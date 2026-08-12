// Per-machine upgrades — the only thing in the game that scales a number.
//
// Plan §3: three dials × three levels, bought at the machine, physically visible, costs
// escalating 1× / 2.5× / 6× so maxing one Fryer competes with buying a second. The tech
// tree unlocks verbs and never touches a stat; these touch stats and never unlock a verb.
// That split is the anti-double-dip rule, and it is structural — `TechNode` has no numeric
// field to put a bonus in, and nothing here returns a capability.
//
// Every function is a pure integer transform of `(spec, machine)`. Order of operations
// matters and is fixed: the Speed penalty applies to wear before the Efficiency cut, so a
// maxed-Speed maxed-Efficiency machine lands on the same number on every engine forever.

import {
  CAPACITY_BONUS_PER_LEVEL,
  CONDITION_EFFECT_THRESHOLD,
  EFFICIENCY_WEAR_CUT_PERCENT_PER_LEVEL,
  type MachineSpec,
  SPEED_RATE_BONUS_PERCENT_PER_LEVEL,
  SPEED_WEAR_PENALTY_PERCENT_PER_LEVEL,
  UPGRADE_COST_PERCENT_BY_LEVEL,
  UPGRADE_MAX_LEVEL,
  UpgradeDial,
} from './data';
import type { Machine } from './state';
import { divFloor } from './units';

/** The level a machine currently holds on one dial. */
export function upgradeLevel(machine: Machine, dial: UpgradeDial): number {
  switch (dial) {
    case UpgradeDial.Speed:
      return machine.speedLevel;
    case UpgradeDial.Efficiency:
      return machine.efficiencyLevel;
    case UpgradeDial.Capacity:
      return machine.capacityLevel;
    default:
      return 0;
  }
}

/** Set a dial. Callers are expected to have checked the level and charged for it. */
export function setUpgradeLevel(machine: Machine, dial: UpgradeDial, level: number): void {
  switch (dial) {
    case UpgradeDial.Speed:
      machine.speedLevel = level;
      return;
    case UpgradeDial.Efficiency:
      machine.efficiencyLevel = level;
      return;
    case UpgradeDial.Capacity:
      machine.capacityLevel = level;
      return;
    default:
      return;
  }
}

/**
 * What the *next* level on a dial costs, in cents, or -1 when the dial is maxed.
 *
 * Priced off the machine's list price rather than what the player paid, so a discount or a
 * future sale can never make a dial cheaper on one machine than on its identical twin.
 */
export function upgradeCostCents(spec: MachineSpec, currentLevel: number): number {
  if (currentLevel >= UPGRADE_MAX_LEVEL) return -1;
  const percent = UPGRADE_COST_PERCENT_BY_LEVEL[currentLevel];
  if (percent === undefined) return -1;
  return divFloor(spec.priceCents * percent, 100);
}

/** Whether a machine is the sort of thing a dial does anything to at all. */
export function acceptsUpgrades(spec: MachineSpec): boolean {
  return spec.workPerOperation > 0;
}

/**
 * Work-points per tick, after the Speed dial and after the condition penalty.
 *
 * Below the effect threshold a machine runs at half speed — deterministic, per-operation,
 * and visible on the wrench lamp. There are no random or time-based failures anywhere.
 */
export function effectiveWorkRate(spec: MachineSpec, machine: Machine): number {
  const boosted = divFloor(
    spec.workRatePerTick * (100 + SPEED_RATE_BONUS_PERCENT_PER_LEVEL * machine.speedLevel),
    100,
  );
  const rate = machine.condition < CONDITION_EFFECT_THRESHOLD ? divFloor(boosted, 2) : boosted;
  return rate < 1 ? 1 : rate;
}

/**
 * Condition lost per completed operation, after both wear dials.
 *
 * Never reaches zero while the machine wears at all: Efficiency is described as "the
 * expensive track", not as a machine that runs forever free, and a wear-free machine would
 * quietly delete plan §4's entire upkeep pressure budget.
 */
export function effectiveWear(spec: MachineSpec, machine: Machine): number {
  if (spec.wearPerOperation <= 0) return 0;
  const faster = divFloor(
    spec.wearPerOperation * (100 + SPEED_WEAR_PENALTY_PERCENT_PER_LEVEL * machine.speedLevel),
    100,
  );
  const cleaner = divFloor(
    faster * (100 - EFFICIENCY_WEAR_CUT_PERCENT_PER_LEVEL * machine.efficiencyLevel),
    100,
  );
  return cleaner < 1 ? 1 : cleaner;
}

function capacityScaled(base: number, level: number): number {
  if (base <= 0) return 0;
  return divFloor(base * (100 + CAPACITY_BONUS_PER_LEVEL * level), 100);
}

export function effectiveInputCapacity(spec: MachineSpec, machine: Machine): number {
  return capacityScaled(spec.inputCapacity, machine.capacityLevel);
}

export function effectiveOutputCapacity(spec: MachineSpec, machine: Machine): number {
  return capacityScaled(spec.outputCapacity, machine.capacityLevel);
}

export function effectiveTankCapacityMl(spec: MachineSpec, machine: Machine): number {
  return capacityScaled(spec.tankCapacityMl, machine.capacityLevel);
}
