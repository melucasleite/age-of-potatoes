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
  SAVES_STORE,
  TRACES_STORE,
  closeDb,
  isStorageAvailable,
} from './db';
export type { TraceBatch } from './db';
export { requestPersistentStorage } from './persist';
export type { PersistenceResult } from './persist';
export { clearSavedWorld, loadWorld, readRawSaves, saveWorld } from './saves';
export type { LoadOutcome, LoadedWorld, NoSavedWorld, RefusedWorld, SaveResult } from './saves';
export { clearTrace, drainTrace, exportTrace, readTrace, tracePersistedCount } from './trace';

import { type WorldState, createWorld } from '@snack/sim';

import { type PersistenceResult, requestPersistentStorage } from './persist';
import { type LoadOutcome, loadWorld } from './saves';
import { clearTrace } from './trace';
import { logWarn } from './log';

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

  return { state, fresh: true, outcome, persistence };
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
