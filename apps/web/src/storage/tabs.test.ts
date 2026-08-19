// Two tabs, one browser, and nothing lost ([[138]]).
//
// WHAT THIS FILE IS FOR. The bug it pins was observed, not theorised: an agent verifying
// another item watched a lot it had just created disappear from the front door, clobbered by a
// second tab's page-old copy of the registry. The registry is written as ONE record holding
// the whole list, so the loser of that race does not lose a field — it loses every world the
// other tab has created since its page loaded. The cost is a card, not a farm (the envelopes
// live in a different object store and the clobbering write cannot reach them), but a farm
// with no card is unreachable forever, because nothing in this directory ever enumerates the
// save store looking for one.
//
// THE TEST LOADS THE REAL `worlds.ts` TWICE. `vi.resetModules()` plus a dynamic import gives
// each "tab" its own module instance and therefore its own genuine read memo — the exact
// condition that caused the bug — over one shared stand-in for IndexedDB. Nothing about the
// registry logic is modelled or restated here; the plans, the merge and the store are the
// shipped ones. What IS modelled, carefully, is the one property of IndexedDB the fix leans
// on: readwrite transactions with overlapping scope never interleave, across connections.
//
// THE BROADCAST IS DELIBERATELY SWITCHED OFF for these tests, and that is the point rather
// than a convenience. `worlds.ts` also drops its memo when another tab writes, which would
// hide the staleness and let this file pass against the broken code. With no channel, both
// tabs hold their stalest possible view — so anything that survives here survives because the
// write merged against the disk, which is the guarantee actually being claimed.
//
// PROVED TO BITE, MEASURED RATHER THAN ASSUMED. With one line of `idbRegistryStore.mutate`
// reverted to the pre-fix behaviour — `const stored = base`, i.e. write the caller's snapshot
// instead of merging against the record — five of these tests go red: the world-eater, the
// rename, the resurrection, the two simultaneous New Games, and the sweep. Every one of them
// reports a world that is no longer on the list.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireWorldLease, heldWorldId, leaseRefusalMessage, releaseWorldLease } from './lease';
import {
  nextRescuedName,
  parseSaveKey,
  peekEnvelope,
  planOrphanRescue,
  worldIdsWithSaves,
} from './orphans';
import type { WorldRegistry } from './db';

// --- a stand-in for IndexedDB -------------------------------------------------------------

const SAVES = 'saves';
const WORLDS = 'worlds';

function clone<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T);
}

/**
 * The one property that matters: a readwrite transaction has its scope to itself.
 *
 * Every transaction created while another readwrite transaction is open waits for that one to
 * finish before any of its reads or writes happen. That is what makes a read-modify-write
 * inside a single transaction atomic in a real browser, and it is the entire basis of the fix
 * — so a fake that let transactions interleave would prove nothing at all.
 */
function fakeDb() {
  const stores = new Map<string, Map<string, unknown>>();
  const store = (name: string): Map<string, unknown> => {
    let found = stores.get(name);
    if (found === undefined) {
      found = new Map<string, unknown>();
      stores.set(name, found);
    }
    return found;
  };

  let chain: Promise<unknown> = Promise.resolve();

  function transaction(names: string | string[], mode = 'readonly') {
    const ready = chain;
    let release!: () => void;
    if (mode === 'readwrite') {
      const mine = new Promise<void>((resolve) => (release = resolve));
      chain = ready.then(() => mine);
    } else {
      release = () => undefined;
    }
    void names;

    const objectStore = (name: string) => ({
      async get(key: string) {
        await ready;
        return clone(store(name).get(key));
      },
      async put(value: unknown, key: string) {
        await ready;
        store(name).set(key, clone(value));
      },
      async add(value: unknown, key: string) {
        await ready;
        if (store(name).has(key)) throw new Error(`ConstraintError: ${key}`);
        store(name).set(key, clone(value));
      },
      async delete(key: string) {
        await ready;
        store(name).delete(key);
      },
    });

    return {
      objectStore,
      done: (async () => {
        await ready;
        release();
      })(),
    };
  }

  return {
    stores,
    async get(name: string, key: string) {
      const tx = transaction(name);
      const value = await tx.objectStore(name).get(key);
      await tx.done;
      return value;
    },
    async put(name: string, value: unknown, key: string) {
      const tx = transaction(name, 'readwrite');
      await tx.objectStore(name).put(value, key);
      await tx.done;
    },
    async getAllKeys(name: string) {
      const tx = transaction(name);
      await tx.done;
      return [...store(name).keys()];
    },
    async clear(name: string) {
      const tx = transaction(name, 'readwrite');
      await tx.done;
      store(name).clear();
    },
    transaction,
  };
}

type FakeDb = ReturnType<typeof fakeDb>;
type Tab = typeof import('./worlds');

/** A tab: its own module instance, its own memo, the shared disk. */
async function openTab(db: FakeDb): Promise<Tab> {
  vi.resetModules();
  vi.doMock('./db', async () => {
    const real = await vi.importActual<typeof import('./db')>('./db');
    return { ...real, getDb: () => Promise.resolve(db), isStorageAvailable: () => true };
  });
  return import('./worlds');
}

/**
 * The notice board THIS tab publishes to.
 *
 * `vi.resetModules()` gives each tab its own `notices.ts` as well as its own `worlds.ts` —
 * which is right (a real tab has its own of both) and is a trap: the copy imported at the top
 * of this file belongs to no tab at all, so a test that watched it would watch an empty board
 * forever and pass without ever checking anything.
 */
async function noticesOf(): Promise<typeof import('./notices')> {
  return import('./notices');
}

let db: FakeDb;

beforeEach(() => {
  db = fakeDb();
  // See the header: no cross-tab courtesy, so only the merge can save a record.
  vi.stubGlobal('BroadcastChannel', undefined);
});

afterEach(() => {
  vi.doUnmock('./db');
  vi.unstubAllGlobals();
  vi.resetModules();
  releaseWorldLease();
});

async function listedNames(tab: Tab): Promise<string[]> {
  tab.invalidateRegistry();
  return (await tab.readRegistry()).worlds.map((world) => world.name).sort();
}

// --- the world-eater ----------------------------------------------------------------------

describe('two tabs on one browser', () => {
  it('the world-eater: a stale tab’s autosave does not erase a lot the other tab just made', async () => {
    const tabA = await openTab(db);
    const tabB = await openTab(db);

    const first = await tabA.createWorldRecord({ name: 'Lot #1' });

    // Tab B loads the front door and reads the list. Its memo is now a photograph, and in a
    // real browser it stays one for as long as the tab is open — which is hours.
    expect((await tabB.readRegistry()).worlds).toHaveLength(1);

    // Tab A makes a second lot. Tab B has never heard of it and never will.
    const second = await tabA.createWorldRecord({ name: 'Lot #2' });

    // Tab B does the most ordinary thing a playing tab does: it autosaves, which touches the
    // card of the world IT is on. Once a minute, forever. This is the write that used to eat
    // Lot #2 whole — not its name, the record.
    await tabB.touchWorld(first.id, { tick: 1_200, moneyCents: 5_000, formatVersion: 21 });

    expect(await listedNames(tabA)).toEqual(['Lot #1', 'Lot #2']);
    const survivors = (await tabA.readRegistry()).worlds.map((world) => world.id);
    expect(survivors).toContain(second.id);
  });

  it('a stale tab renaming its own lot leaves the other tab’s lot alone', async () => {
    const tabA = await openTab(db);
    const tabB = await openTab(db);

    const first = await tabA.createWorldRecord({ name: 'Lot #1' });
    await tabB.readRegistry();
    await tabA.createWorldRecord({ name: 'Lot #2' });

    await tabB.renameWorld(first.id, 'The Farm');

    expect(await listedNames(tabA)).toEqual(['Lot #2', 'The Farm']);
  });

  it('runs backwards too: a stale tab does not resurrect a world the player deleted', async () => {
    const tabA = await openTab(db);
    const tabB = await openTab(db);

    const doomed = await tabA.createWorldRecord({ name: 'Lot #1' });
    const keeper = await tabA.createWorldRecord({ name: 'Lot #2' });
    await tabB.readRegistry();

    await tabA.deleteWorld(doomed.id);
    // Tab B still believes Lot #1 is alive, and says so by writing.
    await tabB.touchWorld(keeper.id, { tick: 2_400, moneyCents: 100, formatVersion: 21 });

    tabA.invalidateRegistry();
    const after = await tabA.readRegistry();
    expect(after.worlds.find((world) => world.id === doomed.id)?.deletedAt).not.toBeNull();
  });

  it('two tabs pressing New Game at once keep both lots, and both names', async () => {
    const tabA = await openTab(db);
    const tabB = await openTab(db);
    await Promise.all([tabA.readRegistry(), tabB.readRegistry()]);

    const [a, b] = await Promise.all([tabA.createWorldRecord(), tabB.createWorldRecord()]);

    const names = await listedNames(tabA);
    expect(names).toHaveLength(2);
    // Interleaved or not, the second one to land sees the first and takes the next number —
    // the name is computed inside the transaction, against the list as it actually stands.
    expect(new Set(names).size).toBe(2);
    expect(a.id).not.toBe(b.id);
  });

  it('the memo really is stale — the hazard is still present, and survived anyway', async () => {
    const tabA = await openTab(db);
    const tabB = await openTab(db);

    await tabA.createWorldRecord({ name: 'Lot #1' });
    expect((await tabB.readRegistry()).worlds).toHaveLength(1);
    await tabA.createWorldRecord({ name: 'Lot #2' });

    // Tab B's own view is one lot behind. It is SUPPOSED to be: that is the read cache doing
    // its job, and proving it here is what stops this file quietly testing nothing later on.
    expect((await tabB.readRegistry()).worlds).toHaveLength(1);
    // And the disk is not.
    expect((await db.get(WORLDS, 'registry')) as WorldRegistry).toHaveProperty('worlds.1');
  });

  it('a stale tab cannot sweep a world the other tab restored', async () => {
    const tabA = await openTab(db);
    const tabB = await openTab(db);

    const world = await tabA.createWorldRecord({ name: 'Lot #1' });
    await db.put(
      SAVES,
      { worldSeed: 7, tick: 900, formatVersion: 21, payload: {} },
      `w:${world.id}:current`,
    );
    await tabA.deleteWorld(world.id);

    // Tab B reads the list while the tombstone is fresh, then time passes and tab A restores.
    await tabB.readRegistry();
    await tabA.restoreDeletedWorld(world.id);

    // Tab B now runs a boot sweep believing the tombstone is a fortnight old.
    const collected = await tabB.sweepTombstones(Date.now() + tabB.WORLD_TOMBSTONE_MS + 1);

    expect(collected).toBe(0);
    expect(await db.get(SAVES, `w:${world.id}:current`)).toBeDefined();
    tabA.invalidateRegistry();
    expect((await tabA.readRegistry()).worlds).toHaveLength(1);
  });
});

// --- a write that cannot be honoured is never silent ---------------------------------------

describe('a registry write that fails', () => {
  it('reaches the player as a card instead of a console line', async () => {
    const broken = fakeDb();
    broken.transaction = () => {
      throw new Error('QuotaExceededError');
    };
    const tab = await openTab(broken as unknown as FakeDb);

    await tab.createWorldRecord({ name: 'Lot #1' });

    const notices = await noticesOf();
    const notice = notices
      .noticeSnapshot()
      .find((entry) => entry.id === notices.NoticeId.RegistryWriteFailed);
    expect(notice).toBeDefined();
    expect(notice?.body).toContain('start a new lot');
    // Rule 1 of `notices.ts`: no jargon. The player is not told about a QuotaExceededError.
    expect(`${notice?.title ?? ''} ${notice?.body ?? ''}`).not.toMatch(
      /IndexedDB|QuotaExceeded|registry|transaction/i,
    );
  });
});

// --- one tab per lot -----------------------------------------------------------------------

function fakeLockManager() {
  const held = new Set<string>();
  return {
    held,
    request: async (name: string, _options: unknown, callback: (lock: unknown) => unknown) => {
      // **THE BROWSER NEVER GRANTS A LOCK SYNCHRONOUSLY, AND THIS DOUBLE USED TO.** That one
      // difference is why the StrictMode race below shipped invisible: with the callback run
      // inside the same turn as the request, `holder` was assigned before `acquireWorldLease`
      // even returned, so no second caller could ever observe the window where it is null. The
      // fake was strictly better behaved than the real API, which is the most expensive kind of
      // test double there is. One microtask restores the gap the real thing has.
      await Promise.resolve();
      if (held.has(name)) {
        await callback(null);
        return;
      }
      held.add(name);
      const kept = callback({ name, mode: 'exclusive' });
      void Promise.resolve(kept).then(
        () => held.delete(name),
        () => held.delete(name),
      );
    },
  };
}

describe('the world lease', () => {
  afterEach(() => {
    releaseWorldLease();
  });

  it('lets the first tab in and turns the second one away', async () => {
    const locks = fakeLockManager();
    vi.stubGlobal('navigator', { locks });

    const first = await acquireWorldLease('lot-a');
    expect(first).toEqual({ worldId: 'lot-a', held: true, enforced: true });

    // A second tab is a second page and therefore a second holder set; the shared manager is
    // what stands in for the browser here.
    //
    // THE ORDER MATTERS AND IT IS THE HONEST ORDER: this page lets go, the release actually
    // lands, and only then does the other tab take the lot. Written the other way round — claim
    // first, release second — the release's own cleanup deletes the lock the "other tab" just
    // took, and the test passes or fails on how many microtasks deep the fake happens to be.
    releaseWorldLease();
    await Promise.resolve();
    locks.held.add('snack-mogul:world:lot-a');
    const second = await acquireWorldLease('lot-a');
    expect(second.held).toBe(false);
    expect(second.enforced).toBe(true);
  });

  it('says yes twice to the same page, because StrictMode asks twice', async () => {
    vi.stubGlobal('navigator', { locks: fakeLockManager() });

    const first = await acquireWorldLease('lot-a');
    const again = await acquireWorldLease('lot-a');

    expect(first.held).toBe(true);
    expect(again.held).toBe(true);
    expect(heldWorldId()).toBe('lot-a');
  });

  it('**SAYS YES TWICE WHEN STRICTMODE ASKS TWICE AT ONCE**, which is how it actually asks', async () => {
    // **THE BUG THE TEST ABOVE CANNOT SEE.** That one awaits the first answer before asking
    // again, and the re-entrancy guard reads `holder` — which is assigned inside the lock
    // callback and is therefore still null for the whole window between asking and being
    // answered. StrictMode does not wait: it fires both boot effects back to back. Both read
    // `holder === null`, both ask, the first takes the lock, and the second is handed `null`
    // BY ITS OWN TAB.
    //
    // What the player saw: a brand-new lot, one tab, no other window, and the boot refusal
    // panel saying the lot was already open somewhere else. Every time, unskippably — which
    // makes the game unbootable in dev, where `reactStrictMode` is on.
    vi.stubGlobal('navigator', { locks: fakeLockManager() });

    // NOT awaited in sequence. That is the entire point of this test.
    const [first, again] = await Promise.all([
      acquireWorldLease('lot-a'),
      acquireWorldLease('lot-a'),
    ]);

    expect(first.held, 'the first ask takes the lock').toBe(true);
    expect(again.held, 'and the second one joins it rather than being turned away').toBe(true);
    expect(heldWorldId()).toBe('lot-a');
  });

  it('still turns away a genuinely second TAB asking at the same time', async () => {
    // The other side of the fix: joining an in-flight claim must be keyed on this PAGE's own
    // ask, not on the lot. A second tab has its own module state and its own `claiming`, so it
    // gets the real answer — otherwise the fix would delete the feature it is repairing.
    const locks = fakeLockManager();
    vi.stubGlobal('navigator', { locks });

    // Somebody else already holds it, exactly as a live second tab would.
    locks.held.add('snack-mogul:world:lot-a');

    const [a, b] = await Promise.all([acquireWorldLease('lot-a'), acquireWorldLease('lot-a')]);
    expect(a.held).toBe(false);
    expect(b.held).toBe(false);
    expect(heldWorldId()).toBeNull();
  });

  it('gives the old lot back when the page moves to a new one', async () => {
    const locks = fakeLockManager();
    vi.stubGlobal('navigator', { locks });

    await acquireWorldLease('lot-a');
    await acquireWorldLease('lot-b');
    await Promise.resolve();

    expect(heldWorldId()).toBe('lot-b');
    expect(locks.held.has('snack-mogul:world:lot-a')).toBe(false);
  });

  it('fails OPEN on a browser with no Web Locks, and admits it is unenforced', async () => {
    vi.stubGlobal('navigator', {});

    const lease = await acquireWorldLease('lot-a');

    // Refusing to boot here would turn a bug that needs two tabs into a bug that needs one.
    expect(lease.held).toBe(true);
    expect(lease.enforced).toBe(false);
  });

  it('names the lot in the refusal, and does not mention a lock', () => {
    const message = leaseRefusalMessage('Sunny Acres');
    expect(message).toContain('Sunny Acres');
    expect(message).toMatch(/tab/i);
    expect(message).not.toMatch(/lock|lease|IndexedDB|registry/i);
  });
});

// --- putting back what was already lost ----------------------------------------------------

function record(patch: Partial<WorldRegistry['worlds'][number]> = {}) {
  return {
    id: 'known',
    name: 'Lot #1',
    seed: 1,
    createdAt: 1_000,
    lastPlayedAt: 5_000,
    summary: { tick: 0, moneyCents: null, formatVersion: 21 },
    deletedAt: null,
    ...patch,
  };
}

function envelope(seed: number, tick: number, money: number) {
  return {
    formatVersion: 21,
    simVersion: '0.5.0',
    worldSeed: seed,
    tick,
    payload: { moneyCents: money },
  };
}

const peekMoney = (payload: unknown): number | null => {
  const money = (payload as Record<string, unknown> | null)?.['moneyCents'];
  return typeof money === 'number' ? money : null;
};

describe('lots whose card went missing', () => {
  it('finds world ids from save keys, and ignores everything that is not one', () => {
    expect(
      worldIdsWithSaves([
        'w:aaa:current',
        'w:aaa:previous',
        'w:bbb:milestone',
        // A lone cloud parking slot is another device's world, not a lot on this machine.
        'w:ccc:conflict',
        'current',
        'registry',
        'w::current',
        'nonsense',
      ]),
    ).toEqual(['aaa', 'bbb']);
  });

  it('refuses to build a card out of something that is not an envelope', () => {
    expect(peekEnvelope(null)).toBeNull();
    expect(peekEnvelope('a string')).toBeNull();
    expect(peekEnvelope({ worldSeed: 1, tick: 2 })).toBeNull();
    expect(peekEnvelope({ worldSeed: 'x', tick: 2, formatVersion: 3 })).toBeNull();
    expect(peekEnvelope(envelope(4, 5, 6))).not.toBeNull();
  });

  it('puts an orphan back with its seed, its tick and its money', () => {
    const before: WorldRegistry = { version: 1, activeId: 'known', worlds: [record()] };
    const { registry, rescued } = planOrphanRescue(
      before,
      [{ worldId: 'lost', envelope: envelope(4_242, 9_000, 40_001_100) as never }],
      { now: 9_000_000, peekMoney },
    );

    expect(rescued).toHaveLength(1);
    expect(rescued[0]).toMatchObject({
      id: 'lost',
      name: 'Recovered lot #1',
      seed: 4_242,
      summary: { tick: 9_000, moneyCents: 40_001_100, formatVersion: 21 },
      deletedAt: null,
    });
    expect(registry.worlds).toHaveLength(2);
  });

  it('sorts a rescued lot LAST, so Continue never opens a stranger’s farm', () => {
    const before: WorldRegistry = { version: 1, activeId: 'known', worlds: [record()] };
    const { rescued } = planOrphanRescue(
      before,
      [{ worldId: 'lost', envelope: envelope(1, 1, 1) as never }],
      { now: 9_000_000, peekMoney },
    );

    // `now` would have made it the newest world in the list and therefore the one the biggest
    // button on the front door opens. There is no record of when it was played; last is the
    // honest guess and it is also the harmless one.
    expect(rescued[0]!.lastPlayedAt).toBeLessThan(record().lastPlayedAt);
  });

  it('leaves alone a world the registry already knows, tombstoned or not', () => {
    const before: WorldRegistry = {
      version: 1,
      activeId: null,
      worlds: [record({ id: 'live' }), record({ id: 'binned', name: 'Lot #2', deletedAt: 8_000 })],
    };
    const { registry, rescued } = planOrphanRescue(
      before,
      [
        { worldId: 'live', envelope: envelope(1, 1, 1) as never },
        // A tombstoned world's envelopes are MEANT to outlive its card for a fortnight. Filing
        // it as a rescue would undo a delete the player asked for.
        { worldId: 'binned', envelope: envelope(2, 2, 2) as never },
      ],
      { now: 9_000_000, peekMoney },
    );

    expect(rescued).toEqual([]);
    expect(registry).toBe(before);
  });

  it('gives each rescued lot a name of its own', () => {
    const before: WorldRegistry = { version: 1, activeId: null, worlds: [] };
    const { rescued } = planOrphanRescue(
      before,
      [
        { worldId: 'a', envelope: envelope(1, 1, 1) as never },
        { worldId: 'b', envelope: envelope(2, 2, 2) as never },
      ],
      { now: 9_000_000, peekMoney },
    );

    expect(rescued.map((world) => world.name)).toEqual(['Recovered lot #1', 'Recovered lot #2']);
    expect(nextRescuedName({ version: 1, activeId: null, worlds: rescued })).toBe(
      'Recovered lot #3',
    );
  });

  it('parses a save key, and only a save key', () => {
    expect(parseSaveKey('w:abc:current')).toEqual({ worldId: 'abc', slot: 'current' });
    expect(parseSaveKey('registry')).toBeNull();
    expect(parseSaveKey('w:abc')).toBeNull();
  });

  it('puts a real orphan back on the list, end to end, and says so out loud', async () => {
    const tab = await openTab(db);
    await db.put(WORLDS, { version: 1, activeId: null, worlds: [] }, 'registry');
    await db.put(SAVES, envelope(777, 4_500, 25_000), 'w:ghost:current');
    await db.put(SAVES, envelope(777, 3_300, 20_000), 'w:ghost:previous');

    const registry = await tab.readRegistry();

    expect(registry.worlds).toHaveLength(1);
    expect(registry.worlds[0]).toMatchObject({
      id: 'ghost',
      name: 'Recovered lot #1',
      seed: 777,
      // The NEWEST readable slot, by the envelope's own tick.
      summary: { tick: 4_500 },
    });
    // The envelopes are untouched: a rescue that wrote to the thing it was rescuing would be a
    // poor sort of rescue.
    expect(await db.get(SAVES, 'w:ghost:current')).toMatchObject({ tick: 4_500 });
    const notices = await noticesOf();
    expect(
      notices.noticeSnapshot().some((entry) => entry.id === notices.NoticeId.WorldsRescued),
    ).toBe(true);
  });

  it('writes nothing at all when every lot already has its card', async () => {
    const tab = await openTab(db);
    const world = await tab.createWorldRecord({ name: 'Lot #1' });
    await db.put(SAVES, envelope(1, 10, 10), `w:${world.id}:current`);

    tab.invalidateRegistry();
    const before = await db.get(WORLDS, 'registry');
    const after = await tab.readRegistry();

    expect(after.worlds).toHaveLength(1);
    expect(await db.get(WORLDS, 'registry')).toEqual(before);
    const notices = await noticesOf();
    expect(
      notices.noticeSnapshot().some((entry) => entry.id === notices.NoticeId.WorldsRescued),
    ).toBe(false);
  });
});
