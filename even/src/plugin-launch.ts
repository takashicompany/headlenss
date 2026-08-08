// セッション配下の G2 プラグイン (dev server) へ WebView ごと遷移し、戻ってくるための処理。
//
// even-loader (Plugin Loader) と同じ規約に乗る:
//   遷移 URL に `?even_loader=1` を付けると、遷移先に注入されている
//   even-loader-shim.js が「ダブルタップ = 終了ダイアログ」を `history.back()`
//   に差し替える。戻り先がこの headlenss になる。
//   シムを持たないプラグインへは遷移できるが、戻るには Even アプリで開き直す。
//
// 戻ってきた側 (headlenss) でやることが 3 つある。いずれも even-loader が実機で
// 踏んだ問題への対処:
//   1. 履歴復帰 (bfcache) ではブリッジ経路が死んでいることがある → 検知してリロード
//   2. 復帰時はホスト側セッションにプラグインのコンテナが残っており、
//      createStartUpPageContainer (セッションにつき 1 回きり) が使えない
//      → 初回描画を rebuildPageContainer にする
//   3. 復帰直後の 1 フレーム目がホスト側で取りこぼされることがある → 少し後に再送

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

/** even-loader と共通のクエリパラメータ名。シムはこれを見て有効化する。 */
const LOADER_PARAM = 'even_loader'
/** 復帰フラグの保存キー。 */
const RETURN_FLAG_KEY = 'headlenss_return_from_plugin_v1'

/** 遷移 URL に `?even_loader=1` を付ける。 */
export function withLoaderParam(url: string): string {
  try {
    const u = new URL(url)
    u.searchParams.set(LOADER_PARAM, '1')
    return u.toString()
  } catch {
    return url
  }
}

/**
 * 遷移直前に呼ぶ: 復帰フラグを立てる。
 * sessionStorage と bridge の両方に書く (インストール済み .ehpk の
 * sessionStorage が履歴復帰をまたいで生きているか不明なため二重化する)。
 */
export async function markNavigateToPlugin(bridge: EvenAppBridge | null): Promise<void> {
  try { sessionStorage.setItem(RETURN_FLAG_KEY, 'nav') } catch { /* ignore */ }
  if (bridge) {
    try { await bridge.setLocalStorage(RETURN_FLAG_KEY, 'nav') } catch { /* ignore */ }
  }
}

/** pageshow (履歴復帰) → reload の直前に呼ぶ: 同期的に sessionStorage だけ立てる */
export function markReturnReload(): void {
  try { sessionStorage.setItem(RETURN_FLAG_KEY, 'pageshow') } catch { /* ignore */ }
}

export type ReturnFlagResult = {
  found: boolean
  /** 検出経路 (実機診断用) */
  via: string[]
}

/** boot で呼ぶ: 復帰フラグの検出結果を返し、両方のストアからクリアする */
export async function consumeReturnFlag(bridge: EvenAppBridge | null): Promise<ReturnFlagResult> {
  const via: string[] = []
  try {
    const s = sessionStorage.getItem(RETURN_FLAG_KEY)
    if (s === 'nav' || s === 'pageshow') via.push(`sessionStorage:${s}`)
    sessionStorage.removeItem(RETURN_FLAG_KEY)
  } catch { /* ignore */ }
  if (bridge) {
    try {
      const v = await bridge.getLocalStorage(RETURN_FLAG_KEY)
      if (v === 'nav' || v === 'pageshow') via.push(`bridge:${v}`)
      if (v) await bridge.setLocalStorage(RETURN_FLAG_KEY, '')
    } catch { /* ignore */ }
  }
  return { found: via.length > 0, via }
}
