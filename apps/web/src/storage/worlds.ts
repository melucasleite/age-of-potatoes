// The world registry: which lots exist, what is on their cards, and which one is live.
//
// WHY THIS FILE EXISTS. Everything under this directory was built on one assumption — that
// there is exactly one world, so `saves` can hold two records under fixed keys and be done.
// Work item 055 supersedes that. The locked decision it appeared to contradict ("one
// persistent world per player, no resets") was about the ONLINE design: no seasons, no
// leaderboard cohorts, no forced wipes. It was never about local save slots, and a player who
// wants a second lot may have one.
//
// THREE RULES GOVERN THIS FILE, and they are the same three the rest of the directory runs on:
//
//   1. THE EXISTING WORLD IS ADOPTED, NEVER LOST AND NEVER RENAMED BEHIND THE PLAYER'S BACK.
//      A database that predates the registry holds a world under `current`. The first read of
//      the registry finds it, gives it an id and the name "Lot #1", and re-keys its two records
//      inside ONE transaction. If that transaction aborts, nothing moved. There is no state in
//      which the records are half-renamed and no state in which they are gone.
//
//   2. DELETING IS A TOMBSTONE, NOT AN ERASE. `deletedAt` is a timestamp on the record; the
//      envelopes stay exactly where they are. They are dropped only by a sweep on a later boot,
//      once the tombstone is older than `WORLD_TOMBSTONE_MS`. Until then the world can be
//      restored in full, which is what makes a two-step confirm honest rather than theatre.
//
//   3. THE PURE PART IS SEPARATED FROM THE DATABASE PART ON PURPOSE. `planLegacyAdoption`,
//      `withWorld`, `nextWorldName` and friends take plain values and return plain values, so
//      the one operation in this codebase that can silently lose a returning player's factory
//      is covered by a test that needs no browser at all. See `worlds.test.ts`.
//
// WHAT IS DELIBERATELY NOT HERE. There is no hot-swap. Switching worlds is a navigation that
// tears the page down and builds it again, because `GameHost`, the HUD store and the reports
// store all hold ownership tokens whose whole purpose is to make a half-replaced world
// impossible — and the honest way to satisfy all three is to not have two worlds in one page.

import type { SaveEnvelope } from '@snack/sim';

import {
  CURRENT_KEY,
  META_STORE,
  PREVIOUS_KEY,
  SAVES_STORE,
  WORLDS_STORE,
  type PlaySession,
  type WorldRecord,
  type WorldRegistry,
  type WorldSummary,
  getDb,
  isStorageAvailable,
} from './db';
import { logInfo, logWarn } from './log';
// The player-facing channel ([[041]]). `notices.ts` imports nothing at all, so this arrow
// points one way like the one below it.
import { NoticeId, publishNotice } from './notices';
// The orphan rescue ([[138]]). It imports nothing from here — the clock and the money peek it
// needs arrive as arguments — so this arrow points one way like the two around it.
import { announceRescue, findOrphanedWorlds, planOrphanRescue } from './orphans';
// `trace.ts` imports nothing from here, so this arrow points one way and stays that way.
import { clearTraceForWorld } from './trace';

/** The registry's one record. */
export const REGISTRY_KEY = 'registry';

/** The registry shape's own version. Not the save format, and not `DB_VERSION`. */
export const REGISTRY_VERSION = 1;

/**
 * How long a deleted world is kept before its envelopes are actually dropped.
 *
 * FOURTEEN DAYS, and the number is chosen against the failure it exists for: somebody deletes
 * the wrong card, closes the tab, and realises on the drive home. Two weeks covers a holiday
 * and a forgotten laptop; it does not pretend to be an archive. The sweep runs on boot rather
 * than on a timer, so a browser that is never opened again never deletes anything at all —
 * which is the correct behaviour for a retention window whose purpose is second thoughts.
 */
export const WORLD_TOMBSTONE_MS = 14 * 24 * 60 * 60 * 1_000;

/** The pre-registry cloud parking key, kept only so the adoption migration can move it. */
export const LEGACY_CONFLICT_KEY = 'conflict';

// --- keys ------------------------------------------------------------------------------

// `w:<id>:<slot>`, and the shape is chosen so a human staring at DevTools can read it. The
// prefix means a stray legacy key can never collide with a world's, which is what lets the
// adoption migration be idempotent by construction: it only ever looks at the three bare names.

export function currentKeyFor(worldId: string): string {
  return `w:${worldId}:current`;
}

export function previousKeyFor(worldId: string): string {
  return `w:${worldId}:previous`;
}

/**
 * The third rolling slot: what `previous` was one autosave ago.
 *
 * Work item 041's instruction 2 asks for "several rolling autosave slots", and three is the
 * depth where the returns stop: `current` for the ordinary load, `previous` for the torn
 * write, `older` for the write that tore twice. Each envelope carries the tick it was written
 * at, because the envelope always has — `SaveEnvelope.tick` is the stamp.
 */
export function olderKeyFor(worldId: string): string {
  return `w:${worldId}:older`;
}

/**
 * The long-interval milestone slot.
 *
 * Rewritten at most every `MILESTONE_INTERVAL_TICKS` (ten minutes of active play), so when the
 * rolling slots are all within a minute of each other — and therefore all within a minute of
 * the same disaster — this one still holds a world from a usefully different moment.
 */
export function milestoneKeyFor(worldId: string): string {
  return `w:${worldId}:milestone`;
}

export function conflictKeyFor(worldId: string): string {
  return `w:${worldId}:conflict`;
}

/**
 * The per-world last-played key in `meta`.
 *
 * It lives HERE, next to the save keys, rather than in `session.ts` — for the plain reason that
 * `session.ts` needs the active world id from this module, and two modules importing each other
 * is a cycle waiting to bite a bundler. Keys point one way; the clock imports them.
 */
export function sessionKeyFor(worldId: string): string {
  return `last-played:${worldId}`;
}

/** The single pre-registry last-played record, kept so the adoption migration can move it. */
export const LEGACY_SESSION_KEY = 'last-played';

// --- the pure core ----------------------------------------------------------------------

export function emptyRegistry(): WorldRegistry {
  return { version: REGISTRY_VERSION, activeId: null, worlds: [] };
}

export function findWorld(registry: WorldRegistry, id: string | null): WorldRecord | null {
  if (id === null) return null;
  return registry.worlds.find((world) => world.id === id) ?? null;
}

/** Every world the player still has, most recently played first. */
export function liveWorlds(registry: WorldRegistry): WorldRecord[] {
  return registry.worlds
    .filter((world) => world.deletedAt === null)
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}

/** Deleted worlds still inside the retention window, most recently deleted first. */
export function deletedWorlds(registry: WorldRegistry): WorldRecord[] {
  return registry.worlds
    .filter((world) => world.deletedAt !== null)
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
}

/**
 * What Continue loads: the world played most recently.
 *
 * Not "the active one". A player who last did anything on Lot #2 should land on Lot #2, and
 * the active id is a boot detail that a failed navigation or a shared link can leave pointing
 * anywhere. Most-recently-played is a fact about the player rather than about the page.
 */
export function newestWorld(registry: WorldRegistry): WorldRecord | null {
  return liveWorlds(registry)[0] ?? null;
}

/**
 * "Lot #3" — the lowest number not currently taken by a live world.
 *
 * Counting live worlds would hand out a name that is already on screen the moment somebody
 * deletes Lot #1 and makes another. Tombstoned worlds deliberately do NOT reserve their names:
 * a restored "Lot #2" sitting beside a new "Lot #2" is a smaller confusion than a player who
 * deletes four worlds and finds the game offering them Lot #7.
 */
export function nextWorldName(registry: WorldRegistry): string {
  const taken = new Set(liveWorlds(registry).map((world) => world.name));
  for (let n = 1; ; n++) {
    const candidate = `Lot #${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A registry with one world replaced. Pure — the input is never mutated. */
export function withWorld(
  registry: WorldRegistry,
  id: string,
  patch: Partial<Omit<WorldRecord, 'id'>>,
): WorldRegistry {
  return {
    ...registry,
    worlds: registry.worlds.map((world) => (world.id === id ? { ...world, ...patch } : world)),
  };
}

/** Tombstones old enough to actually collect. */
export function expiredTombstones(registry: WorldRegistry, now: number): WorldRecord[] {
  return registry.worlds.filter(
    // `now - deletedAt` rather than `deletedAt < cutoff` so a clock that jumped backwards —
    // a corrected machine time, a device an hour ahead — produces a negative age and keeps the
    // world, rather than reading as fourteen days of patience nobody actually waited.
    (world) => world.deletedAt !== null && now - world.deletedAt >= WORLD_TOMBSTONE_MS,
  );
}

/**
 * A summary from a live world's own numbers. The one authoritative path.
 *
 * `moneyCents` comes off `WorldState`, never out of an envelope's payload — see `WorldSummary`
 * in `db.ts` for why reaching into an opaque payload is a guess this directory does not make.
 */
export function summaryOf(state: {
  tick: number;
  moneyCents: number;
}): Omit<WorldSummary, 'formatVersion'> {
  return { tick: state.tick, moneyCents: state.moneyCents };
}

/**
 * A best-effort peek at an unmigrated payload, for the ONE case that has no live world: the
 * card for a pre-registry save the player has not opened yet.
 *
 * Guarded to the point of paranoia and used for nothing but a number on a card. If it comes
 * back null the card says so; it never guesses, never migrates, and never influences a load.
 */
export function peekMoneyCents(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const money = (payload as Record<string, unknown>)['moneyCents'];
  return typeof money === 'number' && Number.isInteger(money) ? money : null;
}

/**
 * Change which farmer walks the ACTIVE lot ([[126]]) — the pause menu's avatar picker, as a
 * pure registry-to-registry function.
 *
 * IT IS PURE FOR RULE 3'S REASON, stated in this file's header: the pure part is separated
 * from the database part on purpose, because there is no IndexedDB in this workspace's test
 * environment and anything welded to `getDb` is a decision no test can reach. `planLegacyAdoption`
 * above is the precedent. What is worth pinning here is small but genuinely silent when wrong:
 * a patch that dropped a sibling field would undress the farmer, and a validation hole would
 * write a half-integer avatar id that `avatarWalkFrame` then refuses forever.
 *
 * THE SAME FIELD THE FRONT DOOR SETS, PATCHED THE SAME WAY. `createWorldRecord` puts the avatar
 * on the record at new-game time; this puts a different one there mid-game, through `withWorld`
 * like every other patch in this file. The avatar is cosmetic envelope metadata and lives on the
 * registry record, never in `WorldState` (see `WorldRecord.avatar` in `db.ts`), so a change here
 * touches no save payload at all.
 *
 * Returns the registry to write, the SAME registry when the pick is already the live one (so the
 * caller can skip a pointless write), or null when there is nobody to dress — a fresh page with
 * no active world, or an id that is not a whole non-negative number.
 */
export function planAvatarChange(registry: WorldRegistry, avatar: number): WorldRegistry | null {
  if (!Number.isInteger(avatar) || avatar < 0) return null;
  const world = findWorld(registry, registry.activeId);
  if (world === null || world.deletedAt !== null) return null;
  if (world.avatar === avatar) return registry;
  return withWorld(registry, world.id, { avatar });
}

export interface LegacyDisk {
  /** The bare `current` envelope, if a pre-registry database left one. */
  current: SaveEnvelope | undefined;
  /** The bare `previous` envelope. */
  previous: SaveEnvelope | undefined;
  /** True when a cloud handoff parked something under the bare `conflict` key. */
  hasConflict: boolean;
  /** The pre-registry `last-played` record, so the adopted world keeps its real timestamp. */
  legacySession: PlaySession | null;
}

export interface LegacyAdoption {
  registry: WorldRegistry;
  /** Record renames to perform, legacy key → world-scoped key. Empty when there is nothing. */
  rekey: { from: string; to: string }[];
  /** The adopted world, or null when this was a genuinely fresh install. */
  adopted: WorldRecord | null;
}

/**
 * Decide what a pre-registry database becomes. Pure: no database, no clock, no randomness.
 *
 * THE ACCEPTANCE CRITERION THIS FUNCTION IS: an existing player reloads and sees their world
 * as a card, and Continue boots it exactly as before. Nothing lost, nothing renamed.
 *
 * `previous` without `current` still counts as a world, matching `loadWorld`'s own fallback —
 * refusing to adopt it would tell a player whose last write was interrupted that they have no
 * save at all, while the parachute sat on disk unread.
 *
 * The summary is taken from whichever envelope will actually be loaded, so the card agrees with
 * what Continue is about to do. `lastPlayedAt` prefers the real last-played record over `now`,
 * because a player returning after a month should see "a month ago" on their card rather than
 * "just now" — the timestamp existed, and inventing a fresher one would be a small lie about
 * their own history.
 */
export function planLegacyAdoption(
  disk: LegacyDisk,
  context: { now: number; id: string },
): LegacyAdoption {
  const envelope = disk.current ?? disk.previous;
  if (envelope === undefined) {
    return { registry: emptyRegistry(), rekey: [], adopted: null };
  }

  const world: WorldRecord = {
    id: context.id,
    name: 'Lot #1',
    seed: envelope.worldSeed,
    // There is no record of when this world was created — nothing ever wrote one down. `now`
    // is the only defensible answer and it is only ever used for tie-breaking a sort.
    createdAt: context.now,
    lastPlayedAt: disk.legacySession?.at ?? context.now,
    summary: {
      tick: envelope.tick,
      moneyCents: peekMoneyCents(envelope.payload),
      formatVersion: envelope.formatVersion,
    },
    deletedAt: null,
  };

  const rekey: { from: string; to: string }[] = [];
  if (disk.current !== undefined) {
    rekey.push({ from: CURRENT_KEY, to: currentKeyFor(world.id) });
  }
  if (disk.previous !== undefined) {
    rekey.push({ from: PREVIOUS_KEY, to: previousKeyFor(world.id) });
  }
  if (disk.hasConflict) {
    rekey.push({ from: LEGACY_CONFLICT_KEY, to: conflictKeyFor(world.id) });
  }

  return {
    registry: {
      version: REGISTRY_VERSION,
      activeId: world.id,
      worlds: [world],
    },
    rekey,
    adopted: world,
  };
}

/**
 * A world id.
 *
 * Opaque and permanent — the save records are keyed on it — so it is drawn from `crypto` where
 * that exists. Host-side randomness, which is fine on this side of the seam; nothing in
 * `packages/sim` ever sees this value.
 */
export function newWorldId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.floor(Math.random() * 0xffff_ffff)
    .toString(16)
    .padStart(8, '0');
}

/**
 * A seed for a new world, as a uint32.
 *
 * `Math.random` is fine on this side of the seam — host-side randomness is not sim randomness,
 * and this value becomes `worldSeed`, after which every roll in that world is derived from it
 * deterministically. `crypto` when it is there, because a world's seed is permanent and worth
 * a decent draw.
 *
 * NEVER THE OLD FIXED SEED. Before the registry, every "new" world was `createWorld(20260812)`
 * and two players — or one player twice — got the same lot down to the last weed. That is the
 * specific thing New Game exists to stop.
 */
export function freshSeed(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return crypto.getRandomValues(new Uint32Array(1))[0]!;
  }
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

// --- the database part ------------------------------------------------------------------

/**
 * A PLAN, not a value: given the registry as it actually is on disk at this instant, say what
 * should replace it. Null means "nothing to do".
 *
 * THIS TYPE IS THE FIX FOR [[138]] AND THE REASON IS WORTH STATING PLAINLY. Every mutation in
 * this file used to be a read-modify-write in three separate steps — read the memo, build a
 * new registry from it, write the whole record set back — and the memo it read was populated
 * once, on page load, and never refreshed. Two tabs therefore each held a private snapshot,
 * and the second one to write erased every world the first had created since. Not a field:
 * the list. A `New Game` in one tab and a routine autosave in the other, sixty seconds apart,
 * and the new lot's card was gone.
 *
 * A plan cannot do that, because it never sees a snapshot. It is handed the current record,
 * inside the transaction that will write its result, and there is no instant between the two
 * for another tab to fit a world into.
 *
 * PLANS RUN EXACTLY ONCE PER `mutate` CALL, so capturing something out of one is legal — the
 * sweep below does it. They must not perform I/O, and they must not read the memo.
 */
export type RegistryPlan = (current: WorldRegistry) => WorldRegistry | null;

export interface RegistryWrite {
  /** The registry as it now stands: the plan's output, or the unchanged record. */
  registry: WorldRegistry;
  /** False when the plan declined, and false when the write was attempted and failed. */
  wrote: boolean;
  /** Set only when a write was attempted and rejected. Never swallowed — see `mutate`. */
  error?: unknown;
}

/**
 * Where the registry lives, as a seam — the same discipline as `SaveRecordStore` in `saves.ts`
 * and for the same reason: there is no IndexedDB in this workspace's test environment, so the
 * one operation that can lose a player's lot has to be reachable without a browser.
 */
export interface RegistryStore {
  read(): Promise<WorldRegistry | undefined>;
  /** Read, apply, write — atomically with respect to every other client of this database. */
  mutate(plan: RegistryPlan, base: WorldRegistry): Promise<RegistryWrite>;
}

/**
 * The real one.
 *
 * ONE READWRITE TRANSACTION OVER `worlds`, AND THAT IS THE WHOLE GUARANTEE. IndexedDB
 * serialises overlapping readwrite transactions across every connection to a database,
 * including the connection held by the tab next door — so a read followed by a write inside
 * one transaction is a genuine compare-and-swap against other tabs, which is a stronger thing
 * than any amount of in-page bookkeeping could buy. No lock to acquire, no message to lose,
 * no retry loop: the browser already owns this problem and has since 2011.
 */
export function idbRegistryStore(): RegistryStore {
  return {
    async read() {
      const db = await getDb();
      return db.get(WORLDS_STORE, REGISTRY_KEY);
    },
    async mutate(plan, base) {
      const db = await getDb();
      const tx = db.transaction(WORLDS_STORE, 'readwrite');
      const store = tx.objectStore(WORLDS_STORE);
      // The read that matters. `base` is only reached on a database that has never held a
      // registry record at all, where there is by definition no other tab's work to lose.
      const stored = (await store.get(REGISTRY_KEY)) ?? base;
      const next = plan(stored);
      if (next === null) {
        await tx.done;
        return { registry: stored, wrote: false };
      }
      await store.put(next, REGISTRY_KEY);
      await tx.done;
      return { registry: next, wrote: true };
    },
  };
}

/**
 * The test one. Structured-clones on the way in and out, and serialises its mutations.
 *
 * BOTH OF THOSE ARE FIDELITY, NOT TIDINESS. IndexedDB stores a copy, so a store that handed
 * back the same object every caller already held would let two "tabs" share one registry by
 * reference and pass a concurrency test for entirely the wrong reason. And the queue is what
 * makes `mutate` atomic here in the way the transaction makes it atomic there — without it a
 * test could interleave two mutations in a way no browser ever would, and prove nothing.
 */
export function memoryRegistryStore(initial?: WorldRegistry): RegistryStore {
  let value = initial === undefined ? undefined : copy(initial);
  let queue: Promise<unknown> = Promise.resolve();

  function serialise<T>(job: () => T): Promise<T> {
    const run = queue.then(job, job);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    read: () => serialise(() => (value === undefined ? undefined : copy(value))),
    mutate: (plan, base) =>
      serialise(() => {
        const stored = value === undefined ? base : copy(value);
        const next = plan(stored);
        if (next === null) return { registry: stored, wrote: false };
        value = copy(next);
        return { registry: next, wrote: true };
      }),
  };
}

function copy<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

export interface RegistryClient {
  /** The registry, memoised for the life of this client. */
  read(): Promise<WorldRegistry>;
  /** Drop the memo. The cross-tab listener, and tests. */
  invalidate(): void;
  /**
   * Apply a plan. `what` is a plain-English verb phrase for the failure card — "start a new
   * lot", "rename a lot" — so a write that cannot be honoured says which one it was.
   */
  mutate(plan: RegistryPlan, what: string): Promise<RegistryWrite>;
}

/**
 * A registry client with its own memo.
 *
 * THE MEMO SURVIVED THE FIX, DELIBERATELY, and it is worth being clear about what it is now
 * for. Its original job is still real: StrictMode mounts everything twice and the front door,
 * the boot path and the autosave all want the registry within the same few milliseconds, so
 * without it two concurrent first reads would each find no registry, each run the adoption
 * migration, and each mint a different id for the same world. One promise means one migration.
 *
 * What changed is that no WRITE consults it any more. It is a read cache for drawing cards,
 * and a stale card is a cosmetic problem that the cross-tab broadcast below fixes as a
 * courtesy. Correctness lives entirely in `store.mutate`, so the broadcast may be dropped,
 * unsupported, or arrive late and nothing is lost.
 */
export function createRegistryClient(
  store: RegistryStore,
  options: { seed?: () => Promise<WorldRegistry>; announce?: () => void } = {},
): RegistryClient {
  let cached: Promise<WorldRegistry> | null = null;
  const seed = options.seed ?? (() => Promise.resolve(emptyRegistry()));

  function read(): Promise<WorldRegistry> {
    cached ??= load().catch((error: unknown) => {
      // A failed read must not poison the page: the next call gets to try again. An empty
      // registry is the safe answer in the meantime — it shows the front door with no cards,
      // which is wrong but harmless, where a thrown error would be a blank screen.
      cached = null;
      logWarn('Could not read the world registry.', error);
      return emptyRegistry();
    });
    return cached;
  }

  async function load(): Promise<WorldRegistry> {
    return (await store.read()) ?? (await seed());
  }

  return {
    read,
    invalidate() {
      cached = null;
    },
    async mutate(plan, what) {
      const base = await read();
      try {
        const result = await store.mutate(plan, base);
        // Priming the memo is safe NOW and was the bug BEFORE, and the difference is where
        // the value came from: this one was merged against the current record inside the
        // transaction that wrote it, rather than derived from a snapshot taken on page load.
        cached = Promise.resolve(result.registry);
        if (result.wrote) options.announce?.();
        return result;
      } catch (error) {
        cached = null;
        reportRegistryFailure(what, error);
        return { registry: base, wrote: false, error };
      }
    },
  };
}

/**
 * A registry write that did not land, said out loud.
 *
 * IT USED TO BE A `console.warn` AND THAT IS HALF OF WHY [[138]] WAS A WORLD-EATER. The other
 * half was the stale memo, which is fixed above; this half is that when the fix does not
 * apply — a full disk, a browser that has revoked the origin's storage — the game carried on
 * exactly as if the write had worked. A player can then press New Game, play a lot for an
 * hour, and have it exist only in a tab. [[041]]'s constraint is blunt about this and it is
 * the right constraint: never fail a save silently, because a silent failure is worse than a
 * visible one — the player keeps playing.
 */
function reportRegistryFailure(what: string, error: unknown): void {
  logWarn(`Could not ${what}: the list of lots could not be written.`, error);
  publishNotice({
    id: NoticeId.RegistryWriteFailed,
    tone: 'warning',
    title: 'The game could not update your list of lots.',
    body:
      'Your factory itself is fine and is still being saved as normal — this is the short ' +
      `list of lots on the front door, not the lots themselves. The game tried to ${what} ` +
      'and the list would not save. If your browser is low on disk space, freeing some and ' +
      'reloading should fix it; your worlds will still be here.',
  });
}

// --- one registry per page, and one message when it changes -----------------------------

/**
 * Other tabs' writes drop this page's read memo.
 *
 * A COURTESY, NOT A CORRECTNESS MECHANISM, and the distinction is the whole reason this is
 * four lines rather than a protocol. Writes are already safe — see `idbRegistryStore` — so a
 * message that is never delivered, arrives out of order, or is unsupported by the browser
 * costs exactly one thing: a front door that shows a lot list from a minute ago until the
 * next write. There is no acknowledgement, no sequence number and no payload, because
 * anything that carried state would be a second source of truth for the thing IndexedDB is
 * already the source of truth for.
 */
const REGISTRY_CHANNEL = 'snack-mogul:registry';

let broadcast: BroadcastChannel | null = null;

function openBroadcast(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    broadcast = new BroadcastChannel(REGISTRY_CHANNEL);
    broadcast.onmessage = () => {
      defaultClient.invalidate();
    };
  } catch {
    // A browser that has the constructor but refuses to open one (some privacy modes). The
    // registry is still correct; the cards are just not live. Nothing to say to anybody.
    broadcast = null;
  }
}

const defaultClient: RegistryClient = createRegistryClient(idbRegistryStore(), {
  seed: adoptLegacyRecords,
  announce: () => {
    broadcast?.postMessage(1);
  },
});

if (isStorageAvailable()) openBroadcast();

/** Drop the memo. Tests, and the cross-tab listener above. */
export function invalidateRegistry(): void {
  defaultClient.invalidate();
}

/**
 * The registry, with the orphan check having run exactly once first ([[138]], `orphans.ts`).
 *
 * IT RUNS HERE RATHER THAN IN `bootWorld` FOR ONE REASON: the player this exists for may have
 * no world left to boot. If every lot they own lost its card, the front door is empty and the
 * only button is New Game — so a rescue that waited for a boot would never reach the person
 * whose whole list is missing. This is the read the front door does on mount, so putting it
 * here is what makes the recovered lots appear on the first paint rather than never.
 *
 * The extra cost is one key enumeration of `saves`, once per page. Everything after that is
 * the memo, exactly as before.
 */
let reconciled: Promise<void> | null = null;

export function readRegistry(): Promise<WorldRegistry> {
  if (!isStorageAvailable()) return Promise.resolve(emptyRegistry());
  reconciled ??= rescueOrphans();
  return reconciled.then(() => defaultClient.read());
}

async function rescueOrphans(): Promise<void> {
  try {
    const current = await defaultClient.read();
    const found = await findOrphanedWorlds(new Set(current.worlds.map((world) => world.id)));
    if (found.length === 0) return;

    let rescued: WorldRecord[] = [];
    const result = await defaultClient.mutate((live) => {
      // Planned against the LIVE record, not against `current` — this is a registry write like
      // any other and it plays by the same rule. A world another tab restored a moment ago is
      // in `live`, so `planOrphanRescue` sees it as known and does not file a second card for
      // the same lot under a different name.
      const plan = planOrphanRescue(live, found, { now: Date.now(), peekMoney: peekMoneyCents });
      rescued = plan.rescued;
      return plan.rescued.length === 0 ? null : plan.registry;
    }, 'put a recovered lot back on the list');

    if (result.wrote && rescued.length > 0) announceRescue(rescued);
  } catch (error) {
    // Best-effort throughout: a failed check is a list that is missing a card it was already
    // missing, and it must never be the reason the front door does not draw.
    logWarn('Could not check for lots that had lost their card.', error);
  }
}

/** Every mutation in this file goes through here. Never call `store.mutate` directly. */
function mutateRegistry(plan: RegistryPlan, what: string): Promise<RegistryWrite> {
  if (!isStorageAvailable()) {
    return Promise.resolve({ registry: emptyRegistry(), wrote: false });
  }
  return defaultClient.mutate(plan, what);
}

/**
 * First read on a database that predates the registry. Runs at most once.
 *
 * The rename happens in ONE transaction with the registry write, so there is no instant at
 * which a record has moved but nothing knows where it went. `store.add` rather than `put` for
 * the destination keys: if a world-scoped record somehow already exists, the whole transaction
 * aborts and the legacy records stay exactly where they are, which is the correct outcome for a
 * situation nobody has a better answer for.
 */
async function adoptLegacyRecords(): Promise<WorldRegistry> {
  const db = await getDb();

  const readTx = db.transaction(SAVES_STORE, 'readonly');
  const readStore = readTx.objectStore(SAVES_STORE);
  const current = await readStore.get(CURRENT_KEY);
  const previous = await readStore.get(PREVIOUS_KEY);
  const conflict = await readStore.get(LEGACY_CONFLICT_KEY);
  await readTx.done;

  const plan = planLegacyAdoption(
    {
      current,
      previous,
      hasConflict: conflict !== undefined,
      legacySession: await readLegacySession(),
    },
    { now: Date.now(), id: newWorldId() },
  );

  if (plan.adopted === null) {
    // A genuinely fresh install. Write the empty registry so the adoption path never runs
    // again — a player who starts a world, deletes it, and reloads must not have the migration
    // wake up and go looking for legacy records.
    //
    // CLAIMED INSIDE THE TRANSACTION, for [[138]]'s reason exactly. This plan was computed
    // four round-trips ago against a database with no registry in it, and a second tab can
    // finish a New Game inside that window — so a bare `put` here would overwrite a real lot
    // with an empty list, which is the world-eater the merge above exists to prevent. The
    // migration runs at most once per database, so anything already on disk outranks it.
    const fresh = db.transaction(WORLDS_STORE, 'readwrite');
    const store = fresh.objectStore(WORLDS_STORE);
    const raced = await store.get(REGISTRY_KEY);
    if (raced !== undefined) {
      await fresh.done;
      return raced;
    }
    await store.put(plan.registry, REGISTRY_KEY);
    await fresh.done;
    return plan.registry;
  }

  const tx = db.transaction([SAVES_STORE, WORLDS_STORE], 'readwrite');
  const worlds = tx.objectStore(WORLDS_STORE);
  // The same claim, and the same reason. A registry that already exists means another tab
  // finished this migration first — its re-key has already moved the records, so repeating it
  // would abort on `add` anyway, and its registry is the one with the adopted world on it.
  const raced = await worlds.get(REGISTRY_KEY);
  if (raced !== undefined) {
    await tx.done;
    return raced;
  }
  const saves = tx.objectStore(SAVES_STORE);
  for (const move of plan.rekey) {
    const record = await saves.get(move.from);
    if (record === undefined) continue;
    await saves.add(record, move.to);
    await saves.delete(move.from);
  }
  await worlds.put(plan.registry, REGISTRY_KEY);
  await tx.done;

  // The last-played record moves too, or the Welcome Back card greets a returning player with
  // a gap of zero on the very boot that was supposed to notice they had been away.
  await adoptLegacySession(plan.adopted.id);

  logInfo(
    `Adopted the existing save as "${plan.adopted.name}" (world ${plan.adopted.id}, seed ` +
      `${String(plan.adopted.seed)}, tick ${String(plan.adopted.summary.tick)}). ` +
      `${String(plan.rekey.length)} record(s) re-keyed.`,
  );

  return plan.registry;
}

// The registry's half of the per-world last-played clock, done here with two `meta` calls
// rather than by importing `session.ts` — that module imports the key helpers above, and an
// import going back the other way would close a cycle for the sake of five lines.

async function readLegacySession(): Promise<PlaySession | null> {
  try {
    const db = await getDb();
    return (await db.get(META_STORE, LEGACY_SESSION_KEY)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Move the pre-registry visit record onto the adopted world's key.
 *
 * A MOVE rather than a copy. Nothing reads the bare key once the registry exists, and a record
 * that nothing reads but that still looks authoritative is exactly the sort of thing somebody
 * wires a fallback to two years from now — at which point a second world would inherit the
 * first world's last-played time and be greeted for an absence it never had.
 */
async function adoptLegacySession(worldId: string): Promise<void> {
  try {
    const db = await getDb();
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    const legacy = await store.get(LEGACY_SESSION_KEY);
    if (legacy !== undefined) {
      await store.put(legacy, sessionKeyFor(worldId));
      await store.delete(LEGACY_SESSION_KEY);
    }
    await tx.done;
  } catch (error) {
    logWarn('Could not move the last-played record onto the adopted world.', error);
  }
}

/** The world `bootWorld()` should load, or null when there is nothing to load. */
export async function activeWorld(): Promise<WorldRecord | null> {
  const registry = await readRegistry();
  const active = findWorld(registry, registry.activeId);
  return active !== null && active.deletedAt === null ? active : null;
}

export async function activeWorldId(): Promise<string | null> {
  return (await activeWorld())?.id ?? null;
}

/**
 * A world's seed, from the registry.
 *
 * The registry is the only thing that remembers a world's seed once its envelope is gone, and
 * the seed is how the trace store and the reports database both key their per-world records.
 */
export async function worldSeedOf(id: string): Promise<number | null> {
  return findWorld(await readRegistry(), id)?.seed ?? null;
}

/**
 * Make `id` the world the next boot loads. Returns null when there is no such live world.
 *
 * The front door awaits this BEFORE mounting the canvas, because `bootWorld()` reads the
 * active id and there is exactly one right answer at that moment.
 */
export async function activateWorld(id: string): Promise<WorldRecord | null> {
  const result = await mutateRegistry((current) => {
    const world = findWorld(current, id);
    if (world === null || world.deletedAt !== null) return null;
    if (current.activeId === id) return null;
    return { ...current, activeId: id };
  }, 'select a lot');

  // Read the answer out of the registry the write produced rather than out of the one the
  // plan was handed, so a card another tab deleted a second ago reports as gone rather than
  // as selected. `activeId` is the one field here two tabs can honestly disagree about, and
  // losing that argument costs nothing: `newestWorld` is what Continue actually follows.
  const world = findWorld(result.registry, id);
  return world !== null && world.deletedAt === null ? world : null;
}

/**
 * Mint a world and make it active. It has no save on disk until the first autosave lands —
 * `bootWorld` creates the state from `record.seed`.
 *
 * `avatar` is which farmer walks the lot ([[079]]) — cosmetic envelope metadata, stored on
 * the record and nowhere near `WorldState` (see `WorldRecord.avatar`). The picker passes
 * the chosen id; the default is avatar 1 so the Enter-through-it new game costs no clicks.
 * Existing records simply lack the field and keep the legacy farmer.
 */
export async function createWorldRecord(
  options: { name?: string; avatar?: number } = {},
): Promise<WorldRecord> {
  const now = Date.now();
  // Minted OUTSIDE the plan, because a plan must be a pure function of the registry and these
  // three are neither. The name is not: "Lot #3" is a fact about the list as it stands at the
  // instant of the write, which is exactly the sort of thing that used to be computed against
  // a page-old snapshot and hand two tabs the same name.
  const id = newWorldId();
  const seed = freshSeed();

  const result = await mutateRegistry(
    (current) => ({
      ...current,
      activeId: id,
      worlds: [
        ...current.worlds,
        {
          id,
          name: options.name ?? nextWorldName(current),
          seed,
          createdAt: now,
          lastPlayedAt: now,
          summary: { tick: 0, moneyCents: null, formatVersion: 0 },
          avatar: options.avatar ?? 1,
          deletedAt: null,
        },
      ],
    }),
    'start a new lot',
  );

  const stored = findWorld(result.registry, id);
  if (stored !== null) {
    logInfo(`New world "${stored.name}" (${id}) with seed ${String(seed)}.`);
    return stored;
  }

  // The write did not land, and `reportRegistryFailure` has already said so on screen. The
  // caller still gets a record because the alternative is a front door that cannot navigate,
  // and the world is genuinely playable — it will simply have no card until the write works.
  // `rescueOrphanedWorlds` in `orphans.ts` is the other half of this: the lot's save envelope
  // is enough to rebuild the card on a later boot, so this is a delay rather than a loss.
  logWarn(`New world ${id} is not on the list: its registry write failed.`);
  return {
    id,
    name: options.name ?? 'Lot #1',
    seed,
    createdAt: now,
    lastPlayedAt: now,
    summary: { tick: 0, moneyCents: null, formatVersion: 0 },
    avatar: options.avatar ?? 1,
    deletedAt: null,
  };
}

/**
 * Refresh a world's card after a successful save. Best-effort, and never throws.
 *
 * Called from `saveWorld`, which means the card always describes what is actually on disk
 * rather than what was in memory when the player last looked at the front door.
 */
export async function touchWorld(id: string, summary: WorldSummary): Promise<void> {
  try {
    const now = Date.now();
    await mutateRegistry((current) => {
      // THE AUTOSAVE'S WRITE, AND THEREFORE THE ONE [[138]] WAS OBSERVED THROUGH. It fires
      // once a minute for as long as a tab is playing, so before the fix a second tab was a
      // metronome erasing whatever the first tab had done since page load. Now it is handed
      // the live record and patches one world inside it, which is all it ever meant to do.
      if (findWorld(current, id) === null) return null;
      return withWorld(current, id, { summary, lastPlayedAt: now });
    }, 'update a lot card');
  } catch (error) {
    logWarn('Could not update the world card after saving.', error);
  }
}

/**
 * The database half of `planAvatarChange` — the pause menu's picker, committed ([[126]]).
 *
 * IT DOES NOT DRAW ANYTHING. The live swap is `publishAvatar` on the renderer's seam, and the
 * caller does both in that order: picture first, then disk. That ordering is what makes a slow
 * or failed write cost the player nothing — the farmer has already changed on screen, and the
 * worst case is a preference that does not survive a reload.
 *
 * Returns whether a live active world took it. False for a fresh page with no world, which is
 * not an error: it is the front door, where the new-game picker does this job instead.
 */
export async function setActiveWorldAvatar(avatar: number): Promise<boolean> {
  const result = await mutateRegistry((current) => {
    const next = planAvatarChange(current, avatar);
    // Identity means "already wearing it" — see `planAvatarChange`. Re-picking the farmer you
    // are already dressed as must not cost a registry write on every click.
    return next === null || next === current ? null : next;
  }, 'change the farmer');

  const world = findWorld(result.registry, result.registry.activeId);
  return world !== null && world.deletedAt === null && (world.avatar ?? 0) === avatar;
}

export async function renameWorld(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === '') return;
  await mutateRegistry(
    (current) =>
      findWorld(current, id) === null
        ? null
        : withWorld(current, id, { name: trimmed.slice(0, 40) }),
    'rename a lot',
  );
}

/**
 * Tombstone a world. The envelopes are NOT touched — see rule 2 in the header.
 *
 * If the deleted world was active, the active id moves to whatever is left, so a player who
 * deletes the world they were on does not end up pointing at a card that no longer exists.
 */
export async function deleteWorld(id: string): Promise<WorldRegistry> {
  const now = Date.now();
  let deleted: WorldRecord | null = null;

  const result = await mutateRegistry((current) => {
    const world = findWorld(current, id);
    if (world === null || world.deletedAt !== null) return null;
    deleted = world;
    const tombstoned = withWorld(current, id, { deletedAt: now });
    return {
      ...tombstoned,
      activeId: current.activeId === id ? (newestWorld(tombstoned)?.id ?? null) : current.activeId,
    };
  }, 'delete a lot');

  if (deleted !== null) {
    logInfo(
      `Deleted "${(deleted as WorldRecord).name}". Its save is kept for ${String(
        Math.round(WORLD_TOMBSTONE_MS / 86_400_000),
      )} days and can be restored until then.`,
    );
  }
  return result.registry;
}

/** Undo a delete, any time inside the retention window. */
export async function restoreDeletedWorld(id: string): Promise<WorldRegistry> {
  const result = await mutateRegistry((current) => {
    const world = findWorld(current, id);
    if (world === null || world.deletedAt === null) return null;
    return withWorld(current, id, { deletedAt: null });
  }, 'restore a deleted lot');
  return result.registry;
}

/**
 * Drop every tombstone past the retention window, envelopes and all.
 *
 * THE ONE PLACE IN THIS DIRECTORY THAT DELETES A WORLD'S SAVE, and it is bounded on both
 * sides: the player asked for it explicitly, and fourteen days passed. It runs on boot, so a
 * browser that is never reopened collects nothing — which is right, because the window exists
 * for second thoughts and there are none if nobody comes back.
 *
 * Best-effort throughout. A failed sweep is a few kilobytes, not a bug worth a card.
 */
export async function sweepTombstones(now: number = Date.now()): Promise<number> {
  try {
    // CLAIM FIRST, DELETE SECOND, and the order is the fix rather than a tidy-up. It used to
    // read the registry, delete the envelopes, and only then write the shortened list — so a
    // tab holding a stale registry could sweep a world the player had restored in another tab
    // a moment earlier, and the restore would survive in the list with nothing behind it.
    // Removing the records inside the transaction claims them: a concurrent restore either
    // landed first (in which case `deletedAt` is null and this plan does not match it) or
    // lands after, by which point there is no record left to restore.
    let expired: WorldRecord[] = [];
    const claim = await mutateRegistry((current) => {
      expired = expiredTombstones(current, now);
      if (expired.length === 0) return null;
      const gone = new Set(expired.map((world) => world.id));
      return { ...current, worlds: current.worlds.filter((world) => !gone.has(world.id)) };
    }, 'tidy up deleted lots');

    // Nothing matched, or the write did not land. Either way, touch no envelopes: the only
    // licence to delete a save is a registry that no longer mentions it.
    if (expired.length === 0 || !claim.wrote) return 0;

    const db = await getDb();
    const tx = db.transaction(SAVES_STORE, 'readwrite');
    const store = tx.objectStore(SAVES_STORE);
    for (const world of expired) {
      await store.delete(currentKeyFor(world.id));
      await store.delete(previousKeyFor(world.id));
      await store.delete(olderKeyFor(world.id));
      await store.delete(milestoneKeyFor(world.id));
      await store.delete(conflictKeyFor(world.id));
    }
    await tx.done;

    // The input log goes with the world. It is the one thing in the database that grows without
    // bound, and keeping a replay of a world nobody can load any more is keeping the receipt
    // for a meal nobody remembers eating.
    for (const world of expired) await clearTraceForWorld(world.seed);

    logInfo(`Collected ${String(expired.length)} world(s) deleted more than two weeks ago.`);
    return expired.length;
  } catch (error) {
    logWarn('Could not collect deleted worlds. They will be collected on a later boot.', error);
    return 0;
  }
}
