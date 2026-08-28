// Re-record the `water-works` golden fixture: the liquid layer under a load that lasts.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-water-works.ts
//
// THIRD RECORDING. The 2026-08-18 session (item 139) farmed a hundred thousand ticks of
// potatoes through a Chip Kitchen to pay for its plumbing; item 145 deleted that kind, the
// economy died with it, and the replay ended with one machine and zero pipes — the exact
// disease that recording had been made to cure. The re-recording opens with `klapaucius`
// (the economy's story is over; the LAYER's story is not) and keeps everything the old
// session's plumbing meant:
//
//   * **THE MAIN IS THE OLD RECORDING'S MAIN, TILE FOR TILE** — nine west along y = 12 and
//     eight north up x = 3 — and the two-tile spur off its east end is torn straight back up,
//     the one `RemovePipe` the set accepts. `apps/web`'s `pipe-run.test.ts` reads these paths
//     out of this file and proves the drag gesture can express them; a fixture that
//     restraightened its own main would delete that test's subject without touching the
//     client.
//   * **BOTH REGIMES, BACK TO BACK.** One head lives inside the pump's rating and the Tank
//     banks the surplus — 2,500 untouched ticks with nothing throttled and the tank climbing.
//     A second head tips the network into permanent shortfall — 4,000 more with round-robin
//     throttling and the tank drained to zero. Infinite source, finite throughput: the load
//     is the PUMP's ceiling, which is what item 140 left of scarcity.
//   * **THE BUCKET.** The drained tank is topped up by hand — `RefillHopper` on a tank, from
//     a pond that always answers — which is the manual-assist rung of the layer and this
//     fixture's closing beat.

import { LiquidId, MachineKind } from '../src/index';
import { recorder } from './recorder-lib';
import { loadFixture } from '../test/goldens';

const SEED = 51015;
const SURPLUS_TICKS = 2_500;
const DEFICIT_TICKS = 4_000;

const r = recorder(SEED, 'record-water-works');
const { state } = r;

function fail(why: string): never {
  throw new Error(`record-water-works: ${why}`);
}

r.mustApply({ type: 'Cheat', code: 'klapaucius' }, 'the cheat opening');

// The main, tile for tile from the 2026-08-18 recording, then the spur laid and torn up.
r.mustApply(
  {
    type: 'PlacePipe',
    liquid: LiquidId.Water,
    path: [
      { x: 11, y: 12 },
      { x: 10, y: 12 },
      { x: 9, y: 12 },
      { x: 8, y: 12 },
      { x: 7, y: 12 },
      { x: 6, y: 12 },
      { x: 5, y: 12 },
      { x: 4, y: 12 },
      { x: 3, y: 12 },
      { x: 3, y: 11 },
      { x: 3, y: 10 },
      { x: 3, y: 9 },
      { x: 3, y: 8 },
      { x: 3, y: 7 },
      { x: 3, y: 6 },
      { x: 3, y: 5 },
      { x: 3, y: 4 },
    ],
  },
  'the seventeen-tile main',
);
r.mustApply(
  {
    type: 'PlacePipe',
    liquid: LiquidId.Water,
    path: [
      { x: 11, y: 11 },
      { x: 11, y: 10 },
    ],
  },
  'the two-tile spur',
);
r.mustApply(
  {
    type: 'RemovePipe',
    path: [
      { x: 11, y: 11 },
      { x: 11, y: 10 },
    ],
  },
  'tearing the spur back up',
);

// The machines, on the old recording's tiles: tank, first head, pump on the pond's bank.
r.mustApply({ type: 'PlaceMachine', kind: MachineKind.Tank, tileX: 1, tileY: 10 }, 'the tank');
r.mustApply(
  { type: 'PlaceMachine', kind: MachineKind.PipedSprinkler, tileX: 4, tileY: 5 },
  'the first head',
);
r.mustApply({ type: 'PlaceMachine', kind: MachineKind.Pump, tileX: 12, tileY: 12 }, 'the pump');
const tank = state.machines.find((m) => m.kind === MachineKind.Tank)!;

// Regime one: surplus. One head inside the pump's rating, the tank banking the difference.
r.idle(SURPLUS_TICKS);
if (state.machines.some((m) => m.throttled)) fail('something throttled in the surplus regime');
if (tank.tankMl <= 0) fail('the tank banked nothing in the surplus regime');
const banked = tank.tankMl;

// Regime two: the second head tips the network into permanent shortfall.
r.mustApply(
  { type: 'PlaceMachine', kind: MachineKind.PipedSprinkler, tileX: 4, tileY: 9 },
  'the second head',
);
let throttledTicks = 0;
for (let i = 0; i < DEFICIT_TICKS; i++) {
  r.stepEmpty();
  if (state.machines.some((m) => m.throttled)) throttledTicks += 1;
}
if (throttledTicks < 1_000) fail(`only ${String(throttledTicks)} throttled ticks in the deficit`);
if (tank.tankMl !== 0) fail(`the tank still holds ${String(tank.tankMl)} ml`);

// The bucket: the drained tank topped up by hand from a pond that always answers.
r.walkNear(tank);
r.mustApply({ type: 'RefillHopper', machineId: tank.id }, 'the bucket top-up');
if (tank.tankMl <= 0) fail('the bucket poured nothing');
r.idle(400);

const old = loadFixture('water-works');
const fixture = r.writeFixture(
  'water-works',
  'The liquid layer under a load that lasts (re-recorded 2026-08-27 — item 145 deleted the ' +
    'Chip Kitchen economy the 2026-08-18 session farmed, so this one opens with klapaucius ' +
    'and keeps the layer). The old recording’s 17-tile main, tile for tile — nine west along ' +
    'the headland and eight north up the field’s west edge, read out of this file by ' +
    'apps/web’s pipe-run test — with a two-tile spur torn straight back up (the one ' +
    'RemovePipe the set accepts), and a Tank and one piped head behind a Pump. One head ' +
    'lives inside the pump’s rating and the tank banks the surplus (' +
    `${String(SURPLUS_TICKS)} ticks, nothing throttled, ${String(banked)} ml banked); a ` +
    'second head tips it short and the tank pays until it cannot (' +
    `${String(DEFICIT_TICKS)} ticks, throttling on ${String(throttledTicks)} of them, tank ` +
    'drained to zero). Closes with the drained tank topped up by bucket from the unlimited ' +
    'pond. See scripts/record-water-works.ts.',
);
console.log(
  `water-works re-recorded: ${String(fixture.ticks)} ticks, ${String(fixture.commands.length)} commands, ` +
    `hash ${old.expectedHash} -> ${fixture.expectedHash}\n` +
    `  banked ${String(banked)} ml, throttled ${String(throttledTicks)}/${String(DEFICIT_TICKS)}`,
);
