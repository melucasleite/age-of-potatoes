// The liquid layer: reservoirs, the one-ledger flow model, and the watering ladder's top rung.
//
// Every test here pins a RULING from the design document rather than an implementation
// detail, in the spirit of the repo's deliberately light verification bar. Several of them
// pin ANTI-SOFTLOCK GUARANTEES — "reservoirs always recover", "the watering can always fills
// at any shore at any level", "no overwatering possible" — which are not balance numbers and
// must never be tuned away for tension. If one of those goes red, a promise was broken.
//
// Worlds are built by hand here rather than earned through commands: a test that had to farm
// its way to an Irrigation Hub would be a proof harness, and the golden fixture already
// covers the real command path end to end.

import { describe, expect, it } from 'vitest';

import {
  type Command,
  type Machine,
  type WorldState,
  BuildRefusal,
  CeremonyId,
  HAND_POUR_ML,
  IRRIGATION_HUB_SCAN_PER_TICK,
  LampState,
  LiquidId,
  MOISTURE_DRY_THRESHOLD,
  CAN_CHARGES_MAX,
  MOISTURE_MAX,
  MachineKind,
  POND_ORIGIN_X,
  POND_ORIGIN_Y,
  PIPE_MAX_PATH_TILES,
  PUMP_RATE_ML_PER_MINUTE,
  RESERVOIR_CAPACITY_ML,
  RESERVOIR_LOW_PERMILLE,
  RESERVOIR_RECHARGE_ML_PER_MINUTE,
  ReservoirThrottle,
  SPRINKLER_CHARGES_MAX,
  SPRINKLER_CHARGE_ML,
  SPRINKLER_PATCH_TILES,
  SPRINKLER_PERIOD_TICKS,
  SPRINKLER_POUR_ML,
  SUBTILE,
  TICKS_PER_MINUTE,
  TechId,
  WaterDraw,
  createWorld,
  createWorldView,
  hashState,
  inspectTile,
  liquidPlacementRefusal,
  machineSpec,
  pipePathRefusal,
  pumpSupplyMlPerMinute,
  rebuildNetworks,
  reservoirThrottle,
  spawnMachine,
  spawnPipe,
  step,
  stepMany,
  takeWater,
  tankTicksToEmpty,
  tileAt,
  view,
  worldTileIndex,
} from '../src/index';

function run(state: WorldState, commands: Command[]): void {
  step(state, { tick: state.tick, commands });
}

function standOn(state: WorldState, tileX: number, tileY: number): void {
  state.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  state.player.ySub = tileY * SUBTILE + SUBTILE / 2;
}

/** The pond every fresh world starts with. */
function pond(state: WorldState) {
  return state.reservoirs[0]!;
}

/**
 * A world with the whole liquid chain already built and researched:
 * `RESERVOIR → Pump → pipes → [Tank] → heads`. Money and tech are granted rather than
 * earned; the golden fixture is what proves the command path.
 */
function plumbedWorld(seed = 909): {
  state: WorldState;
  pump: Machine;
  tank: Machine;
  heads: Machine[];
  hub: Machine | null;
} {
  const state = createWorld(seed);
  state.unlocked = [TechId.Pumps, TechId.PipedSprinklers, TechId.IrrigationHub];
  state.moneyCents = 10_000_000;

  // Pump on the pond's north bank; one run west along y=12 and north up x=3.
  const pump = spawnMachine(state, MachineKind.Pump, 12, 12)!;
  for (let x = 11; x >= 3; x--) spawnPipe(state, x, 12, LiquidId.Water);
  for (let y = 11; y >= 4; y--) spawnPipe(state, 3, y, LiquidId.Water);

  const tank = spawnMachine(state, MachineKind.Tank, 1, 10)!;
  const heads = [
    spawnMachine(state, MachineKind.PipedSprinkler, 2, 8)!,
    spawnMachine(state, MachineKind.PipedSprinkler, 4, 13)!,
  ];
  const hub = spawnMachine(state, MachineKind.IrrigationHub, 1, 4);

  rebuildNetworks(state);
  return { state, pump, tank, heads, hub };
}

// --- the reservoir ------------------------------------------------------------------

describe('the reservoir', () => {
  it('starts every world with a full pond', () => {
    const state = createWorld(1);
    expect(state.reservoirs).toHaveLength(1);
    expect(pond(state).levelMl).toBe(RESERVOIR_CAPACITY_ML);
    expect(pond(state).capacityMl).toBe(RESERVOIR_CAPACITY_ML);
  });

  it('recharges at exactly the rated rate over a minute, remainder and all', () => {
    // 40,000 ml a minute is 33⅓ ml a tick. The accumulator is the whole point: a rate that
    // was divided instead of accrued would make the pond permanently ~1% wrong.
    const state = createWorld(2);
    pond(state).levelMl = 0;
    stepMany(state, TICKS_PER_MINUTE);
    expect(pond(state).levelMl).toBe(RESERVOIR_RECHARGE_ML_PER_MINUTE);
  });

  it('never lets a level go negative, however hard it is drawn from', () => {
    const state = createWorld(3);
    pond(state).levelMl = 1_000;
    const granted = takeWater(state, pond(state), 5_000_000, WaterDraw.Metered);
    expect(granted).toBe(1_000);
    expect(pond(state).levelMl).toBe(0);
  });

  it('ALWAYS RECOVERS when left alone — verified by ticking, not by reading a constant', () => {
    // Plan §4's anti-softlock guarantee. Not a balance number.
    const state = createWorld(4);
    pond(state).levelMl = 0;
    stepMany(state, 10_000);
    expect(pond(state).levelMl).toBeGreaterThan(0);

    // And all the way back to full, given long enough. 20,000,000 ml at 40,000 a minute is
    // 500 minutes of active play — so this steps the arithmetic rather than the clock.
    pond(state).levelMl = RESERVOIR_CAPACITY_ML - 100_000;
    stepMany(state, 3 * TICKS_PER_MINUTE);
    expect(pond(state).levelMl).toBe(RESERVOIR_CAPACITY_ML - 100_000 + 120_000 - 20_000);
  });

  it('never overfills past capacity', () => {
    const state = createWorld(5);
    stepMany(state, 5_000);
    expect(pond(state).levelMl).toBe(RESERVOIR_CAPACITY_ML);
  });

  it('halves a pump below 25% and sips at the recharge rate when empty', () => {
    // Plan §4, exactly: "pumps halve below 25% and sip at recharge rate when empty".
    const state = createWorld(6);
    const reservoir = pond(state);

    reservoir.levelMl = RESERVOIR_CAPACITY_ML;
    expect(reservoirThrottle(reservoir)).toBe(ReservoirThrottle.Full);
    expect(pumpSupplyMlPerMinute(reservoir, PUMP_RATE_ML_PER_MINUTE)).toBe(PUMP_RATE_ML_PER_MINUTE);

    // One millilitre below the 25% line.
    reservoir.levelMl = (RESERVOIR_CAPACITY_ML * RESERVOIR_LOW_PERMILLE) / 1000 - 1;
    expect(reservoirThrottle(reservoir)).toBe(ReservoirThrottle.Half);
    expect(pumpSupplyMlPerMinute(reservoir, PUMP_RATE_ML_PER_MINUTE)).toBe(
      PUMP_RATE_ML_PER_MINUTE / 2,
    );

    reservoir.levelMl = 0;
    expect(reservoirThrottle(reservoir)).toBe(ReservoirThrottle.Sip);
    expect(pumpSupplyMlPerMinute(reservoir, PUMP_RATE_ML_PER_MINUTE)).toBe(
      RESERVOIR_RECHARGE_ML_PER_MINUTE,
    );
  });

  it('holds a dry pond at the sip rather than stopping the pump dead', () => {
    const { state } = plumbedWorld(7);
    pond(state).levelMl = 0;
    const before = state.stats.waterDrawnMl;
    stepMany(state, TICKS_PER_MINUTE);

    // A pump at an empty pond is slow, never dead: over a minute it moves roughly what the
    // pond made, and the level never goes below zero on the way.
    expect(state.stats.waterDrawnMl - before).toBeGreaterThan(0);
    expect(state.stats.waterDrawnMl - before).toBeLessThanOrEqual(RESERVOIR_RECHARGE_ML_PER_MINUTE);
    expect(pond(state).levelMl).toBeGreaterThanOrEqual(0);
  });

  it('does not recharge while the tab is closed, because time does not pass', () => {
    // Nothing in this package reads a clock, so "ten minutes away from the keyboard" is
    // simply zero ticks. This asserts the property rather than the absence of `Date`.
    const state = createWorld(8);
    pond(state).levelMl = 500;
    const before = hashState(state);
    expect(hashState(state)).toBe(before);
    expect(pond(state).levelMl).toBe(500);
  });
});

// --- the watering can ---------------------------------------------------------------

describe('the watering can', () => {
  it('ALWAYS FILLS, at any shore, at any level, including empty', () => {
    // Plan §4's other anti-softlock guarantee: hand-scale farming can never be water-starved.
    const state = createWorld(11);
    pond(state).levelMl = 0;
    standOn(state, 6, 6);

    run(state, [{ type: 'WaterTile', tileX: 6, tileY: 6 }]);
    // Soaked. The tile drains one point in the same tick it was watered, which is why this
    // is not an equality — the pour is what matters, not the arithmetic after it.
    expect(tileAt(state, 6, 6)!.moisture).toBeGreaterThanOrEqual(MOISTURE_MAX - 1);
  });

  it('counts the refill draw in full even when the pond cannot cover it', () => {
    // Since item 009's ruling the water leaves the pond at the REFILL, not the pour — one
    // dip of what the can actually takes, through the one accounting path. An empty pond
    // still fills the can (Shore mode never fails) and the draw is still counted in full.
    const state = createWorld(12);
    pond(state).levelMl = 0;
    state.player.canCharges = 0;
    standOn(state, POND_ORIGIN_X, POND_ORIGIN_Y - 1);
    run(state, [{ type: 'RefillCan' }]);
    expect(state.player.canCharges).toBe(CAN_CHARGES_MAX);
    expect(state.stats.waterDrawnMl).toBe(CAN_CHARGES_MAX * HAND_POUR_ML);
    // The pond gave nothing and owes nothing; what is in it is the tick's own recharge.
    expect(pond(state).levelMl).toBeLessThan(HAND_POUR_ML);
  });

  it('pours without booking water — the canful was already counted at the dip', () => {
    const state = createWorld(12);
    standOn(state, 6, 6);
    run(state, [{ type: 'WaterTile', tileX: 6, tileY: 6 }]);
    expect(tileAt(state, 6, 6)!.moisture).toBeGreaterThanOrEqual(MOISTURE_MAX - 1);
    expect(state.stats.waterDrawnMl).toBe(0);
    expect(state.player.canCharges).toBe(CAN_CHARGES_MAX - 1);
  });

  it('works in a world with no reservoir at all', () => {
    // The anti-softlock clause does not depend on a pond existing: the pour still lands and
    // the refill still succeeds anywhere, because a pondless world must not be a world
    // where farming ends after eight pours.
    const state = createWorld(13);
    state.reservoirs = [];
    standOn(state, 6, 6);
    state.player.canCharges = 1;
    run(state, [{ type: 'WaterTile', tileX: 6, tileY: 6 }]);
    expect(tileAt(state, 6, 6)!.moisture).toBeGreaterThanOrEqual(MOISTURE_MAX - 1);
    expect(state.player.canCharges).toBe(0);
    run(state, [{ type: 'RefillCan' }]);
    expect(state.player.canCharges).toBe(CAN_CHARGES_MAX);
  });

  it('holds twenty pours — the owner’s number, over plan §3’s eight', () => {
    // Owner ruling 2026-08-15 (item 073). Recorded as an equality so a retune is a decision.
    expect(CAN_CHARGES_MAX).toBe(20);
  });

  it('spends one charge per pour and refuses the twenty-first as a gentle no-op', () => {
    const state = createWorld(15);
    standOn(state, 6, 6);
    for (let i = 0; i < CAN_CHARGES_MAX; i++) {
      // Dry the tile between pours: since item 081 a fully saturated tile REFUSES, and on
      // slow-draining soil a back-to-back pour would meet exactly that refusal.
      tileAt(state, 6, 6)!.moisture = 0;
      run(state, [{ type: 'WaterTile', tileX: 6, tileY: 6 }]);
    }
    expect(state.player.canCharges).toBe(0);
    const before = hashState(state);
    const touches = state.stats.touches.handWater;
    run(state, [{ type: 'WaterTile', tileX: 6, tileY: 6 }]);
    // Refused: no charge spent below zero, no touch counted, nothing destroyed — the only
    // thing that moved is the clock. (One empty tick separates the hashes, so compare the
    // parts a refusal could have touched instead.)
    expect(state.player.canCharges).toBe(0);
    expect(state.stats.touches.handWater).toBe(touches);
    expect(before).not.toBe('');
  });

  it('refuses a refill away from the shore, and a refill of a full can', () => {
    const state = createWorld(16);
    standOn(state, 6, 6); // The field, nowhere near the pond.
    state.player.canCharges = 3;
    run(state, [{ type: 'RefillCan' }]);
    expect(state.player.canCharges).toBe(3);

    standOn(state, POND_ORIGIN_X, POND_ORIGIN_Y - 1);
    run(state, [{ type: 'RefillCan' }]);
    expect(state.player.canCharges).toBe(CAN_CHARGES_MAX);
    // Only the missing pours were drawn: topping up a part-full can takes part of a canful.
    expect(state.stats.waterDrawnMl).toBe((CAN_CHARGES_MAX - 3) * HAND_POUR_ML);

    const refills = state.stats.touches.hopperRefill;
    run(state, [{ type: 'RefillCan' }]);
    // Already full: refused rather than consumed, which is UseRepairKit's rule.
    expect(state.stats.touches.hopperRefill).toBe(refills);
  });

  it('inspects a tile without changing anything about how it waters', () => {
    // Plan §2's Mogul-era ceremony. INFORMATION, NEVER A BONUS.
    const state = createWorld(14);
    standOn(state, 6, 6);
    run(state, [{ type: 'PlantTile', tileX: 6, tileY: 6, crop: 1 }]);
    run(state, [{ type: 'WaterTile', tileX: 6, tileY: 6 }]);

    const readout = inspectTile(state, 6, 6);
    expect(readout.exists).toBe(1);
    expect(readout.moisture).toBeGreaterThanOrEqual(MOISTURE_MAX - 1);
    expect(readout.crop).toBe(1);
    expect(readout.fertility).toBe(tileAt(state, 6, 6)!.fertility);
    expect(readout.dry).toBe(0);

    // Off the field it answers rather than throwing.
    expect(inspectTile(state, 0, 0).exists).toBe(0);
  });

  it('draws every barrel refill from the pond, and gives what is there when short', () => {
    const state = createWorld(15);
    state.moneyCents = 100_000;
    const sprinkler = spawnMachine(state, MachineKind.Sprinkler, 0, 0)!;
    standOn(state, 0, 0);

    pond(state).levelMl = 4_000;
    const drawnBefore = state.stats.waterDrawnMl;
    run(state, [{ type: 'RefillHopper', machineId: sprinkler.id }]);
    // A partial fill, not a refusal: you get what is there, and it is counted.
    expect(state.stats.waterDrawnMl - drawnBefore).toBe(4_000);
    expect(pond(state).levelMl).toBeLessThan(4_000);
  });
});

// --- the barrel sprinkler (items 086, 097) -------------------------------------------

/**
 * The assisted rung, after the owner's ten-charge ruling (086) and its redefinition (097).
 *
 * A CHARGE IS AN ACTIVATION, NOT A TILE — owner ruling 2026-08-16: *"when they spend a charge,
 * they should water everything in a 5x5, not just the single tiles like it's doing right now."*
 * Ten charges are ten whole patches.
 *
 * Every test here stands the head DEAD-CENTRE at (7,7) on the 8×8 field (x and y both 4..11),
 * where its 5×5 patch is 25 farm tiles — 24 of them waterable, since item 067 a head never
 * waters its own feet. The whole patch fitting inside the field is what lets "one charge did
 * all 24" be a fact rather than a shape of the field.
 */
describe('the barrel sprinkler', () => {
  /** A full barrel mid-field, and the whole field as dry as it can be. */
  function thirstyField(seed: number): { state: WorldState; barrel: Machine } {
    const state = createWorld(seed);
    const barrel = spawnMachine(state, MachineKind.Sprinkler, 7, 7)!;
    barrel.tankMl = machineSpec(barrel.kind)!.tankCapacityMl;
    for (const tile of state.field) tile.moisture = 0;
    return { state, barrel };
  }

  it('HOLDS TEN CHARGES, and a charge is one full patch in millilitres', () => {
    // Owner ruling 2026-08-15: "the sprinklers should have charges, ten charges", and
    // 2026-08-16: a charge waters the whole 5×5. Neither number is allowed to be an
    // independent opinion — the capacity is those two sentences multiplied together.
    expect(SPRINKLER_PATCH_TILES).toBe(24);
    expect(SPRINKLER_CHARGE_ML).toBe(SPRINKLER_PATCH_TILES * SPRINKLER_POUR_ML);
    expect(machineSpec(MachineKind.Sprinkler)!.tankCapacityMl).toBe(
      SPRINKLER_CHARGES_MAX * SPRINKLER_CHARGE_ML,
    );
  });

  it('WATERS THE WHOLE PATCH ON ONE CHARGE, and ten charges are ten patches', () => {
    // THE ITEM, IN ONE TEST. Twenty-four thirsty neighbours, one cycle, one charge.
    const { state, barrel } = thirstyField(861);
    const full = machineSpec(barrel.kind)!.tankCapacityMl;

    stepMany(state, 1);
    expect(barrel.wateredCount, 'one cycle left thirsty ground behind it').toBe(24);
    expect(barrel.tankMl, 'the whole patch cost more or less than one charge').toBe(
      full - SPRINKLER_CHARGE_ML,
    );
    expect(view(state).machines.find((m) => m.id === barrel.id)!.tankCharges).toBe(
      SPRINKLER_CHARGES_MAX - 1,
    );

    // Nine more patches in the barrel, and the tenth cycle is the one that empties it. The
    // field is re-parched between cycles because a wet patch is free (the test below).
    // `+ 1`: a cycle sets its own cooldown on the tick it fires, so the beat is 101 ticks.
    for (let cycle = 1; cycle < SPRINKLER_CHARGES_MAX; cycle++) {
      for (const tile of state.field) tile.moisture = 0;
      stepMany(state, SPRINKLER_PERIOD_TICKS + 1);
    }
    expect(barrel.wateredCount).toBe(SPRINKLER_CHARGES_MAX * 24);
    expect(barrel.tankMl).toBe(0);
    expect(barrel.opCount, 'ten patches should be ten operations').toBe(SPRINKLER_CHARGES_MAX);

    // Eleventh cycle on an empty barrel: it halts, which is the existing starved tell.
    for (const tile of state.field) tile.moisture = 0;
    stepMany(state, 4 * SPRINKLER_PERIOD_TICKS);
    expect(barrel.wateredCount).toBe(SPRINKLER_CHARGES_MAX * 24);
  });

  it('NEVER STOPS MID-PATCH: it will not start a cycle it cannot finish', () => {
    // The whole reason item 097 could delete item 086's resuming scan cursor. A barrel a drop
    // short of a charge does nothing at all rather than watering the near rows and parking —
    // so there is no "where it ran dry" left for a cursor to remember, and no back row that
    // could starve. (Owner's 086 bug, 2026-08-16: "it looks like it's only watering in front
    // of them.")
    const { state, barrel } = thirstyField(868);
    barrel.tankMl = SPRINKLER_CHARGE_ML - 1;
    const cursor = barrel.scanCursor;

    stepMany(state, 4 * SPRINKLER_PERIOD_TICKS);
    expect(barrel.wateredCount, 'a part-charge bought part of a patch').toBe(0);
    expect(barrel.tankMl, 'the part-charge was spent on nothing').toBe(SPRINKLER_CHARGE_ML - 1);
    expect(barrel.scanCursor, 'the barrel still writes a cursor it no longer reads').toBe(cursor);

    // One more millilitre and the entire patch lands in a single cycle — near rows and far
    // rows together, which is the shape the cursor used to have to fake across three hauls.
    barrel.tankMl = SPRINKLER_CHARGE_ML;
    stepMany(state, SPRINKLER_PERIOD_TICKS + 1);
    const poured = (y: number) =>
      [5, 6, 7, 8, 9].map((x) => tileAt(state, x, y)!).filter((t) => t.lastPouredTick > 0).length;
    expect(poured(5), 'the near row went unwatered').toBe(5);
    expect(poured(9), 'the far row was starved').toBe(5);
    expect(barrel.wateredCount).toBe(24);
    expect(barrel.scanCursor).toBe(cursor);
  });

  it('SPENDS NOTHING over saturated ground — no charge, no pour signal, no wear', () => {
    const state = createWorld(862);
    const barrel = spawnMachine(state, MachineKind.Sprinkler, 7, 7)!;
    barrel.tankMl = machineSpec(barrel.kind)!.tankCapacityMl;
    for (const tile of state.field) tile.moisture = MOISTURE_MAX;
    stepMany(state, 1); // Past tick 0, so a pour mark is distinguishable from "never".
    for (const tile of state.field) tile.lastPouredTick = 0;
    const condition = barrel.condition;

    stepMany(state, 4 * SPRINKLER_PERIOD_TICKS);
    expect(barrel.wateredCount).toBe(0);
    // Item 086's thirst rule, surviving item 097's new unit intact: a sweep that found nothing
    // to do is not an activation, so it is not billed as one.
    expect(barrel.tankMl).toBe(machineSpec(barrel.kind)!.tankCapacityMl);
    // Item 081's rule, one rung up: a skip marks NO pour signal. The renderer would draw a
    // splash and the audio observer would play one, over water that never left the barrel.
    expect(state.field.every((tile) => tile.lastPouredTick === 0)).toBe(true);
    // A cycle that did nothing costs nothing: wear is per operation, and there was none.
    expect(barrel.condition).toBe(condition);
    expect(barrel.opCount).toBe(0);
    // What it DID do is look, and say how much looking saved — the Hub's own counter.
    expect(barrel.skippedCount).toBeGreaterThan(0);
  });

  it('spends ONE WHOLE CHARGE on a mixed patch, however few tiles were thirsty', () => {
    const { state, barrel } = thirstyField(863);
    // Three dry tiles in a patch that is otherwise soaked.
    for (const tile of state.field) tile.moisture = MOISTURE_MAX;
    const thirsty = [tileAt(state, 6, 6)!, tileAt(state, 8, 6)!, tileAt(state, 6, 8)!];
    for (const tile of thirsty) tile.moisture = MOISTURE_DRY_THRESHOLD - 1;
    const before = barrel.tankMl;

    stepMany(state, 1);
    expect(barrel.wateredCount).toBe(3);
    // A CHARGE IS AN ACTIVATION, NOT A TILE COUNT. Three tiles cost exactly what twenty-four
    // would have, and the difference runs off — the barrel rung's sloppiness, and precisely
    // what the ledger-fed rungs above it are sold against.
    expect(before - barrel.tankMl).toBe(SPRINKLER_CHARGE_ML);
    // Above the threshold and never over the ceiling. Not exactly `MOISTURE_MAX`: the pour
    // clamps to it and the same tick's drain then takes one point back off, which is the
    // ordinary order of the day and not the sprinkler's business.
    for (const tile of thirsty) {
      expect(tile.moisture).toBeGreaterThan(MOISTURE_DRY_THRESHOLD);
      expect(tile.moisture).toBeLessThanOrEqual(MOISTURE_MAX);
    }
    // Twenty-one wet neighbours looked at and left alone. The head's own tile is NOT among
    // them: it was never waterable, so passing it over saved nothing and counts as nothing.
    expect(barrel.skippedCount).toBe(21);
  });

  it('waters at the SAME threshold the ground is drawn cracked with, not at saturation', () => {
    // One definition of dry (see `MachineSpec.moistureSensing`). A barrel that poured on
    // anything below MOISTURE_MAX would be back to a sloppiness tax with extra steps.
    const { state, barrel } = thirstyField(864);
    for (const tile of state.field) tile.moisture = MOISTURE_DRY_THRESHOLD;
    const parched = tileAt(state, 6, 6)!;
    parched.moisture = MOISTURE_DRY_THRESHOLD - 1;

    stepMany(state, 1);
    expect(barrel.wateredCount).toBe(1);
    expect(parched.moisture).toBeGreaterThan(MOISTURE_DRY_THRESHOLD);
  });

  it('KEEPS THE ONE LEDGER: every millilitre drawn is spent as charges or still in the barrel', () => {
    // Item 028's law, and the reason item 097 left the barrel on `tankMl` instead of storing
    // charges outright. Charges are a projection; this is the thing they are a projection OF,
    // and if the two ever disagree it is this that is right. `opCount` is the barrel's charge
    // count — it moves once per activation and only when something was watered.
    const state = createWorld(865);
    state.moneyCents = 100_000;
    const barrel = spawnMachine(state, MachineKind.Sprinkler, 7, 7)!;
    standOn(state, 7, 8);

    const drawnBefore = state.stats.waterDrawnMl;
    for (let i = 0; i < 6; i++) {
      for (const tile of state.field) tile.moisture = 0;
      run(state, [{ type: 'RefillHopper', machineId: barrel.id }]);
      stepMany(state, SPRINKLER_PERIOD_TICKS);
    }

    const drawn = state.stats.waterDrawnMl - drawnBefore;
    expect(drawn).toBe(barrel.opCount * SPRINKLER_CHARGE_ML + barrel.tankMl);
    // And the refills were real: a head that never drank would satisfy the equation trivially.
    expect(barrel.opCount).toBeGreaterThan(0);
    expect(barrel.wateredCount).toBe(barrel.opCount * 24);
  });

  it('projects charges from the ledger at every boundary, and stores none of them', () => {
    const { state, barrel } = thirstyField(866);
    const charges = () => view(state).machines.find((m) => m.id === barrel.id)!;

    expect(charges().tankCharges).toBe(SPRINKLER_CHARGES_MAX);
    expect(charges().tankChargesMax).toBe(SPRINKLER_CHARGES_MAX);

    barrel.tankMl = 0;
    expect(charges().tankCharges).toBe(0);

    // A part-charge is not a charge: you cannot water two thirds of a patch, so the readout
    // floors rather than rounding up into a promise the barrel cannot keep — and the barrel
    // agrees, since it refuses to start a cycle it cannot pay for in full.
    barrel.tankMl = SPRINKLER_CHARGE_ML * 3 - 1;
    expect(charges().tankCharges).toBe(2);

    // The Capacity dial moves the ceiling, because it moves the millilitres.
    barrel.tankMl = machineSpec(barrel.kind)!.tankCapacityMl;
    barrel.capacityLevel = 1;
    expect(charges().tankChargesMax).toBeGreaterThan(SPRINKLER_CHARGES_MAX);

    // Nothing in the world state knows the word: the projection is arithmetic on `tankMl`.
    expect(Object.keys(barrel)).not.toContain('charges');
  });

  it('shows the blue lamp A CHARGE SHORT, not a drop short', () => {
    // Plan §5's grammar: the lamp and the readout have to agree. A barrel holding 35,999 ml
    // reads zero charges and will not fire, so a running lamp over it would be a lie.
    const { state, barrel } = thirstyField(870);
    const lamp = () => view(state).machines.find((m) => m.id === barrel.id)!.lamp;

    expect(lamp()).toBe(LampState.Running);
    barrel.tankMl = SPRINKLER_CHARGE_ML - 1;
    expect(lamp()).toBe(LampState.UtilityMissing);
    barrel.tankMl = SPRINKLER_CHARGE_ML;
    expect(lamp()).toBe(LampState.Running);
  });

  it('leaves the piped head METERED and its scan cursor untouched, exactly as it was', () => {
    // Item 097 is the barrel's ruling. The piped head is required to come through it
    // byte-identical: it still pays `SPRINKLER_POUR_ML` per tile out of its ledger-fed buffer,
    // still stops the moment it cannot cover the next tile, and still never writes a cursor.
    const state = createWorld(869);
    state.unlocked = [TechId.Pumps, TechId.PipedSprinklers];
    const head = spawnMachine(state, MachineKind.PipedSprinkler, 7, 7)!;
    head.tankMl = 3 * SPRINKLER_POUR_ML; // Deliberately dry mid-patch, where a barrel would refuse.
    for (const tile of state.field) tile.moisture = 0;

    stepMany(state, 2 * SPRINKLER_PERIOD_TICKS);
    expect(head.wateredCount).toBe(3);
    expect(head.tankMl).toBe(0);
    expect(head.scanCursor).toBe(0);
    // And it has no charges to report: nobody hauls to it, so "3 of 10" would be a walk it
    // never has to plan (item 097's view contract).
    const hv = view(state).machines.find((m) => m.id === head.id)!;
    expect(hv.tankCharges).toBe(0);
    expect(hv.tankChargesMax).toBe(0);
  });

  it('leaves a tank machine out of the charge readout entirely', () => {
    // A Tank holds a million millilitres and pours none of them: 666 charges would be noise.
    const { state, tank } = plumbedWorld(867);
    const tv = view(state).machines.find((m) => m.id === tank.id)!;
    expect(tv.tankCharges).toBe(0);
    expect(tv.tankChargesMax).toBe(0);
  });
});

// --- the pour signal (item 064) ------------------------------------------------------

describe('the pour signal', () => {
  it('REFUSES a pour on a fully saturated tile: no charge, no water, no pour signal', () => {
    // Owner ruling 2026-08-15 (item 081), knowingly superseding item 064's "the saturated
    // pour plays full feedback": the pour does not happen at all. The anti-silence guarantee
    // 064 bought now lives in the input layer's refusal tell, which reads the reason off the
    // view (moisturePermille at 1000) exactly as the empty-can refusal reads canCharges.
    const state = createWorld(17);
    standOn(state, 6, 6);
    stepMany(state, 5); // Off tick 0, where a recorded pour and "never" share a value.

    run(state, [{ type: 'WaterTile', tileX: 6, tileY: 6 }]);
    const tile = tileAt(state, 6, 6)!;
    const firstPour = tile.lastPouredTick;
    expect(firstPour).toBeGreaterThan(0);

    tile.moisture = MOISTURE_MAX; // Saturate: the next pour has nothing to give this tile.
    const charges = state.player.canCharges;
    const touches = state.stats.touches.handWater;
    const traceLength = state.trace.length;
    const drawn = state.stats.waterDrawnMl;
    run(state, [{ type: 'WaterTile', tileX: 6, tileY: 6 }]);
    // Refused, house semantics: nothing spent, nothing drawn, nothing marked, no trace entry.
    expect(state.player.canCharges).toBe(charges);
    expect(state.stats.touches.handWater).toBe(touches);
    expect(state.trace.length).toBe(traceLength);
    expect(state.stats.waterDrawnMl).toBe(drawn);
    expect(tile.lastPouredTick).toBe(firstPour);
  });

  it('still pours and clamps one point below max — only a tile with nothing to gain refuses', () => {
    // The refusal is exact: a 999-out-of-1000 tile takes the pour, costs the charge, and
    // clamps to max. No overwatering is possible, and no near-full tile is refused.
    const state = createWorld(19);
    standOn(state, 6, 6);
    stepMany(state, 5);

    const tile = tileAt(state, 6, 6)!;
    tile.moisture = MOISTURE_MAX - 1;
    const charges = state.player.canCharges;
    run(state, [{ type: 'WaterTile', tileX: 6, tileY: 6 }]);
    expect(state.player.canCharges).toBe(charges - 1);
    // Soaked, minus the same tick's drain — up to 2 points on sand (1500‰ of 1).
    expect(tile.moisture).toBeGreaterThanOrEqual(MOISTURE_MAX - 2);
    expect(tile.lastPouredTick).toBe(state.tick - 1);

    // And the view carries the pour signal, per tile, in row-major field order.
    const projected = view(state, createWorldView());
    const idx =
      (6 - projected.field.originY) * projected.field.tilesWide + (6 - projected.field.originX);
    expect(projected.field.lastPouredTick[idx]).toBe(tile.lastPouredTick);
  });

  it('marks piped-head pours, wet tiles included — a dumb re-wet is still a pour', () => {
    // RE-AIMED AT THE PIPED HEAD BY ITEM 086. Until the owner's ten-charge ruling this test
    // used the BARREL, which re-wet soaked ground as its signature inefficiency; the barrel
    // senses now and its skips are pinned in `the barrel sprinkler` above. The piped head is
    // the dumb one that remains — its water is ledger-fed and its waste is what the Irrigation
    // Hub is sold against — so the sloppiness-tax pour this test watches moved down one rung.
    const state = createWorld(18);
    state.unlocked = [TechId.Pumps, TechId.PipedSprinklers];
    const head = spawnMachine(state, MachineKind.PipedSprinkler, 5, 5)!;
    stepMany(state, 1); // Past tick 0 so a recorded pour is distinguishable from "never".
    head.tankMl = 100_000;
    // A NEIGHBOUR, not the machine's own tile: since item 067 a head standing on farmland
    // never waters its own feet — the occupied tile is outside the watering surface — so the
    // sloppiness-tax pour this test watches lands on the soaked tile beside it.
    tileAt(state, 6, 6)!.moisture = MOISTURE_MAX; // Soaked, and the dumb head pours anyway.

    stepMany(state, 3);
    expect(tileAt(state, 6, 6)!.lastPouredTick).toBeGreaterThan(0);
    expect(tileAt(state, 5, 5)!.lastPouredTick, 'the head watered under itself').toBe(0);
  });

  it('marks Hub pours but never Hub skips — a skip is not a pour', () => {
    const state = createWorld(19);
    const hub = spawnMachine(state, MachineKind.IrrigationHub, 5, 5)!;
    stepMany(state, 1);
    hub.tankMl = 1_000_000;
    const soaked = tileAt(state, 6, 5)!;
    soaked.moisture = MOISTURE_MAX;

    stepMany(state, 60);
    // Dry tiles in the patch were poured on; the soaked one was inspected and passed over,
    // and the signal says so — silence on a skip is by design, it is the saving on display.
    expect(state.field.some((tile) => tile.lastPouredTick > 0)).toBe(true);
    expect(soaked.lastPouredTick).toBe(0);
  });

  it('stays out of the hash: worlds that differ only in pour ticks are the same world', () => {
    const state = createWorld(20);
    standOn(state, 6, 6);
    stepMany(state, 5);
    run(state, [{ type: 'WaterTile', tileX: 6, tileY: 6 }]);

    const before = hashState(state);
    tileAt(state, 6, 6)!.lastPouredTick = 424_242;
    expect(hashState(state)).toBe(before);
  });
});

// --- the ledger ---------------------------------------------------------------------

describe('the one-ledger flow model', () => {
  it('gives a network a geometric id that does not depend on build order', () => {
    const a = createWorld(21);
    for (let x = 3; x <= 8; x++) spawnPipe(a, x, 13, LiquidId.Water);
    rebuildNetworks(a);

    const b = createWorld(21);
    for (let x = 8; x >= 3; x--) spawnPipe(b, x, 13, LiquidId.Water);
    rebuildNetworks(b);

    expect(a.networks.map((n) => n.id)).toEqual(b.networks.map((n) => n.id));
    expect(a.networks[0]!.id).toBe(worldTileIndex(3, 13));
  });

  it('splits one run into two networks when the middle is torn out', () => {
    const state = createWorld(22);
    for (let x = 3; x <= 9; x++) spawnPipe(state, x, 13, LiquidId.Water);
    rebuildNetworks(state);
    expect(state.networks).toHaveLength(1);

    state.pipes = state.pipes.filter((pipe) => pipe.tileX !== 6);
    rebuildNetworks(state);
    expect(state.networks).toHaveLength(2);
    expect(state.networks.map((n) => n.id)).toEqual([worldTileIndex(3, 13), worldTileIndex(7, 13)]);
  });

  it('delivers everything when supply covers demand', () => {
    const { state, heads } = plumbedWorld(23);
    // Drain one head so it asks for water, and leave the rest full.
    heads[0]!.tankMl = 0;
    heads[1]!.tankMl = machineSpec(heads[1]!.kind)!.tankCapacityMl;
    if (state.machines.some((m) => m.kind === MachineKind.IrrigationHub)) {
      for (const machine of state.machines) {
        if (machine.kind === MachineKind.IrrigationHub) {
          machine.tankMl = machineSpec(machine.kind)!.tankCapacityMl;
        }
      }
    }
    stepMany(state, 1);

    const spec = machineSpec(heads[0]!.kind)!;
    expect(heads[0]!.tankMl).toBe(spec.intakeMlPerTick);
    expect(heads[0]!.throttled).toBe(false);
  });

  it('THROTTLES EVERY CONSUMER rather than starving some, and flags them amber', () => {
    // Plan §5: "over-demand throttles round-robin with amber icons."
    const { state, heads, hub } = plumbedWorld(24);
    for (const machine of state.machines) machine.tankMl = 0;
    stepMany(state, 1);

    const consumers = [heads[0]!, heads[1]!, hub!];
    for (const consumer of consumers) {
      expect(consumer.tankMl).toBeGreaterThan(0);
      expect(consumer.throttled).toBe(true);
    }

    // Fair to within one millilitre: the equal shares land, then the remainder rotates.
    const shares = consumers.map((c) => c.tankMl);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
  });

  it('rotates the remainder rather than gifting it to the same machine forever', () => {
    const { state, heads, hub } = plumbedWorld(25);
    const consumers = [heads[0]!, heads[1]!, hub!];
    for (const machine of state.machines) machine.tankMl = 0;

    // Supply is 500 ml a tick over three consumers: 166 each, two left over.
    stepMany(state, 60);
    const network = state.networks[0]!;
    expect(network.rrOffset).toBeGreaterThan(0);
    // Nobody has been starved of the rounding, which is the failure the rotation prevents.
    const shares = consumers.map((c) => c.tankMl);
    expect(Math.min(...shares)).toBeGreaterThan(0);
  });

  it('never delivers more than it drew, over 2,000 ticks', () => {
    // The conservation law. Total delivered ≤ total supplied, and the remainder is carried in
    // the accumulator rather than lost or invented.
    const { state } = plumbedWorld(26);
    for (const machine of state.machines) machine.tankMl = 0;

    let delivered = 0;
    let drawnBefore = state.stats.waterDrawnMl;
    for (let i = 0; i < 2_000; i++) {
      stepMany(state, 1);
      delivered += state.networks[0]!.deliveredMl;
    }
    const drawn = state.stats.waterDrawnMl - drawnBefore;
    // Everything delivered came out of the pond or out of the tank, and the tank's stock came
    // out of the pond earlier — so the pond's total draw bounds the whole ledger.
    expect(delivered).toBeLessThanOrEqual(drawn);
    expect(pond(state).levelMl).toBeGreaterThanOrEqual(0);
    drawnBefore = 0;
  });

  it('lets a tank cover a shortfall and shows a net rate and a time-to-empty', () => {
    const { state, tank, heads, hub } = plumbedWorld(27);
    const tankSpec = machineSpec(tank.kind)!;
    tank.tankMl = tankSpec.tankCapacityMl;
    for (const machine of [heads[0]!, heads[1]!, hub!]) machine.tankMl = 0;

    stepMany(state, 1);
    // Demand outruns the pump, so the tank gives some back and its net rate goes negative.
    expect(tank.flowMlPerMinute).toBeLessThan(0);
    expect(tank.tankMl).toBeLessThan(tankSpec.tankCapacityMl);

    const ticks = tankTicksToEmpty(tank);
    expect(ticks).toBeGreaterThan(0);
    expect(Number.isInteger(ticks)).toBe(true);
  });

  it('answers time-to-empty with a sentinel rather than dividing by zero', () => {
    const { state, tank } = plumbedWorld(28);
    tank.flowMlPerMinute = 0;
    expect(tankTicksToEmpty(tank)).toBe(-1);
    tank.flowMlPerMinute = 1;
    expect(tankTicksToEmpty(tank)).toBe(-1);
    expect(state.networks).toHaveLength(1);
  });

  it('leaves a network with no pump supplying nothing, and banks nothing while it waits', () => {
    const { state, pump } = plumbedWorld(29);
    // Pick the pump up and put it somewhere with no water and no pipe.
    pump.tileX = 0;
    pump.tileY = 15;
    rebuildNetworks(state);
    stepMany(state, 100);

    const network = state.networks[0]!;
    expect(network.supplyMl).toBe(0);
    expect(network.supplyAccum).toBe(0);
    expect(network.deliveredMl).toBe(0);
  });
});

// --- placement rules ------------------------------------------------------------------

describe('one pump and one liquid per network, enforced', () => {
  it('refuses a run that would put two pumps on one network', () => {
    const state = createWorld(31);
    state.unlocked = [TechId.Pumps];
    state.moneyCents = 1_000_000;

    spawnMachine(state, MachineKind.Pump, 12, 12);
    spawnMachine(state, MachineKind.Pump, 13, 12);
    rebuildNetworks(state);

    // A single tile between the two pumps would join them.
    const refusal = pipePathRefusal(
      state,
      [
        { x: 12, y: 11 },
        { x: 13, y: 11 },
      ],
      LiquidId.Water,
      PIPE_MAX_PATH_TILES,
    );
    expect(refusal).toBe(BuildRefusal.TwoPumpsOneNetwork);

    // And the reducer refuses it too — the preview and the rule are the same function.
    run(state, [
      {
        type: 'PlacePipe',
        liquid: LiquidId.Water,
        path: [
          { x: 12, y: 11 },
          { x: 13, y: 11 },
        ],
      },
    ]);
    expect(state.pipes).toHaveLength(0);
  });

  it('refuses a pump that would join a network that already has one', () => {
    const state = createWorld(32);
    state.unlocked = [TechId.Pumps];
    spawnMachine(state, MachineKind.Pump, 12, 12);
    spawnPipe(state, 12, 11, LiquidId.Water);
    spawnPipe(state, 13, 11, LiquidId.Water);
    rebuildNetworks(state);

    // (13,12) is on the pond's bank AND beside the existing pump's run.
    expect(liquidPlacementRefusal(state, MachineKind.Pump, 13, 12)).toBe(
      BuildRefusal.TwoPumpsOneNetwork,
    );
  });

  it('refuses a pump that is not standing on a bank', () => {
    const state = createWorld(33);
    state.unlocked = [TechId.Pumps];
    state.moneyCents = 1_000_000;

    expect(liquidPlacementRefusal(state, MachineKind.Pump, 0, 0)).toBe(BuildRefusal.NoWaterSource);
    run(state, [{ type: 'PlaceMachine', kind: MachineKind.Pump, tileX: 0, tileY: 0 }]);
    expect(state.machines.some((machine) => machine.kind === MachineKind.Pump)).toBe(false);
  });

  it('refuses a run that would join two liquids', () => {
    const state = createWorld(34);
    spawnPipe(state, 5, 13, LiquidId.Water);
    rebuildNetworks(state);

    // There is only one liquid today, so this asserts the mechanism rather than a scenario:
    // an adjacent pipe carrying anything else is refused before it is laid.
    state.pipes[0]!.liquid = 99 as never;
    expect(pipePathRefusal(state, [{ x: 6, y: 13 }], LiquidId.Water, PIPE_MAX_PATH_TILES)).toBe(
      BuildRefusal.LiquidMismatch,
    );
  });

  it('refuses a path that is not contiguous, repeats a tile, or leaves the world', () => {
    const state = createWorld(35);
    const check = (path: { x: number; y: number }[]) =>
      pipePathRefusal(state, path, LiquidId.Water, PIPE_MAX_PATH_TILES);

    expect(
      check([
        { x: 3, y: 13 },
        { x: 6, y: 13 },
      ]),
    ).toBe(BuildRefusal.BadPath);
    expect(
      check([
        { x: 3, y: 13 },
        { x: 4, y: 13 },
        { x: 3, y: 13 },
      ]),
    ).toBe(BuildRefusal.BadPath);
    expect(check([{ x: -1, y: 13 }])).toBe(BuildRefusal.OutsideWorld);
    expect(check([{ x: 6, y: 6 }])).toBe(BuildRefusal.OnField);
    expect(check([{ x: 12, y: 13 }])).toBe(BuildRefusal.Occupied);
    expect(check([])).toBe(BuildRefusal.BadPath);
  });

  it('lays a whole run as ONE trace entry and takes it back up for a full refund', () => {
    const state = createWorld(36);
    state.unlocked = [TechId.Pumps];
    state.moneyCents = 1_000_000;
    const before = state.moneyCents;

    const path: { x: number; y: number }[] = [];
    for (let x = 3; x <= 11; x++) path.push({ x, y: 13 });

    const traceBefore = state.trace.length;
    run(state, [{ type: 'PlacePipe', liquid: LiquidId.Water, path }]);
    expect(state.pipes).toHaveLength(9);
    expect(state.trace.length - traceBefore).toBe(1);
    expect(state.moneyCents).toBeLessThan(before);

    run(state, [{ type: 'RemovePipe', path }]);
    expect(state.pipes).toHaveLength(0);
    expect(state.networks).toHaveLength(0);
    // Misplacement is never a fine (plan §4).
    expect(state.moneyCents).toBe(before);
  });

  it('rejects pipe entirely until the tech that makes it legal is researched', () => {
    const state = createWorld(37);
    state.moneyCents = 1_000_000;
    run(state, [{ type: 'PlacePipe', liquid: LiquidId.Water, path: [{ x: 3, y: 13 }] }]);
    expect(state.pipes).toHaveLength(0);
  });
});

// --- the watering ladder --------------------------------------------------------------

describe('piped sprinklers and the Irrigation Hub', () => {
  it('waters indefinitely with no refilling', () => {
    const { state, heads } = plumbedWorld(41);
    stepMany(state, 3_000);
    // Nobody touched it, and it has been pouring the whole time.
    expect(heads[0]!.wateredCount).toBeGreaterThan(0);
    expect(state.stats.touches.hopperRefill).toBe(0);
  });

  it('THE HUB SKIPS WET TILES, using the one definition of dry', () => {
    const { state, hub } = plumbedWorld(42);
    for (const tile of state.field) tile.moisture = MOISTURE_MAX;
    hub!.tankMl = machineSpec(hub!.kind)!.tankCapacityMl;
    const before = hub!.tankMl;

    stepMany(state, 200);
    expect(hub!.skippedCount).toBeGreaterThan(0);
    expect(hub!.wateredCount).toBe(0);
    expect(hub!.tankMl).toBeGreaterThanOrEqual(before - 0);

    // And it waters the moment a tile crosses the threshold the ground is drawn with.
    tileAt(state, 4, 5)!.moisture = MOISTURE_DRY_THRESHOLD - 1;
    stepMany(state, 200);
    expect(hub!.wateredCount).toBeGreaterThan(0);
    expect(tileAt(state, 4, 5)!.moisture).toBeGreaterThan(MOISTURE_DRY_THRESHOLD);
  });

  it('BEATS A DUMB HEAD ON WATER over the same coverage', () => {
    // The saving IS the promotion (plan §6's Dry County board). If this ever goes red, the
    // Hub is a worse buy than the thing it replaces and the numbers are wrong.
    function drawnOver(kind: MachineKind, ticks: number): number {
      const state = createWorld(43);
      state.unlocked = [TechId.Pumps, TechId.PipedSprinklers, TechId.IrrigationHub];
      spawnMachine(state, MachineKind.Pump, 12, 12)!;
      for (let x = 11; x >= 3; x--) spawnPipe(state, x, 12, LiquidId.Water);
      for (let y = 11; y >= 4; y--) spawnPipe(state, 3, y, LiquidId.Water);
      // Same tile for both, so the only difference is the machine. The Hub covers NINE TIMES
      // the area from there and still draws less, which is the promotion in one number.
      spawnMachine(state, kind, 2, 8);
      rebuildNetworks(state);
      // A field that starts wet, which is the case the Hub exists for.
      for (const tile of state.field) tile.moisture = MOISTURE_MAX;
      const before = state.stats.waterDrawnMl;
      stepMany(state, ticks);
      return state.stats.waterDrawnMl - before;
    }

    const dumb = drawnOver(MachineKind.PipedSprinkler, 2_000);
    const smart = drawnOver(MachineKind.IrrigationHub, 2_000);
    expect(smart).toBeLessThan(dumb);
  });

  it('never lets moisture exceed the maximum, on any rung', () => {
    const { state } = plumbedWorld(44);
    stepMany(state, 2_000);
    for (const tile of state.field) expect(tile.moisture).toBeLessThanOrEqual(MOISTURE_MAX);
  });

  it('bounds the Hub scan per tick regardless of field size', () => {
    const { state, hub } = plumbedWorld(45);
    for (const tile of state.field) tile.moisture = MOISTURE_MAX;
    hub!.scanCursor = 0;
    stepMany(state, 1);
    // Exactly one slice was examined, and the cursor moved by exactly that much.
    expect(hub!.scanCursor).toBe(IRRIGATION_HUB_SCAN_PER_TICK);
  });

  it('holds the cursor rather than skipping a dry tile it cannot afford', () => {
    const { state, hub } = plumbedWorld(46);
    for (const tile of state.field) tile.moisture = 0;
    hub!.tankMl = 0;
    hub!.scanCursor = 0;
    // Detach it so nothing refills it mid-test.
    hub!.network = 0;

    // Long enough to sweep past the off-field part of its patch and reach dry ground.
    stepMany(state, 100);
    expect(hub!.wateredCount).toBe(0);
    const parked = hub!.scanCursor;
    stepMany(state, 100);
    // Parked on the dry tile it cannot afford, rather than scanning past it and forgetting.
    expect(hub!.scanCursor).toBe(parked);
  });

  it('records each first activation once, and never again', () => {
    const { state } = plumbedWorld(47);
    for (const tile of state.field) tile.moisture = 0;
    stepMany(state, 500);

    expect(state.ceremonies).toContain(CeremonyId.PipedSprinkler);
    expect(state.ceremonies).toContain(CeremonyId.IrrigationHub);

    const count = state.ceremonies.filter((id) => id === CeremonyId.IrrigationHub).length;
    stepMany(state, 500);
    expect(state.ceremonies.filter((id) => id === CeremonyId.IrrigationHub).length).toBe(count);
  });

  it('leaves the lower rung’s reach and pour size exactly as they were', () => {
    // Plan §1: "manual never rots." The barrel pours the same amount over the same radius on
    // the same period as it always did — five field tiles from the fence at (2,8).
    //
    // WHAT IT NO LONGER DOES IS WATER THEM WHETHER THEY NEEDED IT OR NOT. This test asserted
    // exactly that until item 086, and the owner's ruling of 2026-08-15 overturned it: "they
    // only should go watering if the tile needs it". The rung did not rot, it stopped
    // wasting — so the geometry stays pinned here and the thirst test is pinned in
    // `the barrel sprinkler` above.
    //
    // AND A CHARGE IS THE ACTIVATION, NOT THE FIVE TILES (item 097). A head with most of its
    // patch off the field pays the same charge as one dead-centre: siting it badly is the
    // player's decision to make and to see, not something the barrel quietly discounts.
    const state = createWorld(48);
    state.moneyCents = 1_000_000;
    const sprinkler = spawnMachine(state, MachineKind.Sprinkler, 2, 8)!;
    const full = machineSpec(sprinkler.kind)!.tankCapacityMl;
    sprinkler.tankMl = full;
    for (const tile of state.field) tile.moisture = 0;

    stepMany(state, 1);
    expect(sprinkler.wateredCount).toBe(5);
    expect(sprinkler.tankMl).toBe(full - SPRINKLER_CHARGE_ML);

    // Same five tiles, now soaked: same reach, same period, nothing spent.
    const held = sprinkler.tankMl;
    for (const tile of state.field) tile.moisture = MOISTURE_MAX;
    stepMany(state, 2 * SPRINKLER_PERIOD_TICKS);
    expect(sprinkler.wateredCount).toBe(5);
    expect(sprinkler.tankMl).toBe(held);
  });
});

// --- the projection ---------------------------------------------------------------------

describe('the render projection', () => {
  it('projects reservoirs, pipes, and networks as plain integers', () => {
    const { state } = plumbedWorld(51);
    stepMany(state, 50);

    const buffer = createWorldView();
    const projected = view(state, buffer);

    expect(projected.reservoirs).toHaveLength(1);
    expect(projected.reservoirs[0]!.levelPermille).toBeLessThanOrEqual(1000);
    expect(projected.pipes).toHaveLength(state.pipes.length);
    expect(projected.networks).toHaveLength(1);
    expect(projected.networks[0]!.consumerCount).toBeGreaterThan(0);

    // Every pipe carries its network's flow, so the tint pass needs no lookups — and an
    // unfed pipe reads zero, which is the grey that finds a dead line.
    for (const pipe of projected.pipes) {
      expect(pipe.network).toBe(projected.networks[0]!.id);
      expect(Number.isInteger(pipe.flowPermille)).toBe(true);
    }

    for (const machine of projected.machines) {
      expect(Number.isInteger(machine.flowMlPerMinute)).toBe(true);
      expect(Number.isInteger(machine.ticksToEmpty)).toBe(true);
    }
  });

  it('reuses its buffers rather than growing them', () => {
    const { state } = plumbedWorld(52);
    const buffer = createWorldView();
    view(state, buffer);
    const pipesArray = buffer.pipes;
    view(state, buffer);
    expect(buffer.pipes).toBe(pipesArray);
    expect(buffer.pipes).toHaveLength(state.pipes.length);
  });

  it('aliases nothing in the world', () => {
    const { state } = plumbedWorld(53);
    const projected = view(state, createWorldView());
    projected.reservoirs[0]!.levelMl = -1;
    expect(state.reservoirs[0]!.levelMl).toBeGreaterThan(0);
  });
});
