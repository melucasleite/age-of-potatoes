// The art sheet: every machine, every pipe frame, every liquid, side by side.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY THIS EXISTS, GIVEN NOBODY ASKED FOR A DEBUG SCREEN.
//
//  §15 names the hard part of this game's art outright: "making 30 machines
//  distinguishable at a glance at 32–48px in one palette." That is not a property of any
//  one sprite — it is a property of the SET, and a set can only be judged laid out
//  together. Checking machines one at a time, in a factory, at whatever zoom you happen
//  to be at, is how a line of five grey boxes ships.
//
//  It also solves a scheduling problem that is specific to this round: the soda machines
//  are drawn HERE before they exist in `packages/sim`, so until the sim lands them there
//  is no way to put a Carbonator on screen at all. `?artsheet` puts every registered
//  frame on screen whether or not a machine of that kind can be built yet.
// ────────────────────────────────────────────────────────────────────────────────────
//
// Renderer-local and inert: it reads the art set, draws sprites, and touches nothing else.
// No commands, no view, no sim. Off unless the URL asks for it.

import { TILE_PX } from './pixel';

import { Container, Graphics, Sprite, Text } from 'pixi.js';

import { EMPTY_PIPE_TINT, LIQUID_LOOKS, liquidTint } from './liquids';
import { PIPE_FRAMES, PipeSide, pipeShape } from './pipe-shape';
import { ART, placeholderMachineFrames } from './textures';
import type { ArtSet } from './textures';

/** 2× — big enough to judge a silhouette, small enough that the whole set fits one screen. */
const SCALE = 2;
const PAD = 14;
const COLUMN = 56 * SCALE;
const SHEET_WIDTH = 1220;
/**
 * Clear of the HUD, which is DOM and therefore always on top of anything Pixi draws.
 * The money panel and the research bar own the top-left corner; the toolbar owns the
 * bottom. Sitting under either one is how the first two machines in an alphabetical list
 * become invisible — which is exactly what happened the first time this ran.
 */
const SHEET_TOP = 285;
const LABEL_STYLE = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  fill: 0xcbb99b,
} as const;

/** True when the page was opened with `?artsheet`. Read once; never re-read. */
export function artSheetRequested(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('artsheet');
}

export class ArtSheet {
  readonly root = new Container();
  private readonly panel = new Graphics();

  constructor(art: ArtSet) {
    this.root.addChild(this.panel);

    let y = PAD;
    y = this.section('machines — chip line is steel and wide, soda line is brass and tall', y);
    y = this.machineRow(art, y);
    y = this.section('pipes — one frame per neighbour mask, rotated, tinted by liquid', y);
    y = this.pipeRow(art, y);
    y = this.section('liquids — the whole vocabulary, plus the grey that means empty', y);
    y = this.liquidRow(art, y);

    this.panel.rect(0, 0, SHEET_WIDTH, y + PAD).fill({ color: 0x14100e, alpha: 0.94 });
    this.root.position.set(16, SHEET_TOP);
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }

  private section(title: string, y: number): number {
    const text = new Text({ text: title, style: { ...LABEL_STYLE, fill: 0xf5d382 } });
    text.position.set(PAD, y);
    this.root.addChild(text);
    return y + 20;
  }

  private label(value: string, x: number, y: number): void {
    const text = new Text({ text: value, style: LABEL_STYLE });
    text.position.set(x, y);
    this.root.addChild(text);
  }

  /** Every machine frame the renderer knows how to draw, at its real footprint, in a grid. */
  private machineRow(art: ArtSet, y: number): number {
    const names = placeholderMachineFrames();
    const perRow = Math.max(1, Math.floor((SHEET_WIDTH - PAD * 2) / COLUMN));
    let rowTop = y;
    let tallest = 0;

    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      const column = i % perRow;
      if (column === 0 && i > 0) {
        rowTop += tallest + 26;
        tallest = 0;
      }
      const texture = art.get(name);
      const sprite = new Sprite(texture);
      sprite.scale.set(SCALE);
      sprite.position.set(PAD + column * COLUMN, rowTop);
      this.root.addChild(sprite);
      tallest = Math.max(tallest, texture.height * SCALE);
      // The name and whether it came from the atlas or from a grey box, because "the art
      // landed" and "the art is still a placeholder" look identical once the placeholder
      // is any good — which is the entire risk of drawing decent placeholders.
      this.label(
        `${name.replace('machine_', '')}${art.isReal(name) ? '' : ' *'}`,
        PAD + column * COLUMN,
        rowTop + texture.height * SCALE + 4,
      );
    }
    return rowTop + tallest + 34;
  }

  /**
   * A worked pipe junction: a cross in the middle, four arms leaving it, each a different
   * liquid, and one arm left empty so the grey is on screen next to the colours.
   */
  private pipeRow(art: ArtSet, y: number): number {
    const cell = TILE_PX * SCALE;
    const liquids = [1, 2, 3, 4];

    // Left: the six frames in their canonical orientation, unrotated and untinted.
    for (let i = 0; i < PIPE_FRAMES.length; i++) {
      const frame = PIPE_FRAMES[i]!;
      const sprite = new Sprite(art.get(ART.pipeFrame(frame)));
      sprite.scale.set(SCALE);
      sprite.position.set(PAD + i * (cell + 8), y);
      this.root.addChild(sprite);
      this.label(frame, PAD + i * (cell + 8), y + cell + 4);
    }

    // Right: a real junction, auto-tiled from masks exactly as the layer does it.
    const originX = PAD + PIPE_FRAMES.length * (cell + 8) + 40;
    const cells: { dx: number; dy: number; mask: number; liquid: number }[] = [
      { dx: 0, dy: 1, mask: PipeSide.East, liquid: liquids[0]! },
      { dx: 1, dy: 1, mask: PipeSide.East | PipeSide.West, liquid: liquids[0]! },
      { dx: 2, dy: 0, mask: PipeSide.South, liquid: liquids[1]! },
      { dx: 2, dy: 1, mask: 0b1111, liquid: liquids[1]! },
      { dx: 2, dy: 2, mask: PipeSide.North, liquid: 0 },
      { dx: 3, dy: 1, mask: PipeSide.West | PipeSide.South, liquid: liquids[2]! },
      { dx: 3, dy: 2, mask: PipeSide.North | PipeSide.East, liquid: liquids[2]! },
      { dx: 4, dy: 2, mask: PipeSide.West, liquid: liquids[3]! },
    ];
    for (const item of cells) {
      const shape = pipeShape(item.mask);
      const sprite = new Sprite(art.get(ART.pipeFrame(shape.frame)));
      sprite.anchor.set(0.5, 0.5);
      sprite.scale.set(SCALE);
      sprite.rotation = (shape.quarterTurns * Math.PI) / 2;
      sprite.tint = liquidTint(item.liquid);
      sprite.position.set(originX + (item.dx + 0.5) * cell, y + (item.dy - 0.5) * cell);
      this.root.addChild(sprite);
    }
    this.label('a junction: four liquids and one dead arm', originX, y + cell * 2 + 4);

    return y + cell * 2 + 34;
  }

  private liquidRow(art: ArtSet, y: number): number {
    const cell = TILE_PX * SCALE;
    const names = [...new Set(Object.keys(LIQUID_LOOKS))];
    let x = PAD;
    for (const slug of names) {
      const sprite = new Sprite(art.get(ART.pipeFrame('straight')));
      sprite.scale.set(SCALE);
      sprite.position.set(x, y);
      sprite.tint = LIQUID_LOOKS[slug]!.tint;
      this.root.addChild(sprite);
      this.label(slug, x, y + cell + 4);
      x += Math.max(cell + 10, slug.length * 7 + 12);
    }
    const empty = new Sprite(art.get(ART.pipeFrame('straight')));
    empty.scale.set(SCALE);
    empty.position.set(x, y);
    empty.tint = EMPTY_PIPE_TINT;
    this.root.addChild(empty);
    this.label('(empty)', x, y + cell + 4);

    return y + cell + 22;
  }
}
