// Re-record the `water-works` golden fixture from scratch, so that the fixture named after the
// liquid layer contains a liquid layer.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/record-water-works.ts
//
// **WHY THIS EXISTS** (item 139, measured by item 122 and confirmed by replay). The old
// `water-works.json` claimed, in its own description, four thousand ticks of a pump, a tank, two
// piped heads and an Irrigation Hub running under load. Replayed at HEAD it ended with **zero
// pipes, zero networks and four machines** — a Sell Bin and three Chip Kitchens. Every hydraulics
// command from tick 36417 on was refused for want of money: the session finished holding 6,600
// cents against a build costing roughly half a million. Its two `PlacePipe` runs and its one
// `RemovePipe` were refused as well, and additionally predated the tech that legalises them.
//
// The fixture was therefore a recording of a player CLICKING at plumbing, and the golden hash
// pinned the clicking. That is the exact disease `record-maintenance.ts` was written to cure a
// fortnight earlier — a fixture whose story died under a re-timing and went on hashing — and the
// cure is the one the fixtures README prescribes and that script's header states outright: **the
// honest repair for a recording whose story has died is a NEW recorded session, not a patched
// one.** So this is a new session under the old name, and its hash moves for reasons that have
// nothing to do with water.
//
// **THE MONEY IS EARNED. THERE IS NO `Cheat` IN HERE**, and that is a deliberate departure from
// `flavour-line` and `bottle-return`, which both open with `klapaucius`. Those two are about what
// a built line DOES, and 130,000 ticks of farming in front of them would have bought nothing but
// runtime. This fixture is about a build the old recording could not afford, so how it is
// afforded is half the point: if the climb is skipped, nobody ever finds out that the plumbing
// costs more than a hand-farm earns. It takes about a hundred thousand ticks, which is a
// hundredth of a second of replay, and it is the cheapest honest answer to "could a player
// actually get here".
//
// **WHAT UNDER LOAD MEANS NOW.** Item 140 made the pond infinite hours before this was recorded,
// so load is no longer "the pond ran low". Infinite source, finite throughput: the Pump is rated
// at 600,000 ml/min — 500 ml a tick — and the network hung off it wants 1,400 (a Tank's 600 and
// two heads' 400 each). Demand is therefore nearly three times supply by construction, which is
// what puts plan §5's round-robin throttle, the tank's fill-and-drain, and the shortfall path in
// `runNetwork` under a load that lasts rather than one that resolves.
//
// The script asserts the story actually happened — pipe torn up, network live, throttle engaged,
// tank both filled and drained, heads fired, every swept verb accepted — before it writes
// anything, so it cannot record a second zombie.

import { writeFileSync } from 'node:fs';

import {
  type Command,
  type WorldState,
  CONDITION_MAX,
  CropId,
  Direction,
  HAND_REACH_SUBTILES,
  IntentAction,
  ItemId,
  LiquidId,
  MachineKind,
  createWorld,
  hashState,
  step,
} from '../src/index';
import {
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  FIELD_TILES_HIGH,
  FIELD_TILES_WIDE,
  POND_ORIGIN_X,
  POND_ORIGIN_Y,
  machineSpec,
} from '../src/data';
import { type Machine, carriedCount, isTileReady, itemCount, tileAt } from '../src/state';
import { subtilesToTile } from '../src/units';
import { type GoldenFixture, fixturePath, loadFixture } from '../test/goldens';

const SEED = 51015;

/** The Chip Kitchen, east of the field on open ground — `maintenance`'s tile. */
const KITCHEN: [number, number] = [14, 4];
/** One tile west of the pond — shore, so a `RefillCan` errand aimed here succeeds. */
const SHORE_X = POND_ORIGIN_X - 1;
const SHORE_Y = POND_ORIGIN_Y;
/** The bank: one tile north of the pond's north-west corner. `bottle-return`'s pump tile. */
const PUMP: [number, number] = [POND_ORIGIN_X, POND_ORIGIN_Y - 1];

const state: WorldState = createWorld(SEED);

let jamsWhacked = 0;
let handRepairs = 0;

function stepEmpty(): void {
  step(state, { tick: state.tick, commands: [] });
}

/** Apply one command on the current tick; report whether the sim accepted it. */
function apply(command: Command): boolean {
  const before = state.trace.length;
  step(state, { tick: state.tick, commands: [command] });
  return state.trace.length > before;
}

function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(`refused: ${what}`);
}

function finishIntent(): void {
  let guard = 0;
  while (state.player.intent !== null) {
    stepEmpty();
    guard += 1;
    if (guard > 30_000) throw new Error('errand never completed');
  }
}

/** Issue one walk-to errand and wait it out. Refills the can first when watering dry. */
function errand(action: IntentAction, tileX: number, tileY: number, item = 0, count = 0): boolean {
  finishIntent();
  if (action === IntentAction.Water && state.player.canCharges <= 0) {
    if (!errand(IntentAction.RefillCan, SHORE_X, SHORE_Y)) throw new Error('refill refused');
  }
  const ok = apply({ type: 'WalkAndAct', action, tileX, tileY, item, count });
  if (ok) finishIntent();
  return ok;
}

function machineOfKind(kind: MachineKind): Machine | undefined {
  return state.machines.find((m) => m.kind === kind);
}

function bin(): Machine {
  const found = machineOfKind(MachineKind.SellBin);
  if (found === undefined) throw new Error('no sell bin in the world');
  return found;
}

function kitchen(): Machine | undefined {
  return machineOfKind(MachineKind.ChipKitchen);
}

/**
 * Walk to a tile with held directions and stop there.
 *
 * `record-maintenance.ts`'s walk, kept because the direct in-reach verbs below — `LoadMachine`,
 * `UnloadMachine`, `RepairMachine`, `WhackJam`, `RefillHopper` — have no walk-to errand of their
 * own. A `WalkAndAct` errand SYNTHESISES those commands on arrival and applies them WITHOUT
 * appending them to the trace, which is correct (the honest record of what the player did is the
 * click), and is precisely why a fixture full of errands can never cover them. Standing next to
 * the machine and pressing the key is a different, real affordance, and it is the only one that
 * puts the verb in the trace.
 */
function walkTo(targetX: number, targetY: number, within = 1): void {
  finishIntent();
  let guard = 0;
  const here = (): [number, number] => [
    subtilesToTile(state.player.xSub),
    subtilesToTile(state.player.ySub),
  ];
  const close = (): boolean => {
    const [px, py] = here();
    return Math.max(Math.abs(px - targetX), Math.abs(py - targetY)) <= within;
  };
  while (!close()) {
    guard += 1;
    if (guard > 20_000) throw new Error(`walk to ${targetX},${targetY} never arrived`);
    const dx = targetX * 256 + 128 - state.player.xSub;
    const dy = targetY * 256 + 128 - state.player.ySub;
    const desired =
      Math.abs(dx) >= Math.abs(dy)
        ? dx >= 0
          ? Direction.East
          : Direction.West
        : dy >= 0
          ? Direction.South
          : Direction.North;
    if (state.player.moveDir !== desired) apply({ type: 'SetMoveDirection', dir: desired });
    else stepEmpty();
  }
  if (state.player.moveDir !== Direction.None)
    apply({ type: 'SetMoveDirection', dir: Direction.None });
}

/**
 * Walk until the machine is genuinely IN REACH, by the sim's own rule.
 *
 * Not "stand on the tile south of it": `withinReachOfMachine` measures from the FOOTPRINT'S
 * CENTRE, so a 2×2 tank reached from one tile past its southern edge is already 3 tiles from the
 * middle of it and the verb is refused. The first draft of this script did exactly that and spent
 * a run finding out. Same arithmetic as the sim, so the recorder cannot disagree with it.
 */
function standBy(machine: Machine): void {
  const spec = machineSpec(machine.kind)!;
  const centreX = machine.tileX * 256 + spec.tilesWide * 128;
  const centreY = machine.tileY * 256 + spec.tilesHigh * 128;
  const inReach = (): boolean => {
    const dx = state.player.xSub - centreX;
    const dy = state.player.ySub - centreY;
    return dx * dx + dy * dy <= HAND_REACH_SUBTILES * HAND_REACH_SUBTILES;
  };
  if (inReach()) return;
  // Aim at the walkable tile below the footprint's middle column, then close the last step.
  walkTo(machine.tileX + (spec.tilesWide - 1), machine.tileY + spec.tilesHigh, 0);
  let guard = 0;
  while (!inReach()) {
    guard += 1;
    if (guard > 4_000) throw new Error(`never got within reach of machine ${String(machine.id)}`);
    const dx = centreX - state.player.xSub;
    const dy = centreY - state.player.ySub;
    const desired =
      Math.abs(dx) >= Math.abs(dy)
        ? dx >= 0
          ? Direction.East
          : Direction.West
        : dy >= 0
          ? Direction.South
          : Direction.North;
    if (state.player.moveDir !== desired) apply({ type: 'SetMoveDirection', dir: desired });
    else stepEmpty();
  }
  if (state.player.moveDir !== Direction.None) {
    apply({ type: 'SetMoveDirection', dir: Direction.None });
  }
}

// --- the field ------------------------------------------------------------------------

const ROWS: { x: number; y: number }[] = [];
for (let dy = 0; dy < FIELD_TILES_HIGH; dy++) {
  for (let dx = 0; dx < FIELD_TILES_WIDE; dx++) {
    ROWS.push({ x: FIELD_ORIGIN_X + dx, y: FIELD_ORIGIN_Y + dy });
  }
}

function sellCarried(item: ItemId): void {
  const carried = itemCount(state, item);
  if (carried <= 0) return;
  const at = bin();
  errand(IntentAction.Sell, at.tileX, at.tileY, item, carried);
}

/** Deliver carried potatoes: into the kitchen once it exists, otherwise to the bin. */
function deliverPotatoes(): void {
  const carried = itemCount(state, ItemId.RussetPotato);
  if (carried <= 0) return;
  const cook = kitchen();
  if (cook !== undefined) {
    const spec = machineSpec(MachineKind.ChipKitchen)!;
    const room = spec.inputCapacity - cook.inputCounts.reduce((a, b) => a + b, 0);
    const load = Math.min(carried, room);
    if (load > 0) {
      errand(IntentAction.Load, KITCHEN[0], KITCHEN[1], 0, load);
      return;
    }
  }
  sellCarried(ItemId.RussetPotato);
}

function sellBags(): void {
  const cook = kitchen();
  if (cook === undefined || cook.outputCount <= 0) return;
  const take = Math.min(cook.outputCount, 12 - carriedCount(state));
  if (take <= 0) return;
  errand(IntentAction.Unload, KITCHEN[0], KITCHEN[1], 0, take);
  sellCarried(ItemId.BaggedChips);
}

function whackIfJammed(): void {
  const cook = kitchen();
  if (cook !== undefined && cook.jammed) {
    if (!errand(IntentAction.WhackJam, KITCHEN[0], KITCHEN[1])) throw new Error('whack refused');
  }
}

/** One pass over the whole field: plant what is empty, water it, wait, harvest. */
function farmCycle(): void {
  for (const { x, y } of ROWS) {
    const tile = tileAt(state, x, y);
    if (tile !== null && tile.crop === CropId.None && itemCount(state, ItemId.PotatoSeed) > 0) {
      errand(IntentAction.Plant, x, y, CropId.RussetPotato);
    }
  }
  whackIfJammed();
  for (const { x, y } of ROWS) {
    const tile = tileAt(state, x, y);
    if (tile !== null && tile.crop !== CropId.None && !isTileReady(tile) && tile.moisture <= 0) {
      errand(IntentAction.Water, x, y);
    }
  }
  whackIfJammed();
  let waited = 0;
  while (
    waited < 8_000 &&
    !ROWS.every((p) => {
      const tile = tileAt(state, p.x, p.y);
      return tile === null || tile.crop === CropId.None || isTileReady(tile);
    })
  ) {
    stepEmpty();
    waited += 1;
    if (waited % 400 === 0) whackIfJammed();
  }
  for (const { x, y } of ROWS) {
    const tile = tileAt(state, x, y);
    if (tile === null || !isTileReady(tile)) continue;
    if (carriedCount(state) >= 10) deliverPotatoes();
    errand(IntentAction.Harvest, x, y);
  }
  deliverPotatoes();
  sellBags();
  whackIfJammed();
}

/**
 * A farming pass that leaves the potatoes in the player's arms rather than delivering them.
 *
 * Act 5 loads the kitchen BY HAND from arm's length, so the delivery step `farmCycle` performs —
 * a `WalkAndAct` errand, which leaves no `LoadMachine` in the trace — would take the crop away
 * before the verb this session exists to cover could be issued.
 */
function farmCycleNoDelivery(): void {
  for (const { x, y } of ROWS) {
    const tile = tileAt(state, x, y);
    if (tile !== null && tile.crop === CropId.None && itemCount(state, ItemId.PotatoSeed) > 0) {
      errand(IntentAction.Plant, x, y, CropId.RussetPotato);
    }
  }
  for (const { x, y } of ROWS) {
    const tile = tileAt(state, x, y);
    if (tile !== null && tile.crop !== CropId.None && !isTileReady(tile) && tile.moisture <= 0) {
      errand(IntentAction.Water, x, y);
    }
  }
  let waited = 0;
  while (
    waited < 8_000 &&
    !ROWS.every((p) => {
      const tile = tileAt(state, p.x, p.y);
      return tile === null || tile.crop === CropId.None || isTileReady(tile);
    })
  ) {
    stepEmpty();
    waited += 1;
  }
  for (const { x, y } of ROWS) {
    const tile = tileAt(state, x, y);
    if (tile === null || !isTileReady(tile)) continue;
    if (carriedCount(state) >= 11) break;
    errand(IntentAction.Harvest, x, y);
  }
}

/** Farm until the world holds `target` cents, or give up loudly. */
function farmUntil(target: number, what: string, limit = 60): void {
  let guard = 0;
  while (state.moneyCents < target) {
    farmCycle();
    guard += 1;
    if (guard > limit) {
      throw new Error(
        `never afforded ${what}: ${String(state.moneyCents)}c after ${String(state.tick)} ticks`,
      );
    }
  }
}

// --- Act 1: the farm that pays for the plumbing -----------------------------------------

farmUntil(10_000, 'the Chip Kitchen');
must(
  apply({
    type: 'PlaceMachine',
    kind: MachineKind.ChipKitchen,
    tileX: KITCHEN[0],
    tileY: KITCHEN[1],
  }),
  'the Chip Kitchen',
);

console.log(`kitchen at tick ${String(state.tick)}, ${String(state.moneyCents)}c`);

// --- Act 2: the research, one node at a time, each farmed for ----------------------------

const RESEARCH: [string, number][] = [
  ['fabrication-wash-and-slice', 6_000],
  ['fabrication-fryer', 12_000],
  ['fabrication-finishing', 20_000],
  ['charter-workshop', 80_000],
  ['hydraulics-pumps', 40_000],
  ['hydraulics-piped-sprinklers', 70_000],
];
for (const [techId, price] of RESEARCH) {
  farmUntil(price, techId);
  must(apply({ type: 'ResearchTech', techId: techId as never }), techId);
  console.log(
    `researched ${techId} at tick ${String(state.tick)}, ${String(state.moneyCents)}c left, ` +
      `${String(state.stats.itemsSold)} items sold`,
  );
}

// --- Act 3: the plumbing ------------------------------------------------------------------
//
// Pipe first, machine second, pump last — `soda-line`'s proven order, followed rather than
// re-derived so this fixture is not a second opinion about how `rebuildNetworks` forms a network.

/**
 * **THE MAIN IS THE OLD FIXTURE'S MAIN, TILE FOR TILE.**
 *
 * Nine tiles west along the headland at y = 12, then eight north up the west edge at x = 3: an
 * L around two sides of the field, exactly the run the recording this replaces laid at tick
 * 30,393 and then could not afford to connect. Kept verbatim for two reasons. It is the routing
 * the layer's designers drew, so re-deriving one here would make this fixture a second opinion
 * about pipe geometry. And `apps/web/src/game/input/pipe-run.test.ts` reads this very path out
 * of this very file to prove the client's drag gesture can express it — *"a player can reproduce
 * water-works.json by hand"*, in executable form — so a fixture that quietly restraightened its
 * own main would delete a client test's subject without touching the client.
 *
 * What is new is that a Pump now stands at (12,12), on the pond's north bank and against the
 * main's first tile, so for the first time the run carries water.
 */
const MAIN: [number, number][] = [];
for (let x = 11; x >= 3; x--) MAIN.push([x, 12]);
for (let y = 11; y >= FIELD_ORIGIN_Y; y--) MAIN.push([3, y]);

/**
 * The spur the player lays first and tears back up: two tiles north off the main's east end,
 * aimed at a head in the middle of the field before the west leg made a shorter answer obvious.
 * Refunded in full, because misplacement is never a fine (plan §4).
 */
const SPUR: [number, number][] = [
  [11, 11],
  [11, 10],
];

/** The Tank, west of the main's north leg where there is room for a 2×2. */
const TANK: [number, number] = [1, 10];
/** Two heads on the field's west column, each against the main. */
const HEAD_A: [number, number] = [4, 5];
const HEAD_B: [number, number] = [4, 9];

farmUntil(108_000, 'the plumbing', 90);

const pipePath = (path: [number, number][]): { x: number; y: number }[] =>
  path.map(([x, y]) => ({ x, y }));

must(apply({ type: 'PlacePipe', liquid: LiquidId.Water, path: pipePath(MAIN) }), 'the water main');
must(apply({ type: 'PlacePipe', liquid: LiquidId.Water, path: pipePath(SPUR) }), 'the tank spur');
// And straight back up — the one `RemovePipe` the whole golden set now accepts.
must(apply({ type: 'RemovePipe', path: pipePath(SPUR) }), 'tearing the spur up');
if (state.pipes.length !== MAIN.length) {
  throw new Error(
    `${String(state.pipes.length)} pipes after the tear-up, wanted ${String(MAIN.length)}`,
  );
}

const BUILD: [MachineKind, [number, number], string][] = [
  [MachineKind.Tank, TANK, 'the Tank'],
  [MachineKind.PipedSprinkler, HEAD_A, 'the first head'],
  [MachineKind.Pump, PUMP, 'the Pump'],
];
for (const [kind, [tileX, tileY], what] of BUILD) {
  must(apply({ type: 'PlaceMachine', kind, tileX, tileY }), what);
}

const pump = machineOfKind(MachineKind.Pump)!;
const tank = machineOfKind(MachineKind.Tank)!;
const headA = machineOfKind(MachineKind.PipedSprinkler)!;
if (pump.network === 0) throw new Error('the pump joined no network');
if (tank.network !== pump.network) throw new Error('the tank is on a different network');
if (headA.network !== pump.network) throw new Error('the head is on a different network');

console.log(
  `plumbed at tick ${String(state.tick)}: ${String(state.pipes.length)} pipes, ` +
    `network ${String(pump.network)}, ${String(state.moneyCents)}c left`,
);

// --- Act 4: under load, in two halves, which is the whole argument for owning a tank --------
//
// **THE SECOND HEAD IS THE EXPERIMENT.** A `PipedSprinkler` spends one whole-patch charge —
// `SPRINKLER_CHARGE_ML`, 36,000 ml — every 101 ticks, so its sustained draw is about 356 ml a
// tick. The Pump is rated at 600,000 ml/min, which is 500. One head therefore lives inside the
// pump's rate with roughly 144 ml a tick to spare, and that spare is what a Tank is *for*: it
// banks the surplus while the head is topped up.
//
// Two heads want 713 sustained against 500 supplied, and no amount of patience fixes that. So the
// second head does not merely add load — it tips a network that was comfortably in surplus into a
// permanent shortfall, and the tank pays the difference until it is empty and then cannot. That
// is plan §5's readable failure (`distribute`'s round-robin slowing *everyone* slightly rather
// than starving whoever sorts first) arriving as a consequence of one build decision, which is
// the only way a fixture can pin it honestly.
//
// The old recording claimed 4,000 ticks of this and delivered none. This is 2,500 + 4,000, with
// nobody's hands on anything for either stretch.

interface LoadReport {
  drawnMl: number;
  throttledTicks: number;
  tankLow: number;
  tankHigh: number;
  firings: number;
}

function runUnderLoad(ticks: number): LoadReport {
  const heads = state.machines.filter((m) => m.kind === MachineKind.PipedSprinkler);
  const drawnBefore = state.stats.waterDrawnMl;
  const report: LoadReport = {
    drawnMl: 0,
    throttledTicks: 0,
    tankLow: tank.tankMl,
    tankHigh: tank.tankMl,
    firings: 0,
  };
  for (let i = 0; i < ticks; i++) {
    const before = heads.map((h) => h.tankMl);
    stepEmpty();
    const network = state.networks.find((n) => n.id === pump.network);
    if (network !== undefined && network.demandMl > network.deliveredMl) report.throttledTicks += 1;
    if (tank.tankMl > report.tankHigh) report.tankHigh = tank.tankMl;
    if (tank.tankMl < report.tankLow) report.tankLow = tank.tankMl;
    // A head that LOST water spent a charge on its patch; intake only ever adds.
    for (let h = 0; h < heads.length; h++) if (heads[h]!.tankMl < before[h]!) report.firings += 1;
  }
  report.drawnMl = state.stats.waterDrawnMl - drawnBefore;
  return report;
}

const surplus = runUnderLoad(2_500);
console.log(
  `one head: ${String(surplus.drawnMl)} ml drawn, throttled ${String(surplus.throttledTicks)}, ` +
    `tank ${String(surplus.tankLow)}..${String(surplus.tankHigh)} ml, ` +
    `${String(surplus.firings)} firings`,
);

must(
  apply({
    type: 'PlaceMachine',
    kind: MachineKind.PipedSprinkler,
    tileX: HEAD_B[0],
    tileY: HEAD_B[1],
  }),
  'the second head',
);
const headB = state.machines.find(
  (m) => m.kind === MachineKind.PipedSprinkler && m.id !== headA.id,
)!;
if (headB.network !== pump.network) throw new Error('the second head is on a different network');
const tankAtTip = tank.tankMl;

const shortfall = runUnderLoad(4_000);
console.log(
  `two heads: ${String(shortfall.drawnMl)} ml drawn, throttled ${String(shortfall.throttledTicks)}, ` +
    `tank ${String(shortfall.tankLow)}..${String(shortfall.tankHigh)} ml (was ${String(tankAtTip)}), ` +
    `${String(shortfall.firings)} firings`,
);

// --- Act 5: the hands the automation does not replace --------------------------------------
//
// **EVERY VERB BELOW IS ISSUED FROM WHERE THE PLAYER IS STANDING, AND THAT IS THE POINT.** A
// `WalkAndAct` errand synthesises `LoadMachine`, `WhackJam` and the rest on arrival and applies
// them WITHOUT a trace entry — correctly, because the honest record of what the player did is the
// click. Which means a fixture built entirely out of errands can never cover the in-reach verbs,
// and the golden set was built entirely out of errands. Item 139's fixed coverage counter found
// twelve of them uncovered; these are the ones this session honestly reaches.

// 1. The tank the second head emptied, topped up by hand from the pond. `RefillHopper` on
//    anything with a tank pours from the nearest reservoir — the bucket the pump made obsolete,
//    which is exactly the tool you reach for when the pump is not keeping up.
standBy(tank);
must(apply({ type: 'RefillHopper', machineId: tank.id }), 'topping the tank up by hand');
if (tank.tankMl <= 0) throw new Error('the hand-fill poured nothing');
const handPour = tank.tankMl;

// 2. The second head comes back up. It is the thing that tipped the network short, so taking it
//    up is the fix a player would actually make — and the box goes back to the stand for scrap.
standBy(headB);
must(apply({ type: 'DeconstructMachine', machineId: headB.id }), 'boxing the second head');
if (itemCount(state, ItemId.BoxedPipedSprinkler) !== 1) throw new Error('no box in the bag');
const beforeScrap = state.moneyCents;
must(apply({ type: 'SellBoxedMachine', item: ItemId.BoxedPipedSprinkler }), 'selling the box');
if (state.moneyCents <= beforeScrap) throw new Error('the box scrapped for nothing');

// 3. The kitchen, by hand, from arm's length: potatoes in, bags out, jams knocked loose and the
//    cell nursed back up. A hundred and fifty thousand ticks of feeding leave it deep in the worn
//    regime, which is where the jams live.
const cook = kitchen()!;
const kitchenSpec = machineSpec(MachineKind.ChipKitchen)!;
let loaded = 0;
let unloaded = 0;
let guardOps = 0;

while ((jamsWhacked < 2 || handRepairs < 6 || loaded < 2 || unloaded < 2) && guardOps < 40) {
  guardOps += 1;

  // Potatoes for the hopper — grown, never bought, like everything else in this session.
  farmCycleNoDelivery();
  standBy(cook);
  const carried = itemCount(state, ItemId.RussetPotato);
  const room = kitchenSpec.inputCapacity - cook.inputCounts.reduce((a, b) => a + b, 0);
  const load = Math.min(carried, room);
  if (
    load > 0 &&
    apply({ type: 'LoadMachine', machineId: cook.id, item: ItemId.RussetPotato, count: load })
  ) {
    loaded += 1;
  }

  // Stand there and watch it work.
  //
  // **THE ORDER OF THESE TWO IS THE WHOLE TIMING OF THIS ACT.** Jams only happen below
  // `CONDITION_EFFECT_THRESHOLD`, so hold-to-repair and waiting-for-a-jam are opposed: the first
  // draft nursed the cell back up on every pass and then waited a hundred thousand ticks for the
  // jam it had just prevented. So the machine is allowed to wear down to where jams live FIRST,
  // and the repair is what happens after — which is also the order a player discovers it in.
  for (let i = 0; i < 2_500; i++) {
    if (cook.jammed) {
      if (apply({ type: 'WhackJam', machineId: cook.id })) jamsWhacked += 1;
      continue;
    }
    if (jamsWhacked >= 2 && handRepairs < 6) {
      if (apply({ type: 'RepairMachine', machineId: cook.id })) handRepairs += 1;
      continue;
    }
    stepEmpty();
  }

  if (cook.outputCount > 0) {
    const take = Math.min(cook.outputCount, 12 - carriedCount(state));
    if (take > 0 && apply({ type: 'UnloadMachine', machineId: cook.id, count: take }))
      unloaded += 1;
    sellCarried(ItemId.BaggedChips);
  }
}

console.log(
  `hands: loaded ${String(loaded)}, unloaded ${String(unloaded)}, jams ${String(jamsWhacked)}, ` +
    `repairs ${String(handRepairs)}, kitchen condition ${String(cook.condition)}, ` +
    `hand pour ${String(handPour)} ml, tick ${String(state.tick)}`,
);

// 4. **THE CLOSING BEAT, AND THE OTHER HALF OF THE SAME WISH.** The heads water the field with
//    nobody's hands on it; a zone with auto-replant set does the planting the same way. The node
//    that legalises it — `agronomy-seed-hopper`, 120,000 — is the single most expensive thing
//    this session buys, and it is bought LAST, out of money farmed after the plumbing was already
//    standing. Which is the honest order: automation is what you can afford once the thing you
//    automated has been paying for a while.
farmUntil(120_000, 'the seed hopper', 90);
must(apply({ type: 'ResearchTech', techId: 'agronomy-seed-hopper' as never }), 'the seed hopper');

const zoneRect = { x: FIELD_ORIGIN_X, y: FIELD_ORIGIN_Y, w: FIELD_TILES_WIDE, h: FIELD_TILES_HIGH };
must(apply({ type: 'CreateZone', rect: zoneRect, crop: CropId.RussetPotato }), 'zoning the field');
const zone = state.zones[state.zones.length - 1]!;
must(apply({ type: 'SetZoneAutoReplant', zoneId: zone.id, on: true }), 'auto-replant on');
if (!zone.autoReplant) throw new Error('the zone did not take the setting');

// A tail with the lot running itself: the head watering, the zone replanting, the tank refilling
// now that the network is back inside the pump's rate.
for (let i = 0; i < 1_200; i++) stepEmpty();

console.log(
  `close: zone ${String(zone.id)} autoReplant=${String(zone.autoReplant)}, ` +
    `tank ${String(tank.tankMl)} ml, pipes ${String(state.pipes.length)}, ` +
    `networks ${String(state.networks.length)}, tick ${String(state.tick)}, ` +
    `${String(state.moneyCents)}c`,
);

// 5. **THE THIRD LEG OF THE SAME WISH: the harvest sells itself.** The heads water the field
//    without hands and the zone replants it without hands; item 087's arm-into-the-bin is what
//    closes the sentence. `logistics-belts` buys the belt and a Mk1 arm; `logistics-belts-fast`
//    buys the Mk2, and it is bought for exactly one reason — **a Mk1 arm cannot hold a filter**
//    (`GrabberSpec.filterable`), and an unfiltered arm standing next to a Sell Bin is a machine
//    that will sell whatever reaches it. The bin buys anything that is not a seed.
for (const [techId, price] of [
  ['logistics-belts', 25_000],
  ['logistics-belts-fast', 90_000],
] as [string, number][]) {
  farmUntil(price, techId, 90);
  must(apply({ type: 'ResearchTech', techId: techId as never }), techId);
}

// The bin comes to the kitchen rather than a twenty-tile belt going to the bin. Moving it is
// free and it is what a player who has stopped carrying bags by hand would actually do.
const till = bin();
must(apply({ type: 'MoveMachine', machineId: till.id, tileX: 15, tileY: 9 }), 'moving the bin');

must(
  apply({ type: 'PlaceGrabber', tier: 2, tileX: 15, tileY: 6, dir: Direction.South, filter: 0 }),
  'the Mk2 arm on the kitchen',
);
must(
  apply({ type: 'PlaceBelt', tier: 1, tileX: 15, tileY: 7, dir: Direction.South, lengthTiles: 1 }),
  'the belt',
);
must(
  apply({ type: 'PlaceGrabber', tier: 1, tileX: 15, tileY: 8, dir: Direction.South, filter: 0 }),
  'the Mk1 arm on the bin',
);
const armA = state.grabbers.find((g) => g.tileY === 6)!;
const armB = state.grabbers.find((g) => g.tileY === 8)!;
const belt = state.belts[state.belts.length - 1]!;

// Feed it and stand back. What is being pinned is that money arrives with nobody touching it.
farmCycleNoDelivery();
standBy(cook);
{
  const carried = itemCount(state, ItemId.RussetPotato);
  const room = kitchenSpec.inputCapacity - cook.inputCounts.reduce((a, b) => a + b, 0);
  const load = Math.min(carried, room);
  if (load > 0) {
    must(
      apply({ type: 'LoadMachine', machineId: cook.id, item: ItemId.RussetPotato, count: load }),
      'the last hand-load',
    );
  }
}
// **SERVICE IT BEFORE YOU WALK AWAY FROM IT**, which is the whole point of the rung: hands-free
// only pays if the machine is out of the worn regime, because below
// `CONDITION_EFFECT_THRESHOLD` it jams and a jammed line is a line waiting for a hand. The first
// draft skipped this and banked exactly nothing across three thousand ticks — the kitchen sat
// jammed at condition 350 with twenty potatoes in its hopper.
if (cook.jammed) {
  must(apply({ type: 'WhackJam', machineId: cook.id }), 'the jam before the hands-free run');
  jamsWhacked += 1;
}
while (cook.condition < CONDITION_MAX) {
  must(apply({ type: 'RepairMachine', machineId: cook.id }), 'servicing the kitchen');
  handRepairs += 1;
}

const beforeHandsFree = state.moneyCents;
for (let i = 0; i < 6_000; i++) stepEmpty();
const handsFreeEarnings = state.moneyCents - beforeHandsFree;

// The filter, which is paperwork rather than a keypress at the machine — `SetGrabberFilter` is
// the one arm verb that is deliberately NOT reach-gated.
must(
  apply({ type: 'SetGrabberFilter', grabberId: armA.id, filter: ItemId.BaggedChips }),
  'filtering the arm to bagged chips',
);
if (armA.filter !== ItemId.BaggedChips) throw new Error('the arm did not take the filter');

// And the same simplification the water main got: the middle of the run was never needed. The
// belt and the second arm come up, the bin moves one tile closer, and the Mk2 posts straight
// into it. Misplacement is never a fine (plan §4) — both refund in full.
must(apply({ type: 'RemoveBelt', beltId: belt.id }), 'taking the belt up');
must(apply({ type: 'RemoveGrabber', grabberId: armB.id }), 'taking the second arm up');
must(apply({ type: 'MoveMachine', machineId: till.id, tileX: 15, tileY: 7 }), 'the bin one closer');
if (state.belts.length !== 0) throw new Error('the belt survived its own removal');
if (state.grabbers.length !== 1) throw new Error('the wrong number of arms is left standing');

// One more hopper's worth, so the shortened chain is measured against something to sell rather
// than against an empty kitchen — which is what the first run of this leg actually measured.
farmCycleNoDelivery();
standBy(cook);
{
  const carried = itemCount(state, ItemId.RussetPotato);
  const room = kitchenSpec.inputCapacity - cook.inputCounts.reduce((a, b) => a + b, 0);
  const load = Math.min(carried, room);
  if (load > 0) {
    must(
      apply({ type: 'LoadMachine', machineId: cook.id, item: ItemId.RussetPotato, count: load }),
      'the hopper for the shortened chain',
    );
  }
}

const beforeDirect = state.moneyCents;
for (let i = 0; i < 4_000; i++) stepEmpty();
const directEarnings = state.moneyCents - beforeDirect;

console.log(
  `hands-free: ${String(handsFreeEarnings)}c through the belt, ` +
    `${String(directEarnings)}c arm-straight-into-bin, arm filter ${String(armA.filter)}, ` +
    `tick ${String(state.tick)}`,
);

// --- The story, asserted before anything is written -----------------------------------------
//
// A recorder that writes whatever happened records a zombie the first time the economy shifts
// underneath it. That is not a hypothetical here: it is the exact way the fixture this replaces
// died, and the way `maintenance` died before it. So every claim the description makes below is
// checked here first, and a miss throws rather than writing.

function insist(ok: boolean, what: string): void {
  if (!ok) throw new Error(`the session did not do what it claims: ${what}`);
}

insist(state.pipes.length === MAIN.length, 'the main survived and the spur did not');
insist(state.networks.length === 1, 'exactly one network');
insist(pump.network === state.networks[0]!.id, 'the pump is on it');

insist(surplus.throttledTicks === 0, 'one head never throttled the network');
insist(surplus.tankHigh > 250_000, 'the tank banked the surplus');
insist(surplus.firings > 10, 'the head fired repeatedly on one-head load');

insist(shortfall.throttledTicks > 2_000, 'two heads throttled the network for thousands of ticks');
insist(shortfall.tankLow === 0, 'the tank was drained to empty paying the difference');
insist(shortfall.firings > surplus.firings, 'two heads fired more often than one');

insist(
  surplus.drawnMl + shortfall.drawnMl > 3_000_000,
  'over three million millilitres moved under load',
);
insist(handPour > 900_000, 'the hand-fill filled the tank');
insist(jamsWhacked >= 2 && handRepairs >= 6, 'the kitchen jammed and was nursed back');
insist(loaded >= 2 && unloaded >= 2, 'the kitchen was fed and emptied from arm’s length');
insist(state.stats.cheatsUsed === 0, 'NO CHEAT — every cent of this was farmed');
insist(handsFreeEarnings > 0, 'the belt-and-two-arms run banked money with nobody touching it');
insist(directEarnings > 0, 'the arm kept selling once the belt between it and the bin came up');
insist(armA.filter === ItemId.BaggedChips, 'the surviving arm is filtered to bags');

/**
 * And the reason this fixture was re-recorded at all: all twelve of the verbs item 139's fixed
 * coverage counter found uncovered are covered by this session, and `RemovePipe` — attempted by
 * the fixture this replaces and accepted by nobody in the whole golden set — is one of them.
 */
const SWEPT = [
  'PlacePipe',
  'RemovePipe',
  'LoadMachine',
  'UnloadMachine',
  'RefillHopper',
  'RepairMachine',
  'WhackJam',
  'DeconstructMachine',
  'SellBoxedMachine',
  'SetZoneAutoReplant',
  'RemoveBelt',
  'RemoveGrabber',
  'SetGrabberFilter',
] as const;
const accepted = new Set(state.trace.map((entry) => entry.command.type));
for (const verb of SWEPT) insist(accepted.has(verb), `${verb} reached the trace`);

// --- Write the fixture ------------------------------------------------------------------
const old = loadFixture('water-works');
const fixture: GoldenFixture = {
  name: 'water-works',
  description:
    'The liquid layer under a load that lasts, on money that was farmed rather than granted — ' +
    'and then the lot learning to run without hands. Hand-farms the 8×8 field through a Chip ' +
    'Kitchen for about a hundred thousand ticks, long enough to sell the 200 items the Corporate ' +
    'Workshop demands and pay for the Fabrication and Hydraulics climb, then lays THE OLD ' +
    'RECORDING’S OWN 17-TILE MAIN, tile for tile — nine west along the headland and eight north ' +
    'up the field’s west edge — drags a two-tile spur off its east end and tears it straight ' +
    'back up (the one RemovePipe the golden set accepts), and hangs a Tank ' +
    `and one piped head off the main behind a Pump. ONE HEAD LIVES INSIDE THE PUMP'S 500 ml/tick ` +
    `AND THE TANK BANKS THE SURPLUS: ${String(surplus.drawnMl)} ml drawn over 2,500 untouched ` +
    `ticks, nothing throttled, the tank climbing to ${String(surplus.tankHigh)} ml. A SECOND HEAD ` +
    `TIPS IT SHORT AND THE TANK PAYS UNTIL IT CANNOT: ${String(shortfall.drawnMl)} ml over 4,000 ` +
    `more ticks, plan §5's round-robin throttling on ${String(shortfall.throttledTicks)} of them, ` +
    'the tank drained to empty. Then the three legs of one wish: the tank topped up by bucket ' +
    'and the second head boxed and scrapped; the kitchen fed, emptied, unjammed and repaired ' +
    'from arm’s length; the field zoned to replant itself; and a Mk2 arm, a belt and a Mk1 arm ' +
    `banking ${String(handsFreeEarnings)}c into a moved Sell Bin with nobody touching anything, ` +
    'before the belt and the second arm come up as unnecessary and the filtered arm posts ' +
    `straight into the bin for ${String(directEarnings)}c more. Pins the one-ledger flow model, ` +
    'the geometric network ids, and THIRTEEN command verbs — ten of which no fixture in the set ' +
    'accepted before item 139 fixed the coverage counter to count accepted commands instead of ' +
    'attempted ones. Re-recorded 2026-08-18 by scripts/record-water-works.ts, which asserts ' +
    'every beat above before writing: the fixture this replaces described the plumbing and did ' +
    'none of it, because its session ran out of money 76× short and every hydraulics command in ' +
    'it — including that RemovePipe — was silently refused.',
  seed: SEED,
  ticks: state.tick,
  expectedHash: hashState(state),
  commands: state.trace.map((entry) => ({ tick: entry.tick, command: entry.command })),
};

writeFileSync(fixturePath('water-works'), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  `water-works re-recorded: ${fixture.ticks} ticks, ${fixture.commands.length} commands, ` +
    `hash ${old.expectedHash} -> ${fixture.expectedHash}\n` +
    `  swept verbs: ${SWEPT.join(', ')}`,
);
