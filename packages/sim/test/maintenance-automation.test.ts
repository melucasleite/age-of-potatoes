// Item 039's maintenance tier, as item 090 left it: the Maintenance Station, the repair
// drones, and the retirement of the parts line that used to sit under them.
//
// **THE THESIS THIS FILE MEASURES CHANGED, AND IT SAYS SO RATHER THAN QUIETLY DRIFTING.** Item
// 039 built the whole tier around §4's *"automation saves your hands, not the bill"* and pinned
// it as an acceptance bar: no service was ever free, a bay without parts sat there while the
// factory rotted, and one test measured that the automated bill did NOT fall. The owner
// repealed that for drones — *"The drone bay shouldn't require parts. It should just fix
// stuff."* — so the ladder's two rungs now say different things, and both are tested:
//
//   * **The Maintenance Station still buys its way.** Real $8 kits off a real belt, and it
//     starves honestly: no kits, no service, amber lamp, a factory that degrades exactly as if
//     it were scenery. Every "nothing is free" test here that survives is about the station.
//   * **The drone is free after the capital.** Buy the node and the hangar and maintenance
//     stops being a running cost at all. The test that used to prove the bill did not fall now
//     proves the opposite by the same method, which is the honest way to record a repeal — the
//     measurement stays, the expectation flips, and nobody has to take a comment's word for it.
//
// What did NOT change is anything about hands: no manual touch is ever counted and no untouched
// clock is ever reset, so the Hands-Free board and the Corporate Charter are unaffected.
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
  MACHINE_SPECS,
  MachineKind,
  REPAIR_KIT_PRICE_CENTS,
  TECH_NODES,
  TechId,
  addBoxedMachine,
  addItem,
  boxedItemForMachine,
  boxedMachineScrapCents,
  createWorld,
  createWorldView,
  fromPayload,
  hashState,
  insertUnlocked,
  isBoxedMachineItem,
  isMachineRetired,
  isPurchasable,
  isSellable,
  itemCount,
  listPriceCents,
  machineSpec,
  machineWantsService,
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
    belt.items.push({ dist: 700, item: ItemId.RepairKit, freshTicks: 0 });

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

  it('flies out of an EMPTY bay, services for nothing, and flies home', () => {
    const { state, bay, kitchen } = droneWorld();
    // **NOTHING IS PUT IN THE BAY, AND THAT IS THE TEST** (item 090's first criterion). This
    // used to stock the hopper with three parts and assert two remained; a bay now has no
    // hopper to stock, so the assertion is that an empty shed is a working shed.
    expect(bay.cargoItem).toBe(0);
    expect(bay.cargoCount).toBe(0);
    kitchen.condition = 300;
    kitchen.jammed = true;
    kitchen.untouchedTicks = 777;

    expect(state.ceremonies).not.toContain(CeremonyId.FirstDrone);
    stepMany(state, 1_500);

    const drone = state.bots[0]!;
    expect(kitchen.condition).toBe(CONDITION_MAX);
    expect(kitchen.jammed).toBe(false);
    expect(kitchen.untouchedTicks).toBe(777);
    expect(bay.cargoCount).toBe(0);
    expect(drone.opCount).toBe(1);
    expect(drone.condition).toBe(CONDITION_MAX - 2);
    // Home again, idle, standing on its bay.
    expect(drone.phase).toBe(BotPhase.Idle);
    expect(drone.xSub).toBe(tileCentreSubtiles(bay.tileX));
    expect(drone.ySub).toBe(tileCentreSubtiles(bay.tileY));
    // **THE BOOKS DID NOT MOVE.** The old assertion here was `toBe(DRONE_PART_PRICE_CENTS)`.
    // The kit-spend row means kits now — bought at a till, thrown by a hand or a station — and
    // a drone's service is not one, so it is not in it.
    expect(state.stats.repairKitSpendCents).toBe(0);
    expect(totalManualTouches(state.stats.touches)).toBe(0);
    // First launch got its ceremony, exactly once (instruction 10).
    expect(state.ceremonies.filter((id) => id === CeremonyId.FirstDrone)).toHaveLength(1);
  });

  it('keeps the factory healthy where an unwatched one rots, for no running cost at all', () => {
    // The exact shape of the test this replaces — a bay world against an identical control —
    // with the expectation inverted. It used to prove that an unsupplied bay let the factory
    // degrade *exactly* as if it were scenery; the two worlds now have to come apart, because
    // there is no such thing as an unsupplied bay.
    const withBay = droneWorld();
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

    expect(controlKitchen.condition).toBeLessThan(350);
    expect(withBay.kitchen.condition).toBeGreaterThan(controlKitchen.condition);
    expect(withBay.state.bots[0]!.opCount).toBeGreaterThan(0);
    // Free means free: three thousand ticks of service, nothing on the ledger.
    expect(withBay.state.stats.repairKitSpendCents).toBe(0);
    // NO LAMP OF ITS OWN. The bay used to show `UtilityMissing` — blue, "a utility is missing" —
    // on an empty hopper. It has no utility to miss, so it reads like the other two docks.
    expect(viewRowFor(withBay.state, withBay.bay.id).lamp).toBe(LampState.Off);
    expect(withBay.state.ceremonies).toContain(CeremonyId.FirstDrone);
  });

  it('serves the whole lot from a wrapping cursor: two worn machines both get a visit', () => {
    const { state } = droneWorld();
    const near = spawnMachine(state, MachineKind.Washer, 10, 0)!;
    const far = spawnMachine(state, MachineKind.Fryer, 30, 30)!;
    near.condition = 100;
    far.condition = 100;

    stepMany(state, 4_000);

    expect(near.condition).toBe(CONDITION_MAX);
    expect(far.condition).toBe(CONDITION_MAX);
    expect(state.stats.repairKitSpendCents).toBe(0);
  });

  it('repairs a DOCK by repairing the robots asleep in it', () => {
    // **THE OWNER'S BUG, PINNED** — reported during item 090 as *"The drone is not repairing the
    // docks"*, and it long predates this item. A dock's `wearPerOperation` is 0, so its own
    // condition never falls and it can never jam; the drone's eligibility test read only those
    // two fields, so a shed full of worn Agri-Bots looked like a machine in perfect health and
    // the drone flew past it forever. The hand's kit and the Maintenance Station both already
    // carried the missing clause, which is why this was a drift bug rather than a design gap —
    // and why the fix was to give all three ONE predicate (`machineWantsService`).
    const { state, bay } = droneWorld();
    const dock = spawnMachine(state, MachineKind.HarvesterDock, 12, 12)!;
    const worker = spawnBot(state, BotKind.Harvester, dock)!;
    worker.condition = 100;

    // The shed itself is the picture of health, and always will be. That is the whole trap.
    expect(dock.condition).toBe(CONDITION_MAX);
    expect(dock.jammed).toBe(false);
    expect(machineSpec(MachineKind.HarvesterDock)!.wearPerOperation).toBe(0);
    expect(machineWantsService(state, dock)).toBe(true);

    stepMany(state, 4_000);

    // The drone flew there, and — the second half of the fix — actually achieved something:
    // restoring only `dock.condition` would have been a wasted errand to a full-health shed.
    expect(worker.condition).toBe(CONDITION_MAX);
    expect(machineWantsService(state, dock)).toBe(false);
    expect(state.bots.find((b) => b.dockId === bay.id)!.opCount).toBeGreaterThan(0);
    // And the player can see what the drone saw: the wrench overlay reads the same clause.
    expect(viewRowFor(state, dock.id).wrenchDue).toBe(0);
  });
});

describe('the parts line, retired (item 090)', () => {
  it('cannot be built any more — not for money, and not out of a box', () => {
    const state = createWorld(7300);
    state.moneyCents = 10_000_000;
    for (const node of TECH_NODES) insertUnlocked(state.unlocked, node.id);

    expect(isMachineRetired(MachineKind.PartsBench)).toBe(true);
    const before = state.machines.length;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'PlaceMachine', kind: MachineKind.PartsBench, tileX: 0, tileY: 0 }],
    });
    expect(state.machines.length).toBe(before);
    // A refused command is not in the trace, because it did not happen.
    expect(state.trace).toHaveLength(0);

    // And the box in the bag is not a back door: the same refusal, before the box is spent.
    addBoxedMachine(state, ItemId.BoxedPartsBench, {
      speedLevel: 0,
      efficiencyLevel: 0,
      capacityLevel: 0,
      condition: CONDITION_MAX,
      investedCents: 80_000,
    });
    step(state, {
      tick: state.tick,
      commands: [{ type: 'PlaceMachine', kind: MachineKind.PartsBench, tileX: 0, tileY: 0 }],
    });
    expect(state.machines.length).toBe(before);
    // NOTHING WAS EATEN BY THE REFUSAL. The box is still there to be scrapped.
    expect(itemCount(state, ItemId.BoxedPartsBench)).toBe(1);
  });

  it('keeps its spec, its box and its scrap value, so nobody who owns one is robbed', () => {
    // THE HEADSTONE IS LOAD-BEARING. A retired kind that lost its spec would leave a box in
    // somebody's bag with no slug to name itself by and no invoice to scrap against — which is
    // how a design change turns into a theft. So the spec stays, unedited, and every path a
    // BOX walks still works.
    const spec = machineSpec(MachineKind.PartsBench)!;
    expect(spec.slug).toBe('parts-bench');
    expect(spec.inputs.map((line) => line.item)).toEqual([ItemId.Bottle, ItemId.KolaPowder]);
    expect(spec.outputItem).toBe(ItemId.DronePart);
    expect(boxedItemForMachine(MachineKind.PartsBench)).toBe(ItemId.BoxedPartsBench);

    const state = createWorld(7301);
    addBoxedMachine(state, ItemId.BoxedPartsBench, {
      speedLevel: 1,
      efficiencyLevel: 0,
      capacityLevel: 0,
      condition: 900,
      investedCents: 112_000,
    });
    const before = state.moneyCents;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SellBoxedMachine', item: ItemId.BoxedPartsBench }],
    });
    // 40% of the real invoice, dials included — the same arithmetic every other box gets.
    expect(state.moneyCents - before).toBe(boxedMachineScrapCents(112_000));
    expect(itemCount(state, ItemId.BoxedPartsBench)).toBe(0);
  });

  it('leaves the drone part with no source, no consumer, and a price', () => {
    // It is nobody's ingredient and nobody's output now, so the only thing left to do with a
    // warehouse of them is sell them — which §4's floor says must always be possible.
    expect(isPurchasable(ItemId.DronePart)).toBe(false);
    expect(isSellable(ItemId.DronePart)).toBe(true);
    expect(listPriceCents(ItemId.DronePart)).toBe(DRONE_PART_PRICE_CENTS);

    const producers = MACHINE_SPECS.filter(
      (spec) => spec.outputItem === ItemId.DronePart && !isMachineRetired(spec.kind),
    );
    const consumers = MACHINE_SPECS.filter((spec) =>
      spec.inputs.some((line) => line.item === ItemId.DronePart),
    );
    expect(producers).toHaveLength(0);
    expect(consumers).toHaveLength(0);

    // §5's ~50-item recipe-graph cap, counted the way `data.ts` counts it: real items plus
    // liquids, boxed machines excluded (nothing eats one, nothing makes one).
    // 35 until item 111 spent nine of the remaining ten on the flavour tier, and 44 until item
    // 131 spent **THE LAST ONE** on `ItemId.UsedBottle`. The two assertions below now meet:
    // 45 + 5 is 50, the ceiling is 50, and the cap has stopped being a headroom note. The next
    // feature that wants a node buys a raise from the owner — which is precisely why the exact
    // number is pinned beside the ceiling rather than only the ceiling.
    //
    // Item 131 got that node for one item instead of two by putting the recipe on the WASHER
    // rather than building a Recycling Centre (owner's ruling, 2026-08-17). The alternative
    // would have read 46 + 5 here and been over.
    const graphItems = ITEM_SPECS.filter((spec) => !isBoxedMachineItem(spec.id)).length;
    expect(graphItems).toBe(45);
    expect(graphItems + LIQUID_SPECS.length).toBe(50);
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

describe('§4 repealed at the top rung: the drone hour costs nothing (item 090)', () => {
  /**
   * **THE MEASUREMENT ITEM 039 BUILT, KEPT, AND POINTING THE OTHER WAY.**
   *
   * Four Chip Kitchens run flat out for one active hour, serviced two ways. The MANUAL world
   * throws $8 kits by hand through the real reducer whenever the wrench comes due; the
   * AUTOMATED world has a drone bay watching, and — the change — nothing feeding it, because
   * there is nothing to feed it with.
   *
   * Item 039's bar was `automated >= manual`: a drone burned a $4 part per machine against a
   * kit's $8 per 7×7 CELL, so four kitchens cost ~$8 a wear cycle by hand and ~$16 by drone,
   * and *"automation saves your hands, not the bill"* was a fact you could read off one
   * accumulator. The owner repealed it. The world it measured is gone, so the honest thing is
   * not to delete the test but to invert it: same two shifts, same reducer, and the automated
   * bill is now exactly zero while the manual one is not. **The comparison is still a
   * comparison** — that is what stops "free" being a claim only a comment makes.
   *
   * What survives of §4's thesis is the rung below, which this file's Maintenance Station
   * tests still hold to the letter: kits, a belt, and an honest starve.
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
      stepEmpty(state);
    }
    expect(totalManualTouches(state.stats.touches)).toBe(0);
    // The bay was never touched and never stocked — there are three lines missing here that
    // used to refill its hopper every tick, standing in for a parts belt that no longer exists.
    expect(bay.cargoItem).toBe(0);
    expect(bay.cargoCount).toBe(0);
    return { spendCents: state.stats.repairKitSpendCents, kitchens };
  }

  it('an hour by hand bills real money; the same hour by drone bills nothing', () => {
    const manual = runManualHour();
    const automated = runAutomatedHour();

    // Both shifts really ran a maintenance regime, not an idle afternoon: the hand's hour cost
    // money, and the drone's hour kept four machines turning past a hundred operations each.
    expect(manual.spendCents).toBeGreaterThan(0);
    for (const kitchen of automated.kitchens) {
      expect(kitchen.opCount).toBeGreaterThan(100);
      expect(kitchen.condition).toBeGreaterThan(CONDITION_EFFECT_THRESHOLD);
    }

    // The repeal, measured. `expect(automated).toBeGreaterThanOrEqual(manual)` stood here for
    // eleven items; free-after-capital is the whole of item 090 and this is where it is a fact.
    expect(automated.spendCents).toBe(0);
    expect(automated.spendCents).toBeLessThan(manual.spendCents);
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
      stockedFreshTicks: 0,
      inTransit: 0,
      inTransitFreshTicks: 0,
      phase: ContractPhase.Waiting,
      ticksRemaining: 0,
      runsCompleted: 0,
      grossCents: 0,
    });
    state.nextContractId += 1;

    // An EMPTY bay, because there is no other kind (item 090). The two lines that stocked it
    // with ten parts are gone, and with them the fixture's only supply-chain beat.
    const bay = spawnMachine(state, MachineKind.DroneBay, 8, 3)!;
    spawnBot(state, BotKind.Repair, bay);

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

    // The wrench came due and a drone answered it: the worn regime was brushed rather than
    // lived in, and the machine ends the watch healthy — for nothing. The two assertions that
    // stood here counted parts off the shelf and cents onto the ledger; both are now zero by
    // construction, so the shelf is asserted empty and the ledger asserted untouched instead.
    expect(minCondition).toBeLessThan(CONDITION_EFFECT_THRESHOLD);
    expect(state.bots[0]!.opCount).toBeGreaterThanOrEqual(1);
    expect(bay.cargoCount).toBe(0);
    expect(state.stats.repairKitSpendCents).toBe(0);
    expect(grinder.condition).toBeGreaterThan(CONDITION_EFFECT_THRESHOLD);
    expect(state.stats.inputsWastedByMachine).toBeLessThanOrEqual(3);

    // The goods left on a truck, unassisted, and the ceremonies marked both first times.
    expect(state.stats.automatedGrossCents).toBeGreaterThan(0);
    expect(state.ceremonies).toContain(CeremonyId.FirstDrone);
    expect(state.ceremonies).toContain(CeremonyId.FirstTruck);

    // The inline golden. Regenerate deliberately or not at all — a move here is a real
    // behaviour change in the maintenance loop and must be enumerated like any golden.
    // 27f06a83 -> 9b28460d in wave 14 (item 110): the digest gained `machine.cargoFreshTicks`
    // (save format 18), the clock a container's cargo is running on. Checked rather than
    // assumed: with that one line held out of the digest this watch reproduces 27f06a83
    // exactly, so nothing it does changed — no storage machine is built in it and nothing
    // perishable is ever put in a box. Every story assertion above is untouched.
    // b26e8c41 -> 27f06a83 in wave 13 (item 090): THE BAY STARTS EMPTY AND STAYS EMPTY. The
    // fixture used to stock it with ten drone parts and spend them one per fix, so the hash
    // carried a machine's cargo pair and a lifetime spend accumulator that no longer move —
    // and this is the deliberate kind of move, not a re-time. Every story assertion above is
    // unchanged and still passing, including the ones that matter most here: the wrench came
    // due, the drone answered, the factory ends the watch healthy and shipped its goods.
    // ff316263 -> b26e8c41 in wave 12 (item 088): the digest gained the bot's seed pocket and
    // every machine's seed shelf, all four zero here — this world's only robot is a REPAIR
    // drone, which harvests nothing and can therefore pocket nothing. Every story assertion
    // above is untouched, which is the claim: four new zeroes, no new behaviour.
    // fbdf6072 -> ff316263 in wave 11 (items 073 + 075): the can starts at 20 charges
    // instead of 8 (`player.canCharges` is hashed) and the digest gained
    // `stats.cheatsUsed`. Every story assertion above is untouched.
    // cba8a24b -> fbdf6072 with format 13 (item 066): the digest gained the field tiles'
    // coordinates and the soil-memory ledger. Every story assertion above held unchanged.
    // 9b28460d -> 7906cb45 (save format 19, item 111): the digest gained `machine.outputItem`.
    // This world's Grinder makes one thing and its basket says so, so the value written is the
    // one the spec always implied — with the `d.num` held out of the digest the watch
    // reproduces 9b28460d exactly. Every story assertion above is untouched: the wrench came
    // due, the drone answered, and the factory ended the watch healthy.
    // 7906cb45 -> ab8ef078 (save format 20, item 112): the digest gained the four other places a
    // good can sit and grow old — `machine.inputFreshTicks`, `machine.outputFreshTicks`,
    // `Grabber.heldFreshTicks`, and `freshTicks` on every belt item. **This one deserved the
    // check more than any hash in the repository**, because unlike the two above it, item 112
    // changed BEHAVIOUR: goods in hoppers, baskets, claws and belts now spend a clock, and this
    // watch is ten thousand ticks of a factory doing exactly that with nobody touching it. If
    // anything on this line was going to turn to compost mid-watch, here is where it would. With
    // the four `d.num` families held out of the digest, the watch reproduces 7906cb45 exactly —
    // so nothing spoiled, nothing composted, and every story assertion above is untouched.
    // ab8ef078 -> 68f7accb (save format 21, item 115): the digest gained the last two places a
    // good can sit and grow old — a standing route's floor and lorry (`Contract.stockedFreshTicks`,
    // `Contract.inTransitFreshTicks`) and an Agri-Bot's arms (`Bot.carryFreshTicks`). This watch
    // has a depot on a Kola Powder route and no harvester at all, so all three write the same
    // zeroes every tick: Kola Powder is shelf-stable, and this world's only robot is a REPAIR
    // drone, which carries nothing. With the three `d.num` calls held out of the digest the watch
    // reproduces ab8ef078 exactly — meaning every other hashed field is byte-identical, so item
    // 115 changed no behaviour here even though it changed behaviour elsewhere. The wrench came
    // due, the drone answered, and the factory ended the watch healthy.
    expect(hashState(state)).toBe('68f7accb');
  });
});
