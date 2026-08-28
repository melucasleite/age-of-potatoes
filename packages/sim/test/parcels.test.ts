// Land: the parcel grid, the deed ladder, and the ownership gate every build verb shares.
//
// The fit arithmetic at the bottom is the answer to item 053's acceptance criterion — "the
// chip line, the soda line, the field, and the pond fit on an expanded lot with belt/pipe room
// to spare". It is arithmetic rather than a screenshot on purpose: a screenshot proves one
// layout, and the sum proves every layout.

import { describe, expect, it } from 'vitest';

import {
  type Command,
  type WorldState,
  BeltTier,
  CropId,
  DEED_PRICE_CENTS_BY_PURCHASE,
  FIELD_TILES_HIGH,
  FIELD_TILES_WIDE,
  MACHINE_SPECS,
  MachineKind,
  PARCELS_HIGH,
  PARCELS_WIDE,
  PARCEL_COUNT,
  PARCEL_TILES,
  POND_TILES_HIGH,
  POND_TILES_WIDE,
  STARTING_PARCEL,
  TechId,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  computeNetWorthCents,
  createWorld,
  deedPriceCents,
  hashState,
  isOwnedTile,
  isParcelBuyable,
  isParcelOwned,
  landValueCents,
  machineSpec,
  nextDeedPriceCents,
  parcelIndexAt,
  parcelOriginX,
  parcelOriginY,
  parcelsAdjacent,
  step,
  view,
} from '../src/index';

/** A world with money but no shortcuts: everything below still goes through a command. */
function richWorld(cents = 100_000_000): WorldState {
  const state = createWorld(2026);
  state.moneyCents = cents;
  return state;
}

function send(state: WorldState, ...commands: Command[]): void {
  step(state, { tick: state.tick, commands });
}

describe('the parcel grid', () => {
  it('is the world, exactly — no tile is outside a parcel and no parcel outside the world', () => {
    expect(WORLD_TILES_WIDE).toBe(PARCEL_TILES * PARCELS_WIDE);
    expect(WORLD_TILES_HIGH).toBe(PARCEL_TILES * PARCELS_HIGH);
    expect(PARCEL_COUNT).toBe(PARCELS_WIDE * PARCELS_HIGH);

    for (let parcel = 0; parcel < PARCEL_COUNT; parcel++) {
      const x = parcelOriginX(parcel);
      const y = parcelOriginY(parcel);
      expect(parcelIndexAt(x, y)).toBe(parcel);
      expect(parcelIndexAt(x + PARCEL_TILES - 1, y + PARCEL_TILES - 1)).toBe(parcel);
    }

    expect(parcelIndexAt(-1, 0)).toBe(-1);
    expect(parcelIndexAt(0, WORLD_TILES_HIGH)).toBe(-1);
  });

  it('puts the whole starting lot — field, pond and stand — inside the free parcel', () => {
    // THE COMPATIBILITY CLAIM, AS AN ASSERTION. Every pre-deed world was a 16×16 map at the
    // origin, so if anything a v0.1 save can contain fell outside parcel 0, that save would
    // load onto land its owner does not hold.
    const state = createWorld(1);
    expect(state.ownedParcels).toEqual([STARTING_PARCEL]);

    for (let y = 0; y < PARCEL_TILES; y++) {
      for (let x = 0; x < PARCEL_TILES; x++) {
        expect(isOwnedTile(state, x, y)).toBe(true);
      }
    }
    for (const machine of state.machines) {
      expect(isOwnedTile(state, machine.tileX, machine.tileY)).toBe(true);
    }
    for (const pond of state.reservoirs) {
      expect(isOwnedTile(state, pond.tileX, pond.tileY)).toBe(true);
      expect(
        isOwnedTile(state, pond.tileX + pond.tilesWide - 1, pond.tileY + pond.tilesHigh - 1),
      ).toBe(true);
    }
  });

  it('counts corners as neighbours of nothing', () => {
    expect(parcelsAdjacent(0, 1)).toBe(true);
    expect(parcelsAdjacent(0, PARCELS_WIDE)).toBe(true);
    // Diagonal. A deed bought across a corner would leave two lots touching at a point.
    expect(parcelsAdjacent(0, PARCELS_WIDE + 1)).toBe(false);
    expect(parcelsAdjacent(0, 0)).toBe(false);
    // And the row wrap that a naive `abs(a - b) === 1` would call adjacent.
    expect(parcelsAdjacent(PARCELS_WIDE - 1, PARCELS_WIDE)).toBe(false);
  });
});

describe('the deed ladder', () => {
  it('has one rung per buyable parcel and escalates', () => {
    expect(DEED_PRICE_CENTS_BY_PURCHASE).toHaveLength(PARCEL_COUNT - 1);
    for (let i = 1; i < DEED_PRICE_CENTS_BY_PURCHASE.length; i++) {
      expect(DEED_PRICE_CENTS_BY_PURCHASE[i]!).toBeGreaterThan(
        DEED_PRICE_CENTS_BY_PURCHASE[i - 1]!,
      );
    }
    // Past the end is a sentinel, never a free parcel and never an extrapolation.
    expect(deedPriceCents(PARCEL_COUNT - 1)).toBe(-1);
    expect(deedPriceCents(-1)).toBe(-1);
  });

  it('prices by how many you have bought, not by which parcel you are buying', () => {
    const east = richWorld();
    const south = richWorld();
    send(east, { type: 'BuyDeed', parcel: 1 });
    send(south, { type: 'BuyDeed', parcel: PARCELS_WIDE });

    expect(east.moneyCents).toBe(south.moneyCents);
    expect(nextDeedPriceCents(east)).toBe(nextDeedPriceCents(south));
  });

  it('hashes two worlds that bought the same land in opposite orders identically', () => {
    const clockwise = richWorld();
    send(clockwise, { type: 'BuyDeed', parcel: 1 });
    send(clockwise, { type: 'BuyDeed', parcel: PARCELS_WIDE });

    const widdershins = richWorld();
    send(widdershins, { type: 'BuyDeed', parcel: PARCELS_WIDE });
    send(widdershins, { type: 'BuyDeed', parcel: 1 });

    expect(clockwise.ownedParcels).toEqual(widdershins.ownedParcels);
    expect(hashState(clockwise)).toBe(hashState(widdershins));
  });
});

describe('buying a deed', () => {
  it('takes exactly the posted price and hands back the parcel', () => {
    const state = richWorld(30_000);
    const before = state.moneyCents;

    send(state, { type: 'BuyDeed', parcel: 1 });

    expect(state.moneyCents).toBe(before - DEED_PRICE_CENTS_BY_PURCHASE[0]!);
    expect(isParcelOwned(state, 1)).toBe(true);
    expect(state.trace).toHaveLength(1);
  });

  it('refuses what it cannot afford, silently and completely', () => {
    // One cent short of the first rung.
    const state = richWorld(DEED_PRICE_CENTS_BY_PURCHASE[0]! - 1);
    send(state, { type: 'BuyDeed', parcel: 1 });

    expect(state.ownedParcels).toEqual([STARTING_PARCEL]);
    expect(state.moneyCents).toBe(DEED_PRICE_CENTS_BY_PURCHASE[0]! - 1);
    // A refused command changes nothing and writes nothing to the trace.
    expect(state.trace).toEqual([]);
  });

  it('refuses land that touches nothing it owns, and land off the map', () => {
    const state = richWorld();

    // Diagonally opposite the starting lot: unowned, on the map, and not a neighbour.
    send(state, { type: 'BuyDeed', parcel: PARCELS_WIDE + 1 });
    expect(state.ownedParcels).toEqual([STARTING_PARCEL]);

    send(state, { type: 'BuyDeed', parcel: PARCEL_COUNT });
    send(state, { type: 'BuyDeed', parcel: -1 });
    send(state, { type: 'BuyDeed', parcel: 1.5 });
    expect(state.ownedParcels).toEqual([STARTING_PARCEL]);

    // But its neighbour is buyable, and buying it makes the corner reachable.
    expect(isParcelBuyable(state, PARCELS_WIDE + 1)).toBe(false);
    send(state, { type: 'BuyDeed', parcel: 1 });
    expect(isParcelBuyable(state, PARCELS_WIDE + 1)).toBe(true);
  });

  it('refuses to sell the same parcel twice', () => {
    const state = richWorld();
    send(state, { type: 'BuyDeed', parcel: 1 });
    const after = state.moneyCents;
    send(state, { type: 'BuyDeed', parcel: 1 });

    expect(state.moneyCents).toBe(after);
    expect(state.ownedParcels).toEqual([0, 1]);
  });

  it('puts the land on the net-worth books at what it cost', () => {
    const state = richWorld();
    const before = computeNetWorthCents(state);
    expect(landValueCents(state)).toBe(0);

    send(state, { type: 'BuyDeed', parcel: 1 });

    // Plan §6: investing during a scoring window is neutral. Cash went down by the price and
    // the land went up by the same number, so the board does not move.
    expect(landValueCents(state)).toBe(DEED_PRICE_CENTS_BY_PURCHASE[0]);
    expect(computeNetWorthCents(state)).toBe(before);
  });

  it('sells the whole map, and then has nothing left to sell', () => {
    // Enough to clear the whole ladder: the sixteen rungs sum to $6,553,400.
    const state = richWorld(1_000_000_000);
    // Buy outward in row-major order; every parcel touches one already owned.
    for (let parcel = 1; parcel < PARCEL_COUNT; parcel++) {
      send(state, { type: 'BuyDeed', parcel });
    }
    expect(state.ownedParcels).toHaveLength(PARCEL_COUNT);
    expect(nextDeedPriceCents(state)).toBe(-1);
    expect(view(state).land.buyable).toEqual([]);
  });
});

describe('the ownership gate', () => {
  it('refuses a machine, a belt and an arm on land nobody has bought', () => {
    const state = richWorld();
    const x = PARCEL_TILES + 2;

    send(state, { type: 'PlaceMachine', kind: MachineKind.HandCart, tileX: x, tileY: 4 });
    send(state, {
      type: 'PlaceBelt',
      tier: BeltTier.Basic,
      tileX: x,
      tileY: 8,
      dir: 2,
      lengthTiles: 3,
    });
    send(state, { type: 'PlaceGrabber', tier: 1, tileX: x, tileY: 10, dir: 2, filter: 0 });

    expect(state.machines.filter((machine) => machine.tileX >= PARCEL_TILES)).toEqual([]);
    expect(state.belts).toEqual([]);
    expect(state.grabbers).toEqual([]);
  });

  it('refuses a footprint that straddles the fence, then accepts it once the deed is bought', () => {
    const state = richWorld();
    state.unlocked = [TechId.WashAndSlice];
    // A 2×2 with its left column on owned land and its right column on the neighbour's.
    const straddle = PARCEL_TILES - 1;

    send(state, {
      type: 'PlaceMachine',
      kind: MachineKind.Washer,
      tileX: straddle,
      tileY: 2,
    });
    expect(state.machines.some((machine) => machine.tileX === straddle)).toBe(false);

    send(state, { type: 'BuyDeed', parcel: 1 });
    send(state, {
      type: 'PlaceMachine',
      kind: MachineKind.Washer,
      tileX: straddle,
      tileY: 2,
    });
    expect(state.machines.some((machine) => machine.tileX === straddle)).toBe(true);
  });

  it('refuses a belt run that crosses the fence rather than clipping it', () => {
    const state = richWorld();
    send(state, {
      type: 'PlaceBelt',
      tier: BeltTier.Basic,
      tileX: PARCEL_TILES - 2,
      tileY: 2,
      dir: 2,
      lengthTiles: 4,
    });
    // Not a two-tile stub: the whole run or none of it.
    expect(state.belts).toEqual([]);
  });

  it('lets the farmer walk onto land he does not own', () => {
    // Plan §5 sells deeds as the answer to "is space free?", which is a question about
    // building. Nothing in the design fences the player in, and an invisible wall would be
    // the first collision geometry in the game.
    const state = createWorld(9);
    for (let i = 0; i < 400; i++) {
      step(state, {
        tick: state.tick,
        commands: i === 0 ? [{ type: 'SetMoveDirection', dir: 2 }] : [],
      });
    }
    expect(state.player.xSub).toBeGreaterThan(PARCEL_TILES * 256);
    expect(isOwnedTile(state, Math.floor(state.player.xSub / 256), 0)).toBe(false);
  });

  it('plants and zones inside the field regardless, because the field is on the free parcel', () => {
    const state = createWorld(11);
    // Within arm's reach of where a fresh world puts the farmer — planting is a hand verb.
    send(state, { type: 'PlantTile', tileX: 8, tileY: 11, crop: CropId.RussetPotato });
    expect(state.field.some((tile) => tile.crop === CropId.RussetPotato)).toBe(true);
  });
});

describe('the lot is big enough for the game that ships on it', () => {
  it('fits both production lines, the field and the pond with room to spare', () => {
    // The arithmetic behind item 053's acceptance criterion, computed from the specs rather
    // than typed out, so it stays true when a machine changes size.
    const footprint = (kind: MachineKind, count = 1): number => {
      const spec = machineSpec(kind)!;
      return spec.tilesWide * spec.tilesHigh * count;
    };

    // Plan §5's chip line at its canonical 1:1:2:1:1 — two Fryers, because the Fryer is
    // deliberately the bottleneck.
    const chipLine =
      footprint(MachineKind.Washer) +
      footprint(MachineKind.Slicer) +
      footprint(MachineKind.Fryer, 2) +
      footprint(MachineKind.Seasoner) +
      footprint(MachineKind.Bagger);

    // And the soda line's pipe organ, 1:1:1 at the finishing end.
    const sodaLine =
      footprint(MachineKind.Juicer) +
      footprint(MachineKind.Kettle) +
      footprint(MachineKind.Grinder) +
      footprint(MachineKind.SyrupMixer) +
      footprint(MachineKind.Carbonator) +
      footprint(MachineKind.Bottler);

    const utilities =
      footprint(MachineKind.Pump) +
      footprint(MachineKind.Tank, 2) +
      footprint(MachineKind.IrrigationHub) +
      footprint(MachineKind.SellBin) +
      footprint(MachineKind.Sprinkler, 2);

    const field = FIELD_TILES_WIDE * FIELD_TILES_HIGH;
    const pond = POND_TILES_WIDE * POND_TILES_HIGH;
    const machinery = chipLine + sodaLine + utilities;

    const oneParcel = PARCEL_TILES * PARCEL_TILES;
    const wholeLot = WORLD_TILES_WIDE * WORLD_TILES_HIGH;

    // The starting parcel alone cannot hold it — which is the whole reason this item exists.
    // Field, pond and machinery come to more than half of 256 tiles before a single belt or
    // pipe is laid, and belts are most of a factory's floor.
    expect(field + pond + machinery).toBeGreaterThan(oneParcel / 2);

    // Two parcels — one deed, $200 — leave more than twice the machinery's own footprint free
    // for belts, pipes, and walking room.
    const twoParcels = oneParcel * 2;
    expect(twoParcels - field - pond - machinery).toBeGreaterThan(machinery * 2);

    // And the full lot is room for years: sixteen times the map the game shipped with.
    expect(wholeLot).toBe(oneParcel * PARCEL_COUNT);
    expect(wholeLot / oneParcel).toBe(16);

    // Every machine in the game is small enough to fit inside one parcel, so no purchase can
    // ever be unbuildable for want of a footprint.
    for (const spec of MACHINE_SPECS) {
      expect(spec.tilesWide).toBeLessThanOrEqual(PARCEL_TILES);
      expect(spec.tilesHigh).toBeLessThanOrEqual(PARCEL_TILES);
    }
  });
});
