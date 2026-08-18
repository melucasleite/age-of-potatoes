// The delivery trucks ([[132]]): the first thing in this game that leaves the lot.
//
// ── WHY THIS IS PURE RENDERER WORK, AND HOW IT STAYS THAT WAY (§12) ─────────────────────
//
// A standing contract was, until this file, a number that went up. The sim already published
// everything needed to draw it and nothing here asks for more: `ContractView.phase` says
// waiting / loading / rolling, `ContractView.ticksRemaining` says how far through, and the
// depot's `runTicks` says how long the whole round trip is. Position is
// `1 - ticksRemaining / runTicks` read fresh every frame — no recorded position, no folded
// tick, no interpolation state to prime.
//
// That last part is not a shortcut, it is the design. The bots and the player need
// `recordTick` because the sim moves them a whole subtile at a time and the renderer has to
// smooth between two known positions. A truck's clock is a countdown, so the honest smoothing
// is arithmetic on the clock itself (`runElapsed` takes the frame's `alpha`), and there is
// nothing to get out of sync. A save reloaded mid-run draws the truck exactly where it should
// be on the first frame, with no priming and no slide in from the world origin.
//
// The ONE piece of memory is the chosen lane, and it is write-only: picked when a run starts,
// held until it ends, never read back into a command, never persisted, never hashed. It has
// to be remembered rather than recomputed because it is a CHOICE — recomputing it every frame
// would let a truck change rows halfway home the instant somebody built a Fryer.
//
// ── THE ROUTE, AND THE THREE RULINGS IT IMPLEMENTS ──────────────────────────────────────
//
//   · OUT FOR THE FIRST HALF, BACK FOR THE SECOND. `runTicks` is a round trip, so it arrives
//     home exactly as the run completes and no second clock is needed. See `truck-route.ts`
//     for why the SPEED inside those halves is not linear.
//   · A CLEAR LANE, CHOSEN ONCE AT DEPARTURE. Due west, toward the road at the lot's west
//     edge, along the least-obstructed row of (or beside) the depot's own footprint. It parks
//     in the lane it will drive, so there is never a bend and never a reversing manoeuvre.
//   · THE LOADING BEAT GETS A STATIONARY TRUCK. `phase === 1` is the one phase where a parked
//     lorry is correct, and it is told apart from driving by the crate hopping aboard rather
//     than riding steady on the roof.
//
// ── WHAT IT CARRIES, AND WHY IT IS OVER THE TRUCK RATHER THAN ON THE BED ────────────────
//
// `ContractView.item` is right there and a truck that visibly carries potatoes makes the
// whole automation legible from across the lot. The art lane's frames draw the bed as a
// CLOSED cargo box, so compositing a crate onto it would be painting through a roof. The
// chip therefore rides above the truck — which is not a compromise, it is `bots.ts`'s
// existing vocabulary for exactly this sentence ("over the head, not in front of the chest"),
// so a carrying truck and a carrying robot say the same thing the same way.
//
// It rides out LOADED and comes back EMPTY, which is the cheapest possible way to tell the
// two halves of the run apart at a glance, and happens to be true.
//
// ── FACING ──────────────────────────────────────────────────────────────────────────────
//
// `truck_side` is authored facing WEST — the bots' convention (`bots.ts`: "east is west with
// `scale.x = -1`"), and the OPPOSITE of the player's, whose side strip faces east. Both
// conventions already live in this codebase; the truck follows the vehicle one. Driving out
// is therefore the unmirrored frame and coming home is the mirror, which is also the cheaper
// of the two ways round.
//
// `truck_up` and `truck_down` are in the atlas and deliberately UNUSED here: the run is due
// west and back, so a truck never turns. They are the frames a future route with a bend would
// need, and they cost nothing sitting in the atlas.

import { Sprite } from 'pixi.js';
import { ContractPhase, MachineKind, TICKS_PER_SECOND } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import type { ItemPage } from './belt-items';
import type { WorldRect } from './camera';
import { TILE_PX } from './pixel';
import { chooseLane, runElapsed, truckAt } from './truck-route';
import type { TruckRoute } from './truck-route';
import { ART } from './textures';
import type { ArtSet } from './textures';

/** The authored side frame is two tiles long. Half of it is how far its centre clears an edge. */
const TRUCK_HALF_W = TILE_PX;

/**
 * Cruise speed, written in tiles per second because that is the unit a person can judge.
 *
 * SIX, against the farmer's four. His pace is `PLAYER_SPEED_SUBTILES_PER_100_TICKS` — 5,120
 * subtiles per 100 ticks, which works out at 0.2 tiles a tick, four a second — but that
 * constant is NOT exported from `@snack/sim`, so this is an independent number chosen to sit
 * half again above it rather than a derivation dressed up as one. If the farmer is ever
 * retuned, nothing here will notice; the number to re-check is this one.
 *
 * Half again a walking pace is enough to read as a vehicle and slow enough that crossing a
 * 64-tile lot is a journey rather than a jump cut.
 */
const TRUCK_SPEED_TILES_PER_SECOND = 6;
const TRUCK_SPEED_PX_PER_TICK = (TRUCK_SPEED_TILES_PER_SECOND * TILE_PX) / TICKS_PER_SECOND;

/** How high above the lane the carried crate rides, and how far it hops while loading. */
const CARGO_LIFT_PX = TILE_PX + 4;
const CARGO_HOP_PX = 5;
const CARGO_HOP_MS = 420;

interface TruckVisual {
  body: Sprite;
  /** What is aboard. Hidden on the way home, because it is not aboard any more. */
  cargo: Sprite;
  /** The lane this run is driving, chosen at departure and held. Write-only (§12). */
  route: TruckRoute | null;
}

export class TruckLayer {
  private readonly visuals = new Map<number, TruckVisual>();

  constructor(
    private readonly art: ArtSet,
    private readonly items: ItemPage,
    private readonly attach: (visual: TruckVisual) => void,
  ) {}

  update(view: WorldView, alpha: number, rect: WorldRect, nowMs: number): void {
    const contracts = view.commerce.contracts;
    const seen = new Set<number>();

    // Lanes already spoken for THIS FRAME, so a depot running two contracts at once does not
    // stack one lorry on another. Rebuilt per frame rather than kept, because a run that ends
    // has to release its row without anything having to remember to.
    const takenByDepot = new Map<number, Set<number>>();
    for (let i = 0; i < contracts.length; i++) {
      const contract = contracts[i]!;
      if (contract.phase === ContractPhase.Waiting) continue;
      const route = this.visuals.get(contract.id)?.route;
      if (route === undefined || route === null) continue;
      let taken = takenByDepot.get(contract.depotId);
      if (taken === undefined) {
        taken = new Set();
        takenByDepot.set(contract.depotId, taken);
      }
      taken.add(route.laneY);
    }

    for (let i = 0; i < contracts.length; i++) {
      const contract = contracts[i]!;

      let visual = this.visuals.get(contract.id);
      if (visual === undefined) {
        visual = { body: new Sprite(), cargo: new Sprite(), route: null };
        // Anchored at the wheels and offset half a tile down, the player's own anchor and the
        // player's own offset — so a truck standing in a row stands in that row.
        visual.body.anchor.set(0.5, 1);
        visual.cargo.anchor.set(0.5, 0.5);
        this.visuals.set(contract.id, visual);
        this.attach(visual);
      }
      seen.add(contract.id);

      // A route WAITING on stock has no truck: the lorry is not sitting in the yard with its
      // engine running, it has not been sent for. Releasing the lane here is what lets the
      // next run pick a different one if the lot has been rebuilt in the meantime.
      if (contract.phase === ContractPhase.Waiting) {
        visual.route = null;
        visual.body.visible = false;
        visual.cargo.visible = false;
        continue;
      }

      const depot = findDepot(view, contract.depotId);
      if (depot === null) {
        // The shed was deconstructed mid-run. The sim finishes the errand and pays (see
        // `advanceContract`), but there is nowhere on the lot for the truck to be — so it is
        // not drawn, rather than drawn at the world origin.
        visual.route = null;
        visual.body.visible = false;
        visual.cargo.visible = false;
        continue;
      }

      if (visual.route === null) {
        visual.route = planRoute(view, depot, takenByDepot.get(contract.depotId) ?? EMPTY_LANES);
      }
      const route = visual.route;

      // Loading is the one phase where a stationary truck is right: it is at the bay with
      // goods going aboard. `ticksRemaining` here is the LOADING clock, not the run clock, so
      // it must not be fed to `runElapsed` — a five-second beat read against a forty-five
      // second run would put the truck a tenth of the way down the road while it loads.
      const loading = contract.phase === ContractPhase.Loading;
      const travelPx = route.homeX - route.awayX;
      const at = loading
        ? PARKED
        : truckAt(
            runElapsed(contract.ticksRemaining, depot.runTicks, alpha),
            depot.runTicks,
            travelPx,
            TRUCK_SPEED_PX_PER_TICK,
          );
      const worldX = route.homeX - travelPx * at.away;
      const worldY = route.laneY * TILE_PX + TILE_PX / 2;

      // Sprites land on whole SOURCE pixels or the truck shimmers inside a world root that is
      // itself on an exact device pixel — the player's rule, and the bots'.
      const drawX = Math.round(worldX);
      const drawY = Math.round(worldY);

      const visible =
        drawX + TRUCK_HALF_W > rect.x &&
        drawX - TRUCK_HALF_W < rect.x + rect.width &&
        drawY + TILE_PX > rect.y &&
        drawY - TILE_PX < rect.y + rect.height;
      // Loaded on the way out, empty on the way home — the direction of the run, readable
      // from across the lot without a panel.
      const carrying = loading || at.heading === 1;
      visual.body.visible = visible;
      visual.cargo.visible = visible && carrying && contract.item !== 0;
      if (!visible) continue;

      visual.body.texture = this.art.get(ART.truckSide);
      // The frame faces WEST. Outbound is west, so it is unmirrored going out and mirrored
      // coming back — flipped about its own centre line, so it does not shuffle sideways as
      // it turns around at the far end.
      visual.body.scale.x = at.heading === 1 ? 1 : -1;
      visual.body.position.set(drawX, drawY);

      if (!visual.cargo.visible) continue;
      visual.cargo.texture = this.items.texture(contract.item);
      // WHILE LOADING IT HOPS, while driving it rides steady. That is the whole difference
      // between the two phases at a glance, and it is a cosmetic wall clock — legal on this
      // side of the seam, fed the frame's one `performance.now()` reading by the caller.
      const hop = loading ? Math.abs(Math.sin(nowMs / CARGO_HOP_MS)) * CARGO_HOP_PX : 0;
      visual.cargo.position.set(drawX, drawY - CARGO_LIFT_PX - Math.round(hop));
    }

    for (const [id, visual] of this.visuals) {
      if (seen.has(id)) continue;
      destroyVisual(visual);
      this.visuals.delete(id);
    }
  }

  destroy(): void {
    for (const visual of this.visuals.values()) destroyVisual(visual);
    this.visuals.clear();
  }
}

const EMPTY_LANES: ReadonlySet<number> = new Set();

/** At the bay, nose pointed at the road. Loading is not a position on the run, it precedes it. */
const PARKED = { away: 0, heading: 1 } as const;

/**
 * Everything a truck needs to know about the shed it came out of.
 *
 * IT TAKES TWO LOOKUPS AND THAT IS NOT A MISTAKE. `DepotView` carries the round-trip clock
 * and where the shed stands; `MachineView` carries how TALL its footprint is, which is what
 * decides how many rows the truck may leave down. Neither projection has both, they are keyed
 * by the same machine id, and gathering them here means the drawing loop never has to know
 * that the depot is published twice.
 */
interface DepotFacts {
  readonly id: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly tilesHigh: number;
  readonly runTicks: number;
}

/**
 * The depot a contract belongs to, or null when it has been deconstructed under the run.
 *
 * BY ID RATHER THAN "the first depot", which is `ceremony.ts`'s `locateDepartingDepot`
 * lesson: `contract.depotId` names its own shed, a lot can hold several, and item 131 already
 * established that the empties come home to the one the route was signed at. A truck rolling
 * out of the wrong yard is a teleport.
 */
function findDepot(view: WorldView, depotId: number): DepotFacts | null {
  const depots = view.commerce.depots;
  for (let i = 0; i < depots.length; i++) {
    const depot = depots[i]!;
    if (depot.id !== depotId) continue;
    return {
      id: depotId,
      tileX: depot.tileX,
      tileY: depot.tileY,
      tilesHigh: footprintHeight(view, depotId),
      runTicks: depot.runTicks,
    };
  }
  return null;
}

/** The depot's footprint height, or one row if this build has never heard of that machine. */
function footprintHeight(view: WorldView, depotId: number): number {
  for (let i = 0; i < view.machines.length; i++) {
    const machine = view.machines[i]!;
    if (machine.id === depotId && machine.kind === MachineKind.TruckDepot) return machine.tilesHigh;
  }
  return 1;
}

/**
 * Pick this run's lane and work out where the two ends of it are, in world pixels.
 *
 * A DEPOT FLUSH AGAINST THE WEST EDGE STILL WORKS, which `ceremony.ts:501` flagged as the
 * hazard here — its own departure trail admits that such a depot "gets a trail of nothing".
 * This one does not: `homeX` is clamped so the parked truck is fully on the lot however far
 * west the shed is, and `awayX` is fixed at one full truck-length past the world's edge, so
 * the shortest possible run is still two tiles of visible pulling-out and leaving. The truck
 * departs; it just has less road to do it on.
 */
function planRoute(view: WorldView, depot: DepotFacts, taken: ReadonlySet<number>): TruckRoute {
  const laneY = chooseLane(
    depot.tileY,
    depot.tilesHigh,
    (row) => blockedWestOf(view, depot, row),
    taken,
  );
  const homeX = Math.max(TRUCK_HALF_W, depot.tileX * TILE_PX - TRUCK_HALF_W);
  return { laneY, homeX, awayX: -TRUCK_HALF_W };
}

/**
 * How many machine tiles sit between this row and the road, west of the depot.
 *
 * The depot itself is skipped — a truck leaving its own shed is not driving through it — and
 * so is anything east of the depot, which is not on the route. Belts and pipes are NOT
 * counted: a lorry crossing a conveyor reads as a farm track crossing a line, and the item's
 * constraint was machines. Counting belts would send every truck on a lot with a factory in
 * it out through the top row for no gain.
 */
function blockedWestOf(view: WorldView, depot: DepotFacts, row: number): number {
  let blocked = 0;
  for (let i = 0; i < view.machines.length; i++) {
    const machine = view.machines[i]!;
    if (machine.id === depot.id) continue;
    if (row < machine.tileY || row >= machine.tileY + machine.tilesHigh) continue;
    // Its whole footprint has to be west of the depot's west face to be in the way. A machine
    // that merely starts west of it and reaches under the yard is still in the way, which is
    // why this tests the LEFT edge.
    if (machine.tileX >= depot.tileX) continue;
    const spanEast = Math.min(machine.tileX + machine.tilesWide, depot.tileX);
    blocked += Math.max(0, spanEast - machine.tileX);
  }
  return blocked;
}

function destroyVisual(visual: TruckVisual): void {
  visual.body.destroy();
  visual.cargo.destroy();
}
