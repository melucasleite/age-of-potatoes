import Link from 'next/link';

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
      }}
    >
      <h1 style={{ margin: 0, fontSize: '2.5rem', letterSpacing: '0.05em' }}>SNACK MOGUL</h1>
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
