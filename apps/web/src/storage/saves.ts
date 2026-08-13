// Reading and writing the one save.
//
// Three rules govern everything below, and all three exist because the failure mode is a
// player losing a world they cared about:
//
//   1. A WRITE ROTATES `current` INTO `previous` FIRST, IN THE SAME TRANSACTION. One extra
//      `put` buys a survivable corrupt write. That is cheap insurance on the file that holds
//      the whole game.
//
//   2. A FAILED LOAD NEVER WRITES *OVER THE SAVE*. Not a repair, not a reset, not a "clean up
//      the bad record". A save from a *newer* build especially: that means a stale deploy met
//      a newer save, the player's world is fine, and it is this tab that is out of date.
//      Overwriting a future save with a past one is the one unrecoverable mistake here. The
//      quarantine copy taken on a failed load is additive and lands in a different store — it
//      touches neither `current` nor `previous`, which is what keeps rule 2 true.
//
//   3. NOTHING FAILS QUIETLY. A save that did not land, and a load that fell back to the
//      backup, both reach the player as sentences through `notices.ts`. The console lines are
//      still here, but they are for the developer; the notice is for the person whose factory
//      it is. A silent save failure looks exactly like a working game until the tab closes.

import {
  type RestoredWorld,
  type SaveEnvelope,
  type SimVersionCheck,
  type WorldState,
  SaveFormatTooNewError,
  restoreWorld,
  serialize,
} from '@snack/sim';

import {
  CURRENT_KEY,
  PREVIOUS_KEY,
  SAVES_STORE,
  TRACES_STORE,
  getDb,
  isStorageAvailable,
} from './db';
import { logError, logInfo, logWarn } from './log';
import { NoticeId, dismissNotice, publishNotice } from './notices';
import { quarantineRecord } from './quarantine';
import { StorageFullError, withQuotaRetry } from './quota';
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
  /**
   * What was dropped to make room for this save, or null when it simply fit.
   *
   * Non-null means the write succeeded on the retry after the ladder in `quota.ts` gave
   * something up. Worth showing in the dev overlay: it is the first sign that a world is
   * outgrowing the browser it lives in.
   */
  freed: string | null;
}

/**
 * Take a save and write it.
 *
 * `serialize()` deep-copies, so this is safe to call from anywhere in the frame — a tick that
 * lands while the write is in flight cannot perturb the payload.
 *
 * Rejects if storage is unavailable or the write fails, but never *silently*: a quota failure
 * has already told the player in plain language by the time this rejects, and the rejection is
 * a `StorageFullError` whose message is that same wording. Callers that autosave should log
 * and carry on rather than interrupting play; a failed save is not a reason to stop the game.
 */
export async function saveWorld(state: WorldState): Promise<SaveResult> {
  const envelope = serialize(state);
  const db = await getDb();

  const write = async (): Promise<void> => {
    const tx = db.transaction(SAVES_STORE, 'readwrite');
    const store = tx.objectStore(SAVES_STORE);
    // Rotate before overwriting, inside the transaction, so a crash mid-write cannot leave
    // both records damaged. Every await here is an IDB request, which is what keeps the
    // transaction alive — do not await anything else between these lines.
    const existing = await store.get(CURRENT_KEY);
    if (existing !== undefined) await store.put(existing, PREVIOUS_KEY);
    await store.put(envelope, CURRENT_KEY);
    await tx.done;
  };

  let freed: string | null = null;
  try {
    freed = (await withQuotaRetry(write, freeSpaceForSave)).freed;
  } catch (error) {
    if (error instanceof StorageFullError) {
      // The one failure the player MUST hear about, because from their side of the screen a
      // world that stopped saving looks identical to a world that is saving fine.
      publishNotice({
        id: NoticeId.QuotaFull,
        tone: 'warning',
        title: 'Your world has stopped saving.',
        body: error.message,
      });
      logError(error.message, error.cause);
    }
    throw error;
  }

  if (freed !== null) {
    // Not an alarm — the save landed. But something was given up to land it, and the player
    // should hear that from the game rather than notice it later as a missing backup.
    publishNotice({
      id: NoticeId.QuotaFreed,
      tone: 'info',
      title: 'Cleared some space to save your world.',
      body:
        `This browser was nearly out of room, so the game let go of ${freed} to fit your ` +
        'save in. Your world is saved and nothing you built is affected. If this keeps ' +
        'happening, freeing up space in your browser will stop it — there is not much left ' +
        'the game can give up on its own.',
    });
  }

  // Whatever was wrong is not wrong now. Leaving a "stopped saving" card on screen above a
  // world that just saved is its own kind of lie.
  dismissNotice(NoticeId.QuotaFull);
  dismissNotice(NoticeId.WriteFailed);

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
    freed,
  };
}

/**
 * Give something up so the save can land. Returns what went, or null when nothing is left.
 *
 * The order is argued in `quota.ts`: the input trace first because it is a debugging asset and
 * the thing that actually grows without bound, then the backup copy, and never the `conflict`
 * key — that one holds a world from another device and dropping it would break cloud sync's
 * only invariant.
 *
 * ONE RUNG PER CALL, deliberately. `withQuotaRetry` retries exactly once, so a world that is
 * genuinely too big walks down the ladder one autosave at a time rather than dropping
 * everything the first time it hits a limit that might have been a transient one.
 */
async function freeSpaceForSave(): Promise<string | null> {
  const db = await getDb();

  const traces = await db.count(TRACES_STORE);
  if (traces > 0) {
    await db.clear(TRACES_STORE);
    // NOTE: `clearTrace()` is not used here, and must not be — it resets the drain cursor to
    // zero, which would make the very next save rewrite the entire in-memory trace and refill
    // the space this just freed. Leaving the cursor where it is means the game stops writing
    // trace it has already given up on. The consequence is honest and worth stating: after
    // this runs, the stored trace is no longer a complete replay of the world.
    logWarn(
      'Storage was full, so the stored input trace was dropped to make room for the save. ' +
        'The trace is no longer a complete replay for this world.',
    );
    return 'the input log it keeps for bug reports';
  }

  const tx = db.transaction(SAVES_STORE, 'readwrite');
  const store = tx.objectStore(SAVES_STORE);
  const previous = await store.get(PREVIOUS_KEY);
  if (previous !== undefined) {
    await store.delete(PREVIOUS_KEY);
    await tx.done;
    logWarn('Storage was full, so the backup save was dropped to make room for the current one.');
    return 'the spare backup copy of your world';
  }
  await tx.done;

  // Everything expendable is gone. What is left is the world itself and, if cloud sync parked
  // one, another device's world — neither of which this layer is allowed to delete.
  return null;
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
    const loaded = finish(restoreWorld(primary), source);
    if (source === 'previous') {
      // `current` was not there at all. The overwhelmingly likely cause is a write that was
      // interrupted between the rotate and the put — a killed tab, a crashed browser, a phone
      // that decided the page had had its turn. This is the crash-recovery path, and it is
      // the one the player is owed an explanation for.
      logWarn('The main save was missing. Loaded the backup copy instead.');
      publishNotice(recoveredNotice('missing', false));
    }
    return loaded;
  } catch (error) {
    if (error instanceof SaveFormatTooNewError) {
      // Refuse, and write nothing. The player's world is fine; the tab is stale.
      logError(error.message);
      return { status: 'refused', reason: 'format-too-new', message: error.message, error };
    }

    logWarn('The saved world is unreadable. Trying the previous copy.', error);

    // Set the bad record aside BEFORE loading the backup, because the moment the backup
    // loads, the autosave clock starts and the ordinary rotation will begin overwriting the
    // evidence within a minute of active play. The original stays exactly where it is; this
    // is a copy into a store nothing else touches.
    const filed = await quarantineRecord({ slot: source, record: primary, error });

    const hasBackup = source === 'current' && fallback !== undefined;
    if (hasBackup) {
      try {
        const recovered = finish(restoreWorld(fallback), 'previous');
        logWarn('Recovered from the previous save. Some progress was lost.');
        publishNotice(recoveredNotice('unreadable', filed === 'quarantined'));
        return recovered;
      } catch (fallbackError) {
        logError('The previous save is unreadable too.', fallbackError);
        await quarantineRecord({ slot: PREVIOUS_KEY, record: fallback, error: fallbackError });
      }
    }

    // As bad as it gets here. The message says exactly what was done with the remains and —
    // because §8's cut-forever list has no "start fresh" button on it — never offers to wipe
    // anything.
    //
    // The two wordings are not decoration. Telling a player the backup also failed when there
    // was no backup to fail is a small lie about their disk, and it is the kind that sends
    // somebody looking for a second copy that never existed.
    const message = hasBackup
      ? 'Your saved world could not be read, and neither could the backup copy. Nothing has ' +
        'been deleted or overwritten — both are still on disk exactly as they were found, and ' +
        'copies have been set aside so they can be looked at. Reloading is worth a try; if it ' +
        'keeps happening, this is worth reporting rather than starting over.'
      : 'Your saved world could not be read, and there was no backup copy to fall back on. ' +
        'Nothing has been deleted or overwritten — it is still on disk exactly as it was ' +
        'found, and a copy has been set aside so it can be looked at. Reloading is worth a ' +
        'try; if it keeps happening, this is worth reporting rather than starting over.';
    logError(message);
    return { status: 'refused', reason: 'unreadable', message, error };
  }
}

/**
 * The words for "your last save did not make it, here is the one before".
 *
 * Written to be read by somebody whose first thought is "have I lost my factory?", so the
 * shape is: what happened, then how much it cost, then what is safe. The cost is stated as a
 * bound the player can check against their own memory ("up to a minute") rather than as a
 * tick count, which would mean nothing to them.
 */
function recoveredNotice(
  kind: 'missing' | 'unreadable',
  quarantined: boolean,
): {
  id: NoticeId;
  tone: 'info';
  title: string;
  body: string;
} {
  const opening =
    kind === 'missing'
      ? 'Your most recent save never finished being written — usually that means the tab or ' +
        'the browser closed partway through one.'
      : 'Your most recent save could not be read.';

  const kept = quarantined
    ? ' The unreadable save has been set aside rather than deleted, in case it can be ' +
      'recovered later.'
    : '';

  return {
    id: NoticeId.Recovered,
    tone: 'info',
    title: 'Picked up from your backup save.',
    body:
      `${opening} The game has loaded the backup from just before it, so you may have lost up ` +
      `to about a minute of play. Everything else is exactly where you left it.${kept}`,
  };
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
