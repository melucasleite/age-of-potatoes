'use client';

// The personal-best board. You versus you, and it says so.
//
// Plan §8's v0.5 line asks for "the local personal-best board (the leaderboard's stat trio,
// validated offline)", and work item 033 widens that to all six of §6's boards — which is
// the cheap, high-leverage half of the leaderboard work. The stats already exist inside
// `WorldStats`; the entire risk is whether they say anything true. Getting that wrong here
// costs an afternoon. Getting it wrong after worlds have posted scores costs the boards
// their credibility, permanently, and no patch buys it back.
//
// NO NETWORK. Not a fetch, not a Supabase call, not a queued upload. Lucas's ruling is a
// fun, lightly validated leaderboard with no cohorts and no replay validation, and the
// online half is a separate, later item. The footer says all of this out loud so nobody
// wonders whether their score went anywhere.
//
// The arithmetic and the two easy-to-invert rulings live in `boards.ts`. This file only
// decides how a row looks.

import { formatCentiHours, formatCents, formatPerHour, formatTicks } from './format';
import { r, cx } from './styles';
import type { BoardRow } from './types';
import { useReportsSlice } from './use-reports';

export function BoardsPanel() {
  const boards = useReportsSlice('boards');

  return (
    <div className={cx(r.card, r.panel)}>
      <div className={r.head}>
        <span className={r.label}>Personal Bests</span>
        <span className={r.sub}>{formatCentiHours(boards.centiActiveHours)} played</span>
      </div>
      <div className={r.rule} />

      {boards.rows.map((row) => (
        <Row key={row.id} row={row} loaded={boards.loaded === 1} />
      ))}

      <p className={r.boardsFoot}>
        Local only. Nothing here is uploaded, ranked against anybody, or checked by a server — the
        record to beat is the one you set last time.
      </p>
    </div>
  );
}

function Row({ row, loaded }: { row: BoardRow; loaded: boolean }) {
  const locked = row.eligible === 0;

  return (
    <div className={cx(r.board, locked && r.boardLocked)}>
      <div className={r.boardHead}>
        <span className={r.boardName}>{row.label}</span>
        <span className={r.boardValue}>{format(row.value, row.unit)}</span>
      </div>
      <p className={r.boardBlurb}>{row.blurb}</p>
      <div className={r.boardFoot}>
        {/*
          "best" is an em dash until IndexedDB has answered, rather than a confident zero.
          A board that says your record is $0.00 for the first half-second of a session is
          a board that told you something false, however briefly.
        */}
        <span>best · {loaded ? format(row.best, row.unit) : '—'}</span>
        {row.fresh === 1 && loaded ? (
          <span className={r.boardFresh}>new best</span>
        ) : row.gate === '' ? null : (
          <span className={r.boardGate}>{row.gate}</span>
        )}
      </div>
    </div>
  );
}

/** One formatter per unit, chosen by the row. Money never touches the ticks path. */
function format(value: number, unit: BoardRow['unit']): string {
  switch (unit) {
    case 'cents':
      return formatCents(value);
    case 'perHour':
      return formatPerHour(value);
    case 'ticks':
      return value <= 0 ? '—' : formatTicks(value);
    case 'centiHours':
      return formatCentiHours(value);
    default:
      return String(value);
  }
}
