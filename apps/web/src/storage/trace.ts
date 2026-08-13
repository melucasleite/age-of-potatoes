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
 * STILL ONE CURSOR, even now that worlds are plural (work item 055) — because only one world
 * is ever loaded in a page. Switching lots is a navigation that tears the page down, so the
 * next world starts from a fresh module and a fresh cursor by construction. The `cursorSeed`
 * guard below was already the belt to that braces: a drain for a seed the cursor does not
 * recognise resets first, so even a hot-swap that nobody has written could not append this
 * world's tail to that world's log.
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
 *
 * `worldSeed` filters to one world. Pass it for anything that claims to be a replay: with
 * several lots on one machine the store holds several worlds' batches interleaved by
 * insertion order, and a "replay" built from all of them is a replay of nothing.
 */
export async function readTrace(worldSeed?: number): Promise<TraceBatch[]> {
  const db = await getDb();
  const all = await db.getAll(TRACES_STORE);
  return worldSeed === undefined ? all : all.filter((batch) => batch.worldSeed === worldSeed);
}

/** The whole trace flattened, for handing to a replay harness or pasting into a bug report. */
export async function exportTrace(
  worldSeed?: number,
): Promise<{ tick: number; command: unknown }[]> {
  const batches = await readTrace(worldSeed);
  const flat: { tick: number; command: unknown }[] = [];
  for (const batch of batches) {
    for (const entry of batch.entries) flat.push(entry);
  }
  return flat;
}

/**
 * Wipe the whole log, every world's.
 *
 * The quota ladder's first rung, and the one caller for which "every world's" is correct —
 * being out of disk is not a per-world condition. Everything else should use
 * `clearTraceForWorld`.
 */
export async function clearTrace(): Promise<void> {
  const db = await getDb();
  await db.clear(TRACES_STORE);
  persistedCount = 0;
  cursorSeed = null;
}

/**
 * Wipe one world's batches and leave every other world's alone.
 *
 * A cursor rather than a key range: batches are auto-incremented, so `worldSeed` is a field
 * inside the value and there is no index over it. There are a handful of batches per session
 * and this runs when a world is being started or collected, never in the frame loop.
 */
export async function clearTraceForWorld(worldSeed: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(TRACES_STORE, 'readwrite');
  let cursor = await tx.objectStore(TRACES_STORE).openCursor();
  while (cursor !== null) {
    if (cursor.value.worldSeed === worldSeed) await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
  if (cursorSeed === worldSeed) {
    persistedCount = 0;
    cursorSeed = null;
  }
}
