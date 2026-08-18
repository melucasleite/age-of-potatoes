// THE SEAM WITH THE SIM THAT DOES NOT EXIST YET.
//
// Work item 032's simulation half — the delivery cart, the truck depot, and standing
// contracts — has not landed. This file is the UI half's half of that contract, written
// down in TypeScript so that landing the sim half is a wiring change and not a redesign.
//
// The pattern is `hud/rate.ts`'s, deliberately, because it is already the house answer to
// "another agent is expanding `packages/sim` right now":
//
//   1. Every read below is OPTIONAL and structural. `WorldView` is read through a widened
//      type, never cast to one that claims fields the sim does not have.
//   2. The moment `view.commerce` appears, `readCommerce()` starts returning it and the
//      panels light up with NO CHANGE ANYWHERE ELSE.
//   3. Until then the panels render their full shape with an explicit "not installed"
//      state — plan §8's standing rule is "fake the far side of every interface, stubs
//      listed explicitly", and a panel that grows its rows three releases from now is worse
//      than one whose shape was fixed the day it was designed.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  FOR THE SIM OWNER. Everything this UI needs, and nothing it does not:
//
//  `WorldView` — one additive field, plus a handful of optional stats fields:
//      commerce?: CommerceView                 (shape below)
//      stats.lifetimeEarnedCents?: number      (Shift Report's GROSS line — see below)
//      stats.lifetimeSpentCents?:  number      (Shift Report's KIT SPEND line)
//      stats.salesByItem?: ItemSaleView[]      (Dawn Report's best seller)
//      stats.hours?: HourBucketView[]          (Shift Report, hash-exact — see `shift.ts`)
//
//  THE GROSS/SPEND SPLIT IS NOT DERIVABLE HERE, and it is worth saying why rather than
//  leaving the next reader to rediscover it. `StatsView` projects `lifetimeNetEarningsCents`
//  — which is `earned − spent` — and `moneyCents`, which is `starting + earned − spent`.
//  Those are the same quantity with a constant between them, so no arithmetic on the
//  projection can separate the two halves. Plan §4's ledger needs them separate, because
//  the whole point of the receipt is showing a careful operator where a careless one's
//  money went. Both accumulators already exist in `WorldStats`; they just are not projected.
//
//  `Command` — four additive variants, named exactly as work item 032 names them:
//      LoadCart      { cartId, item, count }    — counts a `handCarry` touch
//      DispatchCart  { cartId }                 — counts a `handCarry` touch
//      CreateContract{ depotId, item, quantityPerRun, destination }
//      CancelContract{ contractId }             — free, always
//
//  Nothing here needs a price field, a bonus, or a negotiation: prices are stable and
//  posted (locked decision 3), so a contract chooses logistics and never value.
// ────────────────────────────────────────────────────────────────────────────────────

import type { WorldView } from '@snack/sim';

/** One cart, as the sim would project it. Integers and ticks; no wall clock anywhere. */
export interface CartView {
  readonly id: number;
  readonly tileX: number;
  readonly tileY: number;
  /** Items aboard right now. */
  readonly loaded: number;
  readonly capacity: number;
  /** `ItemId` aboard, or 0 when empty. A cart carries one product per run. */
  readonly item: number;
  /** 1 while out on a run. A cart out on a run still counts toward net worth (§6). */
  readonly away: number;
  /** Ticks until it is back. Integer, counted down inside `step()`. */
  readonly ticksRemaining: number;
  /** Ticks a full round trip takes, so the UI can draw a progress track. */
  readonly runTicks: number;
}

export interface DepotView {
  readonly id: number;
  readonly tileX: number;
  readonly tileY: number;
  /** Goods accumulated from the belt, awaiting a run. */
  readonly stocked: number;
  readonly capacity: number;
  /** Contract ids this depot fulfils, sorted ascending. */
  readonly contractIds: readonly number[];
}

/** A standing contract. Logistics only — what to ship and how much, never what it is worth. */
export interface ContractView {
  readonly id: number;
  readonly depotId: number;
  readonly item: number;
  readonly quantityPerRun: number;
  /** Flavour label. Every destination pays exactly list; this is a name on a truck door. */
  readonly destination: string;
  /** Stock counted toward the next run. */
  readonly stocked: number;
  readonly runsCompleted: number;
  readonly grossCents: number;
  /** 0 waiting on stock, 1 loading, 2 out on the road. */
  readonly phase: number;
  readonly ticksRemaining: number;
}

export interface CommerceView {
  readonly carts: readonly CartView[];
  readonly depots: readonly DepotView[];
  readonly contracts: readonly ContractView[];
  /** Lifetime gross that went out by cart or truck rather than by hand. */
  readonly automatedGrossCents: number;
  /**
   * 1 once the first truck has left, so the two-honk ceremony plays exactly once and a
   * reload does not replay it. The seen-flag lives in `WorldState`; the honk lives in the
   * renderer with renderer-only randomness (§12).
   */
  readonly firstDepartureSeen: number;
}

/** Per-item sales, for the Dawn Report's best seller. */
export interface ItemSaleView {
  readonly item: number;
  readonly count: number;
  readonly grossCents: number;
  /** Sales in the current in-game day, so the card does not have to difference anything. */
  readonly dayCount: number;
  readonly dayGrossCents: number;
}

/**
 * A closed active hour, as the sim would project it.
 *
 * When this arrives, `shift.ts` stops deriving buckets and reads these instead — the same
 * two-branch shape `hud/rate.ts` uses. It is the better home for them: work item 033 wants
 * the buckets inside `WorldStats` and inside `hashState()`, which is the only way they
 * survive a reload without a second store and the only way a later refactor cannot silently
 * change what a receipt says.
 */
export interface HourBucketView {
  readonly hour: number;
  readonly grossCents: number;
  readonly spendCents: number;
  readonly waterMl: number;
  readonly itemsSold: number;
  readonly ticks: number;
  /** Permille of production wasted. Entropy release; expect `-1` for "not measured". */
  readonly wastePermille: number;
}

/**
 * `WorldView`, widened by everything the sim MIGHT have grown since this file was written.
 *
 * Every field is optional. Nothing here asserts the sim has anything, which is what keeps
 * this file honest: if the shapes drift, the reads below return `undefined` and the panels
 * say "not installed" rather than throwing inside a render.
 */
export type ExtendedWorldView = WorldView & {
  readonly commerce?: CommerceView;
  readonly stats: WorldView['stats'] & {
    readonly lifetimeEarnedCents?: number;
    readonly lifetimeSpentCents?: number;
    readonly salesByItem?: readonly ItemSaleView[];
    readonly hours?: readonly HourBucketView[];
    readonly wastePermille?: number;
  };
};

/** Gross and spend as two numbers, or null while the projection only carries their difference. */
export function readGrossAndSpend(view: WorldView): { earned: number; spent: number } | null {
  const stats = (view as ExtendedWorldView).stats;
  const earned = stats.lifetimeEarnedCents;
  const spent = stats.lifetimeSpentCents;
  if (typeof earned !== 'number' || typeof spent !== 'number') return null;
  return { earned, spent };
}

/** The commerce projection, or null while the sim half is still on somebody's branch. */
export function readCommerce(view: WorldView): CommerceView | null {
  const commerce = (view as ExtendedWorldView).commerce;
  if (commerce === undefined) return null;
  // A defensive shape check rather than a cast. The sim owner is landing this on their own
  // schedule and a half-built field reaching a `.map()` inside a React render is a blank
  // screen, which is a far worse failure than a panel that keeps saying "not installed".
  if (!Array.isArray(commerce.carts) || !Array.isArray(commerce.contracts)) return null;
  return commerce;
}

/** Per-item sales, or null. The Dawn Report prints the absence rather than guessing. */
export function readSalesByItem(view: WorldView): readonly ItemSaleView[] | null {
  const sales = (view as ExtendedWorldView).stats.salesByItem;
  return Array.isArray(sales) ? sales : null;
}

/** Sim-owned hour buckets, or null while the renderer-side ledger is doing the work. */
export function readHourBuckets(view: WorldView): readonly HourBucketView[] | null {
  const hours = (view as ExtendedWorldView).stats.hours;
  return Array.isArray(hours) ? hours : null;
}

/**
 * Waste, in permille, or −1 for "the system that measures this does not exist yet".
 *
 * There was a `readSpoilagePermille` beside this until [[124]]; spoilage is not a pending
 * system any more, it is a deleted one, so the read went with the row it fed.
 */
export function readWastePermille(view: WorldView): number {
  const value = (view as ExtendedWorldView).stats.wastePermille;
  return typeof value === 'number' ? value : -1;
}

// --- the commands this UI will enqueue ----------------------------------------------
//
// Declared here, structurally, so the panel is written against real types today. When the
// sim's `Command` union grows these four variants, delete these declarations and import the
// real ones — the panel's call sites do not change.

export interface LoadCartCommand {
  readonly type: 'LoadCart';
  readonly cartId: number;
  readonly item: number;
  readonly count: number;
}

export interface DispatchCartCommand {
  readonly type: 'DispatchCart';
  readonly cartId: number;
}

export interface CreateContractCommand {
  readonly type: 'CreateContract';
  readonly depotId: number;
  readonly item: number;
  readonly quantityPerRun: number;
  readonly destination: string;
}

export interface CancelContractCommand {
  readonly type: 'CancelContract';
  readonly contractId: number;
}

/** What the commerce panel can ask the world to do. Nothing else, ever. */
export type CommerceCommand =
  LoadCartCommand | DispatchCartCommand | CreateContractCommand | CancelContractCommand;

/**
 * The way out.
 *
 * A sink, not a queue reference: the panel enqueues a `Command` and never touches
 * `WorldState` (§12 — every mutation is a command applied at a tick). Null until the host
 * attaches one, and the panel's buttons disable themselves when it is, because a button
 * that looks live and does nothing is worse than one that admits it is waiting.
 */
export type CommandSink = (command: CommerceCommand) => void;

/**
 * Destination names, for flavour only.
 *
 * They are in the UI rather than in `data.ts` on purpose: a destination has no mechanical
 * effect whatsoever — same price, same everything — so putting it in the sim would put a
 * string into the world hash for no reason. If a destination ever gains a distance or a
 * bonus it moves to `data.ts` that day.
 */
export const DESTINATIONS: readonly string[] = [
  'Ridgeline Grocers',
  'Halvorsen & Sons',
  'The Filling Station',
  'Comfort Foods Depot',
  'Route 9 Wholesale',
];
