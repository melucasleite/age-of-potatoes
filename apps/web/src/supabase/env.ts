// Which keys we have, if any.
//
// THIS MODULE DELIBERATELY DOES NOT IMPORT `@supabase/supabase-js`. It is the cheap check
// that `bootstrap.ts` runs before deciding whether to fetch the client chunk at all, so
// that a build with no Supabase project configured never downloads a byte of the SDK.
// Adding an import here would quietly undo that.

/**
 * Snack Mogul ships against a Supabase project that may not exist yet, so every field here
 * is optional and "none of them are set" is the normal, supported state.
 */
export interface SupabaseEnv {
  url: string;
  key: string;
  /** Which generation of client key we found. Recorded so the console can say so out loud. */
  keyKind: 'publishable' | 'legacy-anon';
}

// NEXT.JS INLINES `process.env.NEXT_PUBLIC_*` ONLY FOR STATIC PROPERTY ACCESS, at build
// time. `process.env[someName]` compiles to a lookup on an object that is empty in the
// browser bundle — it does not throw, it just reads `undefined`, forever, silently. That is
// why these three are spelled out one at a time instead of being iterated over a list.
const URL_VALUE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLISHABLE_VALUE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const LEGACY_ANON_VALUE = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Resolve the browser-side Supabase credentials, or null when they are not configured.
 *
 * BOTH KEY GENERATIONS ARE ACCEPTED, PUBLISHABLE FIRST. Supabase is mid-migration: the
 * legacy `anon` JWT key is being retired in favour of a `sb_publishable_…` key (with
 * `sb_secret_…` replacing `service_role` on the server side), and the legacy pair is
 * documented as working until end-of-2026. `createClient` takes either one in the same
 * argument position, so supporting both costs one `??` and saves a forced migration on
 * whichever day the old key stops working.
 *
 * Verified against Supabase's live docs on 2026-08-12, not from memory — see the agent log
 * on work item 016.
 */
export function readSupabaseEnv(): SupabaseEnv | null {
  const url = trimmed(URL_VALUE);
  if (url === null) return null;

  const publishable = trimmed(PUBLISHABLE_VALUE);
  if (publishable !== null) return { url, key: publishable, keyKind: 'publishable' };

  const legacy = trimmed(LEGACY_ANON_VALUE);
  if (legacy !== null) return { url, key: legacy, keyKind: 'legacy-anon' };

  return null;
}

/**
 * True when cloud sync has somewhere to sync to.
 *
 * Cheap and synchronous by design: it is the gate that decides whether to dynamically
 * import the SDK, so it must not cost a network round trip or a chunk fetch to answer.
 */
export function isCloudSyncConfigured(): boolean {
  return readSupabaseEnv() !== null;
}

/** An env var that is present, a string, and not just whitespace. Empty means "unset". */
function trimmed(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result.length > 0 ? result : null;
}
