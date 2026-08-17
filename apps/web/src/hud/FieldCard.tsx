'use client';

// The zone card readout, and the one alert that is allowed to interrupt ([[021]]).
//
// IT IS NOT A READOUT ANY MORE — the zone rows are OPENERS ([[102]]). For the whole life of
// this card its rows were `<span>`s that emitted nothing, which is how four working zone
// reducers (`SetZoneCrop`, `SetZoneAutoReplant`, `SetZonePriority`, `RenameZone`) ended up with
// no caller anywhere in the app. The controls themselves are NOT here: they live in
// `ZonePanel.tsx`, a floating window, because [[096]] unmounts this whole column when the
// sidebar folds and a control in here would be unreachable for anyone who had pressed `[`.
// A row click is `openZonePanel(zone.id)` — a second door to one panel, never a second copy of
// its controls. The crop name IS shown here, because "what is growing in that rectangle" is a
// readout, and until now the only place in the game that answered it was the dock card, gated
// behind owning an Agri-Bot dock.
//
// TWO THINGS THAT LOOK LIKE POLISH AND ARE NOT.
//
// 1. THE CARD APPEARS ONLY WHEN IT HAS SOMETHING TO SAY. A permanent panel reporting "0
//    wilting" trains the player to stop looking at the corner it lives in, and the corner
//    is where the alert appears. Chrome that is always there is chrome that is never read.
//
// 2. IT FALLS BACK TO THE WHOLE FIELD WHEN THERE ARE NO ZONES. `createWorld()` starts with
//    `zones: []`, so a player who has never painted a rectangle has no zone cards — which
//    is every player for their first session, and exactly the player most likely to leave a
//    crop in the ground too long. Reporting withering only per-zone would make the feature
//    invisible to the people it was built for. The zone rows are the richer readout; the
//    lot row is the one that guarantees the information exists at all.
//
// The alert's sixty-second delay is NOT implemented here — it is in `derive-lot.ts`, where
// the tick arithmetic is. By the time a `lot.alert` reaches this file it has already earned
// the right to be drawn, and this component's only job is to not bury it.

import { formatCentsWhole } from './format';
import { keepFocus } from './PanelFrame';
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
import { openZonePanel } from './zone-focus';
import type { ZoneRow } from './types';

export function FieldCard() {
  const lot = useHudSlice('lot');

  const zones = lot.zones;
  const withering = lot.wilting > 0 || lot.wilted > 0;
  // Compost on the ground counts as something to say: it is the one state the player cannot
  // read from the crop sprite, because the crop is gone.
  const worthDrawing = zones.length > 0 || withering || lot.compost > 0;
  if (!worthDrawing) return null;

  return (
    <div className={cx(s.card, s.fieldCard)}>
      <div className={s.label}>the field</div>

      {zones.length > 0 ? (
        zones.map((zone) => <ZoneLine key={zone.id} zone={zone} />)
      ) : (
        <LotLine wilting={lot.wilting} wilted={lot.wilted} compost={lot.compost} />
      )}

      {lot.alert !== null ? (
        <div className={s.fieldAlert}>
          <span className={s.fieldAlertMark} />
          <span>{lot.alert.text}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "North Field · Sugar Cane · 47/60 planted · 12 mature · 3 wilting · 1 Day-Old · 3 dry"
 *
 * Segments that are zero are dropped rather than printed as "0 wilting". A readout of
 * mostly zeroes reads as a form, and the two counts this item added would be the two easiest
 * to lose in it.
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
  if (zone.wilting > 0)
    parts.push(
      <span key="wilting" className={s.fieldWilting}>
        {zone.wilting} wilting
      </span>,
    );
  if (zone.wilted > 0)
    parts.push(
      <span key="wilted" className={s.fieldWilted}>
        {zone.wilted} Day-Old
      </span>,
    );
  if (zone.dry > 0) parts.push(<span key="dry">{zone.dry} dry</span>);
  if (zone.compost > 0) parts.push(<span key="compost">{zone.compost} compost</span>);

  return (
    <button
      type="button"
      className={cx(s.fieldRow, s.fieldRowOpen)}
      title={`${zone.name} — crop, seed hopper, priority, name`}
      onMouseDown={keepFocus}
      onClick={() => openZonePanel(zone.id)}
    >
      <div className={s.fieldName}>
        {zone.name}
        {/* The armed hopper, on the row that is always on screen. It is the one zone fact with
            no sign of itself in the field — a tile that re-sows looks like a tile somebody
            sowed — so if it is not said here it is not said anywhere the player is looking. */}
        {zone.autoReplant === 1 ? <span className={s.fieldArmed}>hopper</span> : null}
      </div>
      <div className={s.fieldReadout}>{join(parts)}</div>
    </button>
  );
}

/** The unzoned fallback. Same counts, no name, because the whole lot is the subject. */
function LotLine({
  wilting,
  wilted,
  compost,
}: {
  wilting: number;
  wilted: number;
  compost: number;
}) {
  const parts: React.ReactNode[] = [];
  if (wilting > 0)
    parts.push(
      <span key="wilting" className={s.fieldWilting}>
        {wilting} wilting
      </span>,
    );
  if (wilted > 0)
    parts.push(
      <span key="wilted" className={s.fieldWilted}>
        {wilted} Day-Old
      </span>,
    );
  if (compost > 0) parts.push(<span key="compost">{compost} compost</span>);
  if (parts.length === 0) return null;

  return (
    <div className={s.fieldRow}>
      <div className={s.fieldReadout}>{join(parts)}</div>
    </div>
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

/**
 * Exported for the Welcome Back card, which says the same thing in a different tense.
 *
 * Kept here rather than in `format.ts` because it is not a formatting primitive — it is this
 * feature's one sentence about money, and having exactly one copy of it is what stops the
 * two cards from quietly disagreeing about what a wilting field costs.
 */
export function atRiskSentence(atRiskCents: number): string {
  return `${formatCentsWhole(atRiskCents)} at risk`;
}
