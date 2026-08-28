// The anonymous session: something that ARRIVES, never something you WAIT FOR.
//
// Work item 017's ship gate is a fresh-eyes player grinning at a sprinkler. A player who
// meets a signup form, a spinner, or a "connecting…" state before they meet a watering can
// fails that gate outright — which is why sign-in here is invisible, asynchronous, and
// entirely optional. `getSession()` resolving to null is a completely normal Tuesday: no
// project provisioned, anonymous sign-ins switched off in the dashboard, offline, or a
// paused free-tier project.
//
// NOTHING IN THE BOOT PATH MAY AWAIT THIS. The game renders, plays, and autosaves to
// IndexedDB whether or not this promise ever settles.

import type { Session, SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseClient } from './client';
import { logDebug, once } from './log';

// One in-flight sign-in per page, shared by every caller. Two concurrent
// `signInAnonymously()` calls would mint two anonymous users and orphan the first one's
// save row — a slow leak of abandoned rows that nobody would notice for months.
let pending: Promise<Session | null> | null = null;

/**
 * The current session, signing in anonymously if there is not one yet.
 *
 * NEVER REJECTS AND NEVER THROWS. Every failure resolves to null, because from the game's
 * point of view "the network is down" and "Supabase does not exist" are the same condition
 * and neither is worth a stack trace.
 */
export function getSession(): Promise<Session | null> {
  pending ??= establish()
    .catch(() => null)
    .then((session) => {
      // ONLY SUCCESS IS CACHED. A player who opened the tab in a tunnel should get a
      // session when the train comes out of it, so a null result clears the memo and lets
      // the next caller try again. Caching the in-flight promise still guarantees exactly
      // one `signInAnonymously()` at a time, which is what stops duplicate anonymous users.
      if (session === null) pending = null;
      return session;
    });
  return pending;
}

async function establish(): Promise<Session | null> {
  const client = getSupabaseClient();
  if (client === null) return null;

  try {
    // A persisted session in localStorage is the common case on every load after the first.
    // Note this reads and refreshes local state rather than proving the user still exists
    // server-side, which is exactly what we want here: it is fast, and sync failures are
    // handled by the caller retrying anyway.
    const existing = await client.auth.getSession();
    if (existing.data.session !== null) {
      logDebug(`Resumed session for user ${existing.data.session.user.id}.`);
      return existing.data.session;
    }

    const created = await client.auth.signInAnonymously();
    if (created.error !== null) {
      // The overwhelmingly likely cause on a fresh project is that anonymous sign-ins are
      // still switched off — it is off by default, and it is a DASHBOARD setting that no
      // amount of client code can turn on. Say so once, at debug level, and carry on.
      once('signin-failed', () => {
        logDebug(
          'Anonymous sign-in did not complete, so this session will not sync to the cloud. ' +
            'If this is unexpected, check that Anonymous sign-ins are enabled under ' +
            'Authentication → Sign In / Providers in the Supabase dashboard.',
          created.error,
        );
      });
      return null;
    }

    if (created.data.session !== null) {
      logDebug(`Signed in anonymously as ${created.data.session.user.id}.`);
    }
    return created.data.session;
  } catch (error) {
    once('session-error', () => {
      logDebug('Could not establish a session. Playing offline.', error);
    });
    return null;
  }
}

/**
 * What every deliberate account action answers with. Never a throw: these run behind
 * buttons, and a button's failure is a sentence for the player, not a stack trace.
 */
export type AccountActionResult = { ok: true } | { ok: false; reason: string };

/** The two OAuth doors the account panel offers. A union, per the repo's no-`enum` rule. */
export type OAuthProvider = 'github' | 'google';

/**
 * Where an OAuth redirect or an emailed link should land the player: this page, stripped of
 * query and hash. Stripped because the return trip arrives carrying its own `?code=` — the
 * PKCE exchange in `client.ts` — and a stale query string from the outbound trip would ride
 * along forever. Browser-only by construction: every caller has already checked the client.
 */
function returnHere(): string {
  return window.location.origin + window.location.pathname;
}

/**
 * Attach an email to the CURRENT anonymous user, keeping the same `user.id`.
 *
 * THIS IS THE ENTIRE REASON WORK ITEM 016 HAPPENS AT v0.1 RATHER THAN AT v0.8. Plan §10.2:
 * "Retrofitting auth into a years-old persistent-world save format is the expensive path;
 * doing it first is cheap." Because the user id does not change, the `saves` row this
 * player already owns keeps working with no data migration and without losing a tick.
 *
 * The account screen this function waited for exists now (`hud/AccountPanel.tsx`), so the
 * confirmation email carries an `emailRedirectTo` that brings the player back to the game
 * rather than to the project's Site URL.
 *
 * Unlike the boot-path code in this file this one DOES report failure, because it is only
 * ever called from a deliberate user action that deserves an answer.
 */
export async function linkEmailToCurrentUser(email: string): Promise<AccountActionResult> {
  const client = getSupabaseClient();
  if (client === null) return { ok: false, reason: 'Cloud accounts are not configured.' };

  const session = await getSession();
  if (session === null) return { ok: false, reason: 'Not signed in.' };

  try {
    const { error } = await client.auth.updateUser({ email }, { emailRedirectTo: returnHere() });
    if (error !== null) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Attach a GitHub or Google identity to the CURRENT user, keeping the same `user.id`.
 *
 * THE UPGRADE PATH, same contract as `linkEmailToCurrentUser`: the anonymous user this
 * player has been all along becomes permanent, and their save row never notices. On success
 * the browser NAVIGATES AWAY to the provider — `{ ok: true }` here means "the redirect is
 * underway", and the function's caller is about to stop existing.
 *
 * `linkIdentity` needs manual linking enabled in the dashboard (Authentication → Settings).
 * When it is not, Supabase answers with an error naming it; that message is surfaced
 * verbatim rather than translated, because it is the one clue the developer needs.
 */
export async function linkOAuthToCurrentUser(
  provider: OAuthProvider,
): Promise<AccountActionResult> {
  const client = getSupabaseClient();
  if (client === null) return { ok: false, reason: 'Cloud accounts are not configured.' };

  const session = await getSession();
  if (session === null) return { ok: false, reason: 'Not signed in.' };

  try {
    const { error } = await client.auth.linkIdentity({
      provider,
      options: { redirectTo: returnHere() },
    });
    if (error !== null) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Sign this DEVICE into a different, already-existing account via OAuth.
 *
 * NOT THE UPGRADE PATH, AND THE PANEL SAYS SO OUT LOUD. This replaces the local session:
 * the current user — anonymous or not — is abandoned on this device, and whoever the
 * provider vouches for takes over. Cloud sync then reconciles by its standing conflict rule
 * (higher tick wins, `cloudSync.ts`), so the adopted account's farther-along farm arrives on
 * its own and a fresh account adopts the local one. Offered only behind an explicit
 * "sign in to an existing account" step so nobody replaces a farm by accident.
 */
export async function signInToExistingWithOAuth(
  provider: OAuthProvider,
): Promise<AccountActionResult> {
  const client = getSupabaseClient();
  if (client === null) return { ok: false, reason: 'Cloud accounts are not configured.' };

  try {
    const { error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: returnHere() },
    });
    if (error !== null) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Email a magic link that signs this device into an existing account. The session-replacing
 * sibling of `signInToExistingWithOAuth`, with the same warning and the same conflict rule
 * doing the reconciliation; nothing changes locally until the player clicks the link, and
 * the link must be opened in THIS browser — the PKCE verifier it completes lives in this
 * browser's localStorage.
 */
export async function sendMagicLinkToExisting(email: string): Promise<AccountActionResult> {
  const client = getSupabaseClient();
  if (client === null) return { ok: false, reason: 'Cloud accounts are not configured.' };

  try {
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: returnHere() },
    });
    if (error !== null) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Sign out on THIS DEVICE only, and fall back to being a guest.
 *
 * `scope: 'local'` on purpose: a player signing out of a shared laptop should not be logged
 * out of their own machine at home. The session memo is cleared so the very next
 * `getSession()` — the panel's own follow-up, or cloud sync's next cycle — establishes a
 * fresh anonymous user, which is the state a brand-new player is in. Cloud sync survives
 * this without help: it re-reads the session every cycle and simply starts mirroring the
 * local farm under the new guest.
 */
export async function signOut(): Promise<AccountActionResult> {
  const client = getSupabaseClient();
  if (client === null) return { ok: false, reason: 'Cloud accounts are not configured.' };

  try {
    const { error } = await client.auth.signOut({ scope: 'local' });
    // The memo is cleared even when the server-side revocation failed: supabase-js drops
    // the local session regardless, and a memo pointing at a dropped session would hand
    // callers a corpse until the next reload.
    clearSessionMemo();
    if (error !== null) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (error) {
    clearSessionMemo();
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Forget the memoised sign-in, so the next `getSession()` re-establishes from scratch.
 * The production door for "the session just changed under us" — sign-out uses it above.
 */
export function clearSessionMemo(): void {
  pending = null;
}

/** True when the signed-in user has never attached a real identity. Null when unknown. */
export async function isAnonymous(): Promise<boolean | null> {
  const session = await getSession();
  if (session === null) return null;
  return session.user.is_anonymous ?? null;
}

/** Forget the memoised sign-in. Tests only; the game goes through `clearSessionMemo`. */
export function resetSession(): void {
  clearSessionMemo();
}

export type { Session, SupabaseClient };
