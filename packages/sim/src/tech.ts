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
// **THE IDS ARE STRINGS AND THEY ARE STAYING STRINGS.** Item 036 asks for "integers in a sorted
// array"; a previous agent shipped sorted strings instead, and re-reading that call: it is right,
// and it is not a matter of taste. `WorldState.unlocked` is sorted and hashed, which is what the
// criterion is actually protecting — two worlds that bought the same nodes in a different order
// are the same world and must agree. What the string buys on top of that is that a raw save and a
// raw trace say `charter-assembly` rather than `17`, and that a node's identity cannot be
// silently changed by reordering a table, which is exactly the failure "node ids are permanent"
// exists to prevent. Renumbering the tree to integers now would rewrite every shipped save's
// unlock list to buy nothing. It is not being changed.
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
  // `'agronomy-corn'`, `'agronomy-chili'` and `'agronomy-gold-potato'` were the roster's other
  // three sown crops, and all three are gone (items 145/147, owner cut list 2026-08-27) along
  // with the crops themselves and the whole flavour tier they fed. **THE STRINGS ARE NOT
  // REUSED**: each can be sitting in a saved `unlocked` list, and the 23 → 24 migration takes
  // them out and refunds what they cost.
  // `'agronomy-seed-hopper'` was the AutoReplant node — the zone toggle it made legal is gone
  // with it (item 146): planter bots are now the only automatic planting, re-priced and
  // re-parented below to take its Era-2 seat. Refunded by the 23 → 24 migration.
  // `'agronomy-composting'` was the Composter node — spoiled goods became Fertilizer, and
  // Fertilizer went back in the ground. All three of those are gone (item 124). **THE STRING IS
  // NOT REUSED**: it can be sitting in a saved `unlocked` list, and the 21 → 22 migration takes
  // it out and refunds what it cost.
  // `'agronomy-root-cellar'` bought the Root Cellar, whose freeze died with spoilage (item 124)
  // and whose bulk-storage second act is now cut too (item 145). Refunded by 23 → 24.
  // `'agronomy-orchard'` bought the Orange and Lemon trees. Both trees are cut (item 145); the
  // Kola Tree survives and re-parents onto the soda press below. Refunded by 23 → 24.
  /**
   * The Kola Tree, and **PLAN §3'S JOINT RULE POINTED AT THE COLA LINE**: it requires the soda
   * press. You cannot plant the nut that feeds a cola line before you have a cola line to feed —
   * until then, kola is a thing you buy at the stand for 150¢, which is §4's consumable ladder
   * working exactly as written. (It used to require `agronomy-orchard` as well; that node was
   * cut with its two trees in item 145, and this is now the only tree in the game.)
   */
  KolaTree: 'agronomy-kola-tree',
  /**
   * Agri-Bots: the dock and the harvester that patrols a zone.
   *
   * **RE-PARENTED ONTO THE WORKSHOP CHARTER AND RE-PRICED** (item 146): with auto-replant
   * retired, the bot pair is the game's only automatic planting, so it takes the Era-2 seat the
   * seed hopper held — arriving earlier and cheaper, while still sitting behind a demonstrated
   * Charter and real money. (It used to be the first node behind the Corporate Charter; that
   * Charter is gone too — item 147.)
   */
  AgriBots: 'agronomy-agri-bots',
  /**
   * The planter bot. Requires the harvester — it is the dock family's second half, and §5's
   * *"one-shots wait for the seed-hopper bot"* now means this bot alone: the zone seed hopper
   * it used to also require was retired in item 146.
   */
  PlanterBot: 'agronomy-planter-bot',

  /** Washer and Slicer — the front half of the chip line. */
  WashAndSlice: 'fabrication-wash-and-slice',
  // `'fabrication-diagnostics'` bought the ranked bleed list and the Maintenance Station, and
  // both are cut (item 145): drones are the only automated repair. **THE STRING IS NOT
  // REUSED**; the 23 → 24 migration refunds it.
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
  /**
   * The belt junction: plan §3's *"splitters"*, and plan §5's *"splitters, mergers"*, in one
   * device. It divides a line and it joins one, and which of those it is doing is decided by the
   * belts the player runs into it — see `MachineKind.BeltJunction`.
   *
   * Behind `Belts` rather than beside it. A junction with one belt is a floor tile; the node only
   * means anything to a player who has already run a line and found out that one line is not
   * enough, which is the same reason the Fryer sits behind the Washer rather than next to it.
   */
  Splitters: 'logistics-splitters',

  /** The upgrade bench: what makes `UpgradeMachine` legal at all. */
  UpgradeBench: 'commerce-upgrade-bench',
  /**
   * Trucking: the Truck Depot, and with it standing contracts.
   *
   * THE AUTOMATED RUNG OF PLAN §3'S SELLING LADDER, and the node item 039's repair drones are
   * waiting on — §3's joints rule says *"drones need diagnostics **and** trucking"*, so a
   * capstone that dispatches vehicles cannot be reached by a player who has never dispatched
   * one. The delivery cart is deliberately NOT behind this: the assisted rung needs no research,
   * exactly as the $150 barrel sprinkler needs none on the watering ladder.
   *
   * It unlocks a verb and carries no number, like every node here. How far a truck drives is
   * `RUN_TICKS_PER_TILE_FROM_ROAD` in `data.ts` and how much it carries is the route the player
   * writes — neither is a thing research touches.
   */
  Trucking: 'commerce-trucking',
  /**
   * Repair drones: the Drone Bay and its free-forever service ([[090]] retired the Parts Bench
   * and the drone part recipe that used to hang off this node) — the capstone of
   * plan §3's Commerce & Operations column. **RE-PARENTED** (item 145): the diagnostics half of
   * §3's "drones need diagnostics AND trucking" joint was cut with the Maintenance Station, so
   * the node keeps its trucking leg and takes the Assembly Charter in diagnostics' place —
   * preserving its Era-3 seat, and keeping "you dispatch vehicles before you buy flying ones"
   * true. Drones are now the only automated repair in the game.
   */
  Drones: 'commerce-repair-drones',

  // The soda wing (plan §8's v0.5). It hangs off HYDRAULICS rather than fabrication, and that
  // is the interlock plan §3 asks for: soda is a pipe organ, so a player who never laid a pipe
  // cannot buy their way into one. Chips lead soda by half an era because the chip line needs
  // no plumbing at all and this needs all of it.

  /** The press, the kettle, and the grinder — cane and kola into juice, syrup, and powder. */
  SodaPress: 'hydraulics-soda-press',
  /** The Syrup Mixer, the Carbonator, and the Bottler: the half that finishes a bottle. */
  SodaMixing: 'hydraulics-soda-mixing',
  /**
   * Six-packs and the Snack Combo. Requires BOTH lines finished — the Combo is chips plus soda,
   * so a node that unlocked it without the Bagger would unlock a recipe nobody could cook.
   */
  Bundles: 'commerce-bundles',

  // Hydraulics. Plan §3 names the branch and plan §5 names its grammar:
  // `RESERVOIR → (Pump) → pipes → [Tank] → machines`. The nodes follow that sentence.

  /** Pipes, the Pump, and the Tank — the plumbing itself, with nothing on the end of it. */
  Pumps: 'hydraulics-pumps',
  /** Piped sprinkler heads: the automated rung of plan §3's watering ladder. */
  PipedSprinklers: 'hydraulics-piped-sprinklers',
  // `'hydraulics-recirculator'` bought the Recirculator, which is cut (item 145) with its
  // graywater loop. **THE STRING IS NOT REUSED**; the 23 → 24 migration refunds it.
  /** The Irrigation Hub — moisture-sensing heads that water only dry tiles (plan §4). */
  IrrigationHub: 'hydraulics-irrigation-hub',
  // 'hydraulics-artesian-well' was `ArtesianWell` and is spent (item 140). It bought the only
  // machine that made a pond bigger; the pond is now unlimited, so the node buys nothing. The
  // 22 → 23 migration refunds it to anyone who had researched it.

  /** Era gate 1 → 2 (plan §3). Money plus a visible milestone. */
  WorkshopCharter: 'charter-workshop',
  /** Era gate 2 → 3, and now the last gate: the tree has three eras (item 147). */
  AssemblyCharter: 'charter-assembly',
  // `'charter-corporate'` was Era gate 3 → 4 — $20,000 plus the ten-untouched-days milestone,
  // the only milestone that measured absence. Era 4 folded into Era 3 (item 147, owner: "The
  // Era 4 should be combined with Era 3"), its two nodes re-parented into earlier eras, and the
  // `MilestoneKind.UntouchedLine` counter chain left with it. **THE STRING IS NOT REUSED**; the
  // 23 → 24 migration refunds an owned Charter at its full $20,000.
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
  // 4 was `UntouchedLine` — in-game days one production line ran with nobody's hands on it, the
  // Corporate Charter's demonstrated half and the only milestone that counted absence. The
  // Charter is gone (item 147) and it was this kind's sole consumer, so the whole counter chain
  // went with it: `Machine.untouchedTicks`, `WorldStats.longestUntouchedMachineTicks`, and the
  // day conversion in `tick.ts`. The number stays burned — it is in the balance digest of every
  // pre-24 save.
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
 * The tree, in panel order. Four branches and three Charters, and every node here unlocks
 * something that exists — chips lead soda by half an era (plan §3), and Hydraulics, which was
 * once declared and empty, now carries the plumbing and the whole soda wing.
 *
 * **ALL THREE OF PLAN §3'S NAMED JOINTS ARE NOW REAL**: sprinklers need pipes, bottling needs
 * fluids and belts, and — as of item 039 — drones need diagnostics *and* trucking. The joint
 * was made in the same commit as the machines it gates, exactly as this comment used to
 * promise it would be.
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
    // $400: a *cheap* era-2 node by the 15-Minute Rule, which puts era-2 income at roughly
    // $20–25 a minute (that is what the Assembly Charter's $6,000 means at plan §3's "charters ≈
    // 4–5 h"). Priced level with Pumps rather than with Fast Belt, because it is the same rung —
    // the second thing you buy once things are moving, not the thing you save up for.
    id: TechId.Splitters,
    branch: TechBranch.Fabrication,
    priceCents: 40_000,
    requires: [TechId.Belts],
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
    // Priced between the upgrade bench and the auto-replant hopper, and gated on the Charter for
    // one reason: the Charter's visible half is **200 items sold**, so a player cannot buy their
    // way out of selling by hand until they have demonstrably done it two hundred times. That is
    // plan §3's interlock rule pointed at the ladder it belongs to — you automate the chore you
    // have actually done, and the milestone was already on screen.
    id: TechId.Trucking,
    branch: TechBranch.Commerce,
    priceCents: 60_000,
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
    // Priced above the piped sprinklers and below the Hub: the soda wing is the second thing a
    // player does with plumbing, not the first, and the pipes have to have paid for themselves
    // watering a field before they are asked to carry syrup.
    id: TechId.SodaPress,
    branch: TechBranch.Hydraulics,
    priceCents: 120_000,
    requires: [TechId.Pumps, TechId.Cane],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    // **PLAN §3'S SECOND NAMED JOINT: "bottling needs fluids *and* belts".** The fluids half was
    // always here (`SodaPress`, and the pumps under it); the belts half is this line, added the
    // day belts and the bottling line both existed to be joined.
    //
    // It is fantasy-correct rather than administrative: a Bottler is the one machine in the game
    // with two pipe inlets AND a solid inlet — it drinks syrup and carbonated water and it eats a
    // bottle — so a player who has never run a belt has no way to feed the third one. Requiring
    // the node they would have had to buy anyway costs a finished line nothing and stops the
    // half-plumbed dead end where a Bottler stands full of syrup waiting for bottles by hand.
    //
    // Prerequisites are checked at PURCHASE, so a world that already owns this node keeps it.
    id: TechId.SodaMixing,
    branch: TechBranch.Hydraulics,
    priceCents: 220_000,
    requires: [TechId.SodaPress, TechId.Belts],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    // Both lines, or neither. The Combo is the answer to §8's "does one line dominate into
    // decoration?" gate, so it deliberately cannot be reached from one district alone.
    id: TechId.Bundles,
    branch: TechBranch.Commerce,
    priceCents: 150_000,
    requires: [TechId.SodaMixing, TechId.Finishing],
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
  // `charter-corporate` (Era 3 → 4, $20,000, the ten-untouched-days milestone) stood here until
  // item 147 folded Era 4 into Era 3. Its two dependants re-parented into earlier eras (see
  // `TechId.AgriBots`), so no node lists it and the tree tops out at the Assembly Charter.

  // --- the rest of Agronomy ---------------------------------------------------------------
  //
  // The branch that shipped with three crops and a hopper now carries the Kola Tree and the
  // bots — items 145/146 cut the other crops, the orchard pair, the hopper and the cellar. It
  // is declared after the Charters because its nodes hang off them, and `TECH_NODES` is in
  // panel order.
  {
    // The joint: the soda press. See `TechId.KolaTree` — the orchard half of the old joint was
    // cut with its trees (item 145).
    id: TechId.KolaTree,
    branch: TechBranch.Agronomy,
    priceCents: 200_000,
    requires: [TechId.SodaPress],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    // Item 146's re-parent and re-price: the Era-2 seat auto-replant held, at bot prices.
    id: TechId.AgriBots,
    branch: TechBranch.Agronomy,
    priceCents: 150_000,
    requires: [TechId.WorkshopCharter],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.PlanterBot,
    branch: TechBranch.Agronomy,
    priceCents: 100_000,
    requires: [TechId.AgriBots],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },

  // --- automated maintenance (item 039, halved by item 145) -------------------------------
  //
  // `fabrication-diagnostics` and the Maintenance Station it bought stood here until item 145;
  // the drone capstone below is now the whole of the automated-maintenance story.
  {
    // **THE CAPSTONE.** A drone is a dispatched vehicle, so the trucking leg of §3's joint
    // survives; the diagnostics leg was cut with its node, and the Assembly Charter holds the
    // node's Era-3 seat in its place (item 145's ruling). Priced above the AgriBots node: the
    // last thing the tree sells is the factory that keeps the factory alive.
    id: TechId.Drones,
    branch: TechBranch.Commerce,
    priceCents: 500_000,
    requires: [TechId.Trucking, TechId.AssemblyCharter],
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
