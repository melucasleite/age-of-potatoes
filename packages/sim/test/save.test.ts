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
  Direction,
  IntentAction,
  ItemId,
  MachineKind,
  SIM_CODE_VERSION,
  SIM_VERSION,
  SaveCorruptError,
  SaveFormatTooNewError,
  BALANCE_HASH,
  checkSimVersion,
  createWorld,
  deserialize,
  hashState,
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
  // The expected DIGEST below is a different matter, and it has now moved three times, every
  // time on purpose. Format 2 added belts, grabbers, zones, tech unlocks, upgrade dials, and
  // the per-tile withering clock; format 3 added reservoirs, pipes, one-ledger networks, and
  // the per-machine plumbing fields; format 4 added the player's pending errand — all of them
  // hashed — so the world this file restores to legitimately hashes differently each time.
  // That is the migration working, not the save breaking: the tick, the seed, the money, and
  // every machine came back unchanged, which is what the assertions around it check.
  //
  // Format 4 is the cheapest of the three to reason about and the easiest to get wrong. It
  // adds ONE nullable field, and `null` is the only value that leaves the loaded world
  // behaving like the saved one — a returning player must not find the farmer setting off
  // across the field on an errand they never issued.
  //
  // The rule this preserves: a red line here means "either a migration is missing, or the
  // format changed without one". If you are updating this hash, the commit had better also
  // add a step to the chain in `save/migrations.ts`.
  it('loads format-1.json and reproduces its world', () => {
    const restored = restoreWorld(fixture);

    expect(restored.migration.fromVersion).toBe(1);
    expect(restored.migration.steps).toEqual([1, 2, 3]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(32096);
    expect(restored.state.worldSeed).toBe(20260812);
    expect(hashState(restored.state)).toBe('69618d29');
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
    expect(restored.migration.steps).toEqual([2, 3]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(29_100);
    expect(hashState(restored.state)).toBe('55e73df5');
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
    expect(restored.migration.steps).toEqual([3]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(21_306);
    expect(hashState(restored.state)).toBe('645ae2d9');
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
    expect(restored.migration.steps).toEqual([]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(3300);
    expect(restored.state.worldSeed).toBe(90210);
    expect(hashState(restored.state)).toBe('a3599c88');
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
