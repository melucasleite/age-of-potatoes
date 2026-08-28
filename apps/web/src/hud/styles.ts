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
  | 'sidebar'
  // The fold ([[096]]): the sidebar is a row of two now — the scrolling body, and a handle
  // rail that outlives it when the body is collapsed away.
  | 'sidebarBody'
  | 'sidebarHandle'
  | 'sidebarChevron'
  | 'sidebarHandleWord'
  | 'sideSection'
  | 'sideContext'
  | 'sidePapers'
  | 'stage'
  | 'corner'
  | 'floatWin'
  // Where the at-the-machine cards go when the dock is folded away under them ([[106]]) — a
  // fourth use of `.corner`, not a second floating chrome.
  | 'machineFloat'
  | 'topRight'
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
  | 'exitButton'
  | 'pouch'
  | 'pouchEmpty'
  | 'pouchIcon'
  | 'stack'
  | 'stackCount'
  | 'stackLabel'
  | 'stackValue'
  | 'stackWarnMark'
  | 'pouchDivider'
  | 'canChip'
  | 'canChipEmpty'
  | 'belt'
  | 'slot'
  | 'slotActive'
  | 'slotBroke'
  | 'slotEmpty'
  | 'slotIcon'
  | 'slotFlash'
  | 'slotKey'
  | 'slotVacant'
  | 'slotCost'
  | 'dragGhost'
  | 'ribbon'
  // The Clipboard's paper classes are gone with it ([[076]]); the note list survives for
  // the Welcome Back card, which draws the same observations with the same dots.
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
  | 'perfHint'
  // --- the debug panel ([[075]]) ---
  | 'debugPanel'
  | 'cheatRow'
  | 'cheatPrompt'
  | 'cheatInput'
  | 'cheatLine'
  | 'cheatGranted'
  | 'cheatRejected'
  // --- the panel family: one row and one window, four times over ([[093]]) ---
  // The sidebar row and the floating-window chrome that RESEARCH, THE STAND, THE BAG and
  // BUILD all render through `PanelFrame.tsx`. They used to be named `techToggle*` and
  // `tech*` because research got there first and the other three borrowed rather than
  // cloned — right instinct, misleading name. `.shopPanel` and `.techEra` are gone with the
  // rename: the first was `.winPanel` declaration for declaration, the second was `.winTag`
  // without its `flex`.
  | 'panelRow'
  | 'panelRowName'
  | 'panelRowKey'
  | 'panelRowBadge'
  | 'panelRowLit'
  | 'winPanel'
  | 'winHead'
  | 'winTitle'
  | 'winTag'
  | 'winCount'
  | 'winMoney'
  | 'winClose'
  | 'winScroll'
  | 'winHint'
  // --- research: the tree itself ---
  | 'eraBand'
  | 'eraBandCurrent'
  | 'eraHead'
  | 'eraNumeral'
  | 'eraName'
  | 'eraBlurb'
  | 'branchRow'
  | 'branchCol'
  | 'branchName'
  | 'branchEmpty'
  | 'node'
  | 'nodeTop'
  | 'nodeTitle'
  | 'nodePrice'
  | 'nodeVerb'
  | 'nodeOwned'
  | 'nodeReady'
  | 'nodeShort'
  | 'nodePending'
  | 'nodeBlocked'
  | 'nodeSelected'
  | 'charterBand'
  | 'charterSeal'
  | 'charterBody'
  | 'charterName'
  | 'charterVerb'
  | 'charterGates'
  | 'charterGate'
  | 'charterGateLabel'
  | 'charterGateValue'
  | 'charterGateMet'
  | 'charterGateShort'
  | 'charterTrack'
  | 'charterFill'
  | 'charterFillMet'
  | 'charterOwned'
  | 'charterSelected'
  | 'techDetail'
  | 'detailBody'
  | 'detailTitle'
  | 'detailVerb'
  | 'detailText'
  | 'detailNeeds'
  | 'detailEta'
  | 'detailBuy'
  | 'buyButton'
  | 'buyReady'
  | 'buyNote'
  // --- the roadside stand ---
  // Its row, its shell, its head and its footer are all in the panel family above now
  // ([[093]]) — what is left below is only the board itself.
  | 'shopStatus'
  | 'shopStatusOpen'
  | 'shopStatusShut'
  | 'shopList'
  | 'shopRow'
  | 'shopRowLocked'
  | 'shopRowBody'
  | 'shopRowHead'
  | 'shopName'
  | 'shopPrice'
  | 'shopOwned'
  | 'shopNote'
  | 'shopLocked'
  | 'shopShort'
  | 'shopBuys'
  | 'shopBuy'
  | 'shopBuyReady'
  | 'shopBuyCount'
  | 'shopBuyCost'
  // --- the build menu ---
  // Shell, head, scroll and footer are the tech tree's classes, reused — only the grid,
  // its cells and the focused-entry detail line are new ([[071]]).
  | 'buildGroup'
  | 'buildGrid'
  | 'buildCell'
  | 'buildCellOn'
  | 'buildCellArmed'
  | 'buildCellLocked'
  | 'buildCellIcon'
  | 'buildCellStrike'
  | 'buildCellPrice'
  | 'buildCellPriceBroke'
  | 'buildCellPriceLocked'
  | 'buildDetail'
  | 'buildDetailHead'
  | 'buildDetailName'
  | 'buildDetailPrice'
  | 'buildDetailBroke'
  | 'buildDetailLocked'
  | 'buildDetailHint'
  // --- item sprites ---
  // One class for every sprite in the HUD, wherever it is drawn. The size and the atlas offset
  // are inline styles on the element, because both are arithmetic (`item-art.ts`) rather than
  // design — what belongs in the stylesheet is only how a pixel sprite is rendered at all.
  | 'icon'
  | 'iconBlank'
  // --- the bag ---
  // A centred floating window now ([[089]], retiring [[069]]'s dock section); its shell,
  // head and footer are the tech tree's classes and its status line and buttons are the
  // stand's, class for class — same chrome everywhere, because two lists laid out
  // differently read as two games. Only what a boxed machine adds is new below.
  | 'invEmpty'
  | 'invBody'
  | 'invGrid'
  | 'invSlot'
  | 'invSlotOn'
  | 'invSlotBoxed'
  | 'invSlotCount'
  | 'invSlotCrate'
  | 'invSlotPips'
  | 'invSlotPip'
  | 'invSlotPipOn'
  | 'invDetail'
  | 'invDetailHead'
  | 'invDetailNames'
  | 'invDetailName'
  | 'invDetailCount'
  | 'invValue'
  | 'invUnit'
  | 'invNotForSale'
  | 'invBoxes'
  | 'invBox'
  | 'invNextOut'
  | 'invDial'
  | 'invDialKey'
  | 'invCondition'
  | 'invConditionLow'
  | 'invInvested'
  | 'invScrap'
  // --- the upgrade bench ---
  | 'bench'
  | 'benchHead'
  | 'benchName'
  | 'benchCondition'
  | 'benchConditionLow'
  | 'benchTrack'
  | 'benchFill'
  | 'benchFillLow'
  | 'dial'
  | 'dialHead'
  | 'dialName'
  | 'pips'
  | 'pip'
  | 'pipOn'
  | 'dialTrade'
  | 'dialDelta'
  | 'dialNow'
  | 'dialArrow'
  | 'dialNext'
  | 'dialBuy'
  | 'dialBuyReady'
  | 'dialBuyBroke'
  | 'dialCost'
  | 'dialCompete'
  | 'dialMaxed'
  | 'benchLocked'
  | 'benchDivider'
  // --- the Agri-Bot dock card ---
  // Head, divider and the locked note are the bench's, class for class — same corner, same
  // control, different question. Only the zone list is new.
  | 'dockOrders'
  | 'dockOrdersNone'
  | 'dockZones'
  | 'dockZone'
  | 'dockZoneOn'
  | 'dockZoneHead'
  | 'dockZoneSwatch'
  | 'dockZoneName'
  | 'dockZoneCrop'
  | 'dockZoneCounts'
  | 'dockZoneNote'
  | 'dockStop'
  // --- the grabber card ([[099]]) ---
  // Head, divider and the locked note are the bench's again, class for class. What is new is
  // the close button (it is the one card a click opens, so it needs a click to shut) and the
  // filter grid, which is the bag's cell idea at card width.
  | 'armClose'
  | 'armOrders'
  | 'armOrdersAny'
  | 'armFacing'
  | 'armGridNote'
  | 'armGrid'
  | 'armCell'
  | 'armCellOn'
  | 'armCellAny'
  | 'armCellAnyMark'
  | 'armCellName'
  // --- the zones panel ([[102]]) ---
  // Its shell, head, scroll and footer are the panel family's (`PanelWindow`), its zone list
  // borrows the dock card's swatch/name/crop/counts spans class for class — same subject, same
  // reading — and the crop picker is the grabber card's `.armGrid` unchanged. What is new is
  // only the rename field, the hopper toggle and the priority pips.
  | 'zoneList'
  | 'zoneItem'
  | 'zoneItemOn'
  | 'zoneItemHead'
  | 'zoneItemArmed'
  | 'zoneDetail'
  | 'zoneSection'
  | 'zoneSectionHead'
  | 'zoneNote'
  | 'zoneNoteWarn'
  | 'zoneNameRow'
  | 'zoneNameInput'
  | 'zoneTiles'
  | 'zoneToggle'
  | 'zoneToggleOn'
  | 'zoneToggleLamp'
  | 'zoneToggleLampOn'
  | 'zoneToggleWord'
  | 'zonePips'
  | 'zonePip'
  | 'zonePipOn'
  | 'zonePriorityValue'
  | 'zoneCellSeeds'
  // --- the field card ---
  | 'fieldCard'
  | 'fieldRow'
  // A row is a button since [[102]] — it opens the zones panel on the zone it describes.
  | 'fieldRowOpen'
  | 'fieldName'
  | 'fieldArmed'
  | 'fieldFallow'
  | 'fieldReadout'
  | 'fieldSep'
  // --- the Welcome Back card ---
  | 'topCentre'
  | 'welcome'
  | 'welcomeHead'
  | 'welcomeClose'
  | 'welcomeAway'
  | 'welcomeSafe'
  | 'welcomeStats'
  | 'welcomeStat'
  | 'welcomeStatLabel'
  | 'welcomeStatValue'
  | 'welcomeStatWarn'
  | 'welcomeNote'
  // --- the pause menu ([[126]]) ---
  // The sixth panel, and the only MODAL one: it brings a scrim, which the stylesheet's own
  // `.winPanel` header goes out of its way to say the other five never do. Everything else
  // in it is the house frame (`PanelWindow`) plus a stack of verbs and a farmer picker.
  | 'pauseScrim'
  | 'pauseWin'
  | 'pauseBody'
  | 'pauseActions'
  | 'pauseButton'
  | 'pauseButtonPrimary'
  | 'pauseButtonNote'
  | 'pauseSection'
  | 'pauseSectionHead'
  | 'pauseAvatars'
  | 'pauseAvatar'
  | 'pauseAvatarOn'
  | 'pauseAvatarArt'
  | 'pauseAvatarBlank'
  // --- the account panel ---
  // The sixth floating window (`AccountPanel.tsx`): sign-in, sign-out, and the leaderboard
  // name. `sideTopRow` is the chrome shelf it shares with "exit game" in the dock.
  | 'sideTopRow'
  | 'accountBody'
  | 'accountSection'
  | 'accountSectionHead'
  | 'accountStatusLine'
  | 'accountNote'
  | 'accountNoteWarn'
  | 'accountRow'
  | 'accountInput'
  | 'accountButton'
  | 'accountSwitch'
  | 'accountNotice'
  | 'accountNoticeGood'
  | 'accountNoticeWarn';

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
