// **WHAT THE DAWN REPORT THINKS ONE OPERATION IS WORTH** (item 113).
//
// `IdleWatch` prices idle time at the machine's realised rate, and the multiplicand in that
// sum is the value one completed operation adds. Until item 111 every machine made exactly one
// thing, so `spec.outputItem` less `spec.inputs` was that number and could not be anything
// else. Five machines now choose a recipe, and on two of them the old reading is wrong by the
// whole premium the flavoured lines exist to earn — a Seasoner running chili, and a Washer
// running gold potatoes, which is the one nobody filed.
//
// The arithmetic is pinned in cents against the price table rather than against a magic
// number, so re-balancing an item moves the expectation with it and a REGRESSION still fails.
//
// The idle sum is `valueAddedPerOp * ops * idleTicks / runTicks`. Every case below runs one
// operation, then runs for exactly as long as it later idles — so the flag's cents ARE the
// per-operation value, and nothing here has to reason about the rate.

import { describe, expect, it } from 'vitest';

import { ItemId, LampState, MachineKind, listPriceCents } from '@snack/sim';
import type { MachineView, WorldView } from '@snack/sim';

import { BLEED_THRESHOLD_TICKS, IdleWatch } from './idle';

/** The five fields `IdleWatch` reads, and nothing else. */
function machine(kind: MachineKind, lamp: number, progressPermille: number, outputItem: number) {
  return { id: 1, kind, lamp, progressPermille, outputItem } as unknown as MachineView;
}

function viewAt(tick: number, m: MachineView): WorldView {
  return { tick, machines: [m] } as unknown as WorldView;
}

/**
 * One operation, then an equal stretch of running and of idling — which makes the reported
 * cost exactly one operation's value added.
 */
function costOfIdling(kind: MachineKind, outputItem: number): number {
  const watch = new IdleWatch();
  const span = BLEED_THRESHOLD_TICKS;

  watch.observe(viewAt(0, machine(kind, LampState.Running, 900, outputItem)));
  // Progress falling is how a completed operation is counted.
  watch.observe(viewAt(span, machine(kind, LampState.Running, 100, outputItem)));
  watch.observe(viewAt(span * 2, machine(kind, LampState.Starved, 100, outputItem)));

  const flag = watch.worst();
  expect(flag).not.toBeNull();
  return flag!.costCents;
}

describe('what one operation is worth to the Dawn Report', () => {
  it('values a Seasoner on the chili line at the chili line’s margin', () => {
    // 1850 out, 900 + 300 in. Reported as 500 before this — the plain recipe's margin, on a
    // machine that had not made a plain chip in an hour.
    const expected =
      listPriceCents(ItemId.ChiliChips) -
      listPriceCents(ItemId.PlainChips) -
      listPriceCents(ItemId.ChiliPepper);

    expect(costOfIdling(MachineKind.Seasoner, ItemId.ChiliChips)).toBe(expected);
    expect(expected).toBe(650);
  });

  it('values a Seasoner on the sweetcorn line the same way', () => {
    const expected =
      listPriceCents(ItemId.SweetcornChips) -
      listPriceCents(ItemId.PlainChips) -
      listPriceCents(ItemId.Corn);

    expect(costOfIdling(MachineKind.Seasoner, ItemId.SweetcornChips)).toBe(expected);
    expect(expected).toBe(610);
  });

  it('values a Washer on gold potatoes at three times the russet figure', () => {
    // THE MACHINE THE ORIGINAL REPORT MISSED. Item 113 was filed about the Seasoner; the same
    // misreading was sitting on the Washer, where the premium is a factor of three.
    const gold = listPriceCents(ItemId.WashedGoldPotato) - listPriceCents(ItemId.GoldPotato);
    const russet = listPriceCents(ItemId.WashedPotato) - listPriceCents(ItemId.RussetPotato);

    expect(costOfIdling(MachineKind.Washer, ItemId.WashedGoldPotato)).toBe(gold);
    expect(gold).toBe(russet * 3);
  });

  it('leaves the Bagger where it already was, on every line it can run', () => {
    // The control, and the reason the bug was easy to miss: the Bagger's premium shifts input
    // and output by the same cents, so it read correctly off the old arithmetic and still does.
    const flat = listPriceCents(ItemId.BaggedChips) - listPriceCents(ItemId.SeasonedChips);

    for (const bag of [
      ItemId.BaggedChips,
      ItemId.BaggedChiliChips,
      ItemId.BaggedSweetcornChips,
      ItemId.BaggedGoldChips,
    ]) {
      expect(costOfIdling(MachineKind.Bagger, bag)).toBe(flat);
    }
  });

  it('values an empty machine at what it is for', () => {
    // A basket with nothing in it publishes the spec's product, so an idle Fryer is still
    // priced at the chip it exists to make rather than at zero.
    const expected = listPriceCents(ItemId.PlainChips) - listPriceCents(ItemId.PotatoSlices);

    expect(costOfIdling(MachineKind.Fryer, ItemId.PlainChips)).toBe(expected);
    expect(costOfIdling(MachineKind.Fryer, 0)).toBe(expected);
  });
});
