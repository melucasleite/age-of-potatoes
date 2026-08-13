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

import { logError, logInfo, logWarn } from './log';
import { NoticeId, publishNotice } from './notices';
import { isQuotaError } from './quota';
import { type SaveResult, saveWorld } from './saves';
import { SaveRejectedError, saveRejectedMessage } from './verify';

/** 1,200 ticks at 20 Hz — 60 seconds of *active* play. */
export const AUTOSAVE_INTERVAL_TICKS = 1_200;

/** How often to look at the clock. Cheap: it reads one integer and usually returns. */
export const AUTOSAVE_POLL_MS = 1_000;

/**
 * How far the cadence stretches after a save is refused, as multiples of the interval.
 *
 * WHY THERE IS A LADDER AT ALL. A rejected save is not a transient write error — it means
 * `serialize` produced something the loader cannot read, and the world that produced it is
 * still sitting in memory producing it. Retrying on the ordinary cadence therefore fails
 * again, and again, at a cost that is nothing like a no-op: every attempt deep-copies the
 * world, stringifies it, parses it back and rebuilds it, ON THE MAIN THREAD, forever, while
 * the player is trying to play. The frankensave condition survives until a reload, so "try
 * again in a minute" is a promise the layer cannot keep and should stop making.
 *
 * It stretches rather than stopping because the other way this fires is a genuinely transient
 * fault — a half-applied hot reload settling, a world that was briefly mid-mutation — and
 * giving up permanently on a world that would save fine in five minutes is the worse mistake.
 * Capped at 16 so a long session still attempts roughly every quarter hour.
 */
export const REJECT_BACKOFF_STEPS = [1, 2, 4, 8, 16] as const;

/**
 * How long to wait after the `streak`-th consecutive refusal (0 for the first).
 *
 * Split out and exported because it is the part that can be wrong without looking wrong: an
 * off-by-one reads as "waits too long once", and a ladder that failed to cap would read as
 * "eventually stops saving", both of which are invisible until someone loses a session. The
 * wiring around it needs a browser; this does not.
 */
export function rejectBackoff(
  streak: number,
  intervalTicks: number = AUTOSAVE_INTERVAL_TICKS,
): { multiplier: number; ticks: number; minutes: number } {
  const index = Math.min(Math.max(streak, 0), REJECT_BACKOFF_STEPS.length - 1);
  const multiplier = REJECT_BACKOFF_STEPS[index]!;
  const ticks = intervalTicks * multiplier;
  // Ticks accrue only while the player is present (§6), so this is minutes of ACTIVE play —
  // the honest number, because a paused world is not failing to save, it is just not saving.
  return { multiplier, ticks, minutes: Math.round(ticks / AUTOSAVE_INTERVAL_TICKS) };
}

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

  // How many times in a row a save has been read back and refused, and the tick the cadence is
  // allowed to try again at. Both reset on any successful write — one good save means whatever
  // was wrong with the world is not wrong now, and the next fault deserves a prompt first try
  // rather than inheriting a fifteen-minute penalty from an unrelated one.
  let rejectedStreak = 0;
  let retryAtTick: number | null = null;

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
        rejectedStreak = 0;
        retryAtTick = null;
        options.onSaved?.({ ...result, reason, durationMs: Date.now() - startedAt });
        return true;
      } catch (error) {
        // A failed save is not a reason to stop the game. Log it, keep the mark where it was
        // so the next cadence tick retries, and let the player carry on.
        logError(`Autosave failed (${reason}).`, error);

        // A REFUSED SAVE IS THE ONE FAILURE THAT MUST NOT BE RETRIED ON THE ORDINARY CADENCE.
        // `saveWorld` read this save back through the real boot path and could not load it, so
        // the same world will produce the same unloadable bytes a minute from now — at the cost
        // of a full serialize, stringify, parse and rebuild each time. Stretch the cadence, and
        // say so in the same card rather than a new one, because "still broken" and "no longer
        // hammering at it" are one piece of news to the person watching.
        if (error instanceof SaveRejectedError) {
          const backoff = rejectBackoff(rejectedStreak, intervalTicks);
          rejectedStreak++;
          retryAtTick = state.tick + backoff.ticks;

          logWarn(
            `Save refused ${String(rejectedStreak)}x in a row; next attempt in ` +
              `${String(backoff.minutes)} minutes of play.`,
          );
          publishNotice({
            id: NoticeId.SaveRejected,
            tone: 'warning',
            title: 'This save was checked, and it did not pass.',
            body: saveRejectedMessage(error.reason, backoff.minutes),
          });
          options.onError?.(error, reason);
          return false;
        }

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
    // Held back after a refused save. Only the cadence waits — an explicit `flush()` still goes
    // through, because a player who just pressed save is owed an attempt and an answer, and a
    // manual save is not the thing that can loop.
    if (retryAtTick !== null && state.tick < retryAtTick) return;
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
