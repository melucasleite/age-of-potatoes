// Item 070: the no-op walk errand. Clicking empty ground walks the farmer there, and
// arrival IS completion — no verb, no touch, no sound, no second trace entry.
//
// The design constraint this file watches: `IntentAction.Walk` rides the SAME errand
// machinery as every working verb — one command in the trace, replacement on a second click,
// the same timeout, the same save shape — so the tests here are mostly the ordinary errand
// facts asserted against a verb that does nothing at the end.

import { describe, expect, it } from 'vitest';

import {
  type WorldState,
  CAN_CHARGES_MAX,
  Direction,
  IntentAction,
  ItemId,
  MachineKind,
  addItem,
  createWorld,
  fromPayload,
  hashState,
  itemCount,
  spawnMachine,
  step,
  toPayload,
  waterAtSubtile,
} from '../src/index';
import { POND_ORIGIN_X, POND_ORIGIN_Y, POND_TILES_HIGH, POND_TILES_WIDE } from '../src/data';
import { SUBTILE, tileCentreSubtiles } from '../src/units';

const HAND_REACH_SUBTILES = 384;

function walkCommand(tileX: number, tileY: number) {
  return {
    type: 'WalkAndAct',
    action: IntentAction.Walk,
    tileX,
    tileY,
    item: 0,
    count: 0,
  } as const;
}

function stepEmpty(state: WorldState, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(state, { tick: state.tick, commands: [] });
}

function finishIntent(state: WorldState): number {
  let ticks = 0;
  while (state.player.intent !== null) {
    step(state, { tick: state.tick, commands: [] });
    ticks += 1;
    if (ticks > 10_000) throw new Error('the walk never ended');
  }
  return ticks;
}

function withinReach(state: WorldState, tileX: number, tileY: number): boolean {
  const dx = state.player.xSub - tileCentreSubtiles(tileX);
  const dy = state.player.ySub - tileCentreSubtiles(tileY);
  return dx * dx + dy * dy <= HAND_REACH_SUBTILES * HAND_REACH_SUBTILES;
}

describe('the no-op walk errand', () => {
  it('walks to empty owned ground and does exactly nothing on arrival', () => {
    const state = createWorld(70);
    const touchesBefore = JSON.stringify(state.stats.touches);
    const target = { x: 2, y: 2 };

    const trace = state.trace.length;
    step(state, { tick: state.tick, commands: [walkCommand(target.x, target.y)] });
    expect(state.trace.length, 'the walk click was refused').toBe(trace + 1);
    expect(state.player.intent).not.toBeNull();

    const walked = finishIntent(state);
    expect(walked, 'the farmer teleported').toBeGreaterThan(0);
    expect(withinReach(state, target.x, target.y), 'never arrived').toBe(true);
    // ARRIVAL IS SILENT: no touch counted, nothing appended. (The clock ran; walking is time.)
    expect(state.trace.length).toBe(trace + 1);
    expect(JSON.stringify(state.stats.touches)).toBe(touchesBefore);
  });

  it('retargets on a second click mid-walk — the ordinary errand replacement', () => {
    const state = createWorld(71);
    step(state, { tick: state.tick, commands: [walkCommand(2, 2)] });
    stepEmpty(state, 10);
    expect(state.player.intent).not.toBeNull();

    step(state, { tick: state.tick, commands: [walkCommand(14, 2)] });
    expect(state.player.intent?.tileX).toBe(14);
    expect(state.player.intent?.tileY).toBe(2);

    finishIntent(state);
    expect(withinReach(state, 14, 2)).toBe(true);
    expect(withinReach(state, 2, 2)).toBe(false);
  });

  it('refuses unowned land and open water, exactly as a working click would', () => {
    const state = createWorld(72);
    const trace = state.trace.length;

    // The far corner of the map: a real place with a price on it, not walkable yet.
    step(state, { tick: state.tick, commands: [walkCommand(62, 62)] });
    expect(state.trace.length, 'walked onto unowned land').toBe(trace);
    expect(state.player.intent).toBeNull();

    // The pond. Nothing in this world is solid, but water is not standable.
    step(state, { tick: state.tick, commands: [walkCommand(POND_ORIGIN_X, POND_ORIGIN_Y)] });
    expect(state.trace.length, 'walked into the pond').toBe(trace);
    expect(state.player.intent).toBeNull();
  });

  it('yields to a held movement key, like every errand', () => {
    const state = createWorld(73);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.East }],
    });
    const trace = state.trace.length;
    step(state, { tick: state.tick, commands: [walkCommand(2, 2)] });
    expect(state.trace.length, 'the click overruled the held key').toBe(trace);
  });

  it('survives a mid-walk save and completes after the reload', () => {
    const state = createWorld(74);
    step(state, { tick: state.tick, commands: [walkCommand(2, 12)] });
    stepEmpty(state, 15);
    expect(state.player.intent?.action).toBe(IntentAction.Walk);

    // The save round-trip, mid-stride: same hash coming back, and the same walk still loaded.
    const restored = fromPayload(toPayload(state), state.trace);
    expect(hashState(restored)).toBe(hashState(state));
    expect(restored.player.intent?.action).toBe(IntentAction.Walk);

    // Both worlds finish the walk on their own and agree on every subtile of it.
    finishIntent(state);
    finishIntent(restored);
    expect(hashState(restored)).toBe(hashState(state));
    expect(withinReach(restored, 2, 12)).toBe(true);
  });

  it('walks across its own farmland and machines — nothing is solid', () => {
    const state = createWorld(75);
    // Straight across the starting field: the walk is a straight line THROUGH the crops'
    // tiles, locked by item 050 ("NO PATHING LIVES HERE"), and farmland is standable ground.
    step(state, { tick: state.tick, commands: [walkCommand(7, 7)] });
    expect(state.player.intent).not.toBeNull();
    finishIntent(state);
    expect(withinReach(state, 7, 7)).toBe(true);
  });
});

// --- item 080: the pond is not a floor ------------------------------------------------
//
// Nobody walks on water. WASD stops at the shore the way it stops at the world edge, an
// errand whose straight line meets the pond stops at the bank and lets go (no pathing —
// item 050's doctrine stands; the player routes around by hand), and the refill errand
// keeps working because it aims at the bank-side reach, never at a wet footstep.

describe('the pond is not a floor (item 080)', () => {
  const pondWest = POND_ORIGIN_X; // 12
  const pondNorth = POND_ORIGIN_Y; // 13
  const pondEast = POND_ORIGIN_X + POND_TILES_WIDE - 1; // 14
  const pondSouth = POND_ORIGIN_Y + POND_TILES_HIGH - 1; // 15

  function standOn(state: WorldState, tileX: number, tileY: number): void {
    state.player.xSub = tileCentreSubtiles(tileX);
    state.player.ySub = tileCentreSubtiles(tileY);
  }

  function holdDirection(state: WorldState, dir: Direction, ticks: number): void {
    step(state, { tick: state.tick, commands: [{ type: 'SetMoveDirection', dir }] });
    stepEmpty(state, ticks);
  }

  it('stops WASD at the shore from every direction, on the last dry subtile', () => {
    // Four approaches, four banks. 40 ticks at ~51 subtiles a tick is several tiles of
    // travel — more than enough to hit the water if it were still a floor.
    const east = createWorld(80);
    standOn(east, pondWest - 1, pondNorth + 1);
    holdDirection(east, Direction.East, 40);
    expect(east.player.xSub).toBe(pondWest * SUBTILE - 1);
    expect(waterAtSubtile(east, east.player.xSub, east.player.ySub)).toBe(false);

    const west = createWorld(80);
    standOn(west, pondEast + 1, pondNorth + 1);
    holdDirection(west, Direction.West, 40);
    expect(west.player.xSub).toBe((pondEast + 1) * SUBTILE);
    expect(waterAtSubtile(west, west.player.xSub, west.player.ySub)).toBe(false);

    const south = createWorld(80);
    standOn(south, pondWest + 1, pondNorth - 1);
    holdDirection(south, Direction.South, 40);
    expect(south.player.ySub).toBe(pondNorth * SUBTILE - 1);
    expect(waterAtSubtile(south, south.player.xSub, south.player.ySub)).toBe(false);

    const north = createWorld(80);
    standOn(north, pondWest + 1, pondSouth + 1);
    holdDirection(north, Direction.North, 40);
    expect(north.player.ySub).toBe((pondSouth + 1) * SUBTILE);
    expect(waterAtSubtile(north, north.player.xSub, north.player.ySub)).toBe(false);
  });

  it('lets a player already standing on water walk off it — never trapped', () => {
    // The legacy-save escape: a world saved before the pond was solid can come back with
    // the farmer mid-pond. Blocking would trap them forever; walking off must work.
    const state = createWorld(81);
    standOn(state, pondWest + 1, pondNorth + 1); // The middle of the pond.
    expect(waterAtSubtile(state, state.player.xSub, state.player.ySub)).toBe(true);
    holdDirection(state, Direction.East, 60);
    expect(waterAtSubtile(state, state.player.xSub, state.player.ySub)).toBe(false);
  });

  it('stops an errand at the bank when its straight line crosses the pond, without livelock', () => {
    // Clicking a far tile whose straight line crosses the pond: the walk stops at the
    // water's edge like it stops at any blocked step, and the errand ends there — quietly,
    // immediately, not after a timeout. Routing around is the player's job (item 050).
    const state = createWorld(82);
    standOn(state, 2, pondNorth + 1);
    step(state, { tick: state.tick, commands: [walkCommand(pondEast + 1, pondNorth + 1)] });
    expect(state.player.intent).not.toBeNull();

    const walked = finishIntent(state);
    // Ends at the shore on its own, well inside the errand timeout — not a livelock.
    expect(walked).toBeLessThan(200);
    expect(waterAtSubtile(state, state.player.xSub, state.player.ySub)).toBe(false);
    // Stopped WEST of the pond: the line was never walked through the water.
    expect(state.player.xSub).toBeLessThan(pondWest * SUBTILE);
    expect(withinReach(state, pondEast + 1, pondNorth + 1)).toBe(false);
  });

  it('still refills the can from the bank — the shore remains exactly reachable', () => {
    // The care-list item: `reservoirWithinReach` and `nearestPointOfReservoir` aim the walk
    // at the bank, and arrival-by-reach (384 subtiles) always lands before a wet footstep
    // (~51 subtiles) could. Walk TO the bank, never INTO the water.
    const state = createWorld(83);
    standOn(state, 2, 2);
    state.player.canCharges = 0;
    step(state, {
      tick: state.tick,
      commands: [
        {
          type: 'WalkAndAct',
          action: IntentAction.RefillCan,
          tileX: pondWest - 1,
          tileY: pondNorth,
          item: 0,
          count: 0,
        },
      ],
    });
    expect(state.player.intent).not.toBeNull();

    finishIntent(state);
    expect(state.player.canCharges).toBe(CAN_CHARGES_MAX);
    expect(waterAtSubtile(state, state.player.xSub, state.player.ySub)).toBe(false);
  });
});

describe('the load errand carries what the click carried (item 105)', () => {
  // **A WALK THAT ARRIVES AND DOES NOTHING IS WORSE THAN A REFUSAL**, because the player watches
  // the farmer cross the yard and concludes the machine is broken. That is exactly what every
  // out-of-reach click on a Root Cellar did: `intentCommand` built its `LoadMachine` without the
  // item, and a box — which has no recipe to guess from — refuses a load that names nothing.
  //
  // The errand's payload always had an `item` field. Plant, Sell and Buy all used it. Load simply
  // dropped it on the floor, and nothing noticed for as long as the only things worth walking to
  // were recipe machines that can only eat one thing anyway.

  function loadErrand(tileX: number, tileY: number, item: number, count: number) {
    return {
      type: 'WalkAndAct',
      action: IntentAction.Load,
      tileX,
      tileY,
      item,
      count,
    } as const;
  }

  function farmerAt(seed: number) {
    const state = createWorld(seed);
    state.player.xSub = tileCentreSubtiles(2);
    state.player.ySub = tileCentreSubtiles(2);
    return state;
  }

  it('walks to a Root Cellar and actually fills it', () => {
    const state = farmerAt(90);
    const cellar = spawnMachine(state, MachineKind.RootCellar, 12, 10)!;
    addItem(state, ItemId.RussetPotato, 20);

    step(state, { tick: state.tick, commands: [loadErrand(12, 10, ItemId.RussetPotato, 20)] });
    expect(state.player.intent).not.toBeNull();

    const walked = finishIntent(state);
    expect(walked, 'the farmer teleported').toBeGreaterThan(0);
    expect(cellar.cargoItem).toBe(ItemId.RussetPotato);
    expect(cellar.cargoCount).toBe(20);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(0);
  });

  it('and the same errand naming nothing still arrives at nothing — the box cannot guess', () => {
    // Not a regression, a boundary: the sim refuses an unnamed load at a box on purpose, and the
    // caller is what had to change. Pinned so a future "helpful" default in `applyLoadMachine`
    // has to argue with a test rather than with a comment.
    const state = farmerAt(91);
    const cellar = spawnMachine(state, MachineKind.RootCellar, 12, 10)!;
    addItem(state, ItemId.RussetPotato, 20);

    step(state, { tick: state.tick, commands: [loadErrand(12, 10, 0, 20)] });
    finishIntent(state);

    expect(cellar.cargoCount).toBe(0);
    expect(itemCount(state, ItemId.RussetPotato)).toBe(20);
  });

  it('leaves a recipe machine exactly as it found it — 0 still means "whatever fits"', () => {
    // The compatibility claim the golden hashes rest on. Every caller in the tree issues this
    // errand with item 0 today, and 0 means the field is absent, so the command built here is
    // byte-identical to the one built before this item.
    const state = farmerAt(92);
    const washer = spawnMachine(state, MachineKind.Washer, 12, 10)!;
    addItem(state, ItemId.RussetPotato, 20);

    step(state, { tick: state.tick, commands: [loadErrand(12, 10, 0, 20)] });
    finishIntent(state);

    expect(washer.inputCounts[0]).toBeGreaterThan(0);
    expect(itemCount(state, ItemId.RussetPotato)).toBeLessThan(20);
  });
});

// Keep the constant honest: if reach retunes, this file should fail loudly, not drift.
it('pins the reach the tests above measure with', async () => {
  const data = await import('../src/data');
  expect(data.HAND_REACH_SUBTILES).toBe(HAND_REACH_SUBTILES);
});

// `SUBTILE` is imported for the reach maths above; assert the base so the maths reads true.
it('pins the subtile base', () => {
  expect(SUBTILE).toBe(256);
});
