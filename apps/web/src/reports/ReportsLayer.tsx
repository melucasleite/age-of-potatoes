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

import { useEffect, useState, useSyncExternalStore } from 'react';

// A leaf module, not the `@/hud` barrel — one integer, no React tree. The dock sits at the
// top of the CANVAS region ([[076]]), and "where the canvas starts" has exactly one home —
// which since [[096]] is a function of whether the sidebar is folded, so this subscribes
// rather than reading a constant. A dock that stayed at 440 while the canvas started at 24
// would be the drift the single source of truth exists to prevent, just with an extra step.
import {
  sidebarCollapsed,
  sidebarServerSnapshot,
  sidebarWidth,
  subscribeSidebar,
} from '@/hud/layout';

import { BoardsPanel } from './BoardsPanel';
import { CommercePanel } from './CommercePanel';
import { DawnCard } from './DawnCard';
import { LeaderboardPanel } from './LeaderboardPanel';
import { r, cx } from './styles';

// Two tabs fewer since item 150: Shift and Diagnostics went with their ledgers and slices,
// and Dispatch is next to leave — a later item moves it out of the dock into its own
// sidebar panel under Build.
type Tab = 'boards' | 'ranks' | 'dispatch';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'boards', label: 'Bests' },
  // The cloud half of the leaderboard work, beside the local half it grew out of. The
  // panel degrades to one quiet sentence when Supabase is absent, so the tab earns its
  // place even in a fork with no backend.
  { id: 'ranks', label: 'Ranks' },
  { id: 'dispatch', label: 'Dispatch' },
];

/** The one key this layer claims. The game does not use it; see the header. */
const TOGGLE_CODE = 'KeyP';

export default function ReportsLayer() {
  const [open, setOpen] = useState<Tab | null>(null);
  const collapsed = useSyncExternalStore(subscribeSidebar, sidebarCollapsed, sidebarServerSnapshot);

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
      // P opens Bests now that its old meaning (the Shift Report) is gone; a later lane
      // re-points P to the dispatch panel when dispatch leaves this dock.
      setOpen((current) => (current === null ? 'boards' : null));
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div className={r.layer}>
      <DawnCard />

      {/*
        Top of the canvas region, just right of the sidebar ([[076]]). The offset is inline
        because a CSS module cannot import `sidebarWidth()`, and a hand-copied 440 here is
        exactly the drift the constant exists to prevent — which is also why this tracks the
        fold ([[096]]) rather than parking at the expanded width.
      */}
      <div className={r.dock} style={{ left: sidebarWidth(collapsed) + 14 }}>
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
              {tab.id === 'boards' ? <span className={r.tabKey}>P</span> : null}
            </button>
          ))}
        </div>

        {open === 'boards' ? <BoardsPanel /> : null}
        {open === 'ranks' ? <LeaderboardPanel /> : null}
        {open === 'dispatch' ? <CommercePanel /> : null}
      </div>
    </div>
  );
}
