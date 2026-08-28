// Re-record the `junction-loop` golden fixture: item 024 instruction 11, on the Grinder.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-junction-loop.ts
//
// WHY THIS EXISTS. The original ground its economy up to the Splitters node and fed the loop
// from a Chip Kitchen; item 145 deleted that kind, so the feed — and with it the whole belt
// circuit, whose purchases the dead economy could no longer afford — replayed as refusals:
// the junctions were never placed and the fixture pinned an empty lot. The re-recording opens
// with `klapaucius` (the story is the JUNCTIONS, not the climb) and keeps the original
// recording's loop GEOMETRY tile for tile — the same two junctions, the same four belt runs,
// the same arm tile — with a Grinder standing where the kitchen stood (same 2×2 footprint)
// and bought kola nuts becoming the powder that rides the loop.
//
// THE STORY, unchanged: a closed belt circuit through two junctions — one splitting one feed
// across two branches, one merging them back — with the goods circulating forever and both
// round-robin cursors advancing. `factory.test.ts` replays it watching and asserts the
// alternation and that goods reach every belt in the loop.

import { BeltTier, Direction, GrabberTier, IntentAction, ItemId, MachineKind } from '../src/index';
import { recorder } from './recorder-lib';
import { loadFixture } from '../test/goldens';

const SEED = 626262;

const r = recorder(SEED, 'record-junction-loop');
const { state } = r;

function fail(why: string): never {
  throw new Error(`record-junction-loop: ${why}`);
}

r.mustApply({ type: 'Cheat', code: 'klapaucius' }, 'the cheat opening');

const bin = state.machines.find((m) => m.kind === MachineKind.SellBin)!;
if (!r.errand(IntentAction.Buy, bin.tileX, bin.tileY, ItemId.KolaNut, 14)) {
  fail('nut purchase refused');
}

// The feed: a Grinder on the old kitchen's exact 2×2, nuts hoppered by hand.
r.mustApply(
  { type: 'PlaceMachine', kind: MachineKind.Grinder, tileX: 6, tileY: 0 },
  'grinder placement',
);
const grinder = state.machines.find((m) => m.kind === MachineKind.Grinder)!;
r.walkNear(grinder);
r.mustApply({ type: 'LoadMachine', machineId: grinder.id, count: 14 }, 'the nut feed');

// The loop, tile for tile from the original recording.
r.mustApply(
  { type: 'PlaceMachine', kind: MachineKind.BeltJunction, tileX: 9, tileY: 1 },
  'the splitter',
);
r.mustApply(
  { type: 'PlaceMachine', kind: MachineKind.BeltJunction, tileX: 12, tileY: 2 },
  'the merger',
);
r.mustApply(
  {
    type: 'PlaceBelt',
    tier: BeltTier.Basic,
    tileX: 9,
    tileY: 0,
    dir: Direction.South,
    lengthTiles: 1,
  },
  'the feed belt',
);
r.mustApply(
  {
    type: 'PlaceBelt',
    tier: BeltTier.Basic,
    tileX: 10,
    tileY: 1,
    dir: Direction.East,
    lengthTiles: 2,
    turnDir: Direction.South,
    turnLengthTiles: 1,
  },
  'the north branch',
);
r.mustApply(
  {
    type: 'PlaceBelt',
    tier: BeltTier.Basic,
    tileX: 9,
    tileY: 2,
    dir: Direction.East,
    lengthTiles: 3,
  },
  'the south branch',
);
r.mustApply(
  {
    type: 'PlaceBelt',
    tier: BeltTier.Basic,
    tileX: 13,
    tileY: 2,
    dir: Direction.North,
    lengthTiles: 2,
    turnDir: Direction.West,
    turnLengthTiles: 4,
  },
  'the return run',
);
r.mustApply(
  {
    type: 'PlaceGrabber',
    tier: GrabberTier.Mk1,
    tileX: 8,
    tileY: 0,
    dir: Direction.East,
    filter: 0,
  },
  'the arm',
);

// Let the powder come off the grinder, board the loop, and go round and round — watching
// which belts carry, because that is exactly what the story test will watch.
const carried = new Set<number>();
for (let i = 0; i < 6_000; i++) {
  r.stepEmpty();
  for (const belt of state.belts) {
    if (belt.items.length > 0) carried.add(belt.id);
  }
}

const junctions = state.machines.filter((m) => m.kind === MachineKind.BeltJunction);
if (junctions.length !== 2) fail('a junction went missing');
if (state.belts.length < 6) fail(`only ${String(state.belts.length)} belts — the loop is short`);
const riding = state.belts.reduce((sum, belt) => sum + belt.items.length, 0);
if (riding <= 0) fail('nothing is riding the loop at the end');
for (const belt of state.belts) {
  if (!carried.has(belt.id)) fail(`belt ${String(belt.id)} never carried anything`);
}

const old = loadFixture('junction-loop');
const fixture = r.writeFixture(
  'junction-loop',
  'Item 024 instruction 11: a closed belt circuit through two junctions — one splitting one ' +
    'feed across two branches, one merging them back — with the goods circulating forever and ' +
    'both round-robin cursors advancing in the hash. Re-recorded 2026-08-27 on the original ' +
    'loop’s exact geometry: item 145 deleted the Chip Kitchen that fed it, so a Grinder ' +
    'stands on the same 2×2 grinding bought kola nuts, the session opens with klapaucius (the ' +
    'story is the junctions, not the economy), and the powder rides the same belts the bags ' +
    'did. factory.test.ts replays it watching and asserts the alternation and that goods ' +
    'reach every belt in the loop. See scripts/record-junction-loop.ts.',
);
console.log(
  `junction-loop re-recorded: ${String(fixture.ticks)} ticks, ${String(fixture.commands.length)} commands, ` +
    `hash ${old.expectedHash} -> ${fixture.expectedHash}\n` +
    `  belts ${String(state.belts.length)}, riding ${String(riding)}`,
);
