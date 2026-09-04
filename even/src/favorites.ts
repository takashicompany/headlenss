import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

// お気に入りセッション (グラス内のみ) の永続化。
//
// なぜ localStorage 単独ではいけないか: Even Hub 本番では WebView が起動のたびに
// 作り直され、WebView の localStorage は毎回空から始まる。永続するのはブリッジ側の
// KVS (bridge.setLocalStorage) だけ。よってブリッジを主、localStorage を従とする
// 二重保存にする (ブラウザ単体で動かす検証用に localStorage 側も残す)。
//
// 新旧の決着は settings.ts と同じ savedAt 方式にする。ブリッジ書き込みが失敗した
// 環境で「片方だけ古い」状態になっても、リロードのたびに古い方へ巻き戻らないため。
// 和集合ではなく「新しい方をまるごと採用」なのは、★ を外した操作が次の起動で
// 復活してしまうのを防ぐため (削除も変更として伝わる必要がある)。

const STORAGE_KEY = 'headlenss_favorites_v1'

type Stored = {
  /** ★ を付けた tmux セッション名。付けた順を保つ (並べ替えの安定性のため)。 */
  names: string[]
  /** 保存時刻 (epoch ms)。bridge / localStorage のどちらが新しいかの判定にだけ使う。 */
  savedAt?: number
}

function parse(json: string | null | undefined): Stored | null {
  if (!json) return null
  try {
    const raw = JSON.parse(json) as Partial<Stored>
    if (typeof raw !== 'object' || raw === null) return null
    if (!Array.isArray(raw.names)) return null
    return {
      names: raw.names.filter((v): v is string => typeof v === 'string' && v.length > 0),
      savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : undefined,
    }
  } catch {
    return null
  }
}

/**
 * ★ 付きセッション名を読み出す。
 *
 * 採用規則 (settings.ts の loadSettings と同一):
 *   - 片方にしか値が無ければそれ。
 *   - 両方にあれば savedAt が新しい方。savedAt 無しは最古扱い。
 *   - 同点 (両方 savedAt 無しを含む) は bridge 優先。
 */
export async function loadFavorites(bridge: EvenAppBridge | null): Promise<Set<string>> {
  let fromBridge: Stored | null = null
  if (bridge) {
    try {
      fromBridge = parse(await bridge.getLocalStorage(STORAGE_KEY))
    } catch {
      // 値が無い / 読めないだけのこともある。localStorage 側に任せる
      fromBridge = null
    }
  }
  let fromLocal: Stored | null = null
  try {
    fromLocal = parse(localStorage.getItem(STORAGE_KEY))
  } catch {
    fromLocal = null
  }

  let source: 'bridge' | 'localStorage' | 'default'
  let picked: Stored
  if (fromBridge && fromLocal) {
    const bAt = fromBridge.savedAt ?? -Infinity
    const lAt = fromLocal.savedAt ?? -Infinity
    if (lAt > bAt) { picked = fromLocal; source = 'localStorage' }
    else { picked = fromBridge; source = 'bridge' }
  } else if (fromBridge) {
    picked = fromBridge
    source = 'bridge'
  } else if (fromLocal) {
    picked = fromLocal
    source = 'localStorage'
  } else {
    picked = { names: [] }
    source = 'default'
  }

  // 実機/シミュレータでの切り分け用に 1 行だけ残す (どちら側が採用されたかが
  // 分からないと「再起動で ★ が消えた」の原因を追えないため)。devMode に依存させない。
  console.log(
    `[favorites] loaded from=${source} count=${picked.names.length} savedAt=${picked.savedAt ?? 'none'}` +
    ` (bridge=${fromBridge ? fromBridge.names.length : 'absent'},` +
    ` local=${fromLocal ? fromLocal.names.length : 'absent'})`,
  )
  return new Set(picked.names)
}

/**
 * ★ 付きセッション名を保存する。保存時刻を打ってから localStorage と bridge の両方に書く。
 * @returns bridge へ書けたか。bridge が無い場合は「書く先が無いだけ」なので true。
 */
export async function saveFavorites(bridge: EvenAppBridge | null, names: Set<string>): Promise<boolean> {
  const payload: Stored = { names: [...names], savedAt: Date.now() }
  const json = JSON.stringify(payload)
  try { localStorage.setItem(STORAGE_KEY, json) } catch { /* quota */ }
  if (!bridge) return true
  try {
    // SDK は例外ではなく false で失敗を返すことがあるので、戻り値も必ず見る
    const ok = await bridge.setLocalStorage(STORAGE_KEY, json)
    if (ok === false) {
      console.warn('[favorites] bridge への保存が拒否されました (localStorage 側のみ保存)')
      return false
    }
    console.log(`[favorites] saved count=${payload.names.length} savedAt=${payload.savedAt}`)
    return true
  } catch (err) {
    console.warn(`[favorites] bridge への保存に失敗しました (localStorage 側のみ保存): ${err}`)
    return false
  }
}
