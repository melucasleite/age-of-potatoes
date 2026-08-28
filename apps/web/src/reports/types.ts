// The reports snapshot shape. PLAIN SERIALIZABLE DATA ONLY.
//
// This is the third read boundary in the game and it obeys the same rule as the first two
// (§12's `view(state)`, §13's `hud/types.ts`): numbers, strings, and frozen arrays — no
// `Map`, no class instances, and no references into live sim state. The reason has not
// changed: a live reference is free today and turns the eventual Worker move from a
// transport change into a rewrite.
//
// Every slice carries a `version`. Nothing reads it; its existence is the point.
// `useSyncExternalStore` compares with `Object.is`, so the store hands back the SAME object
// until a slice actually moved — see `store.ts`.
//
// MONEY IS CENTS. Every field below whose name ends in `Cents` is an integer number of
// cents and is formatted at the last moment, in a component, through `format.ts`.

// The SHIFT LEDGER'S SHAPES stood here — `ShiftBucket`, `HourRatio`, `ShiftSlice` and their
// zeros — until item 150 removed the Shift Report with its ledger and persistence. The Dawn
// Report below is what remains of plan §4's receipts.

/**
 * One flagged inefficiency, phrased in cash.
 *
 * Plan §5: "alerts only when money bleeds >60s, phrased in cash ('Fryer B idle 6 min — $14
 * wasted')". ONE flag, never a list — the Clipboard's observations are "never quests" (§2)
 * and a card that hands the player five jobs at dawn is a chore list with a sunrise on it.
 */
export interface InefficiencyFlag {
  readonly id: string;
  readonly text: string;
  readonly costCents: number;
}

/** The day's top product, once the sim can tell us. See `sim-contract.ts`. */
export interface BestSeller {
  readonly label: string;
  readonly count: number;
  readonly grossCents: number;
}

/**
 * The Dawn Report card.
 *
 * NON-BLOCKING IS THE WHOLE DESIGN (§2). It does not pause the sim, does not steal focus,
 * does not sit above the toolbelt, and cannot swallow a click meant for the lot. Its
 * lifetime is counted in TICKS, not in `setTimeout` milliseconds, so the app keeps its one
 * clock — see `store.ts`.
 */
export interface DawnCard {
  /** The dawn's ordinal. Also the React key, so a new dawn replaces rather than merges. */
  readonly id: number;
  /** The day number the on-screen clock is showing, so the two never disagree. */
  readonly day: number;
  /** Gross earned since the previous dawn. Only meaningful when `split` is 1. */
  readonly earnedCents: number;
  /** Earned less spent since the previous dawn. Always exact. */
  readonly netCents: number;
  /** 1 when `earnedCents` is a real gross figure rather than a placeholder. */
  readonly split: number;
  /** null until the sim projects per-item sales — the row prints its own absence. */
  readonly bestSeller: BestSeller | null;
  /** null when nothing bled for longer than a minute, which is a good day. */
  readonly flag: InefficiencyFlag | null;
}

export interface DawnSlice {
  readonly version: number;
  /** The card on screen, or null. */
  readonly card: DawnCard | null;
}

/**
 * A personal-best row. Six of these, from plan §6, all net-worth-accounted.
 *
 * `value` is what this world reads right now; `best` is the highest this player has ever
 * reached on any world, restored from IndexedDB. There is no server, no cohort, and no
 * replay validation — Lucas's ruling is a fun, lightly validated board, so this is You vs
 * You and says so.
 */
export interface BoardRow {
  readonly id: string;
  readonly label: string;
  /** What the board actually measures, in one line. */
  readonly blurb: string;
  readonly value: number;
  readonly best: number;
  /** How a component should format `value` and `best`. */
  readonly unit: 'cents' | 'perHour' | 'ticks' | 'centiHours';
  /** 1 when this world currently qualifies for the board at all. */
  readonly eligible: number;
  /** Why it does not qualify, when it does not. Empty when it does. */
  readonly gate: string;
  /** 1 when `value` is a new personal best this session. */
  readonly fresh: number;
}

export interface BoardsSlice {
  readonly version: number;
  readonly rows: readonly BoardRow[];
  /** Active hours elapsed, in hundredths. The clock every board is timed against. */
  readonly centiActiveHours: number;
  /** 1 once bests have been read back from storage. Rows show "—" as best until then. */
  readonly loaded: number;
}

// The DIAGNOSTICS SHAPES stood here — `BleedRow`, `DiagnosticsSlice`, their zero — until
// item 150 removed the panel alongside item 145's cut of the Diagnostics tech and the
// sim-side `bleedCentsLast60s` that fed it.

// --- commerce ----------------------------------------------------------------------

/**
 * A delivery cart: the ASSISTED rung of selling. Loaded by hand, dispatched by hand, back
 * with the money after a fixed number of ticks. It never leaves without a command.
 */
export interface CartRow {
  readonly id: number;
  readonly label: string;
  /** Items aboard, and what they are worth at list. Counted in net worth while in transit. */
  readonly loaded: number;
  readonly capacity: number;
  readonly valueCents: number;
  /** 0 idle at the depot, 1 out on a run. */
  readonly away: number;
  /** Ticks until it is back. 0 when it is standing right there. */
  readonly ticksRemaining: number;
  readonly runTicks: number;
}

/**
 * A standing contract: LOGISTICS, never price.
 *
 * Plan §8 cuts fluctuating market prices forever and locked decision 3 fixes prices as
 * "stable and posted". A contract therefore says WHAT to ship and HOW MUCH per run. It
 * never says what it is worth, there is no negotiation, and there is no counterparty who
 * is another player — §8 cuts player-to-player trading forever because it re-imports market
 * dynamics through the back door.
 */
export interface ContractRow {
  readonly id: number;
  /** `ItemId` of the product this route ships. */
  readonly item: number;
  readonly itemLabel: string;
  /** Flavour only. "Ridgeline Grocers" buys at exactly the same price as everyone else. */
  readonly destination: string;
  readonly quantityPerRun: number;
  /** What one run pays, at posted list. Displayed, never chosen. */
  readonly runValueCents: number;
  /** Stock the depot has toward the next run. */
  readonly stocked: number;
  readonly runsCompleted: number;
  readonly grossCents: number;
  /** 0 waiting on stock, 1 loading, 2 truck out on the road. */
  readonly phase: number;
  readonly ticksRemaining: number;
}

export interface DepotRow {
  readonly id: number;
  readonly label: string;
  /** Contract ids this depot is fulfilling. */
  readonly contractIds: readonly number[];
  readonly stocked: number;
  readonly capacity: number;
}

/**
 * The commerce slice, and the one flag that says whether any of it is real yet.
 *
 * `installed` is 0 until the sim projects `view.commerce`. The panels render their full
 * shape either way — plan §8's "stubs listed explicitly" — so the layout is reviewable now
 * and lights up the moment the sim half lands, with no UI change at all.
 */
export interface CommerceSlice {
  readonly version: number;
  readonly installed: number;
  readonly carts: readonly CartRow[];
  readonly depots: readonly DepotRow[];
  readonly contracts: readonly ContractRow[];
  /** Products the player can write a contract for, from what the lot actually makes. */
  readonly sellable: readonly {
    readonly item: number;
    readonly label: string;
    readonly priceCents: number;
  }[];
  /** Lifetime gross routed through carts and depots, in cents. */
  readonly automatedGrossCents: number;
  /** 1 when a command sink is attached and the panel's buttons can do anything. */
  readonly wired: number;
}

export interface ReportsSnapshot {
  readonly dawn: DawnSlice;
  readonly boards: BoardsSlice;
  readonly commerce: CommerceSlice;
}

export type ReportsSliceName = keyof ReportsSnapshot;

export const ZERO_DAWN: DawnSlice = Object.freeze({ version: 0, card: null });

export const ZERO_BOARDS: BoardsSlice = Object.freeze({
  version: 0,
  rows: Object.freeze([]),
  centiActiveHours: 0,
  loaded: 0,
});

export const ZERO_COMMERCE: CommerceSlice = Object.freeze({
  version: 0,
  installed: 0,
  carts: Object.freeze([]),
  depots: Object.freeze([]),
  contracts: Object.freeze([]),
  sellable: Object.freeze([]),
  automatedGrossCents: 0,
  wired: 0,
});

/**
 * The server snapshot, frozen and shared.
 *
 * The reports render outside the canvas's `ssr: false` boundary, so this path is real:
 * React requires `getServerSnapshot` to be cached, and a fresh object here is an
 * infinite-loop error rather than a hydration warning.
 */
export const ZERO_REPORTS: ReportsSnapshot = Object.freeze({
  dawn: ZERO_DAWN,
  boards: ZERO_BOARDS,
  commerce: ZERO_COMMERCE,
});
