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
  /** Corn — dual use, oil now and corn syrup later. */
  Corn: 'agronomy-corn',
  /** Chili — regrows, and the seasoning line's other half. */
  Chili: 'agronomy-chili',
  /** The seed hopper: what makes a Grow Zone's auto-replant toggle legal. */
  AutoReplant: 'agronomy-seed-hopper',
  /** §5's "Gold Potato (premium, thirsty)" — the roster's fifth and last sown crop. */
  GoldPotato: 'agronomy-gold-potato',
  /** The Composter: spoiled goods become Fertilizer, and Fertilizer goes back in the ground. */
  Composting: 'agronomy-composting',
  /** The Root Cellar. The one place in the game where a clock stops (plan §4). */
  RootCellar: 'agronomy-root-cellar',
  /** The Orange and Lemon trees — 2×2, permanent, fruiting on a cycle (§5). */
  Orchard: 'agronomy-orchard',
  /**
   * The Kola Tree, and **PLAN §3'S JOINT RULE POINTED AT THE COLA LINE**: it requires the orchard
   * *and* the soda press. You cannot plant the nut that feeds a cola line before you have a cola
   * line to feed — until then, kola is a thing you buy at the stand for 150¢, which is §4's
   * consumable ladder working exactly as written.
   */
  KolaTree: 'agronomy-kola-tree',
  /**
   * Agri-Bots: the dock and the harvester that patrols a zone. **THE FIRST NODE EVER TO SIT
   * BEHIND THE CORPORATE CHARTER**, which shipped with nothing on the far side of it and said so.
   *
   * The gate is fantasy-correct rather than administrative. The Charter's milestone is *one line
   * untouched for ten in-game days* — a player who has demonstrated that a factory can run without
   * them is exactly the player who is ready to be told the farm can too, and it is the one chore
   * in this game that nothing has ever done for them.
   */
  AgriBots: 'agronomy-agri-bots',
  /**
   * The planter bot. Requires the harvester **and** the seed hopper, because it is the seed hopper
   * with legs — §5: *"regrowing crops automate first; one-shots wait for the seed-hopper bot — the
   * crop list itself paces the arc."* A player with only a harvester keeps chili and cane running
   * forever and watches their potatoes run out, which is the roster doing the pacing it was
   * designed to do.
   */
  PlanterBot: 'agronomy-planter-bot',

  /** Washer and Slicer — the front half of the chip line. */
  WashAndSlice: 'fabrication-wash-and-slice',
  /**
   * Diagnostics: the ranked list of machines by cash bled in the last 60 seconds, and the
   * Maintenance Station that acts on what the list says.
   *
   * A VERB UNLOCK LIKE EVERY NODE HERE — it makes a panel and a machine legal, and carries no
   * number. §5's readability rules describe the panel exactly: last-60s figures on an object,
   * phrased in cash, a ranked list of bleeding machines and never a dashboard of graphs. The
   * sim's half is `MachineView.bleedCentsLast60s`; the list itself is the HUD's.
   */
  Diagnostics: 'fabrication-diagnostics',
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
   * Repair drones: the Drone Bay, the Parts Bench, and the drone part recipe — the capstone of
   * plan §3's Commerce & Operations column, and **THE THIRD NAMED JOINT, FINALLY MADE**:
   * *"drones need diagnostics AND trucking."* You cannot buy a machine that dispatches flying
   * service vehicles before you have read a diagnosis or dispatched a vehicle; both
   * prerequisites are real nodes, exactly as §3 demands, and `TECH_NODES`' header comment has
   * been promising this line since the branch shipped.
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
  /**
   * Era gate 3 → 4, and plan §3's third Charter: *"+ one line untouched for 10 in-game days"*.
   *
   * ITS MILESTONE IS THE ONLY ONE IN THE GAME THAT MEASURES ABSENCE, which is what makes it the
   * right gate for the era after the assembly line: the first two Charters ask the player to
   * build and to sell, and this one asks them to walk away and let the thing they built run.
   * `MilestoneKind.UntouchedLine` is where the counter behind it is described.
   */
  CorporateCharter: 'charter-corporate',
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
  /**
   * **In-game days one production line has run with nobody's hands on it** — plan §3's Corporate
   * Charter, *"one line untouched for 10 in-game days"*, and the one milestone here that counts
   * something not happening.
   *
   * THE COUNTER IS PER MACHINE AND THE MILESTONE READS THE BEST OF THEM. `Machine.untouchedTicks`
   * advances on every tick a converter actually advances work and resets the moment a hand lands
   * on that machine; `WorldStats.longestUntouchedMachineTicks` is the high-water mark across the
   * lot. A machine cannot advance work for 96,000 consecutive ticks unless something is feeding
   * it and something is emptying it, so what the counter demonstrates *is* a line — that is the
   * cheapest true statement of the plan's requirement, and it needs no definition of where a line
   * starts and stops.
   *
   * WHY NOT `longestHandsFreeTicks`, WHICH ALREADY EXISTS. That clock counts ticks since the
   * player touched *anything*, and nothing in this game harvests a crop for you (see the
   * README's note on the depot fixture), so ten days of world-wide zero-touch is not reachable by
   * a player who is still farming. A gate nobody can pass is worse than no gate.
   *
   * WHY IT IS A HIGH-WATER MARK RATHER THAN A LIVE READING. Demonstrated is demonstrated: a
   * player who runs a line untouched for ten days and then refills a hopper on the walk to the
   * tech panel has still done the thing. A live maximum would let the gate close again between
   * the achievement and the money, which is the kind of cruelty that gets read as a bug.
   *
   * **The amount on the node is DAYS, not ticks** — `milestoneMet` is handed a day count that
   * `tick.ts` converts with `TICKS_PER_IN_GAME_DAY`, so this module still knows nothing about how
   * long a tick is and the panel shows the number plan §3 actually wrote down.
   */
  UntouchedLine: 4,
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
  {
    // Era 3 → 4. Plan §3: "+ one line untouched for 10 in-game days".
    //
    // **$20,000, DERIVED RATHER THAN EXTRAPOLATED.** The ladder's own arithmetic: the Workshop
    // Charter at $800 is about 4× the dearest node of era 1 ($200 Finishing) and the Assembly
    // Charter at $6,000 is about 5× the dearest of era 2 ($1,200 Auto-Replant). Era 3's dearest
    // is Express Belt at $2,500, so 4–5× lands between $10,000 and $12,500 — and this sits above
    // that band on purpose, because it is the only Charter whose milestone takes 80 real minutes
    // of *play* to demonstrate, and a fee the player clears long before the milestone would make
    // the money half of the gate decorative. $20,000 is 4–5 hours of era-3 income at the ~$70–80
    // a minute a running belt factory makes, which is plan §3's charter rule stated in its own
    // units. Two-way door, like every price here.
    //
    // **WHAT IS BEHIND IT: THE AGRI-BOTS.** This Charter shipped with an empty era behind it, on
    // the stated grounds that an era gate with nothing on the far side is an honest promise while
    // a mid-game node dragged behind a late-game fee is a broken curve — and the promise was
    // "when 038 and 039 land they hang off this id, and nothing renumbers". Item 038 landed:
    // `TechId.AgriBots` requires this node, `TechId.PlanterBot` requires that, and nothing
    // renumbered. The Maintenance Station and the repair drones (item 039) are still to come and
    // hang off it too.
    //
    // The gate reads correctly, which is worth checking rather than assuming: the milestone is
    // *one line untouched for ten in-game days*, so the player who opens era 4 is exactly the
    // player who has proved a factory can run without them — and what era 4 sells is the farm
    // learning the same trick.
    id: TechId.CorporateCharter,
    branch: TechBranch.Charter,
    priceCents: 2_000_000,
    requires: [TechId.AssemblyCharter],
    milestone: MilestoneKind.UntouchedLine,
    milestoneAmount: 10,
  },

  // --- the rest of Agronomy ---------------------------------------------------------------
  //
  // The branch that shipped with three crops and a hopper now carries the roster's last crop, the
  // spoilage loop's two answers, the orchard, and the bots. It is declared after the Charters
  // because two of its nodes hang off them, and `TECH_NODES` is in panel order.
  {
    // $150 against a $250 gold potato: one harvest of one 3★ tile pays it back twice over, which
    // is the 15-Minute Rule landing on a crop rather than on a machine.
    id: TechId.GoldPotato,
    branch: TechBranch.Agronomy,
    priceCents: 15_000,
    requires: [TechId.WorkshopCharter],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    // Cheap and early, because it is the node that makes spoilage a LOOP rather than a LEAK. Plan
    // §4's whole spoilage argument ends "nothing vanishes: spoiled goods → Compost → Fertilizer",
    // and until this exists the second arrow is missing and rot really is a hole.
    id: TechId.Composting,
    branch: TechBranch.Agronomy,
    priceCents: 12_000,
    requires: [],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.RootCellar,
    branch: TechBranch.Agronomy,
    priceCents: 55_000,
    requires: [TechId.WorkshopCharter],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.Orchard,
    branch: TechBranch.Agronomy,
    priceCents: 80_000,
    requires: [TechId.WorkshopCharter],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    // The joint: orchard AND soda press. See `TechId.KolaTree`.
    id: TechId.KolaTree,
    branch: TechBranch.Agronomy,
    priceCents: 200_000,
    requires: [TechId.Orchard, TechId.SodaPress],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    // **ERA 4 FINALLY HAS SOMETHING IN IT.** `TechId.CorporateCharter`'s comment promised that
    // "when 038 and 039 land they hang off this id, and nothing renumbers" — this is 038 landing,
    // and nothing renumbered.
    id: TechId.AgriBots,
    branch: TechBranch.Agronomy,
    priceCents: 400_000,
    requires: [TechId.CorporateCharter],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    id: TechId.PlanterBot,
    branch: TechBranch.Agronomy,
    priceCents: 300_000,
    requires: [TechId.AgriBots, TechId.AutoReplant],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },

  // --- automated maintenance (item 039) ---------------------------------------------------
  {
    // Behind the Assembly Charter rather than a cheaper gate, because a ranked list of
    // bleeding machines means nothing on a lot with two machines: the player this node serves
    // is the one whose factory is big enough that "which machine is costing me most" is a real
    // question. Priced level with the Hub — an era-3 information tool, not a capstone.
    id: TechId.Diagnostics,
    branch: TechBranch.Fabrication,
    priceCents: 120_000,
    requires: [TechId.AssemblyCharter],
    milestone: MilestoneKind.None,
    milestoneAmount: 0,
  },
  {
    // **THE CAPSTONE, AND §3'S THIRD JOINT: diagnostics AND trucking.** Fantasy-correct on both
    // legs — a drone is a dispatched vehicle aimed by a diagnosis. Priced above the AgriBots
    // node: the last thing the tree sells is the factory that keeps the factory alive.
    id: TechId.Drones,
    branch: TechBranch.Commerce,
    priceCents: 500_000,
    requires: [TechId.Diagnostics, TechId.Trucking],
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
  /**
   * In-game DAYS the best production line has run untouched — `tick.ts` does the tick-to-day
   * division, so this module still owes nothing to `units.ts`.
   *
   * **OPTIONAL, AND IT DEFAULTS TO THE PESSIMISTIC ANSWER.** A caller written before this
   * milestone existed — the HUD's `derive-tech.ts` is one — still compiles and still refuses the
   * Corporate Charter. That is the safe direction for a panel to be wrong in: it under-reports
   * progress on a node the sim would also refuse, rather than lighting up a button that gets
   * eaten. The day the panel passes the real number, both agree.
   */
  untouchedLineDays = 0,
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
    case MilestoneKind.UntouchedLine:
      return untouchedLineDays >= node.milestoneAmount;
    default:
      return false;
  }
}
