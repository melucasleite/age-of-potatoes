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
 * The read is memoised for the page's lifetime, and the write invalidates it.
 *
 * StrictMode mounts everything twice and the front door, the boot path and the autosave all
 * want the registry within the same few milliseconds. Without the memo, two concurrent first
 * reads would each find no registry, each run the adoption migration, and each mint a
 * different id for the same world — one of which would win and the other of which would leave
 * a world nothing points at. One promise means one migration.
 */
let cached: Promise<WorldRegistry> | null = null;

/** Drop the memo. Tests, and every write below. */
export function invalidateRegistry(): void {
  cached = null;
}

export function readRegistry(): Promise<WorldRegistry> {
  cached ??= loadRegistry().catch((error: unknown) => {
    // A failed read must not poison the page: the next call gets to try again. An empty
    // registry is the safe answer in the meantime — it shows the front door with no cards,
    // which is wrong but harmless, where a thrown error would be a blank screen.
    cached = null;
    logWarn('Could not read the world registry.', error);
    return emptyRegistry();
  });
  return cached;
}

async function loadRegistry(): Promise<WorldRegistry> {
  if (!isStorageAvailable()) return emptyRegistry();

  const db = await getDb();
  const stored = await db.get(WORLDS_STORE, REGISTRY_KEY);
  if (stored !== undefined) return stored;

  return adoptLegacyRecords();
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
    await db.put(WORLDS_STORE, plan.registry, REGISTRY_KEY);
    return plan.registry;
  }

  const tx = db.transaction([SAVES_STORE, WORLDS_STORE], 'readwrite');
  const saves = tx.objectStore(SAVES_STORE);
  for (const move of plan.rekey) {
    const record = await saves.get(move.from);
    if (record === undefined) continue;
    await saves.add(record, move.to);
    await saves.delete(move.from);
  }
  await tx.objectStore(WORLDS_STORE).put(plan.registry, REGISTRY_KEY);
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

/** Write the registry and drop the memo. Every mutation below goes through this. */
async function writeRegistry(registry: WorldRegistry): Promise<WorldRegistry> {
  cached = Promise.resolve(registry);
  try {
    const db = await getDb();
    await db.put(WORLDS_STORE, registry, REGISTRY_KEY);
  } catch (error) {
    // The registry is small and rewritten often, so a failed write is very likely a full disk
    // — the same condition `quota.ts` handles for saves. It is survivable here in a way it is
    // not there: the in-memory copy is correct for this session, and the next successful write
    // catches the record up. What must NOT happen is an exception escaping into the front door.
    cached = null;
    logWarn('Could not write the world registry. This session will still work.', error);
  }
  return registry;
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
  const registry = await readRegistry();
  const world = findWorld(registry, id);
  if (world === null || world.deletedAt !== null) return null;
  if (registry.activeId === id) return world;
  await writeRegistry({ ...registry, activeId: id });
  return world;
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
  const registry = await readRegistry();
  const now = Date.now();
  const world: WorldRecord = {
    id: newWorldId(),
    name: options.name ?? nextWorldName(registry),
    seed: freshSeed(),
    createdAt: now,
    lastPlayedAt: now,
    summary: { tick: 0, moneyCents: null, formatVersion: 0 },
    avatar: options.avatar ?? 1,
    deletedAt: null,
  };
  await writeRegistry({
    ...registry,
    activeId: world.id,
    worlds: [...registry.worlds, world],
  });
  logInfo(`New world "${world.name}" (${world.id}) with seed ${String(world.seed)}.`);
  return world;
}

/**
 * Refresh a world's card after a successful save. Best-effort, and never throws.
 *
 * Called from `saveWorld`, which means the card always describes what is actually on disk
 * rather than what was in memory when the player last looked at the front door.
 */
export async function touchWorld(id: string, summary: WorldSummary): Promise<void> {
  try {
    const registry = await readRegistry();
    if (findWorld(registry, id) === null) return;
    await writeRegistry(withWorld(registry, id, { summary, lastPlayedAt: Date.now() }));
  } catch (error) {
    logWarn('Could not update the world card after saving.', error);
  }
}

export async function renameWorld(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === '') return;
  const registry = await readRegistry();
  if (findWorld(registry, id) === null) return;
  await writeRegistry(withWorld(registry, id, { name: trimmed.slice(0, 40) }));
}

/**
 * Tombstone a world. The envelopes are NOT touched — see rule 2 in the header.
 *
 * If the deleted world was active, the active id moves to whatever is left, so a player who
 * deletes the world they were on does not end up pointing at a card that no longer exists.
 */
export async function deleteWorld(id: string): Promise<WorldRegistry> {
  const registry = await readRegistry();
  const world = findWorld(registry, id);
  if (world === null || world.deletedAt !== null) return registry;

  const tombstoned = withWorld(registry, id, { deletedAt: Date.now() });
  const nextActive =
    registry.activeId === id ? (newestWorld(tombstoned)?.id ?? null) : registry.activeId;
  logInfo(
    `Deleted "${world.name}". Its save is kept for ${String(
      Math.round(WORLD_TOMBSTONE_MS / 86_400_000),
    )} days and can be restored until then.`,
  );
  return writeRegistry({ ...tombstoned, activeId: nextActive });
}

/** Undo a delete, any time inside the retention window. */
export async function restoreDeletedWorld(id: string): Promise<WorldRegistry> {
  const registry = await readRegistry();
  const world = findWorld(registry, id);
  if (world === null || world.deletedAt === null) return registry;
  return writeRegistry(withWorld(registry, id, { deletedAt: null }));
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
    const registry = await readRegistry();
    const expired = expiredTombstones(registry, now);
    if (expired.length === 0) return 0;

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

    const gone = new Set(expired.map((world) => world.id));
    await writeRegistry({
      ...registry,
      worlds: registry.worlds.filter((world) => !gone.has(world.id)),
    });
    logInfo(`Collected ${String(expired.length)} world(s) deleted more than two weeks ago.`);
    return expired.length;
  } catch (error) {
    logWarn('Could not collect deleted worlds. They will be collected on a later boot.', error);
    return 0;
  }
}
