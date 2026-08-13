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
  PREVIOUS_KEY,
  QUARANTINE_STORE,
  SAVES_STORE,
  TRACES_STORE,
  closeDb,
  isStorageAvailable,
} from './db';
export type { QuarantinedSave, TraceBatch } from './db';
export { requestPersistentStorage } from './persist';
export type { PersistenceResult } from './persist';
export { CONFLICT_KEY, adoptCloudEnvelope, readConflictEnvelope } from './cloudHandoff';
export type { AdoptOutcome } from './cloudHandoff';
export { clearSavedWorld, loadWorld, readRawSaves, saveWorld } from './saves';
export type { LoadOutcome, LoadedWorld, NoSavedWorld, RefusedWorld, SaveResult } from './saves';
export { clearTrace, drainTrace, exportTrace, readTrace, tracePersistedCount } from './trace';
export { quarantineRecord, readQuarantine } from './quarantine';
export type { QuarantineOutcome } from './quarantine';
export { StorageFullError, isQuotaError } from './quota';
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
import { clearTrace } from './trace';
import { logWarn } from './log';
import { NoticeId, publishNoticeOnce } from './notices';

export interface BootOptions {
  /** Seed for a brand-new world. Defaults to a fresh one from `crypto`. */
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
}

/**
 * The whole boot sequence: ask for persistent storage, then load the saved world or make one.
 *
 * The persistence request comes first and on every boot, not just the first — it may be
 * granted silently later on based on engagement, and asking again costs nothing.
 */
export async function bootWorld(options: BootOptions = {}): Promise<BootResult> {
  const persistence = options.skipPersistRequest
    ? { supported: false, persisted: false, alreadyGranted: false }
    : await requestPersistentStorage();

  const outcome = await loadWorld();

  if (outcome.status === 'loaded') {
    warnIfNotPersisted(persistence);
    void startCloudSyncIfConfigured({ localTickAtBoot: outcome.state.tick });
    return { state: outcome.state, fresh: false, outcome, persistence };
  }

  // A refusal we must not play over: the save is intact on disk and starting fresh would
  // hand the next autosave a licence to destroy it.
  if (outcome.status === 'refused' && outcome.reason !== 'unavailable') {
    return { state: null, fresh: false, outcome, persistence };
  }

  const state = createWorld(options.seed ?? freshSeed());

  if (outcome.status === 'empty') {
    // Leftover trace batches from a world that no longer exists are just noise in a bug
    // report. Best-effort — a storage error here must not stop a new game.
    try {
      await clearTrace();
    } catch (error) {
      logWarn('Could not clear the old input trace.', error);
    }
  }

  // Null rather than 0: there is no envelope on disk to compare against, so a cloud save
  // has nothing to be "ahead of" and adoption is unambiguously safe. This is the new-device
  // case, and it is the one that makes sync feel like sync rather than like backup.
  void startCloudSyncIfConfigured({ localTickAtBoot: null });

  return { state, fresh: true, outcome, persistence };
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

/**
 * A seed for a new world, as a uint32.
 *
 * `Math.random` is fine on this side of the seam — host-side randomness is not sim
 * randomness, and this value becomes `worldSeed`, after which every roll in that world is
 * derived from it deterministically. `crypto` when it is there, because a world's seed is
 * permanent and worth a decent draw.
 */
function freshSeed(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    return crypto.getRandomValues(new Uint32Array(1))[0]!;
  }
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}
