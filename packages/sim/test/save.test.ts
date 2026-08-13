// The save format's structural gates.
//
// The one that matters most is the round trip: a world, serialized, stringified, parsed, and
// deserialized must hash identically to the world it came from. Plan §17 calls it the save
// round-trip check, and it is what makes the envelope and the digest incapable of disagreeing
// about what the world *is*.
//
// The fixture test at the bottom is the permanent one. See `fixtures/saves/README.md`.

import { describe, expect, it } from 'vitest';

import {
  type Command,
  type SaveEnvelope,
  type WorldState,
  CURRENT_FORMAT_VERSION,
  CeremonyId,
  CropId,
  DEED_PRICE_CENTS_BY_PURCHASE,
  Direction,
  IntentAction,
  ItemId,
  MachineKind,
  OVERCOOK_BLOCKED_TICKS,
  PARCEL_TILES,
  REPAIR_KIT_PRICE_CENTS,
  SIM_CODE_VERSION,
  SIM_VERSION,
  SUBTILE,
  SaveCorruptError,
  SaveFormatTooNewError,
  BALANCE_HASH,
  checkSimVersion,
  computeNetWorthCents,
  createWorld,
  deserialize,
  hashState,
  landValueCents,
  migrate,
  parseEnvelope,
  restoreWorld,
  serialize,
  step,
  stepMany,
  worldTileIndex,
} from '../src/index';
import fixture from './fixtures/saves/format-1.json';
import fixture2 from './fixtures/saves/format-2.json';
import fixture3 from './fixtures/saves/format-3.json';
import fixture4 from './fixtures/saves/format-4.json';
import fixture5 from './fixtures/saves/format-5.json';
import fixture6 from './fixtures/saves/format-6.json';
import fixture7 from './fixtures/saves/format-7.json';
import fixture8 from './fixtures/saves/format-8.json';

/** A short session with a machine bought, fed, and left mid-operation. */
function playedWorld(): WorldState {
  const state = createWorld(4242);
  const run = (commands: readonly Command[]): void => {
    step(state, { tick: state.tick, commands });
  };

  run([{ type: 'PlantTile', tileX: 8, tileY: 11, crop: CropId.RussetPotato }]);
  run([{ type: 'WaterTile', tileX: 8, tileY: 11 }]);
  run([{ type: 'PlantTile', tileX: 7, tileY: 11, crop: CropId.RussetPotato }]);
  run([{ type: 'SetMoveDirection', dir: Direction.East }]);
  stepMany(state, 19);
  run([{ type: 'SetMoveDirection', dir: Direction.None }]);
  // Money is a gift here rather than an economy: this world exists to exercise the fields.
  state.moneyCents += 20_000;
  run([{ type: 'PlaceMachine', kind: MachineKind.ChipKitchen, tileX: 12, tileY: 11 }]);
  stepMany(state, 500);
  return state;
}

/** The same world, stopped part-way through a walk-to errand. */
function walkingWorld(): WorldState {
  const state = playedWorld();
  step(state, {
    tick: state.tick,
    commands: [
      { type: 'WalkAndAct', action: IntentAction.Water, tileX: 4, tileY: 4, item: 0, count: 0 },
    ],
  });
  stepMany(state, 20);
  if (state.player.intent === null) throw new Error('Fixture world is not mid-errand.');
  return state;
}

/** What a browser actually does: JSON in, JSON out. */
function throughJson(envelope: SaveEnvelope): unknown {
  return JSON.parse(JSON.stringify(envelope)) as unknown;
}

describe('the save round trip', () => {
  it('restores a world that hashes identically', () => {
    const state = playedWorld();
    const restored = restoreWorld(throughJson(serialize(state)));

    expect(hashState(restored.state)).toBe(hashState(state));
    expect(restored.state.tick).toBe(state.tick);
    expect(restored.state.worldSeed).toBe(state.worldSeed);
  });

  it('restores a world that keeps simulating identically', () => {
    const state = playedWorld();
    const restored = restoreWorld(throughJson(serialize(state))).state;

    stepMany(state, 400);
    stepMany(restored, 400);
    expect(hashState(restored)).toBe(hashState(state));
  });

  it('restores the leaderboard accumulators rather than recomputing them', () => {
    const state = playedWorld();
    const restored = restoreWorld(throughJson(serialize(state))).state;
    expect(restored.stats).toEqual(state.stats);
  });

  it('copies the seed and tick onto the envelope header', () => {
    const state = playedWorld();
    const envelope = serialize(state);
    expect(envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(envelope.simVersion).toBe(SIM_VERSION);
    expect(envelope.worldSeed).toBe(state.worldSeed);
    expect(envelope.tick).toBe(state.tick);
  });

  it('produces byte-identical JSON for identical worlds', () => {
    const a = JSON.stringify(serialize(playedWorld()));
    const b = JSON.stringify(serialize(playedWorld()));
    expect(a).toBe(b);
  });

  it('emits RNG streams as an array sorted by id, not as a map', () => {
    const payload = serialize(playedWorld()).payload as { streams: { id: string }[] };
    const ids = payload.streams.map((stream) => stream.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids.length).toBeGreaterThan(1);
  });

  it('is plain JSON with no typed arrays and no undefined', () => {
    const text = JSON.stringify(serialize(playedWorld()));
    expect(text).not.toContain('undefined');
    // Legible in a text editor without tooling, which is the entire argument for JSON.
    expect(text).toContain('"moisture"');
    expect(text).toContain('"moneyCents"');
  });

  // The errand is hashed, so a save that dropped it would restore a world that hashes
  // differently from the one that was written — which is the definition of a broken save,
  // and the reason `intent` is persisted rather than treated as transient input state.
  it('carries a pending errand through the round trip', () => {
    const state = walkingWorld();
    const restored = restoreWorld(throughJson(serialize(state))).state;

    expect(restored.player.intent).toEqual(state.player.intent);
    expect(hashState(restored)).toBe(hashState(state));
  });

  it('keeps a round-tripped errand walking identically', () => {
    const state = walkingWorld();
    const restored = restoreWorld(throughJson(serialize(state))).state;

    stepMany(state, 300);
    stepMany(restored, 300);
    expect(hashState(restored)).toBe(hashState(state));
    // Both arrived and both let go of the errand, rather than both being stuck.
    expect(restored.player.intent).toBeNull();
  });

  it('writes no errand as null rather than as a zeroed row', () => {
    const payload = serialize(playedWorld()).payload as { player: { intent: unknown } };
    expect(payload.player.intent).toBeNull();
    // `null` and "an errand to tile 0,0 doing nothing" must not be the same bytes.
    const restored = restoreWorld(throughJson(serialize(playedWorld()))).state;
    expect(restored.player.intent).toBeNull();
  });

  it('does not alias the live errand into the payload', () => {
    const state = walkingWorld();
    const payload = serialize(state).payload as { player: { intent: { tileX: number } } };
    // `serialize()` is documented as safe to call mid-tick, which is only true if the payload
    // shares no object with the world. The errand is the player's one non-number field.
    expect(payload.player.intent).not.toBe(state.player.intent);
    payload.player.intent.tileX = 99;
    expect(state.player.intent!.tileX).toBe(4);
  });

  it('leaves the trace out of the payload and out of the restored world', () => {
    const state = playedWorld();
    expect(state.trace.length).toBeGreaterThan(0);

    const payload = serialize(state).payload as Record<string, unknown>;
    expect(payload['trace']).toBeUndefined();

    const restored = restoreWorld(throughJson(serialize(state))).state;
    expect(restored.trace).toEqual([]);
    // The trace is not hashed, so leaving it behind costs the round trip nothing.
    expect(hashState(restored)).toBe(hashState(state));
  });
});

describe('the version key', () => {
  it('fuses the code version with the balance hash', () => {
    expect(SIM_VERSION).toBe(`${SIM_CODE_VERSION}+${BALANCE_HASH}`);
    expect(BALANCE_HASH).toMatch(/^[0-9a-f]{8}$/);
  });

  it('reports a mismatch without blocking the load', () => {
    const envelope = serialize(playedWorld());
    const stale = { ...envelope, simVersion: '0.0.9+deadbeef' };

    const restored = restoreWorld(throughJson(stale));
    expect(restored.simVersion.matches).toBe(false);
    expect(restored.simVersion.saved).toBe('0.0.9+deadbeef');
    expect(restored.simVersion.current).toBe(SIM_VERSION);
    // Loaded anyway. A balance change costs replay determinism, not the world.
    expect(restored.state.tick).toBe(envelope.tick);
  });

  it('agrees with itself', () => {
    expect(checkSimVersion(SIM_VERSION).matches).toBe(true);
  });
});

describe('migrations', () => {
  it('is a no-op at the current version', () => {
    const envelope = serialize(playedWorld());
    const outcome = migrate(envelope);
    expect(outcome.steps).toEqual([]);
    expect(outcome.fromVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(outcome.envelope).toBe(envelope);
  });

  it('refuses a save from a newer build and leaves it untouched', () => {
    const envelope = serialize(playedWorld());
    const fromTheFuture = throughJson({ ...envelope, formatVersion: 99 }) as Record<
      string,
      unknown
    >;
    const before = JSON.stringify(fromTheFuture);

    expect(() => restoreWorld(fromTheFuture)).toThrow(SaveFormatTooNewError);
    // Nothing was mutated on the way to the throw — the caller can still write it back.
    expect(JSON.stringify(fromTheFuture)).toBe(before);
  });

  it('names both versions in the refusal', () => {
    const envelope = { ...serialize(playedWorld()), formatVersion: 99 };
    expect(() => migrate(envelope)).toThrow(/save format 99/);
  });
});

describe('reading a damaged save', () => {
  it('rejects a value that is not an envelope', () => {
    expect(() => parseEnvelope(null)).toThrow(SaveCorruptError);
    expect(() => parseEnvelope('{}')).toThrow(SaveCorruptError);
    expect(() => parseEnvelope({ formatVersion: 1 })).toThrow(SaveCorruptError);
  });

  it('names the field that went wrong', () => {
    const envelope = throughJson(serialize(playedWorld())) as {
      payload: { field: { moisture: number }[] };
    };
    envelope.payload.field[3]!.moisture = 12.5;
    expect(() => restoreWorld(envelope)).toThrow(/payload\.field\[3\]\.moisture/);
  });

  it('names a bad field inside the errand', () => {
    const envelope = throughJson(serialize(walkingWorld())) as {
      payload: { player: { intent: { tileX: number } } };
    };
    envelope.payload.player.intent.tileX = 1.5;
    expect(() => restoreWorld(envelope)).toThrow(/payload\.player\.intent\.tileX/);
  });

  // `IntentAction.None` is not a legal errand action — an errand to do nothing is what
  // `null` encodes — so a payload carrying one is damaged, not merely idle.
  it('rejects an errand whose action is None', () => {
    const envelope = throughJson(serialize(walkingWorld())) as {
      payload: { player: { intent: { action: number } } };
    };
    envelope.payload.player.intent.action = IntentAction.None;
    expect(() => restoreWorld(envelope)).toThrow(/not an id this build knows/);
  });

  it('rejects an errand that is missing rather than null', () => {
    const envelope = throughJson(serialize(playedWorld())) as {
      payload: { player: Record<string, unknown> };
    };
    delete envelope.payload.player['intent'];
    // A format-4 payload always writes the key. Reading an absent one as "no errand" would
    // turn a damaged file and a skipped migration into worlds that look fine.
    expect(() => restoreWorld(envelope)).toThrow(/payload\.player\.intent/);
  });

  it('rejects an id this build does not know', () => {
    const envelope = throughJson(serialize(playedWorld())) as {
      payload: { machines: { kind: number }[] };
    };
    envelope.payload.machines[0]!.kind = 77;
    expect(() => restoreWorld(envelope)).toThrow(/not an id this build knows/);
  });

  it('refuses to deserialize an unmigrated envelope', () => {
    const envelope = { ...serialize(playedWorld()), formatVersion: 0 };
    expect(() => deserialize(envelope)).toThrow(/Run migrate\(\) first/);
  });
});

describe('the permanent fixture set', () => {
  // NEVER REGENERATE THIS FIXTURE. `fixtures/saves/format-1.json` is a real world saved by a
  // real build and it must stay byte-identical forever; it is the only thing that will catch
  // a migration bug in 2029.
  //
  // The expected DIGEST below is a different matter, and it has now moved four times, every
  // time on purpose. Format 2 added belts, grabbers, zones, tech unlocks, upgrade dials, and
  // the per-tile withering clock; format 3 added reservoirs, pipes, one-ledger networks, and
  // the per-machine plumbing fields; format 4 added the player's pending errand; format 5
  // added a machine's overcooking clock and its burnt count, plus the waste and repair-kit
  // tallies — all of them hashed — so the world this file restores to legitimately hashes
  // differently each time. That is the migration working, not the save breaking: the tick, the
  // seed, the money, and every machine came back unchanged, which is what the assertions
  // around it check.
  //
  // Format 4 is the cheapest of them to reason about and the easiest to get wrong. It adds
  // ONE nullable field, and `null` is the only value that leaves the loaded world behaving
  // like the saved one — a returning player must not find the farmer setting off across the
  // field on an errand they never issued. Format 5's five fields are all zero on the same
  // argument: a world that never had an overcooking clock has burnt nothing, and a world that
  // could not use a repair kit has used none.
  //
  // The rule this preserves: a red line here means "either a migration is missing, or the
  // format changed without one". If you are updating this hash, the commit had better also
  // add a step to the chain in `save/migrations.ts`.
  it('loads format-1.json and reproduces its world', () => {
    const restored = restoreWorld(fixture);

    expect(restored.migration.fromVersion).toBe(1);
    expect(restored.migration.steps).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(32096);
    expect(restored.state.worldSeed).toBe(20260812);
    expect(hashState(restored.state)).toBe('3efe8b92');
  });

  it('gives a migrated v0.1 world the factory fields at their empty defaults', () => {
    const state = restoreWorld(fixture).state;

    expect(state.belts).toEqual([]);
    expect(state.grabbers).toEqual([]);
    expect(state.zones).toEqual([]);
    expect(state.unlocked).toEqual([]);
    // Machines are invoiced at the price they were bought for, frozen in the migration
    // rather than looked up — today's table must not be able to rewrite an old save.
    const kitchen = state.machines.find((machine) => machine.kind === MachineKind.ChipKitchen);
    expect(kitchen?.investedCents).toBe(10_000);
    expect(kitchen?.speedLevel).toBe(0);
    // Nothing aged while the world was in a file: the withering clock restarts at zero.
    expect(state.field.every((tile) => tile.readyAge === 0 && tile.compost === 0)).toBe(true);

    // And the liquid layer's empty defaults, plus the one thing format 3 does NOT default:
    // the pond arrives FULL. The water was always notionally there — v0.1 drew from an
    // infinite supply — so a returning player must not find it drained by an update.
    expect(state.pipes).toEqual([]);
    expect(state.networks).toEqual([]);
    expect(state.ceremonies).toEqual([]);
    expect(state.reservoirs).toHaveLength(1);
    expect(state.reservoirs[0]!.levelMl).toBe(state.reservoirs[0]!.capacityMl);
    expect(state.machines.every((machine) => machine.network === 0)).toBe(true);
    expect(state.machines.every((machine) => machine.scanCursor === 0)).toBe(true);

    // And format 4's one field. Nobody was mid-walk when a v0.1 world was written, so `null`
    // is the only answer that is not an invention.
    expect(state.player.intent).toBeNull();
  });

  it('still contains the world it was recorded with', () => {
    const state = restoreWorld(fixture).state;
    const kinds = state.machines.map((machine) => machine.kind);
    expect(kinds).toEqual([MachineKind.SellBin, MachineKind.Sprinkler, MachineKind.ChipKitchen]);
    expect(state.machines[1]!.tankMl).toBeGreaterThan(0);
    expect(state.machines[2]!.progress).toBeGreaterThan(0);
    expect(state.stats.itemsProducedByMachine).toBeGreaterThan(0);
    expect(state.inventory.some((slot) => slot.item === ItemId.RussetPotato)).toBe(true);
  });

  it('loads under whatever balance data is current, matching or not', () => {
    const restored = restoreWorld(fixture);
    // Today this matches. The day a balance number moves, `SIM_VERSION` moves with it and
    // this stops matching — at which point the assertion that matters is the one below:
    // the world still loads. A balance change costs replay exactness, never the save.
    expect(restored.simVersion.saved).toBe(fixture.simVersion);
    expect(restored.state.tick).toBe(32096);
  });

  it('keeps simulating from where it left off', () => {
    const state = restoreWorld(fixture).state;
    const tickBefore = state.tick;
    stepMany(state, 100);
    expect(state.tick).toBe(tickBefore + 100);
    expect(state.stats.ticksElapsed).toBe(tickBefore + 100);
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as above.
  // format-2 is the first save with a factory in it, caught deliberately mid-flight: items on
  // both belt segments, three grabber arms holding something, machines part-way through an
  // operation. A save taken at a tidy moment tests nothing.
  it('migrates format-2.json up to the current version', () => {
    const restored = restoreWorld(fixture2);

    expect(restored.migration.fromVersion).toBe(2);
    expect(restored.migration.steps).toEqual([2, 3, 4, 5, 6, 7]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(29_100);
    expect(hashState(restored.state)).toBe('48a83f1c');
  });

  it('brings the factory back exactly as it was left', () => {
    const state = restoreWorld(fixture2).state;

    expect(state.belts).toHaveLength(2);
    expect(state.grabbers).toHaveLength(5);
    expect(state.zones).toHaveLength(1);
    expect(state.unlocked.length).toBeGreaterThan(0);
    expect(state.player.intent).toBeNull();

    // Goods in transit are part of the world, not a cache to be rebuilt.
    const riding = state.belts.reduce((total, belt) => total + belt.items.length, 0);
    expect(riding).toBeGreaterThan(0);
    expect(state.grabbers.some((grabber) => grabber.held !== 0)).toBe(true);

    // And the belt's sorted-by-distance invariant survived the round trip.
    for (const belt of state.belts) {
      for (let i = 1; i < belt.items.length; i++) {
        expect(belt.items[i]!.dist).toBeGreaterThan(belt.items[i - 1]!.dist);
      }
    }
  });

  it('keeps a restored factory simulating identically', () => {
    const a = restoreWorld(fixture2).state;
    const b = restoreWorld(fixture2).state;
    stepMany(a, 500);
    stepMany(b, 500);
    expect(hashState(a)).toBe(hashState(b));
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as above.
  // format-3 is the first save with plumbing in it, caught deliberately mid-throttle: the
  // network is over-demanded, every consumer is amber, the tank is empty, the pond is drawn
  // down, and the Hub is part-way through a scan. A pipe network at rest would round-trip
  // perfectly while proving almost nothing.
  it('migrates format-3.json up to the current version', () => {
    const restored = restoreWorld(fixture3);

    expect(restored.migration.fromVersion).toBe(3);
    expect(restored.migration.steps).toEqual([3, 4, 5, 6, 7]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(21_306);
    expect(hashState(restored.state)).toBe('cd2fcde5');
  });

  it('brings the plumbing back exactly as it was left', () => {
    const state = restoreWorld(fixture3).state;

    expect(state.reservoirs).toHaveLength(1);
    // Drawn down and still recharging. A pond that came back full would mean the level was
    // recomputed rather than restored, which is the one thing a save must never do.
    expect(state.reservoirs[0]!.levelMl).toBeLessThan(state.reservoirs[0]!.capacityMl);
    expect(state.pipes).toHaveLength(17);
    expect(state.networks).toHaveLength(1);
    expect(state.player.intent).toBeNull();

    // Every pipe on the one network, and the network's id is its lowest world tile index.
    const network = state.networks[0]!;
    let lowest = Number.MAX_SAFE_INTEGER;
    for (const pipe of state.pipes) {
      expect(pipe.network).toBe(network.id);
      const index = worldTileIndex(pipe.tileX, pipe.tileY);
      if (index < lowest) lowest = index;
    }
    expect(network.id).toBe(lowest);

    // The bookkeeping that only exists mid-flight, which is the whole reason for this fixture.
    expect(network.rrOffset).toBeGreaterThan(0);
    expect(network.demandMl).toBeGreaterThan(network.deliveredMl);
    expect(state.machines.some((machine) => machine.throttled)).toBe(true);
    expect(state.machines.some((machine) => machine.scanCursor > 0)).toBe(true);

    // A first activation that already happened must not happen again after a reload.
    expect(state.ceremonies).toContain(CeremonyId.IrrigationHub);
    expect(state.ceremonies).toContain(CeremonyId.PipedSprinkler);
  });

  it('keeps a restored network flowing identically', () => {
    const a = restoreWorld(fixture3).state;
    const b = restoreWorld(fixture3).state;
    stepMany(a, 500);
    stepMany(b, 500);
    expect(hashState(a)).toBe(hashState(b));
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as above.
  // format-4 is the first save with an errand in it, caught deliberately MID-WALK: the farmer
  // is 27 ticks into a harvest errand, part of the crop already in the bag and the rest still
  // in the ground. An errand at rest is `null`, which round-trips perfectly while proving
  // nothing — the pending intent is the only field a format-4 payload has that a format-3 one
  // does not, so a fixture saved without one would test the migration and never the feature.
  it('loads format-4.json at the current version with no migration', () => {
    const restored = restoreWorld(fixture4);

    expect(restored.migration.fromVersion).toBe(4);
    expect(restored.migration.steps).toEqual([4, 5, 6, 7]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(3300);
    expect(restored.state.worldSeed).toBe(90210);
    expect(hashState(restored.state)).toBe('a541b961');
  });

  it('brings the errand back exactly as it was left', () => {
    const state = restoreWorld(fixture4).state;

    const intent = state.player.intent;
    expect(intent).not.toBeNull();
    expect(intent!.action).toBe(IntentAction.Harvest);
    expect(intent!.tileX).toBe(11);
    expect(intent!.tileY).toBe(11);
    expect(intent!.issuedTick).toBe(3273);
    // The deadline is measured from `issuedTick`, so an errand that came back with a
    // refreshed clock would be a different errand wearing the same hat.
    expect(state.tick - intent!.issuedTick).toBe(27);

    // Mid-stride in the other sense too: the sub-subtile remainder is part of the world, and
    // a walk that resumed from a rounded position would drift by a subtile per reload.
    expect(state.player.moveAccum).toBeGreaterThan(0);
    expect(state.player.moveDir).toBe(Direction.None);

    // And the world around the errand: some of the crop picked, some still standing.
    expect(state.inventory.some((slot) => slot.item === ItemId.RussetPotato)).toBe(true);
    expect(state.field.some((tile) => tile.crop === CropId.RussetPotato)).toBe(true);
  });

  it('keeps a restored errand walking identically', () => {
    const a = restoreWorld(fixture4).state;
    const b = restoreWorld(fixture4).state;
    stepMany(a, 500);
    stepMany(b, 500);
    expect(hashState(a)).toBe(hashState(b));
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as above.
  // format-5 is the first save with maintenance and overcooking in it, caught deliberately
  // MID-BROWN: a Fryer standing on a full basket, three chips already gone Rustic Style and
  // the clock part-way to a fourth. That moment is the whole point of the file. `blockedTicks`
  // and `overcookedCount` exist only while a machine is stopped with nowhere to put its
  // output, so a save taken with an empty Fryer would carry two zeroes, round-trip perfectly,
  // and prove nothing whatsoever about the feature it was added for.
  it('migrates format-5.json up to the current version', () => {
    const restored = restoreWorld(fixture5);

    expect(restored.migration.fromVersion).toBe(5);
    expect(restored.migration.steps).toEqual([5, 6, 7]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(41_837);
    expect(restored.state.worldSeed).toBe(50505);
    expect(hashState(restored.state)).toBe('0e3fdb0d');
  });

  it('brings the browning basket and the maintenance tallies back as they were', () => {
    const state = restoreWorld(fixture5).state;

    const fryer = state.machines.find((machine) => machine.kind === MachineKind.Fryer);
    expect(fryer).toBeDefined();
    expect(fryer!.outputCount).toBe(20);
    expect(fryer!.overcookedCount).toBe(3);
    // Mid-count, not at either end: a clock that came back at zero would hand the player a
    // free reset every time they reloaded, and one that came back at the interval would burn
    // a chip for the privilege of closing the tab.
    expect(fryer!.blockedTicks).toBeGreaterThan(0);
    expect(fryer!.blockedTicks).toBeLessThan(OVERCOOK_BLOCKED_TICKS);

    // The lifetime tallies the Shift Report reads, restored rather than recomputed.
    expect(state.stats.inputsWastedByMachine).toBeGreaterThan(0);
    expect(state.stats.repairKitsUsed).toBe(1);
    expect(state.stats.repairKitSpendCents).toBe(REPAIR_KIT_PRICE_CENTS);
  });

  it('keeps a restored Fryer browning at the same rate', () => {
    const a = restoreWorld(fixture5).state;
    const b = restoreWorld(fixture5).state;
    stepMany(a, 1000);
    stepMany(b, 1000);
    expect(hashState(a)).toBe(hashState(b));

    // And it is still a layout condition after the reload: nobody emptied the basket, so it
    // keeps browning on exactly the schedule it was on.
    const fryer = a.machines.find((machine) => machine.kind === MachineKind.Fryer)!;
    expect(fryer.overcookedCount).toBeGreaterThan(3);
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as above.
  // format-6 is the first save with the soda line in it, caught deliberately **mid-pour**: five
  // single-liquid networks all part-full, every machine part-way through an operation, and the
  // Bottler's soda-syrup inlet flagged amber while its carbonated-water inlet is fine. That
  // last detail is the entire reason for the moment: a per-port throttle is the one fact a
  // machine-level flag cannot carry, and a save taken with the line at rest would round-trip
  // perfectly while proving nothing about typed ports at all.
  it('migrates format-6.json up to the current version', () => {
    const restored = restoreWorld(fixture6);

    expect(restored.migration.fromVersion).toBe(6);
    expect(restored.migration.steps).toEqual([6, 7]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(42_400);
    expect(restored.state.worldSeed).toBe(60606);
    expect(hashState(restored.state)).toBe('c15ec2b4');
  });

  it('brings every typed port back with its own liquid, level, and amber flag', () => {
    const state = restoreWorld(fixture6).state;

    // One network per liquid, which is plan §5's rule showing up as arithmetic: five liquids
    // on five networks, none of them sharing.
    const liquids = state.networks.map((network) => network.liquid).sort((a, b) => a - b);
    expect(liquids).toEqual([1, 2, 3, 4, 6]);

    const bottler = state.machines.find((machine) => machine.kind === MachineKind.Bottler)!;
    expect(bottler.ports).toHaveLength(2);
    // Syrup short, fizz fine — and the two are different networks, so the player is being told
    // which way to walk.
    expect(bottler.ports[0]!.throttled).toBe(true);
    expect(bottler.ports[1]!.throttled).toBe(false);
    expect(bottler.ports[0]!.network).not.toBe(bottler.ports[1]!.network);
    expect(bottler.ports[1]!.ml).toBeGreaterThan(0);
    // Mid-operation, not between them: progress that came back at zero would hand the player a
    // free restart on every reload.
    expect(bottler.progress).toBeGreaterThan(0);
    // And its recipe line — one bottle per soda — with bottles still in the hopper.
    expect(bottler.inputCounts).toHaveLength(1);
    expect(bottler.inputCounts[0]!).toBeGreaterThan(0);

    const mixer = state.machines.find((machine) => machine.kind === MachineKind.SyrupMixer)!;
    // §5's centrepiece, restored as what it is: two inlets and an outlet, with liquid in both
    // inlets and the kola powder still in the hopper.
    expect(mixer.ports).toHaveLength(3);
    expect(mixer.ports[0]!.ml).toBeGreaterThan(0);
    expect(mixer.ports[1]!.ml).toBeGreaterThan(0);
    expect(mixer.inputCounts[0]!).toBeGreaterThan(0);
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as above.
  // format-7 is the first save with boxed machines in it, and it is caught at a moment chosen
  // for one fact: TWO BOXES OF ONE KIND AT TWO DIFFERENT INVOICES, sitting in a single slot.
  // That is the whole reason a slot carries a list rather than a count — a bare Chip Kitchen
  // and a Speed-2/Capacity-1 one are the same item id and wildly different machines — and a
  // save holding one box, or two identical ones, would round-trip perfectly while proving
  // nothing about it. There is a Washer left part-way through an operation beside them for the
  // same reason every fixture here stops mid-something.
  it('loads format-7.json at the current version with no migration', () => {
    const restored = restoreWorld(fixture7);

    expect(restored.migration.fromVersion).toBe(7);
    expect(restored.migration.steps).toEqual([7]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(48_792);
    expect(restored.state.worldSeed).toBe(24_680);
    expect(hashState(restored.state)).toBe('67e26543');
  });

  it('brings both boxed machines back with their own dials, condition, and invoice', () => {
    const state = restoreWorld(fixture7).state;

    const slot = state.inventory.find((entry) => entry.item === ItemId.BoxedChipKitchen)!;
    expect(slot.count).toBe(2);
    expect(slot.boxes).toHaveLength(2);

    // Least invested first, which is the order the world stores and the order both verbs
    // consume in. A save that came back in the other order would be a different world.
    expect(slot.boxes[0]!.investedCents).toBe(10_000);
    expect(slot.boxes[0]!.speedLevel).toBe(0);
    expect(slot.boxes[1]!.investedCents).toBe(28_000);
    expect(slot.boxes[1]!.speedLevel).toBe(2);
    expect(slot.boxes[1]!.capacityLevel).toBe(1);
    // Condition travels with the box, so net worth does not jump when a worn machine is boxed.
    expect(slot.boxes[1]!.condition).toBe(853);

    // Every other slot in the world is an ordinary stack with no boxes on it at all.
    for (const entry of state.inventory) {
      if (entry.item === ItemId.BoxedChipKitchen) continue;
      expect(entry.boxes).toEqual([]);
    }

    // And the grabber that was turned three times is still facing where it was left.
    expect(state.grabbers[0]!.dir).toBe(Direction.West);
  });

  it('puts a restored box back down as the machine it was', () => {
    // The dials are only worth persisting if they survive into a machine. This is that.
    const state = restoreWorld(fixture7).state;
    const bin = state.machines.find((machine) => machine.kind === MachineKind.SellBin)!;
    state.player.xSub = bin.tileX * SUBTILE + SUBTILE / 2;
    state.player.ySub = bin.tileY * SUBTILE + SUBTILE / 2;

    const money = state.moneyCents;
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'PlaceMachine', kind: MachineKind.ChipKitchen, tileX: bin.tileX, tileY: 14 },
      ],
    });

    const placed = state.machines.find((machine) => machine.kind === MachineKind.ChipKitchen)!;
    expect(state.moneyCents).toBe(money);
    expect(placed.investedCents).toBe(10_000);
    expect(state.inventory.find((entry) => entry.item === ItemId.BoxedChipKitchen)!.count).toBe(1);
  });

  it('keeps a restored soda line pouring identically', () => {
    const a = restoreWorld(fixture6).state;
    const b = restoreWorld(fixture6).state;
    stepMany(a, 1000);
    stepMany(b, 1000);
    expect(hashState(a)).toBe(hashState(b));

    // And it is still making soda after the reload rather than merely surviving it.
    const bottler = a.machines.find((machine) => machine.kind === MachineKind.Bottler)!;
    expect(bottler.opCount).toBeGreaterThan(2);
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as above.
  // format-8 is the first save with bought land in it, and the fact it exists to pin is that
  // ownership is a property of the WORLD rather than of the tiles: two parcels owned, and a
  // Chip Kitchen and a Sprinkler standing on the one that was bought. A save that came back
  // owning only the starter lot would look perfect in every other assertion in this file
  // while leaving the player's machines on somebody else's grass.
  it('loads format-8.json at the current version with no migration', () => {
    const restored = restoreWorld(fixture8);

    expect(restored.migration.fromVersion).toBe(8);
    expect(restored.migration.steps).toEqual([]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(6_721);
    expect(restored.state.worldSeed).toBe(480_480);
    expect(hashState(restored.state)).toBe('c5ae23f8');
  });

  it('brings back the land, and the factory standing on the half that was bought', () => {
    const state = restoreWorld(fixture8).state;

    // Parcel 0 is the gift; parcel 1 is the $200 one, and the list is sorted rather than in
    // purchase order — two players who bought the same land in either order are one world.
    expect(state.ownedParcels).toEqual([0, 1]);

    // Everything east of tile 16 is on ground that could not be built on before this feature.
    const bought = state.machines.filter((machine) => machine.tileX >= PARCEL_TILES);
    expect(bought).toHaveLength(2);
    expect(bought.map((machine) => machine.kind).sort()).toEqual(
      [MachineKind.ChipKitchen, MachineKind.Sprinkler].sort(),
    );

    // The kitchen is mid-operation with a hopper and an output buffer, because a fixture taken
    // at a tidy moment tests nothing.
    const kitchen = bought.find((machine) => machine.kind === MachineKind.ChipKitchen)!;
    expect(kitchen.progress).toBeGreaterThan(0);
    expect(kitchen.inputCounts[0]!).toBeGreaterThan(0);
    expect(kitchen.outputCount).toBeGreaterThan(0);

    // And the deed is on the books at what it cost, so buying land was neutral on net worth
    // rather than a self-inflicted loss (plan §6).
    expect(landValueCents(state)).toBe(DEED_PRICE_CENTS_BY_PURCHASE[0]);
    expect(computeNetWorthCents(state)).toBeGreaterThan(state.moneyCents + landValueCents(state));
  });

  it('keeps building on bought land after the reload', () => {
    const state = restoreWorld(fixture8).state;
    const before = state.machines.length;

    // The parcel is still owned on the other side of a save, which is the only thing that
    // makes the machines already standing on it legal.
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'PlaceMachine', kind: MachineKind.ChipKitchen, tileX: PARCEL_TILES + 8, tileY: 4 },
      ],
    });
    expect(state.machines).toHaveLength(before + 1);

    // And parcel 2 is still somebody else's until it is paid for.
    step(state, {
      tick: state.tick,
      commands: [
        {
          type: 'PlaceMachine',
          kind: MachineKind.ChipKitchen,
          tileX: PARCEL_TILES * 2 + 4,
          tileY: 4,
        },
      ],
    });
    expect(state.machines).toHaveLength(before + 1);
  });

  it('finishes the restored errand rather than dropping it', () => {
    const state = restoreWorld(fixture4).state;
    const before = state.field.filter((tile) => tile.crop === CropId.RussetPotato).length;

    // Far enough to arrive, nowhere near `WALK_ERRAND_TIMEOUT_TICKS`. The errand must fire
    // the verb it was carrying — a save that restored the intent but not its ability to
    // complete would look correct in every assertion above and still strand the player.
    stepMany(state, 60);

    expect(state.player.intent).toBeNull();
    expect(state.field.filter((tile) => tile.crop === CropId.RussetPotato).length).toBe(before - 1);
  });
});
