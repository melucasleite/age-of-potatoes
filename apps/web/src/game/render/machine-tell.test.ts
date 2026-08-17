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
  LiquidId,
  MACHINE_SPECS,
  MachineKind,
  PUMP_RATE_ML_PER_MINUTE,
  RESERVOIR_CAPACITY_ML,
  RESERVOIR_LOW_PERMILLE,
  TICKS_PER_SECOND,
  TechId,
  createWorld,
  createWorldView,
  hopperIndexFor,
  machineHoppers,
  machineSpec,
  rebuildNetworks,
  spawnMachine,
  spawnPipe,
  step,
  stepMany,
  view,
} from '@snack/sim';
import type { Machine, MachineView, WorldState, WorldView } from '@snack/sim';

import { itemName } from '../../hud/item-copy';
import { reservoirAtTile } from '../input/pointer';
import {
  blockedStatus,
  depotStatus,
  dockShelfStatus,
  pondAtTile,
  pondStatus,
  starvedStatus,
  storageStatus,
  waterStatus,
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

// ─────────────────────────────────────────────────────────────────────────────────────────
//  THE WATER SENTENCES (item 130)
//
//  The owner asked twice how to boost his pumps. He could feel the shortage and could not see
//  one number about it: `ticksToEmpty` and `ReservoirView.throttle` were both computed in the
//  sim and read nowhere in the app, and the ONE sentence a dry machine did print — "barrel dry
//  — click to refill" — is true of exactly one machine in the game and was being shown at four.
//
//  Same law as the rest of this file: THE VIEWS ARE REAL, PROJECTED OUT OF A REAL WORLD, with
//  a real pond drained to a real level and a real pump throttled by it. The defect being
//  guarded against is a DISAGREEMENT between what the sim throttles and what the ribbon claims,
//  and a hand-built `ReservoirView` cannot disagree with a pump that does not exist.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** `RESERVOIR → Pump → pipes → Tank → head`, the layout `water.test.ts` plumbs. */
function plumbedWorld(seed: number): {
  state: WorldState;
  pump: Machine;
  tank: Machine;
  head: Machine;
} {
  const state = createWorld(seed);
  state.unlocked = [TechId.Pumps, TechId.PipedSprinklers];
  state.moneyCents = 10_000_000;

  const pump = spawnMachine(state, MachineKind.Pump, 12, 12)!;
  for (let x = 11; x >= 3; x--) spawnPipe(state, x, 12, LiquidId.Water);
  for (let y = 11; y >= 4; y--) spawnPipe(state, 3, y, LiquidId.Water);

  const tank = spawnMachine(state, MachineKind.Tank, 1, 10)!;
  const head = spawnMachine(state, MachineKind.PipedSprinkler, 2, 8)!;

  rebuildNetworks(state);
  return { state, pump, tank, head };
}

/** The pond, parked at a chosen permille. Levels are set directly, as `water.test.ts` does. */
function setPond(state: WorldState, permille: number): void {
  state.reservoirs[0]!.levelMl = Math.floor((RESERVOIR_CAPACITY_ML * permille) / 1000);
}

/**
 * Run the lot at a chosen pond level, then re-pin the level before reading.
 *
 * **THE RE-PIN IS NOT A FAKE AND THE ORDER IS WHY.** The run happens FIRST, at the band being
 * tested, so every rate these tests assert on — a halved pump, a draining tank — was produced
 * by the sim actually throttling itself for `ticks` ticks. What the second `setPond` removes is
 * only the DRIFT: a pump pulling 600 L/min moves the pond a few thousand millilitres over a
 * short run, which is enough to turn "90.0%" into "89.9%" and make an exact-string assertion a
 * coin toss. Re-pinning the level is the same trick `water.test.ts` uses to park a pond in a
 * band; doing it after the run rather than instead of one keeps the throttle honest.
 */
function settle(state: WorldState, permille: number, ticks: number): void {
  setPond(state, permille);
  stepMany(state, ticks);
  setPond(state, permille);
}

/** The ribbon's own name for a machine — `index.ts:machineName`, which a test cannot import. */
function nameOf(kind: MachineKind): string {
  return machineSpec(kind)!.slug.split('-').join(' ');
}

/**
 * A permille as the ribbon prints it — `reports/format.ts:formatPermille`, spelled out here.
 *
 * Deliberately NOT imported from the module under test's own dependency: these expectations
 * exist to catch the day that formatter changes shape, and a test that reads "82.3%" out of
 * the same function that wrote it would agree with any rendering at all. What it IS allowed
 * to share is the LEVEL — the tests derive their thresholds from `RESERVOIR_LOW_PERMILLE`, so
 * that a sim lane retuning the low mark moves the fixtures with it instead of going red.
 */
function permilleText(permille: number): string {
  return `${Math.floor(permille / 10)}.${permille % 10}%`;
}

/** A machine and its pond, exactly as the ribbon receives them. */
function tellFor(state: WorldState, machine: Machine): string | null {
  const projection = view(state, createWorldView());
  const m = projection.machines.find((each) => each.id === machine.id);
  expect(m, 'the machine has to survive projection').toBeDefined();
  return waterStatus(nameOf(machine.kind as MachineKind), m!, projection.reservoirs);
}

function projectedMachine(state: WorldState, machine: Machine): MachineView {
  return projected(state, machine);
}

function projectedPond(state: WorldState): WorldView['reservoirs'][number] {
  const pond = view(state, createWorldView()).reservoirs[0];
  expect(pond, 'the default world has exactly one pond').toBeDefined();
  return pond!;
}

describe('the pond, hovered', () => {
  it('says how full it is, and stays quiet about throttling while it is', () => {
    const { state } = plumbedWorld(701);
    settle(state, 823, 1);

    expect(projectedPond(state).levelPermille).toBe(823);
    expect(pondStatus(projectedPond(state))).toBe('pond — 82.3% full');
  });

  it('**NAMES THE HALVED BAND, AND THE THRESHOLD THAT PUT IT THERE**', () => {
    // The most important sentence in this item. Below the low mark a pump runs at half its
    // posted rate, and before this the game said nothing at all — a pump quietly performing at
    // half speed is indistinguishable from a broken pump, and that is the owner's report.
    //
    // **THE LEVEL AND BOTH PERCENTAGES ARE DERIVED FROM `RESERVOIR_LOW_PERMILLE`**, never typed.
    // A literal 200 here is a bet that the low mark stays above 20%, and a literal "25.0%" in
    // the expectation is the copy-outlives-its-constant bug this very sentence is guarding
    // against — written into the guard. Below the mark by construction, whatever the mark is.
    const { state } = plumbedWorld(702);
    const low = RESERVOIR_LOW_PERMILLE - 50;
    settle(state, low, 1);

    expect(projectedPond(state).levelPermille).toBe(low);
    expect(pondStatus(projectedPond(state))).toBe(
      `pond low — ${permilleText(low)} full, under ${permilleText(RESERVOIR_LOW_PERMILLE)}, so pumps run at HALF RATE`,
    );
  });

  it('promises recovery at zero rather than reading as broken', () => {
    // §4's anti-softlock clause, said out loud: a pump at an empty pond is slow, never dead.
    const { state } = plumbedWorld(703);
    settle(state, 0, 1);

    expect(pondStatus(projectedPond(state))).toBe(
      'pond empty — pumps get only what it refills, so it always recovers',
    );
  });

  it('is still in the full band one notch ABOVE the mark', () => {
    // The other side of the boundary, because a threshold nobody tests from above is a
    // threshold that can quietly drift into an off-by-one. `reservoirThrottle` halves on
    // `< RESERVOIR_LOW_PERMILLE`, so the mark itself is the last full-rate level.
    const { state } = plumbedWorld(704);
    settle(state, RESERVOIR_LOW_PERMILLE, 1);

    const line = pondStatus(projectedPond(state));
    expect(line).not.toContain('HALF RATE');
    expect(line).toBe(`pond — ${permilleText(RESERVOIR_LOW_PERMILLE)} full`);
  });

  it('agrees with pointer.ts about where the water is', () => {
    // `pondAtTile` and `pointer.ts`'s `reservoirAtTile` are two copies of the same rect test,
    // deliberately not merged — delegating would point the input layer at the render layer.
    // This is the cheap half of that decision: they are swept over the whole lot together, so
    // the day one is edited and the other is not, this line goes red instead of the pond
    // quietly losing its sentence along one edge.
    const { state } = plumbedWorld(705);
    const projection = view(state, createWorldView());
    let water = 0;

    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const here = pondAtTile(projection.reservoirs, x, y) !== null;
        expect(here, `disagreement at ${x},${y}`).toBe(reservoirAtTile(projection, x, y));
        if (here) water += 1;
      }
    }

    expect(water, 'the sweep has to actually cross the pond to prove anything').toBeGreaterThan(0);
  });
});

describe('the pump, hovered', () => {
  it('reports the rate it is actually drawing, with the pond level beside it', () => {
    const { state, pump } = plumbedWorld(710);
    settle(state, 900, 5);

    const line = tellFor(state, pump)!;
    expect(line).toContain('pump — ');
    expect(line).toContain('/min');
    expect(line).toContain(`pond at ${permilleText(900)}`);
    expect(line).not.toContain('HALF');
  });

  it('**SAYS "HALF RATE" WHEN IT IS RUNNING AT HALF RATE**', () => {
    // The owner's literal complaint, answered. Before this the ribbon said "pump running" in
    // exactly the same words at full rate and at half — true, and the whole problem.
    const { state, pump } = plumbedWorld(711);
    const low = RESERVOIR_LOW_PERMILLE - 100;
    settle(state, low, 5);

    // The sim really is halving it: the rate below came out of a run at this band, not out of
    // this file. `PUMP_RATE_ML_PER_MINUTE` is the posted rate the player is comparing against.
    const drawn = projectedMachine(state, pump).flowMlPerMinute;
    expect(drawn).toBeLessThanOrEqual(PUMP_RATE_ML_PER_MINUTE / 2);

    const line = tellFor(state, pump)!;
    expect(line).toContain('at HALF RATE');
    expect(line).toContain(`pond down to ${permilleText(low)}`);
  });

  it('never claims a barrel a pump does not have', () => {
    // `lampFor` gives a pump at a dry pond `LampState.UtilityMissing`, whose branch in the
    // ribbon reads "barrel dry — click to refill". A pump has no barrel and no click.
    const { state, pump } = plumbedWorld(712);
    settle(state, 0, 5);

    const line = tellFor(state, pump)!;
    expect(line, 'the wild goose chase').not.toContain('barrel');
    expect(line).not.toContain('click to refill');
    expect(line).toContain('pond empty');
  });
});

describe('the tank, hovered', () => {
  it('**SHOWS A NET RATE AND A TIME TO EMPTY** — the two numbers it exists for', () => {
    // `data.ts:2591`: the Tank is "the only object in the game that shows a NET RATE and a
    // TIME-TO-EMPTY… it turns 'am I short of water' from a feeling into arithmetic the player
    // can do at a glance". `ticksToEmpty` had never been read by a single line of the app.
    const { state, tank } = plumbedWorld(720);
    settle(state, 1000, 40);

    // Fill the buffer, then take the pond away so the tank can only fall.
    state.machines.find((m) => m.id === tank.id)!.tankMl = 400_000;
    settle(state, 0, 30);

    const m = projectedMachine(state, tank);
    expect(m.flowMlPerMinute, 'the tank has to actually be draining').toBeLessThan(0);
    expect(m.ticksToEmpty, 'and must therefore carry a clock').toBeGreaterThan(0);

    const line = tellFor(state, tank)!;
    expect(line).toContain('losing ');
    expect(line).toContain('/min');
    expect(line).toContain('empty ');
  });

  it('invents no deadline for a tank that is not emptying', () => {
    // `-1` is "not emptying", which is a different fact from "no time left". Nothing divides
    // by zero here and nothing prints a countdown that was never computed.
    const { state, tank } = plumbedWorld(721);
    settle(state, 1000, 20);

    const m = projectedMachine(state, tank);
    expect(m.ticksToEmpty).toBe(-1);
    expect(tellFor(state, tank)).not.toContain('empty ');
  });

  it('blames the pond when the pond is the reason it is empty', () => {
    const { state, tank } = plumbedWorld(722);
    settle(state, 100, 10);

    const m = projectedMachine(state, tank);
    expect(m.lamp, 'the sim calls an empty tank blue').toBe(LampState.UtilityMissing);

    const line = tellFor(state, tank)!;
    expect(line).toContain('EMPTY');
    expect(line).toContain('half rate');
    expect(line).not.toContain('barrel');
  });
});

describe('a piped head, hovered', () => {
  it('**NO LONGER TELLS A BARREL-LESS MACHINE TO CLICK ITS BARREL**', () => {
    // The reported defect, at its source. A dry piped head shows the same blue lamp a dry
    // Barrel Sprinkler does, and the ribbon printed the barrel's sentence at both. A player
    // whose field has gone dry hovers a dead head, is told to click it, clicks it, nothing
    // happens — and concludes the pump is the thing that is wrong. Which is what happened.
    const { state, head } = plumbedWorld(730);
    settle(state, 0, 10);

    const m = projectedMachine(state, head);
    expect(m.lamp, 'the head is on the blue lamp — the branch that lied').toBe(
      LampState.UtilityMissing,
    );

    const line = tellFor(state, head);
    expect(line, 'a non-null answer is what makes index.ts skip the barrel branch').not.toBeNull();
    expect(line!).not.toContain('barrel');
    expect(line!).not.toContain('click to refill');
    expect(line!).toContain('the pond is empty');
  });

  it('**LEAVES THE ONE MACHINE THE BARREL SENTENCE IS TRUE OF ALONE**', () => {
    // The other half of the same fix, and the reason it is a fix rather than a swap: the
    // hand-filled Barrel Sprinkler DOES have a barrel and a click that fills it. `waterStatus`
    // returns null for it, which is what hands it back to the lamp switch and its own line.
    const state = createWorld(731);
    const barrel = spawnMachine(state, MachineKind.Sprinkler, 5, 5)!;
    barrel.tankMl = 0;
    stepMany(state, 1);

    const m = projectedMachine(state, barrel);
    expect(m.lamp).toBe(LampState.UtilityMissing);
    expect(tellFor(state, barrel)).toBeNull();
  });

  it('says nothing at all about a head that is working', () => {
    // A rate on a healthy sprinkler is noise on the one machine a player builds forty of.
    //
    // **THE BUFFER IS FILLED DIRECTLY RATHER THAN PUMPED FULL**, which is the same move the
    // thirsty-head test above makes and for a sharper reason than brevity. Written the other
    // way — run a full pond for four hundred ticks and trust the head to charge — this test
    // asserts the renderer's contract THROUGH the water layer's balance numbers, and it went
    // red mid-suite when a sim lane retuned them underneath it. What is being tested here is
    // "a Running, unthrottled head gets no sentence"; the intake rate a head charges at is
    // the sim's business and no business of this file's.
    const { state, head } = plumbedWorld(732);
    settle(state, 1000, 20);
    state.machines.find((m) => m.id === head.id)!.tankMl = 1_000_000;
    stepMany(state, 1);

    const m = projectedMachine(state, head);
    expect(m.lamp).toBe(LampState.Running);
    expect(m.throttled).toBe(0);
    expect(tellFor(state, head)).toBeNull();
  });
});
