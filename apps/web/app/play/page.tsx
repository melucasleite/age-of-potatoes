import type { Metadata } from 'next';

import PlayClient from './play-client';

export const metadata: Metadata = {
  title: 'Snack Mogul — the lot',
  description: 'Plant, water, harvest, fry, sell.',
};

export default function PlayPage() {
  return (
    <main
      style={{
        position: 'fixed',
        inset: 0,
        background: '#141019',
        overflow: 'hidden',
      }}
    >
      <PlayClient />
    </main>
  );
}
