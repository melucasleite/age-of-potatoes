'use client';

// The HUD tree. DOM chrome over the canvas, not part of the Pixi scene.
//
// NOTE WHAT IS NOT HERE: there is no provider, no context, no `useState` holding world
// data, and nothing passing sim numbers down as props from a common ancestor. Each panel
// subscribes to its own slice and re-renders alone. A Context value changing 8×/sec would
// re-render every consumer subtree, and `memo` on the children does not save you because
// Context propagation bypasses the memo check — which is why §13 states the rule as
// structural rather than as a performance preference.
//
// The root is `pointer-events: none`; only the toolbelt buttons opt back in. A HUD that
// swallows a click meant for a tile is a HUD that makes the game feel broken in a way the
// player cannot name.

import { Clipboard } from './Clipboard';
import { s } from './styles';
import { PerfOverlay } from './PerfOverlay';
import { Pouch } from './Pouch';
import { StatusRibbon } from './StatusRibbon';
import { Ticker } from './Ticker';
import { Toolbelt } from './Toolbelt';
import { useHudSlice } from './use-hud';

/**
 * Inlined by the bundler to a literal, so the branch below is dead code in a production
 * build and the overlay goes with it. Verified by grepping `.next` for a string that only
 * exists inside the overlay.
 */
const DEV = process.env.NODE_ENV !== 'production';

export default function HudRoot() {
  // Nothing has published yet — no world, or a save the client refused to overwrite. An
  // empty toolbelt is the tell, and it costs nothing to check because the slice is already
  // subscribed. Showing a confident "$0.00" over a boot failure would be a small lie.
  const tools = useHudSlice('tools');
  if (tools.slots.length === 0) return null;

  return (
    <div className={s.root}>
      <div className={`${s.corner} ${s.topLeft}`}>
        <Ticker />
      </div>

      {/*
        Ribbon, pouch, toolbelt — one centred stack at the bottom edge, in that order.
        The stack is centred rather than tucked left for two reasons: the toolbelt is the
        one thing here the player actually aims at, and the lower-left corner belongs to
        the audio layer's click-to-start gate ([[014]]), which must not end up underneath it.
      */}
      <div className={`${s.corner} ${s.bottomCentre}`}>
        <StatusRibbon />
        <Pouch />
        <Toolbelt />
      </div>

      <div className={`${s.corner} ${s.bottomRight}`}>
        <Clipboard />
      </div>

      {DEV ? (
        <div className={`${s.corner} ${s.topRight}`}>
          <PerfOverlay />
        </div>
      ) : null}
    </div>
  );
}
