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
  emptiesForDelivery,
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
  addItemFresh,
  heldOutputItem,
  machineById,
  markCeremony,
  mergedFreshness,
  spoilTickFromRemaining,
} from './state';
import { recordSale } from './stats';
import { effectiveOutputCapacity } from './upgrades';

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
 *
 * **`freshTicks` IS THE CLOCK THE ARRIVAL BRINGS WITH IT** (item 115), and 0 means "no opinion"
 * rather than "no clock" — the same word every other door in the game speaks, from `putStorage` to
 * `putHopper` to `beltInsert`. This parameter did not exist until item 115, and its absence WAS the
 * sixth fridge: an arm carrying a potato with two minutes left handed the floor a potato, and the
 * floor wrote down a count. Merged at the SOONER against whatever is already stocked, because a
 * floor topped up with one fresh crate every quarter hour would otherwise keep the pile underneath
 * alive forever — `mergedFreshness`' entire reason for existing.
 */
export function depotAccept(
  state: WorldState,
  depot: Machine,
  item: ItemId,
  freshTicks: number,
): boolean {
  const contract = depotCanAcceptRoute(state, depot, item);
  if (contract === null) return false;
  contract.stockedFreshTicks = mergedFreshness(
    contract.stocked,
    contract.stockedFreshTicks,
    item,
    freshTicks,
  );
  contract.stocked += 1;
  return true;
}

/**
 * **THE DEPOT'S ACCEPT-DOOR PREDICATE** (item 085): the route that would take this item right
 * now, or `null` when the depot would refuse it.
 *
 * Returns the contract rather than a bare boolean so `depotAccept` above can be *this plus one
 * increment* — the house single-door rule taken to its conclusion. A parallel `depotCanAccept`
 * that re-asked "is there a route, is there room" would be a second copy of the refusal rule,
 * and the day someone adds a third condition to one of them a grabber starts picking up goods
 * this depot will not take. There is one copy, and it is here.
 *
 * Reading it costs one pass over the contracts and one over them again for the count; nothing
 * is allocated, which is what lets the look-ahead run per arm per swing.
 */
export function depotCanAcceptRoute(
  state: WorldState,
  depot: Machine,
  item: ItemId,
): Contract | null {
  const contract = depotRouteFor(state, depot.id, item);
  if (contract === null) return null;
  if (depotStockedCount(state, depot.id) >= DEPOT_STOCK_CAPACITY) return null;
  return contract;
}

/** True when a depot would take this item right now. `depotCanAcceptRoute`, as a yes/no. */
export function depotCanAccept(state: WorldState, depot: Machine, item: ItemId): boolean {
  return depotCanAcceptRoute(state, depot, item) !== null;
}

/**
 * ONE BIN SALE, AND THE ONLY PLACE A BIN SALE IS BOOKED.
 *
 * Hands and belts both end here (item 087). `applySellItem` in `tick.ts` owns the HAND's
 * preconditions — is it sellable, are you standing near the bin, do you actually have the
 * goods — and `sellBinAccept` below owns the BELT's; but the money and the ledger are these
 * four lines, once, for both. Extracted rather than duplicated on the wave-8 single-credit
 * rule: two places that each did `moneyCents += gross; recordSale(...)` would be a second
 * booking the day one of them gained a line the other did not, and plan §6 wants the Shift
 * Report and every board reading one number.
 *
 * `recordSale` owns the gross, the unit count, and the per-item row in one write (item 062).
 *
 * NO TOUCH IS COUNTED HERE, and that is not an oversight — it is why the split is where it is.
 * The hand's `handCarry` belongs to the hand's door, because that is where the hands were.
 * A belt sale passes through this function without touching that counter, so the Hands-Free
 * board counts an automated bin correctly for free.
 *
 * NOR `automatedGrossCents`, DELIBERATELY. That counter's own doc says "gross that left the lot
 * on a cart or a truck", and the Dispatch panel's header is read off it — a bin sale left on
 * neither and has no dispatch to report. Widening it to mean "income I did not carry by hand"
 * is a defensible call and an owner's to make, not this door's; flagged in item 046's balance
 * pile rather than decided here.
 */
export function sellAtBin(state: WorldState, item: ItemId, count: number): number {
  const gross = listPriceCents(item) * count;
  state.moneyCents += gross;
  recordSale(state.stats, item, count, gross);
  return gross;
}

/**
 * The sell bin's door for a grabber arm: one unit, sold on arrival, at list.
 *
 * A CHIP LINE CAN END AT THE BIN NOW (owner ruling, 2026-08-15: "if I point a picker from a
 * track that has snacks to the trade post, it should be able to sell"). Before this the bin
 * matched none of `grabberPlace`'s doors and the arm stood there holding a bag of chips
 * forever, which read as a bug because it was one.
 *
 * ONE PRICE PATH, so freshness needs no special case: Day-Old goods are their own `ItemId`
 * with their own list price, and `sellAtBin` prices whatever it is handed. A belt sale and a
 * hand sale of the same bag at the same tick fetch the same cents by construction, because
 * they are the same multiplication.
 *
 * UNSELLABLES ARE REFUSED AT THE DOOR, exactly as the bin refuses them from hands — plan §4's
 * anti-softlock floor is that a world can always plant, and an arm quietly selling the seed
 * shelf would break it faster than a misclick ever could. The arm then STALLS holding the seed,
 * which is the ordinary "look downstream" stall every other door in `grabberPlace` gives.
 *
 * **ITEM 085 MADE THE STALL UNREACHABLE, and left it standing anyway.** An arm now asks
 * `sellBinCanAccept` before it picks anything up, so no arm aimed at a bin ever closes its claw
 * on a seed — the trap item 088 named (a belt off a harvester dock's SEED shelf into a bin,
 * selling nothing and jamming the arm forever) cannot be built now. The refusal below is still
 * the door: an arm already mid-swing when the world changed under it must still be told no, and
 * a second caller arriving tomorrow inherits the rule rather than a comment about it.
 */
export function sellBinAccept(state: WorldState, item: ItemId): boolean {
  if (!sellBinCanAccept(item)) return false;
  sellAtBin(state, item, 1);
  return true;
}

/**
 * **THE SELL BIN'S ACCEPT-DOOR PREDICATE** (item 085). A bin has no capacity and no route
 * table: the only question it ever asks is whether the thing has a price, so the predicate is
 * `isSellable` under the bin's own name. Named rather than inlined at the two call sites,
 * because "what the bin refuses" is a fact about the bin — the day it grows a second rule
 * (a closed bin, a per-day cap), there is one place it goes.
 */
export function sellBinCanAccept(item: ItemId): boolean {
  return isSellable(item);
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
 * **THE RETURN LEG** (item 131): a completed delivery sets the empties down in the vehicle's own
 * output basket. **THE ONE PLACE EMPTIES ENTER THE WORLD**, and both vehicles come through it.
 *
 * A SOURCE, not a transfer. The bottles left the lot inside the soda and were paid for at the
 * till; what this mints is the glass coming back off a lorry from a town that is not simulated —
 * `runTicksFor`' fiction, seen from the other end. So there is no clock to carry: an empty is
 * shelf-stable (it is absent from `FRESHNESS_TICKS_BY_ITEM`, exactly as the bottle it used to be
 * is), and the basket's clock is written to 0 out loud rather than left correct by accident.
 *
 * WHICH PRODUCTS COME BACK AS WHAT IS `EMPTIES_PER_DELIVERY`, and it is data because it is
 * balance: a Six-Pack returning four bottles instead of six is a repricing of the whole soda
 * line, and `BALANCE_HASH` folds the table in so a save cannot silently be read against it.
 *
 * TWO REFUSALS, AND NEITHER OF THEM IS A LOSS OF GOODS THAT EXIST:
 *
 *   - **A basket already holding something else is left alone.** One product per basket is the
 *     rule everywhere (`heldOutputItem`), and today nothing but empties can ever be in a
 *     vehicle's, so this is the rule being obeyed rather than a case with a story.
 *   - **A full basket mints fewer.** See `VEHICLE_EMPTIES_CAPACITY` for why capping beats
 *     stalling the vehicle, and for why a source that mints less is not plan §4's "nothing
 *     vanishes" being bent. Every unit this function creates is put in the basket on the same
 *     line it is counted; there is no path where one is made and then dropped.
 */
function landEmpties(machine: Machine, item: ItemId, count: number): void {
  const back = emptiesForDelivery(item, count);
  if (back === null) return;

  const spec = machineSpec(machine.kind);
  if (spec === null) return;

  const held = heldOutputItem(machine, spec);
  if (held !== 0 && held !== back.item) return;

  const room = effectiveOutputCapacity(spec, machine) - machine.outputCount;
  if (room <= 0) return;

  const landed = back.count < room ? back.count : room;
  machine.outputItem = back.item;
  machine.outputCount += landed;
  // Shelf-stable, so this is "no opinion" rather than a window — the reading every door in the
  // game gives a 0. Stated rather than assumed, because a vehicle's basket having been 0 forever
  // is exactly the kind of luck that stops being true one item later.
  machine.outputFreshTicks = 0;
}

/**
 * A cart on the road.
 *
 * It pays on ARRIVAL rather than on dispatch, and that choice is what `Contract.inTransit` and
 * the cargo fields in net worth are for: for the length of the run the player owns goods rather
 * than cash, at the same list price, so the net-worth series does not dip and Peak Flow does not
 * record a trough that never happened.
 *
 * **AND IT COMES BACK WITH THE EMPTIES** (item 131). The same arrival, one line further down: the
 * load is sold and the glass is set down in the cart's basket, where a grabber or the unload key
 * can take it to a Washer.
 */
function advanceCart(state: WorldState, machine: Machine): void {
  machine.runTicksRemaining -= 1;
  if (machine.runTicksRemaining > 0) return;

  const item = machine.cargoItem;
  const count = machine.cargoCount;
  machine.cargoItem = 0;
  machine.cargoCount = 0;
  // The load is sold, so its clock goes with it (item 110). Cleared beside the pair it belongs to
  // rather than left to decay to nothing on its own, so "empty cart" is one state and not two.
  machine.cargoFreshTicks = 0;
  if (item === 0 || count <= 0) return;
  payForDelivery(state, item, count);
  landEmpties(machine, item, count);
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
    // **THE CLOCK GOES ON THE LORRY WITH THE CRATES** (item 115). The floor keeps its own number
    // for whatever is left behind — one pile, one clock, so a partial commit does not have to
    // divide anything — and an emptied floor drops to 0, because "empty" has to be ONE state and
    // not two. `advanceCart` clears a cart's clock beside its cargo pair for the same reason: a
    // container with a remainder and nothing in it hashes differently from an identical one that
    // reached empty by another route.
    contract.inTransitFreshTicks = contract.stockedFreshTicks;
    if (contract.stocked <= 0) contract.stockedFreshTicks = 0;
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
  // Sold, so its clock goes with it — `advanceCart`'s line, on the other vehicle.
  contract.inTransitFreshTicks = 0;
  contract.phase = ContractPhase.Waiting;
  contract.ticksRemaining = 0;
  if (count <= 0) return;
  const gross = payForDelivery(state, contract.item, count);
  contract.runsCompleted += 1;
  contract.grossCents += gross;
  // **THE EMPTIES COME HOME TO THE SHED THE ROUTE WAS SIGNED AT** (item 131), which is the depot
  // the truck reverses back into rather than "the depot" in general — a lot can hold several, and
  // a load returning to the wrong yard would be a teleport. A route whose depot has been
  // deconstructed mid-run finds nothing here and mints nothing: the same "the lorry finishes its
  // errand and pays" fallback `depotRunTicksForContract` takes, and the glass has nowhere on the
  // lot to be put down.
  const depot = machineById(state, contract.depotId);
  if (depot !== null) landEmpties(depot, contract.item, count);
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
  // **AND THE CLOCK COMES BACK WITH THEM** (item 115). These two lines called `addItem`, which
  // stamps a window from NOW — so tearing up a route was the $80 hand cart of item 110 wearing a
  // lorry, and the belt-fed version of the loop needed no clicking at all. `addItemFresh` with
  // `spoilTickFromRemaining` is the same pair `applyDeconstructMachine` hands a boxed cellar's
  // load back through; a remainder of 0 still means "no opinion" and stamps a fresh window, which
  // is correct for a shelf-stable good and for a route grandfathered by format 21.
  if (contract.stocked > 0) {
    addItemFresh(
      state,
      contract.item,
      contract.stocked,
      spoilTickFromRemaining(state, contract.stockedFreshTicks),
    );
  }
  if (contract.inTransit > 0) {
    addItemFresh(
      state,
      contract.item,
      contract.inTransit,
      spoilTickFromRemaining(state, contract.inTransitFreshTicks),
    );
  }
  contract.stocked = 0;
  contract.stockedFreshTicks = 0;
  contract.inTransit = 0;
  contract.inTransitFreshTicks = 0;
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
