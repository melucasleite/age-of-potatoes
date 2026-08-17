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
// The chain is eight steps long: format 1 (v0.1 — field, machines, inventory, stats) up to
// format 2 (the factory — belts, grabbers, zones, tech unlocks, upgrade dials, and the
// per-tile withering clock) up to format 3 (the liquid layer — reservoirs, pipes, one-ledger
// networks, and the per-machine plumbing fields) up to format 4 (the walk-to errand — one
// pending `PlayerIntent` on the player, or none) up to format 5 (maintenance and overcooking
// — a machine's blocked clock and burnt count, and the waste and repair-kit tallies) up to
// format 6 (the soda line — one input count per recipe LINE instead of a single `inputCount`,
// and typed liquid ports on a converter) up to format 7 (deconstruct to inventory — an
// inventory slot carries the boxed machines in it, dials and condition and invoice each) up to
// format 8 (land deeds — the lot is a 4×4 grid of 16-tile parcels and a world records which of
// them it owns; every older world owns parcel 0, which is the map it already had) up to
// format 9 (selling above the roadside stand — standing contracts as a sorted list of their
// own, three delivery-cart fields on every machine, and one more lifetime accumulator) up to
// format 10 (the third Charter and the belt junction — the untouched-work clock every machine
// keeps, the two round-robin cursors a junction alternates on, and the high-water mark the
// Corporate Charter's milestone is read off) up to format 11 (the farm — a spoil tick on every
// perishable stack in the bag, soil and a moisture remainder and a fertility counter on every
// tile, the zone a bot dock is bound to, the cart the player is towing, and a sorted list of
// Agri-Bots) up to format 12 (the eight-pour can and the receipt ledgers — the can's charge
// counter on the player, and per-item sales, dawn-aligned hour buckets, the open hour's mark,
// and the dawn counter on the stats).
//
// This paragraph stopped being extended at format 12 and the chain has run on to 18 without it;
// `MIGRATIONS` below is the authority, and each step carries its own story in its own doc comment.
// The newest is format 18 — the clock inside a box, so a trip through storage preserves a good's
// remaining freshness instead of minting a fresh window on the way out.

import type { SaveEnvelope } from './envelope';
import { SaveCorruptError, SaveFormatTooNewError, SaveMigrationMissingError } from './errors';

/**
 * The envelope/payload shape this build writes and reads.
 *
 * Bump it in the same commit that adds the migration step which reaches it. A bump without
 * a step is a hole in the chain, and `migrate` throws rather than guessing.
 */
export const CURRENT_FORMAT_VERSION = 21;

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
 * Format 6 → 7.
 *
 * Deconstruct-to-inventory. A machine can now come off the lot as a BOXED ITEM, so every
 * inventory slot carries a list of the boxed machines in it — dials, condition and invoice each
 * — beside its count.
 *
 * **Empty is the only honest value, and it is honest for a reason worth stating.** "Default to
 * zero" is how a migration usually goes wrong, but here the empty list is not a guess about
 * missing information: a format-6 world could not contain a boxed machine, because there was no
 * verb that made one and no item id that held one. Every slot in every format-6 save is a stack
 * of goods or seeds, and a stack of goods has no boxes. There is nothing to reconstruct.
 *
 * The two new errand verbs — Deconstruct and Buy — need no step at all. A pending `PlayerIntent`
 * already round-trips as an integer `action`, and no format-6 payload can carry a 10 or an 11
 * because neither existed to be issued; the load-time allowlist simply accepts two more values
 * than it did.
 *
 * Like the three steps above it this one reads no balance data, so it needs no frozen-constant
 * block: an empty list is an empty list in every build this file will ever run in.
 */
const migrateFormat6To7: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-6 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const inventory: Record<string, unknown>[] = [];
  const oldInventory = rows(p, 'inventory');
  for (let i = 0; i < oldInventory.length; i++) {
    inventory.push({ ...oldInventory[i]!, boxes: [] });
  }

  return { ...p, inventory, version: 7 };
};

/**
 * The parcel a world owned WHEN FORMAT 8 ARRIVED, frozen here as a literal.
 *
 * `STARTING_PARCEL` is 0 today and the migration would read the same number if it imported it —
 * but it must not, for the reason the frozen tables above exist: the day somebody moves the
 * starting parcel, every format-7 save must still migrate to the map it was actually saved on,
 * not to whatever the current build calls the starting lot. Zero is where the 16×16 world was.
 */
const FORMAT_8_STARTING_PARCEL = 0;

/**
 * The lot's width in tiles BEFORE and AFTER land deeds, frozen as literals.
 *
 * These are here for the one thing in format 8 that is not a new field: **a pipe network's id
 * is a row-major world tile index**, so it is arithmetic on the map's width, and the map's
 * width changed. A format-7 network id was computed at 16 tiles a row; the same pipes on a
 * 64-wide map compute a different number, and `rebuildNetworks()` — which runs on the next
 * edit, whatever that edit is — would silently renumber every network on the lot.
 *
 * That renumbering is where the bug would have been. It is invisible: nothing breaks, the
 * water keeps flowing, and the only symptom is that a world loaded from a file hashes
 * differently from the identical world built fresh, until some unrelated edit quietly brings
 * them back into agreement. So the translation happens HERE, once, where it is written down.
 */
const FORMAT_7_WORLD_TILES_WIDE = 16;
const FORMAT_8_WORLD_TILES_WIDE = 64;

/** A format-7 row-major tile index, re-expressed on the wider map. Zero stays zero. */
function widenTileIndex(index: number): number {
  if (!Number.isInteger(index) || index <= 0) return index;
  const x = index % FORMAT_7_WORLD_TILES_WIDE;
  const y = Math.floor(index / FORMAT_7_WORLD_TILES_WIDE);
  return y * FORMAT_8_WORLD_TILES_WIDE + x;
}

/**
 * Format 7 → 8.
 *
 * Land deeds. The lot became a 4×4 grid of 16-tile parcels and a world now records which of
 * them it holds the deed to.
 *
 * **`[0]` IS NOT A DEFAULT, IT IS THE MAP THE SAVE WAS WRITTEN ON.** Every format-7 world was
 * born on a 16×16 lot whose north-west corner is the origin, and the new grid grows east and
 * south from that same origin — so the tiles a format-7 payload names are, one for one, the
 * tiles of parcel 0. Nothing is translated: the field is still at (4,4), the pond is still at
 * (12,13), and every machine, belt, pipe and pending errand comes back at the coordinates it
 * was saved at. That is the whole compatibility argument, and it is why the grid grew outward
 * instead of centring the old lot inside the new one — centring is prettier and would have
 * required moving every coordinate in every save by (+16,+16), which is a migration that moves
 * a player's factory to buy symmetry nobody can see from inside the world.
 *
 * The money is untouched too. Parcel 0 is the free starter lot (plan §5), so a returning player
 * is not billed for the land they already had, and `landValueCents` counts purchases beyond the
 * first — which for a migrated world is none.
 *
 * **The one thing that does move is the network ids**, and they are not coordinates — they are
 * row-major tile indices, which are arithmetic on the map's width. Every reference to one is
 * rewritten together (`networks[].id`, `pipes[].network`, `machines[].network`, and each typed
 * port's `network`) so the loaded world names its plumbing exactly as a freshly built copy of
 * it would. See `widenTileIndex`. Not a tile in the world moves; a pipe at (12,13) is still at
 * (12,13), and the network it belongs to is now called 844 instead of 220.
 */
const migrateFormat7To8: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-7 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const networks: Record<string, unknown>[] = [];
  const oldNetworks = rows(p, 'networks');
  for (let i = 0; i < oldNetworks.length; i++) {
    const network = oldNetworks[i]!;
    const id = network['id'];
    networks.push({ ...network, id: typeof id === 'number' ? widenTileIndex(id) : id });
  }

  const pipes: Record<string, unknown>[] = [];
  const oldPipes = rows(p, 'pipes');
  for (let i = 0; i < oldPipes.length; i++) {
    const pipe = oldPipes[i]!;
    const network = pipe['network'];
    pipes.push({
      ...pipe,
      network: typeof network === 'number' ? widenTileIndex(network) : network,
    });
  }

  const machines: Record<string, unknown>[] = [];
  const oldMachines = rows(p, 'machines');
  for (let i = 0; i < oldMachines.length; i++) {
    const machine = oldMachines[i]!;
    const network = machine['network'];
    const oldPorts = machine['ports'];
    const ports: unknown[] = [];
    if (Array.isArray(oldPorts)) {
      for (let j = 0; j < oldPorts.length; j++) {
        const port = oldPorts[j] as Record<string, unknown>;
        if (typeof port !== 'object' || port === null) {
          ports.push(port);
          continue;
        }
        const portNetwork = port['network'];
        ports.push({
          ...port,
          network: typeof portNetwork === 'number' ? widenTileIndex(portNetwork) : portNetwork,
        });
      }
    }
    machines.push({
      ...machine,
      network: typeof network === 'number' ? widenTileIndex(network) : network,
      ports: Array.isArray(oldPorts) ? ports : oldPorts,
    });
  }

  return {
    ...p,
    machines,
    networks,
    ownedParcels: [FORMAT_8_STARTING_PARCEL],
    pipes,
    version: 8,
  };
};

/**
 * Format 8 → 9.
 *
 * Selling above the roadside stand: the delivery cart, the truck depot, and standing contracts.
 *
 * **THE EASIEST MIGRATION IN THE CHAIN, AND FOR A REASON WORTH WRITING DOWN.** A format-8 world
 * could not contain a cart, a depot, or a route — the machine kinds did not exist, so no save
 * can name one, and there was no verb that made a contract. So this adds empty and zero
 * everywhere and translates nothing. Contrast format 5 → 6, which had to *invent* the recipe a
 * machine had been eating, from a frozen table, because the information genuinely was not in the
 * file. Here it is: a world with no vehicles is exactly a world with no vehicles.
 *
 * The three cart fields land on every machine rather than only on carts. That is what
 * `fromPayload` demands — it reads each field by name and fails on a missing one, which is the
 * property that makes a corrupt save name its first bad field instead of loading as a world
 * full of `undefined` — and it is the same shape format 5 → 6 used when it gave every machine a
 * `ports: []` it mostly had no use for.
 *
 * `automatedGrossCents` starts at 0 and that is not an approximation. It counts money that left
 * on a cart or a truck, and in a format-8 world none ever did: every cent of
 * `lifetimeEarnedCents` was carried to the bin by hand. The returning player's Dispatch panel
 * correctly reads "nothing shipped yet", because nothing has been.
 */
const migrateFormat8To9: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-8 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const machines: Record<string, unknown>[] = [];
  const oldMachines = rows(p, 'machines');
  for (let i = 0; i < oldMachines.length; i++) {
    machines.push({ ...oldMachines[i]!, cargoItem: 0, cargoCount: 0, runTicksRemaining: 0 });
  }

  const oldStats = p['stats'];
  if (typeof oldStats !== 'object' || oldStats === null || Array.isArray(oldStats)) {
    throw new SaveCorruptError('Cannot migrate: `payload.stats` is not an object.');
  }
  const stats = { ...(oldStats as Record<string, unknown>), automatedGrossCents: 0 };

  return { ...p, contracts: [], machines, nextContractId: 1, stats, version: 9 };
};

/**
 * Format 9 → 10.
 *
 * The third Charter and the belt junction. Three fields on every machine and one on the stats
 * block, all of them zero, and — like format 8 → 9 before it — **nothing is translated, because
 * there is nothing in a format-9 file to translate.**
 *
 * That is a claim worth being precise about rather than a shrug, since "add a zero" is exactly
 * how a migration quietly invents a world that never existed:
 *
 * - `junctionInCursor` / `junctionOutCursor` — `MachineKind.BeltJunction` did not exist, so no
 *   format-9 save can name one. Zero is not a default here; it is the only value these could
 *   have had, on machines that will never read them.
 * - `untouchedTicks` — the clock was not kept, so no format-9 world knows how long any of its
 *   machines had been running untouched. Zero is the honest answer and it is also the *correct*
 *   one: the counter measures a run that is still going, and a save/load is not a hand on the
 *   machine but the run it was in the middle of is no longer something this build can vouch for.
 *   A returning player's line starts earning its ten days from the tick they load.
 * - `longestUntouchedMachineTicks` — the high-water mark of a number that was never taken. The
 *   returning player has demonstrated nothing yet, which is exactly what the Corporate Charter's
 *   progress bar will say, and it is true.
 */
const migrateFormat9To10: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-9 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const machines: Record<string, unknown>[] = [];
  const oldMachines = rows(p, 'machines');
  for (let i = 0; i < oldMachines.length; i++) {
    machines.push({
      ...oldMachines[i]!,
      untouchedTicks: 0,
      junctionInCursor: 0,
      junctionOutCursor: 0,
    });
  }

  const oldStats = p['stats'];
  if (typeof oldStats !== 'object' || oldStats === null || Array.isArray(oldStats)) {
    throw new SaveCorruptError('Cannot migrate: `payload.stats` is not an object.');
  }
  const stats = { ...(oldStats as Record<string, unknown>), longestUntouchedMachineTicks: 0 };

  return { ...p, machines, stats, version: 10 };
};

/**
 * The freshness windows AS THEY WERE WHEN FORMAT 11 ARRIVED, frozen here as literals.
 *
 * The same discipline as `FORMAT_1_MACHINE_PRICE_CENTS` and `FORMAT_5_MACHINE_INPUT_SLOTS`, and
 * the same reason: a migration that called `freshnessTicks()` would stamp a different deadline on
 * the same file every time the table moved, so one save read by two builds would become two
 * different worlds — which is precisely what this directory exists to prevent. These numbers are
 * the record of what a potato kept for on the day spoilage shipped, and they are never updated.
 *
 * An id that is not here did not perish in format 11 and gets no stack, which is also how a
 * shelf-stable good is represented in a live world: an empty list rather than a long deadline.
 */
const FORMAT_11_FRESHNESS_TICKS: Readonly<Record<number, number>> = {
  2: 18_000, // RussetPotato
  51: 18_000, // GoldPotato
  11: 18_000, // SugarCane
  14: 18_000, // Corn
  17: 18_000, // ChiliPepper
  53: 18_000, // Orange
  54: 18_000, // Lemon
  8: 9_000, // DayOldPotato
  52: 9_000, // DayOldGoldPotato
  12: 9_000, // DayOldCane
  15: 9_000, // DayOldCorn
  18: 9_000, // DayOldChili
  4: 7_200, // WashedPotato
  5: 7_200, // PotatoSlices
};

/** The bucket spoil ticks were quantised to when format 11 shipped. Frozen for the same reason. */
const FORMAT_11_FRESHNESS_BUCKET_TICKS = 300;

/**
 * Format 10 → 11.
 *
 * The farm release, and the widest step in the chain: harvested goods gained a clock, the crop
 * roster reached eight, the assisted tier arrived, and so did the Agri-Bots. **Four items in one
 * step because they land in one release** — the rule this file opens with is that a *released*
 * migration is never edited, and 11 is not released until this ships, so one step is the whole
 * change rather than four steps nobody could ever have run separately.
 *
 * Most of it is empty and zero, and each of those is a claim rather than a shrug:
 *
 * - **`bots: []` and `nextBotId: 1`.** `MachineKind.HarvesterDock` did not exist, so no format-10
 *   save can name one, so no bot can exist to have been saved. Not a default — the only value.
 * - **`player.towedCartId: 0`.** The hand cart did not exist either. Zero is "not towing", which
 *   is what every format-10 player was doing.
 * - **`machines[].boundZone: 0`.** A dock is the only machine that reads it and there were none.
 * - **`field[].fertilityWear: 0` and `moistureAccum: 0`.** Both are remainders, and a returning
 *   player starts each one at the beginning of its cycle. `fertilityWear` at zero is *generous* —
 *   a tile harvested four times under format 10 comes back with a full five harvests before it
 *   loses a star — and that is the right direction to be wrong in, because the alternative is
 *   billing a player for harvests they took under rules that did not charge for them.
 *
 * **`field[].soil: Loam` IS THE ONE THAT IS NOT A DEFAULT, AND IT MATTERS.** The obvious move is
 * to roll soil for a migrated world so old lots get the variety new ones have. That would be a
 * migration that reaches into the RNG (which it must not) *and* a migration that changes the
 * ground under crops already growing: `growthTarget` is computed from the soil AT SOWING, so a
 * tile carrying a half-grown potato has a target that was calculated at loam rates, and calling
 * that tile clay afterwards would leave a crop whose target agrees with no soil at all. Loam is
 * 1000‰ on both axes — exactly the behaviour every format-10 tile actually had — so it is the
 * value that makes the loaded world identical to the one that was saved. New worlds roll soil;
 * old ones are loam, honestly, forever.
 *
 * **THE ONE THING THAT IS ACTUALLY COMPUTED IS FRESHNESS**, and it is computed to be generous on
 * purpose. Item 035's instruction is that no existing world loses anything on load, and the
 * world that was saved had no clock at all — so every perishable stack comes back with its FULL
 * window ahead of it, measured from the tick the save was written. A returning player opens their
 * bag to twelve fresh potatoes rather than to twelve that turned while the tab was shut, which is
 * the same promise the format 1 → 2 step made about the withering clock and for the same reason:
 * time does not pass when nobody is playing, and a migration must not be the one exception.
 */
const migrateFormat10To11: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-10 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const tickRaw = p['tick'];
  const tick = typeof tickRaw === 'number' && Number.isInteger(tickRaw) ? tickRaw : 0;

  const inventory: Record<string, unknown>[] = [];
  const oldInventory = rows(p, 'inventory');
  for (let i = 0; i < oldInventory.length; i++) {
    const slot = oldInventory[i]!;
    const item = slot['item'];
    const countRaw = slot['count'];
    const count = typeof countRaw === 'number' && Number.isInteger(countRaw) ? countRaw : 0;
    const window = typeof item === 'number' ? FORMAT_11_FRESHNESS_TICKS[item] : undefined;

    const stacks: Record<string, unknown>[] = [];
    if (window !== undefined && count > 0) {
      const deadline =
        Math.floor((tick + window) / FORMAT_11_FRESHNESS_BUCKET_TICKS) *
        FORMAT_11_FRESHNESS_BUCKET_TICKS;
      stacks.push({ count, spoilAtTick: deadline });
    }
    inventory.push({ ...slot, stacks });
  }

  const field: Record<string, unknown>[] = [];
  const oldField = rows(p, 'field');
  for (let i = 0; i < oldField.length; i++) {
    field.push({ ...oldField[i]!, moistureAccum: 0, soil: FORMAT_11_LOAM, fertilityWear: 0 });
  }

  const machines: Record<string, unknown>[] = [];
  const oldMachines = rows(p, 'machines');
  for (let i = 0; i < oldMachines.length; i++) {
    machines.push({ ...oldMachines[i]!, boundZone: 0 });
  }

  const playerRaw = p['player'];
  if (typeof playerRaw !== 'object' || playerRaw === null || Array.isArray(playerRaw)) {
    throw new SaveCorruptError('Cannot migrate: `payload.player` is not an object.');
  }

  return {
    ...p,
    bots: [],
    field,
    inventory,
    machines,
    nextBotId: 1,
    player: { ...(playerRaw as Record<string, unknown>), towedCartId: 0 },
    version: 11,
  };
};

/**
 * `SoilType.Loam` AS IT WAS WHEN FORMAT 11 ARRIVED. One is one in every build this file will run
 * in — but the id is save surface, and a migration that imported `SoilType` would start writing
 * whatever a future table called loam. See the step above for why loam specifically.
 */
const FORMAT_11_LOAM = 1;

/**
 * The calendar and the can AS THEY WERE WHEN FORMAT 12 ARRIVED, frozen as literals for the
 * same reason every other `FORMAT_N_*` constant is: a migration that imported
 * `CAN_CHARGES_MAX` or `DAWN_TICK_IN_DAY` would write a different world the day either
 * number moved.
 */
const FORMAT_12_CAN_CHARGES = 8;
const FORMAT_12_TICKS_PER_DAY = 9_600;
const FORMAT_12_DAWN_TICK_IN_DAY = 8_400;
const FORMAT_12_TICKS_PER_HOUR = 72_000;

/**
 * Format 11 → 12.
 *
 * The eight-pour can (item 009's 2026-08-13 ruling) and the receipt ledgers (item 062), in
 * one step because they land in one release.
 *
 * - **`player.canCharges: 8` — full, and that is a claim rather than generosity.** Under
 *   format 11 the can was infinite; at the moment of loading, an infinite can and a full one
 *   are indistinguishable, and full is the value that makes the loaded world behave like the
 *   one that was saved for the first eight pours. (It is also the direction plan §1 errs in:
 *   nobody returns from a reload to a chore.)
 * - **`stats.salesByItem: []` and `stats.hours: []` — empty, honestly.** The world sold
 *   things and worked hours that were never recorded, and a migration must not invent
 *   history. The Dawn Report's best seller starts counting from the load; the display-side
 *   ledger it replaces did exactly the same on every reload.
 * - **`stats.hourMark` — opened AT the load tick, with the saved lifetime accumulators as its
 *   starting line.** So the first bucket this world ever closes contains only what happened
 *   after the load, which is the same telescoping truth every later bucket has.
 * - **`stats.dawnsSeen` — computed from the saved tick** with the frozen calendar, so loading
 *   is not mistaken for a dawn and nothing resets on the first tick.
 *
 * The hour index arithmetic is restated from `hourIndexAt` with frozen literals: hour 0 runs
 * to the first dawn (tick 8,400), and every hour after is 72,000 ticks wide.
 */
const migrateFormat11To12: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-11 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const tickRaw = p['tick'];
  const tick = typeof tickRaw === 'number' && Number.isInteger(tickRaw) ? tickRaw : 0;

  const playerRaw = p['player'];
  if (typeof playerRaw !== 'object' || playerRaw === null || Array.isArray(playerRaw)) {
    throw new SaveCorruptError('Cannot migrate: `payload.player` is not an object.');
  }

  const statsRaw = p['stats'];
  if (typeof statsRaw !== 'object' || statsRaw === null || Array.isArray(statsRaw)) {
    throw new SaveCorruptError('Cannot migrate: `payload.stats` is not an object.');
  }
  const stats = statsRaw as Record<string, unknown>;

  const lifetime = (key: string): number => {
    const value = stats[key];
    return typeof value === 'number' && Number.isInteger(value) ? value : 0;
  };

  const hour =
    tick < FORMAT_12_DAWN_TICK_IN_DAY
      ? 0
      : Math.floor((tick - FORMAT_12_DAWN_TICK_IN_DAY) / FORMAT_12_TICKS_PER_HOUR) + 1;
  const dawnsSeen = Math.floor((tick - FORMAT_12_DAWN_TICK_IN_DAY) / FORMAT_12_TICKS_PER_DAY) + 1;

  return {
    ...p,
    player: { ...(playerRaw as Record<string, unknown>), canCharges: FORMAT_12_CAN_CHARGES },
    stats: {
      ...stats,
      dawnsSeen: dawnsSeen < 0 ? 0 : dawnsSeen,
      hourMark: {
        earnedCents: lifetime('lifetimeEarnedCents'),
        hour,
        inputsWasted: lifetime('inputsWastedByMachine'),
        itemsProduced: lifetime('itemsProducedByMachine'),
        itemsSold: lifetime('itemsSold'),
        spentCents: lifetime('lifetimeSpentCents'),
        tick,
        waterMl: lifetime('waterDrawnMl'),
      },
      hours: [],
      salesByItem: [],
    },
    version: 12,
  };
};

/**
 * The field rectangle AS IT WAS WHEN FORMAT 13 ARRIVED, frozen as literals like every other
 * `FORMAT_N_*` constant: a migration that imported `FIELD_ORIGIN_X` would relocate every old
 * save's farm the day somebody moved the starting field. `WORLD_TILES_WIDE` is likewise
 * frozen because the world tile KEY (`tileY * width + tileX`) is save surface from format 13
 * on — both in `soilMemory` and in a bot's `targetTile`.
 */
const FORMAT_13_FIELD_ORIGIN_X = 4;
const FORMAT_13_FIELD_ORIGIN_Y = 4;
const FORMAT_13_FIELD_TILES_WIDE = 8;
const FORMAT_13_WORLD_TILES_WIDE = 64;
/** `BotKind.Repair` as it stood: the one kind whose `targetTile` is a machine id, not a tile. */
const FORMAT_13_BOT_KIND_REPAIR = 3;

/**
 * Format 12 → 13: the till tool (item 066). Farmland becomes a keyed collection.
 *
 * - **Every field tile gains its coordinate**, computed from its index in the legacy 8×8
 *   row-major rect. Nothing else about the tile changes — same soil, same moisture, same
 *   crop, same fertility, same zone — so the migrated field is the same dirt with its
 *   address written on it. Row-major over the rect is ascending world-key order, so the
 *   array is already sorted the way format 13 requires.
 * - **`soilMemory` is built from the field itself**: one entry per tile, carrying the soil
 *   the tile was born with and the fertility it has RIGHT NOW. The ledger's job is to make
 *   re-tilling hand back what un-tilling took away, and for a world loaded at this moment,
 *   what would be taken away is the current state — no history is invented.
 * - **A field bot's `targetTile` becomes a world tile key** (it was an index into the field
 *   array, which tilling can now reorder). A repair drone's `targetTile` is a machine id and
 *   is left exactly alone; -1 stays -1.
 */
const migrateFormat12To13: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-12 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const tileKeyForIndex = (index: number): number => {
    const tileX = FORMAT_13_FIELD_ORIGIN_X + (index % FORMAT_13_FIELD_TILES_WIDE);
    const tileY = FORMAT_13_FIELD_ORIGIN_Y + Math.floor(index / FORMAT_13_FIELD_TILES_WIDE);
    return tileY * FORMAT_13_WORLD_TILES_WIDE + tileX;
  };

  const field: Record<string, unknown>[] = [];
  const soilMemory: Record<string, unknown>[] = [];
  const oldField = rows(p, 'field');
  for (let i = 0; i < oldField.length; i++) {
    const tile = oldField[i]!;
    const tileX = FORMAT_13_FIELD_ORIGIN_X + (i % FORMAT_13_FIELD_TILES_WIDE);
    const tileY = FORMAT_13_FIELD_ORIGIN_Y + Math.floor(i / FORMAT_13_FIELD_TILES_WIDE);
    field.push({ ...tile, tileX, tileY });
    soilMemory.push({
      fertility: tile['fertility'],
      fertilityWear: tile['fertilityWear'],
      soil: tile['soil'],
      tile: tileKeyForIndex(i),
    });
  }

  const bots: Record<string, unknown>[] = [];
  const oldBots = rows(p, 'bots');
  for (let i = 0; i < oldBots.length; i++) {
    const bot = oldBots[i]!;
    const kind = bot['kind'];
    const target = bot['targetTile'];
    const isFieldBot = kind !== FORMAT_13_BOT_KIND_REPAIR;
    const convertible =
      isFieldBot && typeof target === 'number' && Number.isInteger(target) && target >= 0;
    bots.push(convertible ? { ...bot, targetTile: tileKeyForIndex(target) } : { ...bot });
  }

  return { ...p, bots, field, soilMemory, version: 13 };
};

/**
 * Format 13 → 14: the cheat counter (item 075). `stats.cheatsUsed` joins `WorldStats`,
 * hashed like every accumulator beside it.
 *
 * **ZERO, HONESTLY.** No format-13 world could have applied a `Cheat` command — the command
 * did not exist — so zero is not a default, it is the truth about every save this migration
 * will ever touch. Nothing else changes; the can's wider capacity (item 073, shipped in the
 * same wave) needs no migration at all, because a saved charge count merely loads as a
 * partly full can under the raised cap.
 */
const migrateFormat13To14: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-13 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const statsRaw = p['stats'];
  if (typeof statsRaw !== 'object' || statsRaw === null || Array.isArray(statsRaw)) {
    throw new SaveCorruptError('Cannot migrate: `payload.stats` is not an object.');
  }

  return {
    ...p,
    stats: { ...(statsRaw as Record<string, unknown>), cheatsUsed: 0 },
    version: 14,
  };
};

/**
 * `MachineKind.HarvesterDock` AS IT WAS WHEN FORMAT 15 ARRIVED, frozen for the reason every
 * `FORMAT_N_*` literal is: the id space is permanent save surface, and a migration that
 * imported today's enum would start rewriting whatever a future table calls a dock.
 */
const FORMAT_14_HARVESTER_DOCK_KIND = 31;

/**
 * Crop id → the FRESH item that crop yields, as both tables stood when format 15 arrived.
 *
 * This is the migration's one guess and its whole vocabulary. A format-14 harvester dock's
 * shelf was an anonymous `outputCount` — the identity was discarded at the moment the bot
 * unloaded, so no save on earth records what those goods were. The zone the dock is bound to
 * records what the zone GROWS, which is the best surviving witness: a dock's bot only ever
 * harvests its own zone, so the shelf almost certainly holds that crop's fresh yield. "Almost"
 * is the honest word — the goods could have been Day-Old if the zone wilted before a trip —
 * and fresh is the deliberate direction to be wrong in: a wrong guess beats deletion (plan §4,
 * nothing vanishes), and guessing Day-Old would mark down goods that were probably fine.
 */
const FORMAT_14_FRESH_ITEM_BY_CROP: Readonly<Record<number, number>> = {
  1: 2, // RussetPotato -> ItemId.RussetPotato
  2: 11, // SugarCane -> ItemId.SugarCane
  3: 14, // Corn -> ItemId.Corn
  4: 17, // ChiliPepper -> ItemId.ChiliPepper
  5: 51, // GoldPotato -> ItemId.GoldPotato
};

/** The guess of last resort: the starter crop's fresh yield, `ItemId.RussetPotato`. */
const FORMAT_14_DEFAULT_SHELF_ITEM = 2;

/**
 * Format 14 → 15: the harvester dock's shelf gains an identity (item 083).
 *
 * The dock's shelf becomes its CARGO — `cargoItem`/`cargoCount`, the pair the planter dock
 * already keeps seeds in — because the old shape was a stranding bug in production: goods
 * lived in `outputCount`, whose identity comes from the machine spec, and the dock's spec
 * says it makes nothing. A grabber asking "what is next out of this machine" got null, so
 * NOTHING a bot ever delivered could leave the dock, by arm or by hand.
 *
 * For each harvester dock with a stranded `outputCount`, the count moves onto the shelf and
 * the identity is GUESSED: the bound zone's crop's fresh item, from the frozen table above,
 * defaulting to RussetPotato when the dock is unbound, the zone is gone, or the zone grows
 * nothing. The guess is written here rather than hidden: identity was never recorded, so
 * this is reconstruction, biased fresh on purpose — nothing vanishes, and a wrong name on
 * real goods beats an honest deletion of them. In the one real stranded-dock save this
 * repository keeps (`format-11.json`, nine units on a potato zone's dock), the guess is
 * simply correct.
 *
 * Docks whose count is zero, and every other machine, pass through untouched. In particular
 * `payload.version` is NOT rewritten: that field is `WorldState.version` — hashed world
 * state that fresh saves write as the world's shape version — and stamping the format number
 * onto it would make a migrated world hash differently from the identical world built fresh.
 * The envelope's own `formatVersion` is what `migrate()` advances.
 */
const migrateFormat14To15: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-14 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const zoneCrops = new Map<number, number>();
  const zonesRaw = p['zones'];
  if (Array.isArray(zonesRaw)) {
    for (let i = 0; i < zonesRaw.length; i++) {
      const zone = zonesRaw[i] as Record<string, unknown>;
      if (typeof zone !== 'object' || zone === null) continue;
      const id = zone['id'];
      const crop = zone['crop'];
      if (typeof id === 'number' && typeof crop === 'number') zoneCrops.set(id, crop);
    }
  }

  const machines: Record<string, unknown>[] = [];
  const oldMachines = rows(p, 'machines');
  for (let i = 0; i < oldMachines.length; i++) {
    const machine = oldMachines[i]!;
    const countRaw = machine['outputCount'];
    const count = typeof countRaw === 'number' && Number.isInteger(countRaw) ? countRaw : 0;
    if (machine['kind'] !== FORMAT_14_HARVESTER_DOCK_KIND || count <= 0) {
      machines.push({ ...machine });
      continue;
    }

    const boundZone = machine['boundZone'];
    const crop = typeof boundZone === 'number' ? zoneCrops.get(boundZone) : undefined;
    const guessed =
      crop === undefined
        ? FORMAT_14_DEFAULT_SHELF_ITEM
        : (FORMAT_14_FRESH_ITEM_BY_CROP[crop] ?? FORMAT_14_DEFAULT_SHELF_ITEM);

    // No format-14 code path could put cargo on a harvester dock (`inputCapacity` 0, every
    // door refuses the kind), so the shelf is empty in any save the sim wrote — but a
    // hand-edited payload that somehow carries cargo keeps it: its own identity wins the
    // guess, and the counts merge rather than anything being thrown away.
    const cargoItemRaw = machine['cargoItem'];
    const cargoCountRaw = machine['cargoCount'];
    const existingItem = typeof cargoItemRaw === 'number' ? cargoItemRaw : 0;
    const existingCount =
      typeof cargoCountRaw === 'number' && Number.isInteger(cargoCountRaw) ? cargoCountRaw : 0;

    machines.push({
      ...machine,
      cargoItem: existingItem !== 0 ? existingItem : guessed,
      cargoCount: existingCount + count,
      outputCount: 0,
    });
  }

  return { ...p, machines };
};

/**
 * Format 15 → 16: the seed comes home (item 088).
 *
 * Every bot gains a SEED POCKET (`seedItem`/`seedCount`) and every machine gains the harvester
 * dock's SEED SHELF (`seedShelfItem`/`seedShelfCount`). All four land empty, and unlike format
 * 14 → 15 that is not a guess with a bias — it is the only honest answer.
 *
 * NOTHING IS BEING RECONSTRUCTED HERE, and the difference from its predecessor is worth naming.
 * Format 15's step had to invent an identity for goods whose name had genuinely been thrown
 * away. The seeds a format-15 world's bots discarded were never anywhere: `harvestUnderBot`
 * routed through `takeHarvest`, which returns no seed, so the seed was not stored badly — it
 * did not exist. There is no record to read, no witness to consult, and back-crediting a
 * plausible number of seeds to a returning player would be inventing inventory, which is a
 * worse sin than the parity bug it would pretend to have fixed. The bug stops on load; it is
 * not retroactively unpaid.
 *
 * The four fields land on EVERY machine and EVERY bot rather than only on harvester docks and
 * harvesters, exactly as format 8 → 9's cart fields did: `fromPayload` reads each field by name
 * and fails on a missing one, which is what makes a corrupt save name its first bad field
 * instead of loading as a world full of `undefined`.
 *
 * `payload.version` is NOT rewritten, for the reason format 14 → 15 spells out: that field is
 * hashed world state, and stamping the format number onto it would make a migrated world hash
 * differently from the identical world built fresh.
 */
const migrateFormat15To16: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-15 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const machines: Record<string, unknown>[] = [];
  const oldMachines = rows(p, 'machines');
  for (let i = 0; i < oldMachines.length; i++) {
    machines.push({ ...oldMachines[i]!, seedShelfItem: 0, seedShelfCount: 0 });
  }

  const bots: Record<string, unknown>[] = [];
  const oldBots = rows(p, 'bots');
  for (let i = 0; i < oldBots.length; i++) {
    bots.push({ ...oldBots[i]!, seedItem: 0, seedCount: 0 });
  }

  return { ...p, machines, bots };
};

// --- format 16 → 17: the parts economy retires (item 090) ------------------------------
//
// Frozen ids, because a migration must describe the world it is reading rather than the table
// this build happens to ship. Every one of these was true when format 16 was current and is
// what a format-16 payload means, whatever `data.ts` later calls them.
const FORMAT_17_PARTS_BENCH_KIND = 35;
const FORMAT_17_DRONE_BAY_KIND = 34;
const FORMAT_17_BOXED_PARTS_BENCH = 69;
const FORMAT_17_DRONE_PART = 66;
/** The Parts Bench recipe, in line order: line 0 was a Bottle, line 1 a Kola Powder. */
const FORMAT_17_BENCH_RECIPE: readonly number[] = [23, 22];

interface Format17Box {
  speedLevel: number;
  efficiencyLevel: number;
  capacityLevel: number;
  condition: number;
  investedCents: number;
}

function format17Int(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : 0;
}

/**
 * The slot for an item, created in canonical position when it is not there yet.
 *
 * PLAIN FUNCTIONS OVER THE RAW PAYLOAD, NOT A CALL TO `addItem`/`addBoxedMachine`, and the
 * duplication is the point: those two read `ItemSpec` for freshness and would stamp a spoil
 * clock from *today's* table onto goods a format-16 world was holding. A migration that imports
 * live sim code is a migration whose result changes when the game is rebalanced. Everything
 * this step returns is shelf-stable — bottles, kola powder and drone parts have never had a
 * freshness window — so `stacks` stays empty and the count alone is the truth.
 */
function format17Slot(slots: Record<string, unknown>[], item: number): Record<string, unknown> {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    if (format17Int(slot['item']) === item) return slot;
  }
  // Sorted ascending by item id, which is the invariant the hash and the loader both rest on.
  const created: Record<string, unknown> = { boxes: [], count: 0, item, stacks: [] };
  let insertAt = slots.length;
  for (let i = 0; i < slots.length; i++) {
    if (format17Int(slots[i]!['item']) > item) {
      insertAt = i;
      break;
    }
  }
  slots.splice(insertAt, 0, created);
  return created;
}

function format17AddItem(slots: Record<string, unknown>[], item: number, count: number): void {
  if (count <= 0) return;
  const slot = format17Slot(slots, item);
  slot['count'] = format17Int(slot['count']) + count;
}

/** Which of two boxes sorts first: `compareBoxes` in `state.ts`, restated in payload terms. */
const FORMAT_17_BOX_ORDER: readonly (keyof Format17Box)[] = [
  'investedCents',
  'speedLevel',
  'efficiencyLevel',
  'capacityLevel',
  'condition',
];

/** Put one box in the bag, least-invested-first — the order `peekBoxedMachine` promises. */
function format17AddBox(slots: Record<string, unknown>[], item: number, box: Format17Box): void {
  const slot = format17Slot(slots, item);
  const boxes = Array.isArray(slot['boxes']) ? (slot['boxes'] as Record<string, unknown>[]) : [];
  let insertAt = boxes.length;
  for (let i = 0; i < boxes.length && insertAt === boxes.length; i++) {
    const other = boxes[i]!;
    for (let k = 0; k < FORMAT_17_BOX_ORDER.length; k++) {
      const key = FORMAT_17_BOX_ORDER[k]!;
      const mine = box[key];
      const theirs = format17Int(other[key]);
      if (mine === theirs) continue;
      if (mine < theirs) insertAt = i;
      break;
    }
  }
  boxes.splice(insertAt, 0, { ...box });
  slot['boxes'] = boxes;
  slot['count'] = format17Int(slot['count']) + 1;
}

/**
 * Format 16 → 17: **the parts economy retires, and hands everything back** (item 090).
 *
 * The rule changed above this step: repair drones fix machines for free. That leaves two piles
 * of a returning player's property with no purpose and no owner — a Parts Bench standing on the
 * lot making a part nothing consumes, and whatever parts are sitting on a Drone Bay's hopper
 * shelf. **NEITHER IS DELETED.** Plan §4's floor does not have an exception for things the
 * design changed its mind about, and a player who logs in to find an $800 machine simply gone
 * has been robbed by a patch note.
 *
 * So this step is the DECONSTRUCT PATH, replayed on load, exactly as `applyDeconstructMachine`
 * would have run it if the player had walked over and boxed the bench themselves:
 *   * every bench's **output buffer** comes back as drone parts, and its **two recipe lines**
 *     come back as the bottles and kola powder they were — the recipe is frozen above rather
 *     than read from `machineSpec`, because a format-16 bench's line 1 is kola powder no matter
 *     what a future table says line 1 is;
 *   * every bench itself comes back as a **boxed Parts Bench** carrying its dials, its condition
 *     and — the number that actually matters — its **invoice**, which is what decides the 40% a
 *     scrapped box pays. A box credited at list would quietly rob an upgraded bench's owner;
 *   * every **Drone Bay's parts** come off the shelf and into the bag, and the shelf is cleared
 *     to the empty pair a bay has had since its door closed.
 *
 * The BAY ITSELF STAYS ON THE LOT with its drone, and that asymmetry is deliberate: the bench
 * lost its reason to exist, while the bay is the machine this item exists to improve. A player
 * who bought the capstone still owns the capstone; it simply stopped asking for anything.
 *
 * NOTHING ELSE IN THE PAYLOAD NAMES A BENCH, which is worth having checked rather than assumed:
 * a `PlayerIntent` addresses a TILE and not a machine id, so a pending errand aimed at a bench's
 * pad resolves the way one aimed at any machine that has been moved or boxed already resolves —
 * the arrival finds nothing there and the errand is refused. A bench is a converter, so it never
 * had a bot to orphan, it was never towed, and it never held a contract.
 *
 * `payload.version` is NOT rewritten, for the reason format 14 → 15 spells out: that field is
 * hashed world state, and stamping the format number onto it would make a migrated world hash
 * differently from the identical world built fresh.
 */
const migrateFormat16To17: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-16 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const inventory = rows(p, 'inventory').map((slot) => ({ ...slot }));

  const machines: Record<string, unknown>[] = [];
  const oldMachines = rows(p, 'machines');
  for (let i = 0; i < oldMachines.length; i++) {
    const machine = oldMachines[i]!;
    const kind = format17Int(machine['kind']);

    if (kind === FORMAT_17_DRONE_BAY_KIND) {
      // A bay's cargo was only ever parts, but the check is on the item rather than on the kind
      // — a hand-edited payload with something else on that shelf keeps whatever it named.
      const cargoItem = format17Int(machine['cargoItem']);
      const cargoCount = format17Int(machine['cargoCount']);
      if (cargoItem !== 0 && cargoCount > 0) format17AddItem(inventory, cargoItem, cargoCount);
      machines.push({ ...machine, cargoItem: 0, cargoCount: 0 });
      continue;
    }

    if (kind !== FORMAT_17_PARTS_BENCH_KIND) {
      machines.push({ ...machine });
      continue;
    }

    format17AddItem(inventory, FORMAT_17_DRONE_PART, format17Int(machine['outputCount']));
    const inputCounts = machine['inputCounts'];
    if (Array.isArray(inputCounts)) {
      for (let line = 0; line < FORMAT_17_BENCH_RECIPE.length; line++) {
        format17AddItem(inventory, FORMAT_17_BENCH_RECIPE[line]!, format17Int(inputCounts[line]));
      }
    }
    // A bench never had cargo — it is a converter, not a dock — but a payload that somehow
    // carries some keeps it, on the same "its own identity wins" principle format 15 → 16 used.
    const cargoItem = format17Int(machine['cargoItem']);
    const cargoCount = format17Int(machine['cargoCount']);
    if (cargoItem !== 0 && cargoCount > 0) format17AddItem(inventory, cargoItem, cargoCount);

    format17AddBox(inventory, FORMAT_17_BOXED_PARTS_BENCH, {
      speedLevel: format17Int(machine['speedLevel']),
      efficiencyLevel: format17Int(machine['efficiencyLevel']),
      capacityLevel: format17Int(machine['capacityLevel']),
      condition: format17Int(machine['condition']),
      investedCents: format17Int(machine['investedCents']),
    });
  }

  return { ...p, inventory, machines };
};

/**
 * Format 17 → 18: **every machine gains the clock its cargo is running on** (item 110).
 *
 * THE ONE FACT NO FORMAT 17 SAVE CAN EXPRESS is how much freshness the goods inside a container
 * have left. It could not, because until this item they had none: storage stamped a brand-new
 * window on the way OUT, from the tick the goods came back into the player's arms, so a round trip
 * through an $80 hand cart reset the clock and rot became something a player opted out of by
 * clicking twice. `cargoFreshTicks` is the remainder that now rides through the box.
 *
 * **EVERY MACHINE GETS 0, AND 0 MEANS "NO CLOCK" RATHER THAN "OUT OF TIME".** That is the generous
 * reading and it is chosen deliberately against the alternative of stamping a full window onto
 * every stocked container, which sounds equivalent and is not: a full window would START the cart
 * clock at load time for a player who is not here, and a returning owner would find an armful of
 * compost where their potatoes were. A migration must destroy nothing a player owns, and while
 * compost is not nothing (§4's floor), it is a ninety percent loss inflicted by a patch note.
 *
 * So an existing cellar or cart is GRANDFATHERED: its contents do not age, and they hand back a
 * full window exactly as they did under format 17 — the old behaviour, preserved for the goods
 * that were bought under it. It heals on contact and in the pessimistic direction: `putStorage`
 * treats a clockless box as an empty one, so the next armful a player adds sets a real clock over
 * the whole load, and `takeStorage` empties the container back to a true 0.
 *
 * Nothing else in the payload names this field, and nothing is removed. `payload.version` is NOT
 * rewritten, for the reason format 14 → 15 spells out: it is hashed world state, and stamping the
 * format number onto it would make a migrated world hash differently from an identical fresh one.
 */
const migrateFormat17To18: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-17 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const machines = rows(p, 'machines').map((machine) => ({ ...machine, cargoFreshTicks: 0 }));
  return { ...p, machines };
};

/**
 * Format 18 → 19: **every machine gains a name for what is in its output basket** (item 111).
 *
 * THE ONE FACT NO FORMAT 18 SAVE CAN EXPRESS is which product a full buffer is holding — and it
 * could not, because until this item no machine could hold two. `outputCount` was a bare number
 * whose identity came from `spec.outputItem`, which was true right up to the moment a Seasoner
 * learned four recipes and a Washer learned two.
 *
 * **EVERY MACHINE GETS 0, AND 0 MEANS "ASK THE SPEC" RATHER THAN "EMPTY".** `heldOutputItem()`
 * reads an unlabelled full basket as holding exactly what its spec has always said it holds, so
 * a grandfathered world behaves identically: the same item comes off the same machine, net worth
 * invoices it at the same price, and a basket of plain chips still has to be drained before that
 * Seasoner will start a chili batch. The label heals the next time the machine produces, and
 * `takeOneOutput` returns it to 0 when the basket empties.
 *
 * **NO FROZEN TABLE OF ITEM IDS, DELIBERATELY.** The obvious spelling of this migration is a
 * literal map from machine kind to output item, pinned forever the way `FORMAT_17_BENCH_RECIPE`
 * is. It is not needed here and it would be a liability: the fallback in `heldOutputItem` reads
 * today's spec, which is the same answer the old code gave, and forty frozen literals would be
 * forty chances to disagree with it. A migration that has nothing to write is allowed to write
 * nothing.
 *
 * Nothing is removed and no player loses a unit. `payload.version` is NOT rewritten, for the
 * reason format 14 → 15 spells out.
 */
const migrateFormat18To19: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-18 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const machines = rows(p, 'machines').map((machine) => ({ ...machine, outputItem: 0 }));
  return { ...p, machines };
};

/**
 * Format 19 → 20: **the clock reaches every other place a good can sit** (item 112).
 *
 * Format 18 gave a CONTAINER the clock its cargo runs on, and item 110's own verifier found
 * within the hour that the bug had not died, it had moved: a machine holds goods in a hopper, in
 * an output basket, in a claw and on a belt, and not one of those four had anywhere to record how
 * old anything was. So this step adds `inputFreshTicks` (one per hopper line), `outputFreshTicks`,
 * `Grabber.heldFreshTicks`, and `freshTicks` on every item riding a belt.
 *
 * **EVERY ONE OF THEM GETS 0, AND 0 MEANS "NO CLOCK" RATHER THAN "OUT OF TIME"** — format 18's
 * ruling, applied again for exactly the reason it was made the first time. Stamping a real window
 * onto a stocked hopper during a migration would start that clock at the tick the player last
 * saved, which for somebody who has been away a week is an instruction to hand them compost. A
 * migration must destroy nothing a player owns.
 *
 * So a format-19 world is grandfathered EXACTLY as a format-17 cellar was: its held goods do not
 * age, and they hand back a full window the first time anything takes them out. The healing is
 * where this differs from its predecessor, and it is the other half of item 112. `takeStorage` and
 * `takeDockShelf` now START a clockless container's clock on first contact rather than answering
 * every take with a brand-new window — the *"two takes ten thousand ticks apart were both stamped
 * 18,000"* bug — so a grandfathered container grants one window in total, which is what the word
 * was always supposed to mean. `putHopper` and `putStorage` heal the same way through
 * `mergedFreshness`, in the pessimistic direction, the moment anything is added.
 *
 * **THE HOPPER ARRAY IS SIZED HERE AND RESIZED AGAIN BY THE LOADER**, deliberately. `inputCounts`
 * is the length this writes against, because that is the fact the FILE holds; `readInputFreshTicks`
 * then trims or pads to today's spec exactly as `readInputCounts` does, because that is the fact
 * the BUILD holds. A migration that guessed at the spec would be a migration that ages badly.
 *
 * Nothing is removed and no player loses a unit. `payload.version` is NOT rewritten, for the
 * reason format 14 → 15 spells out.
 */
const migrateFormat19To20: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-19 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const machines = rows(p, 'machines').map((machine) => {
    const counts = machine['inputCounts'];
    const lines = Array.isArray(counts) ? counts.length : 0;
    return {
      ...machine,
      inputFreshTicks: new Array<number>(lines).fill(0),
      outputFreshTicks: 0,
    };
  });

  const belts = rows(p, 'belts').map((belt) => {
    const items = belt['items'];
    if (!Array.isArray(items)) return belt;
    return {
      ...belt,
      items: items.map((entry) =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)
          ? { ...(entry as Record<string, unknown>), freshTicks: 0 }
          : entry,
      ),
    };
  });

  const grabbers = rows(p, 'grabbers').map((grabber) => ({ ...grabber, heldFreshTicks: 0 }));

  return { ...p, machines, belts, grabbers };
};

/**
 * Format 20 → 21: **the last two containers that could hold food learn to hold its clock too**
 * (item 115) — a depot's floor and its lorry, and the arms of an Agri-Bot.
 *
 * Item 112 closed five doors and its own verifier found two more. A standing route's `stocked` was
 * a bare count, so an arm feeding a depot with a run size it could not fill was an unbounded
 * refrigerator that needed no player at all; and a bot that harvested and then could not deliver
 * held its armful with the clock never started. Three fields, three zeroes.
 *
 * **ZERO MEANS "NO OPINION", WHICH IS THE SAME GRANDFATHERING FORMAT 18 AND FORMAT 20 CHOSE**, and
 * the reason is theirs verbatim: stamping a window during a migration would hand a returning player
 * an armful of compost for the crime of having saved. So a depot floor loaded before this build
 * starts its clock the first time anything else arrives on it (`mergedFreshness` takes the
 * arrivals' outright when the pile has no remainder), and a bot mid-round starts its at the next
 * pull. Both heal in the pessimistic direction and neither destroys anything on load.
 *
 * **WHAT THAT COSTS IS ONE FLOOR-LOAD OF GRANDFATHERED FREEDOM**, and item 110's verifier measured
 * exactly this hole on containers: a clockless pile handed every take a brand-new window, so an old
 * save was a perpetual-motion machine one armful at a time. A depot cannot do that — `refundContract`
 * empties the floor in one go rather than a unit at a time, so there is one refund, not a stream of
 * them — which is why the same zero that was a real leak on a cellar is a single bounded gift here.
 *
 * Nothing is removed and no player loses a unit. `payload.version` is NOT rewritten, for the reason
 * format 14 → 15 spells out.
 */
const migrateFormat20To21: SaveMigration = (payload) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Cannot migrate a format-20 save whose payload is not an object.');
  }
  const p = payload as Record<string, unknown>;

  const contracts = rows(p, 'contracts').map((contract) => ({
    ...contract,
    stockedFreshTicks: 0,
    inTransitFreshTicks: 0,
  }));

  const bots = rows(p, 'bots').map((bot) => ({ ...bot, carryFreshTicks: 0 }));

  return { ...p, contracts, bots };
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
  6: migrateFormat6To7,
  7: migrateFormat7To8,
  8: migrateFormat8To9,
  9: migrateFormat9To10,
  10: migrateFormat10To11,
  11: migrateFormat11To12,
  12: migrateFormat12To13,
  13: migrateFormat13To14,
  14: migrateFormat14To15,
  15: migrateFormat15To16,
  16: migrateFormat16To17,
  17: migrateFormat17To18,
  18: migrateFormat18To19,
  19: migrateFormat19To20,
  20: migrateFormat20To21,
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
