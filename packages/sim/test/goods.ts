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

import * as balance from '../src/data';
import { type WorldState, ItemId, heldOutputItem, machineHoppers, machineSpec } from '../src/index';

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
 * **A GOOD IS THREE THINGS, AND THIS TABLE NOW SAYS ALL THREE** (item 118).
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
 *
 * **AND THE TWO COLUMNS ITEM 118 ADDED, WHICH ARE THE WHOLE OF ITS ARGUMENT.** Wave 18's
 * adversary read the table above and said the level this family had climbed to was still one
 * short:
 *
 *   > Item 115 watched NODES; the answer was "watch EDGES"; this census watches QUANTITIES.
 *   > Every row is a number saying *how much*. **None says what a good IS, none says how long
 *   > it has left.**
 *
 * So `identity` says where the id of the goods in that container comes from, and `clock` says
 * which field is counting down beside them. Both are paths rather than prose, because both are
 * checked: `move-census.test.ts` holds `identity` to a live world's data tables and `clock` to
 * the save round trip, and neither can be satisfied by a comment.
 */
export interface GoodsCount {
  /** The `itemBearingPaths` node whose id names these goods. */
  readonly node: string;
  /** How the quantity beside that name is spelled, and the census row's own suffix. */
  readonly quantity: string;
  /**
   * **WHERE THE ID COMES FROM**, and `'state'` is the boring answer for eleven of thirteen rows:
   * the `node` field above is itself the id, so a node sweep can see it and a save carries it.
   *
   * Anything else is a path into the BALANCE DATA, and that is door 10: `overcookedCount` units
   * of a Fryer's basket are not `machines[].outputItem` at all, they are whatever
   * `MACHINE_SPECS[].overcookOutputItem` says — a fact that lives in a table rather than in the
   * world, so there is no field for a node sweep to find and no count for a quantity census to
   * watch. `goodsLedger` reads this column's meaning; `dataItemFields()` below enumerates every
   * data path that could join it.
   */
  readonly identity: string;
  readonly pattern: RegExp;
}

export const GOODS_COUNTS: readonly GoodsCount[] = [
  {
    node: 'belts[].items[].item',
    quantity: 'items[]',
    identity: 'state',
    pattern: /\.items\.(?:push|splice|shift|pop|unshift)\(/,
  },
  {
    node: 'bots[].carryItem',
    quantity: 'carryCount',
    identity: 'state',
    pattern: /\.carryCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'bots[].seedItem',
    quantity: 'seedCount',
    identity: 'state',
    pattern: /\.seedCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'contracts[].item',
    quantity: 'stocked',
    identity: 'state',
    pattern: /\.stocked\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'contracts[].item',
    quantity: 'inTransit',
    identity: 'state',
    pattern: /\.inTransit\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'grabbers[].held',
    quantity: 'held',
    identity: 'state',
    pattern: /\.held\s*=[^=]/,
  },
  {
    node: 'inventory[].item',
    quantity: 'count',
    identity: 'state',
    pattern: /\.count\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'machines[].cargoItem',
    quantity: 'cargoCount',
    identity: 'state',
    pattern: /\.cargoCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'machines[].outputItem',
    quantity: 'outputCount',
    identity: 'state',
    pattern: /\.outputCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    // **DOOR 10, AND THE ONLY ROW ON THIS CENSUS WHOSE GOODS HAVE NO NAME IN THE WORLD.**
    //
    // A Fryer stopped by demand-pull browns one chip per `OVERCOOK_BLOCKED_TICKS`. Nothing moves:
    // `outputCount` does not change, `outputItem` does not change, and one PlainChips has become
    // one RusticStyleChips inside the basket. Measured by wave 18's adversary at 602 ticks — the
    // ledger delta read "(nothing changed)" and `goodsMoves()` matching /overcook/ returned `[]`.
    //
    // It is a transfer between two item ids with no quantity field on the receiving side, which
    // is why a census of quantities was structurally unable to see it. The receiving side's
    // quantity is `overcookedCount` and its NAME is in the spec table, so both columns had to
    // exist before this row could be written down at all.
    node: 'machines[].outputItem',
    quantity: 'overcookedCount',
    identity: 'MACHINE_SPECS[].overcookOutputItem',
    pattern: /\.overcookedCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'machines[].seedShelfItem',
    quantity: 'seedShelfCount',
    identity: 'state',
    pattern: /\.seedShelfCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    // A hopper line has no id field of its own — which line holds which good is `machineHoppers`,
    // and that is data. Harmless, and worth writing down anyway: it is the same shape as door 10
    // with the sting taken out, because a hopper line can only ever hold the one good.
    node: 'machines[].inputCounts',
    quantity: 'inputCounts[]',
    identity: 'MACHINE_SPECS[].inputs[].item',
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
 * and that line IS the census's `state:addItem:count` row, whoever called it.
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
 *
 * **AND BY CALL SITE WITHIN THE CALLER, NUMBERED** (item 121). Until this pass the keys were a
 * `Set`, so every `addItem` in one function collapsed to one row — and `tick:harvestOneTile:addItem`
 * was ONE row standing for FOUR call sites under the single verdict `MintsNew`. That is the same
 * collapse `clockDoors()` was taught to stop making, and it fails in the same direction: item 121's
 * new hand-back returns a crop (a genuine mint), a seed and a compost heap (both shelf-stable, and
 * therefore FALSIFIABLE) from one function. Collapsed, the two checkable claims would have hidden
 * behind the one judgement call that cannot be checked at all. Numbered, each has to be said out
 * loud, and the live harness can go and look at what actually lands in the bag.
 *
 * The first occurrence keeps the bare key so adding a call site never renames its neighbour —
 * `clockDoors()`' rule, for `clockDoors()`' reason.
 */
export function bagDoors(): string[] {
  const doors: [string, RegExp][] = [
    ['addItem', /(?<![A-Za-z0-9_.])addItem\(/],
    ['removeItem', /(?<![A-Za-z0-9_.])removeItem\(/],
  ];
  const found: string[] = [];
  const seen = new Map<string, number>();
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
        if (!pattern.test(line)) continue;
        const key = `${label}:${owners[i]}:${door}`;
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        found.push(n === 1 ? key : `${key}#${n}`);
      }
    }
  }
  return [...found].sort();
}

// --- the clock doors: DELETED (item 124) -----------------------------------------------------
//
// `clockDoors()`, `clockWrites()`, `clockCrossings()`, `ClockDoorVerdict`,
// `CLOCK_CROSSING_VERDICTS` and `UNREACHED_CLOCKS` were the census of every line that handed a
// freshness clock to a container. There are no clocks, so there is nothing to cross and nothing
// to hold to a sentence. `test/clock-crossings.ts`, `test/clock-doors.test.ts` and
// `scripts/clock-mutation-sweep.py` went with them.
//
// **WHAT IS DIRECTLY ABOVE AND DIRECTLY BELOW THIS BLOCK DID NOT GO, AND THE DIFFERENCE IS THE
// WHOLE POINT.** `goodsMoves()` and `bagDoors()` count QUANTITY and IDENTITY across a transfer —
// plan §4's *"nothing vanishes"*, which item 124 does not touch and which is the thing that
// proves this deletion lost nobody a potato. The clock layer was a different census that happened
// to live in the same file.

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
  'commerce:landEmpties:outputCount': MoveVerdict.Source, //  **THE RETURN LEG** (item 131). Glass
  //                                                         enters the world here, off a lorry
  //                                                         from a town that is not simulated —
  //                                                         the same fiction `runTicksFor`
  //                                                         describes, seen from the other end.
  //                                                         The bottles it mints were bought and
  //                                                         shipped inside a soda, so this is a
  //                                                         SOURCE and not the other half of a
  //                                                         transfer: the goods that left went
  //                                                         out through `payForDelivery` and are
  //                                                         money now.
  //                                                         **ONE ROW BECAUSE THERE IS ONE WRITE**
  //                                                         — the census keys by the function that
  //                                                         writes the count, and both vehicles
  //                                                         come through this door. That is the
  //                                                         collapse `MOVE_VERDICTS`' own header
  //                                                         warns about, so BOTH triggers are
  //                                                         driven live rather than one standing
  //                                                         in for the other: a cart coming home
  //                                                         and a truck coming home are separate
  //                                                         scenarios in `move-census-live`.
  'commerce:refundContract:inTransit': MoveVerdict.Conserving, // cancelled route → bag.
  'commerce:refundContract:stocked': MoveVerdict.Conserving, //   ditto, the waiting floor.
  // --- the bag, and the primitives every other row goes through ---
  'state:addBoxedMachine:count': MoveVerdict.Conserving, //   a box into the bag.
  'state:addItem:count': MoveVerdict.Conserving, //           **THE ONE DOOR IN.** See `bagDoors`.
  'state:beltInsert:items[]': MoveVerdict.Conserving, //      THE one door onto a belt.
  'state:putHopper:inputCounts[]': MoveVerdict.Conserving, // THE one door into a hopper.
  'state:putStorage:cargoCount': MoveVerdict.Conserving, //   THE one door into a container.
  'state:removeItem:count': MoveVerdict.Conserving, //        THE one door out, soonest-first.
  'state:takeBoxedMachine:count': MoveVerdict.Conserving, //  a box out of the bag.
  'state:takeDockSeedShelf:seedShelfCount': MoveVerdict.Conserving, // seed shelf → belt or hand.
  'state:takeDockShelf:cargoCount': MoveVerdict.Conserving, //shelf → belt or hand.
  'state:takeHopper:inputCounts[]': MoveVerdict.Conserving, //hopper → out. CLOCK: returned
  'state:takeOneOutput:outputCount': MoveVerdict.Conserving, //THE one door out of a basket.
  'state:takeOneOutput:overcookedCount': MoveVerdict.Conserving, // **the SAME door, counted on the
  //                                                         burnt side.** One pull decrements
  //                                                         both numbers, and it is one transfer:
  //                                                         `nextOutputItem` hands the burnt grade
  //                                                         over first, so the unit that leaves is
  //                                                         a RusticStyleChips and the basket is
  //                                                         one lighter in both books.
  'state:takeStorage:cargoCount': MoveVerdict.Conserving, //  container → out. CLOCK: returned
  // --- the tick's own transfers ---
  'tick:advanceOrchard:outputCount': MoveVerdict.Source, //    a tree makes fruit out of time.
  'tick:advanceOvercooking:overcookedCount': MoveVerdict.Transform, // **DOOR 10.** A stopped Fryer
  //                                                         turns one PlainChips into one
  //                                                         RusticStyleChips WHERE IT STANDS. The
  //                                                         total holds and the ids move, which is
  //                                                         a Transform exactly as spoilage is —
  //                                                         and until item 118 there was no row
  //                                                         here at all, because the census
  //                                                         watched quantities and this line
  //                                                         changes no quantity of anything the
  //                                                         old census could name.
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
  'view:projectMachines:overcookedCount': MoveVerdict.Projection, // the burnt count reaches the
  //                                                         HUD, which is how a player sees a
  //                                                         basket going rustic without opening it.
  'view:projectMachines:seedShelfCount': MoveVerdict.Projection,
  'view:projectRecipe:count': MoveVerdict.Projection, //      a hopper level.
  'view:projectStats:count': MoveVerdict.NotGoods, //         the sales ledger's units. The second
  //                                                         false positive: a receipt cannot spoil.
};

/**
 * **WHICH WAY GOODS CROSS THE BAG'S THRESHOLD.**
 *
 * **THIS ENUM USED TO HAVE FOUR VALUES AND THEY WERE ALL ABOUT THE CLOCK** (item 121):
 * `Carries` for `addItemFresh` handing over the deadline goods came out with, `MintsNew` for a
 * genuinely new good taking a full window, `MintsShelfStable` for a good that had no window to
 * mint, and `Out`. Item 124 deleted freshness, so three of those four collapse into one another
 * and `addItemFresh` no longer exists.
 *
 * **THE CENSUS ITSELF IS NOT WEAKER FOR IT, AND THAT IS WORTH BEING PRECISE ABOUT**, because a
 * two-value enum looks like a table that has stopped asking anything. What it was ever able to
 * catch by itself is a door that is not on the list: door 8 was a hand-back MISSING from a
 * function that made four others, and `move-census.test.ts` holds this table's keys to
 * `bagDoors()` exactly — so a new `addItem` anywhere in the sim turns this red and somebody has
 * to come here and say what it is. That property is untouched. What is gone is the second
 * question asked of each row, and there is nothing left to ask it about.
 */
export const BagDoorVerdict = {
  /** `addItem`. Goods arriving in the bag. */
  In: 'in',
  /** `removeItem`. Goods leaving it. */
  Out: 'out',
} as const;
export type BagDoorVerdict = (typeof BagDoorVerdict)[keyof typeof BagDoorVerdict];

/**
 * **EVERY DOOR INTO AND OUT OF THE PLAYER'S BAG, BY CALLER.** Keys are `bagDoors()` exactly.
 *
 * A hand-back into the bag writes no count at the call site — it calls `addItem`, which collapses
 * to a single row on the census above no matter who called it. So the doors are enumerated by
 * CALLER, and a caller that appears here without a line of its own is a transfer nobody has
 * looked at.
 */
export const BAG_DOOR_VERDICTS: Readonly<Record<string, BagDoorVerdict>> = {
  'commerce:refundContract:addItem': BagDoorVerdict.In, // the depot FLOOR hands its stock back.
  'commerce:refundContract:addItem#2': BagDoorVerdict.In, // and the lorry already on the road.
  'state:createWorld:addItem': BagDoorVerdict.In, // the opening seeds. The one place goods enter a world from nowhere.
  'tick:applyBuyItem:addItem': BagDoorVerdict.In, // bought at the stand.
  'tick:applyDeconstructMachine:addItem': BagDoorVerdict.In, // the output basket, one grade at a time.
  'tick:applyDeconstructMachine:addItem#2': BagDoorVerdict.In, // every hopper line.
  'tick:applyDeconstructMachine:addItem#3': BagDoorVerdict.In, // the cargo bay of a boxed container.
  'tick:applyDeconstructMachine:addItem#4': BagDoorVerdict.In, // the dock's SEED shelf (door 8c).
  'tick:applyDeconstructMachine:addItem#5': BagDoorVerdict.In, // an orphaned bot's armful.
  'tick:applyDeconstructMachine:addItem#6': BagDoorVerdict.In, // and its seed pocket.
  'tick:applyLoadCart:removeItem': BagDoorVerdict.Out,
  'tick:applyLoadMachine:removeItem': BagDoorVerdict.Out, // into a container.
  'tick:applyLoadMachine:removeItem#2': BagDoorVerdict.Out, // into a hopper line.
  'tick:applyPlantTile:removeItem': BagDoorVerdict.Out,
  'tick:applyRefillHopper:removeItem': BagDoorVerdict.Out,
  'tick:applyRemoveBelt:addItem': BagDoorVerdict.In, // everything riding a belt taken up whole.
  'tick:applyRemoveBeltTile:addItem': BagDoorVerdict.In, // a 1-tile belt taken up whole.
  'tick:applyRemoveBeltTile:addItem#2': BagDoorVerdict.In, // and the goods a CUT frees. Two doors, one spelling.
  'tick:applyRemoveGrabber:addItem': BagDoorVerdict.In, // whatever was in the claw.
  'tick:applySellItem:removeItem': BagDoorVerdict.Out,
  'tick:applySwingScythe:addItem': BagDoorVerdict.In, // the produce off each tile the swing cut.
  'tick:applySwingScythe:addItem#2': BagDoorVerdict.In, // and each one-shot tile's seed.
  'tick:applyUnloadMachine:addItem': BagDoorVerdict.In, // a container's cargo bay.
  'tick:applyUnloadMachine:addItem#2': BagDoorVerdict.In, // the dock's PRODUCE shelf.
  'tick:applyUnloadMachine:addItem#3': BagDoorVerdict.In, // and its SEED shelf.
  'tick:applyUnloadMachine:addItem#4': BagDoorVerdict.In, // the output basket.
  'tick:applyUseRepairKit:removeItem': BagDoorVerdict.Out,
  'tick:clearFieldTileForMachine:addItem': BagDoorVerdict.In, // the ripe crop, lifted out by a placement or a till.
  'tick:clearFieldTileForMachine:addItem#2': BagDoorVerdict.In, // and the seed of whatever was growing.
  'tick:harvestOneTile:addItem': BagDoorVerdict.In, // the crop leaving the ground.
  'tick:harvestOneTile:addItem#2': BagDoorVerdict.In, // the replanting seed.
  'zones:replantOneTile:removeItem': BagDoorVerdict.Out,
};

// --- the ledger: how much of everything a world is holding, and how fresh -------------------

export interface GoodsHolding {
  count: number;
}

function hold(into: Map<ItemId, GoodsHolding>, item: ItemId | 0, count: number) {
  if (item === 0 || count <= 0) return;
  const had = into.get(item);
  if (had === undefined) into.set(item, { count });
  else had.count += count;
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
/**
 * **WHAT IS ACTUALLY IN A MACHINE'S BASKET, BY GRADE — DOOR 10 IN ONE FUNCTION.**
 *
 * Every other container in the game answers "what are you holding?" with a field. A basket
 * answers with a field, a spec, and a subtraction, and neither of the last two is in `WorldState`:
 *
 *   - `heldOutputItem` falls back to `MACHINE_SPECS[].outputItem` when the basket is unlabelled,
 *     so a machine can hold goods whose id is nowhere in the world at all.
 *   - `overcookedCount` of those units are not that id: they are the spec's
 *     `overcookOutputItem`, a different good with a different price, and the only trace of the
 *     change is a counter going up. `outputCount` does not move. `outputItem` does not move.
 *
 * The ledger read `machine.outputItem` and multiplied by `outputCount` for five items of this
 * family's history, which is why "a Fryer turned a PlainChips into a RusticStyleChips" produced
 * a delta reading "(nothing changed)". `nextOutputItem` and `takeOneOutput` in the sim have
 * always known this — burnt goes out first — so the sim was right and the instrument was blind,
 * which is the exact shape item 115's node sweep had and the exact shape item 117's census had.
 *
 */
export function basketGrades(
  machine: WorldState['machines'][number],
  spec: NonNullable<ReturnType<typeof machineSpec>>,
): { item: ItemId | 0; count: number }[] {
  const held = heldOutputItem(machine, spec);
  const burntItem = spec.overcookOutputItem;
  const burnt = burntItem === null ? 0 : Math.min(machine.overcookedCount, machine.outputCount);
  const grades: { item: ItemId | 0; count: number }[] = [
    { item: held, count: machine.outputCount - burnt },
  ];
  if (burntItem !== null && burnt > 0) grades.push({ item: burntItem, count: burnt });
  return grades;
}

/**
 * **UNITS THIS WORLD IS HOLDING THAT HAVE NO NAME**, as `path: count`, and it should always be
 * empty.
 *
 * `hold` drops anything whose id is 0, which is correct — a container at rest is an empty field
 * beside a zero — and would be a silent deletion the day a container held goods without saying
 * which. That is not hypothetical: `heldOutputItem` exists precisely because a basket CAN carry
 * `outputItem: 0` with `outputCount: 3`, and before item 118 the ledger read the raw field and
 * counted those three as nothing at all.
 *
 * So the guard is stated rather than assumed: every quantity on the census must have an id
 * beside it, and a container that breaks that is a hole in the books rather than a zero in them.
 *
 * **AND THE TYPES ALREADY DECIDE WHICH CONTAINERS CAN EVEN DO THIS**, which is worth writing down
 * because a non-incremental `tsc` is what said so. Four id fields are `ItemId | 0` — a basket, a
 * cargo bay, a seed shelf, a bot's two hands — and those four are checked below. The bag slot, the
 * belt rider and a contract's product are plain `ItemId`: they cannot be unnamed, the comparison
 * does not compile, and the first draft of this function had all three in it. A container that
 * changes its mind about that will fail to compile here rather than pass quietly.
 */
export function unnamedGoods(state: WorldState): string[] {
  const orphans: string[] = [];
  const note = (path: string, count: number) => {
    if (count > 0) orphans.push(`${path}: ${count} units with no item id`);
  };
  for (const machine of state.machines) {
    if (machine.cargoItem === 0) note('machines[].cargoItem', machine.cargoCount);
    if (machine.seedShelfItem === 0) note('machines[].seedShelfItem', machine.seedShelfCount);
    const spec = machineSpec(machine.kind);
    if (spec === null) {
      note('machines[].kind', machine.outputCount);
      continue;
    }
    for (const grade of basketGrades(machine, spec)) {
      if (grade.item === 0) note('machines[].outputItem', grade.count);
    }
  }
  for (const bot of state.bots) {
    if (bot.carryItem === 0) note('bots[].carryItem', bot.carryCount);
    if (bot.seedItem === 0) note('bots[].seedItem', bot.seedCount);
  }
  return orphans;
}

export function goodsLedger(state: WorldState): Map<ItemId, GoodsHolding> {
  const ledger = new Map<ItemId, GoodsHolding>();

  for (const slot of state.inventory) {
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
    hold(ledger, slot.item, slot.count - slot.boxes.length);
  }

  for (const machine of state.machines) {
    hold(ledger, machine.cargoItem, machine.cargoCount);
    hold(ledger, machine.seedShelfItem, machine.seedShelfCount);
    const spec = machineSpec(machine.kind);
    if (spec === null) {
      hold(ledger, machine.outputItem, machine.outputCount);
      continue;
    }
    for (const grade of basketGrades(machine, spec)) {
      hold(ledger, grade.item, grade.count);
    }
    const hoppers = machineHoppers(spec);
    for (let i = 0; i < hoppers.length; i++) {
      hold(ledger, hoppers[i]!.item, machine.inputCounts[i] ?? 0);
    }
  }

  for (const belt of state.belts) {
    for (const riding of belt.items) hold(ledger, riding.item, 1);
  }
  // The claw's `held` is a bare `number` rather than an `ItemId` — the one node in the sweep whose
  // field does not say "item", and the one whose type does not either.
  for (const grabber of state.grabbers) {
    hold(ledger, grabber.held as ItemId | 0, 1);
  }
  for (const bot of state.bots) {
    hold(ledger, bot.carryItem, bot.carryCount);
    hold(ledger, bot.seedItem, bot.seedCount);
  }
  for (const contract of state.contracts) {
    hold(ledger, contract.item, contract.stocked);
    hold(ledger, contract.item, contract.inTransit);
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

/**
 * **EVERY UNIT OF EVERYTHING, ADDED UP** — the number plan §4 is a sentence about.
 *
 * **IT IS A FLAT CONSERVATION LAW SINCE ITEM 124**, and it used to need an argument: one spoiled
 * unit made exactly one Compost, so the total survived a potato turning only because that ratio
 * was pinned. Nothing turns into anything now, so nothing can change this number but a genuine
 * creation or a genuine deletion — which is what it was always meant to measure.
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
    if (was === now) continue;
    parts.push(`item ${item}: ${was}→${now} units`);
  }
  return parts.length === 0 ? '(nothing changed)' : parts.join('; ');
}

// --- the third and fourth columns: where identity lives, and where the clocks are -------------

/**
 * **EVERY FIELD IN THE BALANCE DATA THAT NAMES A GOOD** — item 115's sweep, pointed at the other
 * half of the game.
 *
 * Item 115 walked a live `WorldState` and collected every field naming a good, on the principle
 * that *"a type is what somebody wrote down and a world is what is actually there"*. It was the
 * right principle and it had a blind side, which door 10 walked through: a good's id does not
 * have to be in the world. `MACHINE_SPECS[].overcookOutputItem` decides what `overcookedCount`
 * units of a Fryer's basket ARE, and it is in a table. No sweep of any world would ever find it.
 *
 * So this walks the balance module the same way, collecting every exported path whose key names
 * an item and whose value is an id. `move-census.test.ts` then makes somebody say a sentence
 * about each — specifically, whether it can RE-LABEL goods that already exist somewhere, which
 * is the only kind the ledger has to know about.
 *
 * Array indices collapse to `[]`, so one spec stands for all of them.
 */
export function dataItemFields(): string[] {
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
      // An id is a number or an explicit "this machine has no such grade". A field holding a
      // table is a table, whatever it is called — `FRESHNESS_TICKS_BY_ITEM` is not an id.
      if (/item$/i.test(key) && (typeof value === 'number' || value === null)) found.add(here);
      walk(value, here);
    }
  };

  for (const [name, value] of Object.entries(balance)) {
    if (typeof value === 'function') continue;
    walk(value, name);
  }
  return [...found].sort();
}

/**
 * **WHAT A DATA-BORNE ITEM ID DOES TO GOODS THAT ALREADY EXIST.**
 *
 * The census's two live instruments — the node sweep and the ledger — read the world. A data
 * field is invisible to both, so the question that decides whether that matters is narrow and
 * answerable: does this field change the identity of goods ALREADY SITTING IN A CONTAINER?
 */
export const DataIdentity = {
  /**
   * **RE-LABELS IN PLACE.** Units that exist, in a container, are silently a different good
   * because of this field. The ledger MUST read it or its books are wrong — door 10.
   */
  Relabels: 'relabels',
  /**
   * Names goods at the moment they are CREATED, and the container then records the id in a state
   * field the node sweep can see. The overwhelming majority, and harmless for that reason.
   */
  Mints: 'mints',
  /** Names goods a machine or a recipe CONSUMES. Nothing is re-labelled; something is eaten. */
  Consumes: 'consumes',
  /** A lookup key rather than a container's contents — a price row, a freshness row, a mapping. */
  Lookup: 'lookup',
} as const;
export type DataIdentity = (typeof DataIdentity)[keyof typeof DataIdentity];

/**
 * **EVERY DATA PATH THAT NAMES A GOOD, WITH THE SENTENCE IT IS HELD TO.** Keys are
 * `dataItemFields()` exactly, so the day somebody adds a second `overcookOutputItem` to a spec
 * this list goes red and the only way to green it is to say which of four sentences it is —
 * and `Relabels` drags `goodsLedger` in behind it.
 */
export const DATA_IDENTITY_VERDICTS: Readonly<Record<string, DataIdentity>> = {
  'BOXED_MACHINE_ROWS[].item': DataIdentity.Lookup, //   kind ↔ box. `boxLedger` weighs these.
  'CROP_SPECS[].seedItem': DataIdentity.Mints, //        a harvest hands a seed back.
  'EMPTIES_PER_DELIVERY[].item': DataIdentity.Lookup, // which delivered good this row is ABOUT.
  //                                                     A key, exactly like a price row: nothing
  //                                                     in a container is re-labelled by it, and
  //                                                     the soda it names has already been sold
  //                                                     and paid for by the time it is read.
  'EMPTIES_PER_DELIVERY[].returnsItem': DataIdentity.Mints, // and what comes home in its place
  //                                                     (item 131). A mint: `landEmpties` writes
  //                                                     this id straight onto `machines[].outputItem`,
  //                                                     which the node sweep can see and a save
  //                                                     carries — the harmless majority shape.
  'CROP_SPECS[].yieldItem': DataIdentity.Mints, //       the crop itself.
  'MACHINE_RECIPES[].recipes[].consumes[].item': DataIdentity.Consumes,
  'MACHINE_SPECS[].inputs[].item': DataIdentity.Consumes, //  which hopper line eats which good.
  //                                                     `MACHINE_HOPPERS` is not on this list and
  //                                                     does not need to be: it is `MACHINE_SPECS
  //                                                     .map(…)`, module-private, and every id in
  //                                                     it came from this row.
  'MACHINE_SPECS[].outputItem': DataIdentity.Mints, //   what a machine makes — AND the fallback
  //                                                     `heldOutputItem` reads when the basket is
  //                                                     unlabelled, which is why `basketGrades`
  //                                                     goes through that function rather than
  //                                                     reading `machine.outputItem` raw.
  'MACHINE_SPECS[].overcookOutputItem': DataIdentity.Relabels, // **DOOR 10. THE ONLY ONE.**
};

/**
 * **EVERY NUMBER IN A WORLD THAT THIS FIXTURE NEVER PUTS A VALUE IN**, by collapsed path.
 *
 * **THE ANSWER TO "ENFORCE THE CONVENTION OR REPLACE IT"**, and it replaces it. Nothing here
 * reads a field name: it walks the world, collects every numeric leaf, and reports the paths whose
 * every occurrence is zero. A clock called `pocketStaleness` lands on this list on the day it is
 * added, and the only ways off it are to fill it in the fixture — which hands `worldDiff` and the
 * zeroing sweep something real to be about — or to write down why a permanent zero is right.
 *
 * That is the same bargain `UNREACHED` strikes for the census rows, and it is strictly stronger
 * than a regex for the reason a regex cannot be: **it cannot be dodged by choosing a name**,
 * because it never looks at the name.
 */
export function unfilledNumbers(root: unknown): string[] {
  const filled = new Map<string, boolean>();
  const seen = new Set<object>();

  const walk = (node: unknown, collapsed: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, `${collapsed}[]`);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const here = collapsed === '' ? key : `${collapsed}.${key}`;
      if (typeof value === 'number') {
        filled.set(here, (filled.get(here) ?? false) || value !== 0);
      } else {
        walk(value, here);
      }
    }
  };

  walk(root, '');
  return [...filled.entries()]
    .filter(([, any]) => !any)
    .map(([path]) => path)
    .sort();
}

/**
 * **EVERY WAY TWO WORLDS DIFFER, BY PATH** — the save guard that needs no list at all.
 *
 * The item asked for a guard general enough that "a ninth clock field added tomorrow is covered
 * without anyone remembering to write a test". Every list-shaped answer to that fails the same
 * way: somebody has to add the field to the list. So the guard is not a list.
 *
 * `deserialize(serialize(state), state.trace)` is structurally IDENTICAL to `state` — measured,
 * every leaf, on a world with something in every container. So the guard is that sentence, and
 * it covers every field of every kind forever: clocks, counts, ids, dials, condition, the lot.
 * A ninth clock dropped from `toPayload` reads back as 0 against a fixture holding 1,234, and
 * this returns a line saying so with the path on it.
 *
 * **WHAT IT CANNOT DO ON ITS OWN, STATED HERE BECAUSE IT IS THE WHOLE OF THE REMAINING RISK:**
 * a field the fixture leaves at 0 round-trips as 0 whether it is carried or dropped. That is not
 * a hole in this function, it is the entire content of door 11 — five of eight clocks were
 * "unguarded" while an assertion about them existed, because nothing ever put a number in them.
 * `clockBearingPaths` above is the half that fixes THAT, by naming the fields the fixture has
 * left empty; the two together are the guard.
 */
export function worldDiff(before: unknown, after: unknown): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (a === b) return;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
      out.push(`${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
      return;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
      out.push(`${path}: one is an array and the other is not`);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) out.push(`${path}: length ${a.length} → ${b.length}`);
      for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b as object)]);
    for (const key of keys) {
      walk(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        path === '' ? key : `${path}.${key}`,
      );
    }
  };
  walk(before, after, '');
  return out;
}

/**
 * **ZERO ONE FIELD OF A SAVE AND SAY WHETHER ANYONE WOULD NOTICE**, the mutation sweep of door
 * 11 run as code rather than by hand.
 *
 * Wave 18's adversary ran 648 sim tests per mutant to answer this. It does not need 648: zeroing
 * a field in `toPayload` and zeroing it in the payload `toPayload` produced are the same act, so
 * the question "does the suite catch it" reduces to "does the restored world differ" — because
 * the round trip above asserts, in one line, that it does not.
 *
 * A payload that no longer PARSES counts as caught, and loudly: `fromPayload` validates, and a
 * throw is the most emphatic form of noticing there is.
 */
export function zeroingIsCaught(
  payload: unknown,
  path: readonly (string | number)[],
  restore: (payload: unknown) => unknown,
  compareTo: unknown,
): boolean {
  const mutant: unknown = JSON.parse(JSON.stringify(payload));
  let cursor: unknown = mutant;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = (cursor as Record<string | number, unknown>)[path[i]!];
    if (cursor === null || cursor === undefined) return false;
  }
  const last = path[path.length - 1]!;
  const holder = cursor as Record<string | number, unknown>;
  if (holder[last] === 0) return false;
  holder[last] = 0;
  try {
    return worldDiff(compareTo, restore(mutant)).length > 0;
  } catch {
    return true;
  }
}
