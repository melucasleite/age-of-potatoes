// Belts and grabber arms.
//
// A BELT IS A SORTED LIST OF `(distanceAlongBelt, itemTypeId)` AND NOTHING ELSE (plan §13).
// Items are not entities: they have no id, no per-item state, and no renderer counterpart
// that has to be kept in sync. The renderer walks visible segments each frame and writes
// positions into a pooled particle buffer, so a drawn item is a query result. That model is
// what makes `ParticleContainer` — which supports no interactivity, no children, no filters,
// no masks — survivable at all, because picking a belt item is a sim-side lookup rather than
// a sprite hit-test. Replacing this with per-item entities would be a rewrite of the
// renderer, not a refactor of the sim.
//
// Movement uses the same exact-rate trick as the player: a per-belt accumulator in
// hundredths of a subtile, spent in whole subtiles. Tier 1 moves 3.2 subtiles per tick and
// rounding that to 3 would make every belt in the game quietly 6% slow.
//
// Belts hand off to belts on their own. Belts and machines meet ONLY through a grabber
// (plan §5's typed-port rule, kept simple): a grabber takes from the tile behind it and
// puts into the tile ahead of it, and that is the whole interface between the two layers.

import {
  BELT_ITEM_SPACING_SUBTILES,
  type ItemId,
  beltSpec,
  grabberSpec,
  machineSpec,
} from './data';
import {
  type Belt,
  type Grabber,
  type WorldState,
  beltAt,
  beltEndDist,
  beltIndexOfTile,
  beltInsert,
  beltTileIndexForDist,
  directionStepX,
  directionStepY,
  machineAt,
} from './state';
import { effectiveInputCapacity } from './upgrades';
import { SUBTILE, divFloor } from './units';

// --- belts ------------------------------------------------------------------------

/** Advance every belt, in ascending id order. */
export function advanceBelts(state: WorldState): void {
  for (let i = 0; i < state.belts.length; i++) {
    advanceBelt(state, state.belts[i]!);
  }
}

function advanceBelt(state: WorldState, belt: Belt): void {
  const spec = beltSpec(belt.tier);
  if (spec === null) return;

  belt.moveAccum += spec.speedSubtilesPer100Ticks;
  const stepSub = divFloor(belt.moveAccum, 100);
  belt.moveAccum -= stepSub * 100;

  if (stepSub > 0) {
    const end = beltEndDist(belt);
    // Head first. Each item is limited by the one ahead of it, which has already moved,
    // so a full belt compacts against its own head rather than overlapping through it.
    for (let i = belt.items.length - 1; i >= 0; i--) {
      const item = belt.items[i]!;
      const ahead = belt.items[i + 1];
      const limit = ahead === undefined ? end : ahead.dist - BELT_ITEM_SPACING_SUBTILES;
      const target = item.dist + stepSub;
      const capped = target > limit ? limit : target;
      if (capped > item.dist) item.dist = capped;
    }
  }

  handOffFromHead(state, belt);
}

/**
 * Push the head item onto whatever belt starts where this one ends.
 *
 * When there is nothing there, or it is full, the item simply stays — and the belt behind
 * it backs up. That is the intended diagnostic (plan §5: "belt gaps mean look upstream,
 * jams mean look downstream"), not a case to route around.
 */
function handOffFromHead(state: WorldState, belt: Belt): void {
  const head = belt.items[belt.items.length - 1];
  if (head === undefined) return;
  if (head.dist < beltEndDist(belt)) return;

  const nextX = belt.tileX + directionStepX(belt.dir) * belt.lengthTiles;
  const nextY = belt.tileY + directionStepY(belt.dir) * belt.lengthTiles;

  const next = beltAt(state, nextX, nextY);
  if (next === null || next.id === belt.id) return;

  const index = beltIndexOfTile(next, nextX, nextY);
  if (index < 0) return;

  if (beltInsert(next, index * SUBTILE, head.item)) {
    belt.items.pop();
  }
}

/**
 * Take the item furthest along the belt within one tile of it, optionally filtered.
 *
 * Furthest-along rather than nearest, so a grabber unloading a belt pulls from the front of
 * the queue and the line behind it keeps flowing.
 */
export function beltTakeFromTile(
  belt: Belt,
  tileX: number,
  tileY: number,
  filter: number,
): ItemId | 0 {
  const index = beltIndexOfTile(belt, tileX, tileY);
  if (index < 0) return 0;

  for (let i = belt.items.length - 1; i >= 0; i--) {
    const entry = belt.items[i]!;
    if (beltTileIndexForDist(belt, entry.dist) !== index) continue;
    if (filter !== 0 && entry.item !== filter) continue;
    belt.items.splice(i, 1);
    return entry.item;
  }
  return 0;
}

// --- grabbers ---------------------------------------------------------------------

/** Advance every grabber, in ascending id order. */
export function advanceGrabbers(state: WorldState): void {
  for (let i = 0; i < state.grabbers.length; i++) {
    advanceGrabber(state, state.grabbers[i]!);
  }
}

function advanceGrabber(state: WorldState, grabber: Grabber): void {
  const spec = grabberSpec(grabber.tier);
  if (spec === null) return;

  if (grabber.cooldown > 0) {
    grabber.cooldown -= 1;
    return;
  }

  if (grabber.held === 0) {
    const taken = grabberTake(state, grabber, spec.reachTiles);
    if (taken !== 0) {
      grabber.held = taken;
      grabber.cooldown = spec.swingTicks;
    }
    return;
  }

  if (grabberPlace(state, grabber)) {
    grabber.held = 0;
    grabber.opCount += 1;
    grabber.cooldown = spec.swingTicks;
  }
  // Still holding means the destination is full. The arm waits, visibly, with an item in
  // its hand — which is the readable version of "look downstream".
}

/** The tile a grabber reaches back into. Long arms skip the tile next to them. */
export function grabberSourceTile(
  grabber: Grabber,
  reachTiles: number,
): { tileX: number; tileY: number } {
  return {
    tileX: grabber.tileX - directionStepX(grabber.dir) * reachTiles,
    tileY: grabber.tileY - directionStepY(grabber.dir) * reachTiles,
  };
}

export function grabberDestTile(
  grabber: Grabber,
  reachTiles: number,
): { tileX: number; tileY: number } {
  return {
    tileX: grabber.tileX + directionStepX(grabber.dir) * reachTiles,
    tileY: grabber.tileY + directionStepY(grabber.dir) * reachTiles,
  };
}

function grabberTake(state: WorldState, grabber: Grabber, reachTiles: number): ItemId | 0 {
  const from = grabberSourceTile(grabber, reachTiles);

  const belt = beltAt(state, from.tileX, from.tileY);
  if (belt !== null) {
    return beltTakeFromTile(belt, from.tileX, from.tileY, grabber.filter);
  }

  const machine = machineAt(state, from.tileX, from.tileY);
  if (machine !== null) {
    const spec = machineSpec(machine.kind);
    if (spec === null || spec.outputItem === null) return 0;
    if (machine.outputCount <= 0) return 0;
    if (grabber.filter !== 0 && spec.outputItem !== grabber.filter) return 0;
    machine.outputCount -= 1;
    return spec.outputItem;
  }

  return 0;
}

function grabberPlace(state: WorldState, grabber: Grabber): boolean {
  const spec = grabberSpec(grabber.tier);
  if (spec === null) return false;
  const to = grabberDestTile(grabber, spec.reachTiles);

  const belt = beltAt(state, to.tileX, to.tileY);
  if (belt !== null) {
    const index = beltIndexOfTile(belt, to.tileX, to.tileY);
    if (index < 0) return false;
    // The middle of the tile, so an arm feeding a belt mid-run leaves room on both sides.
    return beltInsert(belt, index * SUBTILE + divFloor(SUBTILE, 2), grabber.held as ItemId);
  }

  const machine = machineAt(state, to.tileX, to.tileY);
  if (machine !== null) {
    const machineSpecFor = machineSpec(machine.kind);
    if (machineSpecFor === null || machineSpecFor.inputItem === null) return false;
    if (machineSpecFor.inputItem !== grabber.held) return false;
    if (machine.inputCount >= effectiveInputCapacity(machineSpecFor, machine)) return false;
    machine.inputCount += 1;
    return true;
  }

  return false;
}
