// Structural gates for the simulation core.
//
// These are the cheap checks that catch a broken determinism guarantee the day it breaks.
// The standing golden fixtures and the CI job that runs them belong to work item 003; this
// file is the seed they grow from.

import { describe, expect, it } from 'vitest';

import {
  type Command,
  type WorldState,
  CropId,
  Direction,
  FIELD_ORIGIN_X,
  FIELD_ORIGIN_Y,
  BeltTier,
  GrabberTier,
  IntentAction,
  ItemId,
  LampState,
  MachineKind,
  TECH_NODES,
  TICKS_PER_IN_GAME_DAY,
  beltInsert,
  createWorld,
  createWorldView,
  deriveStream,
  findNonIntegerFields,
  hashState,
  inGameDays,
  itemCount,
  nextUint32,
  spawnBelt,
  spawnGrabber,
  step,
  stepMany,
  tileAt,
  view,
} from '../src/index';

/**
 * A fixed script: plant, water, walk to the sell bin, sell, walk back. Enough to move the
 * player, draw from two RNG streams, touch money, and exercise five command variants.
 */
function scriptedCommands(tick: number): Command[] {
  switch (tick) {
    case 0:
      return [{ type: 'PlantTile', tileX: 8, tileY: 11, crop: CropId.RussetPotato }];
    case 1:
      return [{ type: 'WaterTile', tileX: 8, tileY: 11 }];
    case 2:
      return [
        { type: 'PlantTile', tileX: 7, tileY: 11, crop: CropId.RussetPotato },
        { type: 'WaterTile', tileX: 7, tileY: 11 },
      ];
    case 3:
      return [{ type: 'SetMoveDirection', dir: Direction.West }];
    case 33:
      return [{ type: 'SetMoveDirection', dir: Direction.None }];
    case 40:
      return [{ type: 'SellItem', item: ItemId.PotatoSeed, count: 2 }];
    case 41:
      return [{ type: 'SetMoveDirection', dir: Direction.East }];
    case 71:
      return [{ type: 'SetMoveDirection', dir: Direction.None }];
    case 90:
      return [{ type: 'WaterTile', tileX: 8, tileY: 11 }];
    default:
      return [];
  }
}

function runScript(seed: number, ticks: number): WorldState {
  const state = createWorld(seed);
  for (let i = 0; i < ticks; i++) {
    step(state, { tick: state.tick, commands: scriptedCommands(state.tick) });
  }
  return state;
}

describe('determinism', () => {
  it('produces the same hash for the same seed and command list', () => {
    expect(hashState(runScript(1234, 1000))).toBe(hashState(runScript(1234, 1000)));
  });

  it('pins the scripted run to a known hash', () => {
    // If this changes, either the sim changed on purpose or determinism broke by accident.
    // There is no third option, which is the entire point of the fixture.
    // f34ea50f -> 976351e8 in wave 14 (item 110): the digest gained `machine.cargoFreshTicks`
    // (save format 18), the clock a container's cargo is running on. Checked rather than
    // assumed: with that one line held out of the digest this script reproduces f34ea50f
    // exactly. The hash moved because the digest did, which is the whole reason a format bump
    // moves every world at once.
    // e97c57ee -> f48076eb with format 13 (item 066): the digest gained the field tiles'
    // coordinates and the soil-memory ledger; the scripted run's behaviour is unchanged.
    // ea1510a9 -> f34ea50f in wave 12 (item 088): the digest gained the bot seed pocket and the
    // harvester dock's seed shelf (save format 16). This script owns no bot and no dock, so all
    // four fields are zero and the run's behaviour is unchanged — the hash moved because the
    // digest did, which is the whole reason a format bump moves every world at once.
    // f48076eb -> ea1510a9 in wave 11 (items 073 + 075): the can starts at 20 charges
    // instead of 8 (`player.canCharges` is hashed), and the digest gained
    // `stats.cheatsUsed`. The script's behaviour is otherwise unchanged.
    // f34ea50f -> 976351e8 -> db18e797 (save format 19, item 111): the digest gained
    // `machine.outputItem`, the name of whatever is in a machine's output basket, which a
    // count alone stopped being able to carry the day a Seasoner learned four recipes. Checked
    // rather than assumed, the same way the line above was: with that one `d.num` held out of
    // the digest this script reproduces 976351e8 exactly, so the run's behaviour is unchanged
    // and the hash moved because the digest did.
    // db18e797 -> 401ffb95 (save format 20, item 112): the digest gained the other four places
    // a good can sit and grow old — `machine.inputFreshTicks` (one per hopper line, length-
    // prefixed), `machine.outputFreshTicks`, `Grabber.heldFreshTicks`, and `freshTicks` on every
    // item riding a belt. Checked the same way and worth stating precisely, because this item
    // changed BEHAVIOUR as well as shape: with those four `d.num` families held out of the
    // digest, this script and all twenty golden fixtures reproduce their previous hashes
    // EXACTLY. So nothing any of them does was altered — no fixture runs long enough for a
    // clock to expire, and every remaining hashed byte, `stacks[].spoilAtTick` included, is
    // identical. The hash moved because the digest did.
    //
    // 0709cd8a -> dc4bb515 (save format 23, item 140): the digest LOST three `d.num` calls per
    // reservoir — `levelMl`, `capacityMl` and `rechargeAccum` — because an unlimited pond has no
    // level to record. Shape again, and proved the same way: with those three held out of the
    // OLD digest, this script and nineteen of the twenty-one golden fixtures reproduce their new
    // hashes exactly. (The two that do not, `flavour-line` and `bottle-return`, replay `Cheat`,
    // which unlocks every node in `TECH_NODES` — and there is one fewer node.) This script has
    // no pump, so it never drew a millilitre either way.
    expect(hashState(runScript(1234, 1000))).toBe('dc4bb515');
  });

  it('gives different seeds different worlds', () => {
    expect(hashState(createWorld(1))).not.toBe(hashState(createWorld(2)));
  });

  it('gives the same seed identical empty worlds', () => {
    expect(hashState(createWorld(7))).toBe(hashState(createWorld(7)));
  });

  it('survives a JSON round trip', () => {
    const state = runScript(99, 500);
    const revived = JSON.parse(JSON.stringify(state)) as WorldState;
    expect(hashState(revived)).toBe(hashState(state));
  });

  it('keeps every hashed field an integer', () => {
    expect(findNonIntegerFields(runScript(1234, 1000))).toEqual([]);
  });

  it('makes a stray float visible', () => {
    const state = runScript(1234, 200);
    const clean = hashState(state);
    state.field[0]!.moisture = 12.5;
    expect(hashState(state)).not.toBe(clean);
    expect(findNonIntegerFields(state)).toEqual(['field[0].moisture = 12.5']);
  });
});

describe('rng streams', () => {
  it('leaves existing streams untouched when a new consumer is registered', () => {
    const before = hashState(runScript(1234, 1000));

    // A throwaway system nobody had thought of yet, drawn from hard.
    const newcomer = deriveStream(1234, 'crop-disease' as never);
    for (let i = 0; i < 64; i++) nextUint32(newcomer);

    expect(hashState(runScript(1234, 1000))).toBe(before);
  });

  it('derives independent streams per system', () => {
    const growth = deriveStream(42, 'crop-growth' as never);
    const harvest = deriveStream(42, 'harvest' as never);
    expect(nextUint32(growth)).not.toBe(nextUint32(harvest));
  });
});

describe('the trace', () => {
  it('holds exactly the applied commands, in application order', () => {
    const state = runScript(1234, 100);
    const applied = state.trace.map((entry) => `${entry.tick}:${entry.command.type}`);

    expect(applied).toEqual([
      '0:PlantTile',
      '1:WaterTile',
      '2:PlantTile',
      '2:WaterTile',
      '3:SetMoveDirection',
      '33:SetMoveDirection',
      // The script's tick-40 `SellItem` is NOT here, and that absence is the point. It sells
      // two potato seeds, and the sell bin no longer buys seeds — so the command is refused and
      // a refused command never reaches the trace. The script keeps issuing it deliberately:
      // `canary-1000`'s command list is frozen input, and a verb the simulation started
      // rejecting is a finding worth keeping in front of whoever reads this next.
      '41:SetMoveDirection',
      '71:SetMoveDirection',
      '90:WaterTile',
    ]);
  });

  it('does not record rejected commands', () => {
    const state = createWorld(5);
    // Way out of reach, and there is no field tile there anyway.
    step(state, { tick: 0, commands: [{ type: 'WaterTile', tileX: 0, tileY: 0 }] });
    expect(state.trace).toHaveLength(0);
  });

  // ONE GESTURE, ONE ENTRY — the rule zones and pipe runs are each already pinned by, and the
  // one a walk-to errand is most likely to break, because it is the only command that stays
  // live for dozens of ticks and every one of those ticks is a chance to append something.
  // It would break SILENTLY: the trace is excluded from the hash and from the save, so the
  // golden fixtures cannot see it and nothing else in this suite would fail.
  it('records a whole errand as exactly one entry, however long the walk', () => {
    const state = createWorld(77);
    const before = state.trace.length;
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'WalkAndAct', action: IntentAction.Water, tileX: 4, tileY: 4, item: 0, count: 0 },
      ],
    });
    expect(state.player.intent).not.toBeNull();

    let walked = 0;
    while (state.player.intent !== null && walked < 500) {
      step(state, { tick: state.tick, commands: [] });
      walked++;
    }

    // The walk has to be real, or this test passes for the wrong reason.
    expect(walked).toBeGreaterThan(1);
    expect(state.player.intent).toBeNull();
    expect(state.trace.length - before).toBe(1);
    expect(state.trace[state.trace.length - 1]!.command.type).toBe('WalkAndAct');
  });
});

describe('walk-to errands', () => {
  // THE OTHER HALF OF "MANUAL CONTROL ALWAYS WINS". `applySetMoveDirection` covers the player
  // who grabs the wheel DURING a walk. This is the half that was missing: the player who was
  // ALREADY holding a direction when they clicked. Their key sends no second command — there
  // is nothing to change — so nothing was left to cancel the errand, and the click overruled
  // the key they were still holding down.
  it('refuses an errand while a movement key is held', () => {
    const state = createWorld(77);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.North }],
    });

    const before = state.trace.length;
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'WalkAndAct', action: IntentAction.Water, tileX: 4, tileY: 4, item: 0, count: 0 },
      ],
    });

    expect(state.player.intent).toBeNull();
    // Refused, not queued — a pending errand that fired on key release would be the farmer
    // walking off on their own, which is the surprise the whole feature exists to avoid.
    expect(state.trace.length).toBe(before);
    expect(state.player.moveDir).toBe(Direction.North);
  });

  it('takes the errand once the key is released', () => {
    const state = createWorld(77);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.North }],
    });
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.None }],
    });
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'WalkAndAct', action: IntentAction.Water, tileX: 4, tileY: 4, item: 0, count: 0 },
      ],
    });

    expect(state.player.intent).not.toBeNull();
  });

  // ±Infinity IS an integer as far as `Math.trunc(x) !== x` is concerned, and this guard is
  // the only thing standing between a command payload and the save file. An infinite count
  // reached world state and then made the world refuse to serialize.
  it('refuses a non-finite payload rather than storing it in the world', () => {
    const state = createWorld(77);
    for (const bad of [Infinity, -Infinity, NaN, 1.5]) {
      step(state, {
        tick: state.tick,
        commands: [
          {
            type: 'WalkAndAct',
            action: IntentAction.Water,
            tileX: 4,
            tileY: 4,
            item: 0,
            count: bad,
          },
        ],
      });
      expect(state.player.intent).toBeNull();
    }
  });
});

describe('the v0.1 loop', () => {
  it('grows, harvests, and sells a potato', () => {
    const state = createWorld(2026);
    const tileX = FIELD_ORIGIN_X + 4;
    const tileY = FIELD_ORIGIN_Y + 7;

    step(state, {
      tick: state.tick,
      commands: [{ type: 'PlantTile', tileX, tileY, crop: CropId.RussetPotato }],
    });
    expect(tileAt(state, tileX, tileY)?.crop).toBe(CropId.RussetPotato);

    // Keep it watered until it is ready. Growth accrues only on watered ticks.
    for (let i = 0; i < 3000; i++) {
      if (i % 100 === 0) {
        step(state, { tick: state.tick, commands: [{ type: 'WaterTile', tileX, tileY }] });
      } else {
        stepMany(state, 1);
      }
    }

    const potatoesBefore = itemCount(state, ItemId.RussetPotato);
    step(state, { tick: state.tick, commands: [{ type: 'HarvestTile', tileX, tileY }] });
    const harvested = itemCount(state, ItemId.RussetPotato) - potatoesBefore;
    expect(harvested).toBeGreaterThan(0);

    // Walk west to the sell bin. 30 ticks at 4 tiles/s covers exactly six tiles.
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.West }],
    });
    stepMany(state, 29);
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.None }],
    });

    const moneyBefore = state.moneyCents;
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SellItem', item: ItemId.RussetPotato, count: harvested }],
    });
    expect(state.moneyCents).toBeGreaterThan(moneyBefore);
    expect(state.stats.lifetimeEarnedCents).toBeGreaterThan(0);
  });

  it('waters a patch from a filled sprinkler and bills the water to the refill', () => {
    const state = createWorld(77);
    state.moneyCents = 100_000;

    const tileX = FIELD_ORIGIN_X - 1;
    const tileY = FIELD_ORIGIN_Y + 1;
    state.player.xSub = tileX * 256 + 128;
    state.player.ySub = tileY * 256 + 128;

    step(state, {
      tick: state.tick,
      commands: [{ type: 'PlaceMachine', kind: MachineKind.Sprinkler, tileX, tileY }],
    });
    const sprinkler = state.machines[state.machines.length - 1]!;
    expect(sprinkler.kind).toBe(MachineKind.Sprinkler);

    step(state, {
      tick: state.tick,
      commands: [{ type: 'RefillHopper', machineId: sprinkler.id }],
    });
    expect(state.stats.waterDrawnMl).toBeGreaterThan(0);
    expect(state.stats.touches.hopperRefill).toBe(1);

    const drawnAfterRefill = state.stats.waterDrawnMl;
    stepMany(state, 5);
    expect(tileAt(state, FIELD_ORIGIN_X, tileY)?.moisture).toBeGreaterThan(0);
    // Pouring from its own barrel is not a second draw on the reservoir.
    expect(state.stats.waterDrawnMl).toBe(drawnAfterRefill);
  });
});

describe('the view seam', () => {
  it('returns plain data that does not alias live state', () => {
    const state = runScript(11, 300);
    const buffer = createWorldView();
    const projected = view(state, buffer);

    const before = projected.field.moisturePermille[0];
    state.field[0]!.moisture = 0;
    expect(projected.field.moisturePermille[0]).toBe(before);

    // Plain enough to survive the trip a Worker would put it through.
    expect(() => JSON.stringify(projected)).not.toThrow();
    expect(view(state, buffer)).toBe(buffer);
  });

  // The renderer draws a destination marker off these four integers, and the whole reason
  // they are integers rather than a nullable object is that the projection buffer is
  // allocated once and reused forever.
  it('publishes no errand as a zero action', () => {
    const state = createWorld(77);
    const projected = view(state, createWorldView());

    expect(state.player.intent).toBeNull();
    expect(projected.player.intentAction).toBe(0);
  });

  it('publishes the errand target while one is pending', () => {
    const state = createWorld(77);
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'WalkAndAct', action: IntentAction.Water, tileX: 4, tileY: 4, item: 0, count: 0 },
      ],
    });

    const projected = view(state, createWorldView());
    expect(projected.player.intentAction).toBe(IntentAction.Water);
    expect(projected.player.intentTileX).toBe(4);
    expect(projected.player.intentTileY).toBe(4);
    expect(projected.player.intentIssuedTick).toBe(state.player.intent!.issuedTick);
  });

  // THE BUG THIS BUFFER DESIGN INVITES, pinned: an errand that ended must not leave last
  // frame's marker sitting on the map. It fails silently — the world is correct and only the
  // picture is wrong — which is exactly the kind this file exists to catch.
  it('clears the errand out of the reused buffer when it ends', () => {
    const state = createWorld(77);
    const buffer = createWorldView();
    step(state, {
      tick: state.tick,
      commands: [
        { type: 'WalkAndAct', action: IntentAction.Water, tileX: 4, tileY: 4, item: 0, count: 0 },
      ],
    });
    expect(view(state, buffer).player.intentAction).toBe(IntentAction.Water);

    // Manual control abandons it, and the very next projection must say so.
    step(state, {
      tick: state.tick,
      commands: [{ type: 'SetMoveDirection', dir: Direction.South }],
    });
    expect(state.player.intent).toBeNull();

    const after = view(state, buffer);
    expect(after.player.intentAction).toBe(0);
    expect(after.player.intentTileX).toBe(0);
    expect(after.player.intentTileY).toBe(0);
    expect(after.player.intentIssuedTick).toBe(0);
  });

  it('puts a lamp on every grabber arm: amber starved, red blocked, green working', () => {
    // Plan §5's grammar, on the arm — "belt gaps mean look upstream, jams mean look
    // downstream" is only a diagnostic if the two are distinguishable, and a starved arm and a
    // blocked one look identical from ten tiles up without it.
    //
    // **AND SINCE ITEM 085 THE LAMP IS THE WHOLE DIAGNOSTIC.** An arm no longer picks up what
    // its destination will refuse, so the stuck arm holding a hostage — which used to be how a
    // player spotted a mis-aimed belt — has mostly stopped existing. Red now has to fire on an
    // EMPTY arm whose next pickup would be refused, or that belt looks merely idle.
    const state = createWorld(77);

    // Nothing behind it and nothing in front: it reaches back every tick and finds nothing.
    const arm = spawnGrabber(state, GrabberTier.Mk1, 5, 5, Direction.East, 0)!;
    stepMany(state, 5);
    expect(view(state, createWorldView()).grabbers[0]!.lamp).toBe(LampState.Starved);

    // Holding something with nowhere to put it: the mid-swing stall item 085 left standing.
    arm.held = ItemId.PlainChips;
    arm.cooldown = 0;
    stepMany(state, 1);
    expect(view(state, createWorldView()).grabbers[0]!.lamp).toBe(LampState.Blocked);

    // Mid-swing is a working arm.
    arm.cooldown = 5;
    expect(view(state, createWorldView()).grabbers[0]!.lamp).toBe(LampState.Running);

    // EMPTY-HANDED AND STILL RED: a belt behind it with goods on it, bare ground in front. The
    // arm holds nothing and never will — and this is the case the old two-field lamp could not
    // see, because `held === 0` used to mean amber unconditionally.
    arm.held = 0;
    arm.cooldown = 0;
    const feed = spawnBelt(state, BeltTier.Basic, 4, 5, Direction.East, 1)!;
    beltInsert(feed, 0, ItemId.PlainChips);
    stepMany(state, 1);
    expect(view(state, createWorldView()).grabbers[0]!.lamp).toBe(LampState.Blocked);
    expect(arm.held).toBe(0);
    expect(feed.items).toHaveLength(1);
  });

  it('projects the untouched-line counter the third Charter is read off', () => {
    const state = createWorld(78);
    state.stats.longestUntouchedMachineTicks = 3 * TICKS_PER_IN_GAME_DAY;

    const projected = view(state, createWorldView());
    expect(projected.stats.longestUntouchedMachineTicks).toBe(3 * TICKS_PER_IN_GAME_DAY);
    // Published in ticks; the panel divides. Three whole days, and the sim never says "days".
    expect(inGameDays(projected.stats.longestUntouchedMachineTicks)).toBe(3);
  });

  it('projects the gross and spend halves of the lifetime ledger', () => {
    const state = runScript(11, 300);
    const projected = view(state, createWorldView());

    expect(projected.stats.lifetimeEarnedCents).toBe(state.stats.lifetimeEarnedCents);
    expect(projected.stats.lifetimeSpentCents).toBe(state.stats.lifetimeSpentCents);
    // The net figure the HUD already showed is the difference of the two, so a report that
    // prints all three cannot contradict itself.
    expect(projected.stats.lifetimeNetEarningsCents).toBe(
      projected.stats.lifetimeEarnedCents - projected.stats.lifetimeSpentCents,
    );
  });
});

// --- the cheat command (item 075) ---------------------------------------------------
//
// A cheat is a COMMAND — it enters the trace, the save, and the hash like any other, which
// is the only reason a cheated session can still replay. This suite plus the round-trip in
// `save.test.ts` is what lets `Cheat` sit in `GOLDEN_COVERAGE_EXEMPT`: the determinism claim
// a fixture would make is asserted here instead.

describe('the cheat command', () => {
  it('klapaucius grants $100,000 and unlocks every tech node, counting one cheat', () => {
    const state = createWorld(75);
    const moneyBefore = state.moneyCents;
    const earnedBefore = state.stats.lifetimeEarnedCents;
    const trace = state.trace.length;

    step(state, { tick: state.tick, commands: [{ type: 'Cheat', code: 'klapaucius' }] });

    expect(state.moneyCents).toBe(moneyBefore + 10_000_000);
    expect(state.unlocked.length).toBe(TECH_NODES.length);
    for (const node of TECH_NODES) expect(state.unlocked).toContain(node.id);
    // The unlock list stays sorted — the invariant the hash depends on.
    expect([...state.unlocked].sort()).toEqual(state.unlocked);
    expect(state.stats.cheatsUsed).toBe(1);
    // One trace entry: the cheat is in the log, exactly once, like any applied command.
    expect(state.trace.length).toBe(trace + 1);
    expect(state.trace[state.trace.length - 1]!.command.type).toBe('Cheat');
    // The money was conjured, never earned: First Ten's ledger is not for sale.
    expect(state.stats.lifetimeEarnedCents).toBe(earnedBefore);
  });

  it('refuses an unknown code without a trace entry, a counter tick, or any change', () => {
    // Twin worlds: one is fed the typo, one is fed nothing. If the refusal leaves any mark
    // at all — a counter, a trace entry, a hashed anything — the twins separate.
    const typo = createWorld(76);
    const silent = createWorld(76);
    stepMany(typo, 3);
    stepMany(silent, 3);

    step(typo, { tick: typo.tick, commands: [{ type: 'Cheat', code: 'xyzzy' }] });
    step(silent, { tick: silent.tick, commands: [] });

    expect(typo.trace.length).toBe(silent.trace.length);
    expect(typo.stats.cheatsUsed).toBe(0);
    expect(hashState(typo)).toBe(hashState(silent));
  });

  it('replays deterministically: same seed, same cheat, same hash', () => {
    const play = (): WorldState => {
      const state = createWorld(7_500);
      stepMany(state, 10);
      step(state, { tick: state.tick, commands: [{ type: 'Cheat', code: 'klapaucius' }] });
      // Spend the proceeds on something gated, so the unlock is exercised, not just listed.
      step(state, {
        tick: state.tick,
        commands: [{ type: 'PlaceMachine', kind: MachineKind.Pump, tileX: 12, tileY: 12 }],
      });
      stepMany(state, 200);
      return state;
    };

    const first = play();
    const second = play();
    expect(hashState(second)).toBe(hashState(first));
    expect(first.machines.some((m) => m.kind === MachineKind.Pump)).toBe(true);
  });

  it('applies twice honestly: money stacks, unlocks stay put, the counter reaches two', () => {
    const state = createWorld(77);
    step(state, { tick: state.tick, commands: [{ type: 'Cheat', code: 'klapaucius' }] });
    const moneyAfterFirst = state.moneyCents;
    step(state, { tick: state.tick, commands: [{ type: 'Cheat', code: 'klapaucius' }] });

    expect(state.moneyCents).toBe(moneyAfterFirst + 10_000_000);
    expect(state.unlocked.length).toBe(TECH_NODES.length);
    expect(state.stats.cheatsUsed).toBe(2);
  });

  it('publishes the counter on the view, so a surface can annotate a cheated best', () => {
    const state = createWorld(78);
    step(state, { tick: state.tick, commands: [{ type: 'Cheat', code: 'klapaucius' }] });
    expect(view(state, createWorldView()).stats.cheatsUsed).toBe(1);
  });
});
