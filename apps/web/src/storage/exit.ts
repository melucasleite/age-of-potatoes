// The ordered exit ([[078]]): save, verify, and only then let the world unmount.
//
// THE ORDER IS THE FEATURE AND IT IS NOT NEGOTIABLE. "Exit Game" promises that nothing is
// lost, and the only version of that promise this layer can keep is structural: the flush
// goes through `saveWorld`'s write-then-verify machinery ([[041]] — a save that cannot be
// read back never becomes the newest record), the result is CHECKED, and the teardown
// callback runs strictly after, and only on success. An optimistic exit — unmount first,
// save on the way out — is exactly the torn-teardown race the autosave's own header calls
// best-effort, and best-effort is not good enough for a button whose whole meaning is
// "this is safe to press".
//
// A FAILED SAVE MEANS THE EXIT DOES NOT HAPPEN. The world stays up, the player keeps
// playing, and the failure reaches them as the same notice card every failed save shows
// (`saveWorld`/`startAutosave` published it before we ever see the false). Leaving anyway
// would be the one path in this directory that knowingly walks away from unsaved play.

/**
 * What the exit needs from the running game. Deliberately three closures rather than the
 * autosave handle itself, so the ordering below is testable without a browser, a world, or
 * a real handle — the same seam discipline as `SaveRecordStore`.
 */
export interface ExitDeps {
  /** The world's tick right now. Captured BEFORE the flush; the sim keeps ticking under it. */
  tickNow(): number;
  /**
   * Force a save through the write-then-verify path — `AutosaveHandle.flush('manual')`.
   * Resolves true when a write landed, false when there was nothing new to write OR the
   * write failed; the two falses are told apart by `lastSavedTick` below.
   */
  flush(): Promise<boolean>;
  /** The tick of the last save that actually landed, or null when none ever has. */
  lastSavedTick(): number | null;
}

/**
 * Save for an exit, and say whether leaving is safe.
 *
 * True means: every tick up to at least the moment the player pressed the button is on
 * disk, read back, and verified. The ticks that elapse DURING the flush are the same
 * under-a-second exposure every autosave accepts; the unmount path flushes once more,
 * best-effort, on the way out.
 *
 * False means the save did not land. The caller must NOT tear down.
 */
export async function saveBeforeExit(deps: ExitDeps): Promise<boolean> {
  const tickAtRequest = deps.tickNow();
  await deps.flush();
  const saved = deps.lastSavedTick();
  // `flush` returning false is ambiguous (nothing to save vs. write failed), so the verdict
  // reads the one unambiguous fact instead: is a save at or past the request tick on disk?
  // A world that never saved (`null`) at tick 0 has nothing to lose and may leave.
  if (saved !== null) return saved >= tickAtRequest;
  return tickAtRequest === 0;
}

/**
 * The whole exit, in order: save → verify → teardown. `leave` runs only on success.
 *
 * Returns whether the exit happened, so the button can stop pretending otherwise.
 */
export async function performExit(deps: ExitDeps, leave: () => void): Promise<boolean> {
  const safe = await saveBeforeExit(deps);
  if (!safe) return false;
  leave();
  return true;
}
