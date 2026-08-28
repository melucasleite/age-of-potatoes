// The lot picker's reconciliation: every world gets its row, and the legacy row gets a home.
//
// WHY THIS EXISTS ([[143]]). The running world mirrors itself through `cloudSync.ts`'s poll
// loop, but a world the player is NOT running has no loop — before this module, a lot that
// was never opened on this device never reached the cloud, and a lot last played before the
// per-world slots landed sat under one shared `'default'` row. This runs when the front
// door mounts (fire-and-forget, `FrontDoor.tsx`) and squares all of it up:
//
//   for every live lot:  push its local save if the cloud is behind or empty,
//                        adopt the cloud copy if the cloud is ahead (conflict rules kept),
//   once, if present:    move the legacy 'default' row under the world it mirrors.
//
// THE DECISIONS ARE PURE FUNCTIONS (`worldsSyncPlan.ts`), the network code around them
// thin — same discipline as `worlds.ts`'s plan functions and for the same reason: the
// choice of which world adopts the legacy row is the one call here that could quietly
// misfile a farm, so it is covered by `worldsSyncPlan.test.ts` with no network near it.
//
// NO ENVELOPE IS DESTROYED. Adopting a cloud row into local disk goes through
// `adoptCloudEnvelope`, which rotates the displaced record into the world's `conflict` key.
// Retiring the legacy row is a MOVE: its envelope lands either under the world's own slot
// (when it is the furthest along) or under the world's local `conflict` key (when it is
// not), and only then is the `'default'` row deleted. A move that cannot complete leaves
// the row where it was for a later visit.

import type { SaveEnvelope } from '@snack/sim';

import {
  adoptCloudEnvelope,
  liveWorlds,
  peekMoneyCents,
  readRegistry,
  touchWorld,
} from '@/storage';

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseClient } from './client';
import {
  LEGACY_DEFAULT_SLOT,
  TABLE,
  fetchSaveRow,
  pushEnvelope,
  readLocalEnvelope,
  rowToEnvelope,
} from './cloudSync';
import { logDebug, logWarn } from './log';
import { getSession } from './session';
// The decisions live in their own import-free module so `worldsSyncPlan.test.ts` can reach
// them under the repo's plain vitest setup. Re-exported here so callers see one surface.
import { chooseLegacyAdoptionTarget, planLegacyRowMerge, planWorldRowSync } from './worldsSyncPlan';

export { chooseLegacyAdoptionTarget, planLegacyRowMerge, planWorldRowSync } from './worldsSyncPlan';
export type { AdoptionCandidate, LegacyMergeAction, RowSyncAction } from './worldsSyncPlan';

// --- the network part -------------------------------------------------------------------

export interface ReconcileResult {
  /** Worlds whose local save was pushed to the cloud. */
  pushed: number;
  /** Worlds that adopted a further-along cloud copy onto local disk. */
  adopted: number;
  /** True when the legacy `'default'` row was moved to its world this run. */
  legacyMoved: boolean;
}

const NOTHING: ReconcileResult = { pushed: 0, adopted: 0, legacyMoved: false };

/**
 * Square every live lot with its cloud row. NEVER THROWS and never blocks anything — the
 * front door calls it fire-and-forget and repaints the cards when it resolves. Safe to run
 * repeatedly; a run that finds nothing to do costs one header-only listing query.
 */
export async function reconcileCloudWorlds(): Promise<ReconcileResult> {
  if (typeof window === 'undefined') return NOTHING;
  const client = getSupabaseClient();
  if (client === null) return NOTHING;

  try {
    const session = await getSession();
    if (session === null) return NOTHING;
    const userId = session.user.id;

    const registry = await readRegistry();
    const worlds = liveWorlds(registry);

    // One header-only listing for the whole account: slots and ticks, no payloads. The
    // payload of any given row is fetched only when a decision actually needs it.
    const { data, error } = await client
      .from(TABLE)
      .select('slot, world_seed, tick')
      .eq('user_id', userId);
    if (error !== null) throw error;

    const remoteTicks = new Map<string, number>();
    let legacyHeader: { worldSeed: number; tick: number } | null = null;
    for (const row of data ?? []) {
      const slot = typeof row.slot === 'string' ? row.slot : null;
      const tick = Number(row.tick);
      if (slot === null || !Number.isFinite(tick)) continue;
      if (slot === LEGACY_DEFAULT_SLOT) {
        legacyHeader = { worldSeed: Number(row.world_seed), tick };
      } else {
        remoteTicks.set(slot, tick);
      }
    }

    let legacyMoved = false;
    if (legacyHeader !== null) {
      legacyMoved = await retireLegacyRow(client, userId, legacyHeader, worlds, remoteTicks);
    }

    let pushed = 0;
    let adopted = 0;
    for (const world of worlds) {
      const local = await readLocalEnvelope(world.id);
      const action = planWorldRowSync(local?.tick ?? null, remoteTicks.get(world.id) ?? null);

      if (action === 'push' && local !== undefined) {
        if (await pushEnvelope(client, userId, world.id, local)) pushed += 1;
      } else if (action === 'pull') {
        if (await adoptRowIntoWorld(client, userId, world.id, local?.tick ?? null)) adopted += 1;
      }
    }

    if (pushed > 0 || adopted > 0 || legacyMoved) {
      logDebug(
        `Reconciled the lot picker with the cloud: ${String(pushed)} pushed, ` +
          `${String(adopted)} adopted` +
          (legacyMoved ? ', and the legacy default row found its world.' : '.'),
      );
    }
    return { pushed, adopted, legacyMoved };
  } catch (error) {
    // The picker must draw whether or not the network does. The next visit tries again.
    logDebug('Could not reconcile the lots with the cloud. Will try again next visit.', error);
    return NOTHING;
  }
}

/**
 * Pull one world's full row and install it as the local `current` (displaced record parked
 * under `conflict` — `adoptCloudEnvelope`), then refresh the lot card so the picker shows
 * the adopted numbers rather than the stale ones. True when the adoption landed.
 */
async function adoptRowIntoWorld(
  client: SupabaseClient,
  userId: string,
  worldId: string,
  expectedLocalTick: number | null,
): Promise<boolean> {
  const row = await fetchSaveRow(client, userId, worldId);
  if (row === null) return false;

  let remote: SaveEnvelope;
  try {
    remote = rowToEnvelope(row);
  } catch (parseError) {
    logWarn(
      `The cloud row for world ${worldId} is not a readable envelope. Ignoring it.`,
      parseError,
    );
    return false;
  }

  const outcome = await adoptCloudEnvelope(remote, { expectedLocalTick, worldId });
  if (outcome !== 'adopted') return false;

  await touchWorld(worldId, {
    tick: remote.tick,
    moneyCents: peekMoneyCents(remote.payload),
    formatVersion: remote.formatVersion,
  });
  return true;
}

/**
 * Move the legacy `'default'` row under the world it mirrors. A MOVE, in two steps that
 * each preserve the envelope: copy it to where it belongs (the world's slot row when it is
 * furthest along, the world's local `conflict` key otherwise), and only after that copy
 * verifiably landed, delete the `'default'` row. Any failure leaves the row untouched for a
 * later visit. True when the row was retired this run.
 */
async function retireLegacyRow(
  client: SupabaseClient,
  userId: string,
  header: { worldSeed: number; tick: number },
  worlds: { id: string; seed: number; summary: { tick: number } }[],
  remoteTicks: Map<string, number>,
): Promise<boolean> {
  const targetId = chooseLegacyAdoptionTarget(
    header,
    worlds.map((world) => ({ id: world.id, seed: world.seed, summaryTick: world.summary.tick })),
  );
  if (targetId === null) {
    // No live lot carries this seed — a deleted world, or a browser that never had it. The
    // row stays exactly where it is: an envelope with no home is still an envelope.
    logDebug(
      `The legacy 'default' cloud row (seed ${String(header.worldSeed)}) matches no lot on ` +
        'this device. Leaving it in place.',
    );
    return false;
  }

  const row = await fetchSaveRow(client, userId, LEGACY_DEFAULT_SLOT);
  if (row === null) return false; // Retired by another device between the listing and now.

  let envelope: SaveEnvelope;
  try {
    envelope = rowToEnvelope(row);
  } catch (parseError) {
    logWarn(
      "The legacy 'default' row is not a readable envelope. Leaving it in place.",
      parseError,
    );
    return false;
  }

  const merge = planLegacyRowMerge(envelope.tick, remoteTicks.get(targetId) ?? null);

  if (merge === 'replace-slot') {
    // The legacy envelope is the furthest along this lineage has reached in the cloud. If a
    // slot row exists it is older; park it locally first so no envelope is destroyed, then
    // let the legacy one take the slot.
    const displacedTick = remoteTicks.get(targetId);
    if (displacedTick !== undefined) {
      const displaced = await fetchSaveRow(client, userId, targetId);
      if (displaced !== null && !(await parkLocally(displaced, targetId))) return false;
    }
    if (!(await pushEnvelope(client, userId, targetId, envelope))) return false;
    remoteTicks.set(targetId, envelope.tick);
  } else {
    // The world's own row is at or ahead: the legacy envelope is the older copy. Park it
    // locally under the world's conflict key — recoverable from DevTools, per the standing
    // rule — and only then retire the row.
    if (!(await parkLocally(row, targetId))) return false;
  }

  const { error } = await client
    .from(TABLE)
    .delete()
    .eq('user_id', userId)
    .eq('slot', LEGACY_DEFAULT_SLOT);
  if (error !== null) throw error;

  logDebug(`Adopted the legacy 'default' cloud row into world ${targetId} ('${merge}').`);
  return true;
}

/**
 * Park a row's envelope under a world's local `conflict` key. Reuses `adoptCloudEnvelope`
 * with an impossible expected tick, which routes every case with a local save through the
 * 'stashed' branch — the conflict key — and never touches `current` unless the world had
 * no save at all (in which case becoming `current` is strictly more recoverable than a
 * parking spot nobody checks). True when the envelope verifiably landed somewhere local.
 */
async function parkLocally(row: Record<string, unknown>, worldId: string): Promise<boolean> {
  let envelope: SaveEnvelope;
  try {
    envelope = rowToEnvelope(row);
  } catch {
    return false;
  }
  const outcome = await adoptCloudEnvelope(envelope, { expectedLocalTick: -1, worldId });
  return outcome !== 'unavailable';
}
