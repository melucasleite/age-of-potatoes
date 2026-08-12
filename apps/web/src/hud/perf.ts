// Frame timing, and the budgets it is measured against.
//
// Plan §13 sets the budgets NOW, while nothing is slow: a 16.6 ms frame split into ≤4 ms
// sim and ≤8 ms render, with p99 logged in dev from v0.1. The point of setting them early
// is not to optimise early — it is so that the version which breaks performance is
// identifiable as the version that broke it, instead of being discovered six months later
// as "the game got slow at some point".
//
// p99 rather than mean, because the average frame is never the one that ruins the feel.
//
// The timing is taken by the HOST, from outside `step()`. `performance` does not exist in
// `packages/sim` — its tsconfig has no DOM lib, so a timing call in there is a type error
// rather than a code-review convention. That is not a workaround; it is the boundary
// working as designed.

/** Sample budget. 600 frames is ten seconds at 60 fps — long enough for a p99 to mean it. */
const SAMPLES = 600;

export const BUDGET_FRAME_MS = 16.6;
export const BUDGET_SIM_MS = 4;
export const BUDGET_RENDER_MS = 8;

export interface PerfSample {
  frameMs: number;
  simMs: number;
  renderMs: number;
  ticks: number;
  drawCalls: number;
  sprites: number;
  chunksBaked: number;
}

export interface PerfReading {
  frameP99: number;
  simP99: number;
  renderP99: number;
  fps: number;
  ticks: number;
  drawCalls: number;
  sprites: number;
  chunksBaked: number;
}

class PerfSink {
  private readonly frame = new Float32Array(SAMPLES);
  private readonly sim = new Float32Array(SAMPLES);
  private readonly render = new Float32Array(SAMPLES);
  private readonly scratch = new Float32Array(SAMPLES);
  private cursor = 0;
  private filled = 0;
  private frameTotal = 0;

  private ticks = 0;
  private drawCalls = -1;
  private sprites = 0;
  private chunksBaked = 0;

  private visible = false;
  private readonly listeners = new Set<() => void>();

  /** Called once per frame by the host. Three array writes; it does not compute anything. */
  push(sample: PerfSample): void {
    this.frame[this.cursor] = sample.frameMs;
    this.sim[this.cursor] = sample.simMs;
    this.render[this.cursor] = sample.renderMs;
    this.cursor = (this.cursor + 1) % SAMPLES;
    if (this.filled < SAMPLES) this.filled += 1;
    this.ticks = sample.ticks;
    this.drawCalls = sample.drawCalls;
    this.sprites = sample.sprites;
    this.chunksBaked = sample.chunksBaked;
  }

  reset(): void {
    this.cursor = 0;
    this.filled = 0;
    this.frameTotal = 0;
  }

  /** Sorts on demand — at the overlay's 4 Hz refresh, never per frame. */
  read(out: PerfReading): PerfReading {
    this.frameTotal = 0;
    for (let i = 0; i < this.filled; i++) this.frameTotal += this.frame[i]!;

    out.frameP99 = this.percentile(this.frame, 0.99);
    out.simP99 = this.percentile(this.sim, 0.99);
    out.renderP99 = this.percentile(this.render, 0.99);
    out.fps = this.frameTotal > 0 ? (this.filled * 1000) / this.frameTotal : 0;
    out.ticks = this.ticks;
    out.drawCalls = this.drawCalls;
    out.sprites = this.sprites;
    out.chunksBaked = this.chunksBaked;
    return out;
  }

  private percentile(data: Float32Array, q: number): number {
    const filled = this.filled;
    if (filled === 0) return 0;
    const window = this.scratch.subarray(0, filled);
    window.set(data.subarray(0, filled));
    window.sort();
    return window[Math.min(filled - 1, Math.floor(q * filled))]!;
  }

  // --- visibility is UI state, not sim state, so it gets its own tiny store -----------

  readonly subscribeVisible = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVisible = (): boolean => this.visible;
  /** Dev-only overlay: on the server it is always off, and that is not a mismatch. */
  readonly getServerVisible = (): boolean => false;

  toggle(): void {
    this.visible = !this.visible;
    for (const listener of this.listeners) listener();
  }
}

export const perf = new PerfSink();

export function createPerfReading(): PerfReading {
  return {
    frameP99: 0,
    simP99: 0,
    renderP99: 0,
    fps: 0,
    ticks: 0,
    drawCalls: -1,
    sprites: 0,
    chunksBaked: 0,
  };
}
