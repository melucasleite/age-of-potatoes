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
//       around that run — with nothing for the player to get wrong?
//
//  A yes to both is the acceptance criterion "a player can reproduce water-works.json by hand"
//  in executable form, and it is a far better witness than a run somebody made up here: these
//  paths are what the design intends a working network to look like.
// ────────────────────────────────────────────────────────────────────────────────────
//
//  AND THE FIXTURES ANSWER A THIRD QUESTION NOBODY HAD ASKED THEM ([[109]]): what ORDER do they
//  build in? Both of them lay every pipe before a single plumbed machine exists — `water-works`
//  runs its 17-tile main six thousand ticks ahead of the pump it feeds — which is the order the
//  bug report calls "the normal way anyone builds", recorded by the design itself. That fact
//  decided the fix: a run nothing has typed lays nothing and says so, and `L` is how the player
//  answers when they are building in that order. Refusing outright would have been cheaper and
//  would have made both goldens' build order unplayable.
// ────────────────────────────────────────────────────────────────────────────────────
//
// Nothing here is browser-bound. `elbowBetween`/`runTiles` are pure geometry and
// `pipeRunLiquid` takes a projection and a tile list, which is why the whole fixture is a
// `readFileSync` and a `createWorldView()`.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import {
  CropId,
  Direction,
  LIQUID_SPECS,
  LiquidId,
  MachineKind,
  createWorldView,
} from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { elbowBetween, runTiles } from './gesture';
import { dragBand, dragCommands, ghostBand, pipeRunLiquid } from './pointer';
import { nextLiquid } from './system';
import { ToolMode } from './tools';

/** The ghost tests all aim the same 2×2 plumbed machine; naming it once keeps them one line. */
const PLACE_CARB = ToolMode.PlaceCarbonator;
const DIR = Direction.East;

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
  [MachineKind.Washer]: { w: 2, h: 2 },
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
      const carried = pipeRunLiquid(view, tilesOf(command.path!));
      expect(
        carried.liquid,
        `stub at ${JSON.stringify(command.path![0])} guessed the wrong liquid`,
      ).toBe(command.liquid);
      // AND THE WORLD IS WHERE IT CAME FROM ([[109]]). The source matters as much as the
      // answer now: a stub that reached the right liquid through the picker or through a
      // fallback would be a different feature wearing this one's result.
      expect(carried.source).toBe('world');
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
        pipeRunLiquid(view, tiles).liquid,
        `run at ${JSON.stringify(command.path![0])} guessed the wrong liquid`,
      ).toBe(LiquidId.Water);
      layPipes(view, tiles, LiquidId.Water);
    }
  });

  it('says NOTHING about a run across bare ground, instead of quietly saying water ([[109]])', () => {
    // ────────────────────────────────────────────────────────────────────────────────
    //  THE BUG, IN ONE ASSERTION. This test used to require the opposite — "reads a run
    //  across bare ground as water" — and the reasoning was sound about water and wrong
    //  about the player: nothing was touched, so nothing narrowed, so the fallback answered
    //  a question the world had not asked. That is how laying pipe before the machines
    //  produced a silent water main that the soda machine then refused to stand beside.
    //
    //  `untyped` is not `mismatch` and the distinction is the whole fix: nothing here is
    //  ILLEGAL, it is merely undecided, and the band prints a different sentence for each.
    // ────────────────────────────────────────────────────────────────────────────────
    const empty = createWorldView();
    for (const command of WATER_WORKS_PIPES) {
      expect(pipeRunLiquid(empty, tilesOf(command.path!))).toEqual({
        liquid: LiquidId.None,
        source: 'untyped',
      });
    }
  });

  it('lays water-works.json’s main across bare ground once the player has said water', () => {
    // The other half of the same fact, and the reason the fix is a picker rather than a
    // refusal: THE GOLDEN LAYS THIS MAIN BEFORE ITS PUMP EXISTS. `water-works.json` places
    // the 17-tile run six thousand ticks before the Pump it feeds, so a rule that refused
    // untyped runs outright would make the fixture's own build order unplayable. With `L`
    // on water it is expressible again — and the answer is labelled `picked`, because the
    // player said it and the world did not.
    const empty = createWorldView();
    for (const command of WATER_WORKS_PIPES) {
      expect(pipeRunLiquid(empty, tilesOf(command.path!), LiquidId.Water)).toEqual({
        liquid: LiquidId.Water,
        source: 'picked',
      });
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
    // Bare ground otherwise — but the first tile of the run is orthogonally beside syrup, and
    // two liquids never meet. Joining is the only legal reading.
    expect(
      pipeRunLiquid(view, [
        { tileX: 6, tileY: 5 },
        { tileX: 7, tileY: 5 },
      ]).liquid,
    ).toBe(LiquidId.SimpleSyrup);
  });

  it('lets the world overrule a pick rather than the other way round ([[109]])', () => {
    // THE ONE RULE THAT KEEPS THE PICKER HARMLESS. The player has said cane juice; the run is
    // laid beside an existing syrup line. The pick is not consulted at all, because it did not
    // survive the intersection — a picked liquid can answer a silence and break a tie, and it
    // can never argue with something already standing on the lot. Had it won here, the gesture
    // would emit a `PlacePipe` the reducer refuses outright with `LiquidMismatch`.
    const view = createWorldView();
    view.pipes.push({
      tileX: 5,
      tileY: 5,
      liquid: LiquidId.SimpleSyrup,
      network: 1,
      flowPermille: 0,
    } as WorldView['pipes'][number]);
    expect(
      pipeRunLiquid(
        view,
        [
          { tileX: 6, tileY: 5 },
          { tileX: 7, tileY: 5 },
        ],
        LiquidId.CaneJuice,
      ),
    ).toEqual({ liquid: LiquidId.SimpleSyrup, source: 'world' });
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
      ]).liquid,
    ).toBe(LiquidId.SimpleSyrup);
  });

  it('lets the pick settle a tie the direction heuristic would have guessed at ([[109]])', () => {
    // The same Kettle, the same two legal liquids — and a player who has pressed `L` twice for
    // cane juice. The pick is consulted BEFORE the drag's direction, because "I said juice" is
    // a sentence and "you dragged away from it" is an inference about one. The Kettle accepts
    // cane juice, so nothing illegal can come of it.
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
      pipeRunLiquid(
        view,
        [
          { tileX: 5, tileY: 3 },
          { tileX: 6, tileY: 3 },
        ],
        LiquidId.CaneJuice,
      ),
    ).toEqual({ liquid: LiquidId.CaneJuice, source: 'picked' });
  });

  it('ignores a pick the machines could never accept', () => {
    // Soda syrup picked, a Kettle beside the run, and the Kettle handles juice and syrup only.
    // The pick did not survive the intersection, so the run falls back to what the world says
    // rather than forming a command `pipePathRefusal` would answer with `PortMismatch`.
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
      pipeRunLiquid(
        view,
        [
          { tileX: 5, tileY: 3 },
          { tileX: 6, tileY: 3 },
        ],
        LiquidId.SodaSyrup,
      ),
    ).toEqual({ liquid: LiquidId.SimpleSyrup, source: 'world' });
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
    // `mismatch`, NOT `untyped`: everything was ruled out here, rather than nothing ruled in,
    // and the band owes the player a different sentence for each ([[109]]).
    expect(pipeRunLiquid(view, [{ tileX: 2, tileY: 0 }])).toEqual({
      liquid: LiquidId.None,
      source: 'mismatch',
    });
  });

  it('will not let a pick rescue a run that no liquid could fill ([[109]])', () => {
    // The genuinely illegal run, with the player insisting. A Juicer sends cane juice and a
    // Carbonator handles neither juice nor anything the Juicer emits — the intersection is
    // EMPTY, so there is nothing for the pick to be chosen from and the refusal stands. The
    // picker answers open questions; it does not overrule the sim.
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
    expect(pipeRunLiquid(view, [{ tileX: 2, tileY: 0 }], LiquidId.CaneJuice)).toEqual({
      liquid: LiquidId.None,
      source: 'mismatch',
    });
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
    // AND SO IT IS STILL `untyped`, WHICH IS THE POINT ([[109]]): a Fryer standing beside the
    // run does not make the run a decision. Before this item the Fryer's silence and the empty
    // lot's silence both came out as water; now neither does, and the machine that has an
    // opinion is the only thing that can type a run.
    expect(
      pipeRunLiquid(view, [
        { tileX: 5, tileY: 3 },
        { tileX: 5, tileY: 4 },
      ]),
    ).toEqual({ liquid: LiquidId.None, source: 'untyped' });
  });

  it('takes the pick from a machine standing beside a picked run, not from the pick', () => {
    // The soda line in the order the player builds it, in miniature: the run is laid FIRST
    // with cane juice picked, and then a Carbonator — water and fizz, no port for juice — is
    // already standing where the run passes. The machine wins, so the gesture forms the
    // command the sim accepts rather than the one the picker preferred.
    const view = createWorldView();
    view.machines.push({
      id: 1,
      kind: MachineKind.Carbonator,
      tileX: 3,
      tileY: 3,
      tilesWide: 2,
      tilesHigh: 2,
    } as WorldView['machines'][number]);
    const carried = pipeRunLiquid(
      view,
      [
        { tileX: 5, tileY: 3 },
        { tileX: 6, tileY: 3 },
      ],
      LiquidId.CaneJuice,
    );
    expect(carried.liquid).not.toBe(LiquidId.CaneJuice);
    expect(carried.source).toBe('world');
  });
});

describe('the pipe drag becomes one PlacePipe ([[101]])', () => {
  function drag(
    view: WorldView,
    from: { x: number; y: number },
    to: { x: number; y: number },
    picked: LiquidId = LiquidId.None,
  ) {
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
      picked,
    );
  }

  it('emits water-works.json’s water main byte for byte', () => {
    // The end of the chain: press, release, and the command that comes out is the one the
    // golden fixture holds — same type, same liquid, same path, same order. `PlacePipe` had
    // zero issuers in this app before this line could be written.
    //
    // THE WATER IS NOW SAID RATHER THAN ASSUMED ([[109]]). This drag is across bare ground —
    // the fixture lays this main before its pump exists — so the liquid comes from `L`, and
    // that is the only line of this test that moved. The bytes did not.
    const main = WATER_WORKS_PIPES[0]!;
    const path = main.path!;
    const first = path[0]!;
    const last = path[path.length - 1]!;
    expect(drag(createWorldView(), first, last, LiquidId.Water)).toEqual([
      { type: 'PlacePipe', liquid: main.liquid, path },
    ]);
  });

  it('emits ONE command for a bent run, never two', () => {
    // A corner is not two runs. `applyPlacePipe` accepts or refuses a whole path and there is
    // no partial lay, so a drag that split into two commands could leave a stub the player has
    // to go and find — the argument `commands.ts` makes for belts, inherited here.
    const commands = drag(createWorldView(), { x: 2, y: 2 }, { x: 8, y: 6 }, LiquidId.Water);
    expect(commands.length).toBe(1);
    expect(commands[0]!.type).toBe('PlacePipe');
  });

  it('emits nothing at all for a run nothing has typed and nobody has picked ([[109]])', () => {
    // THE REPORTED BUG, AT THE END OF THE CHAIN. This exact drag used to produce a
    // seventeen-tile WATER main on a lot with nothing on it — a $34 decision the player never
    // made and could not see being made. It now produces no command, and the band spent the
    // whole drag saying which two things would fix that.
    const main = WATER_WORKS_PIPES[0]!.path!;
    const first = main[0]!;
    const last = main[main.length - 1]!;
    expect(drag(createWorldView(), first, last)).toEqual([]);
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

  it('lays the same run once the machine it was waiting for is standing there', () => {
    // THE ORDER THE ITEM IS ABOUT, END TO END. The player drags a run across bare ground and
    // gets nothing (above); they place the Carbonator; they drag the same run again and it
    // lays itself, in the machine's own liquid, with no picker touched. This is the case that
    // used to end in a water main and a machine that would not stand next to it.
    const view = createWorldView();
    expect(drag(view, { x: 5, y: 3 }, { x: 6, y: 3 })).toEqual([]);

    view.machines.push({
      id: 1,
      kind: MachineKind.Carbonator,
      tileX: 3,
      tileY: 3,
      tilesWide: 2,
      tilesHigh: 2,
    } as WorldView['machines'][number]);

    const commands = drag(view, { x: 5, y: 3 }, { x: 6, y: 3 });
    expect(commands.length).toBe(1);
    expect(commands[0]).toMatchObject({ type: 'PlacePipe' });
  });

  it('leaves the water-works machines where the fixture put them', () => {
    // A cheap canary on the fixture reader itself: if the JSON shape ever changes under this
    // file, the machine list goes empty and the liquid tests above start passing vacuously.
    expect(WATER_WORKS_MACHINES.length).toBeGreaterThan(0);
    expect(WATER_WORKS_MACHINES.some((command) => command.kind === MachineKind.Pump)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────
//  WHAT THE PLAYER READS ([[109]]).
//
//  A refusal nobody can see is the bug, not the fix — so these assert on the STRINGS, which is
//  unusual in this codebase and deliberate here. The band tag and the ghost tag are the entire
//  user-visible surface of this item; a version of it that reached the right verdict silently
//  would pass every other test in this file and ship the same complaint.
// ────────────────────────────────────────────────────────────────────────────────────

describe('the pipe band explains itself ([[109]])', () => {
  function band(
    view: WorldView,
    from: { x: number; y: number },
    to: { x: number; y: number },
    picked: LiquidId = LiquidId.None,
  ) {
    return dragBand(
      view,
      {
        pointerId: 1,
        anchor: { tileX: from.x, tileY: from.y },
        cursor: { tileX: to.x, tileY: to.y },
        tool: ToolMode.PlacePipe,
        flipped: false,
      },
      CropId.RussetPotato,
      picked,
    );
  }

  it('names both ways out of an untyped run, and quotes no price for it', () => {
    const tag = band(createWorldView(), { x: 5, y: 3 }, { x: 9, y: 3 });
    expect(tag.tone).toBe('blocked');
    expect(tag.label).toContain('nothing here says what this carries');
    // The two routes: the key, and the machine. A tell that named neither would be the old
    // silence with a red band on it.
    expect(tag.label).toContain('L');
    expect(tag.label).toContain('machine');
    // NO PRICE. Quoting "$10.00" under a run that will not be laid is the tag answering a
    // question nobody asked — the rule the mismatch label already followed.
    expect(tag.label).not.toContain('$');
  });

  it('keeps a different sentence for a run that is illegal rather than undecided', () => {
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
    const tag = band(view, { x: 2, y: 0 }, { x: 2, y: 0 });
    expect(tag.tone).toBe('blocked');
    expect(tag.label).toContain('nothing here would share a liquid');
    // Not the undecided sentence: there is no key that fixes this one, and offering one would
    // send the player pressing L at a run no liquid can fill.
    expect(tag.label).not.toContain('press L');
  });

  it('marks a picked liquid as picked, and an inferred one as neither', () => {
    // The tag is the only place these two are ever told apart, and telling them apart is what
    // stops a picked liquid reading as a fact about the world.
    //
    // The TONE is not asserted here on purpose: the stub view owns no land and holds no money,
    // so this band is red for two reasons that have nothing to do with liquids, and pinning it
    // would be pinning the wrong fact. The label is the subject.
    const picked = band(createWorldView(), { x: 5, y: 3 }, { x: 9, y: 3 }, LiquidId.CaneJuice);
    expect(picked.label).toContain('cane juice');
    expect(picked.label).toContain('(picked)');

    const view = createWorldView();
    view.machines.push({
      id: 1,
      kind: MachineKind.Juicer,
      tileX: 3,
      tileY: 3,
      tilesWide: 2,
      tilesHigh: 2,
    } as WorldView['machines'][number]);
    const inferred = band(view, { x: 5, y: 3 }, { x: 9, y: 3 });
    expect(inferred.label).toContain('cane juice');
    expect(inferred.label).not.toContain('(picked)');
  });
});

describe('the machine ghost speaks the liquid layer’s refusals ([[109]])', () => {
  /** A view with one pipe tile of `liquid` on it, at (5,5). */
  function withPipe(liquid: LiquidId): WorldView {
    const view = createWorldView();
    view.pipes.push({
      tileX: 5,
      tileY: 5,
      liquid,
      network: 7,
      flowPermille: 0,
    } as WorldView['pipes'][number]);
    return view;
  }

  it('says WHY a Carbonator will not stand beside a soda syrup pipe', () => {
    // THE SECOND HALF OF THE REPORTED BUG. `liquidPlacementRefusal` had no mirror in this app
    // at all, so this placement was a click that did nothing: no red ghost, no sentence, and
    // nothing on screen connecting the machine to the pipe that refused it.
    const band = ghostBand(withPipe(LiquidId.SodaSyrup), { tileX: 6, tileY: 5 }, PLACE_CARB, DIR)!;
    expect(band.tone).toBe('blocked');
    expect(band.label).toContain('no port for the soda syrup pipe');
  });

  it('says nothing of the kind when the pipe is one the machine takes', () => {
    // A Carbonator takes water in and sends fizz out, so a water pipe beside it is the whole
    // point of the machine. A mirror that reddened this would be worse than no mirror.
    const band = ghostBand(withPipe(LiquidId.Water), { tileX: 6, tileY: 5 }, PLACE_CARB, DIR)!;
    expect(band.label).not.toContain('no port');
  });

  it('leaves a machine with no plumbing alone beside any pipe at all', () => {
    // The sim's rule in as many words: "Machines with no ports at all are invisible to this
    // rule." A Fryer beside a syrup main is legal and its ghost must not claim otherwise.
    const band = ghostBand(
      withPipe(LiquidId.SodaSyrup),
      { tileX: 6, tileY: 5 },
      ToolMode.PlaceFryer,
      DIR,
    )!;
    expect(band.label).not.toContain('no port');
  });

  it('tells a Pump it has to stand on the bank', () => {
    // `NoWaterSource` is the other refusal in the same sim function, and `tools.ts` already
    // calls it "the one refusal a player cannot guess and cannot see". It can be seen now.
    const band = ghostBand(createWorldView(), { tileX: 6, tileY: 5 }, ToolMode.PlacePump, DIR)!;
    expect(band.tone).toBe('blocked');
    expect(band.label).toContain('reservoir bank');
  });

  it('tells a Pump when the line it would join already has one', () => {
    // `TwoPumpsOneNetwork`, the third. The reservoir puts the ghost on the bank so the bank
    // rule cannot answer first — the tag has to reach the pump that is already there.
    const view = withPipe(LiquidId.Water);
    view.reservoirs.push({
      id: 1,
      tileX: 6,
      tileY: 6,
      tilesWide: 2,
      tilesHigh: 2,
      levelMl: 0,
      capacityMl: 1,
      levelPermille: 1000,
      throttle: 0,
    } as WorldView['reservoirs'][number]);
    view.machines.push({
      id: 1,
      kind: MachineKind.Pump,
      tileX: 0,
      tileY: 0,
      tilesWide: 1,
      tilesHigh: 1,
      network: 7,
    } as WorldView['machines'][number]);
    const band = ghostBand(view, { tileX: 6, tileY: 5 }, ToolMode.PlacePump, DIR)!;
    expect(band.tone).toBe('blocked');
    expect(band.label).toContain('already has a pump');
  });
});

describe('L, the picker for the silent case ([[109]])', () => {
  it('starts and returns to “work it out”, which is the half that fixes the bug', () => {
    // A ring that could not get back to `None` would leave a player who once pressed L for
    // cane juice laying cane juice into every silence forever after — the original bug with a
    // different liquid in it.
    let liquid: LiquidId = LiquidId.None;
    const seen: LiquidId[] = [];
    for (let i = 0; i < 6; i++) {
      liquid = nextLiquid(liquid);
      seen.push(liquid);
    }
    expect(seen[seen.length - 1]).toBe(LiquidId.None);
    // Every liquid the game has, exactly once, in the sim's own order.
    expect(seen.slice(0, 5)).toEqual(LIQUID_SPECS.map((spec) => spec.id));
  });

  it('is a closed ring, so the key can never strand the player on nothing', () => {
    let liquid: LiquidId = LiquidId.None;
    for (let i = 0; i < 60; i++) liquid = nextLiquid(liquid);
    expect(liquid).toBe(LiquidId.None);
  });
});
