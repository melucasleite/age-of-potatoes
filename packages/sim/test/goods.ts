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
import {
  type WorldState,
  ItemId,
  freshnessTicks,
  heldOutputItem,
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
  /** The clock counting down beside this quantity, as a path, or null with a `clockless` reason. */
  readonly clock: string | null;
  /** Why this container keeps no clock. A REASON, never a bare `null` — see `MoveCheck`. */
  readonly clockless?: string;
  readonly pattern: RegExp;
}

export const GOODS_COUNTS: readonly GoodsCount[] = [
  {
    node: 'belts[].items[].item',
    quantity: 'items[]',
    identity: 'state',
    clock: 'belts[].items[].freshTicks',
    pattern: /\.items\.(?:push|splice|shift|pop|unshift)\(/,
  },
  {
    node: 'bots[].carryItem',
    quantity: 'carryCount',
    identity: 'state',
    clock: 'bots[].carryFreshTicks',
    pattern: /\.carryCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'bots[].seedItem',
    quantity: 'seedCount',
    identity: 'state',
    clock: null,
    clockless: 'a seed does not spoil; the pocket holds seeds and nothing else.',
    pattern: /\.seedCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'contracts[].item',
    quantity: 'stocked',
    identity: 'state',
    clock: 'contracts[].stockedFreshTicks',
    pattern: /\.stocked\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'contracts[].item',
    quantity: 'inTransit',
    identity: 'state',
    clock: 'contracts[].inTransitFreshTicks',
    pattern: /\.inTransit\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'grabbers[].held',
    quantity: 'held',
    identity: 'state',
    clock: 'grabbers[].heldFreshTicks',
    pattern: /\.held\s*=[^=]/,
  },
  {
    node: 'inventory[].item',
    quantity: 'count',
    identity: 'state',
    clock: 'inventory[].stacks[].spoilAtTick',
    pattern: /\.count\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'inventory[].item',
    quantity: 'stacks[]',
    identity: 'state',
    clock: 'inventory[].stacks[].spoilAtTick',
    pattern: /\.stacks\.(?:push|splice|shift|pop|unshift)\(/,
  },
  {
    node: 'machines[].cargoItem',
    quantity: 'cargoCount',
    identity: 'state',
    clock: 'machines[].cargoFreshTicks',
    pattern: /\.cargoCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'machines[].outputItem',
    quantity: 'outputCount',
    identity: 'state',
    clock: 'machines[].outputFreshTicks',
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
    clock: null,
    clockless:
      'every overcooked grade is shelf-stable, which is what `machineOutputFreshness` means ' +
      'when it hands a burnt unit a zero rather than the basket’s clock.',
    pattern: /\.overcookedCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    node: 'machines[].seedShelfItem',
    quantity: 'seedShelfCount',
    identity: 'state',
    clock: null,
    clockless: 'a dock’s seed shelf holds seeds, and a seed does not spoil.',
    pattern: /\.seedShelfCount\s*(?:[-+*/]?=[^=]|\+\+|--)/,
  },
  {
    // A hopper line has no id field of its own — which line holds which good is `machineHoppers`,
    // and that is data. Harmless, and worth writing down anyway: it is the same shape as door 10
    // with the sting taken out, because a hopper line can only ever hold the one good.
    node: 'machines[].inputCounts',
    quantity: 'inputCounts[]',
    identity: 'MACHINE_SPECS[].inputs[].item',
    clock: 'machines[].inputFreshTicks[]',
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

// --- the clock doors: every line that HANDS a clock to a container ---------------------------

/**
 * **THE PRIMITIVES THAT TAKE A CLOCK AND WRITE IT INTO A CONTAINER.**
 *
 * Every one of these has a clock as its last parameter, and every one of them is a place where
 * the caller — not the primitive — decides what that clock is. `mergedFreshness`,
 * `machineOutputFreshness` and `spoilTickFromRemaining` are deliberately NOT here: they compute a
 * clock and write nothing, so they cannot be the place a window gets minted.
 */
const CLOCK_DOOR_PRIMITIVES = [
  'addItemFresh',
  'beltInsert',
  'depotAccept',
  'placeOnFace',
  'putHopper',
  'putStorage',
] as const;

/** The doors' own bodies call each other; that plumbing is the door, not a user of it. */
const CLOCK_DOOR_PLUMBING = new Set<string>([...CLOCK_DOOR_PRIMITIVES, 'addItem']);

/** Index just past the `)` matching the `(` at `open`. */
function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The last top-level argument of a call, with Prettier's trailing comma discarded.
 *
 * The trailing comma is why this is not a `split(',')`: `addItemFresh(state, item, 1, f(a, b),)`
 * has an empty final segment, and the argument wanted is the one before it — sliced to the NEXT
 * cut rather than to the end, or the discarded comma comes back on the answer.
 */
function lastArgument(inner: string): string {
  const cuts: number[] = [];
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) cuts.push(i);
  }
  const bounds = [...cuts, inner.length];
  for (let i = bounds.length - 1; i >= 0; i--) {
    const from = i === 0 ? 0 : cuts[i - 1]! + 1;
    const candidate = inner.slice(from, bounds[i]).trim();
    if (candidate !== '') return candidate.replace(/\s+/g, ' ');
  }
  return inner.trim().replace(/\s+/g, ' ');
}

/**
 * **EVERY PLACE IN THE SIM WHERE A CLOCK CROSSES A TRANSFER**, as
 * `file:function:door(the clock it hands over)`, sorted. **THE FOURTH COLUMN, EXECUTED.**
 *
 * `bagDoors()` above exists because the BAG's clock is chosen by which function you call rather
 * than by an argument you pass, so the doors had to be enumerated BY CALLER. Item 119 is the
 * discovery that this was never the bag's peculiarity at all — it is every container's. A hopper,
 * a belt, a basket and a depot floor all take their clock as an ARGUMENT, and an argument is
 * chosen at a CALL SITE that the quantity census cannot see:
 *
 *   - `MOVE_VERDICTS` is keyed by the function that writes the COUNT. `grabberDeliver` writes no
 *     count at all — it calls `putHopper`, and the row for that is `state:putHopper:inputCounts[]`,
 *     which the hand's `applyLoadMachine` also drives. Drive it once from the hand and the row is
 *     "covered" while the claw's clock argument has never been looked at.
 *   - The four doors item 119 was filed for all sat under a comment reading
 *     `// --- belts and arms (item 112 clocked all four) ---`, marked `Conserving`, annotated
 *     `CLOCK: heldFreshTicks`. Every word of that was true and none of it ran.
 *
 * **KEYED BY THE CLOCK EXPRESSION, NOT BY THE LINE.** A line number rots on the next edit, and a
 * `file:function:door` key collapses four different transfers: `applyDeconstructMachine` hands
 * `addItemFresh` the basket's clock, then each hopper's, then the cargo bay's, then the bot's
 * armful — four windows, four chances to mint one, one key. So the key carries the expression,
 * which is stable under formatting, unique per container, and says in the key itself WHICH clock
 * is crossing. It is deliberately brittle in one direction: rename the local and this list goes
 * red, which for this family is the feature rather than the cost.
 */
export function clockDoors(): string[] {
  const found: string[] = [];
  // **A SECOND CALL SITE SPELLED IDENTICALLY IS A SECOND DOOR**, and this is the line that says
  // so. `applyRemoveBeltTile` hands `entry.freshTicks` to `addItemFresh` twice — once for a
  // 1-tile belt taken up whole, once for the goods freed by a cut — and the mutation sweep of
  // item 119 caught the second and not the first. Collapsed to one key, adding a third would
  // change nothing at all; numbered, it goes red and somebody has to say what it is. The first
  // occurrence keeps the bare key so an addition does not rename its neighbour.
  const seen = new Map<string, number>();
  const add = (key: string): void => {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    found.push(n === 1 ? key : `${key}#${n}`);
  };
  for (const [label, path] of sourceFiles(SRC)) {
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    const owners = enclosingFunctions(lines);
    // Where each line starts inside `text`, so a call can be read across line breaks.
    const offsets: number[] = [];
    let run = 0;
    for (const line of lines) {
      offsets.push(run);
      run += line.length + 1;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      if (/^\s*(?:export )?function /.test(line)) continue;
      const owner = owners[i]!;
      if (CLOCK_DOOR_PLUMBING.has(owner)) continue;
      for (const door of CLOCK_DOOR_PRIMITIVES) {
        const call = new RegExp(`(?<![A-Za-z0-9_.])${door}\\(`).exec(line);
        if (call === null) continue;
        const open = offsets[i]! + call.index + door.length;
        const close = matchingParen(text, open);
        if (close < 0) continue;
        add(`${label}:${owner}:${door}(${lastArgument(text.slice(open + 1, close))})`);
      }
    }
  }
  return [...found].sort();
}

/**
 * **EVERY PLACE A CLOCK IS WRITTEN STRAIGHT ONTO A CONTAINER**, as
 * `file:function:field = the clock it is given`, sorted — the other half of `clockDoors()`.
 *
 * A clock arrives in a container one of exactly two ways: it is handed to a door primitive, or it
 * is assigned to the field directly. The first half missed four of the nine crossings item 119's
 * sweep found unguarded, and all four were assignments — `grabberSource` setting the claw's clock
 * from a dock shelf and from a machine basket, `takeDockShelf` repairing a clock that was never
 * written down, and `applyLoadCart` loading a delivery cart. A census of one half is a list.
 *
 * The door primitives' own bodies are excluded for the reason `bagDoors()` excludes its own: the
 * line inside `putStorage` that writes `cargoFreshTicks` IS the `putStorage(freshTicks)` door
 * already on the other list, and counting it twice would mean two rows for one decision.
 *
 * Compound assignment is not a crossing and is not matched: `freshTicks -= 1` is a clock being
 * SPENT, which is the sim doing its job, and `\s*=` will not match the `-` in front of it.
 */
export function clockWrites(): string[] {
  const found: string[] = [];
  const seen = new Map<string, number>();
  for (const [label, path] of sourceFiles(SRC)) {
    const lines = readFileSync(path, 'utf8').split('\n');
    const owners = enclosingFunctions(lines);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      const owner = owners[i]!;
      if (CLOCK_DOOR_PLUMBING.has(owner)) continue;
      const write = /\.([A-Za-z0-9_]*(?:[Ff]reshTicks|[Ss]poilAtTick))\s*=([^=].*)$/.exec(line);
      if (write === null) continue;
      // A multi-line right-hand side is reported by its opening call, spelled `f(…)`: the census
      // wants one row per decision, and a decision spread over four lines is still one.
      const given = write[2]!
        .trim()
        .replace(/;\s*$/, '')
        .replace(/\s+/g, ' ')
        .replace(/\($/, '(…)');
      const key = `${label}:${owner}:${write[1]} = ${given}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      found.push(n === 1 ? key : `${key}#${n}`);
    }
  }
  return [...found].sort();
}

/** Both halves of the clock census, which is the whole of it: every clock crossing in the sim. */
export function clockCrossings(): string[] {
  return [...clockDoors(), ...clockWrites()].sort();
}

/**
 * **WHAT A CALL SITE DOES TO THE CLOCK IT HANDS OVER.**
 *
 * `MOVE_VERDICTS` is about the COUNT and `BAG_DOOR_VERDICTS` is about the bag's WINDOW. This is
 * the same question as the second, asked of every other container — and it is the column item 112
 * wrote as a comment (`CLOCK: heldFreshTicks`) and nobody executed.
 */
export const ClockDoorVerdict = {
  /** Hands over the clock the goods came out of. What every transfer between containers owes. */
  Carries: 'carries',
  /** A full window, because the goods genuinely did not exist a moment ago. A judgement. */
  MintsNew: 'mints-new',
  /** The goods keep no clock, so what is handed over cannot matter. Falsifiable: check them. */
  MintsShelfStable: 'mints-shelf-stable',
  /**
   * Repairs a clock that was never written down — a save old enough to predate the field. The
   * value handed over is a full window BY DESIGN, and pessimistically: the goods are treated as
   * having just arrived because nothing recorded when they really did.
   */
  Grandfathers: 'grandfathers',
  /**
   * **PUTS A CLOCK BACK TO ZERO BECAUSE THERE IS NOTHING LEFT TO COUNT** — a container emptied, a
   * claw opened, a route paid out. Not a mint and not a carry: zero means "no opinion" everywhere
   * in this game, and an empty shelf is entitled to have none.
   *
   * Listed rather than filtered out, on item 115's rule: a census that exempts a shape is a list
   * again, and "it only ever writes zero" is exactly the sentence a mint would like to hide behind.
   */
  Clears: 'clears',
  /** Copies a clock outward into a render buffer. The world is not touched. */
  Projection: 'projection',
} as const;
export type ClockDoorVerdict = (typeof ClockDoorVerdict)[keyof typeof ClockDoorVerdict];

/**
 * **EVERY CLOCK CROSSING IN THE SIM, WITH THE SENTENCE IT IS HELD TO.** Keys are
 * `clockCrossings()` exactly, so this is the ONE list rather than a second one beside it.
 *
 * **THIS TABLE IS ITEM 119, AND THE REASON IT EXISTS IS THAT ITS PREDECESSOR WAS PROSE.** Item
 * 112 clocked four transfers and wrote `CLOCK: heldFreshTicks` beside each of them in a `//`
 * comment on `MOVE_VERDICTS`. Item 118 added a `clock` column to `GOODS_COUNTS` and it was read in
 * exactly two places, both set-membership over field NAMES. Between them, nine crossings could be
 * reverted to a literal `0` with all 1,544 tests green — measured, at HEAD `5ce5175`, by the sweep
 * in `scripts/clock-mutation-sweep.py`.
 *
 * A literal `0` is the faithful revert and a `+1` is not, which is worth keeping because the first
 * mutant tried was the wrong one: `FRESHNESS_BUCKET_TICKS` is 300, so a one-tick nudge is
 * legitimately absorbed, while `mergedFreshness` and `addItemFresh` both read 0 as "no opinion"
 * and answer with a FULL window. **These lines do not lose time when they break. They mint it.**
 */
export const CLOCK_CROSSING_VERDICTS: Readonly<Record<string, ClockDoorVerdict>> = {
  // --- belts and arms: the four item 112 clocked, and the two beside them nobody had counted ---
  'belts:advanceGrabber:heldFreshTicks = 0': ClockDoorVerdict.Clears, // the claw let go.
  'belts:advanceJunction:placeOnFace(head.freshTicks)': ClockDoorVerdict.Carries, // belt → face.
  'belts:grabberDeliver:beltInsert(grabber.heldFreshTicks)': ClockDoorVerdict.Carries,
  'belts:grabberDeliver:depotAccept(grabber.heldFreshTicks)': ClockDoorVerdict.Carries,
  'belts:grabberDeliver:putHopper(grabber.heldFreshTicks)': ClockDoorVerdict.Carries, // claw →
  //                                                        hopper. **ONE OF THE NINE.** Its own
  //                                                        comment reads "This line used to pass a
  //                                                        literal 0"; put the 0 back and, until
  //                                                        item 119, nothing objected.
  'belts:grabberDeliver:putStorage(grabber.heldFreshTicks)': ClockDoorVerdict.Carries,
  'belts:grabberSource:heldFreshTicks = 0': ClockDoorVerdict.Clears, // a seed shelf: no clock.
  'belts:grabberSource:heldFreshTicks = entry.freshTicks': ClockDoorVerdict.Carries, // ← a belt.
  'belts:grabberSource:heldFreshTicks = freshTicks': ClockDoorVerdict.Carries, // ← a machine's
  //                                                        output basket. **ONE OF THE NINE**, and
  //                                                        one the item was not filed for: this
  //                                                        function has four take-paths, and the
  //                                                        belt and the cellar were guarded while
  //                                                        the basket and the dock shelf were not.
  'belts:grabberSource:heldFreshTicks = took.freshTicks': ClockDoorVerdict.Carries, // ← a dock's
  //                                                        produce shelf. **ONE OF THE NINE.**
  'belts:grabberSource:heldFreshTicks = took.freshTicks#2': ClockDoorVerdict.Carries, // ← storage.
  'belts:handOffFromHead:beltInsert(head.freshTicks)': ClockDoorVerdict.Carries, // belt → belt.
  //                                                        **ONE OF THE NINE**, and its comment
  //                                                        predicted the exploit in so many words:
  //                                                        "the fix would be defeated by laying
  //                                                        belt in short pieces".
  // --- bots ---
  'bots:harvestUnderBot:carryFreshTicks = 0': ClockDoorVerdict.Clears, // the seed pocket.
  'bots:harvestUnderBot:carryFreshTicks = mergedFreshness(bot.carryCount, bot.carryFreshTicks, result.item, 0)':
    ClockDoorVerdict.MintsNew, //                           GROUND → arms: the crop did not exist a
  //                                                        moment ago, and 0 asks for a full
  //                                                        window merged against the armful.
  'bots:unloadIntoDock:cargoFreshTicks = mergedFreshness(…)': ClockDoorVerdict.Carries, // arms →
  //                                                        shelf, at the sooner of the two.
  'bots:unloadIntoDock:carryFreshTicks = 0': ClockDoorVerdict.Clears, // the arms are empty now.
  // --- commerce ---
  'commerce:advanceCart:cargoFreshTicks = 0': ClockDoorVerdict.Clears, // the cart sold its load.
  'commerce:advanceContract:inTransitFreshTicks = 0': ClockDoorVerdict.Clears, // the lorry paid out.
  'commerce:advanceContract:inTransitFreshTicks = contract.stockedFreshTicks':
    ClockDoorVerdict.Carries, //                            floor → lorry.
  'commerce:advanceContract:stockedFreshTicks = 0': ClockDoorVerdict.Clears, // the floor is bare.
  'commerce:refundContract:addItemFresh(spoilTickFromRemaining(state, contract.inTransitFreshTicks))':
    ClockDoorVerdict.Carries, //                            a torn-up route hands the lorry back.
  'commerce:refundContract:addItemFresh(spoilTickFromRemaining(state, contract.stockedFreshTicks))':
    ClockDoorVerdict.Carries, //                            and the floor.
  'commerce:refundContract:inTransitFreshTicks = 0': ClockDoorVerdict.Clears,
  'commerce:refundContract:stockedFreshTicks = 0': ClockDoorVerdict.Clears,
  // --- the primitives' own take-doors ---
  'state:takeDockShelf:cargoFreshTicks = 0': ClockDoorVerdict.Clears, // shelf emptied.
  'state:takeDockShelf:cargoFreshTicks = freshnessTicks(item)': ClockDoorVerdict.Grandfathers,
  'state:takeOneOutput:outputFreshTicks = 0': ClockDoorVerdict.Clears, // basket emptied.
  'state:takeStorage:cargoFreshTicks = 0': ClockDoorVerdict.Clears, // container emptied.
  'state:takeStorage:cargoFreshTicks = freshnessTicks(item)': ClockDoorVerdict.Grandfathers,
  // --- the tick's own ---
  'tick:advanceBeltSpoilage:freshTicks = 0': ClockDoorVerdict.Clears, // it turned to compost.
  'tick:advanceBotSpoilage:carryFreshTicks = 0': ClockDoorVerdict.Clears, // ditto, in the arms.
  'tick:advanceOrchard:outputFreshTicks = mergedFreshness(…)': ClockDoorVerdict.MintsNew, // a tree
  //                                                        makes fruit out of time.
  'tick:advanceStorageSpoilage:cargoFreshTicks = 0': ClockDoorVerdict.Clears,
  'tick:applyDeconstructMachine:addItemFresh(spoilTickFromRemaining(state, bot.carryFreshTicks))':
    ClockDoorVerdict.Carries, //                            boxing a dock with a bot mid-errand.
  'tick:applyDeconstructMachine:addItemFresh(spoilTickFromRemaining(state, freshTicks))':
    ClockDoorVerdict.Carries, //                            **ONE OF THE NINE**: the output BASKET
  //                                                        on boxing. Its twin at `applyUnload`
  //                                                        has two tests; this one had none, and
  //                                                        the scenario that "covered" the verb
  //                                                        boxed a starved Seasoner whose basket
  //                                                        was empty.
  'tick:applyDeconstructMachine:addItemFresh(spoilTickFromRemaining(state, machine.cargoFreshTicks))':
    ClockDoorVerdict.Carries, //                            the cargo bay.
  'tick:applyDeconstructMachine:addItemFresh(spoilTickFromRemaining(state, took.freshTicks))':
    ClockDoorVerdict.Carries, //                            every hopper line.
  'tick:applyDeconstructMachine:cargoFreshTicks = 0': ClockDoorVerdict.Clears,
  'tick:applyLoadCart:cargoFreshTicks = mergedCargoFreshnessForCart(cart, count, command.item, freshTicks)':
    ClockDoorVerdict.Carries, //                            **ONE OF THE NINE**: bag → delivery
  //                                                        cart. A cart never SPENDS its clock, so
  //                                                        nothing about the cart itself could
  //                                                        show the loss — the door this closes is
  //                                                        the way back out, when the cart is boxed.
  'tick:applyLoadMachine:putHopper(freshTicks)': ClockDoorVerdict.Carries, // hand → hopper.
  'tick:applyLoadMachine:putStorage(freshTicks)': ClockDoorVerdict.Carries, // hand → container.
  'tick:applyPackCrate:addItemFresh(deadline)': ClockDoorVerdict.MintsNew, // **A CRATE IS THE ONE
  //                                                        DOOR ALLOWED TO LENGTHEN A WINDOW**, and
  //                                                        it is a bought good doing it. Guarded in
  //                                                        the sim rather than here: the verb
  //                                                        refuses when the deadline it would grant
  //                                                        is no later than the one already held.
  'tick:applyRemoveBelt:addItemFresh(spoilTickFromRemaining(state, entry.freshTicks))':
    ClockDoorVerdict.Carries, //                            a whole belt run hands its riders back.
  'tick:applyRemoveBeltTile:addItemFresh(spoilTickFromRemaining(state, entry.freshTicks))':
    ClockDoorVerdict.Carries, //                            **ONE OF THE NINE**: the branch that
  //                                                        takes up a ONE-TILE belt whole. Its
  //                                                        neighbour below — the goods freed by
  //                                                        cutting a longer run — is the same line
  //                                                        of code twice and was already covered,
  //                                                        which is why these two keys are
  //                                                        numbered rather than collapsed.
  'tick:applyRemoveBeltTile:addItemFresh(spoilTickFromRemaining(state, entry.freshTicks))#2':
    ClockDoorVerdict.Carries,
  'tick:applyRemoveGrabber:addItemFresh(spoilTickFromRemaining(state, grabber.heldFreshTicks))':
    ClockDoorVerdict.Carries, //                            whatever the arm was holding.
  'tick:applyUnloadMachine:addItemFresh(spoilTickFromRemaining(state, freshTicks))':
    ClockDoorVerdict.Carries, //                            the basket, by hand.
  'tick:applyUnloadMachine:addItemFresh(spoilTickFromRemaining(state, took.freshTicks))':
    ClockDoorVerdict.Carries, //                            a hopper line, by hand.
  'tick:applyUnloadMachine:addItemFresh(spoilTickFromRemaining(state, took.freshTicks))#2':
    ClockDoorVerdict.Carries, //                            the cargo bay, by hand.
  'tick:produceRecipe:outputFreshTicks = mergedFreshness(…)': ClockDoorVerdict.MintsNew, // §4's
  //                                                        "processing IS preservation": the output
  //                                                        is a NEW good with a new window.
  // --- the projection, which moves nothing ---
  'view:projectCommerce:stockedFreshTicks = contract.stockedFreshTicks':
    ClockDoorVerdict.Projection,
};

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
  'state:takeOneOutput:overcookedCount': MoveVerdict.Conserving, // **the SAME door, counted on the
  //                                                         burnt side.** One pull decrements
  //                                                         both numbers, and it is one transfer:
  //                                                         `nextOutputItem` hands the burnt grade
  //                                                         over first, so the unit that leaves is
  //                                                         a RusticStyleChips and the basket is
  //                                                         one lighter in both books.
  'state:takeStorage:cargoCount': MoveVerdict.Conserving, //  container → out. CLOCK: returned
  // --- the tick's own transfers ---
  'tick:advanceBotSpoilage:carryCount': MoveVerdict.Transform, // armful → Compost.
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
  'view:projectMachines:overcookedCount': MoveVerdict.Projection, // the burnt count reaches the
  //                                                         HUD, which is how a player sees a
  //                                                         basket going rustic without opening it.
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
  /**
   * **ONE ENTRY PER UNIT, AND THIS IS THE FIELD ITEM 118 EXISTS FOR.**
   *
   * `soonest` above is a MINIMUM, and a minimum is a hiding place. Wave 18's adversary measured
   * it: a world holding the same item at 4,321 ticks and at 1,111, delete the 4,321 entirely, and
   * `ledgerDelta` reports "(nothing changed)" — the count check is per item and the clock check
   * takes the min, so a whole holder can be deleted behind a sooner one and both instruments
   * agree that nothing happened.
   *
   * A multiset cannot hide anything. Ascending, one entry per UNIT rather than per holder, so
   * "five potatoes at 4,321" and "one potato at 4,321" are different worlds — which they are.
   */
  clocks: number[];
}

function hold(into: Map<ItemId, GoodsHolding>, item: ItemId | 0, count: number, ticks: number) {
  if (item === 0 || count <= 0) return;
  const had = into.get(item);
  if (had === undefined) {
    into.set(item, { count, soonest: ticks, clocks: new Array<number>(count).fill(ticks) });
    return;
  }
  had.count += count;
  for (let i = 0; i < count; i++) had.clocks.push(ticks);
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
 * A BURNT UNIT CARRIES NO CLOCK, and that is `machineOutputFreshness`' rule rather than a choice
 * made here: every overcooked grade is shelf-stable, so the basket's clock is not about it.
 */
export function basketGrades(
  machine: WorldState['machines'][number],
  spec: NonNullable<ReturnType<typeof machineSpec>>,
): { item: ItemId | 0; count: number; freshTicks: number }[] {
  const held = heldOutputItem(machine, spec);
  const burntItem = spec.overcookOutputItem;
  const burnt = burntItem === null ? 0 : Math.min(machine.overcookedCount, machine.outputCount);
  const grades: { item: ItemId | 0; count: number; freshTicks: number }[] = [
    { item: held, count: machine.outputCount - burnt, freshTicks: machine.outputFreshTicks },
  ];
  if (burntItem !== null && burnt > 0) {
    const window = freshnessTicks(burntItem);
    grades.push({
      item: burntItem,
      count: burnt,
      freshTicks: window > 0 ? machine.outputFreshTicks : 0,
    });
  }
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
    hold(ledger, machine.seedShelfItem, machine.seedShelfCount, 0);
    const spec = machineSpec(machine.kind);
    if (spec === null) {
      hold(ledger, machine.outputItem, machine.outputCount, machine.outputFreshTicks);
      continue;
    }
    for (const grade of basketGrades(machine, spec)) {
      hold(ledger, grade.item, grade.count, grade.freshTicks);
    }
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

/**
 * **EVERY CLOCK ON ONE ITEM, ONE PER UNIT, ASCENDING** — `ledgerClock` without the hiding place.
 *
 * Use this wherever the question is "did anything happen to the goods", and `ledgerClock` only
 * where the question is genuinely about the next thing to turn. A minimum answers the second
 * question and quietly declines the first.
 */
export function ledgerClocks(ledger: Map<ItemId, GoodsHolding>, item: ItemId): number[] {
  return [...(ledger.get(item)?.clocks ?? [])].sort((a, b) => a - b);
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
    // **EVERY CLOCK, NOT THE SOONEST ONE** (item 118). The old line compared `ledgerClock`, which
    // is a minimum over holders, so deleting a holder at 4,321 while another sat at 1,111 printed
    // "(nothing changed)" — measured, in those numbers, by wave 18's adversary. A delta that can
    // say "nothing" about a deleted holder is the failure this whole family keeps having.
    const wasClocks = ledgerClocks(before, item);
    const nowClocks = ledgerClocks(after, item);
    if (was === now && wasClocks.join(',') === nowClocks.join(',')) continue;
    parts.push(
      `item ${item}: ${was}→${now} units, clocks [${wasClocks.join(',')}]→[${nowClocks.join(',')}]`,
    );
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
  'CROP_SPECS[].dayOldItem': DataIdentity.Mints, //      a turned tile yields a different good —
  //                                                     but the pull writes `carryItem`, so the
  //                                                     id is in the world before anything holds
  //                                                     it. That is door 9's fix, seen from here.
  'CROP_SPECS[].seedItem': DataIdentity.Mints, //        a harvest hands a seed back.
  'CROP_SPECS[].yieldItem': DataIdentity.Mints, //       the crop itself.
  'FRESHNESS_TICKS_BY_ITEM[].item': DataIdentity.Lookup, // a row key, not a container.
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
 * **EVERY CLOCK IN A WORLD, BY PATH** — the fourth column, swept rather than listed.
 *
 * The second of two independent nets over the same question, and they are independent on
 * purpose. `GOODS_COUNTS[].clock` hangs the clock list off the CONTAINER list, so a new container
 * cannot arrive without somebody naming its clock; this hangs it off the NAMING CONVENTION, so a
 * new clock cannot be added to an EXISTING container without showing up either. Item 115 shipped
 * one net and item 117 found three holes in it.
 *
 * Values, not just paths: the save sweep needs to know which of these the fixture actually
 * exercises, because zeroing a field that was already zero proves nothing at all.
 */
export interface ClockSite {
  /** The field with array indices collapsed to `[]` — one entry per FIELD, not per machine. */
  readonly collapsed: string;
  /** The concrete route to this one occurrence, for a sweep that wants to mutate it. */
  readonly path: (string | number)[];
  readonly value: number;
}

/**
 * Takes `unknown` rather than `WorldState` on purpose: it is run over a live world AND over the
 * save payload, and comparing the two answers is a third net. A clock that exists in the world
 * and has no field in the payload was never serialized at all, and the sets differ by its name.
 */
export function clockBearingPaths(root: unknown): ClockSite[] {
  const found: ClockSite[] = [];
  const seen = new Set<object>();

  const walk = (node: unknown, collapsed: string, path: (string | number)[]): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${collapsed}[]`, [...path, i]);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const here = collapsed === '' ? key : `${collapsed}.${key}`;
      const route = [...path, key];
      if (typeof value === 'number') {
        if (isClockKey(key)) found.push({ collapsed: here, path: route, value });
      } else if (Array.isArray(value) && isClockKey(key)) {
        // A clock can be an ARRAY of clocks — `inputFreshTicks` is one per hopper line — and a
        // walker that only looked at scalars would miss the field door 11 measured as guarded by
        // exactly one test.
        for (let i = 0; i < value.length; i++) {
          const entry: unknown = value[i];
          if (typeof entry === 'number') {
            found.push({ collapsed: `${here}[]`, path: [...route, i], value: entry });
          }
        }
      } else {
        walk(value, here, route);
      }
    }
  };

  walk(root, '', []);
  return found;
}

/** The clock sweep's fields, one entry each, with how many occurrences the fixture actually filled. */
export function clockFieldCoverage(root: unknown): Map<string, { filled: number; total: number }> {
  const coverage = new Map<string, { filled: number; total: number }>();
  for (const site of clockBearingPaths(root)) {
    const had = coverage.get(site.collapsed) ?? { filled: 0, total: 0 };
    had.total += 1;
    if (site.value !== 0) had.filled += 1;
    coverage.set(site.collapsed, had);
  }
  return coverage;
}

/**
 * The naming convention this codebase actually uses for "how long these goods have left".
 *
 * **AND A NAMING CONVENTION IS EXACTLY AS GOOD AS ITS ENFORCEMENT**, which until item 119 was
 * none. A clock called `pocketStaleness` is invisible to this regex, so it would be invisible to
 * `clockBearingPaths`, to `clockFieldCoverage`, and to the save sweep that zeroes each clock in
 * turn — and it could be dropped from `toPayload` entirely with the whole suite green.
 *
 * `worldDiff` is genuinely name-blind and would catch it, but only when the fixture puts a NUMBER
 * in it: a field left at 0 round-trips as 0 whether it is carried or dropped. So the enforcement
 * is not a better regex — a regex can always be dodged by choosing another name — it is
 * `unfilledNumbers` below, which does not read names at all.
 */
function isClockKey(key: string): boolean {
  return /freshticks$/i.test(key) || /spoilattick$/i.test(key);
}

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
