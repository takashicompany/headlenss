import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

// スクロールイベントのクールダウン (ms)。直近に通したイベントからこの時間内に
// 来たイベントは捨てる。設定で変更できるよう let + setter にしている。
let scrollCooldownMs = 200

/** スクロールのクールダウン時間 (ms) を設定する。設定 UI から呼ばれる。 */
export function setScrollCooldownMs(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) scrollCooldownMs = ms
}

type Handlers = {
  onScrollUp: () => void
  onScrollDown: () => void
  onClick: () => void
  onDoubleClick: () => void
  /**
   * OS の長押しメニューでアプリ独自の項目が選ばれた (menuItemClickEvent)。
   * itemID は createStartUpPageContainer / rebuildPageContainer で登録したもの。
   */
  onMenuItem?: (itemID: number) => void
  onAudio: (pcm: Uint8Array) => void
  onForegroundEnter?: () => void
  onForegroundExit?: () => void
  /**
   * 異常終了 / OS 側からの終了通知。foreground exit と同じ後始末が要る
   * (マイクや WebSocket を握ったまま消えるのを防ぐ)。
   * 未指定なら onForegroundExit へ落とす。
   */
  onAppExit?: (kind: string) => void
  onLog?: (msg: string) => void
}

let handlers: Handlers = {
  onScrollUp: () => {},
  onScrollDown: () => {},
  onClick: () => {},
  onDoubleClick: () => {},
  onAudio: () => {},
}

export function setEventHandlers(h: Handlers): void {
  handlers = h
}

let lastScrollTime = 0

// 長押しは OS のもの。実機では長押しで OS の長押しメニューが開くので、アプリ側は
// 長押しそのものに独自の動作を割り当てない (メニューと二重に作用するため)。
// ここで押し始め/離しを見ているのは、その一連のジェスチャーに巻き込まれて上がってくる
// タップを捨てるためだけ。メニューを閉じただけの操作でセッションが開いたりしないようにする。
const LONG_PRESS_SUPPRESS_MS = 600
let longPressHeld = false
let lastPressGestureAt = 0

// 離した通知 (LONG_PRESS_RELEASE_EVENT) を取りこぼしたまま押し状態が残ると、以降の
// タップが永久に無視される。押しっぱなしとみなす上限を置いて必ず自力で抜ける。
const LONG_PRESS_HOLD_MAX_MS = 10_000

/** 直前の長押し / メニュー操作に巻き込まれたタップかどうか。 */
function suppressedByLongPress(): boolean {
  const since = Date.now() - lastPressGestureAt
  if (longPressHeld && since > LONG_PRESS_HOLD_MAX_MS) longPressHeld = false
  return longPressHeld || since < LONG_PRESS_SUPPRESS_MS
}

function scrollThrottled(): boolean {
  const now = Date.now()
  if (now - lastScrollTime < scrollCooldownMs) return true
  lastScrollTime = now
  return false
}

/**
 * EvenHubEvent の eventType を OsEventTypeList に正規化。
 * SDK が用意している `OsEventTypeList.fromJson` を最優先で使う (0..8 を網羅)。
 */
function resolveEventType(event: EvenHubEvent): OsEventTypeList | undefined {
  const raw =
    event.listEvent?.eventType ??
    event.textEvent?.eventType ??
    event.sysEvent?.eventType ??
    ((event.jsonData ?? {}) as Record<string, unknown>).eventType ??
    ((event.jsonData ?? {}) as Record<string, unknown>).event_type ??
    ((event.jsonData ?? {}) as Record<string, unknown>).Event_Type ??
    ((event.jsonData ?? {}) as Record<string, unknown>).type

  const fromSdk = OsEventTypeList.fromJson?.(raw)
  if (fromSdk !== undefined) return fromSdk

  // フォールバック (SDK 古い場合)
  if (typeof raw === 'number') {
    if (raw >= 0 && raw <= 10) return raw as OsEventTypeList
  }
  if (event.listEvent || event.textEvent || event.sysEvent) return OsEventTypeList.CLICK_EVENT
  return undefined
}

export function onEvenHubEvent(event: EvenHubEvent): void {
  if (event.audioEvent?.audioPcm) {
    handlers.onAudio(new Uint8Array(event.audioEvent.audioPcm))
    return
  }

  // OS 長押しメニューの項目が選ばれた。eventType を持たない独立のトップレベル
  // イベントなので、eventType の振り分けより先に拾う。
  if (event.menuItemClickEvent) {
    const itemID = event.menuItemClickEvent.itemID
    // メニューを閉じた直後に上がってくるタップを捨てる (項目を選んだ勢いで
    // セッションが開く等の二重作用を防ぐ)。長押しと同じ抑制窓を使う。
    longPressHeld = false
    lastPressGestureAt = Date.now()
    if (typeof itemID === 'number') handlers.onMenuItem?.(itemID)
    else handlers.onLog?.(`MENU: itemID なし | ${JSON.stringify(event)}`)
    return
  }

  const eventType = resolveEventType(event)
  switch (eventType) {
    case OsEventTypeList.SCROLL_TOP_EVENT:
      if (!scrollThrottled()) handlers.onScrollUp()
      break
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      if (!scrollThrottled()) handlers.onScrollDown()
      break
    case OsEventTypeList.CLICK_EVENT:
      if (suppressedByLongPress()) break
      handlers.onClick()
      break
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      if (suppressedByLongPress()) break
      handlers.onDoubleClick()
      break
    // 長押し / その解除は OS の長押しメニューを開く操作。アプリからは何もしない
    // (アプリ独自の動作はメニュー項目 = menuItemClickEvent 側に置く)。
    case OsEventTypeList.LONG_PRESS_EVENT:
      longPressHeld = true
      lastPressGestureAt = Date.now()
      break
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      longPressHeld = false
      lastPressGestureAt = Date.now()
      break
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      handlers.onForegroundEnter?.()
      break
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      handlers.onForegroundExit?.()
      break
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
    case OsEventTypeList.SYSTEM_EXIT_EVENT: {
      // 黙殺していたが、この経路で終わるとマイクも WebSocket も握ったまま残る。
      // foreground exit と同じ後始末を必ず通す。
      const kind = eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT ? 'abnormal exit' : 'system exit'
      if (handlers.onAppExit) handlers.onAppExit(kind)
      else handlers.onForegroundExit?.()
      break
    }
    case OsEventTypeList.IMU_DATA_REPORT:
      // 黙殺
      break
    default:
      handlers.onLog?.(`UNHANDLED: ${String(eventType)} | ${JSON.stringify(event)}`)
      break
  }
}
