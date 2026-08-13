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

import { Fragment } from 'react';

import { formatCentsWhole } from './format';
import { s } from './styles';
import { useHudSlice } from './use-hud';

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
            <span className={s.stackCount}>{item.count}</span>
            <span className={s.stackLabel}>{item.label}</span>
            {item.sellable === 1 ? (
              <span className={s.stackValue}>{formatCentsWhole(item.valueCents)}</span>
            ) : null}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
