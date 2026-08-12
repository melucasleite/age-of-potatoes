// The gate that keeps an unconfigured build from paying for a backend it does not have.
//
// THIS MODULE MUST NOT STATICALLY IMPORT `./client`, `./cloudSync`, OR
// `@supabase/supabase-js`. It is imported by the storage boot path, and the whole point of
// its existence is that a build with no Supabase env vars never fetches the SDK chunk at
// all — not "loads it and does nothing with it", but never requests it. The dynamic import
// below is load-bearing; turning it into a top-level import silently adds ~100 KB to every
// player's first load in exchange for nothing.

import { isCloudSyncConfigured } from './env';

export interface CloudSyncBootOptions {
  /** The tick the local world booted at, or null when there was no save. */
  localTickAtBoot: number | null;
}

/**
 * Start cloud sync if — and only if — there is a backend configured to sync to.
 *
 * FIRE AND FORGET. Returns a promise purely so callers can `void` it explicitly; nothing in
 * the boot path may await it, and it never rejects. There is no Supabase project
 * provisioned for this repo today, so the overwhelmingly common path through this function
 * is the first `return`.
 */
export async function startCloudSyncIfConfigured(options: CloudSyncBootOptions): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!isCloudSyncConfigured()) return;

  try {
    const { startCloudSync } = await import('./cloudSync');
    startCloudSync({ localTickAtBoot: options.localTickAtBoot });
  } catch {
    // A chunk that fails to load is exactly as survivable as a server that is down.
    // Deliberately silent: this is reached only when the network is already failing.
  }
}
