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

// --- revocation watch ([[041]] follow-up) ---------------------------------------------
//
// A GRANT IS NOT A GUARANTEE FOREVER. `requestPersistentStorage` runs once per boot and
// reports the answer at that instant. Browsers may take the promise back later — Chrome
// re-evaluates on storage pressure and on the engagement signals that granted it in the
// first place, and a revoked origin is an evictable one. Item 041's acceptance criterion
// asks for "denied OR REVOKED", and the denied half has been covered since the notice
// channel existed; this is the other half.
//
// WHY A POLL AND NOT AN EVENT. There is no revocation event to listen for. `persisted()`
// is the only way to ask, so asking occasionally is the only way to know.
//
// WHY IT ONLY RUNS WHEN THE ANSWER WAS YES. A browser that already said no has already been
// reported by `warnIfNotPersisted`, once, at boot. Polling it would be waiting for a chance
// to repeat something the player has already read and can already act on.
//
// WHY IT STOPS AFTER IT FIRES. The news does not get truer by being repeated, there is
// nothing further the player can do once told, and a timer that keeps running is a timer
// somebody has to remember to stop.

/**
 * How often the watch re-asks.
 *
 * Deliberately slow. Revocation is a housekeeping decision measured in days of non-use, not
 * a thing that happens between two potato harvests, and the only cost of noticing it late is
 * that a warning arrives a few minutes after it became true. Cheap either way — one promise
 * against an in-process flag — but a tight loop here would be pure noise.
 */
export const PERSISTENCE_POLL_MS = 5 * 60 * 1000;

let watchTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Watch a granted persistence promise, and say so if the browser takes it back.
 *
 * `onRevoked` is injected rather than imported so this file keeps knowing nothing about the
 * notice channel — the same seam `orphans.ts` uses for its money peek, and what lets the
 * watch be tested without a browser or a HUD.
 *
 * Safe to call repeatedly: a second call replaces the first rather than stacking timers.
 * Never throws, and does nothing at all outside a browser.
 */
export function startPersistenceWatch(
  persistence: PersistenceResult,
  onRevoked: () => void,
  pollMs: number = PERSISTENCE_POLL_MS,
): void {
  stopPersistenceWatch();
  if (!persistence.persisted) return;
  if (typeof navigator === 'undefined' || navigator.storage === undefined) return;
  const storage = navigator.storage;
  if (typeof storage.persisted !== 'function') return;

  watchTimer = setInterval(() => {
    void (async () => {
      let stillPersisted: boolean;
      try {
        stillPersisted = await storage.persisted();
      } catch {
        // A browser that will not answer is not a browser that revoked. Say nothing.
        return;
      }
      if (stillPersisted) return;
      stopPersistenceWatch();
      logWarn('Persistent storage was granted earlier this session and has been withdrawn.');
      onRevoked();
    })();
  }, pollMs);
}

/** Stop watching. Called from the ordered exit, and by the watch itself once it has fired. */
export function stopPersistenceWatch(): void {
  if (watchTimer === null) return;
  clearInterval(watchTimer);
  watchTimer = null;
}

/** Is the watch running? For tests and the dev overlay. */
export function persistenceWatchRunning(): boolean {
  return watchTimer !== null;
}
