// The append-only input trace, in its own object store.
//
// WHY IT IS NOT IN THE SAVE PAYLOAD: it grows without bound over a persistent world, it is
// not save-compatibility surface, and rewriting the whole log on every autosave would make
// each save progressively more expensive for no benefit at all. Keep it separate and
// exportable.
//
// WHY IT EXISTS AT ALL: seed + trace is a bug report that reproduces exactly — the single
// most valuable debugging asset a solo dev can have (plan §12). It is not anti-cheat code
// and must not be deleted as such; leaderboards are only lightly validated.
//
// The sim appends to `state.trace` in memory. This module drains the tail of that array into
// IndexedDB and never mutates it, because the trace is append-only and the sim owns it.

import type { WorldState } from '@snack/sim';

import { type TraceBatch, TRACES_STORE, getDb } from './db';

/**
 * How far into `state.trace` has already been written.
 *
 * Module-level because §6 locks one persistent world per player — there is never a second
 * world to keep a second cursor for. Reset by `resetTraceCursor()` on load and on a fresh
 * world, where `state.trace` starts empty again.
 */
let persistedCount = 0;
let cursorSeed: number | null = null;

export function resetTraceCursor(worldSeed: number): void {
  persistedCount = 0;
  cursorSeed = worldSeed;
}

/** How many entries of the current session's trace are already on disk. */
export function tracePersistedCount(): number {
  return persistedCount;
}

/**
 * Write everything appended since the last drain. Returns how many entries were written.
 *
 * Never throws for "nothing to do" — an idle world drains zero entries and that is the
 * common case.
 */
export async function drainTrace(state: WorldState): Promise<number> {
  if (cursorSeed !== state.worldSeed) resetTraceCursor(state.worldSeed);

  const from = persistedCount;
  const total = state.trace.length;
  if (total <= from) return 0;

  const entries: TraceBatch['entries'] = [];
  for (let i = from; i < total; i++) {
    const entry = state.trace[i]!;
    entries.push({ tick: entry.tick, command: entry.command });
  }

  const db = await getDb();
  await db.add(TRACES_STORE, { worldSeed: state.worldSeed, fromIndex: from, entries });
  persistedCount = total;
  return entries.length;
}

/**
 * Every stored batch, in insertion order — which is application order, which is replay
 * order. Batches from earlier sessions come first; `fromIndex` restarts at 0 each session
 * because the in-memory trace does, so concatenating `entries` across batches is the replay.
 */
export async function readTrace(): Promise<TraceBatch[]> {
  const db = await getDb();
  return db.getAll(TRACES_STORE);
}

/** The whole trace flattened, for handing to a replay harness or pasting into a bug report. */
export async function exportTrace(): Promise<{ tick: number; command: unknown }[]> {
  const batches = await readTrace();
  const flat: { tick: number; command: unknown }[] = [];
  for (const batch of batches) {
    for (const entry of batch.entries) flat.push(entry);
  }
  return flat;
}

/** Wipe the log. Only for starting a genuinely new world. */
export async function clearTrace(): Promise<void> {
  const db = await getDb();
  await db.clear(TRACES_STORE);
  persistedCount = 0;
  cursorSeed = null;
}
