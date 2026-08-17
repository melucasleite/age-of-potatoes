// Pipe networks, and the one-ledger flow model.
//
// ────────────────────────────────────────────────────────────────────────────────────────
// FLOW, NOT PRESSURE (plan §5). READ THIS BEFORE CHANGING ANYTHING HERE.
//
//   "Each pipe network is one ledger (supply = pump rate, demand = machine draws;
//    over-demand throttles round-robin with amber icons). One pump and one liquid per
//    network, enforced; pipes auto-tint by liquid and render gray when empty; tanks show net
//    rate and time-to-empty."
//
// There is no pressure field, no per-segment fill level, no flow direction to solve, and no
// loop to reason about. A network is a SET of pipe tiles; its supply is ONE NUMBER; its
// demands are A LIST; the tick divides one by the other. That is the entire model, and it is
// why routing a pipe is a *puzzle* — where does the pump go, how do I split the supply —
// rather than a *chore* — why is segment 41 empty. If a change here starts wanting a solver,
// the model has been misread; go back and re-read the paragraph above.
//
// ONE PUMP AND ONE LIQUID PER NETWORK, ENFORCED AT PLACEMENT. Not warned about, not resolved
// afterwards: `pipePathRefusal()` refuses the pipe that would create the situation, before it
// exists. That single rule is what kills most fluid-sim confusion, and it is the reason the
// Recirculator feeds a TANK rather than the pipes (see `data.ts`).
// ────────────────────────────────────────────────────────────────────────────────────────
//
// DETERMINISM NOTES, because this is exactly the shape of code that goes subtly wrong:
//
//   - Network ids are GEOMETRIC, not sequential: a network's id is the lowest row-major world
//     tile index among its pipes. Two players who built the same network in a different order
//     get the same ids and therefore the same hash, and an unrelated pipe laid across the map
//     cannot renumber anything.
//   - Membership is recomputed on EDIT ONLY, never per tick. A wrong incremental update is a
//     determinism bug that hides for weeks, so this does a full recompute and will keep doing
//     one until a profiler complains (plan §13: "main thread until a profiler says otherwise").
//   - Throttling rotates a stored integer offset over consumers sorted by machine id. No RNG,
//     no `for...in`, no dependence on insertion order.
//   - The pump draws only what the network can actually place, so total delivered can never
//     exceed total supplied and no water is created or destroyed inside a pipe.

import {
  MachineRole,
  type MachineSpec,
  PIPE_RR_MODULUS,
  PortFlow,
  type LiquidId,
  LiquidId as Liquids,
  WELL_MAX_PER_RESERVOIR,
  WORLD_TILES_WIDE,
  liquidSpec,
  machineSpec,
} from './data';
import {
  type Machine,
  type MachinePort,
  type Pipe,
  type PipeNetwork,
  type WorldState,
  isInsideWorld,
  isOwnedTile,
  machineAt,
  machineCoversTile,
  worldTileKey,
} from './state';
import {
  effectivePortCapacityMl,
  effectivePumpRateMlPerMinute,
  effectiveTankCapacityMl,
} from './upgrades';
import { TICKS_PER_MINUTE, divFloor } from './units';
import {
  WaterDraw,
  pumpSupplyMlPerMinute,
  reservoirAdjacentToTile,
  reservoirRechargeMlPerMinute,
  takeWater,
  wellsOnReservoir,
} from './water';

/** One tile of a drag-routed pipe run. A run is one command; see `commands.ts`. */
export interface TilePoint {
  x: number;
  y: number;
}

/**
 * Why a build was refused, as an integer the HUD turns into stall text ON THE OBJECT rather
 * than in a menu (plan §5: "nothing invisible"). The sim never formats a string; it says
 * which rule stopped it and the renderer says it in English.
 */
export const BuildRefusal = {
  None: 0,
  OutsideWorld: 1,
  /**
   * The field is for crops. Belts and arms are refused by it, and machines are unless they are
   * `fieldPlaceable`.
   *
   * **NO LONGER REACHABLE FROM `pipePathRefusal`** (item 120): plumbing is overhead, so a run
   * crosses farmland without asking. The code stays because two other verbs still speak it and
   * because a refusal code is API the HUD reads — renumbering one would silently re-caption a
   * saved trace.
   */
  OnField: 2,
  Occupied: 3,
  /** Not a contiguous, non-repeating run of legal length. */
  BadPath: 4,
  /** This run would join two different liquids. Plan §5: one liquid per network. */
  LiquidMismatch: 5,
  /** This would put two pumps on one network. Plan §5: one pump per network. */
  TwoPumpsOneNetwork: 6,
  /** A pump has to stand on the bank of a reservoir. */
  NoWaterSource: 7,
  Unaffordable: 8,
  /** The tech node that makes this legal is not researched. */
  Locked: 9,
  /**
   * This run would present a liquid to a machine that has no port for it.
   *
   * THE SAME RULE AS `LiquidMismatch`, ONE STEP FURTHER IN. That one keeps two liquids from
   * meeting in a pipe; this one keeps the wrong liquid from meeting a machine. Plan §5 puts
   * typed ports at the centre of the whole layer — "they meet only inside machines with typed
   * ports" — and a port that could be fed anything is not typed. Dragging carbonated water into
   * the Syrup Mixer is refused while the player is still dragging, on the object, exactly as a
   * two-pump network is.
   *
   * Machines with no ports at all — every belt machine — are invisible to this rule, so a water
   * main may still run past a Fryer.
   */
  PortMismatch: 10,
  /**
   * This is on land the player has not bought the deed to (plan §5).
   *
   * A SEPARATE CODE FROM `OutsideWorld`, and the difference is the whole feature. Outside the
   * world is nowhere — there is nothing there and there never will be. Unowned land is a real
   * place with a price on it, standing in the world where the player can read it, and the
   * sentence the renderer prints for this code is an offer rather than a wall.
   */
  Unowned: 11,
  /**
   * This reservoir already has `WELL_MAX_PER_RESERVOIR` Artesian Wells on its bank (item 130).
   *
   * THE SAME SHAPE AS `TwoPumpsOneNetwork`, AND FOR THE SAME REASON: a cap that is checked while
   * the ghost is still under the cursor is a rule the player learns by being told; a cap
   * enforced afterwards is a purchase they have to undo. What is on the far side of this refusal
   * is not a wall — it is the Irrigation Hub, which needs 28× less water than the dumb heads
   * that got them here. See `WELL_MAX_PER_RESERVOIR` for why the ladder needs a ceiling at all.
   */
  WellLimit: 12,
} as const;

export type BuildRefusal = (typeof BuildRefusal)[keyof typeof BuildRefusal];

/**
 * Row-major world tile index. The basis of every network id — see the header.
 *
 * The same formula as `state.ts`'s `worldTileKey` (format 13 made the key a state-wide
 * concept — the field collection and the soil ledger both sort by it), kept as a delegating
 * alias here because network ids were speaking it first and the export is API surface.
 */
export function worldTileIndex(tileX: number, tileY: number): number {
  return worldTileKey(tileX, tileY);
}

export function pipeAt(state: WorldState, tileX: number, tileY: number): Pipe | null {
  for (let i = 0; i < state.pipes.length; i++) {
    const pipe = state.pipes[i]!;
    if (pipe.tileX === tileX && pipe.tileY === tileY) return pipe;
  }
  return null;
}

export function networkById(state: WorldState, id: number): PipeNetwork | null {
  for (let i = 0; i < state.networks.length; i++) {
    const network = state.networks[i]!;
    if (network.id === id) return network;
  }
  return null;
}

function createNetwork(id: number, liquid: LiquidId): PipeNetwork {
  return {
    id,
    liquid,
    supplyAccum: 0,
    rrOffset: 0,
    supplyMl: 0,
    demandMl: 0,
    deliveredMl: 0,
  };
}

// --- placement rules ------------------------------------------------------------------

/**
 * Whether a pipe run may be laid, and if not, why.
 *
 * PURE, AND CALLED FROM BOTH SIDES: the reducer uses it to accept or reject `PlacePipe`, and
 * the renderer uses it to colour the ghost and print the reason while the player is still
 * dragging. Writing the rule once is what makes "refused before it happens" true rather than
 * aspirational — a rule the preview and the reducer each implement separately is a rule that
 * eventually disagrees with itself.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * **PLUMBING IS A LAYER ABOVE THE GROUND** (item 120, owner ask 2026-08-17). A run may cross
 * ground, farmland, a zone, a belt, an arm and open water. Only two things refuse it, and both
 * are about the pipe rather than about the ground:
 *
 *   - **ANOTHER PIPE.** There is one overhead, not a stack of them. Unchanged.
 *   - **A MACHINE FOOTPRINT.** Machines meet plumbing through TYPED PORTS on their footprint,
 *     and item 101's liquid inference reads the machines a run touches to decide what it
 *     carries. A pipe lying on top of a Syrup Mixer makes "which port is this?" a question
 *     with no answer, so the footprint stays sacred. This is the one refusal that got
 *     *stricter* in wording and identical in effect: it used to arrive via `tileOccupied`.
 *
 * **A RESERVOIR IS CROSSED, NOT OCCUPIED.** An aqueduct over the pond is the most literal
 * reading of "overhead" there is, and nothing draws from a pipe tile: an intake is the PUMP's
 * adjacency rule (`liquidPlacementRefusal` → `reservoirAdjacentToTile`), which asks about the
 * pump's own footprint and is untouched by this. Water stays unwalkable — item 080 blocks the
 * footstep on `reservoirAt`, not on what is above it — so a pipe is not a bridge. The argument
 * for refusing, rejected: keeping the pond clear would preserve the bank as a contested build
 * surface. It would also make the pond the ONE terrain a pipe may not cross, and a rule with an
 * exception in it is where this codebase keeps finding its bugs.
 *
 * **A GRABBER IS CROSSED TOO, AND ITS SWING ARC IS COSMETICS.** Item 094 gave arms a real arc
 * that sweeps overhead, and no sim rule reads it: `grabberSource` and `grabberDeliver` look at
 * the four neighbouring TILES, never at a swept volume. The arc lives in the renderer as a read
 * of `WorldView` (§12), so a legality rule that consulted it would be the renderer feeding back
 * into the sim — which is exactly the seam §12 forbids. An arm passing under a pipe is a
 * drawing problem, and the layer order is the tool for it.
 * ────────────────────────────────────────────────────────────────────────────────────────
 */
export function pipePathRefusal(
  state: WorldState,
  path: readonly TilePoint[],
  liquid: LiquidId,
  maxTiles: number,
): BuildRefusal {
  if (liquid === Liquids.None || liquidSpec(liquid) === null) return BuildRefusal.BadPath;
  if (path.length < 1 || path.length > maxTiles) return BuildRefusal.BadPath;

  for (let i = 0; i < path.length; i++) {
    const node = path[i]!;
    if (!Number.isInteger(node.x) || !Number.isInteger(node.y)) return BuildRefusal.BadPath;
    if (!isInsideWorld(node.x, node.y)) return BuildRefusal.OutsideWorld;
    // Before every other rule about the tile, because "you do not own this" outranks "something
    // is on it" — a pipe dragged across the neighbour's grass is refused for the reason the
    // player can act on, and the price is standing right there.
    if (!isOwnedTile(state, node.x, node.y)) return BuildRefusal.Unowned;
    // **THE OVERHEAD LAYER, AND THESE TWO LINES ARE ALL OF IT** (item 120). Everything a pipe
    // used to be refused by — farmland, a zone, a belt, an arm, open water — it now passes over,
    // because plumbing is above the ground rather than on it. What is left is the pair of rules
    // that are about the pipe itself rather than about the ground: two pipes cannot share a tile
    // (there is only one overhead), and a machine footprint is sacred. See the header note below.
    if (pipeAt(state, node.x, node.y) !== null) return BuildRefusal.Occupied;
    if (machineAt(state, node.x, node.y) !== null) return BuildRefusal.Occupied;

    if (i > 0) {
      const previous = path[i - 1]!;
      const dx = node.x - previous.x;
      const dy = node.y - previous.y;
      const step = (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy);
      // Orthogonal, one tile at a time. A drag that jumps is a dropped pointer event, not a
      // pipe, and quietly bridging the gap would put pipe on tiles nobody dragged over.
      if (step !== 1) return BuildRefusal.BadPath;
    }

    // A run that crosses itself would place two pipes on one tile.
    for (let j = 0; j < i; j++) {
      const earlier = path[j]!;
      if (earlier.x === node.x && earlier.y === node.y) return BuildRefusal.BadPath;
    }
  }

  // What would this run be joined to? Every network it touches, plus every pump it touches,
  // plus every pump already sitting on one of those networks.
  const joinedNetworks: number[] = [];
  const joinedPumps: number[] = [];

  for (let i = 0; i < path.length; i++) {
    const node = path[i]!;
    for (let n = 0; n < 4; n++) {
      const nx = node.x + NEIGHBOUR_DX[n]!;
      const ny = node.y + NEIGHBOUR_DY[n]!;

      const neighbour = pipeAt(state, nx, ny);
      if (neighbour !== null) {
        // TWO LIQUIDS NEVER MEET. This is the refusal, not a mixing rule.
        if (neighbour.liquid !== liquid) return BuildRefusal.LiquidMismatch;
        pushUnique(joinedNetworks, neighbour.network);
      }

      const machine = machineAt(state, nx, ny);
      if (machine !== null) {
        if (isPump(machine)) pushUnique(joinedPumps, machine.id);
        // TYPED PORTS, ENFORCED AT THE PORT. A machine that has ports at all only accepts what
        // its ports declare; everything else is refused here rather than attached and ignored.
        if (machineHasPorts(machine) && !machineAcceptsLiquid(machine, liquid)) {
          return BuildRefusal.PortMismatch;
        }
      }
    }
  }

  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    if (!isPump(machine)) continue;
    if (machine.network !== 0 && joinedNetworks.includes(machine.network)) {
      pushUnique(joinedPumps, machine.id);
    }
  }

  if (joinedPumps.length > 1) return BuildRefusal.TwoPumpsOneNetwork;
  return BuildRefusal.None;
}

/**
 * Whether a machine may go here, for the reasons the liquid layer adds on top of the ordinary
 * footprint check. Returns `None` for machines that have nothing to do with liquids.
 */
export function liquidPlacementRefusal(
  state: WorldState,
  kind: number,
  tileX: number,
  tileY: number,
): BuildRefusal {
  const spec = machineSpec(kind as never);
  if (spec === null) return BuildRefusal.None;

  // THE ARTESIAN WELL STANDS ON THE BANK TOO, AND IS COUNTED THERE (item 130). It is not a
  // pump — no network, no liquid, no ledger — so it shares only the adjacency rule, and it adds
  // one of its own: a reservoir takes `WELL_MAX_PER_RESERVOIR` and no more.
  if (spec.role === MachineRole.Well) {
    const reservoir = reservoirAdjacentToTile(state, tileX, tileY);
    if (reservoir === null) return BuildRefusal.NoWaterSource;
    if (wellsOnReservoir(state, reservoir) >= WELL_MAX_PER_RESERVOIR) return BuildRefusal.WellLimit;
    return BuildRefusal.None;
  }

  if (spec.role === MachineRole.Pump) {
    // A pump stands on the bank. Wells buy placement freedom and are a later purchase.
    if (reservoirAdjacentToTile(state, tileX, tileY) === null) return BuildRefusal.NoWaterSource;

    // And it may not land on a network that already has one.
    const touched: number[] = [];
    for (let dy = 0; dy < spec.tilesHigh; dy++) {
      for (let dx = 0; dx < spec.tilesWide; dx++) {
        for (let n = 0; n < 4; n++) {
          const nx = tileX + dx + NEIGHBOUR_DX[n]!;
          const ny = tileY + dy + NEIGHBOUR_DY[n]!;
          const neighbour = pipeAt(state, nx, ny);
          if (neighbour !== null) pushUnique(touched, neighbour.network);
        }
      }
    }
    for (let i = 0; i < state.machines.length; i++) {
      const machine = state.machines[i]!;
      if (!isPump(machine)) continue;
      if (machine.network !== 0 && touched.includes(machine.network)) {
        return BuildRefusal.TwoPumpsOneNetwork;
      }
    }
  }

  // THE PORT RULE, FROM THE MACHINE'S SIDE. `pipePathRefusal` stops a pipe being dragged into
  // the wrong machine; this stops the same mistake made in the other order — dropping a
  // Carbonator onto a syrup main. The rule has to hold from both ends or it does not hold.
  if (spec.liquid !== Liquids.None || spec.ports.length > 0) {
    for (let dy = 0; dy < spec.tilesHigh; dy++) {
      for (let dx = 0; dx < spec.tilesWide; dx++) {
        for (let n = 0; n < 4; n++) {
          const neighbour = pipeAt(
            state,
            tileX + dx + NEIGHBOUR_DX[n]!,
            tileY + dy + NEIGHBOUR_DY[n]!,
          );
          if (neighbour === null) continue;
          if (specAcceptsLiquid(spec, neighbour.liquid)) continue;
          return BuildRefusal.PortMismatch;
        }
      }
    }
  }

  return BuildRefusal.None;
}

function isPump(machine: Machine): boolean {
  const spec = machineSpec(machine.kind);
  return spec !== null && spec.role === MachineRole.Pump;
}

/** Whether this machine is plumbed at all — a single utility port, or a converter's list. */
function machineHasPorts(machine: Machine): boolean {
  const spec = machineSpec(machine.kind);
  if (spec === null) return false;
  return spec.liquid !== Liquids.None || spec.ports.length > 0;
}

/**
 * Whether any of a machine's ports accepts this liquid.
 *
 * ONE FUNCTION, BOTH DIRECTIONS: it answers "may this pipe touch that machine" for a pipe being
 * laid and "may this machine land beside that pipe" for a machine being placed. Two
 * implementations of the same question is how a preview ends up disagreeing with a reducer.
 */
function machineAcceptsLiquid(machine: Machine, liquid: LiquidId): boolean {
  const spec = machineSpec(machine.kind);
  return spec !== null && specAcceptsLiquid(spec, liquid);
}

function specAcceptsLiquid(spec: MachineSpec, liquid: LiquidId): boolean {
  if (spec.liquid === liquid) return true;
  for (let i = 0; i < spec.ports.length; i++) {
    if (spec.ports[i]!.liquid === liquid) return true;
  }
  return false;
}

function pushUnique(list: number[], value: number): void {
  for (let i = 0; i < list.length; i++) {
    if (list[i] === value) return;
  }
  list.push(value);
}

const NEIGHBOUR_DX: readonly number[] = [0, 1, 0, -1];
const NEIGHBOUR_DY: readonly number[] = [-1, 0, 1, 0];

// --- membership -----------------------------------------------------------------------

/**
 * Recompute every network from scratch. CALLED ON EDIT ONLY — never from the tick.
 *
 * Full recompute rather than an incremental patch, on purpose: a network is at most a few
 * hundred tiles, an edit happens when a human clicks, and an incremental update that is
 * wrong once produces a world that diverges silently. When a profiler says this is hot, cache
 * it — not before.
 */
export function rebuildNetworks(state: WorldState): void {
  const byTile = new Map<number, Pipe>();
  const indices: number[] = [];
  for (let i = 0; i < state.pipes.length; i++) {
    const pipe = state.pipes[i]!;
    const index = worldTileIndex(pipe.tileX, pipe.tileY);
    byTile.set(index, pipe);
    indices.push(index);
  }
  // Ascending tile order, so the first tile of each component IS the component's minimum —
  // which is the component's id. Sorting integers with a numeric comparator, never the
  // default lexicographic one.
  indices.sort((a, b) => a - b);

  const assigned = new Map<number, number>();
  const order: number[] = [];
  const liquids = new Map<number, LiquidId>();

  for (let i = 0; i < indices.length; i++) {
    const start = indices[i]!;
    if (assigned.has(start)) continue;

    const startPipe = byTile.get(start)!;
    const liquid = startPipe.liquid;
    order.push(start);
    liquids.set(start, liquid);

    const stack: number[] = [start];
    assigned.set(start, start);
    while (stack.length > 0) {
      const current = stack.pop()!;
      const pipe = byTile.get(current)!;
      for (let n = 0; n < 4; n++) {
        const nx = pipe.tileX + NEIGHBOUR_DX[n]!;
        const ny = pipe.tileY + NEIGHBOUR_DY[n]!;
        if (!isInsideWorld(nx, ny)) continue;
        const neighbourIndex = worldTileIndex(nx, ny);
        if (assigned.has(neighbourIndex)) continue;
        const neighbour = byTile.get(neighbourIndex);
        if (neighbour === undefined) continue;
        // Same liquid only. Placement already forbids the mixed case; this is the belt and
        // braces that keeps a hand-edited save from producing a two-liquid network.
        if (neighbour.liquid !== liquid) continue;
        assigned.set(neighbourIndex, start);
        stack.push(neighbourIndex);
      }
    }
  }

  for (let i = 0; i < state.pipes.length; i++) {
    const pipe = state.pipes[i]!;
    pipe.network = assigned.get(worldTileIndex(pipe.tileX, pipe.tileY)) ?? 0;
  }

  // Carry the accumulator and the rotation across a rebuild for every network whose id
  // survived, so laying one more tile at the far end of a run does not reset its fairness
  // bookkeeping. `order` is ascending, so `state.networks` stays sorted by id.
  const previous = state.networks;
  const next: PipeNetwork[] = [];
  for (let i = 0; i < order.length; i++) {
    const id = order[i]!;
    const liquid = liquids.get(id) ?? Liquids.None;
    let carried: PipeNetwork | null = null;
    for (let j = 0; j < previous.length; j++) {
      const candidate = previous[j]!;
      if (candidate.id === id && candidate.liquid === liquid) {
        carried = candidate;
        break;
      }
    }
    if (carried === null) {
      next.push(createNetwork(id, liquid));
    } else {
      carried.supplyMl = 0;
      carried.demandMl = 0;
      carried.deliveredMl = 0;
      next.push(carried);
    }
  }
  state.networks = next;

  attachMachines(state, assigned);
}

/**
 * Point every machine at the network it touches, or 0.
 *
 * A machine that touches two networks joins the LOWER-NUMBERED one. Plan §5 allows one pump
 * per network, not one network per machine, so straddling is legal; picking a side by a total
 * order is what keeps the ledger a division rather than an argument.
 */
function attachMachines(state: WorldState, assigned: Map<number, number>): void {
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    const spec = machineSpec(machine.kind);
    if (spec === null) {
      machine.network = 0;
      continue;
    }

    // Each port finds its own network, and finds ONLY a network carrying its own liquid. That
    // is the port typing doing its second job: placement refuses the mistake, and membership
    // refuses to make sense of it anyway if a hand-edited save ever presents one.
    for (let p = 0; p < machine.ports.length; p++) {
      const portSpec = spec.ports[p];
      machine.ports[p]!.network =
        portSpec === undefined
          ? 0
          : lowestAdjacentNetwork(state, machine, spec, assigned, portSpec.liquid);
    }

    if (spec.liquid === Liquids.None) {
      machine.network = 0;
    } else if (machine.ports.length > 0) {
      // A converter's headline network is its first port's, which is the one the renderer
      // highlights and the one its status ribbon names. The ledger never reads it.
      machine.network = machine.ports[0]!.network;
    } else {
      machine.network = lowestAdjacentNetwork(state, machine, spec, assigned, spec.liquid);
    }
  }
}

/**
 * The lowest-numbered network of a given liquid touching a machine's footprint, or 0.
 *
 * A machine that touches two networks joins the LOWER-NUMBERED one (plan §5 allows one pump per
 * network, not one network per machine), and picking by a total order is what keeps the ledger
 * a division rather than an argument. The liquid filter is new with the soda line and it can
 * only ever *reduce* the candidates, so a water-only world attaches exactly as it always did.
 */
function lowestAdjacentNetwork(
  state: WorldState,
  machine: Machine,
  spec: MachineSpec,
  assigned: Map<number, number>,
  liquid: LiquidId,
): number {
  if (liquid === Liquids.None) return 0;
  let best = 0;
  for (let dy = 0; dy < spec.tilesHigh; dy++) {
    for (let dx = 0; dx < spec.tilesWide; dx++) {
      for (let n = 0; n < 4; n++) {
        const nx = machine.tileX + dx + NEIGHBOUR_DX[n]!;
        const ny = machine.tileY + dy + NEIGHBOUR_DY[n]!;
        if (!isInsideWorld(nx, ny)) continue;
        if (machineCoversTile(machine, nx, ny)) continue;
        const pipe = pipeAt(state, nx, ny);
        if (pipe === null || pipe.liquid !== liquid) continue;
        const network = assigned.get(worldTileIndex(nx, ny));
        if (network === undefined) continue;
        if (best === 0 || network < best) best = network;
      }
    }
  }
  return best;
}

// --- the ledger tick --------------------------------------------------------------------

/**
 * One tick of every network's ledger, in ascending network id order.
 *
 * Runs BEFORE machines in `step()`, so a head filled this tick can pour on the same tick and
 * a player watching a pipe fill sees the sprinkler answer immediately rather than 50 ms late.
 */
export function advancePipes(state: WorldState): void {
  // Last tick's readouts are stale the moment this starts. Clearing them here rather than
  // per network means a machine that fell off its network still reads zero.
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    const spec = machineSpec(machine.kind);
    if (spec === null || spec.liquid === Liquids.None) continue;
    machine.flowMlPerMinute = 0;
    machine.throttled = false;
    for (let p = 0; p < machine.ports.length; p++) {
      const port = machine.ports[p]!;
      port.flowMlPerMinute = 0;
      port.throttled = false;
    }
  }

  for (let i = 0; i < state.networks.length; i++) {
    advanceNetwork(state, state.networks[i]!);
  }
}

/**
 * One consumer or one source on a network: a machine, and which of its buffers is involved.
 *
 * `port === null` means the machine's own single utility port — the `tankMl` a head pours from
 * and a hand refills. A non-null port is one line of a converter's `ports` list. Everything
 * below the collection loop works on these refs and never asks which kind it has, which is what
 * keeps the round-robin, the shortfall, and the surplus one implementation each.
 */
interface PortRef {
  machine: Machine;
  port: MachinePort | null;
  /** Effective buffer size, after the Capacity dial. */
  capacityMl: number;
}

function refMl(ref: PortRef): number {
  return ref.port === null ? ref.machine.tankMl : ref.port.ml;
}

function addRefMl(ref: PortRef, amount: number): void {
  if (ref.port === null) ref.machine.tankMl += amount;
  else ref.port.ml += amount;
}

function addRefFlow(ref: PortRef, mlPerMinute: number): void {
  if (ref.port === null) ref.machine.flowMlPerMinute += mlPerMinute;
  else ref.port.flowMlPerMinute += mlPerMinute;
}

function setRefThrottled(ref: PortRef, throttled: boolean): void {
  if (ref.port === null) ref.machine.throttled = throttled;
  else ref.port.throttled = throttled;
  // A converter with one starved port is a starved converter. The per-port flag says WHICH
  // inlet is short; the machine-level flag is what the lamp and the ribbon already read.
  if (throttled && ref.port !== null) ref.machine.throttled = true;
}

/** Scratch arrays, rebuilt per network. Locals, never module state — see the header. */
function advanceNetwork(state: WorldState, network: PipeNetwork): void {
  network.supplyMl = 0;
  network.demandMl = 0;
  network.deliveredMl = 0;

  const heads: PortRef[] = [];
  const wants: number[] = [];
  const tanks: PortRef[] = [];
  /**
   * Outlet ports: a converter's finished liquid, waiting for someone to draw it.
   *
   * THEY ARE TANKS THAT FILL THEMSELVES, AND THEY ARE NOT PUMPS. A juice network has no pump on
   * it at all — plan §5's "one pump per network" is not stretched here, it is unspent. The
   * Recirculator set this precedent a release early: a producer pours into a tank, never into
   * the pipes, because a second *source* on a pumped network would turn the ledger into a
   * solver. A source list plus a demand list is still one division.
   */
  const sources: PortRef[] = [];
  let pump: Machine | null = null;

  // `state.machines` is kept sorted by id, so these lists come out in id order for free —
  // which is exactly the total order the round-robin rotates over. Ports within a machine
  // follow their spec order, which is likewise fixed.
  for (let i = 0; i < state.machines.length; i++) {
    const machine = state.machines[i]!;
    const spec = machineSpec(machine.kind);
    if (spec === null) continue;

    if (
      machine.network === network.id &&
      spec.liquid === network.liquid &&
      spec.ports.length === 0
    ) {
      if (spec.role === MachineRole.Pump) {
        // One pump per network is enforced at placement; the lowest id wins if a hand-edited
        // save ever presents two, so behaviour stays defined rather than merely unlikely.
        if (pump === null) pump = machine;
      } else if (spec.role === MachineRole.Tank) {
        tanks.push({ machine, port: null, capacityMl: effectiveTankCapacityMl(spec, machine) });
      } else if (spec.role === MachineRole.PipedSprinkler) {
        const capacityMl = effectiveTankCapacityMl(spec, machine);
        const room = capacityMl - machine.tankMl;
        const want = room < spec.intakeMlPerTick ? room : spec.intakeMlPerTick;
        heads.push({ machine, port: null, capacityMl });
        wants.push(want > 0 ? want : 0);
      }
    }

    for (let p = 0; p < machine.ports.length; p++) {
      const port = machine.ports[p]!;
      const portSpec = spec.ports[p];
      if (portSpec === undefined) continue;
      if (port.network !== network.id || portSpec.liquid !== network.liquid) continue;

      const capacityMl = effectivePortCapacityMl(portSpec, machine);
      const ref: PortRef = { machine, port, capacityMl };
      if (portSpec.flow === PortFlow.Outlet) {
        sources.push(ref);
      } else {
        const room = capacityMl - port.ml;
        const want = room < portSpec.intakeMlPerTick ? room : portSpec.intakeMlPerTick;
        heads.push(ref);
        wants.push(want > 0 ? want : 0);
      }
    }
  }

  // --- supply: the pump's rate, capped by what its source can actually give ---
  let capacityMl = 0;
  let source = null;
  if (pump === null) {
    // No pump means no supply, and no banked supply either — a network cannot save up while
    // its pump is missing and then dump a tick's worth the moment one is placed.
    network.supplyAccum = 0;
  } else {
    const spec = machineSpec(pump.kind)!;
    source = reservoirAdjacentToTile(state, pump.tileX, pump.tileY);
    // The `Sip` band is the pond's OWN recharge (item 130): a pump at a drained-but-bored pond
    // sips at what the wells make, not at §4's bare constant.
    const ratePerMinute = pumpSupplyMlPerMinute(
      source,
      effectivePumpRateMlPerMinute(spec, pump),
      source === null ? 0 : reservoirRechargeMlPerMinute(state, source),
    );
    network.supplyAccum += ratePerMinute;
    capacityMl = divFloor(network.supplyAccum, TICKS_PER_MINUTE);
    network.supplyAccum -= capacityMl * TICKS_PER_MINUTE;
  }
  network.supplyMl = capacityMl;

  let totalDemand = 0;
  for (let i = 0; i < wants.length; i++) totalDemand += wants[i]!;
  network.demandMl = totalDemand;

  // --- draw only what this network can actually place ---
  //
  // The pump is a CAPACITY, not a forced flow. Drawing water that nowhere could hold would
  // either destroy it (a silent leak on the Dry County board) or require a hidden buffer,
  // which is a per-segment fill level by another name.
  let tankSpace = 0;
  for (let i = 0; i < tanks.length; i++) {
    const tank = tanks[i]!;
    const spec = machineSpec(tank.machine.kind)!;
    const room = tank.capacityMl - refMl(tank);
    const take = room < spec.intakeMlPerTick ? room : spec.intakeMlPerTick;
    if (take > 0) tankSpace += take;
  }

  const placeable = totalDemand + tankSpace;
  const request = capacityMl < placeable ? capacityMl : placeable;
  const drawnMl = pump === null ? 0 : takeWater(state, source, request, WaterDraw.Metered);
  if (pump !== null) pump.flowMlPerMinute = drawnMl * TICKS_PER_MINUTE;

  // --- sources, then tanks, cover the shortfall — both in id order ---
  //
  // Outlets go first because they are the point: on a juice network they are the ONLY supply,
  // and on a network that somehow has both, draining the thing that regenerates before the
  // thing that merely stores is the order that keeps the buffer for when it is needed.
  let availableMl = drawnMl;
  let remaining = totalDemand - drawnMl;
  for (let i = 0; i < sources.length && remaining > 0; i++) {
    const ref = sources[i]!;
    const held = refMl(ref);
    const take = held < remaining ? held : remaining;
    if (take <= 0) continue;
    addRefMl(ref, -take);
    addRefFlow(ref, -take * TICKS_PER_MINUTE);
    remaining -= take;
    availableMl += take;
  }
  for (let i = 0; i < tanks.length && remaining > 0; i++) {
    const tank = tanks[i]!;
    const held = refMl(tank);
    const take = held < remaining ? held : remaining;
    if (take <= 0) continue;
    addRefMl(tank, -take);
    addRefFlow(tank, -take * TICKS_PER_MINUTE);
    remaining -= take;
    availableMl += take;
  }

  // --- the division ---
  const deliveredMl = distribute(network, heads, wants, availableMl);
  network.deliveredMl = deliveredMl;

  // --- and the surplus buffers, which is what a tank is for ---
  //
  // Outlets are deliberately absent here: a source that could absorb the surplus it just
  // supplied would be a loop, and a converter's outlet fills from ITS OWN OPERATIONS or not at
  // all. They fall out anyway — an outlet's `intakeMlPerTick` is zero — but the rule is stated
  // rather than left to arithmetic.
  let surplus = availableMl - deliveredMl;
  for (let i = 0; i < tanks.length && surplus > 0; i++) {
    const tank = tanks[i]!;
    const spec = machineSpec(tank.machine.kind)!;
    const room = tank.capacityMl - refMl(tank);
    const cap = room < spec.intakeMlPerTick ? room : spec.intakeMlPerTick;
    const put = cap < surplus ? cap : surplus;
    if (put <= 0) continue;
    addRefMl(tank, put);
    addRefFlow(tank, put * TICKS_PER_MINUTE);
    surplus -= put;
  }
}

/**
 * Hand `availableMl` out to consumers, and return how much actually landed.
 *
 * When supply covers demand everybody gets what they asked for and nothing rotates. When it
 * does not, this is plan §5's ROUND-ROBIN THROTTLE: repeated equal shares until the water
 * runs out, then the last few millilitres one each starting from the network's stored
 * offset, which advances every throttled tick. The result is that a short network slows
 * *everyone* slightly rather than starving whoever happens to be first in the list — which is
 * the readable failure, and the one a player can fix by looking at the pump.
 *
 * The equal-share loop terminates in at most `n + 1` rounds: each round either satisfies at
 * least one consumer outright, or hands everyone the same share and leaves `remaining mod n`
 * behind, which makes the next share zero.
 */
function distribute(
  network: PipeNetwork,
  heads: readonly PortRef[],
  wants: readonly number[],
  availableMl: number,
): number {
  const n = heads.length;
  if (n === 0 || availableMl <= 0) return 0;

  const granted: number[] = [];
  for (let i = 0; i < n; i++) granted.push(0);

  let remaining = availableMl;
  for (let round = 0; round <= n && remaining > 0; round++) {
    let unsatisfied = 0;
    for (let i = 0; i < n; i++) {
      if (granted[i]! < wants[i]!) unsatisfied += 1;
    }
    if (unsatisfied === 0) break;

    const share = divFloor(remaining, unsatisfied);
    if (share <= 0) break;

    for (let i = 0; i < n && remaining > 0; i++) {
      const need = wants[i]! - granted[i]!;
      if (need <= 0) continue;
      const take = need < share ? need : share;
      granted[i] = granted[i]! + take;
      remaining -= take;
    }
  }

  // The tail: fewer millilitres left than there are thirsty consumers. Whoever the offset
  // points at goes first, and the offset moves on, so the extra millilitre is not a permanent
  // gift to machine #1.
  if (remaining > 0) {
    const thirsty: number[] = [];
    for (let i = 0; i < n; i++) {
      if (granted[i]! < wants[i]!) thirsty.push(i);
    }
    if (thirsty.length > 0) {
      const start = network.rrOffset % thirsty.length;
      for (let k = 0; k < thirsty.length && remaining > 0; k++) {
        const index = thirsty[(start + k) % thirsty.length]!;
        granted[index] = granted[index]! + 1;
        remaining -= 1;
      }
      network.rrOffset = (network.rrOffset + 1) % PIPE_RR_MODULUS;
    }
  }

  let delivered = 0;
  for (let i = 0; i < n; i++) {
    const ref = heads[i]!;
    const amount = granted[i]!;
    addRefMl(ref, amount);
    addRefFlow(ref, amount * TICKS_PER_MINUTE);
    // AMBER (plan §5): asked for water, got less. `LampState.Starved` is the existing amber
    // "look upstream" lamp, and upstream of a head is the pump — exactly the right place to
    // send the player. On a converter's inlet, upstream is whatever machine makes that liquid,
    // which is exactly as useful and one step further along the organ.
    setRefThrottled(ref, amount < wants[i]!);
    delivered += amount;
  }

  return delivered;
}

// --- readouts ---------------------------------------------------------------------------

/**
 * Ticks until a tank runs dry at its current net rate, or -1 when it is not emptying.
 *
 * THE SENTINEL IS THE POINT. Plan §5 puts a time-to-empty on every tank because that single
 * label is what turns fluid management from mystery into arithmetic — and a tank at break-even
 * has no time-to-empty at all, which is a different fact from "zero seconds". Returning -1
 * says so; dividing by zero says something much worse.
 */
export function tankTicksToEmpty(machine: Machine): number {
  if (machine.flowMlPerMinute >= 0) return -1;
  if (machine.tankMl <= 0) return 0;
  return divFloor(machine.tankMl * TICKS_PER_MINUTE, -machine.flowMlPerMinute);
}

/**
 * How full a network's pipes read, 0..1000 — what the renderer tints with, and what makes an
 * unfed pipe render GREY.
 *
 * Not a fill level: there is no per-segment fill in this model and there must never be one.
 * It is the ratio of what the network delivered to what it was asked for, which is the honest
 * answer to "is anything flowing through here" and is why a dead syrup line is findable
 * without opening a single panel.
 */
export function networkFlowPermille(network: PipeNetwork): number {
  if (network.demandMl <= 0) return network.supplyMl > 0 ? 1000 : 0;
  const ratio = divFloor(network.deliveredMl * 1000, network.demandMl);
  return ratio > 1000 ? 1000 : ratio;
}
