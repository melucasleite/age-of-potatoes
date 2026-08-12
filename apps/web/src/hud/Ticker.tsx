'use client';

// The Ticker — the one panel the design doc calls out by name (§2):
//
//   "always-on $/min plus an unlock ETA — 'Sprinkler: $150 — at $36/min, ready in ~4 min.'
//    Converts the stable economy into a countdown."
//
// That last sentence is the whole reason this panel exists, and it is worth being precise
// about the mechanism. A stable economy is a number that sits there. A stable economy with
// an ETA on it is a number that FINISHES — the player is no longer watching money
// accumulate, they are watching a clock run out on something they want. Same economy, same
// numbers, entirely different reason to stay for four more minutes.
//
// Which is also why the failure modes matter more than they look. If the rate is zero or
// unknown, this renders an em dash. It never renders `Infinity`, never a negative
// countdown, and never a number it cannot stand behind — a countdown that lies once is a
// countdown nobody reads again.

import { useEffect, useRef } from 'react';

import { formatCents, formatCentsWhole, formatEta, formatRate } from './format';
import { cx, s } from './styles';
import { hudStore } from './store';
import { useHudSlice } from './use-hud';
import { useLiveText } from './use-live-text';

export function Ticker() {
  const economy = useHudSlice('economy');
  const unlock = useHudSlice('unlock');

  const moneyRef = useRef<HTMLSpanElement | null>(null);
  const deltaRef = useRef<HTMLSpanElement | null>(null);
  useTickingMoney(economy.moneyCents, moneyRef, deltaRef);

  // The in-game clock never enters the snapshot: it would change on every publish and
  // re-render this panel 6.7 times a second to move two digits.
  const clockRef = useLiveText<HTMLSpanElement>(() => hudStore.live.clock);

  const rateClass =
    economy.rateSettled === 0 ? s.rateIdle : economy.rateCentsPerMin < 0 ? s.rateDown : s.rate;

  const progress =
    unlock.priceCents <= 0 ? 0 : Math.min(1, Math.max(0, economy.moneyCents / unlock.priceCents));

  return (
    <div className={`${s.card} ${s.ticker}`}>
      <div className={s.label}>on hand</div>
      <div className={s.moneyRow}>
        <span className={s.money} ref={moneyRef}>
          {formatCents(economy.moneyCents)}
        </span>
        <span className={s.delta} ref={deltaRef} />
      </div>

      <div className={s.rateRow}>
        <span className={`${s.rate} ${rateClass}`}>
          {economy.rateSettled === 0 ? '—— / min' : `${formatRate(economy.rateCentsPerMin)} / min`}
        </span>
        <span className={s.clock} ref={clockRef} />
      </div>

      {unlock.id === null ? null : (
        <>
          <div className={s.rule} />
          <div className={s.unlockHead}>
            <span className={s.unlockName}>{unlock.label}</span>
            <span className={s.unlockPrice}>{formatCentsWhole(unlock.priceCents)}</span>
          </div>
          <div className={s.unlockBlurb}>{unlock.blurb}</div>

          <div className={s.track}>
            <div
              className={cx(s.fill, unlock.affordable === 1 && s.fillReady)}
              style={{ width: `${(progress * 100).toFixed(1)}%` }}
            />
          </div>

          <div className={s.etaRow}>
            <span className={etaClass(unlock.affordable, unlock.etaSeconds)}>
              {unlock.affordable === 1
                ? 'affordable now'
                : `ready in ${formatEta(unlock.etaSeconds)}`}
            </span>
            <span className={s.owned}>
              {unlock.owned === 0 ? 'none on the lot' : `${unlock.owned} already`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function etaClass(affordable: number, etaSeconds: number): string {
  if (affordable === 1) return cx(s.eta, s.etaReady);
  if (etaSeconds < 0) return cx(s.eta, s.etaUnknown);
  return s.eta;
}

/**
 * The counting-up counter.
 *
 * Two things this must not be. It must not be a per-frame React state update — that is 60
 * renders a second to change a string, which is the cost the whole store exists to avoid.
 * And it must not be a silent lerp: money sliding smoothly to a new value while you look
 * away is indistinguishable from money that was always that value, so the arrival of it
 * carries no feeling at all. It counts, in whole cents, with a pulse while it counts and a
 * "+$2.00" that says what just landed.
 *
 * So: React re-renders at most 6.7 times a second when the target moves; the digits
 * animate through an rAF that writes `textContent` and stops itself the instant it arrives.
 */
function useTickingMoney(
  targetCents: number,
  moneyRef: React.RefObject<HTMLSpanElement | null>,
  deltaRef: React.RefObject<HTMLSpanElement | null>,
): void {
  const displayed = useRef(targetCents);
  const raf = useRef(0);
  const deltaTimer = useRef(0);

  useEffect(() => {
    const node = moneyRef.current;
    if (node === null) return;

    const from = displayed.current;
    if (from === targetCents) {
      node.textContent = formatCents(targetCents);
      node.classList.remove(s.moneyTicking);
      return;
    }

    // Say what just landed, then get out of the way.
    const delta = deltaRef.current;
    if (delta !== null) {
      const jump = targetCents - from;
      delta.textContent = `${jump > 0 ? '+' : ''}${formatCents(jump)}`;
      delta.className = cx(s.delta, s.deltaShow, jump < 0 && s.deltaDown);
      window.clearTimeout(deltaTimer.current);
      deltaTimer.current = window.setTimeout(() => {
        delta.className = s.delta;
      }, 900);
    }

    node.classList.add(s.moneyTicking);
    const step = (): void => {
      const remaining = targetCents - displayed.current;
      if (remaining === 0) {
        raf.current = 0;
        node.classList.remove(s.moneyTicking);
        return;
      }
      // A twelfth of the gap per frame, at least one cent: big jumps land in about a fifth
      // of a second and a one-cent change still visibly moves rather than snapping.
      const stride = Math.max(1, Math.ceil(Math.abs(remaining) / 12));
      displayed.current +=
        remaining > 0 ? Math.min(stride, remaining) : Math.max(-stride, remaining);
      node.textContent = formatCents(displayed.current);
      raf.current = requestAnimationFrame(step);
    };

    if (raf.current === 0) raf.current = requestAnimationFrame(step);

    return () => {
      if (raf.current !== 0) {
        cancelAnimationFrame(raf.current);
        raf.current = 0;
      }
    };
  }, [targetCents, moneyRef, deltaRef]);

  // The timer outlives the effect above, so it gets its own unmount cleanup.
  useEffect(() => {
    const timer = deltaTimer;
    return () => {
      window.clearTimeout(timer.current);
    };
  }, []);
}
