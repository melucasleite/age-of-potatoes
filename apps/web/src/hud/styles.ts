// Typed class names for `hud.module.css`.
//
// Next declares `*.module.css` as an index signature, and this workspace runs
// `noUncheckedIndexedAccess`, so every `styles.money` is `string | undefined` — which is
// correct (the compiler cannot know the file has that class) and unhelpful (fifty `?? ''`s
// that would silently paint an unstyled panel if a class were ever renamed).
//
// Naming the classes once, here, fixes both ends: accesses are plain `string`, and a typo
// or a renamed class becomes a compile error instead of an invisible missing style. Keep
// this union in step with the stylesheet — it is the only thing that connects them.

import raw from './hud.module.css';

export type StyleName =
  | 'root'
  | 'corner'
  | 'topLeft'
  | 'topRight'
  | 'bottomRight'
  | 'bottomCentre'
  | 'card'
  | 'label'
  | 'rule'
  | 'ticker'
  | 'moneyRow'
  | 'money'
  | 'moneyTicking'
  | 'delta'
  | 'deltaShow'
  | 'deltaDown'
  | 'rateRow'
  | 'rate'
  | 'rateDown'
  | 'rateIdle'
  | 'clock'
  | 'unlockHead'
  | 'unlockName'
  | 'unlockPrice'
  | 'unlockBlurb'
  | 'track'
  | 'fill'
  | 'fillReady'
  | 'etaRow'
  | 'eta'
  | 'etaReady'
  | 'etaUnknown'
  | 'owned'
  | 'pouch'
  | 'pouchEmpty'
  | 'stack'
  | 'stackCount'
  | 'stackLabel'
  | 'stackValue'
  | 'pouchDivider'
  | 'belt'
  | 'slot'
  | 'slotActive'
  | 'slotBroke'
  | 'slotKey'
  | 'slotName'
  | 'slotCost'
  | 'ribbon'
  | 'clipboard'
  | 'clip'
  | 'clipboardLabel'
  | 'notes'
  | 'note'
  | 'dot'
  | 'dotNudge'
  | 'dotWarn'
  | 'perf'
  | 'perfRow'
  | 'perfKey'
  | 'perfValue'
  | 'perfOver'
  | 'perfHint';

export const s = raw as Readonly<Record<StyleName, string>>;

/** Join class names, dropping the falsy ones. Never returns a stray leading space. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    out = out === '' ? part : `${out} ${part}`;
  }
  return out;
}
