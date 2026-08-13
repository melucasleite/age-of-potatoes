'use client';

// The upgrade bench — three dials on the machine you are standing next to.
//
// IT OPENS BECAUSE YOU WALKED OVER, and that is the whole interaction. There is no "select a
// machine" list, no build-menu entry, no modal. Plan §5's posture is that anything a machine
// does automatically the player can also do standing beside it, and plan §3 says the dials are
// "bought at the machine" — so the panel is a consequence of position, exactly like the reach
// check the sim runs when the command arrives. Walk away and it closes itself.
//
// WHAT MAKES IT A DECISION RATHER THAN A CHECKLIST, which is the only thing that matters here:
//
//   Every dial states its TRADE, not its bonus. Speed is faster and wears out sooner. Efficiency
//   is gentler and expensive. Capacity is free of consequence, and saying that plainly is the
//   point of it — plan §3 says "no catch" twice, and plan §1's generosity pillar makes it the
//   purchase a confused player can make without hurting themselves. A panel that invented a
//   downside for Capacity to look balanced would be lying to make a table symmetrical.
//
//   Every dial shows NOW → NEXT in its own units. "3.0s a batch → 2.3s a batch" is a decision.
//   "+30% speed" is a number, and a number the player cannot price against anything.
//
//   The escalation is called out the moment it bites. At level three a dial costs more than a
//   whole second machine, and the panel says so in words, because plan §3 wants "maxing one
//   fryer competes with buying a second" to be an argument the player actually has — and an
//   argument you have to do arithmetic to notice is an argument you never have.
//
// THE ANTI-DOUBLE-DIP RULE, from this side. Nothing in this file unlocks a capability, teaches
// a recipe, or changes what a machine is for. It scales numbers, and that is the only place in
// the game where numbers are scaled (§1, §3). The mirror of the rule lives in `TechTree.tsx`.
//
// AND ONE VERB THAT IS NOT A DIAL: "Box it up" ([[054]]). It is here because this is already
// the at-the-machine card — it exists BECAUSE the player walked over, which is exactly the reach
// the sim checks when `DeconstructMachine` arrives — and because taking a machine off the lot
// belongs beside the panel that says what has been spent on it. The dials and the box are the
// two ends of one thought: this machine, and what you want to do about it.
//
// IT IS NOT THE ONLY DOOR THIS VERB SHOULD HAVE. Item 054's instruction 6 wants a click on a
// DISTANT machine to walk there first (`IntentAction.Deconstruct` exists in the sim and is
// exercised by its fixture), and that lives in the input layer's pointer wiring, not here. Until
// it lands, this button is the whole of it — which also means a machine with no work cycle and
// therefore no bench (a sprinkler, a tank, a pump) cannot be boxed from the HUD yet.

import { useCallback } from 'react';

import { CONDITION_EFFECT_THRESHOLD, CONDITION_MAX, UpgradeDial, permille } from '@snack/sim';

import { formatCentsWhole } from './format';
import { cx, s } from './styles';
import { hudStore } from './store';
import { useHudSlice } from './use-hud';
import { usePending } from './use-pending';
import type { BenchDial, BenchSlice } from './types';

/**
 * Where the bar turns red: the sim's own degradation threshold, converted to the permille the
 * view publishes rather than assumed to be the same scale. They happen to coincide today
 * (condition runs 0..1000, so does permille) and a HUD that quietly depended on that would
 * start lying the day someone rescaled condition — with no error anywhere.
 */
const ROUGH_PERMILLE = permille(CONDITION_EFFECT_THRESHOLD, CONDITION_MAX);

function keepFocus(event: React.MouseEvent): void {
  event.preventDefault();
}

export function UpgradeBench({ onOpenResearch }: { onOpenResearch: () => void }) {
  const bench = useHudSlice('bench');
  const pending = usePending();

  const buy = useCallback(
    (machineId: number, dial: number) => {
      pending.hold(`${machineId}:${dial}`);
      hudStore.dispatch({
        type: 'UpgradeMachine',
        machineId,
        // The slice carries plain numbers by rule — no enums across the boundary — so the dial
        // widens to `number` on the way out and narrows here, exactly as `Toolbelt` does.
        dial: dial as UpgradeDial,
      });
    },
    [pending],
  );

  const box = useCallback(
    (machineId: number) => {
      pending.hold(`${machineId}:box`);
      hudStore.dispatch({ type: 'DeconstructMachine', machineId });
    },
    [pending],
  );

  // Not standing at anything upgradeable. The panel is not "closed", it simply has no subject.
  if (bench.machineId === 0) return null;

  const rough = bench.conditionPermille < ROUGH_PERMILLE;
  // The field is already permille, so percent is a divide by ten and not a second scaling.
  const conditionPercent = Math.round(bench.conditionPermille / 10);

  return (
    <div className={`${s.card} ${s.bench}`}>
      <div className={s.benchHead}>
        <span className={s.benchName}>{bench.label}</span>
        <span className={cx(s.benchCondition, rough && s.benchConditionLow)}>
          {conditionPercent}% condition
        </span>
      </div>
      <div className={s.benchTrack}>
        <div
          className={cx(s.benchFill, rough && s.benchFillLow)}
          style={{ width: `${Math.max(0, Math.min(100, conditionPercent))}%` }}
        />
      </div>

      {bench.researched === 0 ? (
        <>
          <div className={s.benchDivider} />
          <div className={s.benchLocked}>
            You could be spending money on this machine — Speed, Efficiency, Capacity, three levels
            each. The Upgrade Bench has not been built yet.
          </div>
          <button
            type="button"
            className={cx(s.dialBuy, s.dialBuyReady)}
            onMouseDown={keepFocus}
            onClick={onOpenResearch}
          >
            <span>Open Research</span>
            <span className={s.dialCost}>T</span>
          </button>
        </>
      ) : (
        bench.dials.map((dial) => (
          <Dial
            key={dial.dial}
            dial={dial}
            label={bench.label}
            pending={pending.isPending(`${bench.machineId}:${dial.dial}`)}
            onBuy={() => buy(bench.machineId, dial.dial)}
          />
        ))
      )}

      <div className={s.benchDivider} />
      <BoxButton
        bench={bench}
        pending={pending.isPending(`${bench.machineId}:box`)}
        onBox={() => box(bench.machineId)}
      />
    </div>
  );
}

/**
 * Take the whole machine off the lot.
 *
 * NO PRICE AND NO CONFIRM DIALOG, and both absences are the design. Boxing is not selling — the
 * money stays exactly where it is, the dials and the wear travel inside the box, and putting it
 * back down is free ([[054]]) — so there is nothing to confirm and nothing to quote. The verb
 * that DOES cost you something is scrapping the box, and that happens in the bag, one panel and
 * one deliberate press later.
 *
 * The two refusals are shown as a sentence rather than as a dead button, because "why can I not
 * box this" has an answer the player can act on in both cases: whack it, or take its output.
 */
function BoxButton({
  bench,
  pending,
  onBox,
}: {
  bench: BenchSlice;
  pending: boolean;
  onBox: () => void;
}) {
  const ready = bench.boxable === 1 && !pending;

  return (
    <>
      <button
        type="button"
        className={cx(s.dialBuy, ready && s.dialBuyReady)}
        disabled={!ready}
        onMouseDown={keepFocus}
        onClick={onBox}
      >
        <span>{pending ? 'packing…' : 'Box it up'}</span>
        <span className={s.dialCost}>to the bag</span>
      </button>
      {bench.boxBlocked === '' ? null : <div className={s.dialCompete}>{bench.boxBlocked}</div>}
    </>
  );
}

function Dial({
  dial,
  label,
  pending,
  onBuy,
}: {
  dial: BenchDial;
  label: string;
  pending: boolean;
  onBuy: () => void;
}) {
  const maxed = dial.level >= dial.maxLevel;
  const buyable = !maxed && dial.affordable === 1 && !pending;

  const pips: number[] = [];
  for (let i = 0; i < dial.maxLevel; i++) pips.push(i);

  return (
    <div className={s.dial}>
      <div className={s.dialHead}>
        <span className={s.dialName}>{dial.name}</span>
        <span className={s.pips}>
          {pips.map((i) => (
            <span key={i} className={cx(s.pip, i < dial.level && s.pipOn)} />
          ))}
        </span>
      </div>

      <div className={s.dialTrade}>{dial.trade}</div>

      <div className={s.dialDelta}>
        <span className={s.dialNow}>{dial.now}</span>
        {dial.next === '' ? null : (
          <>
            <span className={s.dialArrow}>→</span>
            <span className={s.dialNext}>{dial.next}</span>
          </>
        )}
      </div>

      {maxed ? (
        <div className={s.dialMaxed}>maxed</div>
      ) : (
        <>
          <button
            type="button"
            className={cx(
              s.dialBuy,
              buyable && s.dialBuyReady,
              dial.affordable === 0 && s.dialBuyBroke,
            )}
            disabled={!buyable}
            onMouseDown={keepFocus}
            onClick={onBuy}
          >
            <span>{pending ? 'fitting…' : `level ${dial.level + 1}`}</span>
            <span className={s.dialCost}>{formatCentsWhole(dial.costCents)}</span>
          </button>
          {dial.outpricesAnother === 1 ? (
            <div className={s.dialCompete}>more than a whole second {label}</div>
          ) : null}
        </>
      )}
    </div>
  );
}
