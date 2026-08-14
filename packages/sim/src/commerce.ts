// Selling without you: the delivery cart, the truck depot, and standing contracts.
//
// THIS IS THE LAST COLUMN OF PLAN §3'S LADDER. Every system in the game runs manual → assisted
// → automated, and until now selling stopped at the first rung: a finished line piles bags up
// in a Bagger and the player carries them to the roadside bin. That rung is a gift the world
// starts with and it never rots (§1) — nothing here penalises it, replaces it, or makes it
// slower. What arrives is the two rungs above:
//
//   Manual     carry it to the stand yourself       — `SellItem`, unchanged, free, forever
//   Assisted   load a cart, send it, it comes back  — `LoadCart` / `DispatchCart`, hands
//   Automated  a belt-fed depot on standing routes  — `CreateContract`, no hands at all
//
// **THE HANDS-FREE BOARD IS ADJUDICABLE ONLY IF THIS FILE IS HONEST ABOUT TOUCHES.** Plan §6
// counts "hand-carry/load/unload" as a manual touch and wants an interval with zero of them.
// Until the depot existed that interval could not contain a sale, because every sale ended in a
// command a human issued. So: a cart load and a cart dispatch each count `handCarry`, and a
// depot sale counts **nothing** — not a touch, not a partial one, not a touch on the tick the
// route was signed. Signing a route is paperwork, done once; the shipping is the machine's.
//
// **PRICES ARE POSTED AND IDENTICAL ON EVERY ROUTE.** Locked decision 3, and §8 cuts fluctuating
// markets forever. Every payout in this file is `listPriceCents(item) × count` — the same
// multiplication `applySellItem` does at the bin. There is no premium for volume, no bonus for a
// destination, no haggling, and no counterparty who is another player (§8 cuts that too). A
// contract is a logistics object: it chooses *what* and *how much*, never *what it is worth*.
//
// **NO WALL CLOCK, ANYWHERE.** A run is an integer number of ticks counted down inside `step()`.
// Close the tab mid-journey and the truck is exactly where it was, because time does not pass
// when the world is not being stepped (§6: there is no offline progress, ever).

import {
  CART_CAPACITY,
  CART_RUN_BASE_TICKS,
  CONTRACT_MAX_QUANTITY,
  DEPOT_LOAD_TICKS,
  DEPOT_MAX_CONTRACTS,
  DEPOT_RUN_BASE_TICKS,
  DEPOT_STOCK_CAPACITY,
  type ItemId,
  MachineRole,
  ROAD_EDGE_TILE_X,
  RUN_TICKS_PER_TILE_FROM_ROAD,
  isSellable,
  listPriceCents,
  machineSpec,
} from './data';
import {
  type Contract,
  ContractPhase,
  type Machine,
  CeremonyId,
  type WorldState,
  addItem,
  markCeremony,
} from './state';
import { recordSale } from './stats';

// --- distance -----------------------------------------------------------------------

/**
 * How long one round trip takes for a vehicle standing here, in ticks.
 *
 * **THE JOURNEY HAPPENS OFF THE MAP, AND THAT IS THE ANSWER TO WHETHER A CART NEEDS TO OWN THE
 * GROUND IT DRIVES OVER.** It does not, and there is no ground: a truck leaves the lot for a
 * town that is not simulated, so there is no path, no route, and nothing for a deed to gate.
 * What *is* gated is the tile the vehicle stands on — `PlaceMachine` already refuses a footprint
 * on land you do not hold, so a depot is on your property by construction and the road is not
 * yours because a road never is. Inventing a path across the lot would have meant inventing this
 * game's first pathfinder in order to answer a question the fiction already answers, and it
 * would have made a delivery fail because somebody parked a Fryer in the way.
 *
 * So distance is one subtraction against `ROAD_EDGE_TILE_X`, the lot's west edge, where the
 * design put the road and where `createWorld` stood the roadside stand. A depot two tiles from
 * the road adds 20 ticks; one on the far parcel adds 630, near enough to double a truck's trip.
 * That is what "the map is 64 wide now" is worth as a decision: build near the road, or pay for
 * the view. `Math.abs` is not used because the edge is 0 and a tile index is never negative —
 * `isInsideWorld` refuses those long before a vehicle exists.
 */
export function runTicksFor(machine: Machine, baseTicks: number): number {
  const tilesFromRoad = machine.tileX - ROAD_EDGE_TILE_X;
  const distance = tilesFromRoad > 0 ? tilesFromRoad : 0;
  return baseTicks + distance * RUN_TICKS_PER_TILE_FROM_ROAD;
}

/** A cart's full round trip from where it stands. Published so the panel can draw a track. */
export function cartRunTicks(machine: Machine): number {
  return runTicksFor(machine, CART_RUN_BASE_TICKS);
}

/** A truck's full round trip from its depot. The loading beat is counted separately. */
export function depotRunTicks(machine: Machine): number {
  return runTicksFor(machine, DEPOT_RUN_BASE_TICKS);
}

// --- roles --------------------------------------------------------------------------

function hasRole(machine: Machine, role: MachineRole): boolean {
  const spec = machineSpec(machine.kind);
  return spec !== null && spec.role === role;
}

export function isCart(machine: Machine): boolean {
  return hasRole(machine, MachineRole.DeliveryCart);
}

export function isDepot(machine: Machine): boolean {
  return hasRole(machine, MachineRole.TruckDepot);
}

/** A cart is away exactly while its clock is running. There is no second flag — see `Machine`. */
export function isCartAway(machine: Machine): boolean {
  return machine.runTicksRemaining > 0;
}

// --- depots and their routes --------------------------------------------------------

/** How many routes a depot already holds. Bounded by `DEPOT_MAX_CONTRACTS`. */
export function depotContractCount(state: WorldState, depotId: number): number {
  let count = 0;
  for (let i = 0; i < state.contracts.length; i++) {
    if (state.contracts[i]!.depotId === depotId) count += 1;
  }
  return count;
}

/**
 * Goods sitting on a depot's floor, across every route it holds.
 *
 * `inTransit` is deliberately NOT in this sum: it is the truck's, not the shed's, and counting
 * it here would keep the depot's floor "full" for the whole of every journey — which is the one
 * thing `DEPOT_STOCK_CAPACITY`'s headroom exists to prevent.
 */
export function depotStockedCount(state: WorldState, depotId: number): number {
  let count = 0;
  for (let i = 0; i < state.contracts.length; i++) {
    const contract = state.contracts[i]!;
    if (contract.depotId === depotId) count += contract.stocked;
  }
  return count;
}

/** The route a depot would file this item under, or `null` when it has none for it. */
export function depotRouteFor(state: WorldState, depotId: number, item: ItemId): Contract | null {
  for (let i = 0; i < state.contracts.length; i++) {
    const contract = state.contracts[i]!;
    if (contract.depotId === depotId && contract.item === item) return contract;
  }
  return null;
}

/**
 * Put one item off a belt into a depot. The grabber's only door into this file.
 *
 * **A DEPOT WITH NO ROUTE FOR THIS PRODUCT REFUSES IT**, and the arm then stands there holding
 * it — which is the same "look downstream" stall a full machine gives, in the same vocabulary
 * the whole factory is taught in. The alternative, swallowing anything and sorting it out later,
 * would make a mis-aimed grabber quietly eat a product the depot can never ship, and the player
 * would have no way to see it happen. One route per product per depot (`applyCreateContract`
 * enforces it), so there is never a question of *which* route an item goes to.
 */
export function depotAccept(state: WorldState, depot: Machine, item: ItemId): boolean {
  const contract = depotRouteFor(state, depot.id, item);
  if (contract === null) return false;
  if (depotStockedCount(state, depot.id) >= DEPOT_STOCK_CAPACITY) return false;
  contract.stocked += 1;
  return true;
}

// --- the tick -----------------------------------------------------------------------

/**
 * One payout, through the one accounting path.
 *
 * EVERY SALE IN THE GAME ENDS HERE OR IN `applySellItem`, and both do the same things in
 * the same order: money, then `recordSale` (which owns the gross, the unit count, and the
 * per-item ledger in one write — item 062), and — for these two — `automatedGross`.
 * Plan §6 wants the Shift Report and every board reading one number, so a route that paid the
 * player without telling `stats` would show up as money that appeared from nowhere on a receipt
 * whose whole job is explaining where money came from.
 *
 * NO MANUAL TOUCH IS RECORDED HERE, deliberately and permanently. The touch for a cart is
 * recorded by the *commands* that loaded and dispatched it, which is where the hands were. By
 * the time a vehicle is coming back up the road there is nobody to charge.
 */
function payForDelivery(state: WorldState, item: ItemId, count: number): number {
  const gross = listPriceCents(item) * count;
  state.moneyCents += gross;
  recordSale(state.stats, item, count, gross);
  state.stats.automatedGrossCents += gross;
  return gross;
}

/**
 * Advance every vehicle and every standing route by one tick.
 *
 * Carts in ascending machine id, then contracts in ascending contract id. Both orders are
 * arbitrary and both are FIXED, which is the only property that matters: two runs of the same
 * world must pay out in the same sequence, and a sequence that depended on array churn would be
 * a desync that only shows up after somebody deconstructs something.
 */
export function advanceCommerce(state: WorldState): void {
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    if (machine.runTicksRemaining <= 0) continue;
    if (!isCart(machine)) continue;
    advanceCart(state, machine);
  }

  for (let i = 0; i < state.contracts.length; i++) {
    advanceContract(state, state.contracts[i]!);
  }
}

/**
 * A cart on the road.
 *
 * It pays on ARRIVAL rather than on dispatch, and that choice is what `Contract.inTransit` and
 * the cargo fields in net worth are for: for the length of the run the player owns goods rather
 * than cash, at the same list price, so the net-worth series does not dip and Peak Flow does not
 * record a trough that never happened.
 */
function advanceCart(state: WorldState, machine: Machine): void {
  machine.runTicksRemaining -= 1;
  if (machine.runTicksRemaining > 0) return;

  const item = machine.cargoItem;
  const count = machine.cargoCount;
  machine.cargoItem = 0;
  machine.cargoCount = 0;
  if (item === 0 || count <= 0) return;
  payForDelivery(state, item, count);
}

/**
 * One route's state machine, one tick of it.
 *
 * ```
 *   Waiting ──stock reaches the run size──▶ Loading ──DEPOT_LOAD_TICKS──▶ Rolling ──▶ Waiting
 *                                             │                                        │
 *                                      the truck honks                            the money
 * ```
 *
 * The commit happens at the Waiting → Loading edge: `quantityPerRun` leaves the floor and
 * becomes `inTransit` in one tick, at one price, so nothing the boards read moves. From there it
 * is two countdowns and a payout.
 */
function advanceContract(state: WorldState, contract: Contract): void {
  if (contract.phase === ContractPhase.Waiting) {
    if (contract.stocked < contract.quantityPerRun) return;
    contract.stocked -= contract.quantityPerRun;
    contract.inTransit = contract.quantityPerRun;
    contract.phase = ContractPhase.Loading;
    contract.ticksRemaining = DEPOT_LOAD_TICKS;
    return;
  }

  contract.ticksRemaining -= 1;
  if (contract.ticksRemaining > 0) return;

  if (contract.phase === ContractPhase.Loading) {
    contract.phase = ContractPhase.Rolling;
    contract.ticksRemaining = depotRunTicksForContract(state, contract);
    // Plan §3's Hall of Hands, second named example. Marked on the departure, once per world,
    // never again after a reload — the sim only records that the theatre is owed and the
    // renderer plays it with its own randomness (§12).
    markCeremony(state, CeremonyId.FirstTruck);
    return;
  }

  const count = contract.inTransit;
  contract.inTransit = 0;
  contract.phase = ContractPhase.Waiting;
  contract.ticksRemaining = 0;
  if (count <= 0) return;
  const gross = payForDelivery(state, contract.item, count);
  contract.runsCompleted += 1;
  contract.grossCents += gross;
}

/**
 * The road time for this route's truck, measured from the depot that owns it.
 *
 * A route whose depot has been deconstructed mid-load falls back to the base duration rather
 * than throwing: the goods are real and already committed, so the truck finishes its errand and
 * pays, and `applyDeconstructMachine` deletes the route on arrival. Losing a shed is not a
 * reason to delete the lorry that already left it.
 */
function depotRunTicksForContract(state: WorldState, contract: Contract): number {
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    if (machine.id === contract.depotId) return depotRunTicks(machine);
  }
  return DEPOT_RUN_BASE_TICKS;
}

// --- command-side rules -------------------------------------------------------------
//
// These are exported so `tick.ts` reads one rule per refusal rather than restating arithmetic,
// and so a test can ask the same questions the reducer asks.

/** How much more this cart will take of what it is already carrying. */
export function cartRoomFor(machine: Machine, item: ItemId): number {
  if (isCartAway(machine)) return 0;
  if (machine.cargoItem !== 0 && machine.cargoItem !== item) return 0;
  const room = CART_CAPACITY - machine.cargoCount;
  return room > 0 ? room : 0;
}

/**
 * Whether a route may be written for this product at all.
 *
 * **THE SAME `sellable` RULE THE BIN USES, and it matters more here than there.** A bin that
 * bought seeds turns one misclick into a world that can no longer plant (plan §4's anti-softlock
 * floor); a *standing route* for seeds would do it on a schedule, forever, while the player was
 * three screens away. One rule, one place, both verbs.
 */
export function contractItemLegal(item: ItemId): boolean {
  return isSellable(item);
}

/** Whether a run size is one the world will write down. */
export function contractQuantityLegal(quantity: number): boolean {
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= CONTRACT_MAX_QUANTITY;
}

/** Whether this depot has room for one more route. */
export function depotHasContractRoom(state: WorldState, depotId: number): boolean {
  return depotContractCount(state, depotId) < DEPOT_MAX_CONTRACTS;
}

/**
 * Tear a route up and hand everything back.
 *
 * **CANCELLING IS FREE AND NOTHING VANISHES** (plan §4). Stock on the floor and goods already on
 * the truck both come back to the player's bag, which is what `RemoveBelt` does with what was
 * riding it and what `DeconstructMachine` does with what was in the hoppers.
 *
 * PAYING OUT THE TRUCK INSTEAD WAS THE OBVIOUS ALTERNATIVE AND IT IS AN EXPLOIT. The goods are
 * sold the moment they are on a lorry, so paying immediately looks generous and harmless — until
 * you notice it deletes the run time. Sign four routes, wait for them to load, cancel all four,
 * re-sign: that is the same money with the journey removed, and it turns the rung of the ladder
 * whose entire selling point is *never touching it again* into the most click-intensive verb in
 * the game. Handing the crates back costs the player a trip and can never pay better than
 * waiting, which is the only shape with no strategy in it.
 */
export function refundContract(state: WorldState, contract: Contract): void {
  if (contract.stocked > 0) addItem(state, contract.item, contract.stocked);
  if (contract.inTransit > 0) addItem(state, contract.item, contract.inTransit);
  contract.stocked = 0;
  contract.inTransit = 0;
}

/** Remove a route from the world. Callers refund first; this only unlinks it. */
export function removeContractById(state: WorldState, id: number): boolean {
  for (let i = 0; i < state.contracts.length; i++) {
    if (state.contracts[i]!.id === id) {
      state.contracts.splice(i, 1);
      return true;
    }
  }
  return false;
}

/**
 * Delete every route a depot held, handing back everything on its floor and on its trucks.
 *
 * Called when the depot itself leaves the lot. A contract whose depot is gone is not a contract
 * — there is nothing to load it — and leaving one behind would put an orphan in the hash, in the
 * save, and on the panel, with a cancel button that is the only thing keeping it honest.
 */
export function releaseDepotContracts(state: WorldState, depotId: number): void {
  for (let i = state.contracts.length - 1; i >= 0; i--) {
    const contract = state.contracts[i]!;
    if (contract.depotId !== depotId) continue;
    refundContract(state, contract);
    state.contracts.splice(i, 1);
  }
}
