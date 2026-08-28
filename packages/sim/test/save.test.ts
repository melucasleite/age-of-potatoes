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
  BotKind,
  BotPhase,
  CONDITION_MAX,
  CURRENT_FORMAT_VERSION,
  CeremonyId,
  CropId,
  DEED_PRICE_CENTS_BY_PURCHASE,
  Direction,
  IntentAction,
  ContractPhase,
  ItemId,
  MACHINE_SPECS,
  MachineKind,
  OVERCOOK_BLOCKED_TICKS,
  PARCEL_TILES,
  REPAIR_KIT_PRICE_CENTS,
  SIM_CODE_VERSION,
  SIM_VERSION,
  SUBTILE,
  TechId,
  SaveCorruptError,
  SaveFormatTooNewError,
  BALANCE_HASH,
  TECH_NODES,
  checkSimVersion,
  computeNetWorthCents,
  takeStorage,
  createWorld,
  depotAccept,
  deserialize,
  hashState,
  fromPayload,
  isSellable,
  machineWantsService,
  landValueCents,
  listPriceCents,
  toPayload,
  migrate,
  parseEnvelope,
  restoreWorld,
  serialize,
  step,
  stepMany,
  worldTileIndex,
  PUMP_RATE_ML_PER_MINUTE,
} from '../src/index';
import { UNFILLED_BY_DESIGN, containersFilledWorld, unfilledNumbers, worldDiff } from './goods';
import fixture from './fixtures/saves/format-1.json';
import fixture2 from './fixtures/saves/format-2.json';
import fixture3 from './fixtures/saves/format-3.json';
import fixture4 from './fixtures/saves/format-4.json';
import fixture5 from './fixtures/saves/format-5.json';
import fixture6 from './fixtures/saves/format-6.json';
import fixture7 from './fixtures/saves/format-7.json';
import fixture8 from './fixtures/saves/format-8.json';
import fixture9 from './fixtures/saves/format-9.json';
import fixture10 from './fixtures/saves/format-10.json';
import fixture11 from './fixtures/saves/format-11.json';
import fixture12 from './fixtures/saves/format-12.json';
import fixture13 from './fixtures/saves/format-13.json';
import fixture14 from './fixtures/saves/format-14.json';
import fixture15 from './fixtures/saves/format-15.json';
import fixture16 from './fixtures/saves/format-16.json';
import fixture16Parts from './fixtures/saves/format-16-parts.json';
import fixture17 from './fixtures/saves/format-17.json';
import fixture18 from './fixtures/saves/format-18.json';
import fixture19 from './fixtures/saves/format-19.json';
import fixture20 from './fixtures/saves/format-20.json';
import fixture21 from './fixtures/saves/format-21.json';
import fixture22 from './fixtures/saves/format-22.json';
import fixture22Well from './fixtures/saves/format-22-well.json';
import fixture23 from './fixtures/saves/format-23.json';
import fixture24 from './fixtures/saves/format-24.json';

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
  // Money and the node are gifts here rather than an economy: this world exists to exercise
  // the fields. (A Washer since item 145 cut the ungated Chip Kitchen — the Washer is the
  // surviving converter, and it needs its node.)
  state.moneyCents += 20_000;
  state.unlocked.push(TechId.WashAndSlice);
  run([{ type: 'PlaceMachine', kind: MachineKind.Washer, tileX: 12, tileY: 11 }]);
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

  it('round-trips a trace with a Cheat in it, and the cheated world keeps replaying', () => {
    // Item 075's determinism rule made concrete: a cheat is a command, so it lives in the
    // trace like any other, survives the save, and the restored world hashes and simulates
    // identically — including the hashed `cheatsUsed` fact.
    const state = playedWorld();
    step(state, { tick: state.tick, commands: [{ type: 'Cheat', code: 'klapaucius' }] });
    expect(state.stats.cheatsUsed).toBe(1);

    const restored = restoreWorld(throughJson(serialize(state)), state.trace).state;
    expect(hashState(restored)).toBe(hashState(state));
    expect(restored.stats.cheatsUsed).toBe(1);
    expect(restored.unlocked).toEqual(state.unlocked);
    expect(restored.trace.some((entry) => entry.command.type === 'Cheat')).toBe(true);

    stepMany(state, 400);
    stepMany(restored, 400);
    expect(hashState(restored)).toBe(hashState(state));
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

  it('carries a kit errand through the round trip — UseRepairKit is on the allowlist', () => {
    // The errand allowlist in `canonical.ts` is hand-written, exactly like `MACHINE_KINDS`,
    // and this is the same failure made cheap: a save written mid-walk with the kit armed
    // must not be refused by a loader whose list stopped at RefillCan.
    const state = createWorld(64);
    step(state, {
      tick: state.tick,
      commands: [
        {
          type: 'WalkAndAct',
          action: IntentAction.UseRepairKit,
          tileX: 30,
          tileY: 30,
          item: 0,
          count: 0,
        },
      ],
    });
    expect(state.player.intent).not.toBeNull();

    const restored = restoreWorld(throughJson(serialize(state))).state;
    expect(restored.player.intent!.action).toBe(IntentAction.UseRepairKit);
    expect(hashState(restored)).toBe(hashState(state));
  });

  it('leaves the pour signal behind: presentation data does not survive a save', () => {
    // `CropTile.lastPouredTick` is deliberately outside the payload and outside the hash —
    // a pour that happened before the save owes no droplets after it. Two worlds differing
    // only there are the same world, and the round trip proves it by hashing identically
    // while the signal comes back zeroed.
    const state = playedWorld();
    state.field[0]!.lastPouredTick = 4_242;

    const restored = restoreWorld(throughJson(serialize(state))).state;
    expect(restored.field[0]!.lastPouredTick).toBe(0);
    expect(hashState(restored)).toBe(hashState(state));
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
  // HASH LEDGER, items 145/146/147 (2026-08-27): **EVERY DIGEST IN THIS FILE MOVED AT ONCE,
  // AND MOST OF THE WORLDS MOVED WITH THEM — WHICH IS NEW.** Two causes, deliberately
  // untangled here because every earlier ledger entry had only one:
  //
  //   1. THE DIGEST: `hashState` lost four field families — `machine.untouchedTicks`,
  //      `stats.longestUntouchedMachineTicks`, and `zone.autoReplant` /
  //      `zone.replantCooldown` — so every world hashes shorter than it did yesterday,
  //      including format-4, which owns nothing item 145 cut.
  //   2. THE FLAVOUR CUT ITSELF: the 23 → 24 migration BUYS BACK six machine kinds, three
  //      crops, twenty-three goods and nine research nodes at their format-23 prices. Unlike
  //      items 115 or 112, this changes the DIRT and the WALLET, not just the digest: format-1
  //      loses its Chip Kitchen and gains $100, format-7 loses two boxed kitchens and gains
  //      $380, format-19 is paid $197 for its premium chips, format-22's Root Cellar goes and
  //      its twelve potatoes land in the bag. Every `moneyCents` movement below is asserted to
  //      the cent beside its pinned hash, which is what keeps the two causes separable.
  //
  // The synthetic worst-case payload — every cut thing in one save — is exercised at the
  // bottom of this describe ('pays out the whole flavour economy'), so the per-fixture tests
  // here only need to hold the cuts each real save actually contains.
  //
  // HASH LEDGER, item 140 (2026-08-18): **EVERY DIGEST IN THIS FILE MOVED AT ONCE, AND ALL OF
  // THEM FOR ONE SHARED CAUSE.** The pond became an unlimited source, so `Reservoir` lost
  // `levelMl`, `capacityMl` and `rechargeAccum`, and `hashState` LOST three `d.num` calls per
  // reservoir. Every world has exactly one pond, so every world hashes three numbers shorter
  // than it did yesterday — including format-1, which is the tell that this is the digest and
  // not the dirt.
  //
  // Checked rather than argued, the way format 20 checked its own: with those three `d.num`
  // calls held out of the OLD digest, nineteen of the twenty-one golden fixtures reproduce their
  // NEW hashes exactly. The two that do not — `flavour-line` and `bottle-return` — replay the
  // `Cheat` command, which unlocks every node in `TECH_NODES`, and the Artesian Well's node is
  // gone. No fixture in THIS file cheats, and none of them contains a well, a pond below a
  // quarter full, or a draw that came up short, so for these twenty-three the digest is the
  // whole of it: the tick, the seed, the money and every machine came back unchanged.
  //
  // NOBODY IS REFUNDED HERE, AND THAT IS CORRECT. The 22 → 23 step pays out every built well,
  // every boxed one and the research node — but the Artesian Well existed for a single day and
  // every fixture in this directory predates it, so every `moneyCents` below is untouched. The
  // refund path is proved by `format-23.json`, which was built to hold one of each.
  //
  // HASH LEDGER, item 131 (2026-08-17): **FOUR OF THESE DIGESTS MOVED AND THE REST DID NOT, AND
  // WHICH FOUR IS THE MEASUREMENT.** The Washer gained a third recipe — used bottle → clean
  // bottle — and therefore a third HOPPER, and `hashState` writes `inputCounts.length` before it
  // writes the counts. So exactly the worlds that hold a Washer hash longer than they did
  // yesterday, and no others: format-2, format-5, format-7 and format-20 moved; format-1 (no
  // factory at all), and every fixture in between whose Washer was boxed or never built, did not.
  // A change that had moved format-1 as well would have been a change to something other than a
  // Washer's hoppers, and this comment would be a lie the next reader could catch.
  //
  // NOTHING IS LOST, and it is checked rather than argued: `machineHoppers` appends unseen
  // ingredients in recipe order, and the bottle line is declared SECOND in `MACHINE_RECIPES` so
  // the new hopper lands on the END. Measured on these four fixtures — format-7's Washer goes
  // `[11] → [11, 0, 0]`, format-20's `[0, 0] → [0, 0, 0]` — every saved count still at its
  // original index, a zero appended, no migration step required because `readHopperArray` sizes
  // the array from today's spec and has absorbed exactly this case since it was written.
  // `test/recycling.test.ts` holds format-7 to that, permanently, rather than leaving it here.
  //
  // HASH LEDGER, wave 11 (2026-08-15): every pinned digest below moved once, for one shared
  // cause — format 14 (item 075) added `stats.cheatsUsed` to `hashState`'s digest, and the
  // 13 -> 14 migration writes the honest zero into every migrated world. The worlds
  // themselves are byte-identical dirt plus that one zero; the README's rule 1 is exactly
  // this case (new format, new migration, new expectation).

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
  //
  // **FORMAT 20 (item 112) MOVED EVERY DIGEST IN THIS FILE AT ONCE**, and the reason is one
  // sentence: the hash gained four new families of field — `machine.inputFreshTicks` (one per
  // hopper line, length-prefixed), `machine.outputFreshTicks`, `Grabber.heldFreshTicks`, and
  // `freshTicks` on every belt item — so every machine in every world hashes longer than it did
  // yesterday. The 19 → 20 step writes a 0 into all of them, which reads as "no clock", so not
  // one of these restored worlds behaves differently from the way it behaved this morning.
  // Checked rather than assumed, the way item 111 checked its own: with those four `d.num`
  // families held out of the digest, all twenty golden fixtures and the scripted run in
  // `sim.test.ts` reproduce their previous hashes exactly.
  it('loads format-1.json and reproduces its world', () => {
    const restored = restoreWorld(fixture);

    expect(restored.migration.fromVersion).toBe(1);
    expect(restored.migration.steps).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(32096);
    expect(restored.state.worldSeed).toBe(20260812);
    expect(hashState(restored.state)).toBe('4f13c5dc');
  });

  it('gives a migrated v0.1 world the factory fields at their empty defaults', () => {
    const state = restoreWorld(fixture).state;

    expect(state.belts).toEqual([]);
    expect(state.grabbers).toEqual([]);
    expect(state.zones).toEqual([]);
    expect(state.unlocked).toEqual([]);
    // Machines are invoiced at the price they were bought for, frozen in the migration rather
    // than looked up — today's table must not be able to rewrite an old save. The 1 → 2 step
    // still stamps the kitchen's $100 invoice, and the 23 → 24 step is what proves it: the
    // Chip Kitchen was DELETED by item 145, so the invoice the chain carried for twenty-two
    // formats is paid back into the wallet at the far end. $260 saved, $100 kitchen: $360.
    expect(state.machines.some((machine) => (machine.kind as number) === 2)).toBe(false);
    expect(state.moneyCents).toBe(26_000 + 10_000);
    // And the liquid layer's empty defaults. Format 3 gave the pond a level and made a point of
    // starting it FULL, because v0.1 had drawn from an infinite supply and a returning player
    // must not find it drained by an update; format 23 went back to the infinite supply and took
    // the level out again, so what a v0.1 world gets now is a pond with nothing in it to be
    // wrong about.
    expect(state.pipes).toEqual([]);
    expect(state.networks).toEqual([]);
    expect(state.ceremonies).toEqual([]);
    expect(state.reservoirs).toHaveLength(1);
    expect(Object.keys(state.reservoirs[0]!).sort()).toEqual(
      ['id', 'tileX', 'tileY', 'tilesHigh', 'tilesWide'].sort(),
    );
    expect(state.machines.every((machine) => machine.network === 0)).toBe(true);
    expect(state.machines.every((machine) => machine.scanCursor === 0)).toBe(true);

    // And format 4's one field. Nobody was mid-walk when a v0.1 world was written, so `null`
    // is the only answer that is not an invention.
    expect(state.player.intent).toBeNull();
  });

  it('still contains the world it was recorded with', () => {
    const state = restoreWorld(fixture).state;
    const kinds = state.machines.map((machine) => machine.kind);
    // The recording held a Chip Kitchen too, mid-operation; item 145 deleted the kind and the
    // 23 → 24 step bought it back (the wallet test above holds the money to the cent). What
    // survives of the recorded world is everything the cut did not name.
    expect(kinds).toEqual([MachineKind.SellBin, MachineKind.Sprinkler]);
    expect(state.machines[1]!.tankMl).toBeGreaterThan(0);
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
    expect(restored.migration.steps).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(29_100);
    expect(hashState(restored.state)).toBe('9c59abe5');
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
    expect(restored.migration.steps).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(21_306);
    expect(hashState(restored.state)).toBe('7ace0f36');
  });

  it('brings the plumbing back exactly as it was left', () => {
    const state = restoreWorld(fixture3).state;

    expect(state.reservoirs).toHaveLength(1);
    // This world was saved with its pond DRAWN DOWN AND STILL RECHARGING, and the assertion used
    // to be that the level came back exactly as low as it was left. Format 23 drops the level
    // rather than topping it up (item 140) — an unlimited pond has nothing to restore — so what
    // is checked now is that the footprint survived the deletion unchanged.
    expect(state.reservoirs[0]!.tilesWide).toBe(3);
    expect(state.reservoirs[0]!.tilesHigh).toBe(3);
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
  it('migrates format-4.json up to the current version', () => {
    const restored = restoreWorld(fixture4);

    expect(restored.migration.fromVersion).toBe(4);
    expect(restored.migration.steps).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(3300);
    expect(restored.state.worldSeed).toBe(90210);
    expect(hashState(restored.state)).toBe('ef204f71');
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
    expect(restored.migration.steps).toEqual([
      5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(41_837);
    expect(restored.state.worldSeed).toBe(50505);
    expect(hashState(restored.state)).toBe('e343e30a');
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
    expect(restored.migration.steps).toEqual([
      6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(42_400);
    expect(restored.state.worldSeed).toBe(60606);
    expect(hashState(restored.state)).toBe('c59c102c');
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
  it('migrates format-7.json up to the current version', () => {
    const restored = restoreWorld(fixture7);

    expect(restored.migration.fromVersion).toBe(7);
    expect(restored.migration.steps).toEqual([
      7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(48_792);
    expect(restored.state.worldSeed).toBe(24_680);
    expect(hashState(restored.state)).toBe('a15183ba');
  });

  it('buys back both boxed kitchens, each at its own invoice — the format-7 half of item 145', () => {
    // This fixture existed to pin TWO BOXES OF ONE KIND AT TWO DIFFERENT INVOICES — a bare
    // $100 kitchen and a Speed-2/Capacity-1 one at $280 — and until item 145 the assertions
    // here brought both boxes back and put one down as the machine it was. The Chip Kitchen is
    // now DELETED, so the same two invoices are what the 23 → 24 step must pay: a flat list
    // refund would have quietly taken $180 off this player, which is exactly the failure the
    // two-invoice moment was recorded to catch. The fixture keeps earning its keep — the same
    // bytes, the mirrored assertion.
    const state = restoreWorld(fixture7).state;

    expect(state.moneyCents).toBe(65_900 + 10_000 + 28_000);
    expect(state.inventory.some((entry) => (entry.item as number) === 27)).toBe(false);

    // Every surviving slot is an ordinary stack with no boxes on it at all.
    for (const entry of state.inventory) {
      expect(entry.boxes).toEqual([]);
    }

    // The Washer beside them survives mid-operation, its bottle hopper re-seated by the
    // format-24 remap (see recycling.test.ts for the count-level assertions)…
    const washer = state.machines.find((machine) => machine.kind === MachineKind.Washer)!;
    expect(washer.inputCounts).toHaveLength(2);
    // …and the grabber that was turned three times is still facing where it was left.
    expect(state.grabbers[0]!.dir).toBe(Direction.West);
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
  it('migrates format-8.json up to the current version', () => {
    const restored = restoreWorld(fixture8);

    expect(restored.migration.fromVersion).toBe(8);
    expect(restored.migration.steps).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(6_721);
    expect(restored.state.worldSeed).toBe(480_480);
    expect(hashState(restored.state)).toBe('22f7b47d');
  });

  it('brings back the land, and the factory standing on the half that was bought', () => {
    const state = restoreWorld(fixture8).state;

    // Parcel 0 is the gift; parcel 1 is the $200 one, and the list is sorted rather than in
    // purchase order — two players who bought the same land in either order are one world.
    expect(state.ownedParcels).toEqual([0, 1]);

    // Everything east of tile 16 is on ground that could not be built on before this feature.
    // The recording put a Chip Kitchen there too, mid-operation; item 145 deleted the kind, so
    // the 23 → 24 step bought it back at its $100 list and the Sprinkler now holds the claim
    // alone. The ownership fact this fixture pins is the same either way: a machine is
    // standing on ground that was bought, and it is still legal after the reload.
    const bought = state.machines.filter((machine) => machine.tileX >= PARCEL_TILES);
    expect(bought.map((machine) => machine.kind)).toEqual([MachineKind.Sprinkler]);
    expect(state.moneyCents).toBe(22_200 + 10_000);

    // And the deed is on the books at what it cost, so buying land was neutral on net worth
    // rather than a self-inflicted loss (plan §6).
    expect(landValueCents(state)).toBe(DEED_PRICE_CENTS_BY_PURCHASE[0]);
    expect(computeNetWorthCents(state)).toBeGreaterThan(state.moneyCents + landValueCents(state));
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as above.
  // format-9 is the first save with vehicles in it, and it is caught at a moment that exists
  // for about two hundred ticks in the whole world's history: **a cart and a truck on the road
  // at the same time**, and neither of them paid yet. That is the entire point of the file.
  // `cargoCount`, `runTicksRemaining`, `Contract.inTransit` and `phase` are all fields that are
  // zero whenever nothing is moving, so a save taken with the yard at rest would round-trip
  // perfectly and prove nothing at all about the format it was written for.
  it('accepts every machine kind this build can build', () => {
    // THE ALLOWLIST IS HAND-WRITTEN AND THIS IS THE ONLY THING KEEPING IT HONEST. `MACHINE_KINDS`
    // in `canonical.ts` is a written list rather than a map over `MACHINE_SPECS`, deliberately —
    // an id space is permanent save surface and deriving the guard from today's table would mean
    // a kind retired in 2029 silently stops being loadable. The cost of writing it down is that
    // it can go out of date, and it did: the delivery cart shipped and the loader refused every
    // save with one in it, which the format-9 fixture caught on its first run. This is that
    // failure, made cheap.
    for (const spec of MACHINE_SPECS) {
      const payload = toPayload(createWorld(1));
      payload.machines = [{ ...payload.machines[0]!, kind: spec.kind }];
      expect(() => fromPayload(payload)).not.toThrow();
    }
  });

  it('migrates format-9.json up to the current version', () => {
    const restored = restoreWorld(fixture9);

    expect(restored.migration.fromVersion).toBe(9);
    expect(restored.migration.steps).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(17_949);
    expect(restored.state.worldSeed).toBe(320_320);
    // 2fc2daeb -> 4d12935b (save format 21, item 115): the digest gained a standing route's two
    // clocks. This world holds ONE contract and no bots, so migration 20 -> 21 writes it a pair of
    // zeroes and the digest reads them; with the two `d.num` calls held out it reproduces 2fc2daeb
    // exactly, so every other hashed field is byte-identical and no behaviour moved.
    expect(hashState(restored.state)).toBe('2b91203d');
  });

  // The 9 → 10 migration's whole claim is that a format-9 world had no junctions, so every
  // field it adds is zero *as a fact* rather than as a default. This is that claim, checked on
  // a real save rather than in a comment. (It used to check the untouched-work clock on the
  // same argument; item 147 cut the clock, and the 23 → 24 step now drops the very zeroes the
  // 9 → 10 step wrote — a field can be born and die inside the chain without either step being
  // edited, which is the whole reason released migrations are frozen.)
  it('brings a format-9 world up with the junction cursors at zero on every machine', () => {
    const state = restoreWorld(fixture9).state;

    for (const machine of state.machines) {
      expect(machine.junctionInCursor).toBe(0);
      expect(machine.junctionOutCursor).toBe(0);
    }
  });

  it('brings the cart back on the road with its load still aboard, and the truck too', () => {
    const state = restoreWorld(fixture9).state;

    // The cart: eight bags, 212 ticks from home. A reload that rounded either number would be
    // a player handed a free delivery or charged for closing the tab.
    const cart = state.machines.find((machine) => machine.runTicksRemaining > 0)!;
    expect(cart.cargoItem).toBe(ItemId.BaggedChips);
    expect(cart.cargoCount).toBe(8);
    expect(cart.runTicksRemaining).toBe(212);

    // The route: one truck rolling with five bags on it, one more bag already on the floor for
    // the next run, and NOTHING PAID YET — `automatedGrossCents` is still zero at this instant.
    // That is what makes the next assertion mean something.
    expect(state.contracts).toHaveLength(1);
    const contract = state.contracts[0]!;
    expect(contract.phase).toBe(ContractPhase.Rolling);
    expect(contract.inTransit).toBe(5);
    expect(contract.stocked).toBe(1);
    expect(contract.runsCompleted).toBe(0);
    expect(state.stats.automatedGrossCents).toBe(0);

    // GOODS IN TRANSIT ARE ON THE BOOKS (plan §6). Fourteen bags are somewhere between a shed
    // and a town and not one of them is cash, so net worth has to be carrying them — a save
    // that dropped them would restore a world several hundred dollars poorer than the one that
    // was written, and the Peak Flow board would record the dip.
    const inFlight = cart.cargoCount + contract.inTransit + contract.stocked;
    expect(inFlight).toBe(14);
    expect(computeNetWorthCents(state)).toBeGreaterThanOrEqual(
      state.moneyCents + listPriceCents(ItemId.BaggedChips) * inFlight,
    );

    // And the destination came back as written. It is the one stored string outside the hash,
    // which makes this the only assertion standing between it and a silent disappearance.
    expect(contract.destination).toBe('Ridgeline Grocers');
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as above.
  // format-10 is the first save with a **belt junction** in it, and it is caught at a moment
  // chosen for the two fields the format exists for: the junction's out-cursor is at 2, part-way
  // round its rotation with one bag already sent north and one sent east, and a Chip Kitchen is
  // 381 ticks into a run nobody has touched. Both are mid-flight quantities — a junction at rest
  // has cursors wherever it last stopped and a machine with an empty hopper has a frozen clock,
  // so a save taken with the line idle would round-trip perfectly and prove nothing at all.
  it('migrates format-10.json up to the current version', () => {
    const restored = restoreWorld(fixture10);

    expect(restored.migration.fromVersion).toBe(10);
    expect(restored.migration.steps).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(22_929);
    expect(restored.state.worldSeed).toBe(320_320);
    // 0dec88c2 -> c5df63a8 (save format 21, item 115): one contract, two new zeroes, for the
    // reason format-9's note above spells out. Held out of the digest, it reproduces 0dec88c2.
    expect(hashState(restored.state)).toBe('fa9fd1e8');
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as above.
  // format-11 is the first save with a **clock on the goods** and a **robot on the lot**, caught
  // at a moment chosen for exactly those two: an Agri-Bot is between the row and its dock with
  // eight potatoes in its arms and 32 hundredths of a subtile banked in its walk accumulator, and
  // the bag holds two heaps of potatoes on two different deadlines beside a heap of slices on a
  // third. Every one of those is a mid-flight quantity — a parked bot has a zero accumulator and
  // a freshly filled bag has one stack — so a save taken with the farm at rest would round-trip
  // perfectly and prove nothing about the format it was written for. The player is towing a hand
  // cart while it happens, which is the third.
  it('migrates format-11.json up to the current version', () => {
    const restored = restoreWorld(fixture11);

    expect(restored.migration.fromVersion).toBe(11);
    expect(restored.migration.steps).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(66_516);
    expect(restored.state.worldSeed).toBe(90_210);
    // 7f902623 until format 15: the 14 → 15 step moves this world's nine stranded dock goods
    // onto the shelf as identified cargo, which legitimately changes the digest. See the
    // rescue test below for the story the new number encodes.
    // 62f605a5 -> 69ce9748 (save format 21, item 115): the digest gained `Bot.carryFreshTicks`,
    // and this world has one bot. Migration 20 -> 21 writes it a 0 — the same "no opinion" the
    // grandfathering everywhere else in this feature uses — and with the `d.num` held out the
    // world reproduces 62f605a5 exactly. The rescue story below is untouched.
    expect(hashState(restored.state)).toBe('ae2fee4b');
  });

  it('rescues the nine anonymous goods stranded on the format-11 dock — the item-083 guess', () => {
    // This file is the one REAL stranded-dock save the repository keeps: its harvester dock
    // was recorded with `outputCount: 9` — nine units a bot delivered whose identity the old
    // buffer model discarded on arrival, unreachable by grabber or hand ever since. The
    // 14 → 15 migration moves them onto the shelf under the documented guess: the bound
    // zone's crop's fresh yield. Zone 1 grows Russet Potato, so here the guess is simply
    // correct — and it is asserted in words rather than only through the hash above.
    const state = restoreWorld(fixture11).state;
    const dock = state.machines.find((m) => m.kind === MachineKind.HarvesterDock)!;

    expect(dock.cargoItem).toBe(ItemId.RussetPotato);
    expect(dock.cargoCount).toBe(9);
    expect(dock.outputCount).toBe(0);
  });

  it('gives a format-11 world a full can and empty ledgers, and invents no history', () => {
    const restored = restoreWorld(fixture11);
    const state = restored.state;

    // The infinite can every format-11 world held is, at the moment of loading,
    // indistinguishable from a full one — so full is what it gets.
    expect(state.player.canCharges).toBe(8);
    // The accumulators start EMPTY. This world sold things and worked hours that were never
    // recorded, and a migration must not invent history for them.
    expect(state.stats.salesByItem).toEqual([]);
    expect(state.stats.hours).toEqual([]);
    // The open hour's starting line is the load itself: the first bucket this world closes
    // will contain only what happened after the load.
    expect(state.stats.hourMark.tick).toBe(66_516);
    expect(state.stats.hourMark.earnedCents).toBe(state.stats.lifetimeEarnedCents);
    expect(state.stats.hourMark.spentCents).toBe(state.stats.lifetimeSpentCents);
    // And loading is not a dawn: the counter matches the saved tick's calendar exactly.
    expect(state.stats.dawnsSeen).toBe(Math.floor((66_516 - 8_400) / 9_600) + 1);
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as every
  // fixture above. format-12 is the first save with the eight-pour can and the receipt
  // ledgers in it, caught mid-morning of its second day: the can run EMPTY (the refusal
  // state is the one worth pinning), a crop freshly watered and growing, one row in
  // `salesByItem` with the day snapshots taken at the first dawn, the short birth hour
  // already closed in `hours`, and the open hour's mark mid-count.
  it('migrates format-12.json up to the current version', () => {
    const restored = restoreWorld(fixture12);

    expect(restored.migration.fromVersion).toBe(12);
    expect(restored.migration.steps).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(11_000);
    expect(restored.state.worldSeed).toBe(812_812);
    expect(hashState(restored.state)).toBe('a9cccb29');
  });

  it('brings back the empty can, the sales ledger, and the closed birth hour', () => {
    const state = restoreWorld(fixture12).state;

    expect(state.player.canCharges).toBe(0);

    expect(state.stats.salesByItem.length).toBeGreaterThan(0);
    const potatoes = state.stats.salesByItem[0]!;
    expect(potatoes.units).toBeGreaterThan(0);
    expect(potatoes.cents).toBeGreaterThan(0);
    // The day snapshots were taken at the dawn after the sale, so "today" reads zero — the
    // exact subtraction the Dawn Report's card does.
    expect(potatoes.unitsAtDawn).toBe(potatoes.units);

    // The short birth hour (tick 0 to the first dawn at 8,400) is closed; the second hour is
    // open with its mark at the boundary.
    expect(state.stats.hours.length).toBe(1);
    expect(state.stats.hours[0]!.hour).toBe(0);
    expect(state.stats.hours[0]!.ticks).toBe(8_400);
    expect(state.stats.hourMark.hour).toBe(1);
    expect(state.stats.hourMark.tick).toBe(8_400);
    expect(state.stats.dawnsSeen).toBe(1);

    // And the buckets telescope: closed plus the open hour's remainder equals lifetime.
    const closed = state.stats.hours[0]!;
    expect(
      closed.grossCents + (state.stats.lifetimeEarnedCents - state.stats.hourMark.earnedCents),
    ).toBe(state.stats.lifetimeEarnedCents);
  });

  it('gives every format-12 field tile its address and builds the ledger from the dirt', () => {
    const state = restoreWorld(fixture12).state;

    // The migrated field is the legacy 8×8 rect with its coordinates written on: row-major
    // from (4,4), sorted by world key, which is the order the flat array always had.
    expect(state.field.length).toBe(64);
    for (let i = 0; i < state.field.length; i++) {
      const tile = state.field[i]!;
      expect(tile.tileX).toBe(4 + (i % 8));
      expect(tile.tileY).toBe(4 + Math.floor(i / 8));
    }

    // One ledger entry per tile, keyed by position, carrying the soil the tile actually has —
    // built from the dirt itself, because a migration must not invent history.
    expect(state.soilMemory.length).toBe(64);
    for (let i = 0; i < state.field.length; i++) {
      const tile = state.field[i]!;
      const entry = state.soilMemory[i]!;
      expect(entry.tile).toBe(worldTileIndex(tile.tileX, tile.tileY));
      expect(entry.soil).toBe(tile.soil);
    }
  });

  it("converts a field bot's target to a world key and leaves a drone's machine id alone", () => {
    // The permanent format-12 save carries no bots, so the conversion is exercised on a
    // synthetic format-12 payload caught mid-errand: a harvester outbound to legacy field
    // index 9 — tile (5,5), world key 325 — a planter with no target, and a repair drone
    // whose `targetTile` is a MACHINE ID and must survive untouched. The migration step is
    // asserted on directly, payload to payload, which is the shape it actually works in.
    const twelve = JSON.parse(JSON.stringify(fixture12)) as {
      formatVersion: number;
      payload: { bots: Record<string, unknown>[] };
    };
    twelve.payload.bots = [
      { id: 1, kind: 1, phase: 1, targetTile: 9 },
      { id: 2, kind: 2, phase: 0, targetTile: -1 },
      { id: 3, kind: 3, phase: 1, targetTile: 7 },
    ];
    const migrated = migrate(twelve as unknown as SaveEnvelope).envelope.payload as {
      bots: { targetTile: number }[];
    };
    expect(migrated.bots[0]!.targetTile).toBe(5 * 64 + 5);
    expect(migrated.bots[1]!.targetTile).toBe(-1);
    expect(migrated.bots[2]!.targetTile).toBe(7);
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as every
  // fixture above. format-13 is the first save with PLAYER-MADE FARMLAND in it, recorded by
  // replaying the `the-till` golden to tick 1,980 — after the harvest and the un-till, before
  // the re-till. The moment is the point: a 67-tile NON-RECTANGULAR field (three tilled tiles
  // still standing north of the rect), and a 68-entry roll-once ledger holding one position
  // WITH NO TILE ON IT — the one state no earlier format can express.
  it('migrates format-13.json up to the current version', () => {
    const restored = restoreWorld(fixture13);

    expect(restored.migration.fromVersion).toBe(13);
    expect(restored.migration.steps).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(1_980);
    expect(restored.state.worldSeed).toBe(660_660);
    expect(hashState(restored.state)).toBe('d452f847');
  });

  it('gives a format-13 world a zero cheat counter — the truth, not a default', () => {
    // No format-13 world could have applied a `Cheat` command; the command did not exist.
    expect(restoreWorld(fixture13).state.stats.cheatsUsed).toBe(0);
  });

  it('loads a saved can at its saved charge count under the wider cap — never topped up', () => {
    // Item 073's owner ruling widened the can from 8 to 20 pours with NO migration: a can
    // saved part-full merely loads as more-part-full. Topping it up on migrate would invent
    // eleven pours of water the saved world never had.
    expect(restoreWorld(fixture13).state.player.canCharges).toBe(7);
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as every
  // fixture above. format-14 is the first save with a CHEAT in it (item 075), recorded by
  // `scripts/record-format-14.ts`: `cheatsUsed: 1`, the full unlock list, and a tech-gated
  // Pump plus a second parcel bought with conjured money at tick 700 — a combination no
  // un-cheated save can carry, and the one state no earlier format can express.
  // The 14 → 15 step (item 083) touches only harvester docks with a stranded `outputCount`,
  // and this world has none — so the migrated hash is EXACTLY the hash the file loaded at
  // under format 14, which is itself the claim worth pinning: a migration that moved this
  // number would be inventing changes in a world with nothing to translate.
  it('migrates format-14.json up to the current version', () => {
    const restored = restoreWorld(fixture14);

    expect(restored.migration.fromVersion).toBe(14);
    expect(restored.migration.steps).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(700);
    expect(restored.state.worldSeed).toBe(750_750);
    expect(hashState(restored.state)).toBe('ba3db32d');
  });

  it('brings back the cheated world exactly: the counter, the unlocks, the conjured money', () => {
    const state = restoreWorld(fixture14).state;

    expect(state.stats.cheatsUsed).toBe(1);
    // **31, NOT `TECH_NODES.length`, AND THE DIFFERENCE IS THE FEATURE** ([[130]]). This fixture
    // was cheated to "everything unlocked" when the tree had 32 nodes; the Artesian Well made it
    // 33. A save does NOT retroactively acquire a node that did not exist when it was written —
    // a returning player with a fully-researched lot meets the new node unresearched and buys
    // it, which is the whole point of shipping one. Pinning today's count here would have
    // asserted the opposite and quietly granted every future node to every old save.
    //
    // **AND IT WENT DOWN BY ONE, WHICH IS THE OTHER DIRECTION AND IS ITEM 124.** The tree LOST
    // `agronomy-composting`: the Composter no longer exists, so a node that unlocks it is money
    // spent on nothing. The 21 → 22 migration takes it out of `unlocked` and refunds its $120,
    // which is the same house rule the machine and the goods are handled under — a deletion may
    // never be a confiscation. The loop below then checks the stronger property: every string
    // still on the list names a node this build actually has.
    //
    // **AND THEN IT WENT DOWN BY NINE MORE (items 146/147, 2026-08-27):** the flavour cut took
    // `agronomy-corn`, `-chili`, `-gold-potato`, `-seed-hopper`, `-root-cellar`, `-orchard`,
    // `hydraulics-recirculator`, `fabrication-diagnostics` and `charter-corporate` — the last
    // one a $20,000 node whose whole ERA is gone. The 23 → 24 step refunds all nine at their
    // format-23 prices, same rule, bigger cheque. 31 − 9 = 22.
    expect(state.unlocked.length).toBe(22);
    expect(state.unlocked.length).toBeLessThanOrEqual(TECH_NODES.length);
    // Everything it does claim is still a real node — an unlock list naming a deleted slug is a
    // different bug and this is where it would show.
    for (const id of state.unlocked) {
      expect(
        TECH_NODES.some((node) => node.id === id),
        `the save claims a node that does not exist: ${id}`,
      ).toBe(true);
    }
    // The Pump the cheat paid for is standing on the bank, and the second parcel is owned.
    expect(state.machines.some((m) => m.kind === MachineKind.Pump)).toBe(true);
    expect(state.ownedParcels).toEqual([0, 1]);
    // The money was conjured, never earned: the earnings ledger stayed honest — and the $120
    // the Composting node was refunded for arrived in the wallet rather than in it (item 124).
    expect(state.moneyCents).toBeGreaterThan(9_000_000);
    expect(state.stats.lifetimeEarnedCents).toBe(0);
  });

  it('guesses the shelf item from the bound zone, and falls back to the starter potato', () => {
    // The permanent format-14 save carries no dock, so the guess table's branches are
    // exercised on a synthetic format-14 payload, asserted migration-step to payload — the
    // same shape the format-12 bot-target test uses. Four machines, four branches: a dock on
    // a cane zone takes the zone's word for it; an unbound dock falls back to RussetPotato;
    // an empty dock is untouched; and a machine that is not a dock keeps its output buffer,
    // because a converter's goods have a spec-side identity and always did.
    //
    // (Until item 145 the zone grew CORN and the fourth machine was a Chip Kitchen — both cut,
    // and a payload reaching format 24 with either would have the guess paid straight back
    // out, which would test the payout rather than the guess. Sugar cane and a Washer walk
    // the same two branches and survive to the far end of the chain.)
    const fourteen = JSON.parse(JSON.stringify(fixture14)) as {
      formatVersion: number;
      payload: { machines: Record<string, unknown>[]; zones: Record<string, unknown>[] };
    };
    fourteen.payload.zones = [{ id: 4, crop: 2, name: 'the cane strip' }];
    fourteen.payload.machines = [
      { kind: 31, outputCount: 7, boundZone: 4, cargoItem: 0, cargoCount: 0 },
      { kind: 31, outputCount: 5, boundZone: 0, cargoItem: 0, cargoCount: 0 },
      { kind: 31, outputCount: 0, boundZone: 4, cargoItem: 0, cargoCount: 0 },
      { kind: 4, outputCount: 9, boundZone: 0, cargoItem: 0, cargoCount: 0 },
    ];
    const migrated = migrate(fourteen as unknown as SaveEnvelope).envelope.payload as {
      machines: { outputCount: number; cargoItem: number; cargoCount: number }[];
    };

    expect(migrated.machines[0]).toMatchObject({
      cargoItem: ItemId.SugarCane,
      cargoCount: 7,
      outputCount: 0,
    });
    expect(migrated.machines[1]).toMatchObject({
      cargoItem: ItemId.RussetPotato,
      cargoCount: 5,
      outputCount: 0,
    });
    expect(migrated.machines[2]).toMatchObject({ cargoItem: 0, cargoCount: 0, outputCount: 0 });
    expect(migrated.machines[3]).toMatchObject({ cargoItem: 0, cargoCount: 0, outputCount: 9 });
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE — the same rule as every
  // fixture above. format-15 is the first save with an IDENTIFIED dock shelf in it (item
  // 083), recorded by `scripts/record-format-15.ts`: a bot's harvest sitting on its dock as
  // `cargoItem`/`cargoCount` — named goods a grabber or a hand can actually take — which is
  // the one state no earlier format can express. Format 14 wrote the same moment as an
  // anonymous `outputCount` that nothing could ever unload.
  //
  // The 15 → 16 step (item 088) adds four empty fields and translates nothing, so the migrated
  // hash is NOT the hash this file loaded at under format 15: the digest itself gained the seed
  // pocket and the seed shelf, and every world in the repository moved with it. What is worth
  // pinning is that the world came back with the seeds it actually had, which is none — the
  // seeds this save's bot discarded were never recorded anywhere, so there is nothing to
  // restore and back-crediting a plausible number would be inventing inventory.
  it('migrates format-15.json up to the current version', () => {
    const restored = restoreWorld(fixture15);

    expect(restored.migration.fromVersion).toBe(15);
    expect(restored.migration.steps).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(2_814);
    expect(restored.state.worldSeed).toBe(830_083);
    // 9f4e3b19 -> d45801e4 (save format 21, item 115): one bot, one new zero. Held out of the
    // digest it reproduces 9f4e3b19, so this is the field arriving rather than the world changing.
    expect(hashState(restored.state)).toBe('5bc8f4f4');
  });

  it('brings the shelf back with its name on it, and no hand in the ledger', () => {
    const state = restoreWorld(fixture15).state;
    const dock = state.machines.find((m) => m.kind === MachineKind.HarvesterDock)!;

    expect(dock.cargoItem).toBe(ItemId.RussetPotato);
    expect(dock.cargoCount).toBe(10);
    expect(dock.outputCount).toBe(0);
    // The bot did the harvesting, and the Hands-Free ledger still says so after the reload.
    expect(state.stats.itemsHarvestedByHand).toBe(0);

    // And the format-16 fields arrived empty on every machine and every bot. Empty is the whole
    // migration: a format-15 world's discarded seeds left no record to reconstruct from.
    expect(dock.seedShelfItem).toBe(0);
    expect(dock.seedShelfCount).toBe(0);
    expect(state.machines.every((m) => m.seedShelfCount === 0)).toBe(true);
    expect(state.bots.every((b) => b.seedItem === 0 && b.seedCount === 0)).toBe(true);
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE. format-16 is the first save
  // in which THE SEED CAME HOME (item 088), recorded by `scripts/record-format-16.ts`: the
  // format-15 session played one beat further, until the dock holds a named harvest on the
  // produce shelf AND named seeds on the seed shelf. A robot bringing back what a hand would
  // have pocketed is the one state no earlier format can express — format 15 wrote that moment
  // as a harvest and a silence, because the seed was not stored badly, it did not exist.
  it('migrates format-16.json up to the current version', () => {
    const restored = restoreWorld(fixture16);

    expect(restored.migration.fromVersion).toBe(16);
    // Two steps now. This world has no Parts Bench and no stocked bay in it, so 16 → 17 walks its
    // machines and changes nothing — which is the claim worth pinning here, and
    // `format-16-parts.json` below is where the step is made to do actual work. 17 → 18 gives
    // every machine a `cargoFreshTicks` of 0 and changes nothing else, ever, by construction.
    expect(restored.migration.steps).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(2_814);
    expect(restored.state.worldSeed).toBe(880_088);
    // 79200b5e -> 24430bc7 (save format 21, item 115): one bot, one new zero. Same proof as above.
    expect(hashState(restored.state)).toBe('2faf9ba7');
  });

  // NEVER EDIT THESE EXPECTATIONS AND NEVER REGENERATE THIS FIXTURE. `format-16-parts.json` is
  // the SECOND format-16 file and the only doubled entry in the set — recorded by
  // `scripts/record-format-16-parts.ts` on the last day it was possible to record it, because
  // item 090 retires the Parts Bench and no build after this one can place one. It is the only
  // real save in existence that contains the two things the 16 → 17 step has to hand back.
  it('migrates format-16-parts.json, handing back everything the parts economy held', () => {
    const restored = restoreWorld(fixture16Parts);

    expect(restored.migration.fromVersion).toBe(16);
    expect(restored.migration.steps).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(4_421);
    expect(restored.state.worldSeed).toBe(160_090);

    const state = restored.state;

    // THE BENCH IS OFF THE LOT. Its grinder and the sell bin and the bay are all still standing;
    // it is the one machine the migration takes, because it is the one with nothing left to do.
    expect(state.machines.some((m) => m.kind === MachineKind.PartsBench)).toBe(false);
    expect(state.machines.some((m) => m.kind === MachineKind.Grinder)).toBe(true);
    expect(state.machines.some((m) => m.kind === MachineKind.DroneBay)).toBe(true);

    // ...AND IN THE BAG, WITH ITS INVOICE. The recorded bench had a Speed dial bought and 972
    // condition, so a box credited at the $800 list price would have quietly cost its owner
    // 40% of $320. The dials, the wear and the invoice all came home.
    const boxSlot = state.inventory.find((slot) => slot.item === ItemId.BoxedPartsBench)!;
    expect(boxSlot.count).toBe(1);
    expect(boxSlot.boxes).toEqual([
      {
        speedLevel: 1,
        efficiencyLevel: 0,
        capacityLevel: 0,
        condition: 972,
        investedCents: 112_000,
      },
    ]);

    // Both recipe lines came back as what they were — six bottles and six kola powder — which
    // is why the migration freezes the recipe rather than reading today's `machineSpec`.
    expect(state.inventory.find((slot) => slot.item === ItemId.Bottle)?.count).toBe(6);
    expect(state.inventory.find((slot) => slot.item === ItemId.KolaPowder)?.count).toBe(6);

    // And every drone part in the world is in the player's hands: six off the bench's output
    // shelf plus the eight that were sitting in the bay's hopper. The bay's shelf is bare.
    expect(state.inventory.find((slot) => slot.item === ItemId.DronePart)?.count).toBe(14);
    const bay = state.machines.find((m) => m.kind === MachineKind.DroneBay)!;
    expect(bay.cargoItem).toBe(0);
    expect(bay.cargoCount).toBe(0);

    // Sellable, so the stock is money rather than sentiment (§4's floor).
    expect(isSellable(ItemId.DronePart)).toBe(true);

    // The inventory is still canonically ordered — ascending by item id — after four items were
    // inserted into it by hand. A migration that appended would hash differently from the same
    // world built fresh, which is the class of bug the golden fixtures exist to catch.
    const ids = state.inventory.map((slot) => slot.item);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  // NEVER EDIT THIS EXPECTATION AND NEVER REGENERATE THIS FIXTURE. format-17 is the first save
  // in which A DRONE WORKS OUT OF AN EMPTY BAY (item 090), recorded by
  // `scripts/record-format-17.ts`. The state it holds was impossible in format 16 in both
  // directions: an empty hopper grounded the drone before a target was picked, so a bare shelf
  // and a drone on an errand could never be true at the same instant. It is caught at exactly
  // that moment, and aimed at a BOT DOCK — the machine whose own condition can never fall, and
  // which the drone therefore ignored for eleven items until the owner reported it.
  it('migrates format-17.json up to the current version', () => {
    const restored = restoreWorld(fixture17);

    expect(restored.migration.fromVersion).toBe(17);
    // It arrived current and stopped being so the same week: item 110 appended 17 → 18, which
    // gives this world's bay, dock and grinder a `cargoFreshTicks` of 0 apiece and nothing else.
    expect(restored.migration.steps).toEqual([17, 18, 19, 20, 21, 22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(18);
    expect(restored.state.worldSeed).toBe(170_090);
    // ced46777 -> 9a0358a1 (save format 21, item 115): TWO bots here — a repair drone and its
    // neighbour — so the digest gained two zeroes. Neither carries produce (a drone harvests
    // nothing), which is why the value written is a zero rather than a clock. Held out, ced46777.
    expect(hashState(restored.state)).toBe('da40007b');
  });

  it('brings back a drone mid-errand over a bay with nothing in it', () => {
    const state = restoreWorld(fixture17).state;
    const bay = state.machines.find((m) => m.kind === MachineKind.DroneBay)!;
    const dock = state.machines.find((m) => m.kind === MachineKind.HarvesterDock)!;
    const drone = state.bots.find((b) => b.kind === BotKind.Repair)!;
    const worker = state.bots.find((b) => b.kind === BotKind.Harvester)!;

    // The shelf is bare and the drone is out anyway.
    expect(bay.cargoItem).toBe(0);
    expect(bay.cargoCount).toBe(0);
    expect(drone.phase).toBe(BotPhase.Outbound);
    expect(drone.targetTile).toBe(dock.id);

    // The trap, preserved: a shed in perfect health with a worn robot asleep in it.
    expect(dock.condition).toBe(CONDITION_MAX);
    expect(dock.jammed).toBe(false);
    expect(worker.condition).toBe(120);
    expect(machineWantsService(state, dock)).toBe(true);

    // Fly the rest of the errand out of the restored world: it lands, and the robot comes back
    // to full for nothing. A save that could not finish its own errand would be a save that
    // recorded a pose rather than a moment.
    stepMany(state, 2_000);
    expect(worker.condition).toBe(CONDITION_MAX);
    expect(state.stats.repairKitSpendCents).toBe(0);
    expect(bay.cargoCount).toBe(0);
  });

  // NEVER EDIT THESE EXPECTATIONS AND NEVER REGENERATE THIS FIXTURE. format-18 is the first save
  // in which A BOX IS RUNNING A CLOCK (item 110), recorded by `scripts/record-format-18.ts`. It
  // holds two containers, one product and two different answers to "how long have these got" —
  // which format 17 could not express in either direction, because every box froze its contents
  // and then handed back a brand-new fifteen minutes on the way out. That was the exploit: *"a
  // round trip through an eighty dollar hand cart resets the freshness clock."*
  it('migrates format-18.json up to the current version', () => {
    const restored = restoreWorld(fixture18);

    expect(restored.migration.fromVersion).toBe(18);
    // One step now (item 111): 18 → 19 gives every machine a name for what is in its output
    // basket. Every machine in this world gets a 0, which `heldOutputItem` reads as "ask the
    // spec" — the same answer the old code gave — so the two boxes below behave identically.
    expect(restored.migration.steps).toEqual([18, 19, 20, 21, 22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(12_005);
    expect(restored.state.worldSeed).toBe(180_110);
    expect(hashState(restored.state)).toBe('a5b1bbf8');
  });

  // NEVER EDIT THESE EXPECTATIONS AND NEVER REGENERATE THIS FIXTURE. format-19 is the first save
  // in which A MACHINE'S OUTPUT BASKET HAS A NAME ON IT (item 111), recorded by
  // `scripts/record-format-19.ts`. Until it, `outputCount` was a bare number whose identity came
  // from the machine's spec — true for the whole life of the file, and false the moment a
  // Seasoner learned four recipes. The world it holds is one format 18 could not describe: two
  // Seasoners side by side holding two different products.
  it('migrates format-19.json up to the current version', () => {
    const restored = restoreWorld(fixture19);

    expect(restored.migration.fromVersion).toBe(19);
    // One step now (item 112): 19 → 20 gives a hopper line, an output basket, a claw and every
    // belt item the clock the goods inside them are running. Every one of them gets a 0, which
    // reads as "no clock" — this world is grandfathered exactly as a format-17 cellar was, and
    // heals on the next thing anybody puts in it.
    expect(restored.migration.steps).toEqual([19, 20, 21, 22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(661);
    expect(restored.state.worldSeed).toBe(190_111);
    expect(hashState(restored.state)).toBe('79d25473');
  });

  it('buys back the premium baskets and keeps the plain one — the format-19 half of item 145', () => {
    // This fixture existed to pin two Seasoners of one kind holding two different products —
    // six chili chips beside six plain — with a bag of gold chips at the Bagger. Item 145
    // deleted the whole flavour tier, so what the same bytes now pin is the payout: the chili
    // basket (6 × $18.50), the gold bag (1 × $26.00) and the three seasoned-gold chips in the
    // Bagger's fourth hopper (3 × $20.00) are all bought back at format-23 list — $197 on the
    // $50 this world had — while the plain basket, which names nothing the cut touched, comes
    // through to the unit.
    const state = restoreWorld(fixture19).state;
    const seasoners = state.machines.filter((m) => m.kind === MachineKind.Seasoner);
    const bagger = state.machines.find((m) => m.kind === MachineKind.Bagger)!;

    expect(state.moneyCents).toBe(5_000 + 6 * 1_850 + 1 * 2_600 + 3 * 2_000);

    expect(seasoners).toHaveLength(2);
    const plain = seasoners.find((m) => m.outputItem === ItemId.SeasonedChips)!;
    const emptied = seasoners.find((m) => m.outputItem === 0)!;
    expect(plain.outputCount).toBe(6);
    expect(emptied.outputCount).toBe(0);
    expect(bagger.outputItem).toBe(0);
    expect(bagger.outputCount).toBe(0);

    // And the hopper remap: every one of these machines saved four hopper lines under format
    // 23 and reads back exactly one, with the surviving count in slot 0.
    for (const machine of [...seasoners, bagger]) {
      expect(machine.inputCounts).toHaveLength(1);
    }

    // One product per buffer, restored rather than merely remembered.
    stepMany(state, 300);
    expect(plain.outputItem).toBe(ItemId.SeasonedChips);
  });

  // NEVER EDIT THIS FIXTURE, AND NEVER REGENERATE IT. format-20 is the first save
  // in which EVERY PLACE A GOOD CAN SIT KNOWS HOW OLD IT IS (item 112), recorded by
  // `scripts/record-format-20.ts`. Format 18 gave a container the clock its cargo runs on and item
  // 110's own verifier found within the hour that the bug had moved rather than died: a hopper, an
  // output basket, a claw and a belt held goods and knew nothing about their age, so a Seasoner
  // nobody could start was a free refrigerator and an arm-and-belt loop minted windows with no
  // player at all. Every clock in this world is caught PART-SPENT, because a clock at rest proves
  // nothing — a machine with an empty hopper and a belt with nothing on it round-trip perfectly
  // and say nothing about the format they were written for.
  it('migrates format-20.json up to the current version', () => {
    const restored = restoreWorld(fixture20);

    expect(restored.migration.fromVersion).toBe(20);
    expect(restored.migration.steps).toEqual([20, 21, 22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(1_291);
    expect(restored.state.worldSeed).toBe(200_112);
    // 24d7d3d8 -> 5466204d (save format 23, item 140), and the loss of a lovely assertion. Until
    // today this line read **THE HASH DOES NOT MOVE, AND THAT IS THE ASSERTION**: migration
    // 20 → 21 wrote three new hashed fields onto collections this world has none of — no
    // contracts, no Agri-Bots — so the digest walked two empty lists and read nothing new. A
    // world that gained a format and kept its hash was a migration that added a field rather than
    // an opinion. Format 23 does not have that shape: it takes three numbers OFF the one
    // collection every world has, so nothing can sit this one out.
    expect(hashState(restored.state)).toBe('46f9677d');
  });

  // NEVER EDIT THESE EXPECTATIONS AND NEVER REGENERATE THIS FIXTURE. format-21 is the first save in
  // which the LAST TWO places a good can sit know how old it is (item 115), recorded by
  // `scripts/record-format-21.ts`. Item 112 closed five doors and its own verifier found two more:
  // a Truck Depot's floor, which was a bare count and therefore an unbounded refrigerator with a
  // receipt; and a bot that cannot deliver, which holds its armful for as long as the jam lasts.
  // Every clock here is caught PART-SPENT except the lorry's, which is caught UNCHANGING, because
  // that is the fact rather than the absence of one.
  it('migrates format-21.json up to the current version', () => {
    const restored = restoreWorld(fixture21);

    expect(restored.migration.fromVersion).toBe(21);
    expect(restored.migration.steps).toEqual([21, 22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.tick).toBe(1_943);
    expect(restored.state.worldSeed).toBe(200_115);
    expect(hashState(restored.state)).toBe('035fa804');
  });

  // **THE REGRESSION TEST FOR ITEM 141, AND THE REASON IT IS THREE ROWS RATHER THAN TWO.** The
  // 21 → 22 merge shipped naming four keys — `lifetimeCount`, `lifetimeCents`, `dawnCount`,
  // `dawnCents` — that belong to the LIVE ledger and appear nowhere in a serialized row, so every
  // fold added nothing and then dropped the row it had failed to fold in.
  //
  // What hid it for a day is the ASYMMETRY, which is why both shapes are driven here at once: a
  // Day-Old row with NO fresh sibling takes the `push` branch, keeps every field, and has always
  // been correct — so the case a person would check by hand was the one case that worked. Only a
  // row WITH a sibling was eaten, and rows sort ascending, so the sibling is always already there.
  //
  // Built on the recorded format-21 payload rather than a hand-written one, so that everything
  // around the ledger is real, and driven through `restoreWorld` rather than `MIGRATIONS[21]` so
  // that the numbers are asserted where a player would see them: after 21 → 22 → 23 → 24,
  // through the loader's own validation. THE FIXTURE ITSELF IS NOT TOUCHED — its `salesByItem` is empty and
  // stays empty; this is a copy with a ledger written onto it.
  it('folds a Day-Old sales row into its fresh sibling instead of eating it', () => {
    const doctored = {
      ...fixture21,
      payload: {
        ...fixture21.payload,
        stats: {
          ...fixture21.payload.stats,
          salesByItem: [
            // RussetPotato, the sibling that survives and must grow.
            { cents: 2_000, centsAtDawn: 500, item: 2, units: 10, unitsAtDawn: 3 },
            // DayOldPotato → folds into the row above.
            { cents: 630, centsAtDawn: 90, item: 8, units: 7, unitsAtDawn: 1 },
            // Compost, which has no successor at all: its row goes, because id 9 is not a good
            // this build can name and the loader would refuse the save over it.
            { cents: 400, centsAtDawn: 200, item: 9, units: 20, unitsAtDawn: 10 },
            // DayOldChili with NO fresh sibling → re-pointed to ChiliPepper, every field intact.
            { cents: 900, centsAtDawn: 300, item: 18, units: 4, unitsAtDawn: 2 },
          ],
        },
      },
    };

    const restored = restoreWorld(doctored);
    expect(restored.migration.steps).toEqual([21, 22, 23]);

    const sales = restored.state.stats.salesByItem;

    // 1. **THE FOLD, TO THE UNIT AND THE CENT.** 10u + 7u and $20.00 + $6.30 — and the dawn pair
    //    counted too, because a merge that got only the lifetime columns right would still hand
    //    the player a Shift Report whose "today" line disagrees with its own total.
    const russet = sales.find((row) => row.item === ItemId.RussetPotato)!;
    expect(russet.units).toBe(17);
    expect(russet.cents).toBe(2_630);
    expect(russet.unitsAtDawn).toBe(4);
    expect(russet.centsAtDawn).toBe(590);

    // 2. **THE BRANCH THAT ALWAYS WORKED now ends one step later.** The DayOldChili row is
    //    re-pointed at ChiliPepper by 21 → 22 exactly as before — and then item 145's 23 → 24
    //    step deletes the ChiliPepper itself, so the re-pointed row is dropped the way the
    //    Compost row always was: history, not property, and a save the loader would otherwise
    //    refuse over a number in a report. No cash moves for a ledger row.
    //
    // 3. Nothing else was invented, and the ledger is still sorted ascending — the order the
    //    hash rests on.
    expect(sales.map((row) => row.item)).toEqual([ItemId.RussetPotato]);
  });

  // NEVER EDIT THESE EXPECTATIONS AND NEVER REGENERATE THIS FIXTURE. format-22 is the first save
  // written after NOTHING ROTS (item 124), recorded by `scripts/record-format-22.ts`. Formats 18
  // through 21 spent four migrations adding a clock to every place a good can sit; this one takes
  // all of them out, along with `readyAge`, the fertility pair and the per-slot `stacks` list.
  //
  // The three beats are the facts a format-21 payload could not express, and every one of them is
  // caught AFTER a simulated day of world time — because a clock that has not been given time to
  // run proves nothing about whether it is gone.
  it('migrates format-22.json up to the current version — one step, and no refund owed', () => {
    const restored = restoreWorld(fixture22);

    expect(restored.migration.fromVersion).toBe(22);
    expect(restored.migration.steps).toEqual([22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.worldSeed).toBe(200_124);
    expect(restored.state.tick).toBe(60_001);

    // 1. A RIPE CROP THAT STOOD FOR A SIMULATED DAY AND IS THE SAME CROP. Under format 21 this
    //    tile drooped at 36,000 ticks, turned Day-Old at 42,000, and was compost by 54,000.
    const waiting = restored.state.field.find((tile) => tile.tileX === 6 && tile.tileY === 6)!;
    expect(waiting.crop).toBe(CropId.RussetPotato);
    expect(waiting.growth).toBeGreaterThanOrEqual(waiting.growthTarget);

    // 2. A LOADED CONTAINER AND A BLOCKED HOPPER, NEITHER OF THEM ANY EMPTIER — though the
    //    container itself is gone: the recorded Root Cellar was DELETED by item 145, so the
    //    23 → 24 step pays its $250 invoice into the wallet and hands its twelve potatoes back
    //    through the bag (the Composter's door — a survivor inside a deleted machine is given,
    //    never paid). The blocked Seasoner survives with its five plain chips in slot 0 of a
    //    hopper the format-24 remap shrank from four lines to one.
    expect(restored.state.machines.some((m) => (m.kind as number) === 25)).toBe(false);
    expect(restored.state.moneyCents).toBe(1_000_000 + 25_000);
    const seasoner = restored.state.machines.find((m) => m.kind === MachineKind.Seasoner)!;
    expect(seasoner.inputCounts).toEqual([5]);

    // 3. A HARVEST PAID AT `HARVEST_BASE_COUNT` + THE COIN, on ground with no fertility on it.
    //    Four: three plus a one — plus the cellar's twelve, which is beat 2 landing in the bag.
    expect(restored.state.inventory.find((slot) => slot.item === ItemId.RussetPotato)?.count).toBe(
      4 + 12,
    );

    expect(hashState(restored.state)).toBe('31789b85');
  });

  // NEVER EDIT THIS FIXTURE, AND NEVER REGENERATE IT — and this one you could not regenerate if
  // you wanted to, which is the whole reason it exists. **`format-22-well.json` IS THE ONLY SAVE
  // IN THIS DIRECTORY THAT NO CURRENT BUILD CAN WRITE.** The Artesian Well was released on
  // 2026-08-17 and retired on 2026-08-18 (items 130 and 140), so it was ownable for one day and
  // `format-22.json` — recorded during it — happens not to contain one. Rather than hand-write a
  // format-22 payload and test the migration I imagined, this was recorded by
  // `scripts/record-format-22-well.ts` running against commit `1fef820`, the last build that had
  // the machine. That script is kept beside the fixture as provenance and is deliberately not
  // compiled: it names three ids that no longer exist.
  //
  // It holds one of every place a well can hide, and every one of them at a DIFFERENT invoice,
  // because the thing most likely to go wrong in a refund is paying list for something that cost
  // more:
  //
  //   * a BARE well on the bank, at exactly the $600 it cost new;
  //   * an UPGRADED well at $915 — the one a flat refund robs;
  //   * two BOXED wells in one slot at $600 and $780, in canonical least-invested-first order;
  //   * the `hydraulics-artesian-well` node, researched;
  //   * and a pond drawn down to 6,040,000 of 20,000,000 ml with 700 in its recharge remainder,
  //     so "the level is dropped" is visibly different from "the level is topped up".
  it('migrates format-22-well.json, and buys back every well at what it actually cost', () => {
    const restored = restoreWorld(fixture22Well);

    expect(restored.migration.fromVersion).toBe(22);
    expect(restored.migration.steps).toEqual([22, 23]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.worldSeed).toBe(200_140);
    expect(restored.state.tick).toBe(400);

    // 1. **THE MONEY, TO THE CENT.** $600 bare + $915 upgraded + $600 boxed + $780 boxed + $600
    //    for the node, on top of the $50 the player had. A flat $600 five times would be $3,050
    //    and would have quietly taken $445 off this player.
    expect(restored.state.moneyCents).toBe(5_000 + 60_000 + 91_500 + 60_000 + 78_000 + 60_000);

    // 2. **NOTHING NAMING A WELL SURVIVES**, in the world or in the bag or in the tech list —
    //    and the sell bin that stood beside them is untouched, which is what says this removed
    //    the wells rather than the machines.
    expect(restored.state.machines.map((machine) => machine.kind)).toEqual([MachineKind.SellBin]);
    expect(restored.state.inventory.map((slot) => slot.item)).toEqual([ItemId.PotatoSeed]);
    expect(restored.state.unlocked).toEqual(['hydraulics-pumps']);

    // 3. **THE POND IS NOT TOPPED UP; IT STOPS HAVING A LEVEL.** A migration that "filled it to
    //    capacity" would be indistinguishable from this one on a full pond, which is exactly why
    //    the fixture was recorded with a drawn-down one.
    expect(restored.state.reservoirs).toHaveLength(1);
    expect(Object.keys(restored.state.reservoirs[0]!).sort()).toEqual(
      ['id', 'tileX', 'tileY', 'tilesHigh', 'tilesWide'].sort(),
    );

    // 4. And it is a world that runs. The pond it now draws on is unlimited, so this is also the
    //    smallest possible statement of the item: a save that knew about scarcity loads into a
    //    world that does not.
    stepMany(restored.state, 200);
    expect(restored.state.tick).toBe(600);
  });

  // NEVER EDIT THESE EXPECTATIONS AND NEVER REGENERATE THIS FIXTURE. format-23 is the first save
  // written after THE POND STOPPED BEING A STOCK (item 140), recorded by
  // `scripts/record-format-23.ts`. Format 3 gave a reservoir a level, a capacity and a recharge
  // accumulator and every format for twenty releases carried all three; this one takes them out.
  //
  // The beats are the facts a format-22 payload could not express, and the middle one is the item
  // in a single number: this world has drunk 25,000,000 ml — a quarter more than the entire
  // capacity of the pond it is standing next to — and the pond is still answering in full.
  it('migrates format-23.json in one step, and owes this world nothing', () => {
    const restored = restoreWorld(fixture23);

    expect(restored.migration.fromVersion).toBe(23);
    // It arrived current and stopped being so within the week: items 145/146/147 appended
    // 23 → 24. This world is all water — a pump, a tank, two heads and a hub — and holds not
    // one thing the flavour cut named, so the step's whole effect here is dropping the four
    // dead field families. The wallet not moving is the assertion that the largest buy-back
    // in the chain's history pays EXACTLY the people it owes: $10,000 in, $10,000 out.
    expect(restored.migration.steps).toEqual([23]);
    expect(restored.state.moneyCents).toBe(1_000_000);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.worldSeed).toBe(200_143);
    expect(restored.state.tick).toBe(50_000);

    // 1. A POND WITH NOTHING IN IT TO RECORD. The absence is the point — the fields are gone from
    //    the payload rather than zeroed in it.
    expect(restored.state.reservoirs).toHaveLength(1);
    expect(Object.keys(restored.state.reservoirs[0]!).sort()).toEqual(
      ['id', 'tileX', 'tileY', 'tilesHigh', 'tilesWide'].sort(),
    );

    // 2. **MORE WATER DRAWN THAN THE OLD POND COULD EVER HAVE HELD.** 20,000,000 ml was a
    //    format-22 pond, brim to bed. This one has taken 25,000,000 and is still going.
    expect(restored.state.stats.waterDrawnMl).toBe(25_000_000);

    // 3. THE INSTANT THAT USED TO BE THE GAME'S WORST: a spent tank and an amber head, with the
    //    pump at its FULL RATING regardless. Under format 22 this world had a drained pond and a
    //    pump that was halved and then sipping; the tank is empty here because demand outruns
    //    600,000 ml/min, which is a fact about the pump rather than about the water.
    const pump = restored.state.machines.find((m) => m.kind === MachineKind.Pump)!;
    const tank = restored.state.machines.find((m) => m.kind === MachineKind.Tank)!;
    const head = restored.state.machines.find((m) => m.kind === MachineKind.PipedSprinkler)!;
    expect(tank.tankMl).toBe(0);
    expect(head.opCount).toBe(341);

    // And it keeps its word after a round trip: one more tick, and the pump is still flat out.
    stepMany(restored.state, 1);
    expect(pump.flowMlPerMinute).toBe(PUMP_RATE_ML_PER_MINUTE);
    expect(restored.state.stats.waterDrawnMl).toBe(25_000_000 + 500);
  });

  // NEVER EDIT THESE EXPECTATIONS AND NEVER REGENERATE THIS FIXTURE. format-24 is the first
  // save written after THE FLAVOUR CUT (items 145/146/147), recorded by
  // `scripts/record-format-24.ts`. A format-24 save is a format-23 save with less in it, so
  // what it pins is the states whose SPELLING moved: a Washer caught mid-bottle with both
  // surviving hoppers loaded — russets in slot 0, used bottles in the slot the gold potatoes
  // used to hold — a zone that is paint and a name and nothing else, and machines with no
  // untouched-work clock anywhere in the payload.
  it('loads format-24.json at the current version with no migration', () => {
    const restored = restoreWorld(fixture24);

    expect(restored.migration.fromVersion).toBe(24);
    expect(restored.migration.steps).toEqual([]);
    expect(restored.envelope.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(restored.state.worldSeed).toBe(200_145);
    expect(restored.state.tick).toBe(251);

    // 1. THE TWO-HOPPER WASHER, MID-BOTTLE. Slot 1 IS the bottle slot now — a loader that
    //    read the format-23 layout here would be washing gold potatoes this world cannot name.
    const washer = restored.state.machines.find((m) => m.kind === MachineKind.Washer)!;
    expect(washer.inputCounts).toEqual([6, 2]);
    expect(washer.outputItem).toBe(ItemId.Bottle);
    expect(washer.outputCount).toBe(8);
    expect(washer.progress).toBeGreaterThan(0);

    // 2. A ZONE WITH NOTHING ON IT BUT PAINT, A CROP AND A NAME.
    expect(restored.state.zones).toHaveLength(1);
    expect(restored.state.zones[0]!.crop).toBe(CropId.RussetPotato);

    // 3. And it keeps simulating identically from here — the bottle wash finishes on the same
    //    schedule in two restores.
    const again = restoreWorld(fixture24).state;
    stepMany(restored.state, 300);
    stepMany(again, 300);
    expect(hashState(restored.state)).toBe(hashState(again));
  });

  // **THE WORST-CASE FORMAT-23 PAYLOAD: every cut thing item 145/146/147 names, in one save.**
  // No current build can record this world and no real save happens to hold all of it, so it is
  // doctored onto the real format-23 fixture the way the item-141 fold test doctors format-21:
  // everything around the cuts is real, and the fixture itself is not touched. Every payout is
  // itemised below and summed to the cent, because "the wallet went up" would pass on a
  // migration that paid double.
  it('pays out the whole flavour economy — every cut thing, everywhere it can sit', () => {
    const base = fixture23.payload.machines[0]!;
    const machine = (over: Record<string, unknown>): Record<string, unknown> => ({
      ...base,
      ...over,
    });
    const box = (investedCents: number): Record<string, unknown> => ({
      speedLevel: 0,
      efficiencyLevel: 0,
      capacityLevel: 0,
      condition: CONDITION_MAX,
      investedCents,
    });

    const doctored = JSON.parse(JSON.stringify(fixture23)) as {
      payload: Record<string, unknown> & {
        field: Record<string, unknown>[];
        stats: Record<string, unknown>;
      };
    };
    const p = doctored.payload;

    // Built machines: every deleted kind, plus survivors holding doomed goods.
    p['machines'] = [
      ...(fixture23.payload.machines as Record<string, unknown>[]),
      // A ChipKitchen with a dial's worth of invoice, potatoes in the hopper, bags in the
      // basket, and an untouched-clock mid-count. Invoice back; potatoes and bags to the bag.
      machine({
        id: 101,
        kind: 2,
        tileX: 20,
        tileY: 20,
        investedCents: 12_000,
        inputCounts: [3],
        outputItem: 3,
        outputCount: 2,
        untouchedTicks: 500,
      }),
      // A Recirculator with a corrupt zero invoice: the $300 list is the floor.
      machine({ id: 102, kind: 13, tileX: 22, tileY: 20, investedCents: 0 }),
      // A RootCellar holding a BOXED CHIP KITCHEN — a deleted machine inside a deleted
      // machine. Cellar at invoice; the box at list, because cargo carries no invoice.
      machine({
        id: 103,
        kind: 25,
        tileX: 24,
        tileY: 20,
        investedCents: 26_000,
        cargoItem: 27,
        cargoCount: 1,
      }),
      // An OrangeTree with five oranges in the basket, and a bare LemonTree.
      machine({
        id: 104,
        kind: 28,
        tileX: 26,
        tileY: 20,
        investedCents: 20_000,
        outputItem: 53,
        outputCount: 5,
      }),
      machine({ id: 105, kind: 29, tileX: 28, tileY: 20, investedCents: 20_000 }),
      // A MaintenanceStation with two repair kits hoppered. Kits survive: back to the bag.
      machine({
        id: 106,
        kind: 33,
        tileX: 30,
        tileY: 20,
        investedCents: 121_000,
        inputCounts: [2],
      }),
      // SURVIVORS holding the dead: the Washer's three format-23 hopper lines (russets keep
      // slot 0, gold pays out, bottles slide 2 → 1), the Seasoner's four (plain chips keep,
      // peppers/corn/gold-chips pay) plus a basket of chili chips, and a harvester dock with
      // corn seed on the seed shelf.
      machine({
        id: 107,
        kind: 4,
        tileX: 32,
        tileY: 20,
        investedCents: 6_000,
        inputCounts: [5, 4, 6],
      }),
      machine({
        id: 108,
        kind: 7,
        tileX: 34,
        tileY: 20,
        investedCents: 9_000,
        inputCounts: [1, 2, 3, 4],
        outputItem: 75,
        outputCount: 2,
      }),
      machine({
        id: 109,
        kind: 31,
        tileX: 36,
        tileY: 20,
        investedCents: 25_000,
        seedShelfItem: 13,
        seedShelfCount: 6,
      }),
    ];
    p['nextMachineId'] = 110;

    // A gold bag riding a belt ahead of a plain one; a claw holding gold chips, filtered to corn.
    p['belts'] = [
      {
        dir: 2,
        id: 1,
        items: [
          { dist: 0, item: 74 },
          { dist: 100, item: 3 },
        ],
        lengthTiles: 3,
        moveAccum: 0,
        tier: 1,
        tileX: 20,
        tileY: 24,
      },
    ];
    p['nextBeltId'] = 2;
    p['grabbers'] = [
      {
        cooldown: 0,
        dir: 1,
        filter: 14,
        held: 72,
        id: 1,
        opCount: 3,
        tier: 1,
        tileX: 24,
        tileY: 24,
      },
    ];
    p['nextGrabberId'] = 2;

    // A bot with an armful of gold potatoes and a pocket of gold seed, parked at the dock.
    p['bots'] = [
      {
        carryCount: 4,
        carryItem: 51,
        condition: CONDITION_MAX,
        dockId: 109,
        facing: 1,
        id: 1,
        kind: BotKind.Harvester,
        moveAccum: 0,
        opCount: 0,
        phase: BotPhase.Idle,
        routeCursor: 0,
        seedCount: 3,
        seedItem: 50,
        targetTile: -1,
        workTicks: 0,
        xSub: 36 * SUBTILE,
        ySub: 21 * SUBTILE,
      },
    ];
    p['nextBotId'] = 2;

    // Two standing routes: gold bags (paid out, stocked AND in transit, and the route torn
    // up) beside plain bags (kept).
    p['contracts'] = [
      {
        depotId: 1,
        destination: 'Ridgeline Grocers',
        grossCents: 0,
        id: 1,
        inTransit: 3,
        item: 74,
        phase: ContractPhase.Rolling,
        quantityPerRun: 5,
        runsCompleted: 0,
        stocked: 2,
        ticksRemaining: 100,
      },
      {
        depotId: 1,
        destination: 'Ridgeline Grocers',
        grossCents: 0,
        id: 2,
        inTransit: 0,
        item: 3,
        phase: ContractPhase.Waiting,
        quantityPerRun: 5,
        runsCompleted: 0,
        stocked: 1,
        ticksRemaining: 0,
      },
    ];
    p['nextContractId'] = 3;

    // The bag: chili seed, two boxed kitchens at two invoices, loose gold potatoes, and a
    // boxed maintenance station — ascending by id, as the writer keeps it.
    p['inventory'] = [
      ...(fixture23.payload.inventory as Record<string, unknown>[]),
      { boxes: [], count: 2, item: 16 },
      { boxes: [box(10_000), box(15_000)], count: 2, item: 27 },
      { boxes: [], count: 3, item: 51 },
      { boxes: [box(120_000)], count: 1, item: 67 },
    ];

    // Three tiles growing the three cut crops, and an auto-replanting chili zone.
    p.field[0] = { ...p.field[0]!, crop: 3, growth: 100, growthTarget: 4_200 };
    p.field[1] = { ...p.field[1]!, crop: 4, growth: 2_400, growthTarget: 2_400 };
    p.field[2] = { ...p.field[2]!, crop: 5, growth: 0, growthTarget: 3_600 };
    p['zones'] = [
      {
        autoReplant: true,
        crop: 4,
        id: 1,
        name: 'the chili strip',
        priority: 0,
        replantCooldown: 55,
      },
    ];
    p['nextZoneId'] = 2;

    // All nine cut research nodes, the Corporate Charter's $20,000 among them.
    p['unlocked'] = [
      ...(fixture23.payload.unlocked as string[]),
      'agronomy-corn',
      'agronomy-chili',
      'agronomy-gold-potato',
      'agronomy-seed-hopper',
      'agronomy-root-cellar',
      'agronomy-orchard',
      'hydraulics-recirculator',
      'fabrication-diagnostics',
      'charter-corporate',
    ];

    // A ledger row for a cut good (dropped, uncompensated — history, not property), and a
    // saved errand walking to plant corn (cancelled — the Fertilize rule).
    p.stats['salesByItem'] = [
      { cents: 2_000, centsAtDawn: 0, item: 2, units: 10, unitsAtDawn: 0 },
      { cents: 9_250, centsAtDawn: 0, item: 75, units: 5, unitsAtDawn: 0 },
    ];
    p['player'] = {
      ...(fixture23.payload.player as Record<string, unknown>),
      intent: {
        action: IntentAction.Plant,
        count: 1,
        issuedTick: 49_990,
        item: 13,
        tileX: 5,
        tileY: 5,
      },
    };

    // THE CHEQUE, ITEMISED. Machines at invoice floored at list; goods at format-23 list.
    const machinesCents = 12_000 + 30_000 + 26_000 + 10_000 + 20_000 + 5 * 260 + 20_000 + 121_000;
    const hopperCents = 4 * 600 + (2 * 300 + 3 * 220 + 4 * 1_500) + 2 * 1_850; // washer gold + seasoner lines + chili basket
    const shelfBeltClawCents = 6 * 70 + 2_600 + 1_500; // corn seed shelf + gold bag on belt + gold chips in claw
    const botCents = 4 * 600 + 3 * 200;
    const contractCents = (2 + 3) * 2_600;
    const bagCents = 2 * 90 + (10_000 + 15_000) + 3 * 600 + 120_000;
    const fieldCents = 70 + 90 + 200;
    const techCents =
      3_000 + 4_000 + 15_000 + 120_000 + 55_000 + 80_000 + 90_000 + 120_000 + 2_000_000;
    const refund =
      machinesCents +
      hopperCents +
      shelfBeltClawCents +
      botCents +
      contractCents +
      bagCents +
      fieldCents +
      techCents;

    const restored = restoreWorld(doctored);
    expect(restored.migration.steps).toEqual([23]);
    const state = restored.state;

    // 1. THE MONEY, TO THE CENT.
    expect(state.moneyCents).toBe(1_000_000 + refund);

    // 2. NOTHING CUT SURVIVES ANYWHERE. Kinds, goods, crops, techs, ledger rows, the errand.
    expect(state.machines.some((m) => [2, 13, 25, 28, 29, 33].includes(m.kind))).toBe(false);
    const doomed = new Set([
      13, 14, 16, 17, 27, 38, 50, 51, 53, 54, 58, 61, 62, 67, 70, 71, 72, 73, 74, 75, 76, 77, 78,
    ]);
    for (const slot of state.inventory) expect(doomed.has(slot.item)).toBe(false);
    for (const belt of state.belts) {
      for (const entry of belt.items) expect(doomed.has(entry.item)).toBe(false);
    }
    for (const grabber of state.grabbers) {
      expect(doomed.has(grabber.held)).toBe(false);
      expect(grabber.filter).toBe(0);
    }
    for (const bot of state.bots) {
      expect(bot.carryItem).toBe(0);
      expect(bot.seedItem).toBe(0);
    }
    expect(state.contracts.map((c) => c.item)).toEqual([ItemId.BaggedChips]);
    expect(state.field.every((tile) => ![3, 4, 5].includes(tile.crop as number))).toBe(true);
    expect(state.zones[0]!.crop).toBe(CropId.None);
    expect(state.unlocked).toEqual([...fixture23.payload.unlocked].sort());
    expect(state.stats.salesByItem.map((row) => row.item)).toEqual([ItemId.RussetPotato]);
    expect(state.player.intent).toBeNull();

    // 3. THE SURVIVORS CAME THROUGH THE RIGHT DOORS. The Washer's bottles slid to slot 1, the
    //    Seasoner kept only plain chips, and the kitchen's potatoes and bags plus the
    //    station's kits landed in the bag beside the seed that was already there.
    const washer = state.machines.find((m) => m.kind === MachineKind.Washer)!;
    expect(washer.inputCounts).toEqual([5, 6]);
    const seasoner = state.machines.find((m) => m.kind === MachineKind.Seasoner)!;
    expect(seasoner.inputCounts).toEqual([1]);
    expect(seasoner.outputItem).toBe(0);
    expect(state.inventory).toEqual([
      { item: ItemId.PotatoSeed, count: 8, boxes: [] },
      { item: ItemId.RussetPotato, count: 3, boxes: [] },
      { item: ItemId.BaggedChips, count: 2, boxes: [] },
      { item: ItemId.RepairKit, count: 2, boxes: [] },
    ]);
    // The cut-crop tiles are TILLED EARTH, not grass: still in the field, growing nothing.
    expect(state.field[0]!.crop).toBe(CropId.None);
    expect(state.field[0]!.growth).toBe(0);

    // 4. AND IT IS A WORLD THAT RUNS: hashable, steppable, integer-clean.
    const hash = hashState(state);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    stepMany(state, 60);
    expect(state.tick).toBe(50_060);
  });

  it('brings back both shelves, each with its own name on it', () => {
    const state = restoreWorld(fixture16).state;
    const dock = state.machines.find((m) => m.kind === MachineKind.HarvesterDock)!;

    expect(dock.cargoItem).toBe(ItemId.RussetPotato);
    expect(dock.cargoCount).toBe(5);
    expect(dock.seedShelfItem).toBe(ItemId.PotatoSeed);
    expect(dock.seedShelfCount).toBe(3);
    expect(dock.outputCount).toBe(0);

    // The seeds are on the SHELF, not in the pouch. A robot's seed is the robot's to hand over,
    // and it takes a belt or a hand to move it — which is the loop this game asks the player to
    // build rather than routing goods across the map by magic.
    expect(state.inventory.find((slot) => slot.item === ItemId.PotatoSeed)?.count ?? 0).toBe(5);
    expect(state.stats.itemsHarvestedByHand).toBe(0);
  });

  it('brings back the tilled ground, and the ledger that outlives it', () => {
    const state = restoreWorld(fixture13).state;

    // 64 gift tiles plus the 4×1 tilled strip, minus the one un-tilled back to grass.
    expect(state.field.length).toBe(67);
    // The strip is OUTSIDE the legacy rect — the field is genuinely non-rectangular.
    expect(state.field.some((tile) => tile.tileY === 2)).toBe(true);
    // The un-tilled position is gone from the field…
    expect(state.field.some((tile) => tile.tileX === 6 && tile.tileY === 2)).toBe(false);
    // …and remembered forever in the ledger, so re-tilling it can never re-roll.
    expect(state.soilMemory.length).toBe(68);
    expect(state.soilMemory.some((entry) => entry.tile === 2 * 64 + 6)).toBe(true);

    // The farmed strip tile went through a full hand cycle and came back bare.
    const farmed = state.field.find((tile) => tile.tileX === 5 && tile.tileY === 2)!;
    expect(farmed.crop).toBe(CropId.None);
  });

  it('brings the bot back mid-walk, with its armful and its accumulator intact', () => {
    const state = restoreWorld(fixture11).state;

    // A bot's position IS world state. A reload that rounded it, dropped its route cursor, or
    // restarted its walk would put the robot somewhere else on the very next tick — and the world
    // would look perfectly healthy while hashing differently from the one that was saved.
    const bot = state.bots[0]!;
    expect(bot.carryCount).toBe(8);
    expect(bot.carryItem).toBe(ItemId.RussetPotato);
    expect(bot.moveAccum).toBe(32);
    expect(Number.isInteger(bot.xSub)).toBe(true);
    expect(Number.isInteger(bot.ySub)).toBe(true);

    // The cart is still in the player's hands.
    expect(state.player.towedCartId).toBeGreaterThan(0);
  });

  it('brings back the whole bag as one count per item, and the soil under the field', () => {
    const state = restoreWorld(fixture11).state;

    // **ONE COUNT PER SLOT AGAIN** (item 124). A format-11 save wrote a `stacks` list beside
    // every perishable count, and the 21 → 22 migration drops it — the COUNT is what survives,
    // which is the whole of plan §4's floor as it applies to a save.
    const potatoes = state.inventory.find((slot) => slot.item === ItemId.RussetPotato)!;
    expect(potatoes.count).toBeGreaterThan(0);

    // Soil is rolled once at world creation and never changes, so a save that lost it would grow
    // every future crop at a rate the tile never had.
    const soils = new Set(state.field.map((tile) => tile.soil));
    expect(soils.size).toBeGreaterThan(1);
  });

  it('brings the junction back mid-rotation, with a bag on each of its branches', () => {
    const state = restoreWorld(fixture10).state;

    // The cursor IS the alternation. A reload that dropped it would restore a splitter that
    // starts its round-robin again from north, which is a different world producing a different
    // hash from the next tick on — and one that looks perfectly healthy while doing it.
    const junction = state.machines.find((m) => m.kind === MachineKind.BeltJunction)!;
    expect(junction.junctionOutCursor).toBe(2);
    expect(junction.junctionInCursor).toBe(0);

    // One bag went north and one went east, which is what a splitter is for. The Chip Kitchen
    // that made them was bought back by item 145's 23 → 24 step (its $200 invoice is in the
    // wallet), but the bags it sent round the junction are bags either way — the cursor and
    // the goods on both branches are the format-10 facts, and they survive their maker.
    const north = state.belts.find((belt) => belt.tileX === 8 && belt.tileY === 13)!;
    const east = state.belts.find((belt) => belt.tileX === 9 && belt.tileY === 14)!;
    expect(north.items).toHaveLength(1);
    expect(east.items).toHaveLength(1);
    expect(state.machines.some((m) => (m.kind as number) === 2)).toBe(false);
    expect(state.moneyCents).toBe(68_750 + 20_000);
  });

  it('keeps splitting identically after the reload', () => {
    // The point of storing the cursor rather than deriving it: two worlds restored from one file
    // and stepped forward must agree, and they must agree with a world that never reloaded.
    const a = restoreWorld(fixture10).state;
    const b = restoreWorld(fixture10).state;
    stepMany(a, 400);
    stepMany(b, 400);
    expect(hashState(a)).toBe(hashState(b));

    // Still splitting after the reload rather than merely surviving it.
    const north = a.belts.find((belt) => belt.tileX === 8 && belt.tileY === 13)!;
    const east = a.belts.find((belt) => belt.tileX === 9 && belt.tileY === 14)!;
    expect(north.items.length).toBeGreaterThan(1);
    expect(east.items.length).toBeGreaterThan(1);
  });

  it('keeps building on bought land after the reload', () => {
    const state = restoreWorld(fixture8).state;
    const before = state.machines.length;

    // The parcel is still owned on the other side of a save, which is the only thing that
    // makes the machines already standing on it legal. (A Sprinkler since item 145 — the
    // ownership gate is the subject, and it needs an ungated kind to show through.)
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'PlaceMachine', kind: MachineKind.Sprinkler, tileX: PARCEL_TILES + 8, tileY: 4 },
      ],
    });
    expect(state.machines).toHaveLength(before + 1);

    // And parcel 2 is still somebody else's until it is paid for.
    step(state, {
      tick: state.tick,
      commands: [
        {
          type: 'PlaceMachine',
          kind: MachineKind.Sprinkler,
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

// --- THE NAME-BLIND GUARDS, IN THEIR SECOND HOME (item 123) -----------------------------------
//
// **THE TWO GUARDS ABOVE ALL NAME A FIELD. THESE TWO NAME NONE**, and that is the whole of their
// value: they are what covers the field nobody has thought of yet — a count, a dial, a cursor, a
// clock — on the day it is added and before anybody has written a test for it.
//
// Which is exactly why they must not live in one place. Item 119 spread the clock scenarios across
// five files so that deleting any one lost nothing; these two were never spread, and until item 123
// both assertions were in `move-census-live.test.ts` alone. Deleting that file would have taken the
// entire name-blind layer with it, silently, because a guard against unknown fields cannot be
// missed by anyone reading a list of known ones.
//
// So they run here too, over the same shared fixture and the same shared excused list — one list,
// two homes — and `move-census.test.ts` counts the homes and goes red the day there is one.
//
// It belongs in this file on its own merits, not merely for the redundancy: the widest edge in
// the game is `toPayload`, and this is the file about `toPayload`.

describe('the save round trip, with no field named', () => {
  it('is structurally identical, every leaf', () => {
    const state = containersFilledWorld(12_400);
    // The trace is handed back rather than excepted: it is stored outside the payload by design,
    // so passing it makes the claim total instead of nearly total. There is no exception list
    // here at all, and that is the point.
    const diff = worldDiff(state, deserialize(serialize(state), state.trace));
    expect(diff.slice(0, 12), `a save/load changed ${String(diff.length)} fields`).toEqual([]);
  });

  it('leaves no number unfilled that nobody has excused', () => {
    // A field left at 0 round-trips as 0 whether it is carried or dropped, so the diff above is
    // blind to anything the fixture never fills. This is the half that fixes that, and it never
    // looks at a name: every number whose every occurrence is zero has to be filled in the fixture
    // or written into `UNFILLED_BY_DESIGN` with a reason.
    expect(
      unfilledNumbers(containersFilledWorld(12_401)),
      'a number this fixture never fills — fill it, or excuse it in goods.ts',
    ).toEqual(UNFILLED_BY_DESIGN);
  });
});
