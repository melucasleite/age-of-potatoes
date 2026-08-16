// The grabber card's state, published across the input→HUD seam ([[099]]).
//
// ────────────────────────────────────────────────────────────────────────────────────
//  WHY THE TRUTH LIVES HERE AND NOT IN `hud/store.ts`. Which arm is selected is a fact
//  about a CLICK ON THE CANVAS — the pointer owns hover, owns the click ladder, and is the
//  only layer that can tell an arm from the tile under it. The HUD store runs the other
//  way round: the host publishes world readings into it and panels read them out. Feeding
//  a selection backwards into that store would need a slice whose value changes on a
//  pointer event rather than on a publish, which is the one thing its every-field
//  comparison is built to avoid.
//
//  So this is `build-panel.ts`'s pattern, second time out: a module-scope contract between
//  two layers that must not import each other's internals, with a snapshot React can
//  subscribe to. `panels.ts` (the one-shot "open that panel" signal) is again not the right
//  shape — an open card with a live filter is STATE, and a listener that subscribes late
//  must see the current truth.
// ────────────────────────────────────────────────────────────────────────────────────
//
// THE CARD IS A CONSEQUENCE OF A CLICK, NOT OF WHERE THE PLAYER STANDS, and that is the one
// place it parts company with its siblings. `UpgradeBench` and `DockCard` open because you
// walked over; this opens because the owner asked for a click — *"when you click the grabber,
// allow you to select which item is gonna grab"* — and because the sim agrees: retuning a
// filter is the only grabber command that is NOT reach-gated (`applySetGrabberFilter`), so
// requiring the player to walk to an arm to give it orders would be the UI inventing a rule
// the sim declined to have. Clicking the same arm again closes it, Esc closes it, and an arm
// that stops existing closes it.
//
// NONE OF THIS IS SIM STATE (§12). Which card is open, which arm is selected — never a
// `Command`, never traced, never hashed, never saved. A replay must not depend on it. The
// one thing the card DOES emit is an ordinary `SetGrabberFilter` through the HUD's command
// sink, which is applied at a tick boundary and validated inside the sim like every other.

import type { WorldView } from '@snack/sim';

import { grabberCard, lotItems, mergeCandidates } from './grabber-card';

export interface GrabberPanelSnapshot {
  readonly version: number;
  readonly open: boolean;
  /** The arm's id, for the command the card dispatches. 0 while `open` is false. */
  readonly grabberId: number;
  readonly tier: number;
  /** The way goods flow. The card turns it into an arrow. */
  readonly dir: number;
  /** `ItemId` the arm is tuned to, or 0 for "anything". */
  readonly filter: number;
  /** The sim's tier rule. False means the card explains itself instead of drawing a grid. */
  readonly filterable: boolean;
  /** `ArmSource`: nothing behind the arm, a belt, or a machine. */
  readonly source: number;
  /** `MachineKind` when `source` is a machine, else 0. The card names it. */
  readonly sourceKind: number;
  /** True when the grid was seeded from the lot because the source was empty on open. */
  readonly fromLot: boolean;
  readonly candidates: readonly number[];
}

const ZERO: GrabberPanelSnapshot = Object.freeze({
  version: 0,
  open: false,
  grabberId: 0,
  tier: 0,
  dir: 0,
  filter: 0,
  filterable: false,
  source: 0,
  sourceKind: 0,
  fromLot: false,
  candidates: Object.freeze([]) as readonly number[],
});

let snapshot: GrabberPanelSnapshot = ZERO;
const listeners = new Set<() => void>();

/**
 * The selection, and the grid it accumulated.
 *
 * `kept` is seeded ONCE, on the first publish after a click, and only ever grows from there —
 * see `mergeCandidates` for why a picker that re-derived itself from a moving belt every
 * frame would be unusable. Both are discarded wholesale when the selection changes, so the
 * accumulation can never outlive the arm it describes.
 */
let selected = 0;
let kept: readonly number[] = [];
let seeded = false;
let seededFromLot = false;

export function grabberPanelSnapshot(): GrabberPanelSnapshot {
  return snapshot;
}

/** The server render and the pre-attach client render: closed, forever, cheaply. */
export function grabberPanelServerSnapshot(): GrabberPanelSnapshot {
  return ZERO;
}

export function subscribeGrabberPanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A left click landed on an arm.
 *
 * TOGGLES ON THE SAME ARM, because the gesture that opened the card is the most obvious one
 * to close it with and a player who clicks an arm twice is telling you they are done. A
 * click on a DIFFERENT arm re-aims the card rather than closing it — that is the reading
 * gesture for a run of arms, and making it a two-click affair would be a papercut per arm.
 */
export function grabberClicked(grabberId: number): void {
  select(grabberId === selected ? 0 : grabberId);
}

/** Esc and the card's own close button. */
export function grabberPanelClose(): void {
  select(0);
}

function select(next: number): void {
  if (selected === next) return;
  selected = next;
  kept = [];
  seeded = false;
  seededFromLot = false;
  // Publishing the closed state here rather than waiting a frame: closing is the one
  // transition the player performed deliberately, and a card that lingers for a frame after
  // the click that dismissed it reads as the click having missed.
  if (next === 0) publish(ZERO_FIELDS);
}

/** The shape `publish` compares against, so the closed case does not need a `WorldView`. */
const ZERO_FIELDS = {
  open: false,
  grabberId: 0,
  tier: 0,
  dir: 0,
  filter: 0,
  filterable: false,
  source: 0,
  sourceKind: 0,
  fromLot: false,
  candidates: [] as readonly number[],
};

/**
 * Called once per frame from `InputSystem.update()`, whether or not a card is open.
 *
 * The steady state — nothing selected — is one comparison and no allocation, exactly as the
 * build menu's refresh is. With a card open it walks one grabber list, one source tile and
 * the accumulated grid, and notifies only when a field actually moved; the common case there
 * is an arm swinging away with its filter unchanged, which publishes nothing.
 */
export function publishGrabberPanel(view: WorldView | null): void {
  if (selected === 0) {
    publish(ZERO_FIELDS);
    return;
  }

  const card = grabberCard(view, selected);
  if (card === null) {
    // The arm was torn down, or the world went away between the click and this frame. Drop
    // the selection rather than merely hiding the card: a later publish must not resurrect
    // it, and the id is gone for good — the sim mints fresh ones.
    select(0);
    return;
  }

  if (!seeded) {
    seeded = true;
    seededFromLot = card.candidates.length === 0;
    kept = seededFromLot ? lotItems(view) : card.candidates.slice();
  }
  kept = mergeCandidates(kept, card.candidates, card.filter);

  publish({
    open: true,
    grabberId: card.grabberId,
    tier: card.tier,
    dir: card.dir,
    filter: card.filter,
    filterable: card.filterable,
    source: card.source,
    sourceKind: card.sourceKind,
    fromLot: seededFromLot,
    candidates: kept,
  });
}

function publish(next: typeof ZERO_FIELDS): void {
  if (same(snapshot, next)) return;
  snapshot = Object.freeze({
    version: snapshot.version + 1,
    ...next,
    candidates: Object.freeze(next.candidates.slice()),
  });
  for (const listener of listeners) listener();
}

function same(current: GrabberPanelSnapshot, next: typeof ZERO_FIELDS): boolean {
  if (
    current.open !== next.open ||
    current.grabberId !== next.grabberId ||
    current.tier !== next.tier ||
    current.dir !== next.dir ||
    current.filter !== next.filter ||
    current.filterable !== next.filterable ||
    current.source !== next.source ||
    current.sourceKind !== next.sourceKind ||
    current.fromLot !== next.fromLot ||
    current.candidates.length !== next.candidates.length
  ) {
    return false;
  }
  // Sorted ascending on both sides by `mergeCandidates`, so equal lengths and equal entries
  // in order is genuine equality rather than a same-size coincidence.
  for (let i = 0; i < next.candidates.length; i++) {
    if (current.candidates[i] !== next.candidates[i]) return false;
  }
  return true;
}

/**
 * Forget everything. Called when a host starts or disposes, the same wipe `hudStore.claim`
 * does to its slices — a new world must not inherit the last one's open card, and grabber
 * ids are per-world.
 */
export function resetGrabberPanel(): void {
  select(0);
}
