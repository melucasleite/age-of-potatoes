// Where the money went, per machine, phrased in cash.
//
// Plan §5 sets the rule this file exists to obey: "alerts only when money bleeds >60s,
// phrased in cash ('Fryer B idle 6 min — $14 wasted')". Both halves of that are load-bearing
// — the sixty seconds keeps the game from nagging, and the cash phrasing is what makes an
// idle lamp mean something to a player who has not yet learned to read lamps.
//
// HOW THE COST IS MEASURED, AND WHY NOT THE OBVIOUS WAY. The obvious way is to price idle
// time at the machine's RATED throughput: a Fryer converts $4.50 of slices into $9.00 of
// chips every sixty ticks, so six idle minutes "cost" $540. That number is enormous, it is
// wrong, and it is wrong in the direction that destroys trust — plan §4 puts a well-run
// hour-6 factory at about $370/hr TOTAL, so a single flag claiming $540 tells the player the
// report cannot count. The rated figure is wrong because the line is never fed at its rated
// rate: the field is the bottleneck, not the machines.
//
// So idle time is priced at the machine's REALISED rate — the value it added per tick over
// the ticks it actually spent running, this day, on this lot. A machine that has never
// completed an operation has no realised rate and is never flagged, which is exactly right:
// a Fryer you built ninety seconds ago and have not fed yet is not bleeding money, it is
// new.
//
// Operations are counted by watching `progressPermille` FALL. Progress climbs to 1000 and
// resets on completion, the fastest machine in the game takes thirty ticks per operation,
// and the HUD hears from the world every third tick — so a completion cannot hide between
// two readings. If one ever did, the count is low and the flag under-claims, which is the
// safe direction for a number the player is being asked to believe.

import { LampState, TICKS_PER_SECOND, listPriceCents, machineSpec } from '@snack/sim';
import type { ItemId, MachineKind, MachineView, WorldView } from '@snack/sim';

import type { InefficiencyFlag } from './types';

/** Plan §5's threshold. Below a minute of continuous bleed, the game says nothing. */
export const BLEED_THRESHOLD_TICKS = 60 * TICKS_PER_SECOND;

/**
 * A machine standing still with work it could be doing.
 *
 * `UtilityMissing` is deliberately absent: it is the sprinkler's empty barrel, sprinklers
 * add no item value, and every path below would price them at zero anyway. Leaving them out
 * of the set says so once instead of relying on the arithmetic to say it quietly.
 */
function isIdle(lamp: number): boolean {
  return (
    lamp === LampState.Starved ||
    lamp === LampState.Blocked ||
    lamp === LampState.Jammed ||
    lamp === LampState.Halted
  );
}

interface MachineWatch {
  kind: number;
  /** "Fryer B" — the letter is its rank among machines of the same kind, by id. */
  label: string;
  /** Cents of value one completed operation adds. Output at list minus input at list. */
  valueAddedPerOp: number;
  /** Ticks spent with the green lamp, this day. */
  runTicks: number;
  /** Operations completed while running, this day. */
  ops: number;
  /** Ticks of the CURRENT unbroken idle run. Reset the moment it runs again. */
  idleTicks: number;
  /** Ticks idle across the whole day, whether or not unbroken. */
  dayIdleTicks: number;
  lastProgress: number;
}

/**
 * One flag per Dawn Report, never a list.
 *
 * The Clipboard's observations are "never quests" (§2), and a card that hands the player
 * five jobs at sunrise is a chore list with a sunrise on it. The single worst bleed wins;
 * everything else is a lamp the player can already see.
 */
export class IdleWatch {
  private readonly watches = new Map<number, MachineWatch>();
  private lastTick = -1;

  reset(): void {
    this.watches.clear();
    this.lastTick = -1;
  }

  /** A new day: the flag is about the day just ended, so the counters start over. */
  rollDay(): void {
    for (const watch of this.watches.values()) {
      watch.runTicks = 0;
      watch.ops = 0;
      watch.dayIdleTicks = 0;
      // `idleTicks` deliberately survives the roll. A machine that has been starved since
      // before dawn is still starved after it, and zeroing the run would make the game
      // forget a genuine bleed once every eight minutes.
    }
  }

  observe(view: WorldView): void {
    const tick = view.tick;
    if (tick < this.lastTick) this.reset();
    const elapsed = this.lastTick < 0 ? 0 : tick - this.lastTick;
    this.lastTick = tick;

    const seen = new Set<number>();
    const letters = new Map<number, number>();

    for (let i = 0; i < view.machines.length; i++) {
      const machine = view.machines[i]!;
      seen.add(machine.id);

      // Machines project sorted by id, so the nth machine of a kind gets the nth letter and
      // "Fryer B" means the same machine every time the report is drawn.
      const rank = letters.get(machine.kind) ?? 0;
      letters.set(machine.kind, rank + 1);

      let watch = this.watches.get(machine.id);
      if (watch === undefined) {
        watch = {
          kind: machine.kind,
          label: '',
          valueAddedPerOp: valueAddedPerOp(machine),
          runTicks: 0,
          ops: 0,
          idleTicks: 0,
          dayIdleTicks: 0,
          lastProgress: machine.progressPermille,
        };
        this.watches.set(machine.id, watch);
      }
      watch.label = `${kindLabel(machine.kind)} ${letter(rank)}`;
      // Dials change what a machine is worth per tick, never per operation — but a machine
      // can be moved onto a different recipe by nothing at all, so this is re-read rather
      // than cached at construction.
      watch.valueAddedPerOp = valueAddedPerOp(machine);

      if (machine.progressPermille < watch.lastProgress) watch.ops += 1;
      watch.lastProgress = machine.progressPermille;

      if (isIdle(machine.lamp)) {
        watch.idleTicks += elapsed;
        watch.dayIdleTicks += elapsed;
      } else {
        watch.idleTicks = 0;
        if (machine.lamp === LampState.Running) watch.runTicks += elapsed;
      }
    }

    // A machine that was sold or scrapped stops being a story about wasted money.
    for (const id of this.watches.keys()) {
      if (!seen.has(id)) this.watches.delete(id);
    }
  }

  /**
   * The single worst bleed, or null on a day where nothing stood still for a minute.
   *
   * Null is a real answer and the card prints it as one. "Nothing sat idle for more than a
   * minute" is the nicest sentence in the game and it should not be replaced by the least
   * bad complaint available.
   */
  worst(): InefficiencyFlag | null {
    let best: InefficiencyFlag | null = null;
    let bestCost = 0;

    for (const [id, watch] of this.watches) {
      if (watch.idleTicks < BLEED_THRESHOLD_TICKS) continue;
      if (watch.ops <= 0 || watch.runTicks <= 0 || watch.valueAddedPerOp <= 0) continue;

      // Realised value per tick × idle ticks, in one integer expression so the division
      // happens last and a slow machine does not floor its own rate to zero.
      const cost = Math.floor(
        (watch.valueAddedPerOp * watch.ops * watch.idleTicks) / watch.runTicks,
      );
      if (cost <= bestCost) continue;

      bestCost = cost;
      best = {
        id: `idle-${id}`,
        text: `${watch.label} idle ${minutes(watch.idleTicks)}`,
        costCents: cost,
      };
    }

    return best;
  }
}

/** Cents one completed operation adds: what comes out at list, less what went in at list. */
function valueAddedPerOp(machine: MachineView): number {
  // `MachineView.kind` is a plain number by design — the projection is structured-cloneable
  // data and carries no branded types across the seam. Widening it back is this reader's job.
  const spec = machineSpec(machine.kind as MachineKind);
  if (spec === null || spec.outputItem === null) return 0;
  const out = listPriceCents(spec.outputItem);
  // Recipes are multi-input since the soda line (`inputs: RecipeInput[]`); the value a
  // machine adds is its output at list less EVERY input line at list. Liquids drawn from
  // ports are deliberately not counted — water has no list price, and juice/syrup cost is
  // already paid at the machine that consumed the cane.
  let inn = 0;
  for (const line of spec.inputs) inn += listPriceCents(line.item) * line.count;
  return out - inn;
}

const KIND_LABELS: Readonly<Record<number, string>> = {
  1: 'Sell bin',
  2: 'Chip Kitchen',
  3: 'Sprinkler',
  4: 'Washer',
  5: 'Slicer',
  6: 'Fryer',
  7: 'Seasoner',
  8: 'Bagger',
};

function kindLabel(kind: number): string {
  return KIND_LABELS[kind] ?? 'Machine';
}

/** A, B, C… and then plain numbers, because "Fryer AB" helps nobody. */
function letter(rank: number): string {
  return rank < 26 ? String.fromCharCode(65 + rank) : `#${rank + 1}`;
}

function minutes(ticks: number): string {
  const total = Math.floor(ticks / TICKS_PER_SECOND);
  if (total < 120) return `${total} sec`;
  return `${Math.floor(total / 60)} min`;
}
