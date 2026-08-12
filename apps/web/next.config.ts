import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@snack/sim'],
  // Next writes its own AGENTS.md and CLAUDE.md into apps/web on every dev run. This
  // repo's AGENTS.md is load-bearing and lives at the root; letting Next scatter its
  // own copies next to it is how an agent ends up reading the wrong rules.
  agentRules: false,
};

export default nextConfig;
