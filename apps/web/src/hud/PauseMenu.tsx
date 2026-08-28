'use client';

// The pause menu ([[126]]): Escape's sixth rung, and the one modal panel in the game.
//
// ────────────────────────────────────────────────────────────────────────────────────
//  OWNER ASK, 2026-08-17, VERBATIM: "Add an esc for a pause menu where I can change my
//  avatar and also I can save and exit."
//
//  Three verbs, and none of them is new machinery. Resume is the seam's `close`. Change
//  avatar is `publishAvatar` (the renderer already reads the id EVERY FRAME) plus one
//  registry write. Save & Exit is item 078's `requestExit`, untouched. What this item
//  actually builds is a door, and the interesting parts are all about where it is hung.
// ────────────────────────────────────────────────────────────────────────────────────
//
// ── THE TRAP, WHICH IS DOCUMENTED AND LOAD-BEARING: `closeOnEsc={false}` ─────────────
//
// `PanelFrame.tsx` explains it for the build menu and it applies here with more force. The
// shared frame closes itself on Escape with its own window listener, and the input layer's
// Escape is a STRICT CASCADE (`escape.ts`). A panel that is opened BY the cascade and then
// closed by a private listener makes one press do two things: this listener would shut the
// menu, and the cascade — finding it already shut — would fall through and take the next
// rung as well. The bug reads as "Escape sometimes skips a step", which is miserable to
// diagnose because the two handlers are in different layers and both are correct alone.
//
// So the menu is closed by the same ladder that opened it: `pauseMenuClose()` is the seam's
// one door, the cascade's `close-pause` rung calls `InputSystem.closePauseMenu` directly,
// and the ESC BUTTON in the head still works because `PanelWindow` calls `onClose` for it.
//
// ── WHY THE AVATAR SWAP NEEDED NO REBUILD ───────────────────────────────────────────
//
// Item 126 predicted a live-swap path would have to be built, because `render/avatar.ts`
// was believed to pick the strip family at scene build. IT DOES NOT, and has not since
// [[079]]: `render/index.ts` reads `avatarIdentity.avatarId` inside the per-frame player
// update, and that file's header says why in as many words — per frame rather than at scene
// build, so publication order against scene construction cannot matter and StrictMode's
// double host stays harmless. A defensive choice made for a lifecycle reason turns out to
// have made mid-game swapping free: `publishAvatar(id)` and the farmer changes on the very
// next frame, with no reload, no scene rebuild and no world touched.
//
// PICTURE FIRST, THEN DISK. The publish is synchronous and the registry write is not, so
// they go in that order: the player sees the farmer change immediately, and the await is
// something they never wait on. The failure mode of that ordering is a preference that does
// not survive a reload; the failure mode of the other ordering is a picker that feels broken.
//
// NONE OF THIS IS SIM STATE (§12). The avatar is envelope metadata on the registry record,
// never in `WorldState`; the pause is a boolean in the input layer, never a field in the
// world. Neither is a `Command`, neither is traced or hashed, and no golden fixture moves.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import {
  pauseMenuClose,
  pauseMenuServerSnapshot,
  pauseMenuSnapshot,
  subscribePauseMenu,
} from '@/game/input/pause-panel';
// Leaf module, not a barrel: `render/avatar.ts` is pure and Pixi-free — `hud/avatars.ts`
// already imports `AVATAR_COUNT` from it, which is the precedent for this arrow.
import { avatarIdentity, publishAvatar } from '@/game/render/avatar';
import { setActiveWorldAvatar } from '@/storage';

import { AVATAR_COUNT, avatarPortrait } from './avatars';
import { requestExit } from './exit';
import { paintIcon } from './item-art';
import { keepFocus, PanelWindow } from './PanelFrame';
import { cx, s } from './styles';

/**
 * The picker's cell art. 96 is the 2× whole magnification of the 48px avatar cell — the
 * next crisp step down is 48 and the next up is 144, neither of which `fitScale` would
 * actually reach in a smaller box. Five of these do not fit one 460px row, which is why
 * `.pauseAvatars` is a 3-column grid rather than the slim row this section shipped as.
 */
const PORTRAIT_PX = 96;

export function PauseMenu() {
  const open = useSyncExternalStore(
    subscribePauseMenu,
    pauseMenuSnapshot,
    pauseMenuServerSnapshot,
  ).open;
  if (!open) return null;
  // Keyed on nothing, but MOUNTED ONLY WHILE OPEN, which is what lets `PauseBody` read the
  // live avatar id once into `useState` below and trust it: the component's whole lifetime
  // is one visit to the menu.
  return (
    <div className={s.pauseScrim}>
      <div className={s.pauseWin}>
        <PanelWindow
          title="Paused"
          tag="the lot is holding still"
          hint="Escape resumes · nothing is running while this is up"
          onClose={pauseMenuClose}
          // THE TRAP. See this file's header — the cascade opened it, the cascade closes it.
          closeOnEsc={false}
        >
          <PauseBody />
        </PanelWindow>
      </div>
    </div>
  );
}

function PauseBody() {
  return (
    <div className={s.pauseBody}>
      <div className={s.pauseActions}>
        <button
          type="button"
          className={cx(s.pauseButton, s.pauseButtonPrimary)}
          onMouseDown={keepFocus}
          onClick={pauseMenuClose}
        >
          <span>Resume</span>
          <span className={s.pauseButtonNote}>Esc</span>
        </button>

        {/*
          SAVE & EXIT IS ITEM 078'S FLOW AND NOT A SECOND ONE. `requestExit()` is the same
          one-shot signal the sidebar's button fires; `GameCanvas` answers it with the order
          that IS the feature — flush through the write-then-verify machinery, CHECK the save
          landed, and only then let the parent unmount the world. A second exit path that
          skipped the verify is how save corruption ships, so this button knows nothing about
          saving at all: it asks, and the layer that owns the world and its autosave handle
          answers.

          NO BUSY STATE, AND NO "ARE YOU SURE". A double press is already harmless —
          `GameCanvas` holds an `exiting` latch so two clicks cannot race two flushes at one
          teardown — and there is nothing to confirm, because the save IS the confirmation.
          A failed save cancels the exit and reaches the player through the same notice card
          every failed save shows, which is a better answer than a spinner in here that would
          have to invent its own opinion about what went wrong.
        */}
        <button
          type="button"
          className={s.pauseButton}
          onMouseDown={keepFocus}
          onClick={requestExit}
        >
          <span>Save &amp; Exit</span>
          <span className={s.pauseButtonNote}>saves first, then leaves</span>
        </button>
      </div>

      <AvatarSwitch />
    </div>
  );
}

/**
 * Change which farmer walks this lot, mid-game, without a reload.
 *
 * THE CHOSEN ID IS LOCAL STATE SEEDED FROM THE LIVE SINGLETON, which is honest rather than
 * lazy: `avatarIdentity` is a mutable object with a version counter, not a subscribable
 * store, and this component's entire lifetime is one visit to an open menu. It reads the
 * truth once on mount and is thereafter the only thing changing it.
 *
 * THE EFFECT IS THE REPAIR FOR ONE REAL CASE and not ceremony: React's StrictMode mounts
 * this twice, and `GameCanvas`'s cleanup publishes avatar 0 on the way through — so the id
 * captured by `useState`'s initialiser can be a legacy 0 for a world that is dressed in
 * farmer 3. Re-reading after mount costs one render at most and never lies.
 */
function AvatarSwitch() {
  const [chosen, setChosen] = useState(() => avatarIdentity.avatarId);

  useEffect(() => {
    setChosen(avatarIdentity.avatarId);
  }, []);

  const pick = useCallback((id: number) => {
    setChosen(id);
    // Picture first: the renderer reads this on its very next frame ([[079]]).
    publishAvatar(id);
    // Then disk. Never awaited by the UI — see the header.
    void setActiveWorldAvatar(id);
  }, []);

  const ids = Array.from({ length: AVATAR_COUNT }, (_, i) => i + 1);
  return (
    <div className={s.pauseSection}>
      <div className={s.pauseSectionHead}>Who farms it</div>
      <div className={s.pauseAvatars}>
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            className={cx(s.pauseAvatar, id === chosen && s.pauseAvatarOn)}
            aria-label={`Farmer ${String(id)}`}
            aria-pressed={id === chosen}
            onMouseDown={keepFocus}
            onClick={() => {
              pick(id);
            }}
          >
            <Portrait avatar={id} />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One farmer's face, cut from the atlas the world dresses them from.
 *
 * THE 48px CELL ([[9359be8]]) NEEDS NOTHING SPECIAL HERE, and that is worth writing down
 * because it is the thing most likely to be assumed broken: the avatars grew from a 16px
 * cell to a 48px one when the whole game doubled, and this component never learns either
 * number. `avatarPortrait` cuts the first SQUARE cell of the down strip by reading the
 * strip's own height, and `paintIcon` picks a whole magnification that fits whatever it is
 * handed into the box asked for. A 48px face in a 96px box is a clean 2×; a future 64px
 * one would land at 1×. Nothing in this file has a cell size in it.
 */
function Portrait({ avatar }: { avatar: number }) {
  const source = avatarPortrait(avatar);
  if (source === null) {
    return (
      <span
        className={s.pauseAvatarBlank}
        style={{ width: PORTRAIT_PX, height: PORTRAIT_PX }}
        aria-hidden="true"
      >
        {avatar}
      </span>
    );
  }
  const paint = paintIcon(source, PORTRAIT_PX);
  return (
    <span
      className={s.pauseAvatarArt}
      aria-hidden="true"
      style={{
        width: PORTRAIT_PX,
        height: PORTRAIT_PX,
        backgroundImage: paint.backgroundImage,
        backgroundPosition: paint.backgroundPosition,
        backgroundSize: paint.backgroundSize,
      }}
    />
  );
}
