// The sign-in gate's states, as pure functions ([[143]]).
//
// `play-client.tsx` renders one of four screens before anything else gets to exist:
// "cloud is not configured", "checking who is here", the sign-in door, or the game. The
// transitions are three lines each, which is exactly why they live here rather than inline
// in a component: the gate is the one piece of this feature where a wrong branch quietly
// lets an unauthenticated player through (or locks a signed-in one out), and a pure
// function is the only version of it a test can pin without a browser, a Supabase client,
// or a mocked auth event. This module imports NOTHING — it must stay free to sit in the
// first-paint bundle.

export type AuthGateMode =
  /** No Supabase env. The game does not start; a plain screen says what to configure. */
  | 'unconfigured'
  /** Env present, session unknown — the moment between mount and the first session read. */
  | 'checking'
  /** No session. The sign-in door takes the whole screen; nothing else mounts. */
  | 'signed-out'
  /** A real session. The lot picker and the game are allowed to exist. */
  | 'signed-in';

/** Where the gate starts: configuration is knowable synchronously, the session is not. */
export function initialAuthGate(configured: boolean): AuthGateMode {
  return configured ? 'checking' : 'unconfigured';
}

/**
 * Where the gate lands when a session answer arrives — the initial read and every
 * `onAuthChange` event go through the same function, so the door dismisses itself when a
 * session appears and re-arms when one goes.
 *
 * `unconfigured` is absorbing: no auth event can conjure a backend into the env, so an
 * event arriving in that state (there is no client to emit one, but the type allows it)
 * changes nothing.
 */
export function authGateOnSession(current: AuthGateMode, hasSession: boolean): AuthGateMode {
  if (current === 'unconfigured') return 'unconfigured';
  return hasSession ? 'signed-in' : 'signed-out';
}
