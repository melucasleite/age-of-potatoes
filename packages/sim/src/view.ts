// The render projection.
//
// `view()` RETURNS PLAIN SERIALIZABLE DATA — numbers and arrays written into reused
// buffers — NOT REFERENCES INTO LIVE STATE. Plan §12 rules on this explicitly and the
// ruling is not negotiable: handing out live references is free today and would make the
// eventual move to a Worker a rewrite instead of a transport change. Everything below is
// structured-cloneable and JSON-safe.
//
// The buffers are reused so a 20 Hz projection does not allocate a fresh world twenty
// times a second. Call `createWorldView()` once per host, keep it, and pass it back in.
// The returned object is only valid until the next `view()` call on the same buffer — a
// consumer that wants to keep a snapshot must copy it.
//
// Interpolated render positions are WRITE-ONLY and do not appear here. They exist in the
// renderer, are never read back into the sim, never persisted, and never hashed. The `alpha`
// the host passes to its draw call is the renderer's business alone.

import {
  ARMFUL_CAP_ITEMS,
  CAN_CHARGES_MAX,
  CART_CAPACITY,
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  CropId,
  DEPOT_STOCK_CAPACITY,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  FIELD_TILES_HIGH,
  FIELD_TILES_WIDE,
  FIELD_TILE_COUNT,
  MOISTURE_DRY_THRESHOLD,
  MOISTURE_MAX,
  MachineRole,
  type MachineSpec,
  PARCELS_HIGH,
  PARCELS_WIDE,
  PARCEL_COUNT,
  PARCEL_TILES,
  PortFlow,
  SPRINKLER_POUR_ML,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  WiltStage,
  boxedMachineScrapCents,
  cropSpec,
  grabberSpec,
  isNetworkConsumer,
  isSellable,
  machineKindForBoxedItem,
  machineSpec,
  wiltStageForAge,
} from './data';
import {
  cartRunTicks,
  depotRunTicks,
  depotStockedCount,
  isCart,
  isCartAway,
  isDepot,
} from './commerce';
import { networkFlowPermille, tankTicksToEmpty } from './pipes';
import { reservoirLevelPermille, reservoirThrottle } from './water';
import {
  type CropTile,
  type Grabber,
  type Machine,
  type WorldState,
  CeremonyId,
  carriedCount,
  isParcelBuyable,
  nextDeedPriceCents,
  tileAt,
} from './state';
import {
  bestTrailingGainCents,
  centiActiveHoursElapsed,
  centsPerKilolitre,
  lifetimeNetEarningsCents,
  totalManualTouches,
} from './stats';
import {
  effectiveInputCapacity,
  effectiveOutputCapacity,
  effectivePortCapacityMl,
} from './upgrades';
import { beatIndex, clampInt, divFloor, permille } from './units';

/**
 * Plan §5's status-lamp grammar, plus `Jammed`, which the renderer draws as the red
 * blocked lamp with its own icon. One grammar everywhere: a lamp means the same thing on
 * every machine in the game.
 */
export const LampState = {
  /** No work cycle — the sell bin, a decorative object. */
  Off: 0,
  /** Green. */
  Running: 1,
  /** Amber: no input. Look upstream. */
  Starved: 2,
  /** Red: output full. Look downstream. */
  Blocked: 3,
  /** Blue: a utility is missing — an empty sprinkler barrel, later an empty pipe. */
  UtilityMissing: 4,
  /** Red, with the whack icon. */
  Jammed: 5,
  /** Stopped dead at zero condition. Costs nothing, never explodes. */
  Halted: 6,
} as const;

export type LampState = (typeof LampState)[keyof typeof LampState];

/**
 * The field as parallel arrays, one entry per tile in row-major order. Parallel arrays
 * rather than per-tile objects because the renderer wants columns, and because 64 numbers
 * copy faster than 64 object writes.
 */
export interface FieldView {
  originX: number;
  originY: number;
  tilesWide: number;
  tilesHigh: number;
  /** `CropId` per tile. */
  crop: number[];
  /** Renderer growth stage, 0 (bare) up to the crop's ready stage. */
  stage: number[];
  /** Moisture as permille of full, so the ground can darken smoothly. */
  moisturePermille: number[];
  /** 1 when the tile can be harvested. */
  ready: number[];
  /** 1 when the tile reads as dry to the player. */
  dry: number[];
  fertility: number[];
  /** `SoilType` per tile: 1 loam, 2 sand, 3 clay. Rolled once, never changed. */
  soil: number[];
  /** `WiltStage` per tile: 0 fresh, 1 drooping, 2 turned. */
  wilt: number[];
  /** Ticks the tile has stood mature, for the "going Day-Old" countdown in the HUD. */
  readyAge: number[];
  /** Compost lying on the tile, waiting to be picked up. */
  compost: number[];
  /** Owning zone id, or 0. Drives the chunked zone-paint bake. */
  zone: number[];
}

export interface MachineView {
  id: number;
  kind: number;
  tileX: number;
  tileY: number;
  tilesWide: number;
  tilesHigh: number;
  lamp: number;
  /** 1 when the wrench overlay should show, independent of the lamp. */
  wrenchDue: number;
  progressPermille: number;
  conditionPermille: number;
  tankPermille: number;
  inputCount: number;
  outputCount: number;
  /** Effective buffer sizes, after the Capacity dial. */
  inputCapacity: number;
  outputCapacity: number;
  /** `ItemId` the machine eats and makes, or 0. Saves the HUD a spec lookup. */
  inputItem: number;
  outputItem: number;
  /**
   * How many of `outputCount` have overcooked, and what they turned into (0 for machines
   * whose output cannot spoil).
   *
   * Plan §5's "nothing invisible": a browning basket is a fact about the world the player is
   * entitled to see on the machine, and the cause — a full buffer nobody is emptying — is
   * standing right there next to it.
   */
  overcookedCount: number;
  overcookedItem: number;
  /** 0..3 on each dial, so the renderer can bolt on chrome exhausts and bigger hoppers. */
  speedLevel: number;
  efficiencyLevel: number;
  capacityLevel: number;
  /**
   * The zone a bot dock has been told to work, or 0 for none.
   *
   * PUBLISHED BECAUSE A BINDING NOBODY CAN READ BACK IS NOT A BINDING. `SetDockZone` has
   * been in the reducer, the hash and the save since [[038]], and the field never crossed
   * the view — so a player could point a dock at a zone and the panel had no way to show
   * which one, or whether it had worked. Zero is genuinely "unbound"; the dock card says so
   * rather than leaving a working robot undescribed.
   */
  boundZone: number;

  // --- the liquid layer ---

  /** The pipe network this machine is on, or 0. Matches a `NetworkView.id`. */
  network: number;
  /** Signed net flow last tick, in ml per minute. Positive is in. A TANK'S NET RATE. */
  flowMlPerMinute: number;
  /**
   * Ticks until a tank runs dry at its current net rate, or **-1 when it is not emptying**.
   *
   * The sentinel is the point: a tank at break-even has no time-to-empty, which is a different
   * fact from "zero seconds", and it is why nothing here divides by zero.
   */
  ticksToEmpty: number;
  /** 1 when this machine asked its network for water and got less. THE AMBER DROPLET. */
  throttled: number;
  /** Chebyshev radius this machine waters, for the placement coverage overlay. */
  coverageRadius: number;
  /** 1 when this machine waters only tiles that are actually dry. */
  moistureSensing: number;
  /** Tiles actually watered, lifetime. */
  wateredCount: number;
  /** Tiles looked at, found wet, and skipped — lifetime. The Hub's saving is the gap. */
  skippedCount: number;

  /**
   * Every line of the recipe and every typed port, for the machines that have more than one of
   * either. Empty for the whole chip line, which is why `inputItem` / `inputCount` above stay
   * exactly what they were: the single-ingredient reading is still true of almost everything,
   * and a HUD that never opens a Syrup Mixer never has to learn a second shape.
   */
  recipe: RecipeLineView[];
  ports: MachinePortView[];
}

/** One line of a machine's recipe, already reduced: what it wants, how much, what it has. */
export interface RecipeLineView {
  item: number;
  /** How many one operation takes. */
  perOperation: number;
  /** How many are sitting in the hopper. */
  count: number;
}

/**
 * One typed liquid port. THE ONE PLACE THE RENDERER LEARNS WHICH INLET IS STARVED.
 *
 * A Syrup Mixer amber on syrup and happy on water is one machine with two answers, and the
 * machine-level `throttled` flag can only carry one of them. `flow` is `PortFlow`: 1 in, 2 out.
 */
export interface MachinePortView {
  liquid: number;
  flow: number;
  network: number;
  ml: number;
  capacityMl: number;
  fillPermille: number;
  flowMlPerMinute: number;
  throttled: number;
}

/**
 * A reservoir, and enough for the renderer to draw a receding shoreline and a mud ring.
 *
 * `levelPermille` is the only number the shoreline needs: the water sits at that fraction of
 * the footprint and the mud ring is the band between it and the bank. The sim does not decide
 * how many rings there are or what they look like — that is the renderer's business, and it
 * is the one number that keeps the two in agreement.
 */
export interface ReservoirView {
  id: number;
  tileX: number;
  tileY: number;
  tilesWide: number;
  tilesHigh: number;
  levelMl: number;
  capacityMl: number;
  /** 0..1000. Falls when drawn from, rises when left alone. Overdraw is telegraphed here. */
  levelPermille: number;
  /** `ReservoirThrottle`: 0 full, 1 halved below 25%, 2 sipping at the recharge rate. */
  throttle: number;
}

/**
 * One tile of pipe.
 *
 * `liquid` is what it carries and `flowPermille` is how much of its network's demand is
 * actually being met — which is what the renderer tints with, and what makes an unfed pipe
 * render GREY. There is deliberately no fill level: plan §5's model is flow, not pressure.
 */
export interface PipeView {
  tileX: number;
  tileY: number;
  liquid: number;
  network: number;
  flowPermille: number;
}

/** One network's ledger, already reduced. Every number is millilitres for the last tick. */
export interface NetworkView {
  id: number;
  liquid: number;
  /** What the pump could have delivered. A capacity, never a forced flow. */
  supplyMl: number;
  /** What its consumers asked for. */
  demandMl: number;
  /** What actually landed. Never more than supply, over any interval. */
  deliveredMl: number;
  /** 0..1000 — deliveredMl over demandMl. Below 1000 means somebody is amber. */
  flowPermille: number;
  /** How many consumers are on it, so "3 heads sharing one pump" is one glance. */
  consumerCount: number;
}

/**
 * One belt segment and the items riding it.
 *
 * `itemDist` and `itemType` are PARALLEL ARRAYS, not objects, because the renderer wants
 * columns: it walks them straight into a pooled particle buffer. Both are trimmed to
 * `itemCount` on every projection, so a belt that empties does not leave stale tails.
 */
export interface BeltView {
  id: number;
  tileX: number;
  tileY: number;
  dir: number;
  lengthTiles: number;
  tier: number;
  itemCount: number;
  /** Subtiles from the belt's start, ascending. */
  itemDist: number[];
  /** `ItemId` per entry, same index. */
  itemType: number[];
}

export interface GrabberView {
  id: number;
  tileX: number;
  tileY: number;
  dir: number;
  tier: number;
  /** `ItemId` filter, or 0 for unfiltered. */
  filter: number;
  /** `ItemId` in the hand, or 0. */
  held: number;
  /** How far through the current swing, for the arm animation. */
  swingPermille: number;
  opCount: number;
  /**
   * Plan §5's lamp grammar, on the arm — `Running`, `Starved`, or `Blocked`, and never anything
   * else. See `grabberLamp`.
   */
  lamp: LampState;
}

/** A zone card's live readout, already reduced. Plan §5's "47/60 planted · 12 mature · 3 dry". */
export interface ZoneView {
  id: number;
  name: string;
  crop: number;
  priority: number;
  /** 1 when auto-replant is armed. */
  autoReplant: number;
  tiles: number;
  planted: number;
  mature: number;
  wilting: number;
  wilted: number;
  dry: number;
  compost: number;
}

/**
 * One boxed machine on an inventory row: what it will be when it goes back down, and what it
 * fetches if it does not.
 *
 * PUBLISHED PER BOX RATHER THAN PER ROW because that is the fact — three boxed Fryers are three
 * different machines at three different prices, and a row that reported "×3" and one set of
 * dials would be lying about two of them.
 *
 * The array order is the world's canonical order, least invested first, which is also the order
 * the two verbs consume in: `boxes[0]` is the box `PlaceMachine` will put down and the box
 * `SellBoxedMachine` will scrap. A panel that wants to say "next out" reads index 0.
 */
export interface BoxedMachineView {
  speedLevel: number;
  efficiencyLevel: number;
  capacityLevel: number;
  /** 0..CONDITION_MAX, as it was when the machine was boxed. Restored on placement. */
  condition: number;
  /** Purchase price plus every dial bought. Restored on placement. */
  investedCents: number;
  /** What `SellBoxedMachine` pays for THIS box: 40% of the invoice, floored. */
  scrapCents: number;
}

export interface InventoryView {
  item: number;
  count: number;
  /**
   * 1 when the sell bin will take this, 0 when it will refuse it — seeds and boxed machines.
   *
   * PROJECTED RATHER THAN LOOKED UP, so the HUD greys the affordance off the same fact the
   * reducer refuses on. `isSellable()` is exported too and says the same thing; this is here so
   * a list of inventory rows can be rendered without a spec lookup per row per frame.
   */
  sellable: number;
  /**
   * The `MachineKind` in this box, or 0 when the row is an ordinary good.
   *
   * IT IS THE ROW'S TYPE TAG, not a decoration: non-zero means the row is boxed machines, which
   * means `sellable` is 0 and the panel must offer `SellBoxedMachine` instead of `SellItem`, and
   * means the "place" affordance should arm the build tool for this kind. One integer, for the
   * same reason `sellable` is one integer — the alternative is a table lookup per row per frame.
   */
  boxedMachineKind: number;
  /** One entry per boxed machine. Empty on every ordinary row. Reused between frames. */
  boxes: BoxedMachineView[];
  /**
   * Ticks until the soonest-expiring part of this stack turns to Compost, or **-1 when nothing
   * in it ever will**.
   *
   * **A COUNTDOWN RATHER THAN THE DEADLINE, AND THAT IS THE ONE INTERESTING CHOICE HERE.** The
   * world stores an absolute `spoilAtTick` because an absolute tick needs nobody to decrement it
   * (see `FreshStack`); the HUD wants the opposite, because "4:12 left" is a sentence and "spoils
   * at tick 918,400" is not. Subtracting once, here, in the projection, is the seam doing its job
   * — the renderer never has to know what tick it is, which is the same reason it is handed
   * `stage` rather than `growth`.
   *
   * -1 for shelf-stable goods rather than a very large number, so "never" and "a long time" can
   * never be confused by a progress bar dividing by a maximum.
   */
  ticksToSpoil: number;
  /** How many units of this row are in that soonest-expiring heap. 0 when nothing perishes. */
  spoilingCount: number;
}

/**
 * Lifetime and today's sales of one item, for the Dawn Report's best seller.
 *
 * THE SHAPE IS `apps/web/src/reports/sim-contract.ts`'s `ItemSaleView`, VERBATIM — that file
 * wrote this projection's contract down before the sim half existed, and the reports layer
 * adopts it structurally the moment it appears. `dayCount` is `units - unitsAtDawn`,
 * subtracted here so the card does not have to difference anything.
 */
export interface ItemSaleView {
  item: number;
  count: number;
  grossCents: number;
  /** Sales since the most recent dawn. */
  dayCount: number;
  dayGrossCents: number;
}

/**
 * One dawn-aligned hour, as the Shift Report's strip reads it — `sim-contract.ts`'s
 * `HourBucketView`, verbatim. Closed hours come first, oldest first; the LAST entry is the
 * hour in progress, which the adopt branch recognises by `ticks < TICKS_PER_ACTIVE_HOUR`.
 */
export interface HourBucketView {
  hour: number;
  grossCents: number;
  spendCents: number;
  waterMl: number;
  itemsSold: number;
  ticks: number;
  /** Permille of machine throughput wasted this hour, or -1 when nothing ran. */
  wastePermille: number;
  /** -1: spoilage is not measured per hour yet — the accumulator does not exist in `WorldStats`. */
  spoilagePermille: number;
}

/** The numbers the HUD panel reads, already reduced. All integers, all cents or counts. */
export interface StatsView {
  centiActiveHours: number;
  lifetimeNetEarningsCents: number;
  /**
   * The two halves `lifetimeNetEarningsCents` is the difference of. Gross receipts and
   * everything spent, published separately so the shift report can say "took in X, spent Y"
   * rather than only "cleared Z" — a net figure alone cannot tell a good day with high costs
   * apart from a quiet one.
   */
  lifetimeEarnedCents: number;
  lifetimeSpentCents: number;
  netWorthCents: number;
  peakNetWorthCents: number;
  bestTrailingFiveHourGainCents: number;
  waterDrawnMl: number;
  centsPerKilolitre: number;
  itemsSold: number;
  itemsProducedByMachine: number;
  itemsHarvestedByHand: number;
  totalManualTouches: number;
  longestHandsFreeTicks: number;
  /**
   * The best run of untouched work any one machine has managed, in ticks — the Corporate
   * Charter's demonstrated half, published so the panel can show the counter climbing from the
   * first time it is opened (plan §7 ruling 3 forbids a milestone you discover by accident).
   *
   * TICKS RATHER THAN DAYS, because the projection publishes facts and leaves units to the
   * reader: the panel divides by `TICKS_PER_IN_GAME_DAY` to say "3 of 10 days", and a progress
   * bar that wants the fraction between two days has the numerator it needs.
   */
  longestUntouchedMachineTicks: number;
  /** Per-item sales, sparse, ascending by item id. Empty until something sells. */
  salesByItem: ItemSaleView[];
  /** Closed dawn-aligned hours oldest-first, then the hour in progress as the last entry. */
  hours: HourBucketView[];
}

export interface PlayerView {
  xSub: number;
  ySub: number;
  facing: number;
  /** 1 while a direction is held. */
  moving: number;
  /**
   * The pending errand's verb as an `IntentAction`, or `IntentAction.None` (0) when there is
   * no errand.
   *
   * THIS IS THE PRESENCE TEST — there is deliberately no separate flag. `None` is never a
   * legal action on a live errand (`applyWalkAndAct` refuses it and the save's
   * `ERRAND_ACTIONS` allowlist excludes it), so `intentAction !== 0` is exactly "an errand is
   * pending". A redundant boolean beside it would be a second copy of the same fact, and two
   * copies of one fact eventually disagree.
   *
   * The three fields below mean nothing when this is 0. They are still written every frame —
   * this buffer is reused forever, and a marker left over from last frame's errand is the bug
   * this design invites.
   */
  intentAction: number;
  /** The tile walked to. For a machine verb, a tile the machine's footprint covers. */
  intentTileX: number;
  intentTileY: number;
  /**
   * The tick the errand was issued, so a marker can age toward `WALK_ERRAND_TIMEOUT_TICKS`.
   * Compare against `view.tick`; the sim owns the deadline and the renderer only draws it.
   */
  intentIssuedTick: number;
  /** The `Machine.id` of the hand cart in tow, or 0. Non-zero is "draw the handles". */
  towedCartId: number;
  /**
   * Ordinary goods in the player's arms, and the cap it is measured against.
   *
   * **BOTH NUMBERS, RATHER THAN A FRACTION OR A "FULL" FLAG**, because the HUD has to be able to
   * say *12 / 12* — item 023's criterion is that the cap is visible, and a player who cannot
   * harvest needs to see the reason rather than a refusal. Boxed machines are excluded from the
   * count for the reason `ARMFUL_CAP_ITEMS` gives: a box is not a good.
   */
  carriedCount: number;
  armfulCap: number;
  /**
   * Pours left in the can, and the capacity it is measured against — both numbers, for the
   * same reason `carriedCount`/`armfulCap` are: the HUD says *3 / 8*, and `canCharges === 0`
   * is the refusal reason a `WaterTile` that did nothing wants explained ("the can is empty —
   * refill at the shore"). The refusal itself is a gentle no-op; this is how the view makes
   * it explainable rather than silent.
   */
  canCharges: number;
  canChargesMax: number;
}

/**
 * One Agri-Bot, in subtiles. Plan §3's "Spudnik".
 *
 * The renderer interpolates between frames from these and **never writes back** (§12): an
 * interpolated position exists on screen, is never persisted, never hashed, and never read into
 * the sim. `phase` is what a 2-frame walk cycle is driven off — walking, working, or standing —
 * and locked decision 10 designs that character down to fit generation rather than up.
 */
export interface BotView {
  id: number;
  kind: number;
  dockId: number;
  xSub: number;
  ySub: number;
  facing: number;
  /** `BotPhase`: 0 idle, 1 walking out, 2 working, 3 walking home. */
  phase: number;
  /** What it is carrying and how much, or 0. */
  carryItem: number;
  carryCount: number;
  /** 0..CONDITION_MAX, and the permille of it the HUD draws a bar from. */
  condition: number;
  conditionPermille: number;
  opCount: number;
}

/**
 * The lot: how it is divided, what the player owns, and what the next deed costs.
 *
 * PARCEL INDICES RATHER THAN A TILE MASK, so the renderer does the same arithmetic the sim
 * does instead of reading 4,096 flags twenty times a second. `parcelTiles` and `parcelsWide`
 * are here so nothing on the far side has to import balance data to turn an index into a
 * rectangle — the view is meant to be enough on its own, and one day it crosses a Worker.
 */
export interface LandView {
  /** Tiles per parcel edge. */
  parcelTiles: number;
  parcelsWide: number;
  parcelsHigh: number;
  /** Parcels this world holds the deed to, sorted ascending. Never empty. */
  owned: number[];
  /**
   * Parcels that could be bought right now: unowned, on the map, and touching owned land.
   *
   * Projected rather than re-derived on the far side because adjacency is a rule about the
   * world (plan §5's "adjacent parcels") and the sim is where rules live — a renderer that
   * decided for itself which parcels were for sale would eventually disagree with the reducer,
   * and the disagreement would look like a price tag on land that refuses to be bought.
   */
  buyable: number[];
  /**
   * What the next deed costs, in cents, or **-1 when every parcel is owned**.
   *
   * One price rather than a price per parcel, because that is how deeds are priced: by how many
   * you have bought, never by which one you are buying (`DEED_PRICE_CENTS_BY_PURCHASE`).
   */
  nextPriceCents: number;
}

/**
 * One delivery cart, as the panel draws it.
 *
 * Everything is ticks and counts. `away` is 1 exactly while `ticksRemaining` is above zero —
 * published as its own number because the far side reads it as a flag and re-deriving a flag on
 * every row of every frame is the lookup this projection exists to avoid.
 */
export interface CartView {
  id: number;
  tileX: number;
  tileY: number;
  /** Goods aboard right now. Counted toward net worth whether the cart is here or not (§6). */
  loaded: number;
  capacity: number;
  /** The `ItemId` aboard, or 0 when empty. A cart carries one product per run. */
  item: number;
  /** 1 while out on a run. */
  away: number;
  /** Ticks until it is back. Integer, counted down inside `step()` — there is no wall clock. */
  ticksRemaining: number;
  /**
   * What a full round trip takes from where this cart stands, so the panel can draw a track.
   *
   * IT IS PER-CART RATHER THAN A CONSTANT because distance is a decision now: the run is
   * `CART_RUN_BASE_TICKS` plus ten ticks for every tile between the cart and the road at the
   * lot's west edge. Two identical carts at opposite ends of a 64-tile lot have honestly
   * different journeys, and a shared constant would draw both progress bars wrong.
   */
  runTicks: number;
}

export interface DepotView {
  id: number;
  tileX: number;
  tileY: number;
  /** Goods on the floor across every route, awaiting a run. Excludes anything already rolling. */
  stocked: number;
  capacity: number;
  /** Route ids this depot fulfils, sorted ascending. */
  contractIds: number[];
  /** A full round trip for this depot's trucks, before the loading beat. */
  runTicks: number;
}

/**
 * One standing contract. **Logistics only** — what to ship and how much, never what it is worth.
 *
 * There is no price here and there never will be: prices are stable and posted, so the run value
 * the panel prints is arithmetic it does on `listPriceCents(item) × quantityPerRun`, displayed
 * rather than chosen. Nothing in this shape could carry a negotiation.
 */
export interface ContractView {
  id: number;
  depotId: number;
  item: number;
  quantityPerRun: number;
  /** Flavour label. Every destination pays exactly list; this is a name on a truck door. */
  destination: string;
  /** Stock counted toward the next run. */
  stocked: number;
  runsCompleted: number;
  grossCents: number;
  /** `ContractPhase`: 0 waiting on stock, 1 loading, 2 out on the road. */
  phase: number;
  ticksRemaining: number;
}

/** Selling above the roadside stand: plan §3's assisted and automated rungs. */
export interface CommerceView {
  carts: CartView[];
  depots: DepotView[];
  contracts: ContractView[];
  /** Lifetime gross that went out by cart or truck rather than by hand, in cents. */
  automatedGrossCents: number;
  /**
   * 1 once the first truck has left, so the two-honk ceremony plays exactly once and a reload
   * does not replay it. The flag is `CeremonyId.FirstTruck` in `WorldState.ceremonies`; this is
   * the same fact, projected as a number so the panel does not scan a string array per frame.
   */
  firstDepartureSeen: number;
}

export interface WorldView {
  tick: number;
  /** The Music Box beat this tick falls on. Audio schedules ahead against it. */
  beat: number;
  worldTilesWide: number;
  worldTilesHigh: number;
  /** The lot's parcels and what the player owns of them. */
  land: LandView;
  moneyCents: number;
  player: PlayerView;
  field: FieldView;
  machines: MachineView[];
  belts: BeltView[];
  grabbers: GrabberView[];
  /** Agri-Bots, in id order. Empty on a lot that has never bought a dock. */
  bots: BotView[];
  zones: ZoneView[];
  reservoirs: ReservoirView[];
  pipes: PipeView[];
  networks: NetworkView[];
  inventory: InventoryView[];
  /** Researched tech node ids, sorted. Copied, so the HUD cannot mutate the world's list. */
  unlocked: string[];
  /**
   * One-shot celebrations this world has already played, sorted. Plan §3's Hall of Hands.
   *
   * A ceremony id appearing here for the first time is the renderer's cue to play ~10 seconds
   * of in-world theatre — non-blocking, renderer-only, with `Math.random` jitter that never
   * touches a sim stream. It never appears twice, and it survives a reload, because a first
   * time that happens again is not a first time.
   */
  ceremonies: string[];
  /** Carts, depots, and standing routes. Empty on a lot that has bought neither. */
  commerce: CommerceView;
  stats: StatsView;
}

const TRAILING_WINDOW_MINUTES = 300;

/** Allocate a projection buffer. One per host; reuse it forever. */
export function createWorldView(): WorldView {
  return {
    tick: 0,
    beat: 0,
    worldTilesWide: WORLD_TILES_WIDE,
    worldTilesHigh: WORLD_TILES_HIGH,
    land: {
      parcelTiles: PARCEL_TILES,
      parcelsWide: PARCELS_WIDE,
      parcelsHigh: PARCELS_HIGH,
      owned: [],
      buyable: [],
      nextPriceCents: 0,
    },
    moneyCents: 0,
    player: {
      xSub: 0,
      ySub: 0,
      facing: 0,
      moving: 0,
      intentAction: 0,
      intentTileX: 0,
      intentTileY: 0,
      intentIssuedTick: 0,
      towedCartId: 0,
      carriedCount: 0,
      armfulCap: ARMFUL_CAP_ITEMS,
      canCharges: 0,
      canChargesMax: CAN_CHARGES_MAX,
    },
    field: {
      originX: FIELD_ORIGIN_X,
      originY: FIELD_ORIGIN_Y,
      tilesWide: FIELD_TILES_WIDE,
      tilesHigh: FIELD_TILES_HIGH,
      crop: new Array<number>(FIELD_TILE_COUNT).fill(0),
      stage: new Array<number>(FIELD_TILE_COUNT).fill(0),
      moisturePermille: new Array<number>(FIELD_TILE_COUNT).fill(0),
      ready: new Array<number>(FIELD_TILE_COUNT).fill(0),
      dry: new Array<number>(FIELD_TILE_COUNT).fill(0),
      fertility: new Array<number>(FIELD_TILE_COUNT).fill(0),
      soil: new Array<number>(FIELD_TILE_COUNT).fill(0),
      wilt: new Array<number>(FIELD_TILE_COUNT).fill(0),
      readyAge: new Array<number>(FIELD_TILE_COUNT).fill(0),
      compost: new Array<number>(FIELD_TILE_COUNT).fill(0),
      zone: new Array<number>(FIELD_TILE_COUNT).fill(0),
    },
    machines: [],
    belts: [],
    grabbers: [],
    bots: [],
    zones: [],
    reservoirs: [],
    pipes: [],
    networks: [],
    inventory: [],
    unlocked: [],
    ceremonies: [],
    commerce: {
      carts: [],
      depots: [],
      contracts: [],
      automatedGrossCents: 0,
      firstDepartureSeen: 0,
    },
    stats: {
      centiActiveHours: 0,
      lifetimeNetEarningsCents: 0,
      lifetimeEarnedCents: 0,
      lifetimeSpentCents: 0,
      netWorthCents: 0,
      peakNetWorthCents: 0,
      bestTrailingFiveHourGainCents: 0,
      waterDrawnMl: 0,
      centsPerKilolitre: 0,
      itemsSold: 0,
      itemsProducedByMachine: 0,
      itemsHarvestedByHand: 0,
      totalManualTouches: 0,
      longestHandsFreeTicks: 0,
      longestUntouchedMachineTicks: 0,
      salesByItem: [],
      hours: [],
    },
  };
}

/**
 * Project the world into `out`, allocating a fresh buffer only if none is given.
 *
 * Nothing in the result aliases `state`. Every number is copied.
 */
export function view(state: WorldState, out: WorldView = createWorldView()): WorldView {
  out.tick = state.tick;
  out.beat = beatIndex(state.tick);
  out.worldTilesWide = WORLD_TILES_WIDE;
  out.worldTilesHigh = WORLD_TILES_HIGH;
  out.moneyCents = state.moneyCents;

  out.player.xSub = state.player.xSub;
  out.player.ySub = state.player.ySub;
  out.player.facing = state.player.facing;
  out.player.moving = state.player.moveDir === 0 ? 0 : 1;

  // All four written unconditionally, on both branches. An early return or an `if` without an
  // `else` would leave the last errand's marker hanging on the map after the errand ended,
  // because this buffer is reused rather than reallocated.
  const intent = state.player.intent;
  out.player.intentAction = intent === null ? 0 : intent.action;
  out.player.intentTileX = intent === null ? 0 : intent.tileX;
  out.player.intentTileY = intent === null ? 0 : intent.tileY;
  out.player.intentIssuedTick = intent === null ? 0 : intent.issuedTick;
  out.player.towedCartId = state.player.towedCartId;
  out.player.carriedCount = carriedCount(state);
  out.player.armfulCap = ARMFUL_CAP_ITEMS;
  out.player.canCharges = state.player.canCharges;
  out.player.canChargesMax = CAN_CHARGES_MAX;

  projectLand(state, out);
  projectField(state, out);
  projectMachines(state, out);
  projectBelts(state, out);
  projectGrabbers(state, out);
  projectBots(state, out);
  projectZones(state, out);
  projectReservoirs(state, out);
  projectNetworks(state, out);
  projectPipes(state, out);
  projectInventory(state, out);
  projectUnlocked(state, out);
  projectCommerce(state, out);
  projectStats(state, out);

  return out;
}

function projectField(state: WorldState, out: WorldView): void {
  const field = out.field;
  field.originX = FIELD_ORIGIN_X;
  field.originY = FIELD_ORIGIN_Y;
  field.tilesWide = FIELD_TILES_WIDE;
  field.tilesHigh = FIELD_TILES_HIGH;

  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    const ready = tile.crop !== CropId.None && tile.growth >= tile.growthTarget;
    field.crop[i] = tile.crop;
    field.stage[i] = growthStage(tile);
    field.moisturePermille[i] = permille(tile.moisture, MOISTURE_MAX);
    field.ready[i] = ready ? 1 : 0;
    field.dry[i] = tile.moisture < MOISTURE_DRY_THRESHOLD ? 1 : 0;
    field.fertility[i] = tile.fertility;
    field.soil[i] = tile.soil;
    field.wilt[i] = ready ? wiltStageForAge(tile.readyAge) : WiltStage.Fresh;
    field.readyAge[i] = tile.readyAge;
    field.compost[i] = tile.compost;
    field.zone[i] = tile.zone;
  }

  field.crop.length = state.field.length;
  field.stage.length = state.field.length;
  field.moisturePermille.length = state.field.length;
  field.ready.length = state.field.length;
  field.dry.length = state.field.length;
  field.fertility.length = state.field.length;
  field.wilt.length = state.field.length;
  field.readyAge.length = state.field.length;
  field.compost.length = state.field.length;
  field.zone.length = state.field.length;
}

/** Bare soil is stage 0, ready is the crop's last stage, and growth fills the middle. */
export function growthStage(tile: CropTile): number {
  if (tile.crop === CropId.None) return 0;
  const spec = cropSpec(tile.crop);
  if (spec === null) return 0;
  if (tile.growth >= tile.growthTarget) return spec.stageCount - 1;

  const growingStages = spec.stageCount - 2;
  if (growingStages <= 0) return 0;
  const target = tile.growthTarget > 0 ? tile.growthTarget : 1;
  const stage = divFloor(tile.growth * growingStages, target);
  return 1 + clampInt(stage, 0, growingStages - 1);
}

function projectMachines(state: WorldState, out: WorldView): void {
  const count = state.machines.length;

  for (let i = 0; i < count; i++) {
    const machine = state.machines[i]!;
    const spec = machineSpec(machine.kind);

    let mv = out.machines[i];
    if (mv === undefined) {
      mv = {
        id: 0,
        kind: 0,
        tileX: 0,
        tileY: 0,
        tilesWide: 1,
        tilesHigh: 1,
        lamp: LampState.Off,
        wrenchDue: 0,
        progressPermille: 0,
        conditionPermille: 0,
        tankPermille: 0,
        inputCount: 0,
        outputCount: 0,
        inputCapacity: 0,
        outputCapacity: 0,
        inputItem: 0,
        outputItem: 0,
        overcookedCount: 0,
        overcookedItem: 0,
        speedLevel: 0,
        efficiencyLevel: 0,
        capacityLevel: 0,
        boundZone: 0,
        network: 0,
        flowMlPerMinute: 0,
        ticksToEmpty: -1,
        throttled: 0,
        coverageRadius: 0,
        moistureSensing: 0,
        wateredCount: 0,
        skippedCount: 0,
        recipe: [],
        ports: [],
      };
      out.machines.push(mv);
    }

    mv.id = machine.id;
    mv.kind = machine.kind;
    mv.tileX = machine.tileX;
    mv.tileY = machine.tileY;
    mv.tilesWide = spec === null ? 1 : spec.tilesWide;
    mv.tilesHigh = spec === null ? 1 : spec.tilesHigh;
    mv.lamp = lampFor(state, i);
    mv.wrenchDue = machine.condition < CONDITION_EFFECT_THRESHOLD ? 1 : 0;
    mv.progressPermille =
      spec === null || spec.workPerOperation <= 0
        ? 0
        : permille(machine.progress, spec.workPerOperation);
    mv.conditionPermille = permille(machine.condition, CONDITION_MAX);
    mv.tankPermille =
      spec === null || spec.tankCapacityMl <= 0 ? 0 : permille(machine.tankMl, spec.tankCapacityMl);
    // The FIRST recipe line, which is the whole recipe for every machine but one. `mv.recipe`
    // below carries the rest; nothing that only ever meets a Washer has to read it.
    mv.inputCount = machine.inputCounts[0] ?? 0;
    mv.outputCount = machine.outputCount;
    mv.inputCapacity = spec === null ? 0 : effectiveInputCapacity(spec, machine);
    mv.outputCapacity = spec === null ? 0 : effectiveOutputCapacity(spec, machine);
    mv.inputItem = spec === null || spec.inputs.length === 0 ? 0 : spec.inputs[0]!.item;
    mv.outputItem = spec === null || spec.outputItem === null ? 0 : spec.outputItem;
    mv.overcookedCount = machine.overcookedCount;
    mv.overcookedItem =
      spec === null || spec.overcookOutputItem === null ? 0 : spec.overcookOutputItem;
    mv.speedLevel = machine.speedLevel;
    mv.efficiencyLevel = machine.efficiencyLevel;
    mv.capacityLevel = machine.capacityLevel;
    mv.boundZone = machine.boundZone;
    mv.network = machine.network;
    mv.flowMlPerMinute = machine.flowMlPerMinute;
    // Computed in the sim, not the renderer: plan §12 says the renderer computes no network
    // state of its own, and a time-to-empty is exactly the sort of arithmetic that would
    // otherwise be reinvented twice and disagree.
    mv.ticksToEmpty =
      spec !== null && spec.role === MachineRole.Tank ? tankTicksToEmpty(machine) : -1;
    mv.throttled = machine.throttled ? 1 : 0;
    mv.coverageRadius = spec === null ? 0 : spec.coverageRadiusTiles;
    mv.moistureSensing = spec !== null && spec.moistureSensing ? 1 : 0;
    mv.wateredCount = machine.wateredCount;
    mv.skippedCount = machine.skippedCount;
    projectRecipe(machine, spec, mv);
    projectPorts(machine, spec, mv);
  }

  out.machines.length = count;
}

/**
 * The recipe and the ports, written into the view's own reused arrays.
 *
 * REUSED, NOT REALLOCATED, like every other buffer in this file: `view()` is called every frame
 * and a fresh array per machine per frame is exactly the allocation churn the projection buffer
 * exists to avoid. The arrays are truncated rather than emptied for the same reason.
 */
function projectRecipe(machine: Machine, spec: MachineSpec | null, mv: MachineView): void {
  const count = spec === null ? 0 : spec.inputs.length;
  for (let i = 0; i < count; i++) {
    const line = spec!.inputs[i]!;
    let lv = mv.recipe[i];
    if (lv === undefined) {
      lv = { item: 0, perOperation: 0, count: 0 };
      mv.recipe.push(lv);
    }
    lv.item = line.item;
    lv.perOperation = line.count;
    lv.count = machine.inputCounts[i] ?? 0;
  }
  mv.recipe.length = count;
}

function projectPorts(machine: Machine, spec: MachineSpec | null, mv: MachineView): void {
  const count = spec === null ? 0 : Math.min(spec.ports.length, machine.ports.length);
  for (let i = 0; i < count; i++) {
    const portSpec = spec!.ports[i]!;
    const port = machine.ports[i]!;
    const capacityMl = effectivePortCapacityMl(portSpec, machine);

    let pv = mv.ports[i];
    if (pv === undefined) {
      pv = {
        liquid: 0,
        flow: 0,
        network: 0,
        ml: 0,
        capacityMl: 0,
        fillPermille: 0,
        flowMlPerMinute: 0,
        throttled: 0,
      };
      mv.ports.push(pv);
    }
    pv.liquid = portSpec.liquid;
    pv.flow = portSpec.flow;
    pv.network = port.network;
    pv.ml = port.ml;
    pv.capacityMl = capacityMl;
    pv.fillPermille = permille(port.ml, capacityMl);
    pv.flowMlPerMinute = port.flowMlPerMinute;
    pv.throttled = port.throttled ? 1 : 0;
  }
  mv.ports.length = count;
}

function projectReservoirs(state: WorldState, out: WorldView): void {
  const count = state.reservoirs.length;

  for (let i = 0; i < count; i++) {
    const reservoir = state.reservoirs[i]!;

    let rv = out.reservoirs[i];
    if (rv === undefined) {
      rv = {
        id: 0,
        tileX: 0,
        tileY: 0,
        tilesWide: 1,
        tilesHigh: 1,
        levelMl: 0,
        capacityMl: 0,
        levelPermille: 0,
        throttle: 0,
      };
      out.reservoirs.push(rv);
    }

    rv.id = reservoir.id;
    rv.tileX = reservoir.tileX;
    rv.tileY = reservoir.tileY;
    rv.tilesWide = reservoir.tilesWide;
    rv.tilesHigh = reservoir.tilesHigh;
    rv.levelMl = reservoir.levelMl;
    rv.capacityMl = reservoir.capacityMl;
    rv.levelPermille = reservoirLevelPermille(reservoir);
    rv.throttle = reservoirThrottle(reservoir);
  }

  out.reservoirs.length = count;
}

function projectNetworks(state: WorldState, out: WorldView): void {
  const count = state.networks.length;

  for (let i = 0; i < count; i++) {
    const network = state.networks[i]!;

    let nv = out.networks[i];
    if (nv === undefined) {
      nv = {
        id: 0,
        liquid: 0,
        supplyMl: 0,
        demandMl: 0,
        deliveredMl: 0,
        flowPermille: 0,
        consumerCount: 0,
      };
      out.networks.push(nv);
    }

    nv.id = network.id;
    nv.liquid = network.liquid;
    nv.supplyMl = network.supplyMl;
    nv.demandMl = network.demandMl;
    nv.deliveredMl = network.deliveredMl;
    nv.flowPermille = networkFlowPermille(network);
    nv.consumerCount = 0;
  }

  out.networks.length = count;
  if (count === 0) return;

  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    if (machine.network === 0) continue;
    const spec = machineSpec(machine.kind);
    if (spec === null || !isNetworkConsumer(spec.role)) continue;
    for (let j = 0; j < count; j++) {
      const nv = out.networks[j]!;
      if (nv.id === machine.network) {
        nv.consumerCount += 1;
        break;
      }
    }
  }
}

/**
 * Pipes as flat tiles, each already carrying its network's flow.
 *
 * Carrying the flow per tile rather than making the renderer join pipes to networks is what
 * lets the pipe layer be a straight tile-by-tile tint pass with no lookups — and GREY WHEN
 * EMPTY, which is the diagnostic instrument that finds a dead line without opening anything.
 */
function projectPipes(state: WorldState, out: WorldView): void {
  const count = state.pipes.length;

  for (let i = 0; i < count; i++) {
    const pipe = state.pipes[i]!;

    let pv = out.pipes[i];
    if (pv === undefined) {
      pv = { tileX: 0, tileY: 0, liquid: 0, network: 0, flowPermille: 0 };
      out.pipes.push(pv);
    }

    pv.tileX = pipe.tileX;
    pv.tileY = pipe.tileY;
    pv.liquid = pipe.liquid;
    pv.network = pipe.network;

    let flow = 0;
    for (let j = 0; j < out.networks.length; j++) {
      const nv = out.networks[j]!;
      if (nv.id === pipe.network) {
        flow = nv.flowPermille;
        break;
      }
    }
    pv.flowPermille = flow;
  }

  out.pipes.length = count;
}

/**
 * Belts, items and all.
 *
 * The item arrays are reused and trimmed rather than rebuilt: at three belt tiers and a
 * mature base this is the hottest loop in the projection, and it is the one place where
 * "plain data in reused buffers" earns its keep twenty times a second.
 */
function projectBelts(state: WorldState, out: WorldView): void {
  const count = state.belts.length;

  for (let i = 0; i < count; i++) {
    const belt = state.belts[i]!;

    let bv = out.belts[i];
    if (bv === undefined) {
      bv = {
        id: 0,
        tileX: 0,
        tileY: 0,
        dir: 0,
        lengthTiles: 0,
        tier: 0,
        itemCount: 0,
        itemDist: [],
        itemType: [],
      };
      out.belts.push(bv);
    }

    bv.id = belt.id;
    bv.tileX = belt.tileX;
    bv.tileY = belt.tileY;
    bv.dir = belt.dir;
    bv.lengthTiles = belt.lengthTiles;
    bv.tier = belt.tier;

    const items = belt.items.length;
    for (let j = 0; j < items; j++) {
      const entry = belt.items[j]!;
      bv.itemDist[j] = entry.dist;
      bv.itemType[j] = entry.item;
    }
    bv.itemDist.length = items;
    bv.itemType.length = items;
    bv.itemCount = items;
  }

  out.belts.length = count;
}

/**
 * An arm's lamp, read off the two fields that already say everything (plan §5's grammar).
 *
 * A GRABBER'S WHOLE STATE MACHINE IS `held` AND `cooldown`, so this needs no new field and no
 * re-simulation: mid-swing means it moved something and is green; standing empty means it reached
 * back and found nothing, which is amber, look upstream; standing full means it reached forward
 * and was refused, which is red, look downstream. `advanceGrabber` leaves the cooldown at zero on
 * exactly the ticks it failed, which is why the two failures are distinguishable at all.
 *
 * The stuck arm holding an item was always visible in the world — item 024 called that the
 * readable version of "look downstream" — but "visible if you know what you are looking at" is
 * not the same as a lamp, and a starved arm and a blocked one otherwise look identical from ten
 * tiles up. `render/grabbers.ts` draws it as a fourth sprite riding the pedestal's top-right
 * corner, through the same `lamps.ts` vocabulary every machine uses.
 */
function grabberLamp(grabber: Grabber): LampState {
  if (grabber.cooldown > 0) return LampState.Running;
  return grabber.held === 0 ? LampState.Starved : LampState.Blocked;
}

function projectGrabbers(state: WorldState, out: WorldView): void {
  const count = state.grabbers.length;

  for (let i = 0; i < count; i++) {
    const grabber = state.grabbers[i]!;
    const spec = grabberSpec(grabber.tier);

    let gv = out.grabbers[i];
    if (gv === undefined) {
      gv = {
        id: 0,
        tileX: 0,
        tileY: 0,
        dir: 0,
        tier: 0,
        filter: 0,
        held: 0,
        swingPermille: 0,
        opCount: 0,
        lamp: LampState.Off,
      };
      out.grabbers.push(gv);
    }

    gv.id = grabber.id;
    gv.tileX = grabber.tileX;
    gv.tileY = grabber.tileY;
    gv.dir = grabber.dir;
    gv.tier = grabber.tier;
    gv.filter = grabber.filter;
    gv.held = grabber.held;
    gv.swingPermille =
      spec === null || spec.swingTicks <= 0
        ? 0
        : permille(spec.swingTicks - grabber.cooldown, spec.swingTicks);
    gv.opCount = grabber.opCount;
    gv.lamp = grabberLamp(grabber);
  }

  out.grabbers.length = count;
}

/**
 * Zone cards, with their readouts already counted.
 *
 * One pass over the field per projection rather than one per zone: the counts are gathered
 * into the view objects in a single sweep, keyed by the tile's owner. Zones are few and the
 * field is small, but the shape is the one that stays cheap when the map is 64×64.
 */
function projectZones(state: WorldState, out: WorldView): void {
  const count = state.zones.length;

  for (let i = 0; i < count; i++) {
    const zone = state.zones[i]!;

    let zv = out.zones[i];
    if (zv === undefined) {
      zv = {
        id: 0,
        name: '',
        crop: 0,
        priority: 0,
        autoReplant: 0,
        tiles: 0,
        planted: 0,
        mature: 0,
        wilting: 0,
        wilted: 0,
        dry: 0,
        compost: 0,
      };
      out.zones.push(zv);
    }

    zv.id = zone.id;
    zv.name = zone.name;
    zv.crop = zone.crop;
    zv.priority = zone.priority;
    zv.autoReplant = zone.autoReplant ? 1 : 0;
    zv.tiles = 0;
    zv.planted = 0;
    zv.mature = 0;
    zv.wilting = 0;
    zv.wilted = 0;
    zv.dry = 0;
    zv.compost = 0;
  }

  out.zones.length = count;
  if (count === 0) return;

  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    if (tile.zone === 0) continue;

    let zv: ZoneView | undefined;
    for (let j = 0; j < count; j++) {
      const candidate = out.zones[j]!;
      if (candidate.id === tile.zone) {
        zv = candidate;
        break;
      }
    }
    if (zv === undefined) continue;

    zv.tiles += 1;
    zv.compost += tile.compost;
    if (tile.moisture < MOISTURE_DRY_THRESHOLD) zv.dry += 1;
    if (tile.crop === CropId.None) continue;

    zv.planted += 1;
    if (tile.growth < tile.growthTarget) continue;

    const stage = wiltStageForAge(tile.readyAge);
    if (stage === WiltStage.Wilted) zv.wilted += 1;
    else if (stage === WiltStage.Wilting) zv.wilting += 1;
    else zv.mature += 1;
  }
}

/**
 * The lot. Sixteen parcels at most, so the buyable scan is cheaper than the array it fills.
 *
 * Written into the reused buffer with `length =` at the end, exactly as `unlocked` is: a deed
 * bought is a parcel that must leave `buyable`, and a stale index left over from last frame is
 * a price tag standing on land the player already owns.
 */
function projectLand(state: WorldState, out: WorldView): void {
  const land = out.land;
  land.parcelTiles = PARCEL_TILES;
  land.parcelsWide = PARCELS_WIDE;
  land.parcelsHigh = PARCELS_HIGH;

  for (let i = 0; i < state.ownedParcels.length; i++) {
    land.owned[i] = state.ownedParcels[i]!;
  }
  land.owned.length = state.ownedParcels.length;

  let count = 0;
  for (let parcel = 0; parcel < PARCEL_COUNT; parcel++) {
    if (!isParcelBuyable(state, parcel)) continue;
    land.buyable[count] = parcel;
    count += 1;
  }
  land.buyable.length = count;

  land.nextPriceCents = nextDeedPriceCents(state);
}

function projectUnlocked(state: WorldState, out: WorldView): void {
  for (let i = 0; i < state.unlocked.length; i++) {
    out.unlocked[i] = state.unlocked[i]!;
  }
  out.unlocked.length = state.unlocked.length;

  for (let i = 0; i < state.ceremonies.length; i++) {
    out.ceremonies[i] = state.ceremonies[i]!;
  }
  out.ceremonies.length = state.ceremonies.length;
}

function lampFor(state: WorldState, index: number): LampState {
  const machine = state.machines[index]!;
  const spec = machineSpec(machine.kind);
  if (spec === null) return LampState.Off;

  if (machine.jammed) return LampState.Jammed;
  if (machine.condition <= 0) return LampState.Halted;

  if (spec.role === MachineRole.Sprinkler) {
    return machine.tankMl <= 0 ? LampState.UtilityMissing : LampState.Running;
  }

  // ONE LAMP GRAMMAR, EVERYWHERE (plan §5). A head with a dry buffer shows the BLUE utility
  // lamp, the same as a sprinkler with an empty barrel, because it means the same thing: the
  // thing that feeds me is not feeding me. A head that is getting water but less than it
  // asked for shows AMBER, the "look upstream" lamp — and upstream of a head is the pump,
  // which is exactly where the player should go.
  if (spec.role === MachineRole.PipedSprinkler) {
    if (machine.tankMl < SPRINKLER_POUR_ML) return LampState.UtilityMissing;
    return machine.throttled ? LampState.Starved : LampState.Running;
  }

  if (spec.role === MachineRole.Pump) {
    // A pump whose source has run out is not broken, it is thirsty. Blue says "the utility
    // behind me is missing", which is precisely true of a dry pond.
    return machine.flowMlPerMinute <= 0 ? LampState.UtilityMissing : LampState.Running;
  }

  if (spec.role === MachineRole.Tank) {
    return machine.tankMl <= 0 ? LampState.UtilityMissing : LampState.Running;
  }

  if (spec.role === MachineRole.Recirculator) {
    return machine.flowMlPerMinute <= 0 ? LampState.Starved : LampState.Running;
  }

  if (spec.workPerOperation <= 0) return LampState.Off;
  // Blocked before starved: a machine that is both is a downstream problem, and plan §5's
  // grammar says a red lamp means look downstream while amber means look upstream.
  if (spec.outputItem !== null && machine.outputCount >= effectiveOutputCapacity(spec, machine)) {
    return LampState.Blocked;
  }
  for (let i = 0; i < spec.ports.length; i++) {
    const portSpec = spec.ports[i]!;
    const port = machine.ports[i];
    if (port === undefined) continue;
    // A full OUTLET is red for the same reason a full basket is: the machine has finished
    // something and nobody has come for it. A Juicer with 4 litres of juice and no kettle on
    // the end of the pipe is a blocked machine, not a broken one.
    if (portSpec.flow === PortFlow.Outlet) {
      if (port.ml + portSpec.mlPerOperation > effectivePortCapacityMl(portSpec, machine)) {
        return LampState.Blocked;
      }
      continue;
    }
    // And a dry INLET is blue — "the utility behind me is missing" — while a throttled one is
    // amber. Same grammar as a piped sprinkler, because it is the same situation one machine
    // further down the organ.
    if (port.ml < portSpec.mlPerOperation) return LampState.UtilityMissing;
    if (port.throttled) return LampState.Starved;
  }
  for (let i = 0; i < spec.inputs.length; i++) {
    if ((machine.inputCounts[i] ?? 0) < spec.inputs[i]!.count) return LampState.Starved;
  }
  return LampState.Running;
}

/** Bots, pooled into the reused buffer exactly as machines and grabbers are. */
function projectBots(state: WorldState, out: WorldView): void {
  const count = state.bots.length;
  for (let i = 0; i < count; i++) {
    const bot = state.bots[i]!;
    let bv = out.bots[i];
    if (bv === undefined) {
      bv = {
        id: 0,
        kind: 0,
        dockId: 0,
        xSub: 0,
        ySub: 0,
        facing: 0,
        phase: 0,
        carryItem: 0,
        carryCount: 0,
        condition: 0,
        conditionPermille: 0,
        opCount: 0,
      };
      out.bots.push(bv);
    }
    bv.id = bot.id;
    bv.kind = bot.kind;
    bv.dockId = bot.dockId;
    bv.xSub = bot.xSub;
    bv.ySub = bot.ySub;
    bv.facing = bot.facing;
    bv.phase = bot.phase;
    bv.carryItem = bot.carryItem;
    bv.carryCount = bot.carryCount;
    bv.condition = bot.condition;
    bv.conditionPermille = permille(bot.condition, CONDITION_MAX);
    bv.opCount = bot.opCount;
  }
  out.bots.length = count;
}

function projectInventory(state: WorldState, out: WorldView): void {
  const count = state.inventory.length;
  for (let i = 0; i < count; i++) {
    const slot = state.inventory[i]!;
    let iv = out.inventory[i];
    if (iv === undefined) {
      iv = {
        item: 0,
        count: 0,
        sellable: 0,
        boxedMachineKind: 0,
        boxes: [],
        ticksToSpoil: -1,
        spoilingCount: 0,
      };
      out.inventory.push(iv);
    }
    iv.item = slot.item;
    iv.count = slot.count;
    iv.sellable = isSellable(slot.item) ? 1 : 0;
    iv.boxedMachineKind = machineKindForBoxedItem(slot.item) ?? 0;

    const head = slot.stacks[0];
    if (head === undefined) {
      iv.ticksToSpoil = -1;
      iv.spoilingCount = 0;
    } else {
      const left = head.spoilAtTick - state.tick;
      iv.ticksToSpoil = left < 0 ? 0 : left;
      iv.spoilingCount = head.count;
    }

    // The nested list is pooled exactly as the row list above it is: grow into it, overwrite in
    // place, then truncate. `view()` buffers are reused forever, and a box left over from last
    // frame's row is the bug this design invites — the same note `PlayerView.intentAction`
    // carries, one level further in.
    const boxCount = slot.boxes.length;
    for (let j = 0; j < boxCount; j++) {
      const box = slot.boxes[j]!;
      let bv = iv.boxes[j];
      if (bv === undefined) {
        bv = {
          speedLevel: 0,
          efficiencyLevel: 0,
          capacityLevel: 0,
          condition: 0,
          investedCents: 0,
          scrapCents: 0,
        };
        iv.boxes.push(bv);
      }
      bv.speedLevel = box.speedLevel;
      bv.efficiencyLevel = box.efficiencyLevel;
      bv.capacityLevel = box.capacityLevel;
      bv.condition = box.condition;
      bv.investedCents = box.investedCents;
      bv.scrapCents = boxedMachineScrapCents(box.investedCents);
    }
    iv.boxes.length = boxCount;
  }
  out.inventory.length = count;
}

/**
 * One tile's full state, for the can-as-inspector readout.
 *
 * PLAN §2'S MOGUL-ERA CEREMONY: "stroll a row with the old watering can, which now doubles as
 * an inspector tool (watering a tile pops its full readout)." This is what makes the can
 * retire with dignity instead of being deleted — it is the tool the Mogul carries out of
 * affection, and it now tells you things.
 *
 * INFORMATION, NEVER A MECHANICAL BONUS. Plan §1 says hand tools are free, indestructible, and
 * always work; §7 ruling 8 bans "trusty tool" bonuses in the other direction. The can waters
 * exactly as it always did. It simply also answers a question.
 *
 * Allocates a small object rather than writing into the reused buffer, because it is called
 * on a click rather than twenty times a second.
 */
export interface TileInspection {
  /** 0 when the tile is not part of the field at all. */
  exists: number;
  tileX: number;
  tileY: number;
  crop: number;
  stage: number;
  moisture: number;
  moistureMax: number;
  moisturePermille: number;
  /** 1 when the tile reads as dry — the same threshold the Irrigation Hub uses. */
  dry: number;
  growth: number;
  growthTarget: number;
  growthPermille: number;
  ready: number;
  /** `WiltStage`: 0 fresh, 1 drooping, 2 turned. */
  wilt: number;
  readyAge: number;
  fertility: number;
  compost: number;
  zone: number;
}

export function inspectTile(state: WorldState, tileX: number, tileY: number): TileInspection {
  const tile = tileAt(state, tileX, tileY);
  if (tile === null) {
    return {
      exists: 0,
      tileX,
      tileY,
      crop: 0,
      stage: 0,
      moisture: 0,
      moistureMax: MOISTURE_MAX,
      moisturePermille: 0,
      dry: 1,
      growth: 0,
      growthTarget: 0,
      growthPermille: 0,
      ready: 0,
      wilt: WiltStage.Fresh,
      readyAge: 0,
      fertility: 0,
      compost: 0,
      zone: 0,
    };
  }

  const ready = tile.crop !== CropId.None && tile.growth >= tile.growthTarget;
  return {
    exists: 1,
    tileX,
    tileY,
    crop: tile.crop,
    stage: growthStage(tile),
    moisture: tile.moisture,
    moistureMax: MOISTURE_MAX,
    moisturePermille: permille(tile.moisture, MOISTURE_MAX),
    dry: tile.moisture < MOISTURE_DRY_THRESHOLD ? 1 : 0,
    growth: tile.growth,
    growthTarget: tile.growthTarget,
    growthPermille: permille(tile.growth, tile.growthTarget > 0 ? tile.growthTarget : 1),
    ready: ready ? 1 : 0,
    wilt: ready ? wiltStageForAge(tile.readyAge) : WiltStage.Fresh,
    readyAge: tile.readyAge,
    fertility: tile.fertility,
    compost: tile.compost,
    zone: tile.zone,
  };
}

function projectStats(state: WorldState, out: WorldView): void {
  const stats = state.stats;
  const s = out.stats;
  s.centiActiveHours = centiActiveHoursElapsed(stats);
  s.lifetimeNetEarningsCents = lifetimeNetEarningsCents(stats);
  s.lifetimeEarnedCents = stats.lifetimeEarnedCents;
  s.lifetimeSpentCents = stats.lifetimeSpentCents;
  s.netWorthCents = stats.netWorthCents;
  s.peakNetWorthCents = stats.peakNetWorthCents;
  s.bestTrailingFiveHourGainCents = bestTrailingGainCents(stats, TRAILING_WINDOW_MINUTES);
  s.waterDrawnMl = stats.waterDrawnMl;
  s.centsPerKilolitre = centsPerKilolitre(stats);
  s.itemsSold = stats.itemsSold;
  s.itemsProducedByMachine = stats.itemsProducedByMachine;
  s.itemsHarvestedByHand = stats.itemsHarvestedByHand;
  s.totalManualTouches = totalManualTouches(stats.touches);
  s.longestHandsFreeTicks = stats.longestHandsFreeTicks;
  s.longestUntouchedMachineTicks = stats.longestUntouchedMachineTicks;

  // The per-item ledger, with "today" subtracted here so the Dawn Report's card reads two
  // integers instead of doing arithmetic. Reused rows, truncated with `.length =`, like every
  // other collection in this file.
  const sales = stats.salesByItem;
  for (let i = 0; i < sales.length; i++) {
    const row = sales[i]!;
    let v = s.salesByItem[i];
    if (v === undefined) {
      v = { item: 0, count: 0, grossCents: 0, dayCount: 0, dayGrossCents: 0 };
      s.salesByItem[i] = v;
    }
    v.item = row.item;
    v.count = row.units;
    v.grossCents = row.cents;
    v.dayCount = row.units - row.unitsAtDawn;
    v.dayGrossCents = row.cents - row.centsAtDawn;
  }
  s.salesByItem.length = sales.length;

  // The hour strip: every closed bucket, then the hour in progress as the last entry — which
  // the Shift Report's adopt branch recognises by its short `ticks`. Waste is telescoped from
  // the same two monotone accumulators the buckets carry; spoilage is not measured per hour
  // yet, and -1 says so rather than pretending zero.
  for (let i = 0; i < stats.hours.length; i++) {
    const bucket = stats.hours[i]!;
    writeHourBucket(
      s.hours,
      i,
      bucket.hour,
      bucket.ticks,
      bucket.grossCents,
      bucket.spendCents,
      bucket.waterMl,
      bucket.itemsSold,
      bucket.inputsWasted,
      bucket.itemsProduced,
    );
  }
  const mark = stats.hourMark;
  writeHourBucket(
    s.hours,
    stats.hours.length,
    mark.hour,
    state.tick - mark.tick,
    stats.lifetimeEarnedCents - mark.earnedCents,
    stats.lifetimeSpentCents - mark.spentCents,
    stats.waterDrawnMl - mark.waterMl,
    stats.itemsSold - mark.itemsSold,
    stats.inputsWastedByMachine - mark.inputsWasted,
    stats.itemsProducedByMachine - mark.itemsProduced,
  );
  s.hours.length = stats.hours.length + 1;
}

function writeHourBucket(
  buffer: HourBucketView[],
  index: number,
  hour: number,
  ticks: number,
  grossCents: number,
  spendCents: number,
  waterMl: number,
  itemsSold: number,
  inputsWasted: number,
  itemsProduced: number,
): void {
  let v = buffer[index];
  if (v === undefined) {
    v = {
      hour: 0,
      grossCents: 0,
      spendCents: 0,
      waterMl: 0,
      itemsSold: 0,
      ticks: 0,
      wastePermille: -1,
      spoilagePermille: -1,
    };
    buffer[index] = v;
  }
  v.hour = hour;
  v.ticks = ticks;
  v.grossCents = grossCents;
  v.spendCents = spendCents;
  v.waterMl = waterMl;
  v.itemsSold = itemsSold;
  const throughput = inputsWasted + itemsProduced;
  v.wastePermille = throughput > 0 ? permille(inputsWasted, throughput) : -1;
  v.spoilagePermille = -1;
}

/**
 * Carts, depots, and standing routes.
 *
 * Written into reused arrays like every other collection here, and truncated with `.length =`
 * rather than reallocated — a lot that boxes its only cart must not leave last frame's cart on
 * the panel, which is the exact bug a reused buffer invites and the reason every projector in
 * this file ends with a truncation.
 */
function projectCommerce(state: WorldState, out: WorldView): void {
  const commerce = out.commerce;
  let cartCount = 0;
  let depotCount = 0;

  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    if (isCart(machine)) {
      const cv = commerce.carts[cartCount] ?? blankCart();
      commerce.carts[cartCount] = cv;
      cartCount += 1;
      cv.id = machine.id;
      cv.tileX = machine.tileX;
      cv.tileY = machine.tileY;
      cv.loaded = machine.cargoCount;
      cv.capacity = CART_CAPACITY;
      cv.item = machine.cargoItem;
      cv.away = isCartAway(machine) ? 1 : 0;
      cv.ticksRemaining = machine.runTicksRemaining;
      cv.runTicks = cartRunTicks(machine);
      continue;
    }
    if (!isDepot(machine)) continue;

    const dv = commerce.depots[depotCount] ?? blankDepot();
    commerce.depots[depotCount] = dv;
    depotCount += 1;
    dv.id = machine.id;
    dv.tileX = machine.tileX;
    dv.tileY = machine.tileY;
    dv.stocked = depotStockedCount(state, machine.id);
    dv.capacity = DEPOT_STOCK_CAPACITY;
    dv.runTicks = depotRunTicks(machine);
    // Rewritten in place. `state.contracts` is sorted ascending by id and this walks it in
    // order, so the result is sorted without a sort — which is what the contract promises.
    let routes = 0;
    for (let j = 0; j < state.contracts.length; j++) {
      const contract = state.contracts[j]!;
      if (contract.depotId !== machine.id) continue;
      dv.contractIds[routes] = contract.id;
      routes += 1;
    }
    dv.contractIds.length = routes;
  }
  commerce.carts.length = cartCount;
  commerce.depots.length = depotCount;

  for (let i = 0; i < state.contracts.length; i++) {
    const contract = state.contracts[i]!;
    const cv = commerce.contracts[i] ?? blankContract();
    commerce.contracts[i] = cv;
    cv.id = contract.id;
    cv.depotId = contract.depotId;
    cv.item = contract.item;
    cv.quantityPerRun = contract.quantityPerRun;
    cv.destination = contract.destination;
    cv.stocked = contract.stocked;
    cv.runsCompleted = contract.runsCompleted;
    cv.grossCents = contract.grossCents;
    cv.phase = contract.phase;
    cv.ticksRemaining = contract.ticksRemaining;
  }
  commerce.contracts.length = state.contracts.length;

  commerce.automatedGrossCents = state.stats.automatedGrossCents;
  commerce.firstDepartureSeen = hasCeremony(state, CeremonyId.FirstTruck) ? 1 : 0;
}

function hasCeremony(state: WorldState, id: string): boolean {
  for (let i = 0; i < state.ceremonies.length; i++) {
    if (state.ceremonies[i] === id) return true;
  }
  return false;
}

function blankCart(): CartView {
  return {
    id: 0,
    tileX: 0,
    tileY: 0,
    loaded: 0,
    capacity: 0,
    item: 0,
    away: 0,
    ticksRemaining: 0,
    runTicks: 0,
  };
}

function blankDepot(): DepotView {
  return { id: 0, tileX: 0, tileY: 0, stocked: 0, capacity: 0, contractIds: [], runTicks: 0 };
}

function blankContract(): ContractView {
  return {
    id: 0,
    depotId: 0,
    item: 0,
    quantityPerRun: 0,
    destination: '',
    stocked: 0,
    runsCompleted: 0,
    grossCents: 0,
    phase: 0,
    ticksRemaining: 0,
  };
}
