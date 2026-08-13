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
  WASTE_PERIOD_AT_THRESHOLD,
  WASTE_PERIOD_AT_ZERO,
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

/**
 * Whether a machine is the sort of thing a dial does anything to at all.
 *
 * DELIBERATELY UNCHANGED BY THE LIQUID LAYER. A pump has no work cycle, no wear, and no tank,
 * so two of the three dials would visibly do nothing on it — and a bench that happily sells a
 * dial which changes no number is worse than one that does not offer it. Pumps get their
 * dials when Entropy gives irrigation something to wear out; `effectivePumpRateMlPerMinute`
 * below already honours Speed for the day that happens.
 */
export function acceptsUpgrades(spec: MachineSpec): boolean {
  return spec.workPerOperation > 0;
}

/**
 * A pump's rated throughput after the Speed dial, in millilitres per minute.
 *
 * The same +30%-per-level curve every other Speed dial uses, and deliberately NOT scaled by
 * condition: irrigation carries no wear in this release (Entropy is its own), so a pump has
 * no worn state to punish. The pond's own throttle is the only thing that reduces this.
 */
export function effectivePumpRateMlPerMinute(spec: MachineSpec, machine: Machine): number {
  if (spec.pumpRateMlPerMinute <= 0) return 0;
  return divFloor(
    spec.pumpRateMlPerMinute * (100 + SPEED_RATE_BONUS_PERCENT_PER_LEVEL * machine.speedLevel),
    100,
  );
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

/**
 * How often a worn machine spoils an input, as "every Nth operation", or 0 for never.
 *
 * DETERMINISTIC BY CONSTRUCTION. Plan §4 calls this a "waste chance" and plan §7 ruling 5
 * bans random failures; the reconciliation is a cadence read off `opCount`, with the period
 * shortening as condition falls:
 *
 *   condition 400 (the threshold) → every 8th operation
 *   condition 200                 → every 5th
 *   condition   1                 → every 2nd
 *
 * A machine at or above `CONDITION_EFFECT_THRESHOLD` returns 0 and wastes nothing at all.
 * Neglect costs margin; running a factory does not.
 *
 * THIS IS THE FUNCTION THE EFFICIENCY DIAL HOOKS. Plan §3 specifies Efficiency as reducing
 * "both input waste and wear" — wear is already cut in `effectiveWear` above, and the waste
 * half belongs here, as a term that *lengthens* this period per `efficiencyLevel`. It is
 * deliberately not applied yet: the dial's waste half is work item 037's, and inventing its
 * curve here would be a balance number nobody decided.
 */
export function effectiveWastePeriod(spec: MachineSpec, machine: Machine): number {
  if (spec.workPerOperation <= 0) return 0;
  if (machine.condition >= CONDITION_EFFECT_THRESHOLD) return 0;

  const span = WASTE_PERIOD_AT_THRESHOLD - WASTE_PERIOD_AT_ZERO;
  const period =
    WASTE_PERIOD_AT_ZERO + divFloor(span * machine.condition, CONDITION_EFFECT_THRESHOLD);
  return period < 2 ? 2 : period;
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
