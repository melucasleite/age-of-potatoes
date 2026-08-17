// The cheap structural gates for the world registry ([[055]]).
//
// AGENTS.md keeps verification light on purpose, so this pins only the places where being
// wrong is INVISIBLE — and for this feature that is a short list with very expensive entries:
//
//   · IF THE ADOPTION MIGRATION MISSES, a returning player opens the game and their factory is
//     not on the list. Everything still works. The save is still on disk, under a key nothing
//     reads any more, and the front door cheerfully offers to start them a new lot. This is the
//     single worst thing this item could do to somebody, it happens exactly once per player,
//     and it happens on a machine nobody is watching — so `planLegacyAdoption` is pure
//     precisely so it can be tested here, without a browser.
//   · IF THE RECORD KEYS COLLIDE, two worlds share one save. Both load. Both look fine. One of
//     them is the other, and the player finds out an hour later. The round trip below drives
//     the REAL `saveWorld`/`loadWorld` against an in-memory store rather than restating what
//     they ought to do.
//   · IF A TOMBSTONE EXPIRES EARLY, a delete that was advertised as recoverable was not.
//   · IF `nextWorldName` COUNTS worlds instead of inspecting their names, the game offers a
//     name that is already on screen the moment anybody deletes their first lot.
//
// There is no IndexedDB in this workspace's test environment, which is why the registry's
// logic and its database access were separated in the first place. What genuinely needs a
// browser — the re-key transaction actually committing, the sweep actually freeing bytes — is
// not faked into passing here; see the agent log on work item 055 for what was not exercised.

import { describe, expect, it } from 'vitest';
import { type SaveEnvelope, createWorld, serialize } from '@snack/sim';

import type { WorldRecord, WorldRegistry } from './db';
import { loadWorld, memorySaveStore, saveWorld } from './saves';
import {
  WORLD_TOMBSTONE_MS,
  createWorldRecord,
  currentKeyFor,
  emptyRegistry,
  expiredTombstones,
  findWorld,
  freshSeed,
  invalidateRegistry,
  liveWorlds,
  milestoneKeyFor,
  newestWorld,
  nextWorldName,
  planAvatarChange,
  planLegacyAdoption,
  previousKeyFor,
  setActiveWorldAvatar,
  withWorld,
} from './worlds';

const NOW = 1_760_000_000_000;

function envelopeAt(seed: number, tick: number, moneyCents: number): SaveEnvelope {
  const state = createWorld(seed);
  state.tick = tick;
  state.moneyCents = moneyCents;
  return serialize(state);
}

function world(patch: Partial<WorldRecord> = {}): WorldRecord {
  return {
    id: 'a',
    name: 'Lot #1',
    seed: 1,
    createdAt: NOW,
    lastPlayedAt: NOW,
    summary: { tick: 0, moneyCents: null, formatVersion: 7 },
    deletedAt: null,
    ...patch,
  };
}

function registryOf(...worlds: WorldRecord[]): WorldRegistry {
  return { version: 1, activeId: worlds[0]?.id ?? null, worlds };
}

describe('adopting a pre-registry player', () => {
  it('finds nothing to adopt on a genuinely fresh install', () => {
    const plan = planLegacyAdoption(
      { current: undefined, previous: undefined, hasConflict: false, legacySession: null },
      { now: NOW, id: 'new' },
    );

    expect(plan.adopted).toBeNull();
    expect(plan.rekey).toEqual([]);
    expect(plan.registry).toEqual(emptyRegistry());
  });

  it('adopts the existing save as Lot #1, keeping its seed and its place', () => {
    const current = envelopeAt(4242, 90_000, 15_000);
    const plan = planLegacyAdoption(
      { current, previous: undefined, hasConflict: false, legacySession: null },
      { now: NOW, id: 'w1' },
    );

    // Nothing renamed, nothing lost, and it is the world Continue will boot.
    expect(plan.adopted?.name).toBe('Lot #1');
    expect(plan.adopted?.seed).toBe(4242);
    expect(plan.registry.activeId).toBe('w1');
    expect(plan.adopted?.summary.tick).toBe(90_000);
    // The card can show money for a world nobody has opened yet, read off the payload with a
    // guard rather than by migrating it.
    expect(plan.adopted?.summary.moneyCents).toBe(15_000);
    expect(plan.rekey).toEqual([{ from: 'current', to: currentKeyFor('w1') }]);
  });

  it('adopts a lone backup rather than telling the player they have no save', () => {
    // `current` missing with `previous` present is the interrupted-write case `loadWorld`
    // already recovers from. A migration that ignored it would delete a world by omission.
    const plan = planLegacyAdoption(
      {
        current: undefined,
        previous: envelopeAt(7, 1_200, 500),
        hasConflict: false,
        legacySession: null,
      },
      { now: NOW, id: 'w1' },
    );

    expect(plan.adopted?.seed).toBe(7);
    expect(plan.adopted?.summary.tick).toBe(1_200);
    expect(plan.rekey).toEqual([{ from: 'previous', to: previousKeyFor('w1') }]);
  });

  it('carries the backup and the cloud parking slot across with the world', () => {
    const plan = planLegacyAdoption(
      {
        current: envelopeAt(1, 10, 0),
        previous: envelopeAt(1, 5, 0),
        hasConflict: true,
        legacySession: null,
      },
      { now: NOW, id: 'w1' },
    );

    expect(plan.rekey.map((move) => move.from)).toEqual(['current', 'previous', 'conflict']);
  });

  it('keeps the real last-played time, so a month away still reads as a month', () => {
    const monthAgo = NOW - 30 * 86_400_000;
    const plan = planLegacyAdoption(
      {
        current: envelopeAt(1, 500_000, 900),
        previous: undefined,
        hasConflict: false,
        legacySession: { at: monthAgo, tick: 500_000 },
      },
      { now: NOW, id: 'w1' },
    );

    expect(plan.adopted?.lastPlayedAt).toBe(monthAgo);
  });
});

describe('the list the front door draws', () => {
  it('offers the lowest free number rather than counting worlds', () => {
    const deleted = world({ id: 'b', name: 'Lot #2', deletedAt: NOW });
    const registry = registryOf(world({ id: 'a', name: 'Lot #1' }), deleted);

    // Lot #2 was deleted, so it is free again. Counting live worlds would have said "Lot #2"
    // as well — which is only right by accident. This is the case that separates them:
    expect(nextWorldName(registryOf(world({ id: 'a', name: 'Lot #2' })))).toBe('Lot #1');
    expect(nextWorldName(registry)).toBe('Lot #2');
  });

  it('hides tombstoned worlds and puts the most recently played first', () => {
    const registry = registryOf(
      world({ id: 'a', lastPlayedAt: NOW - 1_000 }),
      world({ id: 'b', lastPlayedAt: NOW }),
      world({ id: 'c', lastPlayedAt: NOW + 1_000, deletedAt: NOW }),
    );

    expect(liveWorlds(registry).map((w) => w.id)).toEqual(['b', 'a']);
    // Continue follows the player, not the active id — which is why 'c', deleted, cannot win
    // it even though it was played last.
    expect(newestWorld(registry)?.id).toBe('b');
  });

  it('leaves the input registry alone when a world is patched', () => {
    const registry = registryOf(world({ id: 'a' }));
    const next = withWorld(registry, 'a', { name: 'The Back Forty' });

    expect(next.worlds[0]?.name).toBe('The Back Forty');
    expect(registry.worlds[0]?.name).toBe('Lot #1');
  });
});

describe('the delete window', () => {
  it('keeps a tombstone until the window has actually passed', () => {
    const registry = registryOf(world({ id: 'a', deletedAt: NOW - WORLD_TOMBSTONE_MS + 1 }));
    expect(expiredTombstones(registry, NOW)).toHaveLength(0);
    expect(expiredTombstones(registryOf(world({ id: 'a', deletedAt: NOW })), NOW)).toHaveLength(0);
  });

  it('collects one the moment it is old enough', () => {
    const registry = registryOf(world({ id: 'a', deletedAt: NOW - WORLD_TOMBSTONE_MS }));
    expect(expiredTombstones(registry, NOW).map((w) => w.id)).toEqual(['a']);
  });

  it('never collects on a clock that ran backwards', () => {
    // A corrected machine time, or a record written by a device an hour ahead. Not fourteen
    // days of patience, and it must not be read as any.
    const registry = registryOf(world({ id: 'a', deletedAt: NOW + 86_400_000 }));
    expect(expiredTombstones(registry, NOW)).toHaveLength(0);
  });

  it('leaves live worlds entirely alone', () => {
    expect(
      expiredTombstones(registryOf(world({ id: 'a' })), NOW + 10 * WORLD_TOMBSTONE_MS),
    ).toEqual([]);
  });
});

describe('two worlds on one machine', () => {
  it('rolls a different seed every time, and never the old fixed one', () => {
    // 20260812 was `DEFAULT_SEED`, and every "new" world used to be that exact lot.
    const seeds = new Set(Array.from({ length: 24 }, () => freshSeed()));
    expect(seeds.size).toBeGreaterThan(1);
    expect(seeds.has(20260812)).toBe(false);
  });

  it('round-trips both worlds without either touching the other', async () => {
    const store = memorySaveStore();

    const alpha = createWorld(111);
    alpha.moneyCents = 1_000;
    alpha.tick = 40;
    const beta = createWorld(222);
    beta.moneyCents = 9_999;
    beta.tick = 80;

    await saveWorld(alpha, { worldId: 'alpha', store });
    await saveWorld(beta, { worldId: 'beta', store });

    // Interleaved, twice each — the acceptance criterion is "switching between them twice
    // loses nothing in either", and a bug in the key routing shows up on the second pass.
    alpha.tick = 60;
    alpha.moneyCents = 1_500;
    await saveWorld(alpha, { worldId: 'alpha', store });
    beta.tick = 120;
    beta.moneyCents = 8_000;
    await saveWorld(beta, { worldId: 'beta', store });

    const loadedAlpha = await loadWorld({ worldId: 'alpha', store });
    const loadedBeta = await loadWorld({ worldId: 'beta', store });

    expect(loadedAlpha.status).toBe('loaded');
    expect(loadedBeta.status).toBe('loaded');
    if (loadedAlpha.status !== 'loaded' || loadedBeta.status !== 'loaded') return;

    expect(loadedAlpha.state.worldSeed).toBe(111);
    expect(loadedAlpha.state.tick).toBe(60);
    expect(loadedAlpha.state.moneyCents).toBe(1_500);

    expect(loadedBeta.state.worldSeed).toBe(222);
    expect(loadedBeta.state.tick).toBe(120);
    expect(loadedBeta.state.moneyCents).toBe(8_000);

    // Different seeds are also what keeps the reports database apart: its ledger store is
    // keyed by `worldSeed` (`reports/persist.ts`), so two lots cannot share a Shift Report.
    expect(loadedAlpha.state.worldSeed).not.toBe(loadedBeta.state.worldSeed);

    // Six records, three per world — current, previous, and the milestone the first save
    // writes — and no bare `current` anywhere near them.
    expect(store.keys()).toEqual([
      currentKeyFor('alpha'),
      milestoneKeyFor('alpha'),
      previousKeyFor('alpha'),
      currentKeyFor('beta'),
      milestoneKeyFor('beta'),
      previousKeyFor('beta'),
    ]);
  });

  it('rotates each world into its OWN backup, never across', async () => {
    const store = memorySaveStore();
    const alpha = createWorld(111);
    const beta = createWorld(222);

    alpha.tick = 10;
    await saveWorld(alpha, { worldId: 'alpha', store });
    await saveWorld(beta, { worldId: 'beta', store });
    alpha.tick = 20;
    await saveWorld(alpha, { worldId: 'alpha', store });

    // Alpha's parachute must hold ALPHA at tick 10 — not beta, which is what a shared
    // `previous` key would have put there, and which would load without complaint.
    const { previous } = await store.read('alpha');
    expect(previous?.worldSeed).toBe(111);
    expect(previous?.tick).toBe(10);

    // Beta was saved once, so it has no backup at all. A cross-world rotation would have
    // invented one.
    expect((await store.read('beta')).previous).toBeUndefined();
  });

  it('reports an empty world rather than another world’s save', async () => {
    const store = memorySaveStore();
    await saveWorld(createWorld(111), { worldId: 'alpha', store });
    expect((await loadWorld({ worldId: 'beta', store })).status).toBe('empty');
  });
});

describe('the avatar on the record ([[079]])', () => {
  // The one rule under test: the avatar is ENVELOPE METADATA. It lives on the registry
  // record beside the lot's name, it round-trips with the registry, and it never comes
  // anywhere near `WorldState` — which is why these tests never open a save.

  it('a new game carries the picked avatar, and defaults to avatar 1', async () => {
    // In this environment there is no IndexedDB, so the registry write is in-memory only —
    // which is exactly the layer under test: the RECORD carries the field. (The write path
    // itself is the same `writeRegistry` every other field already rides.)
    invalidateRegistry();
    const picked = await createWorldRecord({ avatar: 4 });
    expect(picked.avatar).toBe(4);

    const defaulted = await createWorldRecord();
    expect(defaulted.avatar).toBe(1);
  });

  it('survives the patches a played world accumulates', () => {
    // `touchWorld` (every save) and `renameWorld` go through `withWorld` — a patch that
    // dropped the field would undress the farmer on the first autosave.
    const registry = registryOf(world({ id: 'a', avatar: 3 }));
    const touched = withWorld(registry, 'a', {
      summary: { tick: 99, moneyCents: 5, formatVersion: 7 },
      lastPlayedAt: NOW + 1,
    });
    expect(findWorld(touched, 'a')?.avatar).toBe(3);
  });

  it('an adopted pre-registry world has no avatar: the legacy farmer, by absence', () => {
    const plan = planLegacyAdoption(
      {
        current: envelopeAt(7, 10, 100),
        previous: undefined,
        hasConflict: false,
        legacySession: null,
      },
      { now: NOW, id: 'w1' },
    );
    expect(plan.adopted?.avatar).toBeUndefined();
  });
});

describe('changing the avatar mid-game ([[126]])', () => {
  // The pause menu's picker, pinned on the PURE half for rule 3's reason — there is no
  // IndexedDB here, so `writeRegistry` cannot round-trip and anything welded to `getDb` is a
  // decision no test can reach. `planAvatarChange` was split out precisely so this could exist,
  // exactly as `planLegacyAdoption` was.
  //
  // What fails QUIETLY if this is wrong: the farmer changes on screen (`publishAvatar` is
  // synchronous and cannot fail) and then quietly changes back on the next reload — which the
  // player experiences as the game forgetting them rather than as an error.

  it('moves the avatar on the ACTIVE world and touches nothing else', () => {
    const registry = registryOf(world({ id: 'a', avatar: 2 }), world({ id: 'b', avatar: 5 }));
    const next = planAvatarChange(registry, 4);

    expect(findWorld(next!, 'a')?.avatar).toBe(4);
    // The other lot keeps its own farmer. `activeId` is 'a' — see `registryOf`.
    expect(findWorld(next!, 'b')?.avatar).toBe(5);
    // The name, the seed and the card come through the patch untouched.
    expect(findWorld(next!, 'a')?.name).toBe('Lot #1');
    expect(findWorld(next!, 'a')?.seed).toBe(1);
  });

  it('survives the autosave that lands right after it', () => {
    // The realistic sequence, and the one that would silently undo the change: pick a farmer,
    // keep playing, and let `touchWorld` rewrite the card on the next save. Both patches go
    // through `withWorld`, so the fields must ride over each other in either order.
    const picked = planAvatarChange(registryOf(world({ id: 'a', avatar: 1 })), 4)!;
    const saved = withWorld(picked, 'a', {
      summary: { tick: 400, moneyCents: 1_234, formatVersion: 9 },
      lastPlayedAt: NOW + 5,
    });

    expect(findWorld(saved, 'a')?.avatar).toBe(4);
    expect(findWorld(saved, 'a')?.summary.tick).toBe(400);
  });

  it('hands back the SAME registry when the pick is already the live one', () => {
    // Identity is the contract `setActiveWorldAvatar` reads to skip a write, so a player
    // clicking their own farmer five times costs five comparisons and no writes at all.
    const registry = registryOf(world({ id: 'a', avatar: 3 }));
    expect(planAvatarChange(registry, 3)).toBe(registry);
  });

  it('refuses a nonsense id rather than writing it', () => {
    const registry = registryOf(world({ id: 'a', avatar: 3 }));
    expect(planAvatarChange(registry, -1)).toBeNull();
    expect(planAvatarChange(registry, 2.5)).toBeNull();
    expect(planAvatarChange(registry, Number.NaN)).toBeNull();
  });

  it('says no when there is no world to dress', async () => {
    // Empty registry: the front door, where the new-game picker does this job instead. And a
    // TOMBSTONED active world, which is the narrow one — deleting the lot you are standing on
    // moves `activeId`, but a registry caught mid-move must not have its dead world dressed.
    expect(planAvatarChange(emptyRegistry(), 3)).toBeNull();
    expect(planAvatarChange(registryOf(world({ id: 'a', deletedAt: NOW })), 3)).toBeNull();

    // And the committed half agrees, which is the one thing worth reaching the async door for:
    // with no IndexedDB there is no registry, so there is nobody to dress and it says so
    // rather than throwing on the way past `getDb`.
    invalidateRegistry();
    expect(await setActiveWorldAvatar(3)).toBe(false);
  });
});
