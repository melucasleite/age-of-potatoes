// Re-time the fixtures whose recorded sessions the solid pond (item 080) knocked off their
// schedule — with item 081 (a soaked tile refuses the pour) and item 073 (the twenty-pour
// can) riding along.
//
//   node --import ./packages/sim/scripts/node-resolve-hook.mjs \
//     ./packages/sim/scripts/amend-goldens-for-water.ts
//
// WHY, AND WHY ONLY THESE THREE. Replaying all nineteen fixtures with a divergence detector
// found six whose recorded sessions held a movement key through the pond's corner. Under
// item 080 the farmer stops at the bank instead of crossing, ends the held run displaced,
// and every errand walked from the displaced spot takes a different number of ticks — the
// crop timeline slides under the recorded schedule and money runs late. The six separate:
//
//   - `the-farm` and `worn-to-zero` replay green anyway (worn-to-zero's three refused
//     `RefillCan`s are item 073's relaxation: a twenty-pour can still full refuses the
//     top-up, harmlessly). Commands stay frozen; only hashes repin, via `goldens:regen`.
//   - `depot-run` was re-timed by re-running the committed `amend-depot-for-armful.ts`
//     machinery against today's sim — its deferral-and-earn shape is exactly this disease.
//   - `soda-line`, `rotate-and-box`, `junction-loop` — this script, which is
//     `amend-goldens-for-can.ts` (commit 216cd81) adapted for water: the same drift-shifted
//     replay, proactive reach walks, refill trips, and deferred arc purchases, plus two new
//     pieces. One, EVERY corrective walk skirts the pond — the amender's own dead-reckoning
//     obeys item 080, sidestepping perpendicular when the next tile on the aimed axis is
//     wet. Two, the deferred queue retries PER-TYPE FIFO rather than head-only: id order is
//     a per-entity-type fact (machines, grabbers, belts, pipes each number their own), so a
//     pipe stuck behind a not-yet-affordable tech node must not stall the research that
//     would legalise it.
//
// A REFUSED RECORDED BEAT STAYS IN THE FILE at its attempted tick, exactly the can
// amender's rule: it replays to the same refusal deterministically, the coverage gate still
// counts the verb, and the session still says what was asked. (`soda-line` has carried seven
// such dead pipe beats since the can amend — recorded before their tech landed in that
// re-timing — and this pass finally lands them, because deferral now spans types.)
//
// Committed rather than thrown away because it is the provenance of the amended files — the
// fixtures README's history table points here.

import { writeFileSync } from 'node:fs';

import {
  type Command,
  type WorldState,
  CropId,
  Direction,
  IntentAction,
  ItemId,
  MachineKind,
  TECH_NODES,
  createWorld,
  hashState,
  step,
  waterAtSubtile,
} from '../src/index';
import { HAND_REACH_SUBTILES_SQUARED, itemSpec } from '../src/data';
import { isTileReady, itemCount, machineById, machineCentreSubtiles, tileAt } from '../src/state';
import { reservoirAdjacentToTile, nearestReservoir } from '../src/water';
import { SUBTILE, subtilesToTile, tileCentreSubtiles } from '../src/units';
import { type FixtureCommand, type GoldenFixture, fixturePath, loadFixture } from '../test/goldens';

const AMEND: readonly string[] = ['soda-line', 'rotate-and-box', 'junction-loop'];

/**
 * Arc-critical verbs retried later when the slid timeline reaches them short of money, a
 * milestone, a tech node, or a machine state. The can amender's set, widened: the pipes and
 * the rotation-boxing-upgrading verbs are the story `soda-line` and `rotate-and-box` exist
 * to pin, and a shrug would quietly kill it.
 */
const DEFERRABLE = new Set<Command['type']>([
  'ResearchTech',
  'PlaceMachine',
  'PlaceBelt',
  'PlaceGrabber',
  'PlacePipe',
  'RemovePipe',
  'RemoveBelt',
  'RemoveGrabber',
  'CreateContract',
  'CancelContract',
  'LoadCart',
  'DispatchCart',
  'BuyDeed',
  'BuyItem',
  'UpgradeMachine',
  'RotateGrabber',
  'SetGrabberFilter',
  'SellBoxedMachine',
  'DeconstructMachine',
  // The hand-feed beats. Refused when the slid timeline reaches them empty-handed, and a
  // fixture whose kitchens never eat produces nothing — which starves every
  // production-milestone Charter behind it. Deferred, they land the moment the tail farm
  // puts potatoes back in the player's arms.
  'LoadMachine',
  'UnloadMachine',
  'RefillHopper',
]);

interface Session {
  name: string;
  state: WorldState;
  out: FixtureCommand[];
  refills: number;
  correctiveWalks: number;
  refused: string[];
  deferred: Command[];
}

function stepEmpty(session: Session): void {
  step(session.state, { tick: session.state.tick, commands: [] });
}

/** Apply one command on the current tick, recording it and whether the sim accepted it. */
function apply(session: Session, command: Command, injected: boolean): boolean {
  const before = session.state.trace.length;
  session.out.push({ tick: session.state.tick, command });
  step(session.state, { tick: session.state.tick, commands: [command] });
  const applied = session.state.trace.length > before;
  if (!applied) {
    // An INJECTED refusal is amender noise and is dropped. A refused RECORDED command stays
    // in the list, exactly as the recordings kept theirs: it replays to the same refusal,
    // and the coverage gate counts the attempt.
    if (injected) session.out.pop();
    else session.refused.push(`t${String(session.state.tick - 1)} ${command.type}`);
  }
  return applied;
}

/**
 * Retry deferred commands PER-TYPE FIFO: the first entry of each type gets a try, and a
 * refusal blocks only its own type. Ids are numbered per entity type, so this keeps every
 * id-bearing order while letting research land around a pipe that needs it first.
 */
function retryDeferred(session: Session): void {
  let progressed = true;
  while (progressed && session.deferred.length > 0) {
    progressed = false;
    const blockedTypes = new Set<Command['type']>();
    for (let i = 0; i < session.deferred.length; i++) {
      const command = session.deferred[i]!;
      if (blockedTypes.has(command.type)) continue;
      const point = reachPoint(session.state, command);
      if (
        point !== null &&
        distSq(session.state, point.xSub, point.ySub) > HAND_REACH_SUBTILES_SQUARED
      ) {
        // Do not chase reach between recorded entries; wait for a quiet moment.
        blockedTypes.add(command.type);
        continue;
      }
      if (apply(session, command, true)) {
        session.deferred.splice(i, 1);
        progressed = true;
        break;
      }
      blockedTypes.add(command.type);
    }
  }
}

/**
 * Buy a node AND any prerequisites the tree has grown since the session was recorded.
 *
 * `hydraulics-soda-mixing` gained a `logistics-belts` requirement in a rebalance after
 * `soda-line` was recorded ("prerequisites are checked at PURCHASE" — the node's own comment
 * records the change), so the recorded session can no longer buy it as played. The honest
 * repair is the same as every deferral: the same economy buys what the tree now demands,
 * prerequisites first, each purchase a real command in the record.
 */
function tryResearchWithPrereqs(session: Session, techId: string): boolean {
  if (session.state.unlocked.includes(techId)) return true;
  const node = TECH_NODES.find((n) => n.id === techId);
  if (node === undefined) return false;
  for (const req of node.requires) {
    if (!session.state.unlocked.includes(req)) tryResearchWithPrereqs(session, req);
  }
  return apply(session, { type: 'ResearchTech', techId }, true);
}

/** Like `retryDeferred`, but willing to walk to whatever reach a deferred command wants. */
function retryDeferredWalking(session: Session): void {
  let progressed = true;
  while (progressed && session.deferred.length > 0) {
    progressed = false;
    const blockedTypes = new Set<Command['type']>();
    for (let i = 0; i < session.deferred.length; i++) {
      const command = session.deferred[i]!;
      if (blockedTypes.has(command.type)) continue;
      if (command.type === 'ResearchTech') {
        if (tryResearchWithPrereqs(session, command.techId)) {
          session.deferred.splice(i, 1);
          progressed = true;
          break;
        }
        blockedTypes.add(command.type);
        continue;
      }
      const point = reachPoint(session.state, command);
      if (
        point !== null &&
        distSq(session.state, point.xSub, point.ySub) > HAND_REACH_SUBTILES_SQUARED
      ) {
        finishIntent(session);
        walkUntil(
          session,
          () => distSq(session.state, point.xSub, point.ySub) <= 300 * 300,
          () => point,
        );
      }
      if (apply(session, command, true)) {
        session.deferred.splice(i, 1);
        progressed = true;
        break;
      }
      blockedTypes.add(command.type);
    }
  }
}

function stepTo(session: Session, tick: number): void {
  while (session.state.tick < tick) stepEmpty(session);
}

function finishIntent(session: Session): void {
  let guard = 0;
  while (session.state.player.intent !== null) {
    stepEmpty(session);
    guard += 1;
    if (guard > 5_000) throw new Error(`${session.name}: errand never completed`);
  }
}

function distSq(state: WorldState, xSub: number, ySub: number): number {
  const dx = state.player.xSub - xSub;
  const dy = state.player.ySub - ySub;
  return dx * dx + dy * dy;
}

/**
 * Dead-reckon toward a point with held directions until `reached` says stop — SKIRTING THE
 * POND (item 080): when the next tile ahead on the aimed axis is wet, hold the perpendicular
 * direction toward the target (or deterministically away when aligned) until the way clears.
 * Every tick is re-aimed against the live world, so the walk cannot drift.
 */
function walkUntil(
  session: Session,
  reached: () => boolean,
  aim: () => { xSub: number; ySub: number },
): void {
  const state = session.state;
  if (reached()) return;
  session.correctiveWalks += 1;
  let guard = 0;
  while (!reached()) {
    guard += 1;
    if (guard > 40_000) throw new Error(`${session.name}: walk never arrived`);
    const target = aim();
    const dx = target.xSub - state.player.xSub;
    const dy = target.ySub - state.player.ySub;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    let desired = horizontal
      ? dx >= 0
        ? Direction.East
        : Direction.West
      : dy >= 0
        ? Direction.South
        : Direction.North;
    const wetAhead = (dir: Direction): boolean => {
      const px =
        dir === Direction.East
          ? state.player.xSub + SUBTILE
          : dir === Direction.West
            ? state.player.xSub - SUBTILE
            : state.player.xSub;
      const py =
        dir === Direction.South
          ? state.player.ySub + SUBTILE
          : dir === Direction.North
            ? state.player.ySub - SUBTILE
            : state.player.ySub;
      return waterAtSubtile(state, px, py);
    };
    if (wetAhead(desired)) {
      const sidestep = horizontal
        ? dy > 0
          ? Direction.South
          : Direction.North
        : dx > 0
          ? Direction.East
          : Direction.West;
      if (!wetAhead(sidestep)) desired = sidestep;
      else if (sidestep === Direction.South) desired = Direction.North;
      else if (sidestep === Direction.North) desired = Direction.South;
      else if (sidestep === Direction.East) desired = Direction.West;
      else desired = Direction.East;
    }
    if (state.player.moveDir !== desired) {
      apply(session, { type: 'SetMoveDirection', dir: desired }, true);
    } else {
      stepEmpty(session);
    }
  }
  if (state.player.moveDir !== Direction.None) {
    apply(session, { type: 'SetMoveDirection', dir: Direction.None }, true);
  }
}

function playerTile(state: WorldState): { x: number; y: number } {
  return { x: subtilesToTile(state.player.xSub), y: subtilesToTile(state.player.ySub) };
}

function atShore(state: WorldState): boolean {
  const tile = playerTile(state);
  return reservoirAdjacentToTile(state, tile.x, tile.y) !== null;
}

/** The nearest bank subtile — where a thirsty walk aims. NOT the pond centre: item 080. */
function shorePoint(state: WorldState): { xSub: number; ySub: number } {
  const tile = playerTile(state);
  const pond = nearestReservoir(state, tile.x, tile.y);
  if (pond === null) return { xSub: state.player.xSub, ySub: state.player.ySub };
  // Aim one tile west of the pond's west edge, clamped to its row span: always dry, always
  // within refill reach of the water, and the same spot every time keeps the walk honest.
  return {
    xSub: tileCentreSubtiles(pond.tileX - 1),
    ySub: tileCentreSubtiles(pond.tileY),
  };
}

/** Walk to the shore and refill. The beat plan §2's Gardener circuit names. */
function refillTrip(session: Session): void {
  finishIntent(session);
  walkUntil(
    session,
    () => atShore(session.state),
    () => shorePoint(session.state),
  );
  apply(session, { type: 'RefillCan' }, true);
  session.refills += 1;
  if (session.state.player.canCharges <= 0) {
    throw new Error(`${session.name}: refill did not fill the can`);
  }
}

function needsCharges(command: Command): boolean {
  if (command.type === 'WaterTile') return true;
  return command.type === 'WalkAndAct' && command.action === IntentAction.Water;
}

/** Where a direct command needs the player standing, or null for positionless verbs. */
function reachPoint(state: WorldState, command: Command): { xSub: number; ySub: number } | null {
  switch (command.type) {
    case 'WaterTile':
    case 'PlantTile':
    case 'HarvestTile':
    case 'SwingScythe':
    case 'ApplyFertilizer':
    case 'UseRepairKit':
      return { xSub: tileCentreSubtiles(command.tileX), ySub: tileCentreSubtiles(command.tileY) };
    case 'LoadMachine':
    case 'UnloadMachine':
    case 'RefillHopper':
    case 'RepairMachine':
    case 'WhackJam':
    case 'UpgradeMachine':
    case 'DeconstructMachine': {
      const machine = machineById(state, command.machineId);
      return machine === null ? null : machineCentreSubtiles(machine);
    }
    case 'HitchCart':
    case 'LoadCart':
    case 'DispatchCart': {
      const cart = machineById(state, command.cartId);
      return cart === null ? null : machineCentreSubtiles(cart);
    }
    case 'SellItem':
    case 'BuyItem': {
      let best: { xSub: number; ySub: number } | null = null;
      let bestD = Infinity;
      for (const machine of state.machines) {
        if (machine.kind !== MachineKind.SellBin) continue;
        const centre = machineCentreSubtiles(machine);
        const d = distSq(state, centre.xSub, centre.ySub);
        if (d < bestD) {
          bestD = d;
          best = centre;
        }
      }
      return best;
    }
    case 'RotateGrabber':
    case 'SetGrabberFilter': {
      const grabber = state.grabbers.find((g) => g.id === command.grabberId);
      return grabber === undefined
        ? null
        : { xSub: tileCentreSubtiles(grabber.tileX), ySub: tileCentreSubtiles(grabber.tileY) };
    }
    default:
      return null;
  }
}

/** Issue one walk-to errand and wait for it to finish. Returns whether it was accepted. */
function errand(
  session: Session,
  action: IntentAction,
  tileX: number,
  tileY: number,
  item = 0,
  count = 0,
): boolean {
  finishIntent(session);
  if (action === IntentAction.Water && session.state.player.canCharges <= 0) {
    refillTrip(session);
  }
  const ok = apply(session, { type: 'WalkAndAct', action, tileX, tileY, item, count }, true);
  if (ok) finishIntent(session);
  return ok;
}

function sellSurplus(session: Session): void {
  const state = session.state;
  const bin = state.machines.find((m) => m.kind === MachineKind.SellBin);
  if (bin === undefined) return;
  for (const slot of [...state.inventory]) {
    const spec = itemSpec(slot.item);
    if (spec === null || !spec.sellable) continue;
    const held = itemCount(state, slot.item);
    if (held > 0) errand(session, IntentAction.Sell, bin.tileX, bin.tileY, slot.item, held);
  }
}

/**
 * Keep playing the gardener loop — plant, water (refilling the can), harvest, sell — over
 * the fixture's own field until the deferred purchases become affordable and applied. The
 * honest version of "the session came up short": the player farms a while longer.
 */
function tailFarm(session: Session): void {
  const state = session.state;
  let stalls = 0;
  let passes = 0;
  // A pass is a STALL only when nothing at all moved: not the queue, not the money, not the
  // sales counter a Charter milestone reads. A session grinding honestly toward "200 items
  // sold" makes progress every pass without landing a deferred beat for a while, and giving
  // up mid-grind is how a fixture ends up carrying a dead tail.
  while (session.deferred.length > 0 && stalls < 4 && passes < 200) {
    passes += 1;
    const owedBefore = session.deferred.length;
    const moneyBefore = state.moneyCents;
    const soldBefore = state.stats.itemsSold;
    finishIntent(session);
    retryDeferredWalking(session);
    if (session.deferred.length < owedBefore) continue;

    sellSurplus(session);
    retryDeferredWalking(session);
    if (session.deferred.length < owedBefore) continue;

    for (const tile of [...state.field]) {
      if (isTileReady(tile) || tile.compost > 0) {
        errand(session, IntentAction.Harvest, tile.tileX, tile.tileY);
      }
    }
    sellSurplus(session);
    // Restock seeds when the bag runs dry — the roadside stand sells them, and an earn loop
    // that stops planting the day the seeds run out is not earning.
    if (itemCount(state, ItemId.PotatoSeed) < 8 && state.moneyCents > 4_000) {
      const bin = state.machines.find((m) => m.kind === MachineKind.SellBin);
      if (bin !== undefined) {
        errand(session, IntentAction.Buy, bin.tileX, bin.tileY, ItemId.PotatoSeed, 16);
      }
    }
    for (const tile of [...state.field]) {
      if (tile.crop === CropId.None && itemCount(state, ItemId.PotatoSeed) > 0) {
        errand(session, IntentAction.Plant, tile.tileX, tile.tileY, CropId.RussetPotato);
      }
    }
    for (const tile of [...state.field]) {
      const live = tileAt(state, tile.tileX, tile.tileY);
      if (live === null || live.crop === CropId.None || isTileReady(live)) continue;
      errand(session, IntentAction.Water, tile.tileX, tile.tileY);
    }
    let waited = 0;
    while (waited < 6_000 && !state.field.some((tile) => isTileReady(tile))) {
      stepEmpty(session);
      waited += 1;
    }
    for (const tile of [...state.field]) {
      if (isTileReady(tile)) errand(session, IntentAction.Harvest, tile.tileX, tile.tileY);
    }
    sellSurplus(session);
    finishIntent(session);
    retryDeferredWalking(session);
    if (
      session.deferred.length === owedBefore &&
      state.moneyCents === moneyBefore &&
      state.stats.itemsSold === soldBefore
    ) {
      stalls += 1;
    }
  }
}

function amend(name: string): void {
  const fixture = loadFixture(name);
  const session: Session = {
    name,
    state: createWorld(fixture.seed),
    out: [],
    refills: 0,
    correctiveWalks: 0,
    refused: [],
    deferred: [],
  };
  let shift = 0;
  let heldDir: Direction = Direction.None;

  for (const entry of fixture.commands) {
    const command = entry.command;
    stepTo(session, entry.tick + shift);

    let injectedHere = false;

    // A recorded errand waits its turn: amendment skews walk lengths, and without this a
    // delayed errand would be REPLACED by the next click mid-walk, silently dropping its
    // verb. (The can amender exempted `walk-errands`, which is not in this pass.)
    if (command.type === 'WalkAndAct') {
      finishIntent(session);
    }

    if (needsCharges(command) && session.state.player.canCharges <= 0) {
      refillTrip(session);
      injectedHere = true;
    }

    const point = reachPoint(session.state, command);
    if (
      point !== null &&
      distSq(session.state, point.xSub, point.ySub) > HAND_REACH_SUBTILES_SQUARED
    ) {
      finishIntent(session);
      // Stop just inside reach rather than at the target: 300 of 384 subtiles leaves margin
      // for the ~52-subtile granularity of a held-direction step.
      walkUntil(
        session,
        () => distSq(session.state, point.xSub, point.ySub) <= 300 * 300,
        () => point,
      );
      injectedHere = true;
    }

    // An injected trip cancelled whatever direction the recording had in flight; put it
    // back so the recorded segment keeps its shape until its own recorded stop.
    if (injectedHere && heldDir !== Direction.None && command.type !== 'SetMoveDirection') {
      apply(session, { type: 'SetMoveDirection', dir: heldDir }, true);
    }

    if (DEFERRABLE.has(command.type)) {
      if (!apply(session, command, true)) {
        session.deferred.push(command);
        session.refused.push(`t${String(session.state.tick)} ${command.type} (deferred)`);
      }
    } else {
      apply(session, command, false);
    }
    if (command.type === 'SetMoveDirection') heldDir = command.dir;
    shift = session.state.tick - entry.tick - 1;
    if (shift < 0) shift = 0;

    if (session.deferred.length > 0) retryDeferred(session);
  }

  // Whatever is still owed at the end of the recording gets earned honestly.
  if (session.deferred.length > 0) tailFarm(session);

  if (session.deferred.length > 0) {
    console.log(
      `  ${name} STUCK: money=${String(session.state.moneyCents)} ` +
        `sold=${String(session.state.stats.itemsSold)} ` +
        `produced=${String(session.state.stats.itemsProducedByMachine)} ` +
        `unlocked=${JSON.stringify(session.state.unlocked)} ` +
        `tail=${JSON.stringify(session.deferred)}`,
    );
    session.refused.push(`UNRESOLVED deferred: ${session.deferred.map((c) => c.type).join(',')}`);
    // Put the unresolved commands back into the record as the refusals they are: attempted
    // once more, refused, and kept in the list so the session still says what was asked —
    // and the coverage gate still sees the verb.
    for (const command of session.deferred) {
      const attemptTick = session.state.tick;
      if (!apply(session, command, true)) {
        session.out.push({ tick: attemptTick, command });
        stepTo(session, attemptTick + 1);
      }
    }
    session.deferred.length = 0;
  }

  const ticks = Math.max(fixture.ticks + shift, session.state.tick);
  stepTo(session, ticks);

  if (waterAtSubtile(session.state, session.state.player.xSub, session.state.player.ySub)) {
    throw new Error(`${name}: the farmer ended the session standing on water`);
  }

  const amended: GoldenFixture = {
    ...fixture,
    ticks,
    expectedHash: hashState(session.state),
    commands: session.out,
  };

  writeFileSync(fixturePath(name), `${JSON.stringify(amended, null, 2)}\n`);
  console.log(
    `  ${name}: +${String(session.refills)} refills, ${String(session.correctiveWalks)} walks, ` +
      `ticks ${String(fixture.ticks)} -> ${String(ticks)}, ` +
      `hash ${fixture.expectedHash} -> ${amended.expectedHash}` +
      (session.refused.length > 0 ? `, refused: ${session.refused.join(' | ')}` : ''),
  );
}

for (const name of AMEND) amend(name);
console.log('\nDone. Run `yarn goldens:regen` to confirm the written hashes replay.');
