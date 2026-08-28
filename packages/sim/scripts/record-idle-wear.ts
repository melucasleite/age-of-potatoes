// Re-record the `idle-wear` golden fixture: plan §4's absolute rule as a pinned world.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-idle-wear.ts
//
// WHY THIS EXISTS. The original hand-farmed two rows and bought a Chip Kitchen; item 145
// deleted that kind, so its `PlaceMachine` replayed as a refusal and the fixture spent ten
// thousand ticks proving that a machine which does not exist does not wear — which is not
// plan §4. The re-recording opens with `klapaucius` (the farming prologue pinned nothing this
// fixture is for) and places the WASHER, the surviving converter.
//
// THE STORY, unchanged: wear is per operation and **never** per second. The Washer is placed
// with an empty hopper and then NOT TOUCHED for ten thousand ticks — no operations, so it
// must end at zero opCount and full condition. `factory.test.ts` reads this fixture back and
// asserts exactly that, plus that the tail really is commandless.

import { CONDITION_MAX, MachineKind } from '../src/index';
import { recorder } from './recorder-lib';
import { loadFixture } from '../test/goldens';

const SEED = 606060;
const WASHER_X = 14;
const WASHER_Y = 4;
const UNTOUCHED_TICKS = 10_050;

const r = recorder(SEED, 'record-idle-wear');
const { state } = r;

function fail(why: string): never {
  throw new Error(`record-idle-wear: ${why}`);
}

r.mustApply({ type: 'Cheat', code: 'klapaucius' }, 'the cheat opening');
r.mustApply(
  { type: 'PlaceMachine', kind: MachineKind.Washer, tileX: WASHER_X, tileY: WASHER_Y },
  'washer placement',
);
const washer = state.machines.find((m) => m.kind === MachineKind.Washer)!;

r.idle(UNTOUCHED_TICKS);

if (washer.opCount !== 0) fail('the idle washer did work');
if (washer.condition !== CONDITION_MAX) fail('the idle washer wore — the exact bug this pins');
const last = state.trace[state.trace.length - 1]!;
if (state.tick - last.tick < 10_000) fail('the untouched tail is shorter than ten thousand ticks');

const old = loadFixture('idle-wear');
const fixture = r.writeFixture(
  'idle-wear',
  'Plan §4’s absolute rule, as a pinned world: wear is per operation and never per second. ' +
    'Opens with klapaucius, places a Washer (the surviving converter — item 145 deleted the ' +
    'Chip Kitchen the original bought), and then never touches it again for ten thousand ' +
    'ticks. It completes no operations, so it must end at full condition — a machine that ' +
    'aged on the clock shows up here as a changed hash, and factory.test.ts reads this ' +
    'fixture back and says so in words. Re-recorded 2026-08-27; see ' +
    'scripts/record-idle-wear.ts.',
);
console.log(
  `idle-wear re-recorded: ${String(fixture.ticks)} ticks, ${String(fixture.commands.length)} commands, ` +
    `hash ${old.expectedHash} -> ${fixture.expectedHash}`,
);
