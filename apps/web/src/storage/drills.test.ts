// Deliberate data-destruction drills ([[138]] follow-up, wave 42).
//
// WHY THIS EXISTS ALONGSIDE `tabs.test.ts` RATHER THAN INSIDE IT. That file pins the clobber
// that was observed: a stale tab's registry write erasing a lot. This one attacks the paths
// that clobber did NOT go through, on the principle that a subsystem which has already eaten
// four of the owner's worlds does not get to be judged on the one bug somebody happened to
// catch. Every drill here is written to LOSE something, and passes only by failing to.
//
// THE PROTOCOL EVERY CONCURRENCY DRILL IN THIS FILE FOLLOWS. A test that passes before and
// after the fix proves nothing at all — it is exactly how this family of bug survives review.
// So each two-tab drill was run with the [[138]] merge reverted to `const stored = base` and
// confirmed to go red first. Where a drill is green both ways that is stated on the drill,
// because a green test with no failing mode is documentation, not evidence.
//
// THE STORE SEAM IS THE SHIPPED ONE THROUGHOUT. Nothing about the registry logic, the slot
// ladder or the rescue planner is restated here; what is modelled is the single property of
// IndexedDB the whole design rests on — readwrite transactions with overlapping scope do not
// interleave, across connections — and a fake that got that wrong would prove nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SaveEnvelope, createWorld, serialize } from '@snack/sim';

import { type SaveRecordStore, loadWorld, memorySaveStore } from './saves';
import { planOrphanRescue } from './orphans';
import { NoticeId, noticeSnapshot, resetNotices } from './notices';
import type { WorldRegistry } from './db';

// --- a stand-in for IndexedDB, with a gate --------------------------------------------------

const SAVES = 'saves';
const WORLDS = 'worlds';

function clone<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T);
}

/**
 * The same fake `tabs.test.ts` uses, plus one thing: a `gate` that can hold a named store's
 * operations open.
 *
 * THE GATE IS NOT A CHEAT AND THE DISTINCTION MATTERS. It does not invent a window; it widens
 * one that is already there. `adoptLegacyRecords` runs four database round-trips between the
 * read that finds no registry and the write that puts one, and on a real disk that is a real
 * few milliseconds. Holding it open makes a race that is otherwise a coin-flip into a fact,
 * which is the only way to assert on it.
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
  const hooks = new Map<string, () => void>();

  function transaction(names: string | string[], mode = 'readonly') {
    // The rival tab's write lands HERE: after this transaction was decided on, before it
    // opens. That is the only place a real second tab can get in, because IndexedDB will not
    // interleave two overlapping readwrite transactions once they are open.
    if (mode === 'readwrite') {
      for (const key of typeof names === 'string' ? [names] : names) {
        const hook = hooks.get(key);
        if (hook !== undefined) {
          hooks.delete(key);
          hook();
        }
      }
    }
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
    /**
     * Run `hook` once, just before the next readwrite transaction over `name` opens.
     *
     * THIS IS HOW THE RACE IS MADE DETERMINISTIC, AND WHERE IT FIRES IS THE WHOLE POINT.
     * Interleaving two real boots does not work — both tabs run the adoption migration on an
     * empty database, so any gate that catches one catches the other and the drill deadlocks
     * instead of concluding. So the second tab is modelled instead of run.
     *
     * It fires at the transaction BOUNDARY rather than inside the write, because that is the
     * only instant a real second tab could ever get in: once an overlapping readwrite
     * transaction is open, IndexedDB will not let another one interleave with it. Firing
     * inside the write would be a rigged model that no browser can produce — and would fail
     * the merge path too, which is precisely how you can tell it is rigged. That is why the
     * CONTROL below exists and why it has to pass.
     */
    onNextWrite(name: string, hook: () => void): void {
      hooks.set(name, hook);
    },
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
    transaction,
  };
}

type FakeDb = ReturnType<typeof fakeDb>;
type Tab = typeof import('./worlds');

/** A tab: its own module instance, its own read memo, the shared disk. */
async function openTab(db: FakeDb): Promise<Tab> {
  vi.resetModules();
  vi.doMock('./db', async () => {
    const real = await vi.importActual<typeof import('./db')>('./db');
    return { ...real, getDb: () => Promise.resolve(db), isStorageAvailable: () => true };
  });
  return import('./worlds');
}

let db: FakeDb;

beforeEach(() => {
  db = fakeDb();
  // No cross-tab courtesy: both tabs hold their stalest possible view, so anything that
  // survives survives because the write merged against the disk.
  vi.stubGlobal('BroadcastChannel', undefined);
  resetNotices();
});

afterEach(() => {
  vi.doUnmock('./db');
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** What the front door would draw, read fresh off the disk. */
async function listed(tab: Tab): Promise<string[]> {
  tab.invalidateRegistry();
  return (await tab.readRegistry()).worlds.map((w) => w.name).sort();
}

function registryOnDisk(): WorldRegistry {
  return db.stores.get(WORLDS)?.get('registry') as WorldRegistry;
}

// --- drill 1: every interleaving of the four writes ----------------------------------------

/**
 * The matrix `tabs.test.ts` samples from.
 *
 * It pins four interleavings individually. This runs the whole cross product — each of the
 * four registry-writing operations in tab B against each in tab A, in both orders — because
 * the bug was never about which verb was used. It was about the snapshot, and every verb
 * carries one.
 *
 * REVERT-CONFIRMED: with `const stored = base`, all 16 of these go red.
 */
describe('two tabs, every interleaving of the writes', () => {
  const verbs = ['create', 'rename', 'delete', 'autosave'] as const;
  type Verb = (typeof verbs)[number];

  async function act(tab: Tab, verb: Verb, id: string): Promise<void> {
    if (verb === 'create') await tab.createWorldRecord({ name: `made-by-${id}` });
    if (verb === 'rename') await tab.renameWorld(id, `renamed-${id}`);
    if (verb === 'delete') await tab.deleteWorld(id);
    if (verb === 'autosave')
      await tab.touchWorld(id, { tick: 99, moneyCents: 1234, formatVersion: 22 });
  }

  for (const first of verbs) {
    for (const second of verbs) {
      it(`keeps every lot when A ${first}s and then B ${second}s`, async () => {
        // Two lots exist before either tab loads, so both tabs start with a snapshot that is
        // about to go stale, and each acts on a world of its own.
        const setup = await openTab(db);
        const lotA = await setup.createWorldRecord({ name: 'lot-a' });
        const lotB = await setup.createWorldRecord({ name: 'lot-b' });

        const tabA = await openTab(db);
        const tabB = await openTab(db);
        // Both tabs prime their memo NOW — this is the staleness the bug rode in on.
        await tabA.readRegistry();
        await tabB.readRegistry();

        // A third lot appears after both snapshots were taken. It is the canary: nothing
        // either tab does may remove it, because neither tab has ever heard of it.
        const canary = await setup.createWorldRecord({ name: 'canary' });

        await act(tabA, first, lotA.id);
        await act(tabB, second, lotB.id);

        const onDisk = registryOnDisk();
        const ids = new Set(onDisk.worlds.map((w) => w.id));
        // THE ASSERTION THAT MATTERS: no record vanished. Deletes tombstone, they do not
        // remove, so the count is monotonic no matter which verbs ran.
        expect(ids.has(canary.id)).toBe(true);
        expect(ids.has(lotA.id)).toBe(true);
        expect(ids.has(lotB.id)).toBe(true);
        expect(onDisk.worlds.length).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

// --- drill 2: the adoption seed, which is not a `mutate` ------------------------------------

/**
 * THE ONE REGISTRY WRITE IN THIS DIRECTORY THAT STILL WRITES A SNAPSHOT.
 *
 * `mutateRegistry` was fixed for [[138]] by reading inside the transaction that writes. The
 * seed path — `adoptLegacyRecords`, the first-read migration — was not: it ends in a bare
 * `db.put(WORLDS_STORE, plan.registry, REGISTRY_KEY)` built from a plan computed several
 * round-trips earlier, with no read of the record it is about to overwrite.
 *
 * It only runs on a database with no registry record, so the exposure is a fresh install (or
 * a cleared origin) with two tabs booting together — narrow, but it is the same shape of
 * write that ate four worlds, and it is unguarded.
 */
describe('the first-boot adoption migration', () => {
  /** The registry another tab has just written, with a lot on it worth losing. */
  function rivalRegistry(): WorldRegistry {
    return {
      version: 1,
      activeId: 'rival',
      worlds: [
        {
          id: 'rival',
          name: 'the-only-lot',
          seed: 1,
          createdAt: 1,
          lastPlayedAt: 1,
          summary: { tick: 500, moneyCents: 123_456, formatVersion: 22 },
          deletedAt: null,
        },
      ],
    };
  }

  it('does not erase a lot another tab created while it was still deciding', async () => {
    expect(db.stores.get(WORLDS)?.get('registry')).toBeUndefined();

    const tab = await openTab(db);
    // Another tab finishes a New Game in the window between this boot's read and its write.
    db.onNextWrite(WORLDS, () => {
      db.stores.get(WORLDS)!.set('registry', rivalRegistry());
    });

    await tab.readRegistry();

    const onDisk = registryOnDisk();
    expect(onDisk.worlds.map((w) => w.name)).toContain('the-only-lot');
  });

  it('CONTROL: the ordinary mutate path survives the identical interruption', async () => {
    // Same injection, same instant, against `mutateRegistry` instead of the seed. This is the
    // comparison that makes the drill above a finding rather than a coincidence: if both
    // failed the model would be too aggressive to conclude anything from.
    await db.put(WORLDS, { version: 1, activeId: null, worlds: [] }, 'registry');
    const tab = await openTab(db);
    await tab.readRegistry();

    db.onNextWrite(WORLDS, () => {
      db.stores.get(WORLDS)!.set('registry', rivalRegistry());
    });
    await tab.createWorldRecord({ name: 'mine' });

    const names = registryOnDisk().worlds.map((w) => w.name);
    expect(names).toContain('the-only-lot');
    expect(names).toContain('mine');
  });
});

// --- drill 3: the orphan pass, run twice ----------------------------------------------------

/**
 * A rescue that runs twice must be a no-op the second time.
 *
 * The failure this guards is not theoretical either: the rescue mints a NEW card for a world
 * it does not recognise, so a planner that forgot what it had already filed would hand the
 * player "Recovered lot #1" and "Recovered lot #2" for one farm, and go on adding a row on
 * every boot forever.
 */
describe('the orphan rescue, run more than once', () => {
  it('never invents or duplicates a world, however many times it runs', async () => {
    const tab = await openTab(db);
    const kept = await tab.createWorldRecord({ name: 'on-the-list' });

    // Three worlds on disk with no card: the shape the owner's browser was actually in.
    const saves = db.stores.get(SAVES) ?? new Map<string, unknown>();
    db.stores.set(SAVES, saves);
    for (const [i, id] of ['ghost-1', 'ghost-2', 'ghost-3'].entries()) {
      saves.set(`w:${id}:current`, serialize(worldAt(100 + i)));
    }
    saves.set(`w:${kept.id}:current`, serialize(worldAt(7)));

    const first = await tab.readRegistry();
    const afterOne = first.worlds.map((w) => w.name).sort();
    expect(afterOne.filter((n) => n.startsWith('Recovered lot')).length).toBe(3);

    // Run it again, and again, on fresh module instances — a reload, then another reload.
    for (let reload = 0; reload < 3; reload++) {
      const next = await openTab(db);
      const names = await listed(next);
      expect(names).toEqual(afterOne);
      expect(new Set(names).size).toBe(names.length); // no duplicate names
      expect(registryOnDisk().worlds.length).toBe(4); // no invented rows
    }
  });

  it('files one card per lot when two tabs rescue at the same instant', async () => {
    const saves = new Map<string, unknown>();
    db.stores.set(SAVES, saves);
    saves.set('w:lonely:current', serialize(worldAt(42)));
    await db.put(WORLDS, { version: 1, activeId: null, worlds: [] }, 'registry');

    // A lot neither tab has ever seen. Without it a clobber is invisible here, because both
    // tabs would write the same one-world registry and the test would pass on a coincidence.
    const setup = await openTab(db);
    const canary = await setup.createWorldRecord({ name: 'canary' });

    const tabA = await openTab(db);
    const tabB = await openTab(db);
    // Both discover the same orphan before either has written.
    await Promise.all([tabA.readRegistry(), tabB.readRegistry()]);

    const onDisk = registryOnDisk();
    expect(onDisk.worlds.filter((w) => w.id === 'lonely').length).toBe(1);
    expect(onDisk.worlds.map((w) => w.id)).toContain(canary.id);
    expect(onDisk.worlds.length).toBe(2);
  });

  it('is a pure no-op the second time through the planner', () => {
    const registry: WorldRegistry = { version: 1, activeId: null, worlds: [] };
    const found = [{ worldId: 'x', envelope: serialize(worldAt(5)) }];
    const context = { now: 1_000, peekMoney: () => 500 };

    const once = planOrphanRescue(registry, found, context);
    expect(once.rescued.length).toBe(1);
    const twice = planOrphanRescue(once.registry, found, context);
    expect(twice.rescued.length).toBe(0);
    expect(twice.registry.worlds.length).toBe(1);
  });
});

// --- drill 4: corrupt each slot in turn ------------------------------------------------------

function worldAt(tick: number, seed = 424_242) {
  const state = createWorld(seed);
  state.tick = tick;
  return state;
}

function envelopeAt(tick: number): SaveEnvelope {
  return serialize(worldAt(tick));
}

/** Parses as an envelope; its payload cannot become a world. */
function corruptAt(tick: number): SaveEnvelope {
  return { ...envelopeAt(tick), payload: {} } as SaveEnvelope;
}

/**
 * Does the chain WALK, or give up at the first bad record?
 *
 * The distinction is the whole value of having four slots. A loader that tried `current`,
 * failed, and refused would make `previous`, `older` and `milestone` decorative — and the
 * player would be told their world was unreadable while three readable copies sat on disk.
 */
describe('the fallback chain, corrupted one slot at a time', () => {
  async function seeded(): Promise<SaveRecordStore & { keys(): string[] }> {
    const store = memorySaveStore();
    // Ticks descend with the ladder, which is the order a real world writes them in.
    await store.rotate('w', envelopeAt(100)); // -> older, eventually
    await store.rotate('w', envelopeAt(200)); // -> previous
    await store.rotate('w', envelopeAt(300)); // -> current
    await store.writeMilestone('w', envelopeAt(50));
    return store;
  }

  it('walks all four rungs, one corruption at a time, and lands on the last good one', async () => {
    const ladder: { corrupt: string[]; expect: number }[] = [
      { corrupt: [], expect: 300 },
      { corrupt: ['current'], expect: 200 },
      { corrupt: ['current', 'previous'], expect: 100 },
      { corrupt: ['current', 'previous', 'older'], expect: 50 },
    ];

    for (const rung of ladder) {
      resetNotices();
      const store = await seeded();
      const records = await store.read('w');
      const ticks: Record<string, number> = {
        current: 300,
        previous: 200,
        older: 100,
        milestone: 50,
      };
      const broken = { ...records };
      for (const slot of rung.corrupt) {
        broken[slot as keyof typeof broken] = corruptAt(ticks[slot]!);
      }
      const frozen: SaveRecordStore = { ...store, read: () => Promise.resolve(broken) };

      const outcome = await loadWorld({ worldId: 'w', store: frozen });
      expect(outcome.status, `corrupting ${rung.corrupt.join('+') || 'nothing'}`).toBe('loaded');
      if (outcome.status === 'loaded') {
        expect(outcome.state.tick, `after corrupting ${rung.corrupt.join('+')}`).toBe(rung.expect);
      }
      // A fallback is never silent, and NOTHING on disk was deleted to achieve it.
      const notices = noticeSnapshot().map((n) => n.id);
      if (rung.corrupt.length > 0) expect(notices).toContain(NoticeId.Recovered);
      else expect(notices).not.toContain(NoticeId.Recovered);
      const still = await store.read('w');
      expect([still.current, still.previous, still.older, still.milestone].every(Boolean)).toBe(
        true,
      );
    }
  });

  it('refuses rather than starting fresh when all four are broken, and keeps every byte', async () => {
    const store = await seeded();
    const frozen: SaveRecordStore = {
      ...store,
      read: () =>
        Promise.resolve({
          current: corruptAt(300),
          previous: corruptAt(200),
          older: corruptAt(100),
          milestone: corruptAt(50),
        }),
    };

    const outcome = await loadWorld({ worldId: 'w', store: frozen });
    expect(outcome.status).toBe('refused');
    if (outcome.status === 'refused') {
      expect(outcome.reason).toBe('unreadable');
      // Never offer to wipe. §8's cut-forever list has no "start fresh" button on it.
      // It must never OFFER to wipe. ("deleted" appears in the reassurance and is fine.)
      expect(outcome.message).not.toMatch(/start fresh|wipe|reset|erase/i);
      expect(outcome.message).toMatch(/nothing has been deleted/i);
    }
    // The originals are still exactly where they were found.
    const still = await store.read('w');
    expect([still.current, still.previous, still.older, still.milestone].every(Boolean)).toBe(true);
  });
});

// --- drill 5: the orphan finder against a half-broken world ---------------------------------

describe('the orphan finder', () => {
  it('rescues off whichever slot still reads, and skips a world where none do', async () => {
    const saves = new Map<string, unknown>();
    db.stores.set(SAVES, saves);
    // A world whose newest slot is rubbish but whose milestone is fine.
    saves.set('w:half:current', { not: 'an envelope' });
    saves.set('w:half:milestone', serialize(worldAt(88)));
    // A world where nothing at all reads: it must NOT get a card that opens onto a refusal.
    saves.set('w:hopeless:current', { also: 'not one' });
    saves.set('w:hopeless:previous', null);

    await openTab(db);
    // Imported AFTER the mock is installed: a static import at the top of this file binds the
    // REAL `./db`, and the drill would then fail on "IndexedDB is not available" rather than
    // on anything it means to test.
    const { findOrphanedWorlds } = await import('./orphans');
    const found = await findOrphanedWorlds(new Set<string>());
    const ids = found.map((f) => f.worldId).sort();
    expect(ids).toEqual(['half']);
    expect(found[0]!.envelope.tick).toBe(88);
  });
});
