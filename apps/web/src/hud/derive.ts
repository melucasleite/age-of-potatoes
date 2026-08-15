// WorldView → HUD slice fields.
//
// Everything here is a pure read of the projection. It calls nothing on the simulation and
// hands nothing back to it, exactly as `render/index.ts` does not — the HUD is a second
// reader of the same seam, not a second writer.
//
// It runs at the publish cadence (≈6.7 Hz), so it can afford to be readable. The one thing
// it must NOT do is allocate objects that end up in the snapshot when nothing changed;
// that is the store's job to detect, and `store.ts` compares field by field before it
// keeps anything built here.

import {
  BOT_CARRY_CAPACITY,
  BOT_SPEED_SUBTILES_PER_100_TICKS,
  BOT_WORK_TICKS,
  HAND_REACH_SUBTILES,
  ItemId,
  LampState,
  MachineKind,
  SUBTILE,
  TICKS_PER_SECOND,
  itemSpec,
  machineSpec,
} from '@snack/sim';
import type { ItemSpec, WorldView } from '@snack/sim';

// Relative rather than the `@/` alias, like `derive-inventory.ts` and for its reason: vitest
// runs with no config in this repo, and this module is now under test (`whisper.test.ts`,
// `can.test.ts`) — an alias here is a module the tests cannot follow.
import { hotbar, itemPlaceTool, slotIndexToDigit } from '../game/input/hotbar';
import { TOOL_INFO, toolMachineKind } from '../game/input/tools';
import type { ToolMode } from '../game/input/tools';

import { countWord, formatCents, plural } from './format';
import { freshnessBand } from './freshness';
import { itemName } from './item-copy';
import type { ClipboardNote, PouchItem, ToolSlot } from './types';

// --- the unlock ladder -------------------------------------------------------------

interface CatalogueEntry {
  readonly kind: MachineKind;
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
}

/**
 * Order is want-order, not price-order, and the sprinkler leads deliberately even though
 * the Chip Kitchen is cheaper. The v0.1 design gate is a player grinning when the
 * sprinkler waters for them and immediately wanting a second one (AGENTS.md) — so the
 * sprinkler is what the Ticker counts down to, first and by name.
 */
const CATALOGUE: readonly CatalogueEntry[] = [
  {
    kind: MachineKind.Sprinkler,
    id: 'sprinkler',
    label: 'Sprinkler',
    blurb: 'Waters the 5×5 patch around it every five seconds. It never forgets.',
  },
  {
    kind: MachineKind.ChipKitchen,
    id: 'chip-kitchen',
    label: 'Chip Kitchen',
    blurb: 'Turns two-dollar russets into twenty-dollar bags of chips.',
  },
];

export interface UnlockFields {
  id: string | null;
  label: string;
  blurb: string;
  priceCents: number;
  owned: number;
  affordable: number;
  etaSeconds: number;
}

/**
 * The next thing to want: the first unowned entry in want-order, or — once the lot has one
 * of everything — the cheapest one again, because "another sprinkler" is a real ambition
 * and a Ticker with nothing on it is a Ticker that stops working.
 */
export function deriveUnlock(
  view: WorldView,
  counts: MachineCounts,
  rateCentsPerMin: number,
  rateSettled: number,
  out: UnlockFields,
): UnlockFields {
  let chosen: CatalogueEntry | null = null;
  for (const entry of CATALOGUE) {
    if (ownedOf(counts, entry.kind) === 0) {
      chosen = entry;
      break;
    }
  }
  if (chosen === null) {
    for (const entry of CATALOGUE) {
      const price = priceOf(entry.kind);
      if (chosen === null || price < priceOf(chosen.kind)) chosen = entry;
    }
  }

  if (chosen === null) {
    out.id = null;
    out.label = '';
    out.blurb = '';
    out.priceCents = 0;
    out.owned = 0;
    out.affordable = 0;
    out.etaSeconds = -1;
    return out;
  }

  const price = priceOf(chosen.kind);
  const deficit = price - view.moneyCents;

  out.id = chosen.id;
  out.label = chosen.label;
  out.blurb = chosen.blurb;
  out.priceCents = price;
  out.owned = ownedOf(counts, chosen.kind);
  out.affordable = deficit <= 0 ? 1 : 0;
  // Pure display arithmetic on two sim-owned integers. A non-positive or unsettled rate
  // yields -1 and the panel renders an em dash — never `Infinity`, never a countdown that
  // runs backwards.
  out.etaSeconds =
    deficit <= 0
      ? 0
      : rateSettled === 1 && rateCentsPerMin > 0
        ? (deficit * 60) / rateCentsPerMin
        : -1;
  return out;
}

function priceOf(kind: MachineKind): number {
  const spec = machineSpec(kind);
  return spec === null ? 0 : spec.priceCents;
}

// --- machine census ----------------------------------------------------------------

export interface MachineCounts {
  sprinklers: number;
  kitchens: number;
  jammed: number;
  halted: number;
  blocked: number;
  starved: number;
  utilityMissing: number;
  wrenchDue: number;
}

export function createMachineCounts(): MachineCounts {
  return {
    sprinklers: 0,
    kitchens: 0,
    jammed: 0,
    halted: 0,
    blocked: 0,
    starved: 0,
    utilityMissing: 0,
    wrenchDue: 0,
  };
}

export function censusMachines(view: WorldView, out: MachineCounts): MachineCounts {
  out.sprinklers = 0;
  out.kitchens = 0;
  out.jammed = 0;
  out.halted = 0;
  out.blocked = 0;
  out.starved = 0;
  out.utilityMissing = 0;
  out.wrenchDue = 0;

  for (const machine of view.machines) {
    if (machine.kind === MachineKind.Sprinkler) out.sprinklers += 1;
    if (machine.kind === MachineKind.ChipKitchen) out.kitchens += 1;
    if (machine.wrenchDue === 1) out.wrenchDue += 1;
    switch (machine.lamp) {
      case LampState.Jammed:
        out.jammed += 1;
        break;
      case LampState.Halted:
        out.halted += 1;
        break;
      case LampState.Blocked:
        out.blocked += 1;
        break;
      case LampState.Starved:
        out.starved += 1;
        break;
      case LampState.UtilityMissing:
        out.utilityMissing += 1;
        break;
      default:
        break;
    }
  }
  return out;
}

function ownedOf(counts: MachineCounts, kind: MachineKind): number {
  if (kind === MachineKind.Sprinkler) return counts.sprinklers;
  if (kind === MachineKind.ChipKitchen) return counts.kitchens;
  return 0;
}

// --- the pouch ---------------------------------------------------------------------

const ITEM_LABELS: Readonly<Record<number, string>> = {
  [ItemId.PotatoSeed]: 'seeds',
  [ItemId.RussetPotato]: 'russets',
  [ItemId.BaggedChips]: 'chips',
};

/**
 * The pouch, and whether the bin will take any of it.
 *
 * `sellable` IS READ, NEVER DECIDED HERE. Seeds are bought at the roadside stand and never
 * sold back ([[051]]), and `ItemSpec` is the one place that says so — a list of "seed-ish"
 * item ids maintained on this side would be a second opinion about balance data, which is
 * the same mistake `derive-shop.ts` refuses to make about prices. The value is still computed
 * for a stack the bin refuses; `Pouch.tsx` simply does not print it, because zero is a
 * different claim from "this is not for sale".
 */
export function derivePouch(view: WorldView): PouchItem[] {
  const items: PouchItem[] = [];
  for (const slot of view.inventory) {
    if (slot.count <= 0) continue;
    const spec: ItemSpec | null = itemSpec(slot.item as ItemId);
    items.push({
      id: slot.item,
      // The short plural forms above are the pouch's own register — "12 russets" is what a
      // person says. The FALLBACK is no longer "stuff": twenty boxed-machine rows landed in
      // `ITEM_SPECS` at once ([[054]]), and a pouch reading "2 stuff" beside the panel that
      // calls the same thing a Fryer is the HUD disagreeing with itself in one glance.
      label: ITEM_LABELS[slot.item] ?? itemName(slot.item),
      count: slot.count,
      valueCents: spec === null ? 0 : spec.listPriceCents * slot.count,
      sellable: spec !== null && !spec.sellable ? 0 : 1,
      // The clock, read off the projection and never recomputed here — same rule as `sellable`
      // directly above, and for the same reason. See `freshness.ts`.
      ticksToSpoil: slot.ticksToSpoil,
      spoilingCount: slot.spoilingCount,
    });
  }
  return items;
}

// --- the watering can ----------------------------------------------------------------

export interface CanFields {
  canCharges: number;
  canChargesMax: number;
  shoreHeading: string;
}

/**
 * The can's pours and which way the water is ([[009]]).
 *
 * Charges are READ, never counted here — `view.player.canCharges` is the sim's number, and
 * `canCharges === 0` is the whole refusal story the HUD tells: a pour at zero is a silent
 * no-op in the projection (no event, nothing spent), so the tell has to be state the chip can
 * always draw, not a flash it would have to catch.
 */
export function deriveCan(view: WorldView): CanFields {
  return {
    canCharges: view.player.canCharges,
    canChargesMax: view.player.canChargesMax,
    shoreHeading: shoreHeadingFor(view),
  };
}

/**
 * Which way the nearest water is, eight-point quantised — `deriveShop`'s `headingTo`
 * convention, measured to the nearest point of the reservoir's RECT rather than its centre,
 * because that is where `applyRefillCan` measures reach and a pond is wide: the centre of a
 * big pond can be north-east while its bank is due east at your feet.
 *
 * '' means "nothing to point at": already within dipping reach, or a world with no
 * reservoir at all — where the refill legally works anywhere (§4's guarantee is about the
 * can, not the pond) and an arrow would point at nothing.
 */
function shoreHeadingFor(view: WorldView): string {
  const px = view.player.xSub;
  const py = view.player.ySub;

  let bestDx = 0;
  let bestDy = 0;
  let bestDist = -1;

  for (const r of view.reservoirs) {
    const x0 = r.tileX * SUBTILE;
    const x1 = (r.tileX + r.tilesWide) * SUBTILE;
    const y0 = r.tileY * SUBTILE;
    const y1 = (r.tileY + r.tilesHigh) * SUBTILE;
    const nx = Math.min(Math.max(px, x0), x1);
    const ny = Math.min(Math.max(py, y0), y1);
    const dx = nx - px;
    const dy = ny - py;
    const dist = dx * dx + dy * dy;
    if (bestDist < 0 || dist < bestDist) {
      bestDist = dist;
      bestDx = dx;
      bestDy = dy;
    }
  }

  if (bestDist < 0) return '';
  if (bestDist <= HAND_REACH_SUBTILES * HAND_REACH_SUBTILES) return '';

  const ax = Math.abs(bestDx);
  const ay = Math.abs(bestDy);
  const northSouth = bestDy < 0 ? 'north' : 'south';
  const eastWest = bestDx < 0 ? 'west' : 'east';
  if (ax > ay * 2) return eastWest;
  if (ay > ax * 2) return northSouth;
  return `${northSouth}-${eastWest}`;
}

// --- the hotbar ----------------------------------------------------------------------

/**
 * The bar's slots, read off the `hotbar` singleton's layout ([[061]]).
 *
 * The LAYOUT lives in the input lane and this function only prices it: an item shortcut
 * resolves to its placement cursor through the same chain the bag's Place button uses, and
 * then gets exactly the affordability arithmetic a tool slot gets. `active` marks any slot
 * whose resolved tool is the armed one — pressing 7 and clicking the bag's Place button for
 * the same machine light the same slot, because they armed the same cursor.
 *
 * @param boxedKinds `MachineKind`s the player is carrying at least one box of. A placement tool
 * for one of these costs nothing, because `PlaceMachine` opens the box before it reaches for
 * money ([[054]]) — so the slot must not quote a price, and must not grey itself out at $0.
 */
export function deriveTools(
  moneyCents: number,
  active: ToolMode,
  boxedKinds: readonly number[],
): ToolSlot[] {
  return hotbar.slots.map((entry, index) => {
    const digit = slotIndexToDigit(index);
    if (entry === null) {
      return {
        tool: -1,
        item: -1,
        digit,
        label: '',
        hint: 'empty — drag something placeable from the bag',
        costCents: 0,
        affordable: 1,
        active: 0,
        fromBox: 0,
      };
    }

    const item = entry.kind === 'item' ? entry.item : -1;
    const tool = entry.kind === 'tool' ? entry.tool : itemPlaceTool(entry.item);
    if (tool === -1) {
      // An item shortcut this build has no cursor for — a layout saved by a newer build,
      // honestly disabled rather than arming the wrong thing (the bag makes the same call).
      return {
        tool: -1,
        item,
        digit,
        label: itemName(item),
        hint: 'nothing in this build places one of these',
        costCents: 0,
        affordable: 0,
        active: 0,
        fromBox: 0,
      };
    }

    const info = TOOL_INFO[tool];
    const kind = toolMachineKind(tool);
    const fromBox = kind !== null && boxedKinds.includes(kind) ? 1 : 0;
    return {
      tool,
      item,
      digit,
      label: item === -1 ? info.label : itemName(item),
      hint: info.hint,
      costCents: info.costCents,
      affordable: fromBox === 1 || info.costCents === 0 || moneyCents >= info.costCents ? 1 : 0,
      active: tool === active ? 1 : 0,
      fromBox,
    };
  });
}

// --- the Clipboard -----------------------------------------------------------------

/**
 * Observations, never quests.
 *
 * The distinction is the whole design (§2): "you hand-harvested 60 potatoes this hour; an
 * auto-harvester would have caught 45" is a fact about the lot that happens to imply a
 * purchase. "Buy an auto-harvester" is a chore list. The first makes the player feel
 * observant; the second makes them feel managed. Every string below states something true
 * about the world and stops talking.
 *
 * Each candidate carries a priority; the top three win. Priorities are ordered so that
 * things which have ALREADY STOPPED WORKING outrank things that could merely go better.
 */
interface Candidate extends ClipboardNote {
  readonly priority: number;
}

const FIELD_SAMPLE = {
  ripe: 0,
  dryPlanted: 0,
  bare: 0,
};

/**
 * Hand-harvests inside the CURRENT dawn-aligned hour — the "this hour" in §2's promotion
 * whisper, measured rather than gestured at.
 *
 * The sim's hour ledger (`StatsView.hours`) does not split harvests by hand/machine, so the
 * split is differenced HERE: baseline `itemsHarvestedByHand` at the moment the open hour
 * changes, delta since. Owned by the store and reset on `claim()`, like `RiskWatch`, and for
 * the same reason — "since the hour began" is the one question a stateless projection cannot
 * answer. First observation mid-hour baselines at the current count, so the figure
 * UNDER-claims for the first hour after a load; the house discipline for every cash and
 * count figure in this HUD (see `derive-lot.ts`'s header) is to under-claim.
 */
export class HarvestPace {
  private hourKey = Number.MIN_SAFE_INTEGER;
  private baseline = 0;
  private lastTick = -1;

  reset(): void {
    this.hourKey = Number.MIN_SAFE_INTEGER;
    this.baseline = 0;
    this.lastTick = -1;
  }

  /** Fold in one publish and answer the hand-harvest count since the open hour began. */
  thisHour(view: WorldView): number {
    // Time ran backwards: a save was loaded under the same store. Start over.
    if (view.tick < this.lastTick) this.reset();
    this.lastTick = view.tick;

    const hours = view.stats.hours;
    const open = hours.length === 0 ? null : hours[hours.length - 1]!;
    const key = open === null ? -1 : open.hour;
    const harvested = view.stats.itemsHarvestedByHand;

    if (key !== this.hourKey) {
      this.hourKey = key;
      this.baseline = harvested;
    }
    // A baseline above the count means the world changed without the hour key moving —
    // clamp rather than report a negative harvest.
    if (harvested < this.baseline) this.baseline = harvested;
    return harvested - this.baseline;
  }
}

/**
 * The Harvester Dock bot's pace, in ticks per crop, from its sim spec and nothing else.
 *
 * The constants are the sim's (`BOT_WORK_TICKS`, `BOT_SPEED_SUBTILES_PER_100_TICKS`,
 * `BOT_CARRY_CAPACITY`); the two geometric assumptions are stated here because they are the
 * only numbers that are not: plants one tile apart (a worked zone is contiguous), and a
 * two-tile walk each way to unload every armful (the dock sits at the zone's edge). Roughly
 * 24 ticks a crop — the whisper rounds THROUGH this figure, never states it.
 */
const BOT_TICKS_PER_TILE = (SUBTILE * 100) / BOT_SPEED_SUBTILES_PER_100_TICKS;
const BOT_TICKS_PER_CROP =
  BOT_WORK_TICKS +
  BOT_TICKS_PER_TILE +
  (BOT_WORK_TICKS + 4 * BOT_TICKS_PER_TILE) / BOT_CARRY_CAPACITY;

/** "about 40 seconds" / "about 3 minutes" — how long the bot would take over `crops` pulls. */
export function botCatchUpPhrase(crops: number): string {
  const seconds = Math.ceil((crops * BOT_TICKS_PER_CROP) / TICKS_PER_SECOND);
  if (seconds < 75) return `about ${countWord(Math.max(1, seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  return `about ${countWord(minutes)} ${plural(minutes, 'minute', 'minutes')}`;
}

/** Enough pulls for the comparison to be worth a line. Below this the hour is small talk. */
const WHISPER_MIN_HARVESTS = 12;

export function deriveClipboard(
  view: WorldView,
  counts: MachineCounts,
  pace: HarvestPace,
): ClipboardNote[] {
  const field = view.field;
  FIELD_SAMPLE.ripe = 0;
  FIELD_SAMPLE.dryPlanted = 0;
  FIELD_SAMPLE.bare = 0;
  for (let i = 0; i < field.crop.length; i++) {
    const planted = field.crop[i] !== 0;
    if (!planted) {
      FIELD_SAMPLE.bare += 1;
      continue;
    }
    if (field.ready[i] === 1) FIELD_SAMPLE.ripe += 1;
    else if (field.dry[i] === 1) FIELD_SAMPLE.dryPlanted += 1;
  }

  const seeds = countOf(view, ItemId.PotatoSeed);
  const chips = countOf(view, ItemId.BaggedChips);
  const russets = countOf(view, ItemId.RussetPotato);
  const sprinklerPrice = priceOf(MachineKind.Sprinkler);
  const stats = view.stats;

  const candidates: Candidate[] = [];
  const add = (priority: number, id: string, tone: ClipboardNote['tone'], text: string): void => {
    candidates.push({ priority, id, tone, text });
  };

  if (counts.jammed > 0) {
    add(100, 'jammed', 'warn', 'Something has jammed. It will sit there until it is whacked.');
  }
  if (counts.halted > 0) {
    add(
      95,
      'halted',
      'warn',
      'A machine has worn down to a stop. Right-click and hold repairs it.',
    );
  }
  if (counts.utilityMissing > 0) {
    add(88, 'barrel', 'warn', "The sprinkler's barrel is empty. An empty barrel waters nothing.");
  }
  if (counts.blocked > 0) {
    add(
      82,
      'blocked',
      'warn',
      'The kitchen has filled its own output tray. It stops until somebody takes the chips.',
    );
  }
  // THE ONE THING IN THE BAG WITH A CLOCK ON IT.
  //
  // Why this belongs on the Clipboard at all, since [[035]] already put a wedge on the bag's
  // grid and a time on the pouch chip: the grid is behind a keypress, and the wedge is only ever
  // seen by a player who thought to look. The Clipboard is the surface that says a thing the
  // player did NOT go looking for, and "your slices are about to become compost" is precisely
  // that — it is the same shape as "three planted tiles read dry", one row further along the
  // same pipeline. It stays an observation, not a chore: it says what is happening and one true
  // thing about the world, and never "put them in a machine".
  //
  // It also cannot strobe. The Clipboard re-reads every two seconds and this note changes at two
  // thresholds over minutes, so it is a line that arrives, sits, and is replaced by the louder
  // one — not a countdown ticking in the corner of the eye.
  const spoiling = soonestSpoiling(view);
  if (spoiling !== null) {
    const name = itemName(spoiling.item);
    if (freshnessBand(spoiling.ticksToSpoil) === 'going') {
      add(80, 'spoiling', 'warn', `A stack of ${name} goes to compost in under a minute.`);
    } else if (freshnessBand(spoiling.ticksToSpoil) === 'turning') {
      add(
        64,
        'spoiling',
        'nudge',
        `A stack of ${name} is starting to turn. Nothing ages inside a machine.`,
      );
    }
  }
  if (chips > 0) {
    const worth = formatCents(chips * 2000);
    add(
      74,
      'chips',
      'nudge',
      `${countWord(chips)} ${plural(chips, 'bag', 'bags')} of chips ${plural(chips, 'is', 'are')} in your pocket, worth ${worth}. Nothing sells itself.`,
    );
  }
  if (counts.sprinklers === 0 && view.moneyCents >= sprinklerPrice) {
    add(
      72,
      'afford-sprinkler',
      'good',
      'You can afford the sprinkler. It waters without being asked, which is the entire point of it.',
    );
  }
  if (FIELD_SAMPLE.dryPlanted >= 3) {
    add(
      66,
      'dry',
      'nudge',
      `${countWord(FIELD_SAMPLE.dryPlanted)} planted ${plural(FIELD_SAMPLE.dryPlanted, 'tile reads', 'tiles read')} dry. Growth pauses while they do.`,
    );
  }
  if (FIELD_SAMPLE.ripe >= 3) {
    add(
      62,
      'ripe',
      'nudge',
      `${countWord(FIELD_SAMPLE.ripe)} ${plural(FIELD_SAMPLE.ripe, 'plant is', 'plants are')} ripe. They do not get riper.`,
    );
  }
  if (counts.wrenchDue > 0) {
    add(
      58,
      'wrench',
      'nudge',
      `${countWord(counts.wrenchDue)} ${plural(counts.wrenchDue, 'machine is', 'machines are')} running rough. Still working — just working worse.`,
    );
  }
  if (counts.starved > 0 && russets === 0) {
    add(56, 'starved', 'nudge', 'The kitchen is idle with nothing to fry.');
  }
  // §2's promotion whisper, verbatim in spirit and computed in fact: hand output this hour
  // against what the purchasable device would have done with the same crops, from its spec.
  // An OBSERVATION — it states two facts and stops; the purchase is the player's inference.
  // Silent once a dock is owned (the whisper's work is done) and silent on a small hour
  // (comparing a machine to four potatoes is nagging, not observing).
  const handPulls = pace.thisHour(view);
  if (handPulls >= WHISPER_MIN_HARVESTS && !ownsHarvesterDock(view)) {
    add(
      55,
      'bot-pace',
      'nudge',
      `You pulled ${countWord(handPulls)} crops by hand this hour. A Harvester Dock's bot would have caught them in ${botCatchUpPhrase(handPulls)}, and it never straightens its back.`,
    );
  }
  if (counts.sprinklers === 0 && stats.totalManualTouches >= 24) {
    add(
      54,
      'touches',
      'nudge',
      `${stats.totalManualTouches} things done by hand so far. A sprinkler does not get tired.`,
    );
  }
  if (FIELD_SAMPLE.bare >= 4 && seeds > 0) {
    add(
      46,
      'bare',
      'nudge',
      `${countWord(FIELD_SAMPLE.bare)} ${plural(FIELD_SAMPLE.bare, 'tile is', 'tiles are')} bare and you are carrying ${countWord(seeds)} ${plural(seeds, 'seed', 'seeds')}.`,
    );
  }
  if (stats.longestHandsFreeTicks >= TICKS_PER_SECOND * 90) {
    const minutes = Math.floor(stats.longestHandsFreeTicks / (TICKS_PER_SECOND * 60));
    add(
      38,
      'hands-free',
      'good',
      `Your longest stretch without touching anything is ${countWord(minutes)} ${plural(minutes, 'minute', 'minutes')}.`,
    );
  }
  if (stats.lifetimeNetEarningsCents > 0) {
    add(
      30,
      'earned',
      'good',
      `${formatCents(stats.lifetimeNetEarningsCents)} netted since you took over the lot.`,
    );
  }
  add(1, 'quiet', 'good', 'Nothing on the lot needs you this second. That is allowed.');

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.slice(0, 3).map((c) => ({ id: c.id, text: c.text, tone: c.tone }));
}

function countOf(view: WorldView, item: ItemId): number {
  for (const slot of view.inventory) {
    if (slot.item === item) return slot.count;
  }
  return 0;
}

function ownsHarvesterDock(view: WorldView): boolean {
  for (const machine of view.machines) {
    if (machine.kind === MachineKind.HarvesterDock) return true;
  }
  return false;
}

/**
 * The stack in the bag with the least time on it, or null when nothing is perishing.
 *
 * ONE NOTE, NOT ONE PER STACK. A player mid-harvest is carrying potatoes, slices and Day-Old
 * produce at once, and three of the Clipboard's three slots spent on three flavours of the same
 * warning would push everything else off the paper — the Clipboard's whole design is that it
 * shows the top three of everything, not the top three of one thing.
 *
 * `-1` is "never" and must not sort as "soonest" (see `freshness.ts`), which is why the
 * comparison is guarded rather than a plain `Math.min`.
 */
function soonestSpoiling(view: WorldView): { item: number; ticksToSpoil: number } | null {
  let item = 0;
  let soonest = -1;
  for (const slot of view.inventory) {
    if (slot.count <= 0 || slot.ticksToSpoil < 0) continue;
    if (soonest >= 0 && slot.ticksToSpoil >= soonest) continue;
    soonest = slot.ticksToSpoil;
    item = slot.item;
  }
  return soonest < 0 ? null : { item, ticksToSpoil: soonest };
}
