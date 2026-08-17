// **THE CLOCK A BOX IS SPENDING, PUBLISHED** (item 114).
//
// Item 110 taught a container to spend its contents' window and to turn them to Compost where
// they stand. It did not tell anybody. `cargoFreshTicks` appeared nowhere in `apps/web` at all,
// so the honest summary of the state this file was written against is: **the game destroys your
// food correctly and silently**, and the only surface that could have said so — "12 potatoes" —
// says the same words the whole way down to zero.
//
// So `MachineView` gained two fields, and the interesting risk is not that they are wrong once.
// It is that `view.ts` cannot import `tick.ts`, so the question *which boxes actually spend a
// clock* is now answered in two files. Drift between them is not a cosmetic bug: a countdown on
// a machine the sim never ages is a timer that appears to be stuck, and a machine the sim DOES
// age publishing nothing is item 114 all over again, one release later.
//
// **HENCE THE SWEEP AT THE BOTTOM**, which is the test that actually holds this together. Every
// machine kind in the game gets a load of potatoes with a full window, the world runs one tick,
// and what the projection SAID is checked against what the goods DID. Nothing may lose clock in
// silence, nothing may count down while standing still, and "frozen" has to mean frozen.

import { describe, expect, it } from 'vitest';

import {
  type MachineView,
  type WorldState,
  type WorldView,
  ItemId,
  MachineKind,
  createWorld,
  createWorldView,
  spawnMachine,
  stepMany,
  view,
} from '../src/index';

/**
 * A machine kind's name, for failure messages only.
 *
 * `MachineKind` is a frozen object rather than a TS enum, so there is no reverse lookup to
 * index — `MachineKind[kind]` is an implicit `any` and fails `noImplicitAny`. Scanning the
 * entries is fine at the cost of a message nobody reads unless something already broke.
 */
function kindName(kind: number): string {
  for (const [name, value] of Object.entries(MachineKind)) {
    if (value === kind) return name;
  }
  return String(kind);
}

const ACTIVE_MINUTE = 1_200;
const POTATO_WINDOW = 18_000;

function world(seed = 114): WorldState {
  const state = createWorld(seed);
  state.player.xSub = 128;
  state.player.ySub = 128;
  return state;
}

/** The projected machine with this id, freshly read. The buffer is deliberately not reused. */
function projected(state: WorldState, id: number): MachineView {
  const out: WorldView = view(state, createWorldView());
  const machine = out.machines.find((m) => m.id === id);
  expect(machine, `machine ${String(id)} vanished from the projection`).toBeDefined();
  return machine!;
}

/** A container of `kind` holding `count` goods with `ticks` of window left. */
function stocked(
  state: WorldState,
  kind: MachineKind,
  item: ItemId,
  count: number,
  ticks: number,
): { id: number } | null {
  const machine = spawnMachine(state, kind, 0, 0);
  if (machine === null) return null;
  machine.cargoItem = item;
  machine.cargoCount = count;
  machine.cargoFreshTicks = ticks;
  return machine;
}

// --- the cart, which is the machine the item was filed about ------------------------------

describe('a hand cart', () => {
  it('publishes the clock it is spending, and spends it in the open', () => {
    const state = world();
    const cart = stocked(state, MachineKind.HandCart, ItemId.RussetPotato, 12, 6_000)!;

    expect(projected(state, cart.id).cargoTicksToSpoil).toBe(6_000);
    expect(projected(state, cart.id).cargoFrozen, 'a cart is not a fridge').toBe(0);

    stepMany(state, ACTIVE_MINUTE);
    expect(
      projected(state, cart.id).cargoTicksToSpoil,
      'the number on screen moved by exactly the minute that passed',
    ).toBe(6_000 - ACTIVE_MINUTE);
  });

  it('stops counting the moment the load turns, because there is nothing left to count', () => {
    // The load becomes Compost in place — `cargoItem` changes under the player. Compost keeps
    // indefinitely, so the honest reading of the box afterwards is silence rather than "0:00",
    // which would be a countdown to an event that has already happened.
    const state = world(115);
    const cart = stocked(state, MachineKind.HandCart, ItemId.RussetPotato, 12, 100)!;

    stepMany(state, 200);
    expect(projected(state, cart.id).cargoItem, 'the potatoes turned').toBe(ItemId.Compost);
    expect(projected(state, cart.id).cargoTicksToSpoil).toBe(-1);
    expect(projected(state, cart.id).cargoFrozen).toBe(0);
  });
});

// --- the cellar, which is the one thing in the game that is allowed to stop the clock -----

describe('a root cellar', () => {
  it('reads as frozen, and says what it is holding rather than only that it is holding it', () => {
    const state = world(116);
    const cellar = stocked(state, MachineKind.RootCellar, ItemId.RussetPotato, 40, 6_000)!;

    stepMany(state, 5 * ACTIVE_MINUTE);
    const mv = projected(state, cellar.id);
    expect(mv.cargoFrozen, 'the $250 machine does the one thing it is for').toBe(1);
    expect(
      mv.cargoTicksToSpoil,
      'and BANKS the window rather than resetting it — the number is the balance',
    ).toBe(6_000);
  });

  it('is not "frozen" when it is empty, because an empty shed preserves nothing', () => {
    const state = world(117);
    const cellar = spawnMachine(state, MachineKind.RootCellar, 0, 0)!;

    const mv = projected(state, cellar.id);
    expect(mv.cargoTicksToSpoil).toBe(-1);
    expect(mv.cargoFrozen).toBe(0);
  });

  it('says nothing about goods that were never going to spoil', () => {
    const state = world(118);
    // Compost is the shelf-stable case with no ceremony attached: `freshnessTicks` is 0, so the
    // sim records no window on the way in and has no opinion to publish on the way out.
    const cellar = stocked(state, MachineKind.RootCellar, ItemId.Compost, 10, 0)!;

    expect(projected(state, cellar.id).cargoTicksToSpoil).toBe(-1);
    expect(projected(state, cellar.id).cargoFrozen).toBe(0);
  });
});

// --- the two boxes that hold food and are still not counted -------------------------------

describe('the containers that publish nothing, and why', () => {
  it('says nothing about a format-18 load whose clock was never written down', () => {
    // `cargoFreshTicks: 0` beside real goods is exactly what migration 17 → 18 leaves behind,
    // and `advanceStorageSpoilage` skips it — the load is not ageing, so there is no countdown
    // to draw. It heals to a real window the first time anybody loads the box (item 110), and
    // the projection starts counting on the same tick the sim does.
    const state = world(119);
    const cart = stocked(state, MachineKind.HandCart, ItemId.RussetPotato, 20, 0)!;

    stepMany(state, ACTIVE_MINUTE);
    expect(projected(state, cart.id).cargoTicksToSpoil).toBe(-1);
    expect(projected(state, cart.id).cargoFrozen).toBe(0);
  });

  it('says nothing about a delivery cart, because the sim spends nothing on one', () => {
    // NOT AN OVERSIGHT AND NOT A RULING. `tick.ts` excludes the delivery cart by role — its load
    // is on the road — and item 112 left "should a delivery age?" open for the owner. Until that
    // is answered, the view describes the sim it has. A falling clock here would be the first
    // lie this field ever told, and the test exists so the answer is changed in one place.
    const state = world(120);
    const cart = stocked(state, MachineKind.DeliveryCart, ItemId.RussetPotato, 5, 6_000)!;
    expect(cart, 'the delivery cart never got built; this test proved nothing').not.toBeNull();

    stepMany(state, ACTIVE_MINUTE);
    expect(projected(state, cart.id).cargoTicksToSpoil).toBe(-1);
  });
});

// --- the shelf that is a container without looking like one -------------------------------

describe('a harvester dock', () => {
  it('publishes its produce shelf, which ages at loose speed with nobody touching it', () => {
    const state = world(121);
    const dock = stocked(state, MachineKind.HarvesterDock, ItemId.RussetPotato, 6, 4_800)!;

    stepMany(state, 3 * ACTIVE_MINUTE);
    const mv = projected(state, dock.id);
    expect(mv.cargoTicksToSpoil, 'a shed is not a fridge either').toBe(4_800 - 3 * ACTIVE_MINUTE);
    expect(mv.cargoFrozen).toBe(0);
  });
});

// --- the sweep ----------------------------------------------------------------------------

describe('every machine in the game, checked against what its goods actually did', () => {
  it('never lets a container lose clock while the projection says there is nothing to count', () => {
    const kinds = Object.values(MachineKind).filter((k): k is MachineKind => typeof k === 'number');
    let containers = 0;
    let frozen = 0;

    for (const kind of kinds) {
      const state = world(200 + kind);
      const machine = stocked(state, kind, ItemId.RussetPotato, 4, POTATO_WINDOW);
      if (machine === null) continue;

      const before = projected(state, machine.id);
      const said = before.cargoTicksToSpoil;
      const saidFrozen = before.cargoFrozen;

      const start = state.machines.find((m) => m.id === machine.id)!.cargoFreshTicks;
      stepMany(state, 1);
      const now = state.machines.find((m) => m.id === machine.id)!.cargoFreshTicks;
      const spent = start - now;

      if (said < 0) {
        expect(spent, `${kindName(kind)} is spending a clock it never mentioned`).toBe(0);
        expect(saidFrozen, 'nothing to count cannot also be frozen').toBe(0);
        continue;
      }

      containers += 1;
      expect(said, `${kindName(kind)} misreported its remainder`).toBe(start);

      if (saidFrozen === 1) {
        frozen += 1;
        expect(spent, `${kindName(kind)} calls itself frozen and is not`).toBe(0);
      } else {
        expect(spent, `${kindName(kind)} shows a countdown and stands still`).toBeGreaterThan(0);
      }
    }

    // A guard on the guard: a sweep that silently stopped finding containers would pass every
    // assertion above by never running one. Three today — cellar, cart, harvester dock — and
    // exactly one of them is allowed to stop the clock.
    expect(containers, 'the sweep found no containers at all').toBeGreaterThanOrEqual(3);
    expect(frozen, 'there is one freeze in this game and it costs $250').toBe(1);
  });
});
