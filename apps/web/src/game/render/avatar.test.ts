// Strip-family resolution per avatar ([[079]]).
//
// What fails QUIETLY without this: an off-by-one on the id range dresses avatar 5 as the
// legacy farmer (or asks the atlas for an avatar 6 that never shipped), and a publish that
// forgets its version bump leaves a consumer skipping every frame after the choice.

import { describe, expect, it } from 'vitest';

import { AVATAR_COUNT, avatarIdentity, avatarWalkFrame, publishAvatar } from './avatar';

describe('avatarWalkFrame', () => {
  it('names every pose and step for every shipped avatar', () => {
    for (let id = 1; id <= AVATAR_COUNT; id++) {
      for (const pose of ['north', 'south', 'side'] as const) {
        for (const step of [1, 2]) {
          expect(avatarWalkFrame(id, pose, step)).toBe(`avatar${id}_walk_${pose}_${step}`);
        }
      }
    }
  });

  it('answers null for the legacy farmer and for ids that never shipped', () => {
    expect(avatarWalkFrame(0, 'south', 1)).toBeNull();
    expect(avatarWalkFrame(AVATAR_COUNT + 1, 'south', 1)).toBeNull();
    expect(avatarWalkFrame(-3, 'side', 2)).toBeNull();
    expect(avatarWalkFrame(2.5, 'north', 1)).toBeNull();
  });

  it('ships exactly the five the art contract names', () => {
    expect(AVATAR_COUNT).toBe(5);
  });
});

describe('publishAvatar', () => {
  it('bumps the version on change and holds it on a repeat', () => {
    publishAvatar(3);
    const after = avatarIdentity.version;
    expect(avatarIdentity.avatarId).toBe(3);
    publishAvatar(3);
    expect(avatarIdentity.version).toBe(after);
    publishAvatar(0);
    expect(avatarIdentity.avatarId).toBe(0);
    expect(avatarIdentity.version).toBe(after + 1);
  });
});
