'use client';

// The hourly ledger, as plan §4 specifies it.
//
// THE LINES ARE NOT A SUGGESTION. §4 named six: gross, waste %, spoilage %, kit spend, water
// drawn, rolling best $/hr — five now, because [[124]] deleted spoilage as a mechanic and a
// row measuring nothing is worse than no row. The reason §4 names them is that this report is how
// the game teaches its sloppiness tax. Same machines, different operators: a well-run hour-6
// factory nets about $370/hr and a sloppy one about $180, and the difference is invisible
// unless something itemises it. That is this panel's whole job: not to praise or to nag, but
// to show where the other $190 went.
//
// THE WASTE ROW IS MEASURED, AND FOR A LONG TIME IT SAID OTHERWISE. This header used to
// explain that Waste % "arrives with the Entropy release" and that its stub was therefore
// correct. It had arrived: `tick.ts` counts every input a machine destroys, `stats.ts`
// telescopes the count per hour, and `view.ts` divides it by that hour's throughput. The row
// went on printing "not yet measured" because the client read a `stats.wastePermille` that
// `StatsView` does not have — an optional field on a widened type, so `undefined` forever,
// no type error, no failing test. A STUB OUTLIVING ITS SYSTEM IS THE EXPENSIVE FAILURE HERE:
// the panel's whole job is to itemise where the money went, and it was hiding the one line
// that says a machine ate it.
//
// ⚠️ SPOILAGE WAS THE OTHER SUCH ROW AND IT WENT THE OTHER WAY ([[124]]). A stub is a PROMISE
// that a number is coming; the owner deleted spoilage outright, so that promise could never
// be kept and the row was removed rather than stubbed forever. Between them the two rows are
// the whole rule: a stub is only ever a temporary state, and it is wrong in both directions —
// kept past its release, or kept past its cancellation.
//
// The row can still decline to print a figure, for a REAL reason rather than a pending one:
// an hour in which no machine finished or spoiled anything has no ratio to take, and it says
// that in those words. The gross and kit-spend rows carry the older treatment for a different
// reason again — the projection exposes only their difference. See `sim-contract.ts`.

import { TICKS_PER_ACTIVE_HOUR } from '@snack/sim';

import { formatCents, formatPerHour, formatPermille, formatTicks, formatWater } from './format';
import { centsPerActiveHour } from './rate';
import { r, cx } from './styles';
import type { HourRatio, ShiftBucket } from './types';
import { useReportsSlice } from './use-reports';

export function ShiftReport() {
  const shift = useReportsSlice('shift');
  const current = shift.current;

  return (
    <div className={cx(r.card, r.panel)}>
      <div className={r.head}>
        <span className={r.label}>Shift Report</span>
        <span className={r.sub}>hour {current.hour + 1}</span>
      </div>

      <div className={r.headline}>
        <span
          className={cx(r.headlineValue, shift.centsPerHour < 0 && r.headlineDown)}
          // The rate is the headline because it is the only figure on this panel that is
          // comparable between one hour and the next. A gross figure ten minutes into an
          // hour is not small; it is early.
        >
          {shift.settled === 1 ? formatPerHour(shift.centsPerHour) : '—'}
        </span>
        <span className={r.headlineUnit}>{shift.settled === 1 ? 'this hour' : 'warming up'}</span>
      </div>

      <div className={r.rule} />

      <ul className={r.rows}>
        <Line
          label="Gross"
          value={current.split === 1 ? formatCents(current.grossCents) : null}
          stub="needs stats.lifetimeEarnedCents"
          tone="money"
        />
        <Ratio label="Waste" ratio={shift.waste} />
        <Line
          label="Kit spend"
          value={current.split === 1 ? formatCents(current.spendCents) : null}
          stub="needs stats.lifetimeSpentCents"
          tone="money"
        />
        <Line label="Water drawn" value={formatWater(current.waterMl)} tone="water" />
        <Line
          label="Best hour"
          value={shift.bestCentsPerHour > 0 ? formatPerHour(shift.bestCentsPerHour) : null}
          stub="no hour has closed yet"
          tone="good"
        />
      </ul>

      <div className={r.rule} />

      {/*
        Net movement is not one of §4's six lines and it is here anyway, small, at the
        bottom: it is the only figure on this panel the projection can compute exactly today,
        and a report whose one exact number is missing would be a strange report.
      */}
      <ul className={r.rows}>
        <Line label="Cleared this hour" value={formatCents(current.netCents)} tone="money" />
        <Line label="Sold this hour" value={`${current.itemsSold}`} />
        <Line label="Next dawn card" value={formatTicks(shift.ticksUntilDawn)} />
      </ul>

      <HourStrip history={shift.history} />
    </div>
  );
}

/**
 * One bar per closed hour, oldest left.
 *
 * Not a chart with axes — a chart of eight numbers is a chart nobody reads. The bars exist
 * so that a good hour and a bad one have the same SHAPE, which is the tax made visible in
 * one glance rather than in six rows of arithmetic.
 *
 * HEIGHT IS THE RATE, WIDTH IS HOW LONG THE HOUR LASTED. Almost every hour is a full one and
 * draws at full width, so the strip looks exactly as it always did. The exception is hour 0,
 * which is short because hour boundaries are dawn-aligned: a world born at 09:00 gets 8,400
 * ticks before the first 06:00 rather than a full 72,000. It used to be dropped from this
 * strip entirely (see `shift.ts:adopt`), which is why it is worth drawing rather than
 * hiding — in one measured session it held a third of everything the world had earned.
 * Height needs no adjustment for it: a rate is already divided by the ticks it took, so a
 * short hour and a full one are directly comparable. Only the width has anything left to say.
 */
function HourStrip({ history }: { history: readonly ShiftBucket[] }) {
  if (history.length === 0) {
    return <p className={r.stripEmpty}>The first bar appears when this hour closes.</p>;
  }

  let peak = 1;
  for (const bucket of history) {
    const rate = Math.abs(centsPerActiveHour(bucket.netCents, bucket.ticks));
    if (rate > peak) peak = rate;
  }

  return (
    <>
      <div className={r.rule} />
      <span className={r.label}>Hours closed</span>
      <div className={r.strip}>
        {history.map((bucket) => {
          const rate = centsPerActiveHour(bucket.netCents, bucket.ticks);
          const height = Math.max(3, Math.round((Math.abs(rate) / peak) * 34));
          const best = rate > 0 && Math.abs(rate) === peak;
          const span = Math.min(1, bucket.ticks / TICKS_PER_ACTIVE_HOUR);
          const part = bucket.ticks < TICKS_PER_ACTIVE_HOUR;
          return (
            <div
              key={bucket.hour}
              className={cx(r.bar, rate < 0 && r.barLoss, best && r.barBest)}
              // `flexGrow` rather than a modifier class: the bar's own rule is `flex: 1 1 0`,
              // so a full hour passes 1 and renders byte-identically to before, and a short
              // one narrows in proportion to what it actually was. `min-width` keeps the
              // narrowest hour clickable.
              style={{ height: `${height}px`, flexGrow: span }}
              title={
                part
                  ? `Hour ${bucket.hour + 1}: ${formatPerHour(rate)} over ${formatTicks(bucket.ticks)} — a partial hour`
                  : `Hour ${bucket.hour + 1}: ${formatPerHour(rate)}`
              }
            />
          );
        })}
      </div>
    </>
  );
}

type Tone = 'money' | 'good' | 'water' | undefined;

/** A row whose value may not exist yet. `null` prints the stub instead of a fake zero. */
function Line({
  label,
  value,
  stub,
  tone,
}: {
  label: string;
  value: string | null;
  stub?: string;
  tone?: Tone;
}) {
  return (
    <li className={r.row}>
      <span className={r.rowKey}>{label}</span>
      {value === null ? (
        <span className={r.rowStub}>{stub ?? 'not yet measured'}</span>
      ) : (
        <span
          className={cx(
            r.rowValue,
            tone === 'money' && r.rowMoney,
            tone === 'good' && r.rowGood,
            tone === 'water' && r.rowWater,
          )}
        >
          {value}
        </span>
      )}
    </li>
  );
}

/**
 * A ratio row, which prints a figure or the reason there is not one.
 *
 * The stub says what is actually true — the hour has had no throughput to take a ratio of —
 * rather than the old "not yet measured", which described a system that had already shipped
 * and made the row indistinguishable from a genuine gap in the instruments.
 */
function Ratio({ label, ratio }: { label: string; ratio: HourRatio }) {
  return (
    <Line
      label={`${label} %`}
      value={ratio.measured === 1 ? formatPermille(ratio.permille) : null}
      stub="nothing ran this hour"
    />
  );
}
