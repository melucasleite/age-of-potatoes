// The IndexedDB connection and its schema.
//
// IndexedDB is the source of truth, not a cache. Plan §11: the game must work with the
// network off, and Supabase sync (work item 016) is a mirror on top of this, never the other
// way around.
//
// NOT localStorage — anywhere, for anything. It is synchronous (so it janks the frame it
// runs on), capped around 5 MB, and evicted more aggressively than IndexedDB. A save is the
// one file that holds the whole game.

import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { SaveEnvelope } from '@snack/sim';

export const DB_NAME = 'snack-mogul';
export const DB_VERSION = 4;

export const SAVES_STORE = 'saves';
export const TRACES_STORE = 'traces';

/**
 * The world registry: which lots exist, what to put on their cards, and which one is live.
 *
 * A SEPARATE STORE, for the same reason `meta` and `quarantine` are. The registry is
 * host-side bookkeeping — names, wall-clock timestamps, a summary for a card — and every
 * field in it is something §12 bans from `WorldState` outright. Keeping it beside the saves
 * rather than inside one also means it survives a save that will not parse: a world whose
 * envelope is corrupt still has a card, still has a name, and still says what went wrong.
 *
 * ONE RECORD under `REGISTRY_KEY`, not one record per world. The whole list is read on every
 * boot and written whenever a world is created, renamed, played, or deleted — a handful of
 * small objects, rewritten a few times a session. A record per world would buy nothing except
 * the chance for the list and its members to disagree.
 */
export const WORLDS_STORE = 'worlds';

/**
 * Host-side facts about the player's visits. **Never world state.**
 *
 * A SEPARATE STORE, and the separation is the point rather than tidiness. Work item 040's
 * hard constraint is that the last-played timestamp lives "outside `SavePayload`, outside
 * `WorldState`, and outside `hashState()`" — because §6 and §12 ban `Date` from
 * `packages/sim` entirely, and a wall-clock value that found its way into the world would
 * change the state hash on every save and take every replay and every leaderboard with it.
 *
 * Keeping it in its own store means the mistake is not merely discouraged, it is awkward:
 * there is no code path that reads this store and hands the result to the sim.
 */
export const META_STORE = 'meta';

/**
 * Where a record that would not load goes to be kept.
 *
 * A SEPARATE STORE, not a flag on the save. Work item 041 is explicit that a corrupt record is
 * quarantined rather than overwritten, and the reason is that the instinct — write a fresh
 * world over the bad one — destroys the only copy of the evidence, and destroys a perfectly
 * good world outright if the corruption was a read-side bug rather than a write-side one.
 *
 * Records here are never deleted automatically. They are small, they are rare, and the whole
 * point of them is to still be there when somebody finally goes looking.
 */
export const QUARANTINE_STORE = 'quarantine';

/**
 * The pre-registry record keys, kept because databases in the wild still hold them.
 *
 * These WERE the whole scheme: §6 was read as "one persistent world per player", so `saves`
 * held exactly two records under fixed keys. Work item 055 supersedes that reading — the
 * locked decision was about the ONLINE design (no seasons, no cohort resets), not about local
 * save slots — and records are now keyed by world (`worlds.ts`). These two constants survive
 * for exactly one purpose: the migration that adopts a pre-registry player's world as their
 * first lot has to know where to find it.
 *
 * `previous` is STILL not a save slot and must never be surfaced as one, per world or
 * otherwise. It is the parachute for a corrupt write.
 */
export const CURRENT_KEY = 'current';
export const PREVIOUS_KEY = 'previous';

/**
 * A chunk of the append-only input trace.
 *
 * Batched rather than one record per command because a busy minute produces hundreds of
 * commands, and seed + trace only has to be *replayable*, not queryable. Batches are read
 * back in insertion order, which is the order they were applied in.
 */
export interface TraceBatch {
  /** Which world these belong to. A new seed means a new world means a fresh log. */
  worldSeed: number;
  /** Index into the session's in-memory trace that this batch starts at. */
  fromIndex: number;
  /** `{ tick, command }` entries, exactly as the sim recorded them. */
  entries: { tick: number; command: unknown }[];
}

/**
 * A save record that failed to load, kept exactly as it was found.
 *
 * `record` is `unknown` on purpose: it did not parse as an envelope, so typing it as one would
 * be a lie told to the compiler about the single value in this codebase most likely to be
 * shaped wrong. Everything else here is the triage context — what it was, what went wrong,
 * and when — because a quarantined record with no story attached is just a mystery blob.
 */
export interface QuarantinedSave {
  /** Which key it was read from: `current`, `previous`, or a cloud `conflict`. */
  slot: string;
  /** The stored value, unmodified. */
  record: unknown;
  /** The error's message, as the sim wrote it. Names the first bad field for a parse failure. */
  error: string;
  /** The error's class name — `SaveCorruptError` and friends — so triage can group them. */
  errorName: string;
  /**
   * Wall-clock milliseconds when the load failed.
   *
   * Wall clock is legal HERE and nowhere near the sim: work item 041's constraint is "no
   * `Date` or wall-clock values inside `WorldState` or `SavePayload` — timestamps live in the
   * storage layer, outside the hash". This is the storage layer.
   */
  failedAt: number;
  /** Cheap identity, so five reloads of the same broken save do not make five copies. */
  fingerprint: string;
}

/**
 * When the player was last actually here, and how far their world had got.
 *
 * `tick` is stored alongside the wall clock for one reason: it is how the Welcome Back card
 * tells a returning player from someone who opened the game a month ago, did nothing, and
 * closed it. "Your factory is exactly where you left it" is a hollow sentence when there is
 * no factory, and a card that says it anyway is the game failing to know its own player.
 */
export interface PlaySession {
  /** Wall-clock milliseconds at the last moment the world was observed advancing. */
  at: number;
  /** `state.tick` at that moment. */
  tick: number;
}

/**
 * Everything the front door needs to draw a card without opening the save.
 *
 * Written from the LIVE world by `saveWorld`, not read back out of the envelope. The envelope's
 * `payload` is typed `unknown` on purpose — a format-4 save handed to a format-7 build holds a
 * shape this code has never seen — so reaching into it for a money figure would be the one kind
 * of guess this directory does not make. The live `WorldState` always knows its own money.
 *
 * A summary is therefore as fresh as the last successful save, which is the honest thing for a
 * card to be: it says what is on disk, which is what Continue is about to load.
 */
export interface WorldSummary {
  /** `state.tick` at the last save. The in-game day is derived from it. */
  tick: number;
  /** Money in cents, or null for a world adopted from a pre-registry save (see `worlds.ts`). */
  moneyCents: number | null;
  /** The envelope format the world was last written at, so a card can refuse a future save. */
  formatVersion: number;
}

/**
 * One lot.
 *
 * Every timestamp here is wall clock, and every one of them is legal for the same reason the
 * last-played record is: this is the storage layer, outside `WorldState`, outside `SavePayload`
 * and outside `hashState()`. §12 bans `Date` from `packages/sim`, not from the code that draws
 * a list of saves.
 */
export interface WorldRecord {
  /** Stable, opaque, and permanent — the save records are keyed on it. Never reused. */
  id: string;
  /** The player's name for the lot. Defaults to "Lot #N"; renameable. */
  name: string;
  /** The uint32 `createWorld` was handed. Also how the reports database keys its ledger. */
  seed: number;
  createdAt: number;
  /** Last time this world was actually played, for ordering the list and for Continue. */
  lastPlayedAt: number;
  summary: WorldSummary;
  /**
   * Which farmer walks this lot ([[079]]): 1..5 for a picked avatar, absent for the legacy
   * farmer — which is what every record written before the picker existed correctly reads
   * as, with no registry migration.
   *
   * ENVELOPE METADATA, NEVER WORLD STATE. The avatar is cosmetic identity, and it lives
   * here — beside the lot's name and timestamps — precisely because everything in this
   * record is banned from `WorldState`, the trace, and `hashState()` (§12). Replays and
   * golden fixtures are avatar-agnostic by construction; the renderer reads the id at boot
   * (`render/avatar.ts`) and the sim never hears about it.
   */
  avatar?: number;
  /**
   * When the player deleted it, or null.
   *
   * A TOMBSTONE, NOT A DELETE. The record and its envelopes stay exactly where they are until
   * a boot finds the tombstone older than the retention window — see `worlds.ts`. Deleting a
   * world is the one irreversible thing a player can do to ten hours of their own work, and
   * this directory does not do irreversible in one step.
   */
  deletedAt: number | null;
}

/** The whole registry, as one record. */
export interface WorldRegistry {
  /** Bumped only if this shape ever changes. Not the save format; not the DB version. */
  version: number;
  /** The world `bootWorld()` will load. Null on a fresh install, before New Game. */
  activeId: string | null;
  worlds: WorldRecord[];
}

interface SnackMogulDB extends DBSchema {
  [SAVES_STORE]: { key: string; value: SaveEnvelope };
  [TRACES_STORE]: { key: number; value: TraceBatch };
  [QUARANTINE_STORE]: { key: number; value: QuarantinedSave };
  [META_STORE]: { key: string; value: PlaySession };
  [WORLDS_STORE]: { key: string; value: WorldRegistry };
}

let connection: Promise<IDBPDatabase<SnackMogulDB>> | null = null;

/** True when this environment can store anything at all — false during SSR. */
export function isStorageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * Open (or reuse) the connection.
 *
 * The promise is memoised, not the database, so a failed open can be retried rather than
 * poisoning every later call. Firefox in private browsing and Safari with storage blocked
 * both reject here, and that is a survivable condition — the game still plays, it just does
 * not persist, and the caller gets to say so out loud.
 */
export function getDb(): Promise<IDBPDatabase<SnackMogulDB>> {
  if (!isStorageAvailable()) {
    return Promise.reject(new Error('snack-mogul: IndexedDB is not available here.'));
  }
  if (connection === null) {
    connection = openDB<SnackMogulDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // Schema migrations are keyed on oldVersion and are append-only, exactly like the
        // save-format chain. Never rewrite a released branch of this switch.
        if (oldVersion < 1) {
          // Out-of-line keys: the stored value *is* the envelope, with no wrapper object.
          // That keeps the record legible in DevTools and makes cloud sync an upload rather
          // than a redesign.
          db.createObjectStore(SAVES_STORE);
          db.createObjectStore(TRACES_STORE, { autoIncrement: true });
        }
        if (oldVersion < 2) {
          // Append-only, per the note above: version 1 databases in the wild gain the
          // quarantine store and keep their saves exactly where they were. Auto-incrementing
          // because these are an accumulating log, not a keyed lookup — every failure is its
          // own record and none of them replaces another.
          db.createObjectStore(QUARANTINE_STORE, { autoIncrement: true });
        }
        if (oldVersion < 3) {
          // Append-only again: version 1 and 2 databases in the wild gain the meta store and
          // keep everything else exactly where it is. Out-of-line string keys, one record —
          // this is a lookup, not a log, and last week's visit is of no interest once this
          // week's has happened.
          db.createObjectStore(META_STORE);
        }
        if (oldVersion < 4) {
          // Append-only once more, and this is the one that matters most: the store is
          // CREATED here and left EMPTY. The registry is not written during the schema
          // upgrade. Adopting a pre-registry player's `current`/`previous` records as their
          // first lot is a data migration that has to read a save envelope, decide what to
          // call the world, and re-key two records — all of it async, all of it able to fail
          // survivably, and none of it safe inside an IndexedDB `upgrade` callback, where an
          // await on anything but an IDB request kills the transaction. It runs on first read
          // instead; see `migrateRegistry` in `worlds.ts`.
          db.createObjectStore(WORLDS_STORE);
        }
      },
      terminated() {
        // Browser killed the connection (tab discarded, storage pressure). Drop the memo so
        // the next call reopens instead of awaiting a corpse.
        connection = null;
      },
    }).catch((error: unknown) => {
      connection = null;
      throw error;
    });
  }
  return connection;
}

/** Close and forget the connection. Tests and hot reload; the game itself never needs it. */
export function closeDb(): void {
  const pending = connection;
  connection = null;
  if (pending !== null) {
    void pending.then(
      (db) => {
        db.close();
      },
      () => undefined,
    );
  }
}
