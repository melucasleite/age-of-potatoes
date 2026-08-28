// The browser Supabase client, or null.
//
// NULL IS A FIRST-CLASS RETURN VALUE HERE, NOT AN ERROR PATH. There is no Supabase project
// provisioned for Snack Mogul today, and plan §11 is explicit that there never needs to be
// one: "Nothing about the game requires the server to be up." So a missing key degrades to
// "no sync" — never to a throw, never to a white screen, never to a red console.
//
// If you find yourself adding a `!` or a `throw new Error('missing env')` below, stop: that
// turns a game that plays fine on a plane into a game that shows a stack trace on a plane.

import { type SupabaseClient, createClient } from '@supabase/supabase-js';

import { readSupabaseEnv } from './env';
import { logDebug, once } from './log';

/**
 * Where the anonymous session is parked in `localStorage`.
 *
 * Named rather than defaulted so it is greppable in DevTools → Application, and so that
 * clearing it is an obvious, deliberate act. The session living here is what makes the
 * anonymous identity survive a reload — which is the whole reason the acceptance criteria
 * ask for one row and not one row per page load.
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
        'No Supabase URL or key configured, so cloud save sync is off. The game is ' +
          'local-first and plays and saves normally without it. Set ' +
          'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to enable it.',
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
      // The anonymous identity must survive a reload, or every refresh mints a new user and
      // a new row — which is exactly what acceptance criterion three forbids.
      persistSession: true,
      autoRefreshToken: true,
      storageKey: AUTH_STORAGE_KEY,
      // OAUTH AND MAGIC LINKS EXIST NOW, so the two flags below stopped being dead weight.
      // PKCE is the flow Supabase documents for a browser SPA (guides/auth/sessions/pkce-flow,
      // verified 2026-08-24, not from memory): the sign-in redirect comes back carrying a
      // `?code=` that is only useful together with the verifier this client stashed in
      // localStorage, so a leaked URL is not a leaked session. With `detectSessionInUrl` on,
      // the client exchanges that code for a session by itself during initialisation — no
      // callback route, no manual `exchangeCodeForSession`, and `getSession()` in
      // `session.ts` awaits that initialisation, which is what stops the boot path from
      // minting a fresh anonymous user over the account the player just linked.
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
