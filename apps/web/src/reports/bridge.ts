// The host's whole surface onto the reports layer. Three functions, one line each.
//
// WHY A BRIDGE RATHER THAN THREE `reportsStore.*` CALLS IN `GameHost`. Four agents are in
// this repository at once and `GameHost` is the busiest file in it. Every line of mine that
// lands there is a merge conflict waiting for somebody else's afternoon, and every detail of
// my design that leaks into it is a second place to change when the design moves. So the
// host learns three verbs and nothing else — not the store, not the slices, not the sink,
// not the cast below.
//
// THE CAST, AND WHY IT IS HERE AND NOT THERE. Work item 032's four commerce commands
// (`LoadCart`, `DispatchCart`, `CreateContract`, `CancelContract`) are not in the sim's
// `Command` union yet — see `sim-contract.ts`, which is where they are specified for
// whoever lands them. Wiring the sink anyway is safe and deliberate: `applyCommand` in
// `packages/sim/src/tick.ts` ends in `default: return false`, so a command the reducer does
// not recognise is a no-op that is never applied and never traced. The panel's buttons
// therefore become live the moment the reducer learns the verbs, with no change to this file,
// no change to the host, and no change to the panel. The cast lives in the one file that
// explains it.

import type { Command } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { reportsStore } from './store';

/**
 * Called by a starting `GameHost`, beside `hudStore.claim`.
 *
 * `worldSeed` keys the stored hourly ledger to this lot. The personal bests are NOT keyed to
 * it — plan §6's boards are about the player, so beating your own Dynasty record on a second
 * lot counts, and it would be a strange leaderboard that forgot you when you started over.
 */
export function claimReports(
  token: object,
  worldSeed: number,
  push: (command: Command) => void,
): void {
  reportsStore.claim(token, worldSeed);
  reportsStore.attachCommandSink(token, (command) => {
    push(command as unknown as Command);
  });
}

/** Called at the HUD's publish cadence with the host's reused projection buffer. */
export function publishReports(token: object, view: WorldView): void {
  reportsStore.publishWorld(token, view);
}

/** Called by a disposing `GameHost`, beside `hudStore.release`. Flushes to storage first. */
export function releaseReports(token: object): void {
  reportsStore.release(token);
}
