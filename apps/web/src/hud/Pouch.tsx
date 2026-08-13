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

import { ItemIcon } from './ItemIcon';
import { formatCentsWhole } from './format';
import { formatFreshness, freshnessBand, isWarning } from './freshness';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import type { PouchItem } from './types';

/** Two-times an item frame. The chip strip is always on screen, so it pays rent by the pixel. */
const POUCH_ICON = 32;

export function Pouch() {
  const pouch = useHudSlice('pouch');

  if (pouch.items.length === 0) {
    return (
      <div className={`${s.card} ${s.pouch}`}>
        <span className={s.pouchEmpty}>pockets empty</span>
      </div>
    );
  }

  return (
    <div className={`${s.card} ${s.pouch}`}>
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
