'use client';

// The Dispatch row and window ([[150]]) — carts and standing contracts, out of the dock.
//
// ─────────────────────────────────────────────────────────────────────────────────────
//  THE RULING. Owner, 2026-08-27: "Remove shifts, and diagnostics. Make dispatch it's own
//  menu under build." The first half emptied the reports dock down to Bests and Ranks;
//  this is the second half. Dispatch was the one dock tab that was not a REPORT at all —
//  every button on it enqueues a `Command` — so it never belonged beside two read-only
//  ledgers, and it moves in with the panels that spend money: a `PanelRow` in the sidebar,
//  directly under Build, over a `PanelWindow` in the shared `.floatWin`.
// ─────────────────────────────────────────────────────────────────────────────────────
//
// THE BODY DID NOT MOVE, AND THAT IS THE DESIGN. `reports/CommercePanel.tsx` keeps its
// file, its store wiring (`reportsStore` → bridge → the GameHost queue) and its whole
// interior; what it lost is its dock-rail chrome, because the window head and footer are
// `PanelWindow`'s job now. This file is only the two shells every panel gets — which is
// exactly the bar `PanelFrame.tsx` set for a new row: props and no markup.
//
// THE ROW READS THE REPORTS STORE, NOT THE HUD STORE, and that is honest rather than lazy:
// carts and contracts are projected into `reportsStore` (`view.commerce`) and nowhere else,
// and copying the counts into `hud/store.ts` so this file could avoid one import would be a
// second source of truth for two integers. The subscription is slice-scoped like every
// other row's, so the badge re-renders only when commerce itself moves.

import { formatCents } from './format';
import { PanelRow, PanelWindow } from './PanelFrame';
import { s } from './styles';

import { CommercePanel } from '../reports/CommercePanel';
import { useReportsSlice } from '../reports/use-reports';

/**
 * The sixth gameplay row, under Build ([[150]]) — Build sells the cart and the depot,
 * and this is where they report for duty, so the two rows sit together on purpose.
 *
 * IT NEVER LIGHTS FOR "SOMETHING IS WAITING", like the zones row and for the zones row's
 * reason: a signed route is not an errand — the entire point of a standing contract is
 * that it stops being one.
 */
export function DispatchToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const commerce = useReportsSlice('commerce');
  const carts = commerce.carts.length;
  const routes = commerce.contracts.length;

  return (
    <PanelRow
      name="Dispatch"
      badge={
        routes > 0
          ? `${routes} ${routes === 1 ? 'route' : 'routes'}`
          : carts > 0
            ? `${carts} ${carts === 1 ? 'cart' : 'carts'}`
            : 'carts · routes'
      }
      hotkey="P"
      title="Dispatch — load delivery carts and sign standing routes that ship on their own · P"
      frame="ui_menu_dispatch"
      open={open}
      onToggle={onToggle}
    />
  );
}

/**
 * The window: `PanelWindow` chrome around the unmoved `CommercePanel`. The tag carries what
 * the old dock head's sub-line said — lifetime gross once anything has shipped, the posted-
 * prices promise until then — because the head is the shared frame's now and the fact was
 * worth keeping.
 */
export function DispatchWindow({ onClose }: { onClose: () => void }) {
  const commerce = useReportsSlice('commerce');

  return (
    <PanelWindow
      title="Dispatch"
      tag={
        commerce.automatedGrossCents > 0
          ? `${formatCents(commerce.automatedGrossCents)} shipped`
          : 'prices posted'
      }
      hint="Carts leave when you say · contracts ship on their own · P or ESC closes"
      onClose={onClose}
    >
      <div className={s.winScroll}>
        <CommercePanel />
      </div>
    </PanelWindow>
  );
}
