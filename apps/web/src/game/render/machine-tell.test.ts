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
  MachineRole,
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

/** A container of `kind` holding `count` goods, projected after `wait` ticks. */
function box(seed: number, kind: MachineKind, item: ItemId, count: number, wait = 0): MachineView {
  const state = createWorld(seed);
  const machine = spawnMachine(state, kind, 0, 0)!;
  machine.cargoItem = item;
  machine.cargoCount = count;
  if (wait > 0) stepMany(state, wait);
  return projected(state, machine);
}

describe('what a container says it is holding', () => {
  it('says what a cart is holding, where it used to say "idle"', () => {
    const m = box(401, MachineKind.HandCart, ItemId.RussetPotato, 12);

    expect(m.lamp, 'a box has no work cycle, which is why this branch had to exist').toBe(
      LampState.Off,
    );
    expect(storageStatus('hand cart', m)).toBe('hand cart — 12 Russet Potato');
  });

  // ⚠️ THIS TEST REPLACED THREE THAT COUNTED A CLOCK DOWN ([[124]]), and it is the stronger
  // pin: those asserted that a printed number SHRANK on schedule, which was a test of the
  // freshness feature. This asserts the feature is GONE — item 124's acceptance criterion in
  // as many words, *"a good in a cart, hopper, bot pocket or depot shelf is unchanged after a
  // simulated day"* — and it is the one that would fail if any per-tick sweep over containers
  // came back. A whole simulated day is 20 Hz × 60 × 60 × 24; a thousand seconds is far past
  // every window the game ever had (the shortest was 7,200 ticks) and keeps the suite quick.
  it('says the same thing after a simulated day as it did on the first tick', () => {
    const before = box(402, MachineKind.HandCart, ItemId.RussetPotato, 12);
    const after = box(402, MachineKind.HandCart, ItemId.RussetPotato, 12, 20_000);

    expect(storageStatus('hand cart', after)).toBe(storageStatus('hand cart', before));
    expect(storageStatus('hand cart', after)).toBe('hand cart — 12 Russet Potato');
  });

  it('gives a cellar the same sentence as a cart, with no word about preserving anything', () => {
    // The $250 machine used to buy a FROZEN clock and said so — "(frozen with 4:12 left)".
    // There is no clock to freeze, so what it buys is bulk (`ROOT_CELLAR_CAPACITY`), and the
    // sentence is a plain count. Left as a test rather than deleted because "root cellar idle"
    // is the bug item 114 fixed, and that fix has to survive this one.
    const m = box(403, MachineKind.RootCellar, ItemId.RussetPotato, 40, 5 * 60 * 20);

    const sentence = storageStatus('root cellar', m)!;
    expect(sentence).toBe('root cellar — 40 Russet Potato');
    expect(sentence).not.toContain('frozen');
    expect(sentence).not.toContain('(');
  });

  it('says a cellar holding nothing is empty', () => {
    const state = createWorld(404);
    const cellar = spawnMachine(state, MachineKind.RootCellar, 0, 0)!;

    expect(storageStatus('root cellar', projected(state, cellar))).toBe('root cellar empty');
  });

  it('stays silent on anything that is not a box, so the lamp keeps its sentence', () => {
    const state = createWorld(406);
    const fryer = spawnMachine(state, MachineKind.Fryer, 0, 0)!;

    expect(storageStatus('fryer', projected(state, fryer))).toBeNull();
  });
});

describe("a harvester dock's shelves", () => {
  it('puts the clock on the produce and not on the seeds beside it', () => {
    const state = createWorld(407);
    const dock = spawnMachine(state, MachineKind.HarvesterDock, 0, 0)!;
    dock.cargoItem = ItemId.RussetPotato;
    dock.cargoCount = 12;
    dock.seedShelfItem = ItemId.PotatoSeed;
    dock.seedShelfCount = 6;

    expect(dockShelfStatus('harvester dock', projected(state, dock))).toBe(
      'harvester dock — 12 Russet Potato and 6 Potato Seed on the shelves',
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

  it('asks an empty Six-Packer for all six, and does not say "more" about an empty hopper', () => {
    // The second branch, and the reason `wantsHeld` is published beside the count: the shortfall
    // here is 6 and the shortfall above is 1, but what separates the two sentences is whether
    // there is anything in the hopper for "more" to be more THAN.
    const m = starved(503, MachineKind.SixPacker, ItemId.Soda, 0);

    const sentence = starvedStatus('six packer', m);
    expect(sentence).toBe('six packer needs 6 Soda');
    expect(sentence).not.toContain('more');
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

    // ONE machine, five partial fills — the Six-Packer, which eats six sodas an operation.
    // This read 8 until [[124]]: the Composter was the other multi-count machine in the game
    // (four Compost to a batch) and it contributed three of the fills. The sweep is derived,
    // not hand-listed, so the number moved on its own when the machine left `MachineKind` —
    // and it will rise again on its own if a second multi-count machine ever lands.
    expect(checked, 'the sweep found the machines that can tell this lie').toBe(5);
  });
});

// **WHAT IS WAITING ON A DEPOT FLOOR** (item 116).
//
// This block was written for item 115's "sixth fridge": a standing route's floor spent a
// freshness window, and a depot with forty potatoes going over said "40/200 on the floor" in
// identical words from the first potato to the last tick. [[124]] deleted the window, so what
// survives is the fraction — which item 116 added in the same breath and which was never about
// decay: a route backing up and a route running clean are different states and the sentence
// has to tell them apart.
//
// The contracts here are signed with a real command and the floors are stocked by writing the
// contract the sim owns, then projected — a hand-typed `ContractView` would be this file
// agreeing with itself.

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

/** Put `count` of a route's product on its floor. */
function stockFloor(state: WorldState, index: number, count: number): void {
  const contract = state.contracts[index]!;
  contract.stocked = count;
}

/** The depot's sentence, read the way `index.ts` reads it. */
function depotLine(state: WorldState, depotId: number): string {
  const projection: WorldView = view(state, createWorldView());
  const depot = projection.commerce.depots.find((d) => d.id === depotId);
  expect(depot).toBeDefined();
  return depotStatus('truck depot', depot!);
}

describe('what a depot says about the food waiting on its floor', () => {
  it('keeps the old sentence word for word on a depot with no routes', () => {
    const { state, depotId } = depotWithRoutes(601, []);

    expect(depotLine(state, depotId)).toBe('truck depot — click to sign a contract');
  });

  it('shows how much is waiting on the floor', () => {
    const { state, depotId } = depotWithRoutes(602, [ItemId.RussetPotato]);
    stockFloor(state, 0, 10);

    expect(depotLine(state, depotId)).toBe('truck depot — 1 route, 10/200 on the floor');
  });

  // ⚠️ FIVE TESTS HERE COUNTED A FLOOR CLOCK AND [[124]] DELETED THEM WITH IT: the countdown,
  // the shelf-stable silence, the SOONEST-of-several-routes phrasing, the "do not hedge with
  // soonest on one route" case, and the spent floor that clamped at 1 and read "(0:00 left)".
  // All five described `ContractView.stockedFreshTicks`, which no longer exists. What is left
  // is the fraction — the half of the sentence item 116 added that was never about decay.
  it('leaves a full floor unchanged after a simulated day', () => {
    // The depot's half of item 124's acceptance criterion. A waiting floor is where a route
    // spends nearly all of its life, and it was the sixth fridge — an unbounded warehouse that
    // spent a freshness window. It spends nothing now.
    const { state, depotId } = depotWithRoutes(603, [ItemId.RussetPotato]);
    stockFloor(state, 0, 10);
    const before = depotLine(state, depotId);
    stepMany(state, 20_000);

    expect(depotLine(state, depotId)).toBe(before);
    expect(depotLine(state, depotId)).toBe('truck depot — 1 route, 10/200 on the floor');
  });

  it('says nothing about time when the floor is bare', () => {
    const { state, depotId } = depotWithRoutes(605, [ItemId.RussetPotato]);

    expect(depotLine(state, depotId)).toBe('truck depot — 1 route, 0/200 on the floor');
  });

  it('adds the routes up across a depot running several', () => {
    const { state, depotId } = depotWithRoutes(606, [
      ItemId.RussetPotato,
      ItemId.WashedPotato,
      ItemId.BaggedChips,
    ]);
    stockFloor(state, 0, 10);
    stockFloor(state, 1, 5);
    stockFloor(state, 2, 7);

    expect(depotLine(state, depotId)).toBe('truck depot — 3 routes, 22/200 on the floor');
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

/**
 * The same lot with NO PUMP ON IT — pipe, a tank and a head, and nothing feeding them.
 *
 * **THIS IS THE REPLACEMENT FOR `setPond(state, 0)`** (item 140). Every dry-line test in this
 * file used to be written by draining the pond, which is not a thing that can happen any more:
 * a pond is an unlimited source. What is still finite is the THROUGHPUT, so the way to starve a
 * line now is to take away the straw rather than the water. That is also a state a player can
 * actually reach — pipe laid, heads placed, no pump at the end of it — which the old empty pond
 * never was.
 */
function unpumpedWorld(seed: number): { state: WorldState; tank: Machine; head: Machine } {
  const state = createWorld(seed);
  state.unlocked = [TechId.Pumps, TechId.PipedSprinklers];
  state.moneyCents = 10_000_000;

  for (let x = 11; x >= 3; x--) spawnPipe(state, x, 12, LiquidId.Water);
  for (let y = 11; y >= 4; y--) spawnPipe(state, 3, y, LiquidId.Water);

  const tank = spawnMachine(state, MachineKind.Tank, 1, 10)!;
  const head = spawnMachine(state, MachineKind.PipedSprinkler, 2, 8)!;

  rebuildNetworks(state);
  return { state, tank, head };
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
  return waterStatus(
    nameOf(machine.kind as MachineKind),
    m!,
    projection.reservoirs,
    projection.networks,
  );
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
  // **WHAT THIS BLOCK USED TO TEST, AND WHY NONE OF IT IS HERE** (item 140).
  //
  // Four tests stood here and all four are DELETED, because the states they described do not
  // exist rather than because they were awkward to keep:
  //
  //   - "says how full it is"            — `ReservoirView.levelPermille` is gone. A pond has no
  //                                        level; the field was removed, not renamed.
  //   - "NAMES THE HALVED BAND…"         — `RESERVOIR_LOW_PERMILLE` and `ReservoirThrottle` are
  //                                        gone. There is no half-rate band and no threshold, so
  //                                        there is no copy that could outlive a constant.
  //   - "promises recovery at zero"      — a pond cannot reach zero. There is no recharge rate to
  //                                        promise recovery AT.
  //   - "is still in the full band one   — the boundary it guarded is not a boundary any more.
  //      notch ABOVE the mark"             Both sides of it are now the same side.
  //
  // Rewriting any of them against what survived would have produced an assertion with exactly
  // one possible outcome, which passes forever and proves nothing. What replaced them tests the
  // thing that DID survive: the pond is an unlimited source and the pumps on its bank are the
  // finite part, so the straws are what the sentence counts.

  it('counts the pumps on the bank, because that is the only thing about a pond that moves', () => {
    const { state } = plumbedWorld(701);
    stepMany(state, 40);

    const projection = view(state, createWorldView());
    const line = pondStatus(projectedPond(state), projection.machines, projection.reservoirs);

    expect(line).toContain('1 pump on the bank');
    expect(line).toContain('/min');
    // The deleted vocabulary, pinned as absent: if any of it comes back into this sentence it
    // is because someone reintroduced a level, and that is a conversation, not a copy edit.
    expect(line).not.toContain('full');
    expect(line).not.toContain('%');
  });

  it('says so when there is nothing on the bank to take the water', () => {
    // The actionable case, and the one a new player is most likely to be looking at: they have
    // hovered the water because they want some, and the answer is that nothing is taking it.
    const state = createWorld(706);
    const projection = view(state, createWorldView());

    // A starting lot is not empty — it ships with a Sell Bin — so the precondition is about
    // PUMPS, not about machines. Asserted rather than assumed, so this stops being a test of
    // the empty-bank sentence the day the starting lot gains a pump.
    const pumps = projection.machines.filter(
      (m) => machineSpec(m.kind as MachineKind)?.role === MachineRole.Pump,
    );
    expect(pumps, 'a fresh lot has no pumps').toHaveLength(0);
    expect(pondStatus(projectedPond(state), projection.machines, projection.reservoirs)).toBe(
      'pond — all the water you want, and no pump on the bank to take it',
    );
  });

  it('counts a SECOND pump on the same bank, and adds what both of them draw', () => {
    // The number has to actually move, or it is a constant with extra steps. This is the whole
    // argument for the rewritten sentence: throughput is the player's to change, and the way
    // they change it is by putting another straw in.
    const { state } = plumbedWorld(707);
    stepMany(state, 40);

    const projection = view(state, createWorldView());
    const before = pondStatus(projectedPond(state), projection.machines, projection.reservoirs);
    expect(before).toContain('1 pump on the bank');

    // East bank: the pond is 3×3 at (12,13), so (15,13) is adjacent along its right edge.
    spawnMachine(state, MachineKind.Pump, 15, 13);
    rebuildNetworks(state);
    stepMany(state, 40);

    const after = view(state, createWorldView());
    const line = pondStatus(projectedPond(state), after.machines, after.reservoirs);
    expect(line).toContain('2 pumps on the bank');
  });

  it('does not count a pump that is standing in a field', () => {
    // `pondFor` is adjacency, and the pond's sentence has to use the same one the pump's own
    // sentence uses — a pump counted as "on the bank" here while being told it is not one on
    // its own hover would be the two rect tests disagreeing in public.
    const { state } = plumbedWorld(708);
    spawnMachine(state, MachineKind.Pump, 2, 2);
    rebuildNetworks(state);
    stepMany(state, 5);

    const projection = view(state, createWorldView());
    const line = pondStatus(projectedPond(state), projection.machines, projection.reservoirs);
    expect(line, 'the dry-land pump is not on this bank').toContain('1 pump on the bank');
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
  it('reports the rate it is actually drawing', () => {
    const { state, pump } = plumbedWorld(710);
    stepMany(state, 40);

    const line = tellFor(state, pump)!;
    expect(line).toContain('pump — ');
    expect(line).toContain('/min');
    // "pond at 90.0%" used to be the back half of this sentence. There is no level to quote.
    expect(line).not.toContain('pond');
    expect(line).not.toContain('%');
  });

  it('**SAYS A PUMP OFF THE BANK IS DRAWING NOTHING**', () => {
    // The replacement for the deleted half-rate test, and the same lesson one cause over: a
    // pump that is quietly producing nothing is indistinguishable from a broken pump.
    // `pumpSupplyMlPerMinute` grants zero off a bank and the rated flow on one, so this is now
    // the ONLY thing a pond does to a pump — and the only pump-and-pond question left to ask.
    //
    // `guardPlacement` refuses this placement, so it takes a hand-edited save to reach; that is
    // exactly the case `water.ts` says the metered draw exists to refuse, and a sentence that
    // said nothing about it would leave the player with a silent machine.
    const { state } = plumbedWorld(713);
    const stranded = spawnMachine(state, MachineKind.Pump, 2, 2)!;
    rebuildNetworks(state);
    stepMany(state, 20);

    expect(tellFor(state, stranded)).toBe('pump — not on a bank, so it draws nothing');
  });

  it('says a pump with nothing plumbed to it is idle, rather than printing a bare zero', () => {
    const state = createWorld(714);
    state.unlocked = [TechId.Pumps];
    const lonely = spawnMachine(state, MachineKind.Pump, 12, 12)!;
    rebuildNetworks(state);
    stepMany(state, 20);

    expect(projectedMachine(state, lonely).flowMlPerMinute).toBe(0);
    expect(tellFor(state, lonely)).toBe('pump idle — nothing on its pipes is asking for water');
  });

  it('never claims a barrel a pump does not have, in any of its three states', () => {
    // `lampFor` gives a struggling pump `LampState.UtilityMissing`, whose branch in the ribbon
    // reads "barrel dry — click to refill". A pump has no barrel and no click. Swept across
    // every sentence this function can produce rather than the one that happened to be reported.
    const { state, pump } = plumbedWorld(712);
    const stranded = spawnMachine(state, MachineKind.Pump, 2, 2)!;
    rebuildNetworks(state);
    stepMany(state, 20);

    for (const line of [tellFor(state, pump), tellFor(state, stranded)]) {
      expect(line, 'a pump always gets a sentence of its own').not.toBeNull();
      expect(line!, 'the wild goose chase').not.toContain('barrel');
      expect(line!).not.toContain('click to refill');
    }
  });
});

describe('the tank, hovered', () => {
  it('**SHOWS A NET RATE AND A TIME TO EMPTY** — the two numbers it exists for', () => {
    // `data.ts:2591`: the Tank is "the only object in the game that shows a NET RATE and a
    // TIME-TO-EMPTY… it turns 'am I short of water' from a feeling into arithmetic the player
    // can do at a glance". `ticksToEmpty` had never been read by a single line of the app.
    //
    // The old version of this test filled the buffer and then TOOK THE POND AWAY. It cannot do
    // that any more, so it takes the PUMP away instead — which is the same shape of pressure and
    // a state a player can actually build by accident.
    const { state, tank } = unpumpedWorld(720);
    state.machines.find((m) => m.id === tank.id)!.tankMl = 400_000;
    stepMany(state, 30);

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
    stepMany(state, 20);

    const m = projectedMachine(state, tank);
    expect(m.ticksToEmpty).toBe(-1);
    expect(tellFor(state, tank)).not.toContain('empty ');
  });

  it('blames the LINE for an empty tank, because the pond can no longer be the reason', () => {
    // **THE REWRITE OF "blames the pond when the pond is the reason it is empty".** That test
    // asserted the halved-band and empty-pond branches of `tankStatus`, both of which are gone
    // with the model behind them. The surviving branch is the one that was always the honest
    // answer for a buffer: it is empty because the line is outrunning its supply. Kept as a
    // test rather than dropped, because the branch still exists and still has to not say
    // "barrel".
    const { state, tank } = unpumpedWorld(722);
    stepMany(state, 60);

    const m = projectedMachine(state, tank);
    expect(m.lamp, 'the sim calls an empty tank blue').toBe(LampState.UtilityMissing);

    const line = tellFor(state, tank)!;
    expect(line).toContain('EMPTY');
    expect(line).toContain('spending water faster than the pump brings it');
    expect(line).not.toContain('barrel');
    expect(line, 'the pond has nothing to do with it now').not.toContain('pond down');
  });
});

describe('a piped head, hovered', () => {
  it('**NO LONGER TELLS A BARREL-LESS MACHINE TO CLICK ITS BARREL**', () => {
    // The reported defect, at its source. A dry piped head shows the same blue lamp a dry
    // Barrel Sprinkler does, and the ribbon printed the barrel's sentence at both. A player
    // whose field has gone dry hovers a dead head, is told to click it, clicks it, nothing
    // happens — and concludes the pump is the thing that is wrong. Which is what happened.
    const { state, head } = unpumpedWorld(730);
    stepMany(state, 20);

    const m = projectedMachine(state, head);
    expect(m.lamp, 'the head is on the blue lamp — the branch that lied').toBe(
      LampState.UtilityMissing,
    );

    const line = tellFor(state, head);
    expect(line, 'a non-null answer is what makes index.ts skip the barrel branch').not.toBeNull();
    expect(line!).not.toContain('barrel');
    expect(line!).not.toContain('click to refill');
    // The old expectation here was "the pond is empty", which is now an impossible sentence
    // about an impossible state. This lot has pipe, heads and no pump, which is the real cause.
    expect(line!).toContain('no pump is feeding this line');
  });

  it('**NAMES HOW MANY MACHINES ARE SHARING THE LINE, AND WHAT SHARE THEY GET**', () => {
    // **THE REPLACEMENT FOR THE HALVED-BAND TEST**, and the load-bearing one in this block.
    // Before item 140 a short head had three possible causes and the sentence forked on which;
    // two of those causes are deleted, so the remaining one has to carry a NUMBER or the
    // sentence degrades into the "not getting enough water" the old code was filed for saying.
    //
    // `consumerCount` and `flowPermille` are both computed in `view.ts` and, before this, read
    // nowhere in the app — the same "instruments never plugged in" the original item was about.
    const { state, head } = plumbedWorld(733);
    // Crowd the line until one pump cannot cover it. Both pipe runs get heads hung off them,
    // clear of the pond at (12,13) and of the tank's 2×2 at (1,10).
    for (let x = 4; x <= 11; x++) {
      spawnMachine(state, MachineKind.PipedSprinkler, x, 11);
      spawnMachine(state, MachineKind.PipedSprinkler, x, 13);
    }
    rebuildNetworks(state);
    stepMany(state, 60);

    const m = projectedMachine(state, head);
    // The precondition is asserted rather than assumed: if the sim stops throttling this lot,
    // this test must go RED rather than quietly stop exercising the branch it exists for.
    expect(
      m.throttled === 1 || m.lamp === LampState.UtilityMissing,
      'the line has to actually be short for this to be testing anything',
    ).toBe(true);

    const line = tellFor(state, head)!;
    expect(line).toContain('machines on this line');
    expect(line).toContain('of what they ask for');
    expect(line).toMatch(/\d+\.\d%/);
  });

  it('does not tell a DRY head it is getting 100% of what it asks for', () => {
    // **A CONTRADICTION THE FIRST DRAFT OF THIS SENTENCE ACTUALLY PRINTED**, found by reading
    // the output rather than the types. A head goes blue whenever its buffer is under one
    // activation, which includes the whole time it is charging up after being plumbed in — and
    // on those ticks the pump is meeting demand in full. The oversubscription sentence put
    // "DRY" and "getting 100.0% of what they ask for" in one line, which argues with itself and
    // sends the player off to add a pump they do not need.
    const { state, head } = plumbedWorld(734);
    stepMany(state, 60);

    const m = projectedMachine(state, head);
    expect(m.lamp, 'a freshly plumbed head is still blue while it charges').toBe(
      LampState.UtilityMissing,
    );

    const line = tellFor(state, head)!;
    expect(line).toBe('piped sprinkler DRY — still filling, the line is keeping up');
    expect(line, 'the self-contradiction').not.toContain('100.0%');
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
    // way — run a lot for four hundred ticks and trust the head to charge — this test asserts
    // the renderer's contract THROUGH the water layer's balance numbers, and it went red
    // mid-suite when a sim lane retuned them underneath it. What is being tested here is
    // "a Running, unthrottled head gets no sentence"; the intake rate a head charges at is
    // the sim's business and no business of this file's.
    const { state, head } = plumbedWorld(732);
    stepMany(state, 20);
    state.machines.find((m) => m.id === head.id)!.tankMl = 1_000_000;
    stepMany(state, 1);

    const m = projectedMachine(state, head);
    expect(m.lamp).toBe(LampState.Running);
    expect(m.throttled).toBe(0);
    expect(tellFor(state, head)).toBeNull();
  });
});
