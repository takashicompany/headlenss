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
}

async function rebuildPage(config: {
  containerTotalNum: number
  textObject?: TextContainerProperty[]
}): Promise<void> {
  if (!bridge) return
  const mainContent = config.textObject?.find((t) => t.containerID === 2)?.content ?? ''
  const previewLine = mainContent.split('\n')[0].slice(0, 40)
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
