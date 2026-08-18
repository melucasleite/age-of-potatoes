// The zone verbs, from the HUD's side of the seam ([[102]]).
//
// WHAT FAILS SILENTLY HERE, which is why these are the tests that exist and not others. Every
// break this item fixed was invisible — a button that dispatches a command the sim discards
// looks exactly like a button on a laggy machine, and a reducer with no caller looks exactly
// like a feature the player has not found yet. So the gates are aimed at the four places where
// being wrong produces NOTHING VISIBLE rather than an error:
//
//   · IF THE COMMAND SHAPES DRIFT, the sim refuses them and nothing happens. `applySetZoneCrop`
//     and friends return false on a bad zone id, an unresearched crop or an unchanged value,
//     and a refused command leaves no trace entry and no log line. So these drive REAL
//     REDUCERS with the exact objects the panel dispatches, rather than asserting on a spy —
//     a spy would have passed happily for the entire life of the bug.
//   · IF `deriveLot` DROPS A FIELD, the panel cannot draw the state it just wrote. That is
//     literally what shipped: `ZoneView` published `crop`, `priority` and `autoReplant` and the
//     HUD copied the counts and threw all three away.
//   · IF THE CROP PICKER STOPS ASKING THE SIM'S GATE, it offers a crop the reducer refuses,
//     and the refusal arrives as a click that does nothing.
//   · IF THE HOPPER IS NOT ACTUALLY WIRED, the $1,200 node keeps doing nothing. The
//     five-thousand-tick pair below is the verifier's manual finding, kept.
//
// NOT COVERED, deliberately: React. There is no DOM here, so what a click does to a component
// is not exercised — the browser pass on the work item is what checked that, and its findings
// are in the agent log.

import { describe, expect, it } from 'vitest';

import {
  CropId,
  ItemId,
  TechId,
  ZONE_NAME_MAX_LENGTH,
  ZONE_PRIORITY_MAX,
  addItem,
  createWorld,
  createWorldView,
  insertUnlocked,
  step,
  stepMany,
  view,
} from '@snack/sim';
import type { Command, WorldState, WorldView } from '@snack/sim';

import { createLotFields, deriveLot } from './derive-lot';
import {
  focusZone,
  openZonePanel,
  subscribeZoneFocus,
  zoneFocusServerSnapshot,
  zoneFocusSnapshot,
} from './zone-focus';
import { closeLocalPanel, panelSnapshot } from './panel-state';
import { zoneNameShown, zoneNameToCommit } from './zone-name';

/**
 * Push one command through a real tick, the way the host does.
 *
 * The panel hands `hudStore.dispatch` a bare `Command` and the host wraps it in the tick
 * envelope; these tests keep the command objects identical to the panel's and do the wrapping
 * here, so a drift in a command's SHAPE fails loudly rather than being silently refused.
 */
function send(state: WorldState, command: Command): void {
  step(state, { tick: state.tick, commands: [command] });
}

/** A world with one zone painted over a patch of the starting field. Returns its id. */
function worldWithZone(crop: CropId = CropId.RussetPotato): { state: WorldState; zoneId: number } {
  const state = createWorld(1);
  send(state, { type: 'CreateZone', rect: { x: 0, y: 0, w: 6, h: 6 }, crop });
  const zone = state.zones[0];
  if (zone === undefined) throw new Error('no zone was painted — the starting field moved');
  return { state, zoneId: zone.id };
}

/** The projection, freshly read. The HUD only ever sees a world through this. */
function project(state: WorldState): WorldView {
  const buffer = createWorldView();
  return view(state, buffer);
}

function lotOf(state: WorldState) {
  return deriveLot(project(state), createLotFields());
}

describe('the three fields the HUD used to drop', () => {
  // The data half of the item. `ZoneView` carried all three the whole time; `deriveLot` copied
  // the counts and left these on the floor, so no surface in the app could see them.
  it('carries crop, priority and auto-replant onto the zone row', () => {
    const { state, zoneId } = worldWithZone(CropId.RussetPotato);
    insertUnlocked(state.unlocked, TechId.AutoReplant);
    send(state, { type: 'SetZonePriority', zoneId, priority: 4 });
    send(state, { type: 'SetZoneAutoReplant', zoneId, on: true });

    const row = lotOf(state).zones[0];
    expect(row?.crop).toBe(CropId.RussetPotato);
    expect(row?.cropName).toBe('Russet Potato');
    expect(row?.priority).toBe(4);
    expect(row?.autoReplant).toBe(1);
  });

  it('reports the seed stock the hopper would actually plant from', () => {
    // Relative to what the world already ships with — `createWorld` starts the player holding
    // a few potato seeds, and pinning that number here would make this test a hostage of a
    // starting-loadout change it has no opinion about.
    const { state } = worldWithZone(CropId.RussetPotato);
    const before = lotOf(state).zones[0]?.seeds ?? -1;
    expect(before).toBeGreaterThanOrEqual(0);
    addItem(state, ItemId.PotatoSeed, 7);
    expect(lotOf(state).zones[0]?.seeds).toBe(before + 7);
  });

  it('says "fallow" rather than nothing for a rectangle with no crop', () => {
    const { state } = worldWithZone(CropId.None);
    const row = lotOf(state).zones[0];
    expect(row?.crop).toBe(CropId.None);
    expect(row?.cropName).toBe('');
  });
});

describe('the crop picker offers exactly what the reducer accepts', () => {
  // THE GATE IS THE SIM'S. `applySetZoneCrop` refuses any crop whose `requiresTech` is
  // unresearched; a picker with its own list would offer one and the refusal would arrive as
  // nothing happening — indistinguishable, to a player, from the bug this item fixed.
  it('withholds a crop whose tech is unresearched, and offers it the moment it is not', () => {
    const { state } = worldWithZone();

    const before = lotOf(state).cropOptions.map((option) => option.id);
    expect(before).toContain(CropId.None); // fallow is always assignable
    expect(before).toContain(CropId.RussetPotato); // the starter crop needs no tech
    expect(before).not.toContain(CropId.SugarCane);

    insertUnlocked(state.unlocked, TechId.Cane);
    expect(lotOf(state).cropOptions.map((option) => option.id)).toContain(CropId.SugarCane);
  });

  it('never offers a crop the reducer would throw away', () => {
    const { state, zoneId } = worldWithZone();
    insertUnlocked(state.unlocked, TechId.Cane);

    // Every offered crop, dispatched exactly as the panel dispatches it, must LAND. `step`
    // returns nothing — a refused command is a silent no-op, which is the whole difficulty
    // this item is about — so the world is asked afterwards instead of the return value.
    for (const option of lotOf(state).cropOptions) {
      send(state, { type: 'SetZoneCrop', zoneId, crop: option.id as CropId });
      expect(state.zones[0]?.crop, `${option.name} was refused by the reducer`).toBe(option.id);
    }
  });

  it('counts the seeds behind each crop, because that is the question being asked', () => {
    const { state } = worldWithZone();
    const russetSeeds = () =>
      lotOf(state).cropOptions.find((option) => option.id === CropId.RussetPotato);
    const before = russetSeeds()?.seeds ?? -1;
    addItem(state, ItemId.PotatoSeed, 3);
    expect(russetSeeds()?.seeds).toBe(before + 3);
    expect(russetSeeds()?.seedItem).toBe(ItemId.PotatoSeed);
  });
});

describe('the seed hopper, which was $1,200 for nothing', () => {
  // ⚠️ THE FINDING, KEPT AS A TEST. The verifier ran this by hand: a fully-researched world,
  // 5,000 ticks, ZERO tiles replanted, because `SetZoneAutoReplant` had no caller anywhere in
  // the app. Fed the reducer directly, the same window replanted. The mechanism was perfect and
  // unreachable — so what this pins is not the mechanism (that is `zones.ts`'s own business)
  // but that the command the PANEL sends is the one that switches it on.
  const REPLANT_WINDOW = 5_000;

  function armedRun(on: boolean): number {
    const { state, zoneId } = worldWithZone(CropId.RussetPotato);
    insertUnlocked(state.unlocked, TechId.AutoReplant);
    addItem(state, ItemId.PotatoSeed, 50);
    // The panel's own command object, character for character with `ZonePanel.tsx`'s.
    send(state, { type: 'SetZoneAutoReplant', zoneId, on });
    const before = lotOf(state).zones[0]?.planted ?? 0;
    stepMany(state, REPLANT_WINDOW);
    return (lotOf(state).zones[0]?.planted ?? 0) - before;
  }

  it('replants nothing while the zone is disarmed', () => {
    expect(armedRun(false)).toBe(0);
  });

  it('replants once the panel arms it', () => {
    expect(armedRun(true)).toBeGreaterThan(0);
  });

  it('is refused outright until the node is researched — the lock is in the sim', () => {
    // This is why the toggle draws an explanation rather than a disabled button when the node
    // is unowned: a control that dispatched here would be a control that lies about being one.
    const { state, zoneId } = worldWithZone();
    send(state, { type: 'SetZoneAutoReplant', zoneId, on: true });
    expect(state.zones[0]?.autoReplant).toBe(false);
    expect(lotOf(state).autoReplantOwned).toBe(0);

    insertUnlocked(state.unlocked, TechId.AutoReplant);
    expect(lotOf(state).autoReplantOwned).toBe(1);
    send(state, { type: 'SetZoneAutoReplant', zoneId, on: true });
    expect(state.zones[0]?.autoReplant).toBe(true);
  });
});

describe('priority and rename', () => {
  it('sets a priority the sim keeps', () => {
    const { state, zoneId } = worldWithZone();
    send(state, { type: 'SetZonePriority', zoneId, priority: ZONE_PRIORITY_MAX });
    expect(lotOf(state).zones[0]?.priority).toBe(ZONE_PRIORITY_MAX);
  });

  it('renames a zone, and the name survives the projection', () => {
    const { state, zoneId } = worldWithZone();
    expect(lotOf(state).zones[0]?.name).toBe('Zone 1');
    send(state, { type: 'RenameZone', zoneId, name: 'North Field' });
    expect(lotOf(state).zones[0]?.name).toBe('North Field');
  });

  it('clips a long name at the sim`s own limit, which is the field`s maxLength', () => {
    // The panel imports `clipZoneName` rather than reimplementing it, so the input and the
    // reducer cannot disagree about the 24th character.
    const { state, zoneId } = worldWithZone();
    send(state, { type: 'RenameZone', zoneId, name: 'x'.repeat(80) });
    expect(lotOf(state).zones[0]?.name.length).toBe(ZONE_NAME_MAX_LENGTH);
  });
});

describe('which zone the panel is describing', () => {
  // Held as an id rather than an index, so a zone absorbed out of the middle of the list does
  // not silently re-point the detail pane at a stranger while the player is reading it.
  it('remembers a zone and tells its subscribers', () => {
    let beats = 0;
    const stop = subscribeZoneFocus(() => {
      beats += 1;
    });
    focusZone(0);
    focusZone(7);
    expect(zoneFocusSnapshot()).toBe(7);
    expect(beats).toBe(1);

    // Idempotent: re-selecting the same zone is not a state change and must not notify, or the
    // panel re-renders on every publish that happens to re-run the handler.
    focusZone(7);
    expect(beats).toBe(1);
    stop();
    focusZone(0);
    expect(beats).toBe(1);
  });

  it('renders nothing chosen on the server', () => {
    expect(zoneFocusServerSnapshot()).toBe(0);
  });

  it('opens the panel on the zone the field card names, and never toggles it shut', () => {
    // OPEN, NEVER TOGGLE — clicking a second zone while the panel is up means "show me that
    // one instead", and a toggle would shut the panel in the face of a player clicking two
    // rows in a row.
    closeLocalPanel();
    openZonePanel(3);
    expect(panelSnapshot()).toBe('zones');
    expect(zoneFocusSnapshot()).toBe(3);

    openZonePanel(5);
    expect(panelSnapshot()).toBe('zones');
    expect(zoneFocusSnapshot()).toBe(5);
    closeLocalPanel();
  });
});

/**
 * THE NAME BOX, AND WHAT IS AND IS NOT PINNED HERE ([[108]]).
 *
 * The bug had two halves. This file can hold one of them completely and the other not at all,
 * and pretending otherwise would be worse than saying so:
 *
 *   · PINNED — what a draft MEANS. Every exit gesture routes to one `commit`, and `commit` is
 *     `zoneNameToCommit` plus a dispatch. So "what is sent when the player leaves the field"
 *     is one pure question with one answer, and it is exhaustively covered below, including
 *     the empty-name ruling and the readout invariant that makes two names for one zone
 *     unrepresentable.
 *   · NOT PINNED — that the four gestures actually reach it. That is `focusout` vs `blur`,
 *     capture-phase listeners and unmount ordering, and it needs a DOM. There is no jsdom and
 *     no testing-library in this repo, and installing one mid-run — while other lanes are
 *     running the suite — is a bigger change than the bug. The wiring was verified in Chrome
 *     with real mouse events instead; the findings are in the work item's agent log.
 */
describe('what a typed zone name means', () => {
  it('sends the trimmed, clipped name when it is genuinely new', () => {
    expect(zoneNameToCommit('North Field', 'Zone 1')).toBe('North Field');
    expect(zoneNameToCommit('  North Field  ', 'Zone 1')).toBe('North Field');
    expect(zoneNameToCommit('x'.repeat(80), 'Zone 1')).toBe('x'.repeat(ZONE_NAME_MAX_LENGTH));
  });

  // THE RULING: an empty or whitespace name KEEPS THE OLD ONE. `applyRenameZone` refuses a
  // zero-length name anyway, so a generated default here would be the panel and the reducer
  // disagreeing about what a blank box means — and there is no such thing as a nameless zone.
  it('keeps the old name when the box is empty or nothing but whitespace', () => {
    expect(zoneNameToCommit('', 'North Field')).toBeNull();
    expect(zoneNameToCommit('   ', 'North Field')).toBeNull();
    expect(zoneNameToCommit('\t \n', 'North Field')).toBeNull();
  });

  it('sends nothing when the name has not actually changed', () => {
    expect(zoneNameToCommit('North Field', 'North Field')).toBeNull();
    // Trimmed first, so re-committing a name the player only added a space to is still a no-op
    // rather than a command the sim refuses and a trace entry nobody asked for.
    expect(zoneNameToCommit('  North Field ', 'North Field')).toBeNull();
  });

  it('sends nothing when there is no draft at all', () => {
    // Every exit calls commit and several fire for one gesture — pointer down on the ESC
    // button, then the unmount that follows it. A null draft is what makes that idempotent.
    expect(zoneNameToCommit(null, 'North Field')).toBeNull();
  });

  // The second bug wearing the first one's coat: the shipped box kept a discarded draft on
  // screen, so the panel showed `South Field` in the box and `North Field` on the row for one
  // rectangle. A commit always returns the draft to null, and a null draft renders the world's
  // own string — the same one `ZoneButton` prints — so the disagreement has no representation.
  it('shows the world`s own name whenever nobody is typing', () => {
    expect(zoneNameShown(null, 'North Field')).toBe('North Field');
    expect(zoneNameShown('South Fiel', 'North Field')).toBe('South Fiel');
    // And it tracks a rename that came from somewhere else, which `defaultValue` could not:
    // an uncontrolled field is seeded once at mount and never hears about the world again.
    expect(zoneNameShown(null, 'Renamed Elsewhere')).toBe('Renamed Elsewhere');
  });

  it('agrees with the reducer about every name it is willing to send', () => {
    // The pair, end to end: what the policy hands over is what the sim keeps. A policy that
    // sent a name `applyRenameZone` refuses would be a commit path that looks identical, from
    // the player's chair, to the bug this item was filed about.
    const { state, zoneId } = worldWithZone();
    const name = zoneNameToCommit('  South Field  ', 'Zone 1');
    expect(name).not.toBeNull();
    send(state, { type: 'RenameZone', zoneId, name: name as string });
    expect(lotOf(state).zones[0]?.name).toBe('South Field');
  });
});
