// One tab per lot ([[138]]).
//
// WHY THIS EXISTS, AND WHY THE REGISTRY FIX WAS NOT ENOUGH. `worlds.ts` now merges every
// registry write against the record on disk, inside the transaction that writes it, so two
// tabs can no longer erase each other's LOT CARDS. That was the reported bug and it is fixed
// there. It is not the whole disease.
//
// The disease is that two tabs can boot the SAME lot, and then there are two simulations of
// one world, each with its own tick, each autosaving into `w:<id>:current` once a minute.
// A tab that loaded at tick 3,000 while the other has reached 12,000 does not merely write a
// stale card — it writes a stale WORLD, rotates the good one into `previous`, and three saves
// later has pushed nine thousand ticks of factory off the end of the slot ladder. That is the
// payload, not the index, and no amount of transactional care in the registry touches it.
//
// So the second tab does not get the world. It is told why, and it is told in the boot
// refusal panel the game already has for "this save exists and I must not play over it" —
// which is precisely the right sentence for this, because that is exactly what is happening.
//
// WHY WEB LOCKS RATHER THAN A HEARTBEAT KEY. A heartbeat in IndexedDB needs a timeout, and
// every timeout is a choice between locking a player out of their own world after a crash and
// letting a second tab in while the first is merely busy. There is no good number. Web Locks
// have no timeout because they need none: the lock is held by a live document and the browser
// releases it when that document dies, crash included. Nothing to expire, nothing to reap,
// nothing to explain to somebody whose laptop went to sleep.
//
// PER LOT, NOT PER ORIGIN. A second tab may open the front door, may read the lot list, and
// may play a DIFFERENT lot quite happily — none of that races. This refuses exactly the thing
// that loses data and nothing else, which is what keeps it from feeling like a nanny.
//
// FAIL OPEN. A browser without the API gets its world, with the registry fix still protecting
// its lot list. Refusing to boot on a browser that merely lacks a lock would turn a bug that
// needs two tabs into a bug that needs one, which is a worse trade at any price.

import { logInfo, logWarn } from './log';

/** What `acquireWorldLease` decided. */
export interface WorldLease {
  readonly worldId: string;
  /** False only when another live tab holds this world. The one case that refuses a boot. */
  readonly held: boolean;
  /**
   * False when nothing actually guaranteed it — no Web Locks in this browser, or the request
   * itself failed. `held` is still true in that case (fail open); this says not to believe it.
   */
  readonly enforced: boolean;
}

/** What the player reads when the second tab refuses. No jargon, and it names the lot. */
export function leaseRefusalMessage(worldName: string): string {
  return (
    `"${worldName}" is already open in another tab or window. Two copies of the same lot ` +
    'would save over each other and lose whichever one you were not looking at, so this tab ' +
    'has left it alone. Switch to the tab that already has it open — or close that tab and ' +
    'reload this one, and it will pick up exactly where it left off.'
  );
}

function lockNameFor(worldId: string): string {
  return `snack-mogul:world:${worldId}`;
}

/**
 * The lock this page is holding, if any. One at a time: a page runs one world.
 *
 * `release` resolves the promise the lock manager is waiting on, which is how a Web Lock is
 * given back — there is no `unlock` call, the lock lasts exactly as long as the callback's
 * promise does.
 */
let holder: { worldId: string; release: () => void } | null = null;

/**
 * Claim a world for this page.
 *
 * RE-ENTRANT WITHIN THE PAGE, AND THAT IS NOT A CONVENIENCE. React StrictMode mounts the boot
 * effect twice; a lock taken by the first mount would refuse the second, and the game would
 * tell a player with one tab open that their world was open somewhere else. Same page, same
 * simulation, same world — so asking twice for what you already hold is a yes.
 */
export async function acquireWorldLease(worldId: string): Promise<WorldLease> {
  if (holder !== null && holder.worldId === worldId) {
    return { worldId, held: true, enforced: true };
  }
  // A page that moves from one lot to another gives the first one back on the way past.
  releaseWorldLease();

  const locks = globalThis.navigator?.locks as LockManager | undefined;
  if (locks === undefined) {
    logInfo('This browser has no Web Locks, so a second tab on this lot cannot be refused.');
    return { worldId, held: true, enforced: false };
  }

  return new Promise<WorldLease>((settle) => {
    void locks
      .request(lockNameFor(worldId), { mode: 'exclusive', ifAvailable: true }, (lock) => {
        // `ifAvailable` means the callback runs immediately either way: with the lock, or with
        // null because somebody else has it. It never waits, which matters — a boot that
        // blocked here would hang behind the very tab it is trying not to fight with.
        if (lock === null) {
          settle({ worldId, held: false, enforced: true });
          return;
        }
        return new Promise<void>((release) => {
          holder = {
            worldId,
            release: () => {
              release();
            },
          };
          settle({ worldId, held: true, enforced: true });
        });
      })
      .catch((error: unknown) => {
        // Fail open, per the header. `settle` is idempotent, so if we already reported a
        // verdict this is a late error on a lock we have and it changes nothing.
        logWarn('Could not claim this lot for this tab. Playing anyway.', error);
        settle({ worldId, held: true, enforced: false });
      });
  });
}

/**
 * Give the world back.
 *
 * Called from the ordered exit ([[078]]) so returning to the front door and re-entering the
 * same lot in the same page works. Closing the tab needs no call at all — the browser
 * releases a document's locks when the document goes, which is the whole reason this is a
 * Web Lock and not a row in a table.
 */
export function releaseWorldLease(): void {
  const current = holder;
  holder = null;
  current?.release();
}

/** Which world this page is holding, or null. Tests and the dev overlay. */
export function heldWorldId(): string | null {
  return holder?.worldId ?? null;
}
