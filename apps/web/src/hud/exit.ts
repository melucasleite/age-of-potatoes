// The EXIT GAME signal ([[078]]): the sidebar button asks, the canvas answers.
//
// `panels.ts`'s shape, for `panels.ts`'s reason: a one-shot event between two layers that
// must not import each other's internals. The button lives in the HUD; the ordered exit —
// save through the write-then-verify machinery, THEN tear the world down — has to run where
// the world and its autosave handle live, which is `GameCanvas`. A signal with no memory is
// the right carrier for a keypress-shaped request: a listener that subscribes later hears
// nothing that happened before it, and there is no "last request" field to go stale.
//
// NOTHING HERE IS SIM STATE (§12). Leaving the world is not a command; the save the exit
// forces is the same save the autosave cadence writes.

export type ExitListener = () => void;

const listeners = new Set<ExitListener>();

/**
 * Ask for an orderly exit. A no-op when nothing is listening — the seconds before the
 * canvas mounts, tests, the server — which is correct: with no world there is nothing to
 * save and nothing to leave.
 */
export function requestExit(): void {
  for (const listener of listeners) listener();
}

/** Listen for the request. Returns the unsubscribe, so a React effect can be one line. */
export function onExitRequest(listener: ExitListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
