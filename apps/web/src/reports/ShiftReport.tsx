'use client';

// The hourly ledger, as plan §4 specifies it.
//
// THE SIX LINES ARE NOT A SUGGESTION. §4 names them: gross, waste %, spoilage %, kit spend,
// water drawn, rolling best $/hr — and the reason it names them is that this report is how
// the game teaches its sloppiness tax. Same machines, different operators: a well-run hour-6
// factory nets about $370/hr and a sloppy one about $180, and the difference is invisible
// unless something itemises it. That is this panel's whole job: not to praise or to nag, but
// to show where the other $190 went.
//
// TWO ROWS SAY "NOT YET MEASURED" AND THAT IS THE CORRECT BEHAVIOUR. Waste % and spoilage %
// measure systems that arrive with the Entropy release. Work item 033 is explicit that they
// are shown as labelled stubs rather than hidden, per plan §8's standing rule — a report
// that grows two new rows three releases from now is worse than one whose shape was stable
// from its first hour, and a confident "0.0%" for something nobody is counting is a lie with
// a decimal point on it.
//
// The gross and kit-spend rows carry the same treatment for a different reason: the
// projection currently exposes only their difference. See `sim-contract.ts`.

import { formatCents, formatPerHour, formatPermille, formatTicks, formatWater } from './format';
import { centsPerActiveHour } from './rate';
import { r, cx } from './styles';
import type { ShiftBucket, StubbedRatio } from './types';
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
        <Ratio label="Spoilage" ratio={shift.spoilage} />
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
          return (
            <div
              key={bucket.hour}
              className={cx(r.bar, rate < 0 && r.barLoss, best && r.barBest)}
              style={{ height: `${height}px` }}
              title={`Hour ${bucket.hour + 1}: ${formatPerHour(rate)}`}
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

function Ratio({ label, ratio }: { label: string; ratio: StubbedRatio }) {
  return (
    <Line
      label={`${label} %`}
      value={ratio.measured === 1 ? formatPermille(ratio.permille) : null}
      stub="not yet measured"
    />
  );
}
