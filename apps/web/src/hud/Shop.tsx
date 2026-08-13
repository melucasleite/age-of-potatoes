'use client';

// The roadside stand — the door into the sim's shop, which has been standing there locked.
//
// WHAT THIS IS FOR. `BuyItemCommand` and `applyBuyItem` have worked since the sim grew a
// stand: the money comes off, the seeds land in the pouch, the trace records it. Nothing in
// `apps/web` ever constructed one, so the only way to buy a seed was to write code. Work item
// 051 puts it plainly — "the criterion is about the player, and the player cannot reach it".
// This file is the handle on that door and nothing more; every rule about what a purchase
// costs and whether it is allowed still lives in the sim.
//
// THREE DECISIONS WORTH KNOWING ABOUT:
//
//   IT IS A BOARD, NOT A SHOP SCREEN. Prices, stock and eligibility are read from
//   `ITEM_SPECS` by `derive-shop.ts`; this file lays them out. An item that becomes
//   `purchasable` in `data.ts` appears here with no edit, which is the acceptance criterion
//   stated as a property rather than as a list of seeds.
//
//   THE COUNTER HAS TO BE MANNED. `applyBuyItem` refuses unless the farmer is within hand
//   reach of the bin, so the buttons are inert away from it and the panel says which way to
//   walk instead of failing silently. That is the papercut [[050]] was filed for; a disabled
//   button that explains itself is the cheapest fix for it.
//
//   NOTHING IS OPTIMISTIC. The button goes inert on click and the world answers at the next
//   publish (`use-pending.ts`). A refused purchase changes nothing, publishes nothing, and
//   the release valve hands the button back — the panel never draws a seed the till has not
//   handed over.

import { useCallback, useEffect } from 'react';

import type { ItemId } from '@snack/sim';

// `formatCents` everywhere and never `formatCentsWhole`: a potato seed lists at fifty cents,
// and the whole-dollar formatter — correct for a $600 sprinkler — renders that as "$0".
import { formatCents } from './format';
import { hudStore } from './store';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import { usePending } from './use-pending';
import type { ShopRow, ShopSlice } from './types';

/** Keeps focus on the canvas — see the long note in `Toolbelt.tsx` for why it is `mousedown`. */
function keepFocus(event: React.MouseEvent): void {
  event.preventDefault();
}

/** The stack button. One is tedious; ten is the fistful the work item asks for. */
const STACK = 10;

// --- the corner button -----------------------------------------------------------------

/**
 * Sits under Research, in the same family and deliberately so: the two things a player spends
 * money on that are not standing on the lot are one above the other in one corner.
 *
 * It lights up gold when the farmer is at the counter, which is the only teaching this rule
 * gets. A player who walks to the bin to sell — which is the whole reason they ever walk to
 * the bin — sees the corner change while they are standing there.
 */
export function ShopToggle({ onOpen }: { onOpen: () => void }) {
  const shop = useHudSlice('shop');
  if (shop.rows.length === 0) return null;

  return (
    <button
      type="button"
      className={cx(s.techToggle, shop.atStand === 1 && s.techToggleReady)}
      title="The roadside stand — seeds and supplies, at list"
      onMouseDown={keepFocus}
      onClick={onOpen}
    >
      <span className={s.techToggleName}>The Stand</span>
      <span className={s.techToggleBadge}>{shop.atStand === 1 ? 'open' : 'seeds · kit'}</span>
      <span className={s.techToggleKey}>G</span>
    </button>
  );
}

// --- the panel -------------------------------------------------------------------------

export function ShopPanel({ onClose }: { onClose: () => void }) {
  const shop = useHudSlice('shop');
  const economy = useHudSlice('economy');
  const pending = usePending();

  const buy = useCallback(
    (item: number, count: number) => {
      pending.hold(`${item}x${count}`);
      // The view carries plain numbers by rule — no enums across the boundary (§12) — so the
      // id widens on the way out and narrows here, exactly as the bench does with a machine kind.
      hudStore.dispatch({ type: 'BuyItem', item: item as ItemId, count });
    },
    [pending],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className={s.scrim}
      onMouseDown={(event) => {
        // Only a click on the scrim ITSELF closes, as in the research panel: a drag that starts
        // on a row and ends on the backdrop must not dismiss the board mid-purchase.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={s.shopPanel} onMouseDown={(event) => event.stopPropagation()}>
        <div className={s.techHead}>
          <span className={s.techTitle}>Roadside Stand</span>
          <span className={s.shopTag}>bought at list</span>
          <span className={s.techMoney}>{formatCents(economy.moneyCents)}</span>
          <button type="button" className={s.techClose} onMouseDown={keepFocus} onClick={onClose}>
            ESC
          </button>
        </div>

        <Counter shop={shop} />

        <div className={s.shopList}>
          {shop.rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              moneyCents={economy.moneyCents}
              atStand={shop.atStand === 1}
              pending={pending.isPending}
              onBuy={buy}
            />
          ))}
        </div>

        <div className={s.techHint}>The stand sells; it does not haggle · G or ESC closes</div>
      </div>
    </div>
  );
}

/**
 * Whether the till is open, and where it is if it is not.
 *
 * Stated before the prices rather than after them. A player who reads the board, picks a
 * thing and finds the button dead has already been let down once; the sentence that would
 * have prevented it has to come first.
 */
function Counter({ shop }: { shop: ShopSlice }) {
  if (shop.standExists === 0) {
    return (
      <div className={cx(s.shopStatus, s.shopStatusShut)}>
        There is no stand on the lot. Nothing to buy from.
      </div>
    );
  }
  if (shop.atStand === 1) {
    return (
      <div className={cx(s.shopStatus, s.shopStatusOpen)}>
        You are at the counter. Everything below is yours for the money.
      </div>
    );
  }
  return (
    <div className={cx(s.shopStatus, s.shopStatusShut)}>
      Nobody buys anything from across the lot — walk to the stand
      {shop.heading === '' ? '' : `, ${shop.heading} of you`}.
    </div>
  );
}

// --- one line on the board ---------------------------------------------------------------

function Row({
  row,
  moneyCents,
  atStand,
  pending,
  onBuy,
}: {
  row: ShopRow;
  moneyCents: number;
  atStand: boolean;
  pending: (key: string) => boolean;
  onBuy: (item: number, count: number) => void;
}) {
  const locked = row.needsTech !== '';
  const shortfall = row.unitPriceCents - moneyCents;

  return (
    <div className={cx(s.shopRow, locked && s.shopRowLocked)}>
      <div className={s.shopRowBody}>
        <div className={s.shopRowHead}>
          <span className={s.shopName}>{row.name}</span>
          <span className={s.shopPrice}>{formatCents(row.unitPriceCents)} each</span>
          {row.owned > 0 ? <span className={s.shopOwned}>{row.owned} in the pouch</span> : null}
        </div>
        {row.note === '' ? null : <div className={s.shopNote}>{row.note}</div>}

        {/*
          Two different reasons a row is dead, and they must not look alike. Locked is about
          the tech tree and never resolves by waiting; short is about money and resolves by
          farming. The colours follow the research panel: a missing prerequisite is the warm
          red, a price you cannot meet is quieter.
        */}
        {locked ? (
          <div className={s.shopLocked}>
            Behind {row.needsTech} — you could buy these, but nothing on the lot can plant them yet.
          </div>
        ) : shortfall > 0 ? (
          <div className={s.shopShort}>{formatCents(shortfall)} short of one.</div>
        ) : null}
      </div>

      <div className={s.shopBuys}>
        <BuyButton
          row={row}
          count={1}
          enabled={atStand && !locked && moneyCents >= row.unitPriceCents}
          pending={pending(`${row.id}x1`)}
          onBuy={onBuy}
        />
        <BuyButton
          row={row}
          count={STACK}
          enabled={atStand && !locked && moneyCents >= row.unitPriceCents * STACK}
          pending={pending(`${row.id}x${STACK}`)}
          onBuy={onBuy}
        />
      </div>
    </div>
  );
}

function BuyButton({
  row,
  count,
  enabled,
  pending,
  onBuy,
}: {
  row: ShopRow;
  count: number;
  enabled: boolean;
  pending: boolean;
  onBuy: (item: number, count: number) => void;
}) {
  const total = row.unitPriceCents * count;
  return (
    <button
      type="button"
      className={cx(s.shopBuy, enabled && !pending && s.shopBuyReady)}
      disabled={!enabled || pending}
      onMouseDown={keepFocus}
      onClick={() => onBuy(row.id, count)}
    >
      <span className={s.shopBuyCount}>×{count}</span>
      <span className={s.shopBuyCost}>{pending ? 'wait…' : formatCents(total)}</span>
    </button>
  );
}
