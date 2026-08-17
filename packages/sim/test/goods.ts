// **THE TWO LISTS THIS FAMILY NEEDS**, in one module because they are one argument.
//
// Items 110, 112 and 115 each fixed the bug in front of them and each had a verifier find the
// same bug one field to the left. Item 115 finally stopped patching and wrote a list: walk a live
// world, collect every field that names a good, and make somebody say a sentence about each. That
// list is `itemBearingPaths` below, and it is the NODES — every place a good can sit.
//
// It shipped with the claim that there was no door eight. There were three, and the census
// verifier explained in one line why a node sweep could not see them:
//
//   > Every bug in this family has been an EDGE: a transfer between two properly-clocked nodes
//   > that dropped the number in transit. Door 8 is invisible to a node sweep *because both its
//   > endpoints are clocked.*
//
// So this module holds both halves, and the second is DERIVED FROM THE FIRST rather than written
// out by hand. A container is a name and a number. The node sweep finds the names; `GOODS_COUNTS`
// pairs each name with the number beside it; and `goodsMoves()` reads the source and returns every
// line that writes one of those numbers. That is every edge in the game, found the same way the
// nodes were — by looking, not by remembering.
//
// Three consumers, on purpose, exactly as `goldens.ts` has three:
//   `freshness-depot-and-bot.test.ts` asserts the node list,
//   `move-census.test.ts` asserts the edge list and the ledger,
//   and anything written after this can count a world without inventing a fourth way to do it.
//
// Dependency-free apart from Node builtins and the sim itself.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type WorldState,
  ItemId,
  freshnessTicks,
  machineHoppers,
  machineSpec,
  soonestSpoilTick,
} from '../src/index';

// --- the nodes: every place a good can sit ---------------------------------------------------

/**
 * Every path in `WorldState` that names a good, found by walking a world rather than by reading
 * the types — because a type is what somebody wrote down and a world is what is actually there.
 *
 * Array indices are collapsed to `[]`, so one machine stands for all of them.
 */
export function itemBearingPaths(state: WorldState): string[] {
  const found = new Set<string>();
  const seen = new Set<object>();

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, `${path}[]`);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const here = path === '' ? key : `${path}.${key}`;
      // `held` is the grabber's claw, which names a good without saying "item" — the one place
      // this sweep would miss if it trusted the naming convention.
      if (/item$/i.test(key) || key === 'held') found.add(here);
      walk(value, here);
    }
  };

  walk(state, '');
  return [...found].sort();
}

// --- the edges: every line that changes how much of a good is somewhere ----------------------

/**
 * **THE NUMBER BESIDE EACH NAME**, one row per container in the node list above.
 *
 * A container is an item id and a quantity. The node sweep enumerates the ids; this is how the
 * quantity is spelled for each of them, and `pattern` is what a WRITE to that quantity looks
 * like in the source. Between them they define a transfer without anybody having to decide what
 * a transfer is: it is a line that changes how much of a good is somewhere.
 *
 * The four rows whose quantity is not a `…Count` field are the reason this table exists at all
 * rather than a regex over `Count`:
 *
 *   - a BELT's quantity is its `items` array's length — `push`/`splice`/`shift`/`pop`.
 *   - a GRABBER's claw holds exactly one thing, so the id field IS the quantity.
 *   - a HOPPER's quantity is `inputCounts[line]`, an array slot with no name of its own.
 *   - the BAG's is `slot.count`, plus `stacks` for the clock the count is split across.
 */
export const GOODS_COUNTS: readonly { node: string; quantity: string; pattern: RegExp }[] = [
  {
    node: 'belts[].items[].item',
    quantity: 'items[]',
    pattern: /\.items\.(?:push|splice|shift|pop|unshift)\(/,
  },
  {
    node: 'bots[].carryItem',
    quantity: 'carryCount',
    pattern: /\.carryCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'bots[].seedItem',
    quantity: 'seedCount',
    pattern: /\.seedCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'contracts[].item',
    quantity: 'stocked',
    pattern: /\.stocked\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'contracts[].item',
    quantity: 'inTransit',
    pattern: /\.inTransit\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  { node: 'grabbers[].held', quantity: 'held', pattern: /\.held\s*=[^=]/ },
  { node: 'inventory[].item', quantity: 'count', pattern: /\.count\s*(?:[-+*/]?=[^=]|\+\+|--)/ },
  {
    node: 'inventory[].item',
    quantity: 'stacks[]',
    pattern: /\.stacks\.(?:push|splice|shift|pop|unshift)\(/,
  },
  {
    node: 'machines[].cargoItem',
    quantity: 'cargoCount',
    pattern: /\.cargoCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'machines[].outputItem',
    quantity: 'outputCount',
    pattern: /\.outputCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'machines[].seedShelfItem',
    quantity: 'seedShelfCount',
    pattern: /\.seedShelfCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'machines[].inputCounts',
    quantity: 'inputCounts[]',
    pattern: /\.inputCounts\[[^\]]*\]\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
];

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Every `.ts` under `src/`, including the save subtree, as `[label, absolute path]`. */
function sourceFiles(dir: string, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = dir + name;
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path + '/', prefix + name + '/'));
    else if (name.endsWith('.ts')) out.push([prefix + name.replace(/\.ts$/, ''), path]);
  }
  return out;
}

/**
 * The nearest enclosing declaration above a line. The sim's source is top-level functions with no
 * nesting deeper than a closure, so the last declaration seen before a line names the verb it is
 * part of — which is the granularity a census wants. An EDGE IS A VERB, not a line: two writes to
 * `carryCount` inside `harvestUnderBot` are one transfer described twice.
 */
function enclosingFunctions(lines: string[]): string[] {
  const owners: string[] = [];
  let current = '(top level)';
  for (const line of lines) {
    const declared =
      /^(?:export )?(?:async )?function\*? ([A-Za-z0-9_]+)/.exec(line) ??
      /^(?:export )?const ([A-Za-z0-9_]+) = (?:\([^)]*\)|[A-Za-z0-9_]+) =>/.exec(line);
    if (declared !== null) current = declared[1]!;
    owners.push(current);
  }
  return owners;
}

/**
 * **EVERY TRANSFER OF GOODS IN THE SIM**, as `file:function:quantity`, sorted.
 *
 * Read off the source with `GOODS_COUNTS`' patterns, so it is a census rather than a list: it
 * grows the day somebody writes a new one, and there is nowhere to add a transfer that it cannot
 * see short of inventing a container the node sweep has not met either.
 */
export function goodsMoves(): string[] {
  const found = new Set<string>();
  for (const [label, path] of sourceFiles(SRC)) {
    const lines = readFileSync(path, 'utf8').split('\n');
    const owners = enclosingFunctions(lines);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Comments are prose ABOUT moves. This family has a great deal of prose about moves.
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      for (const entry of GOODS_COUNTS) {
        if (entry.pattern.test(line)) found.add(`${label}:${owners[i]}:${entry.quantity}`);
      }
    }
  }
  return [...found].sort();
}

/**
 * **THE BAG'S DOORS, BY CALLER — AND THIS IS THE HALF THAT CATCHES DOOR 8.**
 *
 * `goodsMoves()` above cannot see door 8, and the reason is worth stating because it is the same
 * blind spot one level down that item 115's node sweep had one level up. A hand-back into the
 * player's bag does not write a count field at the call site; it calls `addItem` or `addItemFresh`
 * and those two lines ARE the census's `state:addItemFresh:count` row, whoever called them.
 *
 * But the bag is the one container in the game whose clock is decided by WHICH FUNCTION YOU CALL
 * rather than by an argument you pass:
 *
 *   - `addItem` stamps a full window from now. Correct for goods that are new (a crop leaving the
 *     ground, a purchase) or that have no clock at all (a seed, a box).
 *   - `addItemFresh` takes the deadline, which every hand-back owes to whatever it came out of.
 *
 * Door 8 was one `addItem` where an `addItemFresh` belonged. So the doors are enumerated by
 * CALLER, and every caller has to say which of those two sentences it is — which is a question a
 * grep for "addItem" cannot ask and a reviewer reading a 90-line function reliably forgets to.
 */
export function bagDoors(): string[] {
  const doors: [string, RegExp][] = [
    ['addItemFresh', /(?<![A-Za-z0-9_.])addItemFresh\(/],
    ['addItem', /(?<![A-Za-z0-9_.])addItem\(/],
    ['removeItem', /(?<![A-Za-z0-9_.])removeItem\(/],
  ];
  const found = new Set<string>();
  for (const [label, path] of sourceFiles(SRC)) {
    const lines = readFileSync(path, 'utf8').split('\n');
    const owners = enclosingFunctions(lines);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      // A declaration is not a call. Without this the three doors each report themselves.
      if (/^\s*(?:export )?function /.test(line)) continue;
      for (const [door, pattern] of doors) {
        // The doors' own bodies call each other; that plumbing is the door, not a user of it.
        if (label === 'state' && doors.some(([name]) => name === owners[i])) continue;
        if (pattern.test(line)) found.add(`${label}:${owners[i]}:${door}`);
      }
    }
  }
  return [...found].sort();
}

// --- the verdicts: what each transfer CLAIMS, as data rather than as a comment ---------------

/**
 * **WHAT A TRANSFER PROMISES ABOUT THE TOTAL NUMBER OF GOODS IN THE WORLD.**
 *
 * Item 117's first pass gave every row on the census a verdict in a `//` comment. That was the
 * right list and the wrong medium: a comment is read by whoever is already looking, and this
 * family's entire history is people who were looking at the next field along. A verdict that is
 * DATA can be executed — the harness in `move-census-live.test.ts` drives the verb and holds it
 * to the sentence written here, so a row whose comment says "conserving" over code that deletes
 * is a red test rather than a nice piece of prose.
 *
 * Four of these are directional claims about the grand total, and they compose: a function that
 * moves goods along and then sells them is a `Sink`, because the strongest thing true of ALL its
 * behaviour is "never adds". Picking the weakest claim that covers the whole function is what
 * makes one verdict per function honest.
 */
export const MoveVerdict = {
  /** Per-item counts survive the move exactly, and no clock comes out larger than it went in. */
  Conserving: 'conserving',
  /** Goods enter the world here: a crop leaves the ground, a tree fruits, a recipe finishes. */
  Source: 'source',
  /** Goods leave the world here: sold, planted, consumed. The total may fall, never rise. */
  Sink: 'sink',
  /** The total holds but the ids move — a clock ran out and the units turned to Compost. */
  Transform: 'transform',
  /** Copies a number outward into a render buffer. The world is not touched. */
  Projection: 'projection',
  /** The pattern matched something that is not goods. Labelled rather than tuned away. */
  NotGoods: 'not-goods',
} as const;
export type MoveVerdict = (typeof MoveVerdict)[keyof typeof MoveVerdict];

/**
 * **EVERY TRANSFER OF GOODS IN THE SIM, WITH THE SENTENCE IT IS HELD TO.**
 *
 * The keys are `goodsMoves()`' output exactly, and `move-census.test.ts` asserts that — so this
 * is the ONE list, not a second one beside it. Adding a transfer to the sim turns that test red,
 * and the only way to green it is to come here and say which of the six sentences the new line
 * is. That is a harder question than "add a row", and deliberately: doors 8, 8b and 8c were all
 * lines somebody would have happily added a row for.
 */
export const MOVE_VERDICTS: Readonly<Record<string, MoveVerdict>> = {
  // --- belts and arms (item 112 clocked all four) ---
  'belts:advanceGrabber:held': MoveVerdict.Conserving, //     claw ↔ world. CLOCK: heldFreshTicks
  'belts:advanceJunction:items[]': MoveVerdict.Conserving, // belt → belt. The clock rides on the
  //                                                         BeltItem and is re-inserted with it.
  'belts:beltTakeFromTile:items[]': MoveVerdict.Conserving, //belt → the hand that took a tile up.
  'belts:grabberSource:items[]': MoveVerdict.Conserving, //   belt → claw.
  'belts:handOffFromHead:items[]': MoveVerdict.Conserving, // belt → belt, or belt → machine.
  // --- bots (items 115 and 117) ---
  'bots:dockAcceptSeed:cargoCount': MoveVerdict.Conserving, //belt → planter hopper. No clock.
  'bots:harvestUnderBot:carryCount': MoveVerdict.Source, //   GROUND → arms. Goods enter the world
  //                                                         here, and a full window is right.
  'bots:harvestUnderBot:seedCount': MoveVerdict.Source, //    ground → seed pocket.
  'bots:plantUnderBot:cargoCount': MoveVerdict.Sink, //       planter hopper → GROUND.
  'bots:unloadIntoDock:cargoCount': MoveVerdict.Conserving, //arms → shelf. CLOCK: mergedFreshness
  'bots:unloadIntoDock:carryCount': MoveVerdict.Conserving, //the other half of the same move.
  'bots:unloadIntoDock:seedCount': MoveVerdict.Conserving, // pocket → seed shelf.
  'bots:unloadIntoDock:seedShelfCount': MoveVerdict.Conserving, // the other half.
  // --- commerce ---
  'commerce:advanceCart:cargoCount': MoveVerdict.Sink, //     cart → SOLD. Goods become money.
  'commerce:advanceContract:inTransit': MoveVerdict.Sink, // **BOTH HALVES OF THIS FUNCTION ARE
  'commerce:advanceContract:stocked': MoveVerdict.Sink, //     ONE VERDICT, AND IT IS THE WEAKER
  //                                                         ONE.** It moves floor → lorry, which
  //                                                         conserves, and then lorry → sold,
  //                                                         which does not. "Never adds" is the
  //                                                         strongest thing true of the whole
  //                                                         verb; the conserving half is checked
  //                                                         on its own by a live scenario that
  //                                                         stops before the run completes.
  'commerce:depotAccept:stocked': MoveVerdict.Conserving, //  claw → depot floor.
  'commerce:refundContract:inTransit': MoveVerdict.Conserving, // cancelled route → bag.
  'commerce:refundContract:stocked': MoveVerdict.Conserving, //   ditto, the waiting floor.
  // --- the bag, and the primitives every other row goes through ---
  'state:addBoxedMachine:count': MoveVerdict.Conserving, //   a box into the bag.
  'state:addItemFresh:count': MoveVerdict.Conserving, //      **THE ONE DOOR IN.** See `bagDoors`.
  'state:addStack:count': MoveVerdict.Conserving, //          within one slot: the clock IS this.
  'state:addStack:stacks[]': MoveVerdict.Conserving, //       merging and capping deadlines.
  'state:beltInsert:items[]': MoveVerdict.Conserving, //      THE one door onto a belt.
  'state:putHopper:inputCounts[]': MoveVerdict.Conserving, // THE one door into a hopper.
  'state:putStorage:cargoCount': MoveVerdict.Conserving, //   THE one door into a container.
  'state:removeItem:count': MoveVerdict.Conserving, //        THE one door out, soonest-first.
  'state:takeBoxedMachine:count': MoveVerdict.Conserving, //  a box out of the bag.
  'state:takeDockSeedShelf:seedShelfCount': MoveVerdict.Conserving, // seed shelf → belt or hand.
  'state:takeDockShelf:cargoCount': MoveVerdict.Conserving, //shelf → belt or hand.
  'state:takeFromStacks:count': MoveVerdict.Conserving, //    within one slot, soonest first.
  'state:takeFromStacks:stacks[]': MoveVerdict.Conserving, // ditto.
  'state:takeHopper:inputCounts[]': MoveVerdict.Conserving, //hopper → out. CLOCK: returned
  'state:takeOneOutput:outputCount': MoveVerdict.Conserving, //THE one door out of a basket.
  'state:takeStorage:cargoCount': MoveVerdict.Conserving, //  container → out. CLOCK: returned
  // --- the tick's own transfers ---
  'tick:advanceBotSpoilage:carryCount': MoveVerdict.Transform, // armful → Compost.
  'tick:advanceOrchard:outputCount': MoveVerdict.Source, //    a tree makes fruit out of time.
  'tick:advanceSpoilage:count': MoveVerdict.Transform, //     bag → Compost.
  'tick:advanceSpoilage:stacks[]': MoveVerdict.Transform, //  ditto, the deadline side.
  'tick:advanceStorageSpoilage:cargoCount': MoveVerdict.Transform, // container → Compost.
  'tick:applyDeconstructMachine:cargoCount': MoveVerdict.Conserving, // boxing: cargo → bag.
  'tick:applyDeconstructMachine:seedShelfCount': MoveVerdict.Conserving, // **DOOR 8c.**
  'tick:applyLoadCart:cargoCount': MoveVerdict.Conserving, // bag → cart. CLOCK: via putStorage
  'tick:applyRefillHopper:cargoCount': MoveVerdict.Conserving, // bag → planter hopper.
  'tick:produceRecipe:outputCount': MoveVerdict.Source, //    a recipe makes a good out of others.
  //                                                         NOT a Transform: §4's "processing IS
  //                                                         preservation" means the output is a
  //                                                         NEW good with a new window, and the
  //                                                         ratio is the recipe's, not one to one.
  // --- the projection, which moves nothing ---
  //
  // **KEPT RATHER THAN FILTERED OUT.** `view.ts` copies numbers OUTWARD into a render buffer and
  // never touches the world, so an exemption would be correct — and item 115's sweep is
  // trustworthy precisely because it took the same offer and refused it. Three items in this
  // family shipped a rule with an exception in it and the bug lived in the exception.
  'view:projectBots:carryCount': MoveVerdict.Projection,
  'view:projectBots:seedCount': MoveVerdict.Projection,
  'view:projectCommerce:stocked': MoveVerdict.Projection,
  'view:projectField:count': MoveVerdict.NotGoods, //         a count of TILES. One of the two
  //                                                         honest false positives, listed rather
  //                                                         than tuned away — a census that
  //                                                         narrowed its own pattern to look
  //                                                         clean would be a list again.
  'view:projectGrabbers:held': MoveVerdict.Projection,
  'view:projectInventory:count': MoveVerdict.Projection,
  'view:projectMachines:cargoCount': MoveVerdict.Projection,
  'view:projectMachines:outputCount': MoveVerdict.Projection,
  'view:projectMachines:seedShelfCount': MoveVerdict.Projection,
  'view:projectRecipe:count': MoveVerdict.Projection, //      a hopper level.
  'view:projectStats:count': MoveVerdict.NotGoods, //         the sales ledger's units. The second
  //                                                         false positive: a receipt cannot spoil.
};

/**
 * **WHAT A DOOR INTO THE BAG DOES TO THE CLOCK**, and the reason door 8 needs its own list.
 *
 * `MOVE_VERDICTS` above is about the COUNT. This is about the WINDOW, and it is a separate
 * question because the bag is the one container whose clock is chosen by which function you call
 * rather than by an argument you pass. Door 8 conserved the count perfectly.
 */
export const BagDoorVerdict = {
  /** `addItemFresh` with the deadline the goods came out of. What every hand-back owes. */
  Carries: 'carries',
  /** `addItem`, stamping a full window from now — legitimate only for a genuinely NEW good. */
  MintsNew: 'mints-new',
  /**
   * `addItem` on a good that HAS no window, so the stamp costs nothing. **This is the verdict
   * door 8 falsely belonged to**, and the one the live harness can actually falsify: drive the
   * door, look at what landed in the bag, and every item of it must be shelf-stable.
   */
  MintsShelfStable: 'mints-shelf-stable',
  /** `removeItem`. Goods leaving the bag; the bag's clock is not this door's business. */
  Out: 'out',
} as const;
export type BagDoorVerdict = (typeof BagDoorVerdict)[keyof typeof BagDoorVerdict];

/**
 * **EVERY DOOR INTO AND OUT OF THE PLAYER'S BAG, BY CALLER.** Keys are `bagDoors()` exactly.
 *
 * A hand-back into the bag writes no count at the call site — it calls `addItem` or
 * `addItemFresh`, and both collapse to the single `state:addItemFresh:count` row on the census
 * above no matter who called them. So the doors are enumerated by CALLER and each caller has to
 * say which of the four sentences it is. Door 8 was one `addItem` among four correct
 * `addItemFresh` calls in one function; on this list it would have had to be written down as
 * "mints a full window" four lines under four rows that do not.
 */
export const BAG_DOOR_VERDICTS: Readonly<Record<string, BagDoorVerdict>> = {
  'commerce:refundContract:addItemFresh': BagDoorVerdict.Carries, // a torn-up route hands back.
  'state:createWorld:addItem': BagDoorVerdict.MintsShelfStable, // the opening seeds.
  'tick:advanceSpoilage:addItem': BagDoorVerdict.MintsShelfStable, // Compost.
  'tick:applyApplyFertilizer:removeItem': BagDoorVerdict.Out,
  'tick:applyBuyItem:addItem': BagDoorVerdict.MintsNew, //     bought goods are new goods.
  'tick:applyDeconstructMachine:addItem': BagDoorVerdict.MintsShelfStable, // **ONLY SINCE ITEM
  //                                                          117**: the two lines here are the
  //                                                          dock's seed shelf and the bot's seed
  //                                                          pocket. The armful that used to be on
  //                                                          this row was DOOR 8.
  'tick:applyDeconstructMachine:addItemFresh': BagDoorVerdict.Carries, // basket, hoppers, cargo,
  //                                                          and — since item 117 — the armful.
  'tick:applyLoadCart:removeItem': BagDoorVerdict.Out,
  'tick:applyLoadMachine:removeItem': BagDoorVerdict.Out,
  'tick:applyPackCrate:addItemFresh': BagDoorVerdict.Carries,
  'tick:applyPackCrate:removeItem': BagDoorVerdict.Out,
  'tick:applyPlantTile:removeItem': BagDoorVerdict.Out,
  'tick:applyRefillHopper:removeItem': BagDoorVerdict.Out,
  'tick:applyRemoveBelt:addItemFresh': BagDoorVerdict.Carries, // a belt hands its riders back.
  'tick:applyRemoveBeltTile:addItemFresh': BagDoorVerdict.Carries, // ditto, one tile at a time.
  'tick:applyRemoveGrabber:addItemFresh': BagDoorVerdict.Carries, // whatever was in the claw.
  'tick:applySellItem:removeItem': BagDoorVerdict.Out,
  'tick:applySwingScythe:addItem': BagDoorVerdict.MintsNew, // crop leaving the ground.
  'tick:applyUnloadMachine:addItem': BagDoorVerdict.MintsShelfStable, // the seed shelf only.
  'tick:applyUnloadMachine:addItemFresh': BagDoorVerdict.Carries, // basket, hoppers and cargo.
  'tick:applyUseRepairKit:removeItem': BagDoorVerdict.Out,
  'tick:harvestOneTile:addItem': BagDoorVerdict.MintsNew, //   the hand's own harvest.
  'zones:replantOneTile:removeItem': BagDoorVerdict.Out,
};

// --- the ledger: how much of everything a world is holding, and how fresh -------------------

export interface GoodsHolding {
  /** Units, everywhere in the world at once. */
  count: number;
  /**
   * The SOONEST deadline anything holding this item is running, in ticks from now, or 0 when
   * nothing holding it has a clock. Remaining ticks rather than absolute deadlines, because the
   * bag stores one and every container stores the other and a census has to compare them.
   */
  soonest: number;
}

function hold(into: Map<ItemId, GoodsHolding>, item: ItemId | 0, count: number, ticks: number) {
  if (item === 0 || count <= 0) return;
  const had = into.get(item);
  if (had === undefined) {
    into.set(item, { count, soonest: ticks });
    return;
  }
  had.count += count;
  if (ticks > 0 && (had.soonest <= 0 || ticks < had.soonest)) had.soonest = ticks;
}

/**
 * **EVERY UNIT OF EVERY GOOD IN A WORLD, AND THE SOONEST CLOCK ON IT.**
 *
 * One entry per node in `itemBearingPaths` that is a CONTAINER — which is to say, all of them
 * except the three the node list itself marks as not containers: `stats.salesByItem` is a receipt,
 * `trace[].command.item` is the input log, and neither holds anything.
 *
 * WHAT IT DOES NOT COUNT, stated rather than implied: compost lying on a field tile
 * (`CropTile.compost`), which is a number with no item id beside it, and standing crops, which are
 * not goods until something pulls them. Both are outside every door this family has ever found.
 */
export function goodsLedger(state: WorldState): Map<ItemId, GoodsHolding> {
  const ledger = new Map<ItemId, GoodsHolding>();

  for (const slot of state.inventory) {
    const deadline = soonestSpoilTick(slot);
    const left = deadline <= 0 ? 0 : Math.max(1, deadline - state.tick);
    // **A BOXED MACHINE IS NOT A GOOD, AND THAT IS THE GAME'S OWN WORD FOR IT**, not an exemption
    // invented here to make a sum come out. `SellBoxedMachineCommand`'s header: *"a boxed machine
    // is none of those things — it is not a good, it is not priced at list"*, and `sellable` is
    // FALSE on every boxed row so the sell bin refuses them.
    //
    // It has to come out because `addBoxedMachine` does `slot.count += 1`, so a box sits in the
    // bag wearing a goods count. Item 117's first pass believed the ledger already skipped them
    // and wrote that down; it did not, and boxing anything quietly added one unit to the world's
    // total. Every "nothing vanished" sum over a verb that boxes something was off by one and
    // passing only because it compared one item id at a time.
    //
    // Boxes are conserved too, and they are counted — by `boxLedger` below, on their own books.
    hold(ledger, slot.item, slot.count - slot.boxes.length, left);
  }

  for (const machine of state.machines) {
    hold(ledger, machine.cargoItem, machine.cargoCount, machine.cargoFreshTicks);
    hold(ledger, machine.outputItem, machine.outputCount, machine.outputFreshTicks);
    hold(ledger, machine.seedShelfItem, machine.seedShelfCount, 0);
    const spec = machineSpec(machine.kind);
    if (spec === null) continue;
    const hoppers = machineHoppers(spec);
    for (let i = 0; i < hoppers.length; i++) {
      hold(ledger, hoppers[i]!.item, machine.inputCounts[i] ?? 0, machine.inputFreshTicks[i] ?? 0);
    }
  }

  for (const belt of state.belts) {
    for (const riding of belt.items) hold(ledger, riding.item, 1, riding.freshTicks);
  }
  // The claw's `held` is a bare `number` rather than an `ItemId` — the one node in the sweep whose
  // field does not say "item", and the one whose type does not either.
  for (const grabber of state.grabbers) {
    hold(ledger, grabber.held as ItemId | 0, 1, grabber.heldFreshTicks);
  }
  for (const bot of state.bots) {
    hold(ledger, bot.carryItem, bot.carryCount, bot.carryFreshTicks);
    hold(ledger, bot.seedItem, bot.seedCount, 0);
  }
  for (const contract of state.contracts) {
    hold(ledger, contract.item, contract.stocked, contract.stockedFreshTicks);
    hold(ledger, contract.item, contract.inTransit, contract.inTransitFreshTicks);
  }

  return ledger;
}

/**
 * **HOW MANY BOXED MACHINES A WORLD IS HOLDING**, by boxed-item id.
 *
 * The paperwork's own books, kept separately from the goods ledger for the reason stated there: a
 * box is not a good. But it is still a thing that can be deleted, and `addBoxedMachine` /
 * `takeBoxedMachine` are two conserving rows on the census — so they get an instrument that can
 * actually weigh what they move, rather than an exemption saying nobody needs to.
 */
export function boxLedger(state: WorldState): Map<ItemId, number> {
  const boxes = new Map<ItemId, number>();
  for (const slot of state.inventory) {
    if (slot.boxes.length === 0) continue;
    boxes.set(slot.item, (boxes.get(slot.item) ?? 0) + slot.boxes.length);
  }
  return boxes;
}

/** Every boxed machine in the world, added up. */
export function sumBoxes(boxes: Map<ItemId, number>): number {
  let total = 0;
  for (const count of boxes.values()) total += count;
  return total;
}

/** How many of one item a world is holding, everywhere at once. */
export function ledgerCount(ledger: Map<ItemId, GoodsHolding>, item: ItemId): number {
  return ledger.get(item)?.count ?? 0;
}

/** The soonest clock on one item anywhere, or 0 when it has none. */
export function ledgerClock(ledger: Map<ItemId, GoodsHolding>, item: ItemId): number {
  return ledger.get(item)?.soonest ?? 0;
}

/** Whether this item runs a clock at all. Seeds, boxes and bagged chips do not. */
export function perishable(item: ItemId): boolean {
  return freshnessTicks(item) > 0;
}

/**
 * **EVERY UNIT OF EVERYTHING, ADDED UP** — the number plan §4 is a sentence about.
 *
 * This is only a conservation law because one spoiled unit makes exactly one Compost, so a
 * potato turning does not change it. `move-census-live.test.ts` pins `COMPOST_PER_SPOILED_ITEM`
 * for that reason: if it is ever tuned to 2, every "the total held" assertion in this family
 * silently stops being one, and a test that quietly stops checking is worse than no test.
 */
export function sumLedger(ledger: Map<ItemId, GoodsHolding>): number {
  let total = 0;
  for (const holding of ledger.values()) total += holding.count;
  return total;
}

/** Every item id named by either ledger, sorted, so a comparison can name what moved. */
export function ledgerItems(...ledgers: Map<ItemId, GoodsHolding>[]): ItemId[] {
  const items = new Set<ItemId>();
  for (const ledger of ledgers) for (const item of ledger.keys()) items.add(item);
  return [...items].sort((a, b) => a - b);
}

/**
 * A one-line account of what changed between two ledgers, for a failure message.
 *
 * Failure text matters more here than anywhere else in this family: the thing being reported is
 * "some number of some good stopped existing somewhere", and a bare `expected 12 to be 15` sends
 * the next reader back through nine containers by hand. That is roughly how items 110 through 117
 * were each spent.
 */
export function ledgerDelta(
  before: Map<ItemId, GoodsHolding>,
  after: Map<ItemId, GoodsHolding>,
): string {
  const parts: string[] = [];
  for (const item of ledgerItems(before, after)) {
    const was = ledgerCount(before, item);
    const now = ledgerCount(after, item);
    const wasClock = ledgerClock(before, item);
    const nowClock = ledgerClock(after, item);
    if (was === now && wasClock === nowClock) continue;
    parts.push(`item ${item}: ${was}→${now} units, clock ${wasClock}→${nowClock}`);
  }
  return parts.length === 0 ? '(nothing changed)' : parts.join('; ');
}
