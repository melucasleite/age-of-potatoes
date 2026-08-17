// **THE CENSUS OF CLOCKS, AND THE BOOKKEEPING THAT STOPS IT BECOMING PROSE** (item 119).
//
// Five items of this family found the instrument one column to the left of the bug. Item 119
// found a column that was added, labelled, and never wired up:
//
//   - Item 112 clocked four transfers and wrote `CLOCK: heldFreshTicks` beside each of them, in a
//     `//` comment, on rows marked `Conserving`.
//   - Item 118 gave `GOODS_COUNTS` a `clock` column. It is read in exactly two places and both
//     are set-membership over field NAMES.
//   - `MoveVerdict.Conserving` documents itself as *"no clock comes out larger than it went in"*
//     and the live harness checks exactly that — against a whole-world LEDGER, which is the right
//     instrument for "nothing vanished" and the wrong one for "which call site minted".
//
// A whole-world ledger cannot see a mint at one call site when another door already drives the
// row: `MOVE_VERDICTS` is keyed by the function that writes the COUNT, and `grabberDeliver`
// writes no count at all — it calls `putHopper`, whose row the player's own hand also drives.
// Drive it once from the hand and the row is covered while the claw's clock argument has never
// been looked at once.
//
// So the census here is keyed by the CALL SITE and the clock expression it hands over, and this
// file holds it to three properties: every crossing is classified, every crossing that claims to
// carry a clock is driven against a live world, and the driving is spread across enough files
// that no single deletion can quietly disarm it.

import { describe, expect, it } from 'vitest';

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CLOCK_CROSSINGS } from './clock-crossings';
import { CLOCK_CROSSING_VERDICTS, ClockDoorVerdict, clockCrossings } from './goods';

const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));

/**
 * **THE NINE CROSSINGS THAT COULD BE REVERTED TO A LITERAL `0` WITH THE SUITE GREEN**, measured
 * at HEAD `5ce5175` by `scripts/clock-mutation-sweep.py` over all 32 clock-bearing arguments in
 * the sim: 23 caught, nine not.
 *
 * Item 119 was filed for four of them. The other five are what the same sweep found when it was
 * run at CALL-SITE granularity instead of per function — including two inside `grabberSource`,
 * which has four take-paths and had a belt and a cellar guarded while the machine basket and the
 * dock shelf beside them were not. That is this family's signature exactly: the same function,
 * adjacent lines, half of it fixed.
 *
 * Pinned by name rather than counted, so deleting the scenario that drives one of them fails HERE
 * with the name of the door in the message, rather than somewhere downstream as a number.
 */
const THE_NINE: readonly string[] = [
  'belts:advanceJunction:placeOnFace(head.freshTicks)',
  'belts:grabberDeliver:putHopper(grabber.heldFreshTicks)',
  'belts:grabberSource:heldFreshTicks = freshTicks',
  'belts:grabberSource:heldFreshTicks = took.freshTicks',
  'belts:handOffFromHead:beltInsert(head.freshTicks)',
  'state:takeDockShelf:cargoFreshTicks = freshnessTicks(item)',
  'tick:applyDeconstructMachine:addItemFresh(spoilTickFromRemaining(state, freshTicks))',
  'tick:applyLoadCart:cargoFreshTicks = mergedCargoFreshnessForCart(cart, count, command.item, freshTicks)',
  'tick:applyRemoveBeltTile:addItemFresh(spoilTickFromRemaining(state, entry.freshTicks))',
];

/**
 * **CROSSINGS THAT CARRY A CLOCK AND HAVE NO SCENARIO HERE — WITH THE REASON, IN WRITING.**
 *
 * Every one of these was already caught by the suite as it stood, and that is a MEASUREMENT
 * rather than a hope: `scripts/clock-mutation-sweep.py` replaced each of them with a literal 0 at
 * HEAD `5ce5175` and every one turned the suite red. A bespoke scenario here would be a second,
 * worse copy of a test that already exists.
 *
 * The reason each entry gives is what the transfer IS, so the next reader can find the test that
 * covers it by looking for that verb rather than by trusting this list. The day one of these stops
 * being caught, the sweep says so; the day a new crossing appears with no scenario and no entry
 * here, the test below says so.
 */
const UNREACHED_CLOCKS: Readonly<Record<string, string>> = {
  'belts:grabberDeliver:beltInsert(grabber.heldFreshTicks)':
    'claw → belt, the return leg of the cellar → arm → belt → arm → cellar loop item 112 was filed ' +
    'for; `freshness-doors.test.ts` drives that circuit and asserts no window is minted.',
  'belts:grabberDeliver:depotAccept(grabber.heldFreshTicks)':
    'claw → depot floor, driven hands-free by the belt-fed depot circuit in ' +
    '`freshness-depot-and-bot.test.ts`, which was written against this exact exploit.',
  'belts:grabberDeliver:putStorage(grabber.heldFreshTicks)':
    'claw → container, the other half of the same belt loop.',
  'belts:grabberSource:heldFreshTicks = entry.freshTicks':
    'belt → claw, the pick-up half of that loop. One of the two take-paths in `grabberSource` that ' +
    'were already guarded while the basket and the dock shelf beside them were not.',
  'belts:grabberSource:heldFreshTicks = took.freshTicks#2':
    'container → claw, the other already-guarded take-path.',
  'bots:unloadIntoDock:cargoFreshTicks = mergedFreshness(…)':
    'a harvester bot’s arms → the dock shelf, merged at the sooner clock. Driven by the jammed-dock ' +
    'scenarios, which stall a bot holding a part-spent armful on purpose.',
  'commerce:advanceContract:inTransitFreshTicks = contract.stockedFreshTicks':
    'depot floor → lorry, driven by the route cancelled while its truck is on the road.',
  'commerce:refundContract:addItemFresh(spoilTickFromRemaining(state, contract.inTransitFreshTicks))':
    'a torn-up route hands the lorry’s load back; same scenario.',
  'commerce:refundContract:addItemFresh(spoilTickFromRemaining(state, contract.stockedFreshTicks))':
    'and the floor’s; same scenario.',
  'state:takeStorage:cargoFreshTicks = freshnessTicks(item)':
    'the container twin of the dock-shelf repair that IS driven here — a format-18 load whose clock ' +
    'was never written down, granted one window in total rather than one per unit.',
  'tick:applyDeconstructMachine:addItemFresh(spoilTickFromRemaining(state, bot.carryFreshTicks))':
    'boxing a dock with a bot mid-errand, so the armful comes home in the box. **This line was ' +
    'DOOR 8**, and it has had a test of its own since item 117.',
  'tick:applyDeconstructMachine:addItemFresh(spoilTickFromRemaining(state, machine.cargoFreshTicks))':
    'boxing a loaded container or cart; the cargo bay’s half.',
  'tick:applyDeconstructMachine:addItemFresh(spoilTickFromRemaining(state, took.freshTicks))':
    'boxing a starved machine, so every hopper line hands its peppers back — the transfer item 112 ' +
    'was filed for, and the one in this family never short of tests.',
  'tick:applyLoadMachine:putHopper(freshTicks)':
    'the player’s hand → a hopper, the door the claw’s `putHopper` is the belt-fed twin of.',
  'tick:applyLoadMachine:putStorage(freshTicks)': 'the player’s hand → a container.',
  'tick:applyRemoveBelt:addItemFresh(spoilTickFromRemaining(state, entry.freshTicks))':
    'a whole belt run torn up at once, handing every rider back with the clock it was riding.',
  'tick:applyRemoveBeltTile:addItemFresh(spoilTickFromRemaining(state, entry.freshTicks))#2':
    'the goods freed by CUTTING a longer run — the neighbour of the one-tile branch driven here, ' +
    'and the reason duplicate keys are numbered instead of collapsed.',
  'tick:applyRemoveGrabber:addItemFresh(spoilTickFromRemaining(state, grabber.heldFreshTicks))':
    'an arm torn out of the ground mid-swing hands over whatever it was holding.',
  'tick:applyUnloadMachine:addItemFresh(spoilTickFromRemaining(state, freshTicks))':
    'the hand emptying an output basket — the twin of the BOXING basket door, and the one that ' +
    'always had two tests while its twin had none.',
  'tick:applyUnloadMachine:addItemFresh(spoilTickFromRemaining(state, took.freshTicks))':
    'the hand emptying a hopper line.',
  'tick:applyUnloadMachine:addItemFresh(spoilTickFromRemaining(state, took.freshTicks))#2':
    'the hand emptying a cargo bay.',
};

/**
 * Every `*.test.ts` beside this one, as `[name, its code with the comments taken out]`.
 *
 * **THE COMMENTS COME OUT, AND THIS INSTRUMENT LEARNED IT THE SAME WAY EVERY OTHER ONE IN THIS
 * FAMILY DID: BY FAILING.** The first draft searched the raw file, so commenting the runner call
 * out — `// runClockCrossings('belt-tiles');` — left the string present, the guard green, and the
 * scenarios silently not running. That is item 119's own bug, in item 119's own fix, found by
 * trying it rather than by reading it. `goodsMoves` and `bagDoors` have skipped comment lines
 * since item 117 for exactly this reason; so does this now.
 */
function testFiles(): [string, string][] {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => [
      name.replace(/\.test\.ts$/, ''),
      readFileSync(TEST_DIR + name, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
        .join('\n'),
    ]);
}

describe('the clock census', () => {
  it('**HAS A VERDICT FOR EVERY CLOCK CROSSING IN THE SIM, AND NO VERDICT WITHOUT ONE**', () => {
    // The property that makes this a census rather than a list. `clockCrossings()` reads the
    // source; this table is written by hand; and the day somebody hands a clock to a container
    // from a new line, or renames the local it hands over, this goes red and the only way to
    // green it is to say which of six sentences the new crossing is.
    expect(
      clockCrossings(),
      'clock crossings with no verdict, or verdicts with no crossing',
    ).toEqual(Object.keys(CLOCK_CROSSING_VERDICTS).sort());
  });

  it('found a great many crossings rather than none, which is the other way to be green', () => {
    // The shape of green this family has been bitten by twice: a sweep whose pattern quietly
    // stopped matching reports a clean bill of health in exactly the same words as a clean world.
    expect(clockCrossings().length).toBeGreaterThan(40);
  });

  it('drives every crossing that CLAIMS TO CARRY A CLOCK, for the nine that nothing drove', () => {
    // Not every `Carries` crossing has a bespoke scenario — twenty-one of them were already caught
    // by the suite as it stood, which the mutation sweep measured rather than assumed. What this
    // pins is the nine that were NOT, each by name.
    const driven = new Set(CLOCK_CROSSINGS.map((check) => check.crossing));
    const missing = THE_NINE.filter((door) => !driven.has(door));
    expect(missing, 'a door item 119 reopened, with no live scenario holding it shut').toEqual([]);
  });

  it('**LEAVES NO CROSSING WITH NEITHER A LIVE SCENARIO NOR A STATED REASON**', () => {
    // **THE PROPERTY THAT STOPS THIS BECOMING THE THING IT REPLACED.** A verdict of `Carries` is a
    // claim that a clock survives a door. Item 119 exists because nine such claims were written
    // down and never executed, so a table of claims with no coverage rule would be item 112's
    // comment again with better syntax.
    //
    // So every crossing that claims to carry is either driven by a scenario in
    // `clock-crossings.ts` or written into `UNREACHED_CLOCKS` with a reason — and adding a new
    // one to the sim fails HERE until somebody does one or the other. That is the same bargain
    // `UNREACHED` strikes for the census rows in `move-census-live.test.ts`.
    const carrying = Object.keys(CLOCK_CROSSING_VERDICTS).filter((key) => {
      const verdict = CLOCK_CROSSING_VERDICTS[key];
      return verdict === ClockDoorVerdict.Carries || verdict === ClockDoorVerdict.Grandfathers;
    });
    const driven = new Set(CLOCK_CROSSINGS.map((check) => check.crossing));
    const missing = carrying.filter(
      (key) => !driven.has(key) && UNREACHED_CLOCKS[key] === undefined,
    );
    expect(missing, 'crossings that carry a clock with neither a scenario nor a reason').toEqual(
      [],
    );

    // And no reason may rot into an excuse for a crossing that IS driven, or for one that no
    // longer exists — either would be the census quietly shrinking its own reach.
    for (const key of Object.keys(UNREACHED_CLOCKS)) {
      expect(
        CLOCK_CROSSING_VERDICTS[key],
        `${key} is excused but is not on the census`,
      ).toBeDefined();
      expect(driven.has(key), `${key} is excused AND driven — delete the excuse`).toBe(false);
    }
  });

  it('holds every scenario to a crossing that exists, and to a verdict worth checking', () => {
    // A scenario naming a crossing that has been renamed away would otherwise go on claiming
    // coverage of something gone — a census rotting quietly rather than going red.
    for (const check of CLOCK_CROSSINGS) {
      const verdict = CLOCK_CROSSING_VERDICTS[check.crossing];
      expect(
        verdict,
        `${check.name} claims ${check.crossing}, which is not on the census`,
      ).toBeDefined();
      // A `Clears` or a `Projection` has no clock to carry, so a scenario claiming to prove one
      // carries would be asserting something that cannot fail.
      expect(
        verdict === ClockDoorVerdict.Carries || verdict === ClockDoorVerdict.Grandfathers,
        `${check.name} drives a crossing whose verdict is "${String(verdict)}" — there is no ` +
          'clock crossing there to prove anything about',
      ).toBe(true);
    }
  });

  it('**SPREADS THE GUARD ACROSS FILES, SO NO ONE DELETION DISARMS IT**', () => {
    // **THE CONCENTRATION RISK, MEASURED AND THEN FIXED.** Item 119's report: all 27 clock
    // catches in the suite came from `move-census-live.test.ts`, largely three tests. Delete that
    // one file and every clock in the game silently un-guards — and "silently" is the word that
    // matters, because a suite that goes from 27 catches to 0 still reports all green.
    const owners = new Set(CLOCK_CROSSINGS.map((check) => check.owner));
    expect(
      owners.size,
      'the clock scenarios have collected in too few files again',
    ).toBeGreaterThanOrEqual(4);

    // And each of those files must exist AND actually run its own group. A scenario whose owner
    // was deleted, renamed, or quietly stopped calling the runner is a scenario that no longer
    // executes — which is precisely the failure this whole item is about, one level up.
    const files = new Map(testFiles());
    for (const owner of [...owners].sort()) {
      const source = files.get(owner);
      expect(
        source,
        `${owner}.test.ts is named by a clock scenario and does not exist`,
      ).toBeDefined();
      expect(
        source!.includes(`runClockCrossings('${owner}')`),
        `${owner}.test.ts exists but never calls runClockCrossings('${owner}'), so the ` +
          'crossings it owns are declared and never executed',
      ).toBe(true);
    }
  });

  it('leaves no crossing carrying a clock that nothing anywhere would notice', () => {
    // The bookkeeping that keeps the two tables honest about each other: every scenario is for a
    // crossing, every one of the nine has a scenario, and every crossing has a verdict. What this
    // adds is the direction nothing else checks — that the table has not quietly filled up with
    // `Clears` verdicts on doors that plainly hand something over.
    const carrying = Object.keys(CLOCK_CROSSING_VERDICTS).filter(
      (key) => CLOCK_CROSSING_VERDICTS[key] === ClockDoorVerdict.Carries,
    );
    expect(
      carrying.length,
      'nothing in this game carries a clock, which cannot be right',
    ).toBeGreaterThan(20);
    for (const key of carrying) {
      expect(key, `${key} is marked Carries but hands over a literal zero`).not.toMatch(
        /[=(]\s*0\)?$/,
      );
    }
  });
});
