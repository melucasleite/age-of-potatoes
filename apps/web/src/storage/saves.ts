// Reading and writing the one save.
//
// Two rules govern everything below, and both exist because the failure mode is a player
// losing a world they cared about:
//
//   1. A WRITE ROTATES `current` INTO `previous` FIRST, IN THE SAME TRANSACTION. One extra
//      `put` buys a survivable corrupt write. That is cheap insurance on the file that holds
//      the whole game.
//
//   2. A FAILED LOAD NEVER WRITES. Not a repair, not a reset, not a "clean up the bad
//      record". A save from a *newer* build especially: that means a stale deploy met a newer
//      save, the player's world is fine, and it is this tab that is out of date. Overwriting
//      a future save with a past one is the one unrecoverable mistake here.

import {
  type RestoredWorld,
  type SaveEnvelope,
  type SimVersionCheck,
  type WorldState,
  SaveFormatTooNewError,
  restoreWorld,
  serialize,
} from '@snack/sim';

import { CURRENT_KEY, PREVIOUS_KEY, SAVES_STORE, getDb, isStorageAvailable } from './db';
import { logError, logInfo, logWarn } from './log';
import { clearTrace, drainTrace, resetTraceCursor } from './trace';

export interface LoadedWorld {
  status: 'loaded';
  state: WorldState;
  /** The envelope after migration. */
  envelope: SaveEnvelope;
  /** `previous` means the main record was unreadable and the parachute opened. */
  source: 'current' | 'previous';
  /** The format version on disk, before migration. Equal to the current one when none ran. */
  migratedFrom: number;
  /**
   * Informational only. A mismatch means the world was balanced under different numbers,
   * which costs replay determinism and leaderboard comparability but not the world. Show it
   * in the dev overlay (work item 013).
   */
  simVersion: SimVersionCheck;
}

export interface NoSavedWorld {
  status: 'empty';
}

export interface RefusedWorld {
  status: 'refused';
  reason: 'format-too-new' | 'unreadable' | 'unavailable';
  message: string;
  error?: unknown;
}

export type LoadOutcome = LoadedWorld | NoSavedWorld | RefusedWorld;

export interface SaveResult {
  tick: number;
  /** Size of the stored JSON, so the dev overlay can watch the 5 MB line §12 draws. */
  bytes: number;
  traceEntriesWritten: number;
}

/**
 * Take a save and write it.
 *
 * `serialize()` deep-copies, so this is safe to call from anywhere in the frame — a tick that
 * lands while the write is in flight cannot perturb the payload.
 *
 * Rejects if storage is unavailable or the write fails. Callers that autosave should log and
 * carry on rather than interrupting play; a failed save is not a reason to stop the game.
 */
export async function saveWorld(state: WorldState): Promise<SaveResult> {
  const envelope = serialize(state);
  const db = await getDb();

  const tx = db.transaction(SAVES_STORE, 'readwrite');
  const store = tx.objectStore(SAVES_STORE);
  // Rotate before overwriting, inside the transaction, so a crash mid-write cannot leave
  // both records damaged. Every await here is an IDB request, which is what keeps the
  // transaction alive — do not await anything else between these lines.
  const existing = await store.get(CURRENT_KEY);
  if (existing !== undefined) await store.put(existing, PREVIOUS_KEY);
  await store.put(envelope, CURRENT_KEY);
  await tx.done;

  // The trace is a debugging asset; the envelope is the player's world. A trace store that
  // is full, blocked, or otherwise unhappy must not turn a successful save into a failed one.
  let traceEntriesWritten = 0;
  try {
    traceEntriesWritten = await drainTrace(state);
  } catch (error) {
    logWarn('The world saved, but the input trace did not.', error);
  }

  return {
    tick: envelope.tick,
    bytes: JSON.stringify(envelope).length,
    traceEntriesWritten,
  };
}

/**
 * Read the saved world, migrating it if it is old and refusing it if it is from the future.
 *
 * Never throws. Every failure is a `RefusedWorld` the caller can render, because "your
 * factory vanished" deserves an explanation rather than an unhandled rejection.
 */
export async function loadWorld(): Promise<LoadOutcome> {
  if (!isStorageAvailable()) {
    const message = 'IndexedDB is not available, so this world cannot be saved or loaded.';
    logWarn(message);
    return { status: 'refused', reason: 'unavailable', message };
  }

  let stored: SaveEnvelope | undefined;
  let fallback: SaveEnvelope | undefined;
  try {
    const db = await getDb();
    const tx = db.transaction(SAVES_STORE, 'readonly');
    const store = tx.objectStore(SAVES_STORE);
    stored = await store.get(CURRENT_KEY);
    fallback = await store.get(PREVIOUS_KEY);
    await tx.done;
  } catch (error) {
    const message = 'Could not open the save database. Play continues, but nothing will save.';
    logError(message, error);
    return { status: 'refused', reason: 'unavailable', message, error };
  }

  // `previous` without a `current` should not happen, but if it does, reading it beats
  // telling the player they have no world.
  const primary = stored !== undefined ? stored : fallback;
  const source: 'current' | 'previous' = stored !== undefined ? 'current' : 'previous';

  if (primary === undefined) {
    logInfo('No saved world found. Starting fresh.');
    return { status: 'empty' };
  }

  try {
    return finish(restoreWorld(primary), source);
  } catch (error) {
    if (error instanceof SaveFormatTooNewError) {
      // Refuse, and write nothing. The player's world is fine; the tab is stale.
      logError(error.message);
      return { status: 'refused', reason: 'format-too-new', message: error.message, error };
    }

    logWarn('The saved world is unreadable. Trying the previous copy.', error);

    if (source === 'current' && fallback !== undefined) {
      try {
        const recovered = finish(restoreWorld(fallback), 'previous');
        logWarn('Recovered from the previous save. Some progress was lost.');
        return recovered;
      } catch (fallbackError) {
        logError('The previous save is unreadable too.', fallbackError);
      }
    }

    const message =
      'The saved world could not be read. It has been left on disk untouched — export it ' +
      'from DevTools before starting over if you want it looked at.';
    logError(message);
    return { status: 'refused', reason: 'unreadable', message, error };
  }
}

function finish(restored: RestoredWorld, source: 'current' | 'previous'): LoadedWorld {
  // The restored world's trace starts empty by design, so the drain cursor does too.
  resetTraceCursor(restored.state.worldSeed);

  if (restored.migration.steps.length > 0) {
    logInfo(
      `Migrated the save from format ${String(restored.migration.fromVersion)} to ` +
        `${String(restored.envelope.formatVersion)}.`,
      restored.migration.steps,
    );
  }
  if (!restored.simVersion.matches) {
    // Informational, never load-blocking. Balance moved; the world did not.
    logWarn(
      `This world was saved under a different sim version (${restored.simVersion.saved}, now ` +
        `${restored.simVersion.current}). Loading it anyway — replays and leaderboard ` +
        'comparisons against it are no longer exact.',
    );
  }

  logInfo(
    `Loaded world ${String(restored.state.worldSeed)} at tick ${String(restored.state.tick)} ` +
      `from the ${source} record.`,
  );

  return {
    status: 'loaded',
    state: restored.state,
    envelope: restored.envelope,
    source,
    migratedFrom: restored.migration.fromVersion,
    simVersion: restored.simVersion,
  };
}

/**
 * Delete the saved world and its trace.
 *
 * There is no UI for this and there should not be one: §6 locks one persistent world per
 * player, and a "new game" button next to a factory somebody spent ten hours on is a
 * footgun. It exists for DevTools and for tests.
 */
export async function clearSavedWorld(): Promise<void> {
  const db = await getDb();
  await db.clear(SAVES_STORE);
  await clearTrace();
  logWarn('Cleared the saved world.');
}

/** The raw stored envelopes, unmigrated, for the dev overlay and for bug reports. */
export async function readRawSaves(): Promise<{
  current: SaveEnvelope | undefined;
  previous: SaveEnvelope | undefined;
}> {
  const db = await getDb();
  const tx = db.transaction(SAVES_STORE, 'readonly');
  const store = tx.objectStore(SAVES_STORE);
  const current = await store.get(CURRENT_KEY);
  const previous = await store.get(PREVIOUS_KEY);
  await tx.done;
  return { current, previous };
}
