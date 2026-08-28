// The cloud leaderboard's read path. One view, two orderings, no writes.
//
// EVERYTHING HARD ALREADY HAPPENED SERVER-SIDE. The `public.leaderboard` view coalesces
// missing names to 'Anonymous Mogul', filters cheated saves out, and computes
// `cents_per_active_hour` with the exact formula `rate.ts` uses — including returning NULL
// below six active minutes, which is `MIN_RATE_SPAN_TICKS` wearing SQL. Nothing here
// re-derives, re-filters, or second-guesses a row: a client that recomputes a server stat is
// how the panel and the database end up disagreeing about the same player.
//
// NEVER THROWS, NEVER REJECTS. The game is local-first (plan §11: "Nothing about the game
// requires the server to be up"), so both ways this can fail are ordinary states with names,
// not errors: `unconfigured` means `getSupabaseClient()` returned null — no project
// provisioned, or a server render — and `offline` is everything else, because from the
// panel's point of view "the network is down" and "the query broke" call for the same calm
// sentence and neither deserves a stack trace.

import { getSupabaseClient } from '@/supabase/client';

/** The two boards: lifetime total, and the settled hourly rate. */
export type LeaderboardKind = 'total' | 'perHour';

/** One row of `public.leaderboard`, camel-cased. All money is integer cents. */
export interface LeaderboardRow {
  readonly userId: string;
  readonly slot: string;
  /** Already coalesced server-side; never empty. */
  readonly displayName: string;
  readonly lifetimeEarnedCents: number;
  /** 20 Hz ticks of active play. 72,000 is one active hour; `formatTicks` knows this. */
  readonly ticksElapsed: number;
  /** null below six active minutes — the same floor `rate.ts` calls `MIN_RATE_SPAN_TICKS`. */
  readonly centsPerActiveHour: number | null;
  readonly updatedAt: string;
}

export type LeaderboardResult =
  | { readonly ok: true; readonly rows: readonly LeaderboardRow[] }
  | { readonly ok: false; readonly reason: 'unconfigured' | 'offline' };

const COLUMNS =
  'user_id, slot, display_name, lifetime_earned_cents, ticks_elapsed, cents_per_active_hour, updated_at';

/**
 * The top `limit` rows of one board, best first.
 *
 * The per-hour board excludes NULL rates in the query rather than after it: a NULL is not a
 * zero, it is "too early to say", and a board that ranked it would fill its bottom with
 * players who have not finished warming up.
 */
export async function fetchLeaderboard(
  kind: LeaderboardKind,
  limit = 50,
): Promise<LeaderboardResult> {
  const client = getSupabaseClient();
  if (client === null) return { ok: false, reason: 'unconfigured' };

  try {
    // Filters before transforms: `.not()` lives on the filter builder, which `.limit()`
    // narrows away, so the limit goes last.
    const base = client.from('leaderboard').select(COLUMNS);
    const { data, error } =
      kind === 'perHour'
        ? await base
            .not('cents_per_active_hour', 'is', null)
            .order('cents_per_active_hour', { ascending: false })
            .limit(limit)
        : await base.order('lifetime_earned_cents', { ascending: false }).limit(limit);

    if (error !== null || data === null) return { ok: false, reason: 'offline' };

    // A malformed row is dropped rather than rendered — a leaderboard entry reading "NaN"
    // costs the whole board its credibility, and the rows around it are still good.
    const rows: LeaderboardRow[] = [];
    for (const raw of data as unknown[]) {
      const row = toRow(raw);
      if (row !== null) rows.push(row);
    }
    return { ok: true, rows };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

/** One row, checked field by field. Postgres bigints arrive as JSON numbers over PostgREST. */
function toRow(raw: unknown): LeaderboardRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const userId = record['user_id'];
  const slot = record['slot'];
  const displayName = record['display_name'];
  const earned = record['lifetime_earned_cents'];
  const ticks = record['ticks_elapsed'];
  const rate = record['cents_per_active_hour'];
  const updatedAt = record['updated_at'];

  if (typeof userId !== 'string' || typeof slot !== 'string') return null;
  if (typeof displayName !== 'string' || displayName === '') return null;
  if (typeof earned !== 'number' || !Number.isFinite(earned)) return null;
  if (typeof ticks !== 'number' || !Number.isFinite(ticks)) return null;
  if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate))) return null;

  return {
    userId,
    slot,
    displayName,
    lifetimeEarnedCents: earned,
    ticksElapsed: ticks,
    centsPerActiveHour: rate,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
  };
}
