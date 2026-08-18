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

  /** この設定を保存した時刻 (epoch ms)。bridge 側と localStorage 側のどちらが
   *  新しいかを判定するためだけに使う。旧データには無いので optional。 */
  savedAt?: number
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
// スクロールアニメの 1 行あたり待ち時間。0 = アニメ無し (一括ジャンプ)。
// 下限が 0 で既定が 10ms なのは even-jp / greensky と揃えるため: スクロール中の
// コマはレンズの完了を待たずに投げる (main.ts の sendScrollFrameLoose 参照) ので、
// tick をレンズ 1 回の送信時間より短くしても中間コマが消えることはない。
export const SCROLL_ANIM_TICK_MIN = 0
export const SCROLL_ANIM_TICK_MAX = 1000

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
      // 新旧比較の基準。壊れた値/旧データは「時刻不明」として undefined にする
      // (undefined は比較時に最古扱いになる = 時刻を持つ側が勝つ)。
      savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : undefined,
    }
  } catch {
    return null
  }
}

/**
 * 設定を読み出す。
 *
 * なぜ両方読むか: 以前は bridge 側を無条件に優先していたため、bridge への書き込みが
 * 失敗している / 古い値が残っている環境では、リロード (プラグイン往復の bfcache 復帰に
 * よる location.reload、通常の再起動) のたびにユーザーの変更が黙って旧値へ巻き戻った。
 * 保存時刻 (savedAt) を持たせ、新しい方を採用することでこの巻き戻りを断つ。
 *
 * 採用規則:
 *   - 片方にしか値が無ければそれ。
 *   - 両方に savedAt があれば新しい方。
 *   - 片方だけ savedAt を持つ (= 一方が旧データ) なら、持っている方が新しい。
 *   - どちらも savedAt を持たない (両方とも旧データ) なら従来どおり bridge 優先。
 * 下 3 つは「savedAt 無し = -Infinity」「同点は bridge 勝ち」で 1 つの比較に畳める。
 */
export async function loadSettings(bridge: EvenAppBridge | null): Promise<Settings> {
  let fromBridge: Settings | null = null
  if (bridge) {
    try {
      fromBridge = parse(await bridge.getLocalStorage(STORAGE_KEY))
    } catch {
      // bridge 側に値が無い / 読めないだけのこともある。localStorage 側に任せる
      fromBridge = null
    }
  }
  let fromLocal: Settings | null = null
  try {
    fromLocal = parse(localStorage.getItem(STORAGE_KEY))
  } catch {
    fromLocal = null
  }

  let source: 'bridge' | 'localStorage' | 'default'
  let picked: Settings
  if (fromBridge && fromLocal) {
    const bAt = fromBridge.savedAt ?? -Infinity
    const lAt = fromLocal.savedAt ?? -Infinity
    // 同点 (両方 savedAt 無しを含む) は bridge 優先 = 従来挙動
    if (lAt > bAt) { picked = fromLocal; source = 'localStorage' }
    else { picked = fromBridge; source = 'bridge' }
  } else if (fromBridge) {
    picked = fromBridge
    source = 'bridge'
  } else if (fromLocal) {
    picked = fromLocal
    source = 'localStorage'
  } else {
    picked = { ...DEFAULT_SETTINGS }
    source = 'default'
  }

  // 実機での切り分け用に 1 行だけ残す (どちら側の値が使われたかが分からないと
  // 巻き戻りの再発を追えないため)。devMode に依存させない。
  console.log(
    `[settings] loaded from=${source} savedAt=${picked.savedAt ?? 'none'}` +
    ` (bridge=${fromBridge ? fromBridge.savedAt ?? 'none' : 'absent'},` +
    ` local=${fromLocal ? fromLocal.savedAt ?? 'none' : 'absent'})`,
  )
  return picked
}

/**
 * 設定を保存する。s.savedAt を保存時刻で更新してから両方へ書く。
 * @returns bridge へ書けたか。bridge が無い場合は「書く先が無いだけ」なので true。
 *          失敗時は devMode に関係なくコンソールへ警告を出す (黙って落とすと、
 *          次回起動で古い bridge 値に巻き戻る原因が表に出ないため)。
 */
export async function saveSettings(bridge: EvenAppBridge | null, s: Settings): Promise<boolean> {
  // 呼び出し側が持っている生存オブジェクトにも刻んでおく (次回の保存/比較で整合させる)
  s.savedAt = Date.now()
  const json = JSON.stringify(s)
  try { localStorage.setItem(STORAGE_KEY, json) } catch { /* quota */ }
  if (!bridge) return true
  try {
    // SDK は例外ではなく false で失敗を返すことがあるので、戻り値も必ず見る
    const ok = await bridge.setLocalStorage(STORAGE_KEY, json)
    if (ok === false) {
      console.warn('[settings] bridge への保存が拒否されました (localStorage 側のみ保存)')
      return false
    }
    return true
  } catch (err) {
    console.warn(`[settings] bridge への保存に失敗しました (localStorage 側のみ保存): ${err}`)
    return false
  }
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
