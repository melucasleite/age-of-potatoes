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
// NO KEY BELONGS TO THIS LAYER ANY MORE ([[150]]). P was the Shift Report's, briefly the
// Bests tab's, and it left with dispatch: the sidebar's Dispatch panel wears it now, bound in
// `HudRoot` beside T, G, I and Z. The two tabs that remain — Bests and Ranks — are read-only
// ledgers a player visits on purpose, and click-only is the honest price of that.

import { useState, useSyncExternalStore } from 'react';

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
import { DawnCard } from './DawnCard';
import { LeaderboardPanel } from './LeaderboardPanel';
import { r, cx } from './styles';

// Three tabs fewer since item 150: Shift and Diagnostics went with their ledgers and
// slices, and Dispatch moved out of the dock entirely — it is a sidebar panel under Build
// now (`hud/Dispatch.tsx`), because a surface whose every button enqueues a `Command` was
// never a report.
type Tab = 'boards' | 'ranks';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'boards', label: 'Bests' },
  // The cloud half of the leaderboard work, beside the local half it grew out of. The
  // panel degrades to one quiet sentence when Supabase is absent, so the tab earns its
  // place even in a fork with no backend.
  { id: 'ranks', label: 'Ranks' },
];

export default function ReportsLayer() {
  const [open, setOpen] = useState<Tab | null>(null);
  const collapsed = useSyncExternalStore(subscribeSidebar, sidebarCollapsed, sidebarServerSnapshot);

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
            </button>
          ))}
        </div>

        {open === 'boards' ? <BoardsPanel /> : null}
        {open === 'ranks' ? <LeaderboardPanel /> : null}
      </div>
    </div>
  );
}
