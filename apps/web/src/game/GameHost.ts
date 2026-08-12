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

import { CommandQueue } from './input/commands';
import type { HoverTile, InputHost } from './input/context';
import { KeyboardInput } from './input/keyboard';
import { PointerInput } from './input/pointer';
import { ToolMode } from './input/tools';
import { Camera } from './render/camera';
import { recordTick, render } from './render/index';
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
  /** Same seed in, same world out, forever. */
  seed?: number;
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
  private readonly keyboard: KeyboardInput;
  private readonly pointer: PointerInput;
  private resizeObserver: ResizeObserver | null = null;

  private accumulatorMs = 0;
  private lastFrameMs = 0;

  private tool: ToolMode = ToolMode.Hand;
  private hover: HoverTile | null = null;

  /** Renderer state. Created before the app so input can hold a stable reference. */
  readonly camera = new Camera();

  constructor(container: HTMLElement, options: GameHostOptions = {}) {
    this.container = container;
    this.seed = options.seed ?? DEFAULT_SEED;
    this.state = createWorld(this.seed);
    this.keyboard = new KeyboardInput(this);
    this.pointer = new PointerInput(this);
  }

  // --- InputHost ---------------------------------------------------------------------

  get canvas(): HTMLCanvasElement {
    // Only ever read from listeners, which are attached after the canvas exists.
    return this.app!.canvas;
  }

  latestView(): WorldView | null {
    return this.lastView;
  }

  getTool(): ToolMode {
    return this.tool;
  }

  setTool(tool: ToolMode): void {
    this.tool = tool;
  }

  setHover(tile: HoverTile | null): void {
    this.hover = tile;
  }

  toggleOverlay(): void {
    this.scene?.overlay.toggle();
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

    // Listeners are attached and detached in this one lifecycle pair, never elsewhere. A
    // leaked `keydown` listener from a double-mount means the player walks at double
    // speed and the cause is invisible.
    this.keyboard.attach();
    this.pointer.attach();

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

    this.keyboard.detach();
    this.pointer.detach();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.queue.clear();

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
    this.accumulatorMs += deltaMs;

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
