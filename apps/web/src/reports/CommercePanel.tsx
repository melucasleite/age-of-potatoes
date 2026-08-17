'use client';

// Dispatch: the delivery cart, the truck depot, and standing contracts.
//
// THIS IS THE MISSING RUNG OF THE LADDER. Plan §3's three tiers run manual → assisted →
// automated for every system in the game, and selling is the one column where only the first
// rung exists: a finished line accumulates bags in the Bagger and the player carries them to
// the roadside bin by hand. That is correct for the manual tier and it stays correct forever
// (§1: "manual never rots" — the sell bin was a gift at world creation and it never becomes a
// penalty). What was missing is everything above it:
//
//   Manual     carry to the roadside stand          — exists, unchanged, free
//   Assisted   load a cart by hand, dispatch it     — this panel's top half
//   Automated  belt-fed depot on standing contracts — this panel's bottom half
//
// A CONTRACT IS A LOGISTICS OBJECT AND NEVER A PRICE. Plan §8 cuts fluctuating market prices
// forever and locked decision 3 fixes prices as "stable and posted", so this panel chooses
// WHAT to ship and HOW MUCH per run — never what it is worth, never a bonus, never a
// negotiation. The run value shown beside each contract is arithmetic on the posted list
// price, displayed so the player can plan, and there is no control anywhere on this panel
// that could change it. There is likewise no counterparty who is another player: §8 cuts
// player-to-player trading forever because it re-imports market dynamics through the back
// door, and destination names are flavour on a truck door.
//
// THE SIM HALF IS NOT HERE YET, AND THIS PANEL SAYS SO IN DETAIL. Work item 032's simulation
// side has not landed. Rather than hide, the panel renders its full shape and lists exactly
// what is missing — plan §8's standing rule is "fake the far side of every interface, stubs
// listed explicitly". The moment `view.commerce` appears in the projection and a host
// attaches a command sink, every control below becomes live with no change to this file. See
// `sim-contract.ts` for the four `Command` variants and the one `WorldView` field.
//
// EVERY BUTTON ENQUEUES A COMMAND AND NOTHING ELSE. Plan §12: every state mutation goes
// through a `Command` applied at a specific tick. This panel never touches `WorldState`, has
// no debug path, and disables its own controls when there is nowhere to send a command —
// because a button that looks live and does nothing is worse than one that admits it.

import { useState } from 'react';

import { formatCents, formatTicks } from './format';
import { r, cx } from './styles';
import { destinationFor, reportsStore } from './store';
import type { CartRow, CommerceSlice, ContractRow, DepotRow } from './types';
import { useReportsSlice } from './use-reports';

/** Quantities a route can be written for. Round numbers; the player is not doing algebra. */
const RUN_SIZES = [10, 25, 50, 100];

export function CommercePanel() {
  const commerce = useReportsSlice('commerce');
  const live = commerce.installed === 1 && commerce.wired === 1;

  const [item, setItem] = useState(0);
  const [quantity, setQuantity] = useState(25);
  const [depotId, setDepotId] = useState(0);

  const chosenItem = item !== 0 ? item : (commerce.sellable[0]?.item ?? 0);

  // ────────────────────────────────────────────────────────────────────────────────────
  //  WHICH DEPOT, AND WHY THIS DEFAULT.
  //
  //  This used to be `commerce.depots[0]`, full stop, so a SECOND depot could never be given
  //  a route: its tell said "click to sign a contract" forever while every signature landed on
  //  the first one. The first depot worked only because it happened to be index zero.
  //
  //  The default is now the first depot with NO routes on it, falling back to the first depot
  //  at all. That is the one the player is almost certainly looking at — an unrouted depot is
  //  the only one whose tell is asking to be clicked — and it means the common case (build a
  //  depot, sign a route) still takes zero interactions with the picker.
  // ────────────────────────────────────────────────────────────────────────────────────
  const fallbackDepot =
    commerce.depots.find((d) => d.contractIds.length === 0) ?? commerce.depots[0];
  const chosenDepot = commerce.depots.find((d) => d.id === depotId) ?? fallbackDepot;

  return (
    <div className={cx(r.card, r.panel)}>
      <div className={r.head}>
        <span className={r.label}>Dispatch</span>
        <span className={r.sub}>
          {commerce.automatedGrossCents > 0
            ? `${formatCents(commerce.automatedGrossCents)} shipped`
            : 'prices posted'}
        </span>
      </div>
      <div className={r.rule} />

      {/* --- the assisted rung ------------------------------------------------------- */}

      <span className={r.label}>Delivery carts</span>
      {commerce.carts.length === 0 ? (
        <p className={r.stubNote}>
          A cart is loaded by hand and leaves when you say so. It is the rung between walking bags
          to the bin yourself and never thinking about it again.
        </p>
      ) : (
        commerce.carts.map((cart) => (
          <Cart key={cart.id} cart={cart} item={chosenItem} live={live} />
        ))
      )}

      <div className={r.rule} />

      {/* --- the automated rung ------------------------------------------------------ */}

      <span className={r.label}>Standing contracts</span>
      {commerce.contracts.length === 0 ? (
        <p className={r.stubNote}>
          A depot takes goods off a belt and ships them under a route you set once. No player
          action, ever again — which is the point, and what the Hands-Free board measures.
        </p>
      ) : (
        commerce.contracts.map((contract) => (
          <Contract key={contract.id} contract={contract} live={live} />
        ))
      )}

      <NewContract
        commerce={commerce}
        item={chosenItem}
        quantity={quantity}
        depot={chosenDepot}
        onItem={setItem}
        onQuantity={setQuantity}
        onDepot={setDepotId}
        live={live}
      />

      {commerce.installed === 0 ? <Pending wired={commerce.wired === 1} /> : null}
    </div>
  );
}

/**
 * One cart. Loading counts a `handCarry` touch and dispatching counts another — this is the
 * ASSISTED rung, so it is still hands, just fewer of them. The Hands-Free board is
 * unadjudicable if that ever leaks, which is why it is stated here as well as in the sim.
 */
function Cart({ cart, item, live }: { cart: CartRow; item: number; live: boolean }) {
  const away = cart.away === 1;
  const progress = away
    ? cart.runTicks <= 0
      ? 0
      : Math.round(((cart.runTicks - cart.ticksRemaining) / cart.runTicks) * 100)
    : cart.capacity <= 0
      ? 0
      : Math.round((cart.loaded / cart.capacity) * 100);

  return (
    <div className={r.commerceRow}>
      <div className={r.commerceHead}>
        <span className={r.commerceName}>{cart.label}</span>
        <span className={r.commerceMeta}>
          {away
            ? `on the road · back in ${formatTicks(cart.ticksRemaining)}`
            : `${cart.loaded}/${cart.capacity} · ${formatCents(cart.valueCents)}`}
        </span>
      </div>

      <div className={r.track}>
        <div
          className={cx(
            r.fill,
            away && r.fillAway,
            !away && cart.loaded >= cart.capacity && r.fillReady,
          )}
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className={r.actions}>
        <button
          type="button"
          className={r.button}
          disabled={!live || away || cart.loaded >= cart.capacity || item === 0}
          onClick={() => {
            reportsStore.submit({
              type: 'LoadCart',
              cartId: cart.id,
              item,
              count: cart.capacity - cart.loaded,
            });
          }}
        >
          Load
        </button>
        <button
          type="button"
          className={cx(r.button, cart.loaded > 0 && !away && r.buttonPrimary)}
          disabled={!live || away || cart.loaded === 0}
          onClick={() => {
            reportsStore.submit({ type: 'DispatchCart', cartId: cart.id });
          }}
        >
          Dispatch
        </button>
      </div>
    </div>
  );
}

const PHASE_LABELS = ['waiting on stock', 'loading', 'on the road'];

function Contract({ contract, live }: { contract: ContractRow; live: boolean }) {
  const stockPercent =
    contract.quantityPerRun <= 0
      ? 0
      : Math.min(100, Math.round((contract.stocked / contract.quantityPerRun) * 100));
  const rolling = contract.phase === 2;

  return (
    <div className={r.commerceRow}>
      <div className={r.commerceHead}>
        <span className={r.commerceName}>
          {contract.itemLabel} ×{contract.quantityPerRun}
        </span>
        {/*
          The run's value at posted list. DISPLAYED, never chosen — there is no control on
          this panel that can change it, because prices are stable and posted (§8).
        */}
        <span className={r.commerceMeta}>{formatCents(contract.runValueCents)}/run</span>
      </div>

      <div className={r.commerceHead}>
        <span className={r.commerceMeta}>→ {contract.destination}</span>
        <span className={r.commerceMeta}>
          {rolling
            ? `arriving in ${formatTicks(contract.ticksRemaining)}`
            : `${contract.stocked}/${contract.quantityPerRun} · ${PHASE_LABELS[contract.phase] ?? ''}`}
        </span>
      </div>

      <div className={r.track}>
        <div
          className={cx(
            r.fill,
            rolling && r.fillAway,
            stockPercent >= 100 && !rolling && r.fillReady,
          )}
          style={{ width: `${rolling ? 100 : stockPercent}%` }}
        />
      </div>

      <div className={r.commerceHead}>
        <span className={r.commerceMeta}>
          {contract.runsCompleted} {contract.runsCompleted === 1 ? 'run' : 'runs'} ·{' '}
          {formatCents(contract.grossCents)}
        </span>
        {/* Cancelling is free, always. A route you regret is not a fine. */}
        <button
          type="button"
          className={r.button}
          disabled={!live}
          onClick={() => {
            reportsStore.submit({ type: 'CancelContract', contractId: contract.id });
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function NewContract({
  commerce,
  item,
  quantity,
  depot,
  onItem,
  onQuantity,
  onDepot,
  live,
}: {
  commerce: CommerceSlice;
  item: number;
  quantity: number;
  depot: DepotRow | undefined;
  onItem: (item: number) => void;
  onQuantity: (quantity: number) => void;
  onDepot: (depotId: number) => void;
  live: boolean;
}) {
  const priced = commerce.sellable.find((entry) => entry.item === item);
  const runValue = priced === undefined ? 0 : priced.priceCents * quantity;

  return (
    <div className={r.commerceRow}>
      <div className={r.actions}>
        {/* Only when there is a choice to make. One depot needs no picker, and a select with
            a single option is furniture that teaches the player nothing. */}
        {commerce.depots.length > 1 ? (
          <select
            className={r.select}
            value={depot?.id ?? 0}
            onChange={(event) => {
              onDepot(Number(event.target.value));
            }}
            aria-label="Depot to ship from"
          >
            {commerce.depots.map((row) => (
              <option key={row.id} value={row.id}>
                {row.label}
                {row.contractIds.length === 0
                  ? ' — no routes'
                  : row.contractIds.length === 1
                    ? ' — 1 route'
                    : ` — ${String(row.contractIds.length)} routes`}
              </option>
            ))}
          </select>
        ) : null}

        <select
          className={r.select}
          value={item}
          disabled={commerce.sellable.length === 0}
          onChange={(event) => {
            onItem(Number(event.target.value));
          }}
          aria-label="Product to ship"
        >
          {commerce.sellable.length === 0 ? (
            <option value={0}>nothing to ship yet</option>
          ) : (
            commerce.sellable.map((entry) => (
              <option key={entry.item} value={entry.item}>
                {entry.label}
              </option>
            ))
          )}
        </select>

        <select
          className={r.select}
          value={quantity}
          onChange={(event) => {
            onQuantity(Number(event.target.value));
          }}
          aria-label="Quantity per run"
        >
          {RUN_SIZES.map((size) => (
            <option key={size} value={size}>
              ×{size}
            </option>
          ))}
        </select>

        <button
          type="button"
          className={cx(r.button, live && depot !== undefined && r.buttonPrimary)}
          disabled={!live || depot === undefined || item === 0}
          onClick={() => {
            if (depot === undefined) return;
            reportsStore.submit({
              type: 'CreateContract',
              depotId: depot.id,
              item,
              quantityPerRun: quantity,
              destination: destinationFor(commerce.contracts.length),
            });
          }}
        >
          Sign route
        </button>
      </div>

      {runValue > 0 ? (
        <span className={r.commerceMeta}>
          {formatCents(runValue)} a run, at the posted price. It is the same price at the bin, on a
          cart, and on a truck.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The explicit stub.
 *
 * It names the four commands and the one projection field rather than saying "coming soon",
 * because plan §8 asks for stubs to be LISTED and because the next person to read this is
 * likelier to be the agent implementing them than a player.
 */
function Pending({ wired }: { wired: boolean }) {
  return (
    <div className={r.pending}>
      <span className={r.pendingTitle}>Not installed yet</span>
      The cart and the depot are built here and waiting on their simulation half. Selling by hand at
      the roadside bin works exactly as it always has, and always will.
      <ul className={r.pendingList}>
        <li>
          <code>WorldView.commerce</code> — carts, depots, contracts, runs in ticks
        </li>
        <li>
          <code>LoadCart</code>, <code>DispatchCart</code> — assisted, one hand-carry touch each
        </li>
        <li>
          <code>CreateContract</code>, <code>CancelContract</code> — automated, no touch at all
        </li>
        <li>{wired ? 'command sink attached' : 'command sink not attached'}</li>
      </ul>
    </div>
  );
}
