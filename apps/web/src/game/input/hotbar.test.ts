// The structural gate for the hotbar model ([[061]]).
//
// What fails QUIETLY here, and is therefore worth pinning (AGENTS.md's bar):
//
//   · A TOOL FALLING OFF THE BAR. `clearItem` and `assignItem` both refuse to displace a
//     tool, and a regression in either strands a player without the Hand — no stack trace,
//     just a digit that stopped meaning anything.
//   · A CORRUPT LAYOUT SURFACING. The item promises a silent fallback to the default;
//     a throw here is a black screen at boot for one player and no repro for anybody else.
//   · DUPLICATE SHORTCUTS. An item assigned twice leaves a decoy slot arming a cursor the
//     player thinks is somewhere else.
//   · AN OLD LAYOUT REJECTING A NEW MANDATORY TOOL. The reconciliation step is exactly the
//     seam the next agent's repair-kit/can-refill tools will ride, so it is pinned by name.
//
// Everything under test is pure state plus an injected Storage double. No DOM, no React.

import { describe, expect, it } from 'vitest';
import { ItemId } from '@snack/sim';

import { HOTBAR_SLOTS, HOTBAR_TOOLS, Hotbar, digitToSlotIndex, itemPlaceTool } from './hotbar';
import { ToolMode, toolHeldFrame, toolIconFrame } from './tools';

/** A localStorage stand-in: the three methods the model touches, over a Map. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: () => null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

function bar(storage: Storage = fakeStorage()): Hotbar {
  const hotbar = new Hotbar(() => storage);
  hotbar.bindWorld('w1');
  return hotbar;
}

/** A boxed machine with a build cursor — the canonical assignable item.
 *
 * Was `BoxedComposter` until [[124]] deleted the machine. Any boxed kind with a `ToolMode`
 * does the job; the two only have to be DIFFERENT so the swap and replace cases are real. */
const PLACEABLE = ItemId.BoxedHandCart;
const PLACEABLE_2 = ItemId.BoxedRootCellar;

describe('the default layout', () => {
  it('holds the five hand tools then empties, ten slots in all', () => {
    const b = bar();
    expect(b.slots.length).toBe(HOTBAR_SLOTS);
    HOTBAR_TOOLS.forEach((tool, i) => {
      expect(b.entryAt(i)).toEqual({ kind: 'tool', tool });
    });
    for (let i = HOTBAR_TOOLS.length; i < HOTBAR_SLOTS; i++) {
      expect(b.entryAt(i)).toBeNull();
    }
  });

  it('includes the teardown tool — the one a player must never lose', () => {
    expect(HOTBAR_TOOLS).toContain(ToolMode.Deconstruct);
  });

  it('includes the till tool ([[066]]) — ground you cannot till is a farm that cannot grow', () => {
    expect(HOTBAR_TOOLS).toContain(ToolMode.Till);
  });
});

// Item 065's mapping test: ONE sprite per hand tool, worn by the hotbar slot AND by the
// avatar's hands, from the same table — so the bar cannot show a can while the character
// holds a hoe. What fails quietly without this: a new mandatory tool ships with no frame
// and its slot silently falls to the letter chip forever.
describe('tool icons — one sprite for the slot and the hand ([[065]])', () => {
  it('every mandatory hotbar tool names exactly one atlas frame, uniquely', () => {
    const frames = HOTBAR_TOOLS.map((tool) => toolIconFrame(tool));
    for (const frame of frames) expect(frame).toMatch(/^tool_[a-z_]+$/);
    expect(new Set(frames).size).toBe(frames.length);
  });

  it('the held frame IS the slot frame — except the Hand, whose held state is empty hands', () => {
    for (const tool of HOTBAR_TOOLS) {
      if (tool === ToolMode.Hand) {
        expect(toolHeldFrame(tool)).toBe('');
      } else {
        expect(toolHeldFrame(tool)).toBe(toolIconFrame(tool));
      }
    }
  });

  it('a cursor without hand art says so explicitly rather than borrowing a picture', () => {
    expect(toolIconFrame(ToolMode.PlaceFryer)).toBe('');
    expect(toolHeldFrame(ToolMode.PlaceFryer)).toBe('');
  });
});

describe('digit mapping', () => {
  it('maps 1–9 to the first nine slots and 0 to the tenth', () => {
    expect(digitToSlotIndex(1)).toBe(0);
    expect(digitToSlotIndex(9)).toBe(8);
    expect(digitToSlotIndex(0)).toBe(9);
  });
});

describe('item shortcuts', () => {
  it('resolves a boxed machine to the cursor that places it', () => {
    expect(itemPlaceTool(PLACEABLE)).toBe(ToolMode.PlaceHandCart);
  });

  it('refuses a plain good — a potato has no placement cursor', () => {
    expect(itemPlaceTool(ItemId.RussetPotato)).toBe(-1);
    const b = bar();
    expect(b.assignItem(6, ItemId.RussetPotato)).toBe(false);
    expect(b.entryAt(6)).toBeNull();
  });

  it('assigns to an empty slot and refuses to displace a tool', () => {
    const b = bar();
    expect(b.assignItem(6, PLACEABLE)).toBe(true);
    expect(b.entryAt(6)).toEqual({ kind: 'item', item: PLACEABLE });
    expect(b.assignItem(0, PLACEABLE_2)).toBe(false);
    expect(b.entryAt(0)).toEqual({ kind: 'tool', tool: ToolMode.Hand });
  });

  it('moves rather than duplicates when the same item is assigned twice', () => {
    const b = bar();
    b.assignItem(6, PLACEABLE);
    b.assignItem(8, PLACEABLE);
    expect(b.entryAt(6)).toBeNull();
    expect(b.entryAt(8)).toEqual({ kind: 'item', item: PLACEABLE });
  });

  it('replaces one item shortcut with another on the same slot', () => {
    const b = bar();
    b.assignItem(6, PLACEABLE);
    expect(b.assignItem(6, PLACEABLE_2)).toBe(true);
    expect(b.entryAt(6)).toEqual({ kind: 'item', item: PLACEABLE_2 });
  });
});

describe('rearranging', () => {
  it('swaps two slots, tools included', () => {
    const b = bar();
    expect(b.move(0, 1)).toBe(true);
    expect(b.entryAt(0)).toEqual({ kind: 'tool', tool: ToolMode.Water });
    expect(b.entryAt(1)).toEqual({ kind: 'tool', tool: ToolMode.Hand });
  });

  it('moves a tool into an empty slot without losing it', () => {
    const b = bar();
    expect(b.move(4, 9)).toBe(true);
    expect(b.entryAt(9)).toEqual({ kind: 'tool', tool: ToolMode.Deconstruct });
    expect(b.entryAt(4)).toBeNull();
  });

  it('clears an item shortcut and refuses to clear a tool', () => {
    const b = bar();
    b.assignItem(6, PLACEABLE);
    expect(b.clearItem(6)).toBe(true);
    expect(b.entryAt(6)).toBeNull();
    expect(b.clearItem(0)).toBe(false);
    expect(b.entryAt(0)).toEqual({ kind: 'tool', tool: ToolMode.Hand });
  });
});

describe('persistence', () => {
  it('survives a reload: a second bar over the same storage sees the layout', () => {
    const storage = fakeStorage();
    const first = bar(storage);
    first.assignItem(6, PLACEABLE);
    first.move(0, 9);

    const second = new Hotbar(() => storage);
    second.bindWorld('w1');
    expect(second.entryAt(6)).toEqual({ kind: 'item', item: PLACEABLE });
    expect(second.entryAt(9)).toEqual({ kind: 'tool', tool: ToolMode.Hand });
    expect(second.entryAt(0)).toBeNull();
  });

  it('keeps worlds apart: another world id gets the default', () => {
    const storage = fakeStorage();
    bar(storage).assignItem(6, PLACEABLE);
    const other = new Hotbar(() => storage);
    other.bindWorld('w2');
    expect(other.entryAt(6)).toBeNull();
  });

  it('falls back to the default on corrupt JSON, silently', () => {
    const storage = fakeStorage();
    storage.setItem('snack:hotbar:w1', '{not json');
    const b = new Hotbar(() => storage);
    expect(() => b.bindWorld('w1')).not.toThrow();
    expect(b.entryAt(0)).toEqual({ kind: 'tool', tool: ToolMode.Hand });
  });

  it('falls back on a structurally wrong layout (missing slots, junk entries)', () => {
    const storage = fakeStorage();
    storage.setItem('snack:hotbar:w1', JSON.stringify({ v: 1, slots: [null, null] }));
    const short = new Hotbar(() => storage);
    short.bindWorld('w1');
    expect(short.entryAt(0)).toEqual({ kind: 'tool', tool: ToolMode.Hand });

    storage.setItem(
      'snack:hotbar:w1',
      JSON.stringify({ v: 1, slots: Array.from({ length: 10 }, () => ({ t: 9999 })) }),
    );
    const junk = new Hotbar(() => storage);
    junk.bindWorld('w1');
    expect(junk.entryAt(0)).toEqual({ kind: 'tool', tool: ToolMode.Hand });
  });

  it('repairs an old layout missing a newly-mandatory tool instead of resetting it', () => {
    const storage = fakeStorage();
    // A stored bar with the teardown tool absent and an item shortcut placed — as if saved
    // by a build from before Teardown joined `HOTBAR_TOOLS`.
    storage.setItem(
      'snack:hotbar:w1',
      JSON.stringify({
        v: 1,
        slots: [
          { t: ToolMode.Hand },
          { t: ToolMode.Water },
          { t: ToolMode.Plant },
          { t: ToolMode.Harvest },
          { i: PLACEABLE },
          null,
          null,
          null,
          null,
          null,
        ],
      }),
    );
    const b = new Hotbar(() => storage);
    b.bindWorld('w1');
    // The shortcut survives; the missing tool landed in the first empty slot.
    expect(b.entryAt(4)).toEqual({ kind: 'item', item: PLACEABLE });
    expect(b.entryAt(5)).toEqual({ kind: 'tool', tool: ToolMode.Deconstruct });
  });

  it('persists nothing without a world id and still works in memory', () => {
    const storage = fakeStorage();
    const b = new Hotbar(() => storage);
    b.bindWorld(null);
    expect(b.assignItem(6, PLACEABLE)).toBe(true);
    expect(storage.length).toBe(0);
  });
});

describe('the repair kit rides the item-shortcut seam ([[009]] tool wiring)', () => {
  it('resolves to its own cursor — a use, not a placement', () => {
    expect(itemPlaceTool(ItemId.RepairKit)).toBe(ToolMode.UseRepairKit);
  });

  it('is assignable to a slot exactly like a boxed machine', () => {
    const b = bar();
    expect(b.assignItem(6, ItemId.RepairKit)).toBe(true);
    expect(b.entryAt(6)).toEqual({ kind: 'item', item: ItemId.RepairKit });
  });

  it('survives a reload like any other shortcut', () => {
    const storage = fakeStorage();
    const first = new Hotbar(() => storage);
    first.bindWorld('w1');
    first.assignItem(7, ItemId.RepairKit);

    const second = new Hotbar(() => storage);
    second.bindWorld('w1');
    expect(second.entryAt(7)).toEqual({ kind: 'item', item: ItemId.RepairKit });
  });
});
