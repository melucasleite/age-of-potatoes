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

import type { WorldView } from '@snack/sim';

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
import { RateMeter } from './rate';
import type {
  ClipboardNote,
  ClipboardSlice,
  EconomySlice,
  HudLive,
  HudSnapshot,
  PouchItem,
  PouchSlice,
  SliceName,
  ToolSlice,
  ToolSlot,
  UnlockSlice,
} from './types';
import {
  ZERO_CLIPBOARD,
  ZERO_ECONOMY,
  ZERO_POUCH,
  ZERO_SNAPSHOT,
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
  private snapshot: HudSnapshot = ZERO_SNAPSHOT;

  private owner: object | null = null;
  private selector: ((tool: ToolMode) => void) | null = null;

  private readonly meter = new RateMeter();
  private readonly counts: MachineCounts = createMachineCounts();
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
  };

  getSnapshot(): HudSnapshot {
    return this.snapshot;
  }

  // --- ownership ---------------------------------------------------------------------

  /** Called by a starting `GameHost`. Wipes whatever the previous host left behind. */
  claim(token: object, selectTool: (tool: ToolMode) => void): void {
    this.owner = token;
    this.selector = selectTool;
    this.meter.reset();
    this.clipboardDueTick = -(2 ** 30);
    this.live.tick = 0;
    this.live.moneyCents = 0;
    this.live.clock = '';
    this.live.status = '';
    this.resetSlices();
  }

  /** Called by a disposing `GameHost`. A stale host calling this is ignored, by design. */
  release(token: object): void {
    if (this.owner !== token) return;
    this.owner = null;
    this.selector = null;
    this.resetSlices();
  }

  private resetSlices(): void {
    this.economy = ZERO_ECONOMY;
    this.unlock = ZERO_UNLOCK;
    this.pouch = ZERO_POUCH;
    this.tools = ZERO_TOOLS;
    this.clipboard = ZERO_CLIPBOARD;
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
    if (this.setTools(view.moneyCents, tool)) changed = true;

    if (view.tick >= this.clipboardDueTick) {
      this.clipboardDueTick = view.tick + CLIPBOARD_PERIOD_TICKS;
      if (this.setClipboard(deriveClipboard(view, this.counts))) changed = true;
    }

    // The live channel is updated unconditionally and notifies nobody. That is the point
    // of it: a counter animating at 60 fps must not cost a React render at 60 fps.
    this.live.tick = view.tick;
    this.live.moneyCents = view.moneyCents;

    if (!changed) return;
    this.snapshot = {
      economy: this.economy,
      unlock: this.unlock,
      pouch: this.pouch,
      tools: this.tools,
      clipboard: this.clipboard,
    };
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
    this.snapshot = {
      economy: this.economy,
      unlock: this.unlock,
      pouch: this.pouch,
      tools: this.tools,
      clipboard: this.clipboard,
    };
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

  private setTools(moneyCents: number, tool: ToolMode): boolean {
    const slots = deriveTools(moneyCents, tool);
    const current = this.tools.slots;
    if (current.length === slots.length) {
      let same = true;
      for (let i = 0; i < slots.length; i++) {
        const a = current[i] as ToolSlot;
        const b = slots[i]!;
        if (a.active !== b.active || a.affordable !== b.affordable) {
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
