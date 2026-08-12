// The version key a save records itself against.
//
// BALANCE DATA IS SAVE-COMPATIBILITY SURFACE, EXACTLY AS MUCH AS CODE IS (plan §12). A save
// is only meaningful against the rules that produced it: change the Chip Kitchen's
// work-point cost and an old save's in-progress machine states describe a world that no
// longer exists, precisely as if the code had changed. Treating balance as data *outside*
// the version key is how a game quietly desyncs its own saves.
//
// So `SIM_VERSION` is the sim's code version fused with `BALANCE_HASH`, which `data.ts`
// computes over the canonical serialization of every balance number at module load. Module
// load rather than a build step on purpose: it costs microseconds, and it cannot be
// forgotten, which a build step can.
//
// Change one price in `data.ts` and `SIM_VERSION` changes. That is the feature.

import { BALANCE_HASH } from '../data';

/** The hand-maintained code version. Bump it when sim *behaviour* changes. */
export const SIM_CODE_VERSION = '0.2.0';

/**
 * What a save writes into `envelope.simVersion`: code version, `+`, balance digest.
 *
 * A mismatch on load is INFORMATIONAL, NOT LOAD-BLOCKING. A balance change does not
 * invalidate a saved world — what it invalidates is replay determinism and leaderboard
 * comparability. So the loader records it, the host logs it, the dev overlay shows it, and
 * the world loads. Refusal is reserved for a `formatVersion` from the future, which is a
 * different problem with a different correct answer.
 */
export const SIM_VERSION = `${SIM_CODE_VERSION}+${BALANCE_HASH}`;

export interface SimVersionCheck {
  /** True when the save was written by this exact code + balance combination. */
  matches: boolean;
  /** What the save recorded. */
  saved: string;
  /** What this build is. */
  current: string;
}

/** Compare a save's recorded version against this build's. Never throws; never blocks. */
export function checkSimVersion(saved: string): SimVersionCheck {
  return { matches: saved === SIM_VERSION, saved, current: SIM_VERSION };
}
