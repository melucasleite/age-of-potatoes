// The channel the storage layer uses to speak to the PLAYER rather than to DevTools.
//
// WHY THIS EXISTS: `log.ts` writes to a console nobody has open. Work item 041's constraint is
// blunt — "Never fail a save silently. A silent failure is worse than a visible one because
// the player keeps playing." A `console.error` during an autosave is, from the far side of the
// screen, indistinguishable from everything working, right up until the tab closes and an hour
// of factory goes with it.
//
// So: storage publishes, the HUD subscribes, and neither imports the other's internals. This
// module is deliberately React-free and DOM-free — it is imported by `saves.ts`, which runs
// during boot before any component exists, and it must be safe during SSR.
//
// TWO RULES ABOUT THE WORDS THEMSELVES, because this is the only place in the codebase where
// an error is read by someone who cannot fix it:
//
//   1. NO JARGON. Not "QuotaExceededError", not "IndexedDB", not "envelope". The player is
//      being told what happened to their factory, not what happened to a transaction.
//   2. SAY WHAT IS SAFE. Every one of these fires at a moment where the honest worry is "did
//      I just lose everything?", so each body says what survived, out loud, first.
//
// `getSnapshot` never allocates, for the same reason `hud/store.ts` says so at length:
// `useSyncExternalStore` compares with `Object.is`, and a getter that mints a fresh array
// re-renders on every publish forever.

export type NoticeTone = 'info' | 'warning';

/**
 * Stable ids, so a notice replaces its previous self instead of stacking.
 *
 * An autosave that fails every minute must not build a tower of identical cards; it should
 * keep showing the one card that is still true.
 */
export const NoticeId = {
  /** The main save was unreadable or missing and the backup was loaded instead. */
  Recovered: 'save-recovered',
  /** Storage was full; something expendable was dropped to fit the save in. */
  QuotaFreed: 'save-quota-freed',
  /** Storage is full and the save did not land, even after making room. */
  QuotaFull: 'save-quota-full',
  /** A save failed for some reason that is not quota. */
  WriteFailed: 'save-write-failed',
  /** The browser declined to make this origin's storage permanent. */
  NotPersistent: 'storage-not-persistent',
} as const;

export type NoticeId = (typeof NoticeId)[keyof typeof NoticeId];

export interface SaveNotice {
  readonly id: NoticeId;
  readonly tone: NoticeTone;
  /** One short line. Reads on its own if that is all the player takes in. */
  readonly title: string;
  /** Two or three sentences. What happened, what is safe, what they can do. */
  readonly body: string;
}

const EMPTY: readonly SaveNotice[] = Object.freeze([]);

let current: readonly SaveNotice[] = EMPTY;
let listeners: (() => void)[] = [];

/** Ids published at least once this session, for `publishNoticeOnce`. */
const everPublished = new Set<string>();

/** The visible notices. Stable between changes — safe as a `useSyncExternalStore` getter. */
export function noticeSnapshot(): readonly SaveNotice[] {
  return current;
}

/**
 * The server's view: nothing, always.
 *
 * Storage never runs during SSR, so an empty list is not a placeholder — it is the truth, and
 * it hydrates without a mismatch.
 */
export function serverNoticeSnapshot(): readonly SaveNotice[] {
  return EMPTY;
}

export function subscribeNotices(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

/**
 * Show a notice, replacing any earlier one with the same id.
 *
 * Re-publishing after the player dismissed it is allowed and deliberate: a save that is STILL
 * failing ten minutes later is still worth saying. What is not allowed is two cards saying the
 * same thing at once.
 */
export function publishNotice(notice: SaveNotice): void {
  everPublished.add(notice.id);

  const index = current.findIndex((entry) => entry.id === notice.id);
  if (index >= 0) {
    const existing = current[index]!;
    if (existing.title === notice.title && existing.body === notice.body) return;
    const next = current.slice();
    next[index] = notice;
    commit(next);
    return;
  }

  commit([...current, notice]);
}

/**
 * Show a notice unless this id has already been shown this session.
 *
 * For the standing conditions rather than the events — "this browser might clear your save" is
 * true all session and does not become truer by being repeated.
 */
export function publishNoticeOnce(notice: SaveNotice): void {
  if (everPublished.has(notice.id)) return;
  publishNotice(notice);
}

export function dismissNotice(id: NoticeId): void {
  const next = current.filter((entry) => entry.id !== id);
  if (next.length === current.length) return;
  commit(next);
}

/** Tests only. Drops the visible notices and the "already said this" memory with them. */
export function resetNotices(): void {
  everPublished.clear();
  if (current.length > 0) commit([]);
}

function commit(next: SaveNotice[]): void {
  current = next.length === 0 ? EMPTY : Object.freeze(next);
  // Copied before iterating: a listener that unsubscribes itself during the loop (React does
  // exactly this on unmount) would otherwise skip whoever it shifted along.
  for (const listener of listeners.slice()) listener();
}
