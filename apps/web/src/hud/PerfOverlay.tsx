'use client';

// The dev overlay. Dead code in production, and the first customer of its own rule.
//
// It renders its skeleton ONCE and then never re-renders: a 4 Hz interval reads the ring
// buffers and writes `textContent` and a class name through refs. An overlay that measured
// frame time by re-rendering React four times a second to display it would be measuring
// itself, which is funny exactly once.
//
// Budgets from plan §13: 16.6 ms frame, ≤4 ms sim, ≤8 ms render. The overlay does not
// warn, log, or explain when one is exceeded — the number turns red, and the number is
// the alarm. When it does go red the plan's own check order is: draw call count first (an
// atlas break is the usual culprit), then whether culling is actually on, then
// `dynamicProperties` set wider than needed, then sim-vs-render timed separately.
//
// "chunks baked" reads 0 in steady state. A number that stays non-zero is a terrain
// re-bake loop, which is invisible by nature — the picture is correct, it is just being
// redrawn forever.

import { useEffect, useRef, useSyncExternalStore } from 'react';

import { cx, s } from './styles';
import { BUDGET_FRAME_MS, BUDGET_RENDER_MS, BUDGET_SIM_MS, createPerfReading, perf } from './perf';

const REFRESH_MS = 250;

export function PerfOverlay() {
  const visible = useSyncExternalStore(
    perf.subscribeVisible,
    perf.getVisible,
    perf.getServerVisible,
  );
  return visible ? <PerfPanel /> : null;
}

function PerfPanel() {
  const frameRef = useRef<HTMLSpanElement | null>(null);
  const simRef = useRef<HTMLSpanElement | null>(null);
  const renderRef = useRef<HTMLSpanElement | null>(null);
  const fpsRef = useRef<HTMLSpanElement | null>(null);
  const drawRef = useRef<HTMLSpanElement | null>(null);
  const spritesRef = useRef<HTMLSpanElement | null>(null);
  const chunksRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const reading = createPerfReading();

    const write = (): void => {
      perf.read(reading);
      setMs(frameRef.current, reading.frameP99, BUDGET_FRAME_MS);
      setMs(simRef.current, reading.simP99, BUDGET_SIM_MS);
      setMs(renderRef.current, reading.renderP99, BUDGET_RENDER_MS);
      setText(fpsRef.current, `${reading.fps.toFixed(0)}  ·  ${reading.ticks} tick/frame`);
      setText(drawRef.current, reading.drawCalls < 0 ? 'n/a' : String(reading.drawCalls));
      setText(spritesRef.current, String(reading.sprites));
      // Steady state is 0. Anything else is a re-bake loop, so it is flagged like a budget.
      setValue(chunksRef.current, String(reading.chunksBaked), reading.chunksBaked > 0);
    };

    write();
    const timer = window.setInterval(write, REFRESH_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className={s.perf}>
      <Row label={`frame p99 / ${BUDGET_FRAME_MS}`} valueRef={frameRef} />
      <Row label={`sim   p99 / ${BUDGET_SIM_MS.toFixed(1)}`} valueRef={simRef} />
      <Row label={`draw  p99 / ${BUDGET_RENDER_MS.toFixed(1)}`} valueRef={renderRef} />
      <Row label="fps" valueRef={fpsRef} />
      <Row label="draw calls" valueRef={drawRef} />
      <Row label="sprites" valueRef={spritesRef} />
      <Row label="chunks baked" valueRef={chunksRef} />
      <div className={s.perfHint}>f3 or ` to hide</div>
    </div>
  );
}

function Row({
  label,
  valueRef,
}: {
  label: string;
  valueRef: React.RefObject<HTMLSpanElement | null>;
}) {
  return (
    <div className={s.perfRow}>
      <span className={s.perfKey}>{label}</span>
      <span className={s.perfValue} ref={valueRef} />
    </div>
  );
}

function setMs(node: HTMLSpanElement | null, value: number, budgetMs: number): void {
  setValue(node, `${value.toFixed(2)}ms`, value > budgetMs);
}

function setText(node: HTMLSpanElement | null, text: string): void {
  setValue(node, text, false);
}

function setValue(node: HTMLSpanElement | null, text: string, over: boolean): void {
  if (node === null) return;
  if (node.textContent !== text) node.textContent = text;
  const className = over ? cx(s.perfValue, s.perfOver) : s.perfValue;
  if (node.className !== className) node.className = className;
}
