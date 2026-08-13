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

// --- units ------------------------------------------------------------------------
export {
  BEATS_PER_MINUTE,
  SUBTILE,
  TICKS_PER_ACTIVE_HOUR,
  TICKS_PER_BEAT,
  TICKS_PER_MINUTE,
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
  AUTO_REPLANT_PERIOD_TICKS,
  BALANCE_HASH,
  BELT_ITEM_SPACING_SUBTILES,
  BELT_MAX_LENGTH_TILES,
  BELT_SPECS,
  BeltTier,
  CAPACITY_BONUS_PER_LEVEL,
  COMPOST_AFTER_TICKS,
  COMPOST_PER_CROP,
  CONDITION_EFFECT_THRESHOLD,
  CONDITION_MAX,
  CROP_SPECS,
  CropId,
  DAY_OLD_DENOMINATOR,
  DAY_OLD_NUMERATOR,
  EFFICIENCY_WEAR_CUT_PERCENT_PER_LEVEL,
  FERTILITY_MAX,
  FERTILITY_MIN,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  FIELD_TILES_HIGH,
  FIELD_TILES_WIDE,
  FIELD_TILE_COUNT,
  GRABBER_SPECS,
  GROWTH_PER_WATERED_TICK,
  GrabberTier,
  HAND_POUR_ML,
  HAND_REACH_SUBTILES,
  IRRIGATION_HUB_RADIUS_TILES,
  IRRIGATION_HUB_SCAN_PER_TICK,
  ITEM_SPECS,
  ItemId,
  LIQUID_SPECS,
  LiquidId,
  MACHINE_SPECS,
  MOISTURE_DRY_THRESHOLD,
  MOISTURE_MAX,
  MachineKind,
  MachineRole,
  NET_WORTH_SAMPLE_LIMIT,
  NET_WORTH_SAMPLE_PERIOD_TICKS,
  OVERCOOK_BLOCKED_TICKS,
  PIPE_MAX_PATH_TILES,
  PIPE_PRICE_CENTS_PER_TILE,
  PIPE_RR_MODULUS,
  POND_ORIGIN_X,
  POND_ORIGIN_Y,
  POND_TILES_HIGH,
  POND_TILES_WIDE,
  PUMP_RATE_ML_PER_MINUTE,
  RECIRCULATOR_ML_PER_MINUTE,
  REPAIR_KIT_PRICE_CENTS,
  REPAIR_KIT_RADIUS_TILES,
  REPAIR_PER_TOUCH,
  RESERVOIR_CAPACITY_ML,
  RESERVOIR_CAPACITY_UNITS,
  RESERVOIR_LOW_PERMILLE,
  RESERVOIR_RECHARGE_ML_PER_MINUTE,
  RESERVOIR_UNIT_ML,
  RUSTIC_STYLE_DENOMINATOR,
  RUSTIC_STYLE_NUMERATOR,
  SEASONED_CHIPS_PRICE_CENTS,
  SPEED_RATE_BONUS_PERCENT_PER_LEVEL,
  SPEED_WEAR_PENALTY_PERCENT_PER_LEVEL,
  SPRINKLER_POUR_ML,
  SPRINKLER_PERIOD_TICKS,
  SPRINKLER_RADIUS_TILES,
  STARTING_MONEY_CENTS,
  STARTING_SEEDS,
  UPGRADE_COST_PERCENT_BY_LEVEL,
  UPGRADE_MAX_LEVEL,
  UpgradeDial,
  WALK_ERRAND_TIMEOUT_TICKS,
  WILT_GRACE_TICKS,
  WILT_WINDOW_TICKS,
  WORK_RATE_SCALE,
  WORLD_TILES_HIGH,
  WORLD_TILES_WIDE,
  WiltStage,
  ZONE_NAME_MAX_LENGTH,
  ZONE_PAINT_MAX_SPAN,
  ZONE_PRIORITY_DEFAULT,
  ZONE_PRIORITY_MAX,
  ZONE_PRIORITY_MIN,
  WASTE_PERIOD_AT_THRESHOLD,
  WASTE_PERIOD_AT_ZERO,
  beltSpec,
  cropSpec,
  dayOldPriceCents,
  grabberSpec,
  isNetworkConsumer,
  isPurchasable,
  itemSpec,
  liquidSpec,
  listPriceCents,
  rusticStylePriceCents,
  machineSpec,
  wiltStageForAge,
} from './data';
export type { BeltSpec, CropSpec, GrabberSpec, ItemSpec, LiquidSpec, MachineSpec } from './data';

// --- the liquid layer -------------------------------------------------------------
// Plan §5's grammar is `RESERVOIR → (Pump) → pipes → [Tank] → machines`, and the model is
// FLOW, NOT PRESSURE: one ledger per network, one pump and one liquid per network enforced at
// placement, tanks buffering the difference and showing a net rate and a time-to-empty.
export {
  ReservoirThrottle,
  WaterDraw,
  nearestReservoir,
  pumpSupplyMlPerMinute,
  rechargeReservoir,
  reservoirAdjacentToTile,
  reservoirAt,
  reservoirById,
  reservoirCoversTile,
  reservoirLevelPermille,
  reservoirThrottle,
  takeWater,
} from './water';
export {
  BuildRefusal,
  advancePipes,
  liquidPlacementRefusal,
  networkById,
  networkFlowPermille,
  pipeAt,
  pipePathRefusal,
  rebuildNetworks,
  tankTicksToEmpty,
  worldTileIndex,
} from './pipes';
export type { TilePoint } from './pipes';

// --- the tech tree ----------------------------------------------------------------
// Nodes unlock VERBS and carry no numbers; upgrade dials scale NUMBERS and unlock nothing.
// The two halves of the anti-double-dip rule (plan §3), enforced by the shapes themselves.
export {
  MilestoneKind,
  TECH_NODES,
  TechBranch,
  TechId,
  hasTech,
  insertUnlocked,
  milestoneMet,
  prerequisitesMet,
  techNode,
  techSatisfied,
} from './tech';
export type { TechNode } from './tech';

// --- per-machine upgrades ---------------------------------------------------------
export {
  acceptsUpgrades,
  effectiveInputCapacity,
  effectiveOutputCapacity,
  effectivePumpRateMlPerMinute,
  effectiveTankCapacityMl,
  effectiveWastePeriod,
  effectiveWear,
  effectiveWorkRate,
  setUpgradeLevel,
  upgradeCostCents,
  upgradeLevel,
} from './upgrades';

// --- belts, grabbers, and zones ---------------------------------------------------
export {
  advanceBelts,
  advanceGrabbers,
  beltTakeFromTile,
  grabberDestTile,
  grabberSourceTile,
} from './belts';
export {
  PaintMode,
  advanceZones,
  clipRectToField,
  createZoneCounts,
  paintZoneRect,
  pruneEmptyZones,
} from './zones';
export type { TileRect, ZoneCounts } from './zones';

// --- world state ------------------------------------------------------------------
export {
  CeremonyId,
  Direction,
  INTENT_ACTIONS,
  IntentAction,
  WORLD_STATE_VERSION,
  addItem,
  beltAt,
  beltById,
  beltCoversTile,
  beltEndDist,
  beltIndexOfTile,
  beltInsert,
  beltTileAtIndex,
  beltTileIndexForDist,
  clipZoneName,
  computeNetWorthCents,
  createWorld,
  directionStepX,
  directionStepY,
  fieldIndex,
  fieldTileX,
  fieldTileY,
  grabberAt,
  grabberById,
  isCompassDirection,
  isFieldTile,
  isInsideWorld,
  isTileReady,
  itemCount,
  machineAt,
  machineById,
  machineCentreSubtiles,
  machineCoversTile,
  markCeremony,
  nextOutputItem,
  oppositeDirection,
  plantCrop,
  removeItem,
  removeZone,
  spawnBelt,
  spawnGrabber,
  spawnMachine,
  spawnPipe,
  takeOneOutput,
  spawnReservoir,
  spawnZone,
  streamFor,
  tileAt,
  tileOccupied,
  zoneById,
  zoneTileCount,
} from './state';
export type {
  Belt,
  BeltItem,
  CropTile,
  Grabber,
  InventorySlot,
  Machine,
  Pipe,
  PipeNetwork,
  PlayerIntent,
  PlayerState,
  Reservoir,
  TraceEntry,
  WorldState,
  Zone,
} from './state';

// --- commands ---------------------------------------------------------------------
export { appendTrace } from './commands';
export type {
  BuyItemCommand,
  Command,
  CommandType,
  CreateZoneCommand,
  HarvestTileCommand,
  LoadMachineCommand,
  MoveMachineCommand,
  PaintZoneCommand,
  PlaceBeltCommand,
  PipePathNode,
  PlaceGrabberCommand,
  PlaceMachineCommand,
  PlacePipeCommand,
  PlantTileCommand,
  RefillHopperCommand,
  RemoveBeltCommand,
  RemoveGrabberCommand,
  RemovePipeCommand,
  RenameZoneCommand,
  RepairMachineCommand,
  ResearchTechCommand,
  SellItemCommand,
  SetGrabberFilterCommand,
  SetMoveDirectionCommand,
  SetZoneAutoReplantCommand,
  SetZoneCropCommand,
  SetZonePriorityCommand,
  UnloadMachineCommand,
  UpgradeMachineCommand,
  UseRepairKitCommand,
  WalkAndActCommand,
  WaterTileCommand,
  WhackJamCommand,
} from './commands';

// --- the tick ---------------------------------------------------------------------
export { CHIP_LINE_KINDS, KNOWN_MACHINE_KINDS, step, stepMany } from './tick';
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
  recordRefund,
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

// --- saves ------------------------------------------------------------------------
// `SIM_VERSION` is the sim's code version fused with `BALANCE_HASH`: balance data is
// save-compatibility surface exactly as much as code is (plan §12), so changing one price in
// `data.ts` changes the version key a save records itself against. The storage driver lives
// in `apps/web/src/storage` — `indexedDB` does not type-check in this package, by design.
export {
  CURRENT_FORMAT_VERSION,
  MIGRATIONS,
  SIM_CODE_VERSION,
  SIM_VERSION,
  SaveCorruptError,
  SaveError,
  SaveFormatTooNewError,
  SaveMigrationMissingError,
  checkSimVersion,
  deserialize,
  fromPayload,
  migrate,
  parseEnvelope,
  restoreWorld,
  serialize,
  toPayload,
} from './save/index';
export type {
  MigrationOutcome,
  RestoredWorld,
  SaveBelt,
  SaveBeltItem,
  SaveCropTile,
  SaveEnvelope,
  SaveGrabber,
  SaveInventorySlot,
  SaveMachine,
  SaveMigration,
  SavePayload,
  SavePipe,
  SavePipeNetwork,
  SaveReservoir,
  SaveStats,
  SaveStream,
  SaveZone,
  SimVersionCheck,
} from './save/index';

// --- the render projection --------------------------------------------------------
export { LampState, createWorldView, growthStage, inspectTile, view } from './view';
export type {
  BeltView,
  FieldView,
  GrabberView,
  InventoryView,
  MachineView,
  NetworkView,
  PipeView,
  PlayerView,
  ReservoirView,
  StatsView,
  TileInspection,
  WorldView,
  ZoneView,
} from './view';
