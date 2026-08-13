// The one boundary sim state crosses to reach React.
//
// There is exactly one of these and there are no others. No Context, no state library, no
// second path. If a component gets a number out of the world by any route that is not this
// file, that route is a bug (§13).
//
// THREE RULES, EACH WITH A FAILURE MODE:
//
//   1. PUBLISHED AT 4–8 Hz, NOT 20. The host calls `publishWorld` every third tick
//      (≈6.7 Hz) from inside the tick loop — not from a `setInterval`, because a second
//      clock in an app that already has a fixed-timestep clock is a bug waiting for a
//      slow frame to surface it. Nobody reads a throughput counter twenty times a second,
//      and throttling removes two thirds of the React work before any cleverness.
//
//   2. `getSnapshot` NEVER ALLOCATES. `useSyncExternalStore` compares with `Object.is`;
//      a getter that mints a fresh object re-renders every subscriber on every publish
//      whether or not anything changed. THAT is the re-render storm — not the publish
//      rate. So each slice is rebuilt only when one of its fields actually moved, its
//      `version` bumps when it is, and the top-level snapshot is rebuilt only when at
//      least one slice moved. When nothing changed, `publishWorld` returns without
//      notifying anybody at all.
//
//   3. THE HOST OWNS THE STORE, BY TOKEN. StrictMode mounts, unmounts, and remounts, so
//      two `GameHost`s exist briefly and the dying one must not be able to reset the store
//      out from under the live one. `claim()` hands back the right to publish; `release()`
//      only takes effect for the holder.
//
// Everything in a slice is plain serializable data — the same rule `view(state)` follows,
// for the same reason (§12): a live reference is free today and makes the Worker move a
// rewrite instead of a transport change.

import type { Command, WorldView } from '@snack/sim';

import type { ToolMode } from '@/game/input/tools';

import {
  censusMachines,
  createMachineCounts,
  deriveClipboard,
  derivePouch,
  deriveTools,
  deriveUnlock,
} from './derive';
import type { MachineCounts, UnlockFields } from './derive';
import { createInventoryFields, deriveInventory } from './derive-inventory';
import type { InventoryFields } from './derive-inventory';
import { RiskWatch, createLotFields, deriveLot } from './derive-lot';
import type { LotFields } from './derive-lot';
import { createShopFields, deriveShop } from './derive-shop';
import type { ShopFields } from './derive-shop';
import { createBenchFields, createTechFields, deriveBench, deriveTech } from './derive-tech';
import type { BenchFields, TechFields } from './derive-tech';
import { RateMeter } from './rate';
import type {
  BenchDial,
  BenchSlice,
  ClipboardNote,
  ClipboardSlice,
  EconomySlice,
  HudLive,
  HudSnapshot,
  InventoryRow,
  InventorySlice,
  LotSlice,
  PouchItem,
  PouchSlice,
  ShopRow,
  ShopSlice,
  SliceName,
  TechCard,
  TechSlice,
  ToolSlice,
  ToolSlot,
  UnlockSlice,
  ZoneRow,
} from './types';
import {
  ZERO_BENCH,
  ZERO_CLIPBOARD,
  ZERO_ECONOMY,
  ZERO_INVENTORY,
  ZERO_LOT,
  ZERO_POUCH,
  ZERO_SHOP,
  ZERO_SNAPSHOT,
  ZERO_TECH,
  ZERO_TOOLS,
  ZERO_UNLOCK,
} from './types';

/**
 * The Clipboard re-reads the lot every two seconds rather than every publish. Observations
 * that reshuffle seven times a second are not observations, they are a strobe — and the
 * field scan is the only non-trivial loop on this path.
 */
const CLIPBOARD_PERIOD_TICKS = 40;

export type Unsubscribe = () => void;

export class HudStore {
  private readonly listeners = new Set<() => void>();

  private economy: EconomySlice = ZERO_ECONOMY;
  private unlock: UnlockSlice = ZERO_UNLOCK;
  private pouch: PouchSlice = ZERO_POUCH;
  private tools: ToolSlice = ZERO_TOOLS;
  private clipboard: ClipboardSlice = ZERO_CLIPBOARD;
  private tech: TechSlice = ZERO_TECH;
  private bench: BenchSlice = ZERO_BENCH;
  private lot: LotSlice = ZERO_LOT;
  private shop: ShopSlice = ZERO_SHOP;
  private inventory: InventorySlice = ZERO_INVENTORY;
  private snapshot: HudSnapshot = ZERO_SNAPSHOT;

  private owner: object | null = null;
  private selector: ((tool: ToolMode) => void) | null = null;
  private dispatcher: ((command: Command) => void) | null = null;

  private readonly meter = new RateMeter();
  private readonly counts: MachineCounts = createMachineCounts();
  private readonly techScratch: TechFields = createTechFields();
  private readonly benchScratch: BenchFields = createBenchFields();
  private readonly lotScratch: LotFields = createLotFields();
  private readonly shopScratch: ShopFields = createShopFields();
  private readonly inventoryScratch: InventoryFields = createInventoryFields();
  private readonly riskWatch = new RiskWatch();
  private readonly unlockScratch: UnlockFields = {
    id: null,
    label: '',
    blurb: '',
    priceCents: 0,
    owned: 0,
    affordable: 0,
    etaSeconds: -1,
  };
  private clipboardDueTick = -(2 ** 30);

  /**
   * Machine kinds the player has a box of, remembered from the last publish.
   *
   * REMEMBERED RATHER THAN LOOKED UP because `publishTool` has no world: tool selection publishes
   * immediately, off a key press, with nothing but the money (see below), and a toolbelt that
   * forgot about the box for one frame would flash a price at the player at the exact moment they
   * pressed the key. Up to 150 ms stale, which is the same staleness every other number on the
   * toolbelt already has.
   */
  private boxedKinds: number[] = [];

  /**
   * The non-reactive channel (§13). Mutated in place, read by rAF writers that put text
   * straight into a DOM node. Nothing renders from it — see `types.ts`.
   */
  readonly live: HudLive = { tick: 0, moneyCents: 0, clock: '', status: '' };

  // --- React's three functions -------------------------------------------------------

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable per-slice getters, built once. A closure per render would allocate per render. */
  readonly getters: { readonly [K in SliceName]: () => HudSnapshot[K] } = {
    economy: () => this.snapshot.economy,
    unlock: () => this.snapshot.unlock,
    pouch: () => this.snapshot.pouch,
    tools: () => this.snapshot.tools,
    clipboard: () => this.snapshot.clipboard,
    tech: () => this.snapshot.tech,
    bench: () => this.snapshot.bench,
    lot: () => this.snapshot.lot,
    shop: () => this.snapshot.shop,
    inventory: () => this.snapshot.inventory,
  };

  /**
   * The server render, and the client's first render before any publish. Returns the one
   * frozen zero snapshot every time: React requires this to be cached, and a fresh object
   * here is an infinite-loop error rather than a hydration warning.
   */
  readonly serverGetters: { readonly [K in SliceName]: () => HudSnapshot[K] } = {
    economy: () => ZERO_SNAPSHOT.economy,
    unlock: () => ZERO_SNAPSHOT.unlock,
    pouch: () => ZERO_SNAPSHOT.pouch,
    tools: () => ZERO_SNAPSHOT.tools,
    clipboard: () => ZERO_SNAPSHOT.clipboard,
    tech: () => ZERO_SNAPSHOT.tech,
    bench: () => ZERO_SNAPSHOT.bench,
    lot: () => ZERO_SNAPSHOT.lot,
    shop: () => ZERO_SNAPSHOT.shop,
    inventory: () => ZERO_SNAPSHOT.inventory,
  };

  getSnapshot(): HudSnapshot {
    return this.snapshot;
  }

  // --- ownership ---------------------------------------------------------------------

  /** Called by a starting `GameHost`. Wipes whatever the previous host left behind. */
  claim(
    token: object,
    selectTool: (tool: ToolMode) => void,
    dispatch: (command: Command) => void,
  ): void {
    this.owner = token;
    this.selector = selectTool;
    this.dispatcher = dispatch;
    this.meter.reset();
    // A fresh world does not inherit the last one's bleed. Without this, loading a save
    // could fire the sixty-second alert on the first publish, which is the exact
    // fire-immediately behaviour the delay exists to prevent.
    this.riskWatch.reset();
    this.clipboardDueTick = -(2 ** 30);
    this.live.tick = 0;
    this.live.moneyCents = 0;
    this.live.clock = '';
    this.live.status = '';
    this.boxedKinds.length = 0;
    this.resetSlices();
  }

  /** Called by a disposing `GameHost`. A stale host calling this is ignored, by design. */
  release(token: object): void {
    if (this.owner !== token) return;
    this.owner = null;
    this.selector = null;
    this.dispatcher = null;
    this.resetSlices();
  }

  private resetSlices(): void {
    this.economy = ZERO_ECONOMY;
    this.unlock = ZERO_UNLOCK;
    this.pouch = ZERO_POUCH;
    this.tools = ZERO_TOOLS;
    this.clipboard = ZERO_CLIPBOARD;
    this.tech = ZERO_TECH;
    this.bench = ZERO_BENCH;
    this.lot = ZERO_LOT;
    this.shop = ZERO_SHOP;
    this.inventory = ZERO_INVENTORY;
    this.snapshot = ZERO_SNAPSHOT;
    this.notify();
  }

  // --- the way in --------------------------------------------------------------------

  /**
   * Publish one world reading. Called from the tick loop every third tick.
   *
   * `view` is the host's REUSED projection buffer and is only valid for the duration of
   * this call. Everything kept from it below is copied out as a primitive.
   */
  publishWorld(token: object, view: WorldView, tool: ToolMode): void {
    if (this.owner !== token) return;

    censusMachines(view, this.counts);
    const rate = this.meter.read(view);

    let changed = false;
    if (this.setEconomy(view.moneyCents, view.stats.netWorthCents, rate)) changed = true;

    const unlock = deriveUnlock(
      view,
      this.counts,
      rate.centsPerMin,
      rate.settled,
      this.unlockScratch,
    );
    if (this.setUnlock(unlock)) changed = true;
    if (this.setPouch(derivePouch(view))) changed = true;

    // The bag is read BEFORE the toolbelt, and the order is load-bearing rather than tidy: a
    // placement tool for a machine the player has boxed costs nothing, so `setTools` needs this
    // frame's boxes rather than last frame's.
    const inventory = deriveInventory(view, this.inventoryScratch);
    this.rememberBoxedKinds(inventory);

    if (this.setTools(view.moneyCents, tool)) changed = true;
    if (this.setTech(deriveTech(view, this.techScratch))) changed = true;
    if (this.setBench(deriveBench(view, this.benchScratch))) changed = true;
    if (this.setLot(deriveLot(view, this.riskWatch, this.lotScratch))) changed = true;
    if (this.setShop(deriveShop(view, this.shopScratch))) changed = true;
    if (this.setInventory(inventory)) changed = true;

    if (view.tick >= this.clipboardDueTick) {
      this.clipboardDueTick = view.tick + CLIPBOARD_PERIOD_TICKS;
      if (this.setClipboard(deriveClipboard(view, this.counts))) changed = true;
    }

    // The live channel is updated unconditionally and notifies nobody. That is the point
    // of it: a counter animating at 60 fps must not cost a React render at 60 fps.
    this.live.tick = view.tick;
    this.live.moneyCents = view.moneyCents;

    if (!changed) return;
    this.rebuildSnapshot();
    this.notify();
  }

  /**
   * Tool selection publishes immediately rather than waiting for the next tick boundary.
   *
   * React owns things that change when the PLAYER does something; 150 ms of lag between
   * pressing 2 and the watering can lighting up is the difference between a UI that
   * responds and one that lags. The world's numbers can wait for the cadence. This cannot.
   */
  publishTool(token: object, tool: ToolMode, moneyCents: number): void {
    if (this.owner !== token) return;
    if (!this.setTools(moneyCents, tool)) return;
    this.rebuildSnapshot();
    this.notify();
  }

  /**
   * The way OUT, and the only one: a HUD click selecting a tool.
   *
   * Tool mode is UI state, not world state — it is never a `Command`, never recorded in
   * the trace, and the sim does not know which button is lit (§12, `input/tools.ts`). If a
   * HUD control ever needs to change the world, it pushes a `Command` onto the host's
   * queue; it does not reach into `WorldState`, and nothing here ever will.
   */
  selectTool(tool: ToolMode): void {
    this.selector?.(tool);
  }

  /**
   * The way out for a HUD control that must change the WORLD, and the only one.
   *
   * `Toolbelt.tsx`'s header describes this door before it existed: "a HUD control that needed
   * to change the world would push a `Command` onto the host's queue instead; none does yet".
   * Research and the upgrade dials are the first two that do, and they go through here, which
   * means they are ordinary commands — applied at a tick boundary, validated inside the sim,
   * written into the trace, and replayable. Nothing in the HUD touches `WorldState`, and the
   * store deliberately holds a *dispatcher* rather than the queue itself so it has no way to.
   *
   * Legality is NOT checked here. The panel disables a button it expects to be refused, but
   * that is a courtesy to the player, not a gate — the sim decides, exactly as it does for a
   * click on a tile (§12). A refused command is a no-op and leaves no trace entry.
   */
  dispatch(command: Command): void {
    this.dispatcher?.(command);
  }

  private rebuildSnapshot(): void {
    this.snapshot = {
      economy: this.economy,
      unlock: this.unlock,
      pouch: this.pouch,
      tools: this.tools,
      clipboard: this.clipboard,
      tech: this.tech,
      bench: this.bench,
      lot: this.lot,
      shop: this.shop,
      inventory: this.inventory,
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  // --- slice writers -----------------------------------------------------------------

  private setEconomy(
    moneyCents: number,
    netWorthCents: number,
    rate: { centsPerMin: number; settled: number },
  ): boolean {
    const current = this.economy;
    if (
      current.moneyCents === moneyCents &&
      current.netWorthCents === netWorthCents &&
      current.rateCentsPerMin === rate.centsPerMin &&
      current.rateSettled === rate.settled
    ) {
      return false;
    }
    this.economy = Object.freeze({
      version: current.version + 1,
      moneyCents,
      netWorthCents,
      rateCentsPerMin: rate.centsPerMin,
      rateSettled: rate.settled,
    });
    return true;
  }

  private setUnlock(next: UnlockFields): boolean {
    const current = this.unlock;
    // The ETA is quantised to whole seconds before comparison. Unquantised it changes on
    // literally every publish, which would re-render the Ticker 6.7 times a second to
    // redraw the same rounded string.
    const eta = next.etaSeconds < 0 ? -1 : Math.round(next.etaSeconds);
    if (
      current.id === next.id &&
      current.priceCents === next.priceCents &&
      current.owned === next.owned &&
      current.affordable === next.affordable &&
      current.etaSeconds === eta
    ) {
      return false;
    }
    this.unlock = Object.freeze({
      version: current.version + 1,
      id: next.id,
      label: next.label,
      blurb: next.blurb,
      priceCents: next.priceCents,
      owned: next.owned,
      affordable: next.affordable,
      etaSeconds: eta,
    });
    return true;
  }

  private setPouch(items: PouchItem[]): boolean {
    const current = this.pouch.items;
    if (current.length === items.length) {
      let same = true;
      for (let i = 0; i < items.length; i++) {
        const a = current[i]!;
        const b = items[i]!;
        if (a.id !== b.id || a.count !== b.count) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }
    this.pouch = Object.freeze({ version: this.pouch.version + 1, items: Object.freeze(items) });
    return true;
  }

  /** The kinds with a box in the bag, rewritten in place — no allocation on the publish path. */
  private rememberBoxedKinds(inventory: InventoryFields): void {
    this.boxedKinds.length = 0;
    for (const row of inventory.rows) {
      if (row.boxedKind !== 0) this.boxedKinds.push(row.boxedKind);
    }
  }

  private setTools(moneyCents: number, tool: ToolMode): boolean {
    const slots = deriveTools(moneyCents, tool, this.boxedKinds);
    const current = this.tools.slots;
    if (current.length === slots.length) {
      let same = true;
      for (let i = 0; i < slots.length; i++) {
        const a = current[i] as ToolSlot;
        const b = slots[i]!;
        if (a.active !== b.active || a.affordable !== b.affordable || a.fromBox !== b.fromBox) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }
    this.tools = Object.freeze({
      version: this.tools.version + 1,
      tool,
      slots: Object.freeze(slots),
    });
    return true;
  }

  /**
   * The research slice.
   *
   * Only four things about a card can move — its status, its milestone counter, its era, and
   * which prerequisites it is still missing — because everything else on it is copy. So the
   * comparison walks those and nothing else. Without it this slice would be rebuilt on every
   * publish and re-render the whole panel 6.7 times a second to redraw thirteen identical
   * cards, which is precisely the storm the version counters exist to prevent.
   */
  private setTech(next: TechFields): boolean {
    const current = this.tech;
    if (
      current.ownedCount === next.ownedCount &&
      current.era === next.era &&
      current.frontierId === next.frontierId &&
      current.cards.length === next.cards.length
    ) {
      let same = true;
      for (let i = 0; i < next.cards.length; i++) {
        const a = current.cards[i] as TechCard;
        const b = next.cards[i]!;
        if (
          a.id !== b.id ||
          a.status !== b.status ||
          a.milestoneHave !== b.milestoneHave ||
          a.missing.length !== b.missing.length
        ) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }

    this.tech = Object.freeze({
      version: current.version + 1,
      cards: Object.freeze(next.cards.map((card) => Object.freeze({ ...card }))),
      ownedCount: next.ownedCount,
      era: next.era,
      frontierId: next.frontierId,
    });
    return true;
  }

  /**
   * The bench slice: which machine the player is standing at, and what its dials cost.
   *
   * `machineId` flipping to 0 as the player walks away is a real change and must publish —
   * that is how the panel closes itself. The condition readout is compared at whole permille,
   * which is what the bar draws; a machine wearing down republishes about once a second rather
   * than on every tick of work.
   */
  private setBench(next: BenchFields): boolean {
    const current = this.bench;
    if (
      current.machineId === next.machineId &&
      current.researched === next.researched &&
      current.conditionPermille === next.conditionPermille &&
      current.boxable === next.boxable &&
      // The reason is compared as well as the verdict: a jam that gets whacked and immediately
      // starts working again never passes through `boxable === 1`, and without this the panel
      // would keep telling the player to whack a machine that is already turning.
      current.boxBlocked === next.boxBlocked &&
      current.dials.length === next.dials.length
    ) {
      let same = true;
      for (let i = 0; i < next.dials.length; i++) {
        const a = current.dials[i] as BenchDial;
        const b = next.dials[i]!;
        if (a.level !== b.level || a.affordable !== b.affordable || a.costCents !== b.costCents) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }

    this.bench = Object.freeze({
      version: current.version + 1,
      machineId: next.machineId,
      kind: next.kind,
      label: next.label,
      conditionPermille: next.conditionPermille,
      listPriceCents: next.listPriceCents,
      researched: next.researched,
      dials: Object.freeze(next.dials.map((dial) => Object.freeze({ ...dial }))),
      boxable: next.boxable,
      boxBlocked: next.boxBlocked,
    });
    return true;
  }

  /**
   * The lot slice: what is wilting, what that costs, and what the machines are doing.
   *
   * Every number here moves in discrete jumps — a tile changes wilt stage, a lamp changes
   * colour — so this comparison genuinely settles rather than merely narrowing. The one
   * thing that could have made it churn is the alert, which is why the sixty-second arming
   * lives in `RiskWatch` and produces a null-or-stable object rather than a countdown: an
   * alert carrying "58 seconds so far" would rebuild this slice on every publish forever.
   */
  private setLot(next: LotFields): boolean {
    const current = this.lot;
    const alert = next.alert;
    const was = current.alert;

    if (
      current.wilting === next.wilting &&
      current.wilted === next.wilted &&
      current.atRiskCents === next.atRiskCents &&
      current.compost === next.compost &&
      current.machines === next.machines &&
      current.running === next.running &&
      current.halted === next.halted &&
      current.jammed === next.jammed &&
      current.starved === next.starved &&
      current.blocked === next.blocked &&
      current.sprinklers === next.sprinklers &&
      current.zones.length === next.zones.length &&
      (was === null ? alert === null : alert !== null && was.text === alert.text)
    ) {
      let same = true;
      for (let i = 0; i < next.zones.length; i++) {
        const a = current.zones[i] as ZoneRow;
        const b = next.zones[i]!;
        if (
          a.id !== b.id ||
          a.planted !== b.planted ||
          a.mature !== b.mature ||
          a.wilting !== b.wilting ||
          a.wilted !== b.wilted ||
          a.dry !== b.dry ||
          a.tiles !== b.tiles ||
          a.compost !== b.compost
        ) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }

    this.lot = Object.freeze({
      version: current.version + 1,
      zones: Object.freeze(next.zones.map((zone) => Object.freeze({ ...zone }))),
      wilting: next.wilting,
      wilted: next.wilted,
      atRiskCents: next.atRiskCents,
      compost: next.compost,
      alert: alert === null ? null : Object.freeze({ ...alert }),
      machines: next.machines,
      running: next.running,
      halted: next.halted,
      jammed: next.jammed,
      starved: next.starved,
      blocked: next.blocked,
      sprinklers: next.sprinklers,
    });
    return true;
  }

  /**
   * The roadside stand's board.
   *
   * The catalogue itself is static balance data, so what actually moves here is where the
   * player is standing and what is already in the pouch. `atStand` is compared because it is
   * what enables the buttons, and `heading` because it is the sentence that replaces them —
   * both are quantised upstream (`deriveShop`) precisely so that a walking farmer does not
   * rebuild this slice on every publish. Prices are compared too, cheaply: they cannot change
   * inside a world today, and if a save ever restores under re-balanced data the board should
   * redraw rather than keep the old number on screen.
   */
  private setShop(next: ShopFields): boolean {
    const current = this.shop;
    if (
      current.atStand === next.atStand &&
      current.standExists === next.standExists &&
      current.heading === next.heading &&
      current.standTileX === next.standTileX &&
      current.standTileY === next.standTileY &&
      current.rows.length === next.rows.length
    ) {
      let same = true;
      for (let i = 0; i < next.rows.length; i++) {
        const a = current.rows[i] as ShopRow;
        const b = next.rows[i]!;
        if (
          a.id !== b.id ||
          a.owned !== b.owned ||
          a.unitPriceCents !== b.unitPriceCents ||
          a.needsTech !== b.needsTech
        ) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }

    this.shop = Object.freeze({
      version: current.version + 1,
      rows: Object.freeze(next.rows.map((row) => Object.freeze({ ...row }))),
      atStand: next.atStand,
      standExists: next.standExists,
      heading: next.heading,
      standTileX: next.standTileX,
      standTileY: next.standTileY,
    });
    return true;
  }

  /**
   * The bag.
   *
   * WHAT CAN ACTUALLY MOVE IN A BOX IS NOTHING. Dials, condition and invoice are frozen the
   * moment a machine goes in one — a boxed Fryer does not wear, does not run, and cannot be
   * upgraded — so the comparison walks counts and totals rather than six fields per box. The
   * one case that would slip through a length check alone is a box leaving and a different box
   * arriving inside the same 150 ms window, which `scrapCents` catches: two boxes that scrap for
   * the same money and carry the same dial levels draw the same row anyway.
   *
   * The goods half is the opposite: counts move constantly, which is a real change and must
   * publish, because it is the number the panel exists to show.
   */
  private setInventory(next: InventoryFields): boolean {
    const current = this.inventory;
    if (
      current.boxCount === next.boxCount &&
      current.scrapCents === next.scrapCents &&
      current.rows.length === next.rows.length
    ) {
      let same = true;
      for (let i = 0; i < next.rows.length; i++) {
        const a = current.rows[i] as InventoryRow;
        const b = next.rows[i]!;
        if (
          a.id !== b.id ||
          a.count !== b.count ||
          a.boxes.length !== b.boxes.length ||
          a.scrapCents !== b.scrapCents ||
          a.placeTool !== b.placeTool
        ) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }

    this.inventory = Object.freeze({
      version: current.version + 1,
      rows: Object.freeze(
        next.rows.map((row) =>
          Object.freeze({ ...row, boxes: Object.freeze(row.boxes.map((box) => ({ ...box }))) }),
        ),
      ),
      boxCount: next.boxCount,
      scrapCents: next.scrapCents,
    });
    return true;
  }

  private setClipboard(notes: ClipboardNote[]): boolean {
    const current = this.clipboard.notes;
    if (current.length === notes.length) {
      let same = true;
      for (let i = 0; i < notes.length; i++) {
        if (current[i]!.text !== notes[i]!.text) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }
    this.clipboard = Object.freeze({
      version: this.clipboard.version + 1,
      notes: Object.freeze(notes),
    });
    return true;
  }
}

/**
 * The singleton. A module-level store is safe in a way a module-level `GameHost` is not —
 * it holds no GPU resources and no listeners of its own, and the token dance above makes a
 * StrictMode double-mount a non-event.
 */
export const hudStore = new HudStore();
