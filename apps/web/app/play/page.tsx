import type { Metadata } from 'next';

import PlayClient from './play-client';

export const metadata: Metadata = {
  title: 'Snack Mogul — the lot',
  description: 'Plant, water, harvest, fry, sell.',
};

/**
 * `/play` is the front door; `/play?world=<id>` is the lot ([[055]]).
 *
 * THE WORLD ID IS READ HERE, IN THE SERVER COMPONENT, and handed down as a prop. The
 * alternatives are both worse: `useSearchParams` would need a Suspense boundary around a tree
 * whose whole job is to be client-only anyway, and reading `window.location` in an effect would
 * cost a frame of nothing before the door could decide what to draw.
 *
 * Reading `searchParams` makes the route dynamic. That is correct rather than a cost — the page
 * shows a different screen for every value of it, and there is nothing here worth prerendering.
 */
export default async function PlayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params['world'];
  const worldId = typeof raw === 'string' && raw.length > 0 ? raw : null;

  return (
    <main
      style={{
        position: 'fixed',
        inset: 0,
        background: '#141019',
        overflow: 'hidden',
      }}
    >
      <PlayClient worldId={worldId} />
    </main>
  );
}
