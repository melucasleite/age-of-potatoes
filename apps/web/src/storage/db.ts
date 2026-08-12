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
export const DB_VERSION = 1;

export const SAVES_STORE = 'saves';
export const TRACES_STORE = 'traces';

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

interface SnackMogulDB extends DBSchema {
  [SAVES_STORE]: { key: string; value: SaveEnvelope };
  [TRACES_STORE]: { key: number; value: TraceBatch };
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
