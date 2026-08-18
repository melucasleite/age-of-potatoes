// The right button, after item 129 swapped its second rung from maintenance to teardown.
//
// THREE THINGS ARE PINNED HERE, AND ALL THREE FAIL SILENTLY IF THEY BREAK — which is the bar
// this repo sets for what deserves a test at all:
//
//   1. THE CANCEL RUNG STILL WINS. A teardown that ate the cancel press would DESTROY the
//      half-drawn belt run the player just asked to get back. Nothing throws; a factory is
//      simply one object smaller than it was, and the player believes they pressed the wrong
//      thing. This is the whole safety argument for the ordering and it is one line of code
//      away from being the opposite.
//
//   2. THE TWO GESTURES PICK THE SAME OBJECT. `pointer.ts` calls the armed tool's own
//      `teardownCommands`, so this cannot drift by construction — but "cannot drift by
//      construction" is a claim about today's call graph, and the sweep below is what turns it
//      into a fact that stays true. Item 120 exists because two teardown paths DID disagree on a
//      belt/pipe crossing, and the failure was a player's belt vanishing under a click that
//      promised a pipe. Compared over EVERY tile of a furnished lot rather than the interesting
//      three, because "the interesting tiles" is exactly the judgement that missed it last time.
//
//   3. WHAT IS TORN DOWN COMES BACK. Item 054's promise — a machine into the bag as a box, a
//      belt, arm or pipe refunded in cash — is the entire justification for putting a
//      destructive verb on a naked mouse button with no confirm. It is asserted against the REAL
//      REDUCER here, not read off a comment, because a right-click that destroyed something
//      irrecoverably would be indistinguishable from one that worked until the player went
//      looking for the Fryer they meant to move.

import { describe, expect, it } from 'vitest';
import {
  BeltTier,
  CropId,
  Direction,
  GrabberTier,
  IntentAction,
  ItemId,
  LiquidId,
  MachineKind,
  SUBTILE,
  TechId,
  beltAt,
  boxedItemForMachine,
  createWorld,
  createWorldView,
  isFieldTile,
  grabberAt,
  isOwnedTile,
  itemCount,
  machineAt,
  pipeAt,
  step,
  view,
} from '@snack/sim';
import type { Camera } from '@/game/render/camera';
import type { Command, WorldState, WorldView } from '@snack/sim';

import { CommandQueue } from './commands';
import type { InputHost } from './context';
import type { InputSystem } from './system';
import { PointerInput } from './pointer';
import { ToolMode } from './tools';

const TILE_PX = 32;

/** Everything researched and money to burn, so every refusal is about the tile. */
function world(): WorldState {
  const state = createWorld(9137);
  state.moneyCents = 100_000_000;
  state.unlocked = [TechId.Belts, TechId.Pumps, TechId.PipedSprinklers];
  return state;
}

function run(state: WorldState, ...commands: Command[]): void {
  step(state, { tick: state.tick, commands });
}

function project(state: WorldState): WorldView {
  return view(state, createWorldView());
}

function standOn(state: WorldState, tileX: number, tileY: number): void {
  state.player.xSub = tileX * SUBTILE + SUBTILE / 2;
  state.player.ySub = tileY * SUBTILE + SUBTILE / 2;
}

/** The left end of a horizontal strip of clear, owned, non-field ground with room above/below. */
function clearStrip(state: WorldState, span: number): { x: number; y: number } {
  for (let y = 1; y < 20; y++) {
    for (let x = 0; x + span < 20; x++) {
      let ok = true;
      for (let i = 0; i < span; i++) {
        for (let dy = -1; dy <= 1; dy++) {
          const tx = x + i;
          const ty = y + dy;
          if (!isOwnedTile(state, tx, ty)) ok = false;
          if (isFieldTile(state, tx, ty)) ok = false;
          if (machineAt(state, tx, ty) !== null) ok = false;
        }
      }
      if (ok) return { x, y };
    }
  }
  throw new Error('no clear strip on the starting lot');
}

/**
 * A lot with one of everything on it, INCLUDING A PIPE CROSSING A BELT — the stacked tile item
 * 120 settled and the one tile the two gestures could ever have disagreed about.
 *
 * Searched for rather than hard-coded, the rule `belt-run.test.ts` set: the starting lot moves
 * between releases and a test that hard-codes (3,3) starts failing for reasons that have nothing
 * to do with the mouse. Every placement is asserted to have LANDED, because a sweep over a world
 * where the belt was silently refused would pass while comparing nothing at all.
 */
function furnished(): { state: WorldState; belt: { x: number; y: number } } {
  const state = world();
  const strip = clearStrip(state, 4);

  run(state, {
    type: 'PlaceBelt',
    tier: BeltTier.Basic,
    tileX: strip.x,
    tileY: strip.y,
    dir: Direction.East,
    lengthTiles: 4,
  });
  expect(beltAt(state, strip.x, strip.y)).not.toBeNull();

  run(state, {
    type: 'PlaceGrabber',
    tier: GrabberTier.Mk1,
    tileX: strip.x,
    tileY: strip.y + 1,
    dir: Direction.North,
    filter: 0,
  });

  run(state, {
    type: 'PlacePipe',
    liquid: LiquidId.Water,
    path: [
      { x: strip.x + 1, y: strip.y - 1 },
      { x: strip.x + 1, y: strip.y },
      { x: strip.x + 1, y: strip.y + 1 },
    ],
  });
  expect(pipeAt(state, strip.x + 1, strip.y)).not.toBeNull();
  expect(beltAt(state, strip.x + 1, strip.y)).not.toBeNull();

  return { state, belt: strip };
}

/**
 * A Sprinkler on clear ground, returned by tile.
 *
 * THE STARTING LOT HAS EXACTLY ONE MACHINE AND IT IS THE SELL BIN — the one thing in the game
 * with no box (`boxedItemForMachine` is null for it), which makes it the worst possible subject
 * for a test about things landing in the bag and the best possible one for the test that nothing
 * does. So the machine tests place their own. A Sprinkler because it needs no tech, is 1×1, and
 * has a box like everything else that is not the bin.
 */
function sprinklerOn(state: WorldState): { tileX: number; tileY: number } {
  const spot = clearStrip(state, 1);
  run(state, {
    type: 'PlaceMachine',
    kind: MachineKind.Sprinkler,
    tileX: spot.x,
    tileY: spot.y,
  });
  expect(machineAt(state, spot.x, spot.y)).not.toBeNull();
  return { tileX: spot.x, tileY: spot.y };
}

/** A tile with nothing of ours on it at all — not a machine, a belt, an arm or a pipe. */
function bareTile(state: WorldState): { tileX: number; tileY: number } {
  for (let y = 1; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      if (!isOwnedTile(state, x, y)) continue;
      if (isFieldTile(state, x, y)) continue;
      if (machineAt(state, x, y) !== null) continue;
      if (beltAt(state, x, y) !== null) continue;
      if (pipeAt(state, x, y) !== null) continue;
      if (grabberAt(state, x, y) !== null) continue;
      return { tileX: x, tileY: y };
    }
  }
  throw new Error('no bare tile on the starting lot');
}

/**
 * The real `PointerInput` over a fake canvas — `pointer.test.ts`'s harness, kept local because
 * this file drives it against a REAL world rather than a hand-built projection.
 */
function harness(worldView: WorldView, tool: ToolMode) {
  const canvasListeners = new Map<string, (event: unknown) => void>();
  const canvas = {
    addEventListener: (name: string, fn: (event: unknown) => void) => {
      canvasListeners.set(name, fn);
    },
    removeEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 640 }),
  } as unknown as HTMLCanvasElement;
  const camera = {
    transform: { viewWidth: 640, viewHeight: 640, zoom: 1 },
    screenToWorld: (x: number, y: number) => ({ x, y }),
    worldToScreen: (x: number, y: number) => ({ x, y }),
  } as unknown as Camera;
  const queue = new CommandQueue();
  let armed = tool;
  const host = {
    canvas,
    camera,
    queue,
    overlayRoot: undefined as unknown as HTMLElement,
    latestView: () => worldView,
    getTool: () => armed,
    setTool: (t: ToolMode) => {
      armed = t;
    },
    setHover: () => {},
    toggleOverlay: () => {},
  } as unknown as InputHost;
  const system = {
    spaceHeld: false,
    placeDir: Direction.East,
    armedCrop: CropId.RussetPotato,
    manualWalkHeld: false,
  } as unknown as InputSystem;
  const pointer = new PointerInput(host, system);
  pointer.attach();

  const fire = (name: string, event: Record<string, unknown>) => {
    canvasListeners.get(name)!({ preventDefault: () => {}, pointerId: 1, ...event });
  };
  const at = (tileX: number, tileY: number) => ({
    clientX: tileX * TILE_PX + TILE_PX / 2,
    clientY: tileY * TILE_PX + TILE_PX / 2,
  });
  return {
    pointer,
    queue,
    listeners: canvasListeners,
    pressAt: (x: number, y: number, button = 0) => fire('pointerdown', { button, ...at(x, y) }),
    releaseAt: (x: number, y: number, button = 0) => fire('pointerup', { button, ...at(x, y) }),
    arm: (t: ToolMode) => host.setTool(t),
  };
}

/** What the right button emits on one tile, with nothing armed and nothing in flight. */
function rightClick(worldView: WorldView, tileX: number, tileY: number): Command[] {
  const h = harness(worldView, ToolMode.Hand);
  h.pressAt(tileX, tileY, 2);
  // Copied out of the queue's readonly view so the callers can spread it into `run`.
  return [...h.queue.drain()];
}

/** What the ARMED teardown tool emits on the same tile: press and release, a 1×1 rect. */
function armedTeardown(worldView: WorldView, tileX: number, tileY: number): Command[] {
  const h = harness(worldView, ToolMode.Deconstruct);
  h.pressAt(tileX, tileY);
  h.releaseAt(tileX, tileY);
  return [...h.queue.drain()];
}

describe('the right button tears down ([[129]])', () => {
  it('takes the belt tile under the cursor, and the sim refunds it', () => {
    const { state, belt } = furnished();
    standOn(state, belt.x, belt.y + 2);

    const commands = rightClick(project(state), belt.x, belt.y);
    expect(commands).toHaveLength(1);

    const before = state.moneyCents;
    run(state, ...commands);
    expect(beltAt(state, belt.x, belt.y)).toBeNull();
    // ITEM 054'S PROMISE, HALF ONE: cash back on the spot, not a hole in the ground.
    expect(state.moneyCents).toBeGreaterThan(before);
  });

  it('takes the machine under the cursor, and it lands in the BAG as a box ([[054]])', () => {
    const state = world();
    const machine = sprinklerOn(state);
    const boxed = boxedItemForMachine(MachineKind.Sprinkler)!;
    standOn(state, machine.tileX, machine.tileY);

    const held = itemCount(state, boxed);
    const before = state.moneyCents;
    const commands = rightClick(project(state), machine.tileX, machine.tileY);
    run(state, ...commands);

    expect(machineAt(state, machine.tileX, machine.tileY)).toBeNull();
    // ITEM 054'S PROMISE, HALF TWO: into the bag as a box, and NOT sold — boxing is not
    // selling, and the money not moving is the fact that says so.
    expect(itemCount(state, boxed)).toBe(held + 1);
    expect(state.moneyCents).toBe(before);
  });

  it('walks to a machine across the lot instead of being silently refused', () => {
    const state = world();
    const machine = sprinklerOn(state);
    // Stand well outside hand reach of it.
    standOn(state, machine.tileX + 12, machine.tileY + 8);

    const commands = rightClick(project(state), machine.tileX, machine.tileY);
    expect(commands).toMatchObject([
      { type: 'WalkAndAct', action: IntentAction.Deconstruct, tileX: machine.tileX },
    ]);
  });

  it('emits nothing at all on bare ground', () => {
    const { state } = furnished();
    const bare = bareTile(state);
    expect(rightClick(project(state), bare.tileX, bare.tileY)).toEqual([]);
  });

  it('takes NOTHING from the sell bin, which has no box ([[076]])', () => {
    const state = world();
    const v = project(state);
    const bin = v.machines.find((m) => m.kind === MachineKind.SellBin);
    expect(bin).toBeDefined();
    standOn(state, bin!.tileX, bin!.tileY);
    // No command rather than a refusal: a refused command per click is noise in the queue.
    expect(rightClick(project(state), bin!.tileX, bin!.tileY)).toEqual([]);
  });
});

describe('the cancel rung still wins, and it is first', () => {
  /** Press a far tile with Plant: the press walks, the queue holds its errand, release. */
  function workingQueue(state: WorldState) {
    const v = project(state);
    const h = harness(v, ToolMode.Plant);
    h.pressAt(2, 14);
    h.releaseAt(2, 14);
    expect(h.queue.drain().length).toBeGreaterThan(0);
    expect(h.pointer.dragging).toBe(true);
    return h;
  }

  it('cancels a working queue and tears down NOTHING', () => {
    const { state, belt } = furnished();
    standOn(state, 2, 2);
    const h = workingQueue(state);

    // Right-click straight onto a belt tile: the cancel is what happens, not the teardown.
    h.pressAt(belt.x, belt.y, 2);
    expect(h.pointer.dragging).toBe(false);
    expect(h.queue.drain()).toEqual([]);
  });

  it('cancels a live teardown drag rather than tearing down where it was released', () => {
    const { state, belt } = furnished();
    standOn(state, belt.x, belt.y + 2);
    const h = harness(project(state), ToolMode.Deconstruct);
    h.pressAt(belt.x, belt.y);
    expect(h.pointer.dragging).toBe(true);

    h.pressAt(belt.x + 2, belt.y, 2);
    expect(h.pointer.dragging).toBe(false);
    expect(h.queue.drain()).toEqual([]);
  });
});

describe('one picking rule, not two ([[120]])', () => {
  it('agrees with the armed teardown tool on EVERY tile of a furnished lot', () => {
    const { state } = furnished();
    const v = project(state);

    let compared = 0;
    let nonEmpty = 0;
    const disagreements: string[] = [];

    for (let y = 0; y < v.worldTilesHigh; y++) {
      for (let x = 0; x < v.worldTilesWide; x++) {
        const right = rightClick(v, x, y);
        const armed = armedTeardown(v, x, y);
        compared += 1;
        if (right.length > 0) nonEmpty += 1;
        if (JSON.stringify(right) !== JSON.stringify(armed)) {
          disagreements.push(`(${x},${y}): ${JSON.stringify(right)} vs ${JSON.stringify(armed)}`);
        }
      }
    }

    expect(disagreements).toEqual([]);
    // A sweep that found nothing to remove anywhere would agree vacuously.
    expect(compared).toBeGreaterThan(100);
    expect(nonEmpty).toBeGreaterThan(0);
  });

  it('takes the PIPE and leaves the belt on a crossing, exactly as the tool does', () => {
    const { state, belt } = furnished();
    const cross = { x: belt.x + 1, y: belt.y };
    standOn(state, cross.x, cross.y + 2);

    const commands = rightClick(project(state), cross.x, cross.y);
    expect(commands).toMatchObject([{ type: 'RemovePipe' }]);

    run(state, ...commands);
    expect(pipeAt(state, cross.x, cross.y)).toBeNull();
    // The half of item 120's rule the player would otherwise learn by watching a belt survive.
    expect(beltAt(state, cross.x, cross.y)).not.toBeNull();

    // And the second click takes what the first one left, which is the whole promise.
    const second = rightClick(project(state), cross.x, cross.y);
    run(state, ...second);
    expect(beltAt(state, cross.x, cross.y)).toBeNull();
  });
});

describe('the browser context menu stays suppressed', () => {
  it('binds `contextmenu` on the canvas and prevents it', () => {
    const { state } = furnished();
    const h = harness(project(state), ToolMode.Hand);
    const onContextMenu = h.listeners.get('contextmenu');
    expect(onContextMenu).toBeDefined();

    let prevented = false;
    onContextMenu!({ preventDefault: () => (prevented = true) } as unknown as Event);
    expect(prevented).toBe(true);
  });
});

describe('the repair kit is still the priced route, and the bag still holds one', () => {
  it('a kit spent beside a worn machine restores it — maintenance did not die with the key', () => {
    const state = world();
    const machine = sprinklerOn(state);

    const target = machineAt(state, machine.tileX, machine.tileY)!;
    target.condition = 100;

    // BOUGHT rather than pushed into the inventory array, so the kit that gets spent is one the
    // real economy handed over — and buying it means standing AT THE STAND, which is `nearSellBin`
    // and is exactly what the card's "the stand sells them" line is telling the player to do.
    const bin = state.machines.find((m) => m.kind === MachineKind.SellBin)!;
    standOn(state, bin.tileX, bin.tileY);
    run(state, { type: 'BuyItem', item: ItemId.RepairKit, count: 1 });
    expect(itemCount(state, ItemId.RepairKit)).toBe(1);

    standOn(state, machine.tileX, machine.tileY);

    run(state, { type: 'UseRepairKit', tileX: machine.tileX, tileY: machine.tileY });
    expect(target.condition).toBeGreaterThan(100);
    expect(itemCount(state, ItemId.RepairKit)).toBe(0);
  });
});
