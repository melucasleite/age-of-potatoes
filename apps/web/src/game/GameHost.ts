// ────────────────────────────────────────────────────────────────────────────────────
//  THIS IMPORT IS FIRST ON PURPOSE AND MUST STAY FIRST.
//
//  `render/pixel` sets `TextureStyle.defaultOptions.scaleMode = 'nearest'` at module
//  scope. That assignment is NOT retroactive: any texture whose source is constructed
//  before it runs keeps linear filtering forever. If a later refactor sorts an
//  asset-loading import above this line, exactly one sprite goes blurry and it reads as
//  an art bug rather than a config bug. Plan §13.
import './render/pixel';
// ────────────────────────────────────────────────────────────────────────────────────

import { Application } from 'pixi.js';
import type { WorldState, WorldView } from '@snack/sim';
import { TICK_MS, createWorld, createWorldView, step, view } from '@snack/sim';

import { createAudioLayer } from '../audio';

// Leaf modules, not the `@/hud` barrel. The barrel re-exports `HudRoot`, and importing it
// here would pull the entire React HUD tree into the game chunk to obtain three constants.
import { HUD_PUBLISH_EVERY_TICKS } from '@/hud/cadence';
import { perf } from '@/hud/perf';
import { hudStore } from '@/hud/store';
// Leaf module, not the `@/reports` barrel, for the same reason as the three lines above: the
// barrel re-exports a React tree. Three verbs, and the reports layer owns everything behind
// them ([[033]]).
import { claimReports, publishReports, releaseReports } from '@/reports/bridge';

import { CommandQueue } from './input/commands';
import type { HoverTile, InputHost } from './input/context';
import { InputSystem } from './input/system';
import { ToolMode } from './input/tools';
import { Camera } from './render/camera';
import { clock } from './render/hud';
import { recordTick, render, statusFor } from './render/index';
import { loadArt } from './render/textures';
import type { ArtSet } from './render/textures';
import { createWorldScene, destroyWorldScene } from './render/world';
import type { WorldScene } from './render/world';

/**
 * Never spiral. When the machine cannot keep up the game FALLS BEHIND VISIBLY rather
 * than entering an ever-growing catch-up loop that never returns. This is a decision,
 * not a tuning constant.
 */
const MAX_CATCHUP = 5;

/** A tab restoring from the background reports `now - last` in minutes. Clamp it. */
const MAX_FRAME_DELTA_MS = 250;

export interface GameHostOptions {
  /** Same seed in, same world out, forever. Ignored when `initialState` is given. */
  seed?: number;
  /**
   * A world restored from disk. When present the host adopts it as-is rather than
   * generating one — its `worldSeed` and `tick` come with it, so a reload resumes
   * mid-session instead of starting over.
   */
  initialState?: WorldState;
}

const DEFAULT_SEED = 20260812;

/**
 * Owns the Pixi `Application`, the rAF loop, and the fixed-timestep accumulator.
 *
 * WHY A CLASS AND NOT HOOKS. Plan §11 chose PixiJS as a library with no game framework
 * and rejected `@pixi/react` for the world scene by name: reconciling thousands of
 * objects twenty times a second through a virtual DOM, to produce mutations you could
 * make directly, is work with no payoff. React owns mounting and unmounting a DOM node;
 * `GameHost` owns everything inside it.
 *
 * THE STRICTMODE HAZARD, PRECISELY. In development React mounts, unmounts, and remounts
 * every component, and `Application.init()` is async. Left alone the sequence is: effect
 * one calls `init()`; cleanup fires before that promise resolves and calls `destroy()` on
 * a half-initialised application; effect two calls `init()` again; the first promise then
 * resolves and appends a second canvas to a container already showing the second
 * application's. The symptom is a doubled canvas, a doubled rAF loop running the sim at
 * 40 Hz, or `destroy()` throwing on undefined internals — and which one you get depends
 * on timing, which is why it is handled deliberately rather than discovered.
 *
 * The shape that works, and the whole reason this class holds two extra fields:
 *   - `destroyed` is re-checked immediately after EVERY `await`, and the suspended
 *     routine bails without appending anything;
 *   - `dispose()` awaits the stored init promise (swallowing its rejection) before
 *     tearing down, so it can never destroy a half-built application.
 *
 * DO NOT "FIX" THIS BY DISABLING STRICTMODE. StrictMode is finding a real bug that also
 * occurs in production on fast navigation.
 */
export class GameHost implements InputHost {
  private readonly container: HTMLElement;
  private readonly seed: number;

  private app: Application | null = null;
  private scene: WorldScene | null = null;
  private art: ArtSet | null = null;

  private destroyed = false;
  private initPromise: Promise<void> | null = null;
  private rafId = 0;

  private readonly state: WorldState;
  /** One projection buffer per host, reused forever. `view()` writes into it. */
  private readonly viewBuffer: WorldView = createWorldView();
  private lastView: WorldView | null = null;

  readonly queue = new CommandQueue();
  /**
   * Pointer, keyboard, the gesture chrome, and the cursor state they share. One object so
   * that the host's only obligations are attach, detach, and one call per frame.
   */
  private readonly input: InputSystem;
  private resizeObserver: ResizeObserver | null = null;

  private accumulatorMs = 0;
  private lastFrameMs = 0;

  private tool: ToolMode = ToolMode.Hand;
  private hover: HoverTile | null = null;

  /** Renderer state. Created before the app so input can hold a stable reference. */
  readonly camera = new Camera();

  /**
   * The Music Box. It READS the projection and never calls back into the sim — see the
   * header of `src/audio/index.ts` for why that direction is not negotiable.
   */
  private readonly audio = createAudioLayer();

  /**
   * The HUD's ownership token. StrictMode mounts, unmounts and remounts, so two hosts exist
   * briefly and the dying one must not be able to reset the store under the live one — the
   * store checks this identity on every call and ignores strangers.
   */
  private readonly hudToken = {};
  /** Ticks since the last HUD publish. The cadence is counted in ticks, never in ms. */
  private ticksSincePublish = 0;

  constructor(container: HTMLElement, options: GameHostOptions = {}) {
    this.container = container;
    this.state = options.initialState ?? createWorld(options.seed ?? DEFAULT_SEED);
    this.seed = this.state.worldSeed;
    this.input = new InputSystem(this);
  }

  /**
   * The live world, for autosave to read on its own schedule.
   *
   * Handing out the mutable state is deliberate: the alternative is copying a world
   * every poll, and the only caller serialises it. Nothing may mutate it — the sole
   * door into the sim is `queue.push`.
   */
  getState(): WorldState {
    return this.state;
  }

  // --- InputHost ---------------------------------------------------------------------

  get canvas(): HTMLCanvasElement {
    // Only ever read from listeners, which are attached after the canvas exists.
    return this.app!.canvas;
  }

  /** The element the canvas sits in. Gesture chrome is absolutely positioned inside it. */
  get overlayRoot(): HTMLElement {
    return this.container;
  }

  latestView(): WorldView | null {
    return this.lastView;
  }

  getTool(): ToolMode {
    return this.tool;
  }

  setTool(tool: ToolMode): void {
    this.tool = tool;
    // Published immediately rather than at the next cadence tick. React owns things that
    // change when the PLAYER does something, and 150 ms between pressing 2 and the
    // watering can lighting up reads as the UI not having heard you. The world's numbers
    // can wait for the throttle; a keypress cannot.
    hudStore.publishTool(this.hudToken, tool, this.state.moneyCents);
  }

  setHover(tile: HoverTile | null): void {
    this.hover = tile;
  }

  /**
   * F3 / backtick. Toggles the React dev overlay ([[013]]); the in-canvas one stays hidden
   * and keeps doing the one job only it can do, which is counting GL draw calls.
   */
  toggleOverlay(): void {
    perf.toggle();
  }

  // --- lifecycle ---------------------------------------------------------------------

  start(): void {
    if (this.destroyed || this.initPromise !== null) return;
    this.initPromise = this.run().catch((error: unknown) => {
      if (!this.destroyed) console.error('[snack] GameHost failed to start:', error);
    });
  }

  private async run(): Promise<void> {
    const app = new Application();
    this.app = app;

    const rect = this.container.getBoundingClientRect();
    await app.init({
      width: Math.max(1, Math.floor(rect.width) || 960),
      height: Math.max(1, Math.floor(rect.height) || 540),
      // Both of these or the canvas is soft on every retina display (§13).
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      antialias: false,
      background: 0x141019,
      // The rAF loop below is the only clock. Pixi's own ticker would render a second
      // time per frame and, in a StrictMode double-mount, twice more.
      autoStart: false,
      preference: 'webgl',
    });

    // Re-check immediately after the await. If disposal happened while `init()` was in
    // flight, append NOTHING — this is the branch that prevents the doubled canvas.
    if (this.destroyed) {
      this.app = null;
      app.destroy({ removeView: true }, { children: true });
      return;
    }
    app.ticker.stop();

    const art = await loadArt(app.renderer);
    if (this.destroyed) {
      this.app = null;
      art.destroy();
      app.destroy({ removeView: true }, { children: true });
      return;
    }
    this.art = art;

    // The camera the input listeners already hold is the camera the scene uses. Handing
    // picking a second instance is how the highlight ends up inverting a transform that
    // was never applied.
    const scene = createWorldScene(app, art, this.camera);
    this.scene = scene;

    app.canvas.style.display = 'block';
    app.canvas.style.width = '100%';
    app.canvas.style.height = '100%';
    app.canvas.style.touchAction = 'none';
    app.canvas.tabIndex = 0;
    this.container.appendChild(app.canvas);

    this.resize();
    scene.overlay.installDrawCallCounter(app.renderer);

    // The React HUD subsumes the in-canvas one ([[013]]). The Pixi panel stays constructed
    // and one flag away from working — its own header always described it as the fallback —
    // but it draws nothing and, hidden, updates nothing.
    scene.hud.root.visible = false;

    // Claim the store and publish once immediately, so the HUD comes up with the world
    // rather than 150 ms after it.
    // Two callbacks, and the asymmetry between them is the boundary working. Tool selection
    // is UI state and goes straight into a field. Anything that changes the WORLD — research,
    // an upgrade dial — is handed to `queue.push` and applies at a tick boundary like every
    // other command, so it lands in the trace and replays (§12). The store never sees the
    // queue and never sees `WorldState`.
    hudStore.claim(
      this.hudToken,
      (tool) => this.setTool(tool),
      (command) => this.queue.push(command),
    );
    perf.reset();
    hudStore.publishWorld(this.hudToken, view(this.state, this.viewBuffer), this.tool);

    // The reports read the same projection through the same token, and the same rules apply:
    // they never see `WorldState`, and their one way to change the world is `queue.push`.
    claimReports(this.hudToken, this.seed, (command) => this.queue.push(command));
    publishReports(this.hudToken, view(this.state, this.viewBuffer));

    // Listeners are attached and detached in this one lifecycle pair, never elsewhere. A
    // leaked `keydown` listener from a double-mount means the player walks at double
    // speed and the cause is invisible.
    this.input.attach();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);

    this.lastFrameMs = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  /** Safe before `start()` resolves, safe twice, safe on a host that never started. */
  async dispose(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    this.input.detach();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.queue.clear();
    this.audio.dispose();
    // Only takes effect if this host is the one holding the token. A StrictMode-orphaned
    // host disposing after its replacement started is a no-op, which is the whole point.
    hudStore.release(this.hudToken);
    releaseReports(this.hudToken);

    // Wait for a half-finished `start()` before tearing anything down, and swallow its
    // rejection: a failed init is not a reason for cleanup to throw.
    try {
      await this.initPromise;
    } catch {
      /* already reported by start() */
    }

    const scene = this.scene;
    this.scene = null;
    if (scene !== null) destroyWorldScene(scene);

    // Only textures this host generated. The atlas stays in the `Assets` cache — the
    // StrictMode remount is milliseconds away and would otherwise get dead textures.
    this.art?.destroy();
    this.art = null;

    const app = this.app;
    this.app = null;
    if (app !== null) {
      try {
        app.destroy({ removeView: true }, { children: true });
      } catch (error) {
        console.warn('[snack] error while destroying the Pixi application:', error);
      }
    }
  }

  // --- the loop ----------------------------------------------------------------------

  private readonly frame = (now: number): void => {
    if (this.destroyed) return;
    const app = this.app;
    const scene = this.scene;
    if (app === null || scene === null) return;

    const deltaMs = Math.min(now - this.lastFrameMs, MAX_FRAME_DELTA_MS);
    this.lastFrameMs = now;

    // ── THE PAUSE ([[126]]), AND IT IS ENTIRELY THIS ────────────────────────────────────
    //
    // Pausing is the host declining to advance the clock. There is no flag in `WorldState`,
    // no `paused` field in the projection and no branch inside `step()` — the sim replays
    // twenty golden fixtures to pinned hashes, and a UI flag in the world would make every
    // one of those goldens a statement about menus. What is paused is THIS LOOP.
    //
    // WHAT PAUSING DOES TO THE WALL-CLOCK CATCH-UP, written down because the item asks for a
    // decision rather than an accident: the accumulator is ZEROED on every paused frame, so
    // the debt owed to the sim while the menu is open is never carried. The player who goes
    // to lunch with the menu up comes back to the tick they left on, and the first frame
    // after resume owes one frame's delta and nothing more. Merely skipping the `while`
    // would have been enough on paper — `deltaMs` is already clamped to 250 ms and
    // `MAX_CATCHUP` bounds any frame to five ticks — but "enough on paper" is how an hour of
    // lunch becomes a visible lurch, and the zero says what is meant.
    //
    // EVERYTHING ELSE IN THIS FRAME STILL RUNS. The world is still projected, still rendered
    // and still presented, because the menu is a translucent scrim over a live canvas and a
    // frozen-but-drawn lot is the picture the player expects behind it. `alpha` comes out at
    // exactly 0, so the interpolated sprites sit on their last whole tick rather than
    // shivering between two. The audio bed keeps its groove: §14's rule is that audio FOLLOWS
    // the sim and never drives it, and a sim that is not moving publishes no new events, so
    // every sim-derived voice falls silent on its own without a second control over the
    // engine. The HUD's throttled publish is counted in TICKS, so it correctly says nothing.
    const paused = this.input.paused;
    if (paused) this.accumulatorMs = 0;
    else this.accumulatorMs += deltaMs;

    const simStart = performance.now();
    let ticks = 0;
    while (this.accumulatorMs >= TICK_MS && ticks < MAX_CATCHUP) {
      // `step()` throws if the tick it is handed is not the tick the state is on, which
      // is the loop's own correctness check — pass `state.tick`, never a local counter.
      step(this.state, { tick: this.state.tick, commands: this.queue.drain() });
      this.accumulatorMs -= TICK_MS;
      ticks += 1;
      recordTick(scene, view(this.state, this.viewBuffer));
    }
    // Anything still owed after MAX_CATCHUP is dropped rather than carried. Carrying it
    // is the spiral: the next frame owes even more and the loop never catches up.
    if (this.accumulatorMs > TICK_MS * MAX_CATCHUP) this.accumulatorMs = TICK_MS;
    const simMs = performance.now() - simStart;

    const projection = view(this.state, this.viewBuffer);
    this.lastView = projection;

    const renderStart = performance.now();
    render(
      scene,
      projection,
      this.accumulatorMs / TICK_MS,
      { hover: this.hover, tool: this.tool },
      deltaMs,
    );
    app.render();
    const renderMs = performance.now() - renderStart;

    // Gesture chrome, positioned by inverting the transform that was ACTUALLY APPLIED —
    // so it goes after `render()`, which is where the camera gets applied. Driven from
    // this loop rather than from `pointermove` because the camera follows the player: a
    // rubber band anchored to tiles has to keep up while you walk, mouse or no mouse.
    // One clock in this application, and this is it.
    this.input.update();

    // After `render()`, so the camera rect it culls and pans against is the one that was
    // actually applied this frame rather than last frame's.
    this.audio.observe(projection, this.camera.cameraRect());

    scene.overlay.readAndResetDrawCalls();
    scene.overlay.push({
      frameMs: deltaMs,
      simMs,
      renderMs,
      ticks,
      chunksBaked: scene.terrain.bakedLastFrame,
      sprites: scene.contentRoot.children.length,
    });
    scene.overlay.refresh(deltaMs);

    // --- the HUD boundary --------------------------------------------------------------
    //
    // Timing is taken HERE, from outside `step()`, because `performance` does not exist
    // inside `packages/sim` — its tsconfig has no DOM lib, so a timer in there is a type
    // error rather than a code-review convention. Not a workaround; the boundary working.
    perf.push({
      frameMs: deltaMs,
      simMs,
      renderMs,
      ticks,
      drawCalls: scene.overlay.lastDrawCalls,
      sprites: scene.contentRoot.children.length,
      chunksBaked: scene.terrain.bakedLastFrame,
    });

    // The live channel: written every frame, notifying nobody. rAF-driven writers in the
    // HUD put these straight into DOM nodes, which is what keeps a clock and a hover
    // readout off React's critical path entirely (§13).
    hudStore.live.clock = clock(projection.tick);
    hudStore.live.status = statusFor(projection, { hover: this.hover, tool: this.tool });

    // The snapshot: every third tick, ≈6.7 Hz. Counted in TICKS, driven by the loop that
    // is already here — introducing a `setInterval` for this would put a second clock in
    // an app whose whole architecture rests on having exactly one.
    this.ticksSincePublish += ticks;
    if (this.ticksSincePublish >= HUD_PUBLISH_EVERY_TICKS) {
      this.ticksSincePublish = 0;
      hudStore.publishWorld(this.hudToken, projection, this.tool);
      publishReports(this.hudToken, projection);
    }

    this.rafId = requestAnimationFrame(this.frame);
  };

  private resize(): void {
    const app = this.app;
    if (app === null || this.destroyed) return;
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    app.renderer.resize(width, height);
    this.camera.setViewport(width, height, app.renderer.resolution);
    this.scene?.overlay.layout(width);
  }
}
