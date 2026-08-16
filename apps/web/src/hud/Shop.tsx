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
//   THE COUNTER HAS TO BE MANNED — AND THE BUTTON NOW WALKS YOU THERE. `applyBuyItem` still
//   refuses unless the farmer is within hand reach of the bin. What changed is that the sim
//   grew `IntentAction.Buy` ([[054]]), so a purchase made from across the lot is issued as a
//   `WalkAndAct` errand: the farmer walks over and the till fires on arrival. The disabled
//   button that explained itself was the cheapest fix for [[050]]; an errand is the real one,
//   and it is the same grammar a click on a distant tile has always used. The panel still says
//   which way the stand is, because a player who presses buy and starts moving is entitled to
//   know why.
//
//   NOTHING IS OPTIMISTIC. The button goes inert on click and the world answers at the next
//   publish (`use-pending.ts`). A refused purchase changes nothing, publishes nothing, and
//   the release valve hands the button back — the panel never draws a seed the till has not
//   handed over.

import { useCallback, useEffect } from 'react';

import { IntentAction } from '@snack/sim';
import type { ItemId } from '@snack/sim';

// `formatCents` everywhere and never `formatCentsWhole`: a potato seed lists at fifty cents,
// and the whole-dollar formatter — correct for a $600 sprinkler — renders that as "$0".
import { ItemIcon } from './ItemIcon';
import { formatCents } from './format';
import { hudStore } from './store';
import { keepFocus, PanelRow, PanelWindow } from './PanelFrame';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import { usePending } from './use-pending';
import type { ShopRow, ShopSlice } from './types';

/** The stack button. One is tedious; ten is the fistful the work item asks for. */
const STACK = 10;

/** Half the bag's slot sprite. A row is read left to right, not scanned, so it needs less. */
const SHOP_ICON = 32;

// --- the corner button -----------------------------------------------------------------

/**
 * Sits under Research, in the same family and deliberately so: the two things a player spends
 * money on that are not standing on the lot are one above the other in one corner.
 *
 * It lights up gold when the farmer is at the counter, which is the only teaching this rule
 * gets. A player who walks to the bin to sell — which is the whole reason they ever walk to
 * the bin — sees the corner change while they are standing there.
 */
/**
 * One of the four ([[093]]).
 *
 * THE BADGE STOPPED SAYING "OPEN" ABOUT THE TILL. It used to: standing at the counter lit the
 * row and printed `open`, which was fine while this row was the only one that lit — and became
 * a lie the moment all four rows agreed that `open` means "this window is on screen". The fact
 * is worth keeping, so it kept both halves it deserves: the row still LIGHTS when the counter
 * is in reach, and the badge says so in words that cannot be misread.
 */
export function ShopToggle({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  const shop = useHudSlice('shop');
  if (shop.rows.length === 0) return null;

  return (
    <PanelRow
      name="The Stand"
      badge={shop.atStand === 1 ? 'at counter' : 'seeds · kit'}
      hotkey="G"
      title="The roadside stand — seeds and supplies, at list"
      open={open}
      lit={shop.atStand === 1}
      onToggle={onOpen}
    />
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
      if (shop.atStand === 1) {
        hudStore.dispatch({ type: 'BuyItem', item: item as ItemId, count });
        return;
      }
      // Out of reach: one errand, not a direct command the till would refuse. The sim walks the
      // farmer over the next hundred-odd ticks and fires `BuyItem` on arrival — and it costs one
      // trace entry, which is the whole argument for `WalkAndAct` existing (see `commands.ts`).
      // The target is the stand's tile; `intentTargetSubtiles` re-resolves the machine from it
      // every tick, so a stand that gets moved mid-walk ends the errand instead of misdirecting.
      hudStore.dispatch({
        type: 'WalkAndAct',
        action: IntentAction.Buy,
        tileX: shop.standTileX,
        tileY: shop.standTileY,
        item,
        count,
      });
    },
    [pending, shop.atStand, shop.standTileX, shop.standTileY],
  );

  // Escape closes — `PanelWindow`'s listener now ([[093]]), not a fourth private copy.

  // A CENTRED FLOATING WINDOW SINCE [[093]] — the board left the sidebar's slot to sit with
  // the other three, and `.shopPanel` went with it: it was `.winPanel` byte for byte, kept
  // apart only so the two could be sized differently, and they no longer are. Still no scrim
  // ([[069]]): the lot — and the stand itself — stay visible and clickable around the window,
  // and closing is the ESC key or the button. The old argument for keeping this board NARROW
  // survives the move intact and is now the shell's: `.floatWin` caps at 460px rather than
  // filling the canvas, so a list of five things with a price each never makes the eye travel
  // the width of the screen between a name and the button that buys it.
  return (
    // TITLED "THE STAND", THE SAME WORDS ITS ROW USES ([[093]]). It said "Roadside Stand"
    // while the row said "THE STAND" — the only one of the four whose window answered to a
    // different name than the button that opens it, which is a small thing until you have
    // four of them side by side and one of them renames itself when you click it. It also
    // happened to be the longest title of the four, and it was eating its own sub-label:
    // "bought at list" ellipsized at 460px and now has 17px to spare.
    <PanelWindow
      title="The Stand"
      tag="bought at list"
      moneyCents={economy.moneyCents}
      hint="The stand sells; it does not haggle · G or ESC closes"
      onClose={onClose}
    >
      <Counter shop={shop} />

      <div className={s.shopList}>
        {shop.rows.map((row) => (
          <Row
            key={row.id}
            row={row}
            moneyCents={economy.moneyCents}
            open={shop.standExists === 1}
            walks={shop.atStand === 0}
            pending={pending.isPending}
            onBuy={buy}
          />
        ))}
      </div>
    </PanelWindow>
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
      The counter is {shop.heading === '' ? 'across the lot' : `${shop.heading} of you`} — buying
      from here sends you walking, and the money changes hands when you arrive.
    </div>
  );
}

// --- one line on the board ---------------------------------------------------------------

function Row({
  row,
  moneyCents,
  open,
  walks,
  pending,
  onBuy,
}: {
  row: ShopRow;
  moneyCents: number;
  /** There is a stand on the lot. Without one there is nothing to buy from and nowhere to walk. */
  open: boolean;
  /** Pressing buy will send the farmer walking rather than take the money now. */
  walks: boolean;
  pending: (key: string) => boolean;
  onBuy: (item: number, count: number) => void;
}) {
  const locked = row.needsTech !== '';
  const shortfall = row.unitPriceCents - moneyCents;

  return (
    <div className={cx(s.shopRow, locked && s.shopRowLocked)}>
      {/*
        The same sprite the bag draws, at half the size ([[058]]). A garnish here rather than a
        rework: the board's rows are already legible, and what the picture buys is that a seed
        bought from this list and a seed found in the pouch are recognisably the same object.
        `ItemIcon` handles a seed the atlas has no frame for, which is most of them.
      */}
      <ItemIcon item={row.id} size={SHOP_ICON} />

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
          enabled={open && !locked && moneyCents >= row.unitPriceCents}
          walks={walks}
          pending={pending(`${row.id}x1`)}
          onBuy={onBuy}
        />
        <BuyButton
          row={row}
          count={STACK}
          enabled={open && !locked && moneyCents >= row.unitPriceCents * STACK}
          walks={walks}
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
  walks,
  pending,
  onBuy,
}: {
  row: ShopRow;
  count: number;
  enabled: boolean;
  walks: boolean;
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
      {/*
        "walk" rather than the price when the purchase is an errand — the price has not changed
        and is on the row above, but what the button DOES has, and a button that reads $5.00
        while the farmer sets off across the lot is describing a transaction that has not
        happened yet. The pending hold is short by design: the errand outlives it, and a button
        held inert for a fifteen-second walk would look broken.
      */}
      <span className={s.shopBuyCost}>
        {pending ? 'wait…' : walks ? 'walk' : formatCents(total)}
      </span>
    </button>
  );
}
