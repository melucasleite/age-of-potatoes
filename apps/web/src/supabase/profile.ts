// The player's public face: one row in `public.profiles`, and a status line for the panel.
//
// `profiles` is the leaderboard's name column — RLS lets anyone read it and only the owner
// write it — so everything here is small and deliberate: a read the panel populates itself
// from, a write behind a Save button, and a status summary the panel refreshes after every
// account action. Nothing in this file is called from the boot path, and per this
// directory's standing rule, deliberate actions answer `{ ok: false, reason }` rather than
// throwing.

import { getSupabaseClient } from './client';
import { type AccountActionResult, getSession } from './session';

const TABLE = 'profiles';

/**
 * The database constrains `display_name` to 1–32 characters and the client enforces the
 * same numbers BEFORE the round trip, so the common mistakes (empty, or a pasted essay)
 * come back instantly and in the game's own words rather than as a check-constraint error.
 */
export const DISPLAY_NAME_MAX = 32;

/** Everything the account panel needs to describe who is playing, in one refreshable read. */
export interface AccountStatus {
  /** Supabase env vars are present and we are in a browser. False means "hide all of it". */
  configured: boolean;
  /**
   * There is a signed-in account. Since work item 143 there is no anonymous state between
   * "signed in" and "signed out" — a false here mid-game is a transient (the session just
   * ended, and the sign-in door is about to take the whole screen).
   */
  signedIn: boolean;
  /** The account email, when there is one. */
  email: string | null;
  /** Linked identity providers — `['email']` since the OAuth doors were removed (2026-09-02). */
  providers: string[];
}

const UNCONFIGURED: AccountStatus = {
  configured: false,
  signedIn: false,
  email: null,
  providers: [],
};

/**
 * Who is playing right now, for the panel to render and re-render after every action.
 *
 * `client.auth.getSession()` directly rather than this directory's `getSession()` for
 * symmetry with the rest of this file: a status poll reads state, it does not establish
 * it. Never throws — a network failure mid-poll degrades to "signed out", which the next
 * refresh corrects.
 */
export async function getAccountStatus(): Promise<AccountStatus> {
  const client = getSupabaseClient();
  if (client === null) return UNCONFIGURED;

  try {
    const { data } = await client.auth.getSession();
    const session = data.session;
    if (session === null) {
      return { configured: true, signedIn: false, email: null, providers: [] };
    }

    // `getUserIdentities` is a server round trip, so the providers list is the live truth —
    // an identity linked in another tab shows up here on the next refresh. When it fails,
    // an empty list is the honest degraded answer; the email above still holds.
    let providers: string[] = [];
    const identities = await client.auth.getUserIdentities();
    if (identities.error === null && identities.data !== null) {
      providers = identities.data.identities.map((identity) => identity.provider);
    }

    return {
      configured: true,
      signedIn: true,
      email: session.user.email ?? null,
      providers,
    };
  } catch {
    return { configured: true, signedIn: false, email: null, providers: [] };
  }
}

/**
 * The current user's display name, or null — no profile row yet, signed out, and any
 * failure all render the same way: an empty input waiting to be filled in.
 */
export async function getOwnProfile(): Promise<{ displayName: string | null }> {
  const client = getSupabaseClient();
  if (client === null) return { displayName: null };

  try {
    const { data } = await client.auth.getSession();
    const session = data.session;
    if (session === null) return { displayName: null };

    const row = await client
      .from(TABLE)
      .select('display_name')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (row.error !== null || row.data === null) return { displayName: null };

    const name = (row.data as Record<string, unknown>)['display_name'];
    return { displayName: typeof name === 'string' ? name : null };
  } catch {
    return { displayName: null };
  }
}

/**
 * Set the name the leaderboard shows for this player.
 *
 * THE ONE UPSERT: `onConflict: 'user_id'`, because the row's identity IS the user and a
 * second Save must overwrite, never duplicate. A null session answers "Not signed in" —
 * which mid-game means the session just ended and the sign-in door is about to say so
 * with the whole screen.
 */
export async function setDisplayName(name: string): Promise<AccountActionResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'A name needs at least one character.' };
  if (trimmed.length > DISPLAY_NAME_MAX) {
    return { ok: false, reason: `Names are at most ${String(DISPLAY_NAME_MAX)} characters.` };
  }

  const client = getSupabaseClient();
  if (client === null) return { ok: false, reason: 'Cloud accounts are not configured.' };

  const session = await getSession();
  if (session === null) return { ok: false, reason: 'Not signed in.' };

  try {
    const { error } = await client
      .from(TABLE)
      .upsert({ user_id: session.user.id, display_name: trimmed }, { onConflict: 'user_id' });
    if (error !== null) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
