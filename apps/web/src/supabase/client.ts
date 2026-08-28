// The browser Supabase client, or null.
//
// NULL IS STILL A FIRST-CLASS RETURN VALUE, NOT AN ERROR PATH — but what it means changed
// with work item 143. Accounts are required now: a build with no Supabase env does not play
// local-only, it shows the "cloud is not configured" screen (`play-client.tsx`) instead of
// the game. This module still never throws about it, because the module that KNOWS what a
// missing backend means for the player is the gate, not the client factory — a `throw new
// Error('missing env')` here would be a white screen where a readable sentence belongs.

import { type SupabaseClient, createClient } from '@supabase/supabase-js';

import { readSupabaseEnv } from './env';
import { logDebug, once } from './log';

/**
 * Where the session is parked in `localStorage`.
 *
 * Named rather than defaulted so it is greppable in DevTools → Application, and so that
 * clearing it is an obvious, deliberate act. The session living here is what makes a
 * sign-in survive a reload — without it every refresh would mean the sign-in door again.
 */
export const AUTH_STORAGE_KEY = 'snack-mogul.auth';

// Memoised, not eagerly constructed at module scope. `createClient` touches `localStorage`
// and `window`, and this module is reachable from a server render — building it lazily on
// first use keeps SSR from evaluating browser-only code. It is still constructed exactly
// once per page, which is the property that actually matters (one client, one auto-refresh
// timer, one session listener).
let memo: SupabaseClient | null | undefined;

/**
 * The one browser client, or null when Supabase is not configured or we are not in a browser.
 *
 * Every caller must handle null. That is not defensive padding — null is the state this
 * repo is in right now, and the state it stays in for any player who forks it without
 * provisioning a backend.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (memo !== undefined) return memo;

  if (typeof window === 'undefined') {
    // Server render. Do not memoise — the same module instance is reused across requests
    // and we want the browser to get a real client when it eventually asks.
    return null;
  }

  const env = readSupabaseEnv();
  if (env === null) {
    once('unconfigured', () => {
      logDebug(
        'No Supabase URL or key configured. Accounts and cloud saves are required now ' +
          '(work item 143), so the game will show its "cloud is not configured" screen. ' +
          'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
      );
    });
    memo = null;
    return memo;
  }

  once('configured', () => {
    logDebug(
      `Cloud save sync is configured against ${env.url} using the ${env.keyKind} key.` +
        (env.keyKind === 'legacy-anon'
          ? ' The legacy anon key is scheduled for retirement at the end of 2026; move to a' +
            ' sb_publishable_… key via NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY when convenient.'
          : ''),
    );
  });

  memo = createClient(env.url, env.key, {
    auth: {
      // The sign-in must survive a reload, or every refresh puts the door back up.
      persistSession: true,
      autoRefreshToken: true,
      storageKey: AUTH_STORAGE_KEY,
      // OAUTH AND MAGIC LINKS ARE THE ONLY WAY IN NOW, so the two flags below are
      // load-bearing. PKCE is the flow Supabase documents for a browser SPA
      // (guides/auth/sessions/pkce-flow, verified 2026-08-24, not from memory): the sign-in
      // redirect comes back carrying a `?code=` that is only useful together with the
      // verifier this client stashed in localStorage, so a leaked URL is not a leaked
      // session. With `detectSessionInUrl` on, the client exchanges that code for a session
      // by itself during initialisation — no callback route, no manual
      // `exchangeCodeForSession`. `getSession()` in `session.ts` awaits that
      // initialisation, and the `onAuthChange` subscription in `play-client.tsx` is how the
      // sign-in door finds out the return leg landed.
      flowType: 'pkce',
      detectSessionInUrl: true,
    },
  });

  return memo;
}

/** Drop the memoised client. Tests and hot reload; the game itself never needs it. */
export function resetSupabaseClient(): void {
  memo = undefined;
}
