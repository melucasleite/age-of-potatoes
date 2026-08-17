// The teardown tool: one cursor that removes anything the player can build.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  THE SIM WAS ALREADY FINISHED AND THE CLIENT COULD NOT REACH IT. `RemoveBelt`,
//  `RemoveGrabber` and `RemovePipe` have existed in `commands.ts` since belts and pipes did,
//  each with a full cash refund and everything riding it handed back — and until this file
//  there was not one code path in `apps/web` that could send any of them. Three finished
//  features the player had no way to use, and one tool ("Box Up") that worked on exactly one
//  of the four things on the lot. So this is wiring, plus a rectangle.
//
//  TWO OUTCOMES, AND THE TOOL HAS TO SAY WHICH ONE IS COMING. A machine goes into the bag as
//  a box carrying its dials and its condition, and pays NOTHING — boxing is rearranging, not
//  selling ([[054]]), and the money verb is `SellBoxedMachine` one deliberate step later. A
//  belt, an arm or a pipe is refunded in cash on the spot. That asymmetry is deliberate and
//  stays; what it must not be is a thing you learn by watching your money not move. Hence
//  `TeardownOutcome`, a tone per outcome on the ghost, and a ribbon line that names both the
//  target and what happens to it before the click lands.
//
//  N COMMANDS, NOT ONE RECT COMMAND — AND THAT IS A DIFFERENT ANSWER FROM THE ONE [[059]]
//  GAVE IN THE SAME WAVE, ON PURPOSE. The repo's rule is that one drag is one command, and
//  the reason it is stated so hard in `commands.ts` is whole-run refusal: a paint or a belt
//  run or a pipe run is a single decision about a single object that must not half-happen. A
//  teardown drag is not one decision. It is N independent removals of N distinct objects,
//  each with its own id, its own refusal, and its own complete outcome — remove four of five
//  things and the lot is in a state the player could have reached by clicking four times,
//  which is emphatically not true of half a belt run. Nothing is left dangling, so there is
//  nothing for a rect command to protect.
//
//  What N entries buy, beyond not inventing a command: the trace names every object that was
//  destroyed, by id, which is exactly the bug-report value the one-command rule exists to
//  protect. `ClearArea { rect }` would record a rectangle and leave "what was in it" to be
//  reconstructed by replaying the world up to that tick.
//
//  What they cost, stated plainly rather than argued away: a big drag is a big handful of
//  trace entries, and an undo built on [[019]] will have to group them to be one step. That
//  is a real debt and the item says so — a destructive drag is an argument for prioritising
//  undo, not for smuggling it in here.
//
//  PIPES ARE THE ONE EXCEPTION AND THE SIM MADE THEM SO. `RemovePipe` already carries a
//  `path`, so every pipe tile in the rectangle goes in ONE command — the rect-carrying shape
//  the item hoped for, already built, for the one target that has it.
// ────────────────────────────────────────────────────────────────────────────────────
//
// Everything here is pure: it takes a `WorldView` and a tile rectangle and returns plain
// data. No DOM, no camera, no Pixi — which is what lets the gesture be tested without a
// browser, and is why this is a `.ts` module rather than logic inside `pointer.ts`.
//
// LEGALITY IS STILL NOT DECIDED HERE (§12). Every command that can be FORMED is sent, even
// for a jammed machine or one across the lot, and the sim refuses it harmlessly. The tones
// below are a preview of that refusal, never a gate on it — `refusals` counts what the sim
// is expected to turn down so the ribbon can say so, and nothing in this file drops a
// command on that basis.

import type { BeltView, Command, MachineView, WorldView } from '@snack/sim';
import {
  LampState,
  MachineKind,
  PIPE_MAX_PATH_TILES,
  PIPE_PRICE_CENTS_PER_TILE,
  beltSpec,
  boxedItemForMachine,
  grabberSpec,
  machineSpec,
} from '@snack/sim';

import type { BandCell, BandTone } from './chrome';
import { beltAtView, beltTiles, grabberAtView, machineWithinReach, pipeAtView } from './picking';

/** What happens to a thing when the teardown tool takes it. */
export const TeardownOutcome = {
  /** Into the bag as a box, carrying its dials. No cash — boxing is not selling. */
  Boxed: 'boxed',
  /** Off the lot, full price back in the pouch. */
  Refunded: 'refunded',
  /**
   * Nothing. The machine has no box (`boxedItemForMachine` says so — the sell bin is the
   * world's gift and the only way to trade), so the tool has nothing to take here and says
   * so, instead of offering a bagging the sim refuses on every click (item 076's owner
   * ruling: hovering the bin with this tool reads "nothing to pick up", never an offer).
   * A `Kept` target contributes its tiles to the ghost in the refusal tone and NOTHING to
   * the command list — a refused command per drag would be noise the player cannot see.
   */
  Kept: 'kept',
} as const;
export type TeardownOutcome = (typeof TeardownOutcome)[keyof typeof TeardownOutcome];

/** One thing the tool has found under the cursor or inside the rectangle. */
export interface TeardownTarget {
  command: Command;
  outcome: TeardownOutcome;
  /** Every tile this thing occupies — the WHOLE object, not just the part inside the rect. */
  tiles: readonly { tileX: number; tileY: number }[];
  /** What to call it in the ribbon: "the Fryer", "6 belt tiles". */
  name: string;
  /** Cash this returns, in cents. Zero for a boxed machine, and that is the point. */
  refundCents: number;
  /**
   * What this click LEAVES STANDING on the same tile, named — or `null` when it leaves nothing.
   *
   * Only a single-tile pick can set this, and only since item 120 gave a tile two layers: a
   * click on a pipe crossing a belt takes the pipe and leaves the belt, and this is the half of
   * that sentence the player would otherwise have to discover by looking. A drag leaves `null`
   * because a drag takes BOTH, so "leaves the belt tile" would be a lie there — which is
   * exactly the class of lie this field exists to prevent.
   */
  beneath: string | null;
  /**
   * True when the sim is expected to refuse this — jammed, or out of arm's reach.
   *
   * A PREVIEW OF THE SIM'S ANSWER, NEVER A SUBSTITUTE FOR IT. Both facts are read off the
   * projection (`MachineView.lamp`, the player's position) rather than re-derived, and the
   * command is built and sent regardless. The one refusal that CANNOT be previewed is "the
   * machine is actually running this tick": that is computed inside `tick.ts` from ingredients
   * and room, and no field of `MachineView` carries it. Such a machine draws green here and is
   * refused on arrival, which is the honest limit of what the projection knows.
   */
  refused: boolean;
}

export interface TeardownPlan {
  /** In application order. Empty when the rectangle holds nothing removable. */
  commands: Command[];
  cells: BandCell[];
  /** The tag on the band, and the summary the ribbon uses for a drag. */
  label: string;
  refundCents: number;
  boxCount: number;
  refusals: number;
  /**
   * The only target, when there is exactly one and it is a machine.
   *
   * WHY THIS IS SINGLED OUT: a machine is the one teardown target the sim reach-gates, so it
   * is the one that can be walked to — `IntentAction.Deconstruct` exists for exactly this. A
   * click is a one-tile drag, so without this a player who armed the tool and clicked a Fryer
   * across the lot would get a silently refused command where they used to get a walk. One
   * errand at a time is the sim's rule, so this is deliberately NOT extended to a drag over
   * six machines: there is no such thing as six errands, and a drag that walked to the first
   * one and refused the rest would be the most confusing possible reading of the gesture.
   */
  loneMachineTile: { tileX: number; tileY: number } | null;
}

const TONE_BY_OUTCOME: Readonly<Record<TeardownOutcome, BandTone>> = {
  [TeardownOutcome.Boxed]: 'box',
  [TeardownOutcome.Refunded]: 'erase',
  [TeardownOutcome.Kept]: 'blocked',
};

/**
 * What the tool would take off a single tile, or `null` for bare ground.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  THE PICKING RULE (item 120), AND IT IS THE SIM'S OWN LAYER SPLIT READ BACKWARDS.
 *
 *  The comment that used to stand here said "`tileOccupied` refuses a build on a tile that
 *  holds a machine, a belt, an arm or a pipe, so at most one of these can be there — the
 *  sequence below is a search, not a priority, and no tile can answer twice." **Item 120 made
 *  that false.** A pipe is overhead now, so a tile can hold a belt AND a pipe, and the moment
 *  it can, this sequence stops being a search and silently becomes a priority — one nobody
 *  chose, written as an accident of which `if` came first. A tile CAN answer twice.
 *
 *  **A CLICK TAKES THE TOPMOST THING, AND ONLY THAT THING.** The order is not invented here:
 *  the sim already split the world into `groundOccupied` (machines, belts, arms, water) and
 *  `tileOccupied` (that, plus the pipe above it). So picking is that split read from the top
 *  down — the overhead layer first, then the ground layer, whose members remain mutually
 *  exclusive and so still answer as a search among themselves. If plumbing ever gains a
 *  neighbour up there, the rule already says where it goes, and this comment is where to
 *  look.
 *
 *  Topmost is also the WYSIWYG answer, which is the reason it is the right one rather than
 *  merely a consistent one: the renderer draws pipes above belts, so the topmost object is
 *  the one the player's eye is on. The thing you can see is the thing you take.
 *
 *  **AND THE CLICK LEAVES THE OTHER ONE STANDING, ON PURPOSE.** Clear a crossing by clicking
 *  twice: the first click takes the pipe, the ribbon then reads "the belt tile", the second
 *  takes that. Each click did exactly what the ribbon promised before it, which is the whole
 *  property being bought — the ribbon is a contract and no click may exceed it.
 *
 *  *THE ALTERNATIVE I REJECTED — "a click takes everything on the tile", which is both the
 *  behaviour item 120 shipped by accident and the one a drag genuinely has.* It is the more
 *  consistent-looking rule and it is wrong for one decisive reason: **the ribbon can only name
 *  one thing.** It is a single line reading `${target.name} · ${outcomePhrase(target)}`, so a
 *  click that took two objects would announce one of them and destroy both — the player points
 *  at a pipe, reads "the pipe · +$2.00", clicks, and their belt goes too. That is not a
 *  cosmetic mismatch, it is the exact bug report the item predicted ("every ambiguity here
 *  becomes a bug report about the wrong thing vanishing"), and it would arrive as data loss on
 *  a factory rather than as a wrong string. A gesture may only destroy what its own affordance
 *  named, and a one-line affordance may only name one thing.
 *
 *  A DRAG IS UNAFFECTED and still takes everything it covers — see `teardownPlan`. That is not
 *  an inconsistency, it is the same rule: a drag's affordance is a multi-cell ghost with a
 *  counted label, so it may take many things because it showed many things. Making a drag
 *  topmost-only would be the worse bug in the other direction — the player would have to drag
 *  the identical rectangle twice, and the second drag would look exactly like the first.
 * ────────────────────────────────────────────────────────────────────────────────────
 */
export function teardownTargetAt(
  view: WorldView,
  tileX: number,
  tileY: number,
): TeardownTarget | null {
  // THE OVERHEAD LAYER, FIRST AND ALONE (item 120). Everything below this line is the ground.
  const pipe = pipeAtView(view, tileX, tileY);
  if (pipe !== null) {
    return {
      // One tile's worth. A drag merges every pipe tile it finds into one path command;
      // `teardownPlan` owns that, because it is the only caller that can see the whole run.
      command: { type: 'RemovePipe', path: [{ x: tileX, y: tileY }] },
      outcome: TeardownOutcome.Refunded,
      tiles: [{ tileX, tileY }],
      name: 'the pipe',
      refundCents: PIPE_PRICE_CENTS_PER_TILE,
      // What survives this click, named for the ribbon. Read off the ground layer BENEATH the
      // pipe rather than assumed — a pipe over bare ground leaves nothing and says nothing.
      beneath: groundNameAt(view, tileX, tileY),
      // NOT REACH-GATED, and that is the sim's answer rather than a convenience: none of
      // `applyRemoveBelt`, `applyRemoveGrabber` or `applyRemovePipe` checks reach, exactly as
      // placement does not. Building a belt across the lot and taking it back up are the same
      // verb in opposite directions, so gating one and not the other would be a new rule
      // invented by the input layer. Machines are the exception because the SIM makes them one.
      refused: false,
    };
  }

  // THE GROUND LAYER. These three still cannot share a tile with each other — `groundOccupied`
  // is what a belt, an arm and a machine footprint all ask — so among themselves this remains a
  // search rather than a priority, and no tile can answer twice.
  const machine = machineAt(view, tileX, tileY);
  if (machine !== null) return machineTarget(view, machine);

  const belt = beltAtView(view, tileX, tileY);
  if (belt !== null) {
    // ONE TILE, NOT THE WHOLE RUN (item 084): belts are owned individually now, so a click on
    // a mid-run tile takes that tile and leaves two working survivors. A 1-tile segment is
    // the whole object anyway, and goes by id like everything else.
    const tiles = beltTiles(belt);
    return tiles.length === 1 ? beltTarget(belt, tiles) : beltTileTarget(belt, tileX, tileY);
  }

  const grabber = grabberAtView(view, tileX, tileY);
  if (grabber !== null) {
    return {
      command: { type: 'RemoveGrabber', grabberId: grabber.id },
      outcome: TeardownOutcome.Refunded,
      tiles: [{ tileX, tileY }],
      name: 'the grabber arm',
      refundCents: grabberSpec(grabber.tier as never)?.priceCents ?? 0,
      beneath: null,
      // Not reach-gated in `applyRemoveGrabber` — see the note on `RemovePipe` above.
      refused: false,
    };
  }

  return null;
}

/**
 * What is standing on the GROUND layer of a tile, named — or `null` for bare ground.
 *
 * Only ever consulted from under a pipe, so it never has to answer about the pipe itself. A
 * machine cannot be here (a pipe may not cross a footprint — item 120's second ruling), and
 * that is asserted by omission rather than by a branch: if the sim ever relaxes it, this
 * returns `null` and the ribbon under-promises, which is the safe direction to be wrong in.
 */
function groundNameAt(view: WorldView, tileX: number, tileY: number): string | null {
  if (beltAtView(view, tileX, tileY) !== null) return 'the belt tile';
  if (grabberAtView(view, tileX, tileY) !== null) return 'the grabber arm';
  return null;
}

function machineTarget(view: WorldView, machine: MachineView): TeardownTarget {
  const tiles: { tileX: number; tileY: number }[] = [];
  for (let y = machine.tileY; y < machine.tileY + machine.tilesHigh; y++) {
    for (let x = machine.tileX; x < machine.tileX + machine.tilesWide; x++) {
      tiles.push({ tileX: x, tileY: y });
    }
  }

  // A machine with NO box — the sell bin — cannot be taken at all, so the tool stops
  // offering to take it ([[076]]). `refused: false` on purpose: the refused branch of the
  // ribbon says "too far, click to walk over", which promises a walk toward a take that can
  // never happen. The `Kept` outcome carries its own sentence instead.
  if (boxedItemForMachine(machine.kind as MachineKind) === null) {
    return {
      command: { type: 'DeconstructMachine', machineId: machine.id },
      outcome: TeardownOutcome.Kept,
      tiles,
      name: `the ${machineName(machine.kind)}`,
      refundCents: 0,
      // A pipe may not cross a footprint (item 120), so a machine never has one above it.
      beneath: null,
      refused: false,
    };
  }

  return {
    command: { type: 'DeconstructMachine', machineId: machine.id },
    outcome: TeardownOutcome.Boxed,
    tiles,
    name: `the ${machineName(machine.kind)}`,
    // Zero, always. Boxing is not selling ([[054]]) and this is the number that says so.
    refundCents: 0,
    beneath: null,
    refused: machine.lamp === LampState.Jammed || !machineWithinReach(view, machine),
  };
}

function beltTarget(belt: BeltView, tiles = beltTiles(belt)): TeardownTarget {
  const perTile = beltSpec(belt.tier as never)?.priceCentsPerTile ?? 0;
  return {
    command: { type: 'RemoveBelt', beltId: belt.id },
    outcome: TeardownOutcome.Refunded,
    tiles,
    name: `${tiles.length} belt tile${tiles.length === 1 ? '' : 's'}`,
    refundCents: perTile * tiles.length,
    // A belt is the GROUND layer, so nothing of ours is under it — a pipe would be above,
    // and a pipe above is why this branch was not reached (see `teardownTargetAt`).
    beneath: null,
    refused: false,
  };
}

/**
 * One tile of a longer belt (item 084): the sim splits the run around it and refunds the
 * tile. Addressed by TILE rather than id because the drag may cut the same original segment
 * twice, and after the first cut the id under the second tile is one surgery just minted —
 * the tile keeps naming the right thing across every intermediate world (see
 * `RemoveBeltTileCommand`).
 */
function beltTileTarget(belt: BeltView, tileX: number, tileY: number): TeardownTarget {
  return {
    command: { type: 'RemoveBeltTile', tileX, tileY },
    outcome: TeardownOutcome.Refunded,
    tiles: [{ tileX, tileY }],
    name: 'the belt tile',
    refundCents: beltSpec(belt.tier as never)?.priceCentsPerTile ?? 0,
    beneath: null,
    refused: false,
  };
}

/**
 * Everything a rectangle would take, as commands, cells and one sentence.
 *
 * ITERATES THE OBJECTS AND ASKS WHICH ARE IN THE RECTANGLE — never the tiles, asking what is
 * on each. That is not a micro-optimisation, it is the difference between a gesture that works
 * on a mature base and one that does not: a drag can span 64 tiles a side, this runs EVERY
 * FRAME from `band()` while the button is down, and a per-tile scan would ask four thousand
 * tiles to search a few hundred belts and pipes each — millions of compares a frame, on the
 * one gesture the player is holding still and staring at. Inverted, it is one pass over the
 * objects, and the ghost costs the same on a full factory as on an empty lot.
 *
 * Turning it inside out also removes the de-duplication this needed in the other direction: a
 * 2×2 Fryer answers on four tiles and a sixteen-tile belt on sixteen, so a tile scan had to
 * remember what it had already seen or send the same removal a dozen times. Visiting each
 * object once cannot repeat itself.
 *
 * WHOLE OBJECTS, NOT CLIPPED ONES — FOR EVERYTHING BUT BELTS. A machine's footprint is one
 * object and comes up whole however the rect clips it. Belts stopped being whole objects
 * with item 084: the sim owns partial removal now (`RemoveBeltTile` splits the run and the
 * survivors keep working), so a drag takes exactly the belt tiles it covers, and the ghost
 * paints exactly those tiles while the button is still down. A rect that covers every tile
 * of a segment still ships one id-named `RemoveBelt`, because there the old sentence is
 * still true: it IS one decision about one whole object.
 */
export function teardownPlan(
  view: WorldView,
  rect: { x: number; y: number; w: number; h: number },
): TeardownPlan {
  // A ONE-TILE RECT IS A CLICK, AND A CLICK IS `teardownTargetAt` — THE SAME CALL THE RIBBON
  // MAKES (item 120's picking rule). Not a parallel implementation that agrees: the identical
  // function, so the sentence the player read and the command that goes out cannot drift into
  // disagreement, because there is only one of them. That is what makes it structurally
  // impossible for this tool to delete the thing the player was not looking at, rather than
  // merely unlikely — before this, the ribbon called `teardownTargetAt` and the click walked
  // the object lists below, and on a belt/pipe crossing those two returned different answers.
  //
  // Every pre-existing one-tile case comes out byte-identical (whole machine footprint, a
  // mid-run belt tile as `RemoveBeltTile`, a lone 1-tile segment as `RemoveBelt` by id, an arm,
  // a pipe, and bare ground's "nothing to take up") — the only behaviour that moves is the
  // stacked tile, which had no defined answer until today.
  if (rect.w === 1 && rect.h === 1) {
    const target = teardownTargetAt(view, rect.x, rect.y);
    return onePick(target);
  }

  const targets: TeardownTarget[] = [];
  const pipeTiles: { x: number; y: number }[] = [];

  // Machines first, then belts, then arms, then pipes — the order the removals are sent in and
  // therefore the order they land in the trace. Within each kind the projection is in sim id
  // order, so two identical drags on two identical worlds produce identical command lists.
  for (let i = 0; i < view.machines.length; i++) {
    const machine = view.machines[i]!;
    if (overlapsRect(rect, machine.tileX, machine.tileY, machine.tilesWide, machine.tilesHigh)) {
      targets.push(machineTarget(view, machine));
    }
  }

  for (let i = 0; i < view.belts.length; i++) {
    const belt = view.belts[i]!;
    const tiles = beltTiles(belt);
    const covered = tiles.filter((t) => overlapsRect(rect, t.tileX, t.tileY, 1, 1));
    if (covered.length === 0) continue;
    // Belts are owned tile by tile (item 084), so a drag takes exactly the tiles it covers:
    // a clipped run loses its clipped tiles and keeps the rest, standing and working. Only
    // when the rect covers EVERY tile is the removal one decision about one object again,
    // and then it ships as one id-named `RemoveBelt` — one trace entry, one refund — exactly
    // as it always has.
    if (covered.length === tiles.length) {
      targets.push(beltTarget(belt, tiles));
    } else {
      for (let t = 0; t < covered.length; t++) {
        targets.push(beltTileTarget(belt, covered[t]!.tileX, covered[t]!.tileY));
      }
    }
  }

  for (let i = 0; i < view.grabbers.length; i++) {
    const grabber = view.grabbers[i]!;
    if (!overlapsRect(rect, grabber.tileX, grabber.tileY, 1, 1)) continue;
    targets.push({
      command: { type: 'RemoveGrabber', grabberId: grabber.id },
      outcome: TeardownOutcome.Refunded,
      tiles: [{ tileX: grabber.tileX, tileY: grabber.tileY }],
      name: 'the grabber arm',
      refundCents: grabberSpec(grabber.tier as never)?.priceCents ?? 0,
      // A DRAG TAKES BOTH LAYERS, so it leaves nothing behind to name (item 120).
      beneath: null,
      refused: false,
    });
  }

  for (let i = 0; i < view.pipes.length; i++) {
    const pipe = view.pipes[i]!;
    if (!overlapsRect(rect, pipe.tileX, pipe.tileY, 1, 1)) continue;
    pipeTiles.push({ x: pipe.tileX, y: pipe.tileY });
    targets.push({
      command: { type: 'RemovePipe', path: [{ x: pipe.tileX, y: pipe.tileY }] },
      outcome: TeardownOutcome.Refunded,
      tiles: [{ tileX: pipe.tileX, tileY: pipe.tileY }],
      name: 'the pipe',
      refundCents: PIPE_PRICE_CENTS_PER_TILE,
      beneath: null,
      refused: false,
    });
  }

  const commands: Command[] = [];
  const cells: BandCell[] = [];
  let refundCents = 0;
  let boxCount = 0;
  let refusals = 0;
  let beltCount = 0;
  let armCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    const tone: BandTone = target.refused ? 'blocked' : TONE_BY_OUTCOME[target.outcome];
    for (let t = 0; t < target.tiles.length; t++) {
      cells.push({ x: target.tiles[t]!.tileX, y: target.tiles[t]!.tileY, tone });
    }
    if (target.refused) refusals += 1;
    refundCents += target.refundCents;
    if (target.outcome === TeardownOutcome.Boxed) boxCount += 1;
    // Both belt shapes count in TILES, so a drag over a whole 6-tile run and a drag over six
    // mid-run tiles read as the same quantity of the same stuff — which they are.
    if (target.command.type === 'RemoveBelt') beltCount += target.tiles.length;
    if (target.command.type === 'RemoveBeltTile') beltCount += 1;
    if (target.command.type === 'RemoveGrabber') armCount += 1;
    // A `Kept` target ships no command at all — the sim refuses it on every click, and a
    // refusal the player cannot see is noise in the queue ([[076]]). Pipes are re-emitted
    // as paths below; everything else goes through as it stands.
    if (target.outcome === TeardownOutcome.Kept) continue;
    if (target.command.type !== 'RemovePipe') commands.push(target.command);
  }

  // One `RemovePipe` per `PIPE_MAX_PATH_TILES` worth of tiles. The sim refuses a longer path
  // outright, so a drag across a big field of plumbing has to be split — and splitting by the
  // sim's own constant means it can never be split into a length the sim will not take.
  for (let i = 0; i < pipeTiles.length; i += PIPE_MAX_PATH_TILES) {
    commands.push({ type: 'RemovePipe', path: pipeTiles.slice(i, i + PIPE_MAX_PATH_TILES) });
  }

  const loneMachine =
    targets.length === 1 &&
    targets[0]!.command.type === 'DeconstructMachine' &&
    targets[0]!.outcome !== TeardownOutcome.Kept
      ? (targets[0]!.tiles[0] ?? null)
      : null;

  return {
    commands,
    cells,
    label: planLabel(targets, { beltCount, armCount, pipeCount: pipeTiles.length, boxCount }),
    refundCents,
    boxCount,
    refusals,
    loneMachineTile: loneMachine,
  };
}

/**
 * One picked target as a whole plan — the click's answer, in the shape the drag's answer has.
 *
 * Kept beside `teardownPlan` rather than inlined into it because the ordering rules it does NOT
 * have are the point: no object loops, no pipe-path chunking, no counting. One thing was picked,
 * so one thing happens.
 */
function onePick(target: TeardownTarget | null): TeardownPlan {
  if (target === null) {
    return {
      commands: [],
      cells: [],
      label: 'nothing to take up',
      refundCents: 0,
      boxCount: 0,
      refusals: 0,
      loneMachineTile: null,
    };
  }

  const tone: BandTone = target.refused ? 'blocked' : TONE_BY_OUTCOME[target.outcome];
  const boxed = target.outcome === TeardownOutcome.Boxed;
  return {
    // A `Kept` target ships no command, exactly as it does in a drag ([[076]]).
    commands: target.outcome === TeardownOutcome.Kept ? [] : [target.command],
    cells: target.tiles.map((t) => ({ x: t.tileX, y: t.tileY, tone })),
    label: `${target.name} · ${outcomePhrase(target)}`,
    refundCents: target.refundCents,
    boxCount: boxed ? 1 : 0,
    refusals: target.refused ? 1 : 0,
    loneMachineTile:
      target.command.type === 'DeconstructMachine' && target.outcome !== TeardownOutcome.Kept
        ? (target.tiles[0] ?? null)
        : null,
  };
}

interface Counts {
  beltCount: number;
  armCount: number;
  pipeCount: number;
  boxCount: number;
}

/**
 * The tag over a teardown drag.
 *
 * THE TWO OUTCOMES ARE NEVER ADDED TOGETHER. A drag over a Fryer and six belt tiles is
 * "+$9.00" and "1 machine → the bag", not one number — because there is no number that
 * describes both, and the one the player would infer is the Fryer's price, which is exactly
 * the wrong lesson.
 */
function planLabel(targets: readonly TeardownTarget[], counts: Counts): string {
  if (targets.length === 0) return 'nothing to take up';
  if (targets.length === 1) return `${targets[0]!.name} · ${outcomePhrase(targets[0]!)}`;

  const parts: string[] = [];
  if (counts.beltCount > 0) parts.push(plural(counts.beltCount, 'belt tile'));
  if (counts.armCount > 0) parts.push(plural(counts.armCount, 'arm'));
  if (counts.pipeCount > 0) parts.push(plural(counts.pipeCount, 'pipe'));

  const refund = targets.reduce((sum, target) => sum + target.refundCents, 0);
  const cash = parts.length > 0 ? `${parts.join(', ')} · ${plusMoney(refund)}` : '';
  const bag = counts.boxCount > 0 ? `${plural(counts.boxCount, 'machine')} → the bag` : '';
  if (cash === '') return bag;
  if (bag === '') return cash;
  return `${cash}  ·  ${bag}`;
}

/**
 * What happens to one target, said in the words the ribbon uses.
 *
 * **AND WHAT SURVIVES IT** (item 120). On a stacked tile the click takes the top thing only, so
 * the sentence has to carry the other half or the player learns it by watching a belt not
 * disappear and wondering whether the click registered. "leaves the belt tile" is a promise the
 * click keeps exactly, because both come from the one `teardownTargetAt` call.
 */
export function outcomePhrase(target: TeardownTarget): string {
  return `${outcomeVerb(target)}${target.beneath === null ? '' : ` · leaves ${target.beneath}`}`;
}

function outcomeVerb(target: TeardownTarget): string {
  if (target.outcome === TeardownOutcome.Kept) {
    // The owner's copy for the empty-handed hover on the sell bin ([[076]]): the tool has
    // nothing to take here, and saying so beats offering a take the sim always refuses.
    return 'nothing to pick up';
  }
  if (target.outcome === TeardownOutcome.Boxed) {
    return 'into the bag, dials and all — no cash';
  }
  return plusMoney(target.refundCents);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Cents as a signed gain. Shares no formatter with prices on purpose: this one has a sign. */
function plusMoney(cents: number): string {
  const whole = Math.floor(cents / 100);
  const pennies = cents % 100;
  return `+$${whole}.${pennies < 10 ? '0' : ''}${pennies}`;
}

/** Does a footprint touch the drag rectangle at all? One tile of overlap is enough. */
function overlapsRect(
  rect: { x: number; y: number; w: number; h: number },
  tileX: number,
  tileY: number,
  tilesWide: number,
  tilesHigh: number,
): boolean {
  return (
    tileX < rect.x + rect.w &&
    tileX + tilesWide > rect.x &&
    tileY < rect.y + rect.h &&
    tileY + tilesHigh > rect.y
  );
}

function machineAt(view: WorldView, tileX: number, tileY: number): MachineView | null {
  for (let i = 0; i < view.machines.length; i++) {
    const m = view.machines[i]!;
    if (
      tileX >= m.tileX &&
      tileY >= m.tileY &&
      tileX < m.tileX + m.tilesWide &&
      tileY < m.tileY + m.tilesHigh
    ) {
      return m;
    }
  }
  return null;
}

/**
 * The machine's name, from the sim's own slug.
 *
 * The sell bin's special case is not here — it is the `Kept` outcome in `machineTarget`,
 * decided off `boxedItemForMachine` (the sim's own fact) rather than off this name.
 */
function machineName(kind: number): string {
  const spec = machineSpec(kind as MachineKind);
  if (spec === null) return 'machine';
  return spec.slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
