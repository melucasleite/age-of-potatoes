// The lot picker reconciliation's decisions, pure ([[143]]).
//
// Split from `worldsSync.ts` the way `worlds.ts` splits its plans from its database part,
// and for the same reason with one addition: this module imports NOTHING — not the SDK,
// not `@/storage`, not even a type — so `worldsSyncPlan.test.ts` can import it under the
// repo's plain vitest setup (no path-alias resolution) and pin the one choice that could
// quietly misfile a farm: which world adopts the legacy `'default'` cloud row.

/** What one world's local save and cloud row call for. The conflict rule, per slot. */
export type RowSyncAction = 'push' | 'pull' | 'none';

/**
 * Compare one world's local tick against its cloud row's. Higher tick wins, exactly as the
 * running loop decides it; a tie keeps local (pushing or pulling identical saves is cost
 * with no benefit); a side with nothing at all defers to the side with something.
 */
export function planWorldRowSync(
  localTick: number | null,
  remoteTick: number | null,
): RowSyncAction {
  if (localTick === null && remoteTick === null) return 'none';
  if (localTick === null) return 'pull';
  if (remoteTick === null) return 'push';
  if (localTick > remoteTick) return 'push';
  if (remoteTick > localTick) return 'pull';
  return 'none';
}

/** What the picker needs to know about one lot to place the legacy row. */
export interface AdoptionCandidate {
  id: string;
  seed: number;
  /** The lot card's saved tick — 0 for a lot that has never saved. */
  summaryTick: number;
}

/**
 * Which world the legacy `'default'` row mirrors, or null when none does.
 *
 * THE MATCH IS THE SEED. A world's seed is minted once and never changes, and the row
 * carries `world_seed` precisely so a future reader could answer "whose save is this?"
 * without parsing the payload — this is that reader. Two live worlds with the same seed
 * should be impossible (seeds are fresh uint32 draws), but if it ever happens the one whose
 * saved tick is closest to the row's wins: same lineage, nearest moment.
 */
export function chooseLegacyAdoptionTarget(
  row: { worldSeed: number; tick: number },
  worlds: AdoptionCandidate[],
): string | null {
  const matching = worlds.filter((world) => world.seed === row.worldSeed);
  if (matching.length === 0) return null;
  let best = matching[0]!;
  for (const world of matching.slice(1)) {
    if (Math.abs(world.summaryTick - row.tick) < Math.abs(best.summaryTick - row.tick)) {
      best = world;
    }
  }
  return best.id;
}

/** Where the legacy envelope goes once its world is known. */
export type LegacyMergeAction =
  /** The legacy row is the furthest along: it becomes the world's slot row. */
  | 'replace-slot'
  /** The world's own row is at or ahead: park the legacy envelope locally, keep the row. */
  | 'park-only';

/**
 * Whether the legacy envelope outranks what the world's own slot already holds. The same
 * higher-tick-wins rule as everywhere else; a tie keeps the slot row (they are the same
 * lineage at the same moment, and the slot row is already where it belongs).
 */
export function planLegacyRowMerge(
  legacyTick: number,
  slotRowTick: number | null,
): LegacyMergeAction {
  if (slotRowTick === null) return 'replace-slot';
  return legacyTick > slotRowTick ? 'replace-slot' : 'park-only';
}
