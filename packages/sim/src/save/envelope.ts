// The save envelope: a world, described well enough to be read by a build that has not been
// written yet.
//
// Five fields, all at the top level, all legible in a text editor:
//
//   formatVersion — the envelope/payload shape. Drives the migration chain.
//   simVersion    — sim code version + balance data hash. Informational on mismatch.
//   worldSeed     — the RNG seed the world was born with.
//   tick          — the active-hour clock. Plan §6: money and the clock are one substance.
//   payload       — plain JSON `WorldState`, minus the trace. See canonical.ts.
//
// `worldSeed` and `tick` are duplicated out of the payload on purpose. They are the two
// things you want to read off a save without parsing it — for a save list, for a bug report,
// for a sync layer deciding which of two copies is further along — and duplicating two
// integers is cheaper than every consumer having to understand the payload to get them.
// `deserialize` reads them from the payload, so the payload stays the single source of truth
// and the envelope copies are a convenience that cannot drift into being authoritative.
//
// The whole thing is one self-describing JSON blob, which is what makes cloud sync (work
// item 016) an upload rather than a redesign.

import type { TraceEntry, WorldState } from '../state';
import { type SavePayload, fromPayload, toPayload } from './canonical';
import { SaveCorruptError } from './errors';
import { CURRENT_FORMAT_VERSION } from './migrations';
import { SIM_VERSION } from './version';

export interface SaveEnvelope {
  /** Envelope/payload shape version. Drives the migration chain. */
  formatVersion: number;
  /** Sim code version fused with the balance data hash. See version.ts. */
  simVersion: string;
  /** The uint32 every RNG stream in this world was derived from. */
  worldSeed: number;
  /** The tick the save was taken at. Copied from the payload for cheap inspection. */
  tick: number;
  /**
   * The world as plain JSON. Typed `unknown` because it is only known-shaped *after* a
   * migration run — a format-3 save handed to a format-7 build holds a shape this code has
   * never seen, and pretending otherwise is how a migration chain gets skipped.
   */
  payload: unknown;
}

/** Take a save. Pure, allocating, and safe to call mid-tick — the payload is a deep copy. */
export function serialize(state: WorldState): SaveEnvelope {
  return {
    formatVersion: CURRENT_FORMAT_VERSION,
    simVersion: SIM_VERSION,
    worldSeed: state.worldSeed,
    tick: state.tick,
    payload: toPayload(state),
  };
}

/**
 * Rebuild a world from an envelope that is already at `CURRENT_FORMAT_VERSION`.
 *
 * Run `migrate()` first. This throws rather than migrating implicitly, because a
 * `deserialize` that quietly accepted an old format would let a missing migration look like
 * a working load right up until the field it forgot about mattered.
 *
 * Accumulators are restored verbatim, never recomputed (plan §12): they are inside the hash,
 * so a recomputed value would produce a world that hashes differently from the one saved.
 *
 * `trace` is optional and stored separately — see canonical.ts. Omitting it yields an empty
 * log, which is correct and does not affect the hash.
 */
export function deserialize(envelope: SaveEnvelope, trace: readonly TraceEntry[] = []): WorldState {
  if (envelope.formatVersion !== CURRENT_FORMAT_VERSION) {
    throw new SaveCorruptError(
      `deserialize() needs a save at format ${String(CURRENT_FORMAT_VERSION)}, got ${String(
        envelope.formatVersion,
      )}. Run migrate() first.`,
    );
  }
  return fromPayload(envelope.payload, trace);
}

/**
 * Validate an untrusted value — anything read back out of IndexedDB, a file, or a sync
 * endpoint — as an envelope.
 *
 * Only the four scalar header fields are checked here, plus that the payload is an object.
 * The payload's *shape* deliberately is not: it may legitimately be an old format that only
 * a migration knows how to read, and validating it against today's shape would reject
 * exactly the saves the chain exists to rescue.
 */
export function parseEnvelope(value: unknown): SaveEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SaveCorruptError('Stored save is not an object.');
  }
  const raw = value as Record<string, unknown>;

  const formatVersion = raw['formatVersion'];
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new SaveCorruptError(
      `Stored save has no usable \`formatVersion\` (found ${JSON.stringify(formatVersion) ?? 'undefined'}).`,
    );
  }

  const simVersion = raw['simVersion'];
  if (typeof simVersion !== 'string') {
    throw new SaveCorruptError('Stored save has no `simVersion` string.');
  }

  const worldSeed = raw['worldSeed'];
  if (typeof worldSeed !== 'number' || !Number.isInteger(worldSeed)) {
    throw new SaveCorruptError('Stored save has no integer `worldSeed`.');
  }

  const tick = raw['tick'];
  if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0) {
    throw new SaveCorruptError('Stored save has no integer `tick`.');
  }

  const payload = raw['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SaveCorruptError('Stored save has no `payload` object.');
  }

  return { formatVersion, simVersion, worldSeed, tick, payload };
}

/** The payload shape this build writes, for consumers that want it named. */
export type { SavePayload };
