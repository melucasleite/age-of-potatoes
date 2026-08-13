// Autosave.
//
// THE CADENCE IS COUNTED IN TICKS, NOT SECONDS. §6 says ticks accrue only while the player is
// present, so an AFK or paused world stops advancing and therefore correctly stops saving — a
// world that is not accruing money should not be accruing saves either. A wall-clock timer
// would keep writing an identical world to disk all night.
//
// The wall-clock `setInterval` below is only a *poll*: it looks at `state.tick` and does
// nothing at all unless the tick has moved far enough. That is the difference between the
// clock deciding when to save and the clock deciding when to look.
//
// THE CADENCE IS ALSO THE REAL GUARANTEE. The `visibilitychange` flush is best-effort and
// nothing more: an async IndexedDB write is not reliable during page teardown, and no amount
// of `beforeunload` cleverness makes it so. Worst case the player loses under a minute of
// play, which is the trade §12 accepts in exchange for not blocking the main thread.

import type { WorldState } from '@snack/sim';

import { logError, logInfo } from './log';
import { NoticeId, publishNotice } from './notices';
import { isQuotaError } from './quota';
import { type SaveResult, saveWorld } from './saves';

/** 1,200 ticks at 20 Hz — 60 seconds of *active* play. */
export const AUTOSAVE_INTERVAL_TICKS = 1_200;

/** How often to look at the clock. Cheap: it reads one integer and usually returns. */
export const AUTOSAVE_POLL_MS = 1_000;

export type AutosaveReason = 'cadence' | 'hidden' | 'manual';

export interface AutosaveInfo extends SaveResult {
  reason: AutosaveReason;
  /** Milliseconds the write took, for the dev overlay. */
  durationMs: number;
}

export interface AutosaveOptions {
  /** Ticks of active play between saves. Default `AUTOSAVE_INTERVAL_TICKS`. */
  intervalTicks?: number;
  /** How often to check the tick counter, in milliseconds. Default `AUTOSAVE_POLL_MS`. */
  pollMs?: number;
  /**
   * The tick to measure the first interval from. Pass the tick a loaded save came back at so
   * a freshly restored world does not immediately rewrite itself. Defaults to whatever the
   * first poll observes.
   */
  sinceTick?: number;
  onSaved?: (info: AutosaveInfo) => void;
  onError?: (error: unknown, reason: AutosaveReason) => void;
}

export interface AutosaveHandle {
  /** Save now, regardless of the cadence. Resolves false if there was nothing to save. */
  flush(reason?: AutosaveReason): Promise<boolean>;
  /** Stop polling and detach listeners. Does not flush — call `flush()` first if you want to. */
  stop(): void;
  /** The tick of the last successful write, or null if nothing has been written yet. */
  readonly lastSavedTick: number | null;
}

/**
 * Start saving `getState()` every `intervalTicks` ticks of active play.
 *
 * `getState` returns null before the world exists, which is the normal state of things for
 * the first frame or two — the handle simply does nothing until it returns a world.
 *
 * Writes are serialised through one promise chain, so two saves can never interleave and a
 * slow write cannot stack up behind a fast poll.
 */
export function startAutosave(
  getState: () => WorldState | null,
  options: AutosaveOptions = {},
): AutosaveHandle {
  const intervalTicks = options.intervalTicks ?? AUTOSAVE_INTERVAL_TICKS;
  const pollMs = options.pollMs ?? AUTOSAVE_POLL_MS;

  let markTick: number | null = options.sinceTick ?? null;
  let lastSavedTick: number | null = null;
  let stopped = false;
  let inFlight: Promise<boolean> = Promise.resolve(false);

  const write = (reason: AutosaveReason): Promise<boolean> => {
    inFlight = inFlight.then(async () => {
      if (stopped && reason !== 'hidden' && reason !== 'manual') return false;
      const state = getState();
      if (state === null) return false;
      // Nothing has happened since the last write. Saving an identical world is pure cost.
      if (lastSavedTick !== null && state.tick === lastSavedTick) return false;

      const startedAt = Date.now();
      try {
        const result = await saveWorld(state);
        lastSavedTick = result.tick;
        markTick = result.tick;
        options.onSaved?.({ ...result, reason, durationMs: Date.now() - startedAt });
        return true;
      } catch (error) {
        // A failed save is not a reason to stop the game. Log it, keep the mark where it was
        // so the next cadence tick retries, and let the player carry on.
        logError(`Autosave failed (${reason}).`, error);

        // ...but it IS a reason to say something out loud. A quota failure has already spoken
        // for itself in `saveWorld` with wording specific to being out of room; anything else
        // gets the general version rather than a second, contradictory card.
        if (!isQuotaError(error)) {
          publishNotice({
            id: NoticeId.WriteFailed,
            tone: 'warning',
            title: 'Your world has stopped saving.',
            body:
              'Something went wrong writing your world to this browser, so the last few ' +
              'minutes of play are not saved yet. Your previous save is safe and untouched. ' +
              'The game will try again in about a minute — if this card is still here after ' +
              'that, reloading the page is the next thing to try.',
          });
        }

        options.onError?.(error, reason);
        return false;
      }
    });
    return inFlight;
  };

  const poll = (): void => {
    const state = getState();
    if (state === null) return;
    if (markTick === null) {
      markTick = state.tick;
      return;
    }
    if (state.tick - markTick < intervalTicks) return;
    // Move the mark before the write so a slow save cannot queue a second one behind it.
    markTick = state.tick;
    void write('cadence');
  };

  const timer = setInterval(poll, pollMs);

  // `visibilitychange` → hidden is the only teardown hook browsers actually honour; on
  // mobile it is often the *last* callback a page ever gets. Best-effort by construction.
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') void write('hidden');
  };
  const onPageHide = (): void => {
    void write('hidden');
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide);
  }

  logInfo(`Autosaving every ${String(intervalTicks)} ticks of active play.`);

  return {
    flush(reason: AutosaveReason = 'manual') {
      return write(reason);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onPageHide);
      }
    },
    get lastSavedTick() {
      return lastSavedTick;
    },
  };
}
