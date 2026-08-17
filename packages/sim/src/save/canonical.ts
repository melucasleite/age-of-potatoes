// The canonical save payload: `WorldState` as plain, ordered, self-describing JSON.
//
// PLAIN JSON, AND EXPLICITLY NOT MORE (plan §12). No typed arrays, no binary packing, no
// compression, no schema compiler — none of it until saves genuinely exceed ~5 MB, which a
// v0.1 world (one 8×8 field) does not come close to. Being able to open a corrupt save in a
// text editor and *see* what went wrong is worth more, for years, than the bytes are.
//
// Two properties this file exists to guarantee:
//
//   1. CANONICAL. The same world always produces byte-identical JSON. Fields are written in
//      the fixed order below rather than by key enumeration, and the stream map — the one
//      collection in `WorldState` with unordered keys — is emitted as an array sorted by id.
//      (Object literal order survives `JSON.stringify` for string keys; every key here is
//      alphabetic, so none of them get the integer-key reordering rule applied to them.)
//
//   2. EXACTLY THE HASHED FIELDS, AND NOTHING ELSE. Everything `hashState()` digests is in
//      the payload, so `hashState(deserialize(serialize(state))) === hashState(state)`. That
//      round-trip is asserted in the tests and it is what makes the save meaningful: the
//      digest and the file can never disagree about what the world *is*.
//
// THE TRACE IS NOT IN THE PAYLOAD. It grows without bound over a persistent world, it is not
// save-compatibility surface, and rewriting the whole log on every autosave would make each
// save progressively more expensive for no benefit. It lives in its own IndexedDB object
// store in `apps/web`. It is also not hashed, so leaving it out costs the round-trip nothing.
//
// LEADERBOARD ACCUMULATORS ARE PERSISTED, NEVER RECOMPUTED (plan §12). They live inside
// `WorldState` and inside the hash; recomputing them on load would produce a world that
// hashes differently from the one that was saved, which is the definition of a broken save.

import {
  BeltTier,
  CropId,
  GrabberTier,
  ITEM_SPECS,
  ItemId,
  LiquidId,
  MachineKind,
  PARCELS_HIGH,
  PARCELS_WIDE,
  SoilType,
  isParcelIndex,
  machineHoppers,
  machineSpec,
} from '../data';
import type { RngState } from '../rng';
import {
  type Belt,
  type Bot,
  type BoxedMachine,
  type Contract,
  type FreshStack,
  type CropTile,
  type Grabber,
  type Machine,
  type MachinePort,
  type Pipe,
  type PipeNetwork,
  type PlayerIntent,
  type PlayerState,
  type Reservoir,
  type SoilMemory,
  type TraceEntry,
  type WorldState,
  type Zone,
  BotKind,
  BotPhase,
  ContractPhase,
  Direction,
  IntentAction,
  clipDestination,
} from '../state';
import type { ManualTouchCounts, WorldStats } from '../stats';
import { SaveCorruptError } from './errors';

// --- the payload shape ------------------------------------------------------------

/**
 * A pending errand, flattened to six integers.
 *
 * THE FIRST NULLABLE FIELD IN THE ENTIRE PAYLOAD, and it is nullable rather than
 * sentinel-encoded because `PlayerIntent` is nullable in `WorldState` and the payload's job
 * is to mirror the world, not to invent a second encoding of it. A `{action: 0}` row meaning
 * "no errand" would be a second way to say `null` — and two encodings of the same fact is
 * how a canonical form stops being canonical.
 */
export interface SavePlayerIntent {
  action: number;
  count: number;
  issuedTick: number;
  item: number;
  tileX: number;
  tileY: number;
}

export interface SavePlayer {
  /** Pours left in the can, 0..8. A half-empty can survives a reload half-empty. */
  canCharges: number;
  facing: number;
  intent: SavePlayerIntent | null;
  moveAccum: number;
  moveDir: number;
  /** The `Machine.id` of the hand cart in tow, or 0. A haul survives a reload. */
  towedCartId: number;
  xSub: number;
  ySub: number;
}

/** One boxed machine in a slot. Keys alphabetical, like every other row in this file. */
export interface SaveBoxedMachine {
  capacityLevel: number;
  condition: number;
  efficiencyLevel: number;
  investedCents: number;
  speedLevel: number;
}

/** One heap of a perishable good and the tick it turns on. */
export interface SaveFreshStack {
  count: number;
  spoilAtTick: number;
}

export interface SaveInventorySlot {
  /** Sorted least-invested-first, and always either empty or `count` long. */
  boxes: SaveBoxedMachine[];
  count: number;
  item: number;
  /**
   * Freshness, soonest-expiring first. Empty for every shelf-stable good, and summing to `count`
   * for a perishable one — the same "either empty or exactly `count`" invariant `boxes` holds.
   */
  stacks: SaveFreshStack[];
}

export interface SaveCropTile {
  compost: number;
  crop: number;
  fertility: number;
  /** Harvests since this tile last lost a star. Decay is a counter, never a roll. */
  fertilityWear: number;
  growth: number;
  growthTarget: number;
  moisture: number;
  /** Moisture-drain remainder in thousandths, so clay and sand stay exact. */
  moistureAccum: number;
  readyAge: number;
  /** `SoilType`. Rolled once per position, ever — see `SoilMemory` in state.ts. */
  soil: number;
  /** World tile coordinate — the collection key since format 13 (the till tool). */
  tileX: number;
  tileY: number;
  zone: number;
}

/**
 * One entry of the roll-once soil ledger (format 13): what ground a position rolled, kept
 * after the tile is un-tilled so re-tilling can never re-roll it.
 */
export interface SaveSoilMemory {
  fertility: number;
  fertilityWear: number;
  soil: number;
  /** Row-major world tile key. Sorted ascending. */
  tile: number;
}

/** One typed liquid port's stored state. The liquid itself is balance data, never saved. */
export interface SaveMachinePort {
  flowMlPerMinute: number;
  ml: number;
  network: number;
  throttled: boolean;
}

export interface SaveMachine {
  blockedTicks: number;
  /** The `Zone.id` an Agri-Bot dock takes its orders from. 0 on every other machine. */
  boundZone: number;
  capacityLevel: number;
  /** Goods on a delivery cart. 0 on every machine that is not one. */
  cargoCount: number;
  /** The `ItemId` on a delivery cart, or 0. One product per run. */
  cargoItem: number;
  /**
   * Freshness the cargo has left, in loose-equivalent ticks; 0 when it has none to lose (item
   * 110). Format 18 gave every machine a 0 here, which reads as "no clock" and is deliberately
   * the generous direction — an existing cellar's contents are not aged retroactively.
   */
  cargoFreshTicks: number;
  condition: number;
  cooldown: number;
  efficiencyLevel: number;
  flowMlPerMinute: number;
  id: number;
  /** One count per line of the machine's recipe, in recipe order. */
  inputCounts: number[];
  /**
   * Freshness each hopper line has left, in ticks, parallel to `inputCounts`; 0 on a line with
   * nothing to lose (item 112). Format 20 gave every line a 0, which reads as "no clock" and
   * heals on the next armful — the same generous direction format 18 took for cargo.
   */
  inputFreshTicks: number[];
  investedCents: number;
  jammed: boolean;
  /** A junction's round-robin cursors, 0..3. Zero on every machine that is not one. */
  junctionInCursor: number;
  junctionOutCursor: number;
  kind: number;
  network: number;
  opCount: number;
  outputCount: number;
  /**
   * Freshness the output basket has left, in ticks; 0 for a basket holding something
   * shelf-stable, which after the Fryer is all of them (item 112).
   */
  outputFreshTicks: number;
  /**
   * What the output buffer is holding, or 0 when it is empty (item 111). Format 19 wrote it for
   * the first time; the 18 → 19 migration reads a non-empty buffer's identity back off the
   * machine's spec, which is exactly where it lived before this field existed.
   */
  outputItem: number;
  overcookedCount: number;
  ports: SaveMachinePort[];
  progress: number;
  /** Ticks until a dispatched cart is back. A COUNTDOWN, never a return tick — see below. */
  runTicksRemaining: number;
  scanCursor: number;
  /** The harvester dock's seed shelf (item 088). 0/0 on every machine that is not one. */
  seedShelfCount: number;
  seedShelfItem: number;
  skippedCount: number;
  speedLevel: number;
  tankMl: number;
  throttled: boolean;
  tileX: number;
  tileY: number;
  /** Consecutive ticks of work with no hand on this machine. The Corporate Charter's counter. */
  untouchedTicks: number;
  wateredCount: number;
}

/** A body of water, and how much is actually left in it. */
export interface SaveReservoir {
  capacityMl: number;
  id: number;
  levelMl: number;
  rechargeAccum: number;
  tileX: number;
  tileY: number;
  tilesHigh: number;
  tilesWide: number;
}

/** One tile of pipe. It has no contents — see `Pipe` in state.ts. */
export interface SavePipe {
  id: number;
  liquid: number;
  network: number;
  tileX: number;
  tileY: number;
}

/**
 * One network's ledger bookkeeping.
 *
 * Membership is NOT stored: it is recomputed from the pipe list on load exactly as it is on
 * every edit, so a save cannot contain a network whose shape disagrees with its pipes. What
 * is stored is the part that cannot be recomputed — the supply accumulator and the round-robin
 * rotation, which are history rather than geometry.
 */
export interface SavePipeNetwork {
  deliveredMl: number;
  demandMl: number;
  id: number;
  liquid: number;
  rrOffset: number;
  supplyAccum: number;
  supplyMl: number;
}

/** One item on a belt: how far along it is, what it is, and how long it has left. */
export interface SaveBeltItem {
  dist: number;
  /** Ticks of freshness remaining; 0 for a shelf-stable good and for anything grandfathered. */
  freshTicks: number;
  item: number;
}

export interface SaveBelt {
  dir: number;
  id: number;
  /** Ascending by `dist`, exactly as the belt holds them. */
  items: SaveBeltItem[];
  lengthTiles: number;
  moveAccum: number;
  tier: number;
  tileX: number;
  tileY: number;
}

export interface SaveGrabber {
  cooldown: number;
  dir: number;
  filter: number;
  held: number;
  /** Ticks of freshness the held unit has left; 0 for an empty claw or a shelf-stable good. */
  heldFreshTicks: number;
  id: number;
  opCount: number;
  tier: number;
  tileX: number;
  tileY: number;
}

export interface SaveZone {
  autoReplant: boolean;
  crop: number;
  id: number;
  name: string;
  priority: number;
  replantCooldown: number;
}

/**
 * One standing contract.
 *
 * `ticksRemaining` is a COUNTDOWN rather than the tick the truck is due back, and that is what
 * makes closing the tab mid-run safe (plan §6: no offline progress, ever). A stored deadline
 * would be a number measured against a clock that only advances while the world is being
 * stepped — correct on reload by accident, and wrong the moment anything else touched `tick`.
 */
export interface SaveContract {
  depotId: number;
  destination: string;
  grossCents: number;
  id: number;
  inTransit: number;
  item: number;
  phase: number;
  quantityPerRun: number;
  runsCompleted: number;
  stocked: number;
  ticksRemaining: number;
}

/**
 * One Agri-Bot.
 *
 * Its POSITION is stored, in subtiles, because a bot halfway across a field is a fact about the
 * world rather than a thing that can be recomputed — and because item 038's criterion is that bot
 * movement is identical across runs, which is a claim about a saved world as much as a fresh one.
 * The route cursor rides along for the reason a junction's round-robin cursors do: it is history,
 * not geometry, so nothing can derive it back.
 */
export interface SaveBot {
  carryCount: number;
  carryItem: number;
  condition: number;
  dockId: number;
  facing: number;
  id: number;
  kind: number;
  moveAccum: number;
  opCount: number;
  phase: number;
  routeCursor: number;
  /** The harvester's seed pocket (item 088). 0/0 on a bot that has pocketed nothing. */
  seedCount: number;
  seedItem: number;
  targetTile: number;
  workTicks: number;
  xSub: number;
  ySub: number;
}

/** One RNG stream, with its system id folded in — an array entry, not a map key. */
export interface SaveStream {
  id: string;
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

export interface SaveTouchCounts {
  handCarry: number;
  handHarvest: number;
  handPlant: number;
  handRepair: number;
  handWater: number;
  hopperRefill: number;
  jamWhack: number;
}

/** One row of the per-item sales ledger. Sorted ascending by `item`, like the live list. */
export interface SaveItemSales {
  cents: number;
  centsAtDawn: number;
  item: number;
  units: number;
  unitsAtDawn: number;
}

/** One closed dawn-aligned hour, as the telescoped differences the live list stores. */
export interface SaveClosedHour {
  grossCents: number;
  hour: number;
  inputsWasted: number;
  itemsProduced: number;
  itemsSold: number;
  spendCents: number;
  ticks: number;
  waterMl: number;
}

/** The open hour's starting line. */
export interface SaveHourMark {
  earnedCents: number;
  hour: number;
  inputsWasted: number;
  itemsProduced: number;
  itemsSold: number;
  spentCents: number;
  tick: number;
  waterMl: number;
}

export interface SaveStats {
  automatedGrossCents: number;
  /** Lifetime cheat commands that took effect (item 075, format 14). Hashed, like the rest. */
  cheatsUsed: number;
  dawnsSeen: number;
  hourMark: SaveHourMark;
  hours: SaveClosedHour[];
  inputsWastedByMachine: number;
  itemsHarvestedByHand: number;
  itemsProducedByMachine: number;
  itemsSold: number;
  lifetimeEarnedCents: number;
  lifetimeSpentCents: number;
  longestHandsFreeTicks: number;
  /** The best run of untouched work any one machine has managed, in ticks. */
  longestUntouchedMachineTicks: number;
  netWorthCents: number;
  netWorthSamples: number[];
  nextNetWorthSampleTick: number;
  peakNetWorthCents: number;
  repairKitSpendCents: number;
  repairKitsUsed: number;
  salesByItem: SaveItemSales[];
  ticksElapsed: number;
  ticksSinceManualTouch: number;
  touches: SaveTouchCounts;
  waterDrawnMl: number;
}

/** `WorldState` minus the trace, in canonical form. Keys are alphabetical, always. */
export interface SavePayload {
  belts: SaveBelt[];
  /** Agri-Bots, sorted ascending by id. */
  bots: SaveBot[];
  /** One-shot celebrations already played, sorted. A first time must not happen twice. */
  ceremonies: string[];
  /** Standing contracts, sorted ascending by id. */
  contracts: SaveContract[];
  field: SaveCropTile[];
  grabbers: SaveGrabber[];
  inventory: SaveInventorySlot[];
  machines: SaveMachine[];
  moneyCents: number;
  networks: SavePipeNetwork[];
  nextBeltId: number;
  nextBotId: number;
  nextContractId: number;
  nextGrabberId: number;
  nextMachineId: number;
  nextPipeId: number;
  nextReservoirId: number;
  nextZoneId: number;
  /**
   * Row-major indices of the parcels this world holds the deed to, sorted ascending.
   *
   * Indices rather than coordinates, and never a per-tile flag: the grid's shape is folded
   * into `BALANCE_HASH`, so a save that recorded parcel 5 can only be read by a build that
   * agrees where parcel 5 is — which is the same guarantee every other id in this file has.
   */
  ownedParcels: number[];
  pipes: SavePipe[];
  reservoirs: SaveReservoir[];
  player: SavePlayer;
  /** The roll-once soil ledger, sorted ascending by `tile`. Format 13. */
  soilMemory: SaveSoilMemory[];
  stats: SaveStats;
  streams: SaveStream[];
  tick: number;
  /** Researched node ids, sorted. Strings on purpose — they outlive any index. */
  unlocked: string[];
  version: number;
  worldSeed: number;
  zones: SaveZone[];
}

// --- writing ----------------------------------------------------------------------

/**
 * Project a world into its canonical payload. Pure, and it copies — the result shares no
 * object with `state`, so a payload handed to `JSON.stringify` cannot be perturbed by a tick
 * that lands while the write is in flight.
 */
export function toPayload(state: WorldState): SavePayload {
  const field: SaveCropTile[] = [];
  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    field.push({
      compost: tile.compost,
      crop: tile.crop,
      fertility: tile.fertility,
      fertilityWear: tile.fertilityWear,
      growth: tile.growth,
      growthTarget: tile.growthTarget,
      moisture: tile.moisture,
      moistureAccum: tile.moistureAccum,
      readyAge: tile.readyAge,
      soil: tile.soil,
      tileX: tile.tileX,
      tileY: tile.tileY,
      zone: tile.zone,
    });
  }

  const soilMemory: SaveSoilMemory[] = [];
  for (let i = 0; i < state.soilMemory.length; i++) {
    const entry = state.soilMemory[i]!;
    soilMemory.push({
      fertility: entry.fertility,
      fertilityWear: entry.fertilityWear,
      soil: entry.soil,
      tile: entry.tile,
    });
  }

  const inventory: SaveInventorySlot[] = [];
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    const boxes: SaveBoxedMachine[] = [];
    for (let j = 0; j < slot.boxes.length; j++) {
      const box = slot.boxes[j]!;
      boxes.push({
        capacityLevel: box.capacityLevel,
        condition: box.condition,
        efficiencyLevel: box.efficiencyLevel,
        investedCents: box.investedCents,
        speedLevel: box.speedLevel,
      });
    }
    const stacks: SaveFreshStack[] = [];
    for (let j = 0; j < slot.stacks.length; j++) {
      const stack = slot.stacks[j]!;
      stacks.push({ count: stack.count, spoilAtTick: stack.spoilAtTick });
    }
    inventory.push({ boxes, count: slot.count, item: slot.item, stacks });
  }

  const machines: SaveMachine[] = [];
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    machines.push({
      blockedTicks: machine.blockedTicks,
      boundZone: machine.boundZone,
      capacityLevel: machine.capacityLevel,
      cargoCount: machine.cargoCount,
      cargoFreshTicks: machine.cargoFreshTicks,
      cargoItem: machine.cargoItem,
      condition: machine.condition,
      cooldown: machine.cooldown,
      efficiencyLevel: machine.efficiencyLevel,
      flowMlPerMinute: machine.flowMlPerMinute,
      id: machine.id,
      inputCounts: machine.inputCounts.slice(),
      inputFreshTicks: machine.inputFreshTicks.slice(),
      investedCents: machine.investedCents,
      jammed: machine.jammed,
      junctionInCursor: machine.junctionInCursor,
      junctionOutCursor: machine.junctionOutCursor,
      kind: machine.kind,
      network: machine.network,
      opCount: machine.opCount,
      outputCount: machine.outputCount,
      outputFreshTicks: machine.outputFreshTicks,
      outputItem: machine.outputItem,
      overcookedCount: machine.overcookedCount,
      ports: machine.ports.map((port) => ({
        flowMlPerMinute: port.flowMlPerMinute,
        ml: port.ml,
        network: port.network,
        throttled: port.throttled,
      })),
      progress: machine.progress,
      runTicksRemaining: machine.runTicksRemaining,
      scanCursor: machine.scanCursor,
      seedShelfCount: machine.seedShelfCount,
      seedShelfItem: machine.seedShelfItem,
      skippedCount: machine.skippedCount,
      speedLevel: machine.speedLevel,
      tankMl: machine.tankMl,
      throttled: machine.throttled,
      tileX: machine.tileX,
      tileY: machine.tileY,
      untouchedTicks: machine.untouchedTicks,
      wateredCount: machine.wateredCount,
    });
  }

  const belts: SaveBelt[] = [];
  for (let i = 0; i < state.belts.length; i++) {
    const belt = state.belts[i]!;
    const items: SaveBeltItem[] = [];
    for (let j = 0; j < belt.items.length; j++) {
      const entry = belt.items[j]!;
      items.push({ dist: entry.dist, freshTicks: entry.freshTicks, item: entry.item });
    }
    belts.push({
      dir: belt.dir,
      id: belt.id,
      items,
      lengthTiles: belt.lengthTiles,
      moveAccum: belt.moveAccum,
      tier: belt.tier,
      tileX: belt.tileX,
      tileY: belt.tileY,
    });
  }

  const grabbers: SaveGrabber[] = [];
  for (let i = 0; i < state.grabbers.length; i++) {
    const grabber = state.grabbers[i]!;
    grabbers.push({
      cooldown: grabber.cooldown,
      dir: grabber.dir,
      filter: grabber.filter,
      held: grabber.held,
      heldFreshTicks: grabber.heldFreshTicks,
      id: grabber.id,
      opCount: grabber.opCount,
      tier: grabber.tier,
      tileX: grabber.tileX,
      tileY: grabber.tileY,
    });
  }

  const zones: SaveZone[] = [];
  for (let i = 0; i < state.zones.length; i++) {
    const zone = state.zones[i]!;
    zones.push({
      autoReplant: zone.autoReplant,
      crop: zone.crop,
      id: zone.id,
      name: zone.name,
      priority: zone.priority,
      replantCooldown: zone.replantCooldown,
    });
  }

  const reservoirs: SaveReservoir[] = [];
  for (let i = 0; i < state.reservoirs.length; i++) {
    const reservoir = state.reservoirs[i]!;
    reservoirs.push({
      capacityMl: reservoir.capacityMl,
      id: reservoir.id,
      levelMl: reservoir.levelMl,
      rechargeAccum: reservoir.rechargeAccum,
      tileX: reservoir.tileX,
      tileY: reservoir.tileY,
      tilesHigh: reservoir.tilesHigh,
      tilesWide: reservoir.tilesWide,
    });
  }

  const pipes: SavePipe[] = [];
  for (let i = 0; i < state.pipes.length; i++) {
    const pipe = state.pipes[i]!;
    pipes.push({
      id: pipe.id,
      liquid: pipe.liquid,
      network: pipe.network,
      tileX: pipe.tileX,
      tileY: pipe.tileY,
    });
  }

  const networks: SavePipeNetwork[] = [];
  for (let i = 0; i < state.networks.length; i++) {
    const network = state.networks[i]!;
    networks.push({
      deliveredMl: network.deliveredMl,
      demandMl: network.demandMl,
      id: network.id,
      liquid: network.liquid,
      rrOffset: network.rrOffset,
      supplyAccum: network.supplyAccum,
      supplyMl: network.supplyMl,
    });
  }

  const contracts: SaveContract[] = [];
  for (let i = 0; i < state.contracts.length; i++) {
    const contract = state.contracts[i]!;
    contracts.push({
      depotId: contract.depotId,
      destination: contract.destination,
      grossCents: contract.grossCents,
      id: contract.id,
      inTransit: contract.inTransit,
      item: contract.item,
      phase: contract.phase,
      quantityPerRun: contract.quantityPerRun,
      runsCompleted: contract.runsCompleted,
      stocked: contract.stocked,
      ticksRemaining: contract.ticksRemaining,
    });
  }

  const bots: SaveBot[] = [];
  for (let i = 0; i < state.bots.length; i++) {
    const bot = state.bots[i]!;
    bots.push({
      carryCount: bot.carryCount,
      carryItem: bot.carryItem,
      condition: bot.condition,
      dockId: bot.dockId,
      facing: bot.facing,
      id: bot.id,
      kind: bot.kind,
      moveAccum: bot.moveAccum,
      opCount: bot.opCount,
      phase: bot.phase,
      routeCursor: bot.routeCursor,
      seedCount: bot.seedCount,
      seedItem: bot.seedItem,
      targetTile: bot.targetTile,
      workTicks: bot.workTicks,
      xSub: bot.xSub,
      ySub: bot.ySub,
    });
  }

  const ceremonies: string[] = [];
  for (let i = 0; i < state.ceremonies.length; i++) ceremonies.push(state.ceremonies[i]!);

  const ownedParcels: number[] = [];
  for (let i = 0; i < state.ownedParcels.length; i++) ownedParcels.push(state.ownedParcels[i]!);

  const unlocked: string[] = [];
  for (let i = 0; i < state.unlocked.length; i++) unlocked.push(state.unlocked[i]!);

  // Sorted keys, never enumeration order. Two worlds that acquired the same streams in a
  // different order must serialize identically, exactly as they already hash identically.
  const streamKeys = Object.keys(state.streams).sort();
  const streams: SaveStream[] = [];
  for (let i = 0; i < streamKeys.length; i++) {
    const key = streamKeys[i]!;
    const rng = state.streams[key]!;
    streams.push({ id: key, s0: rng.s0, s1: rng.s1, s2: rng.s2, s3: rng.s3 });
  }

  const stats = state.stats;
  const samples: number[] = [];
  for (let i = 0; i < stats.netWorthSamples.length; i++) samples.push(stats.netWorthSamples[i]!);

  return {
    belts,
    bots,
    ceremonies,
    contracts,
    field,
    grabbers,
    inventory,
    machines,
    moneyCents: state.moneyCents,
    networks,
    nextBeltId: state.nextBeltId,
    nextBotId: state.nextBotId,
    nextContractId: state.nextContractId,
    nextGrabberId: state.nextGrabberId,
    nextMachineId: state.nextMachineId,
    nextPipeId: state.nextPipeId,
    nextReservoirId: state.nextReservoirId,
    nextZoneId: state.nextZoneId,
    ownedParcels,
    pipes,
    reservoirs,
    player: {
      canCharges: state.player.canCharges,
      facing: state.player.facing,
      // An explicit copy, never an alias. This file's stated guarantee is that the payload
      // shares no object with `state` and is therefore safe to build mid-tick — and the
      // errand is the one field on the player that is an object rather than a number.
      intent:
        state.player.intent === null
          ? null
          : {
              action: state.player.intent.action,
              count: state.player.intent.count,
              issuedTick: state.player.intent.issuedTick,
              item: state.player.intent.item,
              tileX: state.player.intent.tileX,
              tileY: state.player.intent.tileY,
            },
      moveAccum: state.player.moveAccum,
      moveDir: state.player.moveDir,
      towedCartId: state.player.towedCartId,
      xSub: state.player.xSub,
      ySub: state.player.ySub,
    },
    soilMemory,
    stats: {
      automatedGrossCents: stats.automatedGrossCents,
      cheatsUsed: stats.cheatsUsed,
      dawnsSeen: stats.dawnsSeen,
      hourMark: {
        earnedCents: stats.hourMark.earnedCents,
        hour: stats.hourMark.hour,
        inputsWasted: stats.hourMark.inputsWasted,
        itemsProduced: stats.hourMark.itemsProduced,
        itemsSold: stats.hourMark.itemsSold,
        spentCents: stats.hourMark.spentCents,
        tick: stats.hourMark.tick,
        waterMl: stats.hourMark.waterMl,
      },
      hours: stats.hours.map((bucket) => ({
        grossCents: bucket.grossCents,
        hour: bucket.hour,
        inputsWasted: bucket.inputsWasted,
        itemsProduced: bucket.itemsProduced,
        itemsSold: bucket.itemsSold,
        spendCents: bucket.spendCents,
        ticks: bucket.ticks,
        waterMl: bucket.waterMl,
      })),
      inputsWastedByMachine: stats.inputsWastedByMachine,
      itemsHarvestedByHand: stats.itemsHarvestedByHand,
      itemsProducedByMachine: stats.itemsProducedByMachine,
      itemsSold: stats.itemsSold,
      lifetimeEarnedCents: stats.lifetimeEarnedCents,
      lifetimeSpentCents: stats.lifetimeSpentCents,
      longestHandsFreeTicks: stats.longestHandsFreeTicks,
      longestUntouchedMachineTicks: stats.longestUntouchedMachineTicks,
      netWorthCents: stats.netWorthCents,
      netWorthSamples: samples,
      nextNetWorthSampleTick: stats.nextNetWorthSampleTick,
      peakNetWorthCents: stats.peakNetWorthCents,
      repairKitSpendCents: stats.repairKitSpendCents,
      repairKitsUsed: stats.repairKitsUsed,
      salesByItem: stats.salesByItem.map((row) => ({
        cents: row.cents,
        centsAtDawn: row.centsAtDawn,
        item: row.item,
        units: row.units,
        unitsAtDawn: row.unitsAtDawn,
      })),
      ticksElapsed: stats.ticksElapsed,
      ticksSinceManualTouch: stats.ticksSinceManualTouch,
      touches: {
        handCarry: stats.touches.handCarry,
        handHarvest: stats.touches.handHarvest,
        handPlant: stats.touches.handPlant,
        handRepair: stats.touches.handRepair,
        handWater: stats.touches.handWater,
        hopperRefill: stats.touches.hopperRefill,
        jamWhack: stats.touches.jamWhack,
      },
      waterDrawnMl: stats.waterDrawnMl,
    },
    streams,
    tick: state.tick,
    unlocked,
    version: state.version,
    worldSeed: state.worldSeed,
    zones,
  };
}

// --- reading ----------------------------------------------------------------------
//
// Everything below treats the stored bytes as hostile. They came off a disk that a browser
// may have half-written, a text editor may have been pointed at, or a sync layer may have
// truncated. A validating reader that names the bad field beats a world full of `NaN` that
// only reveals itself twenty minutes later as a machine that never finishes an operation.

function fail(path: string, reason: string): never {
  throw new SaveCorruptError(`Save payload is not readable at \`${path}\`: ${reason}.`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, `expected an object, found ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

/**
 * An object, or an explicit `null`. `undefined` is NOT accepted.
 *
 * A missing key falls through to `record()` and fails loudly as `undefined`, which is what
 * we want: a format-4 payload always writes `intent`, so an absent one means the file is
 * damaged or the migration did not run. Quietly reading a missing key as "no errand" would
 * turn both of those into a world that looks fine.
 */
function recordOrNull(value: unknown, path: string): Record<string, unknown> | null {
  if (value === null) return null;
  return record(value, path);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/** An integer, and nothing else — no floats, no NaN, no numeric strings, no `BigInt`. */
function int(source: Record<string, unknown>, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(`${path}.${key}`, `expected an integer, found ${JSON.stringify(value) ?? 'undefined'}`);
  }
  return value;
}

/** An integer restricted to a known set, so an unrecognised id fails here and not later. */
function idInt(
  source: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly number[],
): number {
  const value = int(source, key, path);
  for (let i = 0; i < allowed.length; i++) {
    if (allowed[i] === value) return value;
  }
  fail(`${path}.${key}`, `${String(value)} is not an id this build knows about`);
}

function bool(source: Record<string, unknown>, key: string, path: string): boolean {
  const value = source[key];
  if (typeof value !== 'boolean') {
    fail(`${path}.${key}`, `expected a boolean, found ${describe(value)}`);
  }
  return value;
}

function str(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== 'string') {
    fail(`${path}.${key}`, `expected a string, found ${describe(value)}`);
  }
  return value;
}

function list(source: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    fail(`${path}.${key}`, `expected an array, found ${describe(value)}`);
  }
  return value;
}

/**
 * A machine's recipe buffers, SIZED FROM TODAY'S SPEC rather than from the file.
 *
 * THIS IS NOT A MIGRATION AND IT MUST NOT BECOME ONE. A migration turns yesterday's shape into
 * today's and is frozen forever once released; this is the loader refusing to build a machine
 * whose buffers do not match its own recipe, which is a thing that can happen for reasons a
 * migration cannot see — a spec that gained a line, a save hand-edited at 2 a.m. Extra counts
 * are dropped and missing ones read zero, so a rebalance costs a player the contents of a
 * hopper rather than the world.
 */
function readInputCounts(
  source: Record<string, unknown>,
  path: string,
  kind: MachineKind,
): number[] {
  return readHopperArray(source, 'inputCounts', path, kind);
}

/**
 * The clocks those buffers are running (item 112), sized from today's spec by the same rule and
 * for the same reason — a line that appears out of a rebalance starts at 0, which reads as "no
 * clock" and heals the next time anything is put in it.
 */
function readInputFreshTicks(
  source: Record<string, unknown>,
  path: string,
  kind: MachineKind,
): number[] {
  return readHopperArray(source, 'inputFreshTicks', path, kind);
}

/** One array of per-hopper integers, resized to today's spec. Both readers above are this. */
function readHopperArray(
  source: Record<string, unknown>,
  key: string,
  path: string,
  kind: MachineKind,
): number[] {
  const spec = machineSpec(kind);
  const slots = spec === null ? 0 : machineHoppers(spec).length;
  const raw = list(source, key, path);
  const counts: number[] = [];
  for (let i = 0; i < slots; i++) {
    const value = raw[i];
    counts.push(typeof value === 'number' && Number.isInteger(value) ? value : 0);
  }
  return counts;
}

/** The same, for typed ports. The liquid comes from the spec; only the contents are saved. */
function readPorts(
  source: Record<string, unknown>,
  path: string,
  kind: MachineKind,
): MachinePort[] {
  const spec = machineSpec(kind);
  const slots = spec === null ? 0 : spec.ports.length;
  const raw = list(source, 'ports', path);
  const ports: MachinePort[] = [];
  for (let i = 0; i < slots; i++) {
    const entry = raw[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      ports.push({ network: 0, ml: 0, flowMlPerMinute: 0, throttled: false });
      continue;
    }
    const portPath = `${path}.ports[${String(i)}]`;
    const port = entry as Record<string, unknown>;
    ports.push({
      network: int(port, 'network', portPath),
      ml: int(port, 'ml', portPath),
      flowMlPerMinute: int(port, 'flowMlPerMinute', portPath),
      throttled: bool(port, 'throttled', portPath),
    });
  }
  return ports;
}

const CROP_IDS: readonly number[] = [
  CropId.None,
  CropId.RussetPotato,
  CropId.SugarCane,
  CropId.Corn,
  CropId.ChiliPepper,
  CropId.GoldPotato,
];
/** The roster's other three are machines, not crops — see `CropId`. */
const SOIL_TYPES: readonly number[] = [SoilType.Loam, SoilType.Sand, SoilType.Clay];
const BOT_KINDS: readonly number[] = [BotKind.Harvester, BotKind.Planter, BotKind.Repair];
const BOT_PHASES: readonly number[] = [
  BotPhase.Idle,
  BotPhase.Outbound,
  BotPhase.Working,
  BotPhase.Returning,
];
/**
 * Every item id a save may legally hold — DERIVED FROM `ITEM_SPECS`, not typed out beside it.
 *
 * It used to be a hand-written list, and it was wrong twice: Rustic Style chips and the repair
 * kit were both missing, so a real world holding either refused to load, and the ids had been
 * legal the whole time. That is not a mistake anybody makes once. Twenty boxed-machine rows
 * arriving at once would have been the third and fourth and fifth chances to make it, so the
 * list now reads the table it was always supposed to agree with.
 *
 * The failure mode this trades into is the opposite one — an id RETIRED from `ITEM_SPECS` would
 * start refusing old saves — and that is the safe direction: retiring an item is a deliberate
 * act that shows up in a migration, while forgetting to append to a list is silent.
 */
const ITEM_IDS: readonly number[] = ITEM_SPECS.map((spec) => spec.id);
/** A grabber's filter and its hand both accept 0 for "nothing", on top of the real ids. */
const ITEM_IDS_OR_NONE: readonly number[] = [0, ...ITEM_IDS];
const MACHINE_KINDS: readonly number[] = [
  MachineKind.SellBin,
  MachineKind.ChipKitchen,
  MachineKind.Sprinkler,
  MachineKind.Washer,
  MachineKind.Slicer,
  MachineKind.Fryer,
  MachineKind.Seasoner,
  MachineKind.Bagger,
  MachineKind.Pump,
  MachineKind.Tank,
  MachineKind.PipedSprinkler,
  MachineKind.IrrigationHub,
  MachineKind.Recirculator,
  MachineKind.Juicer,
  MachineKind.Kettle,
  MachineKind.Grinder,
  MachineKind.SyrupMixer,
  MachineKind.Carbonator,
  MachineKind.Bottler,
  MachineKind.SixPacker,
  MachineKind.ComboPacker,
  MachineKind.DeliveryCart,
  MachineKind.TruckDepot,
  MachineKind.BeltJunction,
  MachineKind.RootCellar,
  MachineKind.Composter,
  MachineKind.HandCart,
  MachineKind.OrangeTree,
  MachineKind.LemonTree,
  MachineKind.KolaTree,
  MachineKind.HarvesterDock,
  MachineKind.PlanterDock,
  MachineKind.MaintenanceStation,
  MachineKind.DroneBay,
  // RETIRED ([[090]]) AND STILL ALLOWED, which is exactly the case this list was hand-written
  // for — see the comment above `ITEM_IDS`: "deriving the guard from today's table would mean a
  // kind retired in 2029 silently stops being loadable." That day came early. A format-17 world
  // cannot contain a Parts Bench (the migration boxes every one), and a hand-edited payload that
  // names one loads into a machine whose spec is still there — inert, unbuildable, and boxable.
  // Refusing it instead would turn a curiosity into a save that will not open.
  MachineKind.PartsBench,
];
/** `None` is not a legal liquid for a pipe: a pipe that carries nothing is not a pipe. */
const LIQUIDS: readonly number[] = [
  LiquidId.Water,
  LiquidId.CaneJuice,
  LiquidId.SimpleSyrup,
  LiquidId.CarbonatedWater,
  LiquidId.SodaSyrup,
];
const CONTRACT_PHASES: readonly number[] = [
  ContractPhase.Waiting,
  ContractPhase.Loading,
  ContractPhase.Rolling,
];

const BELT_TIERS: readonly number[] = [BeltTier.Basic, BeltTier.Fast, BeltTier.Express];
const GRABBER_TIERS: readonly number[] = [GrabberTier.Mk1, GrabberTier.Mk2, GrabberTier.Long];
/** Belts and grabbers face a compass direction. `None` is not a legal facing for either. */
const FACINGS: readonly number[] = [
  Direction.North,
  Direction.East,
  Direction.South,
  Direction.West,
];
const DIRECTIONS: readonly number[] = [
  Direction.None,
  Direction.North,
  Direction.East,
  Direction.South,
  Direction.West,
];
/** `None` is not a legal errand action: an errand to do nothing is what `null` is for. */
const ERRAND_ACTIONS: readonly number[] = [
  IntentAction.Water,
  IntentAction.Plant,
  IntentAction.Harvest,
  IntentAction.Load,
  IntentAction.Unload,
  IntentAction.RefillHopper,
  IntentAction.Repair,
  IntentAction.WhackJam,
  IntentAction.Sell,
  IntentAction.Deconstruct,
  IntentAction.Buy,
  IntentAction.Fertilize,
  IntentAction.Scythe,
  IntentAction.HitchCart,
  IntentAction.RefillCan,
  IntentAction.UseRepairKit,
  IntentAction.Walk,
];

/**
 * Rebuild a `WorldState` from a canonical payload, validating as it goes.
 *
 * `trace` is supplied separately because it is stored separately; omit it and the world
 * comes back with an empty log, which is correct — the trace is a session artefact, not
 * part of the world, and nothing in the hash depends on it.
 *
 * Throws `SaveCorruptError` naming the first bad field.
 */
export function fromPayload(value: unknown, trace: readonly TraceLike[] = []): WorldState {
  const p = record(value, 'payload');

  const playerRaw = record(p['player'], 'payload.player');
  const intentRaw = recordOrNull(playerRaw['intent'], 'payload.player.intent');
  const intent: PlayerIntent | null =
    intentRaw === null
      ? null
      : {
          action: idInt(
            intentRaw,
            'action',
            'payload.player.intent',
            ERRAND_ACTIONS,
          ) as IntentAction,
          tileX: int(intentRaw, 'tileX', 'payload.player.intent'),
          tileY: int(intentRaw, 'tileY', 'payload.player.intent'),
          item: int(intentRaw, 'item', 'payload.player.intent'),
          count: int(intentRaw, 'count', 'payload.player.intent'),
          issuedTick: int(intentRaw, 'issuedTick', 'payload.player.intent'),
        };
  const player: PlayerState = {
    xSub: int(playerRaw, 'xSub', 'payload.player'),
    ySub: int(playerRaw, 'ySub', 'payload.player'),
    facing: idInt(playerRaw, 'facing', 'payload.player', DIRECTIONS) as Direction,
    moveDir: idInt(playerRaw, 'moveDir', 'payload.player', DIRECTIONS) as Direction,
    moveAccum: int(playerRaw, 'moveAccum', 'payload.player'),
    towedCartId: int(playerRaw, 'towedCartId', 'payload.player'),
    canCharges: int(playerRaw, 'canCharges', 'payload.player'),
    intent,
  };

  const inventoryRaw = list(p, 'inventory', 'payload');
  const inventory: WorldState['inventory'] = [];
  for (let i = 0; i < inventoryRaw.length; i++) {
    const path = `payload.inventory[${String(i)}]`;
    const slot = record(inventoryRaw[i], path);
    const boxesRaw = list(slot, 'boxes', path);
    const boxes: BoxedMachine[] = [];
    for (let j = 0; j < boxesRaw.length; j++) {
      const boxPath = `${path}.boxes[${String(j)}]`;
      const box = record(boxesRaw[j], boxPath);
      boxes.push({
        speedLevel: int(box, 'speedLevel', boxPath),
        efficiencyLevel: int(box, 'efficiencyLevel', boxPath),
        capacityLevel: int(box, 'capacityLevel', boxPath),
        condition: int(box, 'condition', boxPath),
        investedCents: int(box, 'investedCents', boxPath),
      });
    }
    const stacksRaw = list(slot, 'stacks', path);
    const stacks: FreshStack[] = [];
    for (let j = 0; j < stacksRaw.length; j++) {
      const stackPath = `${path}.stacks[${String(j)}]`;
      const stack = record(stacksRaw[j], stackPath);
      stacks.push({
        spoilAtTick: int(stack, 'spoilAtTick', stackPath),
        count: int(stack, 'count', stackPath),
      });
    }
    // SORTED HERE RATHER THAN TRUSTED, exactly as `ownedParcels` and `ceremonies` are: the order
    // is a hashed invariant and a file that lost it would restore a world that hashes differently
    // from the one that was saved while holding the same potatoes. Ascending by deadline, which
    // is also the order removals eat them in.
    stacks.sort((a, b) => a.spoilAtTick - b.spoilAtTick);
    inventory.push({
      item: idInt(slot, 'item', path, ITEM_IDS) as ItemId,
      count: int(slot, 'count', path),
      boxes,
      stacks,
    });
  }

  const fieldRaw = list(p, 'field', 'payload');
  const field: CropTile[] = [];
  for (let i = 0; i < fieldRaw.length; i++) {
    const path = `payload.field[${String(i)}]`;
    const tile = record(fieldRaw[i], path);
    field.push({
      tileX: int(tile, 'tileX', path),
      tileY: int(tile, 'tileY', path),
      crop: idInt(tile, 'crop', path, CROP_IDS) as CropId,
      growth: int(tile, 'growth', path),
      growthTarget: int(tile, 'growthTarget', path),
      moisture: int(tile, 'moisture', path),
      moistureAccum: int(tile, 'moistureAccum', path),
      soil: idInt(tile, 'soil', path, SOIL_TYPES) as SoilType,
      fertility: int(tile, 'fertility', path),
      fertilityWear: int(tile, 'fertilityWear', path),
      readyAge: int(tile, 'readyAge', path),
      compost: int(tile, 'compost', path),
      zone: int(tile, 'zone', path),
      // Presentation data, never saved and never read (see `CropTile.lastPouredTick`). Every
      // loaded world starts at "never poured", which is correct: a pour that happened before
      // the save owes no droplets after it.
      lastPouredTick: 0,
    });
  }

  const soilMemoryRaw = list(p, 'soilMemory', 'payload');
  const soilMemory: SoilMemory[] = [];
  for (let i = 0; i < soilMemoryRaw.length; i++) {
    const path = `payload.soilMemory[${String(i)}]`;
    const entry = record(soilMemoryRaw[i], path);
    soilMemory.push({
      tile: int(entry, 'tile', path),
      soil: idInt(entry, 'soil', path, SOIL_TYPES) as SoilType,
      fertility: int(entry, 'fertility', path),
      fertilityWear: int(entry, 'fertilityWear', path),
    });
  }

  const machinesRaw = list(p, 'machines', 'payload');
  const machines: Machine[] = [];
  for (let i = 0; i < machinesRaw.length; i++) {
    const path = `payload.machines[${String(i)}]`;
    const machine = record(machinesRaw[i], path);
    const kind = idInt(machine, 'kind', path, MACHINE_KINDS) as MachineKind;
    machines.push({
      id: int(machine, 'id', path),
      kind,
      tileX: int(machine, 'tileX', path),
      tileY: int(machine, 'tileY', path),
      progress: int(machine, 'progress', path),
      cargoItem: idInt(machine, 'cargoItem', path, ITEM_IDS_OR_NONE) as ItemId | 0,
      cargoCount: int(machine, 'cargoCount', path),
      cargoFreshTicks: int(machine, 'cargoFreshTicks', path),
      runTicksRemaining: int(machine, 'runTicksRemaining', path),
      inputCounts: readInputCounts(machine, path, kind),
      inputFreshTicks: readInputFreshTicks(machine, path, kind),
      ports: readPorts(machine, path, kind),
      outputCount: int(machine, 'outputCount', path),
      outputFreshTicks: int(machine, 'outputFreshTicks', path),
      outputItem: idInt(machine, 'outputItem', path, ITEM_IDS_OR_NONE) as ItemId | 0,
      tankMl: int(machine, 'tankMl', path),
      condition: int(machine, 'condition', path),
      opCount: int(machine, 'opCount', path),
      jammed: bool(machine, 'jammed', path),
      blockedTicks: int(machine, 'blockedTicks', path),
      overcookedCount: int(machine, 'overcookedCount', path),
      cooldown: int(machine, 'cooldown', path),
      investedCents: int(machine, 'investedCents', path),
      speedLevel: int(machine, 'speedLevel', path),
      efficiencyLevel: int(machine, 'efficiencyLevel', path),
      capacityLevel: int(machine, 'capacityLevel', path),
      network: int(machine, 'network', path),
      flowMlPerMinute: int(machine, 'flowMlPerMinute', path),
      throttled: bool(machine, 'throttled', path),
      scanCursor: int(machine, 'scanCursor', path),
      wateredCount: int(machine, 'wateredCount', path),
      skippedCount: int(machine, 'skippedCount', path),
      seedShelfItem: idInt(machine, 'seedShelfItem', path, ITEM_IDS_OR_NONE) as ItemId | 0,
      seedShelfCount: int(machine, 'seedShelfCount', path),
      untouchedTicks: int(machine, 'untouchedTicks', path),
      junctionInCursor: int(machine, 'junctionInCursor', path),
      junctionOutCursor: int(machine, 'junctionOutCursor', path),
      boundZone: int(machine, 'boundZone', path),
      // Presentation data, never saved and never read (see `Machine.bleedEvents`). A loaded
      // world opens with an empty diagnostics window: money that bled before the save owes no
      // alert after it.
      bleedEvents: [],
    });
  }

  // Bots. Validated against this build the way contracts are: a kind and a phase are ids this
  // build has to be able to dispatch on, and a bot in phase 9 is not a thing that can be advanced,
  // drawn, or repaired — so it stops here, loudly, rather than at the first tick that touches it.
  const botsRaw = list(p, 'bots', 'payload');
  const bots: Bot[] = [];
  for (let i = 0; i < botsRaw.length; i++) {
    const path = `payload.bots[${String(i)}]`;
    const bot = record(botsRaw[i], path);
    bots.push({
      id: int(bot, 'id', path),
      kind: idInt(bot, 'kind', path, BOT_KINDS) as BotKind,
      dockId: int(bot, 'dockId', path),
      xSub: int(bot, 'xSub', path),
      ySub: int(bot, 'ySub', path),
      facing: idInt(bot, 'facing', path, DIRECTIONS) as Direction,
      moveAccum: int(bot, 'moveAccum', path),
      phase: idInt(bot, 'phase', path, BOT_PHASES) as BotPhase,
      targetTile: int(bot, 'targetTile', path),
      routeCursor: int(bot, 'routeCursor', path),
      workTicks: int(bot, 'workTicks', path),
      seedItem: idInt(bot, 'seedItem', path, ITEM_IDS_OR_NONE) as ItemId | 0,
      seedCount: int(bot, 'seedCount', path),
      carryItem: idInt(bot, 'carryItem', path, ITEM_IDS_OR_NONE) as ItemId | 0,
      carryCount: int(bot, 'carryCount', path),
      condition: int(bot, 'condition', path),
      opCount: int(bot, 'opCount', path),
    });
  }
  bots.sort((a, b) => a.id - b.id);

  const reservoirsRaw = list(p, 'reservoirs', 'payload');
  const reservoirs: Reservoir[] = [];
  for (let i = 0; i < reservoirsRaw.length; i++) {
    const path = `payload.reservoirs[${String(i)}]`;
    const reservoir = record(reservoirsRaw[i], path);
    reservoirs.push({
      id: int(reservoir, 'id', path),
      tileX: int(reservoir, 'tileX', path),
      tileY: int(reservoir, 'tileY', path),
      tilesWide: int(reservoir, 'tilesWide', path),
      tilesHigh: int(reservoir, 'tilesHigh', path),
      levelMl: int(reservoir, 'levelMl', path),
      capacityMl: int(reservoir, 'capacityMl', path),
      rechargeAccum: int(reservoir, 'rechargeAccum', path),
    });
  }

  const pipesRaw = list(p, 'pipes', 'payload');
  const pipes: Pipe[] = [];
  for (let i = 0; i < pipesRaw.length; i++) {
    const path = `payload.pipes[${String(i)}]`;
    const pipe = record(pipesRaw[i], path);
    pipes.push({
      id: int(pipe, 'id', path),
      tileX: int(pipe, 'tileX', path),
      tileY: int(pipe, 'tileY', path),
      liquid: idInt(pipe, 'liquid', path, LIQUIDS) as LiquidId,
      network: int(pipe, 'network', path),
    });
  }

  const networksRaw = list(p, 'networks', 'payload');
  const networks: PipeNetwork[] = [];
  for (let i = 0; i < networksRaw.length; i++) {
    const path = `payload.networks[${String(i)}]`;
    const network = record(networksRaw[i], path);
    networks.push({
      id: int(network, 'id', path),
      liquid: idInt(network, 'liquid', path, LIQUIDS) as LiquidId,
      supplyAccum: int(network, 'supplyAccum', path),
      rrOffset: int(network, 'rrOffset', path),
      supplyMl: int(network, 'supplyMl', path),
      demandMl: int(network, 'demandMl', path),
      deliveredMl: int(network, 'deliveredMl', path),
    });
  }

  // Contracts. Validated against this build the way `ownedParcels` is rather than kept as
  // written: a contract names an item and a phase, and both are ids this build has to be able
  // to look up — a route for item 99 in phase 7 is not a thing that can be advanced, drawn, or
  // paid out, so it stops here, loudly, rather than at the first tick that touches it.
  const contractsRaw = list(p, 'contracts', 'payload');
  const contracts: Contract[] = [];
  for (let i = 0; i < contractsRaw.length; i++) {
    const path = `payload.contracts[${String(i)}]`;
    const contract = record(contractsRaw[i], path);
    contracts.push({
      id: int(contract, 'id', path),
      depotId: int(contract, 'depotId', path),
      item: idInt(contract, 'item', path, ITEM_IDS) as ItemId,
      quantityPerRun: int(contract, 'quantityPerRun', path),
      // Clipped rather than rejected, exactly as a zone name is: a destination is flavour, and
      // an over-long one is a client bug that must not cost the player a route. It is also the
      // one stored string that is not hashed — see `hash.ts`.
      destination: clipDestination(str(contract, 'destination', path)),
      stocked: int(contract, 'stocked', path),
      inTransit: int(contract, 'inTransit', path),
      phase: idInt(contract, 'phase', path, CONTRACT_PHASES) as ContractPhase,
      ticksRemaining: int(contract, 'ticksRemaining', path),
      runsCompleted: int(contract, 'runsCompleted', path),
      grossCents: int(contract, 'grossCents', path),
    });
  }
  // Sorted rather than trusted, like every other id-keyed list here: the order is a hashed
  // invariant, and a file that lost it would restore a world that hashes differently from the
  // one that was saved while being the same lot.
  contracts.sort((a, b) => a.id - b.id);

  const ceremoniesRaw = list(p, 'ceremonies', 'payload');
  const ceremonies: string[] = [];
  for (let i = 0; i < ceremoniesRaw.length; i++) {
    const value = ceremoniesRaw[i];
    if (typeof value !== 'string') {
      fail(`payload.ceremonies[${String(i)}]`, 'expected a string ceremony id');
    }
    ceremonies.push(value);
  }
  ceremonies.sort();

  const beltsRaw = list(p, 'belts', 'payload');
  const belts: Belt[] = [];
  for (let i = 0; i < beltsRaw.length; i++) {
    const path = `payload.belts[${String(i)}]`;
    const belt = record(beltsRaw[i], path);
    const itemsRaw = list(belt, 'items', path);
    const items: Belt['items'] = [];
    for (let j = 0; j < itemsRaw.length; j++) {
      const itemPath = `${path}.items[${String(j)}]`;
      const entry = record(itemsRaw[j], itemPath);
      items.push({
        dist: int(entry, 'dist', itemPath),
        item: idInt(entry, 'item', itemPath, ITEM_IDS) as ItemId,
        freshTicks: int(entry, 'freshTicks', itemPath),
      });
    }
    belts.push({
      id: int(belt, 'id', path),
      tileX: int(belt, 'tileX', path),
      tileY: int(belt, 'tileY', path),
      dir: idInt(belt, 'dir', path, FACINGS) as Direction,
      lengthTiles: int(belt, 'lengthTiles', path),
      tier: idInt(belt, 'tier', path, BELT_TIERS) as BeltTier,
      items,
      moveAccum: int(belt, 'moveAccum', path),
    });
  }

  const grabbersRaw = list(p, 'grabbers', 'payload');
  const grabbers: Grabber[] = [];
  for (let i = 0; i < grabbersRaw.length; i++) {
    const path = `payload.grabbers[${String(i)}]`;
    const grabber = record(grabbersRaw[i], path);
    grabbers.push({
      id: int(grabber, 'id', path),
      tileX: int(grabber, 'tileX', path),
      tileY: int(grabber, 'tileY', path),
      dir: idInt(grabber, 'dir', path, FACINGS) as Direction,
      tier: idInt(grabber, 'tier', path, GRABBER_TIERS) as GrabberTier,
      filter: idInt(grabber, 'filter', path, ITEM_IDS_OR_NONE),
      held: idInt(grabber, 'held', path, ITEM_IDS_OR_NONE),
      heldFreshTicks: int(grabber, 'heldFreshTicks', path),
      cooldown: int(grabber, 'cooldown', path),
      opCount: int(grabber, 'opCount', path),
    });
  }

  const zonesRaw = list(p, 'zones', 'payload');
  const zones: Zone[] = [];
  for (let i = 0; i < zonesRaw.length; i++) {
    const path = `payload.zones[${String(i)}]`;
    const zone = record(zonesRaw[i], path);
    zones.push({
      id: int(zone, 'id', path),
      name: str(zone, 'name', path),
      crop: idInt(zone, 'crop', path, CROP_IDS) as CropId,
      priority: int(zone, 'priority', path),
      autoReplant: bool(zone, 'autoReplant', path),
      replantCooldown: int(zone, 'replantCooldown', path),
    });
  }

  // THE ONE LIST THAT IS VALIDATED AGAINST THIS BUILD'S GEOMETRY RATHER THAN KEPT AS WRITTEN,
  // and the contrast with `unlocked` below is the argument. An unknown tech id is a string
  // nothing looks up — harmless to carry, rude to drop. A parcel index is a place: index 20 in
  // a 4×4 grid names land that does not exist, so a world carrying one cannot be drawn, built
  // on, or hashed against the build that wrote it. `BALANCE_HASH` records the grid's shape but
  // a mismatch there is deliberately non-blocking, so this is where a lot from a differently
  // shaped map actually stops — loudly, naming the index, rather than as a machine placed on
  // land the renderer has no chunk for.
  const parcelsRaw = list(p, 'ownedParcels', 'payload');
  const ownedParcels: number[] = [];
  for (let i = 0; i < parcelsRaw.length; i++) {
    const value = parcelsRaw[i];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      fail(`payload.ownedParcels[${String(i)}]`, 'expected an integer parcel index');
    }
    if (!isParcelIndex(value)) {
      fail(
        `payload.ownedParcels[${String(i)}]`,
        `${String(value)} is not a parcel on this build's ${String(PARCELS_WIDE)}×${String(PARCELS_HIGH)} map`,
      );
    }
    ownedParcels.push(value);
  }
  // Sorted here rather than trusted, exactly as `unlocked` and `ceremonies` are: the order is
  // a hashed invariant, and a file that lost it would restore to a world that hashes
  // differently from the one that was saved while being the same lot.
  ownedParcels.sort((a, b) => a - b);
  for (let i = 1; i < ownedParcels.length; i++) {
    if (ownedParcels[i] === ownedParcels[i - 1]) {
      fail(`payload.ownedParcels[${String(i)}]`, 'the same parcel is owned twice');
    }
  }
  // A world with no land cannot be played — nothing can be built or planted on it — and none
  // was ever written, since the starting parcel is a gift every world is born holding.
  if (ownedParcels.length === 0) fail('payload.ownedParcels', 'a world owns at least one parcel');

  // Unknown node ids are kept rather than rejected: a save written by a newer balance patch
  // that this build then reads has already passed the formatVersion gate, and dropping a
  // node the player paid for would be worse than carrying a string nothing looks up.
  const unlockedRaw = list(p, 'unlocked', 'payload');
  const unlocked: string[] = [];
  for (let i = 0; i < unlockedRaw.length; i++) {
    const value = unlockedRaw[i];
    if (typeof value !== 'string') {
      fail(`payload.unlocked[${String(i)}]`, 'expected a string node id');
    }
    unlocked.push(value);
  }
  unlocked.sort();

  const streamsRaw = list(p, 'streams', 'payload');
  const streams: Record<string, RngState> = {};
  for (let i = 0; i < streamsRaw.length; i++) {
    const path = `payload.streams[${String(i)}]`;
    const stream = record(streamsRaw[i], path);
    streams[str(stream, 'id', path)] = {
      s0: int(stream, 's0', path),
      s1: int(stream, 's1', path),
      s2: int(stream, 's2', path),
      s3: int(stream, 's3', path),
    };
  }

  const statsRaw = record(p['stats'], 'payload.stats');
  const touchesRaw = record(statsRaw['touches'], 'payload.stats.touches');
  const touches: ManualTouchCounts = {
    handWater: int(touchesRaw, 'handWater', 'payload.stats.touches'),
    handPlant: int(touchesRaw, 'handPlant', 'payload.stats.touches'),
    handHarvest: int(touchesRaw, 'handHarvest', 'payload.stats.touches'),
    handCarry: int(touchesRaw, 'handCarry', 'payload.stats.touches'),
    handRepair: int(touchesRaw, 'handRepair', 'payload.stats.touches'),
    jamWhack: int(touchesRaw, 'jamWhack', 'payload.stats.touches'),
    hopperRefill: int(touchesRaw, 'hopperRefill', 'payload.stats.touches'),
  };

  const samplesRaw = list(statsRaw, 'netWorthSamples', 'payload.stats');
  const netWorthSamples: number[] = [];
  for (let i = 0; i < samplesRaw.length; i++) {
    const sample = samplesRaw[i];
    if (typeof sample !== 'number' || !Number.isInteger(sample)) {
      fail(`payload.stats.netWorthSamples[${String(i)}]`, 'expected an integer');
    }
    netWorthSamples.push(sample);
  }

  const salesRaw = list(statsRaw, 'salesByItem', 'payload.stats');
  const salesByItem: WorldStats['salesByItem'] = [];
  for (let i = 0; i < salesRaw.length; i++) {
    const path = `payload.stats.salesByItem[${String(i)}]`;
    const row = record(salesRaw[i], path);
    salesByItem.push({
      item: idInt(row, 'item', path, ITEM_IDS) as ItemId,
      units: int(row, 'units', path),
      cents: int(row, 'cents', path),
      unitsAtDawn: int(row, 'unitsAtDawn', path),
      centsAtDawn: int(row, 'centsAtDawn', path),
    });
  }
  // Sorted here rather than trusted, exactly as `ceremonies` and freshness stacks are: the
  // ascending item order is a hashed invariant of the ledger.
  salesByItem.sort((a, b) => a.item - b.item);

  const hoursRaw = list(statsRaw, 'hours', 'payload.stats');
  const hours: WorldStats['hours'] = [];
  for (let i = 0; i < hoursRaw.length; i++) {
    const path = `payload.stats.hours[${String(i)}]`;
    const bucket = record(hoursRaw[i], path);
    hours.push({
      hour: int(bucket, 'hour', path),
      ticks: int(bucket, 'ticks', path),
      grossCents: int(bucket, 'grossCents', path),
      spendCents: int(bucket, 'spendCents', path),
      waterMl: int(bucket, 'waterMl', path),
      itemsSold: int(bucket, 'itemsSold', path),
      inputsWasted: int(bucket, 'inputsWasted', path),
      itemsProduced: int(bucket, 'itemsProduced', path),
    });
  }
  // Chronological is ascending hour index, so restoring the sort restores the invariant.
  hours.sort((a, b) => a.hour - b.hour);

  const hourMarkRaw = record(statsRaw['hourMark'], 'payload.stats.hourMark');
  const hourMark: WorldStats['hourMark'] = {
    hour: int(hourMarkRaw, 'hour', 'payload.stats.hourMark'),
    tick: int(hourMarkRaw, 'tick', 'payload.stats.hourMark'),
    earnedCents: int(hourMarkRaw, 'earnedCents', 'payload.stats.hourMark'),
    spentCents: int(hourMarkRaw, 'spentCents', 'payload.stats.hourMark'),
    waterMl: int(hourMarkRaw, 'waterMl', 'payload.stats.hourMark'),
    itemsSold: int(hourMarkRaw, 'itemsSold', 'payload.stats.hourMark'),
    inputsWasted: int(hourMarkRaw, 'inputsWasted', 'payload.stats.hourMark'),
    itemsProduced: int(hourMarkRaw, 'itemsProduced', 'payload.stats.hourMark'),
  };

  const stats: WorldStats = {
    ticksElapsed: int(statsRaw, 'ticksElapsed', 'payload.stats'),
    lifetimeEarnedCents: int(statsRaw, 'lifetimeEarnedCents', 'payload.stats'),
    lifetimeSpentCents: int(statsRaw, 'lifetimeSpentCents', 'payload.stats'),
    waterDrawnMl: int(statsRaw, 'waterDrawnMl', 'payload.stats'),
    itemsSold: int(statsRaw, 'itemsSold', 'payload.stats'),
    itemsProducedByMachine: int(statsRaw, 'itemsProducedByMachine', 'payload.stats'),
    itemsHarvestedByHand: int(statsRaw, 'itemsHarvestedByHand', 'payload.stats'),
    automatedGrossCents: int(statsRaw, 'automatedGrossCents', 'payload.stats'),
    inputsWastedByMachine: int(statsRaw, 'inputsWastedByMachine', 'payload.stats'),
    repairKitsUsed: int(statsRaw, 'repairKitsUsed', 'payload.stats'),
    repairKitSpendCents: int(statsRaw, 'repairKitSpendCents', 'payload.stats'),
    netWorthCents: int(statsRaw, 'netWorthCents', 'payload.stats'),
    peakNetWorthCents: int(statsRaw, 'peakNetWorthCents', 'payload.stats'),
    netWorthSamples,
    nextNetWorthSampleTick: int(statsRaw, 'nextNetWorthSampleTick', 'payload.stats'),
    ticksSinceManualTouch: int(statsRaw, 'ticksSinceManualTouch', 'payload.stats'),
    longestHandsFreeTicks: int(statsRaw, 'longestHandsFreeTicks', 'payload.stats'),
    longestUntouchedMachineTicks: int(statsRaw, 'longestUntouchedMachineTicks', 'payload.stats'),
    touches,
    salesByItem,
    cheatsUsed: int(statsRaw, 'cheatsUsed', 'payload.stats'),
    hours,
    hourMark,
    dawnsSeen: int(statsRaw, 'dawnsSeen', 'payload.stats'),
  };

  const restoredTrace: TraceEntry[] = [];
  for (let i = 0; i < trace.length; i++) restoredTrace.push(trace[i]! as TraceEntry);

  return {
    version: int(p, 'version', 'payload'),
    worldSeed: int(p, 'worldSeed', 'payload'),
    tick: int(p, 'tick', 'payload'),
    moneyCents: int(p, 'moneyCents', 'payload'),
    player,
    inventory,
    ownedParcels,
    field,
    soilMemory,
    machines,
    nextMachineId: int(p, 'nextMachineId', 'payload'),
    belts,
    nextBeltId: int(p, 'nextBeltId', 'payload'),
    grabbers,
    nextGrabberId: int(p, 'nextGrabberId', 'payload'),
    zones,
    nextZoneId: int(p, 'nextZoneId', 'payload'),
    reservoirs,
    nextReservoirId: int(p, 'nextReservoirId', 'payload'),
    pipes,
    nextPipeId: int(p, 'nextPipeId', 'payload'),
    networks,
    contracts,
    nextContractId: int(p, 'nextContractId', 'payload'),
    bots,
    nextBotId: int(p, 'nextBotId', 'payload'),
    ceremonies,
    unlocked,
    streams,
    stats,
    trace: restoredTrace,
  };
}

/**
 * The trace entries a host may hand back at load, kept structural so the storage layer does
 * not have to import the `TraceEntry` nominal type to satisfy it.
 */
export interface TraceLike {
  tick: number;
  command: unknown;
}
