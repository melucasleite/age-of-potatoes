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
  ItemId,
  LampState,
  MachineKind,
  TICKS_PER_SECOND,
  itemSpec,
  machineSpec,
} from '@snack/sim';
import type { ItemSpec, WorldView } from '@snack/sim';

import { TOOL_INFO, TOOL_ORDER } from '@/game/input/tools';
import type { ToolMode } from '@/game/input/tools';

import { countWord, formatCents, plural } from './format';
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
    blurb: 'Waters the five tiles around it every five seconds. It never forgets.',
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
      label: ITEM_LABELS[slot.item] ?? 'stuff',
      count: slot.count,
      valueCents: spec === null ? 0 : spec.listPriceCents * slot.count,
      sellable: spec !== null && !spec.sellable ? 0 : 1,
    });
  }
  return items;
}

// --- the toolbelt ------------------------------------------------------------------

export function deriveTools(moneyCents: number, active: ToolMode): ToolSlot[] {
  return TOOL_ORDER.map((tool, index) => {
    const info = TOOL_INFO[tool];
    return {
      tool,
      digit: index + 1,
      label: info.label,
      hint: info.hint,
      costCents: info.costCents,
      affordable: info.costCents === 0 || moneyCents >= info.costCents ? 1 : 0,
      active: tool === active ? 1 : 0,
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

export function deriveClipboard(view: WorldView, counts: MachineCounts): ClipboardNote[] {
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
