// The cheap structural gate for the teardown tool.
//
// Verification here is deliberately light (AGENTS.md: "if it works, it works"), so this pins
// only what fails QUIETLY — where the game keeps running and nobody sees a stack trace:
//
//   · THE VERB MATCHES THE TARGET. A cursor that builds `DeconstructMachine` for a belt sends
//     a command naming a machine id that is really a belt id. The sim refuses it silently and
//     the belt just… does not go away, which reads as an unresponsive click.
//   · THE OUTCOME IS THE RIGHT ONE. Cash-refund and into-the-bag are different money ([[054]])
//     and the whole point of the ribbon is saying which. A wrong `outcome` is a correct
//     removal advertised as the other kind, which is worse than saying nothing.
//   · ONE OBJECT, ONE COMMAND. A 2×2 Fryer answers on four tiles and a sixteen-tile belt on
//     sixteen. Without de-duplication a rectangle emits the same removal over and over; every
//     copy after the first is refused, so nothing breaks and the trace fills with noise.
//   · A LONG BELT COMES UP WHOLE. `RemoveBelt` takes a belt by id and there is no partial, so
//     clipping one tile of a run takes all of it — the ghost has to show that BEFORE release
//     or the player finds out by watching a belt they wanted vanish.
//
// Everything under test is pure: a `WorldView` in, plain data out. No DOM, no camera, no Pixi.

import { describe, expect, it } from 'vitest';
import { BeltTier, Direction, GrabberTier, LampState, MachineKind, SUBTILE } from '@snack/sim';
import type { WorldView } from '@snack/sim';
import { createWorldView } from '@snack/sim';

import { TeardownOutcome, outcomePhrase, teardownPlan, teardownTargetAt } from './teardown';

/** The farmer stands here, so everything nearby is in reach and nothing is refused for range. */
function view(): WorldView {
  const v = createWorldView();
  v.player.xSub = 10 * SUBTILE + SUBTILE / 2;
  v.player.ySub = 10 * SUBTILE + SUBTILE / 2;
  return v;
}

function withMachine(
  v: WorldView,
  id: number,
  kind: number,
  tileX: number,
  tileY: number,
  tilesWide = 1,
  tilesHigh = 1,
  lamp: number = LampState.Running,
): WorldView {
  v.machines.push({ id, kind, tileX, tileY, tilesWide, tilesHigh, lamp } as never);
  return v;
}

function withBelt(
  v: WorldView,
  id: number,
  tileX: number,
  tileY: number,
  dir: number,
  lengthTiles: number,
): WorldView {
  v.belts.push({ id, tileX, tileY, dir, lengthTiles, tier: BeltTier.Basic, itemCount: 0 } as never);
  return v;
}

describe('one cursor, four verbs', () => {
  it('boxes a machine, for no cash at all', () => {
    const v = withMachine(view(), 7, MachineKind.Fryer, 10, 10, 2, 2);
    const target = teardownTargetAt(v, 11, 11)!;
    expect(target.command).toEqual({ type: 'DeconstructMachine', machineId: 7 });
    expect(target.outcome).toBe(TeardownOutcome.Boxed);
    // Boxing is not selling. A non-zero number here would be the design changing by accident.
    expect(target.refundCents).toBe(0);
  });

  it('takes a belt up for a full refund', () => {
    const v = withBelt(view(), 3, 10, 10, Direction.East, 4);
    const target = teardownTargetAt(v, 12, 10)!;
    expect(target.command).toEqual({ type: 'RemoveBelt', beltId: 3 });
    expect(target.outcome).toBe(TeardownOutcome.Refunded);
    expect(target.refundCents).toBe(150 * 4);
  });

  it('takes an arm', () => {
    const v = view();
    v.grabbers.push({
      id: 5,
      tileX: 10,
      tileY: 10,
      dir: Direction.East,
      tier: GrabberTier.Mk1,
    } as never);
    const target = teardownTargetAt(v, 10, 10)!;
    expect(target.command).toEqual({ type: 'RemoveGrabber', grabberId: 5 });
    expect(target.outcome).toBe(TeardownOutcome.Refunded);
  });

  it('takes a pipe', () => {
    const v = view();
    v.pipes.push({ tileX: 10, tileY: 10, liquid: 1, network: 0, flowPermille: 0 } as never);
    const target = teardownTargetAt(v, 10, 10)!;
    expect(target.command).toEqual({ type: 'RemovePipe', path: [{ x: 10, y: 10 }] });
  });

  it('finds nothing on bare ground', () => {
    expect(teardownTargetAt(view(), 10, 10)).toBeNull();
  });
});

describe('the rectangle', () => {
  it('clears a mixed area, one command per object', () => {
    const v = view();
    withMachine(v, 7, MachineKind.Fryer, 10, 10, 2, 2);
    withBelt(v, 3, 12, 10, Direction.East, 3);
    v.grabbers.push({
      id: 5,
      tileX: 10,
      tileY: 12,
      dir: Direction.East,
      tier: GrabberTier.Mk1,
    } as never);

    const plan = teardownPlan(v, { x: 9, y: 9, w: 7, h: 5 });
    expect(plan.commands).toEqual([
      { type: 'DeconstructMachine', machineId: 7 },
      { type: 'RemoveBelt', beltId: 3 },
      { type: 'RemoveGrabber', grabberId: 5 },
    ]);
    expect(plan.boxCount).toBe(1);
  });

  it('sends ONE command for a footprint that answers on four tiles', () => {
    const v = withMachine(view(), 7, MachineKind.Fryer, 10, 10, 2, 2);
    const plan = teardownPlan(v, { x: 10, y: 10, w: 2, h: 2 });
    expect(plan.commands).toHaveLength(1);
    // …and the ghost still covers all four, because all four are going.
    expect(plan.cells).toHaveLength(4);
  });

  it('takes a clipped belt WHOLE, and shows the whole thing in the ghost', () => {
    const v = withBelt(view(), 3, 10, 10, Direction.East, 8);
    // One tile of the run is inside the drag.
    const plan = teardownPlan(v, { x: 13, y: 10, w: 1, h: 1 });
    expect(plan.commands).toEqual([{ type: 'RemoveBelt', beltId: 3 }]);
    expect(plan.cells).toHaveLength(8);
    expect(plan.refundCents).toBe(150 * 8);
  });

  it('merges every pipe tile in the drag into one RemovePipe path', () => {
    const v = view();
    for (let x = 10; x < 14; x++) {
      v.pipes.push({ tileX: x, tileY: 10, liquid: 1, network: 0, flowPermille: 0 } as never);
    }
    const plan = teardownPlan(v, { x: 10, y: 10, w: 4, h: 1 });
    expect(plan.commands).toEqual([
      {
        type: 'RemovePipe',
        path: [
          { x: 10, y: 10 },
          { x: 11, y: 10 },
          { x: 12, y: 10 },
          { x: 13, y: 10 },
        ],
      },
    ]);
  });

  it('says nothing is here rather than drawing an empty band', () => {
    const plan = teardownPlan(view(), { x: 2, y: 2, w: 3, h: 3 });
    expect(plan.commands).toEqual([]);
    expect(plan.cells).toEqual([]);
    expect(plan.label).toBe('nothing to take up');
  });
});

describe('what the player is told before the click', () => {
  it('never adds cash and boxes into one number', () => {
    const v = view();
    withMachine(v, 7, MachineKind.Fryer, 10, 10, 2, 2);
    withBelt(v, 3, 12, 10, Direction.East, 3);

    const plan = teardownPlan(v, { x: 9, y: 9, w: 7, h: 5 });
    expect(plan.label).toContain('+$4.50');
    expect(plan.label).toContain('the bag');
    expect(plan.refundCents).toBe(450);
    expect(plan.boxCount).toBe(1);
  });

  it('names one target and its outcome when the cursor is on exactly one thing', () => {
    const v = withMachine(view(), 7, MachineKind.Fryer, 10, 10, 2, 2);
    const plan = teardownPlan(v, { x: 10, y: 10, w: 1, h: 1 });
    expect(plan.label).toBe('the Fryer · into the bag, dials and all — no cash');
  });

  it('flags a jammed machine as refused rather than offering a dead click', () => {
    const v = withMachine(view(), 7, MachineKind.Fryer, 10, 10, 2, 2, LampState.Jammed);
    const plan = teardownPlan(v, { x: 10, y: 10, w: 2, h: 2 });
    expect(plan.refusals).toBe(1);
    expect(plan.cells.every((cell) => cell.tone === 'blocked')).toBe(true);
    // Still sent. The sim is the authority and refuses it there (§12).
    expect(plan.commands).toEqual([{ type: 'DeconstructMachine', machineId: 7 }]);
  });

  it('flags a machine across the lot as out of reach', () => {
    const v = withMachine(view(), 7, MachineKind.Fryer, 40, 40, 2, 2);
    const plan = teardownPlan(v, { x: 40, y: 40, w: 2, h: 2 });
    expect(plan.refusals).toBe(1);
  });

  // Belts, arms and pipes are NOT reach-gated in the sim — see the note in `teardown.ts`.
  it('does not invent a reach rule for a belt across the lot', () => {
    const v = withBelt(view(), 3, 40, 40, Direction.East, 4);
    const plan = teardownPlan(v, { x: 40, y: 40, w: 4, h: 1 });
    expect(plan.refusals).toBe(0);
  });
});

describe('the sell bin has no box and the tool stops pretending ([[076]])', () => {
  it('keeps the bin: the Kept outcome, the honest phrase, no refused offer', () => {
    const v = withMachine(view(), 9, MachineKind.SellBin, 10, 10);
    const target = teardownTargetAt(v, 10, 10)!;
    expect(target.outcome).toBe(TeardownOutcome.Kept);
    // The ribbon reads `${name} · ${outcomePhrase(target)}` — the owner's copy for hovering
    // the bin with the take-up tool while there is nothing it can take.
    expect(outcomePhrase(target)).toBe('nothing to pick up');
    // NOT the refused path: that branch promises "too far, click to walk over", which is a
    // walk toward a take that can never happen.
    expect(target.refused).toBe(false);
  });

  it('a click on the bin emits nothing at all — no command, no errand', () => {
    const v = withMachine(view(), 9, MachineKind.SellBin, 40, 40);
    const plan = teardownPlan(v, { x: 40, y: 40, w: 1, h: 1 });
    expect(plan.commands).toEqual([]);
    // The lone-machine walk must not single it out either, or a distant click marches the
    // farmer across the lot to be refused.
    expect(plan.loneMachineTile).toBeNull();
    // The ghost still shows the bin, in the refusal tone, so the drag is not invisible.
    expect(plan.cells).toEqual([{ x: 40, y: 40, tone: 'blocked' }]);
    expect(plan.label).toBe('the Sell Bin · nothing to pick up');
  });

  it('a drag over the bin and a belt takes the belt and leaves the bin unoffered', () => {
    const v = withMachine(view(), 9, MachineKind.SellBin, 10, 10);
    withBelt(v, 3, 11, 10, Direction.East, 2);
    const plan = teardownPlan(v, { x: 10, y: 10, w: 3, h: 1 });
    expect(plan.commands).toEqual([{ type: 'RemoveBelt', beltId: 3 }]);
    expect(plan.boxCount).toBe(0);
  });
});

describe('the single machine still walks', () => {
  it('is the one case the plan singles out, so a distant click becomes an errand', () => {
    const v = withMachine(view(), 7, MachineKind.Fryer, 40, 40, 2, 2);
    const plan = teardownPlan(v, { x: 40, y: 40, w: 2, h: 2 });
    expect(plan.loneMachineTile).toEqual({ tileX: 40, tileY: 40 });
  });

  it('does not single one out when the drag holds more than it', () => {
    const v = withMachine(view(), 7, MachineKind.Fryer, 10, 10, 2, 2);
    withBelt(v, 3, 12, 10, Direction.East, 2);
    const plan = teardownPlan(v, { x: 10, y: 10, w: 4, h: 2 });
    expect(plan.loneMachineTile).toBeNull();
  });
});
