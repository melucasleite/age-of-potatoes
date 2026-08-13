'use client';

// The dock card — which Grow Zone the Agri-Bot you are standing next to is working.
//
// IT OPENS BECAUSE YOU WALKED OVER, exactly like the upgrade bench, and for the same reason: plan
// §5's posture is that a machine is configured where it stands. Walk away and it closes itself.
// The two cards share the `midRight` corner and can never both be there — the bench takes
// machines with a work cycle and this takes docks, which have none — so the corner shows whichever
// machine you are actually at.
//
// WHY THIS IS A CARD AND NOT A ROW IN THE BENCH is argued at length in `derive-dock.ts`. The short
// version: `acceptsUpgrades` is `workPerOperation > 0`, a dock's is 0 because its BOT does the
// work, and letting a dock into the bench means four special cases in a panel whose whole argument
// is that every control states its trade.
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
//   IT DOES NOT CLAIM WHAT IT CANNOT READ. See `dockZoneOf`: `Machine.boundZone` is real world
//   state that `MachineView` does not publish yet, so on a build without it the card shows the
//   picker and says nothing about the present rather than guessing and being wrong in front of a
//   robot the player can see working.

import { useCallback } from 'react';

import { BotPhase, CONDITION_EFFECT_THRESHOLD, CONDITION_MAX, permille } from '@snack/sim';

import { ZONE_UNKNOWN, zoneSwatch } from './derive-dock';
import { hudStore } from './store';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import { usePending } from './use-pending';
import type { DockZoneOption } from './types';

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

  const waiting = pending.isPending(`dock:${dock.machineId}`);
  const known = dock.boundZone !== ZONE_UNKNOWN;
  const bound = known && dock.boundZone !== 0;

  return (
    // `.bench` wholesale rather than a card of its own: same corner, same control, same width,
    // different question. Two at-the-machine cards laid out differently read as two games.
    <div className={cx(s.card, s.bench)}>
      <div className={s.benchHead}>
        <span className={s.benchName}>{dock.label}</span>
        <BotCondition phase={dock.botPhase} conditionPermille={dock.botConditionPermille} />
      </div>

      {/*
        THE ORDERS LINE, AND ITS ABSENCE IS AS DELIBERATE AS ITS PRESENCE.

        A dock with no zone is the failure this whole card exists to end — a $600 shed whose bot
        stands in the doorway forever — so when the world says so, the card says so, loudly and in
        the tone of an unfinished job rather than an error. When the world does NOT say (a build
        whose projection has no `boundZone`), the card makes no claim at all: a wrong "no zone"
        printed over a working dock would be worse than saying nothing, because the player would
        believe the panel over the robot.
      */}
      {known ? (
        <div className={cx(s.dockOrders, !bound && s.dockOrdersNone)}>
          {bound
            ? `Working ${dock.boundName === '' ? 'a zone that no longer exists' : dock.boundName}.`
            : 'No zone. Its bot has nothing to do and will stand here until it is given a rectangle.'}
        </div>
      ) : (
        <div className={s.dockOrders}>One dock, one zone. Point it at the rows it should work.</div>
      )}

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
              active={known && zone.id === dock.boundZone}
              disabled={waiting}
              onPick={() => point(dock.machineId, zone.id)}
            />
          ))}
        </div>
      )}

      {/*
        Unbinding is a real thing to want — the sim takes a zone id of 0 for exactly this, "how a
        player retires a dock without boxing it" — and it is offered only when the dock might have
        orders to drop. On a build that cannot read the binding it is offered too, because it is a
        VERB rather than a claim: pressing it means "stop", and it is true whatever the dock was on.
      */}
      {dock.zones.length > 0 && dock.boundZone !== 0 ? (
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
