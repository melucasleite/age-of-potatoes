// The hotbar: ten assignable slots, bound to digits 1–9 and 0.
//
// This is UI STATE, exactly as tool mode is (§12, `tools.ts`): never a `Command`, never in
// the trace, never in `WorldState`, `SavePayload`, or `hashState()`. The layout persists in
// localStorage keyed by world id — the same side of the line as camera position — and a
// replay must not depend on it.
//
// WHAT A SLOT HOLDS. One of three things:
//
//   a TOOL   — one of the six hand verbs (Hand, Water, Plant, Harvest, Teardown, Till). They are
//              on the bar by default, can be rearranged, and can NEVER be removed: a player
//              must not be able to strand themselves without the Hand or the teardown tool.
//   an ITEM  — a shortcut to a bagged item that has a placement cursor. Pressing its digit
//              arms the same build tool the bag's Place button arms, from-the-bag pricing
//              included. Assigned by dragging out of the inventory grid; removable by
//              dragging off the bar.
//   nothing  — an empty slot, waiting.
//
// HOW TO ADD A NEW DEFAULT TOOL (repair kit, can refill, junction placement, …): add its
// `ToolMode` to `HOTBAR_TOOLS` below. That is the whole change — the reconciliation step in
// `sanitize()` inserts a newly-required tool into stored layouts from earlier builds, so a
// player who saved a layout before the tool existed gets it in their first free slot rather
// than a reset bar. Item shortcuts need no registration at all: anything
// `itemPlaceTool()` can resolve is assignable the moment it can be boxed.
//
// WHY A MODULE SINGLETON. The keyboard (digit → slot) and the HUD (rendering, drag and
// drop) read the same layout, and neither owns the other. The pattern is `lod.ts`'s: the
// input layer holds the state, the HUD mutates it through the exported object and then asks
// the store to republish (`hudStore.refreshTools()`), because the store — not this file —
// owns notifying React.

import type { MachineKind } from '@snack/sim';
import { ItemId, machineKindForBoxedItem } from '@snack/sim';

import { ToolMode, toolForMachineKind } from './tools';

export const HOTBAR_SLOTS = 10;

/**
 * The six hand tools, in bar order, all mandatory. `Deconstruct` is the teardown tool
 * ([[060]]) — one cursor for every removal in the game, and the one a player must never be
 * able to lose. `Till` ([[066]]) makes farmland and unmakes it, and joins for the same
 * reason: ground you can no longer till is a farm that can no longer grow.
 */
export const HOTBAR_TOOLS: readonly ToolMode[] = [
  ToolMode.Hand,
  ToolMode.Water,
  ToolMode.Plant,
  ToolMode.Harvest,
  ToolMode.Deconstruct,
  ToolMode.Till,
];

export type HotbarEntry =
  | { readonly kind: 'tool'; readonly tool: ToolMode }
  | { readonly kind: 'item'; readonly item: number };

/** One slot: a tool, an item shortcut, or nothing. */
export type HotbarSlot = HotbarEntry | null;

/**
 * The build cursor an item shortcut arms, or -1 when the item has none.
 *
 * Resolved at read time, never stored: a persisted `ToolMode` number would go stale the day
 * the enum is renumbered, but an `ItemId` names a thing in the world. The chain is the same
 * one the bag's Place button walks — item → boxed machine kind → placement tool — asked of
 * the sim's own table and `toolForMachineKind`, so the two surfaces cannot disagree about
 * which cursor a boxed Fryer arms.
 */
export function itemPlaceTool(item: number): ToolMode | -1 {
  // The usable consumable ([[009]]/tool-wiring): a repair kit is not a boxed machine, so the
  // table below has never heard of it, but it IS a thing a digit can hold — its cursor spends
  // the item on a spot instead of placing anything. Special-cased here rather than grown into a
  // second table because this is the resolver both the bag's drag and the digit keys already
  // ask; one branch makes a consumable assignable everywhere at once.
  //
  // There were TWO of these until [[124]]. A bag of fertilizer resolved to
  // `ToolMode.ApplyFertilizer` on the same line, and `ItemId.Fertilizer` no longer exists.
  if (item === ItemId.RepairKit) return ToolMode.UseRepairKit;
  const kind: MachineKind | null = machineKindForBoxedItem(item as ItemId);
  if (kind === null) return -1;
  return toolForMachineKind(kind) ?? -1;
}

/** Digit key (1–9, 0) → slot index (0–9). The 0 key is the tenth slot, genre convention. */
export function digitToSlotIndex(digit: number): number {
  return digit === 0 ? HOTBAR_SLOTS - 1 : digit - 1;
}

/** Slot index (0–9) → the digit printed on it (1–9, 0). */
export function slotIndexToDigit(index: number): number {
  return index === HOTBAR_SLOTS - 1 ? 0 : index + 1;
}

function defaultSlots(): HotbarSlot[] {
  const slots: HotbarSlot[] = [];
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const tool = HOTBAR_TOOLS[i];
    slots.push(tool === undefined ? null : { kind: 'tool', tool });
  }
  return slots;
}

// --- persistence -----------------------------------------------------------------------

/** Bump only for a shape change. Unknown versions fall back to the default, silently. */
const LAYOUT_VERSION = 1;

interface StoredLayout {
  readonly v: number;
  /** Per slot: `{ t: ToolMode }`, `{ i: ItemId }`, or null. */
  readonly slots: readonly ({ t?: number; i?: number } | null)[];
}

function storageKeyFor(worldId: string): string {
  return `snack:hotbar:${worldId}`;
}

const VALID_TOOLS: ReadonlySet<number> = new Set(Object.values(ToolMode));

/**
 * Turn whatever came out of storage into a legal layout, or null when it is beyond repair.
 *
 * Legal means: ten slots; every mandatory tool present exactly once; no tool the build does
 * not know; no duplicate entries. A stored layout from an older build that is merely MISSING
 * a newly-mandatory tool is repaired rather than rejected — the tool goes into the first
 * empty slot, or evicts the last item shortcut when the bar is full. Anything structurally
 * wrong returns null and the caller falls back to the default without a word to the player:
 * a corrupt layout is not the player's problem to debug.
 */
function sanitize(raw: unknown): HotbarSlot[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const stored = raw as StoredLayout;
  if (stored.v !== LAYOUT_VERSION) return null;
  if (!Array.isArray(stored.slots) || stored.slots.length !== HOTBAR_SLOTS) return null;

  const slots: HotbarSlot[] = [];
  const seenTools = new Set<number>();
  const seenItems = new Set<number>();

  for (const cell of stored.slots) {
    if (cell === null) {
      slots.push(null);
      continue;
    }
    if (typeof cell !== 'object') return null;
    const { t, i } = cell as { t?: unknown; i?: unknown };
    if (typeof t === 'number') {
      // A tool the build does not know, or the same tool twice, is a broken layout — but a
      // tool that is merely NOT mandatory any more degrades to an empty slot, not a reset.
      if (!VALID_TOOLS.has(t) || seenTools.has(t)) return null;
      seenTools.add(t);
      slots.push({ kind: 'tool', tool: t as ToolMode });
      continue;
    }
    if (typeof i === 'number' && Number.isInteger(i) && i > 0) {
      if (seenItems.has(i)) return null;
      seenItems.add(i);
      slots.push({ kind: 'item', item: i });
      continue;
    }
    return null;
  }

  // The reconciliation step the header promises: mandatory tools missing from an older
  // layout are inserted rather than the layout being thrown away.
  for (const tool of HOTBAR_TOOLS) {
    if (seenTools.has(tool)) continue;
    let placed = false;
    for (let s = 0; s < slots.length && !placed; s++) {
      if (slots[s] === null) {
        slots[s] = { kind: 'tool', tool };
        placed = true;
      }
    }
    for (let s = slots.length - 1; s >= 0 && !placed; s--) {
      if (slots[s]?.kind === 'item') {
        slots[s] = { kind: 'tool', tool };
        placed = true;
      }
    }
    // Ten slots, six mandatory tools: unplaceable means the layout was full of tools that
    // should not all exist. Beyond repair.
    if (!placed) return null;
  }

  return slots;
}

function encode(slots: readonly HotbarSlot[]): string {
  const out: StoredLayout = {
    v: LAYOUT_VERSION,
    slots: slots.map((slot) => {
      if (slot === null) return null;
      return slot.kind === 'tool' ? { t: slot.tool } : { i: slot.item };
    }),
  };
  return JSON.stringify(out);
}

// --- the model -------------------------------------------------------------------------

/**
 * The bar itself. Construct one for a test; the app uses the `hotbar` singleton below.
 *
 * EVERY MUTATOR RETURNS WHETHER IT DID ANYTHING, because the HUD's refusal flash and its
 * republish both hang off the answer. Every successful mutation persists immediately —
 * "survives a reload" must not depend on a graceful shutdown.
 */
export class Hotbar {
  private slots_: HotbarSlot[] = defaultSlots();
  private worldKey: string | null = null;
  /** Bumped on every layout change. The HUD store compares it to skip rebuilds. */
  private version_ = 0;

  constructor(private readonly storage: () => Storage | null = defaultStorage) {}

  get version(): number {
    return this.version_;
  }

  /** The layout, live. Read-only to callers; mutate through the verbs below. */
  get slots(): readonly HotbarSlot[] {
    return this.slots_;
  }

  entryAt(index: number): HotbarSlot {
    return this.slots_[index] ?? null;
  }

  /**
   * Adopt a world's saved layout, or the default when there is none, it is corrupt, or the
   * id is null (screens like `?artsheet` that boot without an active world — they get the
   * default and persist nothing). Called once per mount, after `activeWorldId()` resolves.
   */
  bindWorld(worldId: string | null): void {
    this.worldKey = worldId === null ? null : storageKeyFor(worldId);
    let next: HotbarSlot[] | null = null;
    if (this.worldKey !== null) {
      try {
        const raw = this.storage()?.getItem(this.worldKey) ?? null;
        if (raw !== null) next = sanitize(JSON.parse(raw));
      } catch {
        next = null; // Corrupt JSON, blocked storage: the silent fallback the item asks for.
      }
    }
    this.slots_ = next ?? defaultSlots();
    this.version_ += 1;
  }

  /**
   * Assign an item shortcut. Refuses — visibly, the caller flashes the slot — when the item
   * has no placement cursor or the target slot holds a tool (tools are not displaceable by
   * a drop; rearrange them instead). An item already on the bar MOVES rather than
   * duplicating: two slots arming the same cursor would be one slot and a decoy.
   */
  assignItem(index: number, item: number): boolean {
    if (index < 0 || index >= HOTBAR_SLOTS) return false;
    if (itemPlaceTool(item) === -1) return false;
    const target = this.slots_[index] ?? null;
    if (target?.kind === 'tool') return false;
    for (let s = 0; s < this.slots_.length; s++) {
      const slot = this.slots_[s];
      if (s !== index && slot?.kind === 'item' && slot.item === item) this.slots_[s] = null;
    }
    this.slots_[index] = { kind: 'item', item };
    this.commit();
    return true;
  }

  /** Swap two slots. Tools included — this is how they rearrange without ever leaving. */
  move(from: number, to: number): boolean {
    if (from === to) return false;
    if (from < 0 || from >= HOTBAR_SLOTS || to < 0 || to >= HOTBAR_SLOTS) return false;
    const a = this.slots_[from] ?? null;
    const b = this.slots_[to] ?? null;
    if (a === null && b === null) return false;
    this.slots_[from] = b;
    this.slots_[to] = a;
    this.commit();
    return true;
  }

  /** Clear an item shortcut (drag-off). A tool refuses: the bar never loses a hand verb. */
  clearItem(index: number): boolean {
    const entry = this.slots_[index] ?? null;
    if (entry?.kind !== 'item') return false;
    this.slots_[index] = null;
    this.commit();
    return true;
  }

  private commit(): void {
    this.version_ += 1;
    if (this.worldKey === null) return;
    try {
      this.storage()?.setItem(this.worldKey, encode(this.slots_));
    } catch {
      // Quota, private browsing: the session keeps its layout; the next one starts default.
    }
  }
}

function defaultStorage(): Storage | null {
  // Guarded for SSR: this module is imported by the HUD, whose components do render on the
  // server. Nothing touches storage until `bindWorld`, which only runs in an effect.
  return typeof window === 'undefined' ? null : window.localStorage;
}

/** The singleton the keyboard and the HUD share. Tests construct their own `Hotbar`. */
export const hotbar = new Hotbar();
