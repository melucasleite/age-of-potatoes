// The one-shot panel request seam, now that a request can carry a payload ([[148]]).
//
// What fails quietly here: the options object being dropped between `requestPanel` and the
// listener. The panel would still open — `HudRoot`'s handler falls back to a plain open —
// so a locked build cell would land the player on the research FRONTIER instead of on the
// node that locked them, with nothing thrown and nothing visibly broken.

import { describe, expect, it } from 'vitest';

import { onPanelRequest, requestPanel } from './panels';
import type { PanelRequest, PanelRequestOptions } from './panels';

describe('requestPanel', () => {
  it('hands the panel name and the payload to every listener, then forgets both', () => {
    const heard: { panel: PanelRequest; options: PanelRequestOptions | undefined }[] = [];
    const unsubscribe = onPanelRequest((panel, options) => {
      heard.push({ panel, options });
    });

    requestPanel('research', { techId: 'logistics-belts' });
    requestPanel('shop');

    unsubscribe();
    requestPanel('inventory'); // nobody listening — a no-op, exactly as the header promises

    expect(heard).toEqual([
      { panel: 'research', options: { techId: 'logistics-belts' } },
      { panel: 'shop', options: undefined },
    ]);
  });

  it('remembers nothing: a listener subscribing after the request hears silence', () => {
    requestPanel('research', { techId: 'logistics-belts' });
    let heard = 0;
    const unsubscribe = onPanelRequest(() => {
      heard += 1;
    });
    unsubscribe();
    expect(heard).toBe(0);
  });
});
