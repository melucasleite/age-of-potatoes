// The cursor/tool mode.
//
// This is UI state. It is NOT a command, is never recorded in the trace, and never enters
// the world — same rule as camera pan, hover, and menu state (§12). The sim does not know
// which tool is selected and must not: legality is decided from world state alone, so a
// replay does not depend on which button was lit.
//
// RESERVED FOR v0.2, deliberately not implemented here — see
// [[018 Add RimWorld-style zone painting]]:
//   - drag-painting, which §16 requires be a SINGLE RECT COMMAND rather than one command
//     per tile (a 40×40 drag is one command, not 1,600);
//   - belt drag-routing;
//   - the camera-pan vs paint-mode conflict, where the same drag means two things.
// The shape here does not assume a pointer interaction is a single click — `pointer.ts`
// tracks press/release separately so a drag gesture has somewhere to live.

import { CropId, MachineKind } from '@snack/sim';

export const ToolMode = {
  /** Interact: load, unload, refill, sell, whack. Reads the machine under the cursor. */
  Hand: 0,
  Water: 1,
  Plant: 2,
  Harvest: 3,
  PlaceSprinkler: 4,
  PlaceChipKitchen: 5,
} as const;

export type ToolMode = (typeof ToolMode)[keyof typeof ToolMode];

export const TOOL_ORDER: readonly ToolMode[] = [
  ToolMode.Hand,
  ToolMode.Water,
  ToolMode.Plant,
  ToolMode.Harvest,
  ToolMode.PlaceSprinkler,
  ToolMode.PlaceChipKitchen,
];

export interface ToolInfo {
  readonly label: string;
  readonly hint: string;
  /** Cents this tool spends per use, for the affordability hint. Zero for hand verbs. */
  readonly costCents: number;
}

export const TOOL_INFO: Readonly<Record<ToolMode, ToolInfo>> = {
  [ToolMode.Hand]: {
    label: 'Hand',
    hint: 'click a machine: load / take / refill / sell',
    costCents: 0,
  },
  [ToolMode.Water]: { label: 'Water', hint: 'click soil in reach to pour the can', costCents: 0 },
  [ToolMode.Plant]: { label: 'Plant', hint: 'click bare soil to sow a potato', costCents: 0 },
  [ToolMode.Harvest]: { label: 'Harvest', hint: 'click a ripe plant to pull it', costCents: 0 },
  [ToolMode.PlaceSprinkler]: {
    label: 'Buy Sprinkler',
    hint: 'click ground beside the field ($150)',
    costCents: 15_000,
  },
  [ToolMode.PlaceChipKitchen]: {
    label: 'Buy Chip Kitchen',
    hint: 'click 2x2 of clear ground ($100)',
    costCents: 10_000,
  },
};

/** The only crop in v0.1. */
export const V01_CROP = CropId.RussetPotato;

export function toolMachineKind(tool: ToolMode): MachineKind | null {
  if (tool === ToolMode.PlaceSprinkler) return MachineKind.Sprinkler;
  if (tool === ToolMode.PlaceChipKitchen) return MachineKind.ChipKitchen;
  return null;
}
