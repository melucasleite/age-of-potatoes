// Setting a broken save aside instead of stepping on it.
//
// THE RULE THIS IMPLEMENTS (work item 041, and it is a constraint rather than a preference):
// "Never overwrite a corrupt save. Quarantine it. It may be the only copy of a real world and
// it is certainly the only copy of the evidence."
//
// `saves.ts` already refused to write over a record that failed to load — that half was right
// from the start. What was missing is the other half: the bad record just sat there under the
// `current` key, indistinguishable from a healthy save, waiting for the next successful
// autosave to rotate it into `previous` and the one after that to push it off the end. Copying
// it into a store nothing else writes to is what makes "kept" mean kept.
//
// A COPY, NOT A MOVE, AND THAT IS DELIBERATE. Deleting the original would be a write on a
// failed load, which this directory does not do — and if the corruption turns out to be a
// read-side bug (a migration with a hole in it, a field this build does not understand yet),
// the record under `current` is a perfectly good world that a later build will load fine. So
// the original stays exactly where it is. The quarantine copy exists so that the world is
// still recoverable after the ordinary save rotation has moved on.
//
// EVERY FUNCTION HERE IS BEST-EFFORT AND NEVER THROWS. Quarantining runs at the worst possible
// moment — the save is broken, the disk may be full, the database may be the thing that is
// wrong — and a failure to file the paperwork must never stop the fallback load that gets the
// player back into their factory.

import { type QuarantinedSave, QUARANTINE_STORE, getDb, isStorageAvailable } from './db';
import { logInfo, logWarn } from './log';

export type QuarantineOutcome =
  /** Filed. The record is kept, with its error and the time it failed. */
  | 'quarantined'
  /** An identical failure is already on file — this is a reload, not a new fault. */
  | 'already-known'
  /** Could not write it. Logged, and deliberately not fatal. */
  | 'failed';

export interface QuarantineInput {
  /** Which key it came from: `current`, `previous`, `conflict`. */
  slot: string;
  /** The stored value exactly as it was read. */
  record: unknown;
  /** Whatever `restoreWorld` threw. */
  error: unknown;
}

/**
 * File a record that would not load, unless the same failure is already on file.
 *
 * The dedupe matters more than it looks: a player whose save is corrupt will reload the page
 * several times before they believe it, and each reload would otherwise add another copy of an
 * 11 KB world to a database that may already be the reason something is failing.
 */
export async function quarantineRecord(input: QuarantineInput): Promise<QuarantineOutcome> {
  if (!isStorageAvailable()) return 'failed';

  const { name, message } = describeError(input.error);
  const fingerprint = fingerprintRecord(input.slot, input.record, name);

  try {
    const db = await getDb();
    const tx = db.transaction(QUARANTINE_STORE, 'readwrite');
    const store = tx.objectStore(QUARANTINE_STORE);

    // Read inside the transaction so two tabs failing the same load at once cannot both
    // conclude they are the first.
    const existing = await store.getAll();
    for (const entry of existing) {
      if (entry.fingerprint === fingerprint) {
        await tx.done;
        return 'already-known';
      }
    }

    const filed: QuarantinedSave = {
      slot: input.slot,
      record: input.record,
      error: message,
      errorName: name,
      failedAt: Date.now(),
      fingerprint,
    };
    await store.add(filed);
    await tx.done;

    logInfo(
      `Quarantined the unreadable "${input.slot}" save. It is kept under the "quarantine" ` +
        'store in IndexedDB, with the error and the time it failed. Nothing was overwritten.',
    );
    return 'quarantined';
  } catch (error) {
    // The likeliest cause is the disk being full, which is also a likely cause of the
    // corruption we are trying to file. Say so and carry on; the original record is untouched
    // either way, which is the guarantee that actually matters.
    logWarn('Could not quarantine the unreadable save. It is still on disk, untouched.', error);
    return 'failed';
  }
}

/** Everything quarantined so far, oldest first. For the dev overlay and for bug reports. */
export async function readQuarantine(): Promise<QuarantinedSave[]> {
  if (!isStorageAvailable()) return [];
  try {
    const db = await getDb();
    return await db.getAll(QUARANTINE_STORE);
  } catch (error) {
    logWarn('Could not read the quarantine store.', error);
    return [];
  }
}

/**
 * A cheap identity for "this exact record failed this exact way".
 *
 * Not a hash: the point is only to tell a reload apart from a new fault, and hashing 11 KB of
 * JSON on a boot path that is already having a bad day buys nothing. Size plus the two header
 * fields plus the error name is enough — two genuinely different corrupt saves colliding on
 * all four would be a coincidence, and the cost of that coincidence is one missing record in a
 * debugging store, not a lost world.
 */
export function fingerprintRecord(slot: string, record: unknown, errorName: string): string {
  let formatVersion = '?';
  let tick = '?';
  if (record !== null && typeof record === 'object') {
    const header = record as { formatVersion?: unknown; tick?: unknown };
    if (typeof header.formatVersion === 'number') formatVersion = String(header.formatVersion);
    if (typeof header.tick === 'number') tick = String(header.tick);
  }

  let size = '?';
  try {
    // Structured clone permits cycles, so this can genuinely throw on a stored value. A record
    // that cannot even be stringified is exactly the kind this store exists to keep.
    size = String(JSON.stringify(record)?.length ?? 0);
  } catch {
    size = 'unstringifiable';
  }

  return `${slot}:${errorName}:${formatVersion}:${tick}:${size}`;
}

/** An error's class name and message, for anything at all that might be thrown. */
export function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'UnknownError', message: String(error) };
}
