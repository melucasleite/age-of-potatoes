'use client';

// The bag — everything the player is carrying, and the two things you can do to a boxed machine.
//
// WHY IT EXISTS AT ALL. `WorldState.inventory` has been real since the first commit, and the
// only window onto it was the pouch: a strip of chips along the bottom edge that shows a count
// and a value and has room for nothing else. That was survivable while the bag held seeds and
// russets. It stopped being survivable the moment a machine could go INTO the bag ([[054]]) —
// a boxed Fryer has three dial levels, a condition, an invoice and a scrap price, and none of
// that fits on a chip. So this is the pouch's long form, not a second inventory.
//
// FOUR THINGS IT REFUSES TO DO, each of which would have been shorter to write:
//
//   IT DOES NOT PRICE ANYTHING. Every figure on a box comes off the view — `investedCents` and
//   `scrapCents` are the sim's own arithmetic, and `SellBoxedMachine` pays exactly the number
//   printed on the button. The forty-percent ratio is not in this file, not in `types.ts`, and
//   not in `derive-inventory.ts`. See the tombstone at the end of `derive-tech.ts` for what the
//   alternative cost last time.
//
//   IT DOES NOT PICK WHICH BOX. `PlaceMachine` puts down the plainest box you own and
//   `SellBoxedMachine` scraps the plainest box you own — one rule, decided in the sim, and
//   neither command takes an index. A panel with a button per box would be offering the player
//   a choice the world does not implement, so the row has ONE pair of buttons and the list
//   underneath says which box they act on. The consequence is worth stating out loud, because it
//   is a kindness: THE MACHINE YOU SPENT MONEY ON IS THE LAST ONE YOU CAN LOSE BY ACCIDENT.
//
//   IT DOES NOT SELL GOODS. The bin takes goods, standing at the bin, at list ([[051]]); boxes
//   are paperwork and sell from here. Two verbs, two places, and collapsing them into one list
//   of sell buttons would teach the player that the walk to the stand is optional.
//
//   IT DOES NOT PLACE ANYTHING ITSELF. "Place" arms the build cursor and closes the panel; the
//   machine goes down where the player clicks. Placement is a gesture on the world, and a panel
//   that put a Fryer down for you would have to invent a tile to put it on.

import { useCallback, useEffect } from 'react';

import { CONDITION_EFFECT_THRESHOLD, CONDITION_MAX, UPGRADE_MAX_LEVEL, permille } from '@snack/sim';
import type { ItemId } from '@snack/sim';

import type { ToolMode } from '@/game/input/tools';

import { formatCents } from './format';
import { hudStore } from './store';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import { usePending } from './use-pending';
import type { InventoryBox, InventoryRow } from './types';

/** Where a condition bar turns red. The bench's constant, derived the same way and for the same
 * reason: condition and permille happen to share a scale today, and a panel that assumed it
 * would start lying silently the day somebody rescaled one of them. */
const ROUGH_PERMILLE = permille(CONDITION_EFFECT_THRESHOLD, CONDITION_MAX);

/** Keeps focus on the canvas — see the long note in `Toolbelt.tsx` for why it is `mousedown`. */
function keepFocus(event: React.MouseEvent): void {
  event.preventDefault();
}

// --- the corner button -----------------------------------------------------------------

/**
 * Third in the top-left column, under Research and the Stand.
 *
 * It lights up when there is a boxed machine in the bag, which is the only teaching the feature
 * gets: a player who boxes their first Fryer sees a corner of the screen change while they are
 * still standing where the Fryer was.
 */
export function InventoryToggle({ onOpen }: { onOpen: () => void }) {
  const inventory = useHudSlice('inventory');
  const boxed = inventory.boxCount;

  return (
    <button
      type="button"
      className={cx(s.techToggle, boxed > 0 && s.techToggleReady)}
      title="The bag — goods, seeds, and machines you have boxed up"
      onMouseDown={keepFocus}
      onClick={onOpen}
    >
      <span className={s.techToggleName}>The Bag</span>
      <span className={s.techToggleBadge}>
        {boxed > 0
          ? `${boxed} boxed`
          : inventory.rows.length === 0
            ? 'empty'
            : `${inventory.rows.length} ${inventory.rows.length === 1 ? 'kind' : 'kinds'}`}
      </span>
      <span className={s.techToggleKey}>I</span>
    </button>
  );
}

// --- the panel -------------------------------------------------------------------------

export function InventoryPanel({ onClose }: { onClose: () => void }) {
  const inventory = useHudSlice('inventory');
  const economy = useHudSlice('economy');
  const pending = usePending();

  const scrap = useCallback(
    (item: number) => {
      pending.hold(`scrap:${item}`);
      // The view carries plain numbers by rule — no enums across the boundary (§12) — so the id
      // widens on the way out and narrows here, exactly as the stand does with a purchase.
      hudStore.dispatch({ type: 'SellBoxedMachine', item: item as ItemId });
    },
    [pending],
  );

  // Arming a cursor is UI state and never a command (§12), so this goes out through
  // `selectTool` rather than `dispatch`. Closing afterwards is not a flourish: the panel is a
  // full-screen scrim, and a build cursor you cannot see the lot through is not armed, it is
  // stuck.
  const place = useCallback(
    (tool: number) => {
      hudStore.selectTool(tool as ToolMode);
      onClose();
    },
    [onClose],
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
        // Only a click on the scrim ITSELF closes, as in the other two panels: a drag that
        // starts on a row and ends on the backdrop must not dismiss the bag mid-scrap.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={s.shopPanel} onMouseDown={(event) => event.stopPropagation()}>
        <div className={s.techHead}>
          <span className={s.techTitle}>The Bag</span>
          <span className={s.shopTag}>everything you are carrying</span>
          <span className={s.techMoney}>{formatCents(economy.moneyCents)}</span>
          <button type="button" className={s.techClose} onMouseDown={keepFocus} onClick={onClose}>
            ESC
          </button>
        </div>

        <div
          className={cx(s.shopStatus, inventory.boxCount > 0 ? s.shopStatusOpen : s.shopStatusShut)}
        >
          {inventory.boxCount > 0
            ? `${inventory.boxCount} boxed ${inventory.boxCount === 1 ? 'machine' : 'machines'} — ${formatCents(inventory.scrapCents)} if you scrapped every one of them.`
            : 'Nothing boxed. A machine you take apart comes here whole, with its dials, and goes back down for free.'}
        </div>

        <div className={s.shopList}>
          {inventory.rows.length === 0 ? (
            <div className={s.invEmpty}>Your pockets are empty.</div>
          ) : (
            inventory.rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                pending={pending.isPending(`scrap:${row.id}`)}
                onScrap={scrap}
                onPlace={place}
              />
            ))
          )}
        </div>

        <div className={s.techHint}>
          A box keeps its dials and its wear · placing one costs nothing · I or ESC closes
        </div>
      </div>
    </div>
  );
}

// --- one line in the bag -----------------------------------------------------------------

function Row({
  row,
  pending,
  onScrap,
  onPlace,
}: {
  row: InventoryRow;
  pending: boolean;
  onScrap: (item: number) => void;
  onPlace: (tool: number) => void;
}) {
  if (row.boxedKind === 0) return <GoodsRow row={row} />;
  return <BoxedRow row={row} pending={pending} onScrap={onScrap} onPlace={onPlace} />;
}

/**
 * A stack of goods.
 *
 * The value is dropped rather than zeroed when the bin refuses the stack, the same call
 * `Pouch.tsx` makes and for the same reason: "8 seeds · $4" is a price for a transaction that
 * cannot happen, sitting two rows above prices that can.
 */
function GoodsRow({ row }: { row: InventoryRow }) {
  return (
    <div className={s.shopRow}>
      <div className={s.shopRowBody}>
        <div className={s.shopRowHead}>
          <span className={s.shopName}>{row.name}</span>
          <span className={s.invCount}>×{row.count}</span>
          {row.sellable === 1 ? (
            <span className={s.shopPrice}>{formatCents(row.stackValueCents)} at the bin</span>
          ) : (
            <span className={s.invNotForSale}>the bin does not take these</span>
          )}
        </div>
      </div>
    </div>
  );
}

function BoxedRow({
  row,
  pending,
  onScrap,
  onPlace,
}: {
  row: InventoryRow;
  pending: boolean;
  onScrap: (item: number) => void;
  onPlace: (tool: number) => void;
}) {
  const next = row.boxes[0];
  const placeable = row.placeTool >= 0;

  return (
    <div className={cx(s.shopRow, s.invBoxedRow)}>
      <div className={s.shopRowBody}>
        <div className={s.shopRowHead}>
          <span className={s.shopName}>{row.name}</span>
          <span className={s.invBoxedTag}>boxed</span>
          <span className={s.invCount}>×{row.count}</span>
        </div>

        <div className={s.invBoxes}>
          {row.boxes.map((box) => (
            <Box key={box.index} box={box} showNextOut={row.boxes.length > 1} />
          ))}
        </div>

        {placeable ? null : (
          // Honest rather than hopeful: twenty machine kinds can be boxed and only some of them
          // have a build cursor in the UI yet, so the row says which situation this is instead
          // of arming a tool that would put down the wrong machine.
          <div className={s.shopLocked}>
            Nothing in the build menu places one of these yet — it is safe in the bag, and it still
            scraps.
          </div>
        )}
      </div>

      <div className={s.shopBuys}>
        <button
          type="button"
          className={cx(s.shopBuy, placeable && s.shopBuyReady)}
          disabled={!placeable}
          onMouseDown={keepFocus}
          onClick={() => onPlace(row.placeTool)}
        >
          <span className={s.shopBuyCount}>Place</span>
          <span className={s.shopBuyCost}>free</span>
        </button>
        <button
          type="button"
          className={s.shopBuy}
          disabled={pending || next === undefined}
          onMouseDown={keepFocus}
          onClick={() => onScrap(row.id)}
        >
          <span className={s.shopBuyCount}>Scrap</span>
          <span className={s.shopBuyCost}>
            {pending ? 'wait…' : formatCents(next?.scrapCents ?? 0)}
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * One box, with what is inside it.
 *
 * `showNextOut` only when there is more than one, because "next out" is an answer to a question
 * a single box does not raise — and a badge that is always there is a badge nobody reads on the
 * day it matters.
 */
function Box({ box, showNextOut }: { box: InventoryBox; showNextOut: boolean }) {
  const conditionPercent = Math.round(box.conditionPermille / 10);
  const rough = box.conditionPermille < ROUGH_PERMILLE;

  return (
    <div className={s.invBox}>
      {showNextOut && box.index === 0 ? <span className={s.invNextOut}>next out</span> : null}
      <Dial letter="S" level={box.speedLevel} />
      <Dial letter="E" level={box.efficiencyLevel} />
      <Dial letter="C" level={box.capacityLevel} />
      <span className={cx(s.invCondition, rough && s.invConditionLow)}>{conditionPercent}%</span>
      <span className={s.invInvested}>{formatCents(box.investedCents)} in</span>
      <span className={s.invScrap}>{formatCents(box.scrapCents)} scrap</span>
    </div>
  );
}

/** Speed, Efficiency, Capacity — as pips, the same ones the bench draws. */
function Dial({ letter, level }: { letter: string; level: number }) {
  const pips: number[] = [];
  for (let i = 0; i < UPGRADE_MAX_LEVEL; i++) pips.push(i);

  return (
    <span className={s.invDial} title={`${letter} — level ${level} of ${UPGRADE_MAX_LEVEL}`}>
      <span className={s.invDialKey}>{letter}</span>
      <span className={s.pips}>
        {pips.map((i) => (
          <span key={i} className={cx(s.pip, i < level && s.pipOn)} />
        ))}
      </span>
    </span>
  );
}
