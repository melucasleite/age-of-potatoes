// The gate that keeps an unconfigured build from paying for a backend it does not have —
// and, since work item 143, the keeper of the one live sync handle.
//
// THIS MODULE MUST NOT STATICALLY IMPORT `./client`, `./cloudSync`, OR
// `@supabase/supabase-js`. It is imported by the storage boot path, and the whole point of
// its existence is that a build with no Supabase env vars never fetches the SDK chunk at
// all — not "loads it and does nothing with it", but never requests it. The dynamic import
// below is load-bearing; turning it into a top-level import silently adds ~100 KB to every
// player's first load in exchange for nothing. (An unconfigured build shows the "cloud is
// not configured" screen rather than the game now, so the gate mostly protects that screen
// — but that screen is exactly the page that must stay cheap.)
//
// WHY THE HANDLE LIVES HERE. `startCloudSync` used to be fire-and-forget: nothing retained
// the handle, so nothing could flush a final push when a world exited — the cloud row was
// always up to a poll interval behind the exit save. The handle is module state now, one
// per page, swapped when the booted world changes: `bootWorld` starts it, and the ordered
// exit (`storage/exit.ts`) flushes and stops it strictly after the exit save lands.

import { isCloudSyncConfigured } from './env';

export interface CloudSyncBootOptions {
  /** Which world to mirror. Its id is the cloud row's slot. */
  worldId: string;
  /** The tick the local world booted at, or null when there was no save. */
  localTickAtBoot: number | null;
}

/** The retained handle's shape, structurally identical to `cloudSync.ts`'s. Declared here
 * rather than imported so this module keeps its no-static-SDK-import property. */
interface RetainedHandle {
  stop(): void;
  flush(): Promise<void>;
}

let handle: RetainedHandle | null = null;

/**
 * How long an exit is allowed to wait for the final cloud push. Beyond this the exit
 * proceeds anyway: the local save is already written and verified, the poll loop's next
 * page will reconcile, and a player must never be trapped in a world by a dead network.
 */
const EXIT_FLUSH_TIMEOUT_MS = 5_000;

/**
 * Start cloud sync if — and only if — there is a backend configured to sync to. Stops and
 * replaces any previous world's loop: one page, one live mirror, the booted world's.
 *
 * FIRE AND FORGET. Returns a promise purely so callers can `void` it explicitly; nothing in
 * the boot path may await it, and it never rejects.
 */
export async function startCloudSyncIfConfigured(options: CloudSyncBootOptions): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!isCloudSyncConfigured()) return;

  try {
    const { startCloudSync } = await import('./cloudSync');
    handle?.stop();
    handle = startCloudSync({
      worldId: options.worldId,
      localTickAtBoot: options.localTickAtBoot,
    });
  } catch {
    // A chunk that fails to load is exactly as survivable as a server that is down.
    // Deliberately silent: this is reached only when the network is already failing.
  }
}

/**
 * Push the running world's committed save to its row right now, best-effort, bounded.
 *
 * THE EXIT'S HOOK (`storage/exit.ts`): called after the exit save is written and verified,
 * before teardown, so the cloud row leaves this page carrying the world the player just
 * left. Never rejects and never blocks longer than `EXIT_FLUSH_TIMEOUT_MS` — the local
 * save is the source of truth and is already safe; this is the mirror catching up.
 */
export async function flushCloudSyncIfRunning(): Promise<void> {
  const current = handle;
  if (current === null) return;
  try {
    await Promise.race([
      current.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, EXIT_FLUSH_TIMEOUT_MS)),
    ]);
  } catch {
    // The push did not land. The row is at most one save behind, and the picker
    // reconciliation (`worldsSync.ts`) squares it up on the next visit to the front door.
  }
}

/** Stop the live mirror, if any. The exit path, after its flush; and tests. */
export function stopCloudSync(): void {
  handle?.stop();
  handle = null;
}
