// Item 039: the Maintenance Station, the repair drones, and the parts line — maintenance
// promoted from a chore to a supply chain.
//
// The through-line of every test here is §4's thesis, which is also the item's acceptance
// bar: **automation saves your hands, not the bill.** So the tests are as interested in what
// does NOT happen as in what does — no manual touch is ever counted, no untouched clock is
// ever reset, and above all NO SERVICE IS EVER FREE: a station without kits and a bay without
// parts sit there while the factory degrades exactly as if they were scenery, because
// mechanically they are.
//
// The closing test is this feature's golden fixture in the `factory.test.ts` story-watching
// tradition, pinned with an inline hash the way `sim.test.ts` pins its canary: a
// deterministic, command-free world (kola trees → grinder → depot, drone bay on watch) that
// must hold itself steady for 10,000 ticks with zero manual touches.

import { describe, expect, it } from 'vitest';

import {
  type Machine,
  type WorldState,
  BLEED_WINDOW_TICKS,
  BeltTier,
  BotKind,
  BotPhase,
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  CeremonyId,
  ContractPhase,
  DRONE_PART_PRICE_CENTS,
  Direction,
  GrabberTier,
  ITEM_SPECS,
  ItemId,
  LIQUID_SPECS,
  LampState,
  MachineKind,
  REPAIR_KIT_PRICE_CENTS,
  TechId,
  addItem,
  boxedItemForMachine,
  createWorld,
  createWorldView,
  fromPayload,
  hashState,
  isBoxedMachineItem,
  isPurchasable,
  isSellable,
  machineSpec,
  spawnBelt,
  spawnBot,
  spawnGrabber,
  spawnMachine,
  step,
  stepMany,
  techNode,
  tileCentreSubtiles,
  toPayload,
  totalManualTouches,
  view,
} from '../src/index';

function stepEmpty(state: WorldState): void {
  step(state, { tick: state.tick, commands: [] });
}

/** Keep a converter eternally fed and emptied, so wear accrues from real operations. */
function feedAndDrain(machine: Machine): void {
  machine.inputCounts[0] = 5;
  machine.outputCount = 0;
  machine.overcookedCount = 0;
}

/** The machine's view row, for lamp assertions. */
function viewRowFor(state: WorldState, machineId: number) {
  const projected = view(state, createWorldView());
  const row = projected.machines.find((m) => m.id === machineId);
  expect(row).toBeDefined();
  return row!;
}

describe('the Maintenance Station', () => {
  function stationWorld(): { state: WorldState; station: Machine; kitchen: Machine } {
    const state = createWorld(7100);
    const station = spawnMachine(state, MachineKind.MaintenanceStation, 0, 0)!;
    // Footprint x 3..4 — Chebyshev 3 from the station's anchor tile, inside the cell.
    const kitchen = spawnMachine(state, MachineKind.ChipKitchen, 3, 3)!;
    return { state, station, kitchen };
  }

  it('services a wrench-due cell with no player input, for exactly one kit', () => {
    const { state, station, kitchen } = stationWorld();
    station.inputCounts[0] = 2;
    kitchen.condition = 300;
    kitchen.jammed = true;
    kitchen.untouchedTicks = 500;
    const touchesBefore = { ...state.stats.touches };

    stepMany(state, 2);

    expect(kitchen.condition).toBe(CONDITION_MAX);
    expect(kitchen.jammed).toBe(false);
    expect(station.inputCounts[0]).toBe(1);
    expect(state.stats.repairKitsUsed).toBe(1);
    expect(station.opCount).toBe(1);
    // The station is a machine: its own service pass costs its own wear.
    expect(station.condition).toBe(CONDITION_MAX - 2);
    // NOT A HAND. No touch was counted and the serviced machine's untouched clock survives —
    // an automated line being automatically maintained still demonstrates the Corporate
    // Charter's milestone.
    expect(state.stats.touches).toEqual(touchesBefore);
    expect(kitchen.untouchedTicks).toBe(500);
  });

  it('fires when a player would: wrench-due or jammed, never as a top-up', () => {
    const { state, station, kitchen } = stationWorld();
    station.inputCounts[0] = 6;

    // Merely used is not wrench-due. A player does not throw $8 at a machine at 90%.
    kitchen.condition = 900;
    stepMany(state, 50);
    expect(state.stats.repairKitsUsed).toBe(0);
    expect(kitchen.condition).toBe(900);

    // At the threshold exactly the wrench is not yet due (`condition < threshold` is the
    // overlay's own test); one point below it is.
    kitchen.condition = CONDITION_EFFECT_THRESHOLD;
    stepMany(state, 10);
    expect(state.stats.repairKitsUsed).toBe(0);
    kitchen.condition = CONDITION_EFFECT_THRESHOLD - 1;
    stepMany(state, 2);
    expect(state.stats.repairKitsUsed).toBe(1);
    expect(kitchen.condition).toBe(CONDITION_MAX);
  });

  it('starves honestly: no kits means the amber lamp, no service, and real degradation', () => {
    const { state, station, kitchen } = stationWorld();
    station.inputCounts[0] = 0;
    kitchen.condition = 300;

    // The kitchen keeps working — and keeps wearing — while the station stands there starved.
    for (let i = 0; i < 2_000; i++) {
      feedAndDrain(kitchen);
      stepEmpty(state);
    }

    expect(state.stats.repairKitsUsed).toBe(0);
    expect(kitchen.condition).toBeLessThan(300);
    expect(state.stats.inputsWastedByMachine).toBeGreaterThan(0);
    expect(viewRowFor(state, station.id).lamp).toBe(LampState.Starved);

    // And the moment the belt delivers again, service resumes — the lamp was the whole story.
    station.inputCounts[0] = 1;
    stepMany(state, 2);
    expect(state.stats.repairKitsUsed).toBe(1);
    expect(kitchen.condition).toBe(CONDITION_MAX);
    expect(viewRowFor(state, station.id).lamp).toBe(LampState.Starved); // hopper spent again
  });

  it('is belt-fed through the ordinary grabber door, and the belt path costs no touch', () => {
    const state = createWorld(7101);
    const station = spawnMachine(state, MachineKind.MaintenanceStation, 10, 10)!;
    // Belt runs east along y=10 into the grabber at (9,10), which reaches back to (8,10) and
    // places forward onto the station's (10,10) tile — the same recipe-line door a Fryer's
    // potatoes arrive through, because the kit hopper IS a recipe line.
    const belt = spawnBelt(state, BeltTier.Basic, 6, 10, Direction.East, 3)!; // tiles (6..8,10)
    spawnGrabber(state, GrabberTier.Mk1, 9, 10, Direction.East, 0)!;
    belt.items.push({ dist: 700, item: ItemId.RepairKit });

    const touchesBefore = totalManualTouches(state.stats.touches);
    stepMany(state, 100);

    expect(station.inputCounts[0]).toBe(1);
    expect(totalManualTouches(state.stats.touches)).toBe(touchesBefore);
  });
});

describe('the repair drone', () => {
  function droneWorld(): {
    state: WorldState;
    bay: Machine;
    kitchen: Machine;
  } {
    const state = createWorld(7200);
    const bay = spawnMachine(state, MachineKind.DroneBay, 0, 0)!;
    spawnBot(state, BotKind.Repair, bay);
    const kitchen = spawnMachine(state, MachineKind.ChipKitchen, 20, 20)!;
    return { state, bay, kitchen };
  }

  it('flies out, services for one part, and flies home — hands-free end to end', () => {
    const { state, bay, kitchen } = droneWorld();
    bay.cargoItem = ItemId.DronePart;
    bay.cargoCount = 3;
    kitchen.condition = 300;
    kitchen.jammed = true;
    kitchen.untouchedTicks = 777;

    expect(state.ceremonies).not.toContain(CeremonyId.FirstDrone);
    stepMany(state, 1_500);

    const drone = state.bots[0]!;
    expect(kitchen.condition).toBe(CONDITION_MAX);
    expect(kitchen.jammed).toBe(false);
    expect(kitchen.untouchedTicks).toBe(777);
    expect(bay.cargoCount).toBe(2);
    expect(drone.opCount).toBe(1);
    expect(drone.condition).toBe(CONDITION_MAX - 2);
    // Home again, idle, standing on its bay.
    expect(drone.phase).toBe(BotPhase.Idle);
    expect(drone.xSub).toBe(tileCentreSubtiles(bay.tileX));
    expect(drone.ySub).toBe(tileCentreSubtiles(bay.tileY));
    // The spend flowed into the ONE maintenance accumulator, at list (item 039 instr. 8).
    expect(state.stats.repairKitSpendCents).toBe(DRONE_PART_PRICE_CENTS);
    expect(totalManualTouches(state.stats.touches)).toBe(0);
    // First launch got its ceremony, exactly once (instruction 10).
    expect(state.ceremonies.filter((id) => id === CeremonyId.FirstDrone)).toHaveLength(1);
  });

  it('with no parts it sits in its bay — blue lamp, zero repairs, honest degradation', () => {
    const withBay = droneWorld();
    withBay.bay.cargoCount = 0;
    withBay.kitchen.condition = 350;

    const control = createWorld(7200);
    const controlKitchen = spawnMachine(control, MachineKind.ChipKitchen, 20, 20)!;
    controlKitchen.condition = 350;

    for (let i = 0; i < 3_000; i++) {
      feedAndDrain(withBay.kitchen);
      feedAndDrain(controlKitchen);
      stepEmpty(withBay.state);
      stepEmpty(control);
    }

    // The factory degrades EXACTLY as if the player had ignored it — because they have.
    // (Item 039 instruction 4: do not fall back to free repair.)
    expect(withBay.kitchen.condition).toBe(controlKitchen.condition);
    expect(withBay.kitchen.condition).toBeLessThan(350);
    expect(withBay.state.bots[0]!.opCount).toBe(0);
    expect(withBay.state.stats.repairKitSpendCents).toBe(0);
    expect(viewRowFor(withBay.state, withBay.bay.id).lamp).toBe(LampState.UtilityMissing);
    expect(withBay.state.ceremonies).not.toContain(CeremonyId.FirstDrone);
  });

  it('serves the whole lot from a wrapping cursor: two worn machines both get a visit', () => {
    const { state, bay } = droneWorld();
    bay.cargoItem = ItemId.DronePart;
    bay.cargoCount = 12;
    const near = spawnMachine(state, MachineKind.Washer, 10, 0)!;
    const far = spawnMachine(state, MachineKind.Fryer, 30, 30)!;
    near.condition = 100;
    far.condition = 100;

    stepMany(state, 4_000);

    expect(near.condition).toBe(CONDITION_MAX);
    expect(far.condition).toBe(CONDITION_MAX);
    expect(bay.cargoCount).toBe(10);
    expect(state.stats.repairKitSpendCents).toBe(2 * DRONE_PART_PRICE_CENTS);
  });
});

describe('the parts line', () => {
  it('the Parts Bench turns a bottle and kola powder into a drone part, like any converter', () => {
    const state = createWorld(7300);
    const bench = spawnMachine(state, MachineKind.PartsBench, 0, 0)!;
    const spec = machineSpec(MachineKind.PartsBench)!;
    expect(spec.inputs.map((line) => line.item)).toEqual([ItemId.Bottle, ItemId.KolaPowder]);
    expect(spec.outputItem).toBe(ItemId.DronePart);

    bench.inputCounts[0] = 1;
    bench.inputCounts[1] = 1;
    stepMany(state, 40);

    expect(bench.outputCount).toBe(1);
    expect(bench.inputCounts[0]).toBe(0);
    expect(bench.inputCounts[1]).toBe(0);
    expect(state.stats.itemsProducedByMachine).toBe(1);
  });

  it('parts are manufactured only — never purchasable — and the graph stays under the cap', () => {
    expect(isPurchasable(ItemId.DronePart)).toBe(false);
    // Over-producers keep an exit (§4's floor), like Fertilizer.
    expect(isSellable(ItemId.DronePart)).toBe(true);

    // §5's ~50-item recipe-graph cap, counted the way `data.ts` counts it: real items plus
    // liquids, boxed machines excluded (nothing eats one, nothing makes one).
    const graphItems = ITEM_SPECS.filter((spec) => !isBoxedMachineItem(spec.id)).length;
    expect(graphItems).toBe(35);
    expect(graphItems + LIQUID_SPECS.length).toBeLessThanOrEqual(50);
  });
});

describe('the tech joints (§3, by name)', () => {
  it('drones need diagnostics AND trucking, and every new machine hangs off a real node', () => {
    const drones = techNode(TechId.Drones)!;
    expect(drones.requires).toContain(TechId.Diagnostics);
    expect(drones.requires).toContain(TechId.Trucking);

    const diagnostics = techNode(TechId.Diagnostics)!;
    expect(diagnostics).not.toBeNull();

    expect(machineSpec(MachineKind.MaintenanceStation)!.requiresTech).toBe(TechId.Diagnostics);
    expect(machineSpec(MachineKind.DroneBay)!.requiresTech).toBe(TechId.Drones);
    expect(machineSpec(MachineKind.PartsBench)!.requiresTech).toBe(TechId.Drones);

    // Every new machine has a box, so pick-up-and-move works on day one.
    expect(boxedItemForMachine(MachineKind.MaintenanceStation)).toBe(
      ItemId.BoxedMaintenanceStation,
    );
    expect(boxedItemForMachine(MachineKind.DroneBay)).toBe(ItemId.BoxedDroneBay);
    expect(boxedItemForMachine(MachineKind.PartsBench)).toBe(ItemId.BoxedPartsBench);
  });
});

describe('diagnostics: cash bled in the last 60 seconds', () => {
  it('prices wasted inputs per machine, and the window forgets what has aged out', () => {
    const state = createWorld(7400);
    const kitchen = spawnMachine(state, MachineKind.ChipKitchen, 0, 0)!;
    kitchen.condition = 350;

    for (let i = 0; i < 2_000; i++) {
      feedAndDrain(kitchen);
      kitchen.jammed = false; // the subject is the waste cadence, not the jam
      stepEmpty(state);
    }

    expect(state.stats.inputsWastedByMachine).toBeGreaterThan(0);
    const bleeding = viewRowFor(state, kitchen.id).bleedCentsLast60s;
    expect(bleeding).toBeGreaterThan(0);
    // Every wasted operation swallowed one 200¢ potato; the window is a multiple of that.
    expect(bleeding % 200).toBe(0);

    // Left alone for a full window — hopper emptied, so no new operations and no new waste —
    // the ledger reads zero: "right now", not "ever".
    kitchen.inputCounts[0] = 0;
    stepMany(state, BLEED_WINDOW_TICKS + 10);
    expect(viewRowFor(state, kitchen.id).bleedCentsLast60s).toBe(0);
  });

  it('never reaches the hash or the save, like every presentation signal', () => {
    const state = createWorld(7401);
    const kitchen = spawnMachine(state, MachineKind.ChipKitchen, 0, 0)!;
    const before = hashState(state);
    kitchen.bleedEvents.push({ tick: 1, cents: 12_345 });
    expect(hashState(state)).toBe(before);

    const restored = fromPayload(toPayload(state));
    expect(restored.machines[restored.machines.length - 1]!.bleedEvents).toEqual([]);
    expect(hashState(restored)).toBe(before);
  });
});

describe('format-12 rides for the new roster', () => {
  it('a world with all three machines and a mid-flight drone round-trips byte-for-byte', () => {
    const state = createWorld(7500);
    const station = spawnMachine(state, MachineKind.MaintenanceStation, 0, 0)!;
    station.inputCounts[0] = 3;
    spawnMachine(state, MachineKind.PartsBench, 5, 0);
    const bay = spawnMachine(state, MachineKind.DroneBay, 10, 0)!;
    const drone = spawnBot(state, BotKind.Repair, bay);
    bay.cargoItem = ItemId.DronePart;
    bay.cargoCount = 7;
    const patient = spawnMachine(state, MachineKind.Fryer, 20, 20)!;
    patient.condition = 200;

    // Catch the drone genuinely mid-errand, then save.
    stepMany(state, 60);
    expect(drone.phase).not.toBe(BotPhase.Idle);

    const restored = fromPayload(toPayload(state));
    expect(hashState(restored)).toBe(hashState(state));
    expect(restored.bots[0]!.kind).toBe(BotKind.Repair);

    // And the copy keeps living the same life: both worlds step identically.
    stepMany(state, 500);
    stepMany(restored, 500);
    expect(hashState(restored)).toBe(hashState(state));
  });
});

describe('§4: automation saves your hands, not the bill', () => {
  /**
   * Four Chip Kitchens run flat out for one active hour, serviced two ways. The MANUAL world
   * throws $8 kits by hand (through the real reducer) whenever the wrench comes due; the
   * AUTOMATED world has a drone bay the test keeps supplied with parts, standing in for the
   * parts belt. The item's acceptance bar is that the automated bill is not lower.
   *
   * The numbers land in the assertion below and in the work item's agent log. The asymmetry
   * doing the work is the design's own: a kit services the whole 7×7 cell for $8, a drone
   * services ONE machine per $4 part — so four kitchens cost ~$8 per wear cycle by hand and
   * ~$16 by drone. Hands saved; bill up.
   */
  const HOUR_TICKS = 72_000;

  function runManualHour(): { spendCents: number; kitchens: Machine[] } {
    const state = createWorld(7600);
    const kitchens = [
      spawnMachine(state, MachineKind.ChipKitchen, 0, 0)!,
      spawnMachine(state, MachineKind.ChipKitchen, 2, 0)!,
      spawnMachine(state, MachineKind.ChipKitchen, 4, 0)!,
      spawnMachine(state, MachineKind.ChipKitchen, 6, 0)!,
    ];
    // The farmer stands in the middle of the cell for the whole shift.
    state.player.xSub = tileCentreSubtiles(3);
    state.player.ySub = tileCentreSubtiles(2);

    for (let i = 0; i < HOUR_TICKS; i++) {
      for (const kitchen of kitchens) feedAndDrain(kitchen);
      const due = kitchens.some((k) => k.condition < CONDITION_EFFECT_THRESHOLD || k.jammed);
      if (due) {
        addItem(state, ItemId.RepairKit, 1);
        step(state, {
          tick: state.tick,
          commands: [{ type: 'UseRepairKit', tileX: 3, tileY: 2 }],
        });
      } else {
        stepEmpty(state);
      }
    }
    // Kit spend is counted at the till; the test bought its kits off-ledger, so the honest
    // hourly bill is kits actually consumed at the posted $8.
    return { spendCents: state.stats.repairKitsUsed * REPAIR_KIT_PRICE_CENTS, kitchens };
  }

  function runAutomatedHour(): { spendCents: number; kitchens: Machine[] } {
    const state = createWorld(7600);
    const kitchens = [
      spawnMachine(state, MachineKind.ChipKitchen, 0, 0)!,
      spawnMachine(state, MachineKind.ChipKitchen, 2, 0)!,
      spawnMachine(state, MachineKind.ChipKitchen, 4, 0)!,
      spawnMachine(state, MachineKind.ChipKitchen, 6, 0)!,
    ];
    const bay = spawnMachine(state, MachineKind.DroneBay, 10, 0)!;
    spawnBot(state, BotKind.Repair, bay);

    for (let i = 0; i < HOUR_TICKS; i++) {
      for (const kitchen of kitchens) feedAndDrain(kitchen);
      // The parts belt, played by the test: the hopper never runs dry.
      bay.cargoItem = ItemId.DronePart;
      bay.cargoCount = 12;
      stepEmpty(state);
    }
    expect(totalManualTouches(state.stats.touches)).toBe(0);
    // Drone services accrue at list into the one maintenance accumulator.
    return { spendCents: state.stats.repairKitSpendCents, kitchens };
  }

  it('an hour of automated maintenance costs at least what the hand paid', () => {
    const manual = runManualHour();
    const automated = runAutomatedHour();

    // Both shifts really ran a maintenance regime, not an idle afternoon.
    expect(manual.spendCents).toBeGreaterThan(0);
    expect(automated.spendCents).toBeGreaterThan(0);
    for (const kitchen of automated.kitchens) {
      expect(kitchen.opCount).toBeGreaterThan(100);
    }

    // §4, measured: the bill did not fall when the hands left.
    expect(automated.spendCents).toBeGreaterThanOrEqual(manual.spendCents);
  });
});

// --- the golden story: a factory that keeps itself alive ------------------------------
//
// Two kola trees feed a grinder; the grinder's powder rides a grabber into a depot with a
// standing contract; a supplied drone bay watches the lot. Nobody touches anything for
// 10,000 ticks, and the story assertions check the fixture is still telling the truth —
// production continued, the drone did the maintenance, the goods shipped — while the inline
// hash pins the replay byte-for-byte, the same way `sim.test.ts` pins its canary. A NEW pin:
// no prior hash moved to make room for it.

describe('golden story: the supplied drone bay holds the factory steady', () => {
  function maintenanceFactory(): {
    state: WorldState;
    grinder: Machine;
    bay: Machine;
  } {
    const state = createWorld(90390);

    spawnMachine(state, MachineKind.KolaTree, 0, 0);
    spawnMachine(state, MachineKind.KolaTree, 6, 0);
    const grinder = spawnMachine(state, MachineKind.Grinder, 3, 0)!;
    spawnGrabber(state, GrabberTier.Mk1, 2, 0, Direction.East, 0); // west tree → grinder
    spawnGrabber(state, GrabberTier.Mk1, 5, 0, Direction.West, 0); // east tree → grinder
    const depot = spawnMachine(state, MachineKind.TruckDepot, 3, 3)!;
    spawnGrabber(state, GrabberTier.Mk1, 3, 2, Direction.South, 0); // grinder → depot

    state.contracts.push({
      id: state.nextContractId,
      depotId: depot.id,
      item: ItemId.KolaPowder,
      quantityPerRun: 10,
      destination: 'Diagnostics Row',
      stocked: 0,
      inTransit: 0,
      phase: ContractPhase.Waiting,
      ticksRemaining: 0,
      runsCompleted: 0,
      grossCents: 0,
    });
    state.nextContractId += 1;

    const bay = spawnMachine(state, MachineKind.DroneBay, 8, 3)!;
    spawnBot(state, BotKind.Repair, bay);
    bay.cargoItem = ItemId.DronePart;
    bay.cargoCount = 10;

    // The grinder arrives worn from a previous life, so the watch begins with a patient:
    // it crosses the wrench threshold early in the run and the drone must catch it.
    grinder.condition = 420;
    return { state, grinder, bay };
  }

  it('runs 10,000 ticks with zero manual touches, and the drone keeps it healthy', () => {
    const { state, grinder, bay } = maintenanceFactory();

    let minCondition = CONDITION_MAX;
    for (let i = 0; i < 10_000; i++) {
      stepEmpty(state);
      if (grinder.condition < minCondition) minCondition = grinder.condition;
    }

    // Zero manual touches — the whole point of the rung (and there were zero commands).
    expect(totalManualTouches(state.stats.touches)).toBe(0);
    expect(state.trace).toHaveLength(0);

    // The factory actually worked the whole time: trees fruited, the grinder ground.
    expect(grinder.opCount).toBeGreaterThan(40);
    expect(state.stats.itemsProducedByMachine).toBeGreaterThan(40);

    // The wrench came due and a drone answered it: parts were spent, the worn regime was
    // brushed rather than lived in, and the machine ends the watch healthy.
    expect(minCondition).toBeLessThan(CONDITION_EFFECT_THRESHOLD);
    expect(state.bots[0]!.opCount).toBeGreaterThanOrEqual(1);
    expect(bay.cargoCount).toBeLessThan(10);
    expect(state.stats.repairKitSpendCents).toBeGreaterThanOrEqual(DRONE_PART_PRICE_CENTS);
    expect(grinder.condition).toBeGreaterThan(CONDITION_EFFECT_THRESHOLD);
    expect(state.stats.inputsWastedByMachine).toBeLessThanOrEqual(3);

    // The goods left on a truck, unassisted, and the ceremonies marked both first times.
    expect(state.stats.automatedGrossCents).toBeGreaterThan(0);
    expect(state.ceremonies).toContain(CeremonyId.FirstDrone);
    expect(state.ceremonies).toContain(CeremonyId.FirstTruck);

    // The inline golden. Regenerate deliberately or not at all — a move here is a real
    // behaviour change in the maintenance loop and must be enumerated like any golden.
    // cba8a24b -> fbdf6072 with format 13 (item 066): the digest gained the field tiles'
    // coordinates and the soil-memory ledger. Every story assertion above held unchanged.
    expect(hashState(state)).toBe('fbdf6072');
  });
});
