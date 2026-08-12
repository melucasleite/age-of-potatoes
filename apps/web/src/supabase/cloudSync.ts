// Save-blob sync: a mirror of the local save, and never the read path the game boots from.
//
// THE SERVER IS NEVER LOAD-BEARING. Plan §11: "Deliberately small. Nothing about the game
// requires the server to be up." Nothing in this file is awaited by boot, by the frame
// loop, or by the local save path. Every network error is swallowed, logged once at debug
// level, and retried with capped exponential backoff. There is no toast, no modal, and no
// blocked input — a player with the network off must not be able to tell this exists.
//
// WHAT IT DOES, IN FULL:
//   pull, once  — after the session arrives, fetch the row and compare it to local
//   push, often — whenever the committed local save's tick has moved, upsert it
//
// THE CONFLICT RULE, decided here as work item 016 asks: THE ENVELOPE WITH THE HIGHER
// `tick` WINS, tie-broken by `updated_at`. Ticks are the game's actual clock (§6: an active
// hour is 72,000 ticks) and are monotonic within one world's lineage, which makes them a
// far better ordering key than the wall clock on a machine whose clock we do not control —
// a player whose laptop is set to 2019 still syncs correctly. `updated_at` is written by
// the database, not the client, so even the tie-break does not trust the client's clock.
// The loser is never destroyed: it goes under the `conflict` key. See `cloudHandoff.ts`.

import { type SaveEnvelope, parseEnvelope } from '@snack/sim';

import { adoptCloudEnvelope, readRawSaves } from '@/storage';

import { getSupabaseClient } from './client';
import { logDebug, logWarn, once } from './log';
import { getSession } from './session';

/** One row per player per slot. §6 locks one persistent world, so there is exactly one slot. */
export const DEFAULT_SLOT = 'default';

const TABLE = 'saves';

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
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

export interface CloudSyncOptions {
  /**
   * The tick the local world booted at, or null when there was no save. Used to tell "the
   * player has been playing" from "this world is exactly as it was found" when deciding
   * whether adopting a cloud save is safe.
   */
  localTickAtBoot: number | null;
  slot?: string;
}

export interface CloudSyncHandle {
  stop(): void;
}

const INERT: CloudSyncHandle = { stop() {} };

/**
 * Start mirroring the local save to Supabase.
 *
 * Returns immediately and always. When Supabase is not configured, when there is no
 * `window`, or when sign-in never completes, the returned handle is inert and the game is
 * none the wiser.
 */
export function startCloudSync(options: CloudSyncOptions): CloudSyncHandle {
  if (typeof window === 'undefined') return INERT;
  if (getSupabaseClient() === null) return INERT;

  const slot = options.slot ?? DEFAULT_SLOT;

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
    // No session yet is a retryable condition, not a permanent one — the player may simply
    // be offline right now. Throwing routes it through the same backoff as a network error.
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

    const { data, error } = await client
      .from(TABLE)
      .select('format_version, sim_version, world_seed, tick, payload, updated_at')
      .eq('user_id', userId)
      .eq('slot', slot)
      .maybeSingle();

    if (error !== null) throw error;
    if (data === null) return; // Nothing in the cloud yet. The first push will seed it.

    // NEVER TRUST A ROW ON SIGHT. It is reassembled into an envelope and put through the
    // sim's own `parseEnvelope`, the same validator a save off the disk goes through. A
    // malformed row is treated exactly like a corrupt local save: ignored, not loaded.
    let remote: SaveEnvelope;
    try {
      remote = rowToEnvelope(data);
    } catch (parseError) {
      logWarn('The cloud save row is not a readable envelope. Ignoring it.', parseError);
      return;
    }

    const local = await readLocalEnvelope();

    if (local !== undefined && !remoteWins(remote, local)) {
      logDebug(
        `Local save (tick ${String(local.tick)}) is at or ahead of the cloud copy ` +
          `(tick ${String(remote.tick)}). Keeping local.`,
      );
      return;
    }

    await adoptCloudEnvelope(remote, { expectedLocalTick: options.localTickAtBoot });
  };

  const push = async (userId: string): Promise<void> => {
    const client = getSupabaseClient();
    if (client === null) return;

    const envelope = await readLocalEnvelope();
    if (envelope === undefined) return; // Nothing saved locally yet.
    if (lastPushedTick === envelope.tick) return; // Already mirrored. Pushing again is pure cost.

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
      return;
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

    lastPushedTick = envelope.tick;
    logDebug(`Mirrored the save at tick ${String(envelope.tick)} to the cloud.`);
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

/** Rebuild an envelope from a row, validated by the sim's own parser. Throws if malformed. */
function rowToEnvelope(row: Record<string, unknown>): SaveEnvelope {
  return parseEnvelope({
    formatVersion: row['format_version'],
    simVersion: row['sim_version'],
    worldSeed: Number(row['world_seed']),
    tick: Number(row['tick']),
    payload: row['payload'],
  });
}

/** The committed local save, or undefined. Never throws — no IndexedDB just means no sync. */
async function readLocalEnvelope(): Promise<SaveEnvelope | undefined> {
  try {
    return (await readRawSaves()).current;
  } catch {
    return undefined;
  }
}

/** Capped exponential backoff with jitter, so a flapping backend is not retried in lockstep. */
function backoffMs(failures: number): number {
  const capped = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  return capped * (0.5 + Math.random() * 0.5);
}
