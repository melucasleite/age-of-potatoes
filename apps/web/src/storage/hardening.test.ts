// The cheap structural gates for save hardening.
//
// AGENTS.md keeps verification light on purpose, so this pins only the parts where being
// wrong is INVISIBLE — which, for this feature, is nearly the whole point of it. Every failure
// mode here presents to the player as a game that is working fine:
//
//   · IF `isQuotaError` MISSES, the ladder never runs, the retry never happens, and the notice
//     never appears. The player keeps building on a world that stopped being written to disk.
//     It is duck-typed across four engines' worth of error shapes precisely because there is
//     no single shape to check, and a typo in one of them is silent.
//   · IF `withQuotaRetry` LOOPS, a full disk becomes an infinite retry that re-serialises the
//     world on the main thread every pass. "Exactly once" is the contract; this asserts the
//     call count rather than trusting the shape of the code.
//   · IF IT SWALLOWS A NON-QUOTA ERROR, a corrupt-write bug gets "fixed" by deleting the
//     backup copy — the one thing standing between a bad write and a lost world.
//   · IF THE NOTICE SNAPSHOT ALLOCATES, `useSyncExternalStore` re-renders on every publish
//     forever. Same trap `hud/store.ts` documents, same fix, and nothing on screen looks wrong.
//   · IF THE WORDING LEAKS JARGON, the item's plainest requirement is broken and no test would
//     otherwise notice, because "QuotaExceededError: quota exceeded" renders perfectly.
//
// Everything here is pure. The parts that genuinely need a browser — an IndexedDB that can
// actually run out of room, a tab killed mid-write — are not faked into passing tests; see the
// agent log on work item 041 for what was and was not exercised for real.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  NoticeId,
  dismissNotice,
  noticeSnapshot,
  publishNotice,
  publishNoticeOnce,
  resetNotices,
  serverNoticeSnapshot,
  subscribeNotices,
} from './notices';
import { persistenceWatchRunning, startPersistenceWatch, stopPersistenceWatch } from './persist';
import { StorageFullError, isQuotaError, storageFullMessage, withQuotaRetry } from './quota';
import { describeError, fingerprintRecord } from './quarantine';

describe('isQuotaError', () => {
  it('recognises what each engine actually throws', () => {
    // Chrome and friends: a DOMException by name.
    expect(isQuotaError({ name: 'QuotaExceededError', message: 'no' })).toBe(true);
    // Firefox's legacy spelling, and its numeric code.
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError({ name: 'Error', code: 1014 })).toBe(true);
    // DOMException.QUOTA_EXCEEDED_ERR.
    expect(isQuotaError({ name: 'Error', code: 22 })).toBe(true);
    // Safari has been known to reject with a plain Error and nothing but prose.
    expect(isQuotaError(new Error('The quota has been exceeded.'))).toBe(true);
  });

  it('follows the cause chain, because idb reports the abort and hides the reason', () => {
    const wrapped = new Error('Transaction aborted', {
      cause: { name: 'QuotaExceededError' },
    });
    expect(isQuotaError(wrapped)).toBe(true);
  });

  it('does not spin on a self-referencing cause', () => {
    const loop: { name: string; cause?: unknown } = { name: 'AbortError' };
    loop.cause = loop;
    expect(isQuotaError(loop)).toBe(false);
  });

  it('says no to everything else', () => {
    expect(isQuotaError(new Error('Failed to open database'))).toBe(false);
    expect(isQuotaError({ name: 'InvalidStateError' })).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError('quota')).toBe(false); // a string is not an error object
  });
});

describe('withQuotaRetry', () => {
  const quota = (): Error => {
    const error = new Error('out of room');
    error.name = 'QuotaExceededError';
    return error;
  };

  it('does not touch the ladder when the write simply works', async () => {
    let freeCalls = 0;
    const outcome = await withQuotaRetry(
      () => Promise.resolve('saved'),
      () => {
        freeCalls++;
        return Promise.resolve('something');
      },
    );

    expect(outcome).toEqual({ value: 'saved', freed: null });
    expect(freeCalls).toBe(0);
  });

  it('frees space and retries, reporting what it gave up', async () => {
    let attempts = 0;
    const outcome = await withQuotaRetry(
      () => {
        attempts++;
        if (attempts === 1) return Promise.reject(quota());
        return Promise.resolve('saved');
      },
      () => Promise.resolve('the input log it keeps for bug reports'),
    );

    expect(attempts).toBe(2);
    expect(outcome.value).toBe('saved');
    expect(outcome.freed).toBe('the input log it keeps for bug reports');
  });

  it('retries exactly once and then gives up, rather than looping on a full disk', async () => {
    let attempts = 0;
    const failing = withQuotaRetry(
      () => {
        attempts++;
        return Promise.reject(quota());
      },
      () => Promise.resolve('the spare backup copy of your world'),
    );

    await expect(failing).rejects.toBeInstanceOf(StorageFullError);
    expect(attempts).toBe(2);
  });

  it('does not bother retrying when there is nothing left to drop', async () => {
    let attempts = 0;
    const failing = withQuotaRetry(
      () => {
        attempts++;
        return Promise.reject(quota());
      },
      () => Promise.resolve(null),
    );

    const error = await failing.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(StorageFullError);
    expect((error as StorageFullError).freed).toBeNull();
    expect(attempts).toBe(1);
  });

  it('survives the cleanup itself failing', async () => {
    const failing = withQuotaRetry(
      () => Promise.reject(quota()),
      () => Promise.reject(new Error('the database is gone too')),
    );
    await expect(failing).rejects.toBeInstanceOf(StorageFullError);
  });

  it('passes a non-quota error straight through, untouched and un-laddered', async () => {
    let freeCalls = 0;
    const boom = new Error('serialisation blew up');

    const failing = withQuotaRetry(
      () => Promise.reject(boom),
      () => {
        freeCalls++;
        return Promise.resolve('the spare backup copy of your world');
      },
    );

    // The identical error object, not a wrapped one: deleting the backup because of a bug in
    // the writer would destroy the only good copy of the world.
    await expect(failing).rejects.toBe(boom);
    expect(freeCalls).toBe(0);
  });
});

describe('the words the player actually reads', () => {
  const JARGON = [
    'QuotaExceededError',
    'IndexedDB',
    'DOMException',
    'envelope',
    'undefined',
    'null',
    'NaN',
    'transaction',
    'stack',
  ];

  it('names no error classes and no browser internals', () => {
    for (const message of [storageFullMessage(null), storageFullMessage('the input log')]) {
      for (const word of JARGON) {
        expect(message.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });

  it('leads with what is still safe, because that is the actual question', () => {
    expect(storageFullMessage(null)).toContain('safe');
    expect(storageFullMessage(null)).toContain('has not been touched');
  });

  it('says what it gave up when it gave something up', () => {
    expect(storageFullMessage('the input log')).toContain('the input log');
    expect(storageFullMessage(null)).not.toContain('cleared out');
  });
});

describe('the notice channel', () => {
  beforeEach(() => {
    resetNotices();
  });

  it('returns a stable snapshot, so subscribers do not re-render on nothing', () => {
    const first = noticeSnapshot();
    expect(noticeSnapshot()).toBe(first);

    publishNotice({ id: NoticeId.QuotaFull, tone: 'warning', title: 'a', body: 'b' });
    const second = noticeSnapshot();
    expect(second).not.toBe(first);

    // Republishing the identical notice is a no-op all the way down to the array identity.
    publishNotice({ id: NoticeId.QuotaFull, tone: 'warning', title: 'a', body: 'b' });
    expect(noticeSnapshot()).toBe(second);
  });

  it('replaces a notice with the same id instead of stacking duplicates', () => {
    publishNotice({ id: NoticeId.QuotaFull, tone: 'warning', title: 'a', body: 'first' });
    publishNotice({ id: NoticeId.QuotaFull, tone: 'warning', title: 'a', body: 'second' });

    expect(noticeSnapshot()).toHaveLength(1);
    expect(noticeSnapshot()[0]?.body).toBe('second');
  });

  it('keeps different kinds of bad news side by side', () => {
    publishNotice({ id: NoticeId.QuotaFull, tone: 'warning', title: 'a', body: 'b' });
    publishNotice({ id: NoticeId.Recovered, tone: 'info', title: 'c', body: 'd' });
    expect(noticeSnapshot()).toHaveLength(2);
  });

  it('lets a still-true failure come back after the player waves it away', () => {
    publishNotice({ id: NoticeId.QuotaFull, tone: 'warning', title: 'a', body: 'b' });
    dismissNotice(NoticeId.QuotaFull);
    expect(noticeSnapshot()).toHaveLength(0);

    publishNotice({ id: NoticeId.QuotaFull, tone: 'warning', title: 'a', body: 'b' });
    expect(noticeSnapshot()).toHaveLength(1);
  });

  it('holds a "once" notice to once, even after it is dismissed', () => {
    publishNoticeOnce({ id: NoticeId.NotPersistent, tone: 'info', title: 'a', body: 'b' });
    dismissNotice(NoticeId.NotPersistent);
    publishNoticeOnce({ id: NoticeId.NotPersistent, tone: 'info', title: 'a', body: 'b' });
    expect(noticeSnapshot()).toHaveLength(0);
  });

  it('notifies subscribers and lets them leave', () => {
    let calls = 0;
    const unsubscribe = subscribeNotices(() => {
      calls++;
    });

    publishNotice({ id: NoticeId.Recovered, tone: 'info', title: 'a', body: 'b' });
    expect(calls).toBe(1);

    unsubscribe();
    publishNotice({ id: NoticeId.QuotaFull, tone: 'warning', title: 'c', body: 'd' });
    expect(calls).toBe(1);
  });

  it('shows the server nothing, so hydration cannot mismatch', () => {
    publishNotice({ id: NoticeId.Recovered, tone: 'info', title: 'a', body: 'b' });
    expect(serverNoticeSnapshot()).toHaveLength(0);
  });
});

describe('quarantine bookkeeping', () => {
  const record = { formatVersion: 3, tick: 1200, payload: {} };

  it('gives the same broken record the same fingerprint every reload', () => {
    // This is what stops five reloads of one corrupt save from filing five copies of an
    // 11 KB world into a database that may already be the thing that is full.
    expect(fingerprintRecord('current', record, 'SaveCorruptError')).toBe(
      fingerprintRecord('current', { ...record }, 'SaveCorruptError'),
    );
  });

  it('tells genuinely different failures apart', () => {
    const base = fingerprintRecord('current', record, 'SaveCorruptError');
    expect(fingerprintRecord('previous', record, 'SaveCorruptError')).not.toBe(base);
    expect(fingerprintRecord('current', record, 'SaveMigrationMissingError')).not.toBe(base);
    expect(fingerprintRecord('current', { ...record, tick: 2400 }, 'SaveCorruptError')).not.toBe(
      base,
    );
    expect(
      fingerprintRecord('current', { ...record, formatVersion: 2 }, 'SaveCorruptError'),
    ).not.toBe(base);
  });

  it('fingerprints a record too broken to stringify, rather than throwing on it', () => {
    // Structured clone permits cycles, so a stored value genuinely can be un-JSON-able — and
    // that record is exactly the kind quarantine exists to keep hold of.
    const cyclic: { formatVersion: number; self?: unknown } = { formatVersion: 3 };
    cyclic.self = cyclic;
    expect(() => fingerprintRecord('current', cyclic, 'SaveCorruptError')).not.toThrow();
    expect(fingerprintRecord('current', cyclic, 'SaveCorruptError')).toContain('unstringifiable');
  });

  it('describes anything at all that might be thrown', () => {
    expect(describeError(new TypeError('bad field'))).toEqual({
      name: 'TypeError',
      message: 'bad field',
    });
    expect(describeError('just a string').name).toBe('UnknownError');
    expect(describeError(undefined).message).toBe('undefined');
  });
});

// The persistence revocation watch ([[041]] follow-up).
//
// SAME REASON AS EVERYTHING ELSE IN THIS FILE: every way this can be wrong is invisible. A
// watch that never starts, or one that starts and never fires, looks exactly like a browser
// that simply never revoked — which is the overwhelmingly common case, so nothing on screen
// would ever contradict it. The two failures worth pinning are the ones with teeth: a timer
// that stacks (two boots, two timers, two cards) and a fire that repeats (a card the player
// dismisses and that comes back every five minutes for the rest of the session).
describe('the persistence revocation watch', () => {
  const granted = { supported: true, persisted: true, alreadyGranted: true };
  const denied = { supported: true, persisted: false, alreadyGranted: false };

  let answer = true;
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

  beforeEach(() => {
    answer = true;
    stopPersistenceWatch();
    // Node has a `navigator`, but no `navigator.storage`. Give it one that lies on command.
    Object.defineProperty(globalThis.navigator, 'storage', {
      configurable: true,
      value: { persisted: () => Promise.resolve(answer) },
    });
  });

  it('does not watch a browser that never granted persistence', () => {
    startPersistenceWatch(denied, () => {}, 5);
    expect(persistenceWatchRunning()).toBe(false);
  });

  it('stays quiet for as long as the promise holds', async () => {
    let fired = 0;
    startPersistenceWatch(granted, () => void fired++, 5);
    expect(persistenceWatchRunning()).toBe(true);
    await settle();
    expect(fired).toBe(0);
    expect(persistenceWatchRunning()).toBe(true);
  });

  it('fires exactly once when the promise is withdrawn, then stops', async () => {
    let fired = 0;
    startPersistenceWatch(granted, () => void fired++, 5);
    answer = false;
    await settle();
    expect(fired).toBe(1);
    expect(persistenceWatchRunning()).toBe(false);
    // The news does not get truer by being repeated.
    await settle();
    expect(fired).toBe(1);
  });

  it('replaces its timer rather than stacking one per call', async () => {
    let fired = 0;
    startPersistenceWatch(granted, () => void fired++, 5);
    startPersistenceWatch(granted, () => void fired++, 5);
    startPersistenceWatch(granted, () => void fired++, 5);
    answer = false;
    await settle();
    expect(fired).toBe(1);
  });

  it('treats a browser that will not answer as one that has not revoked', async () => {
    let fired = 0;
    Object.defineProperty(globalThis.navigator, 'storage', {
      configurable: true,
      value: {
        persisted: () => Promise.reject(new Error('the browser declines to say')),
      },
    });
    startPersistenceWatch(granted, () => void fired++, 5);
    await settle();
    expect(fired).toBe(0);
    expect(persistenceWatchRunning()).toBe(true);
  });
});
