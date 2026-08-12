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

import type { CropId, ItemId, MachineKind } from './data';
import type { Direction, TraceEntry, WorldState } from './state';

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
  | SellItemCommand;

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
