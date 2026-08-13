// Structural gates for the simulation core.
//
// These are the cheap checks that catch a broken determinism guarantee the day it breaks.
// The standing golden fixtures and the CI job that runs them belong to work item 003; this
// file is the seed they grow from.

import { describe, expect, it } from 'vitest';

import {
  type Command,
  type WorldState,
  CropId,
  Direction,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  IntentAction,
  ItemId,
  MachineKind,
  createWorld,
  createWorldView,
  deriveStream,
  findNonIntegerFields,
  hashState,
  itemCount,
  nextUint32,
  step,
  stepMany,
  tileAt,
  view,
} from '../src/index';

/**
 * A fixed script: plant, water, walk to the sell bin, sell, walk back. Enough to move the
 * player, draw from two RNG streams, touch money, and exercise five command variants.
 */
function scriptedCommands(tick: number): Command[] {
  switch (tick) {
    case 0:
      return [{ type: 'PlantTile', tileX: 8, tileY: 11, crop: CropId.RussetPotato }];
    case 1:
      return [{ type: 'WaterTile', tileX: 8, tileY: 11 }];
    case 2:
      return [
        { type: 'PlantTile', tileX: 7, tileY: 11, crop: CropId.RussetPotato },
        { type: 'WaterTile', tileX: 7, tileY: 11 },
      ];
    case 3:
      return [{ type: 'SetMoveDirection', dir: Direction.West }];
    case 33:
      return [{ type: 'SetMoveDirection', dir: Direction.None }];
    case 40:
      return [{ type: 'SellItem', item: ItemId.PotatoSeed, count: 2 }];
    case 41:
      return [{ type: 'SetMoveDirection', dir: Direction.East }];
    case 71:
      return [{ type: 'SetMoveDirection', dir: Direction.None }];
    case 90:
      return [{ type: 'WaterTile', tileX: 8, tileY: 11 }];
    default:
      return [];
  }
}

function runScript(seed: number, ticks: number): WorldState {
  const state = createWorld(seed);
  for (let i = 0; i < ticks; i++) {
    step(state, { tick: state.tick, commands: scriptedCommands(state.tick) });
  }
  return state;
}

describe('determinism', () => {
  it('produces the same hash for the same seed and command list', () => {
    expect(hashState(runScript(1234, 1000))).toBe(hashState(runScript(1234, 1000)));
  });

  it('pins the scripted run to a known hash', () => {
    // If this changes, either the sim changed on purpose or determinism broke by accident.
    // There is no third option, which is the entire point of the fixture.
    expect(hashState(runScript(1234, 1000))).toBe('79efacc8');
  });

  it('gives different seeds different worlds', () => {
    expect(hashState(createWorld(1))).not.toBe(hashState(createWorld(2)));
  });

  it('gives the same seed identical empty worlds', () => {
    expect(hashState(createWorld(7))).toBe(hashState(createWorld(7)));
  });

  it('survives a JSON round trip', () => {
    const state = runScript(99, 500);
    const revived = JSON.parse(JSON.stringify(state)) as WorldState;
    expect(hashState(revived)).toBe(hashState(state));
  });

  it('keeps every hashed field an integer', () => {
    expect(findNonIntegerFields(runScript(1234, 1000))).toEqual([]);
  });

  it('makes a stray float visible', () => {
    const state = runScript(1234, 200);
    const clean = hashState(state);
    state.field[0]!.moisture = 12.5;
    expect(hashState(state)).not.toBe(clean);
    expect(findNonIntegerFields(state)).toEqual(['field[0].moisture = 12.5']);
  });
});

describe('rng streams', () => {
  it('leaves existing streams untouched when a new consumer is registered', () => {
    const before = hashState(runScript(1234, 1000));

    // A throwaway system nobody had thought of yet, drawn from hard.
    const newcomer = deriveStream(1234, 'crop-disease' as never);
    for (let i = 0; i < 64; i++) nextUint32(newcomer);

    expect(hashState(runScript(1234, 1000))).toBe(before);
  });

  it('derives independent streams per system', () => {
    const growth = deriveStream(42, 'crop-growth' as never);
    const harvest = deriveStream(42, 'harvest' as never);
    expect(nextUint32(growth)).not.toBe(nextUint32(harvest));
  });
});

describe('the trace', () => {
  it('holds exactly the applied commands, in application order', () => {
    const state = runScript(1234, 100);
    const applied = state.trace.map((entry) => `${entry.tick}:${entry.command.type}`);

    expect(applied).toEqual([
      '0:PlantTile',
      '1:WaterTile',
      '2:PlantTile',
      '2:WaterTile',
      '3:SetMoveDirection',
      '33:SetMoveDirection',
      // The script's tick-40 `SellItem` is NOT here, and that absence is the point. It sells
      // two potato seeds, and the sell bin no longer buys seeds — so the command is refused and
      // a refused command never reaches the trace. The script keeps issuing it deliberately:
      // `canary-1000`'s command list is frozen input, and a verb the simulation started
      // rejecting is a finding worth keeping in front of whoever reads this next.
      '41:SetMoveDirection',
      '71:SetMoveDirection',
      '90:WaterTile',
    ]);
  });

  it('does not record rejected commands', () => {
    const state = createWorld(5);
    // Way out of reach, and there is no field tile there anyway.
    step(state, { tick: 0, commands: [{ type: 'WaterTile', tileX: 0, tileY: 0 }] });
    expect(state.trace).toHaveLength(0);
  });

  // ONE GESTURE, ONE ENTRY — the rule zones and pipe runs are each already pinned by, and the
  // one a walk-to errand is most likely to break, because it is the only command that stays
  // live for dozens of ticks and every one of those ticks is a chance to append something.
  // It would break SILENTLY: the trace is excluded from the hash and from the save, so the
  // golden fixtures cannot see it and nothing else in this suite would fail.
  it('records a whole errand as exactly one entry, however long the walk', () => {
    const state = createWorld(77);
    const before = state.trace.length;
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'WalkAndAct', action: IntentAction.Water, tileX: 4, tileY: 4, item: 0, count: 0 },
      ],
    });
    expect(state.player.intent).not.toBeNull();

    let walked = 0;
    while (state.player.intent !== null && walked < 500) {
      step(state, { tick: state.tick, commands: [] });
      walked++;
    }

    // The walk has to be real, or this test passes for the wrong reason.
    expect(walked).toBeGreaterThan(1);
    expect(state.player.intent).toBeNull();
    expect(state.trace.length - before).toBe(1);
    expect(state.trace[state.trace.length - 1]!.command.type).toBe('WalkAndAct');
  });
});

describe('walk-to errands', () => {
  // THE OTHER HALF OF "MANUAL CONTROL ALWAYS WINS". `applySetMoveDirection` covers the player
  // who grabs the wheel DURING a walk. This is the half that was missing: the player who was
  // ALREADY holding a direction when they clicked. Their key sends no second command — there
  // is nothing to change — so nothing was left to cancel the errand, and the click overruled
  // the key they were still holding down.
  it('refuses an errand while a movement key is held', () => {
    const state = createWorld(77);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.North }],
    });

    const before = state.trace.length;
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'WalkAndAct', action: IntentAction.Water, tileX: 4, tileY: 4, item: 0, count: 0 },
      ],
    });

    expect(state.player.intent).toBeNull();
    // Refused, not queued — a pending errand that fired on key release would be the farmer
    // walking off on their own, which is the surprise the whole feature exists to avoid.
    expect(state.trace.length).toBe(before);
    expect(state.player.moveDir).toBe(Direction.North);
  });

  it('takes the errand once the key is released', () => {
    const state = createWorld(77);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.North }],
    });
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.None }],
    });
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'WalkAndAct', action: IntentAction.Water, tileX: 4, tileY: 4, item: 0, count: 0 },
      ],
    });

    expect(state.player.intent).not.toBeNull();
  });

  // ±Infinity IS an integer as far as `Math.trunc(x) !== x` is concerned, and this guard is
  // the only thing standing between a command payload and the save file. An infinite count
  // reached world state and then made the world refuse to serialize.
  it('refuses a non-finite payload rather than storing it in the world', () => {
    const state = createWorld(77);
    for (const bad of [Infinity, -Infinity, NaN, 1.5]) {
      step(state, {
        tick: state.tick,
        commands: [
          {
            type: 'WalkAndAct',
            action: IntentAction.Water,
            tileX: 4,
            tileY: 4,
            item: 0,
            count: bad,
          },
        ],
      });
      expect(state.player.intent).toBeNull();
    }
  });
});

describe('the v0.1 loop', () => {
  it('grows, harvests, and sells a potato', () => {
    const state = createWorld(2026);
    const tileX = FIELD_ORIGIN_X + 4;
    const tileY = FIELD_ORIGIN_Y + 7;

    step(state, {
      tick: state.tick,
      commands: [{ type: 'PlantTile', tileX, tileY, crop: CropId.RussetPotato }],
    });
    expect(tileAt(state, tileX, tileY)?.crop).toBe(CropId.RussetPotato);

    // Keep it watered until it is ready. Growth accrues only on watered ticks.
    for (let i = 0; i < 3000; i++) {
      if (i % 100 === 0) {
        step(state, { tick: state.tick, commands: [{ type: 'WaterTile', tileX, tileY }] });
      } else {
        stepMany(state, 1);
      }
    }

    const potatoesBefore = itemCount(state, ItemId.RussetPotato);
    step(state, { tick: state.tick, commands: [{ type: 'HarvestTile', tileX, tileY }] });
    const harvested = itemCount(state, ItemId.RussetPotato) - potatoesBefore;
    expect(harvested).toBeGreaterThan(0);

    // Walk west to the sell bin. 30 ticks at 4 tiles/s covers exactly six tiles.
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.West }],
    });
    stepMany(state, 29);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.None }],
    });

    const moneyBefore = state.moneyCents;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SellItem', item: ItemId.RussetPotato, count: harvested }],
    });
    expect(state.moneyCents).toBeGreaterThan(moneyBefore);
    expect(state.stats.lifetimeEarnedCents).toBeGreaterThan(0);
  });

  it('waters a patch from a filled sprinkler and bills the water to the refill', () => {
    const state = createWorld(77);
    state.moneyCents = 100_000;

    const tileX = FIELD_ORIGIN_X - 1;
    const tileY = FIELD_ORIGIN_Y + 1;
    state.player.xSub = tileX * 256 + 128;
    state.player.ySub = tileY * 256 + 128;

    step(state, {
      tick: state.tick,
      commands: [{ type: 'PlaceMachine', kind: MachineKind.Sprinkler, tileX, tileY }],
    });
    const sprinkler = state.machines[state.machines.length - 1]!;
    expect(sprinkler.kind).toBe(MachineKind.Sprinkler);

    step(state, {
      tick: state.tick,
      commands: [{ type: 'RefillHopper', machineId: sprinkler.id }],
    });
    expect(state.stats.waterDrawnMl).toBeGreaterThan(0);
    expect(state.stats.touches.hopperRefill).toBe(1);

    const drawnAfterRefill = state.stats.waterDrawnMl;
    stepMany(state, 5);
    expect(tileAt(state, FIELD_ORIGIN_X, tileY)?.moisture).toBeGreaterThan(0);
    // Pouring from its own barrel is not a second draw on the reservoir.
    expect(state.stats.waterDrawnMl).toBe(drawnAfterRefill);
  });
});

describe('the view seam', () => {
  it('returns plain data that does not alias live state', () => {
    const state = runScript(11, 300);
    const buffer = createWorldView();
    const projected = view(state, buffer);

    const before = projected.field.moisturePermille[0];
    state.field[0]!.moisture = 0;
    expect(projected.field.moisturePermille[0]).toBe(before);

    // Plain enough to survive the trip a Worker would put it through.
    expect(() => JSON.stringify(projected)).not.toThrow();
    expect(view(state, buffer)).toBe(buffer);
  });

  // The renderer draws a destination marker off these four integers, and the whole reason
  // they are integers rather than a nullable object is that the projection buffer is
  // allocated once and reused forever.
  it('publishes no errand as a zero action', () => {
    const state = createWorld(77);
    const projected = view(state, createWorldView());

    expect(state.player.intent).toBeNull();
    expect(projected.player.intentAction).toBe(0);
  });

  it('publishes the errand target while one is pending', () => {
    const state = createWorld(77);
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'WalkAndAct', action: IntentAction.Water, tileX: 4, tileY: 4, item: 0, count: 0 },
      ],
    });

    const projected = view(state, createWorldView());
    expect(projected.player.intentAction).toBe(IntentAction.Water);
    expect(projected.player.intentTileX).toBe(4);
    expect(projected.player.intentTileY).toBe(4);
    expect(projected.player.intentIssuedTick).toBe(state.player.intent!.issuedTick);
  });

  // THE BUG THIS BUFFER DESIGN INVITES, pinned: an errand that ended must not leave last
  // frame's marker sitting on the map. It fails silently — the world is correct and only the
  // picture is wrong — which is exactly the kind this file exists to catch.
  it('clears the errand out of the reused buffer when it ends', () => {
    const state = createWorld(77);
    const buffer = createWorldView();
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'WalkAndAct', action: IntentAction.Water, tileX: 4, tileY: 4, item: 0, count: 0 },
      ],
    });
    expect(view(state, buffer).player.intentAction).toBe(IntentAction.Water);

    // Manual control abandons it, and the very next projection must say so.
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.South }],
    });
    expect(state.player.intent).toBeNull();

    const after = view(state, buffer);
    expect(after.player.intentAction).toBe(0);
    expect(after.player.intentTileX).toBe(0);
    expect(after.player.intentTileY).toBe(0);
    expect(after.player.intentIssuedTick).toBe(0);
  });

  it('projects the gross and spend halves of the lifetime ledger', () => {
    const state = runScript(11, 300);
    const projected = view(state, createWorldView());

    expect(projected.stats.lifetimeEarnedCents).toBe(state.stats.lifetimeEarnedCents);
    expect(projected.stats.lifetimeSpentCents).toBe(state.stats.lifetimeSpentCents);
    // The net figure the HUD already showed is the difference of the two, so a report that
    // prints all three cannot contradict itself.
    expect(projected.stats.lifetimeNetEarningsCents).toBe(
      projected.stats.lifetimeEarnedCents - projected.stats.lifetimeSpentCents,
    );
  });
});
