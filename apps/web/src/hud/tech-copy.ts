// The words. Every node's promise, every dial's trade-off, written once and read nowhere else.
//
// THE RULE THIS FILE EXISTS TO ENFORCE (plan §3, and §1 states it as a pillar): **a tech node
// unlocks a verb, never a percentage.** `TechNode` in the sim already makes that structural —
// there is no numeric field to put a bonus in — but structure only stops a node from *having*
// a number. It cannot stop the panel from *reading* like a stat sheet. So every `verb` below
// begins with something the player will do with their hands, in the imperative, and every
// `detail` says what changes on the lot rather than what changes in a table.
//
// The mirror rule lives at the bottom: the three dials are the only place in the game where a
// number gets scaled, so their copy is allowed — required, really — to name the trade. Speed
// costs wear. Efficiency costs money. Capacity costs nothing, and saying so plainly is the
// point of it (plan §1's generosity pillar: it is the purchase a confused player can make
// without hurting themselves).
//
// Copy is keyed by the sim's permanent string ids. A node with no entry here still renders —
// it falls back to its id — because a missing sentence should look like missing copy, not
// like a broken panel.

import { MachineKind, MilestoneKind, TechBranch, TechId, UpgradeDial } from '@snack/sim';

export interface NodeCopy {
  /** What it is called on the card face. Title case, two or three words. */
  readonly title: string;
  /** The promise, in the imperative and under about six words. This is the card's subtitle. */
  readonly verb: string;
  /** One sentence for the detail pane. States a consequence on the lot, never a percentage. */
  readonly detail: string;
}

/**
 * Node copy, in the sim's declaration order.
 *
 * Read the `verb` column top to bottom and it should sound like a list of things a person
 * does, because that is the acceptance test for this file: "Plant sugar cane", "Lay belt and
 * set arms", "Spend money at a machine". If one of them ever reads "Increase throughput", the
 * anti-double-dip rule has sprung a leak on the presentation side.
 */
export const TECH_COPY: Readonly<Record<string, NodeCopy>> = {
  [TechId.Cane]: {
    title: 'Sugar Cane',
    verb: 'Plant sugar cane',
    detail:
      'Cane regrows from the cut stalk instead of dying, so a row planted once keeps paying without being sown again.',
  },
  [TechId.Corn]: {
    title: 'Corn',
    verb: 'Plant corn',
    detail:
      'Corn is the dual-use crop: frying oil today, and the syrup half of every bottle once the soda line exists.',
  },
  [TechId.Chili]: {
    title: 'Chili',
    verb: 'Plant chili',
    detail:
      'Regrows like cane, and it is the half of seasoning you cannot buy in. Salt alone has never sold a bag.',
  },
  [TechId.AutoReplant]: {
    title: 'Seed Hopper',
    verb: 'Arm a zone to replant itself',
    detail:
      'A Grow Zone with the hopper armed sows a tile the moment it is cleared. The field stops waiting for you to walk back.',
  },

  [TechId.WashAndSlice]: {
    title: 'Wash & Slice',
    verb: 'Build the Washer and the Slicer',
    detail:
      'The front half of a real chip line. Two machines that do the two jobs the Chip Kitchen was doing badly at once.',
  },
  [TechId.Fryer]: {
    title: 'The Fryer',
    verb: 'Build the Fryer',
    detail:
      'The loudest machine on the lot, and deliberately the slowest — everything you build after this is an argument with it.',
  },
  [TechId.Finishing]: {
    title: 'Finishing',
    verb: 'Build the Seasoner and Bagger',
    detail:
      'The back half of the line. Chips come out of it in bags, sealed, and you never touch one again.',
  },

  [TechId.Belts]: {
    title: 'Belts & Arms',
    verb: 'Lay belt and set grabber arms',
    detail:
      'Things start moving without you. This is the node the whole first era is walking toward — after it, the lot runs while you are looking somewhere else.',
  },
  [TechId.BeltsFast]: {
    title: 'Fast Belt & Mk2 Arm',
    verb: 'Lay Fast Belt, place filtered arms',
    detail:
      'Belt that keeps up with a fed Fryer, and an arm that picks up only what you tell it to — so one line can carry two products.',
  },
  [TechId.BeltsExpress]: {
    title: 'Express Belt & Long Arm',
    verb: 'Lay Express Belt, reach two tiles',
    detail:
      'The arm that reaches across a belt to the machine behind it. Layouts stop being a row and start being a floor plan.',
  },

  [TechId.Pumps]: {
    title: 'Pumps & Pipes',
    verb: 'Run pipe from the reservoir',
    detail:
      'The plumbing itself — reservoir, pump, pipe, tank — with nothing on the end of it yet. Water stops being something you carry.',
  },
  [TechId.PipedSprinklers]: {
    title: 'Piped Sprinklers',
    verb: 'Plumb a sprinkler into the mains',
    detail:
      'A sprinkler head fed by pipe instead of by barrel. It never runs dry, and you never walk out to refill it again.',
  },
  [TechId.Recirculator]: {
    title: 'Recirculator',
    verb: 'Reclaim the wash water',
    detail:
      'Catches what the Washer throws away and sends it back up the pipe. Needs the Washer as much as it needs the pumps — there is no graywater without a wash.',
  },
  [TechId.IrrigationHub]: {
    title: 'Irrigation Hub',
    verb: 'Water only the tiles that are dry',
    detail:
      'Moisture-sensing heads that skip a wet tile instead of drowning it. The field stops costing you water it did not need.',
  },

  [TechId.UpgradeBench]: {
    title: 'Upgrade Bench',
    verb: 'Spend money at a machine',
    detail:
      'Walk up to any machine and buy its dials: Speed, Efficiency, Capacity. Three levels each, bought where the machine stands.',
  },

  [TechId.WorkshopCharter]: {
    title: 'Workshop Charter',
    verb: 'Open the Workshop era',
    detail:
      'The lot stops being a roadside patch. Belts, the upgrade bench, and the seed hopper all sit on the far side of this signature.',
  },
  [TechId.AssemblyCharter]: {
    title: 'Assembly Charter',
    verb: 'Open the Assembly Line era',
    detail:
      'The paperwork that turns a workshop into a factory floor. Express belt and the long arm are behind it.',
  },
};

export function nodeCopy(id: string): NodeCopy {
  return TECH_COPY[id] ?? { title: id, verb: '', detail: '' };
}

// --- branches and eras ---------------------------------------------------------------

export interface BranchCopy {
  readonly name: string;
  /** One line under the column heading, so an empty branch still explains itself. */
  readonly blurb: string;
}

export const BRANCH_COPY: Readonly<Record<number, BranchCopy>> = {
  [TechBranch.Agronomy]: {
    name: 'Agronomy',
    blurb: 'What grows, and what tends it',
  },
  [TechBranch.Hydraulics]: {
    name: 'Hydraulics',
    blurb: 'Pumps, pipes, and carbonation',
  },
  [TechBranch.Fabrication]: {
    name: 'Fabrication & Logistics',
    blurb: 'Machines, and what carries between them',
  },
  [TechBranch.Commerce]: {
    name: 'Commerce & Operations',
    blurb: 'Selling it, and keeping it running',
  },
  [TechBranch.Charter]: {
    name: 'Charters',
    blurb: 'The era gates',
  },
};

/**
 * The four columns, in reading order. Hydraulics is here and empty on purpose: the branch is
 * declared in the sim with nothing hanging off it because the machines it would unlock are not
 * built yet, and the panel says so out loud rather than hiding a quarter of the tree. A player
 * who can see the empty column knows the game is not finished with them.
 */
export const BRANCH_ORDER: readonly number[] = [
  TechBranch.Agronomy,
  TechBranch.Hydraulics,
  TechBranch.Fabrication,
  TechBranch.Commerce,
];

export interface EraCopy {
  readonly numeral: string;
  readonly name: string;
  readonly blurb: string;
}

/** Plan §3's era table, verbatim in spirit: the Spud Shack, the Workshop, the Assembly Line. */
export const ERA_COPY: readonly EraCopy[] = [
  { numeral: 'I', name: 'The Spud Shack', blurb: 'You, a can, and dirt' },
  { numeral: 'II', name: 'The Workshop', blurb: 'Machines, and things that move on their own' },
  { numeral: 'III', name: 'The Assembly Line', blurb: 'A floor that runs without you' },
];

export function eraCopy(era: number): EraCopy {
  return ERA_COPY[era - 1] ?? { numeral: String(era), name: 'Later', blurb: '' };
}

// --- milestones -----------------------------------------------------------------------

/**
 * The demonstrated half of a Charter, in words.
 *
 * Plan §7 ruling 3 forbids hidden behavioural gates, and this is the sentence that keeps that
 * promise on screen: every Charter shows what it wants and how far along you are, from the
 * first time the panel is opened, whether or not the money is anywhere close.
 */
export function milestoneLabel(kind: number, amount: number): string {
  switch (kind) {
    case MilestoneKind.ItemsSold:
      return `${amount} things sold`;
    case MilestoneKind.WorkingMachines:
      return `${amount} machines running a work cycle`;
    case MilestoneKind.MachineOutput:
      return `${amount} items made by machine`;
    default:
      return '';
  }
}

/** What the counter is counting, for the progress line. Lower case, no number. */
export function milestoneNoun(kind: number): string {
  switch (kind) {
    case MilestoneKind.ItemsSold:
      return 'sold';
    case MilestoneKind.WorkingMachines:
      return 'running';
    case MilestoneKind.MachineOutput:
      return 'made';
    default:
      return '';
  }
}

// --- machines and their dials ---------------------------------------------------------

/**
 * Display names for the machines the bench can be opened at.
 *
 * The sim carries a `slug` for the atlas and for save debugging, not a display string —
 * capitalisation and article choice are presentation, and presentation does not belong in a
 * deterministic core (same reason `format.ts` owns the dollar sign).
 */
export const MACHINE_LABELS: Readonly<Record<number, string>> = {
  [MachineKind.SellBin]: 'Sell Bin',
  [MachineKind.ChipKitchen]: 'Chip Kitchen',
  [MachineKind.Sprinkler]: 'Sprinkler',
  [MachineKind.Washer]: 'Washer',
  [MachineKind.Slicer]: 'Slicer',
  [MachineKind.Fryer]: 'Fryer',
  [MachineKind.Seasoner]: 'Seasoner',
  [MachineKind.Bagger]: 'Bagger',
  [MachineKind.Pump]: 'Pump',
  [MachineKind.Tank]: 'Tank',
  [MachineKind.PipedSprinkler]: 'Piped Sprinkler',
  [MachineKind.IrrigationHub]: 'Irrigation Hub',
  [MachineKind.Recirculator]: 'Recirculator',
};

export function machineLabel(kind: number): string {
  return MACHINE_LABELS[kind] ?? 'Machine';
}

export interface DialCopy {
  readonly name: string;
  /** The trade, stated as a trade. This is the sentence that makes the panel a decision. */
  readonly trade: string;
  /** What the next level physically changes. Present tense, one clause. */
  readonly effect: string;
}

/**
 * Plan §3's three dials, and note which one gets the shortest sentence.
 *
 * Capacity has no catch — the plan says so twice, and the copy must not invent one to make the
 * panel look balanced. A player who reads three dials and finds that one of them is simply
 * good has learned something true about this game.
 */
export const DIAL_COPY: Readonly<Record<number, DialCopy>> = {
  [UpgradeDial.Speed]: {
    name: 'Speed',
    trade: 'Faster, and it wears out sooner. That is the whole trade — there is no hidden one.',
    effect: 'more work per tick, more wear per operation',
  },
  [UpgradeDial.Efficiency]: {
    name: 'Efficiency',
    trade: 'Gentler on itself, and the expensive track. You are buying time between repairs.',
    effect: 'less condition lost every operation',
  },
  [UpgradeDial.Capacity]: {
    name: 'Capacity',
    trade: 'No catch. Twice the buffer, nothing given up — this is the jam-smoother.',
    effect: 'twice the room in and out, so a stall upstream stops mattering',
  },
};

export function dialCopy(dial: number): DialCopy {
  return DIAL_COPY[dial] ?? { name: 'Dial', trade: '', effect: '' };
}
