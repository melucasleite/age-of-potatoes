// The audio layer's public seam. One function in, one call per frame, one call to tear down.
//
// ══════════════════════════════════════════════════════════════════════════════════════
//  THE DIRECTION OF THE CLOCK IS THE WHOLE DESIGN.
//
//      sim  ──── tick, and a read-only projection ────►  audio
//      sim  ◄──────────────  nothing, ever  ──────────── audio
//
//  `observe()` takes; it does not give. There is no callback into `WorldState`, no
//  `Command` issued from this directory, and no audio-derived number anywhere near the
//  deterministic loop. Plan §14 and AGENTS.md both flag getting this backwards as NOT
//  RECOVERABLE BY REFACTORING — it would put a drifting sample clock inside the sim and
//  invalidate every seeded world, every golden hash, and every stored replay at a stroke.
//  `packages/sim` has no DOM lib in its tsconfig so that `AudioContext` is a type error
//  there. That is a guard rail, not an inconvenience.
// ══════════════════════════════════════════════════════════════════════════════════════
//
// USAGE, and it is meant to be this small:
//
//   const audio = createAudioLayer();
//   // …once per frame, after the projection is taken:
//   audio.observe(projection, camera.cameraRect());
//   // …on teardown:
//   audio.dispose();
//
// FOR OTHER WORK ITEMS — the HUD in particular — `playUiSound()` is the seam for button
// clicks. It is a no-op until the player has enabled audio, it is rate limited like
// everything else, and it needs no reference to the host.

import type { WorldView } from '@snack/sim';

import type { WorldRect } from '../game/render/camera';

import { AudioEngine } from './AudioEngine';
import { WorldObserver } from './observer';
import { Scheduler } from './scheduler';
import { SoundId } from './sounds';
import { installStartGate } from './start-gate';
import type { StartGate } from './start-gate';

export { SoundId } from './sounds';

export interface AudioLayer {
  /** Call once per rendered frame with the projection the renderer just drew. */
  observe(view: WorldView, rect: WorldRect): void;
  /** Play a UI sound now. Unquantized, because a button is a player action. */
  ui(id: typeof SoundId.UiClick | typeof SoundId.UiSelect): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

/**
 * The layer created by the running `GameHost`, if there is one.
 *
 * A module-level handle rather than a parameter because the callers who want it — a HUD
 * button, a menu — are React components that have no path to the host and should not grow
 * one. It is cleared on dispose, so a StrictMode remount cannot leave a stale engine behind.
 */
let activeLayer: AudioLayer | null = null;

/** Click a UI sound from anywhere. Silent, and free, when audio has not been started. */
export function playUiSound(id: typeof SoundId.UiClick | typeof SoundId.UiSelect): void {
  activeLayer?.ui(id);
}

export function createAudioLayer(): AudioLayer {
  const engine = new AudioEngine();
  const scheduler = new Scheduler(engine);
  const observer = new WorldObserver(scheduler);

  let lastTick = 0;
  let disposed = false;
  let gate: StartGate | null = null;

  gate = installStartGate({
    onStart: () => {
      // `start()` creates the context synchronously before its first `await`, so the
      // context is born inside this gesture's task — which is what the autoplay policy
      // actually inspects. The scheduler waits for the resume to land, so a suspended
      // context can never accumulate a backlog and then fire it all at once.
      void engine.start().then(() => {
        if (disposed) return;
        if (engine.running) scheduler.start();
        gate?.refresh(engine.started);
      });
    },
    onToggleMute: () => engine.setMuted(!engine.isMuted()),
    isMuted: () => engine.isMuted(),
  });

  const layer: AudioLayer = {
    observe(view: WorldView, rect: WorldRect): void {
      if (disposed) return;
      lastTick = view.tick;
      // Told, never asked: the sim's tick moves the anchor and nothing moves it back.
      engine.sync(view.tick);
      observer.observe(view, rect, performance.now());
    },

    ui(id): void {
      if (disposed || !engine.started) return;
      // Straight to the scheduler with the current tick. Catalogued as `immediate`, so it
      // sounds on the next pass — at most 25 ms — and never waits for a beat.
      scheduler.push({ soundId: id, tick: lastTick, pan: 0, gain: 1, rate: 1 });
    },

    setMuted(muted: boolean): void {
      engine.setMuted(muted);
      gate?.refresh(engine.started);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      scheduler.stop();
      observer.reset();
      engine.dispose();
      gate?.dispose();
      gate = null;
      if (activeLayer === layer) activeLayer = null;
    },
  };

  activeLayer = layer;
  return layer;
}
