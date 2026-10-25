import Link from 'next/link';

import styles from './page.module.css';

/**
 * The splash: the first thing anyone sees, and the second surface wearing the farm.
 *
 * [[092]] dressed the lot picker and stopped there, which left this screen a flat dark
 * rectangle one click earlier in the same flow — the owner spotted it immediately. The
 * layering (in `page.module.css`, `.splash`) is the `.door` recipe from
 * `hud/FrontDoor.module.css`: the picture underneath, a vertical gradient to seat it, and a
 * horizontal scrim whose dark core tracks the TEXT COLUMN rather than the viewport.
 *
 * THE CHAIN UNDER THE BUTTON IS THE GAME, NOT DECORATION. Five sprites straight off
 * `art/cooked`, in the order a lot actually runs: the sprinkler waters, the potato grows, the
 * slicer and fryer turn it into chips, the bagger seals them. A stranger reads the whole loop
 * in one glance without pressing anything. The copies live in `public/art/splash/` because
 * the atlas is a packed page, not five addressable files; if a sprite is redrawn, re-copy it.
 */
const CHAIN = [
  { src: '/art/splash/machine_sprinkler.png', alt: 'Sprinkler', label: 'water' },
  { src: '/art/splash/item_potato.png', alt: 'Potato', label: 'grow' },
  { src: '/art/splash/item_potato_slices.png', alt: 'Potato slices', label: 'slice' },
  { src: '/art/splash/item_plain_chips.png', alt: 'Chips', label: 'fry' },
  { src: '/art/splash/item_chip_bag.png', alt: 'Bag of chips', label: 'bag' },
] as const;

export default function Home() {
  return (
    <main className={styles.splash}>
      <h1 className={styles.wordmark}>AGE OF POTATOES</h1>
      <p className={styles.hook}>
        Plant potatoes by hand, then build a factory that fries and bags them while you nap.
      </p>
      <Link href="/play" className={styles.play}>
        PLAY
      </Link>
      <p className={styles.kicker}>
        A farming and factory game. Runs in your browser, nothing to install.
      </p>
      <ol className={styles.chain} aria-label="What the factory does">
        {CHAIN.map((step) => (
          <li key={step.label}>
            <img src={step.src} alt={step.alt} width={32} height={32} />
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
      <footer className={styles.credit}>
        <p>
          I&apos;m{' '}
          <a href="https://github.com/melucasleite" rel="noopener">
            Lucas Leite
          </a>
          . I built it because it&apos;s fun and I like potatoes and factories. Say hi at{' '}
          <a href="mailto:me@lucasleite.us">me@lucasleite.us</a> or file bugs in{' '}
          <a href="https://github.com/melucasleite/age-of-potatoes/issues" rel="noopener">
            GitHub issues
          </a>
          .
        </p>
      </footer>
    </main>
  );
}
