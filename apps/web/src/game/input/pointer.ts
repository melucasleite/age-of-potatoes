// Pointer: hover tracking, and one click → exactly one command.
//
// Hover is renderer state. It never enters the sim and never enters the trace (§12) — a
// trace that recorded where the mouse was would stop being replayable at any useful size,
// and the state hash would start depending on mouse position.
//
// One click is one command in v0.1: no repeat-on-hold. `pointerdown` is the edge, and
// nothing re-fires while the button stays down. Press and release are tracked separately
// even so, because [[018 Add RimWorld-style zone painting]] turns a drag into a SINGLE
// RECT COMMAND and this must not have been architected into a click-only shape.

import type { Command, MachineView, WorldView } from '@snack/sim';
import { ItemId, LampState, MachineKind, listPriceCents } from '@snack/sim';

import type { HoverTile, InputHost } from './context';
import { screenToTile, tileAtView } from './picking';
import { ToolMode, V01_CROP, toolMachineKind } from './tools';

export class PointerInput {
  private attached = false;
  private pressed = false;

  constructor(private readonly host: InputHost) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const canvas = this.host.canvas;
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    const canvas = this.host.canvas;
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.pressed = false;
    this.host.setHover(null);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.host.setHover(this.tileUnder(event));
    // Deliberately no repeat-while-held here. v0.1 has no drag verb; [[018]] adds one as
    // a rect command issued on release, not as a stream of per-tile commands.
  };

  private readonly onPointerLeave = (): void => {
    this.pressed = false;
    this.host.setHover(null);
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly onPointerUp = (): void => {
    this.pressed = false;
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    const view = this.host.latestView();
    if (view === null) return;

    const tile = this.tileUnder(event);
    this.host.setHover(tile);
    this.pressed = true;

    const command =
      event.button === 2
        ? maintenanceCommand(view, tile)
        : primaryCommand(view, tile, this.host.getTool());

    // A command that could not be formed is simply not sent. A command that CAN be formed
    // is sent even when it looks illegal from here — the sim is the authority and rejects
    // it harmlessly (§12). Letting the UI decide legality is how replays diverge.
    if (command !== null) this.host.queue.push(command);
  };

  private tileUnder(event: PointerEvent): HoverTile {
    return screenToTile(this.host.canvas, this.host.camera, event.clientX, event.clientY);
  }
}

/** Left click: the current tool's verb. */
export function primaryCommand(view: WorldView, tile: HoverTile, tool: ToolMode): Command | null {
  const kind = toolMachineKind(tool);
  if (kind !== null) {
    return { type: 'PlaceMachine', kind, tileX: tile.tileX, tileY: tile.tileY };
  }

  const query = tileAtView(view, tile.tileX, tile.tileY);
  if (!query.insideWorld) return null;

  switch (tool) {
    case ToolMode.Water:
      return { type: 'WaterTile', tileX: tile.tileX, tileY: tile.tileY };
    case ToolMode.Plant:
      return { type: 'PlantTile', tileX: tile.tileX, tileY: tile.tileY, crop: V01_CROP };
    case ToolMode.Harvest:
      return { type: 'HarvestTile', tileX: tile.tileX, tileY: tile.tileY };
    case ToolMode.Hand:
      return query.machine === null ? null : handCommand(view, query.machine);
    default:
      return null;
  }
}

/** Right click: maintenance, on whatever machine is under the cursor. */
export function maintenanceCommand(view: WorldView, tile: HoverTile): Command | null {
  const query = tileAtView(view, tile.tileX, tile.tileY);
  const machine = query.machine;
  if (machine === null) return null;
  if (isJammed(machine)) return { type: 'WhackJam', machineId: machine.id };
  return { type: 'RepairMachine', machineId: machine.id };
}

/**
 * The Hand verb for a machine. One command, chosen from what the machine most obviously
 * needs — this is a convenience, not an authority: every branch below produces a command
 * the sim re-validates.
 */
function handCommand(view: WorldView, machine: MachineView): Command | null {
  if (isJammed(machine)) return { type: 'WhackJam', machineId: machine.id };

  if (machine.kind === MachineKind.SellBin) {
    const item = bestSellable(view);
    return item === null ? null : { type: 'SellItem', item: item.item, count: item.count };
  }

  if (machine.kind === MachineKind.Sprinkler) {
    return { type: 'RefillHopper', machineId: machine.id };
  }

  if (machine.kind === MachineKind.ChipKitchen) {
    if (machine.outputCount > 0) {
      return { type: 'UnloadMachine', machineId: machine.id, count: machine.outputCount };
    }
    const potatoes = countOf(view, ItemId.RussetPotato);
    if (potatoes <= 0) return null;
    return { type: 'LoadMachine', machineId: machine.id, count: potatoes };
  }

  return null;
}

/**
 * The most valuable non-seed stack. Seeds are never auto-sold — selling the last seed is
 * the one irreversible mistake available in v0.1, and the sim's anti-softlock floor
 * (every harvest returns a seed) should not have to save the player from the UI.
 */
function bestSellable(view: WorldView): { item: ItemId; count: number } | null {
  let best: { item: ItemId; count: number } | null = null;
  let bestValue = 0;
  for (let i = 0; i < view.inventory.length; i++) {
    const slot = view.inventory[i]!;
    if (slot.item === ItemId.PotatoSeed || slot.count <= 0) continue;
    const value = listPriceCents(slot.item as ItemId) * slot.count;
    if (value > bestValue) {
      bestValue = value;
      best = { item: slot.item as ItemId, count: slot.count };
    }
  }
  return best;
}

function countOf(view: WorldView, item: ItemId): number {
  for (let i = 0; i < view.inventory.length; i++) {
    const slot = view.inventory[i]!;
    if (slot.item === item) return slot.count;
  }
  return 0;
}

function isJammed(machine: MachineView): boolean {
  return machine.lamp === LampState.Jammed;
}

/** Machine-view helper shared with the renderer's affordability hints. */
export function canAfford(view: WorldView, costCents: number): boolean {
  return view.moneyCents >= costCents;
}
