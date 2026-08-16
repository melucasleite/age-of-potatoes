// FNV-1a over a canonical serialization of the world.
//
// The digest is the canary. Fixtures of `{seed, commands, ticks, expectedHash}` run in CI,
// so accidental non-determinism fails the build the day it appears rather than surfacing
// as a mystery in 2029.
//
// Canonicalisation rules, all of which exist because JSON.stringify honours none of them:
//   - Fields are emitted in the fixed order written below, never by key enumeration.
//   - Collections are emitted in id order: field tiles by index, machines by id, inventory
//     by item id, RNG streams by sorted key.
//   - No floats. Every hashed number is an integer, which is a dividend of the integer
//     base units. If a float ever reaches the digest, the bug is in `units.ts`, not here.
//
// THE TRACE IS NOT HASHED. It is the input log, not the world: two worlds that reached
// identical state by different routes must agree, and hashing an append-only array on
// every call would make the digest O(session) instead of O(world).

import type { WorldState } from './state';

const FNV_OFFSET_BASIS = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;

export function fnv1aInit(): number {
  return FNV_OFFSET_BASIS;
}

/** Fold one byte into the running hash. */
export function fnv1aByte(hash: number, byte: number): number {
  let h = (hash ^ (byte & 0xff)) >>> 0;
  h = Math.imul(h, FNV_PRIME) >>> 0;
  return h;
}

/** Fold a string in, one UTF-16 code unit at a time as two bytes — stable everywhere. */
export function fnv1aString(hash: number, text: string): number {
  let h = hash >>> 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h = fnv1aByte(h, code & 0xff);
    h = fnv1aByte(h, (code >>> 8) & 0xff);
  }
  return h;
}

export function fnv1aToHex(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** The canonical writer. Every value the digest sees goes through one of these. */
class Digest {
  h = fnv1aInit();

  /** A field separator, so `12` then `3` cannot collide with `1` then `23`. */
  private sep(): void {
    this.h = fnv1aByte(this.h, 0x1f);
  }

  num(value: number): void {
    // String() of an integer is exact and identical across engines. A float would show up
    // here as "1.5" and change the digest, which is exactly the visibility we want.
    this.h = fnv1aString(this.h, String(value));
    this.sep();
  }

  bool(value: boolean): void {
    this.h = fnv1aByte(this.h, value ? 1 : 0);
    this.sep();
  }

  text(value: string): void {
    this.h = fnv1aString(this.h, value);
    this.sep();
  }
}

/**
 * A stable 8-character lowercase hex digest of the world.
 *
 * Same seed and same command sequence produce the same string on every machine, every
 * run, forever. Use `hashStateUint32` if a number is more convenient; it is the same
 * value, before formatting.
 */
export function hashState(state: WorldState): string {
  return fnv1aToHex(hashStateUint32(state));
}

/** The digest as a 32-bit unsigned integer. */
export function hashStateUint32(state: WorldState): number {
  const d = new Digest();

  d.text('snack-mogul/world');
  d.num(state.version);
  d.num(state.worldSeed);
  d.num(state.tick);
  d.num(state.moneyCents);

  d.text('player');
  d.num(state.player.xSub);
  d.num(state.player.ySub);
  d.num(state.player.facing);
  d.num(state.player.moveDir);
  d.num(state.player.moveAccum);
  // The cart in tow. A world where the farmer is dragging a barrow and one where they left it by
  // the shed are different worlds, and the difference is visible in how fast the next step is.
  d.num(state.player.towedCartId);
  // The can's remaining pours. A farmer three pours from a walk to the shore and one fresh from
  // it are in different worlds, and the difference is when the next refill happens.
  d.num(state.player.canCharges);

  // A pending errand is world state like any other: two players who have both clicked a far
  // tile but are half a field apart in the walk are in genuinely different worlds, and a
  // digest that ignored the errand would call them identical. The presence flag comes first
  // so "no errand" and "an errand to tile 0,0" can never encode to the same bytes.
  const intent = state.player.intent;
  d.text('player.intent');
  d.bool(intent !== null);
  if (intent !== null) {
    d.num(intent.action);
    d.num(intent.tileX);
    d.num(intent.tileY);
    d.num(intent.item);
    d.num(intent.count);
    d.num(intent.issuedTick);
  }

  d.text('inventory');
  d.num(state.inventory.length);
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    d.num(slot.item);
    d.num(slot.count);
    // Boxed machines, in the slot's canonical order, length first — the same length-first rule
    // every other collection here follows, so a slot holding one box and a slot holding none
    // cannot encode to the same bytes. The list is EMPTY on every ordinary good and still
    // counted, because "no boxes" is a fact about the world and skipping it would let a bare
    // count and a count-with-boxes collide.
    d.num(slot.boxes.length);
    for (let j = 0; j < slot.boxes.length; j++) {
      const box = slot.boxes[j]!;
      d.num(box.speedLevel);
      d.num(box.efficiencyLevel);
      d.num(box.capacityLevel);
      d.num(box.condition);
      d.num(box.investedCents);
    }
    // FRESHNESS, LENGTH FIRST, IN THE SLOT'S SORTED ORDER. Two bags holding twelve potatoes are
    // not the same world if one of them is about to lose four of them, so the deadlines are in
    // the digest — and the list is counted even when empty, because "no clock on this" is a fact
    // about the world and skipping it would let a shelf-stable stack and a perishable one collide.
    d.num(slot.stacks.length);
    for (let j = 0; j < slot.stacks.length; j++) {
      const stack = slot.stacks[j]!;
      d.num(stack.spoilAtTick);
      d.num(stack.count);
    }
  }

  d.text('field');
  d.num(state.field.length);
  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    // The coordinate IS state since format 13: two worlds with the same tile data on
    // different ground are different worlds.
    d.num(tile.tileX);
    d.num(tile.tileY);
    d.num(tile.crop);
    d.num(tile.growth);
    d.num(tile.growthTarget);
    d.num(tile.moisture);
    d.num(tile.moistureAccum);
    d.num(tile.soil);
    d.num(tile.fertility);
    d.num(tile.fertilityWear);
    d.num(tile.readyAge);
    d.num(tile.compost);
    d.num(tile.zone);
  }

  // The roll-once ledger (format 13). In the digest because it is a promise about the future:
  // two worlds that differ only in what an un-tilled position WOULD roll are worlds whose
  // next till diverges, which is exactly what a hash exists to catch early.
  d.text('soil-memory');
  d.num(state.soilMemory.length);
  for (let i = 0; i < state.soilMemory.length; i++) {
    const entry = state.soilMemory[i]!;
    d.num(entry.tile);
    d.num(entry.soil);
    d.num(entry.fertility);
    d.num(entry.fertilityWear);
  }

  d.text('machines');
  d.num(state.machines.length);
  d.num(state.nextMachineId);
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    d.num(machine.id);
    d.num(machine.kind);
    d.num(machine.tileX);
    d.num(machine.tileY);
    d.num(machine.progress);
    // Recipe buffers, in recipe order, length first. Length first because a machine holding
    // [1] and one holding [1, 0] are different worlds and a bare concatenation would say
    // otherwise — the same reason every other collection here is preceded by its count.
    d.num(machine.inputCounts.length);
    for (let j = 0; j < machine.inputCounts.length; j++) d.num(machine.inputCounts[j]!);
    d.num(machine.outputCount);
    d.num(machine.tankMl);
    d.num(machine.condition);
    d.num(machine.opCount);
    d.bool(machine.jammed);
    d.num(machine.blockedTicks);
    d.num(machine.overcookedCount);
    d.num(machine.cooldown);
    d.num(machine.investedCents);
    d.num(machine.speedLevel);
    d.num(machine.efficiencyLevel);
    d.num(machine.capacityLevel);
    d.num(machine.network);
    d.num(machine.flowMlPerMinute);
    d.bool(machine.throttled);
    d.num(machine.scanCursor);
    d.num(machine.wateredCount);
    d.num(machine.skippedCount);
    // The cart's three. Zero on every machine that is not one, and counted anyway — a field
    // skipped when it is zero is a field whose absence and whose zero encode the same bytes.
    d.num(machine.cargoItem);
    d.num(machine.cargoCount);
    d.num(machine.runTicksRemaining);
    // The harvester dock's seed shelf (item 088). Zero on everything else, and counted anyway,
    // for the reason directly above.
    d.num(machine.seedShelfItem);
    d.num(machine.seedShelfCount);
    // The untouched-work clock, and the junction's two round-robin cursors. THE CURSORS ARE IN
    // HERE BECAUSE THAT IS THE POINT OF THEM: a splitter's alternation is world state, so two
    // worlds that differ only in which output is next genuinely differ, and item 024's criterion
    // — same seed and command list, same hash across runs — is a statement about these bytes.
    d.num(machine.untouchedTicks);
    d.num(machine.junctionInCursor);
    d.num(machine.junctionOutCursor);
    d.num(machine.boundZone);
    d.num(machine.ports.length);
    for (let j = 0; j < machine.ports.length; j++) {
      const port = machine.ports[j]!;
      d.num(port.network);
      d.num(port.ml);
      d.num(port.flowMlPerMinute);
      d.bool(port.throttled);
    }
  }

  // Reservoirs, pipes, and networks. All three are already sorted — reservoirs and pipes by
  // id, networks by their geometric id — so the digest reads them as they stand. A network's
  // id being its lowest world tile index is what makes two worlds that built the same
  // plumbing in a different order hash the same.
  d.text('reservoirs');
  d.num(state.reservoirs.length);
  d.num(state.nextReservoirId);
  for (let i = 0; i < state.reservoirs.length; i++) {
    const reservoir = state.reservoirs[i]!;
    d.num(reservoir.id);
    d.num(reservoir.tileX);
    d.num(reservoir.tileY);
    d.num(reservoir.tilesWide);
    d.num(reservoir.tilesHigh);
    d.num(reservoir.levelMl);
    d.num(reservoir.capacityMl);
    d.num(reservoir.rechargeAccum);
  }

  d.text('pipes');
  d.num(state.pipes.length);
  d.num(state.nextPipeId);
  for (let i = 0; i < state.pipes.length; i++) {
    const pipe = state.pipes[i]!;
    d.num(pipe.id);
    d.num(pipe.tileX);
    d.num(pipe.tileY);
    d.num(pipe.liquid);
    d.num(pipe.network);
  }

  d.text('networks');
  d.num(state.networks.length);
  for (let i = 0; i < state.networks.length; i++) {
    const network = state.networks[i]!;
    d.num(network.id);
    d.num(network.liquid);
    d.num(network.supplyAccum);
    d.num(network.rrOffset);
    d.num(network.supplyMl);
    d.num(network.demandMl);
    d.num(network.deliveredMl);
  }

  // Standing contracts, already sorted ascending by id.
  //
  // **`destination` IS DELIBERATELY NOT IN HERE, AND IT IS THE ONLY STORED STRING IN THE WORLD
  // THAT IS NOT.** A zone's name is hashed — the comment on `Zone.name` says "cosmetic, and
  // hashed anyway" — so this is a real exception and it needs a real reason. A zone name is
  // something the player typed and can change with a command of its own; a destination is picked
  // by the client off a table the client owns, has no mechanical effect of any kind, and cannot
  // be edited once signed. Two lots shipping the same chips on the same schedule to two
  // differently-named towns are the same world, and the digest says so.
  //
  // **THE TRAP THIS SETS, stated so the next person does not fall in it:** the day a destination
  // gains a distance, a premium, or anything else a rule reads, it stops being flavour — and it
  // must move into `data.ts` as an id and into this block on that same day. A cosmetic field
  // that quietly grew a mechanic is a desync nothing would catch, because the fixtures would all
  // still pass.
  d.text('contracts');
  d.num(state.contracts.length);
  d.num(state.nextContractId);
  for (let i = 0; i < state.contracts.length; i++) {
    const contract = state.contracts[i]!;
    d.num(contract.id);
    d.num(contract.depotId);
    d.num(contract.item);
    d.num(contract.quantityPerRun);
    d.num(contract.stocked);
    d.num(contract.inTransit);
    d.num(contract.phase);
    d.num(contract.ticksRemaining);
    d.num(contract.runsCompleted);
    d.num(contract.grossCents);
  }

  // Agri-Bots, already sorted ascending by id. **A BOT'S POSITION IS IN THE DIGEST**, which is
  // item 038's criterion — "bot movement is identical across runs from the same seed and command
  // list" — stated as bytes: two worlds whose robots are half a field apart are genuinely
  // different worlds, and the only way a replay can prove it walked the same route is for the
  // route to be hashed. The route cursor is in here for the reason a junction's cursors are.
  d.text('bots');
  d.num(state.bots.length);
  d.num(state.nextBotId);
  for (let i = 0; i < state.bots.length; i++) {
    const bot = state.bots[i]!;
    d.num(bot.id);
    d.num(bot.kind);
    d.num(bot.dockId);
    d.num(bot.xSub);
    d.num(bot.ySub);
    d.num(bot.facing);
    d.num(bot.moveAccum);
    d.num(bot.phase);
    d.num(bot.targetTile);
    d.num(bot.routeCursor);
    d.num(bot.workTicks);
    d.num(bot.carryItem);
    d.num(bot.carryCount);
    // The seed pocket (item 088). A bot that pocketed a seed genuinely differs from one that
    // did not, and a replay that dropped it would diverge only when the seed reached a shelf.
    d.num(bot.seedItem);
    d.num(bot.seedCount);
    d.num(bot.condition);
    d.num(bot.opCount);
  }

  // Already sorted in `WorldState`. A ceremony that has played is a fact about the world, and
  // a world restored from a file must not replay a first time.
  d.text('ceremonies');
  d.num(state.ceremonies.length);
  for (let i = 0; i < state.ceremonies.length; i++) {
    d.text(state.ceremonies[i]!);
  }

  // Belts carry their items inline. The list is already sorted by distance and that order
  // is a world invariant, not a presentation choice, so the digest reads it as it stands.
  d.text('belts');
  d.num(state.belts.length);
  d.num(state.nextBeltId);
  for (let i = 0; i < state.belts.length; i++) {
    const belt = state.belts[i]!;
    d.num(belt.id);
    d.num(belt.tileX);
    d.num(belt.tileY);
    d.num(belt.dir);
    d.num(belt.lengthTiles);
    d.num(belt.tier);
    d.num(belt.moveAccum);
    d.num(belt.items.length);
    for (let j = 0; j < belt.items.length; j++) {
      const entry = belt.items[j]!;
      d.num(entry.dist);
      d.num(entry.item);
    }
  }

  d.text('grabbers');
  d.num(state.grabbers.length);
  d.num(state.nextGrabberId);
  for (let i = 0; i < state.grabbers.length; i++) {
    const grabber = state.grabbers[i]!;
    d.num(grabber.id);
    d.num(grabber.tileX);
    d.num(grabber.tileY);
    d.num(grabber.dir);
    d.num(grabber.tier);
    d.num(grabber.filter);
    d.num(grabber.held);
    d.num(grabber.cooldown);
    d.num(grabber.opCount);
  }

  d.text('zones');
  d.num(state.zones.length);
  d.num(state.nextZoneId);
  for (let i = 0; i < state.zones.length; i++) {
    const zone = state.zones[i]!;
    d.num(zone.id);
    d.text(zone.name);
    d.num(zone.crop);
    d.num(zone.priority);
    d.bool(zone.autoReplant);
    d.num(zone.replantCooldown);
  }

  // The deeds. Sorted in `WorldState` for the same reason `unlocked` is: two players who
  // bought the same two parcels in the opposite order own the same lot and must agree here.
  // The land itself is not in the digest — a parcel's tiles are arithmetic off its index, and
  // hashing 4,096 derived booleans would digest the same fact 256 times.
  d.text('ownedParcels');
  d.num(state.ownedParcels.length);
  for (let i = 0; i < state.ownedParcels.length; i++) {
    d.num(state.ownedParcels[i]!);
  }

  // Already sorted in `WorldState`, for exactly this reason: two worlds that bought the
  // same nodes in a different order are the same world and must agree here.
  d.text('unlocked');
  d.num(state.unlocked.length);
  for (let i = 0; i < state.unlocked.length; i++) {
    d.text(state.unlocked[i]!);
  }

  // Sorted keys, not enumeration order — integer-like keys sort ascending while string
  // keys keep insertion order, and a stream map that grew in a different order would
  // otherwise hash differently for an identical world.
  d.text('streams');
  const streamKeys = Object.keys(state.streams).sort();
  d.num(streamKeys.length);
  for (let i = 0; i < streamKeys.length; i++) {
    const key = streamKeys[i]!;
    const rng = state.streams[key]!;
    d.text(key);
    d.num(rng.s0);
    d.num(rng.s1);
    d.num(rng.s2);
    d.num(rng.s3);
  }

  // ONE-WAY DOOR (plan §12): the leaderboard accumulators are hashed. A world that
  // desynced must not be able to post a plausible score.
  const stats = state.stats;
  d.text('stats');
  d.num(stats.ticksElapsed);
  d.num(stats.lifetimeEarnedCents);
  d.num(stats.lifetimeSpentCents);
  d.num(stats.waterDrawnMl);
  d.num(stats.itemsSold);
  d.num(stats.itemsProducedByMachine);
  d.num(stats.itemsHarvestedByHand);
  d.num(stats.automatedGrossCents);
  d.num(stats.inputsWastedByMachine);
  d.num(stats.repairKitsUsed);
  d.num(stats.repairKitSpendCents);
  d.num(stats.netWorthCents);
  d.num(stats.peakNetWorthCents);
  d.num(stats.nextNetWorthSampleTick);
  d.num(stats.ticksSinceManualTouch);
  d.num(stats.longestHandsFreeTicks);
  d.num(stats.longestUntouchedMachineTicks);
  // Item 075: a world that cheated carries the fact in its digest — see `WorldStats.cheatsUsed`.
  d.num(stats.cheatsUsed);
  d.num(stats.netWorthSamples.length);
  for (let i = 0; i < stats.netWorthSamples.length; i++) {
    d.num(stats.netWorthSamples[i]!);
  }

  d.text('touches');
  d.num(stats.touches.handWater);
  d.num(stats.touches.handPlant);
  d.num(stats.touches.handHarvest);
  d.num(stats.touches.handCarry);
  d.num(stats.touches.handRepair);
  d.num(stats.touches.jamWhack);
  d.num(stats.touches.hopperRefill);

  // The per-item sales ledger. Already sorted ascending by item id in `WorldStats`, so two
  // worlds that sold the same goods in a different order digest identically — they are the
  // same ledger. Length-first, like every collection here.
  d.text('salesByItem');
  d.num(stats.salesByItem.length);
  for (let i = 0; i < stats.salesByItem.length; i++) {
    const row = stats.salesByItem[i]!;
    d.num(row.item);
    d.num(row.units);
    d.num(row.cents);
    d.num(row.unitsAtDawn);
    d.num(row.centsAtDawn);
  }

  // The hour ledger: every closed bucket, the open hour's starting line, and the dawn counter.
  // These are what make the Shift Report's strip and the Dawn Report's "today" column facts
  // about the world rather than a display-side reconstruction (item 062).
  d.text('hours');
  d.num(stats.hours.length);
  for (let i = 0; i < stats.hours.length; i++) {
    const bucket = stats.hours[i]!;
    d.num(bucket.hour);
    d.num(bucket.ticks);
    d.num(bucket.grossCents);
    d.num(bucket.spendCents);
    d.num(bucket.waterMl);
    d.num(bucket.itemsSold);
    d.num(bucket.inputsWasted);
    d.num(bucket.itemsProduced);
  }
  d.text('hourMark');
  d.num(stats.hourMark.hour);
  d.num(stats.hourMark.tick);
  d.num(stats.hourMark.earnedCents);
  d.num(stats.hourMark.spentCents);
  d.num(stats.hourMark.waterMl);
  d.num(stats.hourMark.itemsSold);
  d.num(stats.hourMark.inputsWasted);
  d.num(stats.hourMark.itemsProduced);
  d.num(stats.dawnsSeen);

  return d.h >>> 0;
}

/**
 * Every hashed number that is not an integer, as `path -> value`. Empty means the world is
 * clean.
 *
 * Kept separate from `hashState` on purpose: the digest must stay total, so a float shows
 * up there as a changed hash rather than a thrown error. This is the tool that tells you
 * *which* field went fractional, and a non-empty result is a bug in units, not in the
 * hash.
 */
export function findNonIntegerFields(state: WorldState): string[] {
  const bad: string[] = [];

  const check = (path: string, value: number): void => {
    if (!Number.isInteger(value)) bad.push(`${path} = ${String(value)}`);
  };

  check('version', state.version);
  check('worldSeed', state.worldSeed);
  check('tick', state.tick);
  check('moneyCents', state.moneyCents);
  check('player.xSub', state.player.xSub);
  check('player.ySub', state.player.ySub);
  check('player.moveAccum', state.player.moveAccum);
  check('player.towedCartId', state.player.towedCartId);

  // Hashed, so checked. `action` is left out on purpose: it is an id rather than a quantity,
  // it is validated against `ERRAND_ACTIONS` on load, and a fractional one could only come
  // from a command payload that `applyWalkAndAct` already truncation-checks on the way in.
  const intent = state.player.intent;
  if (intent !== null) {
    check('player.intent.tileX', intent.tileX);
    check('player.intent.tileY', intent.tileY);
    check('player.intent.item', intent.item);
    check('player.intent.count', intent.count);
    check('player.intent.issuedTick', intent.issuedTick);
  }

  for (let i = 0; i < state.ownedParcels.length; i++) {
    check(`ownedParcels[${i}]`, state.ownedParcels[i]!);
  }

  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    check(`inventory[${i}].count`, slot.count);
    for (let j = 0; j < slot.stacks.length; j++) {
      // A spoil tick is arithmetic on the clock and a bucket size; a count is a count. Both are
      // integers by construction and checked rather than reasoned about.
      check(`inventory[${i}].stacks[${j}].spoilAtTick`, slot.stacks[j]!.spoilAtTick);
      check(`inventory[${i}].stacks[${j}].count`, slot.stacks[j]!.count);
    }
    for (let j = 0; j < slot.boxes.length; j++) {
      // A box carries cents and a condition, which are exactly the two kinds of number that go
      // fractional when somebody divides without flooring. The dials are small integers and
      // checked with them rather than reasoned about.
      const box = slot.boxes[j]!;
      check(`inventory[${i}].boxes[${j}].speedLevel`, box.speedLevel);
      check(`inventory[${i}].boxes[${j}].efficiencyLevel`, box.efficiencyLevel);
      check(`inventory[${i}].boxes[${j}].capacityLevel`, box.capacityLevel);
      check(`inventory[${i}].boxes[${j}].condition`, box.condition);
      check(`inventory[${i}].boxes[${j}].investedCents`, box.investedCents);
    }
  }

  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    check(`field[${i}].tileX`, tile.tileX);
    check(`field[${i}].tileY`, tile.tileY);
    check(`field[${i}].growth`, tile.growth);
    check(`field[${i}].growthTarget`, tile.growthTarget);
    check(`field[${i}].moisture`, tile.moisture);
    check(`field[${i}].moistureAccum`, tile.moistureAccum);
    check(`field[${i}].fertility`, tile.fertility);
    check(`field[${i}].fertilityWear`, tile.fertilityWear);
  }

  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    check(`machines[${i}].progress`, machine.progress);
    check(`machines[${i}].tankMl`, machine.tankMl);
    for (let j = 0; j < machine.inputCounts.length; j++) {
      check(`machines[${i}].inputCounts[${j}]`, machine.inputCounts[j]!);
    }
    for (let j = 0; j < machine.ports.length; j++) {
      check(`machines[${i}].ports[${j}].ml`, machine.ports[j]!.ml);
    }
    check(`machines[${i}].condition`, machine.condition);
    check(`machines[${i}].opCount`, machine.opCount);
    check(`machines[${i}].cooldown`, machine.cooldown);
    check(`machines[${i}].blockedTicks`, machine.blockedTicks);
    check(`machines[${i}].overcookedCount`, machine.overcookedCount);
    check(`machines[${i}].investedCents`, machine.investedCents);
    check(`machines[${i}].flowMlPerMinute`, machine.flowMlPerMinute);
    check(`machines[${i}].scanCursor`, machine.scanCursor);
    check(`machines[${i}].cargoCount`, machine.cargoCount);
    check(`machines[${i}].seedShelfCount`, machine.seedShelfCount);
    check(`machines[${i}].runTicksRemaining`, machine.runTicksRemaining);
    check(`machines[${i}].untouchedTicks`, machine.untouchedTicks);
    check(`machines[${i}].junctionInCursor`, machine.junctionInCursor);
    check(`machines[${i}].junctionOutCursor`, machine.junctionOutCursor);
    check(`machines[${i}].boundZone`, machine.boundZone);
  }

  // A bot's position is the one place in this world where a float would be invisible until a
  // replay diverged, so every number on it is checked. `moveAccum` especially: it is hundredths
  // of a subtile and it is what a mis-typed speed constant would go fractional in.
  for (let i = 0; i < state.bots.length; i++) {
    const bot = state.bots[i]!;
    check(`bots[${i}].xSub`, bot.xSub);
    check(`bots[${i}].ySub`, bot.ySub);
    check(`bots[${i}].moveAccum`, bot.moveAccum);
    check(`bots[${i}].targetTile`, bot.targetTile);
    check(`bots[${i}].routeCursor`, bot.routeCursor);
    check(`bots[${i}].workTicks`, bot.workTicks);
    check(`bots[${i}].carryCount`, bot.carryCount);
    check(`bots[${i}].seedCount`, bot.seedCount);
    check(`bots[${i}].condition`, bot.condition);
    check(`bots[${i}].opCount`, bot.opCount);
  }

  // Counts and a countdown, all of which are integers by construction — and cents, which are the
  // kind of number that goes fractional the moment somebody divides one without flooring.
  for (let i = 0; i < state.contracts.length; i++) {
    const contract = state.contracts[i]!;
    check(`contracts[${i}].quantityPerRun`, contract.quantityPerRun);
    check(`contracts[${i}].stocked`, contract.stocked);
    check(`contracts[${i}].inTransit`, contract.inTransit);
    check(`contracts[${i}].ticksRemaining`, contract.ticksRemaining);
    check(`contracts[${i}].grossCents`, contract.grossCents);
  }

  // Millilitres are integers. If one of these ever goes fractional, the bug is a rate that
  // was divided instead of accumulated — see `TICKS_PER_MINUTE` in units.ts.
  for (let i = 0; i < state.reservoirs.length; i++) {
    const reservoir = state.reservoirs[i]!;
    check(`reservoirs[${i}].levelMl`, reservoir.levelMl);
    check(`reservoirs[${i}].capacityMl`, reservoir.capacityMl);
    check(`reservoirs[${i}].rechargeAccum`, reservoir.rechargeAccum);
  }

  for (let i = 0; i < state.networks.length; i++) {
    const network = state.networks[i]!;
    check(`networks[${i}].supplyAccum`, network.supplyAccum);
    check(`networks[${i}].rrOffset`, network.rrOffset);
    check(`networks[${i}].deliveredMl`, network.deliveredMl);
  }

  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    check(`field[${i}].readyAge`, tile.readyAge);
    check(`field[${i}].compost`, tile.compost);
  }

  for (let i = 0; i < state.belts.length; i++) {
    const belt = state.belts[i]!;
    check(`belts[${i}].moveAccum`, belt.moveAccum);
    for (let j = 0; j < belt.items.length; j++) {
      check(`belts[${i}].items[${j}].dist`, belt.items[j]!.dist);
    }
  }

  for (let i = 0; i < state.grabbers.length; i++) {
    check(`grabbers[${i}].cooldown`, state.grabbers[i]!.cooldown);
  }

  const streamKeys = Object.keys(state.streams).sort();
  for (let i = 0; i < streamKeys.length; i++) {
    const key = streamKeys[i]!;
    const rng = state.streams[key]!;
    check(`streams.${key}.s0`, rng.s0);
    check(`streams.${key}.s1`, rng.s1);
    check(`streams.${key}.s2`, rng.s2);
    check(`streams.${key}.s3`, rng.s3);
  }

  const stats = state.stats;
  check('stats.ticksElapsed', stats.ticksElapsed);
  check('stats.lifetimeEarnedCents', stats.lifetimeEarnedCents);
  check('stats.lifetimeSpentCents', stats.lifetimeSpentCents);
  check('stats.automatedGrossCents', stats.automatedGrossCents);
  check('stats.waterDrawnMl', stats.waterDrawnMl);
  check('stats.repairKitSpendCents', stats.repairKitSpendCents);
  check('stats.cheatsUsed', stats.cheatsUsed);
  check('stats.netWorthCents', stats.netWorthCents);
  check('stats.peakNetWorthCents', stats.peakNetWorthCents);
  for (let i = 0; i < stats.netWorthSamples.length; i++) {
    check(`stats.netWorthSamples[${i}]`, stats.netWorthSamples[i]!);
  }
  for (let i = 0; i < stats.salesByItem.length; i++) {
    check(`stats.salesByItem[${i}].units`, stats.salesByItem[i]!.units);
    check(`stats.salesByItem[${i}].cents`, stats.salesByItem[i]!.cents);
  }
  for (let i = 0; i < stats.hours.length; i++) {
    check(`stats.hours[${i}].grossCents`, stats.hours[i]!.grossCents);
    check(`stats.hours[${i}].spendCents`, stats.hours[i]!.spendCents);
  }
  check('stats.hourMark.earnedCents', stats.hourMark.earnedCents);
  check('stats.hourMark.spentCents', stats.hourMark.spentCents);

  return bad;
}
