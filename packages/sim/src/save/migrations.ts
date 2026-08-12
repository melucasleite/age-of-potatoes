// The migration chain.
//
// ────────────────────────────────────────────────────────────────────────────────────────
// A RELEASED MIGRATION IS NEVER EDITED. NOT ONCE. NOT TO FIX IT.
//
// A migration that gets "corrected" after release produces two different worlds from the
// same file depending on which deploy the player happened to load — and the two worlds are
// both plausible, so nothing catches it. If a released migration is wrong, the repair is a
// NEW step on the end of the chain that undoes the damage. Never a change to the old one.
//
// ONE REAL SAVE FIXTURE IS KEPT PER RELEASED FORMAT VERSION, FOREVER. A hand-written
// fixture tests the migration you imagined; a real save tests the one you shipped. They are
// small, they never change, and they are the only thing that will catch a migration bug in
// 2029. See `test/fixtures/saves/`.
// ────────────────────────────────────────────────────────────────────────────────────────
//
// The chain is one step long: format 1 (v0.1 — field, machines, inventory, stats) up to
// format 2 (the factory — belts, grabbers, zones, tech unlocks, upgrade dials, and the
// per-tile withering clock).

import type { SaveEnvelope } from './envelope';
import { SaveCorruptError, SaveFormatTooNewError, SaveMigrationMissingError } from './errors';

/**
 * The envelope/payload shape this build writes and reads.
 *
 * Bump it in the same commit that adds the migration step which reaches it. A bump without
 * a step is a hole in the chain, and `migrate` throws rather than guessing.
 */
export const CURRENT_FORMAT_VERSION = 2;

/**
 * A pure `payload -> payload` transform. It receives whatever the previous version wrote and
 * returns whatever the next version reads. No I/O, no clock, no randomness — a migration
 * that is not a pure function of its input is a migration whose result depends on when it
 * ran.
 */
export type SaveMigration = (payload: unknown) => unknown;

/**
 * Machine prices AS THEY WERE WHEN FORMAT 1 WAS CURRENT, frozen here as literals.
 *
 * This is the whole reason a migration must not import `machineSpec`. A migration that
 * looked up today's price would produce a different world every time the balance table
 * moved — the same file, read by two builds, becoming two different worlds — which is
 * precisely the failure this directory is arranged to prevent. Copies of old constants are
 * not duplication; they are the record of what the numbers were.
 */
const FORMAT_1_MACHINE_PRICE_CENTS: Readonly<Record<number, number>> = {
  1: 0, // SellBin
  2: 10_000, // ChipKitchen
  3: 15_000, // Sprinkler
};

function rows(payload: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    throw new SaveCorruptError(`Cannot migrate: \`payload.${key}\` is not an array.`);
  }
  return value as Record<string, unknown>[];
}

/**
 * Format 1 → 2.
 *
 * Every added field takes the value that makes the loaded world identical to the one that
 * was saved: no belts, no grabbers, no zones, no research, no upgrades bought, and a
 * withering clock at zero — so a v0.1 world with a mature field comes back with its full
 * in-ground grace ahead of it rather than a row of crops that turned while nobody was
 * playing. Time does not pass when the tab is closed, and a migration must not be the one
 * exception to that.
 */
const migrateFormat1To2: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-1 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  // Copies, never edits in place. The caller still holds the stored record and may need to
  // write it back untouched if anything downstream refuses the load.
  const field: Record<string, unknown>[] = [];
  const oldField = rows(p, 'field');
  for (let i = 0; i < oldField.length; i++) {
    field.push({ ...oldField[i]!, readyAge: 0, compost: 0, zone: 0 });
  }

  const machines: Record<string, unknown>[] = [];
  const oldMachines = rows(p, 'machines');
  for (let i = 0; i < oldMachines.length; i++) {
    const machine = oldMachines[i]!;
    const kind = machine['kind'];
    const price = typeof kind === 'number' ? FORMAT_1_MACHINE_PRICE_CENTS[kind] : undefined;
    machines.push({
      ...machine,
      investedCents: price ?? 0,
      speedLevel: 0,
      efficiencyLevel: 0,
      capacityLevel: 0,
    });
  }

  return {
    ...p,
    belts: [],
    field,
    grabbers: [],
    machines,
    nextBeltId: 1,
    nextGrabberId: 1,
    nextZoneId: 1,
    unlocked: [],
    version: 2,
    zones: [],
  };
};

/**
 * Keyed by the version being migrated *from*: `MIGRATIONS[1]` turns a format-1 payload into
 * a format-2 payload.
 */
export const MIGRATIONS: Readonly<Record<number, SaveMigration>> = {
  1: migrateFormat1To2,
};

export interface MigrationOutcome {
  /** The envelope at `CURRENT_FORMAT_VERSION`. Identical to the input when nothing ran. */
  envelope: SaveEnvelope;
  /** The version the save arrived as, for logging. */
  fromVersion: number;
  /** Each step that ran, in order, as `from -> to` pairs. Empty when nothing ran. */
  steps: readonly number[];
}

/**
 * Walk a save up to the current format version.
 *
 * Throws `SaveFormatTooNewError` when the save is from a newer build — the caller must then
 * refuse the load and **leave the stored record untouched**, because the player's world is
 * fine and it is this tab that is out of date. Overwriting a future save with a past one is
 * the one unrecoverable mistake this file exists to prevent.
 *
 * Throws `SaveMigrationMissingError` when a step is absent, which is always a bug in the
 * chain above rather than in the file.
 */
export function migrate(envelope: SaveEnvelope): MigrationOutcome {
  const fromVersion = envelope.formatVersion;

  if (fromVersion > CURRENT_FORMAT_VERSION) {
    throw new SaveFormatTooNewError(fromVersion, CURRENT_FORMAT_VERSION);
  }

  if (fromVersion === CURRENT_FORMAT_VERSION) {
    return { envelope, fromVersion, steps: [] };
  }

  let payload = envelope.payload;
  const steps: number[] = [];

  for (let version = fromVersion; version < CURRENT_FORMAT_VERSION; version++) {
    const step = MIGRATIONS[version];
    if (step === undefined) throw new SaveMigrationMissingError(version);
    payload = step(payload);
    steps.push(version);
  }

  return {
    envelope: {
      formatVersion: CURRENT_FORMAT_VERSION,
      simVersion: envelope.simVersion,
      worldSeed: envelope.worldSeed,
      tick: envelope.tick,
      payload,
    },
    fromVersion,
    steps,
  };
}
