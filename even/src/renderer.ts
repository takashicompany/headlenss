import {
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  utf8ByteLength,
} from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

const DISPLAY_WIDTH = 576
const DISPLAY_HEIGHT = 288
const HEADER_HEIGHT = 32                                // ヘッダ (現在の phase タイトル)
const HEADER_PADDING = 4                                // ヘッダの内側余白 (headerContainer と共有)
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
/** header (containerID:4) の実テキスト描画幅 (px)。padding を四辺から引いた内側。
 *  これより広いヘッダはレンズ側で裁ち落とされる (末尾から見えなくなる)。 */
export const HEADER_INNER_WIDTH = DISPLAY_WIDTH - 2 * HEADER_PADDING
/** LVGL の行の高さ (px, 固定)。@evenrealities/pretext の計測値準拠。 */
export const LENS_LINE_HEIGHT = 27

/** ブリッジ送信 1 回あたりの待ち上限 (ms)。 */
const BRIDGE_SEND_TIMEOUT_MS = 5000

/**
 * OS の長押しメニュー (第 1 階層) に出す項目。
 *
 * menuObject は createStartUpPageContainer / rebuildPageContainer にしか載らない
 * (textContainerUpgrade では差し替えられない) ので、内容を変えるにはページごと
 * 組み直す必要がある。呼び出し側はそのコストを踏まえて「変わった時だけ」渡すこと。
 * null / 空配列を渡すと menuObject を省略し、OS のデフォルトメニューに戻る。
 */
export type LensMenuItem = {
  /** 0 は予約済み。同一メニュー内で一意な正の整数。 */
  itemID: number
  /** レンズに出る表示名。プロトコル上 32 UTF-8 バイトまで。 */
  itemName: string
}

/** 表示名のプロトコル上限 (UTF-8 バイト)。 */
const MENU_ITEM_NAME_MAX_BYTES = 32
/** 1 つのメニューに置ける項目数の上限 (ファームウェア制約)。 */
const MENU_MAX_ITEMS = 10

/**
 * メニュー項目を SDK の検証に必ず通る形へ丸める。
 *
 * なぜ落とさず丸めるか: 検証に落ちた menuObject を渡すと SDK は native を呼ぶ前に
 * ページ全体を弾く (create は invalid、rebuild は false を返す)。つまり「メニューの
 * 文言が 1 文字長い」だけでレンズに何も描かれなくなる。翻訳の差し替えで表示名が
 * 伸びても本文の描画だけは死守する。
 */
function sanitizeMenuItems(items: LensMenuItem[]): MenuItemProperty[] {
  const seen = new Set<number>()
  const out: MenuItemProperty[] = []
  for (const item of items) {
    if (out.length >= MENU_MAX_ITEMS) {
      logFn(`menu: 項目数が上限 (${MENU_MAX_ITEMS}) を超えたので以降を捨てます`)
      break
    }
    if (!Number.isInteger(item.itemID) || item.itemID <= 0 || seen.has(item.itemID)) {
      logFn(`menu: itemID が不正/重複のため捨てます (${item.itemID})`)
      continue
    }
    seen.add(item.itemID)
    let name = item.itemName
    if (utf8ByteLength(name) > MENU_ITEM_NAME_MAX_BYTES) {
      // 末尾から 1 文字ずつ削る (サロゲートペアを割らないよう Array.from で扱う)
      const chars = Array.from(name)
      while (chars.length > 0 && utf8ByteLength(chars.join('')) > MENU_ITEM_NAME_MAX_BYTES) chars.pop()
      name = chars.join('')
      logFn(`menu: 表示名が ${MENU_ITEM_NAME_MAX_BYTES} バイトを超えたので詰めました -> ${JSON.stringify(name)}`)
    }
    if (!name) continue
    out.push(new MenuItemProperty({ itemID: item.itemID, itemName: name }))
  }
  return out
}

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

/** create / rebuild に渡すページ構成。menuObject を省略すると OS のデフォルトメニューに戻る。 */
type PageConfig = {
  containerTotalNum: number
  textObject?: TextContainerProperty[]
  menuObject?: MenuContainerProperty
}

function scheduleReturnRedraw(config: PageConfig): void {
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
 * 時間切れで待つのをやめた送信の会計を、呼び出し元 (main.ts) に知らせるためのフック。
 *
 * なぜ要るか: withBridgeTimeout が reject しても SDK 側の処理は止まらない。
 * 「こちらが待つのをやめただけで、まだ SDK に居座っているフレーム」が何本あるかは
 * ここでしか分からないので、その数を外へ出す。呼び出し元はこれを使って
 * 「詰まっている間は新規送信を見送る」背圧を掛ける。
 *
 *  onTimeout    … 時間切れで待つのをやめた (未決着が 1 本増えた)
 *  onLateSettle … 諦めた後になって SDK 側が決着した (未決着が 1 本減った)
 */
export type BridgeStallHooks = {
  onTimeout: (op: string) => void
  onLateSettle: (op: string, ok: boolean) => void
}
let stallHooks: BridgeStallHooks = { onTimeout: () => {}, onLateSettle: () => {} }
export function setRendererStallHooks(hooks: BridgeStallHooks): void {
  stallHooks = hooks
}

/**
 * ブリッジ送信に上限時間を付ける。
 *
 * SDK 側の Promise が解決しないまま返ってこないと、呼び出し元 (main.ts) の
 * 送信ロックが解放されず、以降レンズが二度と更新されなくなる。
 * 時間切れ時は reject して呼び出し元にロックを解放させる。SDK 側の処理自体は
 * 止められないので、あくまで「こちらが待つのをやめる」ための保険。
 *
 * 待つのをやめた後も元の Promise は追い続け、遅れて決着したら報告する。
 * 「まだ SDK に何本居座っているか」が分からないと、呼び出し元は詰まりの最中も
 * 新規送信を積み続けてしまう (背圧が効かない)。
 */
async function withBridgeTimeout<T>(op: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // この送信の時間切れを会計に載せたか。1 回の送信は高々 1 本しか未決着にならない。
  //
  // なぜフラグが要るか: SDK の one-shot タイマーは ホストの __tickShadowTimers と
  // 実タイマーの両方から発火しうる (timer-guard.ts 参照)。素直に書くと 1 本の送信で
  // onTimeout が 2 回呼ばれ、未決着カウントが実際の 2 倍に膨らむ。決着しない送信では
  // 減ることも無いので、送信 1 本で抑制の閾値 (2 本) に到達し、以後ずっと送信を
  // 見送り続ける = レンズが更新されなくなる。
  //
  // timer-guard.ts で入口を塞いではいるが、あれは読み込み順に依存する対処なので、
  // 会計が壊れると被害が大きいこの一点だけは自前でも冪等にしておく。
  let counted = false
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (!counted) {
            counted = true
            stallHooks.onTimeout(op)
            // 諦めた本数を後で戻せるよう、元の Promise の決着だけは見届ける。
            // (never settle なら永久に減らないが、それが実態なので会計としては正しい。
            //  飢餓しないよう、呼び出し元はバックオフ後に必ず 1 本試す。)
            p.then(
              () => stallHooks.onLateSettle(op, true),
              () => stallHooks.onLateSettle(op, false),
            )
          }
          reject(new Error(`bridge ${op} timed out after ${BRIDGE_SEND_TIMEOUT_MS}ms`))
        }, BRIDGE_SEND_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function initRenderer(appBridge: EvenAppBridge): void {
  bridge = appBridge
}

/**
 * ホスト側にこのページのコンテナが既にあるとみなしているか。
 * false の間は差分更新 (textContainerUpgrade) を送っても何も出ないので、
 * 呼び出し側は showScreen (ページ再構築) から描き直す必要がある。
 */
export function isPageBuilt(): boolean {
  return startupRendered
}

/** Foreground 再入場後など、レンズページを再生成したいときに呼ぶ */
export function resetPageState(): void {
  startupRendered = false
  returnRebuildFallbackArmed = false
}

async function rebuildPage(config: PageConfig): Promise<void> {
  if (!bridge) return
  const mainContent = config.textObject?.find((t) => t.containerID === 2)?.content ?? ''
  const previewLine = mainContent.split('\n')[0].slice(0, 40)
  // どんな長押しメニューを載せて送ったかを毎回残す。メニューは create/rebuild でしか
  // 差し替わらないので、「今レンズに出ているメニュー」はこの行でしか外から追えない。
  const menuNames = config.menuObject?.menuItems?.map((m) => m.itemName ?? '') ?? []
  console.log(`[renderer] menu=${JSON.stringify(menuNames)}`)
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
    paddingLength: HEADER_PADDING,
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

/**
 * ページ全体を組み直してレンズへ送る。
 *
 * @param menu OS 長押しメニューの項目。null / 空なら menuObject を省略し、
 *             その画面では OS のデフォルトメニューに戻る (独自項目で上書きしない)。
 */
export async function showScreen(
  header: string,
  content: string,
  footer: string,
  menu: LensMenuItem[] | null = null,
): Promise<void> {
  const menuItems = menu && menu.length > 0 ? sanitizeMenuItems(menu) : []
  await rebuildPage({
    containerTotalNum: 4,
    // 空の menuObject を渡すと「項目 0 個のメニュー」になりかねないので、
    // 出す物が無い時はキーごと省略する (= デフォルトメニュー復帰)。
    ...(menuItems.length > 0 ? { menuObject: new MenuContainerProperty({ menuItems }) } : {}),
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
  // header/content と同じ書式で出す。3 コンテナの送信本数を同じ物差しで数えられるようにする
  // (どのコンテナが実際に BLE へ流れたかは、この 3 行の時系列でしか外から確かめられない)。
  console.log(`[renderer] textContainerUpgrade #3 (footer: "${footer.slice(0, 40)}")`)
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
