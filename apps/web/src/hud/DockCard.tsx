'use client';

// The dock card — which Grow Zone the Agri-Bot you are standing next to is working.
//
// IT OPENS BECAUSE YOU WALKED OVER, exactly like the upgrade bench, and for the same reason: plan
// §5's posture is that a machine is configured where it stands. Walk away and it closes itself.
// The two cards share the sidebar's contextual slot and can never both be there — the bench takes
// machines with a work cycle and this takes docks, which have none — so the corner shows whichever
// machine you are actually at.
//
// WHY THIS IS A CARD AND NOT A ROW IN THE BENCH is argued at length in `derive-dock.ts`. The short
// version: `acceptsUpgrades` takes machines with a dial worth selling (a work cycle, or the pump's
// rated flow), a dock has neither because its BOT does the work, and letting a dock into the bench
// means four special cases in a panel whose whole argument is that every control states its trade.
//
// WHAT THE CARD REFUSES TO DO, and it is the same refusal the bag makes:
//
//   IT DOES NOT INVENT A SECOND SET OF ORDERS. A zone already knows its crop, its priority and its
//   auto-replant flag ([[018]]); the dock is pointed at one and reads it. There is no crop picker
//   here, no tile list, and no "harvest above 80% ripe" — `SetDockZone` carries a zone id and
//   nothing else because there is nothing else about a dock to configure.
//
//   IT DOES NOT DECIDE WHICH ZONES ARE ELIGIBLE. Every zone the world has is offered, including
//   an empty one and one with no crop assigned, because a player painting a rectangle and pointing
//   a dock at it before planting is a sensible order to do things in and the sim allows it. The
//   card says what a zone IS — one-shot or regrowing, planted or bare — and lets the player decide.
//
//   IT DOES NOT ASK A MACHINE FOR AN INSTRUCTION IT CANNOT FOLLOW ([[107]]). A Drone Bay is a bot
//   dock and gets this card, but it takes no zone: its drone picks the next machine on the lot
//   that wants a wrench and flies there. So the bay's half of this file has no picker, no "no
//   zone" complaint and no stand-down — it reports the queue instead. `dock.takesZone` is the
//   branch, and `derive-dock.ts` argues why that is a different question from `isBotDockKind`.

import { useCallback } from 'react';

import { BotPhase, CONDITION_EFFECT_THRESHOLD, CONDITION_MAX, permille } from '@snack/sim';

import { zoneSwatch } from './derive-dock';
import { hudStore } from './store';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import { usePending } from './use-pending';
import type { DockSlice, DockZoneOption } from './types';

/** The bench's threshold, derived the same way and for the same reason its own note gives. */
const ROUGH_PERMILLE = permille(CONDITION_EFFECT_THRESHOLD, CONDITION_MAX);

function keepFocus(event: React.MouseEvent): void {
  event.preventDefault();
}

export function DockCard() {
  const dock = useHudSlice('dock');
  const pending = usePending();

  const point = useCallback(
    (machineId: number, zoneId: number) => {
      pending.hold(`dock:${machineId}`);
      hudStore.dispatch({ type: 'SetDockZone', machineId, zoneId });
    },
    [pending],
  );

  // Not standing at a dock. The card is not "closed" — it has no subject, which is the bench's
  // rule and the reason neither of them has an open flag to manage.
  if (dock.machineId === 0) return null;

  // The bay's card, which is a different card and not a disabled version of this one.
  if (dock.takesZone === 0) return <BayCard dock={dock} />;

  const waiting = pending.isPending(`dock:${dock.machineId}`);
  const bound = dock.boundZone !== 0;

  return (
    // `.bench` wholesale rather than a card of its own: same corner, same control, same width,
    // different question. Two at-the-machine cards laid out differently read as two games.
    <div className={cx(s.card, s.bench)}>
      <div className={s.benchHead}>
        <span className={s.benchName}>{dock.label}</span>
        <BotCondition phase={dock.botPhase} conditionPermille={dock.botConditionPermille} />
      </div>

      {/*
        THE ORDERS LINE. A dock with no zone is the failure this whole card exists to end — a $600
        shed whose bot stands in the doorway forever — so the card says so, loudly and in the tone
        of an unfinished job rather than an error. It can say it plainly now: `boundZone` is
        published, so there is no longer a third state where the panel had to keep quiet.
      */}
      <div className={cx(s.dockOrders, !bound && s.dockOrdersNone)}>
        {bound
          ? `Working ${dock.boundName === '' ? 'a zone that no longer exists' : dock.boundName}.`
          : 'No zone. Its bot has nothing to do and will stand here until it is given a rectangle.'}
      </div>

      <div className={s.benchDivider} />

      {dock.zones.length === 0 ? (
        // The honest dead end, and the one a first-time dock owner will actually hit: zones are
        // painted with the zone tool and a lot that has never been painted has none. Naming the
        // tool is not a quest — it is the answer to "point it at what?".
        <div className={s.benchLocked}>
          There are no Grow Zones on the lot yet. Paint one over the rows you want worked and this
          dock can be pointed at it.
        </div>
      ) : (
        <div className={s.dockZones}>
          {dock.zones.map((zone) => (
            <ZoneButton
              key={zone.id}
              zone={zone}
              planter={dock.planter === 1}
              active={zone.id === dock.boundZone}
              disabled={waiting}
              onPick={() => point(dock.machineId, zone.id)}
            />
          ))}
        </div>
      )}

      {/*
        Unbinding is a real thing to want — the sim takes a zone id of 0 for exactly this, "how a
        player retires a dock without boxing it" — and it is offered only when there are orders to
        drop, which the card can now tell for certain.
      */}
      {dock.zones.length > 0 && bound ? (
        <button
          type="button"
          className={s.dockStop}
          disabled={waiting}
          onMouseDown={keepFocus}
          onClick={() => point(dock.machineId, 0)}
        >
          Stand it down
        </button>
      ) : null}
    </div>
  );
}

/**
 * THE DRONE BAY'S CARD — the same corner, the same head, and not one control ([[107]]).
 *
 * **WHY IT GETS A CARD AT ALL, since the honest alternative was none.** The item allowed "no card"
 * if that was the simplest true thing, and it is not: a bay is a $200,000 machine the player walks
 * up to, and the two facts they want when they do are *is my drone alright* and *is it keeping
 * up*. Both are already in the slice — the head draws the drone's phase and condition through the
 * same `BotCondition` the farm docks use, and `serviceDue` is the length of its queue. Deleting
 * the card would have replaced a wrong answer with no answer, next to a robot that visibly does
 * something.
 *
 * **AND NOT ONE CONTROL, WHICH IS THE ACTUAL FIX.** No zone picker, because the drone never reads
 * `boundZone`. No "Stand it down", because there is nothing to stand down from — that button
 * dispatches `SetDockZone(0)`, which on a bay is a command the reducer accepts and the world
 * ignores. A bay is not configured; it is bought, and then it works.
 *
 * The three lines say, in order: what it is pointed at (nothing, deliberately), what it is doing
 * about that, and what it costs to run. The last one exists because the shelf item 090 retired
 * left a hole in the player's model — a bay that used to eat Drone Parts and now does not, with
 * a `inputCapacity` of 12 still frozen in its spec, is exactly the machine somebody stands in
 * front of wondering what to put in it.
 */
function BayCard({ dock }: { dock: DockSlice }) {
  const due = dock.serviceDue;

  return (
    <div className={cx(s.card, s.bench)}>
      <div className={s.benchHead}>
        <span className={s.benchName}>{dock.label}</span>
        <BotCondition phase={dock.botPhase} conditionPermille={dock.botConditionPermille} />
      </div>

      <div className={s.dockOrders}>
        No zone, and none to give. Its drone serves the whole lot — it flies to whatever machine
        wants a wrench next, wherever that is.
      </div>

      <div className={s.benchDivider} />

      {/*
        The queue, which is the only number on this card that moves. `serviceDue` counts the
        projection's own `wrenchDue` flags, so it is exactly the set `nextServiceTarget` scans —
        when it says nothing is due, a parked drone is a drone with nothing to do rather than a
        drone that has been given no orders, and that distinction is the entire bug this fixed.
      */}
      <div className={cx(s.zoneNote, due > 0 && s.zoneNoteWarn)}>
        {due === 0
          ? 'Nothing on the lot wants a wrench. A parked drone means the whole farm is well.'
          : `${String(due)} ${due === 1 ? 'machine wants' : 'machines want'} a wrench. It works through them one at a time, in a rotation that does not favour the machine you built first.`}
      </div>

      <div className={s.benchLocked}>
        Nothing to feed it. A service costs no parts and no money — the drone spends only its own
        condition, and any drone on the lot puts a worn one right, its own bay included.
      </div>
    </div>
  );
}

/**
 * What the robot is doing and how worn it is.
 *
 * THE CONDITION IS THE BOT'S, NOT THE DOCK'S, and that is not a technicality: `wearPerOperation`
 * on a dock spec is 0 and always will be, because §4 says Agri-Bot upkeep is per-harvest-op and
 * the operations happen out in the field. A card that drew the shed's condition would show a
 * flawless 100% next to a robot that has been failing for an hour.
 *
 * No repair button. Repair is right-click-and-hold on the dock, which is the verb the player
 * already knows from every other worn machine, and adding a second door for one machine kind
 * would make the wrench feel optional everywhere else.
 */
function BotCondition({ phase, conditionPermille }: { phase: number; conditionPermille: number }) {
  if (phase < 0) return <span className={s.benchCondition}>no bot</span>;

  const rough = conditionPermille < ROUGH_PERMILLE;
  const word =
    phase === BotPhase.Working
      ? 'working'
      : phase === BotPhase.Outbound
        ? 'heading out'
        : phase === BotPhase.Returning
          ? 'coming back'
          : 'parked';

  return (
    <span className={cx(s.benchCondition, rough && s.benchConditionLow)}>
      {word} · {Math.round(conditionPermille / 10)}%
    </span>
  );
}

/**
 * One zone, as a target.
 *
 * THE ONE-SHOT WARNING IS THE ITEM'S OWN PACING, SAID OUT LOUD. §5: "regrowing crops automate
 * first; one-shots wait for the seed-hopper bot — the crop list itself paces the arc." A harvester
 * pointed at a potato zone will clear it once and then stand in an empty field, and a player who
 * discovers that by watching an hour of nothing has learned the same lesson the expensive way. So
 * the button says it before the money is spent — as a fact about the crop, never as a refusal.
 * The planter dock is what closes that loop, so the line is only drawn for the harvester.
 */
function ZoneButton({
  zone,
  planter,
  active,
  disabled,
  onPick,
}: {
  zone: DockZoneOption;
  planter: boolean;
  active: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const oneShot = zone.regrows === 0 && zone.cropName !== '' && !planter;

  return (
    <button
      type="button"
      aria-pressed={active}
      className={cx(s.dockZone, active && s.dockZoneOn)}
      disabled={disabled}
      onMouseDown={keepFocus}
      onClick={onPick}
    >
      <span className={s.dockZoneHead}>
        {/*
          The swatch is the only thing on this button that answers "which rectangle is that?".
          Zones are called "Zone 3" until somebody renames them, and the colour is the one the
          overlay paints on the ground — so the eye matches the button to the field rather than
          reading a number and guessing.
        */}
        <span className={s.dockZoneSwatch} style={{ background: zoneSwatch(zone.id) }} />
        <span className={s.dockZoneName}>{zone.name}</span>
        <span className={s.dockZoneCrop}>
          {zone.cropName === '' ? 'no crop set' : zone.cropName}
        </span>
      </span>
      <span className={s.dockZoneCounts}>
        {zone.planted}/{zone.tiles} planted
        {zone.mature > 0 ? ` · ${zone.mature} ready` : ''}
      </span>
      {oneShot ? (
        <span className={s.dockZoneNote}>
          one-shot — a harvester clears it once and it stays bare
        </span>
      ) : null}
    </button>
  );
}
