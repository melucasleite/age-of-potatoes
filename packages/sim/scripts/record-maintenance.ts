// Re-record the `maintenance` golden fixture: the worn regime, end to end, on the Grinder.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-maintenance.ts
//
// WHY THIS EXISTS, THIRD RECORDING. The original was zombified by the 8-pour-can amendment
// (see the 2026-08-14 note in fixtures/README.md); the second recording ran the story on a
// Chip Kitchen, and item 145 DELETED that kind — its `PlaceMachine` now replays as a clean
// refusal and every feed, whack and kit use lands on a machine that never existed. Same
// disease, new cause, same cure: a new recorded session, asserted before writing.
//
// THE STORY IS UNCHANGED — work reaches the worn regime and one $8 kit restores the cell —
// but the subject is now the GRINDER (wear 2 per operation), fed BOUGHT kola nuts, and the
// session opens with `klapaucius` for the money and the node. That is the flavour-line /
// bottle-return precedent: this fixture is about what a worn machine DOES, and the farming
// prologue the kitchen used to have bought nothing but runtime. What the cheat deliberately
// does not touch: every operation, jam, waste, whack, purchase and repair below is honest
// work through the ordinary reducer, and the recorder stands IN REACH and issues the direct
// commands — LoadMachine, UnloadMachine, WhackJam, UseRepairKit — so the trace itself keeps
// those verbs under golden coverage.

import {
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  IntentAction,
  ItemId,
  MachineKind,
  itemCount,
} from '../src/index';
import { recorder } from './recorder-lib';
import { loadFixture } from '../test/goldens';

const SEED = 404040;
const GRINDER_X = 14;
const GRINDER_Y = 4;
/**
 * Deep enough into the worn regime for the cadence to have visibly cost something (several
 * spoiled inputs, several jams) while staying far from zero — a dead machine is
 * `worn-to-zero.json`'s story, and the two fixtures should not blur.
 */
const STOP_AT_CONDITION = 200;
const MIN_WASTED = 5;
const MIN_JAMS = 3;

const r = recorder(SEED, 'record-maintenance');
const { state } = r;
let jamsWhacked = 0;
let minCondition = CONDITION_MAX;

function fail(why: string): never {
  throw new Error(`record-maintenance: ${why}`);
}

r.mustApply({ type: 'Cheat', code: 'klapaucius' }, 'the cheat opening');

const bin = state.machines.find((m) => m.kind === MachineKind.SellBin)!;
if (!r.errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.KolaNut, 470)) {
  fail('nut purchase refused');
}

r.mustApply(
  { type: 'PlaceMachine', kind: MachineKind.Grinder, tileX: GRINDER_X, tileY: GRINDER_Y },
  'grinder placement',
);
const grinder = state.machines.find((m) => m.kind === MachineKind.Grinder)!;
r.walkNear(grinder);

// Exact LoadMachine counts, which is how the feed stays steerable. (`RefillHopper` is the
// dock-shelf and water-tank verb — a converter's hopper has always been fed by LoadMachine.)
let guard = 0;
for (;;) {
  if (grinder.condition < minCondition) minCondition = grinder.condition;
  if (
    grinder.condition <= STOP_AT_CONDITION &&
    state.stats.inputsWastedByMachine >= MIN_WASTED &&
    jamsWhacked >= MIN_JAMS
  ) {
    break;
  }
  if (grinder.condition <= 80) fail('descended too close to zero — that is worn-to-zero’s story');

  if (grinder.jammed) {
    r.mustApply({ type: 'WhackJam', machineId: grinder.id }, 'a jam whack');
    jamsWhacked += 1;
    continue;
  }
  if (grinder.outputCount >= 15) {
    r.mustApply(
      { type: 'UnloadMachine', machineId: grinder.id, count: grinder.outputCount },
      'emptying the basket',
    );
    continue;
  }
  const hoppered = grinder.inputCounts[0] ?? 0;
  if (hoppered === 0) {
    if (itemCount(state, ItemId.KolaNut) <= 0) fail('ran out of nuts');
    r.mustApply({ type: 'LoadMachine', machineId: grinder.id, count: 10 }, 'a ten-nut feed');
    continue;
  }
  r.stepEmpty();
  guard += 1;
  if (guard > 120_000) fail(`worn regime never reached (condition ${String(grinder.condition)})`);
}

// Drain what is left so the kit lands on a machine that is worn but IDLE, and the fixture's
// tail is a deliberate restart rather than a machine that never stopped.
while ((grinder.inputCounts[0] ?? 0) > 0 || grinder.progress > 0) {
  if (grinder.jammed) {
    r.mustApply({ type: 'WhackJam', machineId: grinder.id }, 'a drain-phase whack');
    jamsWhacked += 1;
  }
  r.stepEmpty();
}
if (grinder.outputCount > 0) {
  r.mustApply(
    { type: 'UnloadMachine', machineId: grinder.id, count: grinder.outputCount },
    'the final basket',
  );
}

// One kit, one trip, whole cell restored.
if (!r.errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.RepairKit, 1)) {
  fail('kit purchase refused');
}
r.walkNear(grinder);
{
  const hereX = Math.floor(state.player.xSub / 256);
  const hereY = Math.floor(state.player.ySub / 256);
  r.mustApply({ type: 'UseRepairKit', tileX: hereX, tileY: hereY }, 'the kit use');
}
if (grinder.condition !== CONDITION_MAX) fail('kit did not restore the grinder');
if (state.stats.repairKitsUsed !== 1) fail('kit was not consumed');
if (state.stats.repairKitSpendCents !== 800) fail('kit spend not counted at the till');
if (minCondition >= CONDITION_EFFECT_THRESHOLD) fail('threshold never crossed');
if (minCondition <= 0) fail('the machine died — that is worn-to-zero’s story');

// A short working tail, so the fixture ends with the restored machine back at work.
r.mustApply({ type: 'LoadMachine', machineId: grinder.id, count: 5 }, 'the tail feed');
r.idle(400);

const old = loadFixture('maintenance');
const fixture = r.writeFixture(
  'maintenance',
  'The worn regime, end to end, on the Grinder. Opens with klapaucius (the flavour-line ' +
    'precedent: the subject is what a worn machine does, not the economy), buys kola nuts at ' +
    'the bin, and grinds batch after batch until wear (2 per operation) drops the cell below ' +
    `the effect threshold — at which point it runs at half speed, jams (${String(jamsWhacked)} ` +
    `whacked out by hand) and spoils inputs on the deterministic cadence ` +
    `(${String(state.stats.inputsWastedByMachine)} wasted). Ends with one $8 repair kit bought ` +
    'at the bin and spent standing by the machine — whole cell back to full in one use — and a ' +
    'short tail of the restored grinder back at work. Re-recorded 2026-08-27 after item 145 ' +
    'deleted the Chip Kitchen the previous recording ran on; see scripts/record-maintenance.ts.',
);
console.log(
  `maintenance re-recorded: ${String(fixture.ticks)} ticks, ${String(fixture.commands.length)} commands, ` +
    `hash ${old.expectedHash} -> ${fixture.expectedHash}\n` +
    `  minCondition ${String(minCondition)}, wasted ${String(state.stats.inputsWastedByMachine)}, ` +
    `jams whacked ${String(jamsWhacked)}, kit spend ${String(state.stats.repairKitSpendCents)}c, ` +
    `final condition ${String(grinder.condition)}`,
);
