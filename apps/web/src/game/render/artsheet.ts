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

import { Container, Graphics, Sprite } from 'pixi.js';

import { LampState } from '@snack/sim';

import { UI_FONT_SIZE, uiText } from './font';
import { LAMP_PX, lampTint } from './lamps';
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

/** Which faces each quarter turn of the junction tee opens. Mirrors `junction.ts`'s table. */
const OPEN_FACES: readonly string[] = ['w-e-s', 'n-s-w', 'e-w-n', 's-n-e'];

/** `bone` — the palette's UI label value, over `paper` for headings. */
const LABEL_FILL = 0xcbb99b;
const HEADING_FILL = 0xf5d382;

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
    y = this.section('belts — three tiers, and the junction tee at all four of its turns', y);
    y = this.beltRow(art, y);
    y = this.section('pipes — one frame per neighbour mask, rotated, tinted by liquid', y);
    y = this.pipeRow(art, y);
    y = this.section('liquids — the whole vocabulary, plus the grey that means empty', y);
    y = this.liquidRow(art, y);
    y = this.section('status lamps — seven states, seven shapes, greyscale-legible (§16)', y);
    y = this.lampRow(art, y);
    y = this.section('the bitmap font — every glyph it can draw, at 1x and 2x', y);
    y = this.fontRow(y);

    this.panel.rect(0, 0, SHEET_WIDTH, y + PAD).fill({ color: 0x14100e, alpha: 0.94 });
    this.root.position.set(16, SHEET_TOP);
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }

  private section(title: string, y: number): number {
    const text = uiText(title, { fill: HEADING_FILL });
    text.position.set(PAD, y);
    this.root.addChild(text);
    return y + 20;
  }

  private label(value: string, x: number, y: number): void {
    const text = uiText(value, { fill: LABEL_FILL });
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
   * The belt surfaces, and the junction tee at every turn it can take.
   *
   * THE FOUR TURNS ARE THE ROW'S REASON TO EXIST. A junction has no facing of its own — the
   * turn is picked from the belts around it — so the failure this catches is a tee whose
   * shading is top-lit rather than symmetric: rotated three quarters, such a frame is lit from
   * underneath, and it is invisible until the one junction on the lot that happens to need
   * that turn gets built. Laid out in a row, the four are either identical under rotation or
   * they are obviously not.
   *
   * The mask each turn serves is printed beneath it, in the compass letters `junction.ts`
   * uses, so a wrong entry in that table is legible here rather than only in the factory.
   */
  private beltRow(art: ArtSet, y: number): number {
    const cell = TILE_PX * SCALE;
    const step = cell + 14;

    const tiers: [string, number][] = [
      ['basic', 1],
      ['fast', 2],
      ['express', 3],
    ];
    tiers.forEach(([name, tier], index) => {
      const sprite = new Sprite(art.get(ART.beltSurface(tier)));
      sprite.scale.set(SCALE);
      sprite.position.set(PAD + index * step, y);
      this.root.addChild(sprite);
      this.label(name, PAD + index * step, y + cell + 4);
    });

    const originX = PAD + tiers.length * step + 24;
    for (let turns = 0; turns < 4; turns++) {
      const sprite = new Sprite(art.get(ART.beltJunction));
      sprite.anchor.set(0.5, 0.5);
      sprite.scale.set(SCALE);
      sprite.rotation = (turns * Math.PI) / 2;
      sprite.position.set(originX + turns * step + cell / 2, y + cell / 2);
      this.root.addChild(sprite);
      this.label(OPEN_FACES[turns]!, originX + turns * step, y + cell + 4);
    }

    this.label(
      `junction${art.isReal(ART.beltJunction) ? '' : ' *'} — one frame, turned by its neighbours`,
      originX + 4 * step + 12,
      y + cell / 2 - 4,
    );

    return y + cell + 26;
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

  /**
   * All seven lamp states side by side, twice: tinted as they ship, and again at full white.
   *
   * The second row is the point. Colour is what a sighted player reads first and therefore
   * what hides a shape problem — laid out in white, the row shows exactly the information a
   * player who cannot use the hue gets, which is the criterion [[042]] is actually judged on.
   */
  private lampRow(art: ArtSet, y: number): number {
    const step = LAMP_PX * SCALE + 34;
    const states: [string, LampState][] = [
      ['off', LampState.Off],
      ['running', LampState.Running],
      ['starved', LampState.Starved],
      ['blocked', LampState.Blocked],
      ['utility', LampState.UtilityMissing],
      ['jammed', LampState.Jammed],
      ['halted', LampState.Halted],
    ];

    states.forEach(([name, state], index) => {
      const x = PAD + index * step;
      const tinted = new Sprite(art.get(ART.lamp(state)));
      tinted.scale.set(SCALE * 2);
      tinted.position.set(x, y);
      tinted.tint = lampTint(state);
      this.root.addChild(tinted);

      const plain = new Sprite(art.get(ART.lamp(state)));
      plain.scale.set(SCALE * 2);
      plain.position.set(x, y + LAMP_PX * SCALE * 2 + 6);
      this.root.addChild(plain);

      this.label(name, x, y + LAMP_PX * SCALE * 4 + 14);
    });

    return y + LAMP_PX * SCALE * 4 + 40;
  }

  /**
   * The font's whole repertoire, so a missing glyph is visible rather than silently blank.
   *
   * At 1x and 2x because pixel-crispness is the criterion and the failure mode is a
   * half-pixel: if the 2x row is not exactly the 1x row with every pixel doubled, something
   * in the pipeline is resampling and the whole exercise has failed.
   */
  private fontRow(y: number): number {
    const rows = [
      ' !"#$%&\'()*+,-./0123456789:;<=>?@',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`',
      'abcdefghijklmnopqrstuvwxyz{|}~',
      '· — – × − ↑ ↓ ← →   $1,204.50   day 3  09:41',
    ];
    let cursor = y;
    for (const row of rows) {
      const text = uiText(row);
      text.position.set(PAD, cursor);
      this.root.addChild(text);
      cursor += UI_FONT_SIZE + 3;
    }
    const doubled = uiText('the quick brown fox — 0O 1lI| 68', { fontSize: UI_FONT_SIZE * 2 });
    doubled.position.set(PAD, cursor + 4);
    this.root.addChild(doubled);
    return cursor + UI_FONT_SIZE * 2 + 14;
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
