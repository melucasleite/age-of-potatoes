// The cloud layer's public surface.
//
// Everything here is optional. There is no Supabase project provisioned for Snack Mogul
// today, and the game is fully playable and fully saveable without one — see README.md in
// this directory for what to set when that changes.

export { AUTH_STORAGE_KEY, getSupabaseClient, resetSupabaseClient } from './client';
export { isCloudSyncConfigured, readSupabaseEnv } from './env';
export type { SupabaseEnv } from './env';
export { startCloudSyncIfConfigured } from './bootstrap';
export type { CloudSyncBootOptions } from './bootstrap';
export { getSession, isAnonymous, linkEmailToCurrentUser, resetSession } from './session';

// `startCloudSync` and `remoteWins` are deliberately NOT re-exported here. They live in
// `./cloudSync`, which is dynamically imported by `./bootstrap` so that an unconfigured
// build never fetches `@supabase/supabase-js` at all. Re-exporting them from the index
// would pull the SDK into every bundle that touches this file and quietly undo that.
