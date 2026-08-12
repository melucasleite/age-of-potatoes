'use client';

// The Clipboard — plan §2: "three auto-populated observations, never quests."
//
// The distinction between an observation and a quest is not a wording preference, it is
// the whole design. The example the plan gives — "you hand-harvested 60 potatoes this
// hour; an auto-harvester would have caught 45" — never asks for anything. It states a
// fact about the lot, and the player draws the conclusion. That is why it works: the idea
// to buy the harvester is THEIRS, and an idea you had yourself is worth ten an assistant
// handed you.
//
// So there is no completion state here, no checkbox, no reward, and nothing that can be
// "done". Notes appear because something is true and vanish when it stops being true. If
// this panel ever grows a checkmark it has become a chore list and the design has lost.
//
// The strings live in `derive.ts`; this file only decides how paper looks.

import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import type { NoteTone } from './types';

export function Clipboard() {
  const clipboard = useHudSlice('clipboard');
  if (clipboard.notes.length === 0) return null;

  return (
    <div className={s.clipboard}>
      <div className={s.clip} />
      <div className={s.clipboardLabel}>the clipboard</div>
      <ul className={s.notes}>
        {clipboard.notes.map((note) => (
          <li key={note.id} className={s.note}>
            <span className={cx(s.dot, toneClass(note.tone))} />
            <span>{note.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function toneClass(tone: NoteTone): string {
  if (tone === 'warn') return s.dotWarn;
  if (tone === 'nudge') return s.dotNudge;
  return '';
}
