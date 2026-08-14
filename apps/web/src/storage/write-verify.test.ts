// Write-then-verify: the guard that would have caught the frankensave.
//
// WHAT THESE TESTS ARE ACTUALLY DEFENDING. Work item 041's log records a real incident: an HMR
// window produced a save stamped with a NEW format version by a reloaded migrations module but
// serialized by a STALE canonical module, so it claimed the current format and was missing a
// field that format requires. Every gate the layer had went past it — the version check compared
// the stamp against itself and agreed — and the rotation then destroyed the last good save with
// the first bad write and the evidence with the second.
//
// So the poisoned serializer below is not a made-up shape. It is that bug, reproduced: a correct
// current-version stamp on a payload with `inputCounts` missing from a machine. It passes
// `parseEnvelope`, it passes `migrate` (nothing to migrate — the stamp is current), and it dies
// in `fromPayload`, several layers below anything a schema check would have inspected. A test
// that faked the failure by throwing from a stub would prove the plumbing and miss the point;
// this one fails where the real one failed.
//
// The assertion that matters most is not that it throws. It is that THE PREVIOUS RECORD IS STILL
// THE NEWEST ONE afterwards — because the incident was not "a bad save happened", it was "a bad
// save became the only save".

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type SaveEnvelope, type WorldState, createWorld, serialize } from '@snack/sim';

// Quarantine writes to IndexedDB, which does not exist in this environment — `quarantineRecord`
// would return 'failed' and assert nothing. Mocked so the call itself is observable, since "the
// evidence was filed" is a requirement in its own right: the rejected bytes are never written to
// disk, so this copy is the entire investigation rather than a convenience. `describeError` is
// kept real because `saves.ts` uses it to build the dedupe signature, and a stubbed one would
// make the dedupe test pass for the wrong reason.
// Typed with its argument rather than as a bare `vi.fn()`, so `mock.calls[0][0]` is a value the
// compiler knows exists — an untyped spy makes the calls list an empty tuple and the assertions
// below unwritable.
const quarantined = vi.fn((_input: { slot: string; record: unknown; error: unknown }) =>
  Promise.resolve('quarantined' as const),
);
vi.mock('./quarantine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quarantine')>();
  return { ...actual, quarantineRecord: quarantined };
});

const { NoticeId, noticeSnapshot, resetNotices } = await import('./notices');
const { memorySaveStore, saveWorld } = await import('./saves');
const { SaveRejectedError, saveRejectedMessage, verifySave } = await import('./verify');
const { REJECT_BACKOFF_STEPS, rejectBackoff } = await import('./autosave');

/**
 * A world id nothing else in this file uses.
 *
 * NOT TIDINESS — the tests genuinely interfere otherwise, and the way they interfere is worth
 * recording because it is the feature working. `saves.ts` files a rejected write once per
 * session per fault, keyed on world plus error, so a second test reusing one world id looks to
 * the layer like the same save failing twice and is correctly not filed again. Distinct worlds
 * are distinct faults, which is both what the dedupe means and what these tests need.
 */
let worldCounter = 0;
function nextWorld(): string {
  worldCounter++;
  return `w-test-${String(worldCounter)}`;
}

function world(tick = 0): WorldState {
  const state = createWorld(20260812);
  state.tick = tick;
  return state;
}

/**
 * The frankensave, built the way the real one was built.
 *
 * Stamp is honest-looking and current, so the version gate has nothing to object to; the payload
 * is missing a field the current format requires, so the restore path throws where it really
 * threw. Deliberately NOT a hand-written envelope: it is a real `serialize()` output with one
 * field removed, so it stays a valid save in every respect except the one being tested.
 */
function poisonedSerialize(state: WorldState): SaveEnvelope {
  const envelope = serialize(state);
  const payload = envelope.payload as unknown as { machines: Record<string, unknown>[] };
  expect(payload.machines.length).toBeGreaterThan(0);
  delete payload.machines[0]!.inputCounts;
  return envelope;
}

beforeEach(() => {
  resetNotices();
  quarantined.mockClear();
});

describe('verifySave', () => {
  it('passes a real save, and hands back the json it already stringified', () => {
    const state = world();
    const result = verifySave(serialize(state), state);

    expect(result.ok).toBe(true);
    expect(result.failure).toBeNull();
    // Reused rather than stringified twice — `saveWorld` needs this for `bytes`.
    expect(result.json).toBeTypeOf('string');
    expect(result.bytes).toBe(result.json!.length);
  });

  it('fails the frankensave in the restore path, not in a shape check', () => {
    const state = world();
    const result = verifySave(poisonedSerialize(state), state);

    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe('unreadable');
    // The error came from the sim's loader, which is the whole claim being made here: the check
    // is the boot path rather than a validator that happens to agree with it.
    expect(String((result.failure?.error as Error).message)).toMatch(/inputCounts/i);
  });

  it('catches a save that loads into a DIFFERENT world', () => {
    // The quieter corruption: everything parses, everything restores, and the factory that comes
    // back is not the one that was saved. No structural check can see this — only the hash can.
    const state = world();
    const envelope = serialize(state);
    (envelope.payload as unknown as { moneyCents: number }).moneyCents += 1_000;

    const result = verifySave(envelope, state);
    expect(result.ok).toBe(false);
    expect(result.failure?.reason).toBe('lossy');
  });

  it('never throws, even on something that cannot be stringified at all', () => {
    const state = world();
    const cyclic = serialize(state) as unknown as { self?: unknown };
    cyclic.self = cyclic;

    const result = verifySave(cyclic as unknown as SaveEnvelope, state);
    expect(result.ok).toBe(false);
    expect(result.json).toBeNull();
  });
});

describe('saveWorld with a poisoned serializer', () => {
  it('leaves the previous good record as the newest one', async () => {
    const id = nextWorld();
    const store = memorySaveStore();

    await saveWorld(world(100), { worldId: id, store });
    expect((await store.read(id)).current?.tick).toBe(100);

    // Now the world moves on and the serializer breaks — the exact incident.
    await expect(
      saveWorld(world(200), { worldId: id, store, serialize: poisonedSerialize }),
    ).rejects.toBeInstanceOf(SaveRejectedError);

    // THE ASSERTION THIS FILE EXISTS FOR. The good save is untouched and still newest, and the
    // rotation never ran — so there is no bad record anywhere, not even in the backup slot.
    const after = await store.read(id);
    expect(after.current?.tick).toBe(100);
    expect(after.previous).toBeUndefined();
    // The good save plus the milestone its own write took — and nothing from the bad one.
    expect(store.keys()).toEqual([`w:${id}:current`, `w:${id}:milestone`]);
  });

  it('never lets a bad save reach disk even when there is nothing to fall back to', async () => {
    // The first-save-of-a-new-world case. There is no previous record to protect, and the
    // temptation is to write something rather than nothing; writing an unloadable save would
    // hand the player a world that cannot be opened instead of one that was never created.
    const store = memorySaveStore();
    await expect(
      saveWorld(world(50), { worldId: nextWorld(), store, serialize: poisonedSerialize }),
    ).rejects.toBeInstanceOf(SaveRejectedError);

    expect(store.keys()).toEqual([]);
  });

  it('files the rejected bytes, labelled as a refused write rather than a bad read', async () => {
    const id = nextWorld();
    const store = memorySaveStore();
    await expect(
      saveWorld(world(50), { worldId: id, store, serialize: poisonedSerialize }),
    ).rejects.toThrow();

    expect(quarantined).toHaveBeenCalledTimes(1);
    const filed = quarantined.mock.calls[0]![0];
    // A save that was refused on the way OUT and one that broke on the way IN are different
    // bugs with the same symptom, so triage has to be able to tell them apart.
    expect(filed.slot).toBe(`w:${id}:rejected-write`);
    expect(filed.record).toBeDefined();
  });

  it('files the same fault once, not once per autosave', async () => {
    // The dedupe in `quarantine.ts` fingerprints the record, and a world that is still being
    // played has a different tick every minute — so it cannot help here. Without the signature
    // check in `saves.ts` this would file a fresh copy of the world every backoff interval, for
    // hours, into a database whose being full is one of the things that could cause this.
    const id = nextWorld();
    const store = memorySaveStore();
    for (const tick of [50, 60, 70]) {
      await expect(
        saveWorld(world(tick), { worldId: id, store, serialize: poisonedSerialize }),
      ).rejects.toThrow();
    }

    expect(quarantined).toHaveBeenCalledTimes(1);
  });

  it('tells the player, in its own words rather than the generic failure card', async () => {
    const store = memorySaveStore();
    await expect(
      saveWorld(world(50), { worldId: nextWorld(), store, serialize: poisonedSerialize }),
    ).rejects.toThrow();

    const notice = noticeSnapshot().find((entry) => entry.id === NoticeId.SaveRejected);
    expect(notice).toBeDefined();
    expect(notice?.tone).toBe('warning');
    // Sharing an id with `WriteFailed` would let "your world has stopped saving" overwrite the
    // specific wording with a vaguer version of something the game actually understands.
    expect(noticeSnapshot().some((entry) => entry.id === NoticeId.WriteFailed)).toBe(false);
  });
});

describe('the wording a player actually reads', () => {
  const bodies = [
    saveRejectedMessage('unreadable', null),
    saveRejectedMessage('unreadable', 8),
    saveRejectedMessage('lossy', 2),
  ];

  it('says what is safe, because that is the question being asked', () => {
    // At this moment the honest worry is "have I lost my factory?" and the answer is no.
    for (const body of bodies) {
      expect(body).toMatch(/nothing you built is lost|nothing has been deleted/i);
    }
  });

  it('leaks no jargon', () => {
    // The requirement most likely to rot unnoticed: "SaveCorruptError: expected inputCounts"
    // renders perfectly and means nothing to the person reading it.
    for (const body of bodies) {
      expect(body).not.toMatch(
        /IndexedDB|envelope|payload|serial|deserial|SaveCorrupt|QuotaExceeded|null|undefined/i,
      );
    }
  });

  it('says when it will next try, once it has stopped trying every minute', () => {
    expect(saveRejectedMessage('unreadable', 8)).toMatch(/8 minutes/);
    // ...and does not promise a number it does not have yet.
    expect(saveRejectedMessage('unreadable', null)).not.toMatch(/\d+ minutes/);
  });
});

describe('rejectBackoff', () => {
  it('starts at the ordinary cadence, so a one-off fault costs nothing', () => {
    // The other way this fires is a genuinely transient fault — a half-applied hot reload
    // settling. Punishing the first one would make the common case worse to fix the rare one.
    expect(rejectBackoff(0).multiplier).toBe(1);
    expect(rejectBackoff(0).minutes).toBe(1);
  });

  it('stretches as the same failure repeats', () => {
    expect(rejectBackoff(1).multiplier).toBe(2);
    expect(rejectBackoff(2).multiplier).toBe(4);
    expect(rejectBackoff(3).multiplier).toBe(8);
  });

  it('caps, so a long session keeps trying instead of quietly giving up', () => {
    const top = REJECT_BACKOFF_STEPS[REJECT_BACKOFF_STEPS.length - 1];
    expect(rejectBackoff(99).multiplier).toBe(top);
    expect(rejectBackoff(1_000_000).multiplier).toBe(top);
  });

  it('scales with the interval it is given rather than assuming the default', () => {
    expect(rejectBackoff(1, 600).ticks).toBe(1_200);
  });
});
