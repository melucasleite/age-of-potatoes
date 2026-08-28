// The session: a real, signed-in account, or nothing — and "nothing" means the door.
//
// THE ANONYMOUS ERA IS OVER (work item 143). This file used to mint an anonymous user the
// moment the game booted so that sign-in was invisible and optional. Lucas's final-stretch
// ruling reverses that: every player has an account, every save mirrors to the cloud, and a
// missing session is not a shrug — it is the sign-in door (`hud/SignInDoor.tsx`), rendered
// by `app/play/play-client.tsx` before the front door ever mounts.
//
// What survives from the old design: `getSession()` NEVER REJECTS AND NEVER THROWS, every
// deliberate account action answers `{ ok, reason }` rather than throwing, and nothing in
// here ever manufactures a user. What is gone: `signInAnonymously`, the "guest" state, and
// the upgrade-the-anonymous-user framing — linking is now plain account management for a
// player who is already signed in.

import type { Session, SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseClient } from './client';
import { logDebug, once } from './log';

// One in-flight read per page, shared by every caller. `client.auth.getSession()` awaits
// the client's initialisation — which, with `detectSessionInUrl: true` in `client.ts`, is
// where an OAuth or magic-link return leg's `?code=` gets exchanged for a session. Sharing
// the promise keeps a burst of callers from each paying that wait separately.
let pending: Promise<Session | null> | null = null;

/**
 * The current session, or null. NULL MEANS THE PLAYER IS NOT SIGNED IN — nothing here will
 * sign them in; that is the sign-in door's job, through the deliberate actions below.
 *
 * Never rejects and never throws. Only a real session is memoised: a null result clears the
 * memo so the next caller re-reads, which is what lets the gate poll cheaply while the
 * player is off authenticating with a provider.
 */
export function getSession(): Promise<Session | null> {
  pending ??= establish()
    .catch(() => null)
    .then((session) => {
      if (session === null) pending = null;
      return session;
    });
  return pending;
}

async function establish(): Promise<Session | null> {
  const client = getSupabaseClient();
  if (client === null) return null;

  try {
    // A persisted session in localStorage, refreshed if stale — or the session the client
    // just exchanged out of the return-leg URL. This reads local state rather than proving
    // the user still exists server-side, which is what a boot-time check should cost.
    const existing = await client.auth.getSession();
    if (existing.data.session !== null) {
      logDebug(`Resumed session for user ${existing.data.session.user.id}.`);
      return existing.data.session;
    }
    return null;
  } catch (error) {
    once('session-error', () => {
      logDebug('Could not read the session.', error);
    });
    return null;
  }
}

/**
 * Run `listen` on every auth state change — sign-in (including the OAuth/magic-link return
 * leg landing), sign-out, token refresh. Returns an unsubscribe function.
 *
 * THE GATE'S EAR. `play-client.tsx` subscribes so the sign-in door dismisses itself the
 * moment a session arrives and re-arms the moment one goes. The memo above is cleared on
 * every event BEFORE the listener runs, so a `getSession()` call made from inside the
 * callback sees the world as the event described it rather than as it was memoised.
 */
export function onAuthChange(listen: (session: Session | null) => void): () => void {
  const client = getSupabaseClient();
  if (client === null) return () => {};

  const { data } = client.auth.onAuthStateChange((_event, session) => {
    clearSessionMemo();
    listen(session);
  });
  return () => {
    data.subscription.unsubscribe();
  };
}

/**
 * What every deliberate account action answers with. Never a throw: these run behind
 * buttons, and a button's failure is a sentence for the player, not a stack trace.
 */
export type AccountActionResult = { ok: true } | { ok: false; reason: string };

/** The two OAuth doors the game offers. A union, per the repo's no-`enum` rule. */
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
 * Sign in with GitHub or Google. THE FRONT HALF OF THE SIGN-IN DOOR.
 *
 * On success the browser NAVIGATES AWAY to the provider — `{ ok: true }` means "the
 * redirect is underway", and the caller is about to stop existing. The return leg lands
 * back on `/play` carrying a `?code=`, `client.ts` exchanges it during initialisation, and
 * the `onAuthChange` subscription dismisses the door.
 */
export async function signInWithOAuth(provider: OAuthProvider): Promise<AccountActionResult> {
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
 * Email a magic link that signs this device in. THE OTHER HALF OF THE SIGN-IN DOOR, and the
 * path for a player with no GitHub or Google. Signing in with an email that has no account
 * yet CREATES the account — `signInWithOtp` with the default `shouldCreateUser` — which is
 * exactly right for a game whose only alternative used to be anonymous play.
 *
 * Nothing changes locally until the player clicks the link, and the link must be opened in
 * THIS browser — the PKCE verifier it completes lives in this browser's localStorage.
 */
export async function sendMagicLink(email: string): Promise<AccountActionResult> {
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
 * Attach an email to the CURRENT signed-in user, keeping the same `user.id`.
 *
 * Plain account management now: a player who signed in with GitHub adds an email address so
 * a magic link works on a machine where GitHub does not. Same `user.id`, same `saves`
 * rows, no migration. Reports failure because it only ever runs behind a deliberate button.
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
 * The other half of plain account management: a second provider on the same account, so
 * losing access to one is not losing the farm. On success the browser NAVIGATES AWAY to the
 * provider — `{ ok: true }` means "the redirect is underway".
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
 * Sign out on THIS DEVICE only.
 *
 * `scope: 'local'` on purpose: a player signing out of a shared laptop should not be logged
 * out of their own machine at home. There is no guest to fall back to any more — the
 * `onAuthChange` subscription in `play-client.tsx` sees the session go and puts the
 * sign-in door back up, unmounting whatever was behind it. The local saves stay exactly
 * where they are; they simply stop syncing until somebody signs in.
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
 * Forget the memoised session read, so the next `getSession()` re-reads from scratch.
 * The production door for "the session just changed under us" — sign-out and the
 * `onAuthChange` subscription both use it.
 */
export function clearSessionMemo(): void {
  pending = null;
}

/** Forget the memoised session. Tests only; the game goes through `clearSessionMemo`. */
export function resetSession(): void {
  clearSessionMemo();
}

export type { Session, SupabaseClient };
