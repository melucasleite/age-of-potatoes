// **WHAT THE DAWN REPORT THINKS ONE OPERATION IS WORTH** (item 113).
//
// `IdleWatch` prices idle time at the machine's realised rate, and the multiplicand in that
// sum is the value one completed operation adds. Until item 111 every machine made exactly one
// thing, so `spec.outputItem` less `spec.inputs` was that number and could not be anything
// else. Since [[145]] cut the flavour tier, the Washer is the one machine left with a choice
// — potatoes or used bottles — and the recipe-aware reading is pinned on it.
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
  it('values a Washer on the bottle line at the bottle line’s margin', () => {
    // The recipe-aware read, on the one machine that still chooses: a Washer whose basket
    // holds clean bottles must be priced at the bottle margin, not the potato one.
    const expected = listPriceCents(ItemId.Bottle) - listPriceCents(ItemId.UsedBottle);

    expect(costOfIdling(MachineKind.Washer, ItemId.Bottle)).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it('values a Washer on potatoes at the potato margin', () => {
    const expected = listPriceCents(ItemId.WashedPotato) - listPriceCents(ItemId.RussetPotato);

    expect(costOfIdling(MachineKind.Washer, ItemId.WashedPotato)).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it('leaves the Bagger where it already was, on its one line', () => {
    // The control: a single-recipe machine reads the same off either arithmetic.
    const flat = listPriceCents(ItemId.BaggedChips) - listPriceCents(ItemId.SeasonedChips);

    expect(costOfIdling(MachineKind.Bagger, ItemId.BaggedChips)).toBe(flat);
  });

  it('values an empty machine at what it is for', () => {
    // A basket with nothing in it publishes the spec's product, so an idle Fryer is still
    // priced at the chip it exists to make rather than at zero.
    const expected = listPriceCents(ItemId.PlainChips) - listPriceCents(ItemId.PotatoSlices);

    expect(costOfIdling(MachineKind.Fryer, ItemId.PlainChips)).toBe(expected);
    expect(costOfIdling(MachineKind.Fryer, 0)).toBe(expected);
  });
});
