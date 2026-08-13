// Reading a save back before agreeing to write it.
//
// THE INCIDENT THIS EXISTS FOR (work item 041's log, and it happened on the day the rest of the
// hardening shipped). A dev-server HMR window during the soda-line rename produced a
// FRANKENSAVE: the header was stamped by a freshly reloaded migrations module, so it claimed
// the NEW format version, while the payload was written by a STALE canonical module, so it was
// missing a field that version requires. Every gate the layer had went straight past it. The
// format check compared the stamp against itself and agreed. The header fields all parsed. The
// record wrote cleanly, rotated the last good save into `previous`, and then did it again a
// minute later — at which point both records were the same lie and the world was gone.
//
// The lesson is narrow and worth stating exactly: EVERY CHECK THAT READS THE SAVE'S OWN CLAIM
// ABOUT ITSELF IS DEFEATED BY A SAVE THAT LIES ABOUT ITSELF. A version gate cannot catch a bad
// version stamp. A shape check cannot catch a payload that has the right shape for the wrong
// version. There is exactly one check that could not be fooled, and it is not a check at all —
// it is doing the thing for real. Load it. If it loads, it is a save. If it does not, it never
// becomes the newest record.
//
// SO THE VERIFY IS THE BOOT PATH, NOT A VALIDATOR. `verifySave` calls `restoreWorld`, which is
// the identical function `loadWorld` calls on the identical kind of value — parse the envelope,
// run the migration chain, then `fromPayload`. That last step is where the frankensave actually
// died, several layers below anything a schema check would have looked at. If the boot path ever
// changes, this changes with it for free, because it is the same call. DO NOT "optimise" this
// into a cheaper structural check: the cheaper check is precisely the one that already failed.
//
// THE NAME IS BACKWARDS ON PURPOSE. The item calls this "write-then-verify", but verifying after
// writing is too late — by then the rotation has already pushed the last good save down a slot
// and the bad one is what a crash would leave behind. So the order here is serialize, verify,
// and only then write. What is verified is the serialized bytes rather than the live world,
// which is the part "re-read" was really asking for.

import { type SaveEnvelope, type WorldState, hashState, restoreWorld } from '@snack/sim';

/**
 * Why a save was refused.
 *
 * `unreadable` is the frankensave: the restore path threw. `lossy` is its quieter cousin — the
 * save loads, but into a world that is not the one that was saved, which is a corruption that
 * would otherwise present as a factory that came back subtly wrong.
 */
export type SaveVerifyReason = 'unreadable' | 'lossy';

export interface SaveVerifyFailure {
  reason: SaveVerifyReason;
  /** What the restore path threw, or an `Error` describing the mismatch for `lossy`. */
  error: unknown;
}

export interface SaveVerification {
  ok: boolean;
  /**
   * The exact JSON that was checked.
   *
   * Handed back so the caller does not stringify the world twice: `saveWorld` already needed
   * this string's length for `SaveResult.bytes`, which means the most expensive half of the
   * verify was being paid for by every save long before there was a verify.
   */
  json: string | null;
  bytes: number;
  durationMs: number;
  failure: SaveVerifyFailure | null;
}

/**
 * A save that could not be read back, and was therefore never written.
 *
 * Carries the player-facing wording as its message, like `StorageFullError` does, so nothing
 * upstream has to translate it. The original restore failure rides along as `cause`.
 */
export class SaveRejectedError extends Error {
  readonly reason: SaveVerifyReason;

  constructor(message: string, reason: SaveVerifyReason, cause: unknown) {
    super(message, { cause });
    this.name = 'SaveRejectedError';
    this.reason = reason;
  }
}

/**
 * Serialize-time proof that this save can be loaded.
 *
 * Three steps, and each one catches a different way the incident could have gone:
 *
 *   1. **Stringify.** The payload is documented as plain JSON, and cloud sync uploads it as
 *      JSON, so JSON is the format it genuinely has to survive. It is also *stricter* than the
 *      structured clone IndexedDB actually stores with — a stray `NaN`, an `Infinity`, or an
 *      `undefined` field survives a structured clone intact and is quietly mangled by JSON, so
 *      checking the looser encoding would let exactly those through to fail at the cloud
 *      boundary weeks later. A payload with a cycle or a function in it throws here, which is
 *      the correct answer rather than an accident.
 *   2. **Parse, then `restoreWorld`.** The real boot path, on the real bytes. This is the step
 *      the frankensave fails.
 *   3. **Compare hashes.** Loading is not enough; it has to load back into the *same world*. A
 *      field that `toPayload` forgets and `fromPayload` defaults would satisfy step 2 perfectly
 *      and hand the player a factory with something missing. `hashState` covers every hashed
 *      field by construction, so this needs no maintenance as the world grows — and the round
 *      trip's hash equality is already an invariant the sim's own `save.test.ts` pins, so this
 *      leans on an established guarantee rather than inventing one.
 *
 * The trace is deliberately not part of any of it: it is stored separately, it is not in the
 * payload, and it is not hashed, so `restoreWorld` is called exactly as `loadWorld` calls it —
 * with no trace at all.
 *
 * NEVER THROWS. A verify that threw would turn "this save looks wrong" into an unhandled
 * rejection at the exact moment the layer is supposed to be at its most careful.
 */
export function verifySave(envelope: SaveEnvelope, state: WorldState): SaveVerification {
  const startedAt = Date.now();

  let json: string;
  try {
    json = JSON.stringify(envelope);
  } catch (error) {
    return {
      ok: false,
      json: null,
      bytes: 0,
      durationMs: Date.now() - startedAt,
      failure: { reason: 'unreadable', error },
    };
  }

  const bytes = json.length;

  try {
    const restored = restoreWorld(JSON.parse(json));

    if (hashState(restored.state) !== hashState(state)) {
      return {
        ok: false,
        json,
        bytes,
        durationMs: Date.now() - startedAt,
        failure: {
          reason: 'lossy',
          error: new Error(
            'The saved world reads back as a different world than the one that was saved ' +
              `(${hashState(state)} going in, ${hashState(restored.state)} coming out). ` +
              'Something in the world is not making it through the save.',
          ),
        },
      };
    }

    return { ok: true, json, bytes, durationMs: Date.now() - startedAt, failure: null };
  } catch (error) {
    return {
      ok: false,
      json,
      bytes,
      durationMs: Date.now() - startedAt,
      failure: { reason: 'unreadable', error },
    };
  }
}

/**
 * What to tell the player when a save was checked and refused.
 *
 * Exported because it is the wording, and the wording is the part most likely to rot unnoticed —
 * "SaveCorruptError: expected inputCounts" renders perfectly and means nothing to the person
 * reading it. Same two rules as everything else in `notices.ts`: no jargon, and say what is safe
 * before saying what went wrong, because the honest question at this moment is "have I lost my
 * factory?" and the answer is no.
 *
 * `retryMinutes` is how long until the next attempt, or null before the cadence has stretched.
 * It lives in the wording rather than in a second card because "it is still broken" and "it has
 * stopped hammering at it" are the same piece of news to the person watching.
 */
export function saveRejectedMessage(reason: SaveVerifyReason, retryMinutes: number | null): string {
  const cause =
    reason === 'lossy'
      ? 'The game checked this save by reading it straight back, and what came back did not ' +
        'match the world it had just saved.'
      : 'The game checked this save by reading it straight back, the same way it does when it ' +
        'loads your world, and it could not read it.';

  const retry =
    retryMinutes === null
      ? ' The game will try again shortly.'
      : ` The game has stopped trying every minute and will next try in about ${String(
          retryMinutes,
        )} minutes, so it is not grinding away at something that keeps failing.`;

  return (
    'Your last save was not written, and that is deliberate rather than a fault of its own. ' +
    `${cause} So it was set aside instead of being saved over the good one. Nothing you built ` +
    'is lost and nothing has been deleted — the save from before this one is still there, ' +
    'exactly as it was, and the game is still running normally. A copy of the one that failed ' +
    `has been kept so it can be looked at.${retry} Reloading the page usually clears this; if ` +
    'it keeps happening after a reload, it is worth reporting rather than starting over.'
  );
}
