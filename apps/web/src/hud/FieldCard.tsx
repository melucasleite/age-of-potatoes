'use client';

// The zone card readout ([[021]], [[102]]).
//
// IT IS NOT A READOUT ANY MORE — the zone rows are OPENERS ([[102]]). For the whole life of
// this card its rows were `<span>`s that emitted nothing, which is how working zone reducers
// (`SetZoneCrop`, `SetZonePriority`, `RenameZone`) ended up with no caller anywhere in the
// app. The controls themselves are NOT here: they live in
// `ZonePanel.tsx`, a floating window, because [[096]] unmounts this whole column when the
// sidebar folds and a control in here would be unreachable for anyone who had pressed `[`.
// A row click is `openZonePanel(zone.id)` — a second door to one panel, never a second copy of
// its controls. The crop name IS shown here, because "what is growing in that rectangle" is a
// readout, and until now the only place in the game that answered it was the dock card, gated
// behind owning an Agri-Bot dock.
//
// THE CARD APPEARS ONLY WHEN IT HAS SOMETHING TO SAY. A permanent panel reporting "0 planted"
// trains the player to stop looking at the corner it lives in. Chrome that is always there is
// chrome that is never read.
//
// ⚠️ THE UNZONED FALLBACK IS GONE, AND ITS ABSENCE IS THE POINT ([[124]]). This card used to
// draw a nameless lot-wide row for players who had never painted a rectangle, on the argument
// that wilting had to be visible to the people most likely to leave a crop in the ground too
// long. That row printed three things and only three: wilting, Day-Old, and compost. Crops do
// not wilt now and compost does not exist, so the fallback had nothing left to say and drawing
// an empty row would be worse than drawing none. The alert slot went the same way — the single
// cash-phrased alert (`RiskWatch`, the sixty-second arming, the two-tense wilt copy) priced a
// bleed that cannot happen. **If a future alert needs this corner, build it from a live
// pressure; do not resurrect the arithmetic, it is measuring nothing.**

import { keepFocus } from './PanelFrame';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import { openZonePanel } from './zone-focus';
import type { ZoneRow } from './types';

export function FieldCard() {
  const lot = useHudSlice('lot');

  const zones = lot.zones;
  if (zones.length === 0) return null;

  return (
    <div className={cx(s.card, s.fieldCard)}>
      <div className={s.label}>the field</div>
      {zones.map((zone) => (
        <ZoneLine key={zone.id} zone={zone} />
      ))}
    </div>
  );
}

/**
 * "North Field · Sugar Cane · 47/60 planted · 12 mature · 3 dry"
 *
 * Segments that are zero are dropped rather than printed as "0 mature". A readout of mostly
 * zeroes reads as a form.
 *
 * A BUTTON SINCE [[102]], and it stays a readout while it is one: the row still says exactly
 * what it said before, it can just be pressed now. The crop is the one new segment, and it
 * leads — it is the fact the counts are all about, and a rectangle whose crop the player cannot
 * see is the "decision made once, blind" the item was filed against.
 */
function ZoneLine({ zone }: { zone: ZoneRow }) {
  const parts: React.ReactNode[] = [
    <span key="crop" className={zone.cropName === '' ? s.fieldFallow : undefined}>
      {zone.cropName === '' ? 'fallow' : zone.cropName}
    </span>,
    <span key="planted">
      {zone.planted}/{zone.tiles} planted
    </span>,
  ];
  if (zone.mature > 0) parts.push(<span key="mature">{zone.mature} mature</span>);
  if (zone.dry > 0) parts.push(<span key="dry">{zone.dry} dry</span>);

  return (
    <button
      type="button"
      className={cx(s.fieldRow, s.fieldRowOpen)}
      title={`${zone.name} — crop, priority, name`}
      onMouseDown={keepFocus}
      onClick={() => openZonePanel(zone.id)}
    >
      {/* The "hopper" badge sat beside the name here — the armed auto-replant, the one zone
          fact with no sign of itself in the field. The hopper retired with its node (item 146),
          and a badge for a state that cannot exist went with it. */}
      <div className={s.fieldName}>{zone.name}</div>
      <div className={s.fieldReadout}>{join(parts)}</div>
    </button>
  );
}

/** Interleave a middot separator. A `·` between spans, never a trailing one. */
function join(parts: React.ReactNode[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push(<span key={`sep-${i}`} className={s.fieldSep} />);
    out.push(parts[i]);
  }
  return out;
}
