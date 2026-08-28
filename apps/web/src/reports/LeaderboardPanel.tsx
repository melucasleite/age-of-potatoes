'use client';

// The cloud board. You versus everybody who syncs, and it stays out of the way about it.
//
// THE ONLINE HALF OF THE LEADERBOARD WORK, kept deliberately smaller than it sounds. The
// server already owns the scoring (see `leaderboard.ts`); this file only decides how a
// standing looks, exactly as `BoardsPanel` only decides how a record looks. The two panels
// are siblings on purpose — same card chrome, same formatters, same one $/hour definition —
// so a player moving between "Bests" and "Ranks" is reading the same currency in both.
//
// LOCAL-FIRST IS THE POSTURE, NOT A FALLBACK. Fetching happens when the panel opens and when
// the player asks again; there is no polling loop, because a leaderboard that refreshes
// itself teaches the player to watch it, and this game's screen time belongs to the lot.
// Every way the fetch can fail renders one calm sentence in stone_mid — never a spinner
// overlay, never a red anything. A player on a plane opens this panel, reads one quiet line,
// and goes back to farming.
//
// The player's own row lights up when the session id matches. `getSession()` resolves to
// null harmlessly when there is no session, and the board is simply nobody's in that case.

import { useCallback, useEffect, useRef, useState } from 'react';

import { getSession } from '@/supabase/session';

import { formatCents, formatPerHour, formatTicks } from './format';
import { fetchLeaderboard } from './leaderboard';
import type { LeaderboardKind, LeaderboardRow } from './leaderboard';
import { r, cx } from './styles';

type BoardPhase =
  | { readonly phase: 'loading' }
  | { readonly phase: 'unconfigured' }
  | { readonly phase: 'offline' }
  | { readonly phase: 'rows'; readonly rows: readonly LeaderboardRow[] };

const LOADING: BoardPhase = { phase: 'loading' };

const KINDS: readonly { readonly id: LeaderboardKind; readonly label: string }[] = [
  { id: 'total', label: 'Total' },
  { id: 'perHour', label: 'Per Hour' },
];

export function LeaderboardPanel() {
  const [kind, setKind] = useState<LeaderboardKind>('total');
  const [boards, setBoards] = useState<Record<LeaderboardKind, BoardPhase>>({
    total: LOADING,
    perHour: LOADING,
  });
  const [selfId, setSelfId] = useState<string | null>(null);

  // Monotone per-board request counters. A slow response from before a refresh must not
  // overwrite the refresh's answer — and a counter still at zero is how the effect below
  // knows a board has never been fetched at all.
  const epochs = useRef<Record<LeaderboardKind, number>>({ total: 0, perHour: 0 });

  const load = useCallback((which: LeaderboardKind): void => {
    const epoch = ++epochs.current[which];
    setBoards((prev) => ({ ...prev, [which]: LOADING }));
    void fetchLeaderboard(which).then((result) => {
      if (epochs.current[which] !== epoch) return;
      setBoards((prev) => ({
        ...prev,
        [which]: result.ok ? { phase: 'rows', rows: result.rows } : { phase: result.reason },
      }));
    });
  }, []);

  // Fetch on open (this panel unmounts when closed, so mount IS open) and on first visit to
  // each board. Deliberately not on every toggle — flipping between the two boards should
  // cost nothing, and the refresh button exists for wanting newer numbers.
  useEffect(() => {
    if (epochs.current[kind] === 0) load(kind);
  }, [kind, load]);

  useEffect(() => {
    let cancelled = false;
    void getSession().then((session) => {
      if (!cancelled && session !== null) setSelfId(session.user.id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const board = boards[kind];

  return (
    <div className={cx(r.card, r.panel)}>
      <div className={r.head}>
        <span className={r.label}>Top Earners</span>
        <button
          type="button"
          className={r.lbRefresh}
          disabled={board.phase === 'loading'}
          onClick={() => {
            load(kind);
          }}
        >
          refresh
        </button>
      </div>
      <div className={r.rule} />

      <div className={cx(r.tabs, r.lbToggle)}>
        {KINDS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={cx(r.tab, kind === entry.id && r.tabActive)}
            aria-pressed={kind === entry.id}
            onClick={() => {
              setKind(entry.id);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <Board board={board} kind={kind} selfId={selfId} />

      <p className={r.boardsFoot}>
        Everyone who syncs to the cloud, best first. Total is lifetime earnings; per-hour is the
        same rate your Shift Report quotes, once a player has six active minutes behind it.
      </p>
    </div>
  );
}

function Board({
  board,
  kind,
  selfId,
}: {
  board: BoardPhase;
  kind: LeaderboardKind;
  selfId: string | null;
}) {
  // One calm sentence per non-row state. The game is local-first, so none of these are
  // errors — they are descriptions of a Tuesday, and they dress accordingly.
  switch (board.phase) {
    case 'loading':
      return <p className={r.lbNote}>Fetching the standings…</p>;
    case 'unconfigured':
      return (
        <p className={r.lbNote}>
          Cloud leaderboard is not configured. The game is local-first — nothing about playing needs
          it.
        </p>
      );
    case 'offline':
      return (
        <p className={r.lbNote}>
          Could not reach the leaderboard just now. Your game is unaffected — refresh to try again.
        </p>
      );
    case 'rows':
      break;
  }

  if (board.rows.length === 0) {
    return <p className={r.lbNote}>Nobody has posted a score on this board yet.</p>;
  }

  return (
    <ol className={r.rows}>
      {board.rows.map((row, index) => (
        <li
          // A player can hold a row per save slot, so the user id alone is not a key.
          key={`${row.userId}:${row.slot}`}
          className={cx(r.lbRow, row.userId === selfId && r.lbSelf)}
        >
          <span className={r.lbRank}>{index + 1}</span>
          <span className={r.lbName}>{row.displayName}</span>
          {/* How long the run took, quietly — context for the number, never a second score. */}
          <span className={r.lbMeta}>{formatTicks(row.ticksElapsed)}</span>
          <span className={r.lbValue}>{format(row, kind)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The board decides the unit; `format.ts` decides everything else, as always. */
function format(row: LeaderboardRow, kind: LeaderboardKind): string {
  if (kind === 'perHour') {
    // The query excludes NULL rates, so this branch is unreachable — but an em dash is the
    // honest rendering if a row ever slips through, and `formatPerHour(0)` would be a lie.
    return row.centsPerActiveHour === null ? '—' : formatPerHour(row.centsPerActiveHour);
  }
  return formatCents(row.lifetimeEarnedCents);
}
