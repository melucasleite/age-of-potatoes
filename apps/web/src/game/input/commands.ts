// The command queue: the only door from input into the simulation.
//
// Plan §12: every state mutation enters the world through a `Command` applied at a
// specific tick. Input never calls into world state — it appends here, and `step()` drains
// the queue at a tick boundary. Commands enqueued mid-frame therefore apply on the NEXT
// tick, deterministically, never immediately.
//
// That indirection is what makes *seed + trace* a bug report that reproduces exactly,
// which §12 calls the single most valuable debugging asset a solo dev can have. A click
// that reached into state directly would be invisible to the trace and would make every
// replay from that session a lie.

import type { Command } from '@snack/sim';

const EMPTY: readonly Command[] = [];

export class CommandQueue {
  private pending: Command[] = [];

  /** Enqueue one command. Legality is NOT checked here — the sim decides (§12). */
  push(command: Command): void {
    this.pending.push(command);
  }

  get size(): number {
    return this.pending.length;
  }

  /**
   * Hand over everything queued and clear. Arrival order is preserved and is the order
   * `step()` applies them in; nothing sorts by tile, id, or type, because any of those
   * introduces a tiebreak that differs between engines the first time two entries compare
   * equal.
   */
  drain(): readonly Command[] {
    if (this.pending.length === 0) return EMPTY;
    const out = this.pending;
    this.pending = [];
    return out;
  }

  clear(): void {
    this.pending.length = 0;
  }
}
