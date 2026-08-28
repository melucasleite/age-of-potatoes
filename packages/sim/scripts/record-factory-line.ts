// Re-record the `factory-line` golden fixture: the chip line, end to end, on the researched
// Wash & Slice → Fryer → Finishing machines.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-factory-line.ts
//
// WHY THIS EXISTS. The original was a full era-1-to-era-2 run whose early economy hand-fed a
// Chip Kitchen; item 145 deleted that kind, the economy died with it, and half the recorded
// build — belts, arms, dials — replayed as refusals for want of money. The re-recording opens
// with `klapaucius` (the tech-gating story now lives in soda-line's honest researches and in
// tech tests; THIS fixture's story is the LINE), and then earns its potatoes the only way
// anyone can: they are farmed by hand, because a potato has never been purchasable.
//
// THE STORY: twenty hand-farmed russets go down the whole surviving line — Washer → belt →
// Slicer → Fryer → Seasoner → Bagger, five grabber arms — and come out as twenty bagged chips
// sold at the bin. Along the way the fixture deliberately exercises the machine-management
// verbs the set must keep under coverage: a deed bought, a zone created, painted and renamed,
// an Mk2 arm filtered, a spare arm rotated round the compass and removed, a spare belt
// removed, a Speed dial bought on the Fryer, and a spare Washer moved, boxed by hand, and its
// box sold at 40%. Every beat is asserted before the file is written.

import {
  BeltTier,
  CropId,
  Direction,
  GrabberTier,
  IntentAction,
  ItemId,
  MachineKind,
  UpgradeDial,
  itemCount,
} from '../src/index';
import { FIELD_ORIGIN_X, FIELD_ORIGIN_Y } from '../src/data';
import { isTileReady, tileAt } from '../src/state';
import { recorder } from './recorder-lib';
import { loadFixture } from '../test/goldens';

const SEED = 70707;
const POTATOES_FOR_THE_LINE = 20;

const r = recorder(SEED, 'record-factory-line');
const { state } = r;

function fail(why: string): never {
  throw new Error(`record-factory-line: ${why}`);
}

r.mustApply({ type: 'Cheat', code: 'klapaucius' }, 'the cheat opening');
// The line runs east onto parcel 1 — ground the starter lot does not include.
r.mustApply({ type: 'BuyDeed', parcel: 1 }, 'the deed to parcel 1');

// A Grow Zone over the row being farmed: created, painted wider, renamed.
r.mustApply(
  { type: 'CreateZone', rect: { x: 4, y: 4, w: 4, h: 1 }, crop: CropId.RussetPotato },
  'the zone',
);
const zone = state.zones[0]!;
r.mustApply(
  { type: 'PaintZone', zoneId: zone.id, rect: { x: 8, y: 4, w: 4, h: 1 }, mode: 'add' },
  'painting the zone wider',
);
r.mustApply({ type: 'RenameZone', zoneId: zone.id, name: 'the potato strip' }, 'the rename');
// The two zone dials: priority up, crop flipped to cane and back — the strip is farmed by
// hand below, so the crop setting is exercised without steering anything.
r.mustApply({ type: 'SetZonePriority', zoneId: zone.id, priority: 2 }, 'the priority dial');
r.mustApply({ type: 'SetZoneCrop', zoneId: zone.id, crop: CropId.SugarCane }, 'the crop dial');
r.mustApply(
  { type: 'SetZoneCrop', zoneId: zone.id, crop: CropId.RussetPotato },
  'the crop dial, back',
);

// Hand-farm the row until twenty russets are in the bag. Seeds come back with each harvest.
let cycles = 0;
while (itemCount(state, ItemId.RussetPotato) < POTATOES_FOR_THE_LINE) {
  cycles += 1;
  if (cycles > 8) fail('the field never yielded twenty potatoes');
  const row: { x: number; y: number }[] = [];
  for (let i = 0; i < 8; i++) row.push({ x: FIELD_ORIGIN_X + i, y: FIELD_ORIGIN_Y });
  for (const { x, y } of row) {
    const tile = tileAt(state, x, y);
    if (tile !== null && tile.crop === CropId.None && itemCount(state, ItemId.PotatoSeed) > 0) {
      r.errand(IntentAction.Plant, x, y, CropId.RussetPotato);
    }
  }
  for (const { x, y } of row) {
    const tile = tileAt(state, x, y);
    if (tile !== null && tile.crop !== CropId.None && !isTileReady(tile)) {
      r.errand(IntentAction.Water, x, y);
    }
  }
  let waited = 0;
  while (
    waited < 8_000 &&
    !row.every((p) => {
      const tile = tileAt(state, p.x, p.y);
      return tile === null || tile.crop === CropId.None || isTileReady(tile);
    })
  ) {
    r.stepEmpty();
    waited += 1;
  }
  for (const { x, y } of row) {
    const tile = tileAt(state, x, y);
    if (tile !== null && isTileReady(tile)) r.errand(IntentAction.Harvest, x, y);
  }
}

// The line, west to east, arms bridging every gap and one belt run inside it:
//   Washer(14,4) →arm(16,4)→ belt(17,4)→(18,4) →arm(19,4)→ Slicer(20,4) →arm(22,4)→
//   Fryer(23,4) →arm(25,4)→ Seasoner(26,4) →arm(28,4)→ Bagger(29,4)
r.mustApply({ type: 'PlaceMachine', kind: MachineKind.Washer, tileX: 14, tileY: 4 }, 'the Washer');
r.mustApply({ type: 'PlaceMachine', kind: MachineKind.Slicer, tileX: 20, tileY: 4 }, 'the Slicer');
r.mustApply({ type: 'PlaceMachine', kind: MachineKind.Fryer, tileX: 23, tileY: 4 }, 'the Fryer');
r.mustApply(
  { type: 'PlaceMachine', kind: MachineKind.Seasoner, tileX: 26, tileY: 4 },
  'the Seasoner',
);
r.mustApply({ type: 'PlaceMachine', kind: MachineKind.Bagger, tileX: 29, tileY: 4 }, 'the Bagger');
r.mustApply(
  {
    type: 'PlaceBelt',
    tier: BeltTier.Basic,
    tileX: 17,
    tileY: 4,
    dir: Direction.East,
    lengthTiles: 2,
  },
  'the belt inside the line',
);
r.mustApply(
  {
    type: 'PlaceGrabber',
    tier: GrabberTier.Mk1,
    tileX: 16,
    tileY: 4,
    dir: Direction.East,
    filter: 0,
  },
  'arm one, Washer to belt',
);
// Arm two is an Mk2, placed unfiltered and then FILTERED BY COMMAND to washed potatoes.
r.mustApply(
  {
    type: 'PlaceGrabber',
    tier: GrabberTier.Mk2,
    tileX: 19,
    tileY: 4,
    dir: Direction.East,
    filter: 0,
  },
  'arm two, belt to Slicer',
);
const mk2 = state.grabbers[state.grabbers.length - 1]!;
r.mustApply(
  { type: 'SetGrabberFilter', grabberId: mk2.id, filter: ItemId.WashedPotato },
  'filtering arm two',
);
r.mustApply(
  {
    type: 'PlaceGrabber',
    tier: GrabberTier.Mk1,
    tileX: 22,
    tileY: 4,
    dir: Direction.East,
    filter: 0,
  },
  'arm three, Slicer to Fryer',
);
r.mustApply(
  {
    type: 'PlaceGrabber',
    tier: GrabberTier.Mk1,
    tileX: 25,
    tileY: 4,
    dir: Direction.East,
    filter: 0,
  },
  'arm four, Fryer to Seasoner',
);
r.mustApply(
  {
    type: 'PlaceGrabber',
    tier: GrabberTier.Mk1,
    tileX: 28,
    tileY: 4,
    dir: Direction.East,
    filter: 0,
  },
  'arm five, Seasoner to Bagger',
);

// A Speed dial on the Fryer — the slowest machine on the line, which is why the original
// bought its dial too. Bought AT the machine (plan §3), so the walk comes first.
const fryer = state.machines.find((m) => m.kind === MachineKind.Fryer)!;
r.walkNear(fryer);
r.mustApply(
  { type: 'UpgradeMachine', machineId: fryer.id, dial: UpgradeDial.Speed },
  'the Speed dial',
);

// The rearranging verbs, on spares so the line itself never moves: an arm turned full circle
// and taken up; a belt taken up; a Washer moved, boxed, and its box sold.
r.mustApply(
  {
    type: 'PlaceGrabber',
    tier: GrabberTier.Mk1,
    tileX: 16,
    tileY: 8,
    dir: Direction.North,
    filter: 0,
  },
  'the spare arm',
);
const spareArm = state.grabbers[state.grabbers.length - 1]!;
r.walkNearTile(16, 8);
for (let i = 0; i < 3; i++) {
  r.mustApply({ type: 'RotateGrabber', grabberId: spareArm.id }, 'a spare-arm rotation');
}
r.mustApply({ type: 'RemoveGrabber', grabberId: spareArm.id }, 'removing the spare arm');
r.mustApply(
  {
    type: 'PlaceBelt',
    tier: BeltTier.Basic,
    tileX: 17,
    tileY: 8,
    dir: Direction.East,
    lengthTiles: 2,
  },
  'the spare belt',
);
const spareBelt = state.belts[state.belts.length - 1]!;
r.walkNearTile(17, 8);
r.mustApply({ type: 'RemoveBelt', beltId: spareBelt.id }, 'removing the spare belt');
r.mustApply(
  { type: 'PlaceMachine', kind: MachineKind.Washer, tileX: 14, tileY: 8 },
  'the spare Washer',
);
const spare = state.machines[state.machines.length - 1]!;
r.mustApply(
  { type: 'MoveMachine', machineId: spare.id, tileX: 14, tileY: 11 },
  'moving the spare Washer',
);
r.walkNear(spare);
r.mustApply({ type: 'DeconstructMachine', machineId: spare.id }, 'boxing the spare Washer');
const bin = state.machines.find((m) => m.kind === MachineKind.SellBin)!;
r.walkNear(bin);
r.mustApply({ type: 'SellBoxedMachine', item: ItemId.BoxedWasher }, 'scrapping the box');

// Twenty potatoes in, twenty bags out. The hopper is hand-loaded, then the line does the rest.
const washer = state.machines.find((m) => m.kind === MachineKind.Washer)!;
r.walkNear(washer);
r.mustApply(
  { type: 'LoadMachine', machineId: washer.id, count: POTATOES_FOR_THE_LINE },
  'loading the twenty',
);
const bagger = state.machines.find((m) => m.kind === MachineKind.Bagger)!;
let guard = 0;
while (bagger.outputCount < POTATOES_FOR_THE_LINE) {
  r.stepEmpty();
  guard += 1;
  if (guard > 60_000) {
    fail(`the line stalled at ${String(bagger.outputCount)} bags`);
  }
}
r.walkNear(bagger);
r.mustApply(
  { type: 'UnloadMachine', machineId: bagger.id, count: POTATOES_FOR_THE_LINE },
  'unloading the twenty bags',
);
if (!r.errand(IntentAction.Sell, bin.tileX, bin.tileY, ItemId.BaggedChips, POTATOES_FOR_THE_LINE)) {
  fail('the sale refused');
}
if (state.stats.itemsSold < POTATOES_FOR_THE_LINE) fail('fewer than twenty bags sold');
if (state.zones[0]!.name !== 'the potato strip') fail('the rename did not stick');

r.idle(200);

const old = loadFixture('factory-line');
const fixture = r.writeFixture(
  'factory-line',
  'The chip line, end to end: twenty hand-farmed russets go down Washer → belt → Slicer → ' +
    'Fryer → Seasoner → Bagger with five grabber arms and come out as twenty bagged chips ' +
    'sold at the bin. Opens with klapaucius — item 145 deleted the Chip Kitchen economy the ' +
    'original farmed, and the tech climb is soda-line’s story now — but the potatoes are ' +
    'honestly grown, because they have never been purchasable. Along the way: a deed bought, ' +
    'a Grow Zone created, painted and renamed, an Mk2 arm filtered to washed potatoes, a ' +
    'spare arm turned full circle and removed, a spare belt removed, a Speed dial on the ' +
    'Fryer, and a spare Washer moved, boxed by hand, and scrapped at 40%. Guards the whole ' +
    'factory: belt movement and hand-off, grabber swings, upgrade arithmetic, zone painting, ' +
    'and the machine-management verbs. Re-recorded 2026-08-27; see ' +
    'scripts/record-factory-line.ts.',
);
console.log(
  `factory-line re-recorded: ${String(fixture.ticks)} ticks, ${String(fixture.commands.length)} commands, ` +
    `hash ${old.expectedHash} -> ${fixture.expectedHash}\n` +
    `  farm cycles ${String(cycles)}, sold ${String(state.stats.itemsSold)}`,
);
