import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

const DISPLAY_WIDTH = 576
const DISPLAY_HEIGHT = 288
const HEADER_HEIGHT = 32                                // ヘッダ (現在の phase タイトル)
const FOOTER_HEIGHT = 40                                // フッタ (操作ガイド)
// 左眼で main container の上端 border (1px) が裁ち落とされる現象への対策で、
// main を MAIN_TOP_INSET px だけ下にずらす。height はその分減らし、footer の位置は変えない。
// 3px ではまだ稀に欠ける個体差があったので 6px に拡大。
const MAIN_TOP_INSET = 6
const CONTENT_TOP = HEADER_HEIGHT + MAIN_TOP_INSET
const CONTENT_HEIGHT = DISPLAY_HEIGHT - HEADER_HEIGHT - FOOTER_HEIGHT - MAIN_TOP_INSET // 210

// main (containerID:2) コンテナの padding / border。LVGL は paddingLength と
// borderWidth を四辺から引いた内側にテキストを描画する。
const MAIN_PADDING = 8
const MAIN_BORDER = 1
/** main コンテナの実テキスト描画幅 (px)。chat の折り返し計算はこの幅を基準にする。
 *  これより広い行はレンズ側 LVGL が勝手に折り返して行数が膨らむ。 */
export const MAIN_INNER_WIDTH = DISPLAY_WIDTH - 2 * (MAIN_PADDING + MAIN_BORDER)
/** main コンテナの実テキスト描画高さ (px)。 */
export const MAIN_INNER_HEIGHT = CONTENT_HEIGHT - 2 * (MAIN_PADDING + MAIN_BORDER)
/** LVGL の行の高さ (px, 固定)。@evenrealities/pretext の計測値準拠。 */
export const LENS_LINE_HEIGHT = 27

/** ブリッジ送信 1 回あたりの待ち上限 (ms)。 */
const BRIDGE_SEND_TIMEOUT_MS = 5000

let bridge: EvenAppBridge | null = null
let startupRendered = false
// 復帰フラグ由来で「ページは既にホスト側に存在する」とみなした場合に true。
// その初回 rebuild が拒否された (= 実は新規セッションだった) 場合は create へ戻す。
let returnRebuildFallbackArmed = false
// 描画呼び出しの通し番号。復帰後ガード再描画の「間に他の描画があったらスキップ」判定に使う。
let drawSeq = 0
// 復帰直後の初回描画フレームがホスト側で取りこぼされる実機対策 (even-loader で実測)。
// この時間内に他の描画が無ければ、同じ内容をもう一度だけ送る。
const RETURN_REDRAW_RETRY_MS = 800

let logFn: (msg: string) => void = (m) => console.log(`[renderer] ${m}`)
/** ログ出力先を差し替える (main.ts の log() に繋ぐ) */
export function setRendererLog(fn: (msg: string) => void): void {
  logFn = fn
}

/**
 * 「ブリッジ送信路のロックを取ってから実行する」実装の差し込み口。
 *
 * なぜ: 復帰後ガード再描画は元々ここから直接 (fire-and-forget で) 送っていたが、
 * main.ts 側は全送信を 1 本の直列路に通して in-flight を高々 1 本に保っている。
 * その外から割り込むと背圧の前提が崩れ、他の送信と混ざる。既定は素通しなので、
 * main.ts が接続していない場合 (テスト等) でも従来どおり動く。
 */
type ExclusiveSender = (body: () => Promise<void>) => Promise<void>
let exclusiveSend: ExclusiveSender = async (body) => { await body() }
export function setRendererExclusiveSender(fn: ExclusiveSender): void {
  exclusiveSend = fn
}

/**
 * プラグインから復帰した直後の boot で呼ぶ。
 * ホスト側セッションには既にプラグインのコンテナが存在し、
 * createStartUpPageContainer はセッションにつき 1 回きりなので、
 * 初回描画を rebuildPageContainer (全コンテナ置き換え) にする。
 */
export function markPageAlreadyBuilt(): void {
  startupRendered = true
  returnRebuildFallbackArmed = true
}

function scheduleReturnRedraw(config: {
  containerTotalNum: number
  textObject?: TextContainerProperty[]
}): void {
  const seqAt = drawSeq
  window.setTimeout(() => {
    if (!bridge) return
    if (drawSeq !== seqAt) return  // 間に他の描画があった = 取りこぼしていない
    // 送信路のロックを取ってから送る。ロック待ちの間に他の描画が入ることがあるので、
    // 取得後にもう一度 drawSeq を見て「その後に描画があったらキャンセル」を保つ。
    void exclusiveSend(async () => {
      if (!bridge) return
      if (drawSeq !== seqAt) return
      drawSeq++
      logFn(`復帰後ガード再描画: ${RETURN_REDRAW_RETRY_MS}ms 無描画のため rebuild を再送`)
      await withBridgeTimeout('rebuildPageContainer(guard)', bridge.rebuildPageContainer(new RebuildPageContainer(config)))
    }).catch((err) => logFn(`ガード再描画 失敗: ${err}`))
  }, RETURN_REDRAW_RETRY_MS)
}

/**
 * ブリッジ送信に上限時間を付ける。
 *
 * SDK 側の Promise が解決しないまま返ってこないと、呼び出し元 (main.ts) の
 * 送信ロックが解放されず、以降レンズが二度と更新されなくなる。
 * 時間切れ時は reject して呼び出し元にロックを解放させる。SDK 側の処理自体は
 * 止められないので、あくまで「こちらが待つのをやめる」ための保険。
 */
async function withBridgeTimeout<T>(op: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`bridge ${op} timed out after ${BRIDGE_SEND_TIMEOUT_MS}ms`)),
          BRIDGE_SEND_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function initRenderer(appBridge: EvenAppBridge): void {
  bridge = appBridge
}

/** Foreground 再入場後など、レンズページを再生成したいときに呼ぶ */
export function resetPageState(): void {
  startupRendered = false
  returnRebuildFallbackArmed = false
}

async function rebuildPage(config: {
  containerTotalNum: number
  textObject?: TextContainerProperty[]
}): Promise<void> {
  if (!bridge) return
  const mainContent = config.textObject?.find((t) => t.containerID === 2)?.content ?? ''
  const previewLine = mainContent.split('\n')[0].slice(0, 40)
  drawSeq++
  // プラグインからの復帰直後: create は使えないので rebuild で全置き換えする。
  // 復帰フラグが古くて実は新規セッションだった場合、rebuild は拒否されるので
  // create にフォールバックして自己修復する。
  if (returnRebuildFallbackArmed) {
    returnRebuildFallbackArmed = false
    let ok = false
    try {
      ok = await withBridgeTimeout(
        'rebuildPageContainer(return)',
        bridge.rebuildPageContainer(new RebuildPageContainer(config)),
      )
    } catch (err) {
      logFn(`復帰 rebuild 失敗: ${err}`)
    }
    logFn(`復帰 rebuild 結果=${String(ok)}`)
    if (ok) {
      scheduleReturnRedraw(config)
      return
    }
    logFn('復帰 rebuild が拒否されたため createStartUpPageContainer にフォールバック')
    startupRendered = false
  }
  if (!startupRendered) {
    console.log(`[renderer] createStartUpPageContainer (main: "${previewLine}")`)
    await withBridgeTimeout(
      'createStartUpPageContainer',
      bridge.createStartUpPageContainer(new CreateStartUpPageContainer(config)),
    )
    startupRendered = true
    return
  }
  console.log(`[renderer] rebuildPageContainer (main: "${previewLine}")`)
  await withBridgeTimeout(
    'rebuildPageContainer',
    bridge.rebuildPageContainer(new RebuildPageContainer(config)),
  )
}

function evtContainer(): TextContainerProperty {
  return new TextContainerProperty({
    containerID: 1,
    containerName: 'evt',
    content: ' ',
    xPosition: 0,
    yPosition: 0,
    width: DISPLAY_WIDTH,
    height: DISPLAY_HEIGHT,
    isEventCapture: 1,
    paddingLength: 0,
  })
}

function headerContainer(text: string): TextContainerProperty {
  return new TextContainerProperty({
    containerID: 4,
    containerName: 'header',
    content: text,
    xPosition: 0,
    yPosition: 0,
    width: DISPLAY_WIDTH,
    height: HEADER_HEIGHT,
    isEventCapture: 0,
    paddingLength: 4,
  })
}

function footerContainer(footer: string): TextContainerProperty {
  return new TextContainerProperty({
    containerID: 3,
    containerName: 'footer',
    content: footer,
    xPosition: 0,
    yPosition: CONTENT_TOP + CONTENT_HEIGHT,
    width: DISPLAY_WIDTH,
    height: FOOTER_HEIGHT,
    isEventCapture: 0,
    paddingLength: 4,
  })
}

export async function showScreen(header: string, content: string, footer: string): Promise<void> {
  await rebuildPage({
    containerTotalNum: 4,
    textObject: [
      evtContainer(),
      headerContainer(header),
      new TextContainerProperty({
        containerID: 2,
        containerName: 'main',
        content,
        xPosition: 0,
        yPosition: CONTENT_TOP,
        width: DISPLAY_WIDTH,
        height: CONTENT_HEIGHT,
        isEventCapture: 0,
        // paddingLength: 4 だと最終行のディセンダが下端 border に重なって切れて見える。
        // 上下に余白を取って末尾文字 (とくに日本語の縦画) が入りきるようにする。
        paddingLength: MAIN_PADDING,
        borderWidth: MAIN_BORDER,
        borderColor: 13,
        borderRadius: 0,
      }),
      footerContainer(footer),
    ],
  })
}

export async function updateContent(content: string): Promise<void> {
  if (!bridge) return
  drawSeq++ // 差分描画もガード再描画のスキップ判定に数える (数えないと復帰後に古いフレームで上書きされる)
  const previewLine = content.split('\n')[0].slice(0, 40)
  console.log(`[renderer] textContainerUpgrade #2 (main: "${previewLine}")`)
  await withBridgeTimeout(
    'textContainerUpgrade #2',
    bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 2,
        containerName: 'main',
        contentOffset: 0,
        contentLength: 2000,
        content,
      }),
    ),
  )
}

export async function updateHeader(header: string): Promise<void> {
  if (!bridge) return
  drawSeq++ // 差分描画もガード再描画のスキップ判定に数える (数えないと復帰後に古いフレームで上書きされる)
  console.log(`[renderer] textContainerUpgrade #4 (header: "${header.slice(0, 40)}")`)
  await withBridgeTimeout(
    'textContainerUpgrade #4',
    bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 4,
        containerName: 'header',
        contentOffset: 0,
        contentLength: 2000,
        content: header,
      }),
    ),
  )
}

export async function updateFooter(footer: string): Promise<void> {
  if (!bridge) return
  drawSeq++ // 差分描画もガード再描画のスキップ判定に数える (数えないと復帰後に古いフレームで上書きされる)
  await withBridgeTimeout(
    'textContainerUpgrade #3',
    bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 3,
        containerName: 'footer',
        contentOffset: 0,
        contentLength: 2000,
        content: footer,
      }),
    ),
  )
}
