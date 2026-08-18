// The pour differ's silence ([[081]]), pinned from the audio side.
//
// The render differ (`farm-fx.test.ts`) and this one read the SAME signal —
// `FieldView.lastPouredTick` — and item 081 turned the hand-can's saturated pour into a
// sim-side refusal that marks nothing. What fails QUIETLY without this test: someone
// "fixes" the missing splash by re-inferring a pour from the click or from moisture, and
// a refused pour starts playing water again — feedback on nothing happening, the exact
// lie item 064 was filed against, inverted.
//
// The scheduler is stubbed to a queue recorder: everything asserted is which events the
// differ pushed, and a real Scheduler would only add beat arithmetic between us and that.

import { describe, expect, it } from 'vitest';
import { SUBTILE, createWorldView } from '@snack/sim';
import type { WorldView } from '@snack/sim';

import { WorldObserver } from './observer';
import { SoundId } from './sounds';
import type { QueuedEvent, Scheduler } from './scheduler';

const RECT = { x: 0, y: 0, width: 4096, height: 4096 };

function recordingScheduler(): { scheduler: Scheduler; pushed: QueuedEvent[] } {
  const pushed: QueuedEvent[] = [];
  const stub = {
    setTick: () => undefined,
    setEnsemble: () => undefined,
    push: (event: QueuedEvent) => {
      pushed.push(event);
    },
  };
  return { scheduler: stub as unknown as Scheduler, pushed };
}

/** One soaked farm tile at (2,2) with the player standing on it, at a given tick. */
function soakedView(tick: number, lastPouredTick: number): WorldView {
  const view = createWorldView();
  view.tick = tick;
  view.player.xSub = 2 * SUBTILE + SUBTILE / 2;
  view.player.ySub = 2 * SUBTILE + SUBTILE / 2;
  view.field.count = 1;
  view.field.tileX = [2];
  view.field.tileY = [2];
  view.field.crop = [0];
  view.field.stage = [0];
  view.field.moisturePermille = [1000];
  view.field.ready = [0];
  view.field.dry = [0];
  view.field.zone = [0];
  view.field.soil = [1];
  view.field.lastPouredTick = [lastPouredTick];
  return view;
}

describe('the pour differ under item 081', () => {
  it('stays silent across a refused hand pour: no signal, no sound', () => {
    const { scheduler, pushed } = recordingScheduler();
    const observer = new WorldObserver(scheduler);

    // Prime, then watch three frames of a soaked tile whose signal never moves — which is
    // exactly what the projection looks like while a player clicks a refused pour.
    observer.observe(soakedView(100, 90), RECT, 0);
    observer.observe(soakedView(101, 90), RECT, 16);
    observer.observe(soakedView(102, 90), RECT, 32);

    expect(pushed.filter((e) => e.soundId === SoundId.WaterPour)).toEqual([]);
  });

  it('still plays the pour when the signal really moves on a soaked tile', () => {
    // The control: same soaked tile, same clamp — but the signal advances (a machine's
    // deliberate pour, or a hand pour on the tick before saturation). The differ must not
    // have been "fixed" into reading moisture, which cannot move here.
    const { scheduler, pushed } = recordingScheduler();
    const observer = new WorldObserver(scheduler);

    observer.observe(soakedView(100, 90), RECT, 0);
    observer.observe(soakedView(101, 101), RECT, 16);

    expect(pushed.filter((e) => e.soundId === SoundId.WaterPour)).toHaveLength(1);
  });
});
