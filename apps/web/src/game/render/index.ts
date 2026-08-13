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
import {
  Direction,
  LampState,
  MachineKind,
  SUBTILE,
  WiltStage,
  itemSpec,
  machineSpec,
} from '@snack/sim';
import type { MachineView, WorldView } from '@snack/sim';

import { TOOL_INFO, ToolMode, toolMachineKind } from '../input/tools';
import type { HoverTile } from '../input/context';
import { tileAtView } from '../input/picking';
import { beltItemAtTile } from './belt-items';
import { money } from './hud';
import { lampAlpha, lampTint } from './lamps';
import { liquidName, liquidTint, portHintTint } from './liquids';
import { pipeAtTile } from './pipes';
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

  // 1. Terrain. The zone diff runs FIRST so a tile painted this frame is queued before the
  //    drain, and lands one frame later rather than one frame plus one paint later.
  //    Nothing re-bakes on a frame with no edits — the dev overlay's "chunks baked" reads 0
  //    in steady state, and a number that stays non-zero is a bug.
  scene.zoneOverlay.sync(view, (tileX, tileY) => scene.terrain.markTileDirty(tileX, tileY));
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
  const rect = scene.camera.cameraRect();
  scene.terrain.cull(rect);

  // 5. The field.
  updateField(scene, view, deltaMs);

  // 6. The factory. Belt surfaces scroll their UVs, belt items are derived fresh into a
  //    pooled particle buffer sized to `rect` — not to the world — and grabber arms read
  //    their swing straight out of the projection.
  //
  //    Pipes go first, under the belts: the fluid layer is ground plumbing, and it is also
  //    the layer a player reads at full zoom-out — four coloured runs and one grey one is
  //    §5's entire diagnostic for a base whose soda line has stopped.
  scene.pipes.update(view, rect, performance.now());
  scene.beltStructures.update(view, alpha, rect);
  scene.beltItems.update(view, alpha, rect);
  scene.grabbers.update(view, rect);

  // 7. Machines.
  updateMachines(scene, view);

  // 8. Hover highlight — renderer state, never a command (§12) — and the errand's
  //    destination, which unlike hover is projected straight out of the sim.
  updateHover(scene, view, ui);
  updateDestination(scene, view);

  // 9. Day/night: one colour matrix on the world root.
  applyDayNight(scene, view.tick);

  // 10. Chrome.
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

    // Compost is litter, not a plant: it shows whether or not anything is growing here,
    // because the tile it is lying on is usually the tile whose crop just collapsed.
    const heap = scene.compost[i]!;
    heap.visible = (field.compost[i] ?? 0) > 0;

    const crop = scene.crops[i]!;
    const cropId = field.crop[i] ?? 0;
    if (cropId === 0) {
      crop.visible = false;
      scene.readyMarks[i]!.visible = false;
      continue;
    }

    const stage = Math.max(1, field.stage[i] ?? 1);
    crop.visible = true;
    crop.texture = scene.art.get(ART.cropStage(cropId, stage));

    // Wilt reads as COLOUR AND POSTURE, not as a badge. A drooping crop yellows and sags a
    // pixel; a turned one goes grey-brown and sags two. Per-sprite tint is a batched vertex
    // attribute in v8 — this costs nothing and breaks nothing, unlike the day/night pass,
    // which is one filter on the root for exactly the opposite reason.
    const wilt = field.wilt[i] ?? WiltStage.Fresh;
    const tileTop = (field.originY + Math.floor(i / field.tilesWide)) * TILE_PX;
    crop.tint =
      wilt === WiltStage.Wilted ? 0x9a8c6a : wilt === WiltStage.Wilting ? 0xd8cf7a : 0xffffff;
    crop.y = tileTop + (wilt === WiltStage.Wilted ? 2 : wilt === WiltStage.Wilting ? 1 : 0);

    const ready = field.ready[i] === 1;
    const mark = scene.readyMarks[i]!;
    mark.visible = ready;
    if (ready) {
      // A small bob, offset per tile so a ripe field shimmers rather than pulsing in
      // lockstep. Purely decorative and purely local.
      mark.y = tileTop + Math.round(Math.sin(now / 260 + i * 0.7) * 1.5) - 1;
      // The same star in three shades: art's own colour when ripe, amber going, brown once
      // it is Day-Old. One glance across the field sorts "harvest now" from "harvest first"
      // without a single number — and the fresh case tints by white, so whatever the art
      // pipeline eventually ships is left exactly as drawn.
      mark.tint =
        wilt === WiltStage.Wilted ? 0xa88a5a : wilt === WiltStage.Wilting ? 0xe8c86a : 0xffffff;
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
  const now = performance.now();

  for (let i = 0; i < view.machines.length; i++) {
    const m = view.machines[i]!;
    seen.add(m.id);

    let visual = scene.machines.get(m.id);
    if (visual === undefined) {
      visual = createMachineVisual(scene, m);
      scene.machines.set(m.id, visual);
    }

    const left = m.tileX * TILE_PX;
    const top = m.tileY * TILE_PX;
    const width = m.tilesWide * TILE_PX;
    const height = m.tilesHigh * TILE_PX;

    visual.body.position.set(left, top);
    visual.body.texture = scene.art.get(ART.machine(m.kind));
    // Pin the body to its FOOTPRINT rather than trusting the frame's own size. Placeholders
    // are generated at the sim's footprint so this is a no-op for them — it is here for the
    // day an atlas ships a 32×32 frame for the 3×2 Bottler, which would otherwise draw a
    // machine two thirds the size of the tiles it occupies and read as a placement bug.
    visual.body.setSize(width, height);

    // The lamp: ONE white sprite, tinted. See `lamps.ts` for why there is not one per state.
    const lampX = left + width - 5;
    const lampY = top + 1;
    visual.lamp.position.set(lampX, lampY);
    visual.lamp.visible = m.lamp !== LampState.Off;
    visual.lamp.tint = lampTint(m.lamp);
    visual.lamp.alpha = lampAlpha(m.lamp, now);

    visual.wrench.position.set(lampX - 8, lampY);
    visual.wrench.visible = m.wrenchDue === 1;

    // Progress along the base. A bar rather than an animated body: §15 rates machine
    // work-loop animation Grade C for AI generation, and the plan's answer is to bend
    // toward compositing in code — which also makes a stalled machine unmistakable,
    // because the bar simply stops.
    const running = m.lamp === LampState.Running && m.progressPermille > 0;
    visual.progress.visible = running;
    if (running) {
      visual.progress.position.set(left + 1, top + height - 2);
      visual.progress.scale.set(((width - 2) * m.progressPermille) / 1000, 1);
    }

    // Input buffer as a column up the left edge: an amber lamp says "starved", and this
    // says how nearly. Grows upward, because a filling hopper that drains downward reads
    // as the wrong thing entirely.
    const hopper = m.inputCapacity > 0 ? Math.min(1, m.inputCount / m.inputCapacity) : 0;
    visual.hopper.visible = hopper > 0;
    if (hopper > 0) {
      const bar = Math.max(1, Math.round((height - 4) * hopper));
      visual.hopper.position.set(left, top + height - 2 - bar);
      visual.hopper.scale.set(1, bar);
    }

    // What is waiting in the output buffer, so a red lamp names its own cargo. Bobs, so a
    // full output catches the eye from across the yard.
    const holding = m.outputCount > 0 && m.outputItem !== 0;
    visual.outputPip.visible = holding;
    if (holding) {
      visual.outputPip.texture = scene.itemPage.texture(m.outputItem);
      visual.outputPip.position.set(
        left + width / 2,
        top - 3 + Math.round(Math.sin(now / 300 + m.id) * 1.5),
      );
    }

    // Upgrade chrome: one pixel of shine per dial level, capped by the strip's own length.
    const dialTotal = m.speedLevel + m.efficiencyLevel + m.capacityLevel;
    visual.dials.visible = dialTotal > 0;
    if (dialTotal > 0) {
      visual.dials.position.set(left + 1, top);
      visual.dials.scale.set(Math.min(width - 2, dialTotal * 2), 1);
    }

    updateTankFill(scene, m, visual, left, top, width, height);
    updatePorts(scene, m, visual, left, top, width, height);
  }

  for (const [id, visual] of scene.machines) {
    if (seen.has(id)) continue;
    destroyMachineVisual(visual);
    scene.machines.delete(id);
  }
}

/** Never more collars than a machine could plausibly have plumbed. */
const MAX_PORTS = 6;

/**
 * The liquid a machine's typed port accepts, or 0 for a machine with no plumbing.
 *
 * `MachineSpec.liquid` is the authority, which is why there is no port table in the renderer:
 * §5's "they meet only inside machines with typed ports" is data in `packages/sim`, and a
 * second copy of it here would be a second copy that could disagree.
 */
function portLiquid(kind: number): number {
  const spec = machineSpec(kind as never);
  return spec === null ? 0 : spec.liquid;
}

/** How much liquid a machine holds, so only machines with a tank draw a level. */
function tankCapacityMl(kind: number): number {
  const spec = machineSpec(kind as never);
  return spec === null ? 0 : spec.tankCapacityMl;
}

/**
 * A tank's level, as a column up the middle of the machine.
 *
 * `tankPermille` has been in the projection since the sprinkler shipped and nothing drew it,
 * so "is the barrel nearly out" was a thing you could only learn by it running out. §5 gives
 * tanks a net rate and a time-to-empty in their card; this is the same fact at a glance, and
 * it is the reason a piped base does not need the card open to be legible.
 */
function updateTankFill(
  scene: WorldScene,
  m: MachineView,
  visual: MachineVisual,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  const capacity = tankCapacityMl(m.kind);
  if (capacity <= 0) {
    visual.tankFill.visible = false;
    return;
  }
  const fill = Math.max(0, Math.min(1000, m.tankPermille));
  const columnWidth = Math.max(2, Math.round(width / 8));
  const columnHeight = Math.max(0, Math.round(((height - 8) * fill) / 1000));
  visual.tankFill.visible = columnHeight > 0;
  if (columnHeight === 0) return;
  visual.tankFill.tint = liquidTint(portLiquid(m.kind));
  visual.tankFill.position.set(
    left + Math.round((width - columnWidth) / 2),
    top + height - 4 - columnHeight,
  );
  visual.tankFill.scale.set(columnWidth, columnHeight);
}

/**
 * Pipe collars, where the fluid layer actually meets a machine.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  THE SYRUP MIXER IS WHAT THIS FUNCTION IS FOR. (Plan §5.)
 *
 *  "Sweeteners are liquids, flavors are powders — the Syrup Mixer (2 pipe inlets + 1 belt
 *   inlet) is the one machine where the two layers visibly cooperate."
 *
 *  Visibly. So the cooperation has to be drawn, and drawn TRUTHFULLY: a lit collar means a
 *  real pipe is touching that edge, tinted with what is actually in it. Two amber collars
 *  and a belt running into the north face is a Mixer that is fed; one amber collar and one
 *  grey one is a Mixer with a dead juice line, and the player can see which side to walk to
 *  without opening anything.
 *
 *  The unconnected case is a DIM HUED collar rather than a grey one, because grey is
 *  already spoken for: on a pipe it means "carrying nothing". "Nothing is plumbed here yet"
 *  and "the line into here is dead" are different errands and must not look alike.
 * ────────────────────────────────────────────────────────────────────────────────────
 */
function updatePorts(
  scene: WorldScene,
  m: MachineView,
  visual: MachineVisual,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  const wants = portLiquid(m.kind);
  if (wants === 0) {
    for (const port of visual.ports) port.visible = false;
    return;
  }

  let used = 0;
  const place = (x: number, y: number, tint: number, alpha: number): void => {
    if (used >= MAX_PORTS) return;
    const sprite = portSprite(scene, visual, used);
    used += 1;
    sprite.position.set(x, y);
    sprite.tint = tint;
    sprite.alpha = alpha;
    sprite.visible = true;
  };

  // Every real pipe touching the perimeter, on all four faces. Scanning rather than reading
  // a declared port table means the collars cannot disagree with the plumbing — and it means
  // a machine the sim adds next month is plumbed correctly here with no edit.
  for (let row = 0; row < m.tilesHigh; row++) {
    const y = top + row * TILE_PX + TILE_PX / 2;
    if (scene.pipes.hasPipe(m.tileX - 1, m.tileY + row)) {
      place(left - 1, y, liquidTint(scene.pipes.liquidAt(m.tileX - 1, m.tileY + row)), 1);
    }
    if (scene.pipes.hasPipe(m.tileX + m.tilesWide, m.tileY + row)) {
      const liquid = scene.pipes.liquidAt(m.tileX + m.tilesWide, m.tileY + row);
      place(left + width + 1, y, liquidTint(liquid), 1);
    }
  }
  for (let column = 0; column < m.tilesWide; column++) {
    const x = left + column * TILE_PX + TILE_PX / 2;
    if (scene.pipes.hasPipe(m.tileX + column, m.tileY - 1)) {
      place(x, top - 1, liquidTint(scene.pipes.liquidAt(m.tileX + column, m.tileY - 1)), 1);
    }
    if (scene.pipes.hasPipe(m.tileX + column, m.tileY + m.tilesHigh)) {
      const liquid = scene.pipes.liquidAt(m.tileX + column, m.tileY + m.tilesHigh);
      place(x, top + height + 1, liquidTint(liquid), 1);
    }
  }

  // Nothing plumbed: one dim hint on the west face, which is where a line laid left-to-right
  // arrives. A hint, not a rule — the sim takes fluid on any face, and the scan above proves
  // it by lighting whichever face actually got one.
  if (used === 0) place(left - 1, top + height / 2, portHintTint(wants), 0.75);

  for (let i = used; i < visual.ports.length; i++) visual.ports[i]!.visible = false;
}

function portSprite(scene: WorldScene, visual: MachineVisual, index: number): Sprite {
  const existing = visual.ports[index];
  if (existing !== undefined) return existing;
  const sprite = new Sprite(scene.art.get(ART.uiPipeNub));
  sprite.anchor.set(0.5, 0.5);
  visual.ports.push(sprite);
  scene.contentRoot.addChild(sprite);
  scene.layers.worldUi.attach(sprite);
  return sprite;
}

function createMachineVisual(scene: WorldScene, m: MachineView): MachineVisual {
  const body = new Sprite(scene.art.get(ART.machine(m.kind)));
  scene.contentRoot.addChild(body);
  scene.layers.machines.attach(body);

  const pixel = scene.art.get(ART.uiPixel);

  const progress = new Sprite(pixel);
  progress.tint = 0x9ef0a8;
  progress.visible = false;

  const hopper = new Sprite(pixel);
  hopper.tint = 0xe8b53d;
  hopper.alpha = 0.9;
  hopper.visible = false;

  const dials = new Sprite(pixel);
  dials.tint = 0x8fe6ff;
  dials.visible = false;

  const lamp = new Sprite(scene.art.get(ART.lamp));
  lamp.visible = false;

  const wrench = new Sprite(scene.art.get(ART.uiWrench));
  wrench.visible = false;

  const outputPip = new Sprite(scene.itemPage.texture(m.outputItem));
  outputPip.anchor.set(0.5, 1);
  outputPip.visible = false;

  const tankFill = new Sprite(pixel);
  tankFill.visible = false;

  for (const sprite of [progress, hopper, dials, lamp, wrench, outputPip, tankFill]) {
    scene.contentRoot.addChild(sprite);
    scene.layers.worldUi.attach(sprite);
  }

  return { body, lamp, wrench, progress, hopper, outputPip, dials, tankFill, ports: [] };
}

function destroyMachineVisual(visual: MachineVisual): void {
  visual.body.destroy();
  visual.lamp.destroy();
  visual.wrench.destroy();
  visual.progress.destroy();
  visual.hopper.destroy();
  visual.outputPip.destroy();
  visual.dials.destroy();
  visual.tankFill.destroy();
  for (const port of visual.ports) port.destroy();
  visual.ports.length = 0;
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

/**
 * The pending errand's destination.
 *
 * READ ENTIRELY FROM THE PROJECTION, which is what makes it honest: the marker is not the
 * client remembering where you clicked, it is the sim saying where the farmer is going. The
 * two differ more often than you would think — an errand the sim refused outright (planting
 * an occupied tile), one that went stale mid-walk (someone moved the machine), one the player
 * cancelled with a movement key. In every one of those the intent is `null` on the sim side
 * and this marker vanishes on the next frame without a line of code here knowing why.
 *
 * "DISAPPEARS ON ARRIVAL" IS FREE FOR THE SAME REASON. `advanceErrand` clears the intent on
 * the very tick it fires the verb, so the projection reads 0 the next frame. There is no
 * arrival event to subscribe to and nothing here to keep in sync.
 *
 * `intentAction !== 0` is the whole presence test — `IntentAction.None` is never legal on a
 * live errand, so the sim publishes no separate flag and this asks for none.
 */
function updateDestination(scene: WorldScene, view: WorldView): void {
  if (view.player.intentAction === 0) {
    scene.destination.visible = false;
    return;
  }

  scene.destination.visible = true;
  scene.destination.position.set(
    view.player.intentTileX * TILE_PX,
    view.player.intentTileY * TILE_PX,
  );

  // A cool blue, deliberately nowhere near the hover box's green-in-reach / amber-out-of-reach
  // pair: both can be on screen at once and they mean unrelated things.
  scene.destination.tint = 0x7ac8f0;
  // Breathing, on the same wall clock as the ready marks' bob. Cosmetic animation in the
  // renderer is explicitly fine (AGENTS.md); `Math.sin` is banned in `packages/sim` only.
  scene.destination.alpha = 0.7 + Math.sin(performance.now() / 260) * 0.25;
}

/**
 * The hover/reach readout. Exported so the host can put it on the HUD's live channel —
 * it changes on pointer move, so it goes to a DOM node by ref and never through React
 * (§13, and [[013]]'s status ribbon).
 */
export function statusFor(view: WorldView, ui: RenderUiState): string {
  const tool = ui.tool;
  const cost = TOOL_INFO[tool].costCents;
  if (cost > 0 && view.moneyCents < cost) {
    return `need ${money(cost)} — you have ${money(view.moneyCents)}`;
  }
  // The errand outranks the tile readout: while the farmer is walking, what he is doing is
  // the more useful sentence than what happens to be under a stationary cursor.
  if (view.player.intentAction !== 0) return 'walking over — press a key to stop';
  if (ui.hover === null) return 'wasd to walk  ·  click far away to walk there  ·  1-6 tools';

  const query = tileAtView(view, ui.hover.tileX, ui.hover.tileY);
  if (!query.insideWorld) return 'outside the lot';
  if (query.machine !== null) return machineStatus(query.machine);

  // Belt items are picked SIM-SIDE, by tile — never by hit-testing a particle, which has
  // no interactivity to hit-test. See `belt-items.ts`.
  const riding = beltItemAtTile(view, ui.hover.tileX, ui.hover.tileY);
  if (riding !== null) return `${itemName(riding.item)} on the belt`;

  // The pipe under the cursor names what is in it — or says the run is dead, which is the
  // sentence §5's grey pipe is trying to say and the only one worth spending words on.
  const pipe = pipeAtTile(view, ui.hover.tileX, ui.hover.tileY);
  if (pipe !== null) {
    if (pipe.flowPermille === 0) return 'empty pipe — nothing is reaching it';
    const carrying = liquidName(pipe.liquid) ?? 'liquid';
    // Below full flow the network is throttling round-robin (§5). Saying so on the PIPE is
    // what turns "my Bottler is slow" into "my pump is oversubscribed", which is the actual
    // errand and two rooms away from the machine that lit up amber.
    return pipe.flowPermille < 1000
      ? `${carrying} pipe — network is short, ${Math.round(pipe.flowPermille / 10)}%`
      : `${carrying} pipe`;
  }

  if (!query.isField)
    return toolMachineKind(tool) === null ? 'bare ground' : 'ground: clear to build';
  // No longer a refusal. Reach still decides which command the click becomes, but out of
  // reach now means "he will walk", so the ribbon must stop reading as a rejection.
  if (!query.withinReach) return 'too far — click to walk there';
  if (query.ready) return 'ripe — harvest it';
  if (query.crop !== 0) return query.dry ? 'growing, but thirsty' : 'growing';
  return query.dry ? 'bare soil, dry' : 'bare soil';
}

/** Item names for the status ribbon. The sim's slug, made readable. */
function itemName(item: number): string {
  const spec = itemSpec(item as never);
  return spec === null ? 'goods' : spec.slug.split('-').join(' ');
}

function machineName(kind: number): string {
  const spec = machineSpec(kind as never);
  return spec === null ? 'machine' : spec.slug.split('-').join(' ');
}

function machineStatus(m: MachineView): string {
  const name = machineName(m.kind);
  switch (m.lamp) {
    case LampState.Jammed:
      return `${name} jammed — right-click to whack it`;
    case LampState.Halted:
      return `${name} worn out — right-click to repair`;
    // The two halves of plan §5's grammar, said out loud: red means look downstream, amber
    // means look upstream. Naming the actual item is what turns a red lamp into an errand.
    case LampState.Blocked:
      return `${name} full of ${itemName(m.outputItem)} — take some`;
    case LampState.Starved:
      return `${name} wants ${itemName(m.inputItem)}`;
    case LampState.UtilityMissing:
      return 'barrel dry — click to refill';
    case LampState.Running:
      return m.kind === MachineKind.Sprinkler ? 'sprinkler running' : `${name} running`;
    default:
      return 'the roadside stand — click to sell';
  }
}
