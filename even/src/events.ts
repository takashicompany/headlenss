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
   * 長押し (LONG_PRESS_EVENT)。押し始めが確定した時点で 1 回だけ呼ぶ。
   * 押しっぱなしの間や離した時には呼ばない (1 ジェスチャー = 1 回)。
   */
  onLongPress?: () => void
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

// 長押しの状態。ホストは長押しの後に通常の click / double click を続けて上げてくる
// ことがあり、そのまま通すと「★ を付けた直後にセッションが開く」ような二重発火になる。
// 押している間と、離してから LONG_PRESS_SUPPRESS_MS の間はタップ系を捨てる。
const LONG_PRESS_SUPPRESS_MS = 600
let longPressHeld = false
let longPressFiredAt = 0
// LONG_PRESS_EVENT を見たか。押し始めが来ないホストでも取りこぼさないための保険で、
// 「押し始めを見ていない release」だけを長押しとして扱う (二重発火はしない)。
let sawLongPressStart = false

// 離した通知 (LONG_PRESS_RELEASE_EVENT) を取りこぼしたまま押し状態が残ると、以降の
// タップが永久に無視される。押しっぱなしとみなす上限を置いて必ず自力で抜ける。
const LONG_PRESS_HOLD_MAX_MS = 10_000

/** 直前の長押しに巻き込まれたタップかどうか。 */
function suppressedByLongPress(): boolean {
  const since = Date.now() - longPressFiredAt
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
    case OsEventTypeList.LONG_PRESS_EVENT:
      longPressHeld = true
      sawLongPressStart = true
      longPressFiredAt = Date.now()
      handlers.onLongPress?.()
      break
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      longPressHeld = false
      longPressFiredAt = Date.now()
      // 押し始めが届いていた場合はそこで発火済み。ここで再度呼ぶと 1 回の長押しで
      // 2 回トグルしてしまうので、押し始めを取りこぼした時だけ拾う。
      if (!sawLongPressStart) handlers.onLongPress?.()
      sawLongPressStart = false
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
