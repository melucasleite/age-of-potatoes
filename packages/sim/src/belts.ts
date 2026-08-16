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
  MachineKind,
  MachineRole,
  beltSpec,
  grabberSpec,
  machineSpec,
} from './data';
import { dockAcceptDelivery } from './bots';
import { depotAccept } from './commerce';
import {
  type Belt,
  Direction,
  type Grabber,
  type Machine,
  type WorldState,
  beltAt,
  beltEndDist,
  beltIndexOfTile,
  beltInsert,
  beltTileIndexForDist,
  directionStepX,
  directionStepY,
  machineAt,
  nextOutputItem,
  takeDockShelf,
  takeOneOutput,
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
 * The tile a belt delivers into: one step past its last tile, in the direction it runs.
 *
 * Where a belt *points* is a question two things now ask — the hand-off below, and a junction
 * deciding which of its four neighbours are feeding it — so it is written once here rather than
 * spelled out twice with the same arithmetic and one chance to drift.
 */
export function beltExitTileX(belt: Belt): number {
  return belt.tileX + directionStepX(belt.dir) * belt.lengthTiles;
}

export function beltExitTileY(belt: Belt): number {
  return belt.tileY + directionStepY(belt.dir) * belt.lengthTiles;
}

/** True when this belt's head item has arrived at the very end and is waiting to be handed on. */
function headWaitingAtEnd(belt: Belt): boolean {
  const head = belt.items[belt.items.length - 1];
  return head !== undefined && head.dist >= beltEndDist(belt);
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

  const nextX = beltExitTileX(belt);
  const nextY = beltExitTileY(belt);

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

// --- junctions --------------------------------------------------------------------
//
// THE SPLITTER AND THE MERGER ARE THE SAME TILE (see `MachineKind.BeltJunction`). A junction
// takes one item per tick off a belt that ends on it and puts it onto a belt that leads away from
// it, choosing round-robin on both sides. Two belts in and one out is a merger; one in and two
// out is a splitter; the device does not know which it is and does not need to, because the
// answer is the belts the player ran into it and those are on screen. That is also why R
// still ignores a junction while it now turns a belt tile (item 084's `RotateBelt`): a
// junction HAS no facing to turn — its behaviour is entirely the belts around it — so a
// rotate would be a command with nothing to change.
//
// THE ALTERNATION IS STATE ON THE MACHINE, NEVER A ROLL AND NEVER THE TICK COUNTER. Item 024's
// criterion is that the same seed and the same command list produce the same hash across runs, so
// the cursors live in `WorldState`, hash with everything else, and survive a save. A splitter that
// alternated on `state.tick % 2` would produce a different pattern depending on when the player
// happened to build it, which is a replay divergence wearing a very convincing disguise.
//
// IT HAS NO BUFFER. An item crosses inside one tick or it stays on the belt it is on, and the
// belt behind it backs up nose to tail — which is the diagnostic plan §5 asks for ("jams mean
// look downstream") rather than a hidden item inside a tile. It also means removing a junction
// can never eat anything, and that net worth has nothing extra to count.
//
// A GRABBER CANNOT FEED ONE, deliberately: a junction has no recipe, so `grabberPlace` finds no
// line that wants the item and the arm stalls holding it — the same stall a full hopper gives.
// Feed junctions with belt; that is what they are for.

/**
 * The four faces, in compass order, and the order the cursors rotate through.
 *
 * A fixed array rather than arithmetic on the `Direction` values. They happen to be numbered
 * clockwise today and `(d % 4) + 1` would work — right up until somebody renumbers one, at which
 * point every junction in every saved world quietly starts serving its belts in a different
 * order. The same argument `rotateDirectionClockwise` is written out longhand for.
 */
const JUNCTION_FACES: readonly Direction[] = [
  Direction.North,
  Direction.East,
  Direction.South,
  Direction.West,
];

/** Advance every junction, in ascending machine id order. */
export function advanceJunctions(state: WorldState): void {
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    const spec = machineSpec(machine.kind);
    if (spec === null || spec.role !== MachineRole.Junction) continue;
    advanceJunction(state, machine);
  }
}

/**
 * One junction's tick: take one item from a feeding belt, put it on a leaving belt.
 *
 * Both scans start at their own cursor and wrap, and BOTH CURSORS ONLY MOVE ON A COMPLETED
 * TRANSFER. That is what makes the round-robin fair rather than merely rotating: a face that had
 * nothing to give, or a belt that had no room, does not consume the turn of the face behind it.
 */
function advanceJunction(state: WorldState, machine: Machine): void {
  for (let i = 0; i < JUNCTION_FACES.length; i++) {
    const inFace = (machine.junctionInCursor + i) % JUNCTION_FACES.length;
    const source = feedingBelt(state, machine, inFace);
    if (source === null) continue;

    const head = source.items[source.items.length - 1];
    if (head === undefined) continue;

    for (let j = 0; j < JUNCTION_FACES.length; j++) {
      const outFace = (machine.junctionOutCursor + j) % JUNCTION_FACES.length;
      if (!placeOnFace(state, machine, outFace, head.item)) continue;

      source.items.pop();
      machine.junctionInCursor = (inFace + 1) % JUNCTION_FACES.length;
      machine.junctionOutCursor = (outFace + 1) % JUNCTION_FACES.length;
      return;
    }

    // Nowhere to put it. Every face was tried, so trying the next source would fail for the same
    // reason — a belt is full or absent regardless of what is being offered to it. Stop, and let
    // the queue build where the player can see it.
    return;
  }
}

/**
 * The belt on one face that is DELIVERING INTO this junction with an item at its head.
 *
 * "Delivering into" is the belt's own hand-off test, reused: a belt feeds this tile when the tile
 * it points at is this tile. That single rule is what stops a junction draining a belt that merely
 * runs past it, and it is the same rule that decides a face is not an output — a belt pointed
 * inwards can never be given an item, so an item can never be handed straight back where it came
 * from and there is no ping-pong to special-case.
 */
function feedingBelt(state: WorldState, machine: Machine, face: number): Belt | null {
  const dir = JUNCTION_FACES[face]!;
  const belt = beltAt(
    state,
    machine.tileX + directionStepX(dir),
    machine.tileY + directionStepY(dir),
  );
  if (belt === null) return null;
  if (beltExitTileX(belt) !== machine.tileX || beltExitTileY(belt) !== machine.tileY) return null;
  if (!headWaitingAtEnd(belt)) return null;
  return belt;
}

/** Try to put one item on the belt at a face. False when there is no belt, or no room. */
function placeOnFace(state: WorldState, machine: Machine, face: number, item: ItemId): boolean {
  const dir = JUNCTION_FACES[face]!;
  const tileX = machine.tileX + directionStepX(dir);
  const tileY = machine.tileY + directionStepY(dir);

  const belt = beltAt(state, tileX, tileY);
  if (belt === null) return false;
  // A belt that points back at us is an input, never an output. See `feedingBelt`.
  if (beltExitTileX(belt) === machine.tileX && beltExitTileY(belt) === machine.tileY) return false;

  const index = beltIndexOfTile(belt, tileX, tileY);
  if (index < 0) return false;
  return beltInsert(belt, index * SUBTILE, item);
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
    // THE HARVESTER DOCK'S SHELF IS CARGO, NOT AN OUTPUT BUFFER (item 083): its spec honestly
    // makes nothing, so `nextOutputItem` has no name for what the bot delivered — the identity
    // lives on the cargo pair. Gated by KIND rather than by dock role, because the planter
    // dock's seeds and the drone bay's parts are incoming supply an arm must never siphon;
    // `takeDockShelf` is the one door out and enforces the same gate itself.
    if (machine.kind === MachineKind.HarvesterDock) {
      const shelf = machine.cargoItem;
      if (shelf === 0) return 0;
      // The filter judges what is actually on the shelf, exactly as it judges the next unit
      // out of a Fryer: an arm filtered to fresh potatoes leaves a Day-Old shelf alone.
      if (grabber.filter !== 0 && shelf !== grabber.filter) return 0;
      const took = takeDockShelf(machine, 1);
      return took === null ? 0 : took.item;
    }

    const spec = machineSpec(machine.kind);
    if (spec === null || spec.outputItem === null) return 0;

    // The filter judges what is actually next out of the buffer, not what the machine makes
    // on a good day: a Fryer hands over its burnt chips first, and an arm filtered to plain
    // chips must leave those alone rather than quietly relabelling them.
    const next = nextOutputItem(machine, spec);
    if (next === null) return 0;
    if (grabber.filter !== 0 && next !== grabber.filter) return 0;

    return takeOneOutput(machine, spec) ?? 0;
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
    if (machineSpecFor === null) return false;
    // A DEPOT HAS NO RECIPE, SO IT NEEDS ITS OWN DOOR. Every other destination in this function
    // is a recipe line, and a depot's contents are decided by the routes the player signed
    // rather than by a spec — so the one branch here hands off to `commerce.ts` rather than
    // teaching this file what a contract is. It refuses when no route on that depot names the
    // item, or when the floor is full, and the arm then stands there holding it: the same
    // "look downstream" stall as a full hopper, saying the same thing about the same mistake.
    if (machineSpecFor.role === MachineRole.TruckDepot) {
      return depotAccept(state, machine, grabber.held as ItemId);
    }
    // AN AGRI-BOT DOCK HAS NO RECIPE EITHER, and its door is the one that makes the Hands-Free
    // board adjudicable. A planter's seed hopper can be filled by hand or by belt; §6's taxonomy
    // makes the hand path a `hopperRefill` touch and the belt path free, so the two are different
    // functions rather than one function with a flag — and this is the free one. It refuses a seed
    // the dock's zone did not ask for and a hopper that is full, and the arm then stands there
    // holding it: the same "look downstream" stall a full Fryer hopper gives.
    if (machineSpecFor.role === MachineRole.BotDock) {
      // One door for every dock's hopper: seeds for a planter, drone parts for a bay. The
      // routing lives in `bots.ts`, so this file keeps knowing one fact about docks.
      return dockAcceptDelivery(state, machine, grabber.held);
    }
    // An arm puts what it is holding into the line of the recipe that wants it, and stands there
    // holding it if no line does. That is the same "look downstream" stall a blocked arm has
    // always had — a Combo Packer with a full chip hopper and an empty soda hopper takes the
    // soda and refuses the chips, which is the machine telling the player which belt is behind.
    for (let i = 0; i < machineSpecFor.inputs.length; i++) {
      if (machineSpecFor.inputs[i]!.item !== grabber.held) continue;
      if ((machine.inputCounts[i] ?? 0) >= effectiveInputCapacity(machineSpecFor, machine)) {
        return false;
      }
      machine.inputCounts[i] = (machine.inputCounts[i] ?? 0) + 1;
      return true;
    }
    return false;
  }

  return false;
}
