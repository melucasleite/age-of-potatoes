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

  d.text('inventory');
  d.num(state.inventory.length);
  for (let i = 0; i < state.inventory.length; i++) {
    const slot = state.inventory[i]!;
    d.num(slot.item);
    d.num(slot.count);
  }

  d.text('field');
  d.num(state.field.length);
  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    d.num(tile.crop);
    d.num(tile.growth);
    d.num(tile.growthTarget);
    d.num(tile.moisture);
    d.num(tile.fertility);
    d.num(tile.readyAge);
    d.num(tile.compost);
    d.num(tile.zone);
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
    d.num(machine.inputCount);
    d.num(machine.outputCount);
    d.num(machine.tankMl);
    d.num(machine.condition);
    d.num(machine.opCount);
    d.bool(machine.jammed);
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
  d.num(stats.netWorthCents);
  d.num(stats.peakNetWorthCents);
  d.num(stats.nextNetWorthSampleTick);
  d.num(stats.ticksSinceManualTouch);
  d.num(stats.longestHandsFreeTicks);
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

  for (let i = 0; i < state.inventory.length; i++) {
    check(`inventory[${i}].count`, state.inventory[i]!.count);
  }

  for (let i = 0; i < state.field.length; i++) {
    const tile = state.field[i]!;
    check(`field[${i}].growth`, tile.growth);
    check(`field[${i}].growthTarget`, tile.growthTarget);
    check(`field[${i}].moisture`, tile.moisture);
    check(`field[${i}].fertility`, tile.fertility);
  }

  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    check(`machines[${i}].progress`, machine.progress);
    check(`machines[${i}].tankMl`, machine.tankMl);
    check(`machines[${i}].condition`, machine.condition);
    check(`machines[${i}].opCount`, machine.opCount);
    check(`machines[${i}].cooldown`, machine.cooldown);
    check(`machines[${i}].investedCents`, machine.investedCents);
    check(`machines[${i}].flowMlPerMinute`, machine.flowMlPerMinute);
    check(`machines[${i}].scanCursor`, machine.scanCursor);
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
  check('stats.waterDrawnMl', stats.waterDrawnMl);
  check('stats.netWorthCents', stats.netWorthCents);
  check('stats.peakNetWorthCents', stats.peakNetWorthCents);
  for (let i = 0; i < stats.netWorthSamples.length; i++) {
    check(`stats.netWorthSamples[${i}]`, stats.netWorthSamples[i]!);
  }

  return bad;
}
