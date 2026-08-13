// The cheap structural gate for the Hall of Hands.
//
// Item 011's acceptance criterion is three clauses long and only one of them is about how
// the theatre LOOKS: "the first activation plays the ~10 s ceremony; the sim keeps running
// during it; reloading the save does not replay it." The other two are logic, they are both
// invisible until they are wrong, and the failure mode of the third is the worst kind —
// nobody notices a ceremony that replays until they have already reloaded twice and started
// to resent it.
//
// So what is pinned here is WHEN it fires, not what it draws:
//
//   priming, because a restored save arrives with every ceremony it has ever played still
//   listed, and firing on that would replay a world's whole history at load;
//
//   once-ever, because "a first time that happens again is not a first time" (view.ts);
//
//   and the skip, because ten seconds is long and a player who has seen it must be able to
//   get on with the game.
//
// Pixi is constructed for real here — `Ceremony` builds two `Text` objects and a `Graphics`
// — but nothing is rendered and no GPU is touched. `Texture.EMPTY` stands in for the atlas.

import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';

import { CeremonyId, MachineKind } from '@snack/sim';
import type { MachineView, WorldView } from '@snack/sim';

import { Ceremony } from './ceremony';

function make(): Ceremony {
  return new Ceremony(Texture.EMPTY, () => undefined);
}

/** Only the fields `Ceremony` actually reads. Everything else is noise for this test. */
function machine(overrides: Partial<MachineView> = {}): MachineView {
  return {
    id: 1,
    kind: MachineKind.Sprinkler,
    tileX: 4,
    tileY: 4,
    tilesWide: 1,
    tilesHigh: 1,
    coverageRadius: 2,
    moistureSensing: 0,
    network: 0,
    wateredCount: 0,
    ...overrides,
  } as unknown as MachineView;
}

function view(ceremonies: string[], machines: MachineView[]): WorldView {
  return { ceremonies, machines } as unknown as WorldView;
}

/** Run the clock forward in frame-sized steps, the way the render loop does. */
function advance(ceremony: Ceremony, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) ceremony.update(16);
}

const POURED = [machine({ wateredCount: 3 })];
const DRY = [machine({ wateredCount: 0 })];

describe('ceremony triggering', () => {
  it('primes on the first frame rather than firing', () => {
    const ceremony = make();

    // A save whose sprinkler has already run. This is the reload case, and it is the whole
    // point: the world remembers, so the celebration does not happen again.
    ceremony.observe(view([CeremonyId.Sprinkler], POURED));
    expect(ceremony.playing).toBe(false);

    advance(ceremony, 200);
    expect(ceremony.playing).toBe(false);
  });

  it('fires when a sprinkler pours for the first time', () => {
    const ceremony = make();
    ceremony.observe(view([], DRY));
    expect(ceremony.playing).toBe(false);

    ceremony.observe(view([CeremonyId.Sprinkler], POURED));
    expect(ceremony.playing).toBe(true);
  });

  it('never fires the same celebration twice', () => {
    const ceremony = make();
    ceremony.observe(view([], DRY));
    ceremony.observe(view([CeremonyId.Sprinkler], POURED));
    expect(ceremony.playing).toBe(true);

    // Run it out, then keep pouring. The machine is still watering every five seconds and
    // must never earn a second ceremony for it.
    advance(ceremony, 11_000);
    expect(ceremony.playing).toBe(false);

    ceremony.observe(view([CeremonyId.Sprinkler], POURED));
    ceremony.observe(view([CeremonyId.Sprinkler], POURED));
    expect(ceremony.playing).toBe(false);
  });

  // THE CASE THE STAND-IN GOT WRONG, now pinned. Deriving "has it poured?" from a machine's
  // lifetime counter meant a demolish-and-rebuild reset the fact and replayed the ceremony.
  // The sim's own flag is on the WORLD, so a second sprinkler earns nothing.
  it('stays silent for a replacement sprinkler in a world that already celebrated', () => {
    const ceremony = make();
    ceremony.observe(view([], DRY));
    ceremony.observe(view([CeremonyId.Sprinkler], POURED));
    advance(ceremony, 11_000);
    expect(ceremony.playing).toBe(false);

    // Old one demolished, a fresh one built and now pouring. The id is still on the world.
    ceremony.observe(view([CeremonyId.Sprinkler], [machine({ wateredCount: 1 })]));
    expect(ceremony.playing).toBe(false);
  });

  it('fires on a sim ceremony id it has not seen', () => {
    const ceremony = make();
    const hub = [machine({ moistureSensing: 1, wateredCount: 1, kind: MachineKind.Sprinkler })];

    ceremony.observe(view([], DRY));
    ceremony.observe(view([CeremonyId.IrrigationHub], hub));
    expect(ceremony.playing).toBe(true);
  });

  it('ignores a sim ceremony id that was already in the save', () => {
    const ceremony = make();
    const hub = [machine({ moistureSensing: 1, wateredCount: 1 })];

    // Present on the very first frame: this world played it long ago.
    ceremony.observe(view([CeremonyId.IrrigationHub], hub));
    ceremony.observe(view([CeremonyId.IrrigationHub], hub));
    expect(ceremony.playing).toBe(false);
  });

  it('stays silent when there is no machine to point at', () => {
    const ceremony = make();
    ceremony.observe(view([], []));

    // The id is owed but the machine is gone — a save can legitimately be in this state.
    // Framing a celebration on empty dirt is worse than playing none.
    ceremony.observe(view([CeremonyId.IrrigationHub], []));
    expect(ceremony.playing).toBe(false);
  });
});

describe('ceremony playback', () => {
  it('runs for about ten seconds and then stops on its own', () => {
    const ceremony = make();
    ceremony.observe(view([], DRY));
    ceremony.observe(view([CeremonyId.Sprinkler], POURED));

    advance(ceremony, 9_000);
    expect(ceremony.playing).toBe(true);

    advance(ceremony, 1_200);
    expect(ceremony.playing).toBe(false);
  });

  it('leans the camera toward the machine and hands it back afterwards', () => {
    const ceremony = make();
    const out = { x: 0, y: 0 };

    // Nothing playing: the player's own position, untouched, so the caller needs no branch.
    ceremony.cameraTarget(10, 20, out);
    expect(out).toEqual({ x: 10, y: 20 });

    ceremony.observe(view([], DRY));
    ceremony.observe(view([CeremonyId.Sprinkler], POURED));
    advance(ceremony, 1_000);

    // The machine sits at tile (4,4), i.e. world pixel 72 — well right of the player at 10.
    ceremony.cameraTarget(10, 20, out);
    expect(out.x).toBeGreaterThan(10);

    // ...and never all the way. The player is still the subject; the camera only leans.
    expect(out.x).toBeLessThan(72);

    advance(ceremony, 10_000);
    ceremony.cameraTarget(10, 20, out);
    expect(out).toEqual({ x: 10, y: 20 });
  });
});
