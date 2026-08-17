// **A MACHINE THAT WANTS MORE MUST NOT SAY IT WANTS ANY** (item 116).
//
// `missingInputItem` flags a recipe line when `count < line.count`. That is exactly right as a
// PREDICATE and it was being read out as a SENTENCE, which drops the quantity that made it true:
// a Six-Packer eats six sodas an operation, so a packer holding FIVE was genuinely starved and
// said *"six packer wants Soda"* at a player looking straight at five sodas in its hopper. Item
// 113 closed the case where a machine held a DIFFERENT input; this is the identical lie one
// dimension over, and it needed a number rather than a new predicate.
//
// **THE CENSUS IS THE POINT OF THIS FILE.** Two machines were reported. The item asked for every
// machine whose recipe wants more than one of anything to be audited, and an audit written as a
// list in a commit message is a claim that expires the next time `data.ts` is edited. So the
// roster is enumerated from `MACHINE_SPECS` here and pinned: exactly two machines can tell this
// lie today, and the day a third lands the line below goes red rather than the sentence going
// quietly wrong in the corner of somebody's screen.

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
  spawnMachine,
  view,
} from '../src/index';
import type { Machine, MachineView, WorldState } from '../src/index';

/** The machine as a surface actually receives it — projected, never hand-typed. */
function projected(state: WorldState, machine: Machine): MachineView {
  const found = view(state, createWorldView()).machines.find((m) => m.id === machine.id);
  expect(found).toBeDefined();
  return found!;
}

/** A lone machine of `kind` with `held` of `item` in the hopper that takes it. */
function loaded(seed: number, kind: MachineKind, item: ItemId, held: number): MachineView {
  const state = createWorld(seed);
  const machine = spawnMachine(state, kind, 0, 0)!;
  const index = hopperIndexFor(machineSpec(kind)!, item);
  expect(index, 'the ingredient has a hopper').toBeGreaterThanOrEqual(0);
  machine.inputCounts[index] = held;
  return projected(state, machine);
}

// --- the census -----------------------------------------------------------------------------

/** Every `{kind, item, count}` in the game that asks for more than one at a time. */
function multiCountLines(): { kind: number; item: number; count: number }[] {
  const found: { kind: number; item: number; count: number }[] = [];
  for (const spec of MACHINE_SPECS) {
    for (const recipe of machineRecipes(spec)) {
      for (const line of recipe.consumes) {
        if (line.count > 1) found.push({ kind: spec.kind, item: line.item, count: line.count });
      }
    }
  }
  return found;
}

describe('every machine that asks for more than one of anything', () => {
  it('is exactly two, and this list is the audit', () => {
    // THE ITEM'S SECOND CRITERION, TAKEN FROM THE ROSTER RATHER THAN FROM THE BUG REPORT. Both
    // reported machines are here and nothing else is — but the value of the assertion is the
    // *other* direction: a thirty-sixth machine that eats three of something lands in this array
    // on the day it is declared, and fails here before it can reach a player.
    expect(multiCountLines()).toEqual([
      { kind: MachineKind.SixPacker, item: ItemId.Soda, count: 6 },
      { kind: MachineKind.Composter, item: ItemId.Compost, count: 4 },
    ]);
  });

  it('declares the same per-operation count in its hopper as in its recipe', () => {
    // **THE INVARIANT THE SHORTFALL IS COMPUTED ON.** `view.ts` derives "how many more" from the
    // hopper table, which is index-parallel to `machine.inputCounts`, rather than by re-running
    // `missingInputItem`'s fewest-missing/last-recipe tie-break a second time. That is only sound
    // while the hopper's count and the recipe's agree — `MACHINE_HOPPERS` keeps the FIRST
    // occurrence of an ingredient, so two recipes disagreeing about how many of one thing they
    // eat would silently make one of them print the other's number.
    for (const spec of MACHINE_SPECS) {
      const hoppers = machineHoppers(spec);
      for (const recipe of machineRecipes(spec)) {
        for (const line of recipe.consumes) {
          const hopper = hoppers[hopperIndexFor(spec, line.item)];
          expect(hopper, `${spec.slug} has a hopper for every ingredient`).toBeDefined();
          expect(hopper!.count, `${spec.slug} agrees with itself about ${line.item}`).toBe(
            line.count,
          );
        }
      }
    }
  });
});

// --- the two reported machines --------------------------------------------------------------

describe('the Six-Packer that said it wanted soda while holding five', () => {
  it('THE BUG: five of the six sodas in the hopper, and the old answer was just "Soda"', () => {
    // The verifier's exact reading, reproduced through the real projection. `wantsItem` alone is
    // the whole of what the renderer used to have, and on its own it is the reported sentence.
    const m = loaded(11_601, MachineKind.SixPacker, ItemId.Soda, 5);

    expect(m.lamp, 'genuinely starved — five will not make a six-pack').toBe(LampState.Starved);
    expect(m.wantsItem).toBe(ItemId.Soda);
    expect(m.wantsHeld, 'the five the player can see').toBe(5);
    expect(m.wantsCount, 'and the one that would start it').toBe(1);
  });

  it('asks for all six when the hopper is bare', () => {
    // The other half of the same field. "Wants Soda" was not false here — it was merely useless,
    // because a player who brought one soda got nothing and no explanation.
    const m = loaded(11_602, MachineKind.SixPacker, ItemId.Soda, 0);

    expect(m.wantsItem).toBe(ItemId.Soda);
    expect(m.wantsHeld).toBe(0);
    expect(m.wantsCount).toBe(6);
  });

  it('asks for nothing once the sixth arrives', () => {
    const m = loaded(11_603, MachineKind.SixPacker, ItemId.Soda, 6);

    expect(m.lamp).toBe(LampState.Running);
    expect(m.wantsItem).toBe(0);
    expect(m.wantsCount, 'all three fields are zero together').toBe(0);
    expect(m.wantsHeld).toBe(0);
  });
});

describe('the Composter that said it wanted compost while holding three', () => {
  it('THE BUG: three of the four, and one more would make the fertilizer', () => {
    const m = loaded(11_604, MachineKind.Composter, ItemId.Compost, 3);

    expect(m.lamp).toBe(LampState.Starved);
    expect(m.wantsItem).toBe(ItemId.Compost);
    expect(m.wantsHeld).toBe(3);
    expect(m.wantsCount).toBe(1);
  });

  it('asks for the full batch when empty', () => {
    const m = loaded(11_605, MachineKind.Composter, ItemId.Compost, 0);

    expect(m.wantsHeld).toBe(0);
    expect(m.wantsCount).toBe(4);
  });
});

describe('the thirty-odd machines that eat one of each thing', () => {
  it('still report a shortfall of one, with an empty hopper behind it', () => {
    // The control, and the reason the renderer keeps the old sentence for this shape: there is no
    // quantity here to be wrong about, so "wants Russet Potato" was never the bug and does not
    // become one.
    const m = loaded(11_606, MachineKind.Washer, ItemId.RussetPotato, 0);

    expect(m.wantsItem).toBe(ItemId.RussetPotato);
    expect(m.wantsCount).toBe(1);
    expect(m.wantsHeld, 'the field that tells the sentence not to say "more"').toBe(0);
  });
});

// --- the sweep ------------------------------------------------------------------------------

describe('the shortfall is honest on every machine in the roster', () => {
  it('never claims a machine needs zero more of what it is short of', () => {
    // **THE GUARANTEE `MachineView` WRITES DOWN, CHECKED OVER EVERYTHING.** Every machine, every
    // hopper, and every fill from empty up to one short of a full operation — which is the range
    // item 113's sweep could not reach, because it loaded nine of one thing and nine is more than
    // six. That is precisely why the Six-Packer walked through it untouched.
    let starved = 0;

    for (const spec of MACHINE_SPECS) {
      const hoppers = machineHoppers(spec);
      if (hoppers.length === 0) continue;

      for (let filled = 0; filled < hoppers.length; filled++) {
        const required = hoppers[filled]!.count;

        for (let held = 0; held < required; held++) {
          const state = createWorld(12_000 + spec.kind * 100 + filled * 10 + held);
          const machine = spawnMachine(state, spec.kind, 0, 0);
          if (machine === null) continue;
          machine.inputCounts[filled] = held;

          const m = projected(state, machine);
          if (m.wantsItem === 0) {
            expect(m.wantsCount, `${spec.slug} zeroes all three together`).toBe(0);
            expect(m.wantsHeld).toBe(0);
            continue;
          }
          starved += 1;

          const index = hopperIndexFor(spec, m.wantsItem as ItemId);
          expect(index, `${spec.slug} names something it has a hopper for`).toBeGreaterThanOrEqual(
            0,
          );
          const line = hoppers[index]!;
          const inHopper = machine.inputCounts[index] ?? 0;

          // The published pair describes THIS hopper, not some other one.
          expect(m.wantsHeld, `${spec.slug} counts the right hopper`).toBe(inHopper);
          // Short of it, still — item 113's guarantee, unchanged.
          expect(m.wantsHeld, `${spec.slug} is genuinely short`).toBeLessThan(line.count);
          // And the arithmetic the sentence prints closes the gap exactly.
          expect(m.wantsCount, `${spec.slug} asks for exactly the gap`).toBe(
            line.count - m.wantsHeld,
          );
          expect(m.wantsCount, 'never zero, never negative').toBeGreaterThanOrEqual(1);
        }
      }
    }

    expect(starved, 'the sweep actually found starved machines to check').toBeGreaterThan(20);
  });
});
