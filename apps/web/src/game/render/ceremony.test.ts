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

function view(
  ceremonies: string[],
  machines: MachineView[],
  contracts: { depotId: number; phase: number }[] = [],
): WorldView {
  // `commerce` is spelled out rather than left off: the truck ceremony reads the contract
  // phases to find which dock the truck actually rolled out of, and the real projection always
  // carries the field. A fixture that omitted it would be testing a shape the game never sees.
  return { ceremonies, machines, commerce: { contracts } } as unknown as WorldView;
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

  // THE TRUCK IS THE FIRST CEREMONY THAT IS NOT ABOUT WATER, and `locate` used to open by
  // skipping every machine with no coverage radius — which is every depot ever built. Reached
  // through that filter this fired with the halo parked on a sprinkler across the lot, or on
  // nothing at all. Three cases, because each fails differently.
  it('fires on the first truck and points at the depot, not at a sprinkler', () => {
    const ceremony = make();
    const depot = machine({
      id: 7,
      kind: MachineKind.TruckDepot,
      tileX: 20,
      tileY: 9,
      tilesWide: 2,
      tilesHigh: 2,
      coverageRadius: 0,
    });
    const world = [machine({ wateredCount: 3 }), depot];

    ceremony.observe(view([], world));
    ceremony.observe(view([CeremonyId.FirstTruck], world, [{ depotId: 7, phase: 2 }]));
    expect(ceremony.playing).toBe(true);

    // The camera leans toward tile (20,9) — world pixel 336 — and never toward the sprinkler
    // at pixel 72, which is where the coverage scan would have sent it.
    const out = { x: 0, y: 0 };
    advance(ceremony, 1_000);
    ceremony.cameraTarget(0, 0, out);
    expect(out.x).toBeGreaterThan(100);
  });

  it('picks the depot whose truck is actually rolling', () => {
    const ceremony = make();
    const near = machine({ id: 3, kind: MachineKind.TruckDepot, tileX: 2, tileY: 2 });
    const far = machine({ id: 9, kind: MachineKind.TruckDepot, tileX: 40, tileY: 2 });

    ceremony.observe(view([], [near, far]));
    // The FAR one is out on the road; the near one is only waiting on stock.
    ceremony.observe(
      view(
        [CeremonyId.FirstTruck],
        [near, far],
        [
          { depotId: 3, phase: 0 },
          { depotId: 9, phase: 2 },
        ],
      ),
    );

    const out = { x: 0, y: 0 };
    advance(ceremony, 1_000);
    ceremony.cameraTarget(0, 0, out);
    // Tile 40 is world pixel 640; tile 2 is 32. Anything past 200 can only be the far depot.
    expect(out.x).toBeGreaterThan(200);
  });

  it('stays silent for a first truck with no depot on the lot', () => {
    const ceremony = make();
    ceremony.observe(view([], POURED));
    // A sprinkler is standing right there and waters a 5x5 patch. It is not a truck depot, and
    // the old fallback would have celebrated it.
    ceremony.observe(view([CeremonyId.FirstTruck], POURED));
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
