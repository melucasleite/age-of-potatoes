// The HUD snapshot shape. PLAIN SERIALIZABLE DATA ONLY.
//
// This is the second read boundary in the game, and it obeys the same rule as the first
// (§12, `view(state)`): numbers, strings, and arrays — no `Map`, no class instances, and
// above all NO REFERENCES INTO LIVE SIM STATE. A slice holding a live entity is the exact
// mistake the rule exists to prevent: it costs nothing today and turns the eventual Worker
// move from a transport change into a rewrite.
//
// Every slice carries a `version`. Nothing reads the number; its existence is the point.
// `useSyncExternalStore` compares snapshots with `Object.is`, so the store must hand back
// the SAME OBJECT REFERENCE until a slice actually changed — see `store.ts`. The version
// is how a slice records "I was rebuilt", and it makes a stale-reference bug visible in
// the React DevTools rather than invisible.
//
// Money is in CENTS everywhere below. `packages/sim` never divides by 100; formatting to
// dollars is `apps/web`'s job and lives in `format.ts`.

/** Cash on hand, net worth, and the rate the Ticker counts down against. */
export interface EconomySlice {
  readonly version: number;
  readonly moneyCents: number;
  readonly netWorthCents: number;
  /**
   * Net-worth gain per active minute, in cents. Read, never invented — see `rate.ts` for
   * where it comes from and why that is a fallback rather than the destination.
   */
  readonly rateCentsPerMin: number;
  /** 1 once the rate window is wide enough to mean something. 0 while warming up. */
  readonly rateSettled: number;
}

/**
 * The countdown. This is the single most important retention device in the design (§2):
 * it converts a stable economy — which is otherwise just a number sitting there — into a
 * thing that will finish soon if you keep going.
 */
export interface UnlockSlice {
  readonly version: number;
  /** Machine slug, or null once nothing is left to want. */
  readonly id: string | null;
  readonly label: string;
  /** One line of why you want it. Not a quest; a description. */
  readonly blurb: string;
  readonly priceCents: number;
  /** How many of this thing already stand on the lot. */
  readonly owned: number;
  readonly affordable: number;
  /** Seconds until affordable at the current rate. -1 when that is unknowable. */
  readonly etaSeconds: number;
}

export interface PouchItem {
  readonly id: number;
  readonly label: string;
  readonly count: number;
  /** List value of the stack, in cents. What the pouch is worth if you walk it to the bin. */
  readonly valueCents: number;
}

export interface PouchSlice {
  readonly version: number;
  readonly items: readonly PouchItem[];
}

export interface ToolSlot {
  readonly tool: number;
  /** The number key that selects it. */
  readonly digit: number;
  readonly label: string;
  readonly hint: string;
  readonly costCents: number;
  readonly affordable: number;
  readonly active: number;
}

export interface ToolSlice {
  readonly version: number;
  readonly tool: number;
  readonly slots: readonly ToolSlot[];
}

/**
 * Clipboard tone. Deliberately not "quest state" — the Clipboard observes, it does not
 * assign. `nudge` is the game noticing something you could act on, `warn` is something
 * that has already stopped working, `good` is a thing going right that deserves saying.
 */
export type NoteTone = 'nudge' | 'warn' | 'good';

export interface ClipboardNote {
  readonly id: string;
  readonly text: string;
  readonly tone: NoteTone;
}

export interface ClipboardSlice {
  readonly version: number;
  readonly notes: readonly ClipboardNote[];
}

/**
 * Where a node stands, from the player's side of the glass.
 *
 *   `owned`   — researched. It is a thing you can do now.
 *   `ready`   — every gate is met and the money is on hand. THE FRONTIER; the panel is laid
 *               out so this state is the one your eye lands on.
 *   `short`   — legal, but you cannot pay for it yet. Shows a price and an ETA.
 *   `pending` — a Charter whose money is fine and whose milestone is not. Shows the counter.
 *   `blocked` — a prerequisite is missing, and the panel names it rather than gesturing.
 */
export type TechStatus = 'owned' | 'ready' | 'short' | 'pending' | 'blocked';

export interface TechCard {
  readonly id: string;
  readonly branch: number;
  /** Which era band it draws in. Derived from the prerequisite closure — see `derive-tech.ts`. */
  readonly era: number;
  readonly title: string;
  /** The promise, imperative, under six words. Never a percentage (plan §1, §3). */
  readonly verb: string;
  readonly detail: string;
  readonly priceCents: number;
  readonly status: TechStatus;
  /** Titles of unmet prerequisites. The answer to the build menu's unhelpful "needs Belts". */
  readonly missing: readonly string[];
  readonly milestoneKind: number;
  readonly milestoneNeed: number;
  /**
   * Where the player is on that counter, published whether or not the node is close.
   * Plan §7 ruling 3: a Charter's demonstrated half is visible from the first time the panel
   * is opened, because a milestone you discover by accidentally completing it is a hidden gate
   * wearing a badge.
   */
  readonly milestoneHave: number;
  readonly isCharter: number;
}

export interface TechSlice {
  readonly version: number;
  readonly cards: readonly TechCard[];
  readonly ownedCount: number;
  /** 1, 2, 3 — one plus the number of Charters signed. */
  readonly era: number;
  /** What the panel selects on open. Never the root; see `deriveTech`. */
  readonly frontierId: string | null;
}

/** One dial on the machine the player is standing at. */
export interface BenchDial {
  readonly dial: number;
  readonly name: string;
  /** The trade-off, stated as a trade. This is what makes the panel a decision. */
  readonly trade: string;
  readonly effect: string;
  readonly level: number;
  readonly maxLevel: number;
  /** Cents for the next level, or -1 when maxed. */
  readonly costCents: number;
  readonly affordable: number;
  /** What the machine does now, in the dial's own units. */
  readonly now: string;
  /** What it would do one level up. Empty at max. */
  readonly next: string;
  /** 1 when this level costs more than another machine of the same kind (plan §3's argument). */
  readonly outpricesAnother: number;
}

/**
 * The at-the-machine panel. Plan §5's posture: you walk over and interact, rather than opening
 * a menu and picking a machine out of a list.
 */
export interface BenchSlice {
  readonly version: number;
  /** 0 when the player is not standing at an upgradeable machine. */
  readonly machineId: number;
  readonly kind: number;
  readonly label: string;
  readonly conditionPermille: number;
  /** List price of another one of these — the thing the third dial level competes with. */
  readonly listPriceCents: number;
  /** 1 once the Upgrade Bench node is researched. The dials are inert until then. */
  readonly researched: number;
  readonly dials: readonly BenchDial[];
}

export interface HudSnapshot {
  readonly economy: EconomySlice;
  readonly unlock: UnlockSlice;
  readonly pouch: PouchSlice;
  readonly tools: ToolSlice;
  readonly clipboard: ClipboardSlice;
  readonly tech: TechSlice;
  readonly bench: BenchSlice;
}

export type SliceName = keyof HudSnapshot;

/**
 * The non-reactive channel.
 *
 * Values that change faster than a person can read them never enter the snapshot — §13 is
 * explicit that hover readouts and cursor counts "draw in Pixi or write to a DOM node by
 * ref, bypassing React entirely". This object is mutated in place by the host and read by
 * rAF-driven writers in the HUD. NOTHING RENDERS FROM IT. If a component ever calls
 * `useState` off one of these fields, the rule has been broken.
 */
export interface HudLive {
  tick: number;
  /** Cash on hand at the last publish. The ticking counter chases this; it does not lerp. */
  moneyCents: number;
  /** "day 3  14:20" — cosmetic, computed by the host so the clock and the sky agree. */
  clock: string;
  /** The hover/reach readout. Changes on pointer move, so it never touches React. */
  status: string;
}

export const ZERO_ECONOMY: EconomySlice = Object.freeze({
  version: 0,
  moneyCents: 0,
  netWorthCents: 0,
  rateCentsPerMin: 0,
  rateSettled: 0,
});

export const ZERO_UNLOCK: UnlockSlice = Object.freeze({
  version: 0,
  id: null,
  label: '',
  blurb: '',
  priceCents: 0,
  owned: 0,
  affordable: 0,
  etaSeconds: -1,
});

export const ZERO_POUCH: PouchSlice = Object.freeze({ version: 0, items: Object.freeze([]) });

export const ZERO_TOOLS: ToolSlice = Object.freeze({
  version: 0,
  tool: 0,
  slots: Object.freeze([]),
});

export const ZERO_CLIPBOARD: ClipboardSlice = Object.freeze({
  version: 0,
  notes: Object.freeze([]),
});

export const ZERO_TECH: TechSlice = Object.freeze({
  version: 0,
  cards: Object.freeze([]),
  ownedCount: 0,
  era: 1,
  frontierId: null,
});

export const ZERO_BENCH: BenchSlice = Object.freeze({
  version: 0,
  machineId: 0,
  kind: 0,
  label: '',
  conditionPermille: 0,
  listPriceCents: 0,
  researched: 0,
  dials: Object.freeze([]),
});

/**
 * The server snapshot, frozen and shared.
 *
 * The canvas mounts `ssr: false`, but the HUD does not have to — and a panel rendered on
 * the server must return the SAME reference every call or React throws a
 * "getServerSnapshot should be cached" error rather than a hydration warning.
 */
export const ZERO_SNAPSHOT: HudSnapshot = Object.freeze({
  economy: ZERO_ECONOMY,
  unlock: ZERO_UNLOCK,
  pouch: ZERO_POUCH,
  tools: ZERO_TOOLS,
  clipboard: ZERO_CLIPBOARD,
  tech: ZERO_TECH,
  bench: ZERO_BENCH,
});
