// Running out of room, and what to do about it.
//
// THE FAILURE THIS PREVENTS: a browser at its storage limit rejects the autosave, the catch in
// `autosave.ts` writes a line to a console nobody has open, and the player keeps building for
// another two hours on a world that has not been written to disk since lunchtime. Everything
// looks perfect. Nothing is being saved. That is the exact shape work item 041 calls out —
// "a silent failure is worse than a visible one because the player keeps playing."
//
// THE LADDER, cheapest loss first. When the disk says no, something has to go, and the order
// is not arbitrary:
//
//   1. THE INPUT TRACE. It is a debugging asset (plan §12: seed + trace reproduces a bug
//      exactly), it is the thing that actually grows without bound over a long world, and it
//      is therefore both the likeliest cause of the squeeze and the cheapest thing to lose.
//      A bug report is worth a lot. It is not worth the world it is a report about.
//   2. THE BACKUP COPY. `previous` is the parachute for a torn write. Dropping it trades a
//      hypothetical future crash for a certain present save, which is the right trade when
//      the alternative is not saving at all — but only after the trace is gone.
//
// `conflict` is NOT on the ladder and must never be. `cloudHandoff.ts` holds one invariant —
// no envelope is ever destroyed — and that key is where a displaced world from another device
// is parked. Freeing space by deleting a world defeats the entire point of freeing space.
//
// RETRY EXACTLY ONCE. Not a loop. A retry loop against a full disk is an infinite loop with
// extra steps, and each pass costs a full serialize of the world on the main thread.

/**
 * A quota failure that survived the retry, carrying wording fit for a human.
 *
 * The message is the player-facing one on purpose: it travels up through `autosave.ts` and
 * whatever else catches a save error, and at no point does anyone have to translate it.
 */
export class StorageFullError extends Error {
  /** What was dropped trying to make room, or null if there was nothing left to drop. */
  readonly freed: string | null;

  /**
   * The browser's original rejection rides along as the standard `cause`, which is doing real
   * work rather than being tidy: `isQuotaError` walks the cause chain, so anything that
   * catches one of these upstream still recognises it as a quota problem and does not publish
   * a second, more generic "something went wrong" notice on top of the specific one.
   */
  constructor(message: string, freed: string | null, cause: unknown) {
    super(message, { cause });
    this.name = 'StorageFullError';
    this.freed = freed;
  }
}

/**
 * Is this the browser saying "no room"?
 *
 * Duck-typed rather than `instanceof DOMException`, because the same condition arrives with a
 * different shape in every engine: Chrome throws a `DOMException` named `QuotaExceededError`,
 * Firefox has historically used `NS_ERROR_DOM_QUOTA_REACHED` with code 1014, Safari has been
 * known to reject with a plain `Error` whose message is the only clue, and `idb` may hand back
 * the transaction's abort error with the real one hanging off `cause`. Guessing wrong here
 * means the ladder never runs, so this is deliberately generous.
 */
export function isQuotaError(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== 'object') return false;

  const candidate = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };

  if (typeof candidate.name === 'string') {
    const name = candidate.name;
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  }
  // 22 is DOMException.QUOTA_EXCEEDED_ERR; 1014 is Firefox's legacy code.
  if (candidate.code === 22 || candidate.code === 1014) return true;

  if (typeof candidate.message === 'string') {
    const message = candidate.message.toLowerCase();
    if (message.includes('quota') || message.includes('storage is full')) return true;
  }

  // One hop down the cause chain, bounded so a self-referencing cause cannot spin.
  if (depth < 3 && candidate.cause !== undefined && candidate.cause !== null) {
    return isQuotaError(candidate.cause, depth + 1);
  }

  return false;
}

export interface QuotaRetryOutcome<T> {
  value: T;
  /**
   * A plain-language description of what was dropped to make room, or null when the first
   * attempt simply worked. Non-null means the save landed but something was sacrificed.
   */
  freed: string | null;
}

/**
 * Run `attempt`. If the browser says it is out of room, drop something and run it once more.
 *
 * `freeSpace` returns a human phrase for what it dropped, or null when there is nothing left
 * to drop — in which case there is no point retrying and this throws immediately with the
 * wording the player should see.
 *
 * Errors that are not quota errors pass straight through untouched. A corrupt-write bug must
 * not be mistaken for a full disk and "fixed" by deleting the backup.
 */
export async function withQuotaRetry<T>(
  attempt: () => Promise<T>,
  freeSpace: () => Promise<string | null>,
): Promise<QuotaRetryOutcome<T>> {
  try {
    return { value: await attempt(), freed: null };
  } catch (error) {
    if (!isQuotaError(error)) throw error;

    let freed: string | null = null;
    try {
      freed = await freeSpace();
    } catch {
      // Even the cleanup failed. Nothing more to try; fall through to the honest message.
      freed = null;
    }

    if (freed === null) throw new StorageFullError(storageFullMessage(null), null, error);

    try {
      return { value: await attempt(), freed };
    } catch (retryError) {
      if (!isQuotaError(retryError)) throw retryError;
      throw new StorageFullError(storageFullMessage(freed), freed, retryError);
    }
  }
}

/**
 * What to tell the player when the disk is full and the save did not land.
 *
 * Exported because it is the wording, and wording is worth testing. Note what it does NOT say:
 * no error name, no byte counts, no mention of IndexedDB. It says which world is safe, what is
 * not being written, and the one thing a player can actually do about it.
 */
export function storageFullMessage(freed: string | null): string {
  const opening =
    freed === null
      ? 'This browser has run out of room, so your last few minutes of play could not be saved.'
      : `This browser has run out of room. The game cleared out ${freed} to try to make ` +
        'space, and it still would not fit, so your last few minutes of play could not be saved.';

  return (
    `${opening} Your earlier save is safe and has not been touched — nothing you built before ` +
    'now is lost. Freeing up space in your browser (clearing site data for other sites, or ' +
    'emptying the downloads folder on a phone) usually fixes it. Keep playing: the game will ' +
    'try again in about a minute.'
  );
}
