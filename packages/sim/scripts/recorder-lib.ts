// Shared machinery for the fixture recorders (items 145/146/147 re-recordings).
//
// A golden fixture is `{seed, commands, ticks, expectedHash}` replayed from a fresh world, so
// a recorder may only ever act through `step()` — no state pokes — and the trace it dumps is
// the sim's own record of what applied. These helpers are `record-maintenance.ts`'s, extracted
// once instead of pasted five times:
//
//   * `apply` issues one command and reports whether the sim accepted it;
//   * `errand` runs a walk-to errand to completion (refilling the can before a dry watering);
//   * `walkNear` walks the farmer by held directions until a machine is within hand reach,
//     which is what DIRECT commands (LoadMachine, RefillHopper, WhackJam, RepairMachine …)
//     require — an errand arrival is deliberately not traced, so a fixture that wants those
//     verbs IN its trace has to walk over and click them the way a player does;
//   * `writeFixture` dumps the trace and pins the hash.
//
// Every recorder asserts its story before writing — the assert here just throws with a name.

import { writeFileSync } from 'node:fs';

import {
  type Command,
  type WorldState,
  Direction,
  IntentAction,
  createWorld,
  hashState,
  machineCentreSubtiles,
  step,
} from '../src/index';
import { POND_ORIGIN_X, POND_ORIGIN_Y } from '../src/data';
import { type Machine } from '../src/state';
import { type GoldenFixture, fixturePath } from '../test/goldens';

/** One tile west of the pond — shore, so a `RefillCan` errand aimed here succeeds. */
export const SHORE_X = POND_ORIGIN_X - 1;
export const SHORE_Y = POND_ORIGIN_Y;

export interface Recorder {
  state: WorldState;
  stepEmpty(): void;
  idle(ticks: number): void;
  apply(command: Command): boolean;
  mustApply(command: Command, why: string): void;
  finishIntent(): void;
  errand(
    action: IntentAction,
    tileX: number,
    tileY: number,
    item?: number,
    count?: number,
  ): boolean;
  walkNear(machine: Machine): void;
  walkNearTile(tileX: number, tileY: number): void;
  writeFixture(name: string, description: string, extra?: Partial<GoldenFixture>): GoldenFixture;
}

export function recorder(seed: number, scriptName: string): Recorder {
  const state = createWorld(seed);

  const fail = (why: string): never => {
    throw new Error(`${scriptName}: ${why}`);
  };

  const stepEmpty = (): void => {
    step(state, { tick: state.tick, commands: [] });
  };

  const idle = (ticks: number): void => {
    for (let i = 0; i < ticks; i++) stepEmpty();
  };

  const apply = (command: Command): boolean => {
    const before = state.trace.length;
    step(state, { tick: state.tick, commands: [command] });
    return state.trace.length > before;
  };

  const mustApply = (command: Command, why: string): void => {
    if (!apply(command)) fail(`refused: ${why} (${command.type})`);
  };

  const finishIntent = (): void => {
    let guard = 0;
    while (state.player.intent !== null) {
      stepEmpty();
      guard += 1;
      if (guard > 30_000) fail('errand never completed');
    }
  };

  const errand = (
    action: IntentAction,
    tileX: number,
    tileY: number,
    item = 0,
    count = 0,
  ): boolean => {
    finishIntent();
    if (action === IntentAction.Water && state.player.canCharges <= 0) {
      if (!errand(IntentAction.RefillCan, SHORE_X, SHORE_Y)) fail('refill refused');
    }
    const ok = apply({ type: 'WalkAndAct', action, tileX, tileY, item, count });
    if (ok) finishIntent();
    return ok;
  };

  /** Walk by held directions until a subtile point is within hand reach, with margin. */
  const walkNearPoint = (target: () => { xSub: number; ySub: number }): void => {
    finishIntent();
    const closeEnough = (): boolean => {
      const centre = target();
      const dx = centre.xSub - state.player.xSub;
      const dy = centre.ySub - state.player.ySub;
      // 370 < HAND_REACH_SUBTILES (384): inside reach with a margin, not on its edge.
      return dx * dx + dy * dy <= 370 * 370;
    };
    let guard = 0;
    while (!closeEnough()) {
      guard += 1;
      if (guard > 20_000) fail('walk to the target never arrived');
      const centre = target();
      const dx = centre.xSub - state.player.xSub;
      const dy = centre.ySub - state.player.ySub;
      const desired =
        Math.abs(dx) >= Math.abs(dy)
          ? dx >= 0
            ? Direction.East
            : Direction.West
          : dy >= 0
            ? Direction.South
            : Direction.North;
      if (state.player.moveDir !== desired) {
        apply({ type: 'SetMoveDirection', dir: desired });
      } else {
        stepEmpty();
      }
    }
    if (state.player.moveDir !== Direction.None) {
      apply({ type: 'SetMoveDirection', dir: Direction.None });
    }
  };

  /**
   * Walk by held directions until the machine's CENTRE is within hand reach — the same point
   * `withinReachOfMachine` measures from. Machines are not solid, so the straight-line walk
   * onto or beside the footprint always lands.
   */
  const walkNear = (machine: Machine): void => {
    walkNearPoint(() => machineCentreSubtiles(machine));
  };

  /** The same, aimed at one tile — what the belt and grabber verbs measure reach against. */
  const walkNearTile = (tileX: number, tileY: number): void => {
    walkNearPoint(() => ({ xSub: tileX * 256 + 128, ySub: tileY * 256 + 128 }));
  };

  const writeFixture = (
    name: string,
    description: string,
    extra: Partial<GoldenFixture> = {},
  ): GoldenFixture => {
    const fixture: GoldenFixture = {
      name,
      description,
      seed,
      ticks: state.tick,
      expectedHash: hashState(state),
      commands: state.trace.map((entry) => ({ tick: entry.tick, command: entry.command })),
      ...extra,
    };
    writeFileSync(fixturePath(name), `${JSON.stringify(fixture, null, 2)}\n`);
    return fixture;
  };

  return {
    state,
    stepEmpty,
    idle,
    apply,
    mustApply,
    finishIntent,
    errand,
    walkNear,
    walkNearTile,
    writeFixture,
  };
}
