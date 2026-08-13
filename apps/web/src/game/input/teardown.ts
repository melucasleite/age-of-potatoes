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
};

/**
 * What the tool would take off a single tile, or `null` for bare ground.
 *
 * THE ORDER IS THE SIM'S OWN. `tileOccupied` refuses a build on a tile that holds a machine,
 * a belt, an arm or a pipe, so at most one of these can be there — the sequence below is a
 * search, not a priority, and no tile can answer twice. It is written machine-first anyway so
 * that the one target with a footprint is resolved before anything is asked about single
 * tiles.
 */
export function teardownTargetAt(
  view: WorldView,
  tileX: number,
  tileY: number,
): TeardownTarget | null {
  const machine = machineAt(view, tileX, tileY);
  if (machine !== null) return machineTarget(view, machine);

  const belt = beltAtView(view, tileX, tileY);
  if (belt !== null) return beltTarget(belt);

  const grabber = grabberAtView(view, tileX, tileY);
  if (grabber !== null) {
    return {
      command: { type: 'RemoveGrabber', grabberId: grabber.id },
      outcome: TeardownOutcome.Refunded,
      tiles: [{ tileX, tileY }],
      name: 'the grabber arm',
      refundCents: grabberSpec(grabber.tier as never)?.priceCents ?? 0,
      // Not reach-gated in `applyRemoveGrabber` — see the note on `RemovePipe` below.
      refused: false,
    };
  }

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
      // NOT REACH-GATED, and that is the sim's answer rather than a convenience: none of
      // `applyRemoveBelt`, `applyRemoveGrabber` or `applyRemovePipe` checks reach, exactly as
      // placement does not. Building a belt across the lot and taking it back up are the same
      // verb in opposite directions, so gating one and not the other would be a new rule
      // invented by the input layer. Machines are the exception because the SIM makes them one.
      refused: false,
    };
  }

  return null;
}

function machineTarget(view: WorldView, machine: MachineView): TeardownTarget {
  const tiles: { tileX: number; tileY: number }[] = [];
  for (let y = machine.tileY; y < machine.tileY + machine.tilesHigh; y++) {
    for (let x = machine.tileX; x < machine.tileX + machine.tilesWide; x++) {
      tiles.push({ tileX: x, tileY: y });
    }
  }
  return {
    command: { type: 'DeconstructMachine', machineId: machine.id },
    outcome: TeardownOutcome.Boxed,
    tiles,
    name: `the ${machineName(machine.kind)}`,
    // Zero, always. Boxing is not selling ([[054]]) and this is the number that says so.
    refundCents: 0,
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
 * WHOLE OBJECTS, NOT CLIPPED ONES. `RemoveBelt` names a belt by id and takes all of it —
 * there is no partial removal in the sim and inventing one here would be the input layer
 * writing a rule. So a drag that clips one tile of a long belt takes the whole belt, and the
 * ghost paints the whole belt so that is visible while the button is still down.
 */
export function teardownPlan(
  view: WorldView,
  rect: { x: number; y: number; w: number; h: number },
): TeardownPlan {
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
    for (let t = 0; t < tiles.length; t++) {
      if (!overlapsRect(rect, tiles[t]!.tileX, tiles[t]!.tileY, 1, 1)) continue;
      targets.push(beltTarget(belt, tiles));
      break;
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
    if (target.command.type === 'RemoveBelt') beltCount += 1;
    if (target.command.type === 'RemoveGrabber') armCount += 1;
    // Pipes are re-emitted as paths below; everything else goes through as it stands.
    if (target.command.type !== 'RemovePipe') commands.push(target.command);
  }

  // One `RemovePipe` per `PIPE_MAX_PATH_TILES` worth of tiles. The sim refuses a longer path
  // outright, so a drag across a big field of plumbing has to be split — and splitting by the
  // sim's own constant means it can never be split into a length the sim will not take.
  for (let i = 0; i < pipeTiles.length; i += PIPE_MAX_PATH_TILES) {
    commands.push({ type: 'RemovePipe', path: pipeTiles.slice(i, i + PIPE_MAX_PATH_TILES) });
  }

  const loneMachine =
    targets.length === 1 && targets[0]!.command.type === 'DeconstructMachine'
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
  if (counts.beltCount > 0) parts.push(plural(counts.beltCount, 'belt'));
  if (counts.armCount > 0) parts.push(plural(counts.armCount, 'arm'));
  if (counts.pipeCount > 0) parts.push(plural(counts.pipeCount, 'pipe'));

  const refund = targets.reduce((sum, target) => sum + target.refundCents, 0);
  const cash = parts.length > 0 ? `${parts.join(', ')} · ${plusMoney(refund)}` : '';
  const bag = counts.boxCount > 0 ? `${plural(counts.boxCount, 'machine')} → the bag` : '';
  if (cash === '') return bag;
  if (bag === '') return cash;
  return `${cash}  ·  ${bag}`;
}

/** What happens to one target, said in the words the ribbon uses. */
export function outcomePhrase(target: TeardownTarget): string {
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
 * The sell bin gets no special case here even though `applyDeconstructMachine` refuses it:
 * it is the world's gift and cannot be boxed, the sim says so, and the refusal arrives the
 * same way every other one does.
 */
function machineName(kind: number): string {
  const spec = machineSpec(kind as MachineKind);
  if (spec === null) return 'machine';
  return spec.slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
