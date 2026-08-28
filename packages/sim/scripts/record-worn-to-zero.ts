// Re-record the `worn-to-zero` golden fixture: item 034's third wear fixture, on the Grinder.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-worn-to-zero.ts
//
// WHY THIS EXISTS. The original drove a Chip Kitchen from full condition to zero by honest
// work; item 145 deleted that kind, so its `PlaceMachine` now replays as a clean refusal and
// the fixture pinned a machine that never existed. Same cure as `record-maintenance.ts`, same
// subject swap (Grinder, wear 2 per operation, fed bought kola nuts), same `klapaucius`
// opening under the flavour-line precedent — the story is the WEAR MECHANISM, and every
// operation, jam-whack, halt and hand-repair pulse below is honest work through the ordinary
// reducer.
//
// THE STORY, unchanged from item 034: driven from full to zero by work — jams whacked out on
// the way down, NEVER repaired, no kit anywhere in the trace — until it halts and sits dead
// losing nothing further, then restored to full by free hand repair alone (plan §1: "manual
// never rots"). The feed is steered so the hopper runs dry exactly as the condition hits
// zero, which is what lets the fixture END at full condition with the machine idle: the story
// test asserts minimum 0 and final CONDITION_MAX in the same replay.

import { CONDITION_MAX, IntentAction, ItemId, MachineKind, itemCount } from '../src/index';
import { recorder } from './recorder-lib';
import { loadFixture } from '../test/goldens';

const SEED = 515151;
const GRINDER_X = 14;
const GRINDER_Y = 4;
/** The story test demands a real corpse, not a bounce: dead for well over 100 ticks. */
const DEAD_TICKS = 300;

const r = recorder(SEED, 'record-worn-to-zero');
const { state } = r;
let jamsWhacked = 0;

function fail(why: string): never {
  throw new Error(`record-worn-to-zero: ${why}`);
}

r.mustApply({ type: 'Cheat', code: 'klapaucius' }, 'the cheat opening');

const bin = state.machines.find((m) => m.kind === MachineKind.SellBin)!;
if (!r.errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.KolaNut, 620)) {
  fail('nut purchase refused');
}

r.mustApply(
  { type: 'PlaceMachine', kind: MachineKind.Grinder, tileX: GRINDER_X, tileY: GRINDER_Y },
  'grinder placement',
);
const grinder = state.machines.find((m) => m.kind === MachineKind.Grinder)!;
r.walkNear(grinder);

// Feed it into the ground. Ten nuts at a time while the condition is high; once it is inside
// one hopper-load of death, exactly condition ÷ 2 more — wear is 2 per operation and a wasted
// input is still an operation, so that lands the last grind ON zero with nothing left over.
let guard = 0;
while (grinder.condition > 0) {
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
    const need = grinder.condition / 2;
    const feed = need > 10 ? 10 : need;
    if (itemCount(state, ItemId.KolaNut) < feed) fail('ran out of nuts');
    r.mustApply({ type: 'LoadMachine', machineId: grinder.id, count: feed }, 'a feed');
    continue;
  }
  r.stepEmpty();
  guard += 1;
  if (guard > 200_000) fail(`never died (condition ${String(grinder.condition)})`);
}

if (grinder.condition !== 0) fail('did not land exactly on zero');
if ((grinder.inputCounts[0] ?? 0) !== 0) fail('died with nuts still hoppered');
if (jamsWhacked < 3) fail('too few jams to call this the worn regime');

// Dead is dead: it sits, consumes nothing, produces nothing, wears nothing further.
const opsAtDeath = grinder.opCount;
r.idle(DEAD_TICKS);
if (grinder.opCount !== opsAtDeath) fail('a dead machine did work');

// Empty the basket, then hands alone bring it back — ten free pulses, no kit in the trace.
if (grinder.outputCount > 0) {
  r.mustApply(
    { type: 'UnloadMachine', machineId: grinder.id, count: grinder.outputCount },
    'the post-mortem basket',
  );
}
while (grinder.condition < CONDITION_MAX) {
  r.mustApply({ type: 'RepairMachine', machineId: grinder.id }, 'a hand-repair pulse');
}
if (state.stats.repairKitsUsed !== 0) fail('a kit crept in');
if (state.stats.touches.handRepair <= 0) fail('no hand repair was counted');

// A short idle tail: restored, idle, and still at full — manual never rots.
r.idle(200);
if (grinder.condition !== CONDITION_MAX) fail('condition moved after restoration');

const old = loadFixture('worn-to-zero');
const fixture = r.writeFixture(
  'worn-to-zero',
  'Item 034’s third wear fixture, on the Grinder since item 145 deleted the Chip Kitchen it ' +
    'used to run on. Opens with klapaucius (the flavour-line precedent), buys kola nuts, and ' +
    'grinds the machine from full condition to zero by honest work — jams whacked out on the ' +
    `way down (${String(jamsWhacked)}), never repaired — until it halts and sits dead ` +
    `for ${String(DEAD_TICKS)} ticks losing nothing further, then is restored to full by free ` +
    'hand repair alone (plan §1: "manual never rots"). The feed is steered so the hopper runs ' +
    'dry exactly at zero, so the fixture ends restored, idle, and at full condition. ' +
    'Re-recorded 2026-08-27; see scripts/record-worn-to-zero.ts.',
);
console.log(
  `worn-to-zero re-recorded: ${String(fixture.ticks)} ticks, ${String(fixture.commands.length)} commands, ` +
    `hash ${old.expectedHash} -> ${fixture.expectedHash}\n` +
    `  ops ${String(grinder.opCount)}, jams whacked ${String(jamsWhacked)}, ` +
    `wasted ${String(state.stats.inputsWastedByMachine)}, handRepair touches ` +
    `${String(state.stats.touches.handRepair)}`,
);
