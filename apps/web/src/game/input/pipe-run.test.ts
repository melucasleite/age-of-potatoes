// The pipe-laying gesture, checked against the two golden fixtures that are its spec.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  THE SIM REGRESSION-PINNED A GAME NO PLAYER COULD PLAY, AND THAT IS WHAT THIS FILE USES.
//
//  `packages/sim/test/fixtures/water-works.json` and `soda-line.json` build a complete water
//  main and a complete soda line out of `PlacePipe` commands — nine of them between the two —
//  and until [[101]] there was no code path in `apps/web` that could issue a single one. The
//  fixtures were therefore a written record of a feature the client did not have, authored by
//  the people who designed the layer, in the exact form the reducer accepts.
//
//  So this file does not invent runs to test. It READS THE FIXTURES, takes each `PlacePipe`
//  they contain, and asks two questions of it:
//
//    1. Can the gesture EXPRESS this run — is there a press tile and a release tile that make
//       `elbowBetween` produce this exact path, in this exact order?
//    2. Would `pipeRunLiquid` reach the liquid the fixture chose, from the machines standing
//       around that run — with no picker, no key and nothing for the player to get wrong?
//
//  A yes to both is the acceptance criterion "a player can reproduce water-works.json by hand"
//  in executable form, and it is a far better witness than a run somebody made up here: these
//  paths are what the design intends a working network to look like.
// ────────────────────────────────────────────────────────────────────────────────────
//
// Nothing here is browser-bound. `elbowBetween`/`runTiles` are pure geometry and
// `pipeRunLiquid` takes a projection and a tile list, which is why the whole fixture is a
// `readFileSync` and a `createWorldView()`.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { CropId, LiquidId, MachineKind, createWorldView } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { elbowBetween, runTiles } from './gesture';
import { dragCommands, pipeRunLiquid } from './pointer';
import { ToolMode } from './tools';

interface PipeNode {
  x: number;
  y: number;
}
interface PlacePipeEntry {
  type: string;
  liquid?: number;
  path?: PipeNode[];
  kind?: number;
  tileX?: number;
  tileY?: number;
}

/** Every command of one type out of a golden fixture, read as plain JSON. */
function fixtureCommands(name: string, type: string): PlacePipeEntry[] {
  const url = new URL(`../../../../../packages/sim/test/fixtures/${name}.json`, import.meta.url);
  const parsed = JSON.parse(readFileSync(url, 'utf8')) as {
    commands: { command: PlacePipeEntry }[];
  };
  return parsed.commands.map((entry) => entry.command).filter((command) => command.type === type);
}

const WATER_WORKS_PIPES = fixtureCommands('water-works', 'PlacePipe');
const SODA_LINE_PIPES = fixtureCommands('soda-line', 'PlacePipe');
const SODA_LINE_MACHINES = fixtureCommands('soda-line', 'PlaceMachine');
const WATER_WORKS_MACHINES = fixtureCommands('water-works', 'PlaceMachine');

/**
 * The drag that would lay this path: press on its first tile, release on its last.
 *
 * Both leads are tried because R flips which axis the L leads with, and the player has R. A
 * path the gesture can only reach with the flip is still a path the gesture can reach.
 */
function dragReproduces(path: PipeNode[]): boolean {
  const anchor = { tileX: path[0]!.x, tileY: path[0]!.y };
  const cursor = { tileX: path[path.length - 1]!.x, tileY: path[path.length - 1]!.y };
  const wanted = path.map((node) => ({ tileX: node.x, tileY: node.y }));
  for (const flipped of [false, true]) {
    if (
      JSON.stringify(runTiles(elbowBetween(anchor, cursor, flipped))) === JSON.stringify(wanted)
    ) {
      return true;
    }
  }
  return false;
}

/** A view carrying exactly the machines a fixture placed, at the tiles it placed them on. */
function worldOf(placements: PlacePipeEntry[]): WorldView {
  const view = createWorldView();
  let id = 1;
  for (const placement of placements) {
    const spec = MACHINE_FOOTPRINTS[placement.kind!] ?? { w: 1, h: 1 };
    view.machines.push({
      id: id++,
      kind: placement.kind!,
      tileX: placement.tileX!,
      tileY: placement.tileY!,
      tilesWide: spec.w,
      tilesHigh: spec.h,
    } as WorldView['machines'][number]);
  }
  return view;
}

/**
 * Footprints, taken from the sim rather than typed — but through a tiny table because
 * `machineSpec` is what the code under test already reads, and a fixture helper that shares the
 * production lookup can agree with a bug rather than catch one.
 */
const MACHINE_FOOTPRINTS: Readonly<Record<number, { w: number; h: number }>> = {
  [MachineKind.ChipKitchen]: { w: 2, h: 2 },
  [MachineKind.Pump]: { w: 1, h: 1 },
  [MachineKind.Tank]: { w: 2, h: 2 },
  [MachineKind.PipedSprinkler]: { w: 1, h: 1 },
  [MachineKind.IrrigationHub]: { w: 2, h: 2 },
  [MachineKind.Juicer]: { w: 2, h: 2 },
  [MachineKind.Kettle]: { w: 2, h: 2 },
  [MachineKind.Grinder]: { w: 2, h: 2 },
  [MachineKind.SyrupMixer]: { w: 2, h: 2 },
  [MachineKind.Carbonator]: { w: 2, h: 2 },
  [MachineKind.Bottler]: { w: 3, h: 2 },
};

function tilesOf(path: PipeNode[]): { tileX: number; tileY: number }[] {
  return path.map((node) => ({ tileX: node.x, tileY: node.y }));
}

/** Put a laid run into the projection, so the next drag sees the world the player would. */
function layPipes(
  view: WorldView,
  tiles: readonly { tileX: number; tileY: number }[],
  liquid: number,
): void {
  for (const tile of tiles) {
    view.pipes.push({
      tileX: tile.tileX,
      tileY: tile.tileY,
      liquid,
      network: 1,
      flowPermille: 0,
    } as WorldView['pipes'][number]);
  }
}

describe('the pipe drag reproduces the goldens ([[101]])', () => {
  it('finds nine pipe runs to answer for', () => {
    // A guard on the guard: if the fixtures are ever re-recorded without their pipes, every
    // assertion below would pass over an empty list and this file would silently test nothing.
    expect(WATER_WORKS_PIPES.length).toBe(2);
    expect(SODA_LINE_PIPES.length).toBe(7);
  });

  it('lays water-works.json’s water main as ONE drag, corner and all', () => {
    // Seventeen tiles, eight west and nine north, and the elbow lands on the tile the fixture
    // put it on. This is the single most load-bearing claim in the item: the belt's `line`
    // gesture already draws exactly the shape the water layer was designed around.
    const main = WATER_WORKS_PIPES[0]!.path!;
    expect(main.length).toBe(17);
    expect(dragReproduces(main)).toBe(true);
  });

  it('expresses every pipe run in both fixtures as a single drag', () => {
    for (const command of [...WATER_WORKS_PIPES, ...SODA_LINE_PIPES]) {
      const path = command.path!;
      expect(dragReproduces(path), `no drag lays ${JSON.stringify(path)}`).toBe(true);
    }
  });

  it('lays a one-tile run from a click, which is a drag that never moved', () => {
    // `soda-line.json` contains two of these. A click with the pipe armed has to be a legal
    // one-tile run or the last fitting on a line is unreachable.
    const singles = SODA_LINE_PIPES.filter((command) => command.path!.length === 1);
    expect(singles.length).toBe(2);
    for (const command of singles) expect(dragReproduces(command.path!)).toBe(true);
  });
});

describe('the run works out its own liquid ([[101]])', () => {
  it('reads every soda-line stub off the machines it touches, with no picker', () => {
    // THE WHOLE DESIGN, ON TRIAL. Four stubs, four different liquids — cane juice, simple
    // syrup, soda syrup, carbonated water — and the player never says which. Each one runs
    // between two machines whose port lists overlap in exactly one liquid, and that liquid is
    // the one the fixture's author chose by hand.
    const view = worldOf(SODA_LINE_MACHINES);
    const stubs = SODA_LINE_PIPES.filter((command) => command.liquid !== LiquidId.Water);
    expect(stubs.length).toBe(4);
    for (const command of stubs) {
      expect(
        pipeRunLiquid(view, tilesOf(command.path!)),
        `stub at ${JSON.stringify(command.path![0])} guessed the wrong liquid`,
      ).toBe(command.liquid);
    }
  });

  it('reads soda-line.json’s water main and both its stubs as water, laid in order', () => {
    // LAID IN ORDER, AND THE ORDER IS THE TEST. The main goes down first, out of the pump; the
    // two single-tile stubs then join it to reach the Carbonator and the Syrup Mixer. Each stub
    // touches a machine that handles two liquids — the Carbonator takes water in and sends fizz
    // out — so on bare ground it would be a genuine coin-toss, and it is not a coin-toss here
    // because THE MAIN IS ALREADY THERE. Two liquids never meet, so a run beside water is
    // water, full stop, before any other rule gets a turn.
    //
    // Worth saying plainly, because it is the shape of the whole feature: the inference is
    // sharpest exactly when the player is doing the obvious thing, and the obvious thing is to
    // run the trunk before the branches.
    const view = worldOf(SODA_LINE_MACHINES);
    for (const command of SODA_LINE_PIPES.filter((c) => c.liquid === LiquidId.Water)) {
      const tiles = tilesOf(command.path!);
      expect(
        pipeRunLiquid(view, tiles),
        `run at ${JSON.stringify(command.path![0])} guessed the wrong liquid`,
      ).toBe(LiquidId.Water);
      layPipes(view, tiles, LiquidId.Water);
    }
  });

  it('reads a run across bare ground as water, which is water-works.json’s whole layer', () => {
    // The commonest drag in the game and the simplest branch: nothing touched, so nothing
    // narrowed, so the fallback answers. Water is the only liquid with a source in the WORLD
    // rather than inside a machine, which is what makes it the only honest default.
    const empty = createWorldView();
    for (const command of WATER_WORKS_PIPES) {
      expect(pipeRunLiquid(empty, tilesOf(command.path!))).toBe(LiquidId.Water);
    }
  });

  it('joins an existing run rather than starting a second liquid beside it', () => {
    const view = createWorldView();
    view.pipes.push({
      tileX: 5,
      tileY: 5,
      liquid: LiquidId.SimpleSyrup,
      network: 1,
      flowPermille: 0,
    } as WorldView['pipes'][number]);
    // Bare ground, so the fallback would say water — except that the first tile of the run is
    // orthogonally beside syrup, and two liquids never meet. Joining is the only legal reading.
    expect(
      pipeRunLiquid(view, [
        { tileX: 6, tileY: 5 },
        { tileX: 7, tileY: 5 },
      ]),
    ).toBe(LiquidId.SimpleSyrup);
  });

  it('takes what the machine at the ANCHOR sends out when several liquids are legal', () => {
    // A Kettle alone accepts cane juice and emits simple syrup, so both are legal and the run
    // has to break the tie. Dragging AWAY from it is laying its output line.
    const view = createWorldView();
    view.machines.push({
      id: 1,
      kind: MachineKind.Kettle,
      tileX: 3,
      tileY: 3,
      tilesWide: 2,
      tilesHigh: 2,
    } as WorldView['machines'][number]);
    expect(
      pipeRunLiquid(view, [
        { tileX: 5, tileY: 3 },
        { tileX: 6, tileY: 3 },
      ]),
    ).toBe(LiquidId.SimpleSyrup);
  });

  it('says no liquid at all when two machines share none', () => {
    // A Juicer emits cane juice and nothing else; a Carbonator handles water and fizz. A run
    // touching both could carry nothing, and `pipePathRefusal` would call it `PortMismatch` —
    // so the gesture must reach the same verdict rather than quoting a price for it.
    const view = createWorldView();
    view.machines.push(
      {
        id: 1,
        kind: MachineKind.Juicer,
        tileX: 0,
        tileY: 0,
        tilesWide: 2,
        tilesHigh: 2,
      } as WorldView['machines'][number],
      {
        id: 2,
        kind: MachineKind.Carbonator,
        tileX: 3,
        tileY: 0,
        tilesWide: 2,
        tilesHigh: 2,
      } as WorldView['machines'][number],
    );
    expect(pipeRunLiquid(view, [{ tileX: 2, tileY: 0 }])).toBe(LiquidId.None);
  });

  it('is not narrowed by a machine with no plumbing standing beside the run', () => {
    // The sim's rule in as many words: "Machines with no ports at all are invisible to this
    // rule, so a water main may still run past a Fryer."
    const view = createWorldView();
    view.machines.push({
      id: 1,
      kind: MachineKind.Fryer,
      tileX: 3,
      tileY: 3,
      tilesWide: 2,
      tilesHigh: 2,
    } as WorldView['machines'][number]);
    expect(
      pipeRunLiquid(view, [
        { tileX: 5, tileY: 3 },
        { tileX: 5, tileY: 4 },
      ]),
    ).toBe(LiquidId.Water);
  });
});

describe('the pipe drag becomes one PlacePipe ([[101]])', () => {
  function drag(view: WorldView, from: { x: number; y: number }, to: { x: number; y: number }) {
    return dragCommands(
      view,
      {
        pointerId: 1,
        anchor: { tileX: from.x, tileY: from.y },
        cursor: { tileX: to.x, tileY: to.y },
        tool: ToolMode.PlacePipe,
        flipped: false,
      },
      CropId.RussetPotato,
    );
  }

  it('emits water-works.json’s water main byte for byte', () => {
    // The end of the chain: press, release, and the command that comes out is the one the
    // golden fixture holds — same type, same liquid, same path, same order. `PlacePipe` had
    // zero issuers in this app before this line could be written.
    const main = WATER_WORKS_PIPES[0]!;
    const path = main.path!;
    const first = path[0]!;
    const last = path[path.length - 1]!;
    expect(drag(createWorldView(), first, last)).toEqual([
      { type: 'PlacePipe', liquid: main.liquid, path },
    ]);
  });

  it('emits ONE command for a bent run, never two', () => {
    // A corner is not two runs. `applyPlacePipe` accepts or refuses a whole path and there is
    // no partial lay, so a drag that split into two commands could leave a stub the player has
    // to go and find — the argument `commands.ts` makes for belts, inherited here.
    const commands = drag(createWorldView(), { x: 2, y: 2 }, { x: 8, y: 6 });
    expect(commands.length).toBe(1);
    expect(commands[0]!.type).toBe('PlacePipe');
  });

  it('says nothing at all when no liquid could fill the run', () => {
    // Not a refusal by the input layer (§12) — an inability to form a sentence. `LiquidId.None`
    // is not a liquid and a `PlacePipe` carrying it would be malformed rather than rejected.
    const view = createWorldView();
    view.machines.push(
      {
        id: 1,
        kind: MachineKind.Juicer,
        tileX: 0,
        tileY: 0,
        tilesWide: 2,
        tilesHigh: 2,
      } as WorldView['machines'][number],
      {
        id: 2,
        kind: MachineKind.Carbonator,
        tileX: 3,
        tileY: 0,
        tilesWide: 2,
        tilesHigh: 2,
      } as WorldView['machines'][number],
    );
    expect(drag(view, { x: 2, y: 0 }, { x: 2, y: 0 })).toEqual([]);
  });

  it('leaves the water-works machines where the fixture put them', () => {
    // A cheap canary on the fixture reader itself: if the JSON shape ever changes under this
    // file, the machine list goes empty and the liquid tests above start passing vacuously.
    expect(WATER_WORKS_MACHINES.length).toBeGreaterThan(0);
    expect(WATER_WORKS_MACHINES.some((command) => command.kind === MachineKind.Pump)).toBe(true);
  });
});
