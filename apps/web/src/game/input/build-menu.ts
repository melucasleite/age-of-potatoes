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
import {
  PIPE_PRICE_CENTS_PER_TILE,
  TechId,
  beltSpec,
  grabberSpec,
  machineSpec,
  techSatisfied,
} from '@snack/sim';

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
  /**
   * The atlas frame this entry is drawn as in the menu ([[071]]).
   *
   * DERIVED FROM THE SPEC, NEVER TYPED PER MACHINE: a machine row's frame is its spec's own
   * slug under the art pipeline's naming rule (`machine_<slug>`, dashes to underscores), so a
   * new machine brings its picture with it and a renamed slug fails the mapping test instead
   * of silently drawing the neighbour. Belts and grabbers share one world sprite per family —
   * that is a fact about the atlas (tiers differ by speed, not by paint; see
   * `render/belt-structure.ts`, "No tint"), so the menu says the same thing the lot does.
   *
   * The four abstract rows carry their frame explicitly because no spec knows them: a zone is
   * painted as the zone overlay the lot actually wears, a deed as the grass it buys, and
   * teardown as the crate a machine goes into — pictures the player has already met, reused
   * rather than invented (the sourcing rule in [[071]]).
   *
   * Resolution — name → atlas rectangle — happens on the HUD side (`hud/item-art.ts`), which
   * owns the manifest. This module never imports geometry; the name is the whole contract.
   */
  readonly frame: string;
}

/**
 * Slug → the words a player would recognise. The sim stores ids like
 * `fabrication-wash-and-slice` and has no display strings by design — presentation lives
 * on this side of the seam, so this map is the right shape rather than a missing feature.
 */
const TECH_LABELS: Readonly<Record<string, string>> = {
  // The final-stretch cuts ([[145]], [[146]], [[150]]) removed nine slugs from this table:
  // corn, chili, gold potato, the seed hopper (auto-replant), the root cellar, the orchard,
  // the recirculator, diagnostics, and the corporate charter. A slug the sim no longer has
  // is a row no entry below can require, so the label would be dead weight, not a tombstone.
  'agronomy-cane': 'Sugar Cane',
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
  'commerce-repair-drones': 'Repair Drones',
  // [[100]]. THE WORDS ARE THE TECH PANEL'S OWN TITLES, not new ones invented here — the lock
  // reason exists so the player can go and FIND the node, and a name that appears on only one
  // of the two surfaces sends them looking for something that is not there. That is why
  // `commerce-trucking` reads "Truck Depot" on a row also labelled "Truck Depot": the panel
  // calls the node that, and a row that says "needs Root Cellar" under the label "Root Cellar"
  // has shipped happily since the cellar did.
  'commerce-bundles': 'Bundles',
  'commerce-trucking': 'Truck Depot',
  // [[101]]. Era II's whole column, which sold six nodes for $6,100 and unlocked no row at all
  // — not even a locked one — because the pipe had no build verb to gate them behind.
  'hydraulics-pumps': 'Pumps & Pipes',
  'hydraulics-piped-sprinklers': 'Piped Sprinklers',
  'hydraulics-irrigation-hub': 'Irrigation Hub',
  'hydraulics-soda-press': 'Press & Kettle',
  'hydraulics-soda-mixing': 'Mixing & Bottling',
};

/** The art pipeline's naming rule, restated in one line: slugs dash, frames underscore. */
function frameSlug(slug: string): string {
  return slug.split('-').join('_');
}

function machineEntry(group: string, tool: ToolMode): BuildEntry {
  const kind = toolMachineKind(tool);
  const spec = kind === null ? null : machineSpec(kind);
  return {
    tool,
    group,
    requiresTech: spec?.requiresTech ?? null,
    costCents: spec?.priceCents ?? 0,
    perTile: false,
    // An empty frame for a spec-less tool would be a bug twice over; the mapping test
    // (`build-menu.test.ts`) fails on it rather than letting the cell render a blank.
    frame: spec === null ? '' : `machine_${frameSlug(spec.slug)}`,
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
    frame: 'belt_straight',
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
    frame: 'grabber_arm',
  };
}

/**
 * The pipe's row ([[101]]) — hand-built, like the belts', because a pipe is not a machine.
 *
 * PRICED PER TILE AND GATED ON THE SIM'S OWN CONSTANT. `applyPlacePipe` refuses without
 * `TechId.Pumps` and charges `PIPE_PRICE_CENTS_PER_TILE` per tile of the path; both numbers are
 * read from the sim here rather than typed, which is this file's rule and the reason the row
 * cannot drift from the reducer that judges it.
 */
function pipeEntry(): BuildEntry {
  return {
    tool: ToolMode.PlacePipe,
    group: 'Plumbing',
    requiresTech: TechId.Pumps,
    costCents: PIPE_PRICE_CENTS_PER_TILE,
    perTile: true,
    // One straight length of pipe, the same way the belt row wears one straight belt: the tiers
    // and the corners and the tees are facts about the run, and a menu cell is not a run.
    frame: 'pipe_straight',
  };
}

/** Menu order. Zones first because zones are what v0.2 is about. */
export const BUILD_CATALOGUE: readonly BuildEntry[] = [
  // Both zone verbs wear the zone overlay itself — the picture the lot puts on a zoned tile,
  // which is the honest glyph for "this tool is about that". Erase carries a red strike over
  // the same sprite on the HUD side: what it erases IS the thing in the picture.
  {
    tool: ToolMode.PaintZone,
    group: 'Zones',
    requiresTech: null,
    costCents: 0,
    perTile: false,
    frame: 'zone_overlay',
  },
  {
    tool: ToolMode.EraseZone,
    group: 'Zones',
    requiresTech: null,
    costCents: 0,
    perTile: false,
    frame: 'zone_overlay',
  },

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

  // PLUMBING SITS DIRECTLY UNDER LOGISTICS ([[101]]) because they are the same kind of thing and
  // the menu should say so: belts and arms move solids, pipe moves liquid, and neither group
  // makes a product. Everything below this line is a machine that consumes one or the other.
  //
  // The pipe is FIRST in its own group, which is the one ordering decision here that matters —
  // the Pump is the expensive half of a purchase that is useless without the cheap half, and a
  // player who buys a $200 pump before they know pipe exists has bought a statue.
  //
  // The Recirculator sat at the bottom of this group until [[145]] cut it with the graywater
  // loop it ran.
  pipeEntry(),
  machineEntry('Plumbing', ToolMode.PlacePump),
  // THE WELL THAT USED TO SIT HERE IS GONE ([[140]]). It was the answer to "how do I boost the
  // pump?" while a pond could run dry; the owner deleted the running dry, so the question no
  // longer has that answer — or that urgency. What is left of it is the pump itself, whose rate
  // is now the only thing between the pond and the pipes, and the Tank below, which is still how
  // you ride out a stall.
  machineEntry('Plumbing', ToolMode.PlaceTank),

  // The Chip Kitchen closed this group until [[145]]: the starter machine is cut, so the
  // researched five ARE the chip line now, and the early game sells raw produce instead.
  machineEntry('Chip line', ToolMode.PlaceWasher),
  machineEntry('Chip line', ToolMode.PlaceSlicer),
  machineEntry('Chip line', ToolMode.PlaceFryer),
  machineEntry('Chip line', ToolMode.PlaceSeasoner),
  machineEntry('Chip line', ToolMode.PlaceBagger),

  // THE THREE WATERING MACHINES ARE NOW A LADDER AND THEY ARE ADJACENT ([[101]]). §3 runs
  // manual → assisted → automated through every system in the game, and this is the water
  // column with all three rungs visible at once for the first time: a barrel you walk out to
  // refill, a head that never runs dry, and a hub that skips a tile which is already wet. The
  // two piped heads are Field rows rather than Plumbing ones because a player shopping for a
  // way to water the field looks where the sprinkler is, not where the pipe is.
  machineEntry('Field', ToolMode.PlaceSprinkler),
  machineEntry('Field', ToolMode.PlacePipedSprinkler),
  machineEntry('Field', ToolMode.PlaceIrrigationHub),
  // The two docks are Field rows rather than Logistics ones, and that is a claim about what the
  // player is shopping for: a bot is not a way of moving goods across the lot, it is a way of
  // not walking the rows. It belongs next to the sprinkler, which is the other machine on this
  // menu that does a chore instead of a job.
  machineEntry('Field', ToolMode.PlaceHarvesterDock),
  machineEntry('Field', ToolMode.PlacePlanterDock),

  // The Orchard keeps only the Kola Tree ([[145]]): the Orange and Lemon trees grew fruit
  // nothing consumed, and the group's one survivor is the tree the soda line actually wants.
  machineEntry('Orchard', ToolMode.PlaceKolaTree),

  // The Root Cellar's five hundred slots went with it ([[145]]); the cart is the storage row.
  machineEntry('Storage', ToolMode.PlaceHandCart),

  // THE SODA LINE, IN THE ORDER THE LIQUID TRAVELS ([[100]] opened the group with the Grinder;
  // [[101]] filled the other five seats). Cane becomes juice becomes syrup; kola becomes powder;
  // the mixer takes syrup, powder and water and makes soda syrup; the carbonator makes the
  // fizz; the bottler puts the two together into a bottle. Reading the group top to bottom is
  // reading the recipe, which is the one ordering a six-machine chain can have that a player
  // can act on — and it is the order `soda-line.json` builds them in.
  //
  // The Grinder is the third row and the odd one out: it is the only member with `ports: []`,
  // belt in and belt out, which is exactly why it was buildable one item earlier than its five
  // neighbours and why five separate auditors walked past it.
  machineEntry('Soda line', ToolMode.PlaceJuicer),
  machineEntry('Soda line', ToolMode.PlaceKettle),
  machineEntry('Soda line', ToolMode.PlaceGrinder),
  machineEntry('Soda line', ToolMode.PlaceSyrupMixer),
  machineEntry('Soda line', ToolMode.PlaceCarbonator),
  machineEntry('Soda line', ToolMode.PlaceBottler),

  // DISPATCH, NAMED AFTER THE PANEL IT FEEDS ([[100]]) — `reports/CommercePanel.tsx` sits in the
  // ribbon ungated from day one, explaining delivery carts and standing contracts in full
  // paragraphs over a permanently empty list, because `projectCommerce` builds its rows from
  // PLACED machines and none of these four could ever be placed. A player who read that panel
  // and went looking for the cart now finds a group with the panel's own name on it.
  //
  // NOT "Logistics", which on this menu means moving goods AROUND the lot — belts, arms, the
  // junction. These four are about goods LEAVING it, in §3's ladder order: bundle it, cart it
  // (assisted — you load and send), truck it (automated — it never needs you again).
  machineEntry('Dispatch', ToolMode.PlaceSixPacker),
  machineEntry('Dispatch', ToolMode.PlaceComboPacker),
  machineEntry('Dispatch', ToolMode.PlaceDeliveryCart),
  machineEntry('Dispatch', ToolMode.PlaceTruckDepot),

  // The maintenance ladder ([[039]], [[090]], [[145]]) is down to its top rung. Item 090
  // retired the Parts Bench; item 145 cut the Maintenance Station, so the hand-thrown kit is
  // the assisted rung now and the bay's drone is the end of the chore.
  machineEntry('Maintenance', ToolMode.PlaceDroneBay),

  // The one row whose price is not a constant. See `dynamicCostCents` below. Drawn as the
  // grass it buys — the deed signs already stand on exactly this tile in the world.
  {
    tool: ToolMode.BuyDeed,
    group: 'Land',
    requiresTech: null,
    costCents: 0,
    perTile: false,
    frame: 'terrain_grass',
  },

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
    // The crate a boxed machine becomes — the picture of where a teardown puts things,
    // already worn by every box in the bag (`item-art.ts`'s `item_crate`).
    frame: 'item_crate',
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
  /** The atlas frame the cell draws, straight off the entry. See `BuildEntry.frame`. */
  readonly frame: string;
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
      frame: entry.frame,
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

// --- the grid ------------------------------------------------------------------------------
//
// The menu is a grid of pictures now ([[071]]), and the cursor has to move the way the eye
// does: left/right walk the shopping list in order, up/down move between VISUAL rows. What a
// visual row is depends on the group layout — every group starts a fresh row and fills across
// `BUILD_GRID_COLS` columns — so the layout is computed here, once, as data, and the React
// grid and the keyboard agree by construction. A column count typed in the stylesheet as well
// would be the classic two-sources bug: arrows that jump diagonally after a CSS tweak.

/** Columns per grid row. The one place this number lives; the panel reads it for CSS. */
export const BUILD_GRID_COLS = 5;

export type GridDirection = 'up' | 'down' | 'left' | 'right';

export interface GridPlace {
  readonly row: number;
  readonly col: number;
}

/**
 * Where each entry sits in the grid. Groups break rows: a group's first entry always starts
 * at column zero, and a group never shares a row with its neighbour — which is what makes
 * the group headings between the grids honest about the geometry underneath them.
 */
export function gridPlaces(rows: readonly { readonly group: string }[], cols: number): GridPlace[] {
  const places: GridPlace[] = [];
  let row = 0;
  let col = 0;
  let group: string | null = null;

  for (const entry of rows) {
    if (entry.group !== group) {
      if (group !== null && col > 0) {
        row += 1;
      }
      col = 0;
      group = entry.group;
    }
    places.push({ row, col });
    col += 1;
    if (col === cols) {
      col = 0;
      row += 1;
    }
  }
  return places;
}

/**
 * One arrow press. Left and right walk the catalogue in order and wrap — the grid read as a
 * list, which keeps the old ↑/↓-through-everything muscle memory reachable sideways. Up and
 * down move to the NEAREST row above or below and keep the column as best that row allows,
 * wrapping top to bottom; a short last row (three cells under a row of five) catches a
 * descending cursor at its rightmost cell instead of refusing the move.
 *
 * Locked cells are landable on purpose, exactly as locked rows were: the cursor is how the
 * player reads a lock reason, and `armMenuCursor` is where refusal lives.
 */
export function moveGridCursor(
  rows: readonly { readonly group: string }[],
  cols: number,
  cursor: number,
  dir: GridDirection,
): number {
  const count = rows.length;
  if (count === 0) return 0;
  const from = cursor < 0 ? 0 : cursor >= count ? count - 1 : cursor;

  if (dir === 'left') return (from - 1 + count) % count;
  if (dir === 'right') return (from + 1) % count;

  const places = gridPlaces(rows, cols);
  const here = places[from]!;
  const lastRow = places[count - 1]!.row;
  const step = dir === 'up' ? -1 : 1;

  // Scan rows outward in the direction of travel, wrapping once past either edge. The rows
  // are dense (every index between 0 and lastRow is occupied), so the first candidate row
  // is the answer; the loop exists only to express the wrap without a modulo-on-negatives.
  let targetRow = here.row + step;
  if (targetRow < 0) targetRow = lastRow;
  if (targetRow > lastRow) targetRow = 0;

  let best = from;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const place = places[i]!;
    if (place.row !== targetRow) continue;
    const distance = Math.abs(place.col - here.col);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}
