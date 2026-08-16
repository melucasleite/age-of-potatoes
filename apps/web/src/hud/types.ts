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

/** Cash on hand, net worth, and the money-rate line. */
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
  /**
   * `StatsView.cheatsUsed`, copied through for the debug console ([[075]]). A refused cheat
   * is a no-op the projection never mentions, so "did the sim take that code?" has exactly
   * one honest answer: watch this counter move. It changes a handful of times per LIFETIME,
   * so carrying it here costs nothing on the publish path.
   */
  readonly cheatsUsed: number;
}

// THE UNLOCK SLICE LIVED HERE — the Ticker's next-purchase countdown ([[013]] lineage) — and
// is gone by ruling ([[076]]): the card was its only reader.

export interface PouchItem {
  readonly id: number;
  readonly label: string;
  readonly count: number;
  /** List value of the stack, in cents. What the pouch is worth if you walk it to the bin. */
  readonly valueCents: number;
  /**
   * 1 when the bin will actually take it. Seeds are bought and never sold ([[051]]), and a
   * price printed beside something you cannot sell is a lie the UI is telling — so the chip
   * drops the figure rather than quietly showing what it would have been worth.
   */
  readonly sellable: number;
  /**
   * Ticks until part of this stack turns to Compost, or -1 when it never does.
   *
   * The pouch is the only surface that shows freshness WITHOUT the player opening anything
   * ([[035]]), and goods age only in the player's hands — a stack inside a machine, a crate or
   * the Root Cellar has no clock running — so the thing the player is carrying is the object
   * §5 wants the state drawn on. The chip stays silent until the clock is worth reading.
   */
  readonly ticksToSpoil: number;
  readonly spoilingCount: number;
}

export interface PouchSlice {
  readonly version: number;
  readonly items: readonly PouchItem[];
  /**
   * Pours left in the watering can, against its capacity ([[009]] — the 8-pour can restored).
   *
   * ON THE POUCH because the can is a carried thing: the pouch is the one surface that shows
   * what is in the player's hands without anything being opened, and the can's remaining
   * pours are exactly that kind of fact. Both numbers, so the chip can say "3/8" — and
   * `canCharges === 0` IS the refusal reason the HUD shows when a pour does nothing
   * (the sim refuses an empty can as a silent no-op; the view carries state, not events).
   */
  readonly canCharges: number;
  /** 0 before the first publish; the chip does not draw until it is real. */
  readonly canChargesMax: number;
  /**
   * Which way the water is, eight-point quantised ("north-west"), or '' when the player is
   * already within dipping reach — or when the world has no reservoir at all, where the
   * refill works anywhere and there is nothing to point at. Same convention as
   * `ShopSlice.heading`, for the same churn reason.
   */
  readonly shoreHeading: string;
}

/**
 * One hotbar slot ([[061]]). Three shapes share it, told apart by two fields:
 *
 *   a tool          — `tool >= 0, item === -1`. One of the five hand verbs.
 *   an item shortcut — `item > 0`. `tool` is the placement cursor its digit arms, or -1
 *                      when the build has no cursor for it (the slot draws, disabled).
 *   empty           — `tool === -1, item === -1`. A digit waiting for an assignment.
 */
export interface ToolSlot {
  readonly tool: number;
  /** `ItemId` of an item shortcut, or -1 for a tool slot and for an empty one. */
  readonly item: number;
  /** The number key that selects it: 1–9, then 0 for the tenth slot. */
  readonly digit: number;
  readonly label: string;
  readonly hint: string;
  readonly costCents: number;
  readonly affordable: number;
  readonly active: number;
  /**
   * 1 when this placement will open a BOX the player already owns instead of charging them.
   *
   * `PlaceMachine` consumes a boxed machine before it reaches for money ([[054]]), so a slot
   * quoting a price the till is not going to charge would be the HUD contradicting itself in
   * the same second: the bag says "Place · free", the player presses it, and the toolbelt
   * answers "$100". Worse, `affordable` would read 0 for a placement that cannot fail on money,
   * which greys a slot that works.
   */
  readonly fromBox: number;
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
  /**
   * 1 when `DeconstructMachine` would be accepted on this machine right now.
   *
   * A MIRROR OF THE SIM'S REFUSALS, not a second opinion: the reducer refuses a jammed machine
   * and one that is mid-batch, and the bench greys the button on exactly those two. It is a
   * courtesy rather than a gate — the sim decides, and a refused command is a no-op (see
   * `hudStore.dispatch`) — but a button that looks alive and does nothing is the papercut this
   * HUD keeps being filed against.
   */
  readonly boxable: number;
  /** Why not, in the panel's own words. Empty when `boxable` is 1. */
  readonly boxBlocked: string;
}

/**
 * One zone's readout line — plan §5's "47/60 planted · 12 mature · 3 dry", with the two
 * withering counts [[021]] adds to it.
 *
 * The counts come from the sim, which owns what a zone contains. `atRiskCents` does not:
 * cents are the sim's, but which of them are "at risk" is a phrasing decision, and those
 * live on this side of the seam (`derive-lot.ts`).
 */
export interface ZoneRow {
  readonly id: number;
  readonly name: string;
  readonly tiles: number;
  readonly planted: number;
  readonly mature: number;
  /** Past its grace and drooping. Still harvests at full price. */
  readonly wilting: number;
  /** Turned. Harvests as Day-Old at half, and collapses to compost if left. */
  readonly wilted: number;
  readonly dry: number;
  readonly compost: number;
  readonly atRiskCents: number;
  /** The slice of `atRiskCents` on crops within ~a minute of turning Day-Old ([[021]]). */
  readonly imminentCents: number;
}

/**
 * The single cash-phrased alert (plan §5). Null far more often than not, and that is the
 * design — see `derive-lot.ts` on why the sixty-second delay is the feature.
 */
export interface LotAlert {
  readonly id: string;
  readonly text: string;
  readonly costCents: number;
}

/**
 * The state of the lot, as opposed to the state of the wallet.
 *
 * Read by two panels that ask the same question at different moments: the zone card wants to
 * know what is wilting now, and the Welcome Back card wants to know what the factory looks
 * like to someone who has forgotten building it.
 */
export interface LotSlice {
  readonly version: number;
  readonly zones: readonly ZoneRow[];
  readonly wilting: number;
  readonly wilted: number;
  readonly atRiskCents: number;
  /** Cents on crops within ~a minute of turning — the deadline the alert switches tense for. */
  readonly imminentCents: number;
  /** Compost lying on the ground, waiting to be swept up. */
  readonly compost: number;
  readonly alert: LotAlert | null;
  /** Machines the player built. The sell bin is scenery and is not counted. */
  readonly machines: number;
  readonly running: number;
  readonly halted: number;
  readonly jammed: number;
  readonly starved: number;
  readonly blocked: number;
  readonly sprinklers: number;
}

/**
 * One line on the roadside stand's board.
 *
 * WHAT IS FOR SALE AND AT WHAT PRICE IS NOT DECIDED HERE. Every field below except the copy
 * is read out of `ITEM_SPECS` — `purchasable` decides whether the row exists at all and
 * `listPriceCents` is the price — because a second price table in the HUD is a table that
 * will disagree with the till one day, and the day it does the player is the one who finds
 * out. See `derive-shop.ts`.
 */
export interface ShopRow {
  /** `ItemId`. */
  readonly id: number;
  readonly name: string;
  /** One line of what it is for. Empty for an item the HUD has no copy for yet. */
  readonly note: string;
  readonly unitPriceCents: number;
  /** How many are already in the pouch. */
  readonly owned: number;
  /**
   * The tech that makes this seed's crop plantable, when the player has not researched it —
   * a title, not an id. Empty when there is nothing in the way.
   *
   * The stand would sell them anyway; the sim gates PLANTING, not buying. Naming the node is
   * what stops a purchase that cannot be planted and (once seeds are unsellable) cannot be
   * undone — the same courtesy the research panel does with `missing`.
   */
  readonly needsTech: string;
}

/**
 * The roadside stand, from the player's side of the counter.
 *
 * `atStand` is the whole reason this is a slice rather than a constant list: `applyBuyItem`
 * refuses unless the farmer is within hand reach of the bin, so a board that did not know
 * where the player was standing would offer buttons the sim throws away in silence.
 */
export interface ShopSlice {
  readonly version: number;
  readonly rows: readonly ShopRow[];
  /** 1 when the farmer is standing close enough for the till to take the money. */
  readonly atStand: number;
  /** 1 when the lot has a stand at all. */
  readonly standExists: number;
  /** Which way to walk — "north-east" — quantised to eight points. Empty when at the stand. */
  readonly heading: string;
  /**
   * The stand's own tile, so a purchase made from across the lot can be sent as an ERRAND
   * rather than refused.
   *
   * Published as a tile rather than as subtiles because that is what `WalkAndAct` carries, and
   * it is stable while the player moves — a subtile pair would be a second thing changing on
   * every publish for a panel that redraws one sentence. Both are -1 when there is no stand.
   */
  readonly standTileX: number;
  readonly standTileY: number;
}

/**
 * ONE boxed machine on an inventory row — not a summary of the row.
 *
 * Per box because that is the fact: three boxed Fryers are three different machines at three
 * different invoices, and a row that showed "×3" over one set of dials would be lying about two
 * of them. The sim publishes them least-invested-first and both verbs consume from the front, so
 * `index === 0` is the box that will actually go down or actually be scrapped.
 */
export interface InventoryBox {
  /** Position in the row's list. 0 is the box `PlaceMachine` and `SellBoxedMachine` take next. */
  readonly index: number;
  readonly speedLevel: number;
  readonly efficiencyLevel: number;
  readonly capacityLevel: number;
  /** Condition it was boxed at, restored when it goes back down. */
  readonly conditionPermille: number;
  /** Price plus every dial ever bought for it. */
  readonly investedCents: number;
  /**
   * What the sim will pay to scrap THIS box, read off the view.
   *
   * NEVER COMPUTED HERE, and the rule is worth the sentence: the payout ratio lives in the sim,
   * `applySellBoxedMachine` pays exactly this number, and the last time this HUD kept its own
   * copy of one of the sim's prices it was wrong by a third for weeks (see the tombstone at the
   * end of `derive-tech.ts`).
   */
  readonly scrapCents: number;
}

/**
 * One line in the bag: a stack of goods, or a stack of boxed machines.
 *
 * `boxedKind` IS THE TYPE TAG, exactly as the sim's `InventoryView.boxedMachineKind` is. Non-zero
 * means this row is machines in boxes, which means the bin refuses it, the scrap verb is
 * `SellBoxedMachine` rather than `SellItem`, and there is a cursor that puts one back down.
 */
export interface InventoryRow {
  /** `ItemId`. */
  readonly id: number;
  readonly name: string;
  readonly count: number;
  /** 1 when the sell bin will take it. Read from the sim, never decided here ([[051]]). */
  readonly sellable: number;
  /** `MachineKind` in the box, or 0 for an ordinary good. */
  readonly boxedKind: number;
  readonly unitPriceCents: number;
  /** List value of the whole stack. Zero on a boxed row — a box is priced off its invoice. */
  readonly stackValueCents: number;
  /** What every box on this row would fetch, summed from the sim's own per-box figures. */
  readonly scrapCents: number;
  /**
   * The `ToolMode` that puts this box down, or -1 when the UI has no build cursor for that
   * machine kind yet. -1 is a real state and the panel says so rather than arming the wrong tool.
   */
  readonly placeTool: number;
  readonly boxes: readonly InventoryBox[];
  /**
   * Ticks until the soonest-expiring heap in this stack turns to Compost, or **-1 when nothing
   * in it ever will**. Copied from the projection; see `freshness.ts` for why there is no
   * fraction beside it and why -1 is not a big number.
   */
  readonly ticksToSpoil: number;
  /** How many units are in that heap. 0 on a row with no clock on it. */
  readonly spoilingCount: number;
}

/** Everything the player is carrying. Goods, seeds, and boxed machines, in the sim's order. */
export interface InventorySlice {
  readonly version: number;
  readonly rows: readonly InventoryRow[];
  /** Boxed machines in the bag, across every row. */
  readonly boxCount: number;
  /** What all of them together would scrap for. */
  readonly scrapCents: number;
}

/**
 * One Grow Zone, as a thing you could point an Agri-Bot dock at ([[038]]).
 *
 * Deliberately not `ZoneRow`: that one is the field card's readout — what is wilting and what it
 * is worth — and this one is a target. They describe the same rectangles and answer different
 * questions, and merging them would put an `atRiskCents` on a button.
 */
export interface DockZoneOption {
  readonly id: number;
  readonly name: string;
  /** What the zone is set to grow, already named, or '' when nobody has assigned a crop. */
  readonly cropName: string;
  /**
   * 1 when the crop comes back after a harvest.
   *
   * §5 paces the whole Agri-Bot arc on this: a harvester alone sustains a regrowing zone forever
   * and empties a one-shot zone exactly once. Read off `CropSpec.regrowTicks`, never a list here.
   */
  readonly regrows: number;
  readonly tiles: number;
  readonly planted: number;
  readonly mature: number;
}

/**
 * The at-the-machine card for an Agri-Bot dock: what it has been told to do.
 *
 * `machineId` of 0 means the player is not standing at a dock and the card has no subject — the
 * same "a consequence of position, not a menu" rule the bench runs on.
 */
export interface DockSlice {
  readonly version: number;
  readonly machineId: number;
  readonly kind: number;
  readonly label: string;
  /** 1 for the planter, which is the dock with a seed hopper. */
  readonly planter: number;
  /**
   * The zone id this dock works, 0 for none, or **-1 when the projection does not publish it**.
   *
   * See `dockZoneOf` in `derive-dock.ts` for the handoff. The three states are genuinely three:
   * a dock with orders, a dock without them, and a build that cannot tell.
   */
  readonly boundZone: number;
  /** The bound zone's name, when it is both known and still exists. */
  readonly boundName: string;
  /** `BotPhase` of this dock's bot, or -1 when it has none. */
  readonly botPhase: number;
  readonly botConditionPermille: number;
  readonly zones: readonly DockZoneOption[];
}

export interface HudSnapshot {
  readonly economy: EconomySlice;
  readonly pouch: PouchSlice;
  readonly tools: ToolSlice;
  readonly clipboard: ClipboardSlice;
  readonly tech: TechSlice;
  readonly bench: BenchSlice;
  readonly dock: DockSlice;
  readonly lot: LotSlice;
  readonly shop: ShopSlice;
  readonly inventory: InventorySlice;
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
  cheatsUsed: 0,
});

export const ZERO_POUCH: PouchSlice = Object.freeze({
  version: 0,
  items: Object.freeze([]),
  canCharges: 0,
  canChargesMax: 0,
  shoreHeading: '',
});

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
  boxable: 0,
  boxBlocked: '',
});

export const ZERO_DOCK: DockSlice = Object.freeze({
  version: 0,
  machineId: 0,
  kind: 0,
  label: '',
  planter: 0,
  // Not standing at a dock, so there is nothing to be unsure about — but the zero value has to
  // be a state the card renders as "no subject", and `machineId === 0` is the one that says so.
  boundZone: -1,
  boundName: '',
  botPhase: -1,
  botConditionPermille: 0,
  zones: Object.freeze([]),
});

export const ZERO_LOT: LotSlice = Object.freeze({
  version: 0,
  zones: Object.freeze([]),
  wilting: 0,
  wilted: 0,
  atRiskCents: 0,
  imminentCents: 0,
  compost: 0,
  alert: null,
  machines: 0,
  running: 0,
  halted: 0,
  jammed: 0,
  starved: 0,
  blocked: 0,
  sprinklers: 0,
});

export const ZERO_SHOP: ShopSlice = Object.freeze({
  version: 0,
  rows: Object.freeze([]),
  atStand: 0,
  standExists: 0,
  heading: '',
  standTileX: -1,
  standTileY: -1,
});

/**
 * The server snapshot, frozen and shared.
 *
 * The canvas mounts `ssr: false`, but the HUD does not have to — and a panel rendered on
 * the server must return the SAME reference every call or React throws a
 * "getServerSnapshot should be cached" error rather than a hydration warning.
 */
export const ZERO_INVENTORY: InventorySlice = Object.freeze({
  version: 0,
  rows: Object.freeze([]),
  boxCount: 0,
  scrapCents: 0,
});

export const ZERO_SNAPSHOT: HudSnapshot = Object.freeze({
  economy: ZERO_ECONOMY,
  pouch: ZERO_POUCH,
  tools: ZERO_TOOLS,
  clipboard: ZERO_CLIPBOARD,
  tech: ZERO_TECH,
  bench: ZERO_BENCH,
  dock: ZERO_DOCK,
  lot: ZERO_LOT,
  shop: ZERO_SHOP,
  inventory: ZERO_INVENTORY,
});
