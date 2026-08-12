// The tech tree — versioned balance data, and a structural rule about what a node may do.
//
// THE ANTI-DOUBLE-DIP RULE IS STRUCTURAL HERE, NOT A CONVENTION (plan §3). A `TechNode` has
// a price, prerequisites, an optional milestone, and a list of *verbs* it makes legal. It
// has no numeric field of any kind — no speed multiplier, no capacity bonus, no yield
// scalar — because there is nowhere in this shape to put one. Numbers are scaled by
// per-machine upgrades (`upgrades.ts`) and only there. A future contributor who wants a
// "+20% fryer speed" node has to change this interface to do it, which is exactly the
// friction the rule is asking for.
//
// Gates are money-only, except the Charters, which add a *visible* demonstrated milestone
// (plan §7 ruling 3). There are no hidden behavioural counters: every milestone below reads
// a number the HUD already shows the player.
//
// Node ids are strings and they are written into saves. They are permanent.
//
// This module is a leaf: it imports nothing. That is what lets `data.ts` fold the tree into
// `BALANCE_HASH` without a cycle, and what keeps the tree testable without a world.

/**
 * Every researchable node. The string values are save surface and must never change; the
 * key names are for code and may.
 */
export const TechId = {
  /** Sugar cane — regrows, thirsty, and the first crop worth automating (plan §5). */
  Cane: 'agronomy-cane',
  /** Corn — dual use, oil now and corn syrup later. */
  Corn: 'agronomy-corn',
  /** Chili — regrows, and the seasoning line's other half. */
  Chili: 'agronomy-chili',
  /** The seed hopper: what makes a Grow Zone's auto-replant toggle legal. */
  AutoReplant: 'agronomy-seed-hopper',

  /** Washer and Slicer — the front half of the chip line. */
  WashAndSlice: 'fabrication-wash-and-slice',
  /** The Fryer. Flashiest machine in the game and deliberately the bottleneck. */
  Fryer: 'fabrication-fryer',
  /** Seasoner and Bagger — the back half. */
  Finishing: 'fabrication-finishing',

  /** Belts tier 1 and the Mk1 grabber. Things start moving without you. */
  Belts: 'logistics-belts',
  /** Belts tier 2 and the filtered Mk2 grabber. */
  BeltsFast: 'logistics-belts-fast',
  /** Belts tier 3 and the Long grabber. */
  BeltsExpress: 'logistics-belts-express',

  /** The upgrade bench: what makes `UpgradeMachine` legal at all. */
  UpgradeBench: 'commerce-upgrade-bench',

  // Hydraulics. Plan §3 names the branch and plan §5 names its grammar:
  // `RESERVOIR → (Pump) → pipes → [Tank] → machines`. The nodes follow that sentence.

  /** Pipes, the Pump, and the Tank — the plumbing itself, with nothing on the end of it. */
  Pumps: 'hydraulics-pumps',
  /** Piped sprinkler heads: the automated rung of plan §3's watering ladder. */
  PipedSprinklers: 'hydraulics-piped-sprinklers',
  /**
   * The Recirculator. Requires the Washer as well as the pumps — plan §3: "branches
   * interlock at fantasy-correct joints". You cannot reclaim graywater with no wash to
   * reclaim it from.
   */
  Recirculator: 'hydraulics-recirculator',
  /** The Irrigation Hub — moisture-sensing heads that water only dry tiles (plan §4). */
  IrrigationHub: 'hydraulics-irrigation-hub',

  /** Era gate 1 → 2 (plan §3). Money plus a visible milestone. */
  WorkshopCharter: 'charter-workshop',
  /** Era gate 2 → 3. */
  AssemblyCharter: 'charter-assembly',
} as const;

export type TechId = (typeof TechId)[keyof typeof TechId];

/** Which branch a node hangs off, for the panel's four columns (plan §3). */
export const TechBranch = {
  Agronomy: 1,
  Hydraulics: 2,
  Fabrication: 3,
  Commerce: 4,
  /** The spine. Charters are their own column. */
  Charter: 5,
} as const;

export type TechBranch = (typeof TechBranch)[keyof typeof TechBranch];

/**
 * The demonstrated half of a Charter gate. Always a counter the player can already see —
 * plan §7 ruling 3 forbids hidden behavioural gates outright.
 */
export const MilestoneKind = {
  None: 0,
  /** Items sold across the world's lifetime. */
  ItemsSold: 1,
  /** Machines placed that run a work cycle — the sell bin and sprinklers do not count. */
  WorkingMachines: 2,
  /** Items produced by machines, lifetime. */
  MachineOutput: 3,
} as const;

export type MilestoneKind = (typeof MilestoneKind)[keyof typeof MilestoneKind];

export interface TechNode {
  readonly id: TechId;
  readonly branch: TechBranch;
  /** Cents. Re-derived from plan §4's curve by the 15-Minute Rule; a two-way door. */
  readonly priceCents: number;
  /** Node ids that must already be unlocked. Order is fixed for readable panels. */
  readonly requires: readonly TechId[];
  readonly milestone: MilestoneKind;
  /** The count the milestone needs. Zero when there is no milestone. */
  readonly milestoneAmount: number;
}

/**
 * The tree, in panel order. Chips lead soda by half an era (plan §3) — the soda branch is
 * not here yet because the machines it would unlock are not built, and a node that unlocks
 * nothing is a node that lies.
 */
export const TECH_NODES: readonly TechNode[] = [
  {
    id: TechId.Cane,
    branch: TechBranch.Agronomy,
    priceCents: 2_500,
    requires: [],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.Corn,
    branch: TechBranch.Agronomy,
    priceCents: 3_000,
    requires: [],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.Chili,
    branch: TechBranch.Agronomy,
    priceCents: 4_000,
    requires: [TechId.Cane],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.WashAndSlice,
    branch: TechBranch.Fabrication,
    priceCents: 6_000,
    requires: [],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.Fryer,
    branch: TechBranch.Fabrication,
    priceCents: 12_000,
    requires: [TechId.WashAndSlice],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.Finishing,
    branch: TechBranch.Fabrication,
    priceCents: 20_000,
    requires: [TechId.Fryer],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    // Era 1 → 2. Plan §3: "Workshop Charter: ~$800 + 200 bags sold".
    id: TechId.WorkshopCharter,
    branch: TechBranch.Charter,
    priceCents: 80_000,
    requires: [TechId.Finishing],
    milestone: MilestoneKind.ItemsSold,
    milestoneAmount: 200,
  },
  {
    id: TechId.Belts,
    branch: TechBranch.Fabrication,
    priceCents: 25_000,
    requires: [TechId.WorkshopCharter],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.UpgradeBench,
    branch: TechBranch.Commerce,
    priceCents: 35_000,
    requires: [TechId.WorkshopCharter],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.AutoReplant,
    branch: TechBranch.Agronomy,
    priceCents: 120_000,
    requires: [TechId.WorkshopCharter],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    // The liquid layer opens after the Workshop Charter, at roughly the same rung as belts:
    // plan §8 puts fluids at v0.4, after the belt factory and before soda, and the whole soda
    // line will stand on this plumbing.
    id: TechId.Pumps,
    branch: TechBranch.Hydraulics,
    priceCents: 40_000,
    requires: [TechId.WorkshopCharter],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.PipedSprinklers,
    branch: TechBranch.Hydraulics,
    priceCents: 70_000,
    requires: [TechId.Pumps],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.Recirculator,
    branch: TechBranch.Hydraulics,
    priceCents: 90_000,
    requires: [TechId.Pumps, TechId.WashAndSlice],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.IrrigationHub,
    branch: TechBranch.Hydraulics,
    priceCents: 180_000,
    requires: [TechId.PipedSprinklers],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.BeltsFast,
    branch: TechBranch.Fabrication,
    priceCents: 90_000,
    requires: [TechId.Belts],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    // Era 2 → 3. Plan §3: "+ 5 machines running".
    id: TechId.AssemblyCharter,
    branch: TechBranch.Charter,
    priceCents: 600_000,
    requires: [TechId.Belts],
    milestone: MilestoneKind.WorkingMachines,
    milestoneAmount: 5,
  },
  {
    id: TechId.BeltsExpress,
    branch: TechBranch.Fabrication,
    priceCents: 250_000,
    requires: [TechId.BeltsFast, TechId.AssemblyCharter],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
];

export function techNode(id: string): TechNode | null {
  for (let i = 0; i < TECH_NODES.length; i++) {
    const node = TECH_NODES[i]!;
    if (node.id === id) return node;
  }
  return null;
}

/**
 * Membership test against the world's unlock list.
 *
 * The list is kept sorted so it hashes and serializes canonically, but this is a linear
 * scan on purpose: the tree is a dozen nodes, and a binary search over a dozen strings is
 * a bug surface bought with nothing.
 */
export function hasTech(unlocked: readonly string[], id: string): boolean {
  for (let i = 0; i < unlocked.length; i++) {
    if (unlocked[i] === id) return true;
  }
  return false;
}

/** A `null` requirement means "always legal" — the v0.1 machines and the starter crop. */
export function techSatisfied(unlocked: readonly string[], required: string | null): boolean {
  if (required === null) return true;
  return hasTech(unlocked, required);
}

/** Insert a node id, keeping the list sorted. Ignores a duplicate. */
export function insertUnlocked(unlocked: string[], id: string): boolean {
  for (let i = 0; i < unlocked.length; i++) {
    const current = unlocked[i]!;
    if (current === id) return false;
    if (current > id) {
      unlocked.splice(i, 0, id);
      return true;
    }
  }
  unlocked.push(id);
  return true;
}

/** Whether every prerequisite of a node is already unlocked. */
export function prerequisitesMet(unlocked: readonly string[], node: TechNode): boolean {
  for (let i = 0; i < node.requires.length; i++) {
    if (!hasTech(unlocked, node.requires[i]!)) return false;
  }
  return true;
}

/**
 * The demonstrated half of a Charter gate, against counters the caller reads off the world.
 *
 * Taking the counts as arguments rather than a `WorldState` is what keeps this module a
 * leaf, and it makes the gate trivially testable without building a world to satisfy it.
 */
export function milestoneMet(
  node: TechNode,
  itemsSold: number,
  workingMachines: number,
  machineOutput: number,
): boolean {
  switch (node.milestone) {
    case MilestoneKind.None:
      return true;
    case MilestoneKind.ItemsSold:
      return itemsSold >= node.milestoneAmount;
    case MilestoneKind.WorkingMachines:
      return workingMachines >= node.milestoneAmount;
    case MilestoneKind.MachineOutput:
      return machineOutput >= node.milestoneAmount;
    default:
      return false;
  }
}
