'use client';

// "too far — walk closer."
//
// The answer to "why did my click do nothing", which is the single most common way a
// player quietly decides a game is broken. It changes on pointer move, so it is the third
// customer of the bypass rule: the host writes the string into the live channel each
// frame and this component's node gets it by ref. React renders this element exactly once,
// ever, and never again.

import { s } from './styles';
import { hudStore } from './store';
import { useLiveText } from './use-live-text';

export function StatusRibbon() {
  // 120 ms rather than 250: this one answers a click, and a beat of lag on an answer reads
  // as the game not having heard you.
  const ref = useLiveText<HTMLDivElement>(() => hudStore.live.status, 120);
  return <div className={s.ribbon} ref={ref} />;
}
