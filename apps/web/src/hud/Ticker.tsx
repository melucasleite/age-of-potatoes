'use client';

// The Ticker — the money on hand, the $/hr, and the in-game clock. That is all of it now.
//
// THE NEXT-PURCHASE CARD IS GONE, BY RULING ([[076]], owner, 2026-08-15, from play: "This box
// can go away. I don't think it's adding any value, and it's taking too much space"). The
// countdown surface — "Sprinkler: $150 · ready in ~4 min", the progress track, the ETA — was
// item 013's lineage and §2's retention device, and the owner watched it earn nothing. The ON
// HAND line above it stays exactly as it was; only the promo card went, and the `unlock`
// slice went with it (this panel was its only reader — see the item's log).
//
// The failure modes on the rate line still matter: if the rate is zero or unknown, this
// renders an em dash. Never `Infinity`, never a number it cannot stand behind.

import { useEffect, useRef } from 'react';

import { formatCents, formatCompactRatePerHour } from './format';
import { cx, s } from './styles';
import { hudStore } from './store';
import { useHudSlice } from './use-hud';
import { useLiveText } from './use-live-text';

export function Ticker() {
  const economy = useHudSlice('economy');

  const moneyRef = useRef<HTMLSpanElement | null>(null);
  const deltaRef = useRef<HTMLSpanElement | null>(null);
  useTickingMoney(economy.moneyCents, moneyRef, deltaRef);

  // The in-game clock never enters the snapshot: it would change on every publish and
  // re-render this panel 6.7 times a second to move two digits.
  const clockRef = useLiveText<HTMLSpanElement>(() => hudStore.live.clock);

  const rateClass =
    economy.rateSettled === 0 ? s.rateIdle : economy.rateCentsPerMin < 0 ? s.rateDown : s.rate;

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
        {/* PER HOUR SINCE [[149]], compact at scale — the slice stays cents/min (the research
            ETA divides by it); the ×60 and the K/M/B ladder live in `formatCompactRatePerHour`. */}
        <span className={`${s.rate} ${rateClass}`}>
          {economy.rateSettled === 0
            ? '—— / hr'
            : `${formatCompactRatePerHour(economy.rateCentsPerMin)} / hr`}
        </span>
        <span className={s.clock} ref={clockRef} />
      </div>
    </div>
  );
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
