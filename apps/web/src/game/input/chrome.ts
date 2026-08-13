// The input layer's own chrome: the rubber band, the placement ghost, and the build menu.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY THIS IS PLAIN DOM AND NOT REACT, AND NOT PIXI EITHER.
//
//  NOT REACT: the band follows the cursor and the camera, so it moves every frame while
//  the player walks. §13 routes high-frequency transient readouts around React entirely —
//  and work item 018's instruction 6 says so in as many words: "drawn in Pixi or written
//  to a DOM node by ref". Six style writes a frame beat a reconciliation a frame, and the
//  React HUD is owned by another agent besides.
//
//  NOT PIXI: `src/game/render/**` is being rewritten by somebody else this round. A
//  preview rectangle that lives in the scene graph would collide with that work and, worse,
//  would make the gesture *depend* on it — a drag with no visible band is not a drag. The
//  band is UI chrome sitting over the canvas, in the same layer the HUD occupies, so it
//  belongs to whoever owns the gesture. When the renderer wants it in-world it can read
//  `viewLod` and the run and draw it there; nothing here has to move for that to happen.
// ────────────────────────────────────────────────────────────────────────────────────
//
// Nothing in this file touches the simulation. It reads the projection for labels and
// prices, positions absolutely-placed divs through the camera transform that was ACTUALLY
// APPLIED this frame, and calls back into the host when a menu row is chosen.

import type { WorldView } from '@snack/sim';
import { Direction } from '@snack/sim';

import type { Camera } from '../render/camera';
import { TILE_PX } from '../render/pixel';
import { buildRows } from './build-menu';
import type { BuildRow } from './build-menu';
import { TOOL_INFO, ToolMode } from './tools';

const STYLE_ID = 'snack-input-chrome';
const CSS = `
.sm-ix-root { position:absolute; inset:0; pointer-events:none; z-index:5;
  font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color:#e6dccb; }
.sm-ix-band { position:absolute; box-sizing:border-box; display:none;
  border:2px solid rgba(126,214,142,0.95); background:rgba(126,214,142,0.18);
  box-shadow:0 0 0 1px rgba(0,0,0,0.55) inset; }
.sm-ix-band[data-tone="erase"] { border-color:rgba(233,124,110,0.95); background:rgba(233,124,110,0.18); }
.sm-ix-band[data-tone="belt"] { border-color:rgba(226,190,101,0.95); background:rgba(226,190,101,0.16); }
.sm-ix-band[data-tone="blocked"] { border-color:rgba(233,124,110,0.9); background:rgba(233,124,110,0.10); }
/* The facing chevron. A ROTATED TRIANGLE RATHER THAN A GLYPH: work item 052's whole
   complaint is that "R rotate" was a text arrow nobody read as motion, and a shape that
   physically swings a quarter turn under the cursor is the one version of this that cannot
   be mistaken for nothing happening. Clipped from a square so a single size sets it, and
   drop-shadowed so it survives being drawn over a bright tile. */
.sm-ix-chev { position:absolute; display:none; background:rgba(126,214,142,0.98);
  clip-path:polygon(50% 0%, 100% 100%, 0% 100%);
  filter:drop-shadow(0 1px 1px rgba(0,0,0,0.75)); }
.sm-ix-chev[data-tone="blocked"], .sm-ix-chev[data-tone="erase"] { background:rgba(233,124,110,0.98); }
.sm-ix-chev[data-tone="belt"] { background:rgba(226,190,101,0.98); }
.sm-ix-tag { position:absolute; display:none; transform:translate(0,-140%); white-space:nowrap;
  padding:2px 6px; border-radius:3px; background:rgba(20,16,25,0.88); border:1px solid rgba(255,255,255,0.14); }
/* Top-CENTRE, not top-left: the HUD's money panel owns the top-left corner and the
   Clipboard owns the bottom-right, so the strip would sit underneath one of them. The
   HUD belongs to another agent — the polite fix is to stay out of its way. */
.sm-ix-hint { position:absolute; left:50%; top:10px; transform:translateX(-50%);
  text-align:center; padding:5px 10px; border-radius:4px; white-space:nowrap;
  background:rgba(20,16,25,0.80); border:1px solid rgba(255,255,255,0.10); }
.sm-ix-hint b { color:#f2e6cf; font-weight:600; }
.sm-ix-hint span { color:#9c9182; }
/* The deed sign: one per unowned parcel, standing in the middle of the land it prices.
   ANCHORED IN WORLD SPACE AND DRAWN IN DOM, which is the same trade the band above makes and
   for the same two reasons — text stays crisp at every zoom rung without a font atlas, and the
   renderer is somebody else's file. It is positioned from the transform that actually reached
   the display this frame, so it rides the camera exactly as the ground under it does. */
.sm-ix-deed { position:absolute; display:none; transform:translate(-50%,-50%); white-space:nowrap;
  padding:3px 8px; border-radius:3px; text-align:center; letter-spacing:0.04em;
  background:rgba(20,16,12,0.78); border:1px solid rgba(216,201,164,0.45); color:#e8dcc0;
  text-shadow:0 1px 2px rgba(0,0,0,0.9); }
.sm-ix-deed b { display:block; font-size:13px; color:#f2e6cf; }
.sm-ix-deed[data-state="far"] { opacity:0.55; border-color:rgba(216,201,164,0.20); }
.sm-ix-deed[data-state="broke"] b { color:#e97c6e; }
.sm-ix-menu { position:absolute; right:14px; top:14px; width:296px; display:none;
  pointer-events:auto; padding:8px; border-radius:6px; background:rgba(20,16,25,0.94);
  border:1px solid rgba(255,255,255,0.14); box-shadow:0 8px 28px rgba(0,0,0,0.5);
  max-height:calc(100% - 28px); overflow:auto; }
.sm-ix-menu h4 { margin:8px 4px 4px; font-size:10px; letter-spacing:0.12em; text-transform:uppercase; color:#8d8378; }
.sm-ix-menu h4:first-child { margin-top:2px; }
.sm-ix-row { display:flex; gap:8px; align-items:baseline; padding:3px 6px; border-radius:3px;
  cursor:pointer; white-space:nowrap; }
.sm-ix-row[data-cursor="1"] { background:rgba(126,214,142,0.20); outline:1px solid rgba(126,214,142,0.55); }
.sm-ix-row[data-locked="1"] { color:#6d6459; cursor:not-allowed; }
.sm-ix-row[data-armed="1"] .sm-ix-name { color:#7ed68e; }
.sm-ix-key { width:14px; color:#8d8378; flex:none; }
.sm-ix-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.sm-ix-cost { flex:none; color:#c8b9a4; }
.sm-ix-row[data-locked="1"] .sm-ix-cost,
.sm-ix-row[data-broke="1"] .sm-ix-cost { color:#e97c6e; }
.sm-ix-foot { margin:6px 4px 2px; color:#8d8378; font-size:11px; }
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** A tile rectangle to outline, plus what to say about it. */
export interface BandState {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  tone: 'zone' | 'erase' | 'belt' | 'blocked';
  /**
   * The facing to draw a chevron for: a `Direction`, or `Direction.None` for no chevron.
   *
   * Only ever set on a one-tile band, because only arms have a facing — a machine's ports are
   * typed by liquid rather than by geometry, so no machine in this game points anywhere
   * (`packages/sim/src/commands.ts`, `RotateGrabberCommand`). The chevron is therefore drawn
   * at the band's centre with no special case for a footprint it can never have.
   */
  dir: number;
}

export interface ChromeHooks {
  arm(tool: ToolMode): void;
  latestView(): WorldView | null;
}

/**
 * One instance per `GameHost`, mounted and unmounted with it.
 *
 * StrictMode mounts twice, so mounting must be idempotent and unmounting must remove
 * exactly the nodes this instance created — hence the element references rather than a
 * `querySelector` sweep, which would find the other host's chrome and delete it.
 */
export class InputChrome {
  private root: HTMLElement | null = null;
  private band: HTMLElement | null = null;
  private chev: HTMLElement | null = null;
  private tag: HTMLElement | null = null;
  private hint: HTMLElement | null = null;
  private menu: HTMLElement | null = null;

  private rows: BuildRow[] = [];
  private cursor = 0;
  private open = false;
  private refreshCountdown = 0;
  private lastHintKey = '';
  /** One sign per unowned parcel, grown on demand and reused. Fifteen at the very most. */
  private readonly deedSigns: HTMLElement[] = [];
  /** What each sign currently says, so a frame that changes nothing writes nothing. */
  private readonly deedText: string[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly camera: Camera,
    private readonly hooks: ChromeHooks,
  ) {}

  mount(): void {
    if (this.root !== null) return;
    ensureStyle();

    const root = document.createElement('div');
    root.className = 'sm-ix-root';

    const band = document.createElement('div');
    band.className = 'sm-ix-band';
    const chev = document.createElement('div');
    chev.className = 'sm-ix-chev';
    const tag = document.createElement('div');
    tag.className = 'sm-ix-tag';
    const hint = document.createElement('div');
    hint.className = 'sm-ix-hint';
    const menu = document.createElement('div');
    menu.className = 'sm-ix-menu';

    root.append(band, chev, tag, hint, menu);
    this.container.appendChild(root);

    this.root = root;
    this.band = band;
    this.chev = chev;
    this.tag = tag;
    this.hint = hint;
    this.menu = menu;
  }

  unmount(): void {
    this.root?.remove();
    this.root = null;
    this.band = null;
    this.chev = null;
    this.tag = null;
    this.hint = null;
    this.menu = null;
    // The signs are children of `root` and go with it, but the arrays must not survive a
    // StrictMode remount holding nodes that are no longer in the document.
    this.deedSigns.length = 0;
    this.deedText.length = 0;
    this.open = false;
  }

  get menuOpen(): boolean {
    return this.open;
  }

  // --- the band ------------------------------------------------------------------------

  /**
   * Position the rubber band, or hide it.
   *
   * Called once per frame from the host's single rAF loop — NOT from `pointermove`. The
   * camera follows the player, so a band anchored to tiles has to be repositioned while
   * you walk even when the mouse has not moved at all. Driving it from the frame loop also
   * means there is still exactly one clock in this application, which is a property the
   * whole architecture leans on.
   */
  setBand(state: BandState | null): void {
    const band = this.band;
    const tag = this.tag;
    if (band === null || tag === null) return;

    if (state === null) {
      band.style.display = 'none';
      tag.style.display = 'none';
      this.setChevron(null, 0, 0, 0, 0);
      return;
    }

    const zoom = this.camera.transform.zoom;
    const origin = this.camera.worldToScreen(state.x * TILE_PX, state.y * TILE_PX);
    const width = state.w * TILE_PX * zoom;
    const height = state.h * TILE_PX * zoom;

    band.style.display = 'block';
    band.dataset.tone = state.tone;
    band.style.left = `${origin.x}px`;
    band.style.top = `${origin.y}px`;
    band.style.width = `${width}px`;
    band.style.height = `${height}px`;

    this.setChevron(state, origin.x, origin.y, width, height);

    if (state.label === '') {
      tag.style.display = 'none';
      return;
    }
    tag.style.display = 'block';
    tag.textContent = state.label;
    tag.style.left = `${origin.x}px`;
    tag.style.top = `${origin.y}px`;
  }

  /**
   * The facing chevron, centred on the band.
   *
   * Rotated in CSS rather than swapped between four glyphs, so the turn is a transform on one
   * element and the shape is identical in all four states — four hand-drawn arrows are four
   * chances for east to be a pixel fatter than west, which reads as a wobble every time the
   * player presses R.
   */
  private setChevron(
    state: BandState | null,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    const chev = this.chev;
    if (chev === null) return;

    const degrees = state === null ? null : chevronDegrees(state.dir);
    if (state === null || degrees === null) {
      chev.style.display = 'none';
      return;
    }

    // Two fifths of the tile: big enough to read at 2× zoom, small enough that the band's
    // own outline still shows around it at 6×.
    const size = Math.max(9, Math.round(Math.min(width, height) * 0.4));
    chev.style.display = 'block';
    chev.dataset.tone = state.tone;
    chev.style.width = `${size}px`;
    chev.style.height = `${size}px`;
    chev.style.left = `${left + width / 2}px`;
    chev.style.top = `${top + height / 2}px`;
    chev.style.transform = `translate(-50%,-50%) rotate(${degrees}deg)`;
  }

  // --- the deed signs --------------------------------------------------------------------

  /**
   * A price standing on every parcel the player has not bought.
   *
   * ITEM 053 ASKS FOR THE PRICE TO BE READABLE **IN-WORLD**, and this is that: no panel to
   * open, no tool to arm, no hover required. A player who walks east until the grass goes dark
   * finds out what the next field costs by looking at it.
   *
   * ONE SIGN PER PARCEL, ALL SHOWING THE SAME NUMBER, and that is honest rather than lazy: a
   * deed is priced by how many you have bought, never by which one you are buying, so every
   * parcel for sale genuinely costs the same today. The ones that are not adjacent say so
   * instead of quoting a price they will not honour.
   *
   * Called once per frame from the host's loop, AFTER the camera has been applied — same rule
   * as the band, and for the same reason: a sign positioned from last frame's transform slides
   * against the ground it is standing on while the player walks.
   */
  setDeedSigns(view: WorldView | null): void {
    const root = this.root;
    if (root === null) return;

    const land = view?.land ?? null;
    if (land === null) {
      for (const sign of this.deedSigns) sign.style.display = 'none';
      return;
    }

    const t = this.camera.transform;
    const half = (land.parcelTiles * TILE_PX) / 2;
    const money = view?.moneyCents ?? 0;
    const price = land.nextPriceCents;
    let used = 0;

    for (let parcel = 0; parcel < land.parcelsWide * land.parcelsHigh; parcel++) {
      if (land.owned.includes(parcel)) continue;

      const index = used;
      used += 1;
      const sign = this.deedSign(index, root);

      const originX = (parcel % land.parcelsWide) * land.parcelTiles * TILE_PX;
      const originY = Math.floor(parcel / land.parcelsWide) * land.parcelTiles * TILE_PX;
      const centre = this.camera.worldToScreen(originX + half, originY + half);

      // Off screen is hidden rather than clipped: an absolutely-positioned node parked far
      // outside the viewport still costs layout, and there can be fifteen of them.
      if (
        centre.x < -half * t.zoom ||
        centre.y < -half * t.zoom ||
        centre.x > t.viewWidth + half * t.zoom ||
        centre.y > t.viewHeight + half * t.zoom
      ) {
        sign.style.display = 'none';
        continue;
      }

      const buyable = land.buyable.includes(parcel);
      const affordable = price >= 0 && money >= price;
      const state = !buyable ? 'far' : affordable ? 'open' : 'broke';
      const html = !buyable
        ? '<b>NOT FOR SALE</b>buy the parcel beside it first'
        : price < 0
          ? '<b>UNOWNED</b>'
          : `<b>LAND DEED · $${Math.round(price / 100).toLocaleString('en-US')}</b>` +
            (affordable ? 'B → Land Deed, then click' : 'you cannot afford this yet');

      sign.style.display = 'block';
      sign.style.left = `${centre.x}px`;
      sign.style.top = `${centre.y}px`;
      // The position moves every frame the camera does; the words change about twice a
      // session. Writing `innerHTML` and the state attribute unconditionally would reparse two
      // nodes and touch an attribute per sign per frame, for a sentence nobody saw change.
      const key = `${state}|${html}`;
      if (this.deedText[index] !== key) {
        this.deedText[index] = key;
        sign.dataset.state = state;
        sign.innerHTML = html;
      }
    }

    for (let i = used; i < this.deedSigns.length; i++) {
      this.deedSigns[i]!.style.display = 'none';
    }
  }

  private deedSign(index: number, root: HTMLElement): HTMLElement {
    const existing = this.deedSigns[index];
    if (existing !== undefined) return existing;

    const sign = document.createElement('div');
    sign.className = 'sm-ix-deed';
    root.appendChild(sign);
    this.deedSigns[index] = sign;
    this.deedText[index] = '';
    return sign;
  }

  // --- the hint strip ------------------------------------------------------------------

  /**
   * `rotates` is the fix for work item 052's fourth instruction: the strip promised "R rotate"
   * in every context this game has, including the ones where R does nothing at all, which is
   * why the feature read as broken rather than as absent. The caller decides — it is the only
   * layer that knows both what is armed and what is under the cursor — and the flag is part of
   * the cache key, or the strip would keep the first answer it ever gave.
   */
  setHint(tool: ToolMode, zoom: number, rotates: boolean): void {
    const hint = this.hint;
    if (hint === null) return;
    const key = `${tool}:${zoom}:${rotates ? 1 : 0}`;
    if (key === this.lastHintKey) return;
    this.lastHintKey = key;

    const info = TOOL_INFO[tool];
    const keys = ['wheel or +/-', 'B build', rotates ? 'R rotate' : '', 'Esc cancel'].filter(
      (part) => part !== '',
    );
    hint.innerHTML =
      `<b>${escapeHtml(info.label)}</b> <span>${escapeHtml(info.hint)}</span><br>` +
      `<span>${zoom}× zoom · ${keys.join(' · ')}</span>`;
  }

  // --- the build menu ------------------------------------------------------------------

  toggleMenu(armed: ToolMode): void {
    if (this.open) this.closeMenu();
    else this.openMenu(armed);
  }

  openMenu(armed: ToolMode): void {
    if (this.menu === null) return;
    this.open = true;
    this.menu.style.display = 'block';
    const index = this.rowsNow().findIndex((row) => row.tool === armed);
    this.cursor = index >= 0 ? index : this.firstUnlocked();
    this.renderMenu(armed);
  }

  closeMenu(): void {
    if (this.menu === null) return;
    this.open = false;
    this.menu.style.display = 'none';
  }

  moveCursor(delta: number, armed: ToolMode): void {
    if (!this.open) return;
    const count = this.rows.length;
    if (count === 0) return;
    this.cursor = (((this.cursor + delta) % count) + count) % count;
    this.renderMenu(armed);
  }

  /** Digit shortcut. 1-based over the whole list; out of range is simply ignored. */
  jumpTo(oneBased: number, armed: ToolMode): void {
    if (!this.open) return;
    const index = oneBased - 1;
    if (index < 0 || index >= this.rows.length) return;
    this.cursor = index;
    this.renderMenu(armed);
  }

  /**
   * Arm whatever the cursor is on.
   *
   * A LOCKED ROW REFUSES rather than arming a tool whose command the sim will throw away.
   * This is the one place a UI-side legality check is right: it is not deciding what the
   * world does, it is declining to pretend the player did something.
   */
  armCursor(): void {
    const row = this.rows[this.cursor];
    if (row === undefined || row.locked) return;
    this.hooks.arm(row.tool);
    this.closeMenu();
  }

  /** Called once per frame; repaints the open menu a few times a second, never more. */
  tick(armed: ToolMode): void {
    if (!this.open) return;
    if (this.refreshCountdown > 0) {
      this.refreshCountdown -= 1;
      return;
    }
    this.renderMenu(armed);
  }

  private rowsNow(): BuildRow[] {
    this.rows = buildRows(this.hooks.latestView());
    return this.rows;
  }

  private firstUnlocked(): number {
    const index = this.rows.findIndex((row) => !row.locked);
    return index >= 0 ? index : 0;
  }

  private renderMenu(armed: ToolMode): void {
    const menu = this.menu;
    if (menu === null) return;
    this.refreshCountdown = 20;

    const rows = this.rowsNow();
    const parts: string[] = [];
    let group = '';

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.group !== group) {
        group = row.group;
        parts.push(`<h4>${escapeHtml(group)}</h4>`);
      }
      const right = row.locked ? row.lockReason : row.price;
      parts.push(
        `<div class="sm-ix-row" data-index="${i}" data-cursor="${i === this.cursor ? 1 : 0}"` +
          ` data-locked="${row.locked ? 1 : 0}" data-armed="${row.tool === armed ? 1 : 0}"` +
          ` data-broke="${row.affordable ? 0 : 1}" title="${escapeHtml(row.hint)}">` +
          `<span class="sm-ix-key">${i < 9 ? i + 1 : ''}</span>` +
          `<span class="sm-ix-name">${escapeHtml(row.label)}</span>` +
          `<span class="sm-ix-cost">${escapeHtml(right)}</span>` +
          `</div>`,
      );
    }
    parts.push('<div class="sm-ix-foot">↑↓ move · Enter build · Esc close</div>');
    menu.innerHTML = parts.join('');

    // Clicking is a convenience over the keyboard path, and goes through exactly the same
    // `armCursor()` so there is one code path that can arm a tool.
    const nodes = menu.querySelectorAll<HTMLElement>('.sm-ix-row');
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      // Keep focus on the canvas: `mousedown`, not `pointerdown`. Per the Pointer Events
      // spec, `preventDefault()` on `pointerdown` suppresses the compatibility mouse
      // sequence including `click`, and the row would silently stop responding.
      node.addEventListener('mousedown', (event) => event.preventDefault());
      node.addEventListener('click', () => {
        this.cursor = Number(node.dataset.index ?? 0);
        this.armCursor();
      });
    }
  }
}

/**
 * Which way to turn the chevron, or `null` for "draw nothing".
 *
 * NORTH IS ZERO because the triangle is clipped pointing up, and the compass then runs
 * clockwise exactly as `rotateDirectionClockwise()` does in the sim — so the shape on screen
 * turns the same way and by the same step as the arm in the world. A direction this build has
 * never heard of draws no chevron rather than an arbitrary one: a save from a newer version is
 * a real thing, and a confident wrong arrow is worse than none.
 */
function chevronDegrees(dir: number): number | null {
  switch (dir) {
    case Direction.North:
      return 0;
    case Direction.East:
      return 90;
    case Direction.South:
      return 180;
    case Direction.West:
      return 270;
    default:
      return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
