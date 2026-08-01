import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { Language } from './i18n'

// 設定の永続化。bridge.setLocalStorage と localStorage の両方に書き込み、
// G2アプリ環境とブラウザ単体テストの両方で同じ値が読めるようにする。

const STORAGE_KEY = 'headlenss_settings_v1'

export type OperatingPoint = 'standard' | 'enhanced'

export type Settings = {
  serverBaseUrl: string
  sessionName: string
  speechmaticsApiKey: string
  speechmaticsLang: string
  speechmaticsOperatingPoint: OperatingPoint
  language: Language
  /** G2 レンズの chat 表示行数。コンテナ高さの都合で実用域は 1〜12。 */
  chatDisplayLines: number
  /** chat 表示の最終行のさらに下に空行を 1 行足す。最終行が下端 border に
   *  かかって切れる時、この空行を犠牲にして実テキストを安全域に逃がす用途。 */
  chatBottomSpacer: boolean

  // 開発モード。オフ (既定) のときは画面ログ (#log) を出力しない。ログは無制限に肥大して
  // 使うほど重くなるため、通常利用ではオフにしておく。
  devMode: boolean
  /** スクロール 1 ジェスチャーで動かす行数。 */
  scrollLinesPerGesture: number
  /** スクロールイベントのクールダウン (ms)。直近に通したイベントからこの時間内の
   *  イベントは捨てる。1 スワイプで複数イベントが来る端末で多重スクロールを抑える。 */
  scrollCooldownMs: number
  /** スクロールアニメーションの 1 行あたりの間隔 (ms)。小さいほど速い。 */
  scrollAnimTickMs: number
}

/** 各数値設定の許容範囲。範囲外の入力はここに clamp する。 */
export const CHAT_DISPLAY_LINES_MIN = 1
// レンズ main コンテナの内側高さ (≒192px) ÷ 行高 27px = 7 行が物理的な上限。
// それ以上は必ず切れるので 7 で頭打ちにする。
export const CHAT_DISPLAY_LINES_MAX = 7
// scrollLinesPerGesture の最大値は固定値ではなく「レンズ表示行数」に追従する (動的)。
// なので MAX 定数は持たず、MIN だけ定数化する。
export const SCROLL_LINES_MIN = 1
export const SCROLL_COOLDOWN_MIN = 0
export const SCROLL_COOLDOWN_MAX = 2000
export const SCROLL_ANIM_TICK_MIN = 0
export const SCROLL_ANIM_TICK_MAX = 200

export const DEFAULT_SETTINGS: Settings = {
  serverBaseUrl: '',
  sessionName: 'master',
  speechmaticsApiKey: '',
  speechmaticsLang: 'ja',
  speechmaticsOperatingPoint: 'enhanced',
  language: 'ja',
  chatDisplayLines: 7,
  chatBottomSpacer: false,
  devMode: false,
  scrollLinesPerGesture: 7,
  scrollCooldownMs: 200,
  scrollAnimTickMs: 10,
}

/** 数値を [min,max] の整数に丸める。NaN や範囲外は fallback / 端に寄せる。 */
export function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.round(v)))
}

/** 数値を chatDisplayLines の許容範囲に丸める。 */
export function clampChatDisplayLines(n: unknown): number {
  return clampInt(n, CHAT_DISPLAY_LINES_MIN, CHAT_DISPLAY_LINES_MAX, DEFAULT_SETTINGS.chatDisplayLines)
}

function parse(json: string | null | undefined): Settings | null {
  if (!json) return null
  try {
    const raw = JSON.parse(json) as Partial<Settings>
    if (typeof raw !== 'object' || raw === null) return null
    // scrollLinesPerGesture の最大値はレンズ表示行数に従うので、先に確定させておく
    const chatDisplayLines =
      raw.chatDisplayLines === undefined
        ? DEFAULT_SETTINGS.chatDisplayLines
        : clampChatDisplayLines(raw.chatDisplayLines)
    return {
      serverBaseUrl: typeof raw.serverBaseUrl === 'string' ? raw.serverBaseUrl : DEFAULT_SETTINGS.serverBaseUrl,
      sessionName: typeof raw.sessionName === 'string' && raw.sessionName ? raw.sessionName : DEFAULT_SETTINGS.sessionName,
      speechmaticsApiKey: typeof raw.speechmaticsApiKey === 'string' ? raw.speechmaticsApiKey : '',
      speechmaticsLang: typeof raw.speechmaticsLang === 'string' && raw.speechmaticsLang ? raw.speechmaticsLang : DEFAULT_SETTINGS.speechmaticsLang,
      speechmaticsOperatingPoint:
        raw.speechmaticsOperatingPoint === 'standard' || raw.speechmaticsOperatingPoint === 'enhanced'
          ? raw.speechmaticsOperatingPoint
          : DEFAULT_SETTINGS.speechmaticsOperatingPoint,
      language: raw.language === 'en' || raw.language === 'ja' ? raw.language : DEFAULT_SETTINGS.language,
      chatDisplayLines,
      chatBottomSpacer:
        typeof raw.chatBottomSpacer === 'boolean'
          ? raw.chatBottomSpacer
          : DEFAULT_SETTINGS.chatBottomSpacer,
      devMode: typeof raw.devMode === 'boolean' ? raw.devMode : DEFAULT_SETTINGS.devMode,
      // 最大値はレンズ表示行数 (chatDisplayLines) に従う。動的なので定数化していない
      scrollLinesPerGesture: clampInt(
        raw.scrollLinesPerGesture,
        SCROLL_LINES_MIN,
        chatDisplayLines,
        Math.min(DEFAULT_SETTINGS.scrollLinesPerGesture, chatDisplayLines),
      ),
      scrollCooldownMs:
        raw.scrollCooldownMs === undefined
          ? DEFAULT_SETTINGS.scrollCooldownMs
          : clampInt(raw.scrollCooldownMs, SCROLL_COOLDOWN_MIN, SCROLL_COOLDOWN_MAX, DEFAULT_SETTINGS.scrollCooldownMs),
      scrollAnimTickMs:
        raw.scrollAnimTickMs === undefined
          ? DEFAULT_SETTINGS.scrollAnimTickMs
          : clampInt(raw.scrollAnimTickMs, SCROLL_ANIM_TICK_MIN, SCROLL_ANIM_TICK_MAX, DEFAULT_SETTINGS.scrollAnimTickMs),
    }
  } catch {
    return null
  }
}

export async function loadSettings(bridge: EvenAppBridge | null): Promise<Settings> {
  if (bridge) {
    try {
      const v = await bridge.getLocalStorage(STORAGE_KEY)
      const parsed = parse(v)
      if (parsed) return parsed
    } catch {
      // bridge側に値が無いだけのこともある。下に落とす
    }
  }
  return parse(localStorage.getItem(STORAGE_KEY)) ?? { ...DEFAULT_SETTINGS }
}

export async function saveSettings(bridge: EvenAppBridge | null, s: Settings): Promise<void> {
  const json = JSON.stringify(s)
  try { localStorage.setItem(STORAGE_KEY, json) } catch { /* quota */ }
  if (bridge) {
    try { await bridge.setLocalStorage(STORAGE_KEY, json) } catch { /* ignore */ }
  }
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
