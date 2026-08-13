// When the player was last actually here.
//
// THIS IS THE ONE WALL CLOCK IN THE GAME, AND IT LIVES HERE BECAUSE IT CANNOT LIVE ANYWHERE
// ELSE. §6 is explicit that the sim has no wall clock — "money and the clock are the same
// substance", ticks accrue only while the player is present, and §12 bans `Date` from
// `packages/sim` outright. A timestamp inside `WorldState` would change the state hash on
// every save and take every replay and every leaderboard down with it. So "time away" is a
// HOST concern, recorded next to the save rather than in it, in its own object store where
// no code path hands it to the sim (`db.ts`, `META_STORE`).
//
// PRESENCE IS GATED ON TICKS, NOT ON THE PAGE BEING OPEN. This is the whole subtlety of the
// file, and it is `autosave.ts`'s insight applied to a different question: that module
// refuses to save a world that is not accruing ticks, because "a world that is not accruing
// money should not be accruing saves". The same holds here. A tab left open overnight is not
// a player playing overnight — and if the timestamp kept advancing while nothing moved, the
// game would believe they were present until 4am, and a genuine week-long absence would be
// measured from the wrong end. So the clock below only writes when `state.tick` has MOVED
// since the last write. Wall clock answers "how long ago"; ticks answer "were they here".
//
// The consequence worth stating out loud: a player who leaves the tab open and walks away
// records their departure to within one poll interval, not to within one night.

//
// ONE RECORD PER WORLD, since work item 055. It used to be one record full stop, because the
// save layer used to assume one world; now each lot has its own visit, keyed `last-played:<id>`
// (`sessionKeyFor` in `worlds.ts`). This is not bookkeeping tidiness — the Welcome Back card
// asks "how long since YOU were HERE", and a global timestamp answers a different question. A
// player who plays Lot #2 daily and opens Lot #1 after a month must be greeted on Lot #1, and
// must not be greeted on Lot #2 the following morning because the other lot moved the clock.

import { META_STORE, type PlaySession, getDb, isStorageAvailable } from './db';
import { logWarn } from './log';
import { activeWorldId, sessionKeyFor } from './worlds';

/**
 * The pre-registry key, re-exported under its old name because it is part of this directory's
 * published surface. The adoption migration in `worlds.ts` moves this record onto the world it
 * adopts; nothing reads the bare key afterwards.
 */
export const SESSION_KEY = 'last-played';

/**
 * Which world's visit to read or write, defaulting to the active one.
 *
 * Resolved from the registry rather than passed in from the HUD, and that is the whole reason
 * the Welcome Back card needed no changes for multiple worlds: `useWelcomeBack` still calls
 * `readLastSession()` with no arguments and still gets the right answer, because the answer
 * was never the caller's to know.
 */
async function keyFor(worldId: string | undefined): Promise<string | null> {
  const id = worldId ?? (await activeWorldId());
  return id === null ? null : sessionKeyFor(id);
}

/** How often to look at the clock. Cheap: it reads one integer and usually returns. */
export const PRESENCE_POLL_MS = 20_000;

/**
 * Below this, a returning player is just a player. Six hours is deliberately far longer than
 * a lunch break and far shorter than the month §6 designs the card for — the card has to be
 * rare enough that seeing it means something, and re-orienting somebody who stepped away for
 * twenty minutes is the kind of help that reads as noise.
 */
export const WELCOME_BACK_THRESHOLD_MS = 6 * 60 * 60 * 1_000;

/**
 * A world with fewer ticks than this was opened, not played.
 *
 * 6,000 ticks is five active minutes. The Welcome Back card's job is to re-orient somebody to
 * "a factory they no longer remember building" (§6) — if they never built one, there is
 * nothing to re-orient them to and the card would be a stranger greeting them by name.
 */
export const PLAYED_ENOUGH_TICKS = 6_000;

/**
 * The last recorded visit, or null when there is none.
 *
 * NEVER THROWS. Storage being unavailable — SSR, private browsing, a blocked origin — is a
 * survivable condition everywhere else in this directory and it is survivable here too: the
 * honest answer to "when were they last here" is then "no idea", which is null, and the card
 * simply does not appear. A boot path must not fail over a nicety.
 *
 * MUST BE READ BEFORE `startPresenceClock` WRITES. The clock overwrites this record, so a
 * caller that starts the clock first will read back the current session and compute a gap of
 * zero. `useWelcomeBack` in the HUD does these in order for exactly that reason.
 */
export async function readLastSession(worldId?: string): Promise<PlaySession | null> {
  if (!isStorageAvailable()) return null;
  try {
    const key = await keyFor(worldId);
    if (key === null) return null;
    const db = await getDb();
    return (await db.get(META_STORE, key)) ?? null;
  } catch (error) {
    logWarn('Could not read the last-played timestamp.', error);
    return null;
  }
}

/** Record a visit at this instant. Best-effort: a failure here costs a card, not a world. */
export async function recordSession(tick: number, worldId?: string): Promise<void> {
  if (!isStorageAvailable()) return;
  try {
    const key = await keyFor(worldId);
    if (key === null) return;
    const db = await getDb();
    await db.put(META_STORE, { at: Date.now(), tick }, key);
  } catch (error) {
    logWarn('Could not record the last-played timestamp.', error);
  }
}

export interface PresenceHandle {
  /** Write now, regardless of the cadence. */
  flush(): void;
  stop(): void;
}

/**
 * Keep the last-played timestamp fresh while the player is actually playing.
 *
 * `getTick` returns null before the world exists, which is normal for the first frame or
 * two; the clock does nothing until it returns a number, and does nothing thereafter unless
 * that number has moved.
 */
export function startPresenceClock(
  getTick: () => number | null,
  options: { pollMs?: number; worldId?: string } = {},
): PresenceHandle {
  const pollMs = options.pollMs ?? PRESENCE_POLL_MS;

  let lastWrittenTick: number | null = null;
  let stopped = false;

  const write = (): void => {
    const tick = getTick();
    if (tick === null) return;
    // The tick has not moved: the world is not advancing, so the player is not here. Writing
    // anyway is what would make an overnight tab look like an overnight session.
    if (lastWrittenTick !== null && tick === lastWrittenTick) return;
    lastWrittenTick = tick;
    void recordSession(tick, options.worldId);
  };

  // Once immediately, so a session that ends in a crash thirty seconds in still leaves a
  // mark. Without it the gap would be measured from the *previous* session and a returning
  // player would be told they had been away longer than they were.
  write();

  const timer = setInterval(write, pollMs);

  // Best-effort teardown, exactly as `autosave.ts` describes at length: an async IndexedDB
  // write during page teardown is not reliable and no amount of `beforeunload` makes it so.
  // The cadence is the real guarantee; this just tightens the usual case.
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') write();
  };
  const onPageHide = (): void => {
    write();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide);
  }

  return {
    flush() {
      if (!stopped) write();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onPageHide);
      }
    },
  };
}

/**
 * Whether a recorded visit is long enough ago, and substantial enough, to be worth greeting.
 *
 * Both halves matter. The gap makes the card rare; the tick floor makes it TRUE — see
 * `PLAYED_ENOUGH_TICKS`. A card that fires for someone with no factory is worse than no card,
 * because the first thing it does is describe a factory that is not there.
 */
export function deservesWelcome(session: PlaySession | null, now: number): boolean {
  if (session === null) return false;
  if (session.tick < PLAYED_ENOUGH_TICKS) return false;
  const away = now - session.at;
  // A clock that ran backwards — the machine's time was corrected, or the record came from a
  // device an hour ahead. Not evidence of an absence, so it is not treated as one.
  if (away < 0) return false;
  return away >= WELCOME_BACK_THRESHOLD_MS;
}

/**
 * "three days" — the gap, in the coarsest unit that is still true.
 *
 * Deliberately vague, and for the same reason `format.ts` keeps the unlock ETA vague: a
 * returning player wants to know roughly how long it has been, and "2 days, 7 hours and 14
 * minutes" is a precision that invites them to check the arithmetic rather than look at
 * their factory. Rounds DOWN throughout, so the card never overstates the absence.
 */
export function formatTimeAway(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} minutes`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour' : `${hours} hours`;

  // The boundaries below are calendar-shaped rather than arithmetic, because the sentence is
  // read by a person and not by a clock. A month away is "a month", never "4 weeks" — the
  // arithmetic is defensible and nobody talks like that.
  const days = Math.floor(hours / 24);
  if (days >= 365) {
    const years = Math.floor(days / 365);
    return years === 1 ? 'a year' : `${years} years`;
  }
  if (days >= 31) {
    // Capped at 12 so the last few days before a year cannot round to "0 years" above.
    const months = Math.min(12, Math.floor(days / 30));
    return months === 1 ? 'a month' : `${months} months`;
  }
  if (days >= 14) return `${Math.floor(days / 7)} weeks`;
  return days === 1 ? 'a day' : `${days} days`;
}
