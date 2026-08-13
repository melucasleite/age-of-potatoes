// The reports layer's public surface.
//
// Two audiences, and they must not import the same thing:
//
//   · THE ROUTE wants `ReportsLayer` and nothing else.
//   · THE HOST (`game/GameHost.ts`) wants `reportsStore` — and must import
//     `./reports/store` DIRECTLY rather than through this barrel, exactly as it already
//     imports `@/hud/store` instead of `@/hud`. Pulling this file into the game chunk would
//     drag the entire React tree along with it to obtain one singleton.
//
// The host needs three calls and should not reach past them:
//   reportsStore.claim(token, worldSeed)     — at start, beside `hudStore.claim`
//   reportsStore.publishWorld(token, view)   — at the same cadence as the HUD's publish
//   reportsStore.release(token)              — at dispose, beside `hudStore.release`
//
// And one more, whenever work item 032's simulation half lands:
//   reportsStore.attachCommandSink(token, (command) => this.queue.push(command))

export { default as ReportsLayer } from './ReportsLayer';
export { reportsStore, ReportsStore } from './store';
export type { ReportsSnapshot, ReportsSliceName } from './types';
export type { CommerceCommand, CommerceView, CommandSink } from './sim-contract';
