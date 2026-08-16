'use client';

// What you are carrying, and what it is worth if you walk it to the bin.
//
// The value is the interesting half. "12 russets" is a number; "12 russets · $24" is the
// reason to walk to the sell bin, and it is also the first place a player notices that a
// bag of chips is worth ten russets — which is the entire argument for the Chip Kitchen,
// made without a tutorial saying so.
//
// WHICH IS EXACTLY WHY A STACK THE BIN REFUSES SHOWS NO FIGURE. Seeds are bought at the
// roadside stand and never sold back ([[051]]), so "8 seeds · $4" would be a price for a
// transaction that cannot happen — and worse, it sits two feet from the real prices and
// reads as a promise. The count still shows; only the claim about money goes. Whether a
// thing is sellable is the simulation's call, read through `derivePouch`.
//
// AND THE SAME RULE NOW GOVERNS THE CLOCK ([[035]]). Harvested goods age only while the player is
// carrying them — a stack in a machine, a crate or a Root Cellar has no clock running — so the
// pouch is not merely *a* place freshness could be shown, it is the surface that corresponds to
// the object §5 wants the state drawn on. It is also the only one a player sees without opening
// anything, which is why the warning lives here and the arithmetic lives one file away.

import { Fragment } from 'react';

import { ToolMode } from '@/game/input/tools';
// THE one threshold ([[073]]): full/half/empty is decided in `render/can-state.ts` and
// nowhere else — the chip, the hotbar slot and the held sprite must flip on the same pour,
// so the HUD imports the render lane's helper rather than owning a second opinion. The
// module is pure (no Pixi), which is what makes the import legal from a DOM component.
import { canFrame } from '@/game/render/can-state';

import { ItemIcon } from './ItemIcon';
import { formatCentsWhole } from './format';
import { formatFreshness, freshnessBand, isWarning } from './freshness';
import { paintIcon, resolveFrameIcon } from './item-art';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import type { PouchItem, PouchSlice } from './types';

/** Two-times an item frame. The chip strip is always on screen, so it pays rent by the pixel. */
const POUCH_ICON = 32;

export function Pouch() {
  const pouch = useHudSlice('pouch');
  // The armed tool decides whether the can chip draws, and reading the tools slice here is
  // cheaper than a second copy of the tool in the pouch slice — the two are already in the
  // same snapshot, published by the same store.
  const tools = useHudSlice('tools');
  const canArmed = tools.tool === ToolMode.Water && pouch.canChargesMax > 0;

  if (pouch.items.length === 0 && !canArmed) {
    return (
      <div className={`${s.card} ${s.pouch}`}>
        <span className={s.pouchEmpty}>pockets empty</span>
      </div>
    );
  }

  return (
    <div className={`${s.card} ${s.pouch}`}>
      {canArmed ? <CanChip pouch={pouch} divide={pouch.items.length > 0} /> : null}
      {pouch.items.map((item, index) => (
        <Fragment key={item.id}>
          {index === 0 ? null : <span className={s.pouchDivider} />}
          <span className={s.stack}>
            {/*
              The one place in the HUD a sprite is on screen without anybody opening anything
              ([[058]]). The label stays: the pouch is four chips wide and the picture is what
              makes it scannable, not what makes it comprehensible. `align-self` rather than a
              change to `.stack` — the three text spans still share a baseline, and the icon
              centres on the line rather than hanging off it.
            */}
            <ItemIcon item={item.id} size={POUCH_ICON} className={s.pouchIcon} />
            <span className={s.stackCount}>{item.count}</span>
            <span className={s.stackLabel}>{item.label}</span>
            {item.sellable === 1 ? (
              <span className={s.stackValue}>{formatCentsWhole(item.valueCents)}</span>
            ) : null}
            <Clock item={item} />
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The watering can's chip: pours left, against the twenty it holds ([[009]], recapped by
 * [[073]] — the owner's 20), with the can's own face beside the count.
 *
 * DRAWN ONLY WHILE THE WATER TOOL IS ARMED — the can is the thing in your hand at that
 * moment, and a permanent gauge would be one more number the eye learns to skip. While it IS
 * armed the chip is always there, so "why did my pour do nothing" has a visible answer at
 * the moment the question is asked: the sim refuses an empty can as a silent no-op (nothing
 * spent, nothing lost), which means the STATE is the only tell the HUD can give.
 *
 * THE SPRITE FLIPS ON THE SHARED THRESHOLD ([[073]]): `canFrame` in `render/can-state.ts`
 * decides full/half/empty for every surface at once, so the chip, the hotbar slot and the
 * farmer's hand can never disagree about which can this is. A build whose atlas predates the
 * new frames draws the count alone — degraded honestly, never magenta ([[037]]).
 *
 * At zero it turns red and points at the water — gently, with a direction rather than a
 * klaxon, because an empty can is not a failure. There is no fail state here (§4): the
 * refill never fails at any shore at any level, so the chip's empty line is a promise, not
 * a warning.
 */
function CanChip({ pouch, divide }: { pouch: PouchSlice; divide: boolean }) {
  const empty = pouch.canCharges <= 0;
  return (
    <>
      <span className={cx(s.canChip, empty && s.canChipEmpty)}>
        <CanFace charges={pouch.canCharges} chargesMax={pouch.canChargesMax} />
        {empty ? <span className={s.stackFreshMark} /> : null}
        <span className={s.stackCount}>
          {pouch.canCharges}/{pouch.canChargesMax}
        </span>
        <span className={s.stackLabel}>{empty ? emptyLine(pouch.shoreHeading) : 'can'}</span>
      </span>
      {divide ? <span className={s.pouchDivider} /> : null}
    </>
  );
}

/** The can drawn as itself, at the pouch's own icon size. Null when the atlas lacks it. */
function CanFace({ charges, chargesMax }: { charges: number; chargesMax: number }) {
  const source = resolveFrameIcon(canFrame(charges, chargesMax));
  if (source === null) return null;
  const paint = paintIcon(source, POUCH_ICON);
  return (
    <span
      className={cx(s.icon, s.pouchIcon)}
      style={{
        width: POUCH_ICON,
        height: POUCH_ICON,
        backgroundImage: paint.backgroundImage,
        backgroundPosition: paint.backgroundPosition,
        backgroundSize: paint.backgroundSize,
      }}
      aria-hidden="true"
    />
  );
}

/** "can empty — the water is north-west", or the reachable cases of the same sentence. */
function emptyLine(shoreHeading: string): string {
  if (shoreHeading === '') return 'can empty — click the water to refill';
  return `can empty — the water is ${shoreHeading}`;
}

/**
 * The freshness warning, and it is the only thing in the HUD that appears on a chip by itself.
 *
 * SILENT UNTIL IT IS NOT, exactly like the value above it. The pouch is on screen every second of
 * the game and its whole worth is that four short chips can be read without stopping — a clock
 * running on every russet from the moment it is pulled would be four counters ticking in the
 * corner of the eye forever, and the eye stops seeing those in about a day. So nothing is drawn
 * until the stack crosses a display threshold, and then it is a time, in amber, and then red.
 *
 * ONE STACK'S CLOCK, NOT THE CHIP'S. `ticksToSpoil` is the soonest heap in the slot ([[035]]), so
 * "0:40" beside "12 russets" means part of those twelve, not all of them — which is why the bag's
 * pane says "3 of 12" and this does not: a chip has room for a warning, and the panel one keypress
 * away has room for the truth.
 */
function Clock({ item }: { item: PouchItem }) {
  const band = freshnessBand(item.ticksToSpoil);
  if (!isWarning(band)) return null;

  return (
    <span className={cx(s.stackFresh, band === 'going' && s.stackFreshGoing)}>
      <span className={s.stackFreshMark} />
      {formatFreshness(item.ticksToSpoil)}
    </span>
  );
}
