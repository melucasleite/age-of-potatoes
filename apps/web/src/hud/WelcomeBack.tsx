'use client';

// The Welcome Back card — §6's month-four retention feature, via [[040]].
//
// The design brief is one sentence and it is worth quoting because it also states the
// failure mode: a returning player gets a card "because 'your factory is exactly where you
// left it' only works if the game re-orients you to it."
//
// SO IT LEADS WITH WHAT IS SAFE. That is `storage/notices.ts`'s rule for save failures and it
// is the right rule here for the same reason — the honest first question after a long absence
// is "is my factory still there?", and the answer is not only yes but *nothing happened to
// it*: §6's ticks accrue only while the player is present, so a month away grew nothing and
// spent nothing. That is a genuinely delightful fact about this game's architecture and the
// card gets to say it out loud before it says anything else.
//
// IT DOES NOT BLOCK, PAUSE, OR DEMAND DISMISSAL. §2's Dawn Report is non-blocking, sim-speed
// controls are cut forever (§6), and §5's doctrine is that the factory is its own UI. There
// is no scrim, the card does not take pointer events except on its one button, and the game
// is running underneath it the entire time it is on screen. A player who ignores it entirely
// loses nothing.
//
// THE NUMBERS ARE FROZEN ON ARRIVAL. A summary of "what you came back to" that ticks upward
// while being read is describing the present, not the return — and the first thing the player
// does is move, which would make the card's own figures wrong as they read them.

import { formatCents } from './format';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import { useWelcomeBack } from './use-welcome';
import { useRef } from 'react';
import type { ClipboardNote } from './types';

interface Frozen {
  readonly machines: number;
  readonly running: number;
  readonly stopped: number;
  readonly netWorthCents: number;
  readonly pouchCents: number;
  readonly pouchItems: number;
  readonly notes: readonly ClipboardNote[];
}

export function WelcomeBack() {
  const welcome = useWelcomeBack();
  const lot = useHudSlice('lot');
  const economy = useHudSlice('economy');
  const pouch = useHudSlice('pouch');
  const clipboard = useHudSlice('clipboard');

  // Captured once, the first time real data is in hand. `lot.version` is 0 until the world
  // has published at least once, which is the cheap test for "this is the zero snapshot".
  const frozen = useRef<Frozen | null>(null);
  if (frozen.current === null && lot.version > 0) {
    let pouchCents = 0;
    let pouchItems = 0;
    for (const item of pouch.items) {
      pouchCents += item.valueCents;
      pouchItems += item.count;
    }
    frozen.current = {
      machines: lot.machines,
      running: lot.running,
      // Halted and jammed are one number here on purpose. The distinction matters when you
      // are standing in front of the machine; on a card summarising a month, "two machines
      // have stopped" is the whole of what a returning player needs to know.
      stopped: lot.halted + lot.jammed,
      netWorthCents: economy.netWorthCents,
      pouchCents,
      pouchItems,
      notes: clipboard.notes,
    };
  }

  const summary = frozen.current;
  if (!welcome.show || summary === null) return null;

  return (
    <div className={cx(s.card, s.welcome)}>
      <div className={s.welcomeHead}>
        <div className={s.label}>welcome back</div>
        <button type="button" className={s.welcomeClose} onClick={welcome.dismiss}>
          ✕
        </button>
      </div>

      <div className={s.welcomeAway}>You were gone {welcome.awayLabel}.</div>

      {/*
        The reassurance, and it is not flannel — it is a true and unusual property of this
        game. Nothing ages while the tab is shut because there is no clock in the sim to age
        it with (§6). Most games with crops cannot say this.
      */}
      <div className={s.welcomeSafe}>
        Your lot is exactly as you left it. Nothing grew and nothing was spent while you were away —
        the clock here only runs when you do.
      </div>

      <div className={s.rule} />

      <ul className={s.welcomeStats}>
        <Stat label="worth" value={formatCents(summary.netWorthCents)} />
        {summary.machines > 0 ? (
          <Stat
            label="machines"
            value={`${summary.running} of ${summary.machines} running`}
            warn={summary.stopped > 0}
          />
        ) : null}
        {summary.stopped > 0 ? (
          <Stat
            label="stopped"
            value={`${summary.stopped} ${summary.stopped === 1 ? 'machine' : 'machines'}`}
            warn
          />
        ) : null}
        {summary.pouchItems > 0 ? (
          <Stat
            label="in your pockets"
            value={`${summary.pouchItems} ${summary.pouchItems === 1 ? 'thing' : 'things'}, ${formatCents(summary.pouchCents)}`}
          />
        ) : null}
      </ul>

      {summary.notes.length > 0 ? (
        <>
          <div className={s.rule} />
          <ul className={s.notes}>
            {summary.notes.map((note) => (
              <li key={note.id} className={cx(s.note, s.welcomeNote)}>
                <span className={cx(s.dot, toneClass(note.tone))} />
                <span>{note.text}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <li className={s.welcomeStat}>
      <span className={s.welcomeStatLabel}>{label}</span>
      <span className={cx(s.welcomeStatValue, warn === true && s.welcomeStatWarn)}>{value}</span>
    </li>
  );
}

function toneClass(tone: ClipboardNote['tone']): string {
  if (tone === 'warn') return s.dotWarn;
  if (tone === 'nudge') return s.dotNudge;
  return '';
}
