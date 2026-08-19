// Where a delivery truck is, as arithmetic ([[132]]).
//
// Kept OUT of `./trucks` for the reason `strips.ts` and `grabber-swing.ts` are kept out of
// their own drawing modules: importing anything that reaches `./textures` drags the generated
// atlas manifest in through the `@/` alias, which vitest does not resolve. Everything in this
// file is a number in, a number out — which is exactly the part of a truck run that can be
// wrong without anybody noticing, because "the truck was somewhere" looks the same as "the
// truck was in the right place" until you watch a whole run.
//
// ── NOTHING HERE IS STATE THE SIM CAN SEE (§12) ─────────────────────────────────────────
//
// The sim publishes `phase`, `ticksRemaining` and the depot's `runTicks` and that is the
// whole input. The chosen lane is renderer-local, write-only memory: it is picked once at
// departure, remembered until the run ends, and never read back, never persisted, never
// hashed. A reload mid-run picks a lane again from the same published facts and the truck
// carries on from wherever the clock says it is — no interpolation state to prime, no
// position to restore.
//
// ── THE ROAD IS THE LOT'S WEST EDGE, AND THAT IS THE SIM'S OWN FACT ─────────────────────
//
// `ROAD_EDGE_TILE_X` is 0 and `runTicksFor` charges ten ticks per tile between a depot and
// it, so "how long is this run" already encodes "how far west do I have to drive". The
// ceremony's departure trail (`ceremony.ts`) runs west for the same reason. A truck that
// drove east would be driving away from the only road this game has.

/**
 * A chosen run, in world pixels. Picked once when a contract starts loading and held for the
 * length of that run.
 *
 * `homeX` is where the truck sits while it loads and where it must be again the instant the
 * run completes; `awayX` is far enough west that the sprite is entirely off the lot.
 */
export interface TruckRoute {
  /** Tile row it drives along. Also the row it parks in — the run is due west, never a dogleg. */
  readonly laneY: number;
  /** Sprite centre x, parked at the depot's west face. */
  readonly homeX: number;
  /** Sprite centre x once it is completely past the world's west edge. */
  readonly awayX: number;
}

/**
 * How far a truck gets through its run, 0 at the depot and 1 back at the depot.
 *
 * `alpha` is the frame's fraction through the current tick — the same one the player and the
 * bots interpolate on. `ticksRemaining` is an integer that drops once per tick, so without it
 * a truck at speed would visibly step three frames at a time at 60Hz.
 *
 * Clamped at both ends because the projection is read on frames the sim has not stepped: a
 * frame that lands after the last tick of a run has `ticksRemaining` 0 and a positive alpha,
 * which unclamped would drive the truck one frame PAST home on the last frame of the journey.
 */
export function runElapsed(ticksRemaining: number, runTicks: number, alpha: number): number {
  if (runTicks <= 0) return 1;
  const smooth = ticksRemaining - alpha;
  const elapsed = (runTicks - smooth) / runTicks;
  return elapsed < 0 ? 0 : elapsed > 1 ? 1 : elapsed;
}

/** Where the truck is on its run, and which way it is pointing. */
export interface TruckAt {
  /** 0 parked at the depot, 1 fully off the lot's west edge. */
  readonly away: number;
  /** 1 while heading out (loaded), -1 while coming back (empty). */
  readonly heading: 1 | -1;
}

/**
 * How far from home the truck is, 0 parked and 1 fully off the lot — and which way it faces.
 *
 * ── OUT FOR THE FIRST HALF, BACK FOR THE SECOND, WITH THE MIDDLE SPENT OFF THE MAP ──────
 *
 * `runTicks` is a full ROUND TRIP, so the halves are the outbound and the return and the
 * truck is home exactly as the clock hits zero. That much is the item's ruling and it needs
 * no extra state.
 *
 * What is NOT linear is the speed. A depot two tiles from the road has the same 45-second
 * base run as one on the far parcel, so mapping the first half linearly onto two tiles would
 * have the truck creep those two tiles over twenty-two seconds — a lorry moving at a third of
 * walking pace, which reads as broken rather than as distant. Instead it drives at a fixed
 * speed until it is off the lot, waits out the middle of the run where the game cannot see
 * it, and comes back at the same speed arriving dead on time.
 *
 * That is not a cheat around the fiction, it IS the fiction: `commerce.ts` says outright that
 * *"the journey happens off the map"* and there is no path across the lot to draw. The part
 * of the trip this game owns is leaving and coming back, and that is the part it now shows.
 *
 * ── THE TURN HAPPENS WHERE NOBODY CAN SEE IT, AND THAT IS ARITHMETIC RATHER THAN LUCK ───
 *
 * `heading` flips at the halfway mark, and the sprite mirrors when it does. The leg is capped
 * at half the run, so `away` is pinned at 1 — the truck entirely past the west edge —
 * whenever the flip is in reach. On a real lot it is not even close: the world is 64 tiles
 * wide, so the longest possible drive is 2,048px against 4,320px of half-run at cruise. The
 * cap is a guard, not a regime the game ever enters, and if it ever did the fallback is
 * exactly the plain linear out-and-back — the two readings meet rather than fight.
 */
export function truckAt(
  elapsed: number,
  runTicks: number,
  travelPx: number,
  speed: number,
): TruckAt {
  const outbound = elapsed < 0.5;
  // Fraction of the WHOLE run one leg takes at cruise, capped at the half it has to fit in.
  // `speed` and `runTicks` are both positive by construction; the guard is for a depot that
  // has been deconstructed mid-run and publishes zeroes. A degenerate run PARKS the truck
  // rather than sending it away, because "sat in the yard" is the failure a player can read.
  const legTicks = speed > 0 ? travelPx / speed : 0;
  const legFraction = runTicks > 0 && legTicks > 0 ? Math.min(0.5, legTicks / runTicks) : 0;
  if (legFraction <= 0) return { away: 0, heading: outbound ? 1 : -1 };

  const throughLeg = outbound ? elapsed / legFraction : (1 - elapsed) / legFraction;
  const away = throughLeg < 0 ? 0 : throughLeg > 1 ? 1 : throughLeg;
  return { away, heading: outbound ? 1 : -1 };
}

/**
 * The lane a truck leaving this depot drives down, chosen once and then held.
 *
 * ── IT DOES NOT DRIVE THROUGH MACHINES, AND THAT IS THE WHOLE JOB HERE ──────────────────
 *
 * Candidates are the depot's own footprint rows first — a straight run out of the yard, which
 * is what a loading bay looks like — and then the row immediately above and below, which a
 * truck can use without ever needing a bend, because it also PARKS in the lane it will drive.
 * Each candidate is scored by how many machine tiles sit between it and the road, and fewest
 * wins. The parking spot is inside that scan, so a lane is never chosen that puts the truck
 * inside a Fryer while it loads.
 *
 * NO PATHFINDER, DELIBERATELY. `commerce.ts` refused to invent one for the sim and gave the
 * reason: a delivery that failed because somebody parked a machine in the way would be a
 * worse game than a truck that takes the clear row. This is the same refusal on the drawing
 * side — it picks a lane, it does not solve a maze, and if the whole yard is walled in it
 * takes the least-blocked row and drives it rather than refusing to leave.
 *
 * `taken` holds the lanes other trucks from this depot are using this instant, so a depot
 * running two contracts at once does not stack one lorry on top of another. It is the LAST
 * tiebreak, well below not driving through a machine: two trucks sharing a row looks busy,
 * and one driving through a Fryer looks broken.
 *
 * ── THE TWO ROWS OUTSIDE THE FOOTPRINT ARE THE ONLY ONES THAT CAN LEAVE THE MAP ─────────
 *
 * `worldTilesHigh` is here because the row above and the row below are offered blind, and a
 * depot built on row 0 offers row -1. That row scores whatever `westwardBlocked` says about
 * a row that does not exist — zero, since no machine occupies it — so it does not merely tie
 * with a walled-in yard, it BEATS one, and the truck drives its whole run along the outside
 * of the world. Off-map rows are therefore dropped before scoring rather than penalised
 * afterwards: a lane off the map is not a worse lane, it is not a lane.
 *
 * The bound is the world's, not the player's owned parcels. A truck crossing land the player
 * has not bought yet is fine — it is driving to a road at the lot's west edge, past parcels
 * that are scenery either way — and the failure being fixed here is leaving the map, not
 * trespassing.
 */
export function chooseLane(
  tileY: number,
  tilesHigh: number,
  westwardBlocked: (laneY: number) => number,
  taken: ReadonlySet<number>,
  worldTilesHigh: number,
): number {
  const high = Math.max(1, tilesHigh);
  const rows: number[] = [];
  const offer = (row: number): void => {
    if (row >= 0 && row < worldTilesHigh) rows.push(row);
  };
  // Footprint rows first, then above, then below — candidate order IS the last tiebreak.
  for (let i = 0; i < high; i++) offer(tileY + i);
  offer(tileY - 1);
  offer(tileY + high);

  // A depot standing on the map has at least its own top row to offer, so this is unreachable
  // from any lot a player can build. It is here for a projection that publishes a zero-height
  // world — the same degenerate-input courtesy `truckAt` extends to a depot with no clock.
  if (rows.length === 0) return tileY;

  let best = rows[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestTaken = true;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const score = westwardBlocked(row);
    const isTaken = taken.has(row);
    // Blockers first, then an unshared lane, then candidate order — which puts the depot's
    // own rows ahead of the two outside it, so a clear yard needs no reason to leave it.
    if (score < bestScore || (score === bestScore && bestTaken && !isTaken)) {
      best = row;
      bestScore = score;
      bestTaken = isTaken;
    }
  }
  return best;
}
