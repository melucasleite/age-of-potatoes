'use client';

// The reports layer: the Dawn Report card, and a dock the player opens on purpose.
//
// WHY THIS IS A SIBLING OF `HudRoot` AND NOT A CHILD OF IT. The HUD's four corners are
// spoken for — Ticker, perf overlay, Clipboard, toolbelt — and everything there is glanceable
// while playing. A ledger is not glanceable; it is a thing you open, read, and close. Mixing
// the two would either crowd the corners or bury the Ticker, and `HudRoot` is being extended
// by another agent right now, so a second root is also a merge that cannot conflict.
//
// THE SPLIT IN WHAT IS ALWAYS ON SCREEN:
//   · The Dawn Report appears by itself, at dawn, for five seconds, and never asks for
//     anything (§2). It is the only part of this layer the player does not summon.
//   · Everything else lives behind a tab and is closed by default. A report that is always
//     open stops being read after the second hour.
//
// THE KEYBOARD RULE THIS FILE OBEYS. `game/input/keyboard.ts` owns Space, WASD, the arrows,
// the digits, B, R, C, +/−, Escape, F3 and the backtick. This listener claims exactly one key
// the game does not use, never calls `preventDefault`, and bails on any modifier or on a
// keystroke aimed at a form control — so it cannot swallow a keystroke meant for the lot, and
// it cannot break the select elements in its own panel.

import { useEffect, useState } from 'react';

import { BoardsPanel } from './BoardsPanel';
import { CommercePanel } from './CommercePanel';
import { DawnCard } from './DawnCard';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ShiftReport } from './ShiftReport';
import { r, cx } from './styles';

type Tab = 'shift' | 'boards' | 'dispatch' | 'diagnostics';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'shift', label: 'Shift' },
  { id: 'boards', label: 'Bests' },
  { id: 'dispatch', label: 'Dispatch' },
  // Present even before its node is researched — the panel renders its locked state, for
  // the same reason a locked build-menu row stays visible ([[039]], `DiagnosticsPanel`).
  { id: 'diagnostics', label: 'Diagnostics' },
];

/** The one key this layer claims. The game does not use it; see the header. */
const TOGGLE_CODE = 'KeyP';

export default function ReportsLayer() {
  const [open, setOpen] = useState<Tab | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== TOGGLE_CODE) return;
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;

      // A keystroke aimed at a form control belongs to the form control. Without this, typing
      // in the contract panel's own selects would toggle the panel out from under the caret.
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
      }

      // Deliberately no `preventDefault()`. Nothing in the browser does anything with a bare
      // P, and a layer that swallows keys is one bug away from swallowing a key the game
      // needed.
      setOpen((current) => (current === null ? 'shift' : null));
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div className={r.layer}>
      <DawnCard />

      <div className={r.dock}>
        <div className={r.tabs}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={cx(r.tab, open === tab.id && r.tabActive)}
              aria-pressed={open === tab.id}
              onClick={() => {
                // Clicking the open tab closes it. Two ways to close a panel is one more
                // than most people look for, and this is the one they try first.
                setOpen((current) => (current === tab.id ? null : tab.id));
              }}
            >
              {tab.label}
              {tab.id === 'shift' ? <span className={r.tabKey}>P</span> : null}
            </button>
          ))}
        </div>

        {open === 'shift' ? <ShiftReport /> : null}
        {open === 'boards' ? <BoardsPanel /> : null}
        {open === 'dispatch' ? <CommercePanel /> : null}
        {open === 'diagnostics' ? <DiagnosticsPanel /> : null}
      </div>
    </div>
  );
}
