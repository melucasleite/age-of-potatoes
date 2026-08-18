// Which farmer walks the world ([[079]]): the avatar id, published for the renderer.
//
// ── THE SEAM, ON THE `armedTool` PRECEDENT ──────────────────────────────────────────────
//
// The avatar is cosmetic identity: it lives in the save ENVELOPE's metadata, never in
// `WorldState`, never in the trace, never in the hash — replays are avatar-agnostic by
// construction. The renderer needs exactly one fact out of the storage layer: which strip
// family to dress the player sprite in. So the boot path publishes the id into the
// singleton below when a world is opened (and 0 again when one is left), and the renderer
// reads it per frame — per frame rather than at scene build, so publication order against
// scene construction cannot matter and StrictMode's double host stays harmless.
//
// WAVE-11 NOTE: the storage half (envelope metadata, the front-door picker) is the HUD
// lane's and had not landed when this was written. Until `publishAvatar` is called the id
// is 0 — the legacy farmer — which is exactly what every existing save must show anyway.
//
// ── THE FRAME CONTRACT, FROM THE ART LANE VERBATIM ──────────────────────────────────────
//
// `avatar<N>_walk_{up,side,down}` for N in 1..5: 144×48 THREE-cell strips, the exact shape of
// `player_walk_*`, side authored FACING EAST (west mirrors — the player convention). The
// legacy farmer stays `player_walk_*`, untouched, as avatar 0.
//
// The shape has moved twice and both moves were free, because the cells are read off the
// picture (`stripCells`) rather than declared anywhere: 32×16 two-cell at v0.1, 96×48 at the
// resolution bump (commit `9359be8`, characters ~1.5 tiles tall), and 144×48 three-cell at
// [[134]], which widened the harvest to take the sheet's PASSING pose as well as its two
// contact poses. The third cell is the neutral one a standing character shows — see
// `STAND_CELL` in `./strips` for why it is cell 3 and not cell 1.

/** How many generated avatars the art contract ships. Ids run 1..AVATAR_COUNT. */
export const AVATAR_COUNT = 5;

/** What the renderer may know about the chosen avatar. Plain data, mutated in place. */
export interface AvatarIdentityView {
  /** Bumped on every change, so a consumer can cheaply skip untouched frames. */
  version: number;
  /** 1..AVATAR_COUNT for a generated avatar; 0 (or anything else) for the legacy farmer. */
  avatarId: number;
}

export const avatarIdentity: AvatarIdentityView = {
  version: 0,
  avatarId: 0,
};

/** Called by the boot path when a world opens (and with 0 when the player leaves it). */
export function publishAvatar(avatarId: number): void {
  if (avatarIdentity.avatarId === avatarId && avatarIdentity.version > 0) return;
  avatarIdentity.avatarId = avatarId;
  avatarIdentity.version += 1;
}

/**
 * The walk-cell frame for an avatar, or `null` for "use the legacy farmer's".
 *
 * Pure — the renderer asks `art.isReal` about the answer and falls back to
 * `ART.playerWalk` itself, so an atlas from before the avatars shipped (or no atlas at
 * all) degrades to the farmer everyone already has rather than to a magenta square.
 */
export function avatarWalkFrame(
  avatarId: number,
  pose: 'north' | 'south' | 'side',
  step: number,
): string | null {
  if (!Number.isInteger(avatarId) || avatarId < 1 || avatarId > AVATAR_COUNT) return null;
  return `avatar${avatarId}_walk_${pose}_${step}`;
}
