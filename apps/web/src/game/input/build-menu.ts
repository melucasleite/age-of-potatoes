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

import { formatCents, formatCentsWhole } from '../../format/money';

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
  'agronomy-gold-potato': 'Gold Potato',
  'agronomy-composting': 'Composting',
  'agronomy-root-cellar': 'Root Cellar',
  'agronomy-orchard': 'The Orchard',
  'agronomy-kola-tree': 'The Kola Tree',
  'agronomy-agri-bots': 'Agri-Bots',
  'agronomy-planter-bot': 'The Planter Bot',
  'fabrication-wash-and-slice': 'Wash & Slice',
  'fabrication-fryer': 'The Fryer',
  'fabrication-finishing': 'Finishing',
  'logistics-belts': 'Belts',
  'logistics-belts-fast': 'Fast Belts',
  'logistics-belts-express': 'Express Belts',
  'logistics-splitters': 'Splitters',
  'commerce-upgrade-bench': 'Upgrade Bench',
  'fabrication-diagnostics': 'Diagnostics',
  'commerce-repair-drones': 'Repair Drones',
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
  // Last in Logistics rather than beside the belts, because it is the row that only means
  // anything to a player who has already run a line and found out that one line is not enough —
  // which is the same argument `TechId.Splitters` makes about sitting behind `Belts`.
  machineEntry('Logistics', ToolMode.PlaceBeltJunction),

  machineEntry('Chip line', ToolMode.PlaceWasher),
  machineEntry('Chip line', ToolMode.PlaceSlicer),
  machineEntry('Chip line', ToolMode.PlaceFryer),
  machineEntry('Chip line', ToolMode.PlaceSeasoner),
  machineEntry('Chip line', ToolMode.PlaceBagger),
  machineEntry('Chip line', ToolMode.PlaceChipKitchen),

  machineEntry('Field', ToolMode.PlaceSprinkler),
  machineEntry('Field', ToolMode.PlaceComposter),
  // The two docks are Field rows rather than Logistics ones, and that is a claim about what the
  // player is shopping for: a bot is not a way of moving goods across the lot, it is a way of
  // not walking the rows. It belongs next to the sprinkler, which is the other machine on this
  // menu that does a chore instead of a job.
  machineEntry('Field', ToolMode.PlaceHarvesterDock),
  machineEntry('Field', ToolMode.PlacePlanterDock),

  machineEntry('Orchard', ToolMode.PlaceOrangeTree),
  machineEntry('Orchard', ToolMode.PlaceLemonTree),
  machineEntry('Orchard', ToolMode.PlaceKolaTree),

  machineEntry('Storage', ToolMode.PlaceHandCart),
  machineEntry('Storage', ToolMode.PlaceRootCellar),

  // The maintenance chain ([[039]]), in supply-chain order: the station that spends kits, the
  // bay that spends parts, the bench that makes them. A group of its own rather than three
  // rows scattered by kind, because what the player is shopping for here is not a machine —
  // it is the idea that repair can be a line like any other, and the menu should say so by
  // putting the whole argument in one place.
  machineEntry('Maintenance', ToolMode.PlaceMaintenanceStation),
  machineEntry('Maintenance', ToolMode.PlaceDroneBay),
  machineEntry('Maintenance', ToolMode.PlacePartsBench),

  // The one row whose price is not a constant. See `dynamicCostCents` below.
  { tool: ToolMode.BuyDeed, group: 'Land', requiresTech: null, costCents: 0, perTile: false },

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
    const cost = dynamicCostCents(entry, view);
    // A world that owns every parcel has no next deed. The row stays visible and says so, for
    // the same reason a locked machine stays visible: a row that vanishes teaches nothing.
    const soldOut = entry.tool === ToolMode.BuyDeed && cost < 0;

    rows.push({
      tool: entry.tool,
      group: entry.group,
      label: info.label,
      hint: info.hint,
      price: cost <= 0 ? '' : formatPrice(cost, entry.perTile),
      locked: !open || soldOut,
      // "needs X", not "research X": the row is a statement about the world, and the verb
      // belongs on the button in the tech panel that actually performs it.
      lockReason: soldOut ? 'the whole lot is yours' : open ? '' : `needs ${techLabel}`,
      affordable: cost <= 0 || money >= cost,
    });
  }
  return rows;
}

/**
 * What this row costs RIGHT NOW, in cents, or -1 for a deed with nothing left to sell.
 *
 * One row needs this and the rest are constants. A land deed is priced by how many the world
 * has already bought (`DEED_PRICE_CENTS_BY_PURCHASE`), so the number lives in the projection
 * and is read per repaint — the menu repaints a few times a second while it is open, never
 * per frame. Copying the ladder over here to save the lookup is exactly the kind of second
 * source of truth this file's header rules out.
 */
function dynamicCostCents(entry: BuildEntry, view: WorldView | null): number {
  if (entry.tool !== ToolMode.BuyDeed) return entry.costCents;
  return view?.land.nextPriceCents ?? 0;
}

/**
 * The price on a row, in the same words the rest of the game prices things in.
 *
 * TWO RENDERINGS, CHOSEN BY WHETHER THE PENNIES ARE LOAD-BEARING — which is the criterion
 * `format/money.ts` documents and `hud/Shop.tsx` already applies to a fifty-cent seed.
 *
 * A PER-TILE PRICE GETS ITS PENNIES. A Basic Belt is 150 cents a tile, and it is the only
 * sub-dollar price in the game — every machine, grabber, tech node and land deed is a whole
 * number of dollars, which is why the disagreement below survived so long. This row used to
 * print `Math.round(150 / 100)` = "$2/tile" while the React toolbelt printed
 * `formatCentsWhole(150)` = "$1". The player is about to multiply this number by twenty, so
 * the fifty cents is the opposite of noise, and neither old answer was the price.
 *
 * EVERYTHING ELSE IS WHOLE DOLLARS, matching the toolbelt and the tech tree exactly. That also
 * puts the separators back on a land deed: the fifteenth costs $3,276,800 and this row printed
 * it as "$3276800", eight digits with nothing to hold on to, while the placement band drawn
 * over the parcel grouped it properly.
 */
function formatPrice(cents: number, perTile: boolean): string {
  return perTile ? `${formatCents(cents)}/tile` : formatCentsWhole(cents);
}
