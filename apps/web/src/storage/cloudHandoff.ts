// The one seam between cloud sync and the save database.
//
// This file exists so that `apps/web/src/supabase` never has to open the save database
// itself. The schema, the key constants, and the rule that a write rotates rather than
// overwrites all live in this directory, and cloud sync should not get a second, subtly
// different copy of any of them.
//
// EVERYTHING HERE IS ADDITIVE. It does not change `saveWorld`, `loadWorld`, or `bootWorld`,
// and the local save path behaves identically whether or not a byte of this ever runs.
//
// THE INVARIANT: NO ENVELOPE IS EVER DESTROYED. Every function below either writes to the
// spare `conflict` key or rotates the displaced envelope into it. Cloud sync is the one
// subsystem that can be handed a world by a machine the player is not sitting at, and a
// merge it gets wrong must be recoverable from DevTools rather than fatal.

import type { SaveEnvelope } from '@snack/sim';

import { SAVES_STORE, getDb, isStorageAvailable } from './db';
import { logInfo, logWarn } from './log';
import { activeWorldId, conflictKeyFor, currentKeyFor } from './worlds';

/**
 * The pre-registry conflict key. Kept so the adoption migration in `worlds.ts` can move it.
 *
 * A THIRD RECORD, NOT A THIRD SAVE SLOT — and now that a player genuinely can have a second
 * world, that distinction stops being pedantic and starts being load-bearing. This is a
 * parachute, in the same spirit as `previous`, for the specific case where two devices
 * disagree about which world is current. It must never appear on the front door as a card.
 */
export const CONFLICT_KEY = 'conflict';

/**
 * PER-WORLD CLOUD SLOTS ARRIVED WITH WORK ITEM 143. The "cloud sync is the active world
 * only" narrowing that used to be documented here is gone: every world has its own row
 * (slot = world id, `cloudSync.ts`), the running world's loop targets it by id, and the lot
 * picker reconciles the rest (`worldsSync.ts`). `adoptCloudEnvelope` therefore takes an
 * optional explicit `worldId`; omitting it still means the active world, which is the
 * running game's case.
 */
async function activeConflictKey(): Promise<string | null> {
  const id = await activeWorldId();
  return id === null ? null : conflictKeyFor(id);
}

export type AdoptOutcome =
  /** The cloud envelope is now `current`; the displaced local one is under `conflict`. */
  | 'adopted'
  /** Local play had moved on, so the cloud envelope was parked under `conflict` instead. */
  | 'stashed'
  /** No IndexedDB, or the write failed. Nothing changed. */
  | 'unavailable';

/**
 * Install a cloud envelope as the local `current`, if and only if local play has not moved.
 *
 * `expectedLocalTick` is the tick the world booted at. If what is on disk still matches it,
 * nothing has been saved this session and swapping the record underneath is safe. If it has
 * moved, THE PLAYER IS ACTIVELY PLAYING and their live world would overwrite whatever we
 * installed at the next autosave anyway — so the cloud copy is parked under `conflict`
 * rather than being written and immediately clobbered.
 *
 * A NOTE ON THE REMAINING RACE, because it is real and it is accepted for v0.1: adoption
 * swaps the record on disk, but the world already running in memory is the old one, and it
 * will autosave over `current` within a minute of active play. That is why the log line
 * below tells the player to reload. The adopted world is not lost when that happens — the
 * ordinary save rotation moves it to `previous`. Making the swap live would mean rebuilding
 * a running world under the renderer, which is well outside this item's scope and is not
 * something v0.1 needs on a single device.
 *
 * Never throws.
 */
export async function adoptCloudEnvelope(
  envelope: SaveEnvelope,
  options: { expectedLocalTick: number | null; worldId?: string },
): Promise<AdoptOutcome> {
  if (!isStorageAvailable()) return 'unavailable';

  try {
    // An explicit id is the picker-reconciliation case ([[143]]): the world is known, named
    // and not running. Falling back to the active id is the running game's case, unchanged.
    const worldId = options.worldId ?? (await activeWorldId());
    // No world at all means the player is standing at the front door with nothing selected.
    // There is nothing for a cloud save to be current *for*, and writing one anyway would
    // install a world into a lot that does not exist.
    if (worldId === null) return 'unavailable';
    const currentKey = currentKeyFor(worldId);
    const conflictKey = conflictKeyFor(worldId);

    const db = await getDb();
    const tx = db.transaction(SAVES_STORE, 'readwrite');
    const store = tx.objectStore(SAVES_STORE);

    // Read inside the transaction: the decision and the write have to see the same disk, or
    // a save landing between them would be silently thrown away.
    const existing = await store.get(currentKey);
    const moved = existing !== undefined && existing.tick !== options.expectedLocalTick;

    if (moved) {
      await store.put(envelope, conflictKey);
      await tx.done;
      logWarn(
        `A cloud save at tick ${String(envelope.tick)} is further along than this device, ` +
          `but this world has already been played since it loaded (now tick ` +
          `${String(existing.tick)}). The cloud copy has been parked under the "conflict" ` +
          'key in IndexedDB rather than replacing your world. Nothing was lost.',
      );
      return 'stashed';
    }

    if (existing !== undefined) await store.put(existing, conflictKey);
    await store.put(envelope, currentKey);
    await tx.done;

    logInfo(
      `Adopted the cloud save at tick ${String(envelope.tick)}. Reload to play it. The ` +
        'world this device had is under the "conflict" key in IndexedDB.',
    );
    return 'adopted';
  } catch (error) {
    // A failed cloud adoption is not a reason to interrupt anything. The local world is
    // untouched by construction — the transaction either committed whole or not at all.
    logWarn('Could not adopt the cloud save. Playing on with the local world.', error);
    return 'unavailable';
  }
}

/** The active world's parked envelope, if there is one. For the dev overlay and DevTools. */
export async function readConflictEnvelope(): Promise<SaveEnvelope | undefined> {
  if (!isStorageAvailable()) return undefined;
  try {
    const key = await activeConflictKey();
    if (key === null) return undefined;
    const db = await getDb();
    return await db.get(SAVES_STORE, key);
  } catch {
    return undefined;
  }
}
