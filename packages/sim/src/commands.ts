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

import type { BeltTier, CropId, GrabberTier, ItemId, MachineKind, UpgradeDial } from './data';
import type { Direction, TraceEntry, WorldState } from './state';
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

export type Command =
  | SetMoveDirectionCommand
  | WaterTileCommand
  | PlantTileCommand
  | HarvestTileCommand
  | PlaceMachineCommand
  | LoadMachineCommand
  | UnloadMachineCommand
  | RefillHopperCommand
  | RepairMachineCommand
  | WhackJamCommand
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
  | SetZoneAutoReplantCommand;

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
