// **WHAT A STOPPED MACHINE SAYS ABOUT ITSELF** (item 113), and it is one file because the two
// halves item 111's verifier found are one state seen twice.
//
// The state (updated for item 145, which cut the Seasoner's flavour recipes and left the
// Washer as the game's one multi-recipe machine): a Washer whose basket holds a single clean
// bottle, twelve russet potatoes in hopper zero, and no empties left. Item 111's own header
// promised the fallback recipe runs; without the fix, `runnableRecipe` returns null, the lamp
// goes AMBER — the game's grammar for "look upstream" — and the sentence under the cursor
// reads "washer wants potatoes" while twelve potatoes sit in the hopper.
//
// Both defects have the same root and it is NOT the recipe table: the basket holds one product
// at a time, so the plain recipe is skipped for its label rather than for any missing
// ingredient. That makes this a DOWNSTREAM problem wearing an upstream lamp. Everything below
// pins the corrected reading — a red lamp, a sentence about the basket, and a `wantsItem` that
// only ever names something the machine is genuinely short of.
//
// The tell is checked on every machine in the roster, not just the Washer, because
// `MachineView.inputItem` was one field answering a question that grew several answers the day
// item 111 shipped, and the (since-cut) Seasoner is merely where it was noticed first.

import { describe, expect, it } from 'vitest';

import {
  ItemId,
  LampState,
  MACHINE_SPECS,
  MachineKind,
  createWorld,
  createWorldView,
  hopperIndexFor,
  machineHoppers,
  machineRecipes,
  machineSpec,
  runnableRecipe,
  spawnMachine,
  stepMany,
  takeOneOutput,
  view,
} from '../src/index';
import type { Machine, MachineSpec, WorldState } from '../src/index';

/** The hopper a named ingredient lives in, asserted rather than assumed. */
function hopper(kind: MachineKind, item: ItemId): number {
  const index = hopperIndexFor(machineSpec(kind)!, item);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

/** The one machine's view, projected fresh. */
function machineView(state: WorldState, machine: Machine) {
  const projected = view(state, createWorldView()).machines.find((m) => m.id === machine.id);
  expect(projected).toBeDefined();
  return projected!;
}

/**
 * The shape item 111's verifier measured, on the machine that still has it: one clean bottle
 * in the basket, twelve potatoes in the hopper, the empties gone.
 */
function strandedSeasoner(seed: number): { state: WorldState; seasoner: Machine } {
  const state = createWorld(seed);
  const seasoner = spawnMachine(state, MachineKind.Washer, 0, 0)!;
  seasoner.outputCount = 1;
  seasoner.outputItem = ItemId.Bottle;
  seasoner.inputCounts[hopper(MachineKind.Washer, ItemId.RussetPotato)] = 12;
  seasoner.inputCounts[hopper(MachineKind.Washer, ItemId.UsedBottle)] = 0;
  return { state, seasoner };
}

describe('a Washer that has run out of empties', () => {
  it('is stopped by the basket, not by the recipe table', () => {
    // The verifier's read, confirmed here rather than taken on trust — and this is the half
    // that decides what the fix is. Every INGREDIENT the plain recipe wants is present; what
    // is missing is somewhere to put a chip that is not a chili chip.
    const { state, seasoner } = strandedSeasoner(101);

    expect(runnableRecipe(machineSpec(MachineKind.Washer)!, seasoner)).toBeNull();

    // Proof that the ingredients are not the problem: the same hoppers with an empty basket
    // run the plain line immediately.
    seasoner.outputCount = 0;
    seasoner.outputItem = 0;
    const recipe = runnableRecipe(machineSpec(MachineKind.Washer)!, seasoner);
    expect(recipe?.output).toBe(ItemId.WashedPotato);

    void state;
  });

  it('shows the RED lamp, because the errand is downstream', () => {
    // THE CORRECTED READING. Amber means "look upstream" and there is nothing wrong upstream:
    // the chips are there. The player's errand is to take the chili chip out, which is exactly
    // what the red lamp has always meant.
    const { state, seasoner } = strandedSeasoner(102);

    expect(machineView(state, seasoner).lamp).toBe(LampState.Blocked);
  });

  it('does not claim to want potatoes while holding twelve of them', () => {
    // The item's third criterion, at the machine it was found on.
    const { state, seasoner } = strandedSeasoner(103);

    expect(machineView(state, seasoner).wantsItem).toBe(0);
  });

  it('goes back to potatoes the moment the basket is clear', () => {
    // ITEM 111'S PROMISE, MADE TRUE AT THE POINT IT CAN BE TRUE. One pull off the basket — a
    // grabber's, a hand's — and the staple line runs on its own.
    const { state, seasoner } = strandedSeasoner(104);
    const spec = machineSpec(MachineKind.Washer)!;

    expect(takeOneOutput(seasoner, spec)).toBe(ItemId.Bottle);
    stepMany(state, 120);

    expect(seasoner.outputItem).toBe(ItemId.WashedPotato);
    expect(seasoner.outputCount).toBeGreaterThan(0);
    expect(machineView(state, seasoner).lamp).toBe(LampState.Running);
  });

  it('washes potatoes with no empty in sight and an empty basket', () => {
    // The acceptance criterion in its plainest form, with no leftovers anywhere.
    const state = createWorld(105);
    const seasoner = spawnMachine(state, MachineKind.Washer, 0, 0)!;
    seasoner.inputCounts[hopper(MachineKind.Washer, ItemId.RussetPotato)] = 6;

    stepMany(state, 120);

    expect(seasoner.outputItem).toBe(ItemId.WashedPotato);
    expect(seasoner.outputCount).toBeGreaterThan(0);
  });
});

describe('a stopped machine names the thing it is actually short of', () => {
  it('an empty Washer asks for potatoes, not for the empty it never needed', () => {
    // The tie-break that matters: two recipes, two missing ingredients, and the honest
    // answer is the one that would get the machine running on its own — the staple.
    const state = createWorld(111);
    const seasoner = spawnMachine(state, MachineKind.Washer, 0, 0)!;

    const mv = machineView(state, seasoner);
    expect(mv.lamp).toBe(LampState.Starved);
    expect(mv.wantsItem).toBe(ItemId.RussetPotato);
  });

  it('a Washer with used bottles only is running, and asks for nothing', () => {
    const state = createWorld(112);
    const seasoner = spawnMachine(state, MachineKind.Washer, 0, 0)!;
    seasoner.inputCounts[hopper(MachineKind.Washer, ItemId.UsedBottle)] = 3;

    const mv = machineView(state, seasoner);
    expect(mv.lamp).toBe(LampState.Running);
    expect(mv.wantsItem).toBe(0);
  });

  it('a Combo Packer with bags and no soda asks for soda', () => {
    // THE OTHER SHAPE OF MULTI-INPUT, and the one `inputItem` got wrong without any help from
    // item 111: a single recipe with two lines, where the missing one is not line zero.
    const state = createWorld(113);
    const packer = spawnMachine(state, MachineKind.ComboPacker, 0, 0)!;
    packer.inputCounts[hopper(MachineKind.ComboPacker, ItemId.BaggedChips)] = 4;

    const mv = machineView(state, packer);
    expect(mv.lamp).toBe(LampState.Starved);
    expect(mv.inputItem).toBe(ItemId.BaggedChips); // the old field, still hopper zero
    expect(mv.wantsItem).toBe(ItemId.Soda);
  });

  it('a Parts Bench with bottles and no powder asks for powder', () => {
    const state = createWorld(114);
    const bench = spawnMachine(state, MachineKind.PartsBench, 0, 0)!;
    bench.inputCounts[hopper(MachineKind.PartsBench, ItemId.Bottle)] = 2;

    const mv = machineView(state, bench);
    expect(mv.lamp).toBe(LampState.Starved);
    expect(mv.wantsItem).toBe(ItemId.KolaPowder);
  });

  it('a Washer holding washed potatoes with only empties left is blocked, not starved', () => {
    // The mirror of the stranded scenario — proof the fix is about the basket rather than
    // about any particular recipe. Telling this player to fetch potatoes would send them to
    // the wrong end of the factory; the empties are already here and the basket is in the way.
    const state = createWorld(115);
    const washer = spawnMachine(state, MachineKind.Washer, 0, 0)!;
    washer.outputCount = 1;
    washer.outputItem = ItemId.WashedPotato;
    washer.inputCounts[hopper(MachineKind.Washer, ItemId.UsedBottle)] = 5;

    const mv = machineView(state, washer);
    expect(mv.lamp).toBe(LampState.Blocked);
    expect(mv.wantsItem).toBe(0);
  });

  it('a throttled piped head asks for no ITEM at all', () => {
    // The amber lamp that is not about solids. Its shortage is water, it has no hoppers, and
    // the honest answer is zero — the sentence has to have a branch for it rather than naming
    // whatever `spec.inputs[0]` happens to be, which for a head is nothing.
    const state = createWorld(117);
    const head = spawnMachine(state, MachineKind.PipedSprinkler, 0, 0)!;
    head.tankMl = 1_000_000;
    head.throttled = true;

    const mv = machineView(state, head);
    expect(mv.lamp).toBe(LampState.Starved);
    expect(mv.wantsItem).toBe(0);
  });

  it('never names an ingredient the machine already has enough of, on any machine', () => {
    // THE SWEEP, and the item's third criterion stated over the whole roster rather than over
    // the two machines it was noticed on. Every machine, every hopper filled one at a time:
    // whatever it says it wants, it must be genuinely short of.
    for (const spec of MACHINE_SPECS) {
      const hoppers = machineHoppers(spec);
      if (hoppers.length === 0) continue;

      for (let filled = 0; filled < hoppers.length; filled++) {
        const state = createWorld(200 + spec.kind * 10 + filled);
        const machine = spawnMachine(state, spec.kind, 0, 0);
        if (machine === null) continue;
        machine.inputCounts[filled] = 9;

        const mv = machineView(state, machine);
        if (mv.wantsItem === 0) continue;

        const index = hopperIndexFor(spec, mv.wantsItem as ItemId);
        expect(index).toBeGreaterThanOrEqual(0);
        const needed = shortfallFor(spec, mv.wantsItem as ItemId);
        expect(machine.inputCounts[index] ?? 0).toBeLessThan(needed);
      }
    }
  });
});

/** The most any one recipe asks for of a named ingredient — the bar "short of it" is set at. */
function shortfallFor(spec: MachineSpec, item: ItemId): number {
  let most = 1;
  for (const recipe of machineRecipes(spec)) {
    for (const line of recipe.consumes) {
      if (line.item === item && line.count > most) most = line.count;
    }
  }
  return most;
}
