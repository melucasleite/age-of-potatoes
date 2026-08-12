// Cloud sync talks quietly, and mostly it does not talk at all.
//
// THE PLAYER MUST NOT BE ABLE TO TELL THAT SYNC EXISTS, let alone that it is failing. Plan
// §11: "Nothing about the game requires the server to be up." A paused Supabase project, a
// plane with no wifi, and a project that was never provisioned are all *normal operating
// conditions*, not incidents — so routine sync chatter goes to `console.debug`, which
// Chrome and Firefox both hide unless you opt into verbose logging.
//
// There is no toast, no modal, no banner, and no error boundary anywhere in this directory.
// That absence is the feature.

const PREFIX = '[snack-mogul/cloud]';

/** Routine sync chatter. Hidden behind DevTools' verbose filter, which is where it belongs. */
export function logDebug(message: string, detail?: unknown): void {
  if (detail === undefined) console.debug(`${PREFIX} ${message}`);
  else console.debug(`${PREFIX} ${message}`, detail);
}

/**
 * Something a developer would want to see without turning verbose on.
 *
 * Reserved for the handful of events that change what is on disk — adopting a cloud save,
 * stashing a conflict. Network failures are not in this category and must never use it.
 */
export function logInfo(message: string, detail?: unknown): void {
  if (detail === undefined) console.info(`${PREFIX} ${message}`);
  else console.info(`${PREFIX} ${message}`, detail);
}

/**
 * A misconfiguration a developer can fix — never a transient network fault.
 *
 * "The server is unreachable" is not a warning, it is Tuesday. "Your payload is about to
 * exceed the size §12 defers a redesign until" is.
 */
export function logWarn(message: string, detail?: unknown): void {
  if (detail === undefined) console.warn(`${PREFIX} ${message}`);
  else console.warn(`${PREFIX} ${message}`, detail);
}

/**
 * Fire a callback at most once for a given key, for the lifetime of the page.
 *
 * A sync loop that retries every few seconds behind a captive portal would otherwise print
 * the same line several hundred times, which is how a genuinely useful message becomes
 * something everyone filters out.
 */
const spoken = new Set<string>();

export function once(key: string, emit: () => void): void {
  if (spoken.has(key)) return;
  spoken.add(key);
  emit();
}
