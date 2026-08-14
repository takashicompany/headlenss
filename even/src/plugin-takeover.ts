// プラグインを「開いて戻る」を、サーバ側の中継も相手の改変も無しで成立させる経路。
// Plugin Loader (even-loader) の takeover 実装を移植したもの。
//
// location.assign で遷移する代わりに、対象 dev server の HTML を fetch で取得し、
// document.open()/write() で自分のドキュメントを対象 HTML に置き換える (クライアント取り込み)。
//   - <base href="対象URL"> を <head> 直後に注入し、相対/ルート相対パスの解決を
//     対象オリジンへ向ける (module script は CORS 付きで対象から読まれる)。
//   - Window は同一のまま維持されるので、書き換え後にシム相当のロジックを
//     headlenss自身が仕込める (対象サーバーへの注入は一切不要)。
//   - URL はheadlenssのまま変わらないため、「戻る」は location.reload() で
//     headlenssの entrypoint に戻る (history 不要)。
//
// 成立根拠 (一次情報で確認済み):
//   - Vite dev server の CORS 既定値 (CVE-2025-24010 対応後):
//     { origin: /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/ }
//     (vite.dev/config/server-options および vite 8.0.0/8.2.0 dist 実物で確認)。
//     判定は Origin リクエストヘッダに対する正規表現 (ポート任意)。
//     実機のインストール版headlenssのオリジンは http://127.0.0.1:<ランダムポート>
//     (実測) なので既定 CORS で許可される。
//   - allowedHosts: Host ヘッダが IP リテラルなら常に許可 (vite dist の
//     host-validation-middleware 実装 + 公式ドキュメントで確認)。
//   - Vite HMR の WebSocket はトークン検証のみ (Origin 値の検証は無し)。トークンは
//     対象から読んだ /@vite/client に埋まっており、client は接続先ホストを
//     location ではなく import.meta.url から導出するため、取り込み後も対象へ繋がる。
//
// 注意 (README にも記載):
//   - document.open() は window のイベントリスナーを全て除去する。そのため
//     シムの仕込み (リスナー/ポーリング) は write/close の後に行う
//     (実行中のこのスクリプトは同一 realm で継続する)。
//   - 取り込み後の localStorage/sessionStorage はheadlenssのオリジンのものになる。
//   - プロキシ (proxy/server.ts) が注入したページを取り込むとシムが二重になるため、
//     注入マーカーを検出したら従来のトップレベル遷移に譲る。

import { markReturnReload } from './plugin-launch'

// 変換 rebuild 送信後、アプリ自身の後続描画が無い場合の再送までの猶予 (シムと同値)
const RESEND_MS = 600
// fetch のタイムアウト (応答しないサーバーで Connecting が固まりすぎないように)
const FETCH_TIMEOUT_MS = 4000
// SDK ブリッジ出現のポーリング間隔と打ち切り
const POLL_INTERVAL_MS = 50
const POLL_LIMIT_MS = 30000

export interface TakeoverState {
  active: boolean
  wrapped: boolean
  createConverted: number
  intercepted: number
  resent: number
  returning: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any

/** proxy/server.ts が注入したページか (取り込むとシム二重になるので従来遷移に譲る) */
export function isProxyInjected(html: string): boolean {
  return html.includes('__EVEN_LOADER_FROM_PROXY=1') || html.includes('/__even-loader/shim.js')
}

/**
 * 対象の HTML を CORS fetch で取得する。失敗 (CORS/タイムアウト/非HTML/非2xx) は null。
 * 呼び出し側の AbortController でも中断できる (Connecting 中のダブルタップ中止用)。
 */
export async function fetchTargetHtml(url: string, signal: AbortSignal): Promise<string | null> {
  const timeoutCtl = new AbortController()
  const timer = window.setTimeout(() => timeoutCtl.abort(), FETCH_TIMEOUT_MS)
  const onOuterAbort = (): void => timeoutCtl.abort()
  signal.addEventListener('abort', onOuterAbort)
  try {
    const res = await fetch(url, { mode: 'cors', cache: 'no-store', signal: timeoutCtl.signal })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.toLowerCase().includes('text/html')) return null
    return await res.text()
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
    signal.removeEventListener('abort', onOuterAbort)
  }
}

/** <head> 直後に <base href="対象URL"> を注入 (無ければ <html> 直後、それも無ければ先頭) */
function injectBaseTag(html: string, targetUrl: string): string {
  const baseTag = `<base href="${targetUrl.replace(/"/g, '%22')}">`
  const head = /<head[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + baseTag + html.slice(at)
  }
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return html.slice(0, at) + baseTag + html.slice(at)
  }
  return baseTag + html
}

// document.open() を呼んだ後は、成功・失敗にかかわらずheadlenssの DOM は失われている。
// 取り込みが途中で失敗した時に、呼び出し側が「headlenssの画面へ戻す復旧をしてよいか」を
// 判断するためのフラグ (置き換え後は復旧描画もポーリング再開も成立しない)。
let documentReplaced = false

/** document.open() まで進んだか (= headlenss の DOM がもう無いか)。 */
export function isDocumentReplaced(): boolean {
  return documentReplaced
}

/**
 * ドキュメントを対象 HTML に置き換え、シム相当を仕込む。
 * 呼び出し後、このページはheadlenssではなく対象プラグインとして動く。
 */
export function performTakeover(html: string, targetUrl: string, log: (msg: string) => void): void {
  // ここまで (文字列組み立て) は DOM に触らないので、失敗しても headlenss は無傷。
  const withBase = injectBaseTag(html, targetUrl)
  // 置き換えの直前に立てる。document.open() 自体が途中で失敗した場合も
  // 「DOM は壊れたかもしれない」側に倒す (復旧描画で二重に壊さない)。
  documentReplaced = true
  document.open()
  document.write(withBase)
  document.close()
  // document.open() は window のリスナーを全除去するため、仕込みはこの後に行う。
  // 対象の module script (SDK 初期化) は close 後に非同期で読まれるので間に合う。
  armTakeoverShim(log)
}

// ─── シム相当 (even-loader-shim.js のロジックの TS 移植) ────────────────
function armTakeoverShim(log: (msg: string) => void): void {
  const w = window as any
  const state: TakeoverState = {
    active: true,
    wrapped: false,
    createConverted: 0,
    intercepted: 0,
    resent: 0,
    returning: false,
  }
  w.__headlenssTakeover = state

  const returnToLoader = (): void => {
    // URL はheadlenssのまま変わっていないので、reload = headlenssの entrypoint。
    // 復帰後の初回描画を rebuild にするフラグは同一オリジン sessionStorage で確実に渡る。
    markReturnReload()
    location.reload()
  }

  const wrapBridge = (bridge: any): boolean => {
    if (!bridge || typeof bridge.shutDownPageContainer !== 'function') return false
    if ((bridge.shutDownPageContainer as any).__evenLoaderWrapped) return true

    // ── shutDownPageContainer: exitMode 0/1 を横取りして reload でheadlenssへ ──
    const origShutDown = bridge.shutDownPageContainer.bind(bridge) as AnyFn
    const wrappedShutDown: AnyFn = (exitMode?: number, ...rest: any[]) => {
      if (exitMode !== 0 && exitMode !== 1 && exitMode !== undefined) {
        return origShutDown(exitMode, ...rest)
      }
      if (state.returning) return origShutDown(exitMode, ...rest)
      state.returning = true
      state.intercepted++
      log(`takeover: shutDownPageContainer(${String(exitMode ?? 0)}) を横取り → reload でheadlenssへ復帰`)
      returnToLoader()
      return Promise.resolve(true)
    }
    ;(wrappedShutDown as any).__evenLoaderWrapped = true
    try {
      bridge.shutDownPageContainer = wrappedShutDown
    } catch (e) {
      log(`takeover: shutDownPageContainer の差し替えに失敗: ${e}`)
      return false
    }

    // ── createStartUpPageContainer: 初回のみ rebuildPageContainer に変換 ──
    // (このセッションではheadlenssが create 済み。create はセッション 1 回きり)
    if (
      typeof bridge.createStartUpPageContainer === 'function' &&
      typeof bridge.rebuildPageContainer === 'function' &&
      !(bridge.createStartUpPageContainer as any).__evenLoaderWrapped
    ) {
      const origCreate = bridge.createStartUpPageContainer.bind(bridge) as AnyFn
      const origRebuild = bridge.rebuildPageContainer.bind(bridge) as AnyFn
      let converted = false
      let appDrew = false
      // アプリ自身の後続描画を観測 (再送ガード)。変換/再送は origRebuild を直接呼ぶ。
      for (const name of ['rebuildPageContainer', 'textContainerUpgrade', 'updateImageRawData']) {
        const orig = bridge[name]
        if (typeof orig !== 'function' || (orig as any).__evenLoaderObserved) continue
        const observer: AnyFn = (...args: any[]) => {
          appDrew = true
          return orig.apply(bridge, args)
        }
        ;(observer as any).__evenLoaderObserved = true
        try { bridge[name] = observer } catch { /* 観測できなくても機能は損なわない */ }
      }
      const wrappedCreate: AnyFn = (container?: any, ...rest: any[]) => {
        if (converted) return origCreate(container, ...rest)
        converted = true
        const payload: Record<string, unknown> = {}
        for (const key of ['containerTotalNum', 'listObject', 'textObject', 'imageObject']) {
          if (container && container[key] !== undefined) payload[key] = container[key]
        }
        state.createConverted++
        log('takeover: createStartUpPageContainer を rebuildPageContainer に変換 (headlenssのコンテナを全置き換え)')
        // 実機の初回フレーム取りこぼし対策: 後続描画が無ければ一度だけ再送
        window.setTimeout(() => {
          if (appDrew) {
            log('takeover: 後続描画を観測したため変換 rebuild の再送はスキップ')
            return
          }
          state.resent++
          log(`takeover: 後続描画が ${RESEND_MS}ms 無いため変換 rebuild を再送`)
          try {
            origRebuild(payload).then(
              (ok: unknown) => log(`takeover: 再送 rebuild 結果=${String(ok)}`),
              (err: unknown) => log(`takeover: 再送 rebuild 失敗: ${err}`),
            )
          } catch (e) {
            log(`takeover: 再送 rebuild 例外: ${e}`)
          }
        }, RESEND_MS)
        return origRebuild(payload).then(
          (ok: unknown) => {
            log(`takeover: 変換 rebuild 結果=${String(ok)}`)
            return ok ? 0 : 1 // StartUpPageCreateResult 契約に写像
          },
          (err: unknown) => {
            log(`takeover: rebuildPageContainer 変換呼び出しが失敗: ${err}`)
            return 1
          },
        )
      }
      ;(wrappedCreate as any).__evenLoaderWrapped = true
      try {
        bridge.createStartUpPageContainer = wrappedCreate
      } catch (e) {
        log(`takeover: createStartUpPageContainer の差し替えに失敗: ${e}`)
      }
    }

    state.wrapped = true
    log('takeover: EvenAppBridge をラップしました (shutDown 横取り + create→rebuild 変換)')
    return true
  }

  // 対象の SDK は module script として close 後に読まれ、新しいブリッジ単例を作る
  // (既存単例を再利用する SDK 実装でも同じ対象をラップするだけなので問題ない)。
  // evenAppBridgeReady (document.open 後に登録するので消えない) + ポーリングの
  // 二段構えで、出現し次第・差し替わり次第ラップする。
  window.addEventListener('evenAppBridgeReady', () => { wrapBridge(w.EvenAppBridge) })
  const started = Date.now()
  const poll = window.setInterval(() => {
    const b = w.EvenAppBridge
    if (b && typeof b.shutDownPageContainer === 'function' && !(b.shutDownPageContainer as any).__evenLoaderWrapped) {
      wrapBridge(b)
    }
    if (Date.now() - started > POLL_LIMIT_MS) window.clearInterval(poll)
  }, POLL_INTERVAL_MS)
}
