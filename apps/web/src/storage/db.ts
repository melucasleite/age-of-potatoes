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
export const DB_VERSION = 3;

export const SAVES_STORE = 'saves';
export const TRACES_STORE = 'traces';

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
 * §6 locks one persistent world per player, so `saves` holds exactly two records under fixed
 * keys rather than a slot list. `previous` is not a save slot and must never be surfaced as
 * one — it is the parachute for a corrupt write.
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

interface SnackMogulDB extends DBSchema {
  [SAVES_STORE]: { key: string; value: SaveEnvelope };
  [TRACES_STORE]: { key: number; value: TraceBatch };
  [QUARANTINE_STORE]: { key: number; value: QuarantinedSave };
  [META_STORE]: { key: string; value: PlaySession };
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
