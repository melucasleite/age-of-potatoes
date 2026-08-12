// The HUD's public surface.
//
// This barrel is for the ROUTE, which wants `HudRoot` and nothing else. `GameHost` imports
// `./cadence`, `./perf` and `./store` directly instead, because pulling this file into the
// game chunk would drag the whole React tree along with it to obtain three constants.
//
// The host needs exactly three things and should not reach past them:
//   hudStore.claim / release / publishWorld / publishTool / live   — the boundary
//   perf.push                                                      — one frame sample
//   HUD_PUBLISH_EVERY_TICKS                                        — the cadence

export { default as HudRoot } from './HudRoot';
export { hudStore } from './store';
export { HUD_PUBLISH_EVERY_TICKS } from './cadence';
export { perf } from './perf';
export type { PerfSample } from './perf';
export type { HudLive, HudSnapshot } from './types';
