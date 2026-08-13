'use client';

// The zone card readout, and the one alert that is allowed to interrupt ([[021]]).
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
import { cx, s } from './styles';
import { useHudSlice } from './use-hud';
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
 * "North Field · 47/60 planted · 12 mature · 3 wilting · 1 Day-Old · 3 dry"
 *
 * Segments that are zero are dropped rather than printed as "0 wilting". A readout of
 * mostly zeroes reads as a form, and the two counts this item added would be the two easiest
 * to lose in it.
 */
function ZoneLine({ zone }: { zone: ZoneRow }) {
  const parts: React.ReactNode[] = [
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
    <div className={s.fieldRow}>
      <div className={s.fieldName}>{zone.name}</div>
      <div className={s.fieldReadout}>{join(parts)}</div>
    </div>
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
