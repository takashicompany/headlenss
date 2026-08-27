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
    if (raw >= 0 && raw <= 8) return raw as OsEventTypeList
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
      handlers.onClick()
      break
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      handlers.onDoubleClick()
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
