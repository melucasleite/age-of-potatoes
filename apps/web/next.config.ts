import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@snack/sim'],
  // Next writes its own AGENTS.md and CLAUDE.md into apps/web on every dev run. This
  // repo's AGENTS.md is load-bearing and lives at the root; letting Next scatter its
  // own copies next to it is how an agent ends up reading the wrong rules.
  agentRules: false,

  /**
   * THE ATLAS IS CONTENT-HASHED, SO IT MUST NEVER BE REVALIDATED.
   *
   * `atlas.<hash>.png` earns a new name whenever its bytes change ([[022]]), which is the
   * whole point of hashing it — a cached copy can only ever be correct. Next serves
   * `public/` with `max-age=0` by default, so every reload asked the server "still good?"
   * and the server answered **304 Not Modified with no body**. PixiJS loads the atlas
   * inside a worker (`WorkerManager.loadImageBitmap`), where that bodiless response is not
   * a cache hit but a failed fetch — so the texture never arrived, every sprite fell back
   * to its procedural placeholder, and the lot lost its people and its good ground while
   * the file sat on disk perfectly intact and serving 200 to anything that asked plainly.
   *
   * It went unnoticed for as long as nobody's cached copy disagreed with the server's
   * timestamp. Re-packing the atlas — same bytes, same hash, new mtime — is exactly what
   * starts the revalidation, so the failure arrived with an art run that changed nothing.
   *
   * `immutable` is the honest header for a name that can never mean two things, and it
   * removes the conditional request rather than teaching the loader to survive one.
   */
  async headers() {
    return [
      {
        source: '/art/:file(atlas\\..*)',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

export default nextConfig;
