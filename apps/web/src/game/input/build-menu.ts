// The build menu's catalogue: what you can buy, what it costs, and what is still locked.
//
// KEYBOARD-DRIVEN AND DELIBERATELY PLAIN. `B` opens it, `↑`/`↓` walk it, `Enter` arms the
// highlighted row, `Esc` closes. Rows 1–9 also answer to their digit for people who
// already know where the Fryer is. It is a shopping list, not a skill tree — the tech tree
// is a different panel and this one only reports its verdict.
//
// LOCKED ROWS STAY VISIBLE. Hiding a machine until its node is researched means the player
// never learns the machine exists, and "the chip line" stops being a thing you are working
// toward and becomes a thing that silently appears. A greyed row that names its unlock is
// the whole difference between a tech tree and a surprise.
//
// The catalogue reads prices and tech requirements out of the sim's balance data at module
// scope. Nothing here types a number that also lives in `packages/sim`.

import type { WorldView } from '@snack/sim';
import { beltSpec, grabberSpec, machineSpec, techSatisfied } from '@snack/sim';

import { TOOL_INFO, ToolMode, toolBeltTier, toolGrabberTier, toolMachineKind } from './tools';

export interface BuildEntry {
  readonly tool: ToolMode;
  readonly group: string;
  /** `null` when the row is always legal — zones, and the two v0.1 machines. */
  readonly requiresTech: string | null;
  /** Cents. For belts this is per tile and `perTile` is set. */
  readonly costCents: number;
  readonly perTile: boolean;
}

/**
 * Slug → the words a player would recognise. The sim stores ids like
 * `fabrication-wash-and-slice` and has no display strings by design — presentation lives
 * on this side of the seam, so this map is the right shape rather than a missing feature.
 */
const TECH_LABELS: Readonly<Record<string, string>> = {
  'agronomy-cane': 'Sugar Cane',
  'agronomy-corn': 'Corn',
  'agronomy-chili': 'Chili',
  'agronomy-seed-hopper': 'Seed Hopper',
  'fabrication-wash-and-slice': 'Wash & Slice',
  'fabrication-fryer': 'The Fryer',
  'fabrication-finishing': 'Finishing',
  'logistics-belts': 'Belts',
  'logistics-belts-fast': 'Fast Belts',
  'logistics-belts-express': 'Express Belts',
  'commerce-upgrade-bench': 'Upgrade Bench',
};

function machineEntry(group: string, tool: ToolMode): BuildEntry {
  const kind = toolMachineKind(tool);
  const spec = kind === null ? null : machineSpec(kind);
  return {
    tool,
    group,
    requiresTech: spec?.requiresTech ?? null,
    costCents: spec?.priceCents ?? 0,
    perTile: false,
  };
}

function beltEntry(tool: ToolMode): BuildEntry {
  const tier = toolBeltTier(tool);
  const spec = tier === null ? null : beltSpec(tier);
  return {
    tool,
    group: 'Logistics',
    requiresTech: spec?.requiresTech ?? null,
    costCents: spec?.priceCentsPerTile ?? 0,
    perTile: true,
  };
}

function grabberEntry(tool: ToolMode): BuildEntry {
  const tier = toolGrabberTier(tool);
  const spec = tier === null ? null : grabberSpec(tier);
  return {
    tool,
    group: 'Logistics',
    requiresTech: spec?.requiresTech ?? null,
    costCents: spec?.priceCents ?? 0,
    perTile: false,
  };
}

/** Menu order. Zones first because zones are what v0.2 is about. */
export const BUILD_CATALOGUE: readonly BuildEntry[] = [
  { tool: ToolMode.PaintZone, group: 'Zones', requiresTech: null, costCents: 0, perTile: false },
  { tool: ToolMode.EraseZone, group: 'Zones', requiresTech: null, costCents: 0, perTile: false },

  beltEntry(ToolMode.PlaceBeltBasic),
  beltEntry(ToolMode.PlaceBeltFast),
  beltEntry(ToolMode.PlaceBeltExpress),
  grabberEntry(ToolMode.PlaceGrabberMk1),
  grabberEntry(ToolMode.PlaceGrabberMk2),
  grabberEntry(ToolMode.PlaceGrabberLong),

  machineEntry('Chip line', ToolMode.PlaceWasher),
  machineEntry('Chip line', ToolMode.PlaceSlicer),
  machineEntry('Chip line', ToolMode.PlaceFryer),
  machineEntry('Chip line', ToolMode.PlaceSeasoner),
  machineEntry('Chip line', ToolMode.PlaceBagger),
  machineEntry('Chip line', ToolMode.PlaceChipKitchen),

  machineEntry('Field', ToolMode.PlaceSprinkler),

  // The one row in here that spends nothing, and the only one that takes something away.
  // Last, in a group of its own, because a teardown verb sitting between two machines you
  // are shopping for is a misclick waiting for a Fryer — and because "unbuild" is the
  // natural bottom of a list of buys. See `ToolMode.Deconstruct` for why it lives on this
  // surface rather than on the toolbelt.
  {
    tool: ToolMode.Deconstruct,
    group: 'Teardown',
    requiresTech: null,
    costCents: 0,
    perTile: false,
  },
];

export interface BuildRow {
  readonly tool: ToolMode;
  readonly group: string;
  readonly label: string;
  readonly hint: string;
  /** Rendered price, already formatted, or `''` for free. */
  readonly price: string;
  readonly locked: boolean;
  /** `''` when unlocked. Otherwise the words to show in the row. */
  readonly lockReason: string;
  /** `false` when the row is unlocked but the money is not there. */
  readonly affordable: boolean;
}

/**
 * Project the catalogue against a world.
 *
 * A pure read of `WorldView`'s plain data — `unlocked[]` and `moneyCents` — recomputed
 * only when the menu is open and a publish arrives, which is at most a few times a second.
 * This never runs per frame.
 */
export function buildRows(view: WorldView | null): BuildRow[] {
  const unlocked = view?.unlocked ?? [];
  const money = view?.moneyCents ?? 0;
  const rows: BuildRow[] = [];

  for (let i = 0; i < BUILD_CATALOGUE.length; i++) {
    const entry = BUILD_CATALOGUE[i]!;
    const info = TOOL_INFO[entry.tool];
    const open = techSatisfied(unlocked, entry.requiresTech);
    const techLabel =
      entry.requiresTech === null ? '' : (TECH_LABELS[entry.requiresTech] ?? entry.requiresTech);

    rows.push({
      tool: entry.tool,
      group: entry.group,
      label: info.label,
      hint: info.hint,
      price: entry.costCents === 0 ? '' : formatPrice(entry.costCents, entry.perTile),
      locked: !open,
      // "needs X", not "research X": the row is a statement about the world, and the verb
      // belongs on the button in the tech panel that actually performs it.
      lockReason: open ? '' : `needs ${techLabel}`,
      affordable: entry.costCents === 0 || money >= entry.costCents,
    });
  }
  return rows;
}

function formatPrice(cents: number, perTile: boolean): string {
  const dollars = Math.round(cents / 100);
  return perTile ? `$${dollars}/tile` : `$${dollars}`;
}
