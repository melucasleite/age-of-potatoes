import type { ProviderName } from '../manifest.js';
import { createRetroDiffusionAdapter } from './retro-diffusion.js';
import { createLocalAdapter } from './local.js';
import type { ProviderAdapter } from './types.js';

const cache = new Map<ProviderName, ProviderAdapter>();

/** Adapters are built lazily so a manifest with no RD entries never demands the token. */
export function getAdapter(name: ProviderName): ProviderAdapter {
  const existing = cache.get(name);
  if (existing) return existing;

  const adapter = name === 'retro-diffusion' ? createRetroDiffusionAdapter() : createLocalAdapter();
  cache.set(name, adapter);
  return adapter;
}

export type { ProviderAdapter, ProviderCapabilities } from './types.js';
