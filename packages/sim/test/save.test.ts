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
  CropId,
  Direction,
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
} from '../src/index';
import fixture from './fixtures/saves/format-1.json';

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
  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE. If it fails, either a
  // migration is missing or the save format changed without one. See fixtures/saves/README.md.
  it('loads format-1.json and reproduces its world', () => {
    const restored = restoreWorld(fixture);

    expect(restored.migration.fromVersion).toBe(1);
    expect(restored.migration.steps).toEqual([]);
    expect(restored.state.tick).toBe(32096);
    expect(restored.state.worldSeed).toBe(20260812);
    expect(hashState(restored.state)).toBe('9fa30100');
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
});
