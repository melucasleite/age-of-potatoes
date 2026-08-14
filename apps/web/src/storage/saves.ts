// Reading and writing a world's save.
//
// IT USED TO BE "THE ONE SAVE". Work item 055 made worlds plural, and the change here is
// narrower than it sounds: the two record keys became three functions of a world id
// (`worlds.ts`), and everything else — the rotation, the refusals, the quarantine copy, the
// quota ladder — is untouched, because none of it ever cared what the records were called.
// Which world is meant comes from the registry's active id rather than from an argument, so
// `bootWorld`, `GameCanvas` and cloud sync all keep working without knowing worlds are plural.
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
//
// RULE 1 HAS A HOLE IN IT, AND `verify.ts` IS THE PATCH. Rotating the last good save into
// `previous` is only insurance if what replaces it is loadable. Hand this file two unloadable
// saves a minute apart and the rotation faithfully destroys the good record with the first and
// the evidence with the second — which is exactly what the frankensave did. So a save is now
// read back through the real boot path BEFORE the rotation is allowed to happen, and one that
// cannot be read never becomes the newest record. See `verify.ts` for why that check has to be
// the load itself rather than anything cheaper.

import {
  type RestoredWorld,
  type SaveEnvelope,
  type SimVersionCheck,
  type WorldState,
  SaveFormatTooNewError,
  restoreWorld,
  serialize,
} from '@snack/sim';

import { SAVES_STORE, TRACES_STORE, getDb, isStorageAvailable } from './db';
import { logError, logInfo, logWarn } from './log';
import { NoticeId, dismissNotice, publishNotice } from './notices';
import { describeError, quarantineRecord } from './quarantine';
import { StorageFullError, withQuotaRetry } from './quota';
import { clearTraceForWorld, drainTrace, resetTraceCursor } from './trace';
import {
  type SaveVerification,
  SaveRejectedError,
  saveRejectedMessage,
  verifySave,
} from './verify';
import {
  activeWorldId,
  conflictKeyFor,
  currentKeyFor,
  milestoneKeyFor,
  olderKeyFor,
  previousKeyFor,
  summaryOf,
  touchWorld,
  worldSeedOf,
} from './worlds';

/**
 * Ticks of active play between milestone writes — 12,000 at 20 Hz is ten minutes, ten times
 * the autosave cadence.
 *
 * WHY A MILESTONE SLOT EXISTS AT ALL. The three rolling slots are written a minute apart, so
 * they are three photographs of the same sixty seconds — good odds against a torn write,
 * poor odds against anything that was quietly wrong for five minutes before it was noticed.
 * The milestone is the copy from a usefully different moment. It is a floor on the loss, not
 * a second parachute: recovering from it costs up to ten minutes of play, which the notice
 * says out loud.
 */
export const MILESTONE_INTERVAL_TICKS = 12_000;

/**
 * The record operations, behind an interface.
 *
 * NOT AN ABSTRACTION FOR ITS OWN SAKE. Two worlds that quietly overwrite each other is the
 * failure this whole item exists to avoid, and it is invisible from the outside — both worlds
 * load, both look fine, and one of them is the other. That is exactly the kind of thing worth
 * a test, and there is no IndexedDB in this workspace's test environment. So the rotation and
 * the fallback read run against a swappable store, `memorySaveStore()` stands in for the disk,
 * and `worlds.test.ts` exercises the REAL logic rather than a restatement of it.
 *
 * `rotate` is one method rather than a get and two puts because it must be one transaction —
 * see rule 1 above. An interface that let a caller do it in pieces would let a caller do it
 * wrong.
 */
/** The slots one world's saves rotate through, newest first in the order declared. */
export interface SlotRecords {
  current?: SaveEnvelope;
  previous?: SaveEnvelope;
  older?: SaveEnvelope;
  milestone?: SaveEnvelope;
}

/** The slots the quota ladder and the tests may drop. `current` is never droppable. */
export type DroppableSlot = 'previous' | 'older' | 'milestone';

export interface SaveRecordStore {
  read(worldId: string): Promise<SlotRecords>;
  /**
   * Push the rolling slots down one — `previous` into `older`, `current` into `previous` —
   * then write `envelope` as `current`. Atomic.
   */
  rotate(worldId: string, envelope: SaveEnvelope): Promise<void>;
  /** The tick stamped on the milestone record, or null when there is none (or no stamp). */
  milestoneTick(worldId: string): Promise<number | null>;
  /** Write the milestone slot. Separate from `rotate` because its cadence is its own. */
  writeMilestone(worldId: string, envelope: SaveEnvelope): Promise<void>;
  /** Drop one backup slot. True when there was a record to drop. */
  drop(worldId: string, slot: DroppableSlot): Promise<boolean>;
  /** Drop every record belonging to one world, including the cloud parking slot. */
  clear(worldId: string): Promise<void>;
}

function slotKeyFor(worldId: string, slot: DroppableSlot): string {
  if (slot === 'previous') return previousKeyFor(worldId);
  if (slot === 'older') return olderKeyFor(worldId);
  return milestoneKeyFor(worldId);
}

/** The real one. Every method is one IndexedDB transaction. */
export const idbSaveStore: SaveRecordStore = {
  async read(worldId) {
    const db = await getDb();
    const tx = db.transaction(SAVES_STORE, 'readonly');
    const store = tx.objectStore(SAVES_STORE);
    const current = await store.get(currentKeyFor(worldId));
    const previous = await store.get(previousKeyFor(worldId));
    const older = await store.get(olderKeyFor(worldId));
    const milestone = await store.get(milestoneKeyFor(worldId));
    await tx.done;
    return { current, previous, older, milestone };
  },

  async rotate(worldId, envelope) {
    const db = await getDb();
    const tx = db.transaction(SAVES_STORE, 'readwrite');
    const store = tx.objectStore(SAVES_STORE);
    // Rotate before overwriting, inside the transaction, so a crash mid-write cannot leave
    // both records damaged. Deepest slot first, so a torn transaction can only ever have
    // moved a record DOWN, never lost one. Every await here is an IDB request, which is what
    // keeps the transaction alive — do not await anything else between these lines.
    const previous = await store.get(previousKeyFor(worldId));
    if (previous !== undefined) await store.put(previous, olderKeyFor(worldId));
    const existing = await store.get(currentKeyFor(worldId));
    if (existing !== undefined) await store.put(existing, previousKeyFor(worldId));
    await store.put(envelope, currentKeyFor(worldId));
    await tx.done;
  },

  async milestoneTick(worldId) {
    const db = await getDb();
    const milestone = await db.get(SAVES_STORE, milestoneKeyFor(worldId));
    const tick: unknown = milestone === undefined ? undefined : milestone.tick;
    return typeof tick === 'number' && Number.isFinite(tick) ? tick : null;
  },

  async writeMilestone(worldId, envelope) {
    const db = await getDb();
    await db.put(SAVES_STORE, envelope, milestoneKeyFor(worldId));
  },

  async drop(worldId, slot) {
    const db = await getDb();
    const key = slotKeyFor(worldId, slot);
    const tx = db.transaction(SAVES_STORE, 'readwrite');
    const store = tx.objectStore(SAVES_STORE);
    const record = await store.get(key);
    if (record !== undefined) await store.delete(key);
    await tx.done;
    return record !== undefined;
  },

  async clear(worldId) {
    const db = await getDb();
    const tx = db.transaction(SAVES_STORE, 'readwrite');
    const store = tx.objectStore(SAVES_STORE);
    await store.delete(currentKeyFor(worldId));
    await store.delete(previousKeyFor(worldId));
    await store.delete(olderKeyFor(worldId));
    await store.delete(milestoneKeyFor(worldId));
    await store.delete(conflictKeyFor(worldId));
    await tx.done;
  },
};

/**
 * A store in a Map, for tests. Keyed by the same key functions the real one uses, so a routing
 * mistake shows up here exactly as it would on disk.
 */
export function memorySaveStore(
  seed: Iterable<[string, SaveEnvelope]> = [],
): SaveRecordStore & { keys(): string[] } {
  const records = new Map<string, SaveEnvelope>(seed);
  return {
    read(worldId) {
      return Promise.resolve({
        current: records.get(currentKeyFor(worldId)),
        previous: records.get(previousKeyFor(worldId)),
        older: records.get(olderKeyFor(worldId)),
        milestone: records.get(milestoneKeyFor(worldId)),
      });
    },
    rotate(worldId, envelope) {
      const previous = records.get(previousKeyFor(worldId));
      if (previous !== undefined) records.set(olderKeyFor(worldId), previous);
      const existing = records.get(currentKeyFor(worldId));
      if (existing !== undefined) records.set(previousKeyFor(worldId), existing);
      records.set(currentKeyFor(worldId), envelope);
      return Promise.resolve();
    },
    milestoneTick(worldId) {
      const milestone = records.get(milestoneKeyFor(worldId));
      const tick: unknown = milestone === undefined ? undefined : milestone.tick;
      return Promise.resolve(typeof tick === 'number' && Number.isFinite(tick) ? tick : null);
    },
    writeMilestone(worldId, envelope) {
      records.set(milestoneKeyFor(worldId), envelope);
      return Promise.resolve();
    },
    drop(worldId, slot) {
      return Promise.resolve(records.delete(slotKeyFor(worldId, slot)));
    },
    clear(worldId) {
      records.delete(currentKeyFor(worldId));
      records.delete(previousKeyFor(worldId));
      records.delete(olderKeyFor(worldId));
      records.delete(milestoneKeyFor(worldId));
      records.delete(conflictKeyFor(worldId));
      return Promise.resolve();
    },
    keys() {
      return [...records.keys()].sort();
    },
  };
}

/** Which world's records to touch, and where they live. Defaults to the active world. */
export interface SaveTarget {
  worldId?: string;
  store?: SaveRecordStore;
  /**
   * How to turn the world into an envelope. Defaults to the sim's `serialize`.
   *
   * A TEST SEAM, and the same kind as `store` above rather than a new idea. The guard this file
   * now runs exists because a *broken serializer* once produced a save nothing could load, so
   * the only honest test of it is one that hands `saveWorld` a broken serializer and checks
   * that the previous record survived. `serialize` is a module import, so without this the test
   * would have to mock the sim's whole module graph to reach the one function — which tests the
   * mock rather than this file. Nothing in the game ever passes it.
   */
  serialize?: (state: WorldState) => SaveEnvelope;
}

/**
 * Resolve the target, or throw.
 *
 * Throwing is right here and nowhere else in this file: a save with no world to save into is a
 * programming error, not a survivable disk condition. `loadWorld` catches it and turns it into
 * a readable refusal, which is the shape every other failure in here already has.
 */
async function resolveWorld(target: SaveTarget): Promise<string> {
  const id = target.worldId ?? (await activeWorldId());
  if (id === null) {
    throw new Error('snack-mogul: no world is active, so there is nothing to save or load.');
  }
  return id;
}

/** The slot a world was loaded from. Anything but `current` means a fallback happened. */
export type SlotName = 'current' | 'previous' | 'older' | 'milestone';

export interface LoadedWorld {
  status: 'loaded';
  state: WorldState;
  /** The envelope after migration. */
  envelope: SaveEnvelope;
  /** Anything but `current` means the newest record was unreadable and a parachute opened. */
  source: SlotName;
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
  /**
   * `no-world` is work item 055's addition and the least alarming of the four: no lot is
   * selected, so there is nothing to load. It exists so that boot can REFUSE rather than
   * inventing a world — the old behaviour, where an empty database silently became a fixed-seed
   * lot, is exactly what the front door replaces.
   */
  reason: 'format-too-new' | 'unreadable' | 'unavailable' | 'no-world';
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
  /**
   * What the read-back check cost, in milliseconds.
   *
   * Here so the dev overlay can watch it on a real machine with a real world, which is the one
   * measurement that could not be taken from a test — see the agent log on work item 041 for
   * the numbers that were. If this ever stops being a rounding error, sampling the check rather
   * than running it every time is the lever, and this number is how that decision gets made
   * from evidence instead of from nerves.
   */
  verifyMs: number;
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
export async function saveWorld(state: WorldState, target: SaveTarget = {}): Promise<SaveResult> {
  const envelope = (target.serialize ?? serialize)(state);
  const worldId = await resolveWorld(target);
  const store = target.store ?? idbSaveStore;

  // THE GUARD, AND IT IS BEFORE THE WRITE RATHER THAN AFTER IT. Read the save back through the
  // real boot path first; only a save that loads is allowed to become the newest record. After
  // the write would be too late — the rotation would already have pushed the last good save
  // down a slot to make room for one that cannot be read.
  const verification = verifySave(envelope, state);
  if (!verification.ok) {
    await rejectSave(worldId, envelope, verification);
  }

  const write = (): Promise<void> => store.rotate(worldId, envelope);

  let freed: string | null = null;
  try {
    freed = (await withQuotaRetry(write, () => freeSpaceForSave(worldId, store))).freed;
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

  // Refresh the card. AFTER the write, so the front door describes what is actually on disk —
  // a card promising money the save does not contain is worse than a stale one. Best-effort by
  // construction: `touchWorld` never throws, because a card is not worth a failed save.
  await touchWorld(worldId, {
    ...summaryOf(state),
    formatVersion: envelope.formatVersion,
  });

  // The milestone, on its own longer cadence. AFTER the rotation and best-effort, because the
  // milestone is insurance on top of a save that has already landed — a failure here must not
  // turn a successful save into a failed one, and it must not run the quota ladder either
  // (dropping a backup to fit a backup is circular). SKIPPED ENTIRELY when this save only
  // landed because the ladder freed something: spending the just-reclaimed room on a backup
  // would re-create the squeeze on the very next save, possibly with the milestone as the
  // thing that was freed.
  if (freed === null) await writeMilestoneIfDue(worldId, envelope, store);

  return {
    tick: envelope.tick,
    // Not stringified a second time: the check above already did it, and the world is not worth
    // serialising twice to count the same characters.
    bytes: verification.bytes,
    traceEntriesWritten,
    freed,
    verifyMs: verification.durationMs,
  };
}

/**
 * A save failed its read-back. File it, say so, and refuse — writing nothing.
 *
 * Always throws. Returning `never` rather than a result is the point: there is no path out of
 * here that reaches the rotation, because the entire value of the check is that a save which
 * cannot be loaded never becomes the newest record.
 */
async function rejectSave(
  worldId: string,
  envelope: SaveEnvelope,
  verification: SaveVerification,
): Promise<never> {
  const failure = verification.failure!;
  const message = saveRejectedMessage(failure.reason, null);

  logError(
    `The save for world ${worldId} could not be read back and was NOT written. The previous ` +
      'record is still the newest one.',
    failure.error,
  );

  // Keep the rejected bytes. They are the only copy of the evidence — the record was never
  // written, so unlike a load failure there is nothing left on disk to go back to afterwards,
  // which makes this copy the whole investigation rather than a convenience.
  //
  // ONCE PER SESSION PER FAULT, and the reason is specific rather than tidiness: the quarantine
  // store dedupes on a fingerprint that includes the tick, and a world that is still being
  // played has a different tick every single time this fires. So the dedupe that stops five
  // reloads filing five copies is exactly no help here, and without this the layer would file a
  // fresh 25 KB record every backoff interval, for hours, into a database whose being full is
  // one of the things that could have caused this. The second copy is the same bug one minute
  // later; it is not evidence, it is just weight.
  const described = describeError(failure.error);
  const signature = `${worldId}:${failure.reason}:${described.name}:${described.message}`;
  if (!rejectedWritesFiled.has(signature)) {
    rejectedWritesFiled.add(signature);
    await quarantineRecord({
      // A LABEL, NOT A KEY. Nothing was ever stored under this name and nothing ever will be —
      // it exists so triage can tell a save that was refused on the way out from one that broke
      // on the way in, which are different bugs with the same symptom.
      slot: `w:${worldId}:rejected-write`,
      record: envelope,
      error: failure.error,
    });
  }

  publishNotice({
    id: NoticeId.SaveRejected,
    tone: 'warning',
    title: 'This save was checked, and it did not pass.',
    body: message,
  });

  throw new SaveRejectedError(message, failure.reason, failure.error);
}

/**
 * Faults already filed this session. Reset on reload, deliberately — a new page load may be a
 * new build, and the first failure under a build that has changed is worth keeping again.
 */
const rejectedWritesFiled = new Set<string>();

/**
 * The milestone tick each store last saw per world, so the ordinary autosave does not pay an
 * IndexedDB read of a full envelope every minute just to learn a number that has not moved.
 *
 * KEYED BY STORE INSTANCE, not module-wide: tests hand `saveWorld` fresh memory stores for the
 * same world id, and a module-level map would let one test's milestone suppress another's. A
 * `WeakMap` means a discarded store takes its memo with it.
 */
const milestoneMemo = new WeakMap<SaveRecordStore, Map<string, number>>();

async function writeMilestoneIfDue(
  worldId: string,
  envelope: SaveEnvelope,
  store: SaveRecordStore,
): Promise<void> {
  try {
    let memo = milestoneMemo.get(store);
    if (memo === undefined) {
      memo = new Map();
      milestoneMemo.set(store, memo);
    }
    const last = memo.has(worldId) ? memo.get(worldId)! : await store.milestoneTick(worldId);

    // Due when there is no milestone yet, when the interval has elapsed — or when the world's
    // tick is BEHIND the stored milestone, which means the milestone on disk is from a
    // timeline that failed to load (had it loaded, the ladder would have picked it — it was
    // the newest record). A copy of it is in quarantine; the slot should track the world that
    // is actually being played.
    const due =
      last === null || envelope.tick - last >= MILESTONE_INTERVAL_TICKS || envelope.tick < last;
    if (!due) {
      if (!memo.has(worldId)) memo.set(worldId, last);
      return;
    }

    await store.writeMilestone(worldId, envelope);
    memo.set(worldId, envelope.tick);
  } catch (error) {
    // The save itself landed; this is the backup of a backup. Say so to the developer and move
    // on — the next due save will try again.
    logWarn('The milestone backup could not be written. The main save is unaffected.', error);
  }
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
async function freeSpaceForSave(worldId: string, store: SaveRecordStore): Promise<string | null> {
  // ONLY THIS WORLD'S BACKUPS, never another world's. A player whose second lot is running out
  // of room has not consented to their first lot losing its parachute, and a ladder that
  // reached across worlds would mean the cost of a big factory is paid by a small one. The
  // trace store below is the exception, and it is the right one: it is shared, it is explicitly
  // the cheapest thing in the database to lose, and it is not a world.
  //
  // Guarded rather than assumed, so a swappable store (tests, and any future non-IDB backend)
  // can still walk the slot rungs below when there is no trace store to clear.
  if (isStorageAvailable()) {
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
  }

  // The slots, oldest first — which is also cheapest-loss first, because an older copy is a
  // copy more autosaves have already superseded. `previous` goes last of the three: it is the
  // parachute for the very next torn write, so it is the most expensive backup to be without.
  if (await store.drop(worldId, 'older')) {
    logWarn('Storage was full, so the oldest rolling backup was dropped to make room.');
    return 'the oldest of the rolling backup copies of your world';
  }

  if (await store.drop(worldId, 'milestone')) {
    logWarn('Storage was full, so the milestone backup was dropped to make room.');
    return 'the long-term backup copy of your world';
  }

  if (await store.drop(worldId, 'previous')) {
    logWarn('Storage was full, so the backup save was dropped to make room for the current one.');
    return 'the spare backup copy of your world';
  }

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
export async function loadWorld(target: SaveTarget = {}): Promise<LoadOutcome> {
  // "Storage is unavailable" is a statement about the DEFAULT driver, so an explicitly supplied
  // store answers the question by existing. Without this, every test would refuse before it
  // reached a line worth testing.
  if (target.store === undefined && !isStorageAvailable()) {
    const message = 'IndexedDB is not available, so this world cannot be saved or loaded.';
    logWarn(message);
    return { status: 'refused', reason: 'unavailable', message };
  }

  let records: SlotRecords;
  let worldId: string;
  try {
    worldId = await resolveWorld(target);
    records = await (target.store ?? idbSaveStore).read(worldId);
  } catch (error) {
    const message = 'Could not open the save database. Play continues, but nothing will save.';
    logError(message, error);
    return { status: 'refused', reason: 'unavailable', message, error };
  }

  // Every slot that holds anything, NEWEST FIRST BY TICK rather than by slot name. Slot order
  // and tick order usually agree, but the milestone runs on its own cadence: the moment it is
  // written it carries the same tick as `current` and a newer one than `older`, so "newest good
  // slot wins" has to mean the tick on the record, not the name on the key. The sort is stable,
  // so a tie keeps the declared slot priority.
  const slotOrder: SlotName[] = ['current', 'previous', 'older', 'milestone'];
  const candidates = slotOrder
    .map((slot) => ({ slot, envelope: records[slot] }))
    .filter(
      (entry): entry is { slot: SlotName; envelope: SaveEnvelope } => entry.envelope !== undefined,
    )
    .sort((a, b) => tickOf(b.envelope) - tickOf(a.envelope));

  if (candidates.length === 0) {
    logInfo('No saved world found. Starting fresh.');
    return { status: 'empty' };
  }

  let failures = 0;
  let quarantinedAny = false;
  let lastError: unknown;

  for (const { slot, envelope } of candidates) {
    try {
      const loaded = finish(restoreWorld(envelope), slot);
      if (slot !== 'current') {
        // Either `current` was never there (a write interrupted between the rotate and the
        // put — a killed tab, a crashed browser, a phone that decided the page had had its
        // turn), or it was there and would not read, in which case a copy has just been set
        // aside. Both are the crash-recovery path, and both owe the player an explanation.
        const kind = failures > 0 ? 'unreadable' : 'missing';
        logWarn(`Recovered from the ${slot} save record. Some progress was lost.`);
        publishNotice(recoveredNotice(kind, quarantinedAny, slot));
      }
      return loaded;
    } catch (error) {
      if (error instanceof SaveFormatTooNewError) {
        // Refuse, and write nothing — and do NOT fall through to an older slot. The player's
        // world is fine; the tab is stale. Booting an older copy in a stale tab would start
        // an autosave that rotates the future save down the ladder and, three saves later,
        // off the end of it.
        logError(error.message);
        return { status: 'refused', reason: 'format-too-new', message: error.message, error };
      }

      failures += 1;
      lastError = error;
      logWarn(`The ${slot} save record is unreadable. Trying the next slot.`, error);

      // Set the bad record aside BEFORE loading anything older, because the moment a fallback
      // loads, the autosave clock starts and the ordinary rotation will begin overwriting the
      // evidence within a minute of active play. The original stays exactly where it is; this
      // is a copy into a store nothing else touches.
      // The slot label carries the world id, so triage on a player with three lots can tell
      // which one broke — and so the quarantine fingerprint cannot collide across worlds and
      // silently decide that a second broken save is "already known".
      const filed = await quarantineRecord({
        slot: quarantineLabelFor(worldId, slot),
        record: envelope,
        error,
      });
      if (filed === 'quarantined') quarantinedAny = true;
    }
  }

  // As bad as it gets here: every slot failed. The message says exactly what was done with the
  // remains and — because §8's cut-forever list has no "start fresh" button on it — never
  // offers to wipe anything.
  //
  // The two wordings are not decoration. Telling a player the backups also failed when there
  // were no backups to fail is a small lie about their disk, and it is the kind that sends
  // somebody looking for a second copy that never existed.
  const message =
    candidates.length > 1
      ? 'Your saved world could not be read, and neither could any of its backup copies. ' +
        'Nothing has been deleted or overwritten — all of them are still on disk exactly as ' +
        'they were found, and copies have been set aside so they can be looked at. Reloading ' +
        'is worth a try; if it keeps happening, this is worth reporting rather than starting ' +
        'over.'
      : 'Your saved world could not be read, and there was no backup copy to fall back on. ' +
        'Nothing has been deleted or overwritten — it is still on disk exactly as it was ' +
        'found, and a copy has been set aside so it can be looked at. Reloading is worth a ' +
        'try; if it keeps happening, this is worth reporting rather than starting over.';
  logError(message);
  return { status: 'refused', reason: 'unreadable', message, error: lastError };
}

/** The stamped tick, or -1 for a record too broken to carry one — which sorts it last. */
function tickOf(envelope: SaveEnvelope): number {
  const tick: unknown = envelope.tick;
  return typeof tick === 'number' && Number.isFinite(tick) ? tick : -1;
}

/** The on-disk key the record was read from, which is what triage wants to see. */
function quarantineLabelFor(worldId: string, slot: SlotName): string {
  if (slot === 'current') return currentKeyFor(worldId);
  if (slot === 'previous') return previousKeyFor(worldId);
  if (slot === 'older') return olderKeyFor(worldId);
  return milestoneKeyFor(worldId);
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
  slot: SlotName,
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

  // The bound is per slot and stated as time the player can check against their own memory,
  // never as a tick count. Overstating is safer than understating — "up to" is a ceiling.
  const cost =
    slot === 'milestone'
      ? 'the longer-term backup from a little earlier, so you may have lost up to about ten ' +
        'minutes of play'
      : slot === 'older'
        ? 'an earlier backup, so you may have lost up to a few minutes of play'
        : 'the backup from just before it, so you may have lost up to about a minute of play';

  const kept = quarantined
    ? ' The unreadable save has been set aside rather than deleted, in case it can be ' +
      'recovered later.'
    : '';

  return {
    id: NoticeId.Recovered,
    tone: 'info',
    title: 'Picked up from your backup save.',
    body: `${opening} The game has loaded ${cost}. Everything else is exactly where you left it.${kept}`,
  };
}

function finish(restored: RestoredWorld, source: SlotName): LoadedWorld {
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
 * Delete one world's records and its trace.
 *
 * STILL NOT THE DELETE BUTTON. The front door's delete is `deleteWorld` in `worlds.ts`, which
 * tombstones the registry entry and leaves every byte of the save where it is for two weeks;
 * this is the collection that eventually follows, plus DevTools and tests. The distinction is
 * the whole reason deleting a world is recoverable — one of these two functions is reversible
 * and the other is not, and the player only ever presses the reversible one.
 */
export async function clearSavedWorld(target: SaveTarget = {}): Promise<void> {
  const worldId = await resolveWorld(target);
  // The seed before the records, because the seed is how the trace store knows whose batches
  // are whose and the registry is the only thing that still remembers it once the save is gone.
  const seed = await worldSeedOf(worldId);
  await (target.store ?? idbSaveStore).clear(worldId);
  if (seed !== null) await clearTraceForWorld(seed);
  logWarn('Cleared the saved world.');
}

/** The raw stored envelopes, unmigrated, for the dev overlay and for bug reports. */
export async function readRawSaves(target: SaveTarget = {}): Promise<SlotRecords> {
  const worldId = await resolveWorld(target);
  return (target.store ?? idbSaveStore).read(worldId);
}
