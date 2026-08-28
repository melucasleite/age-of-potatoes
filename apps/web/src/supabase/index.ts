// The cloud layer's public surface.
//
// NOT OPTIONAL ANY MORE (work item 143): the game requires a signed-in account and a
// configured Supabase project — an unconfigured build shows a plain "cloud is not
// configured" screen instead of the game, and an unauthenticated player meets the sign-in
// door before the lot picker. See README.md in this directory.

export { AUTH_STORAGE_KEY, getSupabaseClient, resetSupabaseClient } from './client';
export { isCloudSyncConfigured, readSupabaseEnv } from './env';
export type { SupabaseEnv } from './env';
export { flushCloudSyncIfRunning, startCloudSyncIfConfigured, stopCloudSync } from './bootstrap';
export type { CloudSyncBootOptions } from './bootstrap';
export {
  clearSessionMemo,
  getSession,
  linkEmailToCurrentUser,
  linkOAuthToCurrentUser,
  onAuthChange,
  resetSession,
  sendMagicLink,
  signInWithOAuth,
  signOut,
} from './session';
export type { AccountActionResult, OAuthProvider } from './session';
export { DISPLAY_NAME_MAX, getAccountStatus, getOwnProfile, setDisplayName } from './profile';
export type { AccountStatus } from './profile';

// `startCloudSync`, `remoteWins`, and the `worldsSync` reconciliation are deliberately NOT
// re-exported here. They live in modules that are dynamically imported (`./bootstrap`, the
// front door's effect) so that a page which never reaches them never fetches
// `@supabase/supabase-js` up front. Re-exporting them from the index would pull the SDK
// into every bundle that touches this file and quietly undo that.
