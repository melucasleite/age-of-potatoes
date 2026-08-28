// The research slice's dependency edges ([[144]]), and the era arithmetic after the Corporate
// Charter's retirement ([[147]]).
//
// WHAT FAILS SILENTLY HERE, which is why these tests exist and not others:
//
//   · IF `requires` STOPS MIRRORING `TECH_NODES`, the card face draws a tree that is not the
//     one the reducer walks — a prerequisite chip missing from a card is indistinguishable,
//     to a player, from a node that does not need it.
//   · IF A `met` FLAG GOES STALE, a bought prerequisite keeps shouting amber. That is the
//     store's diff to get right, so the diff is exercised here THROUGH the store, not by
//     calling the private comparison: publish, buy, publish, and watch the reference change.
//   · IF THE ERA DERIVATION DRIFTED, the panel would draw a band for an era the game cannot
//     reach. Eras are 1 + charters-in-closure and the tree has two charters, so MAX_ERA is 3
//     — the number is asserted because item 147's whole point was that it stops being 4.
//
// NOT COVERED, deliberately: React. What the chips look like was checked in a browser; the
// findings are in the work item's agent log.

import { describe, expect, it } from 'vitest';

import { TECH_NODES, createWorld, createWorldView, insertUnlocked, view } from '@snack/sim';
import type { WorldState } from '@snack/sim';

import { createTechFields, deriveTech, MAX_ERA, TECH_LEADS_TO, eraOfNode } from './derive-tech';
import { nodeCopy } from './tech-copy';
import { hudStore } from './store';
import { ToolMode } from '../game/input/tools';

function techOf(state: WorldState) {
  return deriveTech(view(state, createWorldView()), createTechFields());
}

describe('the dependency edges on every card', () => {
  it('mirrors TECH_NODES exactly — every edge, in the sim`s own order, titled from the copy', () => {
    const tech = techOf(createWorld(1));
    expect(tech.cards.length).toBe(TECH_NODES.length);

    for (let i = 0; i < TECH_NODES.length; i++) {
      const node = TECH_NODES[i]!;
      const card = tech.cards[i]!;
      expect(card.id).toBe(node.id);
      expect(card.requires.map((edge) => edge.id)).toEqual([...node.requires]);
      for (const edge of card.requires) {
        expect(edge.title).toBe(nodeCopy(edge.id).title);
      }
    }
  });

  it('starts with every edge unmet on a fresh world, and missing agreeing with it', () => {
    const tech = techOf(createWorld(1));
    for (const card of tech.cards) {
      for (const edge of card.requires) expect(edge.met).toBe(0);
      expect(card.missing.length).toBe(card.requires.length);
    }
  });

  it('flips met — and only met — when the prerequisite is researched', () => {
    const state = createWorld(1);
    insertUnlocked(state.unlocked, 'fabrication-wash-and-slice');

    const fryer = techOf(state).cards.find((card) => card.id === 'fabrication-fryer')!;
    expect(fryer.requires).toEqual([
      {
        id: 'fabrication-wash-and-slice',
        title: nodeCopy('fabrication-wash-and-slice').title,
        met: 1,
      },
    ]);
    expect(fryer.missing).toEqual([]);
  });
});

describe('the forward edges, derived once from the same tree', () => {
  it('is the exact inversion of every requires list', () => {
    const forward: Record<string, string[]> = {};
    for (const node of TECH_NODES) {
      for (const required of node.requires) {
        (forward[required] ??= []).push(nodeCopy(node.id).title);
      }
    }
    for (const node of TECH_NODES) {
      expect(TECH_LEADS_TO[node.id] ?? []).toEqual(forward[node.id] ?? []);
    }
  });

  it('gives the Workshop Charter the widest doorway, because it opens Era II', () => {
    expect((TECH_LEADS_TO['charter-workshop'] ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('eras after the Corporate Charter (item 147)', () => {
  it('tops out at three — the fourth era is not drawn because it cannot be reached', () => {
    expect(MAX_ERA).toBe(3);
    for (const node of TECH_NODES) {
      expect(eraOfNode(node.id)).toBeLessThanOrEqual(3);
      expect(eraOfNode(node.id)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('the store`s tech diff, exercised through the store', () => {
  it('keeps the same slice for an unchanged world and republishes on a bought prerequisite', () => {
    const token = {};
    const state = createWorld(1);
    const buffer = createWorldView();
    hudStore.claim(
      token,
      () => undefined,
      () => undefined,
    );
    try {
      hudStore.publishWorld(token, view(state, buffer), ToolMode.Hand);
      const first = hudStore.getSnapshot().tech;

      // Nothing moved: the diff must hand back the SAME reference, or the panel re-renders
      // 6.7 times a second to redraw identical cards.
      hudStore.publishWorld(token, view(state, buffer), ToolMode.Hand);
      expect(hudStore.getSnapshot().tech).toBe(first);

      // A prerequisite lands: the met flag is the thing that changed, so the diff must see it
      // ([[144]] — the card face draws these flags now).
      insertUnlocked(state.unlocked, 'fabrication-wash-and-slice');
      hudStore.publishWorld(token, view(state, buffer), ToolMode.Hand);
      const second = hudStore.getSnapshot().tech;
      expect(second).not.toBe(first);
      expect(second.version).toBeGreaterThan(first.version);

      const fryer = second.cards.find((card) => card.id === 'fabrication-fryer')!;
      expect(fryer.requires[0]?.met).toBe(1);
    } finally {
      hudStore.release(token);
    }
  });
});
