// Re-record the `depot-run` golden fixture: selling without you, on the Grinder.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-depot-run.ts
//
// WHY THIS EXISTS. The original farmed a potato economy up from $50 through the Workshop
// Charter, Belts and Trucking, and fed its depot from a Chip Kitchen; item 145 deleted that
// kind, so the kitchens were refused, the economy died, and the hands-off window contained no
// production and no income. The re-recording opens with `klapaucius` (the story is the
// WINDOW, not the climb — the flavour-line precedent) and keeps the original's yard geometry:
// the producer on the kitchen's old 2×2 at (2,14), the arm at (4,14) facing east, the Truck
// Depot at (5,14), a standing route signed and a second one signed and torn up.
//
// THE STORY, unchanged: **ends with 5,000 commandless ticks** — no player input of any kind —
// in which truck runs arrive, the money goes up, and every manual touch counter stays exactly
// where it was. `handsOffFromTick` marks the boundary and `test/commerce.test.ts` replays to
// it and asserts the counters are frozen across the window. What the fixture still does NOT
// claim is seed-to-sold: the Grinder's hopper is hand-loaded before the window opens, which
// is the same honesty note the original carried about its kitchen.

import { Direction, GrabberTier, IntentAction, ItemId, MachineKind, itemCount } from '../src/index';
import { recorder } from './recorder-lib';
import { loadFixture } from '../test/goldens';

const SEED = 320_320;
const WINDOW_TICKS = 5_000;

const r = recorder(SEED, 'record-depot-run');
const { state } = r;

function fail(why: string): never {
  throw new Error(`record-depot-run: ${why}`);
}

r.mustApply({ type: 'Cheat', code: 'klapaucius' }, 'the cheat opening');

const bin = state.machines.find((m) => m.kind === MachineKind.SellBin)!;
if (!r.errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.KolaNut, 40)) {
  fail('nut purchase refused');
}

r.mustApply(
  { type: 'PlaceMachine', kind: MachineKind.Grinder, tileX: 2, tileY: 14 },
  'grinder placement',
);
const grinder = state.machines.find((m) => m.kind === MachineKind.Grinder)!;
r.mustApply(
  {
    type: 'PlaceGrabber',
    tier: GrabberTier.Mk1,
    tileX: 4,
    tileY: 14,
    dir: Direction.East,
    filter: 0,
  },
  'the arm',
);
r.mustApply(
  { type: 'PlaceMachine', kind: MachineKind.TruckDepot, tileX: 5, tileY: 14 },
  'depot placement',
);
const depot = state.machines.find((m) => m.kind === MachineKind.TruckDepot)!;

// The standing route, and the one that gets torn up — CreateContract twice, CancelContract
// once, exactly the original's beats.
r.mustApply(
  {
    type: 'CreateContract',
    depotId: depot.id,
    item: ItemId.KolaPowder,
    quantityPerRun: 5,
    destination: 'Ridgeline Grocers',
  },
  'the powder route',
);
r.mustApply(
  {
    type: 'CreateContract',
    depotId: depot.id,
    item: ItemId.KolaNut,
    quantityPerRun: 25,
    destination: 'Route 9 Wholesale',
  },
  'the doomed nut route',
);
const doomed = state.contracts.find((c) => c.item === ItemId.KolaNut);
if (doomed === undefined) fail('the second route was not signed');
r.mustApply({ type: 'CancelContract', contractId: doomed.id }, 'tearing up the nut route');
if (state.contracts.length !== 1) fail('expected exactly one standing route');

// Feed the grinder by hand — two hopper loads, twenty and twenty — so the window opens with
// forty operations' worth of powder either made or on the way.
r.walkNear(grinder);
r.mustApply({ type: 'LoadMachine', machineId: grinder.id, count: 20 }, 'the first hopper load');
let guard = 0;
while ((grinder.inputCounts[0] ?? 0) > 0) {
  r.stepEmpty();
  guard += 1;
  if (guard > 30_000) fail('the first load never ground down');
}
if (itemCount(state, ItemId.KolaNut) < 20) fail('not enough nuts left for the second load');
r.mustApply({ type: 'LoadMachine', machineId: grinder.id, count: 20 }, 'the second hopper load');

// THE WINDOW. Nothing is issued from here to the end — this is the whole fixture.
const boundary = state.tick;
const touchesBefore = JSON.stringify(state.stats.touches);
const moneyBefore = state.moneyCents;
const grossBefore = state.stats.automatedGrossCents;
r.idle(WINDOW_TICKS);

if (state.tick !== boundary + WINDOW_TICKS) fail('the window is not exactly 5,000 ticks');
if (JSON.stringify(state.stats.touches) !== touchesBefore) fail('a manual touch was counted');
if (state.moneyCents <= moneyBefore) fail('no money arrived in the window');
if (state.stats.automatedGrossCents <= grossBefore) fail('no automated gross in the window');
const route = state.contracts[0]!;
if (route.runsCompleted < 2) fail(`only ${String(route.runsCompleted)} runs completed`);
if (!state.ceremonies.includes('truck-first-departure')) fail('the first truck never honked');

const old = loadFixture('depot-run');
const fixture = r.writeFixture(
  'depot-run',
  'Selling without you. Opens with klapaucius (the story is the hands-off window, not the ' +
    'climb — item 145 deleted the Chip Kitchen economy the original farmed), then builds the ' +
    'original yard on the same tiles: a Grinder fed bought kola nuts, an arm, and a Truck ' +
    'Depot with a standing powder route — plus a second route signed and torn up. **Ends with ' +
    '5,000 commandless ticks** in which ' +
    `${String(route.runsCompleted)} truck runs complete, the money goes up by ` +
    `$${String((state.moneyCents - moneyBefore) / 100)}, and every manual touch counter stays ` +
    'exactly where it was. That window is the whole fixture; test/commerce.test.ts replays to ' +
    'its boundary and asserts the counters are frozen across it. Re-recorded 2026-08-27; see ' +
    'scripts/record-depot-run.ts.',
  { handsOffFromTick: boundary },
);
console.log(
  `depot-run re-recorded: ${String(fixture.ticks)} ticks, ${String(fixture.commands.length)} commands, ` +
    `hash ${old.expectedHash} -> ${fixture.expectedHash}\n` +
    `  boundary ${String(boundary)}, runs ${String(route.runsCompleted)}, ` +
    `window income ${String(state.moneyCents - moneyBefore)}c`,
);
