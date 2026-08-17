// **THE SENTENCE UNDER THE CURSOR, ON A MACHINE THAT HAS STOPPED** (item 113).
//
// This is the one surface where a wrong lamp becomes a wrong ERRAND. Item 111's verifier found
// a Seasoner reading "seasoner wants plain chips" with twelve plain chips in its hopper — false
// on its face, and pointing at the far end of the factory. The same sentence had been telling a
// piped head it wanted an "Unknown item", and a Juicer that it was full of one, since the soda
// line shipped.
//
// **THE VIEWS HERE ARE REAL, PROJECTED OUT OF A REAL WORLD.** Not one field is set by hand.
// That is deliberate and it is the whole point: the defect was a DISAGREEMENT between the lamp
// and the words beside it, and a fixture that sets both by hand cannot disagree with itself.
// `lampFor` and `wantsItem` come out of the sim on the same pass the sentence is written from,
// so if they ever part company again a line below goes red.

import { describe, expect, it } from 'vitest';

import {
  ItemId,
  LampState,
  MachineKind,
  TICKS_PER_SECOND,
  createWorld,
  createWorldView,
  hopperIndexFor,
  machineSpec,
  spawnMachine,
  stepMany,
  view,
} from '@snack/sim';
import type { Machine, MachineView, WorldState } from '@snack/sim';

import { blockedStatus, dockShelfStatus, starvedStatus, storageStatus } from './machine-tell';

/** The machine as the renderer actually receives it. */
function projected(state: WorldState, machine: Machine): MachineView {
  const found = view(state, createWorldView()).machines.find((m) => m.id === machine.id);
  expect(found).toBeDefined();
  return found!;
}

function hopper(kind: MachineKind, item: ItemId): number {
  return hopperIndexFor(machineSpec(kind)!, item);
}

/** The reported state: one chili chip in the basket, twelve plain chips, peppers gone. */
function strandedSeasoner(seed: number): MachineView {
  const state = createWorld(seed);
  const seasoner = spawnMachine(state, MachineKind.Seasoner, 0, 0)!;
  seasoner.outputCount = 1;
  seasoner.outputItem = ItemId.ChiliChips;
  seasoner.inputCounts[hopper(MachineKind.Seasoner, ItemId.PlainChips)] = 12;
  return projected(state, seasoner);
}

describe('what a stopped machine says under the cursor', () => {
  it('does not send a Seasoner full of chips off to find chips', () => {
    const m = strandedSeasoner(301);

    // The lamp is red, so the sentence the switch reaches is the blocked one — which is the
    // half of the fix that decides which end of the factory the player walks to.
    expect(m.lamp).toBe(LampState.Blocked);
    const sentence = blockedStatus('seasoner', m);

    expect(sentence).not.toContain('wants');
    expect(sentence).toContain('Chili Chips');
    expect(sentence).toContain('clear the basket');
  });

  it('does not call a basket with nineteen free slots full', () => {
    // "Full" was the only word the red lamp had. A Seasoner stopped at 1 of 20 is not full of
    // anything, and a player who reads that goes looking for a jam that is not there.
    const m = strandedSeasoner(302);

    expect(m.outputCount).toBeLessThan(m.outputCapacity);
    expect(blockedStatus('seasoner', m)).not.toContain('full');
  });

  it('still says full when the basket is genuinely full', () => {
    // The control: the common red lamp keeps its old sentence, word for word.
    const state = createWorld(303);
    const fryer = spawnMachine(state, MachineKind.Fryer, 0, 0)!;
    fryer.outputCount = machineSpec(MachineKind.Fryer)!.outputCapacity;
    fryer.outputItem = ItemId.PlainChips;
    const m = projected(state, fryer);

    expect(m.lamp).toBe(LampState.Blocked);
    expect(blockedStatus('fryer', m)).toBe('fryer full of Plain Chips — take some');
  });

  it('names the ingredient a starved Combo Packer is genuinely short of', () => {
    // A single recipe with two lines, where the missing one is not line zero — the shape
    // `inputItem` got wrong without any help from item 111.
    const state = createWorld(304);
    const packer = spawnMachine(state, MachineKind.ComboPacker, 0, 0)!;
    packer.inputCounts[hopper(MachineKind.ComboPacker, ItemId.BaggedChips)] = 4;
    const m = projected(state, packer);

    expect(m.lamp).toBe(LampState.Starved);
    expect(starvedStatus('combo packer', m)).toBe('combo packer wants Soda');
  });

  it('asks an empty Seasoner for chips rather than for a pepper it can live without', () => {
    const state = createWorld(305);
    const seasoner = spawnMachine(state, MachineKind.Seasoner, 0, 0)!;
    const m = projected(state, seasoner);

    expect(m.lamp).toBe(LampState.Starved);
    expect(starvedStatus('seasoner', m)).toBe('seasoner wants Plain Chips');
  });

  it('never says "Unknown item" about a thirsty head', () => {
    // A piped head has no hoppers at all, so the old sentence read `spec.inputs[0]` off the end
    // of an empty list and printed the words "Unknown item" at the player.
    const state = createWorld(306);
    const head = spawnMachine(state, MachineKind.PipedSprinkler, 0, 0)!;
    head.tankMl = 1_000_000;
    head.throttled = true;
    const m = projected(state, head);

    expect(m.lamp).toBe(LampState.Starved);
    const sentence = starvedStatus('piped sprinkler', m);
    expect(sentence).not.toContain('Unknown');
    expect(sentence).toBe('piped sprinkler — not getting enough water');
  });

  it('names the liquid a backed-up Juicer is full of', () => {
    // The third blocked cause, and the one that has been wrong the longest: a machine whose
    // product is a liquid has no `outputItem`, so this branch printed "full of Unknown item".
    const state = createWorld(307);
    const juicer = spawnMachine(state, MachineKind.Juicer, 0, 0)!;
    const port = machineSpec(MachineKind.Juicer)!.ports[0]!;
    juicer.ports[0]!.ml = port.capacityMl;
    const m = projected(state, juicer);

    expect(m.lamp).toBe(LampState.Blocked);
    const sentence = blockedStatus('juicer', m);
    expect(sentence).not.toContain('Unknown');
    expect(sentence).toBe('juicer full of cane juice — nothing is drawing it off');
  });
});

// **WHAT A BOX SAYS IT IS DOING TO YOUR FOOD** (item 114).
//
// The ribbon had no branch for a container at all: a Root Cellar has no work cycle, answers
// `LampState.Off`, and fell to the bottom of the switch as "root cellar idle" — a sentence about
// ninety potatoes that mentions neither the potatoes nor that a cart beside it is eating them.
//
// The views here are projected out of real worlds for `strandedSeasoner`'s reason, and it matters
// more here than anywhere: the clock is a number, the number comes from `view.ts`, and a fixture
// with a hand-typed `cargoTicksToSpoil` would be a test of this file's ability to print a number
// somebody else already agreed with.

/** A container of `kind` holding `count` goods with `ticks` of window left, after `wait` ticks. */
function box(
  seed: number,
  kind: MachineKind,
  item: ItemId,
  count: number,
  ticks: number,
  wait = 0,
): MachineView {
  const state = createWorld(seed);
  const machine = spawnMachine(state, kind, 0, 0)!;
  machine.cargoItem = item;
  machine.cargoCount = count;
  machine.cargoFreshTicks = ticks;
  if (wait > 0) stepMany(state, wait);
  return projected(state, machine);
}

describe('what a container says about the clock it is spending', () => {
  it('says what a cart is holding and how long it has, where it used to say "idle"', () => {
    const m = box(401, MachineKind.HandCart, ItemId.RussetPotato, 12, TICKS_PER_SECOND * 252);

    expect(m.lamp, 'a box has no work cycle, which is why this branch had to exist').toBe(
      LampState.Off,
    );
    expect(storageStatus('hand cart', m)).toBe('hand cart — 12 Russet Potato (4:12 left)');
  });

  it('counts down as the cart spends it — the same minute, on screen', () => {
    const later = box(
      402,
      MachineKind.HandCart,
      ItemId.RussetPotato,
      12,
      TICKS_PER_SECOND * 252,
      60 * TICKS_PER_SECOND,
    );

    expect(storageStatus('hand cart', later)).toBe('hand cart — 12 Russet Potato (3:12 left)');
  });

  it('calls a cellar frozen and still shows the window it is holding', () => {
    const m = box(
      403,
      MachineKind.RootCellar,
      ItemId.RussetPotato,
      40,
      TICKS_PER_SECOND * 252,
      5 * 60 * TICKS_PER_SECOND,
    );

    // Five minutes went by and the number did not: that is the $250 machine working, and the
    // word in front of it is what stops the same figure reading as a hung clock.
    expect(storageStatus('root cellar', m)).toBe(
      'root cellar — 40 Russet Potato (frozen with 4:12 left)',
    );
  });

  it('does not call an empty cellar frozen, because it is preserving nothing', () => {
    const state = createWorld(404);
    const cellar = spawnMachine(state, MachineKind.RootCellar, 0, 0)!;

    expect(storageStatus('root cellar', projected(state, cellar))).toBe('root cellar empty');
  });

  it('says nothing about time for goods that were never going to spoil', () => {
    const m = box(405, MachineKind.RootCellar, ItemId.Compost, 10, 0);

    const sentence = storageStatus('root cellar', m)!;
    expect(sentence).toBe('root cellar — 10 Compost');
    expect(sentence).not.toContain('frozen');
    expect(sentence).not.toContain('(');
  });

  it('stays silent on anything that is not a box, so the lamp keeps its sentence', () => {
    const state = createWorld(406);
    const fryer = spawnMachine(state, MachineKind.Fryer, 0, 0)!;

    expect(storageStatus('fryer', projected(state, fryer))).toBeNull();
  });
});

describe("a harvester dock's shelves", () => {
  it('puts the clock on the produce and not on the seeds beside it', () => {
    // The reason the clock is in brackets rather than trailing the sentence: only one of these
    // two piles has a window, and "on the shelves, 4:12 left" would attach it to whichever noun
    // came last — which for a shelf of seeds is a claim that is simply false.
    const state = createWorld(407);
    const dock = spawnMachine(state, MachineKind.HarvesterDock, 0, 0)!;
    dock.cargoItem = ItemId.RussetPotato;
    dock.cargoCount = 12;
    dock.cargoFreshTicks = TICKS_PER_SECOND * 252;
    dock.seedShelfItem = ItemId.PotatoSeed;
    dock.seedShelfCount = 6;

    expect(dockShelfStatus('harvester dock', projected(state, dock))).toBe(
      'harvester dock — 12 Russet Potato (4:12 left) and 6 Potato Seed on the shelves',
    );
  });

  it('keeps the old sentence word for word when the shed holds only seeds', () => {
    const state = createWorld(408);
    const dock = spawnMachine(state, MachineKind.HarvesterDock, 0, 0)!;
    dock.seedShelfItem = ItemId.PotatoSeed;
    dock.seedShelfCount = 6;

    expect(dockShelfStatus('harvester dock', projected(state, dock))).toBe(
      'harvester dock — 6 Potato Seed on the seed shelf',
    );
  });

  it('hands a bare dock back to the lamp switch, exactly as the inlined version did', () => {
    const state = createWorld(409);
    const dock = spawnMachine(state, MachineKind.HarvesterDock, 0, 0)!;

    expect(dockShelfStatus('harvester dock', projected(state, dock))).toBeNull();
  });
});
