// @snack/sim — the deterministic simulation core.
//
// Zero runtime dependencies, permanently. No DOM. Given the same seed and the same
// command sequence, N ticks produce the same `hashState()` on every machine, every run,
// forever. The rules that keep that true are in README.md and enforced by lint and by a
// tsconfig with no "DOM" lib.
//
// The shape of a host loop:
//
//   const state = createWorld(seed);
//   const buffer = createWorldView();
//   // …each fixed step:
//   step(state, { tick: state.tick, commands: drainCommands() });
//   render(view(state, buffer), alpha);
//
// Nothing outside this package may mutate `WorldState` directly. Send a `Command`.

export const SIM_VERSION = '0.1.0';

// --- units ------------------------------------------------------------------------
export {
  BEATS_PER_MINUTE,
  SUBTILE,
  TICKS_PER_ACTIVE_HOUR,
  TICKS_PER_BEAT,
  TICKS_PER_SECOND,
  TICK_MS,
  beatIndex,
  centiActiveHours,
  cents,
  clampInt,
  distanceSquaredSubtiles,
  divFloor,
  divRound,
  isBeatTick,
  litresToMillilitres,
  millilitres,
  permille,
  subtiles,
  subtilesToTile,
  tileCentreSubtiles,
  ticksToMilliseconds,
  tilesToSubtiles,
  workPoints,
} from './units';
export type { Cents, Millilitres, Subtiles, WorkPoints } from './units';

// --- randomness -------------------------------------------------------------------
export {
  SYSTEM_IDS,
  SystemId,
  cloneRng,
  deriveStream,
  nextBelow,
  nextChance,
  nextRange,
  nextUint32,
  normaliseSeed,
  splitmix32,
} from './rng';
export type { RngState } from './rng';

// --- balance data -----------------------------------------------------------------
export {
  BALANCE_HASH,
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  CROP_SPECS,
  CropId,
  FERTILITY_MAX,
  FERTILITY_MIN,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  FIELD_TILES_HIGH,
  FIELD_TILES_WIDE,
  FIELD_TILE_COUNT,
  GROWTH_PER_WATERED_TICK,
  HAND_POUR_ML,
  HAND_REACH_SUBTILES,
  ITEM_SPECS,
  ItemId,
  MACHINE_SPECS,
  MOISTURE_DRY_THRESHOLD,
  MOISTURE_MAX,
  MachineKind,
  NET_WORTH_SAMPLE_LIMIT,
  NET_WORTH_SAMPLE_PERIOD_TICKS,
  REPAIR_PER_TOUCH,
  SPRINKLER_POUR_ML,
  SPRINKLER_PERIOD_TICKS,
  SPRINKLER_RADIUS_TILES,
  STARTING_MONEY_CENTS,
  STARTING_SEEDS,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  cropSpec,
  itemSpec,
  listPriceCents,
  machineSpec,
} from './data';
export type { CropSpec, ItemSpec, MachineSpec } from './data';

// --- world state ------------------------------------------------------------------
export {
  Direction,
  WORLD_STATE_VERSION,
  addItem,
  computeNetWorthCents,
  createWorld,
  fieldIndex,
  isFieldTile,
  isInsideWorld,
  isTileReady,
  itemCount,
  machineAt,
  machineById,
  machineCentreSubtiles,
  machineCoversTile,
  removeItem,
  spawnMachine,
  streamFor,
  tileAt,
} from './state';
export type {
  CropTile,
  InventorySlot,
  Machine,
  PlayerState,
  TraceEntry,
  WorldState,
} from './state';

// --- commands ---------------------------------------------------------------------
export { appendTrace } from './commands';
export type {
  Command,
  CommandType,
  HarvestTileCommand,
  LoadMachineCommand,
  PlaceMachineCommand,
  PlantTileCommand,
  RefillHopperCommand,
  RepairMachineCommand,
  SellItemCommand,
  SetMoveDirectionCommand,
  UnloadMachineCommand,
  WaterTileCommand,
  WhackJamCommand,
} from './commands';

// --- the tick ---------------------------------------------------------------------
export { KNOWN_MACHINE_KINDS, step, stepMany } from './tick';
export type { TickInput } from './tick';

// --- stats ------------------------------------------------------------------------
export {
  bestTrailingGainCents,
  centiActiveHoursElapsed,
  centsPerKilolitre,
  createManualTouchCounts,
  createStats,
  lifetimeNetEarningsCents,
  pushNetWorthSample,
  recordEarnings,
  recordManualTouch,
  recordSpend,
  recordWaterDrawn,
  totalManualTouches,
} from './stats';
export type { ManualTouchCounts, ManualTouchKind, WorldStats } from './stats';

// --- hashing ----------------------------------------------------------------------
export {
  findNonIntegerFields,
  fnv1aByte,
  fnv1aInit,
  fnv1aString,
  fnv1aToHex,
  hashState,
  hashStateUint32,
} from './hash';

// --- the render projection --------------------------------------------------------
export { LampState, createWorldView, growthStage, view } from './view';
export type {
  FieldView,
  InventoryView,
  MachineView,
  PlayerView,
  StatsView,
  WorldView,
} from './view';
