// The reports' read boundary. One store, three slices, the same three rules as `hud/store.ts`.
// (Four slices until item 150 removed the Shift Report's ledger slice and the Diagnostics
// slice that item 145's tech cut had already orphaned.)
//
// This is a SECOND external store rather than more slices on the HUD's, and that is a
// deliberate call with a reason on both sides. Against: two stores means two `subscribe`
// sets. For: the reports own a per-machine idle watch, an IndexedDB connection and
// a command sink, none of which the Ticker or the toolbelt has any business carrying — and
// the HUD is being extended by another agent right now, so a second file is also a second
// merge that never conflicts. The publish path is identical, the cadence is identical, and
// nothing in either store reads the other.
//
// THE THREE RULES, RESTATED BECAUSE THEY STILL BITE:
//
//   1. PUBLISHED AT THE HUD'S CADENCE, NOT ON A TIMER. `GameHost` calls `publishWorld` from
//      inside the tick loop. There is no `setInterval` here, because a second clock in an
//      app with a fixed-timestep clock is a bug waiting for a slow frame.
//   2. `getSnapshot` NEVER ALLOCATES. Each slice is rebuilt only when one of its fields
//      actually moved, and the top-level snapshot only when a slice was rebuilt. When
//      nothing changed, `publishWorld` returns without notifying anybody.
//   3. THE HOST OWNS THE STORE, BY TOKEN. StrictMode mounts, unmounts and remounts, so two
//      hosts exist briefly and the dying one must not reset the store under the live one.
//
// THE DAWN CARD'S LIFETIME IS COUNTED IN TICKS. Five seconds is a hundred ticks, and they
// are counted by the loop that is already running rather than by a `setTimeout`. It matters
// beyond tidiness: the card is supposed to be non-blocking and cosmetic, so it must not
// outlive a tab that stopped ticking, and it must not be the one thing in the app keeping a
// timer alive. Dismissing it early is free and immediate.
//
// NOTHING HERE MUTATES THE WORLD. The commerce panel's buttons enqueue a `Command` through
// a sink the host attaches; the sink is null until it does, and the panel disables itself
// rather than pretending (§12: every mutation is a command applied at a tick).

import {
  ItemId,
  itemSpec,
  listPriceCents,
  machineKindForBoxedItem,
  machineRecipes,
  machineSpec,
} from '@snack/sim';
import type { MachineKind, WorldView } from '@snack/sim';

import { itemName } from '../hud/item-copy';

import {
  FIRST_TEN_CENTI_HOURS,
  deriveBoards,
  emptyBests,
  foldBests,
  readBoardValues,
} from './boards';
import type { BoardValues, PersonalBests } from './boards';
import { dawnCount, dayNumber } from './day';
import { IdleWatch } from './idle';
import { loadBests, loadWorldRecord, saveBests, saveWorldRecord } from './persist';
import { DESTINATIONS, readCommerce, readGrossAndSpend, readSalesByItem } from './sim-contract';
import type { CommandSink, CommerceCommand, CommerceView } from './sim-contract';
import { ZERO_BOARDS, ZERO_COMMERCE, ZERO_DAWN, ZERO_REPORTS } from './types';
import type {
  BoardsSlice,
  CartRow,
  CommerceSlice,
  ContractRow,
  DawnCard,
  DawnSlice,
  DepotRow,
  ReportsSliceName,
  ReportsSnapshot,
} from './types';

/** Plan §2: "a 5-second non-blocking card". A hundred ticks, counted by the sim's clock. */
const DAWN_CARD_TICKS = 100;

/** How often the world record and the bests are written back. Thirty seconds of sim time. */
const PERSIST_PERIOD_TICKS = 600;

export type Unsubscribe = () => void;

export class ReportsStore {
  private readonly listeners = new Set<() => void>();

  private dawn: DawnSlice = ZERO_DAWN;
  private boards: BoardsSlice = ZERO_BOARDS;
  private commerce: CommerceSlice = ZERO_COMMERCE;
  private snapshot: ReportsSnapshot = ZERO_REPORTS;

  private owner: object | null = null;
  private sink: CommandSink | null = null;
  private worldSeed = 0;

  private readonly idle = new IdleWatch();

  private bests: PersonalBests = emptyBests();
  private bestsLoaded = false;
  private bestsDirty = false;

  /** Lifetime net earnings the moment the world crossed ten active hours. −1 before that. */
  private firstTenCents = -1;

  /**
   * 1 once this session has seen the world BELOW ten active hours.
   *
   * Without it, a world restored already past the mark would freeze its current lifetime
   * earnings and call the result a First Ten score. See `publishWorld`.
   */
  private sawBeforeTen = false;

  private lastCommerce: CommerceView | null = null;
  private lastPublishedTick = 0;
  private lastValues: BoardValues | null = null;

  private lastDawn = -1;
  private dawnClearTick = -1;
  private dayMarkNetCents = 0;
  private dayMarkEarnedCents = 0;
  private persistDueTick = 0;

  // --- React's three functions -------------------------------------------------------

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable per-slice getters, built once. A closure per render would allocate per render. */
  readonly getters: { readonly [K in ReportsSliceName]: () => ReportsSnapshot[K] } = {
    dawn: () => this.snapshot.dawn,
    boards: () => this.snapshot.boards,
    commerce: () => this.snapshot.commerce,
  };

  /**
   * The server render, and the client's first render before any publish. Returns the one
   * frozen zero snapshot every time — React requires this to be cached, and a fresh object
   * here is an infinite-loop error rather than a hydration warning.
   */
  readonly serverGetters: { readonly [K in ReportsSliceName]: () => ReportsSnapshot[K] } = {
    dawn: () => ZERO_REPORTS.dawn,
    boards: () => ZERO_REPORTS.boards,
    commerce: () => ZERO_REPORTS.commerce,
  };

  getSnapshot(): ReportsSnapshot {
    return this.snapshot;
  }

  // --- ownership ---------------------------------------------------------------------

  /**
   * Called by a starting `GameHost`. Wipes whatever the previous host left behind and kicks
   * off the two storage reads, which resolve whenever they resolve — the panels render a
   * dash for "best" until then rather than blocking on a database.
   */
  claim(token: object, worldSeed: number): void {
    this.owner = token;
    this.worldSeed = worldSeed;
    this.idle.reset();
    this.bests = emptyBests();
    this.bestsLoaded = false;
    this.bestsDirty = false;
    this.firstTenCents = -1;
    this.sawBeforeTen = false;
    this.lastDawn = -1;
    this.dawnClearTick = -1;
    this.dayMarkNetCents = 0;
    this.dayMarkEarnedCents = 0;
    this.persistDueTick = 0;
    this.lastCommerce = null;
    this.lastPublishedTick = 0;
    this.lastValues = null;
    this.lastSellable = Object.freeze([]);
    this.lastSellableKey = '';
    this.resetSlices();

    void this.restore(token, worldSeed);
  }

  /** Called by a disposing `GameHost`. A stale host calling this is ignored, by design. */
  release(token: object): void {
    if (this.owner !== token) return;
    // Flush before letting go. A First Ten frozen moments before navigating away must land.
    void this.flush();
    this.owner = null;
    this.sink = null;
    this.resetSlices();
  }

  /**
   * Attach the way OUT: a function that puts a `Command` on the host's queue.
   *
   * Separate from `claim` because the commerce commands do not exist in the sim's `Command`
   * union yet (see `sim-contract.ts`). A host that cannot accept them simply never calls
   * this, the slice reports `wired: 0`, and the panel's buttons disable themselves — which
   * is the honest state, and visibly better than a button that looks live and does nothing.
   */
  attachCommandSink(token: object, sink: CommandSink): void {
    if (this.owner !== token) return;
    this.sink = sink;
    // Republish immediately rather than waiting for the next tick boundary: the panel's
    // buttons are disabled while `wired` is 0, and a control that stays greyed for 150 ms
    // after it became usable reads as a UI that did not hear you.
    if (this.setCommerce(this.lastCommerce, true)) this.commit();
  }

  private async restore(token: object, worldSeed: number): Promise<void> {
    const [bests, stored] = await Promise.all([loadBests(), loadWorldRecord(worldSeed)]);
    // The host may have been swapped while IndexedDB was thinking. Restoring into a store
    // somebody else now owns would hand the live world another world's records.
    if (this.owner !== token) return;

    this.bests = bests ?? emptyBests();
    this.bestsLoaded = true;
    if (stored !== null) {
      // Only when this session has not already taken its own reading. IndexedDB resolving
      // late is rare and would otherwise undo a freeze that just happened.
      if (this.firstTenCents < 0) this.firstTenCents = stored.firstTenCents;
    }
    // Nothing to notify with yet if no publish has happened; the next one picks it up.
    this.commitIfChanged(this.rebuildBoardsFromLast());
  }

  private rebuildBoardsFromLast(): boolean {
    if (this.lastValues === null) return false;
    return this.setBoards(this.lastValues);
  }

  private resetSlices(): void {
    this.dawn = ZERO_DAWN;
    this.boards = ZERO_BOARDS;
    this.commerce = ZERO_COMMERCE;
    this.snapshot = ZERO_REPORTS;
    this.notify();
  }

  // --- the way in --------------------------------------------------------------------

  /**
   * Publish one world reading. Called from the tick loop at the HUD's cadence.
   *
   * `view` is the host's REUSED projection buffer and is only valid for the duration of this
   * call. Everything kept from it below is copied out as a primitive.
   */
  publishWorld(token: object, view: WorldView): void {
    if (this.owner !== token) return;
    this.lastPublishedTick = view.tick;

    let changed = false;

    this.idle.observe(view);

    // First Ten is scored AT ten active hours and then never again (§7 ruling 4). Freezing
    // it the first time the world crosses the mark is what makes it a First Ten score rather
    // than a Dynasty score wearing its name.
    //
    // AND IT ONLY COUNTS IF WE WATCHED IT HAPPEN. A world can arrive at this store already
    // past the mark — restored from a save whose reports record is gone, which needs no
    // misfortune at all, since the two live in different stores and `loadWorldRecord`
    // swallows every failure and returns null. Its lifetime net earnings at that moment are a
    // twelve-hour figure, and freezing THAT would post a First Ten score nobody ever scored.
    // So the freeze requires having seen the world below the mark; failing that the score
    // stays unknown, and the board says unknown rather than guessing.
    const pastTen = view.stats.centiActiveHours >= FIRST_TEN_CENTI_HOURS;
    if (!pastTen) this.sawBeforeTen = true;
    if (pastTen && this.sawBeforeTen && this.firstTenCents < 0) {
      this.firstTenCents = view.stats.lifetimeNetEarningsCents;
      this.bestsDirty = true;
    }

    // Read AFTER the freeze, so the publish that crosses the mark already reports a known
    // score instead of an unknown one it corrects a fifth of a second later.
    const values = readBoardValues(view, this.firstTenCents);
    this.lastValues = values;
    if (this.bestsLoaded && foldBests(this.bests, values)) this.bestsDirty = true;
    if (this.setBoards(values)) changed = true;

    this.refreshSellable(view);
    this.lastCommerce = readCommerce(view);
    if (this.setCommerce(this.lastCommerce, this.sink !== null)) changed = true;
    if (this.advanceDawn(view)) changed = true;

    if (view.tick >= this.persistDueTick) {
      this.persistDueTick = view.tick + PERSIST_PERIOD_TICKS;
      void this.flush();
    }

    if (!changed) return;
    this.commit();
  }

  /**
   * Dismiss the Dawn Report early. Free, immediate, and the only thing the card's own click
   * handler does — it does not pause anything, because there is nothing to pause.
   */
  dismissDawn(): void {
    if (this.dawn.card === null) return;
    this.dawnClearTick = -1;
    this.dawn = Object.freeze({ version: this.dawn.version + 1, card: null });
    this.commit();
  }

  /** The commerce panel's one door to the world. A no-op until a host attaches a sink. */
  submit(command: CommerceCommand): void {
    this.sink?.(command);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private commit(): void {
    this.snapshot = {
      dawn: this.dawn,
      boards: this.boards,
      commerce: this.commerce,
    };
    this.notify();
  }

  private commitIfChanged(changed: boolean): void {
    if (changed) this.commit();
  }

  private async flush(): Promise<void> {
    const writes: Promise<void>[] = [];
    if (this.bestsDirty && this.bestsLoaded) {
      this.bestsDirty = false;
      writes.push(saveBests(this.bests));
    }
    // The per-world record is down to First Ten (item 150 removed the Shift Report and its
    // ledger), and that one number still MUST be written: it is a reports-side reading taken
    // once, at the moment the world crosses ten active hours, and NOTHING IN THE SIM HOLDS
    // IT. Skipping this write is how First Ten silently becomes the Dynasty board with a
    // longer name after a reload (plan §7 ruling 4's exact inversion).
    if (this.worldSeed !== 0) {
      writes.push(
        saveWorldRecord({
          worldSeed: this.worldSeed,
          firstTenCents: this.firstTenCents,
        }),
      );
    }
    await Promise.all(writes);
  }

  // --- slice writers -----------------------------------------------------------------
  // (`setShift` stood first here until item 150 removed the Shift Report's slice.)

  private setBoards(values: BoardValues): boolean {
    const rows = deriveBoards(values, this.bests);
    const previous = this.boards;
    if (
      previous.rows.length === rows.length &&
      previous.centiActiveHours === values.centiActiveHours &&
      previous.loaded === (this.bestsLoaded ? 1 : 0)
    ) {
      let same = true;
      for (let i = 0; i < rows.length; i++) {
        const a = previous.rows[i]!;
        const b = rows[i]!;
        if (a.value !== b.value || a.best !== b.best || a.eligible !== b.eligible) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }

    this.boards = Object.freeze({
      version: previous.version + 1,
      rows: Object.freeze(rows),
      centiActiveHours: values.centiActiveHours,
      loaded: this.bestsLoaded ? 1 : 0,
    });
    return true;
  }

  private setCommerce(commerce: CommerceView | null, wired: boolean): boolean {
    const previous = this.commerce;
    const installed = commerce === null ? 0 : 1;
    const wiredFlag = wired ? 1 : 0;

    const carts: CartRow[] =
      commerce === null
        ? []
        : commerce.carts.map((cart, index) =>
            Object.freeze({
              id: cart.id,
              label: `Cart ${String.fromCharCode(65 + (index % 26))}`,
              loaded: cart.loaded,
              capacity: cart.capacity,
              valueCents: cart.item === 0 ? 0 : listPriceCents(cart.item as ItemId) * cart.loaded,
              away: cart.away,
              ticksRemaining: cart.ticksRemaining,
              runTicks: cart.runTicks,
            }),
          );

    const depots: DepotRow[] =
      commerce === null
        ? []
        : commerce.depots.map((depot, index) =>
            Object.freeze({
              id: depot.id,
              label: `Depot ${String.fromCharCode(65 + (index % 26))}`,
              contractIds: Object.freeze(depot.contractIds.slice()),
              stocked: depot.stocked,
              capacity: depot.capacity,
            }),
          );

    const contracts: ContractRow[] =
      commerce === null
        ? []
        : commerce.contracts.map((contract) =>
            Object.freeze({
              id: contract.id,
              item: contract.item,
              itemLabel: itemLabel(contract.item),
              destination: contract.destination,
              quantityPerRun: contract.quantityPerRun,
              // Posted list price × quantity. DISPLAYED, never chosen — a contract is a
              // logistics object and there is no negotiation anywhere in this UI.
              runValueCents: listPriceCents(contract.item as ItemId) * contract.quantityPerRun,
              stocked: contract.stocked,
              runsCompleted: contract.runsCompleted,
              grossCents: contract.grossCents,
              phase: contract.phase,
              ticksRemaining: contract.ticksRemaining,
            }),
          );

    const sellable = this.lastSellable;

    if (
      previous.installed === installed &&
      previous.wired === wiredFlag &&
      previous.carts.length === carts.length &&
      previous.depots.length === depots.length &&
      previous.contracts.length === contracts.length &&
      previous.automatedGrossCents === (commerce?.automatedGrossCents ?? 0) &&
      previous.sellable === sellable &&
      sameCarts(previous.carts, carts) &&
      sameContracts(previous.contracts, contracts)
    ) {
      return false;
    }

    this.commerce = Object.freeze({
      version: previous.version + 1,
      installed,
      carts: Object.freeze(carts),
      depots: Object.freeze(depots),
      contracts: Object.freeze(contracts),
      sellable,
      automatedGrossCents: commerce?.automatedGrossCents ?? 0,
      wired: wiredFlag,
    });
    return true;
  }

  // (`setDiagnostics` stood here until item 150 removed the panel; the sim-side bleed
  // figures it ranked were cut with item 145's Diagnostics tech.)

  /**
   * Products the lot can write a contract for: whatever its machines actually make.
   *
   * **EVERY RECIPE, NOT THE SPEC'S ONE OUTPUT** (item 111), and this was not a copy problem.
   * `spec.outputItem` is what a machine makes on an ordinary day — a Bagger makes bagged
   * chips — so a Bagger on the lot put exactly one row in this list however many flavours it
   * could actually run. A depot only accepts an item it has a contract for
   * (`depotCanAcceptRoute`), and this list is the only place a contract can be written from,
   * so chili chips could not be routed through a depot AT ALL: not badly labelled, not priced
   * wrong — belted in, refused at the door, with no row anywhere to explain it.
   *
   * IT LISTS WHAT THE MACHINES CAN MAKE RATHER THAN WHAT IS IN STOCK, which is the rule it
   * has always followed (it lists washed potatoes and slices, and nobody stocks those) and
   * the only rule that works: a contract is a standing order that waits for supply, so
   * writing one BEFORE the first chili is grown is the ordinary way to use the feature. The
   * cost of the wider list is a longer dropdown on a mature lot; the cost of the narrow one
   * was a product with no way out of the factory.
   *
   * Rebuilt only when the machine census changes shape, because the list is stable for
   * minutes at a time and allocating six objects seven times a second to hand React an
   * identical array is exactly the allocation the version dance exists to avoid.
   */
  private lastSellable: CommerceSlice['sellable'] = Object.freeze([]);
  private lastSellableKey = '';

  private refreshSellable(view: WorldView): void {
    let key = '';
    const items: number[] = [];
    for (let i = 0; i < view.machines.length; i++) {
      const spec = machineSpec(view.machines[i]!.kind as MachineKind);
      if (spec === null) continue;
      const recipes = machineRecipes(spec);
      for (let r = 0; r < recipes.length; r++) {
        const output = recipes[r]!.output;
        if (output === null) continue;
        if (items.includes(output)) continue;
        items.push(output);
        key += `${output},`;
      }
    }
    if (key === this.lastSellableKey) return;
    this.lastSellableKey = key;
    items.sort((a, b) => a - b);
    this.lastSellable = Object.freeze(
      items.map((item) =>
        Object.freeze({ item, label: itemLabel(item), priceCents: listPriceCents(item as ItemId) }),
      ),
    );
  }

  /**
   * Fire the Dawn Report on the tick the dawn count moves, and clear it a hundred ticks
   * later. Non-blocking throughout: nothing is paused, nothing takes focus, and the card
   * cannot swallow a click meant for the lot.
   */
  private advanceDawn(view: WorldView): boolean {
    const count = dawnCount(view.tick);
    const stats = view.stats;

    if (this.lastDawn < 0) {
      // First publish of a session. A world restored at 3pm on day nine must not open with
      // nine days of card, so the count is adopted silently and the marks are taken here.
      this.lastDawn = count;
      this.dayMarkNetCents = stats.lifetimeNetEarningsCents;
      this.dayMarkEarnedCents = readGrossAndSpend(view)?.earned ?? 0;
      return false;
    }

    if (count > this.lastDawn) {
      this.lastDawn = count;
      const flag = this.idle.worst();
      this.idle.rollDay();

      const netCents = stats.lifetimeNetEarningsCents - this.dayMarkNetCents;
      this.dayMarkNetCents = stats.lifetimeNetEarningsCents;

      const split = readGrossAndSpend(view);
      const earnedCents = split === null ? netCents : split.earned - this.dayMarkEarnedCents;
      this.dayMarkEarnedCents = split?.earned ?? 0;

      const card: DawnCard = Object.freeze({
        id: count,
        day: dayNumber(view.tick),
        earnedCents,
        netCents,
        split: split === null ? 0 : 1,
        bestSeller: bestSellerFrom(view),
        flag,
      });
      this.dawn = Object.freeze({ version: this.dawn.version + 1, card });
      this.dawnClearTick = view.tick + DAWN_CARD_TICKS;
      // A dawn is a good moment to write the day down, and it is the one moment a player
      // reliably reads the report — so the numbers behind it should already be on disk.
      void this.flush();
      return true;
    }

    if (this.dawnClearTick >= 0 && view.tick >= this.dawnClearTick) {
      this.dawnClearTick = -1;
      if (this.dawn.card !== null) {
        this.dawn = Object.freeze({ version: this.dawn.version + 1, card: null });
        return true;
      }
    }
    return false;
  }
}

/**
 * The day's best seller, or null.
 *
 * NULL IS THE HONEST ANSWER TODAY. `StatsView` projects `itemsSold` as one total with no
 * per-item breakdown, and there is no arithmetic on the projection that recovers which
 * product it was — an average price back-solved from gross would be a guess dressed as a
 * receipt. `sim-contract.ts` names the field the sim needs (`stats.salesByItem`); the row
 * prints its own absence until that lands, per plan §8's "stubs listed explicitly".
 */
function bestSellerFrom(view: WorldView): DawnCard['bestSeller'] {
  const sales = readSalesByItem(view);
  if (sales === null) return null;

  let best: DawnCard['bestSeller'] = null;
  let bestGross = 0;
  for (let i = 0; i < sales.length; i++) {
    const entry = sales[i]!;
    if (entry.dayGrossCents <= bestGross) continue;
    bestGross = entry.dayGrossCents;
    best = Object.freeze({
      label: itemLabel(entry.item),
      count: entry.dayCount,
      grossCents: entry.dayGrossCents,
    });
  }
  return best;
}

/**
 * Names the receipt spells differently from the panel — and there are only two of them.
 *
 * The paperwork's register is longer and more formal than `hud/derive.ts`'s pouch labels
 * ("russets", "chips") on purpose: the pouch is what is in your hands and a receipt is a
 * document. "Bagged chips × 40" belongs on a contract; "chips" belongs in a pocket. But that
 * is a rule about CASE, not about vocabulary — a contract and a bag should call the same
 * object the same word — so the names themselves come from `itemName`, and this table holds
 * only the two the receipt genuinely says differently. A bottle in your hands is a bottle;
 * a bottle on an invoice, sitting one line above the soda it will become, is an empty one.
 */
const RECEIPT_NAMES: Readonly<Record<number, string>> = {
  [ItemId.Bottle]: 'Empty bottle',
  [ItemId.Soda]: 'Bottled soda',
};

/**
 * The name of a line item, DERIVED rather than listed (item 111).
 *
 * **THIS WAS A HAND-KEYED TABLE OF NUMBERS AND IT WENT STALE TWICE.** Its own comment
 * recorded the first time: it stopped at 18 while `ItemId` marched to 69, so a contract for
 * kola powder read "Item 22" — "a receipt naming its own line item by number, which is the
 * exact credibility leak this vocabulary exists to prevent". The repair added thirty rows and
 * left the mechanism in place, so item 111 walked straight into the second one: nine new
 * products landed in `data.ts`, and a chili contract — a thing a player deliberately set up
 * and is waiting on — billed itself as "Item 76".
 *
 * A THIRD REPAIR WOULD HAVE BEEN THE SAME BUG WITH A LATER DATE. So the default is the sim's
 * own slug, by way of `itemName`, which is the one place this app spells items; the whole
 * table above is what is left. That is `hud/item-copy.ts`'s argument — a table of exceptions
 * stays small, a table of everything goes stale the day an item is added, silently, in the
 * one place the player is looking — and this is the surface that had not heard it yet.
 *
 * BOXED MACHINES KEEP THEIR CAPITALS. No contract ships one and no dawn card sells one, so
 * this is a branch for a row that should never print — but the sentence-casing below is meant
 * for produce, and a Root Cellar that arrived here as "Root cellar" would look like a typo
 * rather than like the impossible row it actually is.
 *
 * AN ITEM WITH NO SPEC KEEPS ITS NUMBER, which is the one thing the old table did better and
 * is worth carrying across. `itemName` answers "Unknown item" — right for a bag, where the
 * player wants to know it is a save from the future rather than a bug — but a receipt is a
 * document somebody may have to reconcile, and the id is the only handle it has.
 */
export function itemLabel(item: number): string {
  const exception = RECEIPT_NAMES[item];
  if (exception !== undefined) return exception;
  if (itemSpec(item as ItemId) === null) return `Item ${item}`;

  const name = itemName(item);
  if (machineKindForBoxedItem(item as ItemId) !== null) return name;
  // "Bagged Chili Chips" → "Bagged chili chips". One capital, at the front, exactly as a line
  // on an invoice is written.
  return name.charAt(0) + name.slice(1).toLowerCase();
}

/** A destination name for a new contract. Flavour only; every one of them pays list. */
export function destinationFor(contractCount: number): string {
  return DESTINATIONS[contractCount % DESTINATIONS.length] ?? DESTINATIONS[0]!;
}

function sameCarts(a: readonly CartRow[], b: readonly CartRow[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.loaded !== y.loaded ||
      x.away !== y.away ||
      x.valueCents !== y.valueCents ||
      // Quantised: the countdown moves every tick and nobody reads a truck's ETA to the
      // twentieth of a second.
      Math.floor(x.ticksRemaining / 20) !== Math.floor(y.ticksRemaining / 20)
    ) {
      return false;
    }
  }
  return true;
}

function sameContracts(a: readonly ContractRow[], b: readonly ContractRow[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.item !== y.item ||
      x.quantityPerRun !== y.quantityPerRun ||
      x.stocked !== y.stocked ||
      x.runsCompleted !== y.runsCompleted ||
      x.phase !== y.phase ||
      Math.floor(x.ticksRemaining / 20) !== Math.floor(y.ticksRemaining / 20)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The singleton. Safe at module scope in a way a `GameHost` is not — it holds no GPU
 * resources, and the token dance above makes a StrictMode double-mount a non-event.
 */
export const reportsStore = new ReportsStore();
