// The state of the lot: what is drooping, what has turned, and what that is costing.
//
// WHY ONE SLICE AND NOT TWO. This file feeds two panels that ask the same question from
// opposite ends of a session. The zone card ([[021]]) asks "what is happening in my field
// right now"; the Welcome Back card ([[040]]) asks "what happened to my field while I was
// gone". Both are answered by one sweep of the projection, and splitting them would mean
// walking the field twice per publish to produce two views of the same sixty numbers.
//
// THE SIXTY SECONDS IS THE FEATURE, NOT AN IMPLEMENTATION DETAIL. Plan §5: "alerts only
// when money bleeds >60s, phrased in cash." An alert that fires the instant one plant
// droops is noise, and noise gets ignored — which is strictly worse than no alert at all,
// because it also teaches the player to ignore the next one. `RiskWatch` below is the whole
// mechanism, and it is deliberately the largest commented thing in the file.
//
// IT COUNTS TICKS, NOT SECONDS. `Date.now()` would keep running while the tab is in the
// background, so a player who alt-tabbed for two minutes would come back to an alert about
// a bleed that never happened — nothing wilted, because §6's ticks only accrue while the
// player is present. Ticks are the only clock that agrees with the thing being measured.
//
// WHAT "AT RISK" MEANS, AND WHY IT IS THE SMALL NUMBER. `reports/idle.ts` sets the house
// discipline for cash-phrased alerts at length: price the loss at what is REALLY forgone,
// never at the impressive figure, because a number the player can tell is inflated makes
// every other number in the HUD suspect. So this is not the value of the crop — the crop is
// never destroyed, and plan §4 is emphatic that nothing ever vanishes. It is only the
// DIFFERENCE the player can still recover by walking over there:
//
//   drooping (`Wilting`) — still harvests at full price (`tick.ts` halves the price only at
//                          `Wilted`), so the risk is the discount about to be eaten:
//                          list − Day-Old.
//   turned   (`Wilted`)  — already sells at Day-Old, and collapses to compost if left, so
//                          the risk is Day-Old minus what the compost is worth.
//
// Both terms are floored at zero and neither counts the harvest bonus roll, so the figure
// under-claims by design. A player who acts on it is never disappointed by the payout.

import {
  COMPOST_PER_CROP,
  CropId,
  ItemId,
  LampState,
  MachineKind,
  TICKS_PER_SECOND,
  WILT_GRACE_TICKS,
  WILT_WINDOW_TICKS,
  WiltStage,
  cropSpec,
  dayOldPriceCents,
  listPriceCents,
} from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { formatCentsWhole, plural } from './format';
import type { LotAlert, ZoneRow } from './types';

/**
 * Plan §5's threshold, in ticks. Shares its value with `reports/idle.ts`'s constant of the
 * same name and is deliberately NOT imported from it: that module belongs to the reports
 * layer, and a HUD panel reaching across for a number would couple two features that only
 * happen to agree. The plan is the shared source, not the other file.
 */
export const BLEED_THRESHOLD_TICKS = 60 * TICKS_PER_SECOND;

/** What one tile's worth of compost fetches, if the crop is left to collapse into it. */
const COMPOST_VALUE_CENTS = COMPOST_PER_CROP * listPriceCents(ItemId.Compost);

/**
 * The tick a matured crop turns Day-Old, on its own clock (`readyAge`). The one boundary the
 * DEADLINE phrasing below counts down to — `wiltStageForAge`'s middle fence, restated from
 * the same two exported constants so it cannot drift from the sim's.
 */
const TURNS_AT_AGE = WILT_GRACE_TICKS + WILT_WINDOW_TICKS;

export interface LotFields {
  zones: ZoneRow[];
  wilting: number;
  wilted: number;
  atRiskCents: number;
  /**
   * The slice of `atRiskCents` on crops within ~60 seconds of TURNING Day-Old ([[021]]'s
   * alert copy). When this is non-zero the alert stops describing a slow bleed and states
   * the deadline — "$N of crops wilt in about a minute" — because a discount that lands in
   * under a minute is a different sentence from one that has merely been possible for one.
   */
  imminentCents: number;
  compost: number;
  alert: LotAlert | null;
  machines: number;
  running: number;
  halted: number;
  jammed: number;
  starved: number;
  blocked: number;
  sprinklers: number;
}

export function createLotFields(): LotFields {
  return {
    zones: [],
    wilting: 0,
    wilted: 0,
    atRiskCents: 0,
    imminentCents: 0,
    compost: 0,
    alert: null,
    machines: 0,
    running: 0,
    halted: 0,
    jammed: 0,
    starved: 0,
    blocked: 0,
    sprinklers: 0,
  };
}

/**
 * How long the lot has had money bleeding out of it, in ticks.
 *
 * Held by the store rather than recomputed, because "has this been true for a minute" is the
 * one question a stateless projection cannot answer. Reset on `claim()` so a reloaded world
 * does not inherit the previous world's grudge.
 */
export class RiskWatch {
  /** The tick value first went at risk, or -1 while nothing is. */
  private since = -1;
  private lastTick = -1;

  reset(): void {
    this.since = -1;
    this.lastTick = -1;
  }

  /**
   * Fold this publish into the run, and answer whether the alert has earned the right to
   * speak. Returns the ticks the current bleed has lasted, or -1 when nothing is at risk.
   */
  observe(tick: number, atRiskCents: number): number {
    // Time ran backwards: a save was loaded, or the host handed us a different world. The
    // old run described a field that no longer exists.
    if (tick < this.lastTick) this.reset();
    this.lastTick = tick;

    if (atRiskCents <= 0) {
      this.since = -1;
      return -1;
    }
    if (this.since < 0) this.since = tick;
    return tick - this.since;
  }

  armed(tick: number, atRiskCents: number): boolean {
    return this.observe(tick, atRiskCents) >= BLEED_THRESHOLD_TICKS;
  }
}

/** Per-zone risk accumulator, reused across publishes so the sweep allocates nothing. */
const ZONE_RISK = new Map<number, number>();

/** Its deadline twin: per-zone cents on crops within a minute of turning. */
const ZONE_IMMINENT = new Map<number, number>();

/**
 * One pass over the field and one over the machines.
 *
 * The per-zone wilt counts are ALSO published by the sim (`view.zones`), and those are the
 * ones the zone rows use — the sim owns what a zone contains. What the sim cannot publish is
 * the cash value, because `packages/sim` deals in cents but has no opinion about which of
 * them are "at risk"; that is a phrasing decision and phrasing decisions live over here.
 */
export function deriveLot(view: WorldView, watch: RiskWatch, out: LotFields): LotFields {
  const field = view.field;
  ZONE_RISK.clear();
  ZONE_IMMINENT.clear();

  let wilting = 0;
  let wilted = 0;
  let atRisk = 0;
  let imminent = 0;
  let compost = 0;

  for (let i = 0; i < field.crop.length; i++) {
    compost += field.compost[i] ?? 0;

    const crop = field.crop[i] ?? CropId.None;
    if (crop === CropId.None) continue;

    const stage = field.wilt[i] ?? WiltStage.Fresh;
    if (stage === WiltStage.Fresh) continue;

    // The sim's own baseline yield for the tile. The +0/+1 harvest bonus is a roll and is
    // deliberately left out — see the header: this figure under-claims on purpose.
    const count = Math.max(1, field.fertility[i] ?? 1);
    const tileRisk = riskForTile(crop, stage, count);

    if (stage === WiltStage.Wilted) wilted += 1;
    else wilting += 1;

    atRisk += tileRisk;

    // Within a minute of going Day-Old? `readyAge` is the crop's own clock; the fence is the
    // sim's (`TURNS_AT_AGE`), and the window is the same sixty seconds every alert here runs
    // on. Only a DROOPING crop has this deadline — a turned one is already paying it.
    const turnsIn = stage === WiltStage.Wilting ? TURNS_AT_AGE - (field.readyAge[i] ?? 0) : -1;
    const isImminent = turnsIn >= 0 && turnsIn <= BLEED_THRESHOLD_TICKS;
    if (isImminent) imminent += tileRisk;

    const zoneId = field.zone[i] ?? 0;
    if (zoneId !== 0 && tileRisk > 0) {
      ZONE_RISK.set(zoneId, (ZONE_RISK.get(zoneId) ?? 0) + tileRisk);
      if (isImminent) ZONE_IMMINENT.set(zoneId, (ZONE_IMMINENT.get(zoneId) ?? 0) + tileRisk);
    }
  }

  out.wilting = wilting;
  out.wilted = wilted;
  out.atRiskCents = atRisk;
  out.imminentCents = imminent;
  out.compost = compost;

  out.zones.length = 0;
  for (const zone of view.zones) {
    out.zones.push({
      id: zone.id,
      name: zone.name,
      tiles: zone.tiles,
      planted: zone.planted,
      mature: zone.mature,
      wilting: zone.wilting,
      wilted: zone.wilted,
      dry: zone.dry,
      compost: zone.compost,
      atRiskCents: ZONE_RISK.get(zone.id) ?? 0,
      imminentCents: ZONE_IMMINENT.get(zone.id) ?? 0,
    });
  }

  censusMachines(view, out);

  out.alert = watch.armed(view.tick, atRisk) ? buildAlert(out) : null;
  return out;
}

function censusMachines(view: WorldView, out: LotFields): void {
  out.machines = 0;
  out.running = 0;
  out.halted = 0;
  out.jammed = 0;
  out.starved = 0;
  out.blocked = 0;
  out.sprinklers = 0;

  for (const machine of view.machines) {
    // The sell bin is scenery with a lamp, not a machine the player runs. Counting it would
    // make "3 machines" mean something different from what the player can see standing there.
    if (machine.kind === MachineKind.SellBin) continue;
    out.machines += 1;
    if (machine.kind === MachineKind.Sprinkler) out.sprinklers += 1;
    switch (machine.lamp) {
      case LampState.Running:
        out.running += 1;
        break;
      case LampState.Halted:
        out.halted += 1;
        break;
      case LampState.Jammed:
        out.jammed += 1;
        break;
      case LampState.Starved:
        out.starved += 1;
        break;
      case LampState.Blocked:
        out.blocked += 1;
        break;
      default:
        break;
    }
  }
}

/**
 * The one alert, phrased in cash.
 *
 * ONE, NEVER A LIST — the same ruling `reports/idle.ts` makes for the Dawn Report, for the
 * same reason: a HUD that hands the player five jobs has become a chore list, and plan §2's
 * Clipboard rule ("observations, never quests") does not stop applying because the text is
 * urgent. So the worst zone speaks and the rest are counted in it.
 *
 * The money comes first in the sentence's weight and last in its word order, which is where
 * the eye lands. "$84 at risk" is the part a player who reads three words will read.
 *
 * TWO TENSES, ONE SLOT. With a real deadline inside the next minute the alert switches to
 * [[021]]'s copy — "$N of crops wilt in about a minute" — and N is the imminent slice only,
 * priced by the same under-claiming rule as everything else (the discount about to be eaten,
 * never the crop). The sixty-second ARMING is unchanged either way: a drooping window is five
 * minutes long, so by the time any crop is a minute from turning the bleed has been running
 * for four — the deadline phrasing cannot fire early, only speak more plainly.
 */
function buildAlert(lot: LotFields): LotAlert | null {
  if (lot.atRiskCents <= 0) return null;

  let worst: ZoneRow | null = null;
  for (const zone of lot.zones) {
    if (zone.atRiskCents <= 0) continue;
    if (worst === null || zone.atRiskCents > worst.atRiskCents) worst = zone;
  }

  // No zones painted — which is every new player, since `createWorld` starts with none. The
  // lot-wide figure is the honest fallback; the alternative is a player whose crops are
  // rotting being told nothing because they never drew a rectangle.
  if (worst === null) {
    const count = lot.wilting + lot.wilted;
    if (lot.imminentCents > 0) {
      return {
        id: 'wilt-lot',
        text: deadlinePhrase(lot.imminentCents),
        costCents: lot.imminentCents,
      };
    }
    return {
      id: 'wilt-lot',
      text: `${phrase(count, lot.wilting, lot.wilted)} — ${formatCentsWhole(lot.atRiskCents)} at risk`,
      costCents: lot.atRiskCents,
    };
  }

  if (worst.imminentCents > 0) {
    return {
      id: `wilt-zone-${worst.id}`,
      text: `${worst.name}: ${deadlinePhrase(worst.imminentCents)}`,
      costCents: worst.imminentCents,
    };
  }

  const count = worst.wilting + worst.wilted;
  return {
    id: `wilt-zone-${worst.id}`,
    text: `${worst.name}: ${phrase(count, worst.wilting, worst.wilted)} — ${formatCentsWhole(worst.atRiskCents)} at risk`,
    costCents: worst.atRiskCents,
  };
}

/** "$8 of crops wilt in about a minute" — the deadline tense, cash first ([[021]]). */
function deadlinePhrase(imminentCents: number): string {
  return `${formatCentsWhole(imminentCents)} of crops wilt in about a minute`;
}

/**
 * "12 crops going Day-Old" — a statement about the field, not an instruction.
 *
 * Split three ways because "going Day-Old" is a lie once they have already gone: a crop that
 * has turned is not heading anywhere, it is sitting there getting closer to being compost,
 * and telling the player it is "going" would misdescribe the deadline they are actually up
 * against.
 */
function phrase(count: number, wilting: number, wilted: number): string {
  const crops = `${count} ${plural(count, 'crop', 'crops')}`;
  if (wilted === 0) return `${crops} going Day-Old`;
  if (wilting === 0) return `${crops} sitting Day-Old, rotting down`;
  return `${crops} going Day-Old`;
}

/** Cents recoverable by harvesting this tile now rather than leaving it. Never negative. */
function riskForTile(crop: number, stage: number, count: number): number {
  const spec = cropSpec(crop as CropId);
  if (spec === null) return 0;

  const list = listPriceCents(spec.yieldItem);
  const dayOld = dayOldPriceCents(spec.yieldItem);

  if (stage === WiltStage.Wilting) return Math.max(0, (list - dayOld) * count);
  return Math.max(0, dayOld * count - COMPOST_VALUE_CENTS);
}
