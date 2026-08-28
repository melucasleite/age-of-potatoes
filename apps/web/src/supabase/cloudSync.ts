// Save-blob sync: a mirror of the local save, and never the read path the game boots from.
//
// THE LOCAL SAVE IS STILL THE SOURCE OF TRUTH. Accounts are required now (work item 143)
// and every world mirrors to the cloud, but the boot path still reads IndexedDB, the frame
// loop still never waits on the network, and a mid-session outage is still invisible:
// every network error is swallowed, logged once at debug level, and retried with capped
// exponential backoff. What changed is the SCOPE — one row per world (`slot` = the local
// world id) instead of one hardcoded `'default'` row for whichever world was active — and
// the LIFECYCLE: the handle is retained by `bootstrap.ts` so a world exit can flush a final
// push before teardown, and the lot picker reconciles every world through `worldsSync.ts`.
//
// WHAT THE PER-WORLD LOOP DOES, IN FULL:
//   pull, once  — after the session arrives, fetch this world's row and compare it to local
//   push, often — whenever the committed local save's tick has moved, upsert it
//   flush       — one immediate push, awaited by the exit path before the world unmounts
//
// THE CONFLICT RULE, unchanged since work item 016: THE ENVELOPE WITH THE HIGHER `tick`
// WINS, tie-broken by `updated_at`. Ticks are the game's actual clock (§6: an active hour
// is 72,000 ticks) and are monotonic within one world's lineage, which makes them a far
// better ordering key than the wall clock on a machine whose clock we do not control — a
// player whose laptop is set to 2019 still syncs correctly. `updated_at` is written by the
// database, not the client, so even the tie-break does not trust the client's clock. The
// loser is never destroyed: it goes under the world's `conflict` key. See `cloudHandoff.ts`.

import { type SaveEnvelope, parseEnvelope } from '@snack/sim';

import { adoptCloudEnvelope, readRawSaves } from '@/storage';

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseClient } from './client';
import { logDebug, logWarn, once } from './log';
import { getSession } from './session';

/**
 * The pre-143 slot name: one row for "the" world, from the era when only the active world
 * mirrored. Kept ONLY so `worldsSync.ts` can find such a row and adopt it into the world it
 * belongs to. Nothing writes this slot any more.
 */
export const LEGACY_DEFAULT_SLOT = 'default';

export const TABLE = 'saves';

/**
 * How often to look at the committed local save.
 *
 * THIS IS A POLL, NOT A SECOND SAVE TIMER. It reads what `saveWorld` has already written to
 * IndexedDB and pushes only when that record's tick has moved, so it cannot drift from the
 * local save cadence or push a tick the local save has not committed — it observes the
 * local write rather than racing it. Autosave writes every 1,200 ticks (60s of active
 * play), so at 10s this adds at most a few seconds of lag and usually finds nothing to do.
 */
const POLL_MS = 10_000;

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * §12 defers switching to Storage or a typed-array format until saves actually exceed this.
 * Approaching it is a "stop and raise it" event, not a cue to silently change formats.
 */
export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

export interface CloudSyncOptions {
  /** Which world this loop mirrors. Its id is the row's `slot`. */
  worldId: string;
  /**
   * The tick the local world booted at, or null when there was no save. Used to tell "the
   * player has been playing" from "this world is exactly as it was found" when deciding
   * whether adopting a cloud save is safe.
   */
  localTickAtBoot: number | null;
}

export interface CloudSyncHandle {
  stop(): void;
  /**
   * One immediate push of the committed local save, awaited. The exit path calls this after
   * the exit save lands so the cloud row carries the world the player just left, not the
   * one from the last poll. Rejects on network failure — the caller decides how much an
   * exit is allowed to wait (`bootstrap.ts` races it against a timeout).
   */
  flush(): Promise<void>;
}

const INERT: CloudSyncHandle = {
  stop() {},
  flush: () => Promise.resolve(),
};

/**
 * Start mirroring one world's local save to its Supabase row.
 *
 * Returns immediately and always. When Supabase is not configured, when there is no
 * `window`, or when sign-in never completes, the returned handle is inert and the game is
 * none the wiser.
 */
export function startCloudSync(options: CloudSyncOptions): CloudSyncHandle {
  if (typeof window === 'undefined') return INERT;
  if (getSupabaseClient() === null) return INERT;

  const slot = options.worldId;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let pulled = false;
  let lastPushedTick: number | null = null;

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void cycle(), ms);
  };

  const cycle = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runOnce();
      failures = 0;
      schedule(POLL_MS);
    } catch (error) {
      failures += 1;
      // Once per page, not once per attempt. A tab left open behind a captive portal would
      // otherwise print this a few hundred times and train everyone to filter it out.
      once('sync-failing', () => {
        logDebug(
          'Cloud sync is not reaching the server. Retrying quietly in the background.',
          error,
        );
      });
      schedule(backoffMs(failures));
    }
  };

  const runOnce = async (): Promise<void> => {
    const client = getSupabaseClient();
    if (client === null) return;

    const session = await getSession();
    // No session is a retryable condition here, not a fatal one: the sign-in door gates the
    // way IN, but a session can end mid-play (revoked elsewhere, expired refresh token) and
    // the world keeps running locally. Throwing routes it through the same backoff as a
    // network error, and the next successful sign-in picks the mirror back up.
    if (session === null) throw new Error('no session yet');

    const userId = session.user.id;

    if (!pulled) {
      await pull(userId);
      pulled = true;
    }
    await push(userId);
  };

  const pull = async (userId: string): Promise<void> => {
    const client = getSupabaseClient();
    if (client === null) return;

    const row = await fetchSaveRow(client, userId, slot);
    if (row === null) return; // Nothing in the cloud yet. The first push will seed it.

    // NEVER TRUST A ROW ON SIGHT. It is reassembled into an envelope and put through the
    // sim's own `parseEnvelope`, the same validator a save off the disk goes through. A
    // malformed row is treated exactly like a corrupt local save: ignored, not loaded.
    let remote: SaveEnvelope;
    try {
      remote = rowToEnvelope(row);
    } catch (parseError) {
      logWarn('The cloud save row is not a readable envelope. Ignoring it.', parseError);
      return;
    }

    const local = await readLocalEnvelope(options.worldId);

    if (local !== undefined && !remoteWins(remote, local)) {
      logDebug(
        `Local save (tick ${String(local.tick)}) is at or ahead of the cloud copy ` +
          `(tick ${String(remote.tick)}). Keeping local.`,
      );
      return;
    }

    await adoptCloudEnvelope(remote, {
      expectedLocalTick: options.localTickAtBoot,
      worldId: options.worldId,
    });
  };

  const push = async (userId: string): Promise<void> => {
    const client = getSupabaseClient();
    if (client === null) return;

    const envelope = await readLocalEnvelope(options.worldId);
    if (envelope === undefined) return; // Nothing saved locally yet.
    if (lastPushedTick === envelope.tick) return; // Already mirrored. Pushing again is pure cost.

    await pushEnvelope(client, userId, slot, envelope);

    lastPushedTick = envelope.tick;
    logDebug(`Mirrored world ${options.worldId} at tick ${String(envelope.tick)} to the cloud.`);
  };

  // Kick off on a macrotask rather than synchronously: `startCloudSync` is called from the
  // boot path and must return before anything touches the network.
  schedule(0);

  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    async flush() {
      const client = getSupabaseClient();
      if (client === null) return;
      const session = await getSession();
      if (session === null) return; // An exit with no session has nothing to flush to.
      await push(session.user.id);
    },
  };
}

/**
 * The conflict rule, as a pure function so it can be reasoned about without a network.
 *
 * Higher tick wins. On a tie the local copy is kept — with equal ticks the two are the same
 * world at the same moment in all but pathological cases, and churning the disk to swap
 * identical saves is cost with no benefit.
 */
export function remoteWins(remote: SaveEnvelope, local: SaveEnvelope): boolean {
  return remote.tick > local.tick;
}

/** The columns a save row round-trips through, minus the database-owned `updated_at`. */
export interface SaveRow {
  format_version: unknown;
  sim_version: unknown;
  world_seed: unknown;
  tick: unknown;
  payload: unknown;
}

/**
 * One world's row for one user, or null. Exported for `worldsSync.ts`, which walks every
 * slot at the lot picker. Throws on network failure — callers own their retry policy.
 */
export async function fetchSaveRow(
  client: SupabaseClient,
  userId: string,
  slot: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await client
    .from(TABLE)
    .select('format_version, sim_version, world_seed, tick, payload, updated_at')
    .eq('user_id', userId)
    .eq('slot', slot)
    .maybeSingle();
  if (error !== null) throw error;
  return data;
}

/**
 * Upsert one envelope as one row. The single writer for the `saves` table — the poll loop
 * above, the exit flush, and the picker reconciliation all come through here, so the size
 * cap and the "never send `updated_at`" rule cannot drift apart between call sites.
 *
 * Returns false when the envelope was refused for size (said out loud, once); throws on
 * network failure.
 */
export async function pushEnvelope(
  client: SupabaseClient,
  userId: string,
  slot: string,
  envelope: SaveEnvelope,
): Promise<boolean> {
  const bytes = JSON.stringify(envelope.payload).length;
  if (bytes > MAX_PAYLOAD_BYTES) {
    // §12 is explicit that exceeding this is a decision to be made deliberately, not a
    // cue to quietly switch storage formats. So: refuse, say so loudly, keep playing.
    once('payload-too-large', () => {
      logWarn(
        `The save payload is ${String(Math.round(bytes / 1024))} KB, past the ~5 MB line ` +
          'plan §12 draws. Cloud sync is skipping it. This needs a real decision about ' +
          'Storage or a binary format — raise it rather than working around it.',
      );
    });
    return false;
  }

  const { error } = await client.from(TABLE).upsert(
    {
      user_id: userId,
      slot,
      format_version: envelope.formatVersion,
      sim_version: envelope.simVersion,
      // Text on purpose: seeds are uint32 today, and a text column never needs a
      // migration on the day one of them is not.
      world_seed: String(envelope.worldSeed),
      tick: envelope.tick,
      payload: envelope.payload,
      // `updated_at` is deliberately NOT sent. The database sets it, so the conflict
      // tie-break never depends on a client clock we do not control.
    },
    { onConflict: 'user_id,slot' },
  );
  if (error !== null) throw error;
  return true;
}

/** Rebuild an envelope from a row, validated by the sim's own parser. Throws if malformed. */
export function rowToEnvelope(row: Record<string, unknown>): SaveEnvelope {
  return parseEnvelope({
    formatVersion: row['format_version'],
    simVersion: row['sim_version'],
    worldSeed: Number(row['world_seed']),
    tick: Number(row['tick']),
    payload: row['payload'],
  });
}

/** One world's committed local save, or undefined. Never throws — no IndexedDB means no sync. */
export async function readLocalEnvelope(worldId: string): Promise<SaveEnvelope | undefined> {
  try {
    return (await readRawSaves({ worldId })).current;
  } catch {
    return undefined;
  }
}

/** Capped exponential backoff with jitter, so a flapping backend is not retried in lockstep. */
function backoffMs(failures: number): number {
  const capped = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  return capped * (0.5 + Math.random() * 0.5);
}
