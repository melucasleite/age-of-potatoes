// The save module's public surface, plus the one composed operation every host wants.
//
// The split between this directory and `apps/web/src/storage` is forced and useful:
// `packages/sim` has a DOM-free tsconfig with `"lib": ["ES2022"]`, so `indexedDB`,
// `navigator`, and `localStorage` do not type-check here. Envelope types, canonical form,
// and migrations are pure data transforms and belong in the sim; the storage driver belongs
// in the web app. That is the boundary working as designed, not an obstacle to route around
// — and it is why nothing in this directory logs: the sim has no `console` either. Load
// diagnostics come back as *data* and the host decides what to do with them.

export { type SavePayload, deserialize, parseEnvelope, serialize } from './envelope';
export type { SaveEnvelope } from './envelope';
export {
  SaveCorruptError,
  SaveError,
  SaveFormatTooNewError,
  SaveMigrationMissingError,
} from './errors';
export { CURRENT_FORMAT_VERSION, MIGRATIONS, migrate } from './migrations';
export type { MigrationOutcome, SaveMigration } from './migrations';
export { SIM_CODE_VERSION, SIM_VERSION, checkSimVersion } from './version';
export type { SimVersionCheck } from './version';
export {
  type SaveBelt,
  type SaveBeltItem,
  type SaveCropTile,
  type SaveGrabber,
  type SaveInventorySlot,
  type SaveMachine,
  type SaveStats,
  type SaveStream,
  type SaveZone,
  fromPayload,
  toPayload,
} from './canonical';

import type { TraceEntry, WorldState } from '../state';
import { type SaveEnvelope, deserialize, parseEnvelope } from './envelope';
import { type MigrationOutcome, migrate } from './migrations';
import { type SimVersionCheck, checkSimVersion } from './version';

export interface RestoredWorld {
  state: WorldState;
  /** The envelope after migration, at `CURRENT_FORMAT_VERSION`. */
  envelope: SaveEnvelope;
  migration: MigrationOutcome;
  /**
   * Informational. A mismatch means the world was balanced under different numbers, which
   * costs replay determinism and leaderboard comparability but does not invalidate the
   * world. Log it, show it in the dev overlay, and load anyway.
   */
  simVersion: SimVersionCheck;
}

/**
 * Parse, migrate, and deserialize an untrusted stored value in one call.
 *
 * Throws `SaveCorruptError` if the bytes are not a save, and `SaveFormatTooNewError` if the
 * save came from a newer build — in which case the caller must refuse the load and leave the
 * stored record exactly as it found it.
 */
export function restoreWorld(value: unknown, trace: readonly TraceEntry[] = []): RestoredWorld {
  const parsed = parseEnvelope(value);
  const migration = migrate(parsed);
  return {
    state: deserialize(migration.envelope, trace),
    envelope: migration.envelope,
    migration,
    simVersion: checkSimVersion(parsed.simVersion),
  };
}
