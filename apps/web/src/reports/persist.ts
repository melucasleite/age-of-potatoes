// Where the receipts live between sessions.
//
// A SEPARATE DATABASE, ON PURPOSE. `storage/db.ts` owns `snack-mogul` and its version
// number, and adding an object store to it means bumping `DB_VERSION` — which is a schema
// migration on the file that holds the entire game, landed by an agent who does not own that
// file, to store a leaderboard. That trade is obviously wrong. `snack-mogul-reports` is a
// second, tiny database with its own version line: nothing here can corrupt a save, and a
// player who clears it loses their personal bests and not their farm.
//
// NOT localStorage — the same rule the save driver states and for the same reasons: it is
// synchronous (so it janks the frame it runs on), capped around 5 MB, and evicted more
// aggressively than IndexedDB.
//
// EVERY WRITE IS BEST-EFFORT AND EVERY FAILURE IS SILENT. Firefox in private browsing and
// Safari with storage blocked both reject on open. That is survivable here in a way it is
// not for a save: the reports keep working for the session and forget afterwards, which is
// strictly better than an error card over a game that is otherwise fine.
//
// WHEN THE SIM OWNS THE BUCKETS, HALF OF THIS GOES AWAY. Work item 033 wants the hourly
// ledger inside `WorldStats`, in the hash, where it rides along in the ordinary save for
// free. The personal bests stay here regardless — they are cross-world records and do not
// belong in any one world's state.

import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

import type { PersonalBests } from './boards';
import type { PersistedLedger } from './shift';

const DB_NAME = 'snack-mogul-reports';
const DB_VERSION = 1;

const BESTS_STORE = 'bests';
const LEDGER_STORE = 'ledgers';

/**
 * Bests are cross-world by design — plan §6's boards are about the PLAYER, so beating your
 * own Dynasty record on a second lot counts. One record under one fixed key.
 */
const BESTS_KEY = 'personal';

/** What a stored ledger carries beyond the ledger itself. */
export interface StoredLedger {
  readonly worldSeed: number;
  readonly ledger: PersistedLedger;
  /** Value captured when the world crossed ten active hours, or −1 before it did. */
  readonly firstTenCents: number;
}

interface ReportsDB extends DBSchema {
  [BESTS_STORE]: { key: string; value: PersonalBests };
  /** Keyed by world seed: the hourly ledger belongs to one lot, unlike the bests. */
  [LEDGER_STORE]: { key: number; value: StoredLedger };
}

let connection: Promise<IDBPDatabase<ReportsDB>> | null = null;

function available(): boolean {
  return typeof indexedDB !== 'undefined';
}

function db(): Promise<IDBPDatabase<ReportsDB>> {
  if (!available()) return Promise.reject(new Error('reports: no IndexedDB here'));
  if (connection === null) {
    connection = openDB<ReportsDB>(DB_NAME, DB_VERSION, {
      upgrade(database, oldVersion) {
        // Append-only, keyed on oldVersion, exactly like the save chain. Never rewrite a
        // released branch of this switch.
        if (oldVersion < 1) {
          database.createObjectStore(BESTS_STORE);
          database.createObjectStore(LEDGER_STORE);
        }
      },
      terminated() {
        // The browser killed the connection (tab discarded, storage pressure). Drop the
        // memo so the next call reopens rather than awaiting a corpse.
        connection = null;
      },
    }).catch((error: unknown) => {
      connection = null;
      throw error;
    });
  }
  return connection;
}

/** The player's records, or null when storage is unavailable or empty. */
export async function loadBests(): Promise<PersonalBests | null> {
  try {
    const stored = await (await db()).get(BESTS_STORE, BESTS_KEY);
    return stored ?? null;
  } catch {
    return null;
  }
}

export async function saveBests(bests: PersonalBests): Promise<void> {
  try {
    // A structural copy, not the live object. The store keeps mutating its own copy between
    // now and whenever this transaction actually commits, and handing IndexedDB a reference
    // to a mutating object is a race that shows up as a best that is one publish ahead of
    // the board that set it.
    await (await db()).put(BESTS_STORE, { ...bests }, BESTS_KEY);
  } catch {
    /* the session keeps its numbers; the next one starts fresh */
  }
}

export async function loadLedger(worldSeed: number): Promise<StoredLedger | null> {
  try {
    const stored = await (await db()).get(LEDGER_STORE, worldSeed);
    return stored ?? null;
  } catch {
    return null;
  }
}

export async function saveLedger(entry: StoredLedger): Promise<void> {
  try {
    await (await db()).put(LEDGER_STORE, entry, entry.worldSeed);
  } catch {
    /* best effort, always */
  }
}

/** Tests and hot reload. The game itself never needs to close this. */
export function closeReportsDb(): void {
  const pending = connection;
  connection = null;
  if (pending !== null) {
    void pending.then(
      (database) => {
        database.close();
      },
      () => undefined,
    );
  }
}
