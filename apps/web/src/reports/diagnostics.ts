// The diagnostics ranking: which machines are costing the most RIGHT NOW, in cash.
//
// Plan §5 and work item 039 specify this surface tightly: "a ranked list of machines by cash
// bled over the last 60 seconds, phrased in cash" — and, twice, what it is NOT: "not a graph
// dashboard", "not a metrics dashboard". So this module produces rows of exactly three facts
// — a machine's name, and the cents it wasted in the trailing minute — and nothing here
// computes a trend, a percentage, or a history.
//
// WHY THIS IS NOT `idle.ts`, though the two price waste in the same voice. `IdleWatch`'s
// header is a design ruling: "One flag per Dawn Report, never a list" — the dawn card hands
// the player at most one observation, because a card with five jobs on it is a chore list
// with a sunrise on it (§2). This list is the OPPOSITE surface by design: a panel the player
// opens on purpose, after researching a node whose whole promise is "read where the money
// bleeds". Opening a diagnostics panel IS asking for the list; repurposing the dawn flag's
// machinery against its own header would make both surfaces worse at their jobs.
//
// The two also measure different waste, and double-counting is the trap. `idle.ts` prices
// STANDING STILL (a starved Fryer earning nothing) from its realised rate, display-side.
// This list reads `MachineView.bleedCentsLast60s`, the sim's own accounting of INPUTS
// DESTROYED — ingredients a degraded machine ruined, priced at list over a trailing
// 60-second window (`BLEED_WINDOW_TICKS`). One number per surface, no overlap, and the sim's
// number rides the projection so a replay shows the same list.
//
// GATED BEHIND THE NODE. §3 lists diagnostics as a real tech with real UI, and the unlock is
// a verb: the panel's read. Before the node, the tab renders its locked state — visible and
// named, like a locked build-menu row, because a surface that vanishes teaches nobody it
// exists.

import { TechId, techSatisfied } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { machineLabel } from '../hud/tech-copy';

import type { BleedRow } from './types';

/**
 * Rows shown. Ranked and capped rather than complete: the point of the list is aim, and the
 * ninth-worst bleed on a lot big enough to have one is a lamp the player can already see.
 */
export const DIAGNOSTICS_ROW_LIMIT = 8;

/** Has the player researched the read? The projection's unlock list is the one authority. */
export function diagnosticsUnlocked(view: WorldView): boolean {
  return techSatisfied(view.unlocked, TechId.Diagnostics);
}

/**
 * Machines that wasted money in the trailing minute, worst first.
 *
 * DETERMINISTIC ORDER, STATED: descending by cents bled, ties broken by machine id
 * ascending. Machines project sorted by id, so the same world state always ranks the same —
 * a list that shuffles its ties on every publish looks alive in exactly the way a receipt
 * must not.
 *
 * Labels are "Fryer B" — the same kind-plus-letter scheme `idle.ts` uses, computed from rank
 * among same-kind machines in projection (id) order, so the diagnostics list and the dawn
 * flag never call the same machine two different names.
 */
export function rankBleeds(view: WorldView): BleedRow[] {
  const letters = new Map<number, number>();
  const rows: BleedRow[] = [];

  for (let i = 0; i < view.machines.length; i++) {
    const machine = view.machines[i]!;
    const rank = letters.get(machine.kind) ?? 0;
    letters.set(machine.kind, rank + 1);

    const bled = machine.bleedCentsLast60s;
    if (bled <= 0) continue;
    rows.push({
      id: machine.id,
      label: `${machineLabel(machine.kind)} ${letter(rank)}`,
      bleedCents: bled,
    });
  }

  rows.sort((a, b) => (b.bleedCents !== a.bleedCents ? b.bleedCents - a.bleedCents : a.id - b.id));
  rows.length = Math.min(rows.length, DIAGNOSTICS_ROW_LIMIT);
  return rows;
}

/** A, B, C… and then plain numbers, because "Fryer AB" helps nobody. Same rule as `idle.ts`. */
function letter(rank: number): string {
  return rank < 26 ? String.fromCharCode(65 + rank) : `#${rank + 1}`;
}
