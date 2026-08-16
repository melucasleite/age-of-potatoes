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
  type MachineSpec,
  beltSpec,
  grabberSpec,
  machineSpec,
} from './data';
import { dockAcceptDelivery, dockCanAcceptDelivery } from './bots';
import { depotAccept, depotCanAccept, sellBinAccept, sellBinCanAccept } from './commerce';
import {
  type Belt,
  Direction,
  type Grabber,
  type Machine,
  type WorldState,
  beltAt,
  beltCanInsert,
  beltEndDist,
  beltIndexOfTile,
  beltInsert,
  beltTileIndexForDist,
  directionStepX,
  directionStepY,
  machineAt,
  nextOutputItem,
  takeDockSeedShelf,
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
 * WHICH ITEM ON THIS BELT A CLAW OVER THIS TILE WOULD CLOSE ON — an index into `belt.items`,
 * or -1 for nothing it wants.
 *
 * Furthest-along rather than nearest, so a grabber unloading a belt pulls from the front of
 * the queue and the line behind it keeps flowing.
 *
 * **THE BELT SOURCE'S ONE ANSWER** (item 085). An arm now asks what it *would* pick up before
 * it decides to pick anything up at all, and the peek and the pull have to name the same
 * item — not "the same rule, written twice". They call this, and differ only by a splice.
 * Returns an index rather than the item so the caller can do either without a second scan;
 * nothing is allocated, which is what lets it run per arm per swing.
 */
export function beltItemIndexAt(belt: Belt, tileX: number, tileY: number, filter: number): number {
  const index = beltIndexOfTile(belt, tileX, tileY);
  if (index < 0) return -1;

  for (let i = belt.items.length - 1; i >= 0; i--) {
    const entry = belt.items[i]!;
    if (beltTileIndexForDist(belt, entry.dist) !== index) continue;
    if (filter !== 0 && entry.item !== filter) continue;
    return i;
  }
  return -1;
}

/** Take the item furthest along the belt within one tile of it, optionally filtered. */
export function beltTakeFromTile(
  belt: Belt,
  tileX: number,
  tileY: number,
  filter: number,
): ItemId | 0 {
  const at = beltItemIndexAt(belt, tileX, tileY, filter);
  if (at < 0) return 0;
  const item = belt.items[at]!.item;
  belt.items.splice(at, 1);
  return item;
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
//
// AN ARM LOOKS BEFORE IT GRABS (item 085; owner ruling, 2026-08-15: "the grabbers should only be
// able to take what the machine is able to receive… if it grabs something that the machine can't
// take, it shouldn't grab it"). Every pickup is two questions asked in one tick — *what would the
// source hand me* and *would my destination take that* — and the claw only closes when both
// answer. An arm whose destination is full, or whose next item is something that destination will
// never want, leaves the goods where they are.
//
// THIS OVERRULES THE OLD "LOOK DOWNSTREAM" HOSTAGE. Until this item every accept-door in this
// file and `bots.ts` documented the stall as the diagnostic: the arm stood there holding a thing
// nobody would take, and that was how the player found the jam. The diagnostic did not go away,
// it MOVED TO THE LAMP — `grabberLamp` in `view.ts` now shows red on an idle empty-handed arm
// whose next pickup would be refused, and amber keeps meaning "nothing to take". Same two
// diagnoses, same colours, no goods held hostage to say it.
//
// THE MID-SWING STALL SURVIVES, deliberately. A destination that fills up while an arm is already
// carrying still refuses it, and the arm still waits with the item in its hand. The ruling
// prevents doomed *grabs*; it does not teleport goods backwards onto a belt they already left.
// In steady state that is bounded by the one swing the world changed under.
//
// THE SHAPE, and the reason it is this shape: `grabberSource` and `grabberDeliver` each take a
// `commit` flag and are each the ONLY code that knows their half. The look-ahead calls them with
// `false` and the pickup calls them with `true`, so a peek can never resolve a different shelf,
// a different belt item, or a different accept-door than the delivery that follows. Two mirrored
// functions that started identical is exactly the failure this item exists to prevent, and the
// per-door predicates (`beltCanInsert`, `depotCanAcceptRoute`, `sellBinCanAccept`,
// `dockCanAcceptDelivery`, `hopperLineFor`) are each called by both halves rather than copied
// into one. Nothing on either path allocates: it runs per arm per swing.

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
  // Still holding means the destination filled up mid-swing — the one stall item 085 left
  // standing. The arm waits with the item in its hand and its lamp red.
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

/**
 * ONE PICKUP: peek, ask the destination, and only then close the claw (item 085).
 *
 * The three lines are the whole ruling. `grabberSource(..., false)` names what the source would
 * hand over; `grabberDeliver(..., false)` asks the destination whether it would take *that*;
 * `grabberSource(..., true)` repeats the first resolution and this time removes it. Nothing
 * mutates between the peek and the pull, so the second call cannot resolve a different item
 * than the first — and because both are the same function, it cannot resolve it by different
 * rules either.
 *
 * THE MIDDLE LINE IS NOT REDUNDANT NOW THAT A DOCK'S SHELF ASKS THE DESTINATION TOO (item 098).
 * `dockShelfFor` consults `grabberWouldAccept` to choose *between* two stocked shelves, but when
 * neither would land it still names one — so this is the check that turns "the destination wants
 * neither" into a refusal to grab, and into the red lamp that says so.
 */
function grabberTake(state: WorldState, grabber: Grabber, reachTiles: number): ItemId | 0 {
  const sx = grabber.tileX - directionStepX(grabber.dir) * reachTiles;
  const sy = grabber.tileY - directionStepY(grabber.dir) * reachTiles;

  const next = grabberSource(state, grabber, sx, sy, false);
  if (next === 0) return 0;
  if (!grabberWouldAccept(state, grabber, next)) return 0;

  return grabberSource(state, grabber, sx, sy, true);
}

/**
 * What this arm would pick up next, without touching anything.
 *
 * The peek half of `grabberTake` above, exported for `view.ts`'s lamp and the door tests. It is
 * the same call the pickup makes, so "what the lamp is complaining about" and "what the arm
 * would have grabbed" are the same item by construction rather than by agreement.
 */
export function grabberNextPickup(
  state: WorldState,
  grabber: Grabber,
  reachTiles: number,
): ItemId | 0 {
  const sx = grabber.tileX - directionStepX(grabber.dir) * reachTiles;
  const sy = grabber.tileY - directionStepY(grabber.dir) * reachTiles;
  return grabberSource(state, grabber, sx, sy, false);
}

/**
 * **THE SOURCE SIDE OF AN ARM, ASKED OR WALKED THROUGH.** `commit === false` says what this arm
 * would pick up from the tile at `(sx, sy)` right now and changes nothing; `true` says the same
 * thing and takes it.
 *
 * One function rather than a peek and a take, because the filter rules here are subtle enough
 * that a copy would drift within a month: which of a dock's two shelves an unfiltered arm reads,
 * whether a Fryer's burnt chips count as chips, which end of a belt's queue the claw is over.
 * Every one of those answers is written once, below, and both halves of item 085's look-ahead
 * read it.
 */
function grabberSource(
  state: WorldState,
  grabber: Grabber,
  sx: number,
  sy: number,
  commit: boolean,
): ItemId | 0 {
  const belt = beltAt(state, sx, sy);
  if (belt !== null) {
    const at = beltItemIndexAt(belt, sx, sy, grabber.filter);
    if (at < 0) return 0;
    const item = belt.items[at]!.item;
    if (commit) belt.items.splice(at, 1);
    return item;
  }

  const machine = machineAt(state, sx, sy);
  if (machine === null) return 0;

  // THE HARVESTER DOCK'S SHELF IS CARGO, NOT AN OUTPUT BUFFER (item 083): its spec honestly
  // makes nothing, so `nextOutputItem` has no name for what the bot delivered — the identity
  // lives on the cargo pair. Gated by KIND rather than by dock role, because the planter
  // dock's seeds are incoming supply an arm must never siphon; `takeDockShelf` is the one door
  // out and enforces the same gate itself. (A Drone Bay's cargo pair is empty forever now —
  // [[090]] — but the gate is written against what a shelf MEANS, not against today's roster.)
  if (machine.kind === MachineKind.HarvesterDock) {
    const shelf = dockShelfFor(state, grabber, machine);
    if (shelf === DockShelf.Produce) {
      if (!commit) return machine.cargoItem as ItemId;
      return takeDockShelf(machine, 1)?.item ?? 0;
    }
    if (shelf === DockShelf.Seed) {
      if (!commit) return machine.seedShelfItem as ItemId;
      return takeDockSeedShelf(machine, 1)?.item ?? 0;
    }
    return 0;
  }

  const spec = machineSpec(machine.kind);
  if (spec === null || spec.outputItem === null) return 0;

  // The filter judges what is actually next out of the buffer, not what the machine makes
  // on a good day: a Fryer hands over its burnt chips first, and an arm filtered to plain
  // chips must leave those alone rather than quietly relabelling them.
  const next = nextOutputItem(machine, spec);
  if (next === null) return 0;
  if (grabber.filter !== 0 && next !== grabber.filter) return 0;

  return commit ? (takeOneOutput(machine, spec) ?? 0) : next;
}

/**
 * WHICH SHELF OF A HARVESTER DOCK THIS ARM IS READING (item 088's rule, item 085's machinery,
 * item 098's correction).
 *
 * TWO SHELVES ON ONE MACHINE, AND AN UNFILTERED ARM ASKS ITS DESTINATION WHICH ONE TO READ. A
 * dock holds produce on one shelf and seeds on the other, and the rule used to be a fixed
 * priority: produce first, seeds only when the produce shelf was EMPTY. That rule made the loop
 * item 088 exists for — harvester seeds into a planter's hopper — unbuildable in practice, and
 * the owner found it exactly that way ("the arm is not able to take seeds from the harvester to
 * the planter"): a working harvester keeps produce stocked, so the fall-through never fired and
 * an arm pointed at a planter stood there declining a potato nothing would ever take.
 *
 * So the priority is now a TIE-BREAK rather than a search order. Both shelves stocked and no
 * filter means offering each item to `grabberWouldAccept` and taking the first the destination
 * will have; produce wins only when the destination would take either, which is what keeps a
 * dock→belt or dock→Root Cellar run doing precisely what it did before this item. The seed loop
 * needs no filter and no Mk2 any more — a plain Mk1 pointed at a planter reads the seed shelf
 * because the planter is the thing that says so.
 *
 * WHEN NEITHER SHELF WILL LAND IT STILL NAMES ONE, and that is deliberate rather than sloppy.
 * `grabberLamp` reads `grabberNextPickup` and calls a 0 "nothing to pick up" — amber, look
 * upstream — so a dock with two full shelves and a destination that refuses both must return an
 * item here, be refused by the caller's own accept check, and light RED. Returning `None` would
 * turn a downstream problem into an upstream lamp.
 *
 * A FILTERED ARM IS UNTOUCHED. The filter names the shelf and no destination-guessing overrides
 * it: an arm filtered to seeds that is pointed at a sell bin still resolves the seed shelf, and
 * still never closes its claw, because the bin refuses seeds a swing early (the trap item 088
 * named and item 085 closed).
 *
 * ITEM 085 IS WHY THIS IS A FUNCTION AND NOT A PAIR OF `if`s INSIDE THE PULL, and the reason
 * bites harder now that the answer depends on the destination: the peek and the pull must agree
 * about *which shelf that arm reads*, and they agree because they both call this. Nothing
 * mutates between them, so the two calls see the same shelves and ask the same door.
 */
const DockShelf = { None: 0, Produce: 1, Seed: 2 } as const;
type DockShelf = (typeof DockShelf)[keyof typeof DockShelf];

function dockShelfFor(state: WorldState, grabber: Grabber, dock: Machine): DockShelf {
  const filter = grabber.filter;
  const produce = dock.cargoCount > 0 ? (dock.cargoItem as ItemId) : 0;
  const seeds = dock.seedShelfCount > 0 ? (dock.seedShelfItem as ItemId) : 0;

  // The filter judges what is actually on the shelf, exactly as it judges the next unit out of
  // a Fryer: an arm filtered to fresh potatoes leaves a Day-Old shelf alone.
  if (filter !== 0) {
    if (produce === filter) return DockShelf.Produce;
    if (seeds === filter) return DockShelf.Seed;
    return DockShelf.None;
  }

  // One shelf stocked is not a choice, and asking the destination about it would only change
  // which lamp lights — the caller's accept check refuses it either way.
  if (produce === 0) return seeds === 0 ? DockShelf.None : DockShelf.Seed;
  if (seeds === 0) return DockShelf.Produce;

  if (grabberWouldAccept(state, grabber, produce)) return DockShelf.Produce;
  if (grabberWouldAccept(state, grabber, seeds)) return DockShelf.Seed;
  // Neither will land. Name the produce so the refusal is the caller's to report — see above.
  return DockShelf.Produce;
}

/**
 * Would this arm's destination take that item right now? The look-ahead's second question.
 *
 * Exported for `view.ts`, which needs it to tell a red lamp from an amber one, and for the tests
 * that pin every door's peek against its accept.
 */
export function grabberWouldAccept(state: WorldState, grabber: Grabber, item: ItemId): boolean {
  return grabberDeliver(state, grabber, item, false);
}

function grabberPlace(state: WorldState, grabber: Grabber): boolean {
  return grabberDeliver(state, grabber, grabber.held as ItemId, true);
}

/**
 * **THE DESTINATION SIDE OF AN ARM, ASKED OR WALKED THROUGH.** `commit === false` asks whether
 * the tile in front would take `item` and changes nothing; `true` asks and puts it there.
 *
 * ONE BRANCH TABLE FOR BOTH, which is the whole safety property: a look-ahead that picked the
 * depot branch while the delivery a tick later picked the recipe-hopper branch would hand an
 * arm exactly the doomed grab this item forbids. Each branch is a pair — a pure `canAccept`
 * predicate and a mutating accept that calls that same predicate first — so the `commit` flag
 * chooses between two spellings of one rule rather than between two rules.
 */
function grabberDeliver(
  state: WorldState,
  grabber: Grabber,
  item: ItemId | 0,
  commit: boolean,
): boolean {
  const spec = grabberSpec(grabber.tier);
  if (spec === null) return false;
  if (item === 0) return false;

  const tx = grabber.tileX + directionStepX(grabber.dir) * spec.reachTiles;
  const ty = grabber.tileY + directionStepY(grabber.dir) * spec.reachTiles;

  const belt = beltAt(state, tx, ty);
  if (belt !== null) {
    const index = beltIndexOfTile(belt, tx, ty);
    if (index < 0) return false;
    // The middle of the tile, so an arm feeding a belt mid-run leaves room on both sides.
    const dist = index * SUBTILE + divFloor(SUBTILE, 2);
    return commit ? beltInsert(belt, dist, item) : beltCanInsert(belt, dist);
  }

  const machine = machineAt(state, tx, ty);
  if (machine === null) return false;

  const machineSpecFor = machineSpec(machine.kind);
  if (machineSpecFor === null) return false;

  // A DEPOT HAS NO RECIPE, SO IT NEEDS ITS OWN DOOR. Every other destination in this function
  // is a recipe line, and a depot's contents are decided by the routes the player signed
  // rather than by a spec — so the one branch here hands off to `commerce.ts` rather than
  // teaching this file what a contract is. It refuses when no route on that depot names the
  // item, or when the floor is full; after item 085 an arm reads that refusal before it grabs,
  // so a mis-aimed belt now leaves its goods on the belt instead of in a frozen claw.
  if (machineSpecFor.role === MachineRole.TruckDepot) {
    return commit ? depotAccept(state, machine, item) : depotCanAccept(state, machine, item);
  }
  // THE SELL BIN SELLS ON ARRIVAL (item 087). Gated by KIND rather than by `MachineRole.Inert`,
  // on item 083's precedent: "inert" means "has no work cycle", which is a statement about the
  // tick loop and not a promise about who buys things — the day a second inert machine exists
  // it must not start paying the player. The bin is the thing that sells, so the bin is what
  // this asks about.
  //
  // `sellBinAccept` in `commerce.ts` is the door, and it books through `sellAtBin`, which is
  // the same money-and-ledger the hand's `SellItem` walks through. No touch is counted: a belt
  // sale is the hands-free path by construction. Its predicate refuses an unsellable exactly as
  // the bin refuses one from hands — and now refuses it a swing earlier, so the arm that used to
  // stand there holding a seed forever never picks the seed up.
  if (machine.kind === MachineKind.SellBin) {
    return commit ? sellBinAccept(state, item) : sellBinCanAccept(item);
  }
  // AN AGRI-BOT DOCK HAS NO RECIPE EITHER, and its door is the one that makes the Hands-Free
  // board adjudicable. A planter's seed hopper can be filled by hand or by belt; §6's taxonomy
  // makes the hand path a `hopperRefill` touch and the belt path free, so the two are different
  // functions rather than one function with a flag — and this is the free one. It refuses a seed
  // the dock's zone did not ask for and a hopper that is full.
  if (machineSpecFor.role === MachineRole.BotDock) {
    // One door for every dock's hopper — seeds for a planter, and nothing at all for the other
    // two ([[090]] closed the bay's). The routing lives in `bots.ts`, so this file keeps knowing
    // exactly one fact about docks: they have a door, and it may say no.
    return commit
      ? dockAcceptDelivery(state, machine, item)
      : dockCanAcceptDelivery(state, machine, item);
  }
  // An arm puts what it is holding into the line of the recipe that wants it. A Combo Packer
  // with a full chip hopper and an empty soda hopper takes the soda and refuses the chips —
  // which, since item 085, means an arm feeding it chips does not pick chips up at all, and the
  // belt behind backs up where the player can see it.
  const line = hopperLineFor(machineSpecFor, machine, item);
  if (line < 0) return false;
  if (!commit) return true;
  machine.inputCounts[line] = (machine.inputCounts[line] ?? 0) + 1;
  return true;
}

/**
 * **THE RECIPE HOPPER'S ACCEPT-DOOR PREDICATE** (item 085): the input line that would take one
 * more of this item right now, or -1 when none would.
 *
 * The line index rather than a boolean, so the accept above is this plus one increment and there
 * is no second search to disagree with the first. Note it is deliberately not shared with the
 * hand's `LoadMachine` in `tick.ts`: that verb moves a *stack* out of the player's inventory and
 * has its own arithmetic for how much fits, while this one always asks about exactly one unit
 * off a claw. Same capacity function, different question.
 */
function hopperLineFor(spec: MachineSpec, machine: Machine, item: ItemId): number {
  const capacity = effectiveInputCapacity(spec, machine);
  for (let i = 0; i < spec.inputs.length; i++) {
    if (spec.inputs[i]!.item !== item) continue;
    if ((machine.inputCounts[i] ?? 0) >= capacity) return -1;
    return i;
  }
  return -1;
}
