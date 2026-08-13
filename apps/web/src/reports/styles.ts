// Typed class names for `reports.module.css`.
//
// The same problem `hud/styles.ts` solves, for the same reason: Next declares
// `*.module.css` as an index signature and this workspace runs `noUncheckedIndexedAccess`,
// so every `styles.card` is `string | undefined` — correct (the compiler cannot know the
// file has that class) and unhelpful (a `?? ''` at every site, which would silently paint an
// unstyled panel if a class were ever renamed).
//
// Naming the classes once, here, fixes both ends: accesses are plain `string`, and a typo or
// a renamed class becomes a compile error rather than an invisible missing style. Keep this
// union in step with the stylesheet — it is the only thing connecting them.

import raw from './reports.module.css';

export type ReportStyle =
  | 'layer'
  | 'card'
  | 'head'
  | 'label'
  | 'sub'
  | 'rule'
  | 'dock'
  | 'panel'
  | 'headline'
  | 'headlineValue'
  | 'headlineDown'
  | 'headlineUnit'
  | 'rows'
  | 'row'
  | 'rowKey'
  | 'rowValue'
  | 'rowMoney'
  | 'rowGood'
  | 'rowWater'
  | 'rowStub'
  | 'stubNote'
  | 'strip'
  | 'bar'
  | 'barBest'
  | 'barLoss'
  | 'stripEmpty'
  | 'board'
  | 'boardHead'
  | 'boardName'
  | 'boardValue'
  | 'boardBlurb'
  | 'boardFoot'
  | 'boardLocked'
  | 'boardGate'
  | 'boardFresh'
  | 'boardsFoot'
  | 'dawn'
  | 'dawnLeaving'
  | 'dawnCard'
  | 'dawnHead'
  | 'dawnTitle'
  | 'dawnDay'
  | 'dawnMoney'
  | 'dawnMoneyDown'
  | 'dawnLines'
  | 'dawnLine'
  | 'dawnDot'
  | 'dawnDotFlag'
  | 'dawnDotStub'
  | 'dawnStub'
  | 'dawnClose'
  | 'dawnTrack'
  | 'commerceRow'
  | 'commerceHead'
  | 'commerceName'
  | 'commerceMeta'
  | 'track'
  | 'fill'
  | 'fillAway'
  | 'fillReady'
  | 'actions'
  | 'button'
  | 'buttonPrimary'
  | 'select'
  | 'pending'
  | 'pendingTitle'
  | 'pendingList'
  | 'tabs'
  | 'tab'
  | 'tabActive'
  | 'tabKey';

export const r = raw as Readonly<Record<ReportStyle, string>>;

/** Join class names, dropping the falsy ones. Never returns a stray leading space. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    out = out === '' ? part : `${out} ${part}`;
  }
  return out;
}
