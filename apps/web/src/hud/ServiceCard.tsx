'use client';

// The maintenance card — the first thing on the machine you are standing at ([[129]]).
//
// IT EXISTS BECAUSE THE RIGHT MOUSE BUTTON STOPPED BEING THE REPAIR KEY. Right-click tears down
// now, and the owner ruled where repair goes instead: *"Make it teardown, maintenance by bots or
// clicking the machine has a maintenance at the top with a dollar cost."* Bots were already the
// automated route ([[039]], [[090]]). This is the manual one, and it is FIRST in `MachineCards`
// so "at the top" is a fact about the markup rather than a hope about the layout.
//
// THE PRICE IS ON THE BUTTON, WHICH IS THE ENTIRE POINT OF THE RULING. Repair used to be an
// invisible drain — you held a button and money never moved, so nothing about wear was ever a
// decision. A kit costs what the stand charges for it, the label says so before the click, and
// the player chooses with the number in front of them. See `derive-service.ts` for why the free
// hand pulse sits beneath it saying "free" rather than being given an invented price.
//
// IT BORROWS `.bench` WHOLESALE, exactly as `DockCard` and `GrabberCard` do and for the same
// reason: same corner, same controls, same width, different question. No new stylesheet rules
// were added for this card, which is also why it inherits the fold ([[106]]) without knowing
// there is one.
//
// WHAT THE CARD REFUSES TO DO:
//
//   IT DOES NOT DECIDE WHETHER THE REPAIR WILL BE ACCEPTED. Both buttons build a command the sim
//   re-validates (§12). `handUseful` greys the free one on the two states `applyRepairMachine`
//   returns false for, as a courtesy — the papercut this HUD keeps being filed against is a live
//   control that does nothing — but the sim remains the authority and a refused command is a
//   no-op that leaves no trace entry.
//
//   IT DOES NOT PRETEND THE KIT IS ABOUT THIS MACHINE ALONE. `applyUseRepairKit` services
//   everything within `REPAIR_KIT_RADIUS_TILES` of the tile, jams included, and the sub-line says
//   so. Quoting $8.00 for "this Fryer" would undersell the one thing the kit is actually for —
//   plan §4's "one trip services a cell".

import { useCallback } from 'react';

import { CONDITION_EFFECT_THRESHOLD, CONDITION_MAX, permille } from '@snack/sim';

import { KIT_RADIUS_TILES, serviceCommand } from './derive-service';
import { formatCentsWhole } from './format';
import { hudStore } from './store';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import { usePending } from './use-pending';

/** Where the bar turns red — the bench's threshold, derived the same way and for its reasons. */
const ROUGH_PERMILLE = permille(CONDITION_EFFECT_THRESHOLD, CONDITION_MAX);

function keepFocus(event: React.MouseEvent): void {
  event.preventDefault();
}

export function ServiceCard() {
  const service = useHudSlice('service');
  const pending = usePending();

  const kit = useCallback(
    (tileX: number, tileY: number) => {
      pending.hold(`service:kit:${tileX}:${tileY}`);
      hudStore.dispatch({ type: 'UseRepairKit', tileX, tileY });
    },
    [pending],
  );

  const hand = useCallback(
    (machineId: number, jammed: boolean) => {
      pending.hold(`service:hand:${machineId}`);
      hudStore.dispatch(serviceCommand(machineId, jammed));
    },
    [pending],
  );

  // Not standing at anything a wrench means something to. Not "closed" — it has no subject.
  if (service.machineId === 0) return null;

  const jammed = service.jammed === 1;
  const percent = Math.round(service.conditionPermille / 10);
  const rough = service.conditionPermille < ROUGH_PERMILLE;

  const hasKit = service.kitsHeld > 0;
  const kitPending = pending.isPending(`service:kit:${service.kitTileX}:${service.kitTileY}`);
  const handPending = pending.isPending(`service:hand:${service.machineId}`);
  const handReady = service.handUseful === 1 && !handPending;

  return (
    <div className={`${s.card} ${s.bench}`}>
      <div className={s.benchHead}>
        <span className={s.benchName}>{service.label}</span>
        <span className={cx(s.benchCondition, rough && s.benchConditionLow)}>
          {jammed ? 'jammed' : `${percent}% condition`}
        </span>
      </div>
      <div className={s.benchTrack}>
        <div
          className={cx(s.benchFill, rough && s.benchFillLow)}
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>

      {/*
        THE PRICED ROW, FIRST, BECAUSE IT IS THE ONE WITH A NUMBER ON IT. A kit puts this machine
        and everything around it back to full in one press — the free pulse below is ten presses
        and a stand-still — so the trade the player is being asked to make is $8.00 against their
        own time, and both halves of it are on screen at once.
      */}
      <button
        type="button"
        className={cx(
          s.dialBuy,
          hasKit && !kitPending && s.dialBuyReady,
          !hasKit && s.dialBuyBroke,
        )}
        disabled={!hasKit || kitPending}
        onMouseDown={keepFocus}
        onClick={() => kit(service.kitTileX, service.kitTileY)}
      >
        <span>{kitPending ? 'servicing…' : 'Full service'}</span>
        <span className={s.dialCost}>{formatCentsWhole(service.kitPriceCents)}</span>
      </button>
      <div className={s.dialCompete}>
        {hasKit
          ? `spends 1 of your ${service.kitsHeld} repair kits — restores everything within ${KIT_RADIUS_TILES} tiles, jams and all`
          : `no repair kits in the bag — the stand sells them at ${formatCentsWhole(service.kitPriceCents)}`}
      </div>

      {/*
        AND THE FREE ONE, WHICH IS THE VERB RIGHT-CLICK USED TO CARRY. One pulse per press, and a
        jam is whacked before anything is tightened — the same branch, in the same order, that
        `maintenanceCommand` ran on the mouse button until this item moved it.
      */}
      <button
        type="button"
        className={cx(s.dialBuy, handReady && s.dialBuyReady)}
        disabled={!handReady}
        onMouseDown={keepFocus}
        onClick={() => hand(service.machineId, jammed)}
      >
        <span>{handPending ? 'wrenching…' : jammed ? 'Whack the jam' : 'Tighten it up'}</span>
        <span className={s.dialCost}>free</span>
      </button>
      {service.handUseful === 0 ? (
        <div className={s.dialCompete}>nothing to tighten — this one is in good order</div>
      ) : service.botsWanting > 0 ? (
        <div className={s.dialCompete}>
          {service.botsWanting === 1
            ? 'services the Agri-Bot asleep in here too'
            : `services the ${service.botsWanting} Agri-Bots asleep in here too`}
        </div>
      ) : (
        <div className={s.dialCompete}>by hand, one pulse a press — or let a drone do it</div>
      )}
    </div>
  );
}
