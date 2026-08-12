// `navigator.storage.persist()`, called once at startup.
//
// WITHOUT IT, SAFARI EVICTS INDEXEDDB AFTER EXTENDED NON-USE. That does not present to the
// player as a storage-policy nuance. It presents as *"my factory vanished."* For a game whose
// entire meta-design rests on §6's one persistent world per player, and whose returning-player
// card promises "your factory is exactly where you left it", that is the worst bug the product
// can have.
//
// The call is one line. It may be granted silently based on engagement, denied silently, or
// unsupported — so log the result either way, because "did the browser actually agree to keep
// this?" is a question worth being able to answer later.

import { logInfo, logWarn } from './log';

export interface PersistenceResult {
  /** Whether the browser implements the Storage API at all. */
  supported: boolean;
  /** Whether storage is persistent now — the only field most callers need. */
  persisted: boolean;
  /** True when it was already granted before this call, so nothing was prompted. */
  alreadyGranted: boolean;
  /** Bytes used and available, when the browser will say. Both undefined otherwise. */
  usageBytes?: number;
  quotaBytes?: number;
}

/**
 * Ask the browser to stop evicting this origin's storage.
 *
 * Safe to call more than once, and safe to call during SSR (it reports unsupported). Never
 * throws — a browser that refuses to answer is not a reason to fail to start a game.
 */
export async function requestPersistentStorage(): Promise<PersistenceResult> {
  if (typeof navigator === 'undefined' || navigator.storage === undefined) {
    logWarn('This browser has no Storage API, so saved worlds may be evicted without warning.');
    return { supported: false, persisted: false, alreadyGranted: false };
  }

  const storage = navigator.storage;
  const estimate = await measure(storage);

  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) {
      logInfo('Storage is already persistent. Saved worlds will not be evicted.', estimate);
      return { supported: true, persisted: true, alreadyGranted: true, ...estimate };
    }

    if (typeof storage.persist !== 'function') {
      logWarn('This browser cannot grant persistent storage. Saved worlds may be evicted.');
      return { supported: false, persisted: false, alreadyGranted: false, ...estimate };
    }

    const granted = await storage.persist();
    if (granted) {
      logInfo('Persistent storage granted. Saved worlds will not be evicted.', estimate);
    } else {
      // Not fatal, and not worth interrupting the player over. Chrome grants this on
      // engagement, so it often flips to true on its own after a few sessions.
      logWarn(
        'Persistent storage was not granted. The browser may evict this world after a long ' +
          'gap between sessions.',
        estimate,
      );
    }
    return { supported: true, persisted: granted, alreadyGranted: false, ...estimate };
  } catch (error) {
    logWarn('Could not request persistent storage.', error);
    return { supported: true, persisted: false, alreadyGranted: false, ...estimate };
  }
}

async function measure(
  storage: StorageManager,
): Promise<{ usageBytes?: number; quotaBytes?: number }> {
  if (typeof storage.estimate !== 'function') return {};
  try {
    const { usage, quota } = await storage.estimate();
    return { usageBytes: usage, quotaBytes: quota };
  } catch {
    return {};
  }
}
