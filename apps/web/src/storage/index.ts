// The storage layer's public surface.
//
// Three calls cover the whole game loop:
//
//   const boot = await bootWorld();          // persist request + load, or a fresh world
//   if (boot.state === null) { /* show boot.outcome.message; do NOT autosave */ }
//   const autosave = startAutosave(() => stateRef.current, { sinceTick: boot.state.tick });
//
// Everything else is for the dev overlay, for tests, and for bug reports.

export { AUTOSAVE_INTERVAL_TICKS, AUTOSAVE_POLL_MS, startAutosave } from './autosave';
export type { AutosaveHandle, AutosaveInfo, AutosaveOptions, AutosaveReason } from './autosave';
export {
  CURRENT_KEY,
  DB_NAME,
  DB_VERSION,
  META_STORE,
  PREVIOUS_KEY,
  QUARANTINE_STORE,
  SAVES_STORE,
  TRACES_STORE,
  WORLDS_STORE,
  closeDb,
  isStorageAvailable,
} from './db';
export type {
  PlaySession,
  QuarantinedSave,
  TraceBatch,
  WorldRecord,
  WorldRegistry,
  WorldSummary,
} from './db';
// The world registry ([[055]]). The front door is its only UI; everything else in the game
// reaches it indirectly, through `bootWorld` and `saveWorld` resolving the active world.
export {
  REGISTRY_KEY,
  WORLD_TOMBSTONE_MS,
  activateWorld,
  activeWorld,
  activeWorldId,
  conflictKeyFor,
  createWorldRecord,
  currentKeyFor,
  deleteWorld,
  deletedWorlds,
  expiredTombstones,
  findWorld,
  freshSeed,
  invalidateRegistry,
  liveWorlds,
  milestoneKeyFor,
  newestWorld,
  nextWorldName,
  olderKeyFor,
  planLegacyAdoption,
  previousKeyFor,
  readRegistry,
  renameWorld,
  restoreDeletedWorld,
  sweepTombstones,
  withWorld,
} from './worlds';
export type { LegacyAdoption, LegacyDisk } from './worlds';
// The one wall clock in the game, kept deliberately outside the save payload and outside the
// state hash — see `session.ts`. The HUD's Welcome Back card is the only consumer.
export {
  PLAYED_ENOUGH_TICKS,
  PRESENCE_POLL_MS,
  SESSION_KEY,
  WELCOME_BACK_THRESHOLD_MS,
  deservesWelcome,
  formatTimeAway,
  readLastSession,
  recordSession,
  startPresenceClock,
} from './session';
export type { PresenceHandle } from './session';
export { requestPersistentStorage } from './persist';
export type { PersistenceResult } from './persist';
// The ordered exit ([[078]]): save → verify → only then tear down. `GameCanvas` is the one
// game caller; the types are public so its deps object stays honest.
export { performExit, saveBeforeExit } from './exit';
export type { ExitDeps } from './exit';
export { CONFLICT_KEY, adoptCloudEnvelope, readConflictEnvelope } from './cloudHandoff';
export type { AdoptOutcome } from './cloudHandoff';
export {
  MILESTONE_INTERVAL_TICKS,
  clearSavedWorld,
  idbSaveStore,
  loadWorld,
  memorySaveStore,
  readRawSaves,
  saveWorld,
} from './saves';
export type {
  DroppableSlot,
  LoadOutcome,
  LoadedWorld,
  NoSavedWorld,
  RefusedWorld,
  SaveRecordStore,
  SaveResult,
  SaveTarget,
  SlotName,
  SlotRecords,
} from './saves';
export {
  clearTrace,
  clearTraceForWorld,
  drainTrace,
  exportTrace,
  readTrace,
  tracePersistedCount,
} from './trace';
export { quarantineRecord, readQuarantine } from './quarantine';
export type { QuarantineOutcome } from './quarantine';
export { StorageFullError, isQuotaError } from './quota';
// Public for the same reason `StorageFullError` is: a caller that catches a failed save needs to
// tell "there is no room" from "this save would not have loaded", because only one of those is
// about the player's disk and they call for different words.
export { SaveRejectedError, verifySave } from './verify';
export type { SaveVerification, SaveVerifyReason } from './verify';
// The player-facing channel. The HUD subscribes to these three; storage publishes. Anything
// that renders a notice needs `dismissNotice` too — a card with no way to close it is a card
// the player resents by the third look.
export {
  NoticeId,
  dismissNotice,
  noticeSnapshot,
  publishNotice,
  resetNotices,
  serverNoticeSnapshot,
  subscribeNotices,
} from './notices';
export type { NoticeTone, SaveNotice } from './notices';

import { type WorldState, createWorld } from '@snack/sim';

// The one place cloud sync is switched on. It is `void`ed at both call sites below and is
// never awaited: work item 016's hard constraint is that no boot path may block on, await,
// or fail because of a Supabase call. `startCloudSyncIfConfigured` does not even import the
// Supabase SDK unless the env vars are set, so with no backend provisioned this costs one
// synchronous check of `process.env` and nothing else.
import { startCloudSyncIfConfigured } from '@/supabase/bootstrap';

import { type PersistenceResult, requestPersistentStorage } from './persist';
import { type LoadOutcome, loadWorld } from './saves';
import { clearTraceForWorld } from './trace';
import { logInfo, logWarn } from './log';
import { NoticeId, publishNoticeOnce } from './notices';
import type { WorldRecord } from './db';
import { activeWorld, sweepTombstones } from './worlds';

export interface BootOptions {
  /**
   * Seed for a brand-new world, overriding the active world's own.
   *
   * FOR TESTS AND FOR THE DEV OVERLAY. The ordinary path takes the seed off the registry
   * record, which New Game rolled from `crypto` — see `freshSeed` in `worlds.ts`. There is no
   * longer a default seed anywhere in this boot path, which is the point: every "new" world
   * used to be `createWorld(20260812)` and therefore the same lot, weed for weed.
   */
  seed?: number;
  /** Skip the persistence request. Only for tests. */
  skipPersistRequest?: boolean;
}

export interface BootResult {
  /**
   * The world to start the loop with, or **null when the load was refused**.
   *
   * Null is not "make a new one anyway". It means a readable save exists that this build must
   * not touch — either it came from a newer deploy or it failed to parse — and starting a
   * fresh world would let the next autosave overwrite it. Show `outcome.message` and stop.
   */
  state: WorldState | null;
  /** True when `state` is a brand-new world rather than a restored one. */
  fresh: boolean;
  outcome: LoadOutcome;
  persistence: PersistenceResult;
  /**
   * The registry record for the world that was booted, or null when none was.
   *
   * The seed, the name and the card all come from here rather than from the save, because a
   * world exists in the registry from the moment New Game mints it and does not reach the disk
   * until the first autosave lands a minute later.
   */
  world: WorldRecord | null;
}

/**
 * The whole boot sequence: ask for persistent storage, then load the active world or start it.
 *
 * WHICH WORLD IS NOT AN ARGUMENT. It comes from the registry's active id, which the front door
 * sets before it mounts anything. That is what let this change land without `GameCanvas`,
 * `GameHost` or the cloud sync layer learning that worlds became plural — every one of them
 * still asks for "the world" and still gets exactly one.
 *
 * The persistence request comes first and on every boot, not just the first — it may be
 * granted silently later on based on engagement, and asking again costs nothing.
 */
export async function bootWorld(options: BootOptions = {}): Promise<BootResult> {
  const persistence = options.skipPersistRequest
    ? { supported: false, persisted: false, alreadyGranted: false }
    : await requestPersistentStorage();

  // Collect anything the player deleted a fortnight ago. Fire and forget: it touches only
  // records whose worlds are already gone from the list, it never throws, and boot must not
  // wait on housekeeping.
  void sweepTombstones();

  const world = await activeWorld();
  if (world === null) {
    // No lot is selected. REFUSE rather than invent one — silently creating a world here is
    // precisely the behaviour the front door exists to replace, and it is how a player who
    // lost a world used to be handed an identical-looking replacement with no ceremony.
    const message = 'No lot is selected. Pick one from the front door, or start a new one.';
    logInfo(message);
    return {
      state: null,
      fresh: false,
      outcome: { status: 'refused', reason: 'no-world', message },
      persistence,
      world: null,
    };
  }

  const outcome = await loadWorld({ worldId: world.id });

  if (outcome.status === 'loaded') {
    warnIfNotPersisted(persistence);
    void startCloudSyncIfConfigured({ localTickAtBoot: outcome.state.tick });
    return { state: outcome.state, fresh: false, outcome, persistence, world };
  }

  // A refusal we must not play over: the save is intact on disk and starting fresh would
  // hand the next autosave a licence to destroy it.
  if (outcome.status === 'refused' && outcome.reason !== 'unavailable') {
    return { state: null, fresh: false, outcome, persistence, world };
  }

  // The registry's seed, not a fresh draw and never a fixed one. A world that was minted,
  // played for thirty seconds and closed before its first autosave must come back as the SAME
  // lot when the player returns to its card — the seed is what makes that true, and it has
  // been written down since the moment New Game was pressed.
  const state = createWorld(options.seed ?? world.seed);

  if (outcome.status === 'empty') {
    // Leftover batches from a previous life of this seed are just noise in a bug report. Only
    // this world's, now — wiping the whole store would take the other lots' logs with it.
    // Best-effort: a storage error here must not stop a new game.
    try {
      await clearTraceForWorld(state.worldSeed);
    } catch (error) {
      logWarn('Could not clear the old input trace.', error);
    }
  }

  // Null rather than 0: there is no envelope on disk to compare against, so a cloud save
  // has nothing to be "ahead of" and adoption is unambiguously safe. This is the new-device
  // case, and it is the one that makes sync feel like sync rather than like backup.
  void startCloudSyncIfConfigured({ localTickAtBoot: null });

  return { state, fresh: true, outcome, persistence, world };
}

/**
 * Tell a returning player, once, that this browser has not promised to keep their world.
 *
 * ONLY WHEN A SAVED WORLD CAME BACK, and that restriction is the whole design. Chrome commonly
 * declines `persist()` until a site has earned some engagement, so a brand-new player would
 * otherwise be handed a warning about losing a factory they have not built yet — during the
 * exact first minute AGENTS.md says the entire project is in service of. A player with a world
 * on disk has something to lose and is owed the heads-up; a player on their first lot is not.
 *
 * ONCE PER SESSION rather than once ever. Persistence is re-requested on every boot and may
 * flip to granted on its own, so the honest scope for "we already mentioned this" is the page
 * load — remembering it for longer would mean writing a flag to the very storage the notice is
 * about, which is a poor place to keep it.
 */
function warnIfNotPersisted(persistence: PersistenceResult): void {
  if (persistence.persisted) return;

  publishNoticeOnce({
    id: NoticeId.NotPersistent,
    tone: 'info',
    title: 'This browser has not promised to keep your world.',
    body:
      'Your factory is saved here as normal and nothing is wrong right now. But this browser ' +
      'has not marked the game as permanent, which means that if you leave it alone for a ' +
      'long stretch it may clear the save out to reclaim space. Playing every so often — or ' +
      'bookmarking or installing the game — is usually enough to convince it to keep your ' +
      'world for good.',
  });
}
