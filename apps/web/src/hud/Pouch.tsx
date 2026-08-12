'use client';

// What you are carrying, and what it is worth if you walk it to the bin.
//
// The value is the interesting half. "12 russets" is a number; "12 russets · $24" is the
// reason to walk to the sell bin, and it is also the first place a player notices that a
// bag of chips is worth ten russets — which is the entire argument for the Chip Kitchen,
// made without a tutorial saying so.

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
            <span className={s.stackValue}>{formatCentsWhole(item.valueCents)}</span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}
