// `render(view, alpha)` — a pure read of the projection.
//
// This function RETURNS VOID and calls nothing on the simulation. It reads plain numbers
// out of a `WorldView` and mutates display objects. There is no import of a sim mutator in
// this directory, and there must never be one: §12's seam is that `view()` hands out plain
// serializable data and the renderer hands nothing back.
//
// Interpolated positions are WRITE-ONLY (§12). They live on the scene, are never read back
// into the sim, never persisted, and never hashed. A hash that moved when the camera moved
// would be exactly the failure that rule prevents.

import { TILE_PX } from './pixel';

import { Sprite } from 'pixi.js';
import { Direction, LampState, MachineKind, SUBTILE } from '@snack/sim';
import type { MachineView, WorldView } from '@snack/sim';

import { TOOL_INFO, ToolMode, toolMachineKind } from '../input/tools';
import type { HoverTile } from '../input/context';
import { tileAtView } from '../input/picking';
import { money } from './hud';
import { ART } from './textures';
import { applyDayNight, WORLD_HEIGHT_PX, WORLD_WIDTH_PX } from './world';
import type { MachineVisual, WorldScene } from './world';

export interface RenderUiState {
  hover: HoverTile | null;
  tool: ToolMode;
}

/**
 * Fold one simulated tick into the renderer's interpolation state.
 *
 * Called by the host immediately after each `step()`, so that when several ticks run in
 * one frame the "previous" position is the tick before the last — not the position from
 * the last frame, which would make `alpha` overshoot backwards during catch-up.
 */
export function recordTick(scene: WorldScene, view: WorldView): void {
  if (!scene.primed) {
    scene.prevXSub = view.player.xSub;
    scene.prevYSub = view.player.ySub;
    scene.currXSub = view.player.xSub;
    scene.currYSub = view.player.ySub;
    scene.primed = true;
    return;
  }
  scene.prevXSub = scene.currXSub;
  scene.prevYSub = scene.currYSub;
  scene.currXSub = view.player.xSub;
  scene.currYSub = view.player.ySub;
}

/** Draw one frame. `alpha` is the tick loop's accumulator remainder, in [0, 1). */
export function render(
  scene: WorldScene,
  view: WorldView,
  alpha: number,
  ui: RenderUiState,
  deltaMs: number,
): void {
  if (!scene.primed) recordTick(scene, view);

  // 1. Terrain. Nothing re-bakes on a frame with no edits — the dev overlay's "chunks
  //    baked" reads 0 in steady state, and a number that stays non-zero is a bug.
  scene.terrain.drainDirty();

  // 2. Player, interpolated for display only.
  const xSub = scene.prevXSub + (scene.currXSub - scene.prevXSub) * alpha;
  const ySub = scene.prevYSub + (scene.currYSub - scene.prevYSub) * alpha;
  const playerWorldX = (xSub * TILE_PX) / SUBTILE;
  const playerWorldY = (ySub * TILE_PX) / SUBTILE;

  // Sprites snap to whole SOURCE pixels. Without this the world root sits on an exact
  // device pixel and the player still shimmers, because the sprite inside it does not.
  scene.player.position.set(Math.round(playerWorldX), Math.round(playerWorldY) + TILE_PX / 2);
  scene.player.texture = scene.art.get(facingTexture(view.player.facing));

  // 3. Camera follows the interpolated position, then clamps and snaps.
  scene.camera.lookAt(playerWorldX, playerWorldY);
  scene.camera.clampToWorld(WORLD_WIDTH_PX, WORLD_HEIGHT_PX);
  scene.camera.apply(scene.worldRoot);

  // 4. Cull analytically from the camera rect. Culling is opt-in in Pixi v8 (§13): it
  //    moved out of the render loop, so nothing is culled unless you cull it.
  scene.terrain.cull(scene.camera.cameraRect());

  // 5. The field.
  updateField(scene, view, deltaMs);

  // 6. Machines.
  updateMachines(scene, view);

  // 7. Hover highlight — renderer state, never a command (§12).
  updateHover(scene, view, ui);

  // 8. Day/night: one colour matrix on the world root.
  applyDayNight(scene, view.tick);

  // 9. Chrome.
  const t = scene.camera.transform;
  scene.overlay.layout(t.viewWidth);
  scene.hud.update(view, ui.tool, { status: statusFor(view, ui) });
}

// --- field ---------------------------------------------------------------------------

function updateField(scene: WorldScene, view: WorldView, deltaMs: number): void {
  const field = view.field;
  const now = performance.now();

  for (let i = 0; i < scene.soil.length; i++) {
    const moisture = field.moisturePermille[i] ?? 0;

    // Damp soil is a dark overlay faded in by alpha. Watering a tile darkens it visibly
    // and immediately, which is the entire feedback loop the v0.1 design gate rests on.
    const wet = scene.soil[i]!;
    wet.alpha = (moisture / 1000) * 0.72;

    // A rise in moisture means somebody — hand or sprinkler — just poured. Spray a few
    // droplets. Cosmetic randomness lives in the renderer and uses `Math.random` freely
    // (§12); it must never touch a sim RNG stream, and it does not.
    const previous = scene.lastMoisture[i] ?? 0;
    if (moisture > previous + 40) {
      spawnDroplets(scene, i, field.originX, field.originY, field.tilesWide);
    }
    scene.lastMoisture[i] = moisture;

    const crop = scene.crops[i]!;
    const cropId = field.crop[i] ?? 0;
    if (cropId === 0) {
      crop.visible = false;
      scene.readyMarks[i]!.visible = false;
      continue;
    }

    const stage = Math.max(1, field.stage[i] ?? 1);
    crop.visible = true;
    crop.texture = scene.art.get(ART.cropStage(stage));

    const ready = field.ready[i] === 1;
    const mark = scene.readyMarks[i]!;
    mark.visible = ready;
    if (ready) {
      // A small bob, offset per tile so a ripe field shimmers rather than pulsing in
      // lockstep. Purely decorative and purely local.
      mark.y =
        (field.originY + Math.floor(i / field.tilesWide)) * TILE_PX +
        Math.round(Math.sin(now / 260 + i * 0.7) * 1.5) -
        1;
    }
  }

  updateDroplets(scene, deltaMs);
}

function spawnDroplets(
  scene: WorldScene,
  index: number,
  originX: number,
  originY: number,
  tilesWide: number,
): void {
  const tileX = originX + (index % tilesWide);
  const tileY = originY + Math.floor(index / tilesWide);
  let spawned = 0;
  for (const droplet of scene.droplets) {
    if (droplet.life > 0) continue;
    droplet.life = 260 + Math.random() * 200;
    droplet.vx = (Math.random() - 0.5) * 0.02;
    droplet.vy = -0.03 - Math.random() * 0.02;
    droplet.sprite.visible = true;
    droplet.sprite.alpha = 1;
    droplet.sprite.position.set(
      tileX * TILE_PX + 2 + Math.random() * (TILE_PX - 4),
      tileY * TILE_PX + 4 + Math.random() * 8,
    );
    spawned += 1;
    if (spawned >= 3) return;
  }
}

function updateDroplets(scene: WorldScene, deltaMs: number): void {
  const dt = Math.min(deltaMs, 64);
  for (const droplet of scene.droplets) {
    if (droplet.life <= 0) continue;
    droplet.life -= dt;
    if (droplet.life <= 0) {
      droplet.sprite.visible = false;
      continue;
    }
    droplet.vy += 0.00035 * dt;
    droplet.sprite.x += droplet.vx * dt;
    droplet.sprite.y += droplet.vy * dt;
    droplet.sprite.alpha = Math.min(1, droplet.life / 200);
  }
}

// --- machines ------------------------------------------------------------------------

function updateMachines(scene: WorldScene, view: WorldView): void {
  const seen = new Set<number>();

  for (let i = 0; i < view.machines.length; i++) {
    const m = view.machines[i]!;
    seen.add(m.id);

    let visual = scene.machines.get(m.id);
    if (visual === undefined) {
      visual = createMachineVisual(scene, m);
      scene.machines.set(m.id, visual);
    }

    visual.body.position.set(m.tileX * TILE_PX, m.tileY * TILE_PX);
    visual.body.texture = scene.art.get(machineTexture(m.kind));

    const lampX = (m.tileX + m.tilesWide) * TILE_PX - 5;
    const lampY = m.tileY * TILE_PX + 1;
    visual.lamp.position.set(lampX, lampY);
    visual.lamp.visible = m.lamp !== LampState.Off;
    if (visual.lamp.visible) visual.lamp.texture = scene.art.get(lampTexture(m.lamp));

    visual.wrench.position.set(lampX - 8, lampY);
    visual.wrench.visible = m.wrenchDue === 1;
  }

  for (const [id, visual] of scene.machines) {
    if (seen.has(id)) continue;
    visual.body.destroy();
    visual.lamp.destroy();
    visual.wrench.destroy();
    scene.machines.delete(id);
  }
}

function createMachineVisual(scene: WorldScene, m: MachineView): MachineVisual {
  const body = new Sprite(scene.art.get(machineTexture(m.kind)));
  scene.contentRoot.addChild(body);
  scene.layers.machines.attach(body);

  const lamp = new Sprite(scene.art.get(ART.lampRunning));
  lamp.visible = false;
  scene.contentRoot.addChild(lamp);
  scene.layers.worldUi.attach(lamp);

  const wrench = new Sprite(scene.art.get(ART.uiWrench));
  wrench.visible = false;
  scene.contentRoot.addChild(wrench);
  scene.layers.worldUi.attach(wrench);

  return { body, lamp, wrench };
}

function machineTexture(kind: number): string {
  if (kind === MachineKind.ChipKitchen) return ART.machineChipKitchen;
  if (kind === MachineKind.Sprinkler) return ART.machineSprinkler;
  return ART.machineSellBin;
}

/** One lamp grammar for every machine in the game (§5). */
function lampTexture(lamp: number): string {
  switch (lamp) {
    case LampState.Running:
      return ART.lampRunning;
    case LampState.Starved:
      return ART.lampStarved;
    case LampState.Blocked:
      return ART.lampBlocked;
    case LampState.UtilityMissing:
      return ART.lampUtility;
    case LampState.Jammed:
      return ART.lampJammed;
    default:
      return ART.lampHalted;
  }
}

function facingTexture(facing: number): string {
  switch (facing) {
    case Direction.North:
      return ART.playerNorth;
    case Direction.East:
      return ART.playerEast;
    case Direction.West:
      return ART.playerWest;
    default:
      return ART.playerSouth;
  }
}

// --- hover and status ------------------------------------------------------------------

function updateHover(scene: WorldScene, view: WorldView, ui: RenderUiState): void {
  const hover = ui.hover;
  if (hover === null) {
    scene.hover.visible = false;
    return;
  }
  const query = tileAtView(view, hover.tileX, hover.tileY);
  if (!query.insideWorld) {
    scene.hover.visible = false;
    return;
  }

  scene.hover.visible = true;
  scene.hover.position.set(hover.tileX * TILE_PX, hover.tileY * TILE_PX);

  // Green in reach, amber out of reach. A hint only: the sim re-checks reach and rejects
  // harmlessly, and the UI is never the authority on legality (§12).
  const placing = toolMachineKind(ui.tool) !== null;
  scene.hover.tint = placing || query.withinReach ? 0x9ef0a8 : 0xf0c07a;
  scene.hover.alpha = 0.85;
}

function statusFor(view: WorldView, ui: RenderUiState): string {
  const tool = ui.tool;
  const cost = TOOL_INFO[tool].costCents;
  if (cost > 0 && view.moneyCents < cost) {
    return `need ${money(cost)} — you have ${money(view.moneyCents)}`;
  }
  if (ui.hover === null) return 'wasd to walk  ·  1-6 tools  ·  right-click to repair';

  const query = tileAtView(view, ui.hover.tileX, ui.hover.tileY);
  if (!query.insideWorld) return 'outside the lot';
  if (query.machine !== null) return machineStatus(query.machine);
  if (!query.isField)
    return toolMachineKind(tool) === null ? 'bare ground' : 'ground: clear to build';
  if (!query.withinReach) return 'too far — walk closer';
  if (query.ready) return 'ripe — harvest it';
  if (query.crop !== 0) return query.dry ? 'growing, but thirsty' : 'growing';
  return query.dry ? 'bare soil, dry' : 'bare soil';
}

function machineStatus(m: MachineView): string {
  switch (m.lamp) {
    case LampState.Jammed:
      return 'jammed — right-click to whack it';
    case LampState.Halted:
      return 'worn out — right-click to repair';
    case LampState.Blocked:
      return 'output full — take the chips';
    case LampState.Starved:
      return 'empty — feed it potatoes';
    case LampState.UtilityMissing:
      return 'barrel dry — click to refill';
    case LampState.Running:
      return m.kind === MachineKind.Sprinkler ? 'sprinkler running' : 'cooking';
    default:
      return 'the roadside stand — click to sell';
  }
}
