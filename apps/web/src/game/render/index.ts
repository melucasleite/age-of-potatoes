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

import { Sprite, Texture } from 'pixi.js';
import {
  Direction,
  LampState,
  MachineKind,
  SUBTILE,
  TICKS_PER_SECOND,
  WiltStage,
  itemSpec,
  machineSpec,
} from '@snack/sim';
import type { GrabberView, MachineView, WorldView } from '@snack/sim';

import { TOOL_INFO, ToolMode, toolMachineKind } from '../input/tools';
import { beltItemsVisibleAt } from '../input/lod';
import type { HoverTile } from '../input/context';
import { grabberAtView, tileAtView, tileWithinReach } from '../input/picking';
import { bestSellable } from '../input/pointer';
import { beltItemAtTile } from './belt-items';
import { FarmFx } from './farm-fx';
import { money } from './hud';
import { junctionMask, junctionQuarterTurns } from './junction';
import { LAMP_PX, lampAlpha, lampTint } from './lamps';
import { liquidName, liquidTint, portHintTint } from './liquids';
import { pipeAtTile } from './pipes';
import { ART } from './textures';
import type { DecalDial } from './textures';
import { applyDayNight, WORLD_HEIGHT_PX, WORLD_WIDTH_PX } from './world';
import type { MachineVisual, WorldScene } from './world';

export interface RenderUiState {
  hover: HoverTile | null;
  tool: ToolMode;
}

/** Reused so the per-frame camera blend allocates nothing. Renderer-local, write-only. */
const cameraTarget = { x: 0, y: 0 };

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
  //
  //    A DEED IS AN EDIT EVENT LIKE A PAINT IS, and a rarer one: ownership changes on the tick
  //    a parcel is bought and on the frame a world loads, and on no other frame in a session.
  //    So it re-bakes the whole map rather than diffing tiles — the wash and the fence line
  //    both move, on both sides of a boundary sixteen tiles long, and `drainDirty` spreads the
  //    cost over the next few frames anyway.
  if (scene.landOverlay.sync(view)) scene.terrain.markAllDirty();
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
  //
  //    A running ceremony LEANS this toward whatever it is celebrating. That is all it does
  //    to the camera: a bias on the look-at target, with the clamp and the pixel snap still
  //    running underneath exactly as before. The player keeps walking, and the camera keeps
  //    following them — it is simply doing it from a little further over for ten seconds.
  scene.ceremony.observe(view);
  scene.ceremony.cameraTarget(playerWorldX, playerWorldY, cameraTarget);
  scene.camera.lookAt(cameraTarget.x, cameraTarget.y);
  scene.camera.clampToWorld(WORLD_WIDTH_PX, WORLD_HEIGHT_PX);
  scene.camera.apply(scene.worldRoot);

  // 4. Cull analytically from the camera rect. Culling is opt-in in Pixi v8 (§13): it
  //    moved out of the render loop, so nothing is culled unless you cull it.
  const rect = scene.camera.cameraRect();
  scene.terrain.cull(rect);

  // 5. The field.
  updateField(scene, view, deltaMs, playerWorldX, playerWorldY);

  // 6. The factory. Belt surfaces scroll their UVs, belt items are derived fresh into a
  //    pooled particle buffer sized to `rect` — not to the world — and grabber arms read
  //    their swing straight out of the projection.
  //
  //    Pipes go first, under the belts: the fluid layer is ground plumbing, and it is also
  //    the layer a player reads at full zoom-out — four coloured runs and one grey one is
  //    §5's entire diagnostic for a base whose soda line has stopped.
  //
  //    THE FLOW LOD SWITCHES HERE, and this is the only place it switches. Above the
  //    threshold the goods are drawn one by one and the belt surface is plain; below it the
  //    items are not drawn at all and the surface carries the throughput instead. Read off
  //    `camera.zoom` — the scale that was actually applied to the world root a few lines
  //    above — rather than off input's published `viewLod`, so the picture can never disagree
  //    with the transform it was drawn under, which is the same rule `picking.ts` follows.
  //
  //    ONE WALL-CLOCK READING for the whole frame, taken here and threaded down. Every lamp
  //    pulse, flow scroll and bob is derived from it, and three separate `performance.now()`
  //    calls a frame would put the arm's lamp a fraction of a millisecond out of phase with the
  //    machine's next to it — invisible individually, and exactly how a row of lamps that should
  //    breathe together ends up shimmering.
  const nowMs = performance.now();
  const beltItemsVisible = beltItemsVisibleAt(scene.camera.zoom);
  scene.pipes.update(view, rect, nowMs);
  scene.beltStructures.update(view, alpha, rect, !beltItemsVisible);
  if (beltItemsVisible) scene.beltItems.update(view, alpha, rect);
  else scene.beltItems.clear();
  scene.grabbers.update(view, rect, nowMs);

  // 7. Machines, and then the vehicles among them: a cart's own readouts are in the commerce
  //    projection rather than on its `MachineView`, so they are applied as a second pass over
  //    the same pooled sprites.
  updateMachines(scene, view, nowMs);
  updateCommerce(scene, view);

  // 8. Hover highlight — renderer state, never a command (§12) — and the errand's
  //    destination, which unlike hover is projected straight out of the sim.
  updateHover(scene, view, ui);
  updateDestination(scene, view);

  // 9. Day/night: one colour matrix on the world root.
  applyDayNight(scene, view.tick);

  // 10. Chrome. The ceremony's plaque is laid out before it is advanced, so its first frame
  //     is already sized to the viewport rather than sliding in from the wrong place.
  const t = scene.camera.transform;
  scene.overlay.layout(t.viewWidth);
  scene.ceremony.layout(t.viewWidth, t.viewHeight);
  scene.ceremony.update(deltaMs);
  scene.hud.update(view, ui.tool, { status: statusFor(view, ui) });
}

// --- field ---------------------------------------------------------------------------

function updateField(
  scene: WorldScene,
  view: WorldView,
  deltaMs: number,
  playerWorldX: number,
  playerWorldY: number,
): void {
  const field = view.field;
  const now = performance.now();

  // The harvest diff, before anything reads the field this frame. It spots a ripe crop that
  // vanished and throws a potato at the player — see `farm-fx.ts` for why that is derived
  // here rather than pushed by the sim, and for why it can never write anything back.
  scene.farmFx.observe(field);

  for (let i = 0; i < scene.soil.length; i++) {
    const moisture = field.moisturePermille[i] ?? 0;

    // Damp soil is a dark overlay faded in by alpha. Watering a tile darkens it visibly
    // and immediately, which is the entire feedback loop the v0.1 design gate rests on.
    const wet = scene.soil[i]!;
    wet.alpha = (moisture / 1000) * 0.72;

    // A rise in moisture means somebody — hand or sprinkler — just poured. Spray a few
    // droplets, and bounce whatever is planted here: item 009's "plants bounce when they
    // drink", which together with the darkening soil is the three-part feedback the design
    // gate rests on. ONE diff drives both effects rather than two passes over 64 numbers.
    // Cosmetic randomness lives in the renderer and uses `Math.random` freely (§12); it
    // must never touch a sim RNG stream, and it does not.
    const previous = scene.lastMoisture[i] ?? 0;
    if (FarmFx.isPour(moisture, previous)) {
      spawnDroplets(scene, i, field.originX, field.originY, field.tilesWide);
      scene.farmFx.pour(i);
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
    // `+ TILE_PX` because the crop sprite is anchored at its BASE (see `world.ts`): its y is
    // where the stem meets the soil, not where the leaves start.
    crop.y =
      tileTop + TILE_PX + (wilt === WiltStage.Wilted ? 2 : wilt === WiltStage.Wilting ? 1 : 0);

    // The drink-bounce. A flat transform when the tile is not bouncing, so this is an
    // unconditional two-number write rather than a branch — and the crop's scale is owned
    // here and only here, which is what keeps it from fighting the wilt sag above.
    const bounce = scene.farmFx.bounceAt(i);
    crop.scale.set(bounce.scaleX, bounce.scaleY);

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

  // The bounce clocks and the potatoes in flight. The magnet reads the player's INTERPOLATED
  // position — the same write-only value the sprite was drawn at a few lines above — so a
  // potato chases the farmer as he walks rather than flying to where he used to be.
  scene.farmFx.update(deltaMs, playerWorldX, playerWorldY);
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

function updateMachines(scene: WorldScene, view: WorldView, now: number): void {
  const seen = new Set<number>();

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

    if (m.kind === MachineKind.BeltJunction) {
      updateJunctionBody(scene, view, m, visual, left, top, width, height);
    } else {
      visual.body.position.set(left, top);
      visual.body.texture = scene.art.get(ART.machine(m.kind));
      // Pin the body to its FOOTPRINT rather than trusting the frame's own size. Placeholders
      // are generated at the sim's footprint so this is a no-op for them — it is here for the
      // day an atlas ships a 32×32 frame for the 3×2 Bottler, which would otherwise draw a
      // machine two thirds the size of the tiles it occupies and read as a placement bug.
      visual.body.setSize(width, height);
    }

    // The lamp: one white sprite per state, SHAPED and tinted. Assigning `.texture` on an
    // unchanged state is a no-op inside Pixi, so selecting by state every frame is free —
    // and it is what makes the state legible to a player who cannot use the colour (§16,
    // and `lamps.ts` for the whole argument).
    const lampX = left + width - LAMP_PX - 1;
    const lampY = top + 1;
    visual.lamp.texture = scene.art.get(ART.lamp(m.lamp));
    visual.lamp.position.set(lampX, lampY);
    visual.lamp.visible = m.lamp !== LampState.Off;
    visual.lamp.tint = lampTint(m.lamp);
    visual.lamp.alpha = lampAlpha(m.lamp, now);

    visual.wrench.position.set(lampX - 7, lampY);
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

    updateDecals(scene, m, visual, left, top, width, height);
    updateTankFill(scene, m, visual, left, top, width, height);
    updatePorts(scene, m, visual, left, top, width, height);
  }

  for (const [id, visual] of scene.machines) {
    if (seen.has(id)) continue;
    destroyMachineVisual(visual);
    scene.machines.delete(id);
  }
}

/**
 * The belt junction's body: the conveyor tee, turned to face the belts around it.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  THE ONLY MACHINE IN THE GAME THAT DOES NOT DRAW ITS OWN MACHINE FRAME, and the reason
 *  is what it IS rather than a shortcut. A junction is $8 of pressed steel sitting in the
 *  middle of a belt run: plan §5's splitter and merger in one tile, with no work cycle, no
 *  buffer, no facing and no dials. Drawn from `ART.machine` it would wear the generic
 *  placeholder body — a boxed machine with a topper, parked across the line, reading as
 *  something that processes goods rather than something the goods pass through.
 *
 *  So it wears `belt_junction` off the BELT page, and `junction.ts` picks the quarter turn
 *  from the belts the player actually ran into it. That is the whole splitter/merger
 *  distinction on screen: two belts arriving and one leaving is a merger, one arriving and
 *  two leaving is a splitter, and the tee points the same way in both because it is the
 *  same casting. The sim's own note is that "the device does not know which it is and does
 *  not need to" — this is that sentence, drawn.
 * ────────────────────────────────────────────────────────────────────────────────────
 *
 * Anchored at its CENTRE, unlike every other body, because a rotation about a sprite's
 * top-left corner throws the tile into its neighbour. Set every frame rather than at
 * creation: one property write against a branch and a flag, and it cannot drift out of step
 * with the texture it belongs to.
 */
function updateJunctionBody(
  scene: WorldScene,
  view: WorldView,
  m: MachineView,
  visual: MachineVisual,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  visual.body.texture = scene.art.get(ART.beltJunction);
  visual.body.anchor.set(0.5, 0.5);
  visual.body.setSize(width, height);
  visual.body.position.set(left + width / 2, top + height / 2);
  visual.body.rotation =
    (junctionQuarterTurns(junctionMask(view.belts, m.tileX, m.tileY)) * Math.PI) / 2;
}

/**
 * The vehicles: what a cart is carrying, and whether it is even here.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  A CART IN TRANSIT IS OFF THE MAP BY DESIGN (item 032), and that is a rendering problem
 *  rather than a rendering saving. The machine is still on its tile — you cannot build
 *  there, the sim still ticks it, `view.machines` still lists it — but the vehicle itself is
 *  somewhere on a road this game never draws. Left alone it sits in the yard looking parked
 *  while the panel insists it is out, which is the version of this that generates a bug
 *  report.
 *
 *  So a departed cart becomes a GHOST at its stand — visibly the cart, visibly not there —
 *  with the run on the progress bar the machine already owns. "Where did my cart go" and
 *  "when is it back" are then the same glance, and neither costs a sprite.
 * ────────────────────────────────────────────────────────────────────────────────────
 *
 * Runs AFTER `updateMachines` and deliberately overrides it. A cart's cargo and a depot's
 * stock live in `CommerceView`, not on `MachineView` — the cart holds one product per run in
 * its own hold rather than in a recipe's buffers, so `inputCapacity` and `outputCount` are
 * both zero and the generic pass correctly hides both readouts. This is the second half of
 * the same sentence, not a fight with the first.
 */
function updateCommerce(scene: WorldScene, view: WorldView): void {
  const commerce = view.commerce;

  for (let i = 0; i < commerce.carts.length; i++) {
    const cart = commerce.carts[i]!;
    const visual = scene.machines.get(cart.id);
    if (visual === undefined) continue;

    const away = cart.away === 1;
    visual.body.alpha = away ? DEPARTED_ALPHA : 1;

    // The round trip, on the bar that already means "work in progress". `runTicks` is
    // per-cart — the sim charges ten ticks a tile out to the road — so two carts at opposite
    // ends of the lot draw honestly different bars rather than one shared fiction.
    const rolling = away && cart.runTicks > 0;
    visual.progress.visible = rolling;
    if (rolling) {
      const done = Math.max(0, Math.min(1, (cart.runTicks - cart.ticksRemaining) / cart.runTicks));
      visual.progress.position.set(cart.tileX * TILE_PX + 1, (cart.tileY + 1) * TILE_PX - 2);
      visual.progress.scale.set((TILE_PX - 2) * done, 1);
    }

    // What is aboard, and how full. Hidden while it is away: a pip bobbing over an empty
    // stand would be goods sitting in the yard, which is the one thing they are not.
    const loaded = !away && cart.loaded > 0 && cart.item !== 0;
    visual.outputPip.visible = loaded;
    if (loaded) {
      visual.outputPip.texture = scene.itemPage.texture(cart.item);
      visual.outputPip.position.set(cart.tileX * TILE_PX + TILE_PX / 2, cart.tileY * TILE_PX - 3);
    }
    fillColumn(visual, cart.tileX, cart.tileY, 1, !away ? cart.loaded : 0, cart.capacity);
  }

  // A depot's floor stock is the same fact a hopper column shows on a Fryer — goods waiting
  // for the thing that consumes them — so it is the same column, on a 2×2 footprint.
  for (let i = 0; i < commerce.depots.length; i++) {
    const depot = commerce.depots[i]!;
    const visual = scene.machines.get(depot.id);
    if (visual === undefined) continue;
    fillColumn(visual, depot.tileX, depot.tileY, 2, depot.stocked, depot.capacity);
  }
}

/** How present a departed cart still is. Enough to find its stand; not enough to look parked. */
const DEPARTED_ALPHA = 0.26;

/** The hopper column, driven from a count the `MachineView` does not carry. */
function fillColumn(
  visual: MachineVisual,
  tileX: number,
  tileY: number,
  tilesHigh: number,
  count: number,
  capacity: number,
): void {
  const fill = capacity > 0 ? Math.min(1, count / capacity) : 0;
  visual.hopper.visible = fill > 0;
  if (fill <= 0) return;
  const height = tilesHigh * TILE_PX;
  const bar = Math.max(1, Math.round((height - 4) * fill));
  visual.hopper.position.set(tileX * TILE_PX, tileY * TILE_PX + height - 2 - bar);
  visual.hopper.scale.set(1, bar);
}

/** Never more collars than a machine could plausibly have plumbed. */
const MAX_PORTS = 6;

/**
 * The highest level the ART has a frame for. NOT the sim's cap.
 *
 * `UPGRADE_MAX_LEVEL` is balance and could move; the atlas holds nine frames and cannot
 * follow it by itself. Clamping here means a machine that somehow reaches level 4 wears the
 * level-3 paint — visibly upgraded, one rung understated — rather than losing its decal
 * entirely, which is the failure a player would report as "my upgrade disappeared".
 */
const DECAL_MAX_LEVEL = 3;

/**
 * Composite the upgrade decals over a machine.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  THE WHOLE DESIGN IS "NO TABLE". (§13's lamp trick, applied to paint.)
 *
 *  Each decal is a full overlay drawn in the MACHINE'S OWN coordinate space, so it lands at
 *  the machine's position and stretches onto its footprint exactly as `body` does — the same
 *  two lines, deliberately. No offset table, no per-machine anchor, no per-machine variant.
 *  §15 names the hard problem of this game's art as "making 30 machines distinguishable at a
 *  glance"; three dials × three levels × thirty machines is 270 sprites of that problem, and
 *  this is nine.
 *
 *  Levels map STRAIGHT off the projection with no lookup: level 0 draws nothing, and a
 *  machine at Speed 2 + Capacity 1 draws two overlays, stacked in dial order.
 * ────────────────────────────────────────────────────────────────────────────────────
 */
function updateDecals(
  scene: WorldScene,
  m: MachineView,
  visual: MachineVisual,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  let used = 0;
  used = placeDecal(scene, visual, used, 'speed', m.speedLevel, left, top, width, height);
  used = placeDecal(scene, visual, used, 'efficiency', m.efficiencyLevel, left, top, width, height);
  used = placeDecal(scene, visual, used, 'capacity', m.capacityLevel, left, top, width, height);
  for (let i = used; i < visual.decals.length; i++) visual.decals[i]!.visible = false;
}

function placeDecal(
  scene: WorldScene,
  visual: MachineVisual,
  used: number,
  dial: DecalDial,
  level: number,
  left: number,
  top: number,
  width: number,
  height: number,
): number {
  if (level <= 0) return used;
  const name = ART.decal(dial, Math.min(DECAL_MAX_LEVEL, level));

  // A MISSING FRAME DRAWS NOTHING. `art.get()` answers an unknown name with a magenta
  // tile-sized square, which here would be pasted over the machine it was meant to decorate —
  // an art build that skipped the decals would look like a rendering bug rather than like
  // missing art. Asking `isReal` first also keeps the placeholder counter honest.
  if (!scene.art.isReal(name)) return used;

  const sprite = decalSprite(scene, visual, used);
  sprite.texture = scene.art.get(name);
  sprite.position.set(left, top);
  // Pinned to the FOOTPRINT, exactly as the body is. The decals are drawn at 32×32 over a 2×2
  // machine, so this is 1:1 for the whole chip line and correct rather than merely lucky for
  // the 1×1 sprinkler and the 3×2 Bottler.
  sprite.setSize(width, height);
  sprite.visible = true;
  return used + 1;
}

/**
 * Grow the decal pool. Attached to the MACHINES layer, not `worldUi`.
 *
 * A decal is paint on the machine, so it belongs under every readout: the lamp, the wrench,
 * the progress bar and the hopper column all have to stay on top of it. Machine footprints
 * never overlap, so attach order within the layer settles nothing that is visible.
 */
function decalSprite(scene: WorldScene, visual: MachineVisual, index: number): Sprite {
  const existing = visual.decals[index];
  if (existing !== undefined) return existing;
  const sprite = new Sprite(Texture.EMPTY);
  sprite.visible = false;
  visual.decals.push(sprite);
  scene.contentRoot.addChild(sprite);
  scene.layers.machines.attach(sprite);
  return sprite;
}

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

  const lamp = new Sprite(scene.art.get(ART.lamp(m.lamp)));
  lamp.visible = false;

  const wrench = new Sprite(scene.art.get(ART.uiWrench));
  wrench.visible = false;

  const outputPip = new Sprite(scene.itemPage.texture(m.outputItem));
  outputPip.anchor.set(0.5, 1);
  outputPip.visible = false;

  const tankFill = new Sprite(pixel);
  tankFill.visible = false;

  for (const sprite of [progress, hopper, lamp, wrench, outputPip, tankFill]) {
    scene.contentRoot.addChild(sprite);
    scene.layers.worldUi.attach(sprite);
  }

  return { body, lamp, wrench, progress, hopper, outputPip, tankFill, ports: [], decals: [] };
}

function destroyMachineVisual(visual: MachineVisual): void {
  visual.body.destroy();
  visual.lamp.destroy();
  visual.wrench.destroy();
  visual.progress.destroy();
  visual.hopper.destroy();
  visual.outputPip.destroy();
  visual.tankFill.destroy();
  for (const port of visual.ports) port.destroy();
  visual.ports.length = 0;
  // `destroy()` with no argument leaves the TEXTURE alone, which is the atlas's and not
  // this sprite's to free. Same reason the ports above take no argument either.
  for (const decal of visual.decals) decal.destroy();
  visual.decals.length = 0;
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
  const cost = tool === ToolMode.BuyDeed ? view.land.nextPriceCents : TOOL_INFO[tool].costCents;
  if (cost > 0 && view.moneyCents < cost) {
    return `need ${money(cost)} — you have ${money(view.moneyCents)}`;
  }
  // The errand outranks the tile readout: while the farmer is walking, what he is doing is
  // the more useful sentence than what happens to be under a stationary cursor.
  if (view.player.intentAction !== 0) return 'walking over — press a key to stop';
  if (ui.hover === null) return 'wasd to walk  ·  click far away to walk there  ·  1-6 tools';

  const query = tileAtView(view, ui.hover.tileX, ui.hover.tileY);
  if (!query.insideWorld) return 'outside the lot';

  // UNOWNED LAND OUTRANKS EVERYTHING ELSE ON THE TILE, and that ordering is the readable
  // reason item 053 asks for: a player who drags a belt across the fence gets "you do not own
  // this" rather than "bare ground", which is true and useless. It sits above the machine
  // line because nothing can be standing there anyway.
  if (!query.owned) return unownedStatus(view, query.parcel);
  if (query.machine !== null) return machineStatus(view, query.machine);

  // An arm is not a machine and has no `MachineView`, so this is the only line in the game
  // that can tell the player which way one is pointing and that R will turn it ([[052]]).
  const arm = grabberAtView(view, ui.hover.tileX, ui.hover.tileY);
  if (arm !== null) return grabberStatus(view, arm);

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

/**
 * What to say about a tile the player does not own.
 *
 * THREE SENTENCES, BECAUSE THERE ARE THREE SITUATIONS AND THEY ASK FOR DIFFERENT THINGS: this
 * parcel is for sale and you can afford it, it is for sale and you cannot, or it is not for
 * sale yet because nothing you own touches it. Collapsing them into "you do not own this land"
 * would be the readable-refusal box ticked and the question left unanswered.
 */
function unownedStatus(view: WorldView, parcel: number): string {
  const price = view.land.nextPriceCents;
  const buyable = view.land.buyable.includes(parcel);

  if (!buyable) return 'not for sale yet — buy the parcel next to it first';
  if (price < 0) return 'unowned land';
  if (view.moneyCents < price) {
    return `land deed ${money(price)} — you have ${money(view.moneyCents)}`;
  }
  return `unowned land — ${money(price)} for the deed`;
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

/**
 * The arm under the cursor: which way it points, what it is holding, and whether R reaches.
 *
 * SAYS "TOO FAR" RATHER THAN "CLICK TO WALK THERE", because rotate is the one hand verb with
 * no errand behind it — there is no `IntentAction` for it and item 052 says a visible refusal
 * is the right answer. Promising a walk this key cannot perform would be worse than the
 * papercut it was filed for.
 */
function grabberStatus(view: WorldView, g: GrabberView): string {
  const facing = compass(g.dir);
  if (!tileWithinReach(view, g.tileX, g.tileY)) {
    return `arm facing ${facing} — too far to turn it`;
  }
  return g.held !== 0
    ? `arm facing ${facing}, holding ${itemName(g.held)} — R turns it`
    : `arm facing ${facing} — R turns it`;
}

function compass(dir: number): string {
  switch (dir) {
    case Direction.North:
      return 'north';
    case Direction.East:
      return 'east';
    case Direction.South:
      return 'south';
    case Direction.West:
      return 'west';
    default:
      return 'nowhere';
  }
}

/**
 * The commerce row's own sentences, or null for a machine this does not speak for.
 *
 * A junction is answered from the belts around it rather than from the machine, because that is
 * where the answer is: the same mask the tee is turned by, counted. "Two in, one out" is the
 * only sentence in the game that tells a player which of the two devices they just built.
 */
function vehicleStatus(view: WorldView, m: MachineView): string | null {
  if (m.kind === MachineKind.BeltJunction) {
    const mask = junctionMask(view.belts, m.tileX, m.tileY);
    const arms = junctionArms(mask);
    if (arms === 0) return 'belt junction — run a belt into it';
    if (arms === 1) return 'belt junction — one belt only, nothing to split';
    return `belt junction — ${arms} belts, splitting round-robin`;
  }

  if (m.kind === MachineKind.DeliveryCart) {
    const cart = view.commerce.carts.find((c) => c.id === m.id);
    if (cart === undefined) return null;
    if (cart.away === 1) {
      return `delivery cart out — back in ${Math.ceil(cart.ticksRemaining / TICKS_PER_SECOND)}s`;
    }
    return cart.loaded > 0
      ? `delivery cart — ${cart.loaded}/${cart.capacity} ${itemName(cart.item)}, click to send it`
      : 'delivery cart — load it with goods to sell';
  }

  if (m.kind === MachineKind.TruckDepot) {
    const depot = view.commerce.depots.find((d) => d.id === m.id);
    if (depot === undefined) return null;
    if (depot.contractIds.length === 0) return 'truck depot — click to sign a contract';
    const routes =
      depot.contractIds.length === 1 ? '1 route' : `${depot.contractIds.length} routes`;
    return `truck depot — ${routes}, ${depot.stocked}/${depot.capacity} on the floor`;
  }

  return null;
}

/** How many faces of a junction mask carry belt. Four bits, counted the readable way. */
function junctionArms(mask: number): number {
  let count = 0;
  for (let bit = 1; bit <= 8; bit <<= 1) {
    if ((mask & bit) !== 0) count += 1;
  }
  return count;
}

function machineStatus(view: WorldView, m: MachineView): string {
  const name = machineName(m.kind);

  // THE THREE THAT HAVE NO WORK CYCLE AND ARE NOT DECORATION. All three answer `LampState.Off`
  // — no `workPerOperation`, so the sim's grammar has nothing to say about them — and all three
  // would otherwise fall to the "idle" line at the bottom, which is true of a cart out on the
  // road in the least useful possible way. Answered above the lamp switch because the lamp is
  // the thing that has no answer for them.
  const vehicle = vehicleStatus(view, m);
  if (vehicle !== null) return vehicle;

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
      // `LampState.Off` is "no work cycle", which is the sell bin AND every tank, pump and
      // decorative slab — so the bin's own sentence has to be gated on the KIND rather than on
      // the lamp, or a water tank claims to be the roadside stand.
      if (m.kind !== MachineKind.SellBin) return `${name} idle`;
      // Two halves of one counter ([[051]], and lane C's handoff): the bin sells, and clicking
      // it empty-handed opens the board it buys from. The sentence says whichever one this
      // click would actually do, read off the same function the click reads.
      return bestSellable(view) === null
        ? 'the roadside stand — click to open the board'
        : 'the roadside stand — click to sell';
  }
}
