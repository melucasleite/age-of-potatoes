'use client';

// The research panel — four branches, three eras, and the Charters that separate them.
//
// WHAT THIS PANEL IS FOR, precisely. The tech tree has existed in the simulation for a while
// and has been completely invisible: the build menu shows a locked entry reading "needs Belts"
// and stops there, so the player learns the NAME of a thing they cannot have and nothing else —
// not what it does, not what it costs, not how to get it. Plan §3 makes the tree the engine of
// the whole manual→automated arc, which means an invisible tree is an invisible arc.
//
// So this panel answers four questions in one screen, and the layout is chosen for them:
//
//   WHAT DOES IT GIVE ME?  Every card carries its verb on its face, not in a tooltip. Plan §1
//     and §3: "the tree unlocks verbs; upgrades scale numbers. No tech node is a percentage."
//     `TechNode` in the sim enforces that structurally by having nowhere to put a number; this
//     file is the other half — it is where the rule could still be broken, by *presentation*,
//     and is not.
//
//   CAN I HAVE IT YET?  Five states, five distinct treatments, and only one of them is gold.
//     The affordable frontier is the loudest thing on screen because §8's v0.7 gate is a UI
//     question — "can a returning player see their next want within 30 seconds?" — and the
//     answer has to survive a player who is not reading carefully.
//
//   WHAT IS IN MY WAY?  Missing prerequisites are named, and a Charter shows BOTH halves of its
//     gate with the milestone counter running from the first time the panel opens. Plan §7
//     ruling 3 forbids hidden behavioural gates; a milestone you discover by accidentally
//     completing it is a hidden gate wearing a badge.
//
//   WHERE AM I?  It opens on the frontier, never on the root. See `deriveTech`.
//
// Everything here reads two slices and writes one command. No sim state in Context, no second
// path to the world, and the open/closed flag is UI state that never enters the trace (§12).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MilestoneKind } from '@snack/sim';

import { formatCents, formatCentsWhole, formatEta, plural } from './format';
import { cx, s } from './styles';
import { hudStore } from './store';
import { MAX_ERA } from './derive-tech';
import { BRANCH_COPY, BRANCH_ORDER, eraCopy, milestoneLabel, milestoneNoun } from './tech-copy';
import { useHudSlice } from './use-hud';
import { usePending } from './use-pending';
import type { EconomySlice, TechCard } from './types';

/** Keeps focus on the canvas — see the long note in `Toolbelt.tsx` for why it is `mousedown`. */
function keepFocus(event: React.MouseEvent): void {
  event.preventDefault();
}

// --- the corner button -----------------------------------------------------------------

export function TechToggle({ onOpen }: { onOpen: () => void }) {
  const tech = useHudSlice('tech');
  if (tech.cards.length === 0) return null;

  let ready = 0;
  for (const card of tech.cards) if (card.status === 'ready') ready += 1;

  return (
    <button
      type="button"
      className={cx(s.techToggle, ready > 0 && s.techToggleReady)}
      title="The research tree — what you can build next, and what it costs"
      onMouseDown={keepFocus}
      onClick={onOpen}
    >
      <span className={s.techToggleName}>Research</span>
      <span className={s.techToggleBadge}>
        {ready > 0 ? `${ready} ready` : `${tech.ownedCount}/${tech.cards.length}`}
      </span>
      <span className={s.techToggleKey}>T</span>
    </button>
  );
}

// --- the panel -------------------------------------------------------------------------

export function TechPanel({ onClose }: { onClose: () => void }) {
  const tech = useHudSlice('tech');
  const economy = useHudSlice('economy');
  const pending = usePending();

  // Selection is UI state and starts on the frontier — the cheapest thing the player could act
  // on. `deriveTech` ranks it; this only remembers what was clicked afterwards.
  const [selectedId, setSelectedId] = useSelection(tech.frontierId);

  const selected = useMemo(
    () => tech.cards.find((card) => card.id === selectedId) ?? tech.cards[0] ?? null,
    [tech.cards, selectedId],
  );

  const research = useCallback(
    (id: string) => {
      pending.hold(id);
      hudStore.dispatch({ type: 'ResearchTech', techId: id });
    },
    [pending],
  );

  // Escape closes. The game's own keyboard layer also sees Escape and uses it to close the
  // build menu or drop the tool — harmless overlap, and the alternative is capturing keys away
  // from a system that does not know this panel exists.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const eras: number[] = [];
  for (let era = 1; era <= MAX_ERA; era++) eras.push(era);

  const emptyBranches = useMemo(() => {
    const populated = new Set<number>();
    for (const card of tech.cards) populated.add(card.branch);
    return new Set(BRANCH_ORDER.filter((branch) => !populated.has(branch)));
  }, [tech.cards]);

  return (
    <div
      className={s.scrim}
      onMouseDown={(event) => {
        // Only a click on the scrim ITSELF closes. Without the target check, a click that
        // starts inside the panel and drifts onto the backdrop would dismiss it mid-read.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={s.techPanel} onMouseDown={(event) => event.stopPropagation()}>
        <div className={s.techHead}>
          <span className={s.techTitle}>Research</span>
          <span className={s.techEra}>
            Era {eraCopy(tech.era).numeral} · {eraCopy(tech.era).name}
          </span>
          <span className={s.techCount}>
            {tech.ownedCount} of {tech.cards.length} researched
          </span>
          <span className={s.techMoney}>{formatCents(economy.moneyCents)}</span>
          <button type="button" className={s.techClose} onMouseDown={keepFocus} onClick={onClose}>
            ESC
          </button>
        </div>

        <div className={s.techScroll}>
          {eras.map((era) => (
            <EraBand
              key={era}
              era={era}
              current={era === tech.era}
              cards={tech.cards}
              emptyBranches={emptyBranches}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
            />
          ))}
        </div>

        {selected === null ? null : (
          <Detail
            card={selected}
            economy={economy}
            pending={pending.isPending(selected.id)}
            onResearch={research}
          />
        )}

        <div className={s.techHint}>Every node unlocks something you can do · T or ESC closes</div>
      </div>
    </div>
  );
}

/**
 * Selection, seeded once from the frontier and owned by the player thereafter.
 *
 * The seed cannot simply BE the frontier: `deriveTech` recomputes it on every publish, so a
 * selection that tracked it would yank itself out from under the player the moment a crop sold
 * and made something else affordable. It seeds on the first publish that has one — which is
 * usually the first render, but not on a cold boot where the panel can open before the world
 * has published — and then stops listening.
 */
function useSelection(frontierId: string | null): [string | null, (id: string) => void] {
  const [chosen, setChosen] = useState<string | null>(null);
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current || frontierId === null) return;
    seeded.current = true;
    setChosen(frontierId);
  }, [frontierId]);

  const set = useCallback((id: string) => {
    seeded.current = true;
    setChosen(id);
  }, []);

  return [chosen, set];
}

// --- an era band -----------------------------------------------------------------------

function EraBand({
  era,
  current,
  cards,
  emptyBranches,
  selectedId,
  onSelect,
}: {
  era: number;
  current: boolean;
  cards: readonly TechCard[];
  /** Branches with no nodes in the whole tree, not merely none in this era. */
  emptyBranches: ReadonlySet<number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const copy = eraCopy(era);
  const inEra = cards.filter((card) => card.era === era);
  const charters = inEra.filter((card) => card.isCharter === 1);
  const branchCards = inEra.filter((card) => card.isCharter === 0);
  if (inEra.length === 0) return null;

  return (
    <div className={cx(s.eraBand, current && s.eraBandCurrent)}>
      <div className={s.eraHead}>
        <span className={s.eraNumeral}>ERA {copy.numeral}</span>
        <span className={s.eraName}>{copy.name}</span>
        <span className={s.eraBlurb}>{copy.blurb}</span>
      </div>

      <div className={s.branchRow}>
        {BRANCH_ORDER.map((branch) => {
          const column = branchCards.filter((card) => card.branch === branch);
          const copyForBranch = BRANCH_COPY[branch];
          return (
            <div className={s.branchCol} key={branch}>
              <div className={s.branchName}>{copyForBranch?.name ?? ''}</div>
              {column.length === 0 ? (
                <div className={s.branchEmpty}>
                  {/*
                    Two different silences, and telling them apart matters. A branch with
                    nothing in THIS era is a gap in a tree the player is already walking; a
                    branch with nothing anywhere is a part of the game that has not been built.
                    Derived from the card list rather than hard-coded against a branch id,
                    because "which branch is empty" is a fact with a short shelf life — this
                    panel was written when Hydraulics had nothing in it and had four nodes by
                    the time it was first looked at.
                  */}
                  {emptyBranches.has(branch)
                    ? 'Nothing here yet — this part of the lot is still on the drawing board.'
                    : 'Nothing in this era.'}
                </div>
              ) : (
                column.map((card) => (
                  <NodeButton
                    key={card.id}
                    card={card}
                    selected={card.id === selectedId}
                    onSelect={onSelect}
                  />
                ))
              )}
            </div>
          );
        })}
      </div>

      {charters.map((card) => (
        <CharterBand
          key={card.id}
          card={card}
          selected={card.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

// --- one node --------------------------------------------------------------------------

/**
 * Five states, five treatments, and exactly one of them is gold.
 *
 * The restraint is the design. If "affordable", "nearly affordable", and "blocked" all get an
 * accent colour then none of them is an accent, and the frontier stops being findable at a
 * glance — which is the one thing §8's v0.7 gate actually measures.
 */
const STATUS_CLASS: Readonly<Record<TechCard['status'], string>> = {
  owned: s.nodeOwned,
  ready: s.nodeReady,
  short: s.nodeShort,
  pending: s.nodePending,
  blocked: s.nodeBlocked,
};

function NodeButton({
  card,
  selected,
  onSelect,
}: {
  card: TechCard;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const ref = useScrollIntoViewOnce(selected);

  return (
    <button
      type="button"
      ref={ref}
      className={cx(s.node, STATUS_CLASS[card.status], selected && s.nodeSelected)}
      onMouseDown={keepFocus}
      onClick={() => onSelect(card.id)}
    >
      <span className={s.nodeTop}>
        <span className={s.nodeTitle}>{card.title}</span>
        <span className={s.nodePrice}>
          {card.status === 'owned' ? 'done' : formatCentsWhole(card.priceCents)}
        </span>
      </span>
      <span className={s.nodeVerb}>{card.verb}</span>
    </button>
  );
}

/** Bring the seeded selection into view once, so the panel opens where the player is. */
function useScrollIntoViewOnce(active: boolean) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const done = useRef(false);
  useEffect(() => {
    if (!active || done.current) return;
    done.current = true;
    ref.current?.scrollIntoView({ block: 'center' });
  }, [active]);
  return ref;
}

// --- a Charter -------------------------------------------------------------------------

/**
 * An era gate, drawn as a band across the whole tree.
 *
 * Both halves of the gate are always on screen: the money, and the demonstrated milestone with
 * its counter and a bar. Plan §3 puts the Charters on a spine and the eras in a table, and
 * §7 ruling 3 requires the milestone to be visible rather than discovered. A Charter rendered
 * as one more card in the Commerce column would satisfy neither.
 */
function CharterBand({
  card,
  selected,
  onSelect,
}: {
  card: TechCard;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const ref = useScrollIntoViewOnce(selected);
  const owned = card.status === 'owned';
  const milestoneDone = card.milestoneNeed === 0 || card.milestoneHave >= card.milestoneNeed;
  const progress =
    card.milestoneNeed <= 0 ? 1 : Math.min(1, card.milestoneHave / card.milestoneNeed);

  return (
    <button
      type="button"
      ref={ref}
      className={cx(s.charterBand, owned && s.charterOwned, selected && s.charterSelected)}
      onMouseDown={keepFocus}
      onClick={() => onSelect(card.id)}
    >
      <span className={s.charterSeal}>{owned ? '✔' : '§'}</span>
      <span className={s.charterBody}>
        <span className={s.charterName}>{card.title}</span>
        <span className={s.charterVerb}>{owned ? 'Signed. The era is open.' : card.verb}</span>

        <span className={s.charterGates}>
          <span className={s.charterGate}>
            <span className={s.charterGateLabel}>the fee</span>
            <span
              className={cx(
                s.charterGateValue,
                owned || card.status === 'ready' ? s.charterGateMet : s.charterGateShort,
              )}
            >
              {formatCentsWhole(card.priceCents)}
            </span>
          </span>

          {card.milestoneKind === MilestoneKind.None ? null : (
            <span className={s.charterGate}>
              <span className={s.charterGateLabel}>
                {milestoneLabel(card.milestoneKind, card.milestoneNeed)}
              </span>
              <span
                className={cx(
                  s.charterGateValue,
                  milestoneDone ? s.charterGateMet : s.charterGateShort,
                )}
              >
                {card.milestoneHave} {milestoneNoun(card.milestoneKind)}
              </span>
              <span className={s.charterTrack}>
                <span
                  className={cx(s.charterFill, milestoneDone && s.charterFillMet)}
                  style={{ width: `${(progress * 100).toFixed(1)}%` }}
                />
              </span>
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

// --- the detail pane -------------------------------------------------------------------

function Detail({
  card,
  economy,
  pending,
  onResearch,
}: {
  card: TechCard;
  economy: EconomySlice;
  pending: boolean;
  onResearch: (id: string) => void;
}) {
  const deficit = card.priceCents - economy.moneyCents;
  const etaSeconds =
    deficit <= 0
      ? 0
      : economy.rateSettled === 1 && economy.rateCentsPerMin > 0
        ? (deficit * 60) / economy.rateCentsPerMin
        : -1;

  const buyable = card.status === 'ready' && !pending;

  return (
    <div className={s.techDetail}>
      <div className={s.detailBody}>
        <div className={s.detailTitle}>{card.title}</div>
        <div className={s.detailVerb}>{card.verb}</div>
        <div className={s.detailText}>{card.detail}</div>

        {card.missing.length > 0 ? (
          <div className={s.detailNeeds}>
            Behind {card.missing.join(' and ')} —{' '}
            {plural(card.missing.length, 'that comes', 'those come')} first.
          </div>
        ) : null}

        {card.status === 'pending' ? (
          <div className={s.detailNeeds}>
            The money is not the problem — {card.milestoneHave} of {card.milestoneNeed}{' '}
            {milestoneNoun(card.milestoneKind)}. Keep going and it opens on its own.
          </div>
        ) : null}

        {card.status === 'short' ? (
          <div className={s.detailEta}>
            {formatCentsWhole(deficit)} short
            {etaSeconds < 0 ? '' : ` · ${formatEta(etaSeconds)} at the current rate`}
          </div>
        ) : null}
      </div>

      <div className={s.detailBuy}>
        <button
          type="button"
          className={cx(s.buyButton, buyable && s.buyReady)}
          disabled={!buyable}
          onMouseDown={keepFocus}
          onClick={() => onResearch(card.id)}
        >
          {buttonLabel(card, pending)}
        </button>
        <span className={s.buyNote}>{buttonNote(card)}</span>
      </div>
    </div>
  );
}

function buttonLabel(card: TechCard, pending: boolean): string {
  if (card.status === 'owned') return 'Researched';
  if (pending) return 'Signing…';
  if (card.status === 'ready') return `Research · ${formatCentsWhole(card.priceCents)}`;
  if (card.status === 'blocked') return 'Locked';
  if (card.status === 'pending') return 'Not yet earned';
  return formatCentsWhole(card.priceCents);
}

function buttonNote(card: TechCard): string {
  switch (card.status) {
    case 'owned':
      return 'yours';
    case 'ready':
      return 'you can afford this now';
    case 'short':
      return 'save up';
    case 'pending':
      return 'money is fine · milestone is not';
    default:
      return 'earlier nodes first';
  }
}
