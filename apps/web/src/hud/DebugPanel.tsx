'use client';

// The debug panel ([[075]]): the perf overlay grown a cheat console.
//
// RENDERED FROM THE INPUT LANE'S SEAM (`input/debug-panel.ts`, the build-panel pattern):
// Backquote is `keyboard.ts`'s key, open/closed is `InputSystem`'s state, and this file is
// only the surface. The two doors back are the seam's own — `debugPanelSubmitCode` (the one
// code path that can dispatch a `Cheat` command) and `debugPanelClose`. It renders in EVERY
// build, per the item's constraint: this is a hobby game and the owner wants his cheat, so
// the panel is unobtrusive rather than dev-gated.
//
// THE VERDICT IS THE SEAM'S, NOT OURS. `InputSystem` watches `view.stats.cheatsUsed` — the
// hashed counter the sim slice added exactly so surfaces can annotate honestly — and
// publishes edge counters: `acceptedCount` bumps clear the input, `rejectedCount` bumps
// print the dry line quoting `lastRejectedCode`. No timer, no code table on this side,
// nothing that could disagree with the reducer.
//
// F3 REMAINS THE BARE-OVERLAY DOOR: perf rows without the cheat box. So this component owns
// both surfaces — the full panel when the seam says open, else the plain overlay when
// `perf` says visible — and the two can never double-draw.
//
// THE FOCUS GUARD IS DOUBLE-WALLED. `keyboard.ts` ignores keydowns aimed at an editable
// target (the input lane's half), and this input stops propagation besides — so WASD types
// letters, digits type digits, and Esc/backtick close through `debugPanelClose` from the
// input's own handler rather than falling through to the game's Esc cascade.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  type DebugPanelSnapshot,
  debugPanelClose,
  debugPanelServerSnapshot,
  debugPanelSnapshot,
  debugPanelSubmitCode,
  subscribeDebugPanel,
} from '@/game/input/debug-panel';

import { cx, s } from './styles';
import { PerfPanel, usePerfVisible } from './PerfOverlay';
import { useHudSlice } from './use-hud';

function useDebugPanel(): DebugPanelSnapshot {
  return useSyncExternalStore(subscribeDebugPanel, debugPanelSnapshot, debugPanelServerSnapshot);
}

export function DebugPanel() {
  const panel = useDebugPanel();
  const overlayVisible = usePerfVisible();

  if (panel.open) {
    return (
      <div className={s.debugPanel}>
        <PerfPanel />
        <CheatConsole panel={panel} />
      </div>
    );
  }
  // The F3 door: numbers without the cheat box. Mutually exclusive with the panel above by
  // construction, so the overlay can never draw twice.
  return overlayVisible ? <PerfPanel /> : null;
}

function CheatConsole({ panel }: { panel: DebugPanelSnapshot }) {
  const economy = useHudSlice('economy');
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** The last verdict counters this surface has already reacted to. */
  const seen = useRef({ accepted: panel.acceptedCount, rejected: panel.rejectedCount });
  const [line, setLine] = useState<'none' | 'granted' | 'rejected'>('none');

  // The caret goes straight into the console when the panel opens — ` then typing is the
  // whole gesture. One focus on mount; the component unmounts entirely when the panel shuts.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // React to verdict edges: an accepted cheat clears the input (the seam's contract offers
  // exactly this); a rejected one leaves the typo on screen to fix, under the dry line.
  useEffect(() => {
    if (panel.acceptedCount > seen.current.accepted) {
      seen.current.accepted = panel.acceptedCount;
      if (inputRef.current !== null) inputRef.current.value = '';
      setLine('granted');
    }
    if (panel.rejectedCount > seen.current.rejected) {
      seen.current.rejected = panel.rejectedCount;
      setLine('rejected');
    }
  }, [panel.acceptedCount, panel.rejectedCount]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    // The HUD's half of the focus guard: nothing typed here may reach the game or the
    // HUD's own key effects, whatever the window listeners do about editable targets.
    event.stopPropagation();
    if (event.key === 'Enter') {
      const code = event.currentTarget.value.trim();
      if (code !== '') {
        setLine('none');
        debugPanelSubmitCode(code);
      }
    } else if (event.key === 'Escape' || event.code === 'Backquote') {
      debugPanelClose();
    }
  }, []);

  return (
    <div className={s.cheatRow}>
      <span className={s.cheatPrompt}>&gt;</span>
      <input
        ref={inputRef}
        className={s.cheatInput}
        type="text"
        spellCheck={false}
        autoComplete="off"
        placeholder="cheat code"
        aria-label="cheat code"
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          event.stopPropagation();
        }}
      />
      <Line line={line} lastRejectedCode={panel.lastRejectedCode} cheats={economy.cheatsUsed} />
    </div>
  );
}

function Line({
  line,
  lastRejectedCode,
  cheats,
}: {
  line: 'none' | 'granted' | 'rejected';
  lastRejectedCode: string;
  cheats: number;
}) {
  if (line === 'granted') {
    return <span className={cx(s.cheatLine, s.cheatGranted)}>granted.</span>;
  }
  if (line === 'rejected') {
    return (
      <span className={cx(s.cheatLine, s.cheatRejected)}>
        &lsquo;{lastRejectedCode}&rsquo; does nothing.
      </span>
    );
  }
  // The honest annotation surface ([[075]]): a world that has cheated says so here, off the
  // hashed counter the economy slice now carries.
  return cheats > 0 ? (
    <span className={s.cheatLine}>
      {cheats} {cheats === 1 ? 'cheat' : 'cheats'} on this world
    </span>
  ) : null;
}
