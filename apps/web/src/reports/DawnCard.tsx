'use client';

// The Dawn Report. Five seconds, non-blocking, and the reason for "one more day".
//
// PLAN §2 SPECIFIES THIS PRECISELY, and every clause of it is a constraint on this file:
//
//   "the in-game day runs 8 real minutes; dawn shows a 5-second non-blocking card
//    (earnings, best seller, one flagged inefficiency) — the natural session exit ramp and
//    the reason for 'one more day.'"
//
// NON-BLOCKING IS LOAD-BEARING AND IT IS NOT A CSS DETAIL. This card must not pause the sim,
// must not steal focus, must not interrupt a drag, and must not swallow a click meant for a
// tile. So:
//
//   · It is `pointer-events: none` in full except the dismiss button. A gesture that starts
//     under it reaches the canvas.
//   · It renders no `<dialog>`, no focus trap, no `autoFocus`, and no `aria-modal`. The
//     dismiss button is a plain button and nothing moves the caret to it.
//   · Its lifetime is counted in TICKS by the store, from the loop that is already running.
//     There is no `setTimeout` here — sim-speed controls are cut forever (§6) and a card
//     that outlives a stopped tab is the same sin in a hat.
//   · Dismissing early is free, immediate, and enqueues nothing. Closing a receipt is not a
//     world event.
//
// ONE FLAG, NEVER A LIST. §2 is explicit that the Clipboard's observations are "never
// quests", and this card obeys the same rule: the single worst bleed, phrased in cash per
// §5, or the sentence saying there wasn't one — which is the nicest line in the game and
// must not be replaced by the least bad complaint available.

import { formatCents } from './format';
import { r, cx } from './styles';
import { reportsStore } from './store';
import { useReportsSlice } from './use-reports';

export function DawnCard() {
  const dawn = useReportsSlice('dawn');
  const card = dawn.card;
  if (card === null) return null;

  const flag = card.flag;

  return (
    // `key` on the card's ordinal so a second dawn REPLACES the first rather than mutating
    // it in place — the entrance animation should play again, and a card that morphs into
    // the next day's numbers while you read it is worse than one that arrives.
    <div className={r.dawn} key={card.id} aria-live="polite">
      <div className={r.dawnCard}>
        <button
          type="button"
          className={r.dawnClose}
          onClick={() => {
            reportsStore.dismissDawn();
          }}
          aria-label="Dismiss the dawn report"
        >
          ×
        </button>

        <div className={r.dawnHead}>
          <span className={r.dawnTitle}>Dawn Report</span>
          <span className={r.dawnDay}>day {card.day}</span>
        </div>

        <div className={cx(r.dawnMoney, card.netCents < 0 && r.dawnMoneyDown)}>
          {formatCents(card.split === 1 ? card.earnedCents : card.netCents)}
        </div>

        <ul className={r.dawnLines}>
          <li className={r.dawnLine}>
            <span className={r.dawnDot} />
            <span>
              {card.split === 1
                ? `taken in yesterday · ${formatCents(card.netCents)} cleared`
                : 'cleared yesterday, after everything you spent'}
            </span>
          </li>

          <li className={r.dawnLine}>
            <span className={cx(r.dawnDot, card.bestSeller === null && r.dawnDotStub)} />
            {card.bestSeller === null ? (
              // The honest absence. `StatsView` carries `itemsSold` as one total with no
              // per-item breakdown, and back-solving a product from an average price would
              // be a guess dressed as a receipt. `sim-contract.ts` names the field needed.
              <span className={r.dawnStub}>best seller — awaiting per-item sales</span>
            ) : (
              <span>
                best seller: {card.bestSeller.label} ×{card.bestSeller.count} ·{' '}
                {formatCents(card.bestSeller.grossCents)}
              </span>
            )}
          </li>

          <li className={r.dawnLine}>
            <span className={cx(r.dawnDot, flag !== null && r.dawnDotFlag)} />
            {flag === null ? (
              <span>Nothing sat idle for more than a minute.</span>
            ) : (
              // §5's voice exactly: "Fryer B idle 6 min — $14 wasted". A fact about the lot,
              // stated once, that happens to imply what to do. Never an instruction.
              <span>
                {flag.text} — {formatCents(flag.costCents)} wasted
              </span>
            )}
          </li>
        </ul>

        {/*
          The drain bar. Decoration: the real deadline is a tick count in the store, and
          this is a CSS animation so that nothing re-renders to move three pixels. If the
          card is dismissed early the whole subtree unmounts and the bar goes with it.
        */}
        <div className={r.dawnTrack} aria-hidden="true" />
      </div>
    </div>
  );
}
