// The debug panel's state, published across the input→HUD seam ([[075]]).
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY THIS EXISTS. Backquote grows from "toggle the perf overlay" into a debug panel:
//  the overlay plus a text input for cheat codes. The SURFACE is the HUD's (React renders
//  the panel and its input; this module never learns what a component is), but the key
//  lives in `keyboard.ts` and the cheat is a `Command`, so ownership of the STATE stays
//  input-side — `InputSystem` owns open/closed and the code's verdict, and this module is
//  the window React watches it through. It is `build-panel.ts`'s pattern verbatim: a
//  frozen snapshot store with a subscription, plus registered hooks as the doors back in.
// ────────────────────────────────────────────────────────────────────────────────────
//
// THE VERDICT FIELDS ARE OBSERVATIONS, NOT AUTHORITY (§12). Whether a code is real is the
// reducer's secret: `applyCheat` grants `klapaucius` and refuses everything else untraced,
// and no code table exists on this side to disagree with it. `InputSystem` dispatches the
// `Cheat` command, then watches `view.stats.cheatsUsed` — the hashed counter the sim slice
// added exactly so surfaces can annotate honestly — and reports what it saw: the counter
// moved (accepted) or it did not (rejected). `acceptedCount`/`rejectedCount` are edge
// counters, so the HUD can key its rejection line and its input-clear on a bump without
// this store ever carrying a one-shot event.
//
// NONE OF THIS IS SIM STATE. Which panel is open is never traced, hashed, or saved; the
// CHEAT ITSELF is a command in the trace like any other — that is the determinism rule the
// item is built on, and it is enforced on the far side of the queue, not here.

export interface DebugPanelSnapshot {
  readonly version: number;
  /** The panel (perf overlay + cheat input) is up. Backquote toggles; Esc closes. */
  readonly open: boolean;
  /** Bumps once per cheat the sim visibly granted. The HUD may clear its input on this. */
  readonly acceptedCount: number;
  /** Bumps once per code the sim refused. The HUD shows its dry rejection line on this. */
  readonly rejectedCount: number;
  /** The code behind the latest rejection, verbatim, for the line to quote. `''` before any. */
  readonly lastRejectedCode: string;
}

const ZERO: DebugPanelSnapshot = Object.freeze({
  version: 0,
  open: false,
  acceptedCount: 0,
  rejectedCount: 0,
  lastRejectedCode: '',
});

let snapshot: DebugPanelSnapshot = ZERO;
const listeners = new Set<() => void>();

export function debugPanelSnapshot(): DebugPanelSnapshot {
  return snapshot;
}

/** The server render and the pre-attach client render: closed, forever, cheaply. */
export function debugPanelServerSnapshot(): DebugPanelSnapshot {
  return ZERO;
}

export function subscribeDebugPanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by `InputSystem` on every open/close edge and every cheat verdict. */
export function publishDebugPanel(
  open: boolean,
  acceptedCount: number,
  rejectedCount: number,
  lastRejectedCode: string,
): void {
  if (
    snapshot.open === open &&
    snapshot.acceptedCount === acceptedCount &&
    snapshot.rejectedCount === rejectedCount &&
    snapshot.lastRejectedCode === lastRejectedCode
  ) {
    return;
  }
  snapshot = Object.freeze({
    version: snapshot.version + 1,
    open,
    acceptedCount,
    rejectedCount,
    lastRejectedCode,
  });
  for (const listener of listeners) listener();
}

// --- the doors back in ---------------------------------------------------------------------
//
// The HUD's input submits through `submitCode` and closes through `close`, so there is
// exactly one code path that can dispatch a cheat — the same one-door property the build
// menu keeps for arming. Before a host exists (tests, the server, the seconds before
// mount) the doors are no-ops, which is correct because the panel cannot be open then.

export interface DebugPanelHooks {
  /** Dispatch `code` as a `Cheat` command and start watching for the verdict. */
  submitCode(code: string): void;
  close(): void;
}

let hooks: DebugPanelHooks | null = null;

/** Returns the unregister. A stale host unregistering after its successor is a no-op. */
export function registerDebugPanelHooks(next: DebugPanelHooks): () => void {
  hooks = next;
  return () => {
    if (hooks === next) hooks = null;
  };
}

export function debugPanelSubmitCode(code: string): void {
  hooks?.submitCode(code);
}

export function debugPanelClose(): void {
  hooks?.close();
}
