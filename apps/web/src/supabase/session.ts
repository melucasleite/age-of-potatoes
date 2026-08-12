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
 * Attach an email to the CURRENT anonymous user, keeping the same `user.id`.
 *
 * THIS IS THE ENTIRE REASON WORK ITEM 016 HAPPENS AT v0.1 RATHER THAN AT v0.8. Plan §10.2:
 * "Retrofitting auth into a years-old persistent-world save format is the expensive path;
 * doing it first is cheap." Because the user id does not change, the `saves` row this
 * player already owns keeps working with no data migration and without losing a tick.
 *
 * SHIPPED AS A FUNCTION WITH NO UI ON PURPOSE. An account screen is explicitly out of v0.1
 * scope; building the function now is what keeps the door open. Supabase sends a
 * confirmation email, and the account is only fully permanent once the player also sets a
 * password — both of which are the future account screen's problem, not this function's.
 *
 * Unlike everything else in this directory this one DOES report failure, because it is only
 * ever called from a deliberate user action that deserves an answer.
 */
export async function linkEmailToCurrentUser(
  email: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const client = getSupabaseClient();
  if (client === null) return { ok: false, reason: 'Cloud accounts are not configured.' };

  const session = await getSession();
  if (session === null) return { ok: false, reason: 'Not signed in.' };

  try {
    const { error } = await client.auth.updateUser({ email });
    if (error !== null) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** True when the signed-in user has never attached a real identity. Null when unknown. */
export async function isAnonymous(): Promise<boolean | null> {
  const session = await getSession();
  if (session === null) return null;
  return session.user.is_anonymous ?? null;
}

/** Forget the memoised sign-in. Tests only. */
export function resetSession(): void {
  pending = null;
}

export type { Session, SupabaseClient };
