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
// The chain is five steps long: format 1 (v0.1 — field, machines, inventory, stats) up to
// format 2 (the factory — belts, grabbers, zones, tech unlocks, upgrade dials, and the
// per-tile withering clock) up to format 3 (the liquid layer — reservoirs, pipes, one-ledger
// networks, and the per-machine plumbing fields) up to format 4 (the walk-to errand — one
// pending `PlayerIntent` on the player, or none) up to format 5 (maintenance and overcooking
// — a machine's blocked clock and burnt count, and the waste and repair-kit tallies) up to
// format 6 (the soda line — one input count per recipe LINE instead of a single `inputCount`,
// and typed liquid ports on a converter).

import type { SaveEnvelope } from './envelope';
import { SaveCorruptError, SaveFormatTooNewError, SaveMigrationMissingError } from './errors';

/**
 * The envelope/payload shape this build writes and reads.
 *
 * Bump it in the same commit that adds the migration step which reaches it. A bump without
 * a step is a hole in the chain, and `migrate` throws rather than guessing.
 */
export const CURRENT_FORMAT_VERSION = 6;

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
 * The pond AS IT WAS WHEN FORMAT 3 ARRIVED, frozen here as literals for the same reason the
 * format-1 prices above are frozen: a migration that looked up today's `data.ts` would give
 * the same file a different pond every time the balance table moved. These numbers are the
 * record of what a reservoir was on the day format 3 shipped, and they are never updated.
 */
const FORMAT_3_POND = {
  tileX: 12,
  tileY: 13,
  tilesWide: 3,
  tilesHigh: 3,
  capacityMl: 20_000_000,
} as const;

/**
 * Format 2 → 3.
 *
 * EVERY EXISTING WORLD GAINS A FULL POND. Not an empty one: the water was always notionally
 * there — v0.1's `takeWater` seam drew from an infinite supply — so a returning player must
 * not find their pond mysteriously drained by an update they did not ask for. Full is the
 * value that makes the loaded world behave like the one that was saved.
 *
 * Everything else takes its empty default: no pipes, no networks, no ceremonies played, every
 * machine unattached with a still flow and an idle scan cursor. `wateredCount` starts at zero
 * even for a v0.1 sprinkler that has watered a thousand tiles — the counter did not exist, so
 * inventing a number for it would be fiction, and it is a trophy stat rather than a gate.
 *
 * The pond's corner was picked to be clear of where existing worlds actually built — but if a
 * player happens to have put something on those nine tiles, the machine keeps working and the
 * water is simply drawn under it. Pick-up-and-move is free forever (plan §4), so an overlap is
 * a cosmetic annoyance the player can fix in one drag, never a fine and never a broken world.
 */
const migrateFormat2To3: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-2 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const machines: Record<string, unknown>[] = [];
  const oldMachines = rows(p, 'machines');
  for (let i = 0; i < oldMachines.length; i++) {
    machines.push({
      ...oldMachines[i]!,
      network: 0,
      flowMlPerMinute: 0,
      throttled: false,
      scanCursor: 0,
      wateredCount: 0,
      skippedCount: 0,
    });
  }

  return {
    ...p,
    ceremonies: [],
    machines,
    networks: [],
    nextPipeId: 1,
    nextReservoirId: 2,
    pipes: [],
    reservoirs: [
      {
        capacityMl: FORMAT_3_POND.capacityMl,
        id: 1,
        levelMl: FORMAT_3_POND.capacityMl,
        rechargeAccum: 0,
        tileX: FORMAT_3_POND.tileX,
        tileY: FORMAT_3_POND.tileY,
        tilesHigh: FORMAT_3_POND.tilesHigh,
        tilesWide: FORMAT_3_POND.tilesWide,
      },
    ],
    version: 3,
  };
};

/**
 * Format 3 → 4.
 *
 * NOBODY WAS MID-WALK WHEN A FORMAT-3 WORLD WAS WRITTEN, so `null` is the value that makes
 * the loaded world identical to the one that was saved. The errand did not exist; inventing
 * one for a returning player would be fiction, and it would be the *worst* kind — the farmer
 * would set off across the field on their own the moment the world loaded, which is exactly
 * the surprise `applySetMoveDirection` is arranged to prevent.
 *
 * This step reads no balance data at all, so unlike the two above it needs no frozen-constant
 * block: `null` is `null` in every build this file will ever run in.
 */
const migrateFormat3To4: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-3 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  // `rows()` only handles arrays, and the player is a lone object — so it is guarded inline,
  // to the same standard, rather than reached into and hoped about.
  const playerRaw = p['player'];
  if (typeof playerRaw !== 'object' || playerRaw === null || Array.isArray(playerRaw)) {
    throw new SaveCorruptError('Cannot migrate: `payload.player` is not an object.');
  }

  return {
    ...p,
    player: { ...(playerRaw as Record<string, unknown>), intent: null },
    version: 4,
  };
};

/**
 * Format 4 → 5.
 *
 * Maintenance and overcooking. Three new counters on the stats block and two new fields on
 * every machine, and **zero is the right value for all five** — which is a claim worth
 * spelling out rather than assuming, because "default to zero" is how a migration usually
 * goes wrong.
 *
 * `blockedTicks` and `overcookedCount` are a Fryer's overcooking clock and its burnt count.
 * A format-4 world never had them, so no chip in it ever browned; inventing a burnt batch for
 * a returning player would take goods they earned and mark them down 30%. Zero says "nothing
 * has spoiled", which is exactly what was true of the world they saved. The clock restarting
 * is likewise correct rather than generous: it counts *continuous* blockage, and a world that
 * was closed and reopened has not been standing still — time did not pass at all.
 *
 * `inputsWastedByMachine`, `repairKitsUsed`, and `repairKitSpendCents` are lifetime tallies,
 * and zero is the only honest number for a world that could not waste an input or use a kit
 * because neither existed. They are trophy stats rather than gates, so a returning player
 * loses nothing by starting them here — the same call `wateredCount` made in format 3.
 *
 * Like the step above it, this one reads no balance data, so it needs no frozen-constant
 * block: zero is zero in every build this file will ever run in.
 */
const migrateFormat4To5: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-4 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const machines: Record<string, unknown>[] = [];
  const oldMachines = rows(p, 'machines');
  for (let i = 0; i < oldMachines.length; i++) {
    machines.push({ ...oldMachines[i]!, blockedTicks: 0, overcookedCount: 0 });
  }

  const statsRaw = p['stats'];
  if (typeof statsRaw !== 'object' || statsRaw === null || Array.isArray(statsRaw)) {
    throw new SaveCorruptError('Cannot migrate: `payload.stats` is not an object.');
  }

  return {
    ...p,
    machines,
    stats: {
      ...(statsRaw as Record<string, unknown>),
      inputsWastedByMachine: 0,
      repairKitSpendCents: 0,
      repairKitsUsed: 0,
    },
    version: 5,
  };
};

/**
 * How many lines of recipe each machine kind had WHEN FORMAT 5 WAS CURRENT, frozen as literals.
 *
 * The same discipline as `FORMAT_1_MACHINE_PRICE_CENTS` above, and for the same reason: a
 * migration that called `machineSpec()` would produce a different world every time the recipe
 * table moved, so the same file read by two builds would become two different worlds. In
 * format 5 the answer was always "one, or none" — `inputItem` was a single field — so this
 * table is the record of which kinds had one.
 *
 * A kind that is not in this table is a kind that did not exist in format 5, so a format-5 save
 * cannot contain one; `?? 0` is the honest reading of an id that could not have been written.
 */
const FORMAT_5_MACHINE_INPUT_SLOTS: Readonly<Record<number, number>> = {
  1: 0, // SellBin
  2: 1, // ChipKitchen
  3: 0, // Sprinkler
  4: 1, // Washer
  5: 1, // Slicer
  6: 1, // Fryer
  7: 1, // Seasoner
  8: 1, // Bagger
  9: 0, // Pump
  10: 0, // Tank
  11: 0, // PipedSprinkler
  12: 0, // IrrigationHub
  13: 0, // Recirculator
};

/**
 * Format 5 → 6.
 *
 * The soda line made a recipe a LIST. A machine that held one `inputCount` now holds one count
 * per line of its recipe, and a converter may carry typed liquid ports of its own.
 *
 * The conversion is exact rather than defaulted, which is the whole reason the table above
 * exists: a format-5 Washer holding six potatoes becomes `inputCounts: [6]`, and a format-5
 * Pump — which had an `inputCount` field it never used, because every machine did — becomes
 * `inputCounts: []`. Writing `[inputCount]` for both would give the Pump a buffer slot that a
 * freshly built Pump does not have, and the two worlds would hash differently while being the
 * same world. That is the exact failure mode this directory exists to prevent, and it is
 * invisible without this table.
 *
 * `ports: []` for every machine, with no table needed: no machine in format 5 had one. The
 * soda machines did not exist, and the water machines are plumbed through `network`/`tankMl`
 * exactly as they were — this step does not touch them.
 */
const migrateFormat5To6: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-5 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const machines: Record<string, unknown>[] = [];
  const oldMachines = rows(p, 'machines');
  for (let i = 0; i < oldMachines.length; i++) {
    const machine = oldMachines[i]!;
    const kind = machine['kind'];
    const slots = typeof kind === 'number' ? (FORMAT_5_MACHINE_INPUT_SLOTS[kind] ?? 0) : 0;
    const held = machine['inputCount'];
    const count = typeof held === 'number' && Number.isInteger(held) ? held : 0;

    const next: Record<string, unknown> = {
      ...machine,
      inputCounts: slots > 0 ? [count] : [],
      ports: [],
    };
    // The old field goes, rather than lingering as a second opinion about what the machine
    // holds. A payload with both would round-trip through `toPayload` without it anyway, so
    // leaving it would make the migrated file differ from the re-saved one for one save only.
    delete next['inputCount'];
    machines.push(next);
  }

  return { ...p, machines, version: 6 };
};

/**
 * Keyed by the version being migrated *from*: `MIGRATIONS[1]` turns a format-1 payload into
 * a format-2 payload, which `MIGRATIONS[2]` then turns into a format-3 one, and so on up the
 * chain to the current version.
 */
export const MIGRATIONS: Readonly<Record<number, SaveMigration>> = {
  1: migrateFormat1To2,
  2: migrateFormat2To3,
  3: migrateFormat3To4,
  4: migrateFormat4To5,
  5: migrateFormat5To6,
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
