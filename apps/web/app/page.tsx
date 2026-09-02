import Link from 'next/link';

import styles from './page.module.css';

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
 * screen holds a wordmark, two lines and one big button, so the scrim can close in and give
 * the farm more of the frame.
 *
 * THE BUTTON AND THE COPY live in `page.module.css` — the old version was one 12px-ish outlined
 * link under a tagline about rent, and the owner's note was that it was neither fun nor big.
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
      <h1 style={{ margin: 0, fontSize: '3rem', letterSpacing: '0.08em' }}>AGE OF POTATOES</h1>
      <p className={styles.hook}>
        Turn one weedy roadside lot into a chips-and-soda empire. Starting capital: a sack of seed
        potatoes and wildly unearned confidence.
      </p>
      <p className={styles.hookDetail}>
        Grow it · Fry it · Bag it · Sell it by the road · Build a factory to do it all while you nap
      </p>
      <Link href="/play" className={styles.play} style={{ marginTop: '0.5rem' }}>
        PLAY
      </Link>
    </main>
  );
}
