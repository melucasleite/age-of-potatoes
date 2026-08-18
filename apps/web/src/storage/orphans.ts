// Lots whose save is on disk with nothing pointing at it ([[138]]).
//
// WHY THIS SHIPS ALONGSIDE THE FIX RATHER THAN AFTER IT. The two-tab clobber lost registry
// records, not save envelopes — the registry is one record in `worlds` and the envelopes are
// separate records in `saves`, and the clobbering write could not reach them. So the factories
// survived every occurrence of this bug. What did not survive was the only thing that knows
// they exist: nothing in this directory ever enumerates the `saves` store, every read is by
// explicit world id, and so an envelope with no registry row is not merely unlisted but
// UNREACHABLE. It is never collected and never found. It sits there for good, invisible.
//
// This was not hypothetical when the fix was written. The author's own browser held four such
// worlds — thirteen envelopes, every one of them parsing, with ticks and seeds and money in
// them — and would have held them forever.
//
// WHAT IT IS AND IS NOT. It rebuilds the CARD from the envelope: the id is in the key, and the
// seed, tick and format are in the envelope. It does not migrate anything, does not restore a
// world, and does not write a single byte into `saves` — a rescue that modified the thing it
// was rescuing would be a poor sort of rescue. The world is simply on the list again, and
// opening it goes down the ordinary load path with the ordinary slot ladder and the ordinary
// refusals, exactly as if it had never been lost.
//
// THIS IS `planLegacyAdoption` POINTED SOMEWHERE ELSE, and deliberately so — the pre-registry
// adoption migration in `worlds.ts` solves the identical problem for the identical reason (a
// save on disk that the list does not know about) and its shape has been load-bearing long
// enough to trust.
//
// NOTHING HERE IMPORTS `worlds.ts`. That module orchestrates this one, on the first read of
// the registry, and the arrow points one way like every other arrow in this directory. The
// two things this file would otherwise have reached back for — a money peek and the clock —
// arrive as arguments instead, which is also what makes the planner testable without a
// browser.

import type { SaveEnvelope } from '@snack/sim';

import { SAVES_STORE, type WorldRecord, type WorldRegistry, getDb } from './db';
import { logInfo } from './log';
import { NoticeId, publishNotice } from './notices';

/** A world id found in the `saves` store, with the best envelope behind it. */
export interface OrphanFinding {
  worldId: string;
  /** The newest slot that looked like an envelope. Never migrated, never restored. */
  envelope: SaveEnvelope;
}

export interface RescueContext {
  now: number;
  /** `peekMoneyCents` from `worlds.ts`, injected rather than imported — see the header. */
  peekMoney: (payload: unknown) => number | null;
}

/**
 * The slots that mean "there is a world here".
 *
 * `conflict` is NOT one of them. It is where `cloudHandoff.ts` parks another device's world
 * when it declines to overwrite a newer local one, so a lone `conflict` record is a world that
 * belongs to a registry somewhere else — putting it on this machine's list would be inventing
 * a lot rather than recovering one.
 */
const WORLD_SLOTS = ['current', 'previous', 'older', 'milestone'] as const;

/** `w:<id>:<slot>` → its parts, or null for anything else in the store. */
export function parseSaveKey(key: string): { worldId: string; slot: string } | null {
  const parts = key.split(':');
  if (parts.length !== 3 || parts[0] !== 'w') return null;
  const [, worldId, slot] = parts;
  if (worldId === undefined || worldId === '' || slot === undefined) return null;
  return { worldId, slot };
}

/** Every world id that has at least one real save slot on disk, in the order first seen. */
export function worldIdsWithSaves(keys: readonly string[]): string[] {
  const slots = new Set<string>(WORLD_SLOTS);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const parsed = parseSaveKey(key);
    if (parsed === null || !slots.has(parsed.slot)) continue;
    if (seen.has(parsed.worldId)) continue;
    seen.add(parsed.worldId);
    ids.push(parsed.worldId);
  }
  return ids;
}

/**
 * Does this look like a save envelope?
 *
 * GUARDED TO THE POINT OF PARANOIA, for `peekMoneyCents`' reason: it reads a value that may
 * have been written by a build that no longer exists, and the only thing riding on it is a
 * line on a card. It checks the three fields the card needs and nothing else — deciding
 * whether a PAYLOAD is good is `restoreWorld`'s job, and doing it badly here would refuse to
 * rescue a world that loads perfectly well.
 */
export function peekEnvelope(value: unknown): SaveEnvelope | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { worldSeed, tick, formatVersion } = record;
  if (typeof worldSeed !== 'number' || !Number.isFinite(worldSeed)) return null;
  if (typeof tick !== 'number' || !Number.isFinite(tick)) return null;
  if (typeof formatVersion !== 'number' || !Number.isFinite(formatVersion)) return null;
  return value as SaveEnvelope;
}

/**
 * "Recovered lot #2" — the lowest free number.
 *
 * A NAME OF ITS OWN RATHER THAN "Lot #N", because the player has never seen this lot's card
 * and is about to. A row appearing on the front door under an ordinary-looking name is
 * indistinguishable from a bug; one that says what it is answers the question before it is
 * asked, and it goes on saying it a month later when the notice is long forgotten.
 */
export function nextRescuedName(registry: WorldRegistry): string {
  const taken = new Set(
    registry.worlds.filter((world) => world.deletedAt === null).map((world) => world.name),
  );
  for (let n = 1; ; n++) {
    const candidate = `Recovered lot #${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Put the findings back on the list. Pure — no database, no clock, no randomness.
 *
 * `lastPlayedAt` IS THE ONLY INTERESTING DECISION HERE, and it goes deliberately backwards.
 * Nothing on disk records when a lost world was last played, and `now` is the one answer that
 * is definitely wrong: it would sort the rescued lot to the top of the front door and make it
 * the world `Continue` opens, so a player pressing the biggest button on the screen would land
 * in a stranger's lot instead of their own farm. Sorting it last is a guess too, but it is a
 * guess that costs a scroll rather than a fright — and it is the more honest one, because a
 * world nobody could open has not been played recently by anybody.
 */
export function planOrphanRescue(
  registry: WorldRegistry,
  found: readonly OrphanFinding[],
  context: RescueContext,
): { registry: WorldRegistry; rescued: WorldRecord[] } {
  const known = new Set(registry.worlds.map((world) => world.id));
  const oldest = registry.worlds.reduce(
    (low, world) => Math.min(low, world.lastPlayedAt),
    Number.POSITIVE_INFINITY,
  );
  let bury = Number.isFinite(oldest) ? oldest : context.now;

  let next = registry;
  const rescued: WorldRecord[] = [];

  for (const orphan of found) {
    // A tombstoned world is NOT an orphan: its record is right there with `deletedAt` set, and
    // its envelopes are meant to outlive it for fourteen days. `known` covers both states,
    // which is exactly why the check is on the id and not on `liveWorlds`.
    if (known.has(orphan.worldId)) continue;
    bury -= 1;
    const record: WorldRecord = {
      id: orphan.worldId,
      name: nextRescuedName(next),
      seed: orphan.envelope.worldSeed,
      // No record of this exists either. It is used for nothing but breaking a sort tie.
      createdAt: context.now,
      lastPlayedAt: bury,
      summary: {
        tick: orphan.envelope.tick,
        moneyCents: context.peekMoney(orphan.envelope.payload),
        formatVersion: orphan.envelope.formatVersion,
      },
      deletedAt: null,
    };
    next = { ...next, worlds: [...next.worlds, record] };
    known.add(record.id);
    rescued.push(record);
  }

  return { registry: next, rescued };
}

/**
 * Everything in `saves` that the registry has never heard of.
 *
 * One key enumeration of a store that holds at most five records per world, then at most four
 * gets per candidate — and on the overwhelmingly common path there are no candidates and it
 * stops after the enumeration. That is what makes it affordable on the read that draws the
 * front door, which is where it has to run: a player whose only worlds were orphaned has no
 * lot to boot, and a rescue that waited for a boot would never reach the person who needs it.
 */
export async function findOrphanedWorlds(known: ReadonlySet<string>): Promise<OrphanFinding[]> {
  const db = await getDb();
  const keys = (await db.getAllKeys(SAVES_STORE)) as string[];
  const candidates = worldIdsWithSaves(keys).filter((id) => !known.has(id));
  if (candidates.length === 0) return [];

  const found: OrphanFinding[] = [];
  for (const worldId of candidates) {
    let best: SaveEnvelope | null = null;
    for (const slot of WORLD_SLOTS) {
      const stored: unknown = await db.get(SAVES_STORE, `w:${worldId}:${slot}`);
      const envelope = peekEnvelope(stored);
      if (envelope === null) continue;
      if (best === null || envelope.tick > best.tick) best = envelope;
    }
    // An id whose slots hold nothing readable is left exactly where it is. There is no card to
    // be built from it, and inventing one would put a lot on the front door that opens onto a
    // refusal — which is a worse experience than the lot not being there.
    if (best !== null) found.push({ worldId, envelope: best });
  }
  return found;
}

/**
 * Say what happened, out loud.
 *
 * Good news, which is why it is `info` — but it is still news, because these lots are about to
 * appear under names the player has never seen, and a row that shows up unannounced looks far
 * more like a bug than like a rescue.
 */
export function announceRescue(rescued: readonly WorldRecord[]): void {
  const count = rescued.length;
  const one = count === 1;
  const names = rescued.map((world) => world.name).join(', ');
  logInfo(`Put ${String(count)} lot(s) back on the list: ${names}.`);

  publishNotice({
    id: NoticeId.WorldsRescued,
    tone: 'info',
    title: one
      ? 'A lot was found and put back on your list.'
      : `${String(count)} lots were found and put back on your list.`,
    body:
      (one
        ? 'A saved farm was sitting in this browser with nothing on the front door pointing at '
        : 'Saved farms were sitting in this browser with nothing on the front door pointing at ') +
      `${one ? 'it' : 'them'}, so the game has put ${one ? 'it' : 'them'} back. Nothing was ` +
      `lost and nothing was changed — only the card went missing, never the farm. ` +
      `${one ? 'It is' : 'They are'} at the bottom of your list as ${names}, because there is ` +
      `no record of when ${one ? 'it was' : 'they were'} last played. Open ${one ? 'it' : 'them'} ` +
      'to see what is there, and rename or delete as you like.',
  });
}
