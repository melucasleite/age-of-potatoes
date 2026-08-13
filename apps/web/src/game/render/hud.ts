// A minimal screen-space HUD, drawn in Pixi.
//
// SCOPE NOTE: the real HUD is [[013 Build the HUD bridge and dev performance overlay]] —
// a React panel fed by `useSyncExternalStore` at 4–8 Hz. This is not that, and is not
// trying to be: it is the smallest readout that makes the v0.1 loop playable (money,
// inventory, the selected tool, and why the last click did nothing). It lives in the
// renderer, reads the same `WorldView` everything else reads, and holds no state of its
// own. When 013 lands, delete this or leave it as the in-canvas fallback.
//
// Money is NOT formatted here any more. `packages/sim` deals in cents and never divides by 100
// — "$123.45" is a presentation concern (see `units.ts`) — but it is not a RENDERER concern
// specifically, which is what this file used to assume and what earned the game two spellings
// of a negative balance. `format/money.ts` owns it for both sides now.
//
// TEXT IS THE GAME'S OWN BITMAP FONT ([[042]]). This panel used to ask the browser for
// `ui-monospace, SFMono-Regular, Menlo, monospace`, which is a different typeface on every
// platform at a different width, rasterised with hinting and antialiasing on top of
// nearest-neighbour pixel art. See `font.ts`.

import { Container, Graphics } from 'pixi.js';
import type { BitmapText } from 'pixi.js';

import { ItemId } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { formatCents } from '../../format/money';

import { uiLineHeight, uiText, uiTextWidth } from './font';
import { dayPhase, TICKS_PER_DAY } from './pixel';
import { TOOL_INFO, TOOL_ORDER, ToolMode } from '../input/tools';

const PAD = 10;
const LINES = 6;

/**
 * Laid out in CHARACTERS now, not in pixels.
 *
 * The old numbers — 340px wide, 17px lines — were a guess at what the browser's monospace
 * stack would come out as, and a different guess on every platform. The font is the game's own
 * and monospaced, so the panel is exactly as wide as the longest line it can print.
 */
const PANEL_COLUMNS = 52;
const PANEL_WIDTH = uiTextWidth(PANEL_COLUMNS) + PAD * 2;
const LINE_HEIGHT = uiLineHeight();

export interface HudLineState {
  /** Transient feedback, e.g. "too far to reach". Renderer-only; never a sim concept. */
  status: string;
}

export class Hud {
  readonly root = new Container();
  private readonly panel = new Graphics();
  private readonly lines: BitmapText[] = [];
  /**
   * The last string each line was set to. `null` before anything is set, so the first update
   * always applies — this used to be a literal NUL character, which worked and had one nasty
   * side effect: a NUL byte makes the file BINARY to grep, so every audit that grepped this
   * tree for `new Text(` silently skipped this file and reported it clean.
   */
  private readonly previous: (string | null)[] = [];

  constructor() {
    this.root.addChild(this.panel);
    for (let i = 0; i < LINES; i++) {
      const text = uiText('', { fill: 0xf2ecdd });
      text.position.set(PAD, PAD + i * LINE_HEIGHT);
      this.lines.push(text);
      this.previous.push(null);
      this.root.addChild(text);
    }
    this.panel
      .roundRect(0, 0, PANEL_WIDTH, PAD * 2 + LINE_HEIGHT * LINES, 6)
      .fill({ color: 0x14100c, alpha: 0.72 });
    this.root.position.set(12, 12);
  }

  update(view: WorldView, tool: ToolMode, state: HudLineState): void {
    // Subsumed by the React HUD ([[013]]), which now owns money, inventory, the tool and
    // the status line. The host hides this at boot and nothing below runs — but the class
    // stays as the in-canvas fallback its own header always said it would be, one flag
    // away from working. Assigning `.text` re-lays out the glyphs, so an invisible panel
    // that kept updating would cost six of them per frame for nobody.
    if (!this.root.visible) return;

    const seeds = countOf(view, ItemId.PotatoSeed);
    const potatoes = countOf(view, ItemId.RussetPotato);
    const chips = countOf(view, ItemId.BaggedChips);

    this.setLine(0, `${money(view.moneyCents)}    ${clock(view.tick)}`);
    this.setLine(1, `seeds ${seeds}   potatoes ${potatoes}   chips ${chips}`);
    this.setLine(2, `[${toolDigit(tool)}] ${TOOL_INFO[tool].label}`);
    this.setLine(3, TOOL_INFO[tool].hint);
    this.setLine(4, toolStrip(tool));
    this.setLine(5, state.status);
  }

  private setLine(index: number, value: string): void {
    // Only on a change. At 60 Hz with six lines that is the difference between free and not.
    if (this.previous[index] === value) return;
    this.previous[index] = value;
    this.lines[index]!.text = value;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

/**
 * Cents → "$123.45", for this panel and for `render/index.ts`'s ribbon.
 *
 * AN ALIAS, NOT AN IMPLEMENTATION. It stays exported under this name because the ribbon reads
 * better as `money(cost)` than as `formatCents(cost)` and because renaming it would have put
 * an unrelated file in the diff. What it used to be was a fourth copy that disagreed with the
 * React HUD twice over: an ASCII hyphen for negatives where every other surface used U+2212,
 * and `toLocaleString('en-US')` for separators — a second grouping rule that happens to agree
 * with ours today and is an ICU implementation detail rather than a promise.
 */
export const money = formatCents;

/** Plan §2: the in-game day is 8 real minutes. Purely cosmetic — no night mechanics. */
export function clock(tick: number): string {
  const day = Math.floor(tick / TICKS_PER_DAY) + 1;
  // The same phase the colour matrix reads, so the clock and the sky never disagree.
  const minutes = Math.floor(dayPhase(tick) * 24 * 60);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `day ${day}  ${hh}:${mm}`;
}

function toolStrip(active: ToolMode): string {
  return TOOL_ORDER.map((tool, index) =>
    tool === active
      ? `[${index + 1}${TOOL_INFO[tool].label[0]}]`
      : ` ${index + 1}${TOOL_INFO[tool].label[0]} `,
  ).join('');
}

function toolDigit(tool: ToolMode): number {
  return TOOL_ORDER.indexOf(tool) + 1;
}

function countOf(view: WorldView, item: ItemId): number {
  for (let i = 0; i < view.inventory.length; i++) {
    const slot = view.inventory[i]!;
    if (slot.item === item) return slot.count;
  }
  return 0;
}
