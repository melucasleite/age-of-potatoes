// The measured economy walk item 011 calls the deliverable: how many ticks does the
// gardener loop take to reach $150 cash, played headlessly with human-plausible pacing?
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs ./packages/sim/scripts/economy-walk.ts
//
// THE LOOP, as item 011 named it — minus one machine: plant, water with the 8-pour can,
// refill at the shore, harvest, sell. The "hand-process through a Chip Kitchen bought
// mid-run" step died with the kitchen (item 145 deleted the kind), so since 2026-08-27 this
// walks the RAW gardener loop; the measurement is slower and the number is not comparable to
// pre-145 runs. Everything is a walk-to errand, so every beat includes the walking time —
// nobody teleports — and a small reaction pause is added between actions, because a human
// does not issue the next command on the tick the last one resolved.
//
// This is a MEASUREMENT SCRIPT, not a golden fixture: it asserts nothing and pins nothing.
// Target band (item 011): 30,000–48,000 ticks (25–40 min at 20 Hz). If the number lands
// outside the band, the instruction is to report the miss, not to retune prices here.

import {
  type Command,
  type WorldState,
  CAN_CHARGES_MAX,
  CropId,
  IntentAction,
  ItemId,
  TICKS_PER_SECOND,
  createWorld,
  step,
} from '../src/index';
import { FIELD_ORIGIN_X, FIELD_ORIGIN_Y } from '../src/data';
import { isTileReady, itemCount, tileAt } from '../src/state';

const TARGET_CENTS = 15_000;
/** One second of human dithering between actions. */
const REACTION_TICKS = TICKS_PER_SECOND;

const state: WorldState = createWorld(20260813);

let commandsIssued = 0;
let refills = 0;
let batches = 0;

function run(commands: Command[]): void {
  step(state, { tick: state.tick, commands });
  commandsIssued += commands.length;
}
function idle(ticks: number): void {
  for (let i = 0; i < ticks && state.moneyCents < TARGET_CENTS; i++) run([]);
}
function waitIntent(): void {
  let guard = 0;
  while (state.player.intent !== null && guard < 4_000) {
    run([]);
    guard += 1;
  }
}
function errand(action: IntentAction, x: number, y: number, item = 0, count = 0): boolean {
  idle(REACTION_TICKS);
  const before = state.trace.length;
  run([{ type: 'WalkAndAct', action, tileX: x, tileY: y, item, count }]);
  const ok = state.trace.length > before;
  if (ok) waitIntent();
  return ok;
}

const row: { x: number; y: number }[] = [];
for (let i = 0; i < 8; i++) row.push({ x: FIELD_ORIGIN_X + i, y: FIELD_ORIGIN_Y });

const binTile = { x: FIELD_ORIGIN_X - 2, y: FIELD_ORIGIN_Y + 8 };
const shoreTile = { x: 12, y: 12 };

function sellAll(item: ItemId): void {
  const carried = itemCount(state, item);
  if (carried > 0) errand(IntentAction.Sell, binTile.x, binTile.y, item, carried);
}

while (state.moneyCents < TARGET_CENTS && state.tick < 200_000) {
  for (const { x, y } of row) {
    const tile = tileAt(state, x, y);
    if (tile !== null && tile.crop === CropId.None && itemCount(state, ItemId.PotatoSeed) > 0) {
      errand(IntentAction.Plant, x, y, CropId.RussetPotato);
    }
  }
  for (const { x, y } of row) {
    const tile = tileAt(state, x, y);
    if (tile === null || tile.crop === CropId.None) continue;
    if (state.player.canCharges <= 0) {
      errand(IntentAction.RefillCan, shoreTile.x, shoreTile.y);
      refills += 1;
    }
    errand(IntentAction.Water, x, y);
  }

  // While the row grows: wait like a person.
  let waited = 0;
  while (
    waited < 4_000 &&
    state.moneyCents < TARGET_CENTS &&
    !row.some((p) => {
      const tile = tileAt(state, p.x, p.y);
      return tile !== null && isTileReady(tile);
    })
  ) {
    run([]);
    waited += 1;
  }

  for (const { x, y } of row) {
    if (state.moneyCents >= TARGET_CENTS) break;
    const tile = tileAt(state, x, y);
    if (tile !== null && isTileReady(tile)) {
      errand(IntentAction.Harvest, x, y);
    }
  }
  batches += 1;

  sellAll(ItemId.RussetPotato);
}

const minutes = state.tick / (TICKS_PER_SECOND * 60);
console.log(`ticks to $150 cash: ${state.tick} (${minutes.toFixed(1)} min at 20 Hz)`);
console.log(
  `money ${state.moneyCents}c, batches ${batches}, refills ${refills}, ` +
    `commands ${commandsIssued}`,
);
console.log(
  `sold: ${state.stats.salesByItem
    .map((row) => `item${row.item}x${row.units}=${row.cents}c`)
    .join(' ')}`,
);
console.log('target band: 30,000-48,000 ticks (25-40 min)');
