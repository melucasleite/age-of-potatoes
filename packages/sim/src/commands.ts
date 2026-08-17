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

/**
 * Which way the till is being swung. THREE RUNGS, AND THE TOOL ALWAYS TAKES BACK EXACTLY ONE
 * LAYER OF WHAT YOU DID (item 127) — which is what makes the ladder guessable rather than
 * memorised:
 *
 *   - `Till` — grass becomes farmland. You broke ground.
 *   - `Unplant` — a farm tile with something on it hands that something back and STAYS
 *     FARMLAND. You planted; this un-plants.
 *   - `Untill` — bare farmland becomes grass. You tilled; this un-tills.
 *
 * `Unplant` is the middle rung item 127 added, and it sits between the two on purpose: the
 * owner's ask was *"if I use a shovel on a planted tile that is not fully grown, I want it to
 * give me back the seed and keep it as dirt — if I click again, turn it to grass"*. Two swings
 * to take a planted tile back to grass, in the order the two swings were made.
 */
export const TillMode = {
  Till: 'till',
  Unplant: 'unplant',
  Untill: 'untill',
} as const;

export type TillMode = (typeof TillMode)[keyof typeof TillMode];

/**
 * Swing the till over a run of tiles: grass becomes farmland, a laden farm tile hands its crop
 * back in `Unplant` mode, or empty farmland becomes grass again in `Untill` mode.
 *
 * **ONE DRAG IS ONE COMMAND**, exactly the zone-paint grammar and for the same reasons: a
 * sixty-tile run is one trace entry, one replay step, and one eventual undo. The mode is
 * EXPLICIT rather than per-tile toggling, because a rect swept over mixed ground that
 * flipped each tile to its opposite would be a command whose meaning depends on what it
 * happened to land on — unreadable in a trace and hostile under a drag.
 *
 * **AND THAT IS WHY A THIRD MODE DID NOT BECOME A THIRD RULE** (item 127). The alternative
 * considered and rejected was a drag that takes ONE LAYER off each tile independently: it
 * would un-till the empty squares and un-plant the growing ones in a single gesture, which is
 * exactly the "what did this drag mean?" ambiguity the anchor grammar exists to prevent. The
 * anchor picks one of the three, the whole rect does that one thing, and tiles that do not
 * match are skipped — the existing per-tile skip, extended rather than replaced.
 *
 * **HAND-TOOL DOCTRINE: free, indestructible, always works** (plan §1). No cost, no wear, no
 * failure state — tiles the swing cannot convert (unowned ground, occupied ground, a farm tile
 * that is bare when the swing wants it laden or laden when the swing wants it bare, ground that
 * already is what the mode asks for) are SKIPPED GENTLY and cost nothing. Refused only when
 * nothing at all changed, so the trace keeps its "every applied command changed the world"
 * contract.
 *
 * **NOT REACH-GATED**, like `PaintZone` and unlike the watering can. A run of tiles cannot be
 * walked to one errand at a time (the player holds ONE intent), and the drag gesture is the
 * point of the tool; the ≤1.5 s feel lives in the input layer, not in a walk. The SOIL each
 * newly broken tile gets is the sim's rule alone — rolled once per position ever, from the
 * position-keyed `SoilInit` stream; see `tillTile` in `state.ts`.
 *
 * Counts one `handCarry` touch per applied command — it is a physical verb done with a tool
 * in hand, filed where every unnamed hand verb is filed, and one drag is one motion exactly
 * as one scythe swing is.
 */
export interface TillTileCommand {
  type: 'TillTile';
  rect: TileRect;
  mode: TillMode;
}

/** Pour the can on one tile. Counts as a hand-water touch. */
export interface WaterTileCommand {
  type: 'WaterTile';
  tileX: number;
  tileY: number;
}

/**
 * Refill the watering can to `CAN_CHARGES_MAX` at a shore.
 *
 * Legal while the player's tile touches a reservoir (its own tile or an orthogonal
 * neighbour), and it NEVER FAILS THERE, at any water level — §4's bold clause is about
 * exactly this verb. Refused rather than consumed when the can is already full, which is
 * `UseRepairKit`'s rule and for the same reason. Counts as a hopper-refill touch.
 */
export interface RefillCanCommand {
  type: 'RefillCan';
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

/**
 * Swing the push-scythe: three tiles at once, across the player's path.
 *
 * **ONE SWING IS ONE COMMAND AND ONE TOUCH.** The three tiles are computed by the sim from the
 * player's facing and the tile swung at — there is no tile list in the payload, for the same
 * reason `RotateGrabber` carries no direction: which three tiles a swing cuts is the sim's rule,
 * and a client that could send the list is a client that could send the wrong one.
 *
 * Unready tiles cost nothing and are left untouched, so a swing at the end of a row is a swing,
 * not a mistake. Refused entirely unless the player owns a `PushScythe`, which is never consumed.
 */
export interface SwingScytheCommand {
  type: 'SwingScythe';
  tileX: number;
  tileY: number;
}

/**
 * Work a bag of Fertilizer into a tile, putting a fertility star back.
 *
 * The closing arrow of plan §4's loop — *"spoiled goods → Compost → Fertilizer"* — and the reason
 * a player builds a Composter at all. Reach-gated like every verb you do with your hands, and
 * **refused rather than consumed** on a tile already at full stars: misplacement is never a fine.
 */
export interface ApplyFertilizerCommand {
  type: 'ApplyFertilizer';
  tileX: number;
  tileY: number;
}

/**
 * Pack a perishable stack into a crate, buying it §4's *"45 crated"*.
 *
 * NOT REACH-GATED, and not a placement: a crate is a thing in your bag that you put other things
 * in your bag into. There is nothing to stand next to. It is the same shape as
 * `SellBoxedMachine`, which is also paperwork done from the inventory panel.
 *
 * Consumes one `ItemId.Crate` and is refused — never consumed — when it would not help: an
 * unperishable item, an empty bag, or goods that are already crated and would gain nothing.
 */
export interface PackCrateCommand {
  type: 'PackCrate';
  item: ItemId;
  count: number;
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

/**
 * Take a machine off the lot and put it in the bag as a boxed item.
 *
 * BOXING IS NOT SELLING, AND THAT IS THE WHOLE DESIGN. It pays nothing, because the machine
 * was already paid for and moving one is free forever (plan §4) — a deconstruct that handed
 * back cash would be a laundering route through a verb whose entire job is rearranging. The
 * box keeps the dials and the condition, so putting it back down is free and gives you the
 * machine you had. The 40% scrap value lives on `SellBoxedMachine`, one deliberate step
 * later, which is where item 037's dangling "scrapping refunds 40% of the upgraded invoice"
 * criterion finally lands.
 *
 * Refused while jammed and while the machine is actually running — a machine mid-batch is not
 * a box — and refused for the sell bin, which is a gift the world starts with rather than a
 * thing the player owns. Everything in its hoppers and its output buffer comes back to the
 * player's hands; nothing vanishes (plan §4).
 */
export interface DeconstructMachineCommand {
  type: 'DeconstructMachine';
  machineId: number;
}

/**
 * Sell one boxed machine out of the bag, for 40% of what was invested in it.
 *
 * A SEPARATE VERB FROM `SellItem`, NOT A SPECIAL CASE INSIDE IT. `SellItem` is the sell bin:
 * it takes goods, at list, while you stand next to the stand, and `ItemSpec.sellable` is the
 * one rule it refuses on. A boxed machine is none of those things — it is not a good, it is
 * not priced at list, and it is scrapped from the inventory panel rather than carried to the
 * bin — so `sellable` stays FALSE on every boxed row and the bin keeps refusing them. Folding
 * two prices and two gates into one reducer to save a command shape is how `SellItem` would
 * stop being readable.
 *
 * NO TARGET INDEX IN THE PAYLOAD. Boxes inside a slot are kept in a canonical order — least
 * invested first — so "the next one out" is a fact about the world rather than about the
 * order the panel happened to render, and it is the same box `PlaceMachine` would put down.
 * One rule, both verbs.
 */
export interface SellBoxedMachineCommand {
  type: 'SellBoxedMachine';
  /** The boxed-machine `ItemId`. Which kind, not which one — the order decides that. */
  item: ItemId;
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

/**
 * Buy the deed to one parcel of land (plan §5).
 *
 * NO PRICE IN THE PAYLOAD, on purpose and for the same reason `RotateGrabber` carries no target
 * direction: what a deed costs is the sim's rule, off `DEED_PRICE_CENTS_BY_PURCHASE` and how
 * many the world already owns. A client that sent a price would be a client that could send the
 * wrong one, and a replay would then depend on what some build thought land was worth.
 *
 * NOT REACH-GATED, like `PlaceMachine` and `ResearchTech` and unlike every verb you do with your
 * hands. Buying land is signing for it, not touching it — there is no object on the parcel to
 * stand next to, and gating it would mean walking into land you do not own to buy the right to
 * walk into it. That is also why it needs no `IntentAction`: nothing here can be walked to.
 */
export interface BuyDeedCommand {
  type: 'BuyDeed';
  /** Row-major parcel index. Refused unless it is unowned, on the map, and adjacent to owned. */
  parcel: number;
}

// --- selling above the roadside stand -------------------------------------------------
//
// The four verbs of plan §3's assisted and automated selling rungs. Two of them are hands and
// count a `handCarry` touch; two of them are paperwork and count nothing. **THAT SPLIT IS THE
// WHOLE ADJUDICABILITY OF THE HANDS-FREE BOARD** (plan §6), so it is stated on each one.
//
// NONE OF THEM CARRIES A PRICE, and none of them ever will. Prices are stable and posted (locked
// decision 3) and §8 cuts fluctuating markets forever, so what a delivery is worth is the sim's
// rule — the same rule the sell bin uses — exactly as what a deed costs is (`BuyDeed`) and which
// way clockwise goes is (`RotateGrabber`). A client that could send a price is a client that
// could send the wrong one, and then a replay depends on what some build thought chips were
// worth.

/**
 * Put goods from the bag onto a cart. Counts a hand-carry touch.
 *
 * Reach-gated, because it is a thing you do with your hands: you are standing at the cart
 * putting crates in it. The count is CLAMPED to what will fit rather than refused, so the
 * panel's "fill it up" button — which asks for `capacity - loaded` — cannot be made wrong by a
 * belt delivering a bag between the render and the click.
 */
export interface LoadCartCommand {
  type: 'LoadCart';
  cartId: number;
  /** One product per run. Refused if the cart already holds a different one. */
  item: ItemId;
  count: number;
}

/**
 * Send a loaded cart. Counts a hand-carry touch.
 *
 * **IT NEVER LEAVES WITHOUT THIS COMMAND, and that is what makes the cart the ASSISTED rung
 * rather than a cheap depot.** A cart that departed on its own when full would be an automated
 * seller with no research behind it, which would leave the depot buying nothing but capacity.
 */
export interface DispatchCartCommand {
  type: 'DispatchCart';
  cartId: number;
}

/**
 * Sign a standing route at a depot. Counts NO manual touch.
 *
 * Not reach-gated either, and the two facts are the same fact: this is paperwork, like
 * `ResearchTech` and `BuyDeed`, not a verb you perform with your hands. Configure it once from
 * the panel and the depot fulfils it forever while it has stock.
 */
export interface CreateContractCommand {
  type: 'CreateContract';
  depotId: number;
  item: ItemId;
  quantityPerRun: number;
  /**
   * The name on the truck door. Flavour only — every destination pays list and every run takes
   * the same time. Clipped rather than rejected, and deliberately kept out of the world hash;
   * see `Contract.destination`.
   */
  destination: string;
}

/**
 * Tear a route up. Counts NO manual touch, and is **free, always** — everything on the depot's
 * floor and on its trucks comes back to the bag. A route you regret is not a fine.
 */
export interface CancelContractCommand {
  type: 'CancelContract';
  contractId: number;
}

// --- the hand cart, and the Agri-Bot dock ---------------------------------------------

/**
 * Take hold of a hand cart's handles. Counts a `handCarry` touch.
 *
 * **THE TOW IS ONE COMMAND AND THEN IT IS WORLD STATE**, not a held key. `PlayerState.towedCartId`
 * says which cart is in the player's hands, and from that tick the cart's tile follows the player
 * and the player walks slower — so a save loaded mid-haul comes back with the cart still in tow,
 * and a replay drags it over exactly the same subtiles. A key held down would put the tow in the
 * input layer, which is the same mistake as sending movement deltas.
 *
 * Reach-gated, because you are picking up a handle. Hitching a second cart drops the first, which
 * is the only sensible reading of a player with two hands and one back.
 */
export interface HitchCartCommand {
  type: 'HitchCart';
  cartId: number;
}

/** Let go. Free, always — the cart stands where the player was standing. */
export interface UnhitchCartCommand {
  type: 'UnhitchCart';
}

/**
 * Point an Agri-Bot dock at a Grow Zone.
 *
 * **THE ZONE IS THE BOT'S ONLY INSTRUCTION SET** (item 038's constraint): item 018 already built
 * a surface that says what should be growing where, and a dock with its own crop and its own tile
 * list would be a second answer to the same question — one that disagrees the first time somebody
 * repaints a rectangle. This command carries a zone id and nothing else, because there is nothing
 * else about a dock to configure.
 *
 * NO TOUCH AND NO REACH CHECK, exactly like `SetGrabberFilter` beside it and `CreateContract`
 * before it. Retuning a machine from a panel is paperwork; it is `RotateGrabber` — reaching out
 * and shoving something — that is the physical verb.
 */
export interface SetDockZoneCommand {
  type: 'SetDockZone';
  machineId: number;
  /** 0 to unbind. A dock with no zone has no orders and its bot parks. */
  zoneId: number;
}

// --- belts and grabbers -------------------------------------------------------------

/**
 * Lay a belt run: one straight segment, or two meeting at a right angle.
 *
 * CORNERS ARE STILL TWO SEGMENTS AND NOTHING ABOUT THE WORLD CHANGED — `belts.ts` already
 * hands an item from a belt onto whatever belt starts where its own ends, so a bend has
 * always worked once both segments existed. What did not exist was a way to ASK for one in
 * a single command, and that is the only thing these two fields buy.
 *
 * WHY ONE COMMAND RATHER THAN TWO `PlaceBelt`s FROM THE CLIENT. Two commands cannot be
 * refused together. A drag whose second leg crosses a machine, the fence, or the field would
 * lay the first leg and refuse the second, leaving a stub the player did not ask for and now
 * has to find — and `applyPlaceBelt`'s whole rule, stated on the loop below, is that a run is
 * refused WHOLE. An L is one gesture, so it is one entry in the trace and one decision by the
 * reducer. (`PlacePipe` reaches the same place by carrying a `path`; see the note below on
 * why a belt does not.)
 *
 * WHY TWO OPTIONAL FIELDS RATHER THAN A `path` ARRAY LIKE `PlacePipe`. A path can express a
 * route, and an L is explicitly not one — no pathfinding was the constraint. Origin + dir +
 * length is the belt grammar already, and a second one of exactly the same shape is the only
 * bend this can encode: it cannot zigzag, cannot double back, and cannot be handed a
 * disconnected list of tiles, because there is nowhere in the payload to put any of that.
 * The shape enforces the constraint, which is the friction `TechNode` gets its numbers-free
 * rule from. Optional rather than zero-valued so that every trace and every golden fixture
 * recorded before this existed replays byte-identically: absent means straight, which is
 * what they all were.
 *
 * THE ELBOW TILE BELONGS TO THE SECOND LEG, and the sim decides that rather than the client:
 * the second leg starts at the first leg's EXIT tile — one step past its last tile, the tile
 * `beltExitTileX/Y` already names as where it delivers. Get this backwards and the item rides
 * to the end of leg one and hands off into empty ground, which is a stall with no visible
 * cause. It is not a payload field for exactly that reason.
 */
export interface PlaceBeltCommand {
  type: 'PlaceBelt';
  tier: BeltTier;
  tileX: number;
  tileY: number;
  dir: Direction;
  lengthTiles: number;
  /**
   * The second leg's direction. Absent — or `Direction.None` — for a straight run.
   *
   * Must be PERPENDICULAR to `dir`. Parallel would be a longer straight run written in two
   * pieces and anti-parallel would be a belt doubling back onto itself; both are refused
   * rather than normalised, because a command that quietly means something other than it
   * says is worse in a trace than one that did nothing.
   */
  turnDir?: Direction;
  /** Tiles in the second leg, starting at the first leg's exit tile. Capped per leg. */
  turnLengthTiles?: number;
}

/** Take a whole segment back up. Refunds in full and returns whatever was riding it. */
export interface RemoveBeltCommand {
  type: 'RemoveBelt';
  beltId: number;
}

/**
 * Take up ONE TILE of a belt (item 084). Refunds one tile's price, hands back whatever was
 * riding that tile, and leaves the rest of the run standing: the segment is split around the
 * gap and the two survivors keep working, each backing up or starving exactly as two belts
 * that were never joined would.
 *
 * TILE-ADDRESSED, NOT ID-ADDRESSED, unlike `RemoveBelt` — and that is load-bearing rather
 * than stylistic. Segment surgery mints fresh ids (see `splitBeltAtTile`), so the second
 * tile of a drag may land on a segment that did not exist when the drag was planned. A tile
 * names the thing the player actually owns now (the owner's ruling on this item); an id
 * names a storage artefact that surgery is free to replace.
 *
 * `RemoveBelt` stays beside it on purpose: a teardown that covers EVERY tile of a segment is
 * still one decision about one object, one trace entry, and one refund — this command is for
 * the cuts that leave something behind.
 */
export interface RemoveBeltTileCommand {
  type: 'RemoveBeltTile';
  tileX: number;
  tileY: number;
}

/**
 * Turn ONE TILE of a belt one step clockwise (item 084): N → E → S → W → N.
 *
 * BELTS PLACE AS DRAGS BUT LIVE AS TILES — the owner's ruling on item 084, superseding the
 * note on `RotateGrabber` below that once excluded them. The drag grammar is unchanged and
 * still the only way to LAY belt; this is what R means over belt that is already down. The
 * containing segment is split at the tile (`splitBeltAtTile`), the tile becomes its own
 * 1-tile segment facing the new way, and the ordinary head-of-belt hand-off decides who
 * feeds whom afterwards — runs are emergent chains of tiles pointing into each other, not
 * sacred objects.
 *
 * ONE STEP, NO TARGET DIRECTION IN THE PAYLOAD, for `RotateGrabber`'s exact reason: R is a
 * nudge, the sim owns which way clockwise goes, and each press is one honest trace entry.
 * TILE-ADDRESSED for `RemoveBeltTile`'s exact reason: surgery replaces segment ids, tiles
 * are what the player owns. Junctions are machines, not belts, so R keeps ignoring them —
 * see the junction header in `belts.ts` for why they stay facing-less.
 */
export interface RotateBeltCommand {
  type: 'RotateBelt';
  tileX: number;
  tileY: number;
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

/**
 * Turn a placed arm one step clockwise.
 *
 * ONE STEP, AND NO TARGET DIRECTION IN THE PAYLOAD. R is a nudge, not a picker: the player
 * presses it until the arm points the right way, and each press is one entry in the trace
 * that says exactly what the player did. A `dir` field would let the client compute the
 * answer and send it, which is the same mistake as sending a movement delta — the client
 * would own a rule the sim is supposed to own, and two clients could disagree about which
 * way clockwise goes.
 *
 * There is no `RotateMachine` beside it because there is nothing to rotate: a machine's
 * ports are typed by LIQUID rather than by geometry (`MachineSpec.ports`), so no machine in
 * this game has a facing to turn. Belts were once excluded here too; item 084 reversed that
 * — see `RotateBelt` above, which turns one TILE of a belt and borrows this command's whole
 * argument for being a one-step nudge.
 */
export interface RotateGrabberCommand {
  type: 'RotateGrabber';
  grabberId: number;
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
  /** `CropId` for Plant, `ItemId` for Sell and Buy, 0 for the verbs that need neither. */
  item: number;
  /** Stack size for Load, Unload, Sell, and Buy. 0 otherwise. */
  count: number;
}

// --- cheats -----------------------------------------------------------------------------

/**
 * Enter a cheat code (item 075).
 *
 * **A CHEAT IS A COMMAND, AND THAT IS THE DETERMINISM RULE, NON-NEGOTIABLE.** It mutates world
 * state, so it enters the trace, the save, and the hash like any other command — a debug panel
 * that poked `moneyCents` directly would make seed + trace stop being a complete description
 * of a session, and every replay and golden fixture would silently diverge. There are no debug
 * buttons; there is this.
 *
 * ONE CODE-CARRYING COMMAND rather than a `CheatGrantMoney` + `CheatUnlockAllTech` pair, so a
 * future cheat is one branch in the reducer rather than a new command shape each time. The
 * reducer owns the code table: `klapaucius` grants $100,000 and unlocks every tech node, and
 * an UNKNOWN code is a refused no-op that never enters the trace — exactly the house refusal
 * semantics, so a typo in the console leaves no mark on the world or its log.
 *
 * Every application bumps the hashed `WorldStats.cheatsUsed`, so surfaces that care (personal
 * bests, future leaderboards — "fun, lightly validated") can annotate honestly.
 */
export interface CheatCommand {
  type: 'Cheat';
  code: string;
}

export type Command =
  | SetMoveDirectionCommand
  | WalkAndActCommand
  | CheatCommand
  | TillTileCommand
  | WaterTileCommand
  | RefillCanCommand
  | PlantTileCommand
  | HarvestTileCommand
  | SwingScytheCommand
  | ApplyFertilizerCommand
  | PackCrateCommand
  | HitchCartCommand
  | UnhitchCartCommand
  | SetDockZoneCommand
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
  | DeconstructMachineCommand
  | SellBoxedMachineCommand
  | UpgradeMachineCommand
  | ResearchTechCommand
  | BuyDeedCommand
  | LoadCartCommand
  | DispatchCartCommand
  | CreateContractCommand
  | CancelContractCommand
  | PlaceBeltCommand
  | RemoveBeltCommand
  | RemoveBeltTileCommand
  | RotateBeltCommand
  | PlaceGrabberCommand
  | SetGrabberFilterCommand
  | RotateGrabberCommand
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
