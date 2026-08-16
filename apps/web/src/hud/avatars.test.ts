// The picker's portraits, pinned against the REAL manifest ([[079]]).
//
// What fails quietly: an atlas repack that drops or renames an avatar strip leaves the
// new-game picker with numbered chips where five farmers should be, and nothing throws.
// Resolving every portrait against the generated manifest makes that a red test instead.

import { describe, expect, it } from 'vitest';

import { AVATAR_COUNT, DEFAULT_AVATAR, avatarPortrait } from './avatars';

describe('avatarPortrait', () => {
  it('cuts a square first cell from every shipped avatar’s down strip', () => {
    for (let id = 1; id <= AVATAR_COUNT; id++) {
      const portrait = avatarPortrait(id);
      expect(portrait, `avatar ${String(id)}`).not.toBeNull();
      expect(portrait!.frame).toBe(`avatar${String(id)}_walk_down`);
      // Square, and the cell is the strip's height on both axes — a 32×16 two-cell strip
      // yields a 16×16 face, never the whole strip squashed into a button.
      expect(portrait!.width).toBe(portrait!.height);
    }
  });

  it('refuses ids outside the shipped range instead of inventing a farmer', () => {
    expect(avatarPortrait(0)).toBeNull();
    expect(avatarPortrait(AVATAR_COUNT + 1)).toBeNull();
    expect(avatarPortrait(2.5)).toBeNull();
    expect(avatarPortrait(-1)).toBeNull();
  });

  it('the Enter-through default is a real, shipped avatar', () => {
    expect(DEFAULT_AVATAR).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_AVATAR).toBeLessThanOrEqual(AVATAR_COUNT);
    expect(avatarPortrait(DEFAULT_AVATAR)).not.toBeNull();
  });
});
