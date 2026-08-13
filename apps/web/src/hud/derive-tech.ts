// WorldView → the research slice and the at-the-machine bench slice.
//
// Same contract as `derive.ts`: a pure read of the projection, running at the publish cadence,
// calling nothing on the simulation and handing nothing back to it. It allocates freely and
// the store throws the result away when nothing moved — that is `deriveTools`' bargain and it
// holds here for the same reason (thirteen nodes and three dials is not a budget).
//
// TWO PREDICATES THAT ARE NOT DUPLICATED HERE, AND WHY THAT MATTERS. Whether a node is legal
// to research is `prerequisitesMet` + `milestoneMet`, imported from the sim. Whether a dial is
// legal to buy is `upgradeCostCents` + `UPGRADE_MAX_LEVEL`, imported from the sim. The panel
// asks the same functions `tick.ts` asks, so a button that looks enabled is a command that
// will be accepted — and, more importantly, a rule change lands in both places at once. The
// one thing computed locally is *era*, which is a layout concern the sim has no opinion about.
//
// The reach test is the exception worth naming. `withinReachOfMachine` is private to `tick.ts`
// and takes a `Machine`, which never crosses the view boundary, so the geometry is restated
// below against `MachineView`. It is a mirror, kept honest by using the sim's own constants
// and its own integer helpers rather than re-deriving them — if it ever disagrees, the panel
// offers a button the sim refuses, which is visible in one click rather than silent.

import {
  CAPACITY_BONUS_PER_LEVEL,
  CONDITION_MAX,
  EFFICIENCY_WEAR_CUT_PERCENT_PER_LEVEL,
  HAND_REACH_SUBTILES,
  MachineKind,
  MilestoneKind,
  SPEED_RATE_BONUS_PERCENT_PER_LEVEL,
  SPEED_WEAR_PENALTY_PERCENT_PER_LEVEL,
  SUBTILE,
  TECH_NODES,
  TICKS_PER_SECOND,
  TechBranch,
  TechId,
  UPGRADE_MAX_LEVEL,
  UpgradeDial,
  upgradeCostCents,
  acceptsUpgrades,
  distanceSquaredSubtiles,
  divFloor,
  hasTech,
  machineSpec,
  milestoneMet,
  prerequisitesMet,
  tileCentreSubtiles,
} from '@snack/sim';
import type { MachineSpec, MachineView, TechNode, WorldView } from '@snack/sim';

import { dialCopy, machineLabel, nodeCopy } from './tech-copy';
import type { BenchDial, TechCard, TechStatus } from './types';

/** The mutable scratch the store fills each publish, mirroring `BenchSlice` minus its version. */
export interface BenchFields {
  machineId: number;
  kind: number;
  label: string;
  conditionPermille: number;
  listPriceCents: number;
  researched: number;
  dials: BenchDial[];
}

export function createBenchFields(): BenchFields {
  return {
    machineId: 0,
    kind: 0,
    label: '',
    conditionPermille: 0,
    listPriceCents: 0,
    researched: 0,
    dials: [],
  };
}

export function createTechFields(): TechFields {
  return { cards: [], ownedCount: 0, era: 1, frontierId: null };
}

// --- eras ------------------------------------------------------------------------------

/**
 * Which era band a node is drawn in: one plus the number of Charters standing between it and
 * the root.
 *
 * DERIVED, NEVER DECLARED. A hand-written era column on each node is a second source of truth
 * that goes stale the first time somebody reparents a node, and it goes stale silently — the
 * panel would simply draw the node in the wrong band and nothing would fail. Counting Charters
 * in the prerequisite closure cannot drift, because the closure *is* the tree.
 *
 * A Charter counts the Charters *below* it, so `charter-workshop` lands in era 1: it is drawn
 * as the band that CLOSES era 1 rather than as a member of era 2, which is what makes it read
 * as a gate you cross instead of an item you pick up.
 */
function computeEras(): Readonly<Record<string, number>> {
  const eras: Record<string, number> = {};
  const charters: Record<string, number> = {};
  for (const node of TECH_NODES) {
    charters[node.id] = node.branch === TechBranch.Charter ? 1 : 0;
  }

  // The node list is in dependency order (a prerequisite is always declared before the node
  // that needs it), so one forward pass settles every closure. Guarded anyway: a node whose
  // prerequisite has not been seen contributes zero rather than throwing.
  const crossed: Record<string, number> = {};
  for (const node of TECH_NODES) {
    let deepest = 0;
    for (const required of node.requires) {
      const below = (crossed[required] ?? 0) + (charters[required] ?? 0);
      if (below > deepest) deepest = below;
    }
    crossed[node.id] = deepest;
    eras[node.id] = deepest + 1;
  }
  return eras;
}

const ERA_BY_ID = computeEras();

export function eraOfNode(id: string): number {
  return ERA_BY_ID[id] ?? 1;
}

/** The highest era any node sits in. Drives how many bands the panel draws. */
export const MAX_ERA: number = (() => {
  let max = 1;
  for (const node of TECH_NODES) {
    const era = eraOfNode(node.id);
    if (era > max) max = era;
  }
  return max;
})();

// --- the research slice ----------------------------------------------------------------

export interface TechFields {
  cards: TechCard[];
  ownedCount: number;
  era: number;
  /** The node the panel opens on: the cheapest thing the player could act on right now. */
  frontierId: string | null;
}

/**
 * Machines that run a work cycle — the Assembly Charter's visible half.
 *
 * Mirrors `workingMachineCount` in `tick.ts` by asking the same question of the same spec
 * field, through the sim's own `acceptsUpgrades`. Two callers, one predicate.
 */
function workingMachineCount(view: WorldView): number {
  let count = 0;
  for (const machine of view.machines) {
    // The view carries plain numbers by rule — no enums across the boundary (§12) — so the
    // kind widens on the way out and narrows here, exactly as `Toolbelt` does with tool ids.
    const spec = machineSpec(machine.kind as MachineKind);
    if (spec !== null && acceptsUpgrades(spec)) count += 1;
  }
  return count;
}

function milestoneProgress(node: TechNode, view: WorldView, working: number): number {
  switch (node.milestone) {
    case MilestoneKind.ItemsSold:
      return view.stats.itemsSold;
    case MilestoneKind.WorkingMachines:
      return working;
    case MilestoneKind.MachineOutput:
      return view.stats.itemsProducedByMachine;
    default:
      return 0;
  }
}

export function deriveTech(view: WorldView, out: TechFields): TechFields {
  const unlocked = view.unlocked;
  const working = workingMachineCount(view);

  const cards: TechCard[] = [];
  let ownedCount = 0;
  let charters = 0;

  let frontierId: string | null = null;
  let frontierPrice = 0;
  let frontierRank = 99;

  for (const node of TECH_NODES) {
    const owned = hasTech(unlocked, node.id);
    if (owned) {
      ownedCount += 1;
      if (node.branch === TechBranch.Charter) charters += 1;
    }

    const prereqs = prerequisitesMet(unlocked, node);
    const milestoneHave = milestoneProgress(node, view, working);
    const milestone = milestoneMet(
      node,
      view.stats.itemsSold,
      working,
      view.stats.itemsProducedByMachine,
    );
    const affordable = view.moneyCents >= node.priceCents;

    const status: TechStatus = owned
      ? 'owned'
      : !prereqs
        ? 'blocked'
        : !milestone
          ? 'pending'
          : affordable
            ? 'ready'
            : 'short';

    // Unmet prerequisites BY NAME. This is the entire complaint the panel exists to answer:
    // the build menu says "needs Belts" and stops, so the player learns the name of a thing
    // and nothing else about it. Here the name is a card they can look at.
    const missing: string[] = [];
    for (const required of node.requires) {
      if (!hasTech(unlocked, required)) missing.push(nodeCopy(required).title);
    }

    const copy = nodeCopy(node.id);
    cards.push({
      id: node.id,
      branch: node.branch,
      era: eraOfNode(node.id),
      title: copy.title,
      verb: copy.verb,
      detail: copy.detail,
      priceCents: node.priceCents,
      status,
      missing,
      milestoneKind: node.milestone,
      milestoneNeed: node.milestoneAmount,
      milestoneHave,
      isCharter: node.branch === TechBranch.Charter ? 1 : 0,
    });

    // The frontier, and the ranking is the "30 seconds" acceptance test in three lines: the
    // panel opens on something you can buy right now; failing that, on the thing you are
    // saving for; failing that, on the milestone you are working toward. Never on the root,
    // which is where a tree panel defaults to and where nobody's attention is.
    if (!owned) {
      const rank = status === 'ready' ? 0 : status === 'short' ? 1 : status === 'pending' ? 2 : 3;
      if (rank < frontierRank || (rank === frontierRank && node.priceCents < frontierPrice)) {
        frontierRank = rank;
        frontierPrice = node.priceCents;
        frontierId = node.id;
      }
    }
  }

  out.cards = cards;
  out.ownedCount = ownedCount;
  out.era = charters + 1;
  out.frontierId = frontierId;
  return out;
}

// --- the bench -------------------------------------------------------------------------

export const HAND_REACH_SQUARED = HAND_REACH_SUBTILES * HAND_REACH_SUBTILES;

/**
 * Mirror of `machineCentreSubtiles`, against the view's copy of the footprint.
 *
 * Exported because the roadside stand asks the same question of a different machine
 * (`derive-shop.ts`). One mirror of the sim's geometry in this package is a mirror that can
 * be checked; two are two that can disagree.
 */
export function centreXSub(machine: MachineView): number {
  return tileCentreSubtiles(machine.tileX) + divFloor((machine.tilesWide - 1) * SUBTILE, 2);
}

export function centreYSub(machine: MachineView): number {
  return tileCentreSubtiles(machine.tileY) + divFloor((machine.tilesHigh - 1) * SUBTILE, 2);
}

/** Ticks one operation takes at a given Speed level, at full condition. Presentation only. */
function ticksPerOperation(spec: MachineSpec, speedLevel: number): number {
  const rate = divFloor(
    spec.workRatePerTick * (100 + SPEED_RATE_BONUS_PERCENT_PER_LEVEL * speedLevel),
    100,
  );
  if (rate <= 0) return 0;
  return spec.workPerOperation / rate;
}

function secondsPerOperation(spec: MachineSpec, speedLevel: number): string {
  const ticks = ticksPerOperation(spec, speedLevel);
  if (ticks <= 0) return '—';
  return `${(ticks / TICKS_PER_SECOND).toFixed(1)}s`;
}

/** Condition points lost per operation at a given Efficiency level, before the Speed penalty. */
function wearAt(spec: MachineSpec, efficiencyLevel: number, speedLevel: number): number {
  if (spec.wearPerOperation <= 0) return 0;
  const faster = divFloor(
    spec.wearPerOperation * (100 + SPEED_WEAR_PENALTY_PERCENT_PER_LEVEL * speedLevel),
    100,
  );
  const cleaner = divFloor(
    faster * (100 - EFFICIENCY_WEAR_CUT_PERCENT_PER_LEVEL * efficiencyLevel),
    100,
  );
  return cleaner < 1 ? 1 : cleaner;
}

/** How many operations from box-fresh to a dead stop. The number Efficiency actually buys. */
function operationsToWornOut(wear: number): number {
  if (wear <= 0) return 0;
  return Math.floor(CONDITION_MAX / wear);
}

function buildDial(
  dial: number,
  spec: MachineSpec,
  machine: MachineView,
  moneyCents: number,
): BenchDial {
  const level =
    dial === UpgradeDial.Speed
      ? machine.speedLevel
      : dial === UpgradeDial.Efficiency
        ? machine.efficiencyLevel
        : machine.capacityLevel;

  const costCents = upgradeCostCents(spec, level, dial as UpgradeDial);
  const copy = dialCopy(dial);

  let now = '';
  let next = '';
  if (dial === UpgradeDial.Speed) {
    now = `${secondsPerOperation(spec, level)} a batch`;
    next = level < UPGRADE_MAX_LEVEL ? `${secondsPerOperation(spec, level + 1)} a batch` : '';
  } else if (dial === UpgradeDial.Efficiency) {
    const wearNow = wearAt(spec, level, machine.speedLevel);
    if (wearNow <= 0) {
      // Some work-cycle machines simply do not wear. Saying "0 batches before a repair" would
      // read as the worst machine on the lot rather than the most carefree one.
      now = 'never needs a repair';
      next = '';
    } else {
      now = `${operationsToWornOut(wearNow)} batches before a repair`;
      next =
        level < UPGRADE_MAX_LEVEL
          ? `${operationsToWornOut(wearAt(spec, level + 1, machine.speedLevel))} batches`
          : '';
    }
  } else {
    now = `${machine.inputCapacity} in · ${machine.outputCapacity} out`;
    const scale = (base: number, lv: number): number =>
      divFloor(base * (100 + CAPACITY_BONUS_PER_LEVEL * lv), 100);
    next =
      level < UPGRADE_MAX_LEVEL
        ? `${scale(spec.inputCapacity, level + 1)} in · ${scale(spec.outputCapacity, level + 1)} out`
        : '';
  }

  return {
    dial,
    name: copy.name,
    trade: copy.trade,
    effect: copy.effect,
    level,
    maxLevel: UPGRADE_MAX_LEVEL,
    costCents,
    affordable: costCents >= 0 && moneyCents >= costCents ? 1 : 0,
    now,
    next,
    // The escalation, said out loud at the moment it becomes true. Plan §3 wants maxing one
    // Fryer to be a real argument against buying a second, and an argument the player has to
    // do arithmetic to notice is an argument they will not have.
    outpricesAnother: costCents > spec.priceCents ? 1 : 0,
  };
}

// The local copy of the upgrade-cost formula that used to sit here is GONE, on purpose. It
// predated `upgradeCostCents` growing a per-dial multiplier, kept compiling after the sim
// changed, and quoted Efficiency at two thirds of what the reducer actually charges — the
// exact failure mode a second copy of one price always ends in. The bench now asks the sim.

/**
 * The machine the player is standing at, or none.
 *
 * Nearest wins, not first: two 2×2 machines set side by side both fall inside hand reach from
 * the seam between them, and a panel that picks by array order would flicker between them as
 * the player drifts a few subtiles. Nearest is stable and is also what the player means.
 */
export function deriveBench(view: WorldView, out: BenchFields): BenchFields {
  out.researched = hasTech(view.unlocked, TechId.UpgradeBench) ? 1 : 0;

  let best: MachineView | null = null;
  let bestSpec: MachineSpec | null = null;
  let bestDistance = HAND_REACH_SQUARED + 1;

  for (const machine of view.machines) {
    // The view carries plain numbers by rule — no enums across the boundary (§12) — so the
    // kind widens on the way out and narrows here, exactly as `Toolbelt` does with tool ids.
    const spec = machineSpec(machine.kind as MachineKind);
    if (spec === null || !acceptsUpgrades(spec)) continue;
    const distance = distanceSquaredSubtiles(
      view.player.xSub,
      view.player.ySub,
      centreXSub(machine),
      centreYSub(machine),
    );
    if (distance > HAND_REACH_SQUARED || distance >= bestDistance) continue;
    bestDistance = distance;
    best = machine;
    bestSpec = spec;
  }

  if (best === null || bestSpec === null) {
    out.machineId = 0;
    out.kind = 0;
    out.label = '';
    out.conditionPermille = 0;
    out.listPriceCents = 0;
    out.dials = [];
    return out;
  }

  out.machineId = best.id;
  out.kind = best.kind;
  out.label = machineLabel(best.kind);
  out.conditionPermille = best.conditionPermille;
  out.listPriceCents = bestSpec.priceCents;
  out.dials = [
    buildDial(UpgradeDial.Speed, bestSpec, best, view.moneyCents),
    buildDial(UpgradeDial.Efficiency, bestSpec, best, view.moneyCents),
    buildDial(UpgradeDial.Capacity, bestSpec, best, view.moneyCents),
  ];
  return out;
}
