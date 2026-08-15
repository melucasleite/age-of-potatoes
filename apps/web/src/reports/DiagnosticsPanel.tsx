'use client';

// The diagnostics panel: work item 039's ranked list of bleeding machines, in cash.
//
// WHAT THIS PANEL IS FOR. The maintenance chain automates the WORK of repair; this list is
// how the player aims it. §5's readability rule sets the voice — money, phrased in cash,
// per machine — and item 039 sets the form: "a ranked list of bleeding machines, not a
// dashboard of graphs". So each row is a name and a dollar figure and nothing else. No
// sparkline, no percentage, no history. The panel answers exactly one question — "where is
// my money going right now?" — and the moment it answers more it has become the dashboard
// the item forbids.
//
// LOCKED, IT STAYS VISIBLE AND SAYS WHY — same argument as a locked build-menu row: a tab
// that vanishes until researched is a feature the player never learns exists. The locked
// state names the node in the same "needs X" voice `buildRows()` uses.
//
// The ranking itself lives in `diagnostics.ts`, derived in the store; this file only
// decides how a row looks. An empty list is a real answer and renders as one — "nothing
// wasted a cent" is the nicest sentence this panel can print, and it must not be replaced
// by the least-bad complaint available (`idle.ts` makes the same promise for the dawn
// card's flag).

import { formatCents } from './format';
import { r, cx } from './styles';
import { useReportsSlice } from './use-reports';

export function DiagnosticsPanel() {
  const diagnostics = useReportsSlice('diagnostics');

  return (
    <div className={cx(r.card, r.panel)}>
      <div className={r.head}>
        <span className={r.label}>Diagnostics</span>
        <span className={r.sub}>last 60 seconds</span>
      </div>
      <div className={r.rule} />

      {diagnostics.unlocked === 0 ? (
        // The build menu's "needs X" voice: a statement about the world, with the verb left
        // on the research panel's button where it actually lives.
        <p className={r.stubNote}>
          needs Diagnostics — the Fabrication node that reads what every machine wastes, and sells
          the Maintenance Station to aim at the worst of it.
        </p>
      ) : diagnostics.rows.length === 0 ? (
        <p className={r.stripEmpty}>Nothing on the lot wasted a cent in the last minute.</p>
      ) : (
        <ul className={r.rows}>
          {diagnostics.rows.map((row) => (
            <li key={row.id} className={r.row}>
              <span className={r.rowKey}>{row.label}</span>
              {/* §5's voice: a fact in cash, stated once. "Fryer B — $14.00 wasted". */}
              <span className={cx(r.rowValue, r.rowMoney)}>
                {formatCents(row.bleedCents)} wasted
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className={r.boardsFoot}>
        Ingredients ruined by worn machines, priced at list. Idle time is the Dawn Report&apos;s
        beat — the two are different money and are never added together.
      </p>
    </div>
  );
}
