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

import type { SaveEnvelope } from './envelope';
import { SaveCorruptError, SaveFormatTooNewError, SaveMigrationMissingError } from './errors';

/**
 * The envelope/payload shape this build writes and reads.
 *
 * Bump it in the same commit that adds the migration step which reaches it. A bump without
 * a step is a hole in the chain, and `migrate` throws rather than guessing.
 */
export const CURRENT_FORMAT_VERSION = 14;

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
