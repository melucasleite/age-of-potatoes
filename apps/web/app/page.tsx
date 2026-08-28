import Link from 'next/link';

/**
 * The splash: the first thing anyone sees, and the second surface wearing the farm.
 *
 * [[092]] dressed the lot picker and stopped there, which left this screen a flat dark
 * rectangle one click earlier in the same flow — the owner spotted it immediately. The
 * layering below is the `.door` recipe verbatim (see `hud/FrontDoor.module.css`): the
 * picture underneath, a vertical gradient to seat it, and a horizontal scrim whose dark
 * core tracks the TEXT COLUMN rather than the viewport, so the middle stays readable while
 * the barn and the pond keep their light at the edges.
 *
 * Narrower here than on the picker — 230px there covers a 520px column of lot cards; this
 * screen holds a wordmark, one line and a button, so the scrim can close in and give the
 * farm more of the frame.
 */
const SCRIM = [
  'linear-gradient(' +
    '90deg,' +
    'rgba(20, 16, 25, 0) 0,' +
    'rgba(20, 16, 25, 0) calc(50% - 320px),' +
    'rgba(20, 16, 25, 0.86) calc(50% - 170px),' +
    'rgba(20, 16, 25, 0.86) calc(50% + 170px),' +
    'rgba(20, 16, 25, 0) calc(50% + 320px),' +
    'rgba(20, 16, 25, 0) 100%)',
  'linear-gradient(' +
    '180deg,' +
    'rgba(20, 16, 25, 0.62) 0%,' +
    'rgba(20, 16, 25, 0.24) 40%,' +
    'rgba(20, 16, 25, 0.72) 100%)',
  "url('/art/frontdoor_farm.png')",
].join(',');

export default function Home() {
  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: '1.5rem',
        textAlign: 'center',
        backgroundColor: '#141019',
        backgroundImage: SCRIM,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center, center, center 45%',
        backgroundSize: 'cover, cover, cover',
        // A 384px source at full-screen scale. Nearest-neighbour or nothing.
        imageRendering: 'pixelated',
      }}
    >
      <h1 style={{ margin: 0, fontSize: '2.5rem', letterSpacing: '0.05em' }}>AGE OF POTATOES</h1>
      <p style={{ margin: 0, opacity: 0.7, maxWidth: '32rem', lineHeight: 1.6 }}>
        Rent&rsquo;s paid through the month. Make chips.
      </p>
      <Link
        href="/play"
        style={{
          padding: '0.75rem 2rem',
          border: '2px solid var(--ink)',
          color: 'var(--ink)',
          textDecoration: 'none',
          letterSpacing: '0.1em',
        }}
      >
        PLAY
      </Link>
    </main>
  );
}
