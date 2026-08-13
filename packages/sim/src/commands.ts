// The Command union and the append-only input trace.
//
// EVERY state mutation enters the world through a `Command` applied at a specific tick.
// There are no debug buttons, no direct setters, and no out-of-band mutation — if a thing
// can change the world, it is in this union. That is what makes seed + trace a complete
// description of a session.
//
// WHAT IS NOT A COMMAND: camera pan, camera zoom, hover, tooltips, selection, and menu
// state. None of them touch the world, none of them are recorded, and none of them may
// ever become commands — a camera pan that entered the trace would make replays depend on
// where somebody was looking.
//
// Player movement is a HELD DIRECTION, never a position delta. `SetMoveDirection` says
// which way the stick is pushed; the sim decides how far that goes in a tick. Sending
// deltas would let input frequency leak into world state, so a dropped frame or a 144 Hz
// monitor would change how fast the character walks.
//
// Every variant is a plain serializable object with integer payloads. No floats, no
// objects with behaviour, nothing that needs a constructor to come back from JSON.

import type {
  BeltTier,
  CropId,
  GrabberTier,
  ItemId,
  LiquidId,
  MachineKind,
  UpgradeDial,
} from './data';
import type { Direction, IntentAction, TraceEntry, WorldState } from './state';
import type { PaintMode, TileRect } from './zones';

/** Hold a direction, or `Direction.None` to stop. */
export interface SetMoveDirectionCommand {
  type: 'SetMoveDirection';
  dir: Direction;
}

/** Pour the can on one tile. Counts as a hand-water touch. */
export interface WaterTileCommand {
  type: 'WaterTile';
  tileX: number;
  tileY: number;
}

/** Plant a seed from inventory. Counts as a hand-plant touch. */
export interface PlantTileCommand {
  type: 'PlantTile';
  tileX: number;
  tileY: number;
  crop: CropId;
}

/** Pull a ready tile. Counts as a hand-harvest touch. */
export interface HarvestTileCommand {
  type: 'HarvestTile';
  tileX: number;
  tileY: number;
}

/** Buy and place a machine at its invoice price. */
export interface PlaceMachineCommand {
  type: 'PlaceMachine';
  kind: MachineKind;
  tileX: number;
  tileY: number;
}

/** Hand-feed a machine's input buffer. Counts as a hand-carry touch. */
export interface LoadMachineCommand {
  type: 'LoadMachine';
  machineId: number;
  count: number;
  /**
   * Which line of the recipe to fill, as an item id — or absent for "whatever fits".
   *
   * OPTIONAL, AND THAT IS THE WHOLE POINT. Every machine but the Combo Packer eats exactly one
   * ingredient, so requiring the field would make every existing caller name the only possible
   * answer, and every existing trace entry would have to be rewritten to carry it. Absent means
   * the reducer fills the first line the player is carrying and has room for, which is what a
   * single-ingredient machine has always done. The field is additive: an old trace replays
   * identically, because `undefined` is exactly the behaviour it recorded.
   */
  item?: ItemId;
}

/** Take a machine's output by hand. Counts as a hand-carry touch. */
export interface UnloadMachineCommand {
  type: 'UnloadMachine';
  machineId: number;
  count: number;
}

/** Top up a tank or hopper by hand. Counts as a hopper-refill touch. */
export interface RefillHopperCommand {
  type: 'RefillHopper';
  machineId: number;
}

/** One hold-to-repair pulse. Free forever (plan §3). Counts as a hand-repair touch. */
export interface RepairMachineCommand {
  type: 'RepairMachine';
  machineId: number;
}

/** Clear a jam with a thump. Counts as a jam-whack touch. */
export interface WhackJamCommand {
  type: 'WhackJam';
  machineId: number;
}

/**
 * Spend one repair kit on a spot, servicing every machine around it.
 *
 * ADDRESSED TO A TILE RATHER THAN A MACHINE, on purpose. Plan §4 buys "one trip services a
 * cell" with this command's shape: a kit aimed at a machine id would be a per-machine
 * consumable that hand repair already does for free, and the player would rightly never buy
 * one. Aimed at a spot on the ground, it is a different verb — it trades money for a walk.
 */
export interface UseRepairKitCommand {
  type: 'UseRepairKit';
  tileX: number;
  tileY: number;
}

/** Sell from inventory at list, standing at the sell bin. */
export interface SellItemCommand {
  type: 'SellItem';
  item: ItemId;
  count: number;
}

/** Buy seeds and consumables at the roadside stand, at list. */
export interface BuyItemCommand {
  type: 'BuyItem';
  item: ItemId;
  count: number;
}

/**
 * Pick a machine up and put it down somewhere else. Free, forever (plan §4): misplacement
 * is genre-baseline QoL and must never be a fine. Buffers and condition travel with it.
 */
export interface MoveMachineCommand {
  type: 'MoveMachine';
  machineId: number;
  tileX: number;
  tileY: number;
}

/** Buy one level on one of a machine's three dials. Numbers only, never a new verb. */
export interface UpgradeMachineCommand {
  type: 'UpgradeMachine';
  machineId: number;
  dial: UpgradeDial;
}

/** Research a tech node: money, prerequisites, and — for Charters — a visible milestone. */
export interface ResearchTechCommand {
  type: 'ResearchTech';
  techId: string;
}

// --- belts and grabbers -------------------------------------------------------------

/** Lay one straight belt segment. Corners are two segments meeting, not a curve. */
export interface PlaceBeltCommand {
  type: 'PlaceBelt';
  tier: BeltTier;
  tileX: number;
  tileY: number;
  dir: Direction;
  lengthTiles: number;
}

/** Take a belt back up. Refunds in full and returns whatever was riding it. */
export interface RemoveBeltCommand {
  type: 'RemoveBelt';
  beltId: number;
}

export interface PlaceGrabberCommand {
  type: 'PlaceGrabber';
  tier: GrabberTier;
  tileX: number;
  tileY: number;
  dir: Direction;
  /** 0 for unfiltered. Mk1 arms reject anything else. */
  filter: number;
}

/** Retune a filtered arm without rebuying it. */
export interface SetGrabberFilterCommand {
  type: 'SetGrabberFilter';
  grabberId: number;
  filter: number;
}

export interface RemoveGrabberCommand {
  type: 'RemoveGrabber';
  grabberId: number;
}

// --- zones --------------------------------------------------------------------------
//
// ONE DRAG IS ONE COMMAND. The rect is the payload precisely so that a sixty-tile paint is
// one trace entry rather than sixty — replays stay small, bug reports stay readable, and an
// eventual undo is one step per player action. The in-progress rubber band is renderer-only
// and emits nothing; a cancelled drag emits nothing at all.

/** Start a new zone from a completed drag. */
export interface CreateZoneCommand {
  type: 'CreateZone';
  rect: TileRect;
  crop: CropId;
}

/** Add to or erase from an existing zone. Tiles owned by another zone are reassigned. */
export interface PaintZoneCommand {
  type: 'PaintZone';
  zoneId: number;
  rect: TileRect;
  mode: PaintMode;
}

export interface SetZoneCropCommand {
  type: 'SetZoneCrop';
  zoneId: number;
  crop: CropId;
}

export interface SetZonePriorityCommand {
  type: 'SetZonePriority';
  zoneId: number;
  priority: number;
}

export interface RenameZoneCommand {
  type: 'RenameZone';
  zoneId: number;
  name: string;
}

/**
 * Arm or disarm auto-replant.
 *
 * REJECTED BY THE REDUCER until the seed hopper is researched, so the locked toggle is
 * locked in the simulation rather than only in the UI — a disabled button is a suggestion,
 * and this is the rule.
 */
export interface SetZoneAutoReplantCommand {
  type: 'SetZoneAutoReplant';
  zoneId: number;
  on: boolean;
}

// --- pipes ----------------------------------------------------------------------------
//
// ONE DRAG IS ONE COMMAND, exactly as it is for zone painting and for belts. A thirty-tile
// pipe run appends ONE entry to the trace carrying its whole path, so replays stay small, bug
// reports stay readable, and an eventual undo has one exact inverse to apply rather than
// thirty. The in-progress ghost is renderer-only and emits nothing; a cancelled drag emits
// nothing at all.

/** One tile of a routed run. Integers, like everything else in a command payload. */
export interface PipePathNode {
  x: number;
  y: number;
}

/**
 * Lay a run of pipe along a contiguous, non-repeating path of tiles.
 *
 * Refused outright — not resolved afterwards — if the run would join two liquids or put two
 * pumps on one network. `pipePathRefusal()` in `pipes.ts` is the single rule, shared with the
 * renderer's placement preview so the reason appears on the object before the click lands.
 */
export interface PlacePipeCommand {
  type: 'PlacePipe';
  liquid: LiquidId;
  path: PipePathNode[];
}

/**
 * Take a run of pipe back up. Refunds in full — misplacement is never a fine (plan §4) — and
 * the path is the exact inverse of the `PlacePipe` that laid it.
 */
export interface RemovePipeCommand {
  type: 'RemovePipe';
  path: PipePathNode[];
}

// --- walking to an errand ---------------------------------------------------------------
//
// ONE CLICK IS ONE COMMAND, exactly as one drag is. Clicking a tile you cannot reach records
// a single `WalkAndAct` and nothing else: the sim walks the farmer over the next hundred-odd
// ticks and fires the verb on arrival, and none of those ticks appends anything. The
// alternative — the client emitting `SetMoveDirection` until the player is close enough — is
// the reason the note at the top of this file exists. It would put a direction change in the
// trace every few ticks for every click, forever, and it would make how far the farmer walks
// depend on how fast the browser happened to be running.

/**
 * Walk to a tile and perform one hand verb on arrival.
 *
 * The payload is FLAT: an action kind, a target tile, and two integers whose meaning the
 * action decides. Nesting a whole `Command` in here would have been shorter to write and
 * worse to live with — a recursive command is recursive in the trace, in the save, and in
 * the hash.
 *
 * Issued by the input layer ONLY when the target is out of reach. An in-reach click still
 * emits the direct command, so the common case gains nothing that can go wrong.
 */
export interface WalkAndActCommand {
  type: 'WalkAndAct';
  action: IntentAction;
  tileX: number;
  tileY: number;
  /** `CropId` for Plant, `ItemId` for Sell, 0 for the verbs that need neither. */
  item: number;
  /** Stack size for Load, Unload, and Sell. 0 otherwise. */
  count: number;
}

export type Command =
  | SetMoveDirectionCommand
  | WalkAndActCommand
  | WaterTileCommand
  | PlantTileCommand
  | HarvestTileCommand
  | PlaceMachineCommand
  | LoadMachineCommand
  | UnloadMachineCommand
  | RefillHopperCommand
  | RepairMachineCommand
  | WhackJamCommand
  | UseRepairKitCommand
  | SellItemCommand
  | BuyItemCommand
  | MoveMachineCommand
  | UpgradeMachineCommand
  | ResearchTechCommand
  | PlaceBeltCommand
  | RemoveBeltCommand
  | PlaceGrabberCommand
  | SetGrabberFilterCommand
  | RemoveGrabberCommand
  | CreateZoneCommand
  | PaintZoneCommand
  | SetZoneCropCommand
  | SetZonePriorityCommand
  | RenameZoneCommand
  | SetZoneAutoReplantCommand
  | PlacePipeCommand
  | RemovePipeCommand;

export type CommandType = Command['type'];

/**
 * Append an applied command to the trace.
 *
 * Only commands that actually took effect are recorded. A rejected command is a no-op, so
 * omitting it leaves the replay identical while keeping the trace an honest log of what
 * happened rather than what was attempted.
 *
 * The trace is append-only: nothing sorts it, nothing rewrites it, nothing removes from
 * it. Its order *is* application order.
 */
export function appendTrace(state: WorldState, tick: number, command: Command): void {
  const entry: TraceEntry = { tick, command };
  state.trace.push(entry);
}
