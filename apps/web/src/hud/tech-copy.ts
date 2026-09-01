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

import {
  GrabberTier,
  MachineKind,
  MilestoneKind,
  TechBranch,
  TechId,
  UpgradeDial,
} from '@snack/sim';

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
  // Corn, Chili, Auto-Replant, Gold Potato, the Root Cellar and the Orchard all had copy here
  // and all six nodes are cut (items 145/146/147, owner cut list 2026-08-27) — the crops with
  // their flavour tier, the hopper toggle in favour of the planter bot, the cellar and the two
  // fruit trees outright. The slugs are burned in the sim, so a stale block here would never
  // render; it is deleted rather than left to read like a promise.
  [TechId.KolaTree]: {
    title: 'Kola Tree',
    verb: 'Plant the kola tree',
    detail:
      'The nut the cola line runs on, growing on your own land instead of arriving on a delivery. Planting the first one is the day soda stops being someone else’s ingredient.',
  },
  [TechId.AgriBots]: {
    title: 'Agri-Bots',
    verb: 'Send a robot to pull the crop',
    detail:
      'A dock at the edge of a Grow Zone, and Spudnik patrolling it. Nothing in this game has ever harvested for you before.',
  },
  [TechId.PlanterBot]: {
    title: 'Planter Bot',
    verb: 'Send a robot to sow the row',
    detail:
      'The sowing half of the dock family, and the only automatic planting there is. Cane regrows on its own — potatoes are the crop that has been waiting for this.',
  },

  [TechId.WashAndSlice]: {
    title: 'Wash & Slice',
    verb: 'Build the Washer and the Slicer',
    detail:
      'The front half of a real chip line: one machine washes, the next one slices, and each does its one job properly.',
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

  [TechId.Splitters]: {
    title: 'Belt Junction',
    verb: 'Split a line, or join two',
    detail:
      'One fitting that does both: run two belts out of it and it deals to them in turn, run two in and it takes from each in turn. Which one it is depends on the belts you put around it.',
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
  // The Recirculator's block sat here; the node and its graywater loop are cut (item 145).
  [TechId.IrrigationHub]: {
    title: 'Irrigation Hub',
    verb: 'Water only the tiles that are dry',
    detail:
      'Moisture-sensing heads that skip a wet tile instead of drowning it. The field stops costing you water it did not need.',
  },

  [TechId.SodaPress]: {
    title: 'Press & Kettle',
    verb: 'Press cane, boil it down, grind kola',
    detail:
      'The front half of the soda line. Cane goes in as a stalk and comes out as syrup, and none of it touches a belt — this half runs on pipe.',
  },
  [TechId.SodaMixing]: {
    title: 'Mixing & Bottling',
    verb: 'Mix syrup, carbonate, and bottle it',
    detail:
      'The half that finishes a bottle. It wants pipe for the liquids and belt for the bottles, which is why it asks for both before it will sell you either.',
  },

  [TechId.UpgradeBench]: {
    title: 'Upgrade Bench',
    verb: 'Spend money at a machine',
    detail:
      'Walk up to any machine and buy its dials: Speed, Efficiency, Capacity. Three levels each, bought where the machine stands.',
  },

  [TechId.Trucking]: {
    title: 'Truck Depot',
    verb: 'Sign a route and stop carrying it',
    detail:
      'A depot takes goods off a belt and ships them under a standing contract while you are three screens away. The cart still needs your hands; this does not.',
  },
  [TechId.Bundles]: {
    title: 'Bundles',
    verb: 'Pack six-packs and Snack Combos',
    detail:
      'A bag and a bottle sold together fetch more than the two sold apart, so running both districts beats running either one twice. It needs a finished line on each side.',
  },

  // Diagnostics' block sat here; the node, its bleed list and the Maintenance Station are cut
  // (item 145). Drones below are the only automated repair now.
  [TechId.Drones]: {
    title: 'Repair Drones',
    verb: 'Let the bay fix the lot',
    detail:
      'A drone that flies to any machine on the lot and services it — no parts, no belt, no hopper. Buy the bay once and the wrench is somebody else\u2019s problem forever.',
  },

  [TechId.WorkshopCharter]: {
    title: 'Workshop Charter',
    verb: 'Open the Workshop era',
    detail:
      'The lot stops being a roadside patch. Belts, the upgrade bench, and the plumbing all sit on the far side of this signature.',
  },
  [TechId.AssemblyCharter]: {
    title: 'Assembly Charter',
    verb: 'Open the Assembly Line era',
    detail:
      'The paperwork that turns a workshop into a factory floor. Express belt and the long arm are behind it.',
  },
  // The Corporate Charter's block sat here. The Charter is retired (item 147, owner: "The Era 4
  // should be combined with Era 3") \u2014 the tree ends at the Assembly Line now, and the
  // ten-untouched-days milestone it carried went with it.
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
 * The four columns, in reading order.
 *
 * Hydraulics used to be here and empty — declared in the sim with nothing hanging off it,
 * because a node that unlocks nothing is a node that lies. It is now the fullest column in the
 * tree: the plumbing, the piped heads, the Hub, and the whole soda wing. The empty-branch
 * message survives anyway, derived from the card list rather than hard-coded against a branch
 * id, because the next branch to be born empty will not be this one.
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

/**
 * Plan §3's era table, verbatim in spirit: the Spud Shack, the Workshop, the Assembly Line.
 *
 * Row IV — The Corporation — is gone with its Charter (item 147). The table is not what says
 * how many bands the panel draws (`MAX_ERA` derives that from the tree); it only names them,
 * and a fourth name here would be an era the game can no longer reach.
 */
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
    // `UntouchedLine` had a case here — the only milestone that measured absence — and it is
    // gone with the Corporate Charter that was its one bearer (item 147).
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
  // The Chip Kitchen's row led this table for the whole life of the HUD; the machine is cut
  // (item 145) and its boxed item with it, so there is no crate left for the row to name. The
  // Recirculator, Root Cellar and Maintenance Station rows are gone by the same cut — unlike
  // the retired Parts Bench below, whose BOX survives in old saves, these four machines were
  // migrated out of every save entirely, boxes included.
  [MachineKind.SellBin]: 'Sell Bin',
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
  // The soda line. Named here for the same reason as the rest, and needed by more than the
  // bench now: a boxed machine in the bag is named by its machine ([[054]], `item-copy.ts`), so
  // a kind missing from this table would read "Machine" on a row the player is about to scrap.
  [MachineKind.Juicer]: 'Juicer',
  [MachineKind.Kettle]: 'Kettle',
  [MachineKind.Grinder]: 'Grinder',
  [MachineKind.SyrupMixer]: 'Syrup Mixer',
  [MachineKind.Carbonator]: 'Carbonator',
  [MachineKind.Bottler]: 'Bottler',
  [MachineKind.SixPacker]: 'Six-Packer',
  [MachineKind.ComboPacker]: 'Combo Packer',
  // The two vehicles and the belt fitting. Missing rows are not cosmetic here: a boxed machine
  // in the bag is named by its machine, so a kind absent from this table reads "Machine" on the
  // row the player is about to scrap for 40%.
  [MachineKind.DeliveryCart]: 'Delivery Cart',
  [MachineKind.TruckDepot]: 'Truck Depot',
  [MachineKind.BeltJunction]: 'Belt Junction',
  // The Agri-Bots ([[038]]). Kinds that shipped without a row here, which is not cosmetic for
  // exactly the reason stated twice above: a boxed machine in the bag is named by its machine.
  // The dock card names its subject from this table too.
  [MachineKind.HarvesterDock]: 'Harvester Dock',
  [MachineKind.PlanterDock]: 'Planter Dock',
  // The Drone Bay ([[039]]'s survivor — the Maintenance Station half of that chain is cut).
  [MachineKind.DroneBay]: 'Drone Bay',
  // The Parts Bench is RETIRED ([[090]]) and its row stays for exactly the reason stated three
  // times above: a boxed machine in the bag is named by its machine. A player who owned one
  // when the bench retired still has the box, and a box that reads "Machine — scrap for $448"
  // is the row this table exists to prevent.
  [MachineKind.PartsBench]: 'Parts Bench',
};

export function machineLabel(kind: number): string {
  return MACHINE_LABELS[kind] ?? 'Machine';
}

/**
 * The three grabber tiers, for the card that clicking one opens ([[099]]).
 *
 * AN ARM IS NOT A MACHINE — it has no `MachineKind`, no `MachineView`, no footprint — so it
 * cannot live in the table above, and the grabber card would otherwise have nothing to put at
 * the top of itself.
 *
 * THE WORDS ARE COPIED FROM `TOOL_INFO`'s PLACEMENT ROWS ON PURPOSE. That table names the
 * TOOL you are holding and this one names the ARM standing on the lot; they are the same
 * relationship `MACHINE_LABELS` and the Fryer's build row already have, and the one thing that
 * would actually confuse a player is buying "Long Grabber" from the menu and clicking on
 * something the card calls a "Grabber Long". A tier this build has never heard of gets the
 * generic word rather than a blank.
 */
export const GRABBER_LABELS: Readonly<Record<number, string>> = {
  [GrabberTier.Mk1]: 'Grabber Mk1',
  [GrabberTier.Mk2]: 'Grabber Mk2',
  [GrabberTier.Long]: 'Long Grabber',
};

export function grabberLabel(tier: number): string {
  return GRABBER_LABELS[tier] ?? 'Grabber';
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

/**
 * The pump's Speed dial, which is the one dial in the game with genuinely no trade. The
 * standard Speed copy promises extra wear, and a pump has none to give — irrigation carries
 * no wear in this release — so saying so would be inventing a catch, the exact sin the
 * Capacity note above warns against.
 */
export const PUMP_SPEED_COPY: DialCopy = {
  name: 'Speed',
  trade: 'More water down the same pipe. Nothing wears, nothing is given up.',
  effect: 'a stronger rated flow for the whole network to divide',
};

export function pumpSpeedCopy(): DialCopy {
  return PUMP_SPEED_COPY;
}
