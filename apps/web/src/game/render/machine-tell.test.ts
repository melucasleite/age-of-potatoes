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
  MACHINE_SPECS,
  MachineKind,
  TICKS_PER_SECOND,
  createWorld,
  createWorldView,
  hopperIndexFor,
  machineHoppers,
  machineSpec,
  spawnMachine,
  step,
  stepMany,
  view,
} from '@snack/sim';
import type { Machine, MachineView, WorldState, WorldView } from '@snack/sim';

import { itemName } from '../../hud/item-copy';
import {
  blockedStatus,
  depotStatus,
  dockShelfStatus,
  starvedStatus,
  storageStatus,
} from './machine-tell';

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

// **"SIX PACKER WANTS SODA", WITH FIVE SODAS IN THE HOPPER** (item 116).
//
// The predicate behind that sentence was right and the sentence was wrong. `missingInputItem`
// flags a line when `count < line.count`; read aloud, the comparison drops the quantity that made
// it true, and the only two machines in the game that eat more than one of anything spent every
// starved moment of their lives naming an ingredient the player could see inside them.
//
// The views are projected out of real worlds, for the reason `strandedSeasoner` gives above and
// then some: the defect here is a DISAGREEMENT between a hopper's contents and the words beside
// it, and a hand-typed fixture is incapable of that disagreement.

/** A starved machine of `kind` holding `held` of `item`, as the renderer receives it. */
function starved(seed: number, kind: MachineKind, item: ItemId, held: number): MachineView {
  const state = createWorld(seed);
  const machine = spawnMachine(state, kind, 0, 0)!;
  machine.inputCounts[hopper(kind, item)] = held;
  return projected(state, machine);
}

describe('what a machine short of several says it is short of', () => {
  it('THE BUG: a Six-Packer holding five sodas no longer just "wants Soda"', () => {
    // The reported string, at the machine it was reported on. The lamp is genuinely amber —
    // five sodas will not make a six-pack — so this is a true state described falsely, which is
    // the only kind of bug this whole family has ever been.
    const m = starved(501, MachineKind.SixPacker, ItemId.Soda, 5);

    expect(m.lamp).toBe(LampState.Starved);
    expect(m.wantsHeld, 'the five the player is looking at').toBe(5);
    expect(starvedStatus('six packer', m)).toBe('six packer needs 1 more Soda');
  });

  it('THE BUG: a Composter holding three no longer just "wants Compost"', () => {
    const m = starved(502, MachineKind.Composter, ItemId.Compost, 3);

    expect(m.lamp).toBe(LampState.Starved);
    expect(starvedStatus('composter', m)).toBe('composter needs 1 more Compost');
  });

  it('asks an empty Six-Packer for all six, and does not say "more" about an empty hopper', () => {
    // The second branch, and the reason `wantsHeld` is published beside the count: the shortfall
    // here is 6 and the shortfall above is 1, but what separates the two sentences is whether
    // there is anything in the hopper for "more" to be more THAN.
    const m = starved(503, MachineKind.SixPacker, ItemId.Soda, 0);

    const sentence = starvedStatus('six packer', m);
    expect(sentence).toBe('six packer needs 6 Soda');
    expect(sentence).not.toContain('more');
  });

  it('asks an empty Composter for the whole batch of four', () => {
    const m = starved(504, MachineKind.Composter, ItemId.Compost, 0);

    expect(starvedStatus('composter', m)).toBe('composter needs 4 Compost');
  });

  it('leaves the sentence every other machine gets exactly as it was', () => {
    // THE CONTROL, and it is load-bearing: thirty-odd machines eat one of each thing, there is
    // no quantity in their case to be wrong about, and "wants Russet Potato" was never the bug.
    // A fix that reworded all of them would be a change nobody asked for wearing a bug fix's
    // clothes.
    const m = starved(505, MachineKind.Washer, ItemId.RussetPotato, 0);

    expect(starvedStatus('washer', m)).toBe('washer wants Russet Potato');
  });

  it('still names the ingredient a Combo Packer is short of, one per operation', () => {
    // Item 113's own reproduction, replayed unchanged — the multi-INPUT machine, as opposed to
    // the multi-COUNT ones above. Its bags and its soda are one apiece, so its sentence must not
    // have moved.
    const m = starved(506, MachineKind.ComboPacker, ItemId.BaggedChips, 4);

    expect(starvedStatus('combo packer', m)).toBe('combo packer wants Soda');
  });

  it('never says "wants" about something the machine is holding — any machine, any hopper', () => {
    // **THE ITEM'S FIRST CRITERION, THROUGH THE RENDERED STRING RATHER THAN THROUGH A FIELD.**
    // Item 113's sweep proved `wantsItem` never names an ingredient a machine has enough of; it
    // could not catch this bug, because it loaded nine of one thing and nine is more than six.
    // This one walks every fill from empty to one short, and reads the actual sentence.
    let checked = 0;

    for (const spec of MACHINE_SPECS) {
      const hoppers = machineHoppers(spec);

      for (let index = 0; index < hoppers.length; index++) {
        const required = hoppers[index]!.count;

        for (let held = 1; held < required; held++) {
          const state = createWorld(5_000 + spec.kind * 100 + index * 10 + held);
          const machine = spawnMachine(state, spec.kind, 0, 0);
          if (machine === null) continue;
          machine.inputCounts[index] = held;

          const m = projected(state, machine);
          if (m.lamp !== LampState.Starved || m.wantsItem === 0) continue;
          checked += 1;

          const sentence = starvedStatus('machine', m);
          // The one forbidden shape: the bare "wants X" verdict about a hopper with X in it.
          if (m.wantsHeld > 0) {
            expect(sentence, `${spec.slug} holds ${m.wantsHeld} and said "${sentence}"`).not.toBe(
              `machine wants ${itemName(m.wantsItem)}`,
            );
            expect(sentence).toContain(`${m.wantsCount} more`);
          }
        }
      }
    }

    // Two machines, five partial fills each minus the empty one — small, and exactly the set
    // that was broken. If a third multi-count machine lands this number rises on its own.
    expect(checked, 'the sweep found the machines that can tell this lie').toBe(8);
  });
});

// **THE SIXTH FRIDGE, FINALLY VISIBLE** (item 116, closing item 115's hand-off).
//
// Item 115 taught a standing route's floor to spend a freshness window and published
// `ContractView.stockedFreshTicks` for a surface that did not exist yet — its own log says so:
// *"nothing in `apps/web` reads `stockedFreshTicks` yet"*. Until this describe block, a depot with
// forty potatoes going over on its floor said "40/200 on the floor" in identical words from the
// first potato to the last tick, which is item 110's silent-destruction lesson for the third time.
//
// The contracts here are signed with a real command and the floors are stocked by writing the
// contract the sim owns, then projected — the clock under test is `view.ts`'s arithmetic, and a
// hand-typed `ContractView` would be this file agreeing with itself.

/** A depot at `tileX` with one route per entry of `items`, and the world it lives in. */
function depotWithRoutes(
  seed: number,
  items: readonly ItemId[],
): { state: WorldState; depotId: number } {
  const state = createWorld(seed);
  const depot = spawnMachine(state, MachineKind.TruckDepot, 7, 0)!;
  for (const item of items) {
    step(state, {
      tick: state.tick,
      commands: [
        {
          type: 'CreateContract',
          depotId: depot.id,
          item,
          // High enough that nothing ever dispatches: a WAITING floor is the state a route
          // spends nearly all its life in, and the only one with a clock worth reading.
          quantityPerRun: 40,
          destination: 'Springfield',
        },
      ],
    });
  }
  return { state, depotId: depot.id };
}

/** Put `count` of a route's product on its floor with `ticks` of window, then project. */
function stockFloor(state: WorldState, index: number, count: number, ticks: number): void {
  const contract = state.contracts[index]!;
  contract.stocked = count;
  contract.stockedFreshTicks = ticks;
}

/** The depot's sentence, read the way `index.ts` reads it. */
function depotLine(state: WorldState, depotId: number): string {
  const projection: WorldView = view(state, createWorldView());
  const depot = projection.commerce.depots.find((d) => d.id === depotId);
  expect(depot).toBeDefined();
  return depotStatus('truck depot', depot!, projection.commerce.contracts);
}

describe('what a depot says about the food waiting on its floor', () => {
  it('keeps the old sentence word for word on a depot with no routes', () => {
    const { state, depotId } = depotWithRoutes(601, []);

    expect(depotLine(state, depotId)).toBe('truck depot — click to sign a contract');
  });

  it('shows the floor clock where it used to show only a fraction', () => {
    // THE HAND-OFF, CLOSED. Ten potatoes with four minutes and twelve seconds of window left.
    const { state, depotId } = depotWithRoutes(602, [ItemId.RussetPotato]);
    stockFloor(state, 0, 10, TICKS_PER_SECOND * 252);

    expect(depotLine(state, depotId)).toBe(
      'truck depot — 1 route, 10/200 on the floor (4:12 left)',
    );
  });

  it('counts the clock down as the sim spends it', () => {
    const { state, depotId } = depotWithRoutes(603, [ItemId.RussetPotato]);
    stockFloor(state, 0, 10, TICKS_PER_SECOND * 252);
    stepMany(state, 60 * TICKS_PER_SECOND);

    expect(depotLine(state, depotId)).toBe(
      'truck depot — 1 route, 10/200 on the floor (3:12 left)',
    );
  });

  it('says nothing about time for a route shipping something shelf-stable', () => {
    // A bagged-chip route carries `stockedFreshTicks === 0` for the whole of its life, and 0 is
    // "no clock" rather than "no time" — one apart from the spent floor below and its opposite.
    const { state, depotId } = depotWithRoutes(604, [ItemId.BaggedChips]);
    stockFloor(state, 0, 10, 0);

    const sentence = depotLine(state, depotId);
    expect(sentence).toBe('truck depot — 1 route, 10/200 on the floor');
    expect(sentence).not.toContain('(');
  });

  it('says nothing about time when the floor is bare', () => {
    const { state, depotId } = depotWithRoutes(605, [ItemId.RussetPotato]);

    expect(depotLine(state, depotId)).toBe('truck depot — 1 route, 0/200 on the floor');
  });

  it('names the SOONEST of several routes, and says that it is doing so', () => {
    // The floor is per-route and the sentence is per-depot. "(4:12 left)" beside a number
    // covering three piles would be a true clock attached to a noun it is false of twice.
    const { state, depotId } = depotWithRoutes(606, [
      ItemId.RussetPotato,
      ItemId.WashedPotato,
      ItemId.BaggedChips,
    ]);
    stockFloor(state, 0, 10, TICKS_PER_SECOND * 252);
    stockFloor(state, 1, 5, TICKS_PER_SECOND * 100);
    stockFloor(state, 2, 7, 0);

    expect(depotLine(state, depotId)).toBe(
      'truck depot — 3 routes, 22/200 on the floor (soonest 1:40 left)',
    );
  });

  it('does not hedge with "soonest" when there is only one route to be soonest among', () => {
    const { state, depotId } = depotWithRoutes(607, [ItemId.RussetPotato]);
    stockFloor(state, 0, 10, TICKS_PER_SECOND * 100);

    expect(depotLine(state, depotId)).not.toContain('soonest');
  });

  it('ignores a route whose floor is empty, whatever number it is still carrying', () => {
    // `stockedFreshTicks` is only zeroed when the LAST of a pile rolls away, so a route mid-run
    // can hold a stale figure with nothing under it. It must not win the "soonest" contest.
    const { state, depotId } = depotWithRoutes(608, [ItemId.RussetPotato, ItemId.WashedPotato]);
    stockFloor(state, 0, 0, 1);
    stockFloor(state, 1, 5, TICKS_PER_SECOND * 252);

    expect(depotLine(state, depotId)).toBe(
      'truck depot — 2 routes, 5/200 on the floor (soonest 4:12 left)',
    );
  });

  it('shows a spent floor as out of time rather than hiding it', () => {
    // **THE CLAMP, SAID OUT LOUD.** `advanceContractSpoilage` stops at 1 instead of composting,
    // because a route's product is fixed at signing and there is nowhere to write that the floor
    // turned — so these goods are out of time and the game still ships them at list. That
    // asymmetry is item 115's flag to item 046; this line is the first place a player can see it.
    const { state, depotId } = depotWithRoutes(609, [ItemId.RussetPotato]);
    stockFloor(state, 0, 10, 2);
    stepMany(state, 200);

    expect(state.contracts[0]!.stockedFreshTicks, 'clamped, not composted').toBe(1);
    expect(depotLine(state, depotId)).toBe(
      'truck depot — 1 route, 10/200 on the floor (0:00 left)',
    );
  });
});
