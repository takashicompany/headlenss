import { List_ItemEvent, OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

/**
 * E2E 検証専用のイベント注入口。**出荷ビルドには一切入らない。**
 *
 * なぜ要るか: 公式シミュレータの automation API (`POST /api/input`) が送れるのは
 * up / down / click / double_click の 4 つだけで、長押し (LONG_PRESS_EVENT) を
 * 発火できない。長押しの検証を諦めるとお気に入り機能の入口がまるごと未検証になるので、
 * 検証スクリプトが立てたスタブサーバから「注入したいイベント」を受け取り、
 * 実機と同じ経路 (events.ts の onEvenHubEvent) に流し込む。
 *
 * 出荷物に混ざらない根拠:
 *   - 呼び出し側 (main.ts) が `import.meta.env.DEV` で括っている。本番ビルドでは
 *     この定数が false に置換され、動的 import ごと dead code elimination で消える。
 *   - さらに URL に `?e2e=1` が無いと起動しないので、普段の `npm run dev` でも動かない。
 */

/** ポーリング間隔。検証スクリプトの待ち時間に直結するので短めにする。 */
const POLL_MS = 150

/** スタブサーバが返すアクション名。 */
type E2EAction = 'long_press' | 'long_press_release' | 'reload' | 'wipe_local_reload'

/** ★ の保存キー。wipe_local_reload で「本番の WebView localStorage が消えた状態」を作る。 */
const FAVORITES_KEY = 'headlenss_favorites_v1'

function eventFor(action: E2EAction): EvenHubEvent | null {
  // 長押しは独立したトップレベル event ではなく list/text/sys event の eventType として
  // 届く (SDK README 参照)。rootlist は list コンテナなので listEvent に載せる。
  switch (action) {
    case 'long_press':
      return { listEvent: new List_ItemEvent({ eventType: OsEventTypeList.LONG_PRESS_EVENT }) }
    case 'long_press_release':
      return { listEvent: new List_ItemEvent({ eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT }) }
    default:
      return null
  }
}

/**
 * スタブサーバの `/e2e/input` を短間隔で取りに行き、返ってきたアクションを順に実行する。
 * @param base 検証スクリプトのスタブサーバ (= settings.serverBaseUrl)
 * @param inject 実アプリのイベント振り分け (events.ts の onEvenHubEvent)
 */
export function startE2EInputBridge(base: string, inject: (event: EvenHubEvent) => void): void {
  if (!base) return
  console.log(`[e2e] input bridge on ${base}/e2e/input`)
  setInterval(() => {
    void (async () => {
      let actions: E2EAction[]
      try {
        const res = await fetch(`${base}/e2e/input`, { cache: 'no-store' })
        if (!res.ok) return
        const body = (await res.json()) as { actions?: E2EAction[] }
        actions = Array.isArray(body.actions) ? body.actions : []
      } catch {
        return
      }
      for (const action of actions) {
        console.log(`[e2e] inject ${action}`)
        if (action === 'reload' || action === 'wipe_local_reload') {
          if (action === 'wipe_local_reload') {
            // 本番の再起動を忠実に再現する: Even Hub では WebView が作り直され
            // localStorage は空から始まる。残るのはブリッジ側 KVS だけ。
            // ここを消してから reload して ★ が戻るなら、ブリッジ保存が効いている証拠。
            try { localStorage.removeItem(FAVORITES_KEY) } catch { /* ignore */ }
          }
          location.reload()
          return
        }
        const event = eventFor(action)
        if (event) inject(event)
      }
    })()
  }, POLL_MS)
}
