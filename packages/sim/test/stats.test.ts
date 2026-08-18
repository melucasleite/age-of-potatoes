// The receipt ledgers of item 062: per-item sales and dawn-aligned hour buckets.
//
// The property under test is the one `apps/web/src/reports/shift.ts` documents for its
// display-side ledger: buckets are DIFFERENCES OF MONOTONE ACCUMULATORS, so they telescope —
// however the boundaries land, the buckets sum to the lifetime totals exactly. Here that
// property lives in the sim, hashed and saved, which is the whole point of the item.

import { describe, expect, it } from 'vitest';

import {
  type Command,
  type WorldState,
  CropId,
  DAWN_TICK_IN_DAY,
  HOUR_HISTORY_LIMIT,
  IntentAction,
  ItemId,
  TICKS_PER_ACTIVE_HOUR,
  advanceStatsClock,
  createWorld,
  hashState,
  hourIndexAt,
  recordSale,
  serialize,
  step,
  stepMany,
  view,
  createWorldView,
} from '../src/index';
import { restoreWorld } from '../src/save/index';

function run(state: WorldState, commands: Command[]): void {
  step(state, { tick: state.tick, commands });
}

/** Walk-to errand, awaited. The gardener loop as the sim plays it. */
function errand(
  state: WorldState,
  action: IntentAction,
  x: number,
  y: number,
  item = 0,
  count = 0,
): void {
  run(state, [{ type: 'WalkAndAct', action, tileX: x, tileY: y, item, count }]);
  let guard = 0;
  while (state.player.intent !== null && guard < 4_000) {
    run(state, []);
    guard += 1;
  }
}

describe('salesByItem', () => {
  it('accumulates at the sale, is hashed, and survives save/load', () => {
    const state = createWorld(62_001);
    errand(state, IntentAction.Plant, 4, 4, CropId.RussetPotato);
    errand(state, IntentAction.Water, 4, 4);
    let guard = 0;
    while (state.stats.itemsHarvestedByHand === 0 && guard < 4_000) {
      errand(state, IntentAction.Harvest, 4, 4);
      run(state, []);
      guard += 1;
    }
    const carried = state.inventory.find((slot) => slot.item === ItemId.RussetPotato)!.count;
    errand(state, IntentAction.Sell, 2, 12, ItemId.RussetPotato, carried);

    const row = state.stats.salesByItem.find((r) => r.item === ItemId.RussetPotato)!;
    expect(row.units).toBe(carried);
    expect(row.cents).toBe(state.stats.lifetimeEarnedCents);
    expect(row.cents).toBeGreaterThan(0);

    // Hashed: two worlds that differ only in the ledger digest differently.
    const before = hashState(state);
    state.stats.salesByItem[0]!.units += 1;
    expect(hashState(state)).not.toBe(before);
    state.stats.salesByItem[0]!.units -= 1;
    expect(hashState(state)).toBe(before);

    // And it survives the round trip byte-for-byte.
    const restored = restoreWorld(serialize(state));
    expect(hashState(restored.state)).toBe(before);
    expect(restored.state.stats.salesByItem).toEqual(state.stats.salesByItem);
  });

  it('keeps rows sparse and sorted regardless of sale order', () => {
    const a = createWorld(62_002);
    const b = createWorld(62_002);
    recordSale(a.stats, ItemId.BaggedChips, 2, 4_000);
    recordSale(a.stats, ItemId.RussetPotato, 1, 200);
    recordSale(b.stats, ItemId.RussetPotato, 1, 200);
    recordSale(b.stats, ItemId.BaggedChips, 2, 4_000);
    expect(a.stats.salesByItem).toEqual(b.stats.salesByItem);
    expect(a.stats.salesByItem.map((r) => r.item)).toEqual(
      [...a.stats.salesByItem.map((r) => r.item)].sort((x, y) => x - y),
    );
    expect(hashState(a)).toBe(hashState(b));
  });

  it('snapshots at dawn, so "today" telescopes to zero the moment the day turns', () => {
    const state = createWorld(62_003);
    recordSale(state.stats, ItemId.RussetPotato, 3, 600);
    stepMany(state, DAWN_TICK_IN_DAY + 1 - state.tick);
    const row = state.stats.salesByItem[0]!;
    expect(state.stats.dawnsSeen).toBe(1);
    expect(row.unitsAtDawn).toBe(row.units);
    expect(row.centsAtDawn).toBe(row.cents);

    // The projection's dayCount is the subtraction, done once, in the view.
    recordSale(state.stats, ItemId.RussetPotato, 2, 400);
    const projected = view(state, createWorldView());
    const sale = projected.stats.salesByItem.find((r) => r.item === ItemId.RussetPotato)!;
    expect(sale.count).toBe(5);
    expect(sale.dayCount).toBe(2);
    expect(sale.dayGrossCents).toBe(400);
  });
});

describe('the hour ledger', () => {
  it('telescopes: closed buckets plus the open hour equal the lifetime totals exactly', () => {
    const state = createWorld(62_004);
    // Earnings on a cadence that never lands on a boundary — the case a counting ledger
    // gets wrong and a telescoping one cannot.
    const horizon = DAWN_TICK_IN_DAY + TICKS_PER_ACTIVE_HOUR * 2 + 137;
    while (state.tick < horizon) {
      if (state.tick % 701 === 0) recordSale(state.stats, ItemId.RussetPotato, 1, 137);
      stepMany(state, 1);
    }
    expect(state.stats.hours.length).toBe(3); // the short birth hour, then two full ones

    let gross = 0;
    let ticks = 0;
    for (const bucket of state.stats.hours) {
      gross += bucket.grossCents;
      ticks += bucket.ticks;
    }
    gross += state.stats.lifetimeEarnedCents - state.stats.hourMark.earnedCents;
    ticks += state.tick - state.stats.hourMark.tick;
    expect(gross).toBe(state.stats.lifetimeEarnedCents);
    expect(ticks).toBe(state.tick);
  });

  it('aligns the grid to dawn: hour 0 is short, every later hour is full', () => {
    expect(hourIndexAt(0)).toBe(0);
    expect(hourIndexAt(DAWN_TICK_IN_DAY - 1)).toBe(0);
    expect(hourIndexAt(DAWN_TICK_IN_DAY)).toBe(1);
    expect(hourIndexAt(DAWN_TICK_IN_DAY + TICKS_PER_ACTIVE_HOUR - 1)).toBe(1);
    expect(hourIndexAt(DAWN_TICK_IN_DAY + TICKS_PER_ACTIVE_HOUR)).toBe(2);

    const state = createWorld(62_005);
    stepMany(state, DAWN_TICK_IN_DAY + TICKS_PER_ACTIVE_HOUR + 5);
    expect(state.stats.hours[0]!.ticks).toBe(DAWN_TICK_IN_DAY);
    expect(state.stats.hours[1]!.ticks).toBe(TICKS_PER_ACTIVE_HOUR);
  });

  it('projects closed hours plus the open one, in the shape the Shift Report adopts', () => {
    const state = createWorld(62_006);
    stepMany(state, DAWN_TICK_IN_DAY + 50);
    recordSale(state.stats, ItemId.RussetPotato, 1, 200);
    stepMany(state, 10);

    const projected = view(state, createWorldView());
    const hours = projected.stats.hours;
    expect(hours.length).toBe(2);
    // The closed birth hour is a full bucket by its own width; the LAST entry is the hour in
    // progress, which the adopt branch recognises by ticks < TICKS_PER_ACTIVE_HOUR.
    expect(hours[0]!.ticks).toBe(DAWN_TICK_IN_DAY);
    expect(hours[1]!.ticks).toBe(state.tick - DAWN_TICK_IN_DAY);
    expect(hours[1]!.grossCents).toBe(200);
  });

  it('caps retained hours like the Shift Report strip does', () => {
    const state = createWorld(62_007);
    const stats = state.stats;
    // Fabricate a long life cheaply: hand `advanceStatsClock` one boundary crossing per
    // call, rather than stepping two million real ticks. The cap under test is the real one.
    for (let i = 0; i < HOUR_HISTORY_LIMIT + 5; i++) {
      stats.hourMark.hour = i;
      stats.hourMark.tick = i === 0 ? 0 : DAWN_TICK_IN_DAY + TICKS_PER_ACTIVE_HOUR * (i - 1);
      advanceStatsClock(stats, DAWN_TICK_IN_DAY + TICKS_PER_ACTIVE_HOUR * i);
    }
    expect(stats.hours.length).toBe(HOUR_HISTORY_LIMIT);
    expect(stats.hours[0]!.hour).toBe(5);
    expect(stats.hours[stats.hours.length - 1]!.hour).toBe(HOUR_HISTORY_LIMIT + 4);
  });
});
