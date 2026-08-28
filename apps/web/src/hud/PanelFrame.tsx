'use client';

// The two shapes the HUD's four panels are made of: ONE ROW and ONE WINDOW ([[093]]).
//
// ────────────────────────────────────────────────────────────────────────────────────
//  THE RULING. Owner, 2026-08-16, verbatim: "The stand and research should also be buttons
//  that open a menu, just like the build and the bag. Consolidate those. They should have
//  the same feeling to them."
//
//  Item 089 floated the bag and the build menu but left research and the stand docking into
//  the sidebar's contextual slot — two species of panel with two different feels. This file
//  ends that by owning the parts that were being copied: RESEARCH, THE STAND, THE BAG and
//  BUILD are now four `PanelRow`s over four `PanelWindow`s, and the only thing any of them
//  still brings is its own body.
//
//  WHY A COMPONENT AND NOT A SHARED CLASS NAME. They already shared class names — every one
//  of them wrote `.winPanel > .winHead > .winTitle …` by hand — and they drifted anyway:
//  two of the four forgot `aria-pressed`, two lit for "something is ready" and two for "the
//  window is up", the stand's badge said "open" about the TILL while the bag's said "open"
//  about the PANEL, and each panel carried its own copy of the Escape listener. A shared
//  stylesheet cannot stop any of that. A shared component can, and the test of it is the
//  one the item names: a fifth row must be a `PanelRow` and nothing else.
// ────────────────────────────────────────────────────────────────────────────────────
//
// NOT A STATE MACHINE. Which panel is open still lives in `panel-state.ts` (item 089), with
// the build menu's half owned by the input layer. This file renders; it never decides. None
// of it is sim state (§12): a panel opening is not a `Command`, is never traced, hashed or
// saved, and a replay must not depend on it.

import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { formatCents } from './format';
import { paintIcon, resolveFrameIcon } from './item-art';
import { cx, s } from './styles';

/**
 * Keep focus off a HUD button, so Space keeps meaning "pan the camera" rather than "press
 * the last button again". Every clickable thing in the HUD wants this; it lived as a
 * private copy in five files before this one existed.
 */
export function keepFocus(event: React.MouseEvent): void {
  event.preventDefault();
}

/**
 * ONE SIDEBAR ROW, for all four openers.
 *
 * THE LIT RULE, STATED ONCE SO IT CANNOT DRIFT AGAIN: a row is lit when its window is open,
 * OR when it has something waiting for the player (`lit` — research affordable, the till in
 * reach, a boxed machine in the bag). Before this, research and the stand lit ONLY for the
 * second reason and so gave no sign at all that they were the thing currently on screen,
 * while the bag and build lit only for the first. Both meanings are worth having; they are
 * the same treatment now because they are the same control.
 *
 * THE BADGE SLOT is the row's one variable: it reads `open` whenever the window is up, and
 * whatever the panel wants to say otherwise ("2 READY", "SEEDS · KIT", "1 KIND"). The stand
 * used to spend that word on its counter being in reach; that fact moved into `lit` and into
 * the badge's own text, because one word cannot mean two things four rows in a row.
 *
 * THE ICON SLOT ([[151]]) sits before the name: every row hands its `ui_menu_*` atlas frame
 * and the sprite renders at a quarter of the 64px art — crisp, per `paintIcon`'s ladder. A
 * frame the atlas has not got degrades to the same quiet lettered chip the bag and the build
 * menu use, never the renderer's magenta ([[037]]): the six frames exist today, and the rule
 * is for the seventh row that lands before its art does.
 */
export function PanelRow({
  name,
  badge,
  hotkey,
  title,
  frame,
  open,
  lit = false,
  onToggle,
}: {
  /** The row's name, in the sidebar's small caps: "Research", "The Stand", "The Bag", "Build". */
  name: string;
  /** What the badge says while the window is CLOSED — open is spelled by the row itself. */
  badge: string;
  /** The single letter that does the same thing: T, G, I, B. */
  hotkey: string;
  /** The tooltip — one plain sentence on what the window is for, plus the hotkey. */
  title: string;
  /** The row's `ui_menu_*` atlas frame ([[151]]). Missing art draws the lettered chip. */
  frame?: string;
  /** Is this row's window up right now. Lights the row and sets `aria-pressed`. */
  open: boolean;
  /** Something is waiting in there. Lights the row while it is closed. */
  lit?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={cx(s.panelRow, (open || lit) && s.panelRowLit)}
      title={title}
      aria-pressed={open}
      onMouseDown={keepFocus}
      onClick={onToggle}
    >
      {frame === undefined ? null : <RowIcon frame={frame} name={name} />}
      <span className={s.panelRowName}>{name}</span>
      <span className={s.panelRowBadge}>{open ? 'open' : badge}</span>
      <span className={s.panelRowKey}>{hotkey}</span>
    </button>
  );
}

/** How big a row's sprite box is. 64px art draws at ¼ inside it — 16 device-crisp pixels. */
const ROW_ICON = 16;

/**
 * The row's picture, or the same lettered chip every other missing frame gets ([[037]]:
 * never magenta). `CellIcon` in `BuildMenu.tsx` is the template, deliberately — a sidebar
 * whose missing art degrades differently from the panels it opens would read as two games.
 */
function RowIcon({ frame, name }: { frame: string; name: string }) {
  const source = resolveFrameIcon(frame);

  if (source === null) {
    return (
      <span
        className={cx(s.icon, s.iconBlank)}
        style={{ width: ROW_ICON, height: ROW_ICON, fontSize: 9 }}
        aria-hidden="true"
      >
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }

  const paint = paintIcon(source, ROW_ICON);
  return (
    <span
      className={s.icon}
      style={{
        width: ROW_ICON,
        height: ROW_ICON,
        backgroundImage: paint.backgroundImage,
        backgroundPosition: paint.backgroundPosition,
        backgroundSize: paint.backgroundSize,
      }}
      aria-hidden="true"
    />
  );
}

/**
 * ONE FLOATING WINDOW, for all four panels — the bevel, the head, the ESC affordance and
 * the footer hint. The centring, the width and the height cap are the wrapper's job
 * (`.floatWin` in `HudRoot`, item 089); everything inside the frame is this.
 *
 * THE HEAD IS FIXED IN ORDER AND IN GEOMETRY: title, tag, count, money, ESC. The tag span is
 * rendered even when empty, because it is the flexible one — it is what pushes the count,
 * the money and the ESC key hard right, and a head that reflowed depending on whether a
 * panel happened to have a subtitle is exactly the drift this file exists to stop. Count and
 * money are omitted when a panel has no such number (the bag has no money, the stand has no
 * count); their SLOTS do not move when they are.
 *
 * ESCAPE, AND THE ONE PANEL THAT MUST OPT OUT. Three of the four closed themselves on Escape
 * with their own identical listener; that listener is here now. BUILD PASSES
 * `closeOnEsc={false}` AND THIS IS LOAD-BEARING, not tidiness: the input layer's Escape is a
 * strict four-step cascade (`keyboard.ts` — close the menu, else the debug panel, else
 * abandon the drag, else put the tool down), and a HUD listener that closed the build menu
 * first would leave the cascade looking at a shut menu and falling through to the next step.
 * One press would close the menu AND disarm the player's tool. So build's Escape stays where
 * it has always been, and the ESC BUTTON still works because it calls `onClose` directly.
 */
export function PanelWindow({
  title,
  tag,
  count,
  moneyCents,
  hint,
  onClose,
  closeOnEsc = true,
  children,
}: {
  /** The window's name, top left. */
  title: string;
  /** The amber sub-label: the era, "bought at list", "everything you are carrying". */
  tag?: ReactNode;
  /** The grey figure on the right: "3 of 12 researched", "2 kinds". */
  count?: ReactNode;
  /** Money, if this panel is one where the player spends it. Formatted here, once. */
  moneyCents?: number;
  /** The footer line — what the panel is, and which keys close it. */
  hint: string;
  onClose: () => void;
  /** Leave true unless the input layer already owns this panel's Escape (build does). */
  closeOnEsc?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!closeOnEsc) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.code === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [closeOnEsc, onClose]);

  return (
    <div className={s.winPanel}>
      <div className={s.winHead}>
        <span className={s.winTitle}>{title}</span>
        <span className={s.winTag}>{tag ?? ''}</span>
        {count === undefined ? null : <span className={s.winCount}>{count}</span>}
        {moneyCents === undefined ? null : (
          <span className={s.winMoney}>{formatCents(moneyCents)}</span>
        )}
        <button type="button" className={s.winClose} onMouseDown={keepFocus} onClick={onClose}>
          ESC
        </button>
      </div>

      {children}

      <div className={s.winHint}>{hint}</div>
    </div>
  );
}
