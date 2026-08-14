// The slot ladder: three rolling copies, one milestone, newest good record wins.
//
// WHAT THIS FILE PROVES that `write-verify.test.ts` and `worlds.test.ts` do not: the shape of
// the ladder itself. That three saves deep is actually three saves deep, that the milestone
// runs on its own cadence rather than the autosave's, that a load walks DOWN the ladder in
// tick order rather than key order, and that the quota ladder gives the slots up oldest-first
// with `previous` — the parachute for the very next torn write — held back until last.
//
// Everything runs against `memorySaveStore`, for the reason `saves.ts` documents at the
// interface: there is no IndexedDB in this workspace's test environment, and the rotation and
// fallback logic is exactly the code most worth exercising for real.

import { beforeEach, describe, expect, it } from 'vitest';
import { type SaveEnvelope, createWorld, serialize } from '@snack/sim';

import {
  MILESTONE_INTERVAL_TICKS,
  type SaveRecordStore,
  loadWorld,
  memorySaveStore,
  saveWorld,
} from './saves';
import { NoticeId, noticeSnapshot, resetNotices } from './notices';
import { currentKeyFor, milestoneKeyFor, olderKeyFor, previousKeyFor } from './worlds';

let counter = 0;
function nextWorld(): string {
  counter += 1;
  return `slot-test-${String(counter)}`;
}

function worldAt(tick: number, seed = 424_242) {
  const state = createWorld(seed);
  state.tick = tick;
  return state;
}

function envelopeAt(tick: number, seed = 424_242): SaveEnvelope {
  return serialize(worldAt(tick, seed));
}

/** An envelope that parses as an envelope but whose payload cannot become a world. */
function corruptAt(tick: number): SaveEnvelope {
  return { ...envelopeAt(tick), payload: {} } as SaveEnvelope;
}

/** An envelope claiming a format this build has never heard of. */
function futureAt(tick: number): SaveEnvelope {
  const envelope = envelopeAt(tick);
  return { ...envelope, formatVersion: envelope.formatVersion + 99 };
}

/** A store whose next write is refused the way a full disk refuses it. */
function quotaOnce(inner: SaveRecordStore & { keys(): string[] }) {
  let failNext = true;
  return {
    ...inner,
    rotate(worldId: string, envelope: SaveEnvelope) {
      if (failNext) {
        failNext = false;
        const error = new Error('quota exceeded');
        error.name = 'QuotaExceededError';
        return Promise.reject(error);
      }
      return inner.rotate(worldId, envelope);
    },
  };
}

beforeEach(() => {
  resetNotices();
});

describe('the rolling slots', () => {
  it('is three saves deep: current, previous, and older', async () => {
    const id = nextWorld();
    const store = memorySaveStore();

    await saveWorld(worldAt(100), { worldId: id, store });
    await saveWorld(worldAt(200), { worldId: id, store });
    await saveWorld(worldAt(300), { worldId: id, store });

    const { current, previous, older } = await store.read(id);
    expect(current?.tick).toBe(300);
    expect(previous?.tick).toBe(200);
    expect(older?.tick).toBe(100);
  });

  it('stamps every slot with the tick it was written at', async () => {
    const id = nextWorld();
    const store = memorySaveStore();

    await saveWorld(worldAt(700), { worldId: id, store });

    const { current, milestone } = await store.read(id);
    // The stamp is the envelope's own `tick` — there is no separate bookkeeping to drift.
    expect(current?.tick).toBe(700);
    expect(milestone?.tick).toBe(700);
  });
});

describe('the milestone cadence', () => {
  it('writes a milestone with the first save, then holds until the interval elapses', async () => {
    const id = nextWorld();
    const store = memorySaveStore();

    await saveWorld(worldAt(100), { worldId: id, store });
    expect((await store.read(id)).milestone?.tick).toBe(100);

    // A minute later: the rolling slots move, the milestone does not.
    await saveWorld(worldAt(1_300), { worldId: id, store });
    expect((await store.read(id)).milestone?.tick).toBe(100);

    // Past the interval: now it moves.
    await saveWorld(worldAt(100 + MILESTONE_INTERVAL_TICKS), { worldId: id, store });
    expect((await store.read(id)).milestone?.tick).toBe(100 + MILESTONE_INTERVAL_TICKS);
  });

  it('keeps the milestone usefully far from the rolling slots', async () => {
    // The point of the slot: after a long session the rolling copies are all within a couple
    // of minutes of the head, and the milestone is the one record from a different era.
    const id = nextWorld();
    const store = memorySaveStore();

    for (let tick = 0; tick <= 6_000; tick += 1_200) {
      await saveWorld(worldAt(tick), { worldId: id, store });
    }

    const { current, previous, older, milestone } = await store.read(id);
    expect(current?.tick).toBe(6_000);
    expect(previous?.tick).toBe(4_800);
    expect(older?.tick).toBe(3_600);
    expect(milestone?.tick).toBe(0);
  });
});

describe('loading walks the ladder, newest good record first', () => {
  it('falls from a corrupt current to previous, and says so', async () => {
    const id = nextWorld();
    const store = memorySaveStore([
      [currentKeyFor(id), corruptAt(300)],
      [previousKeyFor(id), envelopeAt(200)],
    ]);

    const outcome = await loadWorld({ worldId: id, store });
    expect(outcome.status).toBe('loaded');
    if (outcome.status !== 'loaded') return;
    expect(outcome.source).toBe('previous');
    expect(outcome.state.tick).toBe(200);

    const notice = noticeSnapshot().find((entry) => entry.id === NoticeId.Recovered);
    expect(notice).toBeDefined();
    expect(notice?.body).toContain('about a minute');
  });

  it('falls through two corrupt slots to older', async () => {
    const id = nextWorld();
    const store = memorySaveStore([
      [currentKeyFor(id), corruptAt(300)],
      [previousKeyFor(id), corruptAt(200)],
      [olderKeyFor(id), envelopeAt(100)],
    ]);

    const outcome = await loadWorld({ worldId: id, store });
    expect(outcome.status).toBe('loaded');
    if (outcome.status !== 'loaded') return;
    expect(outcome.source).toBe('older');
    expect(outcome.state.tick).toBe(100);
  });

  it('reaches the milestone when every rolling slot is bad, and owns up to the cost', async () => {
    const id = nextWorld();
    const store = memorySaveStore([
      [currentKeyFor(id), corruptAt(13_000)],
      [previousKeyFor(id), corruptAt(11_800)],
      [olderKeyFor(id), corruptAt(10_600)],
      [milestoneKeyFor(id), envelopeAt(1_000)],
    ]);

    const outcome = await loadWorld({ worldId: id, store });
    expect(outcome.status).toBe('loaded');
    if (outcome.status !== 'loaded') return;
    expect(outcome.source).toBe('milestone');

    const notice = noticeSnapshot().find((entry) => entry.id === NoticeId.Recovered);
    expect(notice?.body).toContain('ten minutes');
  });

  it('orders candidates by tick, not by slot name', async () => {
    // A freshly written milestone carries a newer tick than `older`. If both survive a
    // disaster that takes `current` and `previous`, the milestone is the smaller loss and
    // must win despite being last in slot order.
    const id = nextWorld();
    const store = memorySaveStore([
      [currentKeyFor(id), corruptAt(12_400)],
      [previousKeyFor(id), corruptAt(12_300)],
      [olderKeyFor(id), envelopeAt(100)],
      [milestoneKeyFor(id), envelopeAt(12_000)],
    ]);

    const outcome = await loadWorld({ worldId: id, store });
    expect(outcome.status).toBe('loaded');
    if (outcome.status !== 'loaded') return;
    expect(outcome.source).toBe('milestone');
    expect(outcome.state.tick).toBe(12_000);
  });

  it('refuses a future-format save outright rather than playing an older copy over it', async () => {
    // Falling back would be worse than failing: an autosave under this stale build would
    // rotate the future save down the ladder and, three saves later, off the end of it.
    const id = nextWorld();
    const store = memorySaveStore([
      [currentKeyFor(id), futureAt(300)],
      [previousKeyFor(id), envelopeAt(200)],
    ]);

    const outcome = await loadWorld({ worldId: id, store });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.reason).toBe('format-too-new');
  });

  it('refuses with every slot corrupt, deleting nothing', async () => {
    const id = nextWorld();
    const store = memorySaveStore([
      [currentKeyFor(id), corruptAt(300)],
      [previousKeyFor(id), corruptAt(200)],
    ]);

    const outcome = await loadWorld({ worldId: id, store });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.reason).toBe('unreadable');
    // Both records are still exactly where they were found.
    expect(store.keys()).toEqual([currentKeyFor(id), previousKeyFor(id)]);
  });
});

describe('the quota ladder and the slots', () => {
  it('gives up the oldest rolling slot first', async () => {
    const id = nextWorld();
    const inner = memorySaveStore();
    for (const tick of [100, 1_300, 2_500]) {
      await saveWorld(worldAt(tick), { worldId: id, store: inner });
    }

    const result = await saveWorld(worldAt(3_700), { worldId: id, store: quotaOnce(inner) });
    expect(result.freed).toContain('oldest');

    // The save landed via the retry, so the rotation ran: older now holds what previous did.
    const { current, previous, older, milestone } = await inner.read(id);
    expect(current?.tick).toBe(3_700);
    expect(previous?.tick).toBe(2_500);
    expect(older?.tick).toBe(1_300);
    expect(milestone?.tick).toBe(100);
  });

  it('gives up the milestone before the parachute', async () => {
    const id = nextWorld();
    const inner = memorySaveStore([
      [currentKeyFor(id), envelopeAt(1_300)],
      [previousKeyFor(id), envelopeAt(100)],
      [milestoneKeyFor(id), envelopeAt(100)],
    ]);

    const result = await saveWorld(worldAt(2_500), { worldId: id, store: quotaOnce(inner) });
    expect(result.freed).toContain('long-term');

    const { previous, milestone } = await inner.read(id);
    // The parachute survived; the milestone went, and was NOT immediately rewritten — a save
    // that only landed because room was freed does not spend that room on a backup.
    expect(previous?.tick).toBe(1_300);
    expect(milestone).toBeUndefined();
  });

  it('gives up the parachute only when it is the last thing left', async () => {
    const id = nextWorld();
    const inner = memorySaveStore([
      [currentKeyFor(id), envelopeAt(1_300)],
      [previousKeyFor(id), envelopeAt(100)],
    ]);

    const result = await saveWorld(worldAt(2_500), { worldId: id, store: quotaOnce(inner) });
    expect(result.freed).toContain('spare backup');
    expect((await inner.read(id)).current?.tick).toBe(2_500);
  });
});
