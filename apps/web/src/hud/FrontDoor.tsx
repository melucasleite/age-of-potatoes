'use client';

// The front door ([[055]]): Continue, New Game with its five farmers ([[079]]), and the lots.
//
// IT NEVER MOUNTS THE GAME. Not the canvas, not `GameHost`, not the HUD store, not the reports
// layer. That is the whole reason it is a screen rather than a panel: `GameHost` owns a Pixi
// application, an rAF loop and two store ownership tokens, and the honest way to switch worlds
// is to not have two of any of those in one page. Picking a lot sets the registry's active id
// FIRST — `bootWorld()` reads it on the far side, and there is exactly one right answer at
// that moment — and only then does anything mount.
//
// HOW THE GAME MOUNTS CHANGED WITH THE ROAD BACK ([[078]]). When `play-client` renders this
// door it passes `onEnter`, and entering a lot is an in-page state flip over there — no
// document navigation, because Exit Game's whole contract is "no reload anywhere in the
// flow", and the leak-free property the old navigation bought is now bought by the full
// unmount/remount of a keyed `GameCanvas` plus the stores' ownership tokens. Rendered with
// no callback (a direct visit, some future embed), the door still does the honest
// `location.assign` — never `next/navigation`'s router, which would swap search params under
// a live tree and hot-swap exactly what must not be hot-swapped.
//
// KEYBOARD FIRST. Continue is auto-focused, so a returning player presses Enter without reading
// anything. N opens the farmer picker with the default focused, so N-then-Enter starts a new
// lot exactly as fast as it used to. Everything else is reachable by Tab in reading order.

import { useCallback, useEffect, useState } from 'react';
import { CURRENT_FORMAT_VERSION } from '@snack/sim';

import {
  type WorldRecord,
  type WorldRegistry,
  activateWorld,
  createWorldRecord,
  deleteWorld,
  deletedWorlds,
  formatTimeAway,
  liveWorlds,
  newestWorld,
  readRegistry,
  renameWorld,
  restoreDeletedWorld,
} from '@/storage';
// Leaf modules, not the `@/reports` barrel — the barrel re-exports a React tree and this
// screen wants one pure function out of it. `day.ts` imports nothing but `@snack/sim`, which
// is exactly why it exists (see its header).
import { dayNumber } from '@/reports/day';
import { isCloudSyncConfigured } from '@/supabase/env';

import { AVATAR_COUNT, DEFAULT_AVATAR, avatarPortrait } from './avatars';
import { formatCentsWhole } from './format';
import { paintIcon } from './item-art';
import raw from './FrontDoor.module.css';

type StyleName =
  | 'door'
  | 'inner'
  | 'wordmark'
  | 'tagline'
  | 'primary'
  | 'primaryLabel'
  | 'primaryDetail'
  | 'secondary'
  | 'hint'
  | 'sectionHead'
  | 'list'
  | 'card'
  | 'cardNewest'
  | 'cardRefused'
  | 'cardHead'
  | 'cardName'
  | 'cardWhen'
  | 'cardStats'
  | 'cardMoney'
  | 'cardUnsaved'
  | 'cardCloud'
  | 'cardCloudActive'
  | 'cardRefusal'
  | 'cardTools'
  | 'rowButton'
  | 'danger'
  | 'confirm'
  | 'confirmText'
  | 'confirmRow'
  | 'nameInput'
  | 'deletedRow'
  | 'deletedWhen'
  | 'empty'
  | 'loading'
  | 'note'
  | 'picker'
  | 'pickerHead'
  | 'pickerRow'
  | 'pickerCell'
  | 'portrait'
  | 'portraitBlank'
  | 'pickerHint';

// The same trick `hud/styles.ts` documents: Next types a CSS module as an index signature and
// this workspace runs `noUncheckedIndexedAccess`, so every class would otherwise be
// `string | undefined` and a renamed class would silently paint nothing.
const s = raw as Readonly<Record<StyleName, string>>;

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * "3 hours ago", and "just now" for anything inside the minute.
 *
 * `formatTimeAway` floors to a whole minute and clamps at 1, which is right for the Welcome
 * Back card (a gap of six hours minimum) and wrong here, where the commonest case by far is a
 * player who reloaded the tab ten seconds ago and would be told they had been away a minute.
 */
function whenLabel(at: number, now: number): string {
  const away = now - at;
  if (away < 60_000) return 'just now';
  return `${formatTimeAway(away)} ago`;
}

export interface FrontDoorProps {
  /**
   * Enter a lot IN PAGE ([[078]]): the world is already active when this is called, and the
   * caller mounts the game without a navigation. Absent, the door document-navigates as it
   * always did.
   */
  onEnter?: (worldId: string) => void;
}

export default function FrontDoor({ onEnter }: FrontDoorProps = {}) {
  const [registry, setRegistry] = useState<WorldRegistry | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which card is showing step two of its delete. One at a time, by construction. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The farmer picker ([[079]]): open between pressing NEW GAME and choosing who farms. */
  const [picking, setPicking] = useState(false);

  // Read once per mount. StrictMode's second mount awaits the same memoised promise inside
  // `readRegistry`, so the adoption migration cannot run twice and mint two ids for one world.
  useEffect(() => {
    let cancelled = false;
    void readRegistry().then((value) => {
      if (!cancelled) setRegistry(value);
    });

    // Square every lot with its cloud row while the player reads the cards ([[143]]):
    // push the lots the cloud has never seen, adopt the ones another device carried
    // further, give the legacy 'default' row its home. Fire-and-forget and never throws
    // (`worldsSync.ts`); a dynamic import so this screen only fetches the Supabase chunk
    // when there is a backend to talk to. The cards repaint only when something changed.
    if (isCloudSyncConfigured()) {
      void import('@/supabase/worldsSync')
        .then((worldsSync) => worldsSync.reconcileCloudWorlds())
        .then(async (result) => {
          if (cancelled) return;
          if (result.pushed > 0 || result.adopted > 0 || result.legacyMoved) {
            setRegistry(await readRegistry());
          }
        })
        .catch(() => {
          // A chunk that fails to load is as survivable as a server that is down.
        });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const enter = useCallback(
    async (id: string) => {
      setBusy(true);
      // Await the activation before entering: `bootWorld()` reads the active id on the far
      // side, and there is exactly one right answer at that moment. True for the in-page
      // entry exactly as it was for the navigation.
      const world = await activateWorld(id);
      if (world === null) {
        setBusy(false);
        setRegistry(await readRegistry());
        return;
      }
      if (onEnter !== undefined) {
        onEnter(id);
        return;
      }
      window.location.assign(`/play?world=${encodeURIComponent(id)}`);
    },
    [onEnter],
  );

  /** Mint the lot with its farmer and walk in. The picker is the only caller ([[079]]). */
  const startNew = useCallback(
    async (avatar: number) => {
      setBusy(true);
      const world = await createWorldRecord({ avatar });
      if (onEnter !== undefined) {
        onEnter(world.id);
        return;
      }
      window.location.assign(`/play?world=${encodeURIComponent(world.id)}`);
    },
    [onEnter],
  );

  const newest = registry === null ? null : newestWorld(registry);

  // N for a new lot — it opens the farmer picker now ([[079]]), whose default cell takes
  // focus, so N-then-Enter still starts a game without reading anything. Ignored while a
  // text field has the caret, or the first letter of a rename would open a picker — which
  // is the kind of bug that only bites the one player who names a world "Nettles". Esc
  // closes the picker from the same listener.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (busy || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        setPicking(true);
      } else if (event.key === 'Escape') {
        setPicking(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [busy]);

  if (registry === null) {
    return (
      <div className={s.door}>
        <div className={s.loading}>reading the deeds…</div>
      </div>
    );
  }

  const now = Date.now();
  const lots = liveWorlds(registry);
  const binned = deletedWorlds(registry);
  const cloudOn = isCloudSyncConfigured();

  const refresh = async (): Promise<void> => {
    setRegistry(await readRegistry());
  };

  return (
    <div className={s.door}>
      <div className={s.inner}>
        <h1 className={s.wordmark}>AGE OF POTATOES</h1>
        <p className={s.tagline}>Rent&rsquo;s paid through the month. Make chips.</p>

        {newest !== null && (
          <button
            type="button"
            className={s.primary}
            // The one auto-focus in the game, and it is the point of the screen: a returning
            // player presses Enter and is in their factory without reading a word.
            autoFocus
            disabled={busy}
            onClick={() => void enter(newest.id)}
          >
            <span className={s.primaryLabel}>CONTINUE</span>
            <span className={s.primaryDetail}>
              {newest.name} · {summaryLine(newest)} · {whenLabel(newest.lastPlayedAt, now)}
            </span>
          </button>
        )}

        <button
          type="button"
          className={s.secondary}
          disabled={busy}
          onClick={() => {
            setPicking((was) => !was);
          }}
        >
          NEW GAME
        </button>

        {picking ? (
          <AvatarPicker busy={busy} onPick={(avatar) => void startNew(avatar)} />
        ) : (
          <p className={s.hint}>
            {newest === null ? 'N starts a new lot.' : 'Enter continues. N starts a new lot.'}
          </p>
        )}

        {lots.length === 0 ? (
          <p className={s.empty}>
            No lots yet. Start one — the seed is rolled fresh, so it will be a lot nobody has stood
            on before.
          </p>
        ) : (
          <>
            <div className={s.sectionHead}>
              <span>Your lots</span>
              <span>{lots.length === 1 ? '1 lot' : `${String(lots.length)} lots`}</span>
            </div>
            <div className={s.list}>
              {lots.map((lot) => (
                <LotCard
                  key={lot.id}
                  lot={lot}
                  now={now}
                  busy={busy}
                  cloudOn={cloudOn}
                  isNewest={lot.id === newest?.id}
                  confirming={confirming === lot.id}
                  renaming={renaming === lot.id}
                  onOpen={() => void enter(lot.id)}
                  onAskDelete={() => {
                    setConfirming(lot.id);
                  }}
                  onCancelDelete={() => {
                    setConfirming(null);
                  }}
                  onConfirmDelete={() => {
                    setConfirming(null);
                    void deleteWorld(lot.id).then(setRegistry);
                  }}
                  onStartRename={() => {
                    setRenaming(lot.id);
                  }}
                  onRename={(name) => {
                    setRenaming(null);
                    void renameWorld(lot.id, name).then(refresh);
                  }}
                  onCancelRename={() => {
                    setRenaming(null);
                  }}
                />
              ))}
            </div>
          </>
        )}

        {binned.length > 0 && (
          <>
            <div className={s.sectionHead}>
              <span>Recently deleted</span>
              <span>kept 14 days</span>
            </div>
            <div className={s.list}>
              {binned.map((lot) => (
                <div key={lot.id} className={s.deletedRow}>
                  <span>
                    {lot.name}
                    <span className={s.deletedWhen}>
                      {' '}
                      · deleted {whenLabel(lot.deletedAt ?? now, now)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={s.rowButton}
                    disabled={busy}
                    onClick={() => void restoreDeletedWorld(lot.id).then(setRegistry)}
                  >
                    restore
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <p className={s.note}>
          {cloudOn
            ? 'Every lot is backed up to the cloud under your account and follows you to ' +
              'any browser you sign into. A copy also lives here, so the game loads ' +
              'instantly and plays through an outage.'
            : 'Cloud backup is not set up on this build, so nothing leaves this machine.'}
        </p>
      </div>
    </div>
  );
}

/**
 * The five farmers ([[079]]): a range of skin tones and masculine/feminine/androgynous
 * presentations, none of them named, none of them gendered by the copy — the button says
 * which farmer by NUMBER and lets the picture say the rest. Picking one starts the game.
 *
 * KEYBOARD FLOW, PRESERVED BY FOCUS: the default cell auto-focuses when the picker opens,
 * so N-then-Enter is still the two-keystroke new game — with the default farmer, which is
 * what a default is for. Arrow-free by design: five buttons Tab in reading order, and a
 * picker this small does not need a cursor of its own.
 *
 * A portrait the atlas cannot supply degrades to a numbered chip, never magenta ([[037]]).
 */
function AvatarPicker({ busy, onPick }: { busy: boolean; onPick: (avatar: number) => void }) {
  const ids = Array.from({ length: AVATAR_COUNT }, (_, i) => i + 1);
  return (
    <div className={s.picker}>
      <div className={s.pickerHead}>Who farms it?</div>
      <div className={s.pickerRow}>
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            className={s.pickerCell}
            disabled={busy}
            autoFocus={id === DEFAULT_AVATAR}
            aria-label={`Farmer ${String(id)}`}
            onClick={() => {
              onPick(id);
            }}
          >
            <Portrait avatar={id} />
          </button>
        ))}
      </div>
      <p className={s.pickerHint}>Enter takes the first. Esc changes your mind. Looks only.</p>
    </div>
  );
}

/** The pixel farmer at 3×, cut from the same atlas the world dresses them from. */
const PORTRAIT_PX = 48;

function Portrait({ avatar }: { avatar: number }) {
  const source = avatarPortrait(avatar);
  if (source === null) {
    return (
      <span className={cx(s.portrait, s.portraitBlank)} aria-hidden="true">
        {avatar}
      </span>
    );
  }
  const paint = paintIcon(source, PORTRAIT_PX);
  return (
    <span
      className={s.portrait}
      style={{
        width: PORTRAIT_PX,
        height: PORTRAIT_PX,
        backgroundImage: paint.backgroundImage,
        backgroundPosition: paint.backgroundPosition,
        backgroundSize: paint.backgroundSize,
      }}
      aria-hidden="true"
    />
  );
}

/** "$1,842 · Day 12", or an honest dash for a lot that has not saved yet. */
function summaryLine(lot: WorldRecord): string {
  if (lot.summary.formatVersion === 0) return 'not saved yet';
  const money = lot.summary.moneyCents === null ? '—' : formatCentsWhole(lot.summary.moneyCents);
  return `${money} · Day ${String(dayNumber(lot.summary.tick))}`;
}

interface LotCardProps {
  lot: WorldRecord;
  now: number;
  busy: boolean;
  cloudOn: boolean;
  isNewest: boolean;
  confirming: boolean;
  renaming: boolean;
  onOpen: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}

function LotCard(props: LotCardProps) {
  const { lot } = props;
  // A save written by a newer deploy. THE EXISTING READABLE REFUSAL, kept: the world is fine
  // and it is this tab that is stale, so the card says so and refuses to open rather than
  // letting the player through to a boot that would refuse anyway with less context.
  const tooNew = lot.summary.formatVersion > CURRENT_FORMAT_VERSION;
  const unsaved = lot.summary.formatVersion === 0;

  return (
    <div>
      <div
        className={cx(s.card, props.isNewest && s.cardNewest, tooNew && s.cardRefused)}
        // A div with a button role rather than a `<button>`, because the card contains its own
        // buttons — rename, delete — and nesting interactive elements is invalid HTML that
        // browsers resolve by dropping the inner one.
        role={tooNew ? undefined : 'button'}
        tabIndex={tooNew || props.busy ? undefined : 0}
        onClick={tooNew || props.renaming ? undefined : props.onOpen}
        onKeyDown={(event) => {
          if (tooNew || props.renaming || props.busy) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            props.onOpen();
          }
        }}
      >
        <div className={s.cardHead}>
          {props.renaming ? (
            <input
              className={s.nameInput}
              defaultValue={lot.name}
              autoFocus
              maxLength={40}
              onClick={(event) => {
                event.stopPropagation();
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') props.onRename(event.currentTarget.value);
                if (event.key === 'Escape') props.onCancelRename();
              }}
              onBlur={(event) => {
                props.onRename(event.currentTarget.value);
              }}
            />
          ) : (
            <span className={s.cardName}>{lot.name}</span>
          )}
          <span className={s.cardWhen}>{whenLabel(lot.lastPlayedAt, props.now)}</span>
        </div>

        <div className={cx(s.cardStats, unsaved && s.cardUnsaved)}>
          {unsaved ? (
            <span>Started, not saved yet — opening it plants you on the same lot.</span>
          ) : (
            <>
              <span className={s.cardMoney}>
                {lot.summary.moneyCents === null ? '—' : formatCentsWhole(lot.summary.moneyCents)}
              </span>
              <span>Day {dayNumber(lot.summary.tick)}</span>
            </>
          )}
        </div>

        {props.cloudOn && (
          // Every lot, not just the active one ([[143]]): the running world mirrors live,
          // and the reconciliation above squares the rest each time this screen opens.
          <div className={cx(s.cardCloud, s.cardCloudActive)}>
            {unsaved ? 'backs up to the cloud once it saves' : 'backed up to the cloud'}
          </div>
        )}

        {tooNew && (
          <p className={s.cardRefusal}>
            This lot was saved by a newer version of the game than this tab is running. It has not
            been touched and nothing is wrong with it — reload the page and it will open.
          </p>
        )}
      </div>

      {props.confirming ? (
        <div className={s.confirm}>
          <p className={s.confirmText}>
            Delete {lot.name}? The save is kept for 14 days and can be restored from this screen
            until then. After that it is gone for good.
          </p>
          <div className={s.confirmRow}>
            <button type="button" className={s.danger} onClick={props.onConfirmDelete}>
              yes, delete it
            </button>
            <button type="button" className={s.rowButton} onClick={props.onCancelDelete}>
              keep it
            </button>
          </div>
        </div>
      ) : (
        <div className={s.cardTools}>
          <button
            type="button"
            className={s.rowButton}
            disabled={props.busy}
            onClick={props.onStartRename}
          >
            rename
          </button>
          <button
            type="button"
            className={s.danger}
            disabled={props.busy}
            onClick={props.onAskDelete}
          >
            delete
          </button>
        </div>
      )}
    </div>
  );
}
