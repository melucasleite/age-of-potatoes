// The Escape cascade, all seven rungs ([[126]]).
//
// WHAT FAILS QUIETLY HERE, which is AGENTS.md's bar for pinning anything:
//
//   · A PRESS THAT ADVANCES TWO RUNGS. The exact bug `PanelFrame.tsx` documents at length:
//     a panel with its own Escape listener closes itself AND lets the cascade fall through
//     to the next step, so one keystroke shuts the menu and disarms the tool. There is no
//     error and no stack trace — the player just finds their cursor empty for no reason,
//     intermittently, and reports it as "Escape sometimes skips a step".
//   · THE PAUSE MENU STEALING THE DRAG-CANCEL. Item 126 says out loud that a pause menu
//     which ate the cancel press would be actively hostile: the player pressed Escape to
//     get a half-drawn belt run back and lost the run to a menu instead. Silent, and
//     destructive rather than merely wrong.
//   · AN UNCONDITIONAL DISARM. The disarm ran unconditionally before this item, which was
//     harmless as the floor of the ladder and fatal with a rung underneath it — the pause
//     menu would simply never open, and the key would look like it did nothing at all.
//   · THE CLOSE FALLING OUT OF THE OPEN. Escape opens the menu and Escape must close it. A
//     ladder where the modal is only reachable downward is one that traps the player.
//
// The cascade is a pure function precisely so this file can exist: there is no DOM in this
// workspace's test environment, and a decision buried in a `keydown` handler is a decision
// nothing can pin. Same argument as `nextCrop`/`nextLiquid` in `system.ts`.

import { describe, expect, it } from 'vitest';

import { type EscapeState, escapeRung } from './escape';

/** Nothing open, nothing armed, nothing paused: the state that reaches the last rung. */
const IDLE: EscapeState = {
  paused: false,
  menuOpen: false,
  debugPanelOpen: false,
  dragging: false,
  grabberCardOpen: false,
  toolArmed: false,
};

function state(patch: Partial<EscapeState> = {}): EscapeState {
  return { ...IDLE, ...patch };
}

/**
 * The ladder in order, top rung first — the table the rest of this file reads from, so the
 * order lives in exactly one place here as it does in `escape.ts`.
 */
const LADDER: { field: keyof EscapeState; rung: ReturnType<typeof escapeRung> }[] = [
  { field: 'paused', rung: 'close-pause' },
  { field: 'menuOpen', rung: 'close-build-menu' },
  { field: 'debugPanelOpen', rung: 'close-debug-panel' },
  { field: 'dragging', rung: 'cancel-drag' },
  { field: 'grabberCardOpen', rung: 'close-grabber-card' },
  { field: 'toolArmed', rung: 'disarm' },
];

describe('the rungs, one at a time', () => {
  it('takes each rung when it is the only thing true', () => {
    for (const { field, rung } of LADDER) {
      expect(escapeRung(state({ [field]: true }))).toBe(rung);
    }
  });

  it('pauses when nothing is open and the hand is empty', () => {
    expect(escapeRung(IDLE)).toBe('open-pause');
  });
});

describe('the order, which is the whole feature', () => {
  it('prefers every rung to the ones below it', () => {
    // Every higher rung wins against every lower one held true at the same time. This is the
    // exhaustive version of the `else if` chain the handler used to be.
    for (let higher = 0; higher < LADDER.length; higher++) {
      for (let lower = higher + 1; lower < LADDER.length; lower++) {
        const both = state({ [LADDER[higher]!.field]: true, [LADDER[lower]!.field]: true });
        expect(escapeRung(both)).toBe(LADDER[higher]!.rung);
      }
    }
  });

  it('never opens the pause menu while anything at all is open or armed', () => {
    // The load-bearing negative: with EVERY combination of the six flags, `open-pause` is
    // reachable from exactly one — the empty one. 64 states, no DOM, no canvas.
    let opens = 0;
    for (let mask = 0; mask < 1 << LADDER.length; mask++) {
      // `EscapeState` is readonly all the way down — deliberately, since the whole point of
      // the type is that the cascade cannot mutate what it is shown — so the loop builds its
      // combination in a mutable twin and hands it over as the frozen thing it is.
      const flags: { -readonly [K in keyof EscapeState]: boolean } = { ...IDLE };
      LADDER.forEach(({ field }, bit) => {
        flags[field] = (mask & (1 << bit)) !== 0;
      });
      if (escapeRung(flags) === 'open-pause') opens += 1;
    }
    expect(opens).toBe(1);
  });
});

describe('the two failures item 126 names by name', () => {
  it('does NOT steal the drag-cancel press', () => {
    // A half-drawn belt run is what the player wants back first. The pause menu is the rung
    // BELOW the drag, so a press mid-gesture cancels the gesture and the menu stays shut.
    expect(escapeRung(state({ dragging: true }))).toBe('cancel-drag');
    // ...and with a tool armed as well, which is the realistic case: you are dragging
    // something, so you are holding something.
    expect(escapeRung(state({ dragging: true, toolArmed: true }))).toBe('cancel-drag');
  });

  it('disarms first, then pauses on the second press', () => {
    // The acceptance criterion verbatim: "Escape with a tool armed disarms; Escape again
    // opens the pause menu." Two presses, two rungs, in that order.
    const armed = state({ toolArmed: true });
    expect(escapeRung(armed)).toBe('disarm');
    // The world after the first press: the hand is empty and nothing else changed.
    expect(escapeRung({ ...armed, toolArmed: false })).toBe('open-pause');
  });
});

describe('the round trip', () => {
  it('opens on one press and closes on the next', () => {
    // The modal is opened at the BOTTOM of the ladder and closed at the TOP, and this is the
    // test that those two facts compose into one key the player can press twice.
    expect(escapeRung(IDLE)).toBe('open-pause');
    expect(escapeRung(state({ paused: true }))).toBe('close-pause');
  });

  it('closes the pause menu before anything else, whatever else claims to be open', () => {
    // Belt and braces for a state that should not arise: the cascade cannot open the menu
    // with a panel up, but if a later feature ever opens one over a paused world, Escape
    // must still put the modal away first rather than reaching past it.
    expect(
      escapeRung(state({ paused: true, menuOpen: true, dragging: true, toolArmed: true })),
    ).toBe('close-pause');
  });
});
