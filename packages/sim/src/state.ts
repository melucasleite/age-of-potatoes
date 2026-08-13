// The world.
//
// `WorldState` is plain JSON data: numbers, strings, booleans, arrays, and objects with a
// fixed shape. No `Date`, no class instances, no functions, no getters, and no field that
// is sometimes absent and sometimes `undefined`. `JSON.parse(JSON.stringify(state))` must
// round-trip to a world that hashes identically — that is the property the save format,
// the golden fixtures, and any eventual Worker transport all stand on.
//
// Collections are ordered for deterministic iteration: the field is a flat row-major
// array; machines, belts, grabbers, and zones are arrays kept sorted by id; inventory is
// kept sorted by item id; the unlock list is kept sorted by node id. Nothing here is
// iterated with `for...in`, and nothing depends on object key insertion order — integer-like
// keys sort ascending while string keys keep insertion order, and that mixed rule will
// eventually reorder entity iteration on somebody's engine.

import {
  BELT_ITEM_SPACING_SUBTILES,
  type BeltTier,
  CONDITION_MAX,
  CropId,
  type CropSpec,
  DESTINATION_MAX_LENGTH,
  FERTILITY_MAX,
  FERTILITY_MIN,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  FIELD_TILES_HIGH,
  FIELD_TILES_WIDE,
  FIELD_TILE_COUNT,
  type GrabberTier,
  ItemId,
  type LiquidId,
  MachineKind,
  type MachineSpec,
  POND_ORIGIN_X,
  POND_ORIGIN_Y,
  PIPE_PRICE_CENTS_PER_TILE,
  POND_TILES_HIGH,
  POND_TILES_WIDE,
  RESERVOIR_CAPACITY_ML,
  STARTING_MONEY_CENTS,
  STARTING_PARCEL,
  STARTING_SEEDS,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  ZONE_NAME_MAX_LENGTH,
  ZONE_PRIORITY_DEFAULT,
  beltSpec,
  deedPriceCents,
  grabberSpec,
  isParcelIndex,
  listPriceCents,
  machineSpec,
  parcelIndexAt,
  parcelsAdjacent,
} from './data';
import type { Command } from './commands';
import {
  type RngState,
  type SystemId,
  SystemId as SystemIds,
  deriveStream,
  nextRange,
} from './rng';
import { type WorldStats, createStats } from './stats';
import { SUBTILE, divFloor, tileCentreSubtiles } from './units';

/**
 * The save-format shape version.
 *
 * 1 — v0.1: field, machines, inventory, stats.
 * 2 — the factory: belts, grabbers, zones, tech unlocks, machine upgrade dials, and the
 *     per-tile withering clock. Migrations are a chain of pure functions, never edits.
 * 3 — the liquid layer: reservoirs with a finite level, pipes, one-ledger networks, and the
 *     per-machine plumbing fields (network, flow, throttle, the Hub's scan cursor).
 * 4 — the walk-to errand: one pending `PlayerIntent`, or none.
 * 5 — maintenance and overcooking: a machine's blocked clock, its burnt count, and the waste
 *     and repair-kit tallies.
 * 6 — the soda line: recipes became lists, so a machine holds one input count PER RECIPE LINE
 *     rather than one number, and a converter carries typed liquid ports of its own.
 * 7 — deconstruct to inventory: a machine comes off the lot as a BOXED ITEM, so an inventory
 *     slot carries a list of boxed machines beside its count — dials, condition, and invoice
 *     each — and two new errand verbs (Deconstruct, Buy) can be pending on the player.
 * 8 — land deeds: the lot is a 4×4 grid of 16-tile parcels rather than one 16×16 map, and a
 *     world carries the sorted list of the parcels it owns. Every existing world owns exactly
 *     parcel 0, which is the map it already had, at the coordinates it already had.
 * 9 — selling above the stand: standing contracts as a sorted list of their own, and three
 *     cart fields on every machine — what it is carrying, how much, and how long until it is
 *     back. Nothing existing changed shape; a format-8 world simply had no vehicles.
 * 10 — the third Charter and the belt junction: every machine carries the untouched-work clock
 *     the Corporate Charter's milestone is read off, and the two round-robin cursors a junction
 *     alternates on. A format-9 world had no junctions and had never been asked how long a line
 *     had run untouched, so all three start at zero — see the migration's note on why that is a
 *     fact rather than an approximation.
 */
export const WORLD_STATE_VERSION = 10;

/**
 * A held direction, not a delta. Input tells the sim *which way the player is holding*,
 * and the sim owns how fast that moves them — otherwise input frequency leaks into world
 * state and a laggy frame becomes a slower character.
 *
 * Belts and grabbers reuse the same four compass values for which way they face. `None` is
 * not a legal facing for either.
 */
export const Direction = {
  None: 0,
  North: 1,
  East: 2,
  South: 3,
  West: 4,
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

/** The tile step one compass direction represents. `None` is the zero vector. */
export function directionStepX(dir: Direction): number {
  if (dir === Direction.East) return 1;
  if (dir === Direction.West) return -1;
  return 0;
}

export function directionStepY(dir: Direction): number {
  if (dir === Direction.South) return 1;
  if (dir === Direction.North) return -1;
  return 0;
}

export function isCompassDirection(dir: number): boolean {
  return (
    dir === Direction.North ||
    dir === Direction.East ||
    dir === Direction.South ||
    dir === Direction.West
  );
}

export function oppositeDirection(dir: Direction): Direction {
  if (dir === Direction.North) return Direction.South;
  if (dir === Direction.South) return Direction.North;
  if (dir === Direction.East) return Direction.West;
  if (dir === Direction.West) return Direction.East;
  return Direction.None;
}

/**
 * One step clockwise: N → E → S → W → N. `None` stays `None`.
 *
 * WRITTEN OUT RATHER THAN COMPUTED. The compass values happen to be in clockwise order today,
 * so `(dir % 4) + 1` would work — and it would keep working right up until somebody added a
 * fifth value or renumbered one, at which point grabbers all over the world would quietly
 * start facing somewhere else. These ids are save surface and permanent; the arithmetic that
 * depends on their *order* is not, so it does not get to be implicit.
 */
export function rotateDirectionClockwise(dir: Direction): Direction {
  if (dir === Direction.North) return Direction.East;
  if (dir === Direction.East) return Direction.South;
  if (dir === Direction.South) return Direction.West;
  if (dir === Direction.West) return Direction.North;
  return Direction.None;
}

/**
 * The hand verbs an errand can be carrying. A SMALL FLAT ENUM, NOT A NESTED `Command`.
 *
 * An intent that stored a whole command inside itself would put a recursive shape in the
 * trace, in the save, and in the hash — three places that all want plain integers. The kind
 * plus a target tile plus at most two numbers says everything these nine verbs need, and it
 * stays readable when somebody is reading a raw trace at 2 a.m.
 *
 * These are exactly the verbs `tick.ts` gates on `HAND_REACH_SUBTILES`. A verb that is not
 * reach-gated has nothing to walk toward and does not belong here.
 */
export const IntentAction = {
  None: 0,
  Water: 1,
  Plant: 2,
  Harvest: 3,
  Load: 4,
  Unload: 5,
  RefillHopper: 6,
  Repair: 7,
  WhackJam: 8,
  Sell: 9,
  /** Walk over and box the machine. Wired exactly as `Repair` is — same target, same reach. */
  Deconstruct: 10,
  /**
   * Walk to the stand and buy. The mirror of `Sell`, and it exists for the same reason: the
   * shop panel could otherwise only tell the player to go and stand somewhere.
   */
  Buy: 11,
} as const;

export type IntentAction = (typeof IntentAction)[keyof typeof IntentAction];

export const INTENT_ACTIONS: readonly IntentAction[] = [
  IntentAction.None,
  IntentAction.Water,
  IntentAction.Plant,
  IntentAction.Harvest,
  IntentAction.Load,
  IntentAction.Unload,
  IntentAction.RefillHopper,
  IntentAction.Repair,
  IntentAction.WhackJam,
  IntentAction.Sell,
  IntentAction.Deconstruct,
  IntentAction.Buy,
];

/**
 * A pending errand: go there, then do that.
 *
 * WHY THIS IS WORLD STATE AND NOT CLIENT STATE. The obvious shortcut is to have the input
 * layer emit movement commands until the player is close enough and then emit the verb. That
 * shortcut is wrong twice over (plan §12): movement is a HELD DIRECTION precisely so the
 * trace stays small, and a client-driven walk would write a direction change into it every
 * few ticks for every click, forever — and a walk whose length is decided by client timing is
 * a walk whose length depends on framerate. Modelled here instead, an errand is one command,
 * and where the farmer ends up is a function of `seed + trace` like everything else.
 *
 * Integers only, and `null` when there is no errand — which is almost always.
 */
export interface PlayerIntent {
  /** What to do on arrival. Never `IntentAction.None` — that is what `null` is for. */
  action: IntentAction;
  /** The tile walked to. For a machine verb, a tile the machine's footprint covers. */
  tileX: number;
  tileY: number;
  /** `CropId` for Plant, `ItemId` for Sell and Buy, 0 for the verbs that need neither. */
  item: number;
  /** Stack size for Load, Unload, Sell, and Buy. 0 for verbs that move nothing countable. */
  count: number;
  /**
   * The tick the errand was issued. THE ONLY THING THE TIMEOUT IS MEASURED FROM — an errand
   * that can never complete is a farmer who can never move again, so every errand carries the
   * clock that eventually kills it.
   */
  issuedTick: number;
}

export interface PlayerState {
  /** Position in subtiles. */
  xSub: number;
  ySub: number;
  /** Last non-none direction, kept when the player stops. */
  facing: Direction;
  /** The direction currently held. `None` means standing still. */
  moveDir: Direction;
  /**
   * Sub-subtile movement remainder. 4 tiles/s at 20 Hz is 51.2 subtiles per tick, which is
   * not an integer — so movement accrues in hundredths and spends whole subtiles. Exact,
   * and the same technique every future rate that does not divide evenly will use.
   */
  moveAccum: number;
  /**
   * The one pending errand, or `null`.
   *
   * ONE AT A TIME, DELIBERATELY. A new click replaces the old errand rather than queueing
   * behind it: click-three-tiles-do-all-three is a different feature with its own interface
   * problems (what is the order, how do you cancel the second one, what does the marker show)
   * and none of them are solved by letting this field become an array.
   */
  intent: PlayerIntent | null;
}

/**
 * One machine in a box: the three dials, its condition, and its invoice.
 *
 * IT DOES NOT SAY WHICH KIND IT IS, because the slot it lives in already does — a boxed Fryer
 * is a `BoxedFryer` item, and a `kind` field here would be a second opinion about that. The
 * one time the two could disagree is the one time it would matter.
 *
 * It carries CONDITION as well as the dials, which the request did not ask for and which
 * closes a hole it would otherwise leave: net worth invoices a placed machine at
 * `investedCents × condition ÷ CONDITION_MAX`, so a box that forgot condition would make
 * boxing a worn Fryer *raise* the player's net worth. It also means the machine you put back
 * down is the machine you picked up. There is no exploit in the other direction, because hand
 * repair is free and unlimited (plan §1) — a free condition reset would be strictly slower
 * than just holding the repair button.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY IS PROGRESS. Banked work-points are not an item and
 * cannot be spilled, which is exactly why a running machine refuses to be boxed at all.
 */
export interface BoxedMachine {
  speedLevel: number;
  efficiencyLevel: number;
  capacityLevel: number;
  /** 0..CONDITION_MAX, as it stood when the machine came off the lot. */
  condition: number;
  /** Purchase price plus every upgrade bought. The 40% scrap payout is 40% of this. */
  investedCents: number;
}

export interface InventorySlot {
  item: ItemId;
  count: number;
  /**
   * One entry per boxed machine in this slot, or EMPTY for every ordinary good — which is all
   * of them but the twenty boxed-machine rows. `boxes.length` is always either 0 or `count`.
   *
   * A PARALLEL LIST ON THE SLOT RATHER THAN A SLOT PER MACHINE, because the alternative breaks
   * an invariant the whole inventory rests on: `inventory` is sorted by item id with one slot
   * per id, and `itemCount` stops scanning the moment it passes the id it wants. Two slots
   * holding boxed Fryers with different dials would make the second one invisible.
   *
   * SORTED, LEAST INVESTED FIRST, and that is not cosmetic. Two players who boxed the same
   * bare Fryer and the same maxed one in the opposite order are in the same world, and a
   * digest that read insertion order would call them different — the same argument that keeps
   * `unlocked` sorted and makes a pipe network's id geometric. It also settles, once and for
   * both verbs, which box comes out next: `PlaceMachine` puts down the plainest one it has and
   * `SellBoxedMachine` scraps the plainest one it has, so the machine you spent money on is
   * the last one you can lose by accident.
   */
  boxes: BoxedMachine[];
}

export interface CropTile {
  crop: CropId;
  /** Growth work-points accrued. Ready when it reaches `growthTarget`. */
  growth: number;
  /** Rolled per tile when planted, so a field ripens in waves rather than all at once. */
  growthTarget: number;
  /** 0..MOISTURE_MAX. Growth accrues only while this is above zero. */
  moisture: number;
  /** 1..3 stars. Decides yield. Decay-with-harvests arrives with soil types. */
  fertility: number;
  /**
   * Ticks this tile has stood mature and unharvested. THE ONLY CLOCK WITHERING HAS. It
   * advances inside `step()`, so it counts active factory minutes and nothing else — a
   * closed tab ages no crop, because time does not pass (plan §4, §6).
   */
  readyAge: number;
  /** Compost left by a crop that was never picked. Nothing vanishes (plan §4). */
  compost: number;
  /** The zone that claims this tile, or 0. A tile belongs to at most one zone. */
  zone: number;
}

/**
 * One typed port's live state: what network it found, what it is holding, and whether it got
 * everything it asked for last tick.
 *
 * The liquid is NOT stored here — it is in `MachineSpec.ports[i].liquid`, which is balance data
 * and already folded into `BALANCE_HASH`. A copy on the entity would be a second opinion about
 * what a machine's port accepts, and the port typing rule (`pipePathRefusal`) is only worth
 * anything if there is exactly one.
 */
export interface MachinePort {
  /** The pipe network this port is attached to, or 0. Recomputed on EDIT ONLY. */
  network: number;
  /** Millilitres held in this port's own buffer. */
  ml: number;
  /** Signed net flow over the last tick, in ml/min. Positive is in. */
  flowMlPerMinute: number;
  /** Asked its network for liquid and got less. Plan §5's amber, per port. */
  throttled: boolean;
}

export interface Machine {
  id: number;
  kind: MachineKind;
  /** Top-left tile of the footprint. */
  tileX: number;
  tileY: number;
  /** Work-points accrued toward the current operation. */
  progress: number;
  /**
   * How many of each of the spec's `inputs` this machine is holding, in the spec's order.
   *
   * PARALLEL TO THE RECIPE, NOT KEYED BY ITEM. A map from item id to count would be a second
   * place the recipe is written down, and the two would disagree the first time a spec changed
   * under a save. The array is sized from `spec.inputs.length` when the machine is built and
   * re-sized on load, so index `j` is always recipe line `j` and a machine that eats nothing
   * holds an empty array rather than a zero nobody reads.
   */
  inputCounts: number[];
  outputCount: number;
  /** Water held, in millilitres, for machines with a tank. */
  tankMl: number;
  /** 0..CONDITION_MAX. Wear is per completed operation, never per second. */
  condition: number;
  /** Completed operations, lifetime. Drives deterministic jamming. */
  opCount: number;
  /** Halted until whacked. Only ever set by a deterministic rule, never by a die roll. */
  jammed: boolean;
  /**
   * Consecutive ticks this machine has stood still with a full output buffer, reset to zero
   * the moment anything is taken out of it. Stays at zero on every machine whose spec names
   * no `overcookOutputItem`, because it is that rule's clock and nothing else's.
   *
   * IT COUNTS A LAYOUT CONDITION, NOT TIME. It only runs while demand-pull is holding the
   * machine stopped, which is a fact about what the player built — no belt off the Fryer, a
   * grabber pointed elsewhere, a basket nobody came back for. A closed tab advances it by
   * exactly nothing, because `step()` is the only thing that moves it.
   */
  blockedTicks: number;
  /**
   * How many of `outputCount` have turned into the spec's `overcookOutputItem`. Always
   * between 0 and `outputCount`, and always taken out FIRST — the burnt ones were at the
   * bottom of the basket, so they are the ones a grabber's hand closes on.
   */
  overcookedCount: number;
  /** Ticks until this machine's next periodic action, for machines that have one. */
  cooldown: number;
  /** Purchase price plus every upgrade bought since. What net worth invoices it at. */
  investedCents: number;
  /** 0..UPGRADE_MAX_LEVEL on each dial. Numbers only — dials never unlock a verb. */
  speedLevel: number;
  efficiencyLevel: number;
  capacityLevel: number;

  // --- the liquid layer (plan §5) ---
  //
  // Every field below is written by `pipes.ts` and read by `view.ts`. They are stored rather
  // than derived because the renderer must not compute network state of its own (plan §12),
  // and because a tank's net rate is a fact about the tick that just happened — there is
  // nowhere else for it to live.

  /**
   * The pipe network this machine is attached to, or 0. Recomputed on EDIT ONLY, by
   * `rebuildNetworks()`, never per tick.
   */
  network: number;
  /**
   * Signed net flow over the last tick, in millilitres per minute. Positive is in. This is
   * what a tank's **net rate and time-to-empty** are read off — plan §5's one label that
   * turns fluid management into arithmetic.
   */
  flowMlPerMinute: number;
  /**
   * Asked its network for water and got less than it asked for. Plan §5's AMBER DROPLET: the
   * network is over-demanded and every consumer on it is running slow, which is a readable
   * failure with a fixable cause rather than one machine mysteriously stopping.
   */
  throttled: boolean;
  /**
   * One entry per `MachineSpec.ports`, in the spec's order — empty for every machine whose
   * plumbing is its `network` / `tankMl` pair above, which is all of the water layer.
   *
   * A converter's ports are ingredients rather than utilities: each one holds its own liquid,
   * joins its own network, and is throttled on its own. That is what lets the Syrup Mixer be
   * amber on syrup while perfectly happy on water — one machine, two independent answers to
   * "is anything coming through", which is exactly what the player needs to know to fix it.
   */
  ports: MachinePort[];
  /**
   * Where the Irrigation Hub's rotating scan is up to, as an offset into its coverage patch.
   *
   * IT LIVES HERE AND NOT IN A MODULE VARIABLE. Module state is invisible to the hash and to
   * saves, so a cursor kept there would make two identically-saved worlds water different
   * tiles after a reload — the exact class of bug the golden fixtures exist to catch.
   */
  scanCursor: number;
  /** Tiles this machine has actually watered, lifetime. A Hub's saving is the gap between… */
  wateredCount: number;
  /** …this and that: tiles it looked at, found already wet, and deliberately skipped. */
  skippedCount: number;

  // --- the delivery cart (plan §3's assisted rung of selling) ---
  //
  // Three fields, all zero on every machine that is not a cart. They are here rather than in a
  // parallel `carts` array for the reason the plumbing fields are: a cart is placed, moved,
  // boxed, invoiced, ownership-gated and reach-checked by exactly the code that does all of
  // that for a Fryer, and a second entity type would be a second copy of every one of those
  // rules — the copies to drift being the ones nobody remembers exist.

  /**
   * The `ItemId` aboard, or 0 when the cart is empty.
   *
   * ONE PRODUCT PER RUN, and the single field is the enforcement. A cart is a cart, not a
   * warehouse: `LoadCart` refuses a second product rather than growing a per-item list, which
   * keeps "what is this cart worth" one multiplication and keeps the panel's one-line summary
   * honest. The depot is where mixed cargo lives, and it holds it per *route*.
   */
  cargoItem: ItemId | 0;
  /** Goods aboard. Never above `CART_CAPACITY`. */
  cargoCount: number;
  /**
   * Ticks until the cart is back, or 0 when it is standing in the yard.
   *
   * **`away` IS THIS BEING NON-ZERO — there is no second flag.** A boolean beside it would be a
   * duplicate of the same fact, and the tick that cleared one and forgot the other would leave a
   * cart that is permanently on the road or one that pays out twice. Arrival happens on the tick
   * this reaches zero, so the two can never disagree about which state the cart is in.
   */
  runTicksRemaining: number;

  /**
   * Consecutive ticks this machine has ADVANCED WORK with nobody's hands on it.
   *
   * The demonstrated half of the Corporate Charter (plan §3: *"one line untouched for 10 in-game
   * days"*), and `MilestoneKind.UntouchedLine` carries the full argument for the shape. Two rules
   * and no others: it advances on a tick the machine actually moved an operation forward, and it
   * drops to zero the moment a hand-verb lands on this machine — load, unload, refill, repair,
   * whack, upgrade, move.
   *
   * IT COUNTS WORK RATHER THAN TIME, which is what makes it a *production* line. A machine
   * standing idle in a corner is untouched in the sense that nobody visits it, and that is
   * exactly the sense the plan does not mean; ten days of a Fryer with nothing to fry would be a
   * charter earned by neglect. Because it only runs while the machine is producing, and a machine
   * cannot produce for 96,000 straight ticks unless something is feeding it and something is
   * taking the output away, the thing it certifies is a line.
   *
   * A closed tab advances it by nothing, like every other clock here: `step()` is the only thing
   * that moves it.
   */
  untouchedTicks: number;

  // --- the belt junction (plan §5's splitter and merger, one tile) ---
  //
  // Two cursors and no held item. On every machine that is not a junction they stay at zero, the
  // same way the cart's three fields do — and for the same reason set out on `cargoItem`: a
  // junction is placed, invoiced, ownership-gated, boxed and scrapped by exactly the code that
  // does all of that for a Fryer, so a parallel entity list would be a second copy of every one
  // of those rules.

  /**
   * Which face this junction looks at FIRST for an incoming item, 0..3 in compass order.
   *
   * **THIS IS THE MERGER'S FAIRNESS AND IT IS WORLD STATE, NEVER A ROLL.** Two belts feeding one
   * junction alternate because the cursor moves past whichever face was served; without it the
   * lower-numbered face would win every tick and the other line would starve. Item 024 states the
   * criterion exactly — round-robin state in the machine, in the hash, so the same seed and the
   * same command list produce the same hash across runs.
   */
  junctionInCursor: number;
  /**
   * Which face it offers an item to first, 0..3 in compass order. The splitter's alternation.
   *
   * SEPARATE FROM THE INTAKE CURSOR, and not for symmetry. One shared cursor was tried on paper
   * and it degenerates: a merger that advances the same counter on take *and* on place lands back
   * on the face it just served and feeds from one belt forever. Two cursors, two independent
   * rotations, one obvious behaviour.
   */
  junctionOutCursor: number;
}

/**
 * A body of water with a countable amount in it.
 *
 * Plan §4: "~10,000 units recharging ~20 u/min ... pumps halve below 25% and sip at recharge
 * rate when empty — **reservoirs always recover**." The level is the whole point: it falls
 * when drawn from, rises when left alone, and the shoreline moves with it, so overdraw is
 * telegraphed in the world rather than in a panel.
 */
export interface Reservoir {
  id: number;
  /** Top-left tile of the footprint. */
  tileX: number;
  tileY: number;
  tilesWide: number;
  tilesHigh: number;
  /** Millilitres in it now. Floors at zero; `water.ts` is the only thing that moves it. */
  levelMl: number;
  capacityMl: number;
  /**
   * Recharge remainder, in millilitre-ticks. 40,000 ml a minute is 33⅓ ml a tick, so this
   * accrues and spends whole millilitres — the same integer accumulator the player's movement
   * uses, and for the same reason: rounding a rate is a float wearing a disguise.
   */
  rechargeAccum: number;
}

/**
 * One tile of pipe.
 *
 * A PIPE HAS NO CONTENTS. There is no fill level here and there must never be one — plan §5's
 * model is flow, not pressure, and a per-segment volume is the first step down the road to a
 * solver. A pipe knows what liquid its network carries and which network it belongs to. That
 * is all a pipe is.
 */
export interface Pipe {
  id: number;
  tileX: number;
  tileY: number;
  liquid: LiquidId;
  /** Its network's id, or 0. Recomputed on edit by `rebuildNetworks()`. */
  network: number;
}

/**
 * One connected run of pipe, and its ledger.
 *
 * The id is GEOMETRIC — the lowest row-major world tile index among its pipes — so two worlds
 * that built the same plumbing in a different order agree, and laying a pipe across the map
 * cannot renumber a network somewhere else.
 */
export interface PipeNetwork {
  id: number;
  liquid: LiquidId;
  /** The pump-rate remainder, in millilitre-ticks. See `Reservoir.rechargeAccum`. */
  supplyAccum: number;
  /** The round-robin rotation. Advances one step every tick the network is over-demanded. */
  rrOffset: number;
  /** Last tick's numbers, for the hover readout. Supply is a capacity, not a forced flow. */
  supplyMl: number;
  demandMl: number;
  deliveredMl: number;
}

/**
 * One item riding a belt.
 *
 * PLAN §13's REPRESENTATION, AND IT IS LOAD-BEARING: a belt is a sorted list of
 * `(distanceAlongBelt, itemTypeId)` and nothing else. The renderer derives screen positions
 * from this list into a pooled particle buffer every frame — a rendered item is a query
 * result, not an object. There is no persistent particle per sim item, no id per item, and
 * no sync bookkeeping, which is exactly what makes `ParticleContainer` (no interactivity,
 * no children) survivable: picking a belt item is a sim-side lookup, not a sprite hit-test.
 */
export interface BeltItem {
  /** Subtiles from the belt's start. Strictly ascending within a belt. */
  dist: number;
  item: ItemId;
}

export interface Belt {
  id: number;
  /** The first tile of the segment. */
  tileX: number;
  tileY: number;
  /** Which way goods travel. Always a compass direction, never `None`. */
  dir: Direction;
  /** Tiles covered, including the first. Segments are straight; corners are two belts. */
  lengthTiles: number;
  tier: BeltTier;
  /** Sorted ascending by `dist`, never closer together than the tier's item spacing. */
  items: BeltItem[];
  /** Sub-subtile movement remainder, in hundredths — the same trick the player uses. */
  moveAccum: number;
}

export interface Grabber {
  id: number;
  tileX: number;
  tileY: number;
  /** The way the arm faces: it takes from behind and puts down ahead. */
  dir: Direction;
  tier: GrabberTier;
  /** Only move this item, or 0 for "anything". Mk1 arms cannot hold one. */
  filter: number;
  /** What the hand is holding, or 0. */
  held: number;
  /** Ticks left in the current swing. */
  cooldown: number;
  /** Items delivered, lifetime. A diagnostic, and a trophy stat. */
  opCount: number;
}

/**
 * A painted Grow Zone.
 *
 * A ZONE IS A PLAN, NOT A MACHINE (plan §5). Membership lives on the tiles (`CropTile.zone`)
 * rather than in a rect list here, because tiles belong to at most one zone and a flat
 * per-tile owner id is what makes "47/60 planted" unambiguous and O(1) to maintain.
 */
export interface Zone {
  id: number;
  /** Player-facing, clipped to `ZONE_NAME_MAX_LENGTH`. Cosmetic, and hashed anyway. */
  name: string;
  /** What the player intends to grow here. `CropId.None` means undecided. */
  crop: CropId;
  /** 0..9. Higher goes first when the seed hopper decides which zone to serve. */
  priority: number;
  /** Rejected until the seed hopper is researched — locked in the sim, not just the UI. */
  autoReplant: boolean;
  /** Ticks until this zone's next auto-replant attempt. */
  replantCooldown: number;
}

/**
 * Where a standing contract's current run is up to.
 *
 * STORED RATHER THAN DERIVED, and that is a deliberate exception to the rule that talked me out
 * of a second `away` flag on a cart. A cart has one state worth naming — out, or not — so a
 * timer says it all. A route is a **three-state machine** with one clock shared between two of
 * its states, and the alternatives are both worse: two timers (which can both be non-zero, a
 * world with no meaning) or a phase inferred from four other fields at every read (which is the
 * same rule written in three files, one of which will eventually round differently). The phase
 * IS the state; `ticksRemaining` is only its clock.
 */
export const ContractPhase = {
  /** Accumulating. The belt is filling the depot and nothing is going anywhere yet. */
  Waiting: 0,
  /** A run's worth is committed and the truck is at the dock with its engine running. */
  Loading: 1,
  /** On the road. It pays when it gets back, not when it left. */
  Rolling: 2,
} as const;

export type ContractPhase = (typeof ContractPhase)[keyof typeof ContractPhase];

/**
 * A standing contract: what to ship, how much per run, and where the truck says it is going.
 *
 * **LOGISTICS, NEVER PRICE.** Locked decision 3 and plan §8's cut-forever list mean there is no
 * price field here and there never will be — a run is worth `listPriceCents(item) × quantity`,
 * the same as the same goods carried to the bin by hand. Nothing in this shape can express a
 * bonus, a discount, a negotiation, or a counterparty, and that is the shape doing the work: a
 * future contributor who wants volume pricing has to add a field to this interface to get it,
 * which is exactly the friction plan §3's anti-double-dip rule buys in `TechNode`.
 *
 * Contracts live in a flat `WorldState.contracts` sorted by id rather than inside the depot they
 * belong to, for the reason belt items do not live on tiles: `CancelContract` names one by id,
 * and a nested list means every lookup is two loops and every id is only unique within a parent.
 */
export interface Contract {
  id: number;
  /** The depot fulfilling this route. A contract with no depot is deleted, never orphaned. */
  depotId: number;
  item: ItemId;
  /** Goods one run ships. 1..`CONTRACT_MAX_QUANTITY`, chosen once and never renegotiated. */
  quantityPerRun: number;
  /**
   * The name on the truck door. **FLAVOUR, AND NOT HASHED** — see the note in `hash.ts`.
   *
   * It is stored because the projection publishes it and a label that vanished on reload would
   * be worse than no label, but it has no mechanical effect of any kind: every destination pays
   * exactly list and every run takes exactly as long. The day a destination gains a distance or
   * a premium it stops being flavour, moves into `data.ts` as an id, and goes into the digest
   * that same day.
   */
  destination: string;
  /** Goods accumulated toward the next run. Counted at list by `computeNetWorthCents`. */
  stocked: number;
  /**
   * Goods on the truck right now, or 0.
   *
   * **THIS FIELD IS WHY LOADING A TRUCK DOES NOT DIP NET WORTH** (plan §6). Stock leaves
   * `stocked` and arrives here in the same tick, at the same list price, so the one number every
   * board is read off does not move at dispatch — it moves when the money arrives, which is when
   * something actually happened.
   */
  inTransit: number;
  phase: ContractPhase;
  /** Ticks left in the current phase. Zero while `Waiting`, which has no clock. */
  ticksRemaining: number;
  /** Completed runs, lifetime. A run completes when the truck is back, not when it left. */
  runsCompleted: number;
  /** Cents this route has grossed, lifetime. */
  grossCents: number;
}

/** One entry of the append-only input trace. */
export interface TraceEntry {
  tick: number;
  command: Command;
}

export interface WorldState {
  version: number;
  /** The uint32 every RNG stream in this world is derived from. */
  worldSeed: number;
  /** The tick about to be simulated. `createWorld` starts at 0. */
  tick: number;

  moneyCents: number;

  player: PlayerState;
  /** Sorted ascending by item id. Never contains a zero-count slot. */
  inventory: InventorySlot[];

  /**
   * The parcels this world has a deed to, as row-major parcel indices, **sorted ascending**.
   *
   * Sorted rather than purchase-ordered, for exactly the reason `unlocked` is: two players who
   * bought the same two parcels in the opposite order own the same land and must hash the same.
   * The order is not a record of what happened — the trace is — and a digest that read purchase
   * order would call two identical lots different worlds.
   *
   * A LIST OF INDICES RATHER THAN A PER-TILE FLAG. Ownership is a fact about a parcel, and 4,096
   * booleans would be 4,096 chances for a tile to disagree with the parcel it is in. Sixteen
   * entries at most, so every lookup in here is a scan over a list that fits in a cache line.
   *
   * Never empty: `STARTING_PARCEL` is a gift, like the sell bin and the pond, and a world with
   * no land is a world where nothing can be built or planted.
   */
  ownedParcels: number[];

  /** Row-major, `FIELD_TILES_WIDE * FIELD_TILES_HIGH` entries. Index is the tile's id. */
  field: CropTile[];

  /** Sorted ascending by id. */
  machines: Machine[];
  nextMachineId: number;

  /** Sorted ascending by id. */
  belts: Belt[];
  nextBeltId: number;

  /** Sorted ascending by id. */
  grabbers: Grabber[];
  nextGrabberId: number;

  /** Sorted ascending by id. */
  zones: Zone[];
  nextZoneId: number;

  /** Sorted ascending by id. Finite, recharging, and never permanently dry (plan §4). */
  reservoirs: Reservoir[];
  nextReservoirId: number;

  /** Sorted ascending by id. One tile each; a run is many. */
  pipes: Pipe[];
  nextPipeId: number;

  /**
   * Sorted ascending by id, and the id is the network's lowest world tile index rather than a
   * counter — so there is deliberately no `nextNetworkId`. Rebuilt from the pipe list on
   * every edit by `rebuildNetworks()`, never per tick.
   */
  networks: PipeNetwork[];

  /**
   * Standing contracts, sorted ascending by id.
   *
   * Flat rather than nested inside their depots — see `Contract`. A depot's routes are
   * `contractsForDepot()` in `commerce.ts`, which is a filtered scan over a list that will never
   * be longer than `DEPOT_MAX_CONTRACTS` times the number of depots on the lot.
   */
  contracts: Contract[];
  nextContractId: number;

  /**
   * One-shot celebrations this world has already played, sorted.
   *
   * Plan §3's Hall of Hands: "First activations get ~10 seconds of in-world theater
   * (sprinklers pop on down the rows)." The flag lives here rather than in the renderer so the
   * ceremony fires exactly once per WORLD and never replays after a reload — a first time that
   * happens twice is not a first time. The theatre itself is renderer-only and non-blocking;
   * the sim only records that it is owed.
   */
  ceremonies: string[];

  /**
   * Researched tech node ids, sorted ascending. Sorted rather than insertion-ordered so
   * two worlds that bought the same nodes in a different order hash identically — they are
   * the same world, and the digest has to agree.
   */
  unlocked: string[];

  /**
   * Per-system generator states, derived lazily on first draw. Lazy is deliberate: a world
   * that never draws from a stream never stores it, so introducing a new system leaves
   * existing worlds' hashes untouched. Only ever accessed by explicit key — never iterated
   * except through sorted keys in `hash.ts`.
   */
  streams: Record<string, RngState>;

  stats: WorldStats;

  /**
   * Append-only. Every command that was actually applied, in application order, never
   * mutated and never reordered.
   *
   * This is not dead anti-cheat code and must not be deleted as such — leaderboards are
   * only lightly validated (plan §10.9). It is here because seed + trace is a bug report
   * that reproduces exactly, which is the single most valuable debugging asset a solo dev
   * can have, and it costs an append-only array.
   */
  trace: TraceEntry[];
}

// --- construction -----------------------------------------------------------------

/**
 * Build a world deterministically from a seed. Same seed in, byte-identical world out, on
 * every machine, forever.
 */
export function createWorld(seed: number): WorldState {
  const worldSeed = Math.trunc(seed) >>> 0;
  const stats = createStats();

  const state: WorldState = {
    version: WORLD_STATE_VERSION,
    worldSeed,
    tick: 0,
    moneyCents: STARTING_MONEY_CENTS,
    player: {
      xSub: tileCentreSubtiles(FIELD_ORIGIN_X + divFloor(FIELD_TILES_WIDE, 2)),
      ySub: tileCentreSubtiles(FIELD_ORIGIN_Y + FIELD_TILES_HIGH),
      facing: Direction.North,
      moveDir: Direction.None,
      moveAccum: 0,
      intent: null,
    },
    inventory: [],
    // The starter lot is free (plan §5). One parcel, at the origin, which is exactly the map
    // every world before deeds was born on.
    ownedParcels: [STARTING_PARCEL],
    field: [],
    machines: [],
    nextMachineId: 1,
    belts: [],
    nextBeltId: 1,
    grabbers: [],
    nextGrabberId: 1,
    zones: [],
    nextZoneId: 1,
    reservoirs: [],
    nextReservoirId: 1,
    pipes: [],
    nextPipeId: 1,
    networks: [],
    contracts: [],
    nextContractId: 1,
    ceremonies: [],
    unlocked: [],
    streams: {},
    stats,
    trace: [],
  };

  const fieldRng = streamFor(state, SystemIds.FieldInit);
  for (let i = 0; i < FIELD_TILE_COUNT; i++) {
    state.field.push({
      crop: CropId.None,
      growth: 0,
      growthTarget: 0,
      moisture: 0,
      fertility: nextRange(fieldRng, FERTILITY_MIN, FERTILITY_MAX),
      readyAge: 0,
      compost: 0,
      zone: 0,
    });
  }

  // The roadside stand is a gift, not a purchase — selling by hand is the manual tier of
  // plan §3's ladder and must work from the first second.
  spawnMachine(state, MachineKind.SellBin, FIELD_ORIGIN_X - 2, FIELD_ORIGIN_Y + FIELD_TILES_HIGH);

  // And so is the pond. Plan §3's Liquids ladder starts at "bucket/can at the shore", so the
  // shore has to exist on the first second too — the can is free, indestructible, and works
  // from a full pond and an empty one alike.
  spawnReservoir(state, POND_ORIGIN_X, POND_ORIGIN_Y, POND_TILES_WIDE, POND_TILES_HIGH);

  addItem(state, ItemId.PotatoSeed, STARTING_SEEDS);
  state.stats.netWorthCents = computeNetWorthCents(state);
  state.stats.peakNetWorthCents = state.stats.netWorthCents;

  return state;
}

/**
 * A machine's recipe buffers, empty — one slot per line of the recipe, and none for a machine
 * with no recipe. Exported because loading a save has to size them the same way a build does.
 */
export function emptyInputCounts(spec: MachineSpec): number[] {
  const counts: number[] = [];
  for (let i = 0; i < spec.inputs.length; i++) counts.push(0);
  return counts;
}

/** A machine's typed ports, empty and unattached. */
export function emptyPorts(spec: MachineSpec): MachinePort[] {
  const ports: MachinePort[] = [];
  for (let i = 0; i < spec.ports.length; i++) {
    ports.push({ network: 0, ml: 0, flowMlPerMinute: 0, throttled: false });
  }
  return ports;
}

/** Place a machine without charging for it. Command handling does the money. */
export function spawnMachine(
  state: WorldState,
  kind: MachineKind,
  tileX: number,
  tileY: number,
): Machine | null {
  const spec = machineSpec(kind);
  if (spec === null) return null;

  const machine: Machine = {
    id: state.nextMachineId,
    kind,
    tileX,
    tileY,
    progress: 0,
    inputCounts: emptyInputCounts(spec),
    ports: emptyPorts(spec),
    outputCount: 0,
    tankMl: 0,
    condition: CONDITION_MAX,
    opCount: 0,
    jammed: false,
    blockedTicks: 0,
    overcookedCount: 0,
    cooldown: 0,
    investedCents: spec.priceCents,
    speedLevel: 0,
    efficiencyLevel: 0,
    capacityLevel: 0,
    network: 0,
    flowMlPerMinute: 0,
    throttled: false,
    scanCursor: 0,
    wateredCount: 0,
    skippedCount: 0,
    cargoItem: 0,
    cargoCount: 0,
    runTicksRemaining: 0,
    untouchedTicks: 0,
    junctionInCursor: 0,
    junctionOutCursor: 0,
  };
  state.nextMachineId += 1;
  // Ids only increase, so appending keeps the array sorted by id.
  state.machines.push(machine);
  return machine;
}

/** Put a body of water on the map. Full to start; the level is a fact from here on. */
export function spawnReservoir(
  state: WorldState,
  tileX: number,
  tileY: number,
  tilesWide: number,
  tilesHigh: number,
): Reservoir {
  const reservoir: Reservoir = {
    id: state.nextReservoirId,
    tileX,
    tileY,
    tilesWide,
    tilesHigh,
    levelMl: RESERVOIR_CAPACITY_ML,
    capacityMl: RESERVOIR_CAPACITY_ML,
    rechargeAccum: 0,
  };
  state.nextReservoirId += 1;
  state.reservoirs.push(reservoir);
  return reservoir;
}

/** Lay one tile of pipe. Network membership is assigned by `rebuildNetworks()`, not here. */
export function spawnPipe(state: WorldState, tileX: number, tileY: number, liquid: LiquidId): Pipe {
  const pipe: Pipe = { id: state.nextPipeId, tileX, tileY, liquid, network: 0 };
  state.nextPipeId += 1;
  state.pipes.push(pipe);
  return pipe;
}

/**
 * Record that a one-shot celebration is owed, exactly once per world.
 *
 * Returns true the first time and false forever after, which is what makes the Hub's
 * pop-on-down-the-rows theatre a first time rather than a recurring animation.
 */
export function markCeremony(state: WorldState, id: string): boolean {
  for (let i = 0; i < state.ceremonies.length; i++) {
    const current = state.ceremonies[i]!;
    if (current === id) return false;
    if (current > id) {
      state.ceremonies.splice(i, 0, id);
      return true;
    }
  }
  state.ceremonies.push(id);
  return true;
}

/** The ids `markCeremony` uses. Strings, and they are save surface, so they are permanent. */
export const CeremonyId = {
  /** Plan §3's named example: the first time an Irrigation Hub waters a row. */
  IrrigationHub: 'irrigation-hub-first-run',
  /** The first piped head that pours without anyone having filled it. */
  PipedSprinkler: 'piped-sprinkler-first-run',
  /**
   * THE ONE THE WHOLE v0.1 GATE IS ABOUT: the first time the $150 barrel sprinkler pours by
   * itself. It arrived last, after its two automated descendants already had ids, which is
   * exactly backwards — plan §8's ship/no-ship question is whether a fresh player grins at
   * THIS moment, and it was the only one of the three that could not be marked.
   */
  Sprinkler: 'sprinkler-first-run',
  /**
   * **THE FIRST TRUCK HONKS TWICE.** Plan §3's Hall of Hands names this one by example, beside
   * the sprinklers popping on down the rows — it is one of the two ceremonies the design itself
   * wrote down, and it is the fourth customer of a one-shot built in v0.1 for exactly this.
   *
   * Marked on the tick a truck leaves the dock, not on the tick a route is signed and not on the
   * tick it comes back: the horn belongs to the departure. A **cart** deliberately does not mark
   * it — a cart is not a truck, and giving the assisted rung the automated rung's moment would
   * spend the ceremony before the thing it is celebrating exists.
   */
  FirstTruck: 'truck-first-departure',
} as const;

export type CeremonyId = (typeof CeremonyId)[keyof typeof CeremonyId];

/** Place a belt without charging for it. */
export function spawnBelt(
  state: WorldState,
  tier: BeltTier,
  tileX: number,
  tileY: number,
  dir: Direction,
  lengthTiles: number,
): Belt | null {
  if (beltSpec(tier) === null) return null;

  const belt: Belt = {
    id: state.nextBeltId,
    tileX,
    tileY,
    dir,
    lengthTiles,
    tier,
    items: [],
    moveAccum: 0,
  };
  state.nextBeltId += 1;
  state.belts.push(belt);
  return belt;
}

/** Place a grabber without charging for it. */
export function spawnGrabber(
  state: WorldState,
  tier: GrabberTier,
  tileX: number,
  tileY: number,
  dir: Direction,
  filter: number,
): Grabber | null {
  if (grabberSpec(tier) === null) return null;

  const grabber: Grabber = {
    id: state.nextGrabberId,
    tileX,
    tileY,
    dir,
    tier,
    filter,
    held: 0,
    cooldown: 0,
    opCount: 0,
  };
  state.nextGrabberId += 1;
  state.grabbers.push(grabber);
  return grabber;
}

/** Create an empty zone. Painting tiles into it is a separate step. */
export function spawnZone(state: WorldState, crop: CropId): Zone {
  const id = state.nextZoneId;
  const zone: Zone = {
    id,
    name: clipZoneName(`Zone ${String(id)}`),
    crop,
    priority: ZONE_PRIORITY_DEFAULT,
    autoReplant: false,
    replantCooldown: 0,
  };
  state.nextZoneId += 1;
  state.zones.push(zone);
  return zone;
}

/** Clip rather than reject: a long name is a typo, not a reason to eat the command. */
export function clipZoneName(name: string): string {
  return name.length <= ZONE_NAME_MAX_LENGTH ? name : name.slice(0, ZONE_NAME_MAX_LENGTH);
}

/** Same rule for the name on a truck door, for the same reason. */
export function clipDestination(name: string): string {
  return name.length <= DESTINATION_MAX_LENGTH ? name : name.slice(0, DESTINATION_MAX_LENGTH);
}

/** A contract by id, or `null`. Sorted ascending, so the scan stops early on a miss. */
export function contractById(state: WorldState, id: number): Contract | null {
  for (let i = 0; i < state.contracts.length; i++) {
    const contract = state.contracts[i]!;
    if (contract.id === id) return contract;
    if (contract.id > id) return null;
  }
  return null;
}

// --- streams ----------------------------------------------------------------------

/**
 * The generator for one system of this world, derived on first use and stored thereafter.
 * This is the only way to reach randomness inside the sim.
 */
export function streamFor(state: WorldState, systemId: SystemId): RngState {
  const existing = state.streams[systemId];
  if (existing !== undefined) return existing;
  const created = deriveStream(state.worldSeed, systemId);
  state.streams[systemId] = created;
  return created;
}

// --- field ------------------------------------------------------------------------

export function isFieldTile(tileX: number, tileY: number): boolean {
  return (
    tileX >= FIELD_ORIGIN_X &&
    tileY >= FIELD_ORIGIN_Y &&
    tileX < FIELD_ORIGIN_X + FIELD_TILES_WIDE &&
    tileY < FIELD_ORIGIN_Y + FIELD_TILES_HIGH
  );
}

/** Row-major index of a world tile within the field, or -1 if it is not field. */
export function fieldIndex(tileX: number, tileY: number): number {
  if (!isFieldTile(tileX, tileY)) return -1;
  return (tileY - FIELD_ORIGIN_Y) * FIELD_TILES_WIDE + (tileX - FIELD_ORIGIN_X);
}

/** The world tile a field index sits on. The inverse of `fieldIndex`. */
export function fieldTileX(index: number): number {
  return FIELD_ORIGIN_X + (index % FIELD_TILES_WIDE);
}

export function fieldTileY(index: number): number {
  return FIELD_ORIGIN_Y + divFloor(index, FIELD_TILES_WIDE);
}

export function tileAt(state: WorldState, tileX: number, tileY: number): CropTile | null {
  const index = fieldIndex(tileX, tileY);
  if (index < 0) return null;
  return state.field[index] ?? null;
}

export function isInsideWorld(tileX: number, tileY: number): boolean {
  return tileX >= 0 && tileY >= 0 && tileX < WORLD_TILES_WIDE && tileY < WORLD_TILES_HIGH;
}

// --- land -------------------------------------------------------------------------
//
// INSIDE THE WORLD AND OWNED ARE TWO DIFFERENT QUESTIONS, and every build path has to ask both.
// The map is the maximum extent of the lot; ownership is how much of it is yours. Keeping them
// apart is what lets the renderer draw unowned ground — and the deed price standing on it —
// rather than an edge the camera simply refuses to show.
//
// WALKING IS NOT GATED ON EITHER, deliberately. Plan §5 sells deeds as the answer to "is space
// free?", which is a question about BUILDING; nothing in the plan fences the farmer in. Nothing
// in this world is solid enough to walk into (see `WALK_ERRAND_TIMEOUT_TICKS`), so an invisible
// wall around unowned land would be the first collision geometry in the game — and it would be
// there to stop the player walking over to read the price of the thing they are meant to buy.

export function isParcelOwned(state: WorldState, parcel: number): boolean {
  for (let i = 0; i < state.ownedParcels.length; i++) {
    if (state.ownedParcels[i] === parcel) return true;
  }
  return false;
}

/** True when a tile is inside the world AND on land this world holds the deed to. */
export function isOwnedTile(state: WorldState, tileX: number, tileY: number): boolean {
  const parcel = parcelIndexAt(tileX, tileY);
  return parcel >= 0 && isParcelOwned(state, parcel);
}

/**
 * What the next deed costs this world, in cents, or -1 when every parcel is already owned.
 *
 * Priced off HOW MANY have been bought, never off which one is being bought — see
 * `DEED_PRICE_CENTS_BY_PURCHASE`. `ownedParcels` always contains the free starting parcel, so
 * the count of purchases is one less than its length.
 */
export function nextDeedPriceCents(state: WorldState): number {
  return deedPriceCents(state.ownedParcels.length - 1);
}

/**
 * Whether a parcel is one this world could buy right now: on the map, not already owned, and
 * orthogonally touching land it already holds.
 *
 * ADJACENCY IS PLAN §5'S WORD — *"adjacent parcels are purchasable land deeds"* — and it is
 * load-bearing rather than decorative. Without it a player could buy the far corner and own two
 * disconnected islands with a stranger's field between them, which is a different game (§8's
 * campuses, and item 047's scope) reached by accident.
 */
export function isParcelBuyable(state: WorldState, parcel: number): boolean {
  if (!isParcelIndex(parcel)) return false;
  if (isParcelOwned(state, parcel)) return false;
  for (let i = 0; i < state.ownedParcels.length; i++) {
    if (parcelsAdjacent(state.ownedParcels[i]!, parcel)) return true;
  }
  return false;
}

/**
 * Record a parcel as owned, keeping the list sorted. Returns false if it was already there.
 *
 * Money is the caller's business, exactly as `spawnMachine` leaves the invoice to the reducer.
 */
export function ownParcel(state: WorldState, parcel: number): boolean {
  for (let i = 0; i < state.ownedParcels.length; i++) {
    const current = state.ownedParcels[i]!;
    if (current === parcel) return false;
    if (current > parcel) {
      state.ownedParcels.splice(i, 0, parcel);
      return true;
    }
  }
  state.ownedParcels.push(parcel);
  return true;
}

/**
 * What this world's land is worth on the books: the sum of the deeds it actually paid.
 *
 * LAND IS INVOICED, EXACTLY AS A MACHINE IS, and for plan §6's reason rather than for tidiness:
 * every board is net-worth-accounted so that *"investing during a window is neutral"*. A deed
 * that only ever subtracted cash would make buying land the one purchase in the game that costs
 * you a rung on the leaderboard, and a player racing a Peak Flow window would learn to stop
 * expanding — which is precisely backwards for the money sink land is supposed to be.
 *
 * Priced off the LADDER rather than off a per-parcel invoice stored in state, because the ladder
 * is what was paid: prices go by purchase count, so the first n purchases cost the first n rungs
 * whichever parcels they were. That is one fewer number in the save and one fewer chance for the
 * books to disagree with the till. The free starting parcel is worth nothing here — it was a
 * gift, and counting it would hand every fresh world a phantom $200.
 */
export function landValueCents(state: WorldState): number {
  let total = 0;
  const purchases = state.ownedParcels.length - 1;
  for (let i = 0; i < purchases; i++) {
    const price = deedPriceCents(i);
    if (price > 0) total += price;
  }
  return total;
}

export function isTileReady(tile: CropTile): boolean {
  return tile.crop !== CropId.None && tile.growth >= tile.growthTarget;
}

/**
 * Put a crop in the ground and roll its growth variance.
 *
 * The one place a tile is planted, so hand-planting and the seed hopper draw from the same
 * stream in the same way. Seed accounting is the caller's job — the hopper spends from the
 * player's stock and a hand-plant does too, but a future greenhouse might not.
 */
export function plantCrop(state: WorldState, tile: CropTile, spec: CropSpec): void {
  // Per-tile growth variance, so a field ripens in waves rather than all at once.
  const span = divFloor(spec.growthTicks * spec.growthVariancePermille, 1000);
  const jitter = nextRange(streamFor(state, SystemIds.CropGrowth), -span, span);

  tile.crop = spec.id;
  tile.growth = 0;
  tile.growthTarget = spec.growthTicks + jitter;
  tile.readyAge = 0;
}

// --- machines ---------------------------------------------------------------------

export function machineById(state: WorldState, id: number): Machine | null {
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    if (machine.id === id) return machine;
  }
  return null;
}

/**
 * What the next unit out of a machine's output buffer is, or `null` when it is empty.
 *
 * BURNT GOES FIRST. A Fryer's overcooked chips were at the bottom of the basket — they are
 * the batch that sat there while the buffer stayed full — so they are what the next hand or
 * grabber closes on. Taking them last would let a player drain the good chips and leave the
 * burnt ones to be quietly forgotten, which is both wrong and unreadable.
 */
export function nextOutputItem(machine: Machine, spec: MachineSpec): ItemId | null {
  if (machine.outputCount <= 0) return null;
  if (machine.overcookedCount > 0 && spec.overcookOutputItem !== null) {
    return spec.overcookOutputItem;
  }
  return spec.outputItem;
}

/**
 * Take exactly one unit out of a machine's output buffer and say what it was.
 *
 * THE ONE PLACE OUTPUT LEAVES A MACHINE — grabbers and the player's own hands both come
 * through here, for the same reason `takeWater()` is the only draw path: two code paths that
 * both decrement `outputCount` would eventually disagree about which grade came out.
 *
 * Any pull resets the overcook clock. A basket that moved is a basket out of the oil.
 */
export function takeOneOutput(machine: Machine, spec: MachineSpec): ItemId | null {
  const item = nextOutputItem(machine, spec);
  if (item === null) return null;

  const burnt = machine.overcookedCount > 0 && spec.overcookOutputItem !== null;
  machine.outputCount -= 1;
  if (burnt) machine.overcookedCount -= 1;
  machine.blockedTicks = 0;
  return item;
}

export function machineCoversTile(machine: Machine, tileX: number, tileY: number): boolean {
  const spec = machineSpec(machine.kind);
  if (spec === null) return false;
  return (
    tileX >= machine.tileX &&
    tileY >= machine.tileY &&
    tileX < machine.tileX + spec.tilesWide &&
    tileY < machine.tileY + spec.tilesHigh
  );
}

export function machineAt(state: WorldState, tileX: number, tileY: number): Machine | null {
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    if (machineCoversTile(machine, tileX, tileY)) return machine;
  }
  return null;
}

/** The subtile centre of a machine's footprint, for reach checks. */
export function machineCentreSubtiles(machine: Machine): { xSub: number; ySub: number } {
  const spec = machineSpec(machine.kind);
  const wide = spec === null ? 1 : spec.tilesWide;
  const high = spec === null ? 1 : spec.tilesHigh;
  return {
    xSub: tileCentreSubtiles(machine.tileX) + divFloor((wide - 1) * SUBTILE, 2),
    ySub: tileCentreSubtiles(machine.tileY) + divFloor((high - 1) * SUBTILE, 2),
  };
}

// --- belts and grabbers -----------------------------------------------------------

export function beltById(state: WorldState, id: number): Belt | null {
  for (let i = 0; i < state.belts.length; i++) {
    const belt = state.belts[i]!;
    if (belt.id === id) return belt;
  }
  return null;
}

/** How far along a belt an item can travel, in subtiles. */
export function beltEndDist(belt: Belt): number {
  return belt.lengthTiles * SUBTILE - 1;
}

/** Which tile of a belt a distance falls on, as an index from its start. */
export function beltTileIndexForDist(belt: Belt, dist: number): number {
  const index = divFloor(dist, SUBTILE);
  if (index < 0) return 0;
  return index >= belt.lengthTiles ? belt.lengthTiles - 1 : index;
}

/** The world tile at a given index along a belt. */
export function beltTileAtIndex(belt: Belt, index: number): { tileX: number; tileY: number } {
  return {
    tileX: belt.tileX + directionStepX(belt.dir) * index,
    tileY: belt.tileY + directionStepY(belt.dir) * index,
  };
}

/** The index of a world tile along a belt, or -1 if the belt does not cover it. */
export function beltIndexOfTile(belt: Belt, tileX: number, tileY: number): number {
  const dx = directionStepX(belt.dir);
  const dy = directionStepY(belt.dir);
  const offset = dx !== 0 ? (tileX - belt.tileX) * dx : (tileY - belt.tileY) * dy;
  if (offset < 0 || offset >= belt.lengthTiles) return -1;
  // The other axis has to match exactly, or a parallel belt one row over would answer.
  if (dx !== 0 && tileY !== belt.tileY) return -1;
  if (dy !== 0 && tileX !== belt.tileX) return -1;
  return offset;
}

export function beltCoversTile(belt: Belt, tileX: number, tileY: number): boolean {
  return beltIndexOfTile(belt, tileX, tileY) >= 0;
}

export function beltAt(state: WorldState, tileX: number, tileY: number): Belt | null {
  for (let i = 0; i < state.belts.length; i++) {
    const belt = state.belts[i]!;
    if (beltCoversTile(belt, tileX, tileY)) return belt;
  }
  return null;
}

/**
 * Insert an item at `dist`, keeping the list sorted and the spacing legal.
 *
 * Returns false and changes nothing when the slot is occupied — which is what a backed-up
 * belt looks like from the outside, and the reason a grabber holding an item is a jam the
 * player can see rather than an item that disappeared.
 */
export function beltInsert(belt: Belt, dist: number, item: ItemId): boolean {
  if (dist < 0 || dist > beltEndDist(belt)) return false;

  let insertAt = belt.items.length;
  for (let i = 0; i < belt.items.length; i++) {
    const existing = belt.items[i]!;
    const gap = existing.dist - dist;
    const spacing = gap < 0 ? -gap : gap;
    if (spacing < BELT_ITEM_SPACING_SUBTILES) return false;
    if (existing.dist > dist) {
      insertAt = i;
      break;
    }
  }

  belt.items.splice(insertAt, 0, { dist, item });
  return true;
}

export function grabberById(state: WorldState, id: number): Grabber | null {
  for (let i = 0; i < state.grabbers.length; i++) {
    const grabber = state.grabbers[i]!;
    if (grabber.id === id) return grabber;
  }
  return null;
}

export function grabberAt(state: WorldState, tileX: number, tileY: number): Grabber | null {
  for (let i = 0; i < state.grabbers.length; i++) {
    const grabber = state.grabbers[i]!;
    if (grabber.tileX === tileX && grabber.tileY === tileY) return grabber;
  }
  return null;
}

/**
 * True when anything at all already occupies a tile — including a pipe, and including open
 * water. A pond is scenery you cannot build on; a Pump stands on the bank next to it.
 */
export function tileOccupied(state: WorldState, tileX: number, tileY: number): boolean {
  return (
    machineAt(state, tileX, tileY) !== null ||
    beltAt(state, tileX, tileY) !== null ||
    grabberAt(state, tileX, tileY) !== null ||
    pipeAtTile(state, tileX, tileY) !== null ||
    reservoirAtTile(state, tileX, tileY) !== null
  );
}

/**
 * Pipe and reservoir lookups, duplicated here rather than imported.
 *
 * `pipes.ts` and `water.ts` both import from this module, so reaching back into them for a
 * two-line scan would be a cycle. These are the same rule written once more, and the tests
 * hold them together.
 */
function pipeAtTile(state: WorldState, tileX: number, tileY: number): Pipe | null {
  for (let i = 0; i < state.pipes.length; i++) {
    const pipe = state.pipes[i]!;
    if (pipe.tileX === tileX && pipe.tileY === tileY) return pipe;
  }
  return null;
}

function reservoirAtTile(state: WorldState, tileX: number, tileY: number): Reservoir | null {
  for (let i = 0; i < state.reservoirs.length; i++) {
    const reservoir = state.reservoirs[i]!;
    if (
      tileX >= reservoir.tileX &&
      tileY >= reservoir.tileY &&
      tileX < reservoir.tileX + reservoir.tilesWide &&
      tileY < reservoir.tileY + reservoir.tilesHigh
    ) {
      return reservoir;
    }
  }
  return null;
}

// --- zones ------------------------------------------------------------------------

export function zoneById(state: WorldState, id: number): Zone | null {
  for (let i = 0; i < state.zones.length; i++) {
    const zone = state.zones[i]!;
    if (zone.id === id) return zone;
  }
  return null;
}

/** How many field tiles a zone owns. */
export function zoneTileCount(state: WorldState, zoneId: number): number {
  let count = 0;
  for (let i = 0; i < state.field.length; i++) {
    if (state.field[i]!.zone === zoneId) count += 1;
  }
  return count;
}

/** Drop a zone and release its tiles. Called when the last tile is painted away. */
export function removeZone(state: WorldState, zoneId: number): void {
  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    if (tile.zone === zoneId) tile.zone = 0;
  }
  for (let i = 0; i < state.zones.length; i++) {
    if (state.zones[i]!.id === zoneId) {
      state.zones.splice(i, 1);
      return;
    }
  }
}

// --- inventory --------------------------------------------------------------------

export function itemCount(state: WorldState, item: ItemId): number {
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    if (slot.item === item) return slot.count;
    if (slot.item > item) return 0;
  }
  return 0;
}

/** The slot holding an item, or `null`. Callers must not reorder what they are handed. */
function slotFor(state: WorldState, item: ItemId): InventorySlot | null {
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    if (slot.item === item) return slot;
    if (slot.item > item) return null;
  }
  return null;
}

/** The slot holding an item, created empty and in sort order if it is not there yet. */
function ensureSlot(state: WorldState, item: ItemId): InventorySlot {
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    if (slot.item === item) return slot;
    if (slot.item > item) {
      const created: InventorySlot = { item, count: 0, boxes: [] };
      state.inventory.splice(i, 0, created);
      return created;
    }
  }
  const created: InventorySlot = { item, count: 0, boxes: [] };
  state.inventory.push(created);
  return created;
}

/** Add items, keeping the inventory sorted ascending by item id. */
export function addItem(state: WorldState, item: ItemId, count: number): void {
  if (count <= 0) return;
  ensureSlot(state, item).count += count;
}

/**
 * Remove items. Returns false and changes nothing if the player does not have them.
 *
 * A slot with boxes in it gives them up FROM THE FRONT, so `boxes.length === count` survives
 * any caller — including one written years from now that has never heard of a boxed machine.
 * Keeping that invariant here rather than at the call sites is the difference between a rule
 * and a convention, and a convention is what a hash notices first.
 */
export function removeItem(state: WorldState, item: ItemId, count: number): boolean {
  if (count <= 0) return true;
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    if (slot.item !== item) continue;
    if (slot.count < count) return false;
    slot.count -= count;
    if (slot.boxes.length > 0) slot.boxes.splice(0, count);
    if (slot.count === 0) state.inventory.splice(i, 1);
    return true;
  }
  return false;
}

/**
 * The canonical order boxes sit in inside a slot: least invested first, then the dials, then
 * condition. A TOTAL ORDER WITH NO TIES THAT MATTER — two boxes that compare equal on all five
 * numbers are interchangeable, so which one is "first" is not a fact anything can observe.
 *
 * Sorting rather than appending is what makes boxing order-independent: box a bare Fryer and a
 * maxed one in either sequence and the world hashes the same, because it *is* the same world.
 */
function compareBoxes(a: BoxedMachine, b: BoxedMachine): number {
  if (a.investedCents !== b.investedCents) return a.investedCents - b.investedCents;
  if (a.speedLevel !== b.speedLevel) return a.speedLevel - b.speedLevel;
  if (a.efficiencyLevel !== b.efficiencyLevel) return a.efficiencyLevel - b.efficiencyLevel;
  if (a.capacityLevel !== b.capacityLevel) return a.capacityLevel - b.capacityLevel;
  return a.condition - b.condition;
}

/** Put one boxed machine in the bag, in canonical order. */
export function addBoxedMachine(state: WorldState, item: ItemId, box: BoxedMachine): void {
  const slot = ensureSlot(state, item);
  let insertAt = slot.boxes.length;
  for (let i = 0; i < slot.boxes.length; i++) {
    if (compareBoxes(box, slot.boxes[i]!) < 0) {
      insertAt = i;
      break;
    }
  }
  slot.boxes.splice(insertAt, 0, box);
  slot.count += 1;
}

/** What the next boxed machine of a kind would be, without taking it. `null` when there is none. */
export function peekBoxedMachine(state: WorldState, item: ItemId): BoxedMachine | null {
  const slot = slotFor(state, item);
  if (slot === null) return null;
  return slot.boxes[0] ?? null;
}

/**
 * Take the next boxed machine of a kind out of the bag — the least invested one, which is the
 * same one `peekBoxedMachine` promised. Returns `null` and changes nothing when there is none.
 */
export function takeBoxedMachine(state: WorldState, item: ItemId): BoxedMachine | null {
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    if (slot.item !== item) continue;
    const box = slot.boxes.shift();
    if (box === undefined) return null;
    slot.count -= 1;
    if (slot.count === 0) state.inventory.splice(i, 1);
    return box;
  }
  return null;
}

/**
 * What a boxed machine is worth on the books: its invoice scaled by the condition it was boxed
 * at. THE SAME ARITHMETIC A PLACED MACHINE IS INVOICED AT below, deliberately — boxing a
 * machine and putting it back down must not move the one number plan §6's boards are read off.
 */
export function boxedMachineValueCents(box: BoxedMachine): number {
  return divFloor(box.investedCents * box.condition, CONDITION_MAX);
}

// --- money ------------------------------------------------------------------------

/**
 * Net worth: cash, plus inventory at list, plus machines at invoice scaled by condition,
 * plus everything sitting in a buffer or riding a belt, plus the land at what its deeds cost.
 *
 * Every board is net-worth-accounted (plan §6) so that investing during a scoring window
 * is neutral while letting machines rust is a visible loss. Upgrade spend counts through
 * `investedCents` for the same reason: an upgraded Fryer is worth more than a bare one, and
 * a board that said otherwise would punish the player for buying the dial. Growing crops
 * are deliberately not counted — they are not inventory until they are harvested.
 */
export function computeNetWorthCents(state: WorldState): number {
  let total = state.moneyCents;

  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    // A boxed machine is priced off its OWN invoice, never off a table — every boxed row lists
    // at zero for exactly that reason (see `ITEM_SPECS`), so these two lines cannot double-count
    // each other. A box in the bag is worth what the same machine standing on the lot is worth,
    // which is what makes deconstruct-and-replace a no-op on net worth rather than a trade.
    total += listPriceCents(slot.item) * slot.count;
    for (let j = 0; j < slot.boxes.length; j++) {
      total += boxedMachineValueCents(slot.boxes[j]!);
    }
  }

  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    const spec = machineSpec(machine.kind);
    if (spec === null) continue;
    total += divFloor(machine.investedCents * machine.condition, CONDITION_MAX);
    if (spec.outputItem !== null) {
      // A burnt batch is invoiced at what it will actually fetch, not at what it would have
      // fetched. Net worth that quietly counted twenty rustic chips as twenty good ones would
      // make neglect invisible on the one number plan §6's boards are read off.
      const overcooked = spec.overcookOutputItem;
      const burnt = overcooked === null ? 0 : machine.overcookedCount;
      total += listPriceCents(spec.outputItem) * (machine.outputCount - burnt);
      if (overcooked !== null && burnt > 0) total += listPriceCents(overcooked) * burnt;
    }
    // Every line of the recipe, at list. A Bottler holding six bottles is holding six bottles'
    // worth; liquid sitting in a port buffer is deliberately NOT counted, for the same reason a
    // growing crop is not — it is work in progress, not inventory, and there is no price on a
    // millilitre of anything anywhere in this game.
    for (let j = 0; j < spec.inputs.length; j++) {
      total += listPriceCents(spec.inputs[j]!.item) * (machine.inputCounts[j] ?? 0);
    }
    // A cart's cargo, standing in the yard or halfway to town. Plan §6: goods in transit are
    // still the player's inventory, and a board that dropped them for the length of a run would
    // record a loss at dispatch and a windfall on arrival — neither of which happened.
    if (machine.cargoItem !== 0) {
      total += listPriceCents(machine.cargoItem) * machine.cargoCount;
    }
  }

  // A depot's floor and its trucks. Both at list, and both for the same reason the cart's cargo
  // is: stock that came off a belt has been counted at list since the moment the Bagger made it,
  // and moving it into a shed and then onto a lorry must not be the two most expensive
  // decisions in the game. THIS IS WHAT MAKES "loading a truck does not dip net worth" TRUE —
  // `stocked` falls by exactly what `inTransit` rises by, at one price, inside one tick.
  for (let i = 0; i < state.contracts.length; i++) {
    const contract = state.contracts[i]!;
    total += listPriceCents(contract.item) * (contract.stocked + contract.inTransit);
  }

  for (let i = 0; i < state.belts.length; i++) {
    const belt = state.belts[i]!;
    const spec = beltSpec(belt.tier);
    if (spec !== null) total += spec.priceCentsPerTile * belt.lengthTiles;
    for (let j = 0; j < belt.items.length; j++) {
      total += listPriceCents(belt.items[j]!.item);
    }
  }

  for (let i = 0; i < state.grabbers.length; i++) {
    const grabber = state.grabbers[i]!;
    const spec = grabberSpec(grabber.tier);
    if (spec !== null) total += spec.priceCents;
    if (grabber.held !== 0) total += listPriceCents(grabber.held as ItemId);
  }

  // Pipe is an asset like belt is. WATER IS NOT: a pond is terrain rather than stock, and a
  // tank full of it is a machine doing its job, not inventory. Counting water would make
  // filling a tank read as profit and draining it as a loss, which is precisely backwards.
  total += PIPE_PRICE_CENTS_PER_TILE * state.pipes.length;

  // And the deeds, at what they cost. See `landValueCents` — buying land is investing, and
  // plan §6 says investing during a scoring window is neutral.
  total += landValueCents(state);

  return total;
}
