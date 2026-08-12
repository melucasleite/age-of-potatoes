// The click-to-start gate, and afterwards the mute toggle. The whole audio UI for v0.1.
//
// ── WHY A GATE IS NOT OPTIONAL ─────────────────────────────────────────────────────
// Every browser's autoplay policy requires a real user gesture before audio may sound, and
// Chrome will not resume a context from a timer, a promise, or a `load` handler. Without a
// gate the game is silently silent — which is the worst outcome, because it looks like a
// bug in the audio engine rather than a policy doing its job.
//
// ── WHY IT IS A CORNER PILL AND NOT A FULL-SCREEN MODAL ────────────────────────────
// A modal over the canvas would stand between a fresh player and the first thing they are
// meant to do, and plan §0's design gate is that a fresh-eyes player grins the moment the
// sprinkler waters for them. Nothing gets to stand in front of that — least of all a dialog
// about audio. So: a small pill that is itself a valid gesture target, plus a one-shot
// listener that treats the player's FIRST CLICK ANYWHERE as the gesture. In practice the
// player never notices the gate at all; they click the ground to plant something and the
// sound arrives with it.
//
// This module owns its own DOM and is deliberately framework-free. `GameCanvas.tsx` and the
// HUD belong to other work items, and an audio feature has no business editing either.

const PILL_BASE_STYLE = `
  position: fixed;
  left: 12px;
  bottom: 12px;
  z-index: 40;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 12px;
  border: 1px solid #4a3f52;
  border-radius: 999px;
  background: rgba(20, 16, 25, 0.82);
  color: #c8b9a4;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.02em;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  backdrop-filter: blur(4px);
  transition: opacity 160ms ease, border-color 160ms ease;
`;

const KEYFRAMES = `
@keyframes snack-audio-pulse {
  0%, 100% { border-color: #4a3f52; }
  50%      { border-color: #b8934a; }
}
`;

export interface StartGateOptions {
  /** Called from inside the real gesture handler. Must start the context synchronously. */
  readonly onStart: () => void;
  readonly onToggleMute: () => void;
  readonly isMuted: () => boolean;
}

export interface StartGate {
  /** Reflect engine state back onto the pill — after `start()` resolves, or a mute change. */
  refresh(started: boolean): void;
  dispose(): void;
}

export function installStartGate(options: StartGateOptions): StartGate {
  // Belt and braces for a server render. Nothing here should ever run on the server, but a
  // module that throws during SSR fails the whole page rather than just the sound.
  if (typeof document === 'undefined') {
    return { refresh: () => undefined, dispose: () => undefined };
  }

  let started = false;
  let disposed = false;

  const style = document.createElement('style');
  style.textContent = KEYFRAMES;
  document.head.appendChild(style);

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.setAttribute(
    'style',
    `${PILL_BASE_STYLE} animation: snack-audio-pulse 1.8s ease-in-out infinite;`,
  );
  pill.textContent = '♪  click for sound';
  pill.setAttribute('aria-label', 'Enable game audio');
  document.body.appendChild(pill);

  const begin = (): void => {
    if (started || disposed) return;
    started = true;
    // Synchronous, inside the gesture's own task. That is what the autoplay policy checks —
    // an `await` before the context is created hands the check a task with no gesture in it.
    options.onStart();
    render();
    removeGestureListeners();
  };

  const onPill = (event: MouseEvent): void => {
    // Never let the pill's click fall through to the canvas and plant a crop under it.
    event.stopPropagation();
    if (!started) {
      begin();
      return;
    }
    options.onToggleMute();
    render();
  };

  // The real gate. `capture: true` so it runs before the game's own handlers, `passive` so
  // it cannot interfere with them, and it removes itself the moment it has done its job.
  const onFirstGesture = (): void => begin();

  function removeGestureListeners(): void {
    window.removeEventListener('pointerdown', onFirstGesture, true);
    window.removeEventListener('keydown', onFirstGesture, true);
  }

  function render(): void {
    if (disposed) return;
    if (!started) {
      pill.textContent = '♪  click for sound';
      pill.setAttribute('aria-label', 'Enable game audio');
      return;
    }
    const muted = options.isMuted();
    pill.setAttribute('style', `${PILL_BASE_STYLE} opacity: ${muted ? '0.55' : '0.8'};`);
    pill.textContent = muted ? '♪  muted' : '♪  sound on';
    pill.setAttribute('aria-label', muted ? 'Unmute game audio' : 'Mute game audio');
  }

  pill.addEventListener('click', onPill);
  window.addEventListener('pointerdown', onFirstGesture, { capture: true, passive: true });
  window.addEventListener('keydown', onFirstGesture, { capture: true, passive: true });

  return {
    refresh(engineStarted: boolean): void {
      started = engineStarted;
      render();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      removeGestureListeners();
      pill.removeEventListener('click', onPill);
      pill.remove();
      style.remove();
    },
  };
}
