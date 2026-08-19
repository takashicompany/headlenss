import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'

import {
  getPcmByteLength,
  getRecordingSeconds,
  resetPcmCounter,
  trackPcmFrame,
} from './audio'
import { onEvenHubEvent, setEventHandlers, setScrollCooldownMs } from './events'
import {
  initRenderer,
  isPageBuilt,
  MAIN_INNER_WIDTH,
  markPageAlreadyBuilt,
  resetPageState,
  setRendererExclusiveSender,
  setRendererLog,
  showScreen,
  updateContent,
  updateFooter,
  updateHeader,
} from './renderer'
import {
  consumeReturnFlag,
  markNavigateToPlugin,
  markReturnReload,
  withLoaderParam,
} from './plugin-launch'
import { fetchTargetHtml, isDocumentReplaced, isProxyInjected, performTakeover } from './plugin-takeover'
import {
  HeadlenssClient,
  PendingConflictError,
  RespondInterruptedError,
  type AgentSource,
  type ChatItem,
  type ClaudeSessionInfo,
  type DeliveryWarning,
  type G2PluginInfo,
  type Pending,
  type Session,
} from './server-client'
import {
  CHAT_DISPLAY_LINES_MAX,
  CHAT_DISPLAY_LINES_MIN,
  clampChatDisplayLines,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  SCROLL_ANIM_TICK_MAX,
  SCROLL_ANIM_TICK_MIN,
  SCROLL_COOLDOWN_MAX,
  SCROLL_COOLDOWN_MIN,
  SCROLL_LINES_MIN,
  type OperatingPoint,
  type Settings,
} from './settings'
import { SpeechmaticsRT } from './speechmatics-rt'
import {
  applyTranslations,
  getLanguage,
  LANGUAGE_LABELS,
  setLanguage,
  t,
  type Language,
} from './i18n'

// ───────────────────────────────────────────────────────────────────────
// 利用シーン: G2 をかけてポケットのスマホ (このWebView) で動かす。
// G2クリック → 喋ってる最中から partial がレンズに出る → もう一度クリックで確定 →
// 確定テキストが tmux に流れる。
// ───────────────────────────────────────────────────────────────────────

const BRIDGE_TIMEOUT_MS = 4000
// かつて「G2 の連続録音上限は 30 秒」としてカウントダウンと自動停止を入れていたが、
// 実機で 30 秒を超えて録音し続けられることを確認したため、両方とも廃止した。
// SDK の audioControl にも録音長の上限は明記されていない。
const MIN_RECORDING_SEC = 0.2
const HISTORY_LIMIT = 20
const PROBE_DEBOUNCE_MS = 500
const SESSIONS_REFRESH_MS = 15000
const G2_REFRESH_THROTTLE_MS = 250

// ─── DOM ───────────────────────────────────────────────────────────────
const bodyEl = document.body

// 言語セレクタ (左上固定)
const langToggleBtn = document.getElementById('langToggle') as HTMLButtonElement
const langCurrentEl = document.getElementById('langCurrent') as HTMLSpanElement
const langDropdownEl = document.getElementById('langDropdown') as HTMLUListElement

// Onboarding
const obSteps = Array.from(document.querySelectorAll<HTMLDivElement>('.ob-step'))
const obServerUrlEl = document.getElementById('ob-server-url') as HTMLInputElement
const obServerProbeEl = document.getElementById('ob-server-probe') as HTMLDivElement
const obNext1Btn = document.getElementById('ob-next-1') as HTMLButtonElement
const obSmKeyEl = document.getElementById('ob-sm-key') as HTMLInputElement
const obBackBtn = document.getElementById('ob-back') as HTMLButtonElement
const obFinishBtn = document.getElementById('ob-finish') as HTMLButtonElement
const obSmPortalLink = document.getElementById('ob-sm-portal-link') as HTMLAnchorElement

// Toast
const toastEl = document.getElementById('toast') as HTMLDivElement

// Dashboard
const statusDotEl = document.getElementById('statusDot') as HTMLSpanElement
const statusTextEl = document.getElementById('statusText') as HTMLSpanElement
const activeSessionNameEl = document.getElementById('activeSessionName') as HTMLElement

const sessionPillsEl = document.getElementById('sessionPills') as HTMLDivElement
const reloadSessionsBtn = document.getElementById('reloadSessionsBtn') as HTMLButtonElement
const newSessionForm = document.getElementById('newSessionForm') as HTMLFormElement
const newSessionInput = document.getElementById('newSessionInput') as HTMLInputElement

const historyListEl = document.getElementById('historyList') as HTMLOListElement
const clearHistoryBtn = document.getElementById('clearHistoryBtn') as HTMLButtonElement

const settingsDetails = document.getElementById('settingsDetails') as HTMLDetailsElement
const serverUrlEl = document.getElementById('serverUrl') as HTMLInputElement
const serverProbeText = document.getElementById('serverProbeText') as HTMLSpanElement
const smApiKeyEl = document.getElementById('smApiKey') as HTMLInputElement
const smLangEl = document.getElementById('smLang') as HTMLSelectElement
const smOperatingPointEl = document.getElementById('smOperatingPoint') as HTMLSelectElement
const chatLinesEl = document.getElementById('chatLines') as HTMLInputElement
const chatBottomSpacerEl = document.getElementById('chatBottomSpacer') as HTMLInputElement
const devModeEl = document.getElementById('devMode') as HTMLInputElement
const scrollLinesEl = document.getElementById('scrollLines') as HTMLInputElement
const scrollLinesValEl = document.getElementById('scrollLinesVal') as HTMLSpanElement
const scrollCooldownEl = document.getElementById('scrollCooldown') as HTMLInputElement
const scrollCooldownValEl = document.getElementById('scrollCooldownVal') as HTMLSpanElement
const scrollAnimTickEl = document.getElementById('scrollAnimTick') as HTMLInputElement
const scrollAnimTickValEl = document.getElementById('scrollAnimTickVal') as HTMLSpanElement

const pendingSection = document.getElementById('pendingSection') as HTMLElement
const pendingTextEl = document.getElementById('pendingText') as HTMLDivElement
const confirmBtn = document.getElementById('confirmBtn') as HTMLButtonElement
const discardBtn = document.getElementById('discardBtn') as HTMLButtonElement

const tmuxOutputEl = document.getElementById('tmuxOutput') as HTMLPreElement
const reloadOutputBtn = document.getElementById('reloadOutputBtn') as HTMLButtonElement

// Claude セッション一覧 (WebView)
const claudeSessionsCardEl = document.getElementById('claudeSessionsCard') as HTMLDetailsElement
const claudeSessionsListEl = document.getElementById('claudeSessionsList') as HTMLUListElement
const reloadClaudeBtn = document.getElementById('reloadClaudeBtn') as HTMLButtonElement

// 新規 Claude セッション
const newClaudeSessionCardEl = document.getElementById('newClaudeSessionCard') as HTMLElement
const newClaudeForm = document.getElementById('newClaudeSessionForm') as HTMLFormElement
const newClaudeNameEl = document.getElementById('newClaudeName') as HTMLInputElement
const newClaudeCwdEl = document.getElementById('newClaudeCwd') as HTMLInputElement
const newAgentKindEl = document.getElementById('newAgentKind') as HTMLSelectElement
const newClaudeStatusEl = document.getElementById('newClaudeStatus') as HTMLDivElement

const recordBtn = document.getElementById('recordBtn') as HTMLButtonElement
const durationEl = document.getElementById('duration') as HTMLSpanElement

const logEl = document.getElementById('log') as HTMLPreElement

// ─── State ─────────────────────────────────────────────────────────────
// 画面遷移:
//   boot → (設定済) → rootlist ──click──> idle (selected session)
//                                     ↑doubleClick (戻る)
//   idle ──click──> recording ──click──> pending ──↑scroll──> sending ──> idle
//                                              └──↓scroll──> idle (破棄)
//   idle (pending有) ──click──> cc-message ──click──> cc-response ──> (応答送信) idle
//                                        ↑doubleClick (戻る)┘
//                          idle <──doubleClick (応答キャンセル)
type Phase =
  | 'boot' | 'unconfigured' | 'rootlist' | 'idle'
  | 'recording' | 'finalizing' | 'pending' | 'sending'
  | 'cc-message'   // Claude Code の承認/質問の本文を全文読む画面 (cc-response の手前)
  | 'cc-response'  // Claude Code の承認/質問待ちに応答する画面
  | 'error'

const TMUX_OUTPUT_LINES = 200          // (legacy) capture-pane 用 — 現状未使用
// G2 レンズに出す chat 行数。content area は CONTENT_HEIGHT=210px - paddingLength*2(=16px)
// ≒ 194px で、7 行詰めると 1 行 ~27.7px となり日本語のディセンダで最終行が切れる実機報告が
// あった。最適値は個体差・フォントで変わるので固定せず、設定 (settings.chatDisplayLines) で
// WebView から変更できるようにしている。ここはその参照用アクセサ。
function chatDisplayLines(): number {
  return settings.chatDisplayLines
}
// スクロール系パラメータは settings で WebView から変更できる。以下は参照アクセサ。
/** スクロール 1 ジェスチャーで動かす行数。 */
function scrollLinesPerGesture(): number {
  return settings.scrollLinesPerGesture
}
/** スクロールアニメーションの 1 行あたりの間隔 (ms)。 */
function scrollAnimTickMs(): number {
  return settings.scrollAnimTickMs
}
// chat の折り返し幅。レンズ main コンテナの実描画幅 (px) を基準にし、@evenrealities/pretext
// の getTextWidth (LVGL と同じ実グリフ幅) で計測する。これで「アプリが 1 行と思った行を
// レンズが勝手にもう一度折り返す」ズレを無くす。-2px は丸め誤差のセーフティマージン。
const CHAT_WRAP_PX = MAIN_INNER_WIDTH - 2
const CHAT_WRAP_WIDTH = 56             // (cc-response の粗いスライス用) 全角28文字相当のカラム数
const CC_POLL_INTERVAL_MS = 1500       // Agent sessions / chat / pending のポーリング間隔
const ROOT_LIST_VISIBLE = 7            // G2 root 画面に同時表示するセッション数 (8 行送ると容量超えでスクロールバーが出るため 7 に絞る)
const CC_LIST_VISIBLE = 7              // cc-response / cc-message 画面に同時表示する行数 (rootlist と揃える)
// cc-message で本文として折り返す最大文字数。巨大な toolInput をそのまま px 計測すると
// 描画が固まるので、閲覧用途として十分な長さで頭打ちにする。
const CC_MSG_MAX_CHARS = 2000

type HistoryEntry = {
  id: number
  text: string
  session: string
  ok: boolean
  durationMs: number
  errorMsg?: string
  timestamp: number
}

let bridge: EvenAppBridge | null = null
let settings: Settings = { ...DEFAULT_SETTINGS }
let phase: Phase = 'boot'
/** await を挟んだ後の phase 読み出し用。直接読むと await 前の絞り込みが残るため。 */
function currentPhase(): Phase { return phase }
let serverProbeOk = false
let serverErrorMsg = ''
let lastSessions: Session[] = []
let history: HistoryEntry[] = []
let historyCounter = 0
let recordingTimer: ReturnType<typeof setInterval> | null = null
let sessionsRefreshTimer: ReturnType<typeof setInterval> | null = null
let probeDebounceTimer: ReturnType<typeof setTimeout> | null = null
let rtSession: SpeechmaticsRT | null = null
let liveTranscript = '' // 録音中のpartial+final結合表示用
let recordingReady = false // RT接続+G2マイク起動が完了して実際に音声を取り始めたか
// 確定待ちのテキストを「録音1回ぶん = 1文」単位で配列管理する。
// pending 中に追加クリック → 新たな録音 → 末尾に append。
// 下スクロールで末尾の1文だけ削除。
let pendingSentences: string[] = []
function pendingDisplayText(): string { return pendingSentences.join('\n') }
function pendingSendText(): string    { return pendingSentences.join(' ') }
function pendingHasContent(): boolean { return pendingSentences.some((s) => s.trim().length > 0) }
let tmuxOutput = ''     // (legacy) tmux 出力 — 現状ダッシュボードとレンズには使わない
let outputPollTimer: ReturnType<typeof setInterval> | null = null
let outputFetchOkLogged = false
let scrollOffset = 0  // chat の末尾から何行戻ったか (0=ライブ末尾)
// 録音中の live transcript 用スクロール。喋った内容が画面に収まらなくなった時に
// 遡って読めるようにする。0 = 最新 (喋っている先頭) を表示。
let recordingScrollOffset = 0
// live transcript を折り返した結果。partial が来るたびに全文を折り返すと重いので、
// 元テキストが変わった時だけ計算する。
let recordingLinesCache: string[] = []
let recordingLinesCacheKey = ''
let scrollAnimPending = 0  // アニメーションでまだ消化していない残り行数。正=back, 負=forward
let scrollAnimTimer: ReturnType<typeof setTimeout> | null = null
// スクロールアニメの実行中フラグ。開始〜終了 (中断含む) を通して true。
// なぜ: tick は sendContentDirect の前に scrollAnimTimer を null に戻すため、
// タイマーの有無で「アニメ中か」を判定すると full render の延期が一度も効かない。
let scrollAnimActive = false
// rootlist 内のカーソルが指す行のキー (index ではなくキーで追跡し、一覧が入れ替わっても位置を保つ)
let rootCursorKey: string | null = null
let rootListStart = 0 // rootlist 表示窓の先頭 index。カーソル追従方式で cursor が窓外に出た時だけスライドする
let ccListStart = 0   // cc-response 画面の表示窓の先頭行 index (rootlist と同じカーソル追従方式)
// cc-message (メッセージ全文閲覧) 画面の読み位置は respondFlow.msgScrollOffset が持つ
// (用件 1 件に属する状態なので、応答フローの他の状態と一緒に生まれて一緒に消える)。
// cc-message の本文を折り返した結果。ポーリングのたびに全文を px 計測し直すと重いので、
// 元テキスト (pending / 質問 index を含む) が変わった時だけ計算する。
let ccMsgLinesCache: string[] = []
let ccMsgLinesCacheKey = ''

// 「最後に開いてから何か動いた」を未読として rootlist に印を出す仕組み。
// セッション名 → 最後に既読化した unix ms。idle 中はポーリングごとに現在
// セッションを markAsRead で更新する。localStorage に persist (debounced)。
const LAST_READ_KEY = 'headlenss_last_read_v1'
const lastReadAt: Record<string, number> = (() => {
  try {
    const raw = localStorage.getItem(LAST_READ_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch { return {} }
})()
let lastReadPersistTimer: ReturnType<typeof setTimeout> | null = null
function persistLastRead(): void {
  try { localStorage.setItem(LAST_READ_KEY, JSON.stringify(lastReadAt)) } catch {}
}
function markAsRead(name: string): void {
  if (!name) return
  lastReadAt[name] = Date.now()
  if (lastReadPersistTimer) return
  lastReadPersistTimer = setTimeout(() => {
    lastReadPersistTimer = null
    persistLastRead()
  }, 1000)
}
/** 保留中の既読位置の書き込みを今すぐ済ませる (debounce タイマーを捨てる前に呼ぶ)。 */
function flushLastReadPersist(): void {
  if (!lastReadPersistTimer) return
  clearTimeout(lastReadPersistTimer)
  lastReadPersistTimer = null
  persistLastRead()
}
function isUnread(s: ClaudeSessionInfo): boolean {
  const last = lastReadAt[s.tmuxSessionName] ?? 0
  return s.lastSeenAt > last
}

// Claude Code hook 連携
let claudeSessions: ClaudeSessionInfo[] = []     // 起動中Claude Codeを持つtmuxセッション一覧
let claudeChat: ChatItem[] = []                  // 現在選択中セッションのチャット履歴
// formatChatLines(claudeChat) の結果。スクロール毎の全文再整形 (長文で重い) を
// 避けるため保持する。claudeChat を差し替える箇所で必ず更新/クリアする。
let chatLinesCache: string[] = []
// chatLinesCache がどの入力から作られたかの指紋。ポーリングで取得した内容が前回と
// 同一ならここで打ち切り、再整形しない。
//
// formatChatLines は全文字を 1 文字ずつグリフ幅測定するため、コストが表示対象の
// 総文字数に比例する (実測: 20件x9,700字 で約2,000ms)。ポーリング間隔は1.5秒なので、
// 会話が長くなるほどメインスレッドが埋まり、スクロールも一覧移動も止まる。
// 無操作中は内容が変わらないので、指紋一致で丸ごと省ける。
let chatLinesCacheKey = ''
let currentAgentSource: AgentSource | undefined = undefined
// サーバから来た Agent の動作状態 (idle / busy / waiting-*)。chat 末尾の待機行に使う。
let claudeChatStatus: string | undefined = undefined
// 送ったのに届いた確証が得られていない直近の送信 (サーバが未確認の間だけ載せてくる)。
// 確認できたらサーバ側で消えるので、こちらは受け取った値をそのまま持つだけでよい。
let claudeDeliveryWarning: DeliveryWarning | null = null
let claudePending: Pending | null = null         // 現在選択中セッションの承認/質問待ち
let claudeChatLoading = false                    // セッション切替直後のロード中フラグ
// refreshClaudeData の非同期レース防止: 実行中の fetch を abort し、完了時にセッション名を検証する
let refreshAbortCtrl: AbortController | null = null
/** 実行中の refreshClaudeData fetch を中断する (セッション切替時に呼ぶ) */
function abortInFlightRefresh(): void {
  if (refreshAbortCtrl) { refreshAbortCtrl.abort(); refreshAbortCtrl = null }
}
// AskUserQuestion 回答ビルド用: 各質問について構築中の回答を保持
type RespondAnswer =
  | { kind: 'predefined'; option?: string; options?: string[] }   // single or multi
  | { kind: 'type-something'; text: string }
  | { kind: 'chat-about-this' }

/**
 * 用件 (pending) 1 件への応答フローが持つ状態。
 *
 * なぜ 1 つのオブジェクトにまとめるか:
 * 「本文を読む → 選択肢を選ぶ → (必要なら) 音声入力 → POST」は一続きの流れで、
 * 途中の状態はすべて「今答えている 1 件」に属する。以前はこれが 6 本の独立した
 * 変数に散らばっていて、後始末を書く場所が 5 か所に重複していた。1 か所でも
 * 書き漏らすと「カーソルだけ前の用件のまま」「録音の用途だけ残る」といった
 * 非対称が生まれる。フロー全体を 1 つの参照にして、生成と破棄を遷移関数に
 * 集約する = 「全部残る」か「全部消える」しか作れない形にする。
 *
 * 不変条件 (assertRespondFlowInvariant で実行時にも守る):
 *   - phase が cc-message / cc-response なら respondFlow は必ず非 null
 *   - respondFlow が非 null なら、phase は cc-message / cc-response、または
 *     Type something の録音中 (recording=true) か POST 中 (inFlightSince≠null)
 */
type RespondFlow = {
  /** どの用件に答えているか。ポーリング結果との突き合わせに使う。 */
  pendingId: string
  /** 複数質問時、現在表示中の質問 index */
  qIdx: number
  /** cc-response 画面のカーソル位置 (現在質問の行 index) */
  cursor: number
  /** cc-message (本文閲覧) 画面の窓の先頭行 index。0 = 本文の先頭。 */
  msgScrollOffset: number
  /** 各質問について構築中の回答 (質問 index → 回答) */
  answers: Record<number, RespondAnswer>
  /** Type something の音声入力中 (録音 / 確定待ち) か。録音の用途フラグを兼ねる。 */
  recording: boolean
  /**
   * 応答 POST を開始した時刻 (performance.now)。null = 送信中でない。
   * 送信は数百ms〜秒単位かかる (サーバが tmux にキーを注入して確認するまで) ので、
   * その間の入力を全部捨てないと同じ用件へ 2 通目を送ってしまう。
   *
   * 真偽値ではなく時刻を持つのは、fetch が決着しないまま返ってこない場合の脱出口の
   * ため。WebView では通信が切れても reject も resolve もしないことがあり、その間
   * 入力を捨て続けると画面が二度と操作できなくなる (RESPOND_INFLIGHT_GUARD_MS 参照)。
   */
  inFlightSince: number | null
  /** 直近の送信失敗の表示文言 (null = 無し)。次の操作か時間経過で消える。 */
  error: string | null
}
let respondFlow: RespondFlow | null = null

/**
 * 応答 POST の入力ガードを壁時計で解除するまでの時間 (ms)。
 * client 側の fetch タイムアウト (15 秒) より長く取り、「タイムアウトで決着する」
 * 正常系ではこちらが先に動かないようにする。
 */
const RESPOND_INFLIGHT_GUARD_MS = 20000

/** 応答 POST 中か (フロー未生成なら false)。 */
function flowIsInFlight(flow: RespondFlow | null): boolean {
  return flow != null && flow.inFlightSince !== null
}

/**
 * 決着しない送信の入力ガードを解除する。
 * 送信自体は諦めない (返ってきたら finally が後始末する) が、届いたかどうかは
 * 分からないので、その旨を出して操作だけ返す。
 * 既に決着済み (inFlightSince が null) なら何もしない = 何度呼んでも安全。
 */
function releaseStuckInFlightGuard(flow: RespondFlow): void {
  if (flow.inFlightSince === null) return
  flow.inFlightSince = null
  log(`応答の送信が ${RESPOND_INFLIGHT_GUARD_MS}ms 決着しないため入力ガードを解除しました (送信結果は不明)`)
  if (respondFlow === flow) {
    showRespondError(t('respondUnknownResult'))
    void refreshG2(true)
  }
}

/** 現在表示中の質問 index。フローが無い間 (描画の隙間) は 0 として扱う。 */
function flowQIdx(): number { return respondFlow?.qIdx ?? 0 }
/** cc-response のカーソル位置。フローが無い間は 0 として扱う。 */
function flowCursor(): number { return respondFlow?.cursor ?? 0 }
/** cc-message の読み位置。フローが無い間は先頭として扱う。 */
function flowMsgScroll(): number { return respondFlow?.msgScrollOffset ?? 0 }
/** 構築中の回答表 (読み取り専用に使う)。フローが無い間は空。 */
function flowAnswers(): Record<number, RespondAnswer> { return respondFlow?.answers ?? {} }

/** 応答 POST 中の G2 入力か。true ならその入力は無視する (全ジェスチャー共通)。 */
function respondInputBlocked(): boolean {
  const flow = respondFlow
  if (!flow || flow.inFlightSince === null) return false
  if (performance.now() - flow.inFlightSince < RESPOND_INFLIGHT_GUARD_MS) return true
  // タイマー経路より先にユーザが触った場合の保険。ここでも解除して操作を通す。
  releaseStuckInFlightGuard(flow)
  return false
}
/**
 * 用件への応答フロー (本文閲覧 → 選択肢 → Type something の録音 → POST) の最中か。
 * なぜ: この間に足元のセッションが差し替わると、組み立て中の回答ごと操作が消える。
 * 自動 (ユーザ操作以外) の切替はこれが true の間だけ保留する。
 */
function isRespondFlowActive(): boolean {
  return respondFlow !== null || phase === 'cc-message' || phase === 'cc-response'
}
/** 今の録音が cc-response の Type something 用か (通常の tmux 送信用なら false)。 */
function recordingIsForRespond(): boolean {
  return respondFlow?.recording === true
}
// THROTTLE_MS だけ十分過去に置いておくことで、boot 直後の最初の refreshG2 が必ず発火するようにする
let g2RefreshLastAt = -G2_REFRESH_THROTTLE_MS - 1000
const client = new HeadlenssClient('')

// ─── Logging ───────────────────────────────────────────────────────────
// logEl は新しい行を先頭に前置する。上限を設けないと textContent が無制限に肥大し、
// 1回の log で全文を read/concat/再代入するため累積コストが二乗的になり、巨大な <pre>
// の再レイアウトで「使うほど重く」なる。直近 LOG_MAX_LINES 行だけ保持して抑える。
const LOG_MAX_LINES = 200
function log(msg: string): void {
  // 開発モードがオフ (既定) のときは画面ログを出力しない (肥大による重さを根から断つ)。
  if (!settings.devMode) return
  const time = new Date().toLocaleTimeString()
  const lines = (`[${time}] ${msg}\n` + (logEl.textContent ?? '')).split('\n')
  logEl.textContent = lines.length > LOG_MAX_LINES ? lines.slice(0, LOG_MAX_LINES).join('\n') : lines.join('\n')
  console.log(`[headlenss] ${msg}`)
}

// ─── Status (top bar + G2) ─────────────────────────────────────────────
function statusForCurrentPhase(): { dot: string; text: string } {
  switch (phase) {
    case 'boot':
      return { dot: 'idle', text: t('g2Booting') }
    case 'rootlist':
      return { dot: 'ready', text: `${t('g2Sessions')} (${claudeSessions.length})` }
    case 'cc-message':
    case 'cc-response':
      return { dot: 'busy', text: t('g2ClaudeAck') }
    case 'recording':
      return { dot: 'rec', text: `${t('g2Recording')} ${getRecordingSeconds().toFixed(1)}s` }
    case 'finalizing':
      return { dot: 'busy', text: t('g2Finalizing') }
    case 'pending':
      return { dot: 'busy', text: t('g2PendingHint') }
    case 'sending':
      return { dot: 'busy', text: `${t('g2Sending')} ${settings.sessionName || '—'}` }
    case 'error':
      return { dot: 'err', text: serverErrorMsg || 'Error' }
    case 'unconfigured':
      if (!bridge) return { dot: 'err', text: t('g2BridgeMissing') }
      if (!settings.serverBaseUrl) return { dot: 'idle', text: t('g2SetUrl') }
      if (!settings.speechmaticsApiKey) return { dot: 'idle', text: t('g2SetKey') }
      if (!serverProbeOk) return { dot: 'err', text: serverErrorMsg || t('g2Unreachable') }
      return { dot: 'idle', text: t('g2ConfigureSess') }
    case 'idle':
    default:
      return { dot: 'ready', text: `[${settings.sessionName || '?'}] ${t('g2Ready')}` }
  }
}

function paintStatus(): void {
  const s = statusForCurrentPhase()
  statusTextEl.textContent = s.text
  statusDotEl.className = `dot dot-${s.dot}`
  activeSessionNameEl.textContent = settings.sessionName || '—'
}

function isReady(): boolean {
  return Boolean(
    bridge &&
    settings.serverBaseUrl &&
    settings.speechmaticsApiKey &&
    serverProbeOk,
  )
}

function recomputePhase(): void {
  // pendingは「ユーザの判断待ち」なので自動で抜けない
  // cc-message / cc-response も閲覧/応答操作中なので自動で抜けない
  if (
    phase === 'recording' ||
    phase === 'finalizing' ||
    phase === 'pending' ||
    phase === 'sending' ||
    phase === 'cc-message' ||
    phase === 'cc-response'
  ) return
  if (!isReady()) {
    phase = 'unconfigured'
  } else if (phase !== 'rootlist' && phase !== 'idle') {
    // boot or unconfigured から ready になった: rootlist へ
    phase = 'rootlist'
    syncRootCursor()
  }
  paintStatus()
  void refreshG2()
  updateRecordButton()
  updatePendingUI()
}

/**
 * rootlist の 1 行。セッション行と、その配下にぶら下がる G2 プラグイン行の 2 種類。
 * カーソルはこの行配列の上を動く (プラグイン行にも止まれる)。
 */
type RootRow =
  | { kind: 'session'; session: ClaudeSessionInfo }
  | { kind: 'plugin'; session: ClaudeSessionInfo; plugin: G2PluginInfo }

/** 行の同一性キー。並びが変わってもカーソル位置を保つために index ではなくこれで追う。 */
function rootRowKey(row: RootRow): string {
  return row.kind === 'session'
    ? `s:${row.session.tmuxSessionName}`
    // 名前も含める。URL だけだと、同じ URL を別名で 2 行宣言した時にキーが衝突し、
    // 2 件目にカーソルを合わせても 1 件目に吸い寄せられて永久に選べなくなる。
    : `p:${row.session.tmuxSessionName}:${row.plugin.name}:${row.plugin.url}`
}

/**
 * rootlist に描かれる行の指紋。中身が変わったか (= 再描画が要るか) の判定に使う。
 * 行として見えるものを全部含める: 行の並び・キー・表示に使う値。
 * lastSeenAt は生値ではなく、表示に効く未読フラグ (isUnread) に落としてから含める。
 * 生値だとフックイベントのたびに変わり、表示が同じでも毎ポーリング全面再描画になる。
 */
function rootRowSignature(): string {
  return rootRows()
    .map((r) => (r.kind === 'session'
      ? `${rootRowKey(r)}|${r.session.status}|${r.session.screenBlocked === true}|${r.session.source ?? ''}|${r.session.lastChat ?? ''}|${isUnread(r.session)}`
      : `${rootRowKey(r)}|${r.plugin.name}`))
    .join('\n')
}

/** セッション一覧を、プラグインをぶら下げた行配列に展開する。 */
function rootRows(): RootRow[] {
  const rows: RootRow[] = []
  for (const session of claudeSessions) {
    rows.push({ kind: 'session', session })
    for (const plugin of session.g2Plugins ?? []) rows.push({ kind: 'plugin', session, plugin })
  }
  return rows
}

/** rootCursorKey を rootRows 内の index に解決する。行が消えた場合はクランプしてキーも更新する */
function resolveRootCursorIndex(): number {
  const rows = rootRows()
  if (rows.length === 0) return 0
  if (rootCursorKey) {
    const idx = rows.findIndex((r) => rootRowKey(r) === rootCursorKey)
    if (idx >= 0) return idx
  }
  // 行が見つからない (一覧から消えた) → 先頭にフォールバックしキーも更新
  rootCursorKey = rows[0] ? rootRowKey(rows[0]) : null
  return 0
}

/** カーソルが今指している行 */
function currentRootRow(): RootRow | undefined {
  return rootRows()[resolveRootCursorIndex()]
}

/** rootCursorKey を現在の選択 (settings.sessionName) のセッション行に合わせる */
function syncRootCursor(): void {
  const name = settings.sessionName || claudeSessions[0]?.tmuxSessionName || ''
  rootCursorKey = name ? `s:${name}` : null
}

/**
 * Claude Code セッションの待機状態を1文字記号にする。
 *
 * 画面ブロック (対話ウィザード等が tmux の画面を占有中) は status より優先して出す。
 * status は idle/busy のまま正しいが、その画面には送っても届かないので、
 * 「考え中」を知らせるより「今は送れない」を知らせる方が先だという判断。
 * (レンズの 1 行は狭く、記号は 1 枠しか置けない)
 */
function claudeStatusMark(s: ClaudeSessionInfo): string {
  if (s.screenBlocked === true) return '⚠'
  switch (s.status) {
    case 'waiting-permission': return '⏸'
    case 'waiting-question': return '?'
    case 'busy': return '●'
    case 'idle':
    default: return ' '
  }
}

function updatePendingUI(): void {
  if (phase === 'pending') {
    pendingSection.hidden = false
    pendingTextEl.textContent = pendingDisplayText() || '(empty)'
  } else {
    pendingSection.hidden = true
  }
}

// ─── G2 lens ───────────────────────────────────────────────────────────
function buildG2Content(): string {
  // ルート画面: tmux一覧 (cursor 中央)
  if (phase === 'rootlist') {
    return buildRootListView()
  }

  // idle時は Claude Code の chat (user発言とClaude返事) を画面いっぱい使って表示。
  if (phase === 'idle') {
    // 回答待ちの告知はヘッダ/フッタ側で出す (本文に差し込むとスクロールしても
    // 1 行目に張り付き、その 1 行ぶん chat が読めなくなるため)。
    const formatted = chatLinesForDisplay()
    if (formatted.length > 0) {
      const body = chatWindow(formatted, chatDisplayLines()).join('\n')
      // 末尾スペーサ: ON なら最終行のさらに下に空行を 1 行足す。最終行が下端 border に
      // かかって切れる時、この空行を犠牲にして実テキストを安全域へ逃がす。
      return settings.chatBottomSpacer ? body + '\n' : body
    }
    return `[${settings.sessionName || 'no session'}]\n${claudeChatLoading ? t('chatLoading') : t('chatNoMsg')}`
  }

  // Claude Code 承認/質問 待ちのメッセージ全文閲覧画面 (応答画面の手前)
  if (phase === 'cc-message') {
    return buildCcMessageView()
  }

  // Claude Code 承認/質問 待ちへの応答画面
  if (phase === 'cc-response') {
    return buildCcResponseView()
  }

  // それ以外の状態は状態 + 内容を表示
  const lines: string[] = []
  if (phase === 'recording') {
    // 秒数表示は header。content は live transcript (もしくは状態メッセージ) を
    // レンズ幅で折り返し、スクロール位置に応じた窓だけ出す。
    const all = recordingLines()
    const n = chatDisplayLines()
    const end = Math.max(n, all.length - recordingScrollOffset)
    return all.slice(Math.max(0, end - n), end).join('\n')
  } else if (phase === 'finalizing') {
    // 接続中など PCM が乗る前に停止すると liveTranscript は空のまま finalize に入る。
    // 「処理中」と見せると実態 (何も処理していない) と齟齬があるので empty 表示にする。
    lines.push('▌ ' + (liveTranscript || '(empty)'))
  } else if (phase === 'pending') {
    // 件数表示 (1件なら省略、複数なら "Pending (3 sentences)" のように)
    const n = pendingSentences.length
    lines.push(n > 1 ? `Pending (${n} sentences)` : 'Pending')
    lines.push('')
    lines.push(pendingDisplayText() || '(empty)')
  } else if (phase === 'sending') {
    lines.push(`Sending → ${settings.sessionName}`)
    lines.push('')
    lines.push(pendingSendText().slice(0, 200))
  } else if (phase === 'unconfigured') {
    // 初期設定中はそれを大きく明示する
    const s = statusForCurrentPhase()
    lines.push(`[${t('g2Setup')}]`)
    lines.push('')
    lines.push(t('g2SetupHint'))
    lines.push('')
    lines.push('· ' + s.text)
  } else {
    lines.push(t('appName'))
  }
  return lines.join('\n')
}

/**
 * 録音中に表示する live transcript を、レンズ幅で折り返した行配列にして返す。
 * 元テキストが変わっていなければ前回の結果を返す (partial のたびに全文を px 計測
 * し直すと、喋るほど重くなるため)。
 * 遡って読んでいる最中 (recordingScrollOffset > 0) に行が増えた場合は、その分だけ
 * オフセットを繰り上げて読んでいる位置を保つ。
 */
function recordingLines(): string[] {
  const body = liveTranscript
    ? '▌ ' + liveTranscript
    : '▌ ' + (recordingReady ? t('recStartedHint') : t('recConnecting'))
  if (body === recordingLinesCacheKey) return recordingLinesCache

  const out: string[] = []
  for (const para of body.split('\n')) {
    for (const line of wrapText(para, CHAT_WRAP_PX)) out.push(line)
  }
  if (recordingScrollOffset > 0) {
    const delta = out.length - recordingLinesCache.length
    // 増減どちらも補正する (chat 側と同じ理由: 片方向だけだと partial が縮んだ分の
    // ズレが戻らず、遡って読んでいる位置が少しずつ漂う)。
    if (delta !== 0) {
      const max = Math.max(0, out.length - chatDisplayLines())
      recordingScrollOffset = Math.max(0, Math.min(max, recordingScrollOffset + delta))
    }
  }
  recordingLinesCache = out
  recordingLinesCacheKey = body
  return out
}

/** 録音中スクロールの上限 (これ以上遡れない行数) */
function maxRecordingScrollOffset(): number {
  return Math.max(0, recordingLines().length - chatDisplayLines())
}

/** 録音中: 過去方向へ遡る */
function recordingScrollBack(): void {
  const max = maxRecordingScrollOffset()
  if (max === 0) return
  const next = Math.min(max, recordingScrollOffset + scrollLinesPerGesture())
  if (next === recordingScrollOffset) return
  recordingScrollOffset = next
  void refreshG2(true)
}

/** 録音中: 最新方向へ戻る */
function recordingScrollForward(): void {
  if (recordingScrollOffset === 0) return
  recordingScrollOffset = Math.max(0, recordingScrollOffset - scrollLinesPerGesture())
  void refreshG2(true)
}

/** 行ごとに右側の空白を落とし、末尾の空行を全部捨てた結果の配列を返す */
function normalizeOutput(text: string): string[] {
  const lines = text.split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Dashboard 用: 末尾 n 行 (スクロール非依存) */
function tailLines(text: string, n: number): string {
  return normalizeOutput(text).slice(-n).join('\n')
}

/** G2 rootlist 画面: Claude Code 起動中の tmux 一覧 (待機状態は記号で示す) */
function buildRootListView(): string {
  const items = rootRows()
  if (items.length === 0) {
    return t('rootListEmpty')
  }
  const total = items.length
  const rootCursor = resolveRootCursorIndex()

  // カーソル追従方式: 窓の中にカーソルがいる間はスライドしない、はみ出した時だけ最小限スライドする。
  if (rootCursor < rootListStart) {
    rootListStart = rootCursor
  } else if (rootCursor >= rootListStart + ROOT_LIST_VISIBLE) {
    rootListStart = rootCursor - ROOT_LIST_VISIBLE + 1
  }
  // セッション数が ROOT_LIST_VISIBLE 以下、もしくは末尾近辺で start が範囲を超えそうな時のクリップ
  rootListStart = Math.max(0, Math.min(rootListStart, Math.max(0, total - ROOT_LIST_VISIBLE)))

  const lines: string[] = []
  for (let i = rootListStart; i < Math.min(rootListStart + ROOT_LIST_VISIBLE, total); i++) {
    const row = items[i]
    const cursor = i === rootCursor ? '▶ ' : '  '
    if (row.kind === 'plugin') {
      // セッション行の下にぶら下げる。字下げで従属関係を示す。
      lines.push(`${cursor}  └ ${row.plugin.name}`)
      continue
    }
    const s = row.session
    const mark = claudeStatusMark(s)
    const agent = s.source === 'codex' ? 'Codex' : s.source === 'claude' ? 'Claude' : 'Agent'
    // 既読セッションは空白で揃え、未読は '*' でマーク
    const unread = isUnread(s) ? '*' : ' '
    const prefix = `${cursor}${s.tmuxSessionName} [${agent}] ${unread}${mark}`
    lines.push(appendRootPreview(prefix, s.lastChat))
  }
  return lines.join('\n')
}

/**
 * cc-message 画面に出す本文を、レンズ幅で折り返した行配列にして返す。
 * 内容が変わっていなければ前回の結果を返す (ポーリングのたびに全文を px 計測し直すと
 * 本文が長いほど重くなるため。recordingLines と同じキャッシュ方式)。
 */
function ccMessageLines(): string[] {
  const pending = claudePending
  if (!pending) {
    ccMsgLinesCache = []
    ccMsgLinesCacheKey = ''
    return ccMsgLinesCache
  }
  // 指紋は「本文を作る前に分かるもの」だけで構成する。pending は id が同じなら中身も
  // 同じなので、id + 種類 + 質問 index で一意に決まる (言語は省略表示行の文言に効く)。
  // なぜ本文を含めないか: 本文の構築 (summarizeToolInput の JSON 整形と slice) 自体が
  // 重く、キーに含めるとポーリングのたびに必ず実行されてキャッシュの意味が無い。
  const key = `${pending.id}#${pending.kind}#${flowQIdx()}#${getLanguage()}`
  if (key === ccMsgLinesCacheKey) return ccMsgLinesCache

  // 段落 (折り返し前) の配列。空文字は空行として扱う。
  // 質問番号 / multi バッジ / ツール名といったメタ情報はヘッダ (buildG2Header) が
  // 受け持つので、ここは本題だけを載せる (7 行しかない窓を無駄遣いしない)。
  const paras: string[] = []
  let fullLength = 0   // 切り詰め前の文字数 (0 = 切り詰めていない)
  if (pending.kind === 'permission') {
    // 選択肢画面と違いここは切り詰めない (全文を読ませるのがこの画面の役目)。
    // 巨大な toolInput で描画が固まらないよう文字数だけ上限を掛ける。
    const full = toolInputSummaryFor(pending)
    const summary = full.slice(0, CC_MSG_MAX_CHARS)
    if (summary) paras.push(summary)
    if (full.length > summary.length) fullLength = full.length
  } else {
    const q = pending.questions?.[flowQIdx()]
    if (!q) {
      ccMsgLinesCache = []
      ccMsgLinesCacheKey = ''
      return ccMsgLinesCache
    }
    // header は AskUserQuestion が付ける短い見出し (無い場合もある)
    if (q.header) {
      paras.push(q.header)
      paras.push('')
    }
    paras.push(q.question.slice(0, CC_MSG_MAX_CHARS))
    if (q.question.length > CC_MSG_MAX_CHARS) fullLength = q.question.length
  }
  // 切り詰めたことを黙っていると「読み切った」と誤解されるので末尾に明示する
  if (fullLength > 0) {
    paras.push('')
    paras.push(
      t('ccMsgTruncated')
        .replace('{shown}', String(CC_MSG_MAX_CHARS))
        .replace('{total}', String(fullLength)),
    )
  }

  const out: string[] = []
  for (const para of paras) {
    // 段落自体が改行を含むことがある (質問文やツール入力の整形結果)。wrapText は
    // 改行を知らないので、先に行へ割ってから折り返す (formatChatLines / recordingLines と同じ)。
    for (const src of para.split('\n')) {
      for (const line of wrapText(src, CHAT_WRAP_PX)) out.push(line)
    }
  }
  ccMsgLinesCache = out
  ccMsgLinesCacheKey = key
  return out
}

/** cc-message のスクロール上限 (窓の先頭行 index の最大値) */
function maxCcMsgScrollOffset(): number {
  return Math.max(0, ccMessageLines().length - CC_LIST_VISIBLE)
}

/** cc-message: 前 (メッセージ先頭) 方向へ戻る */
function ccMsgScrollBack(): void {
  const flow = respondFlow
  if (!flow || flow.msgScrollOffset === 0) return
  clearRespondError()
  flow.msgScrollOffset = Math.max(0, flow.msgScrollOffset - scrollLinesPerGesture())
  void refreshG2(true)
}

/** cc-message: 次 (メッセージ末尾) 方向へ進む */
function ccMsgScrollForward(): void {
  const flow = respondFlow
  if (!flow) return
  const max = maxCcMsgScrollOffset()
  const next = Math.min(max, flow.msgScrollOffset + scrollLinesPerGesture())
  if (next === flow.msgScrollOffset) return
  clearRespondError()
  flow.msgScrollOffset = next
  void refreshG2(true)
}

/**
 * Claude Code 承認/質問の本文を全文読むための画面。
 * 選択肢は出さず、CC_LIST_VISIBLE 行の窓を respondFlow.msgScrollOffset でスクロールさせる。
 */
function buildCcMessageView(): string {
  if (!claudePending) return '(no pending)'
  const all = ccMessageLines()
  // 本題が空 (toolInput 無しの承認など) でも、用件自体はヘッダに出ている
  if (all.length === 0) {
    return claudePending.kind === 'permission' ? '(no tool input)' : '(question is empty)'
  }
  // 本文が短くなった場合に窓が範囲外へ出ないようクランプする
  const start = Math.max(0, Math.min(flowMsgScroll(), Math.max(0, all.length - CC_LIST_VISIBLE)))
  if (respondFlow) respondFlow.msgScrollOffset = start
  return all.slice(start, start + CC_LIST_VISIBLE).join('\n')
}

/** Claude Code 承認/質問への応答画面 */
function buildCcResponseView(): string {
  if (!claudePending) return '(no pending)'
  const lines: string[] = []
  // 「カーソル行に対応する全行配列上の index」と「最初のカーソル可能行の index」を記録。
  // 最後のスクロール窓計算で、カーソルが最初の選択肢に戻ったらヘッダから見せるために使う。
  let cursorLineIdx = -1
  let firstCursorLineIdx = -1
  const qIdx = flowQIdx()
  const cursor = flowCursor()
  if (claudePending.kind === 'permission') {
    // ツール名はヘッダ (buildG2Header) に出しているので本文では繰り返さない。
    // 7 行しかない窓を選択肢と要約に使い切るため。
    // 要約はポーリング/カーソル移動のたびに組み直されるので、用件単位のキャッシュを使う
    const summary = toolInputSummaryFor(claudePending).slice(0, CHAT_WRAP_WIDTH * 3)
    if (summary) {
      lines.push(summary)
      lines.push('')
    }
    const opts = ['Allow', 'Deny']
    for (let i = 0; i < opts.length; i++) {
      if (i === 0) firstCursorLineIdx = lines.length
      if (i === cursor) cursorLineIdx = lines.length
      lines.push((i === cursor ? '▶ ' : '  ') + opts[i])
    }
    return applyCcScrollWindow(lines, cursorLineIdx, firstCursorLineIdx)
  }
  // question kind: 複数質問対応
  const questions = claudePending.questions ?? []
  const totalQ = questions.length
  if (totalQ === 0) return '(question is empty)'
  const q = questions[qIdx]
  if (!q) return '(question is empty)'
  // 1 行目は質問文の抜粋だけ。質問番号 (i/n) と [複数] バッジはヘッダ側で出しているので
  // ここでは付けない (同じ情報を 2 か所に出すと、狭い窓がさらに削られる)。
  // 抜粋の長さは従来と同じ幅予算 (1 行に収まる長さ) を維持する。
  lines.push(q.question.slice(0, CHAT_WRAP_WIDTH - 12))
  lines.push('')
  // 行構成: predefined options → (multi のみ) Submit → Type something → Chat about this
  const opts = q.options ?? []
  const builtAnswer = flowAnswers()[qIdx]
  for (let i = 0; i < opts.length; i++) {
    const marker = i === cursor ? '▶' : ' '
    let check = ''
    if (q.multiSelect) {
      const sel = builtAnswer?.kind === 'predefined' ? builtAnswer.options ?? [] : []
      check = sel.includes(opts[i].label) ? '[X] ' : '[ ] '
    } else {
      const sel = builtAnswer?.kind === 'predefined' ? builtAnswer.option : undefined
      check = sel === opts[i].label ? '● ' : '○ '
    }
    if (i === 0) firstCursorLineIdx = lines.length
    if (i === cursor) cursorLineIdx = lines.length
    lines.push(`${marker} ${check}${opts[i].label}`)
  }
  let extraIdx = opts.length
  if (q.multiSelect) {
    const m = extraIdx === cursor ? '▶' : ' '
    if (extraIdx === cursor) cursorLineIdx = lines.length
    // 0 件のまま Submit しても確定できないので、その旨をこの行自体に出す
    // (フッターは multi 用の操作案内で埋まっている)。
    const selected = builtAnswer?.kind === 'predefined' ? builtAnswer.options ?? [] : []
    const hint = selected.length === 0 ? ` ${t('submitNeedsPick')}` : ''
    lines.push(`${m} ${t('submitOption')}${hint}`)
    extraIdx++
  }
  {
    const m = extraIdx === cursor ? '▶' : ' '
    const built = builtAnswer?.kind === 'type-something' ? builtAnswer.text : ''
    if (extraIdx === cursor) cursorLineIdx = lines.length
    lines.push(`${m} T Type something${built ? ` (${built.slice(0, 16)}…)` : t('voiceInputBadge')}`)
    extraIdx++
  }
  {
    const m = extraIdx === cursor ? '▶' : ' '
    if (extraIdx === cursor) cursorLineIdx = lines.length
    lines.push(`${m} C Chat about this`)
  }
  return applyCcScrollWindow(lines, cursorLineIdx, firstCursorLineIdx)
}

/**
 * cc-response 画面の表示窓計算。全行が CC_LIST_VISIBLE 以下ならそのまま返す。
 * 超えたら rootlist と同じ「カーソル追従窓スライド」を適用 (cursor が窓外に出た時だけ最小限スライド)。
 * ただしカーソルが最初の選択肢にある場合は窓を 0 に戻し、ヘッダ(質問本文)が見えるようにする。
 */
function applyCcScrollWindow(lines: string[], cursorLineIdx: number, firstCursorLineIdx: number): string {
  const total = lines.length
  if (total <= CC_LIST_VISIBLE) {
    ccListStart = 0
    return lines.join('\n')
  }
  // カーソル位置がない場合 (受動的な表示) は末尾追従
  if (cursorLineIdx < 0) {
    ccListStart = total - CC_LIST_VISIBLE
    return lines.slice(ccListStart, ccListStart + CC_LIST_VISIBLE).join('\n')
  }
  // カーソルが最初の選択肢に居る間はヘッダから見せたいので 0 にスナップ
  if (cursorLineIdx <= firstCursorLineIdx) {
    ccListStart = 0
  } else if (cursorLineIdx < ccListStart) {
    ccListStart = cursorLineIdx
  } else if (cursorLineIdx >= ccListStart + CC_LIST_VISIBLE) {
    ccListStart = cursorLineIdx - CC_LIST_VISIBLE + 1
  }
  ccListStart = Math.max(0, Math.min(ccListStart, total - CC_LIST_VISIBLE))
  return lines.slice(ccListStart, ccListStart + CC_LIST_VISIBLE).join('\n')
}

/** 現在質問の行数(predefined + Submit (multiのみ) + Type something + Chat about this) */
function currentRespondRowCount(): number {
  if (!claudePending) return 0
  if (claudePending.kind === 'permission') return 2
  const q = claudePending.questions?.[flowQIdx()]
  if (!q) return 0
  return (q.options ?? []).length + (q.multiSelect ? 1 : 0) + 2
}

// summarizeToolInput の結果を用件 (pending.id) 単位でキャッシュする。
// なぜ: toolInput 全体の JSON 化 + 正規表現置換なので入力が大きいほど重く、
// cc-message / cc-response はポーリングやスクロールのたびに再描画される。
// 同じ pending なら toolInput も同じなので id をキーにできる (ccMessageLines と同じ方式)。
let toolSummaryCache = ''
let toolSummaryCacheKey = ''
function toolInputSummaryFor(pending: Pending): string {
  if (pending.id === toolSummaryCacheKey) return toolSummaryCache
  toolSummaryCache = summarizeToolInput(pending.toolInput)
  toolSummaryCacheKey = pending.id
  return toolSummaryCache
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input).replace(/[{}",]/g, ' ').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

/**
 * chatLinesCache の指紋。formatChatLines の出力を決めるのは各項目の role と text、
 * そして source (タグ表記) だけなので、それらだけを連結する。
 * 文字列連結は総文字数に比例するが、グリフ幅測定を伴う整形より桁違いに安い。
 */
function chatCacheKeyOf(items: ChatItem[], source: AgentSource | undefined): string {
  let key = String(source)
  for (const item of items) key += `${item.role}${item.text}`
  return key
}

/**
 * チャット項目を G2 レンズ用に整形。
 * 役割タグ ([YOU] / [Claude|Codex]) を独立行で挟み、タグの前に空行を入れる。
 * 生ログ (claudeChat) は書き換えず、表示時にこの関数で都度生成する。
 */
function formatChatLines(items: ChatItem[], maxWidthPx: number, source: 'claude' | 'codex' | undefined = currentAgentSource): string[] {
  const out: string[] = []
  for (const item of items) {
    const text = item.text.replace(/\r/g, '').trim()
    if (!text) continue
    const agentName = source === 'codex' ? 'Codex' : source === 'claude' ? 'Claude' : 'Agent'
    const tag = item.role === 'user' ? '[YOU]' : `[${agentName}]`
    if (out.length > 0) out.push('')  // タグの直前に空行を挟んで境目を強調
    out.push(tag)
    const paragraphs = text.split('\n')
    for (const para of paragraphs) {
      const wrapped = wrapText(para, maxWidthPx)
      for (const line of wrapped) out.push(line)
    }
  }
  return out
}

/**
 * text を maxWidthPx に収まるよう px 精度で折り返す。
 * G2 レンズの LVGL レンダラと同じ実グリフ幅 (getTextWidth, カーニング込み) で計測するので、
 * 「アプリが 1 行と思った行をレンズが勝手に再折り返しする」ズレが起きない。
 * 半角スペースを優先折り返し位置にし、無ければ任意文字境界でハードブレーク (日本語等)。
 *
 * 幅の増分はペアワイズ・カーニングが成立する (getTextWidth(s+c) は s 末尾と c の
 * ペアのみで決まる) ことを利用し、buf 全体を測り直さず O(1) で積算する。
 */
function wrapText(text: string, maxWidthPx: number): string[] {
  if (maxWidthPx <= 0 || getTextWidth(text) <= maxWidthPx) return [text || '']
  const out: string[] = []
  let buf = ''
  let bufW = 0
  let lastChar = ''       // buf の末尾文字 (カーニング増分計算用)
  let lastSpaceLen = -1   // 直近の空白直後の位置 (buf の code unit index)
  for (const ch of text) {
    // buf + ch の幅増分 = getTextWidth(末尾文字 + ch) - getTextWidth(末尾文字)
    const addW = lastChar
      ? getTextWidth(lastChar + ch) - getTextWidth(lastChar)
      : getTextWidth(ch)
    if (buf !== '' && bufW + addW > maxWidthPx) {
      if (lastSpaceLen >= 0) {
        // 直近の空白で折り返す
        out.push(buf.slice(0, lastSpaceLen).trimEnd())
        buf = buf.slice(lastSpaceLen).trimStart() + ch
      } else {
        // 空白が無いケース (日本語等) はハードブレーク
        out.push(buf)
        buf = ch
      }
      bufW = getTextWidth(buf)
      lastSpaceLen = -1
    } else {
      if (ch === ' ') lastSpaceLen = buf.length + 1  // 空白の直後で折り返したい
      buf += ch
      bufW += addW
    }
    lastChar = ch  // break / 追加どちらの分岐でも buf は ch で終わる
  }
  if (buf) out.push(buf)
  return out
}

/** text を px 幅 maxPx に収まる最長の接頭辞に切り詰める。切り詰めたかも返す。 */
function truncateToPx(text: string, maxPx: number): { s: string; truncated: boolean } {
  if (maxPx <= 0) return { s: '', truncated: text.length > 0 }
  if (getTextWidth(text) <= maxPx) return { s: text, truncated: false }
  let buf = ''
  let last = ''
  for (const ch of text) {
    const addW = last ? getTextWidth(last + ch) - getTextWidth(last) : getTextWidth(ch)
    if (getTextWidth(buf) + addW > maxPx) return { s: buf, truncated: true }
    buf += ch
    last = ch
  }
  return { s: buf, truncated: false }
}

/** rootlist 1 行に、名前行の残り幅までプレビューを付ける (レンズ幅で折り返さないよう px で切る)。 */
function appendRootPreview(prefix: string, preview: string | undefined): string {
  const p = (preview ?? '').replace(/\s+/g, ' ').trim()
  if (!p) return prefix
  const sep = ' '
  const avail = CHAT_WRAP_PX - getTextWidth(prefix + sep)
  const ellipsisW = getTextWidth('…')
  if (avail <= ellipsisW) return prefix // プレビューを置く余地が無い (名前が長い等)
  if (getTextWidth(p) <= avail) return prefix + sep + p
  const { s } = truncateToPx(p, avail - ellipsisW)
  return s ? prefix + sep + s + '…' : prefix
}

/** chat 行配列を scrollOffset を考慮して n 行 window する */
function chatWindow(lines: string[], n: number): string[] {
  if (lines.length === 0) return []
  const total = lines.length
  const end = Math.max(n, total - scrollOffset)
  const start = Math.max(0, end - n)
  return lines.slice(start, end)
}

/** Lens 用: scrollOffset を考慮した表示ウィンドウ */
function lensWindow(text: string, n: number): string {
  const lines = normalizeOutput(text)
  if (lines.length === 0) return ''
  const total = lines.length
  // 末尾から scrollOffset 行戻った位置を「ウィンドウの下端」にする
  const end = Math.max(n, total - scrollOffset)
  const start = Math.max(0, end - n)
  return lines.slice(start, end).join('\n')
}

/**
 * 現在の status に対応する chat 末尾の待機行。idle / 不明なら null。
 * サーバも同義の英語行を chat に合成してくるが、そちらは synthetic として捨て、
 * 表示はここで作る (言語設定に追従させるため)。ドットのアニメーションは再現しない。
 */
function chatStatusLine(): string | null {
  // 回答待ちが実在する間は、その告知をヘッダのバナー (buildG2Header) に一本化する。
  // 本文末尾にも出すと、同じことをスクロールしても消えないヘッダと本文の 2 か所で
  // 言うことになり、狭い窓が 1 行無駄になる。busy (考え中) は従来どおり本文に出す。
  if (claudePending && (claudeChatStatus === 'waiting-permission' || claudeChatStatus === 'waiting-question')) {
    return null
  }
  switch (claudeChatStatus) {
    case 'busy':               return t('chatStatusThinking')
    case 'waiting-permission': return t('chatStatusWaitPerm')
    case 'waiting-question':   return t('chatStatusWaitQ')
    default:                   return null
  }
}

// 送達未確認の注意行 (レンズ幅で折り返し済み)。文言が変わらない限り測り直さない。
let deliveryWarnLinesCache: string[] = []
let deliveryWarnLinesCacheKey = ''

/**
 * 「送ったのに届いていないようだ」の注意行。
 *
 * 画面ブロック中はヘッダ (buildG2Header) が同じことを既に伝えているので出さない。
 * 届かない原因は同じ (画面が塞がっている) で、狭いレンズで二度言う価値が無い。
 */
function deliveryWarningLines(): string[] {
  if (!claudeDeliveryWarning || currentSessionBlocked()) return []
  const text = t('chatDeliveryUnconfirmed')
  if (text !== deliveryWarnLinesCacheKey) {
    deliveryWarnLinesCache = wrapText(text, CHAT_WRAP_PX)
    deliveryWarnLinesCacheKey = text
  }
  return deliveryWarnLinesCache
}

// chatLinesForDisplay の結果キャッシュ。(chatLinesCache, 末尾に足す行) の組が変わった
// 時だけ作り直す。なぜ: 毎回 [...chatLinesCache, ...] を組むと、スクロールの 1 tick ごとに
// 会話全体ぶんの配列コピー (O(n)) が走り、会話が長いほどスクロールが重くなる。
// chatLinesCache は常に丸ごと差し替えられる (要素を書き換えない) ので、参照一致で判定できる。
let chatDisplayCache: string[] = []
let chatDisplayCacheSource: string[] | null = null
let chatDisplayCacheStatus: string | null = null

/** 末尾に足す行 (待機行 → 送達未確認の注意)。注意は最下段 = いちばん目に入る位置に置く。 */
function chatTailLines(): string[] {
  const status = chatStatusLine()
  const warn = deliveryWarningLines()
  if (!status) return warn
  return warn.length === 0 ? [status] : [status, ...warn]
}

/** 表示用の chat 行配列 = 整形済みキャッシュ + (あれば) 末尾の待機行 / 注意行 */
function chatLinesForDisplay(): string[] {
  const tail = chatTailLines()
  const key = tail.join('\n')
  if (chatDisplayCacheSource === chatLinesCache && chatDisplayCacheStatus === key) {
    return chatDisplayCache
  }
  chatDisplayCache = tail.length > 0 ? [...chatLinesCache, ...tail] : chatLinesCache
  chatDisplayCacheSource = chatLinesCache
  chatDisplayCacheStatus = key
  return chatDisplayCache
}

/** 表示用 chat の行数だけが要る呼び出し用。配列を組まずに数える (スクロール中に毎 tick 呼ばれる)。 */
function chatDisplayCount(): number {
  return chatLinesCache.length + chatTailLines().length
}

function maxChatScrollOffset(): number {
  return Math.max(0, chatDisplayCount() - chatDisplayLines())
}

/** 末尾突き合わせで使う行数。これだけ一致すれば同じ位置と見なす。 */
const TAIL_MATCH_PROBE = 8

/**
 * 旧表示行列と新表示行列を末尾で突き合わせ、「末尾に何行足されたか」を返す。
 * 負なら末尾から減った行数。一致が見つからない (内容が総取っ替え) なら null。
 *
 * なぜ「差し引きの行数」ではなく「末尾の増減」なのか:
 * scrollOffset は「末尾から何行戻ったか」なので、読んでいる位置が動くのは
 * 末尾が動いた時だけ。tail 窓の先頭から古い行が落ちても末尾は動かないので、
 * 基準は 1 行も動かしてはいけない。総行数の差 (旧コード) だと、先頭の脱落を
 * 末尾の減少と取り違えて、読んでいる位置が脱落したぶんだけ末尾方向へ滑る。
 *
 * 探索範囲に上限は設けない (行数で自然に有界)。以前は 64 行で打ち切っていたが、
 * 長い返答が一度に届くと「一致は必ず存在するのに見つからない」= 総取っ替え扱いに
 * なり、読んでいた位置が据え置き + クランプで飛んでいた。
 */
function tailAppendedLines(prev: string[], next: string[]): number | null {
  if (prev.length === 0) return next.length
  const limit = Math.max(prev.length, next.length)
  // ズレの小さい順に試す (最小の説明を採る)。d>0 = 末尾に追記、d<0 = 末尾から減少。
  for (let mag = 0; mag <= limit; mag++) {
    for (const d of mag === 0 ? [0] : [mag, -mag]) {
      // d ぶんズラした時に重なる「末尾」の位置
      const a = next.length - Math.max(d, 0)
      const b = prev.length + Math.min(d, 0)
      const probe = Math.min(TAIL_MATCH_PROBE, a, b)
      if (probe <= 0) continue
      let ok = true
      for (let i = 1; i <= probe; i++) {
        if (next[a - i] !== prev[b - i]) { ok = false; break }
      }
      if (ok) return d
    }
  }
  return null
}

function isScrolled(): boolean {
  return scrollOffset > 0
}

function scrollBack(): void {
  if (phase !== 'idle') return
  if (maxChatScrollOffset() === 0) return
  scrollAnimPending += scrollLinesPerGesture()
  startScrollAnimation()
}

function scrollForward(): void {
  if (phase !== 'idle') return
  if (scrollOffset === 0 && scrollAnimPending <= 0) return
  scrollAnimPending -= scrollLinesPerGesture()
  startScrollAnimation()
}

/**
 * scroll アニメ終了時に延期された full render を発火する。
 *
 * 待機枠 (g2RenderPending) はここでは絶対に消さない。以前は「枠を消してから
 * refreshG2 を呼び直す」形だったが、refreshG2 はスロットル / bridge 無し /
 * プラグイン遷移中に bail するので、bail した回の描画要求がそのまま消えていた
 * (スクロールを止めた瞬間の画面が古いまま残る)。枠は残したままポンプに取りに
 * 行かせ、実際にクリアするのはポンプが送信を始める時だけにする。
 */
function flushDeferredRender(): void {
  g2RenderDeferredAt = null
  if (!g2RenderPending) return
  // 今は送れない状況。待機枠を残しておけば、送れるようになった次の要求で一緒に出る。
  if (!bridge || pluginNavBlocksG2Render) return
  void pumpG2Sends()
}

/** 1 行ずつ scrollOffset を進めるアニメーションループ。
 *  scrollAnimPending を 0 に向けて消化する。新たに scroll イベントが来たら自動で延長される。
 *  refreshG2 を await することで SDK レンダリングを 1 行ごとに必ず確定させる
 *  (await しないと SDK 側でフレームが coalesce されて一括スクロールに見える)。
 *  スクロール速度が 0 の時はアニメーションせず、pending を一括消化して 1 回だけ再描画する。 */
function startScrollAnimation(): void {
  if (scrollAnimTimer) return  // 既に走っているなら何もしない (pending が増えただけ)
  // 速度 0: アニメ無し。目的位置へ一気に移動して content 更新も 1 回だけ。
  if (scrollAnimTickMs() <= 0) {
    if (phase !== 'idle') { scrollAnimPending = 0; return }
    const next = Math.max(0, Math.min(maxChatScrollOffset(), scrollOffset + scrollAnimPending))
    scrollAnimPending = 0
    if (next !== scrollOffset) {
      scrollOffset = next
      sendContentDirect(buildG2Content())
    }
    return
  }
  const tick = async (): Promise<void> => {
    scrollAnimTimer = null
    if (phase !== 'idle') { scrollAnimPending = 0; scrollAnimActive = false; flushDeferredRender(); return }
    let changed = false
    if (scrollAnimPending > 0) {
      const max = maxChatScrollOffset()
      const next = Math.min(max, scrollOffset + 1)
      if (next !== scrollOffset) { scrollOffset = next; changed = true }
      scrollAnimPending--
    } else if (scrollAnimPending < 0) {
      const next = Math.max(0, scrollOffset - 1)
      if (next !== scrollOffset) { scrollOffset = next; changed = true }
      scrollAnimPending++
    }
    if (changed) {
      const content = buildG2Content()
      // pending を使い切った = これが着地点のコマ。直列路 (待機枠) に載せて
      // 「最後のコマは必ず届く」保証を維持する。途中のコマは投げっぱなしにして、
      // レンズの完了待ちで間引かれないようにする (sendScrollFrameLoose 参照)。
      if (scrollAnimPending === 0) sendContentDirect(content)
      else sendScrollFrameLoose(content)
    }
    if (scrollAnimPending !== 0) {
      scrollAnimTimer = setTimeout(() => { void tick() }, scrollAnimTickMs())
    } else {
      // アニメーション終了 — 延期された full render があれば発火する
      scrollAnimActive = false
      flushDeferredRender()
    }
  }
  scrollAnimActive = true
  scrollAnimTimer = setTimeout(() => { void tick() }, scrollAnimTickMs())
}

function resetScroll(): void {
  scrollOffset = 0
}

/** 現在の cc-response 質問が multi-select か? */
function currentRespondQuestionIsMulti(): boolean {
  const q = claudePending?.questions?.[flowQIdx()]
  return !!q?.multiSelect
}

/** 現在のカーソル行が Type something か? */
function currentRespondRowIsTypeSomething(): boolean {
  if (!claudePending) return false
  const q = claudePending.questions?.[flowQIdx()]
  if (!q) return false
  const optsCount = (q.options ?? []).length
  // rows: 0..N-1=predefined, N=submit(multi only), N+s=Type something, last=Chat about this
  const submitOffset = q.multiSelect ? 1 : 0
  return flowCursor() === optsCount + submitOffset
}

function buildG2Footer(): string {
  switch (phase) {
    case 'rootlist': {
      // 分母はカーソルが動ける行数 (プラグイン行を含む)。セッション数だと
      // プラグインを足したぶんだけ「22/21」のようにズレる。
      const rows = rootRows().length
      if (rows === 0) return t('g2NoSessionsBrief')
      return `${t('g2FootRoot')} (${resolveRootCursorIndex() + 1}/${rows})`
    }
    case 'cc-message': {
      // 送信に失敗した直後は、その事実と再試行の案内を最優先で出す
      if (respondFlow?.error) return respondFlow.error
      // 収まりきらない本文はスクロールで読む。今どこまで読んだかを rootlist と同じ書式で出す
      const total = ccMessageLines().length
      if (total <= CC_LIST_VISIBLE) return t('g2FootCcMessage')
      const shownEnd = Math.min(total, flowMsgScroll() + CC_LIST_VISIBLE)
      return `${t('g2FootCcMessage')} (${shownEnd}/${total})`
    }
    case 'cc-response':
      if (respondFlow?.error) return respondFlow.error
      // multi-select 中の Submit 行を強調するため、multi-select 質問のときは別文言
      if (currentRespondQuestionIsMulti()) return t('g2FootCcRespMulti')
      return t('g2FootCcResponse')
    case 'recording': {
      // cc-response の Type something で録音中なら専用文言
      const base = recordingIsForRespond() ? t('g2FootCcRespRec') : t('g2FootRecOff')
      // 遡って読んでいる間は戻り行数を出す (idle の chat と同じ表記)
      return recordingScrollOffset > 0 ? `${base}  (-${recordingScrollOffset})` : base
    }
    case 'finalizing':    return t('g2FootFinalizing')
    case 'pending':       return t('g2FootPending')
    case 'sending':       return t('g2FootSending')
    case 'unconfigured':  return t('g2FootSetup')
    case 'idle':
      // スクロール中も通常と同じ表記。戻り行数だけ末尾に付加する
      // pending があるなら「タップ:応答」用のフッターを出す
      if (claudePending) {
        if (isScrolled()) return `${t('g2FootIdlePending')}  (-${scrollOffset})`
        return t('g2FootIdlePending')
      }
      if (isScrolled()) return `${t('g2FootIdle')}  (-${scrollOffset})`
      return t('g2FootIdle')
    default: return ''
  }
}

/** 今開いているセッションが画面ブロック中か (一覧の最新の取得結果から見る) */
function currentSessionBlocked(): boolean {
  const name = settings.sessionName
  if (!name) return false
  return claudeSessions.some((s) => s.tmuxSessionName === name && s.screenBlocked === true)
}

/** G2 レンズ最上段に表示する「現在の画面/フェーズ」のタイトル文字列 */
function buildG2Header(): string {
  switch (phase) {
    case 'boot':         return t('g2HeadBoot')
    case 'unconfigured': return t('g2HeadSetup')
    case 'rootlist':     return t('g2HeadRoot')
    // 時間制限が無いのでカウントダウンはしない。代わりに経過秒をカウントアップする。
    case 'recording':    return `${t('g2HeadRecording')}  ${getRecordingSeconds().toFixed(1)}s`
    case 'finalizing':   return t('g2HeadFinalizing')
    case 'pending': {
      const n = pendingSentences.length
      return n > 1 ? `${t('g2HeadPending')} (${n})` : t('g2HeadPending')
    }
    case 'sending':      return `${t('g2HeadSending')} → ${settings.sessionName || ''}`.slice(0, 56)
    // メッセージ閲覧と選択肢は同じ用件の 2 画面なのでヘッダは共通。
    // 本文の窓 (7 行) を本題だけに使いたいので、ツール名・質問番号・multi バッジは
    // スクロールしない ここ で出す。
    case 'cc-message':
    case 'cc-response': {
      if (!claudePending) return t('g2HeadCcResponse')
      if (claudePending.kind === 'permission') {
        return t('approveTool').replace('{name}', claudePending.toolName).slice(0, 56)
      }
      const questions = claudePending.questions ?? []
      const q = questions[flowQIdx()]
      // 単一質問でも (1/1) を出す (2 画面で番号の見え方を揃える)
      const num = questions.length > 0 ? ` (${flowQIdx() + 1}/${questions.length})` : ''
      const badge = q?.multiSelect ? t('multiBadge') : ''
      return `${t('g2HeadCcResponse')}${num}${badge}`.slice(0, 56)
    }
    case 'error':        return t('g2HeadError')
    case 'idle': {
      // 回答待ちがあるなら、スクロールしても消えないヘッダで知らせる
      if (claudePending) {
        const isQ = claudePending.kind === 'question'
        const head = `${isQ ? '?' : '⏸'} ${isQ ? t('claudeStatusWaitQ') : t('claudeStatusWaitPerm')}`
        return `${head}　${settings.sessionName || ''}`.slice(0, 56)
      }
      // 画面が塞がっているなら、スクロールしても消えないヘッダで知らせる
      // (フッタは操作の案内なので変えない)
      if (currentSessionBlocked()) {
        return `${t('g2HeadBlocked')}　${settings.sessionName || ''}`.slice(0, 56)
      }
      return settings.sessionName || t('appName')
    }
    default:             return t('appName')
  }
}

// ─── G2 レンダリング直列化 (送信背圧) ──────────────────────────────────
// レンズへの送信は、スクロールアニメの中間コマ 1 つを除いて、この 1 本の直列路
// (pumpG2Sends) を通す。唯一の例外は sendScrollFrameLoose (指を動かしている間だけ
// 発生する有限個のコマ) で、そちらは直列路の会計 (g2SendLock / 待機枠) に一切
// 参加せず、専用のカウンタ g2LooseScrollInFlight で別勘定にしてある。
//
// なぜ背圧が要るか:
//   SDK ブリッジは呼ばれたぶんだけフレームを内部キューに積むが、実際に消化できる
//   速度は BLE 側で決まる。アプリが消化速度を超えて投げ続けると未処理が単調に
//   増え続け、レンズ表示が操作から数十秒遅れる。長時間使うほど遅延が伸びるので
//   「使い続けると全体が重くなる」という体感になる。送信レートを消化レートに
//   律速する = 背圧を掛けるしか止める手が無い。
//
// 経緯:
//   cc3286d で content-only 送信を latest-wins に coalesce したが、d13bc26 で
//   「フレームが飛んでカクつく」と判断して fire-and-forget に戻した。その後
//   6153e41 の計測で、fire-and-forget では滞留がピーク 1198 フレーム / 1 フレームの
//   完了に 97 秒かかることが判明した (背圧ありでは 2 フレーム / 0.2 秒)。
//   カクつきの実体は「送りすぎて遅れていた」側だったため、背圧を正式に戻す。
//
// 構造:
//   g2SendLock … ブリッジへ送信中か。全経路共通の唯一の相互排他で、
//                どの瞬間も SDK への in-flight は高々 1 本。
//   待機枠は 2 つだけ。どちらも latest-wins で、古い要求は捨てる:
//     full render (header+content+footer) … g2RenderPending / g2RenderPendingForce
//     content-only (スクロール 1 行送り)  … g2ContentQueued
//   送信が終わるたびポンプが待機枠から次の 1 件を取り出す。アプリ内の待機も
//   高々 1 件なので、どれだけ速く要求が来ても構造的に滞留が起きない。
//   full render は content も送り直すので、実行時に content-only の待機枠は捨てる。
//   スクロールアニメの着地点 (最後のコマ) もこの待機枠を通るので、必ず届く。
/** レンズ 1 画面ぶんのスナップショット (同じ状態から組んだ 3 コンテナの内容)。 */
type G2Frame = { header: string; content: string; footer: string }

let g2SendLock = false            // ブリッジ送信中 (全経路共通の in-flight フラグ)
let g2RenderPending = false       // full render の待機枠 (latest-wins)
let g2RenderPendingForce = false  // 待機要求の force を OR で蓄積
// 待機中の full render に添えられたスナップショット (無ければ実行時に組み直す)。
// なぜ: 「変化したか」の判定で既に 3 つとも組んでいる場合、それをそのまま描けば
// 二重ビルドが消え、判定した内容と実際に描く内容が必ず一致する。
let g2RenderPendingFrame: G2Frame | null = null
let g2RenderDeferredAt: number | null = null  // scroll 中の full render 延期開始時刻
let g2ContentQueued: string | null = null     // content-only の待機枠 (latest-wins)

/** scroll アニメ中に full render を延期できる上限 (ms)。超えたら安全弁として実行する。 */
const G2_RENDER_DEFER_MAX_MS = 2000

// プラグイン遷移中はレンズを headlenss の内容で塗り替えない。
// なぜ: openG2Plugin は「接続中」を出してから遷移するが、その間もポーリング
// (reloadClaudeSessions / reloadSessions / refreshClaudeData) は完了ごとに
// refreshG2(true) を要求してくるので、放っておくと接続中表示が一覧で上書きされる。
// 解除するのは cancelPluginNavigation だけ (ダブルタップでの中止 / 取り込み失敗時の復帰)。
// 取り込み (performTakeover) やトップレベル遷移まで進んだ場合は、以降 headlenss の画面を
// 出す理由が無いので立てたままにする。
let pluginNavBlocksG2Render = false

/** 最後に実際にレンズへ送信した時刻 (performance.now)。低頻度の強制再同期の基準。 */
let g2LastSentAt = performance.now()
/** 無変更スキップで取りこぼしたフレームを自己修復するための強制再同期間隔 (ms)。 */
const G2_FORCED_RESYNC_MS = 15000

/**
 * 「変化が無くても 1 回描き直すべきか」。
 * なぜ: 無変更スキップを入れたことで、1.5 秒ごとの無条件再送という自己修復が消えた。
 * ホスト側がフレームを取りこぼすとレンズが古いまま永久に直らないので、送信が
 * 途絶えて G2_FORCED_RESYNC_MS 経ったら dedup 基準を捨てて 1 回だけ通す。
 */
function isForcedResyncDue(): boolean {
  // そもそも送れない状況 (ブリッジ無し / プラグイン遷移中) では起点も進まないので数えない
  if (!bridge || pluginNavBlocksG2Render) return false
  return performance.now() - g2LastSentAt >= G2_FORCED_RESYNC_MS
}

// 直近でレンズへ送った (= 送信を予約した) 各コンテナの内容。同一なら送らない。
// ポーリング由来の再描画要求も、この 3 つと突き合わせて変化が無ければ丸ごと捨てる
// (g2FrameWouldChange 参照)。dedup の基準はここ 1 箇所だけに持つ。
let g2ContentLastSent: string | null = null
let g2HeaderLastSent: string | null = null
let g2FooterLastSent: string | null = null

/** 送信済みマークを取り消す。送信に失敗した内容が「送った」ままだと再送されないため。 */
function invalidateG2Dedup(): void {
  g2ContentLastSent = null
  g2HeaderLastSent = null
  g2FooterLastSent = null
}

/**
 * いま full render を実行してよいか (true = 延期する)。
 * scroll アニメ中は content-only で足りるので full render を先送りし、
 * アニメ終了時に flushDeferredRender から発火させる。長期ブロックを防ぐため
 * G2_RENDER_DEFER_MAX_MS の安全弁を持つ。
 */
function isFullRenderDeferred(now: number): boolean {
  // 判定はタイマーではなく明示フラグで行う (tick が送信前にタイマーを null に戻すため)。
  // speed-0 パスはアニメを回さないのでフラグが立たない → 延期しない。
  if (!scrollAnimActive) {
    g2RenderDeferredAt = null
    return false
  }
  if (g2RenderDeferredAt === null) {
    g2RenderDeferredAt = now
    console.log('[refreshG2] deferred: scroll anim active')
  }
  if (now - g2RenderDeferredAt < G2_RENDER_DEFER_MAX_MS) return true
  // 安全弁: 延期しすぎ — 解除して実行させる
  console.log(`[refreshG2] safety valve: deferred >${G2_RENDER_DEFER_MAX_MS}ms, executing`)
  g2RenderDeferredAt = null
  return false
}

/**
 * レンズ本文の更新 (content コンテナのみ) を直列路へ載せる。
 * 使うのはスクロールアニメの着地点 (最後のコマ) と速度 0 の一括ジャンプ。
 * 送信中なら待機枠に置くだけで、待機枠は常に最新で上書きされる (古い要求は捨てる)。
 * 送信そのものはポンプが直列に行うので、ここから SDK へ直接投げることはない。
 * スクロールの中間コマはこちらではなく sendScrollFrameLoose を通る。
 */
function sendContentDirect(content: string): void {
  if (content === g2ContentLastSent) return
  g2ContentLastSent = content
  g2ContentQueued = content
  // スクロールは refreshG2 を通さずに表示状態 (scrollOffset) を動かす唯一の経路なので、
  // 待機中の full render のスナップショットはここで古くなる。捨てて実行時に組み直させる。
  g2RenderPendingFrame = null
  void pumpG2Sends()
}

/** 投げっぱなしで送ったスクロールコマのうち、まだ完了していない本数 (直列路の会計とは別勘定)。 */
let g2LooseScrollInFlight = 0
/**
 * 投げっぱなしを許す上限 = ジェスチャー 1 回ぶんのコマ数。
 *
 * 1 ジェスチャーが出す中間コマは高々 scrollLinesPerGesture - 1 本 (最後の 1 本は
 * 直列路) なので、単発のジェスチャーでこの上限に当たることはない。当たるのは
 * 「レンズが遅くて前のジェスチャーぶんがまだ捌けていないのに次を連打した」時だけで、
 * その時は中間コマを捨てて滞留をジェスチャー 1 回ぶんに頭打ちにする
 * (捨てても着地点は直列路で必ず届くので、表示が迷子になることはない)。
 * これが「投げっぱなしでも溜まり続けない」ことの担保。
 */
function looseScrollMaxInFlight(): number {
  return scrollLinesPerGesture()
}

/**
 * スクロールアニメの中間コマを、待機枠 (背圧) を通さずレンズへ直接投げる。
 *
 * なぜ直列路を通さないか:
 *   直列路は latest-wins なので、レンズ 1 回の送信にかかる時間より tick が短いと
 *   中間コマが丸ごと捨てられる。7 行スクロールが 2〜3 コマに落ちて「飛んだ」ように
 *   見えるカクつきの正体はこれ。even-jp / greensky はスクロールを含む全送信を
 *   投げっぱなし (ロック・間引きなし) で実機運用していて滑らかなので、滑らかさの
 *   条件は「中間コマを捨てないこと」だと判断し、スクロールアニメの tick 由来の
 *   content 送信だけを同じ扱いにする。
 *
 * なぜ全経路を投げっぱなしに戻さないか:
 *   ポーリング由来の full render まで投げっぱなしにすると、無操作でも 1.5 秒ごとに
 *   供給が続くので未処理が単調に増え、長時間使うほど表示が遅れる (背圧を入れた元の
 *   理由)。ここで投げるのは「指を動かしている間だけ」「1 ジェスチャーあたり高々
 *   scrollLinesPerGesture コマ」なので、溜まる量の上限がジェスチャー 1 回ぶんに閉じる。
 *   指を止めれば供給も止まり、レンズが追いつけば必ず空になる = 蓄積し続けない。
 *
 * 順序: ブリッジは呼ばれた順に処理するので、投げっぱなしのコマと直列路の送信が
 * 混ざっても「呼び出し順 = 反映順」は保たれる。
 */
function sendScrollFrameLoose(content: string): void {
  if (content === g2ContentLastSent) return
  // 安全弁: レンズが遅すぎて投げっぱなし分が捌けていない。中間コマなので捨ててよい
  // (g2ContentLastSent を進めないので、同じ内容が後で必要になれば送り直される)。
  if (g2LooseScrollInFlight >= looseScrollMaxInFlight()) return
  g2ContentLastSent = content
  // スクロールは refreshG2 を通さずに scrollOffset を動かすので、待機中の full render の
  // スナップショットはここで古くなる (sendContentDirect と同じ理由)。
  g2RenderPendingFrame = null
  g2LooseScrollInFlight++
  void updateContent(content).then(
    () => { g2LooseScrollInFlight-- },
    (err) => {
      g2LooseScrollInFlight--
      // 送れていない内容を送信済みにしない (次の要求で送り直させる)
      if (g2ContentLastSent === content) g2ContentLastSent = null
      log(`G2 scroll frame error: ${err}`)
    },
  )
}

/**
 * レンズ送信路のポンプ。待機枠が空になるまで 1 件ずつ、必ず完了を待って送る。
 * g2SendLock を握れなかった呼び出しは即座に戻る (握っている側が解放時に呼び直す)。
 */
async function pumpG2Sends(): Promise<void> {
  if (g2SendLock) return  // 誰かが送信路を握っている。解放時に必ずここが再度呼ばれる
  g2SendLock = true
  try {
    for (;;) {
      // full render を優先する (content-only より新しい状態を丸ごと反映するため)
      if (g2RenderPending && !isFullRenderDeferred(performance.now())) {
        const force = g2RenderPendingForce
        const frame = g2RenderPendingFrame
        g2RenderPending = false
        g2RenderPendingForce = false
        g2RenderPendingFrame = null
        // full render は content も送り直すので、待機中の content-only は用済み
        g2ContentQueued = null
        await executeFullRender(force, frame)
        continue
      }
      const content = g2ContentQueued
      if (content === null) break  // full render が延期中ならここで抜ける (アニメ終了時に再開)
      g2ContentQueued = null
      try {
        await updateContent(content)
        // ここでは g2LastSentAt を進めない。強制再同期は「header/footer も含めて
        // 一度描き直す」ための時計で、content だけを送り続けるスクロール中に進めると
        // 期限が永久に来ず、取りこぼした header/footer が直らないため。
      } catch (err) {
        // ブリッジ側のタイムアウト/失敗。送れていない内容を送信済みにしない
        if (g2ContentLastSent === content) g2ContentLastSent = null
        log(`G2 content-direct error: ${err}`)
      }
    }
  } finally {
    // renderer 側の 5 秒タイムアウトが必ず reject/resolve を返すので、
    // ここに到達せずロックが漏れることはない
    g2SendLock = false
  }
}

/**
 * G2 レンズの全面更新 (header + content + footer) を要求する。
 * 実際の送信はポンプが直列に行い、実行中の要求は待機枠で latest-wins に畳まれる。
 * force=false の場合はスロットル (G2_REFRESH_THROTTLE_MS) が適用される。
 * frame を渡すと、実行時に組み直さずそのスナップショットを描く (呼び出し側が
 * 既に 3 つとも組んでいる場合用。判定と描画で内容がずれないようにする)。
 */
async function refreshG2(force = false, frame: G2Frame | null = null): Promise<void> {
  if (!bridge) {
    console.log('[refreshG2] bailed: no bridge')
    return
  }
  if (pluginNavBlocksG2Render) {
    // プラグイン遷移中。ここで弾かないとポーリング由来の再描画が「接続中」を上書きする
    console.log('[refreshG2] bailed: plugin navigation in progress')
    return
  }
  const now = performance.now()
  if (!force && now - g2RefreshLastAt < G2_REFRESH_THROTTLE_MS) {
    console.log(`[refreshG2] throttled (Δ=${(now - g2RefreshLastAt).toFixed(0)}ms)`)
    return
  }
  // 待機枠に積むだけ (latest-wins)。送信するかどうか/いつかはポンプが決める。
  g2RenderPending = true
  g2RenderPendingForce = g2RenderPendingForce || force
  // スナップショットも latest-wins。添えずに要求された場合は「今の状態で組み直す」が
  // 正しいので、古いスナップショットは必ず捨てる。
  g2RenderPendingFrame = frame
  await pumpG2Sends()
}

/**
 * full render を 1 回だけ実行する。ポンプからのみ呼ぶ
 * (g2SendLock は呼び出し側が握っている前提)。
 */
async function executeFullRender(force: boolean, frame: G2Frame | null = null): Promise<void> {
  g2RefreshLastAt = performance.now()
  // ここで例外を外に出さない (ポンプのループを止めないため)。
  try {
    // header / content / footer を同期的に一括ビルド (同一 phase スナップショット)。
    // 呼び出し側が既に組んだスナップショットがあればそれを使う (二重ビルドの解消)。
    const { header, content, footer } = frame ?? buildG2Frame()
    console.log(`[refreshG2] firing (phase=${phase}, force=${force})`)
    // dedup 基準は「送れたもの」だけを 1 つずつ記録する: scroll tick とポーリング由来の
    // 再描画がこの 3 つと突き合わせる。3 つまとめて先に立てると、途中の await が失敗した
    // 時に「送っていない内容を送信済み」と記録したフレームが残る (catch の一括取り消しは
    // 逆に、送れていた分まで捨てて無駄な再送を生む)。
    await updateHeader(header)
    g2HeaderLastSent = header
    await updateContent(content)
    g2ContentLastSent = content
    await updateFooter(footer)
    g2FooterLastSent = footer
    g2LastSentAt = performance.now()  // 強制再同期の起点 (full render が通った時だけ更新する)
  } catch (err) {
    // ここで dedup 基準を一括で捨てる必要は無い: 失敗した時点より後の 3 つは
    // 更新していないので、次の要求で自然に送り直される。
    log(`G2 refresh error: ${err}`)
  }
}

/**
 * ポンプの待機枠に載らない特殊な送信 (ページ再構築 / プラグイン遷移前の告知) を、
 * 同じ送信路のロックを取ってから実行する。これで「ポンプ外の送信」も in-flight 1 本の
 * 制約に収まり、ポンプの送信と混ざらない。
 * ロック中は解放されるまで待つ (ドロップではなくキューイング)。
 */
async function runExclusiveG2Send(body: () => Promise<void>): Promise<void> {
  // ロック取得を待つ: 他の送信が完了するまでスピンしない Promise で待機
  while (g2SendLock) {
    await new Promise((r) => setTimeout(r, 16))
  }
  g2SendLock = true
  try {
    await body()
  } finally {
    g2SendLock = false
    // 溜まっていた待機枠 (full render / content-only) を流す
    void pumpG2Sends()
  }
}

/**
 * showScreen (rebuildPageContainer) をロック経由で呼ぶ。
 * boot / foreground 再入場 / 言語切替などページ全体再構築時に使う。
 */
async function sendShowScreen(header: string, content: string, footer: string): Promise<void> {
  await runExclusiveG2Send(async () => {
    // ページ全体を送り直すので、待機中の content-only は用済み。dedup 基準も更新する。
    g2ContentQueued = null
    g2HeaderLastSent = header
    g2ContentLastSent = content
    g2FooterLastSent = footer
    try {
      await showScreen(header, content, footer)
      g2LastSentAt = performance.now()
    } catch (err) {
      invalidateG2Dedup()
      throw err
    }
  })
}

/**
 * 現在の状態を送ったとき、前回送った内容から 1 つでも変わるか。
 *
 * ポーリングは成功のたびに全面更新を要求してくるが、内容が同じなら 3 フレームを
 * ブリッジへ流し込んでも表示は 1px も変わらない。無操作でも 1.5 秒ごとに供給が
 * 続くため、これがキューへの定常的な負荷源になっていた。変化の無いポーリング
 * 由来の要求はここで捨てる。ユーザ操作起因の描画はこのチェックを通さず即時に描く。
 */
function g2FrameWouldChange(frame: G2Frame): boolean {
  return frame.header !== g2HeaderLastSent
    || frame.content !== g2ContentLastSent
    || frame.footer !== g2FooterLastSent
}

/** 現在の状態から 3 コンテナぶんの内容を一度に組む (同一スナップショット)。 */
function buildG2Frame(): G2Frame {
  return { header: buildG2Header(), content: buildG2Content(), footer: buildG2Footer() }
}

// ─── Sessions ──────────────────────────────────────────────────────────
function renderSessionPills(): void {
  sessionPillsEl.innerHTML = ''
  if (!settings.serverBaseUrl) {
    sessionPillsEl.innerHTML = `<div class="muted small">${escapeHtml(t('pillSetServerUrl'))}</div>`
    return
  }
  if (!serverProbeOk) {
    sessionPillsEl.innerHTML = `<div class="muted small">${escapeHtml(t('pillServerDownPfx'))}${escapeHtml(serverErrorMsg) || '?'}</div>`
    return
  }
  if (lastSessions.length === 0) {
    sessionPillsEl.innerHTML = `<div class="muted small">${escapeHtml(t('pillNoSessions'))}</div>`
    return
  }
  for (const s of lastSessions) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'pill' + (s.name === settings.sessionName ? ' active' : '')
    btn.dataset.action = 'select'
    btn.dataset.name = s.name
    btn.innerHTML = `<span>${escapeHtml(s.name)}</span>` +
      `<span class="pill-kill" data-action="kill" data-name="${escapeAttr(s.name)}" aria-label="kill ${escapeAttr(s.name)}">✕</span>`
    sessionPillsEl.appendChild(btn)
  }
}

sessionPillsEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
  const name = target.closest<HTMLElement>('[data-name]')?.dataset.name
  if (!action || !name) return

  if (action === 'kill') {
    e.stopPropagation()
    void killSession(name)
    return
  }
  if (action === 'select') {
    if (settings.sessionName === name) return
    abortInFlightRefresh()
    settings.sessionName = name
    void persistSettings()
    claudeChat = []
    chatLinesCache = []
    chatLinesCacheKey = ''
    claudeChatStatus = undefined
    claudeDeliveryWarning = null
    claudeChatLoading = true
    // 前セッションの用件と作りかけの回答を捨てる (応答画面を開いていたら idle に戻る)。
    // recomputePhase は cc-* を「操作中」として抜けないので、先に phase を落としておく。
    resetRespondStateForSessionChange()
    renderSessionPills()
    recomputePhase()
    tmuxOutput = ''
    resetScroll()
    void refreshClaudeData()
    startOutputPolling()  // ポーリングタイマーをリセット
  }
})

reloadSessionsBtn.addEventListener('click', () => {
  void reloadSessions(true)
})

newSessionForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const name = newSessionInput.value.trim()
  if (!name) return
  void createAndSelectSession(name)
})

async function reloadSessions(verbose = false): Promise<void> {
  if (!settings.serverBaseUrl || !serverProbeOk) return
  try {
    lastSessions = await client.listSessions()
    if (verbose) log(`sessions: ${lastSessions.map((s) => s.name).join(', ') || '(none)'}`)
    if (lastSessions.length > 0 && !lastSessions.some((s) => s.name === settings.sessionName)) {
      if (isRespondFlowActive()) {
        // 応答フローの最中は自動切替を保留する。
        // なぜ: 回答を組んでいる最中に足元のセッションを差し替えると、作りかけの回答が
        // 捨てられて操作が消える。一覧に無いセッションを見ているだけなら実害は小さいので、
        // フローが終わった後の次回実行 (15 秒ごと) で切り替われば足りる。
        log('応答フロー中なのでセッションの自動切替を保留します')
      } else {
        abortInFlightRefresh()
        settings.sessionName = lastSessions[0].name
        void persistSettings()
        // 見ていたセッションが無くなって別セッションへ移った。前の用件は捨てる
        resetRespondStateForSessionChange()
      }
    }
    // rootlist のカーソル位置がオーバーランしないよう名前解決でクランプ
    resolveRootCursorIndex()
    renderSessionPills()
    paintStatus()
    if (phase === 'rootlist') void refreshG2(true)
  } catch (e) {
    log(`listSessions error: ${(e as Error).message}`)
  }
}

async function createAndSelectSession(name: string): Promise<void> {
  if (!settings.serverBaseUrl || !serverProbeOk) {
    log('cannot create session: server not reachable')
    return
  }
  try {
    await client.createSession(name)
    log(`created session: ${name}`)
    abortInFlightRefresh()
    settings.sessionName = name
    // 新しいセッションへ移った = 前セッションの用件と作りかけの回答は無効
    resetRespondStateForSessionChange()
    await persistSettings()
    newSessionInput.value = ''
    await reloadSessions()
    recomputePhase()
  } catch (e) {
    log(`createSession error: ${(e as Error).message}`)
  }
}

// ─── Claude Code セッション/チャット/承認待ち データ取得 ──────────────────
function setOutputDisplay(text: string, kind: 'ok' | 'muted' | 'err'): void {
  // dashboard 側のミラー欄。chat 表示用に再利用。
  tmuxOutputEl.textContent = text
  tmuxOutputEl.classList.toggle('muted', kind !== 'ok')
  tmuxOutputEl.classList.toggle('err', kind === 'err')
}

/** Claude Code 起動中の tmux session 一覧を取得 (rootlist 用) */
let reloadClaudeInFlight = false
async function reloadClaudeSessions(): Promise<void> {
  if (!serverProbeOk) {
    renderClaudeSessionsList()
    return
  }
  // 前回の応答待ち中は重ねて叩かない。サーバ応答が停滞した際に 1.5s 毎のポーリングで
  // 未解決リクエスト/プロミスが累積して重くなるのを防ぐ。タイムアウトで必ず解ける。
  if (reloadClaudeInFlight) return
  reloadClaudeInFlight = true
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const next = await client.listClaudeSessions(ctrl.signal)
    // rootlist に出る行が変わったかを、実際に描く行の並びで比較する。
    // セッションだけを見ていると、プラグイン行の増減 (dev server の起動/停止) を
    // 取りこぼす。取りこぼすとレンズは古い一覧のままなのにカーソルは新しい行配列で
    // 解決されるため、光っている行とタップで実行される行がズレる。
    const before = rootRowSignature()
    claudeSessions = next
    const changed = before !== rootRowSignature()
    // カーソルの指す行が消えた場合、キー解決内でクランプされる
    resolveRootCursorIndex()
    // WebView の一覧は毎回更新 (active 切り替えなど含む)
    renderClaudeSessionsList()
    // rootlist を見ている間は中身が変わったら即レンズ再描画
    if (changed && phase === 'rootlist') void refreshG2(true)
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') log(`listClaudeSessions error: ${(e as Error).message}`)
  } finally {
    clearTimeout(timeout)
    reloadClaudeInFlight = false
  }
}

/** 現在選択中セッションの chat と pending を取得 (idle / cc-response 用) */
async function refreshClaudeData(): Promise<void> {
  if (!serverProbeOk) {
    setOutputDisplay(`(server not reachable: ${serverErrorMsg || '?'})`, 'err')
    return
  }
  if (!settings.sessionName) {
    setOutputDisplay('(no session selected)', 'muted')
    return
  }
  // 前回の in-flight fetch を abort し、新しい AbortController を用意する
  abortInFlightRefresh()
  const ctrl = new AbortController()
  refreshAbortCtrl = ctrl
  // fetch 開始時点のセッション名を保持。完了時にセッションが切り替わっていたら結果を捨てる
  const targetSession = settings.sessionName
  try {
    const [chatResponse, pending] = await Promise.all([
      client.getClaudeChat(targetSession, ctrl.signal, 20),
      client.getClaudePending(targetSession, ctrl.signal),
    ])
    // ── セッション切替ガード: fetch 中にユーザがセッションを変えた場合は結果を破棄 ──
    if (settings.sessionName !== targetSession) return
    // サーバが状態表示用に合成した行 (synthetic) は捨てる。表示は status から
    // ローカライズして作り直す。ドット数が 500ms ごとに変わるので、素通しすると
    // 指紋が毎回変わって全文の再整形が走り続ける、という問題も同時に消える。
    const chat = chatResponse.chat.filter((c) => !c.synthetic)
    currentAgentSource = chatResponse.source ?? claudeSessions.find((s) => s.tmuxSessionName === targetSession)?.source
    // 差し替え前の表示行列 (待機行込み)。scrollback 中の繰り上げ量の計算に使う。
    // chatLinesCache は常に丸ごと差し替えられる (要素を書き換えない) ので、
    // ここで掴んだ配列は後の更新に影響されない = 旧状態のスナップショットになる。
    const prevDisplayLines = scrollOffset > 0 ? chatLinesForDisplay() : null
    // 取得内容が前回と同一なら整形をまるごと省く。無操作でもポーリングは 1.5 秒毎に
    // 走るので、ここを毎回計算すると会話が長いほどメインスレッドが埋まる。
    // source も鍵に含める (タグ表記が変わると整形結果も変わるため)。
    const nextCacheKey = chatCacheKeyOf(chat, currentAgentSource)
    if (nextCacheKey !== chatLinesCacheKey) {
      // 整形は取得時に1回だけ行い、描画/スクロールで使い回す (スクロール毎の全文再整形を回避)。
      // source を明示的に渡してタグずれを防ぐ。
      chatLinesCache = formatChatLines(chat, CHAT_WRAP_PX, currentAgentSource)
      chatLinesCacheKey = nextCacheKey
    }
    // 表示行数を測る前に、末尾の待機行を決める材料 (status と pending) を両方入れ替える。
    // 片方だけ新しい中間状態で測ると、待機行の有無が実際とは違う判定になり、
    // pending の出現/消滅のたびに読んでいる位置が 1 行ずれる。
    claudeChatStatus = chatResponse.status
    claudeDeliveryWarning = chatResponse.deliveryWarning ?? null
    claudePending = pending
    // chat: scrollback 中なら「末尾に増減したぶん」だけオフセットを補正して読み位置を保つ。
    //  - 追記 (新しい発言 / 待機行が出た)      → その行数ぶん繰り上げる
    //  - 末尾の減少 (待機行が消えた)           → その行数ぶん繰り下げる
    //    (増加時だけ繰り上げると busy⇔idle の往復でオフセットが片道ぶんずつ溜まる)
    //  - tail 窓の先頭からの脱落                → 末尾は動いていないので何もしない
    if (scrollOffset > 0) {
      const added = prevDisplayLines ? tailAppendedLines(prevDisplayLines, chatLinesForDisplay()) : 0
      // null = 内容が総取っ替えで対応が付かない。動かす根拠が無いので基準は据え置き。
      scrollOffset = Math.max(0, Math.min(maxChatScrollOffset(), scrollOffset + (added ?? 0)))
    }
    claudeChat = chat
    claudeChatLoading = false
    // 応答画面を開いている間に、対象の用件そのものが入れ替わっていないかを突き合わせる
    reconcileRespondPending()
    if (chat.length > 0) {
      const lastUser = [...chat].reverse().find((c) => c.role === 'user')?.text ?? ''
      const lastAssistant = [...chat].reverse().find((c) => c.role === 'assistant')?.text ?? ''
      setOutputDisplay(
        `${chat.length} messages\n` +
        (lastUser ? `> ${lastUser.slice(0, 200)}\n` : '') +
        (lastAssistant ? `${lastAssistant.slice(0, 200)}` : ''),
        'ok',
      )
      if (!outputFetchOkLogged) {
        log(`getClaudeChat ok: ${chat.length} items from "${targetSession}"`)
        outputFetchOkLogged = true
      }
    } else {
      setOutputDisplay(`(no chat yet for "${targetSession}")`, 'muted')
    }
    if (phase === 'idle' || phase === 'cc-message' || phase === 'cc-response') {
      // ポーリング由来の再描画は「表示が変わる時だけ」。変わらないのに 1.5 秒ごとに
      // 全面送信 (3 フレーム) を掛け続けると、レンズ側の消化が追いつかない環境では
      // それだけで滞留が育つ (g2FrameWouldChange 参照)。
      // ただし送信が途絶えて久しい場合は、取りこぼし対策として dedup を捨てて 1 回通す。
      if (isForcedResyncDue()) {
        console.log('[refreshG2] forced resync: no send for a while')
        invalidateG2Dedup()
        void refreshG2(true)
      } else {
        // 判定で組んだスナップショットをそのまま描画に渡す。組み直さないので
        // 「変化すると判定した内容」と「実際に描く内容」が必ず一致する。
        const frame = buildG2Frame()
        if (g2FrameWouldChange(frame)) void refreshG2(true, frame)
      }
      // chat を実際に取得して描画している = ユーザは見ている前提なので既読化
      markAsRead(targetSession)
    }
  } catch (e) {
    // AbortError はセッション切替による意図的キャンセルなので無視する
    if ((e as DOMException).name === 'AbortError') return
    // エラーでも現在セッション向けのフェッチならローディング解除
    if (settings.sessionName === targetSession) claudeChatLoading = false
    const msg = (e as Error).message
    setOutputDisplay(`error: ${msg}`, 'err')
    log(`refreshClaudeData error: ${msg}`)
    outputFetchOkLogged = false
  }
}

function startOutputPolling(): void {
  if (outputPollTimer) clearInterval(outputPollTimer)
  outputPollTimer = setInterval(() => {
    // Recording / pending / sending / finalizing 中は claude polling を止める
    if (phase === 'recording' || phase === 'finalizing' || phase === 'pending' || phase === 'sending') return
    if (phase === 'rootlist') {
      void reloadClaudeSessions()
    } else if (phase === 'idle' || phase === 'cc-message' || phase === 'cc-response') {
      void reloadClaudeSessions()
      void refreshClaudeData()
    }
  }, CC_POLL_INTERVAL_MS)
}

reloadOutputBtn.addEventListener('click', () => { void refreshClaudeData() })

async function killSession(name: string): Promise<void> {
  if (!confirm(`Kill session "${name}"?`)) return
  try {
    await client.killSession(name)
    log(`killed session: ${name}`)
    if (settings.sessionName === name) {
      abortInFlightRefresh()
      const remaining = lastSessions.filter((s) => s.name !== name)
      if (remaining.length > 0) {
        settings.sessionName = remaining[0].name
        await persistSettings()
      }
      // 見ていたセッションが消えた = 用件も消えた。作りかけの回答も捨てる
      resetRespondStateForSessionChange()
    }
    await reloadSessions()
    recomputePhase()
  } catch (e) {
    log(`killSession error: ${(e as Error).message}`)
  }
}

// ─── History ───────────────────────────────────────────────────────────
function addHistoryEntry(entry: Omit<HistoryEntry, 'id' | 'timestamp'>): void {
  const e: HistoryEntry = {
    id: ++historyCounter,
    timestamp: Date.now(),
    ...entry,
  }
  history = [e, ...history].slice(0, HISTORY_LIMIT)
  renderHistory()
}

function renderHistory(): void {
  if (history.length === 0) {
    historyListEl.innerHTML = `<li class="muted small">${escapeHtml(t('noHistory'))}</li>`
    return
  }
  historyListEl.innerHTML = ''
  const now = Date.now()
  for (const h of history) {
    const li = document.createElement('li')
    li.className = `history-item ${h.ok ? 'ok' : 'err'}`
    const icon = h.ok ? '✓' : '✗'
    const ago = formatAgo(now - h.timestamp)
    const meta = h.ok
      ? `${ago} · ${h.durationMs.toFixed(0)}ms`
      : `${ago} · failed`
    const body = h.ok ? h.text : `${h.text || '(empty)'}\n→ ${h.errorMsg ?? 'error'}`
    li.innerHTML =
      `<span class="history-icon">${icon}</span>` +
      `<div class="history-text">${escapeHtml(body)}<span class="target">→ ${escapeHtml(h.session)}</span></div>` +
      `<span class="history-meta">${escapeHtml(meta)}</span>`
    historyListEl.appendChild(li)
  }
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  return `${Math.floor(ms / 3_600_000)}h ago`
}

clearHistoryBtn.addEventListener('click', () => {
  history = []
  renderHistory()
})

// 履歴の相対時刻 ("3m ago") を定期的に描き直すタイマー。
// stopAllBackgroundWork で止めて復旧経路で再開できるよう、const ではなく開始関数を持つ。
let historyRenderTimer: ReturnType<typeof setInterval> | null = null
function startHistoryRenderTimer(): void {
  if (historyRenderTimer) clearInterval(historyRenderTimer)
  historyRenderTimer = setInterval(renderHistory, 60_000)
}
startHistoryRenderTimer()

/** セッション一覧の定期更新。boot と、取り込み失敗からの復旧の両方から呼ぶ。 */
function startSessionsRefreshTimer(): void {
  if (sessionsRefreshTimer) clearInterval(sessionsRefreshTimer)
  sessionsRefreshTimer = setInterval(() => {
    if (phase === 'recording' || phase === 'finalizing' || phase === 'pending' || phase === 'sending') return
    void reloadSessions()
  }, SESSIONS_REFRESH_MS)
}

/**
 * headlenss 自身の常駐処理を全部止める。
 *
 * プラグインを取り込む (document を対象 HTML に置き換える) 前に必ず呼ぶ。
 * document.open() はイベントリスナーは消すが**タイマーは消さない**ため、
 * 止めないと headlenss のポーリングが裏で回り続け、プラグインの描画と
 * 奪い合ってレンズがちらつく (1.5 秒ごとに一覧の内容を送ってしまう)。
 *
 * ここで止めた常駐処理のうち、再開が要るものは restartAllBackgroundWork が受け持つ
 * (取り込みに失敗して headlenss に戻る経路)。止める側と再開する側は必ず対で更新すること。
 */
function stopAllBackgroundWork(): void {
  for (const t of [recordingTimer, sessionsRefreshTimer, outputPollTimer, historyRenderTimer]) {
    if (t) clearInterval(t)
  }
  recordingTimer = null
  sessionsRefreshTimer = null
  outputPollTimer = null
  historyRenderTimer = null
  // 未書き込みの既読位置はここで書き切る。debounce タイマーを捨てるだけだと、
  // 直前に見ていたセッションの既読化が失われる (再開しても書く材料が残らない)。
  flushLastReadPersist()
  for (const t of [probeDebounceTimer, scrollAnimTimer, obProbeTimer, toastHideTimer]) {
    if (t) clearTimeout(t)
  }
  probeDebounceTimer = null
  scrollAnimTimer = null
  scrollAnimPending = 0
  scrollAnimActive = false  // タイマーを止めた = アニメも終わり。延期判定を残さない
  obProbeTimer = null
  // 自動で消えるはずの toast は、消すタイマーごと止めるとここで消し切っておく必要がある
  toastHideTimer = null
  hideToastNow()
  // 実行中の取得も打ち切る (完了時に描画へ回るため)
  abortInFlightRefresh()
  // レンズ送信の待機枠も捨てる。残しておくと in-flight が捌けた瞬間に headlenss の
  // フレームがプラグインのページに 1 枚だけ被さる。
  g2RenderPending = false
  g2RenderPendingForce = false
  g2RenderPendingFrame = null
  g2ContentQueued = null
  // 取り込み後、SDK がブリッジ単例を再利用する実装でも headlenss のハンドラが誤発火しないよう無効化する
  setEventHandlers({
    onScrollUp: () => {},
    onScrollDown: () => {},
    onClick: () => {},
    onDoubleClick: () => {},
    onAudio: () => {},
  })
  navigatingToPlugin = false
}

/**
 * stopAllBackgroundWork で止めた常駐処理を再開する。
 * 取り込み (performTakeover) が document を置き換える前に失敗し、headlenss の画面へ
 * 戻す時にだけ呼ぶ。document を置き換えた後は headlenss の DOM が無いので呼ばない。
 *
 * 対応 (stopAllBackgroundWork で止めるもの → ここでの扱い):
 *   recordingTimer      … 録音中だった場合のみ再開 (rootlist からしか遷移しないので通常は無い)
 *   sessionsRefreshTimer… 再開
 *   outputPollTimer     … 再開 (startOutputPolling)
 *   historyRenderTimer  … 再開
 *   probeDebounceTimer  … 再開しない (URL 入力の debounce。次の入力で張り直される)
 *   obProbeTimer        … 同上 (オンボーディングの入力 debounce)
 *   scrollAnimTimer     … 再開しない (アニメの残り行数ごと破棄済み)
 *   lastReadPersistTimer… 停止時に書き切っているので再開不要 (次の markAsRead が張り直す)
 *   toastHideTimer      … 停止時に toast ごと消しているので再開不要
 *   G2 入力ハンドラ     … 呼び出し側が reinstallG2EventHandlers で戻す
 *   レンズ送信の待機枠  … 呼び出し側の再描画要求 (cancelPluginNavigation) で積み直す
 */
function restartAllBackgroundWork(): void {
  startHistoryRenderTimer()
  startSessionsRefreshTimer()
  startOutputPolling()
  if (phase === 'recording') startRecordingTimer()
}

// ─── Settings UI ───────────────────────────────────────────────────────
/** スライダーと、その横の現在値表示を同じ値で揃える。 */
function syncSlider(input: HTMLInputElement, valEl: HTMLElement, value: number): void {
  input.value = String(value)
  valEl.textContent = String(value)
}

/** スクロール行数スライダーの最大値を「レンズ表示行数」に追従させる。
 *  現在値が新上限を超えていれば切り下げ、スライダーと値表示も同期する。 */
function applyScrollLinesMax(): void {
  const max = settings.chatDisplayLines
  scrollLinesEl.max = String(max)
  if (settings.scrollLinesPerGesture > max) settings.scrollLinesPerGesture = max
  syncSlider(scrollLinesEl, scrollLinesValEl, settings.scrollLinesPerGesture)
}

function renderSettings(): void {
  serverUrlEl.value = settings.serverBaseUrl
  smApiKeyEl.value = settings.speechmaticsApiKey
  smLangEl.value = settings.speechmaticsLang
  smOperatingPointEl.value = settings.speechmaticsOperatingPoint
  chatLinesEl.value = String(settings.chatDisplayLines)
  chatBottomSpacerEl.checked = settings.chatBottomSpacer
  devModeEl.checked = settings.devMode
  applyScrollLinesMax() // scrollLinesEl の max / value / 値表示をまとめて設定
  syncSlider(scrollCooldownEl, scrollCooldownValEl, settings.scrollCooldownMs)
  syncSlider(scrollAnimTickEl, scrollAnimTickValEl, settings.scrollAnimTickMs)
}

async function persistSettings(): Promise<void> {
  await saveSettings(bridge, settings)
}

function applyClientBase(): void {
  client.setBase(settings.serverBaseUrl)
}

serverUrlEl.addEventListener('input', () => {
  settings.serverBaseUrl = serverUrlEl.value.trim()
  applyClientBase()
  void persistSettings()
  scheduleProbe()
})

smApiKeyEl.addEventListener('change', () => {
  settings.speechmaticsApiKey = smApiKeyEl.value.trim()
  void persistSettings()
  recomputePhase()
})

smLangEl.addEventListener('change', () => {
  const v = smLangEl.value || DEFAULT_SETTINGS.speechmaticsLang
  settings.speechmaticsLang = v
  void persistSettings()
})

smOperatingPointEl.addEventListener('change', () => {
  const v = smOperatingPointEl.value as OperatingPoint
  settings.speechmaticsOperatingPoint = v === 'standard' ? 'standard' : 'enhanced'
  void persistSettings()
})

// 入力欄の min/max は settings 側の定数を単一ソースにする (HTML の値を上書き)。
// scrollLinesEl.max だけは「レンズ表示行数」に追従する動的値なので applyScrollLinesMax() が設定。
chatLinesEl.min = String(CHAT_DISPLAY_LINES_MIN)
chatLinesEl.max = String(CHAT_DISPLAY_LINES_MAX)
scrollLinesEl.min = String(SCROLL_LINES_MIN)
scrollCooldownEl.min = String(SCROLL_COOLDOWN_MIN)
scrollCooldownEl.max = String(SCROLL_COOLDOWN_MAX)
scrollAnimTickEl.min = String(SCROLL_ANIM_TICK_MIN)
scrollAnimTickEl.max = String(SCROLL_ANIM_TICK_MAX)

/**
 * range スライダーを設定値に接続する。
 * - ドラッグ中 (input): 値表示を更新し onInput でライブ反映
 * - 離した時 (change): 永続化し、必要なら onCommit で確定処理
 * range 入力は min/max/step にネイティブでクランプされるので追加の丸めは不要。
 */
function bindSlider(
  input: HTMLInputElement,
  valEl: HTMLElement,
  onInput: (v: number) => void,
  onCommit?: () => void,
): void {
  input.addEventListener('input', () => {
    valEl.textContent = input.value
    onInput(Number(input.value))
  })
  input.addEventListener('change', () => {
    void persistSettings()
    onCommit?.()
  })
}

// レンズ表示行数はフォーム (数値入力)。type=number は範囲外をネイティブでは弾かないので
// clampChatDisplayLines で丸める。値が変わるとスクロール行数の上限も追従させる。
chatLinesEl.addEventListener('change', () => {
  const next = clampChatDisplayLines(chatLinesEl.value)
  settings.chatDisplayLines = next
  chatLinesEl.value = String(next) // clamp 結果を入力欄に戻す
  // 表示窓が狭まると現在の scrollOffset が範囲外になり得るのでクリップ
  scrollOffset = Math.min(scrollOffset, maxChatScrollOffset())
  applyScrollLinesMax() // スクロール行数スライダーの上限を追従 + 必要なら値を切り下げ
  void persistSettings()
  void refreshG2(true)
})

bindSlider(scrollLinesEl, scrollLinesValEl, (v) => {
  settings.scrollLinesPerGesture = v
})

bindSlider(scrollCooldownEl, scrollCooldownValEl, (v) => {
  settings.scrollCooldownMs = v
  setScrollCooldownMs(v) // events.ts に即反映
})

bindSlider(scrollAnimTickEl, scrollAnimTickValEl, (v) => {
  settings.scrollAnimTickMs = v
})

chatBottomSpacerEl.addEventListener('change', () => {
  settings.chatBottomSpacer = chatBottomSpacerEl.checked
  void persistSettings()
  void refreshG2(true)
})

devModeEl.addEventListener('change', () => {
  settings.devMode = devModeEl.checked
  // オフに戻したら溜まったログを破棄してメモリを解放する。
  if (!settings.devMode) logEl.textContent = ''
  void persistSettings()
})

function scheduleProbe(): void {
  if (probeDebounceTimer) clearTimeout(probeDebounceTimer)
  setProbeText('busy', t('probeChecking'))
  probeDebounceTimer = setTimeout(() => {
    probeDebounceTimer = null
    void probeServer()
  }, PROBE_DEBOUNCE_MS)
}

function setProbeText(kind: 'ok' | 'err' | 'busy' | 'muted', text: string): void {
  serverProbeText.className = `probe small ${kind === 'muted' ? 'muted' : kind}`
  serverProbeText.textContent = text
}

async function probeServer(): Promise<void> {
  if (!settings.serverBaseUrl) {
    serverProbeOk = false
    serverErrorMsg = 'unset'
    setProbeText('muted', t('unset'))
    renderSessionPills()
    recomputePhase()
    return
  }
  setProbeText('busy', t('probeChecking'))
  try {
    const res = await client.health()
    if (res.ok) {
      serverProbeOk = true
      serverErrorMsg = ''
      await reloadSessions()
      setProbeText('ok', `OK · sessions: ${lastSessions.length}`)
    } else {
      serverProbeOk = false
      serverErrorMsg = 'health returned ok=false'
      setProbeText('err', serverErrorMsg)
    }
  } catch (e) {
    serverProbeOk = false
    serverErrorMsg = (e as Error).message
    setProbeText('err', serverErrorMsg)
    log(`probe error: ${serverErrorMsg}`)
  } finally {
    renderSessionPills()
    recomputePhase()
    renderClaudeSessionsList()
  }
}

// ─── Onboarding ────────────────────────────────────────────────────────
type View = 'onboarding' | 'dashboard'

function setView(v: View): void {
  bodyEl.dataset.view = v
}

function showOnboardingStep(n: 1 | 2): void {
  for (const el of obSteps) {
    const step = Number(el.dataset.step)
    el.hidden = step !== n
  }
  if (n === 1) obServerUrlEl.focus()
  if (n === 2) obSmKeyEl.focus()
}

let obProbeTimer: ReturnType<typeof setTimeout> | null = null

function setObProbe(kind: 'ok' | 'err' | 'busy' | 'muted', text: string): void {
  obServerProbeEl.className = `probe small ${kind === 'muted' ? 'muted' : kind}`
  obServerProbeEl.textContent = text
}

async function obProbe(url: string): Promise<void> {
  obNext1Btn.disabled = true
  setObProbe('busy', t('probeChecking'))
  const tmp = new HeadlenssClient(url)
  try {
    const res = await tmp.health()
    if (!res.ok) throw new Error('health returned ok=false')
    const sessions = await tmp.listSessions()
    setObProbe('ok', `OK · ${sessions.length} session${sessions.length === 1 ? '' : 's'}`)
    obNext1Btn.disabled = false
  } catch (e) {
    setObProbe('err', `${t('probeUnreachablePfx')}${(e as Error).message}`)
    obNext1Btn.disabled = true
  }
}

obServerUrlEl.addEventListener('input', () => {
  const url = obServerUrlEl.value.trim()
  if (!url) {
    setObProbe('muted', t('ob1ProbeIdle'))
    obNext1Btn.disabled = true
    return
  }
  if (obProbeTimer) clearTimeout(obProbeTimer)
  setObProbe('busy', t('probeTyping'))
  obProbeTimer = setTimeout(() => {
    obProbeTimer = null
    void obProbe(url)
  }, PROBE_DEBOUNCE_MS)
})

obNext1Btn.addEventListener('click', () => {
  settings.serverBaseUrl = obServerUrlEl.value.trim()
  applyClientBase()
  void persistSettings()
  showOnboardingStep(2)
})

obSmKeyEl.addEventListener('input', () => {
  obFinishBtn.disabled = obSmKeyEl.value.trim().length === 0
})

obBackBtn.addEventListener('click', (e) => {
  e.preventDefault()
  showOnboardingStep(1)
})

obFinishBtn.addEventListener('click', () => {
  void finishOnboarding()
})

async function finishOnboarding(): Promise<void> {
  const key = obSmKeyEl.value.trim()
  if (!key) return
  settings.speechmaticsApiKey = key
  await persistSettings()
  try {
    const sessions = await client.listSessions()
    if (sessions.length === 0) {
      log('Auto-creating session "main"')
      await client.createSession('main')
      abortInFlightRefresh()
      settings.sessionName = 'main'
    } else if (!sessions.some((s) => s.name === settings.sessionName)) {
      abortInFlightRefresh()
      settings.sessionName = sessions[0].name
    }
    // 初期設定中なので用件を持っているはずはないが、セッション名を書き換える経路は
    // 例外なく同じ後始末を通す (「ここだけ通さない」を作らない)。
    resetRespondStateForSessionChange()
    await persistSettings()
  } catch (e) {
    log(`finishOnboarding session setup error: ${(e as Error).message}`)
  }
  renderSettings()
  setView('dashboard')
  await probeServer()
}

function isConfigured(s: Settings): boolean {
  return Boolean(s.serverBaseUrl && s.speechmaticsApiKey)
}

// ─── Recording → RT → tmux ─────────────────────────────────────────────
function startRecordingTimer(): void {
  stopRecordingTimer()
  recordingTimer = setInterval(() => {
    if (phase !== 'recording') return
    durationEl.textContent = `${getRecordingSeconds().toFixed(1)}s`
    paintStatus()
    void refreshG2()
    // 時間による自動停止はしない。停止はユーザー操作 (クリック / ダブルタップ) のみ。
  }, 250)
}

function stopRecordingTimer(): void {
  if (recordingTimer) {
    clearInterval(recordingTimer)
    recordingTimer = null
  }
}

function updateRecordButton(): void {
  if (phase === 'finalizing' || phase === 'sending') {
    recordBtn.disabled = true
    recordBtn.textContent = phase === 'finalizing' ? 'Finalizing…' : 'Sending…'
    recordBtn.classList.remove('recording')
    return
  }
  if (phase === 'recording') {
    recordBtn.disabled = false
    recordBtn.textContent = 'Stop'
    recordBtn.classList.add('recording')
    return
  }
  if (phase === 'pending') {
    recordBtn.disabled = true
    recordBtn.textContent = t('recBtnPending')
    recordBtn.classList.remove('recording')
    return
  }
  if (phase === 'rootlist') {
    recordBtn.disabled = true
    recordBtn.textContent = 'Pick session on G2'
    recordBtn.classList.remove('recording')
    return
  }
  recordBtn.disabled = phase !== 'idle'
  recordBtn.textContent = 'Record'
  recordBtn.classList.remove('recording')
}

async function startRecording(): Promise<void> {
  if (!bridge) {
    log('cannot record: G2 bridge not available')
    return
  }
  if (!settings.speechmaticsApiKey || !settings.serverBaseUrl || !settings.sessionName) {
    log('startRecording blocked: not configured')
    return
  }

  resetPcmCounter()

  recordingScrollOffset = 0

  recordingLinesCache = []

  recordingLinesCacheKey = ''
  liveTranscript = ''
  recordingReady = false
  durationEl.textContent = '0.0s'
  resetScroll()

  // 1. UI を即座に recording 画面へ遷移 (体感ラグを減らす)
  phase = 'recording'
  startRecordingTimer()
  paintStatus()
  updateRecordButton()
  void refreshG2(true)

  // 2. Speechmatics RT 接続 + マイク起動 を非同期で進める。
  //    途中でユーザが停止した場合に二重起動を防ぐため、session 同一性で gard する。
  const localBridge = bridge
  const session = new SpeechmaticsRT()
  rtSession = session

  const revertToIdle = () => {
    if (rtSession !== session || phase !== 'recording') return
    stopRecordingTimer()
    try { session.abort() } catch { /* ignore */ }
    rtSession = null
    const flow = respondFlow
    if (flow?.recording) {
      // Type something の録音だった。idle に落とすと応答フローだけが宙に浮くので、
      // 戻り先の用件が健在なら応答画面へ戻し、消えていればフローごと畳む。
      flow.recording = false
      if (!claudePending || claudePending.id !== flow.pendingId) {
        resetRespondFlow('pending-gone', flow)
        return
      }
      phase = 'cc-response'
    } else {
      phase = 'idle'
    }
    paintStatus()
    updateRecordButton()
    void refreshG2(true)
  }

  void (async () => {
    try {
      await session.start({
        apiKey: settings.speechmaticsApiKey,
        language: settings.speechmaticsLang,
        operatingPoint: settings.speechmaticsOperatingPoint,
        onPartial: (text) => {
          liveTranscript = text
          void refreshG2()
        },
        onFinal: (text) => {
          liveTranscript = text
          void refreshG2()
        },
        onError: (err) => log(`RT error: ${err.message}`),
      })
      log('Speechmatics RT connected')
    } catch (err) {
      log(`RT connect failed: ${(err as Error).message}`)
      revertToIdle()
      return
    }

    // 接続完了するまでにユーザが停止していたら、ここで打ち切り
    if (rtSession !== session || phase !== 'recording') {
      try { session.abort() } catch { /* ignore */ }
      return
    }

    // 3. G2マイク開始
    try {
      const ok = await localBridge.audioControl(true)
      if (ok === false) {
        log('audioControl(true) returned false')
        revertToIdle()
        return
      }
      // 接続&マイク起動完了 → レンズ表示を「録音中」に切り替え
      if (rtSession === session && phase === 'recording') {
        recordingReady = true
        void refreshG2(true)
      }
    } catch (err) {
      log(`audioControl error: ${err}`)
      revertToIdle()
    }
  })()
}

/** 録音停止 → ASR 確定 → pending 状態へ。送信はしない (ユーザの↑/↓判断待ち) */
async function stopRecordingToPending(): Promise<void> {
  // ── 最初の await より前に「この録音が何のためのものか」を確保する ──
  // 停止処理には G2 マイク停止と ASR の最終結果待ちという 2 つの await が挟まり、
  // その間にセッション切替 (足場ごとの差し替え) が起こりうる。後から「今の状態」を
  // 見て分岐すると、応答用に喋った内容が行き先を失った拍子に tmux 送信の待ち行列へ
  // 紛れ込む。用途・対象フロー・セッション名 (世代) をここで固定する。
  const startedSession = settings.sessionName
  const recordingFlow = respondFlow?.recording ? respondFlow : null
  const startedRt = rtSession
  /**
   * 録音を止め始めた時と同じセッション (世代) のままか。
   * 違っていたら、この録音の結果は行き先ごと消えているので破棄する。
   * 新しい状態 (切替後のセッションの phase / pending / 録音) には一切触らない。
   */
  const abandonIfSessionSwitched = (where: string): boolean => {
    if (settings.sessionName === startedSession) return false
    log(`録音停止 (${where}): セッションが切り替わったので結果を破棄します`)
    // 自分が始めた ASR 接続だけを片付ける (切替後に始まった新しい録音は触らない)
    if (startedRt && rtSession === startedRt) {
      try { rtSession.abort() } catch { /* ignore */ }
      rtSession = null
    }
    return true
  }

  stopRecordingTimer()
  phase = 'finalizing'
  paintStatus()
  updateRecordButton()
  void refreshG2(true)

  // G2マイク停止
  try {
    if (bridge) await bridge.audioControl(false)
  } catch (err) {
    log(`Stop error: ${err}`)
  }
  if (abandonIfSessionSwitched('マイク停止後')) return

  /** 録音終了時の戻り先を決める共通ハンドラ。
   *  録音が cc-response の Type something 用なら応答画面へ、そうでなければ tmux 用 pending へ。 */
  const finishWithText = (text: string): void => {
    if (recordingFlow) {
      recordingFlow.recording = false
      // 喋っている間に戻り先が消えていることがある (別経路で承認された / セッションを
      // kill された / ポーリングで用件が入れ替わった)。戻る先が無いのに cc-response へ
      // 帰すと、pending 無しの応答画面という作れないはずの状態になる。
      const flow = respondFlow
      if (flow !== recordingFlow || !claudePending || claudePending.id !== recordingFlow.pendingId) {
        log('respond type-something: 戻り先の用件が消えていたので idle に戻ります')
        resetRespondFlow('pending-gone', recordingFlow)
        return
      }
      // cc-response の type-something 回答として記録、cc-response に戻る
      if (text) {
        flow.answers[flow.qIdx] = { kind: 'type-something', text }
        log(`respond type-something: "${text.slice(0, 40)}"`)
      } else {
        log('respond type-something: empty, cancel')
      }
      phase = 'cc-response'
      paintStatus()
      updateRecordButton()
      void refreshG2(true)
      // 入力済なら自動で次の質問へ進む
      if (text) {
        advanceToNextQuestionOrSubmit()
      }
      return
    }
    // 通常 (tmux 用) フロー
    if (text) {
      pendingSentences.push(text)
      log(`pending: appended sentence #${pendingSentences.length}`)
    }
    phase = 'pending'
    paintStatus()
    updateRecordButton()
    updatePendingUI()
    void refreshG2(true)
  }

  const seconds = getRecordingSeconds()
  if (seconds < MIN_RECORDING_SEC || getPcmByteLength() === 0) {
    log(`Recording too short: ${seconds.toFixed(2)}s`)
    rtSession?.abort()
    rtSession = null
    durationEl.textContent = '0.0s'
    liveTranscript = ''
    finishWithText('')
    return
  }

  const rt = rtSession
  if (!rt) {
    finishWithText('')
    return
  }
  let text = ''
  const t0 = performance.now()
  try {
    text = (await rt.stop()).trim()
    log(`RT final: "${text.slice(0, 80)}" (${(performance.now() - t0).toFixed(0)}ms)`)
  } catch (e) {
    const errorMsg = (e as Error).message
    log(`RT stop error: ${errorMsg}`)
    if (abandonIfSessionSwitched('ASR 失敗後')) return
    addHistoryEntry({
      text: liveTranscript || '(ASR failed)',
      session: settings.sessionName,
      ok: false,
      durationMs: performance.now() - t0,
      errorMsg,
    })
    durationEl.textContent = '0.0s'
    liveTranscript = ''
    finishWithText('')
    return
  } finally {
    // 片付けるのは自分が止めた接続だけ。世代が変わった後に始まった新しい録音の
    // 接続まで手放すと、その録音が確定できなくなる。
    if (rtSession === rt) rtSession = null
  }

  if (abandonIfSessionSwitched('ASR 確定後')) return
  durationEl.textContent = '0.0s'
  liveTranscript = ''
  finishWithText(text)
}

/** pending → サーバ送信 → idle */
async function confirmAndSend(): Promise<void> {
  if (phase !== 'pending') return
  if (!pendingHasContent()) {
    // 空のまま送信を試みても何もしない。idle へ自動復帰せず pending に留まる。
    // ターミナル画面 (idle) へ戻すのはダブルタップ (discardPending) 経由のみ。
    return
  }
  const text = pendingSendText()
  phase = 'sending'
  paintStatus()
  updateRecordButton()
  updatePendingUI()
  void refreshG2(true)

  const t0 = performance.now()
  try {
    await client.sendKeys(settings.sessionName, {
      text,
      submit: true,
    })
    log(`sendKeys ok → ${settings.sessionName} (${pendingSentences.length} sentences)`)
    addHistoryEntry({
      text,
      session: settings.sessionName,
      ok: true,
      durationMs: performance.now() - t0,
    })
  } catch (e) {
    const errorMsg = (e as Error).message
    log(`sendKeys error: ${errorMsg}`)
    addHistoryEntry({
      text,
      session: settings.sessionName,
      ok: false,
      durationMs: performance.now() - t0,
      errorMsg,
    })
  } finally {
    pendingSentences = []
    phase = 'idle'
    resetScroll()
    recomputePhase()
    // 送信直後に出力ミラーを取り直し (反映を見える化)
    void refreshClaudeData()
  }
}

/** pending → 全部破棄 → idle (⊕⊕ で呼ばれる) */
function discardPending(): void {
  if (phase !== 'pending') return
  log(`pending discarded (${pendingSentences.length} sentences dropped)`)
  pendingSentences = []
  phase = 'idle'
  recomputePhase()
}

/**
 * pending 中の下スクロール = 末尾1文だけ削除。
 * 空になっても phase は pending のまま留める。idle (ターミナル画面) に
 * 戻すのはダブルタップ (discardPending) のみ、というのがユーザ意図。
 */
function removeLastSentence(): void {
  if (phase !== 'pending') return
  if (pendingSentences.length === 0) return  // 既に空: そのまま pending に留まる
  const removed = pendingSentences.pop()
  log(`pending: removed last sentence "${(removed ?? '').slice(0, 40)}" (remaining ${pendingSentences.length})`)
  updatePendingUI()
  paintStatus()
  void refreshG2(true)
}

/**
 * 録音をキャンセルする (⊕⊕ で呼ばれる)。
 * Speechmatics 接続を破棄し、PCM をすべて捨て、新しい文は append しない。
 * 既存 pendingSentences があれば pending 状態に戻り、無ければ idle へ戻る。
 */
async function abortRecording(): Promise<void> {
  if (phase !== 'recording') return
  log(`recording aborted (kept ${pendingSentences.length} sentences)`)
  stopRecordingTimer()
  // G2 マイク停止
  try {
    if (bridge) await bridge.audioControl(false)
  } catch (err) {
    log(`Stop error: ${err}`)
  }
  // RT セッションを破棄 (final 結果は受け取らない)
  rtSession?.abort()
  rtSession = null
  resetPcmCounter()
  recordingScrollOffset = 0
  recordingLinesCache = []
  recordingLinesCacheKey = ''
  liveTranscript = ''
  durationEl.textContent = '0.0s'
  recordingReady = false
  // 録音の用途が cc-response の type-something なら、cc-response に戻る。
  // ただし戻り先の用件が消えていたら応答フローごと畳んで idle へ落とす
  // (pending 無しの応答画面を作らない)。
  const flow = respondFlow
  if (flow?.recording) {
    flow.recording = false
    if (!claudePending || claudePending.id !== flow.pendingId) {
      log('録音中止: 戻り先の用件が消えていたので idle に戻ります')
      resetRespondFlow('pending-gone')
      updateRecordButton()
      updatePendingUI()
      return
    }
    phase = 'cc-response'
  } else {
    phase = pendingSentences.length > 0 ? 'pending' : 'idle'
  }
  paintStatus()
  updateRecordButton()
  updatePendingUI()
  void refreshG2(true)
}

async function toggleRecording(): Promise<void> {
  if (phase === 'finalizing' || phase === 'sending') return
  // 応答 POST 中のタップは無視 (同じ用件へ 2 通目を送らせない)
  if (respondInputBlocked()) return
  if (phase === 'recording') {
    await stopRecordingToPending()
  } else if (phase === 'pending') {
    // 追加録音 — 既存 pendingSentences は保持されたまま新しい文を末尾に追加する
    await startRecording()
    return
  } else if (phase === 'rootlist') {
    activateSelectedFromRoot()
  } else if (phase === 'idle') {
    // pending があるなら音声入力ではなく、まずメッセージ全文の閲覧画面に遷移
    if (claudePending) {
      enterRespondFlow(claudePending)
    } else {
      await startRecording()
    }
  } else if (phase === 'cc-message') {
    // 本文を読み終えた → 選択肢画面へ
    const flow = respondFlow
    if (!flow) { assertRespondFlowInvariant('cc-message tap'); return }
    clearRespondError()
    flow.cursor = 0
    phase = 'cc-response'
    paintStatus()
    void refreshG2(true)
    updateRecordButton()
  } else if (phase === 'cc-response') {
    await handleCcResponseClick()
  } else {
    settingsDetails.open = true
  }
}

// ─── rootlist ──────────────────────────────────────────────────────────
function moveRootCursor(delta: number): void {
  if (phase !== 'rootlist') return
  const rows = rootRows()
  if (rows.length === 0) return
  const cur = resolveRootCursorIndex()
  const next = (cur + delta + rows.length) % rows.length
  rootCursorKey = rootRowKey(rows[next])
  const row = rows[next]
  log(`rootlist cursor=${row.kind} ${row.kind === 'plugin' ? row.plugin.name : row.session.tmuxSessionName}`)
  void refreshG2(true)
}

// ─── G2 プラグインへの遷移 ─────────────────────────────────────────────
// 遷移直前にレンズへフィードバックを出し、そのフレームが届くまで少し待つ。
const PLUGIN_NAVIGATE_DELAY_MS = 400
let navigatingToPlugin = false
// 取り込み用 fetch の中断口 (Connecting 中のダブルタップ中止で使う)
let pluginNavAbort: AbortController | null = null
// boot で登録した G2 入力ハンドラの再登録口。取り込み直前に no-op へ差し替えるので、
// 取り込みに失敗して headlenss に戻る時はこれで操作を復活させる。
let reinstallG2EventHandlers: (() => void) | null = null

/**
 * セッション配下の G2 プラグインへ WebView ごと遷移する。
 * URL に `?even_loader=1` を付けるので、遷移先に even-loader のシムが入っていれば
 * ダブルタップで headlenss に戻れる (Plugin Loader と同じ規約)。
 */
function openG2Plugin(plugin: G2PluginInfo): void {
  if (navigatingToPlugin) return
  // URL は宣言ファイルに書かれたものをそのまま使う (推測しない)。
  const url = plugin.url
  if (!url) return
  navigatingToPlugin = true
  // 「接続中」を出した後、遷移が完了するまでポーリング由来の再描画で上書きされないよう
  // レンズ描画を止める。取り込み経路 (performTakeover) / トップレベル遷移 (location.assign)
  // のどちらに進んでも解除しない。解除は cancelPluginNavigation 経由だけ
  // (ダブルタップでの中止 / 取り込みに失敗して headlenss に戻る時)。
  pluginNavBlocksG2Render = true
  pluginNavAbort = new AbortController()
  log(`plugin を開きます: ${plugin.name} -> ${url}`)
  void (async () => {
    try {
      // 送信路のロックを取ってから出す。ポンプが送っている最中に割り込むと
      // 「接続中」の後ろに headlenss のフレームが上書きされる。
      await runExclusiveG2Send(async () => {
        // これ以降レンズは headlenss の画面ではないので、待機枠と dedup 基準を捨てる
        g2RenderPending = false
        g2RenderPendingForce = false
        g2ContentQueued = null
        invalidateG2Dedup()
        await updateHeader(plugin.name)
        await updateContent(`${t('pluginConnecting')}\n${url}`)
      })
      await new Promise((r) => setTimeout(r, PLUGIN_NAVIGATE_DELAY_MS))
    } catch (err) {
      log(`plugin を開く前の描画エラー: ${err}`)
    }
    if (!navigatingToPlugin) return

    // 取り込み方式: 対象の HTML を取得して自分のドキュメントを置き換える。
    // ページは headlenss のまま (URL も変わらない) なので、戻る機構をこちら側で
    // 仕込める = 相手のプラグインにも中継サーバにも一切依存しない。
    const html = await fetchTargetHtml(url, pluginNavAbort.signal)
    if (!navigatingToPlugin) return

    if (html && !isProxyInjected(html)) {
      // 取り込み後もタイマーは生き残る。止めないと headlenss のポーリングが
      // 裏で回り続け、プラグインの描画と奪い合う。
      stopAllBackgroundWork()
      log('plugin を取り込みます (ページ置き換え)')
      try {
        performTakeover(html, url, log)
        return
      } catch (err) {
        if (isDocumentReplaced()) {
          // document を置き換えた後の失敗。headlenss の DOM もイベントリスナーも既に
          // 無いので、ここで復旧描画やポーリング再開をしても「消えたページのための
          // 処理」が裏で回るだけで、プラグイン側の描画を奪い合う。開発者向けに記録
          // するだけにして何も動かさない (log は画面の <pre> を触るので使わない)。
          console.log(`[headlenss] plugin の取り込みが document 置換後に失敗しました: ${err}`)
          return
        }
        // 置き換え前の失敗。レンズは「接続中」のまま、背景処理も入力ハンドラも止めた
        // 後なので、何も起きない画面で固まる。描画停止を解いて headlenss の画面へ戻し、
        // 操作と常駐処理も復活させる。
        log(`plugin の取り込みに失敗しました: ${err}`)
        reinstallG2EventHandlers?.()
        cancelPluginNavigation()
        restartAllBackgroundWork()
        return
      }
    }

    // 取り込めない場合 (CORS 拒否 / 非 HTML / 応答なし / 既にシム注入済み) は
    // 従来どおりトップレベル遷移する。相手にシムがあれば戻れる。
    log(`plugin を取り込めないので遷移します (html=${html ? 'proxy注入済み' : '取得失敗'})`)
    await markNavigateToPlugin(bridge)
    if (!navigatingToPlugin) {
      void consumeReturnFlag(bridge)
      return
    }
    location.assign(withLoaderParam(url))
  })()
}

/**
 * 遷移の中止。
 *
 * 接続先が落ちている / 応答しない場合、location.assign を呼んでも WebView は現ページに
 * 留まり、Connecting 表示のまま固まる。この間のダブルタップで一覧へ戻す。
 * (遷移が成功した場合はページごと破棄されるのでこの処理は動かない)
 */
function cancelPluginNavigation(): void {
  // 描画停止の解除だけは early-return より前に必ず行う。
  // なぜ: 解除を navigatingToPlugin に依存させると、遷移フラグが先に降りている状態
  // (取り込み失敗の後始末など) から呼ばれた時に解除されず、レンズが「接続中」のまま
  // 二度と描き替わらなくなる。
  const wasBlocked = pluginNavBlocksG2Render
  pluginNavBlocksG2Render = false
  if (!navigatingToPlugin) {
    // 遷移中でなければ中止すべきものは無い。描画だけ止まっていたなら描き直す。
    if (wasBlocked) redrawAfterPluginNavigationCancelled()
    return
  }
  navigatingToPlugin = false
  log('plugin を開くのを中止しました')
  // 取り込み用 fetch と、保留中のトップレベル遷移の両方を止める
  pluginNavAbort?.abort()
  pluginNavAbort = null
  try { window.stop() } catch { /* ignore */ }
  // 遷移前に立てた復帰フラグを撤回する (遷移しなかったので次回 boot は通常経路でよい)
  void consumeReturnFlag(bridge)
  // レンズを一覧へ戻す
  redrawAfterPluginNavigationCancelled()
}

/**
 * プラグイン遷移を中止した後、レンズを headlenss の画面へ戻す描画。
 *
 * 通常は差分更新で足りるが、遷移をブロックしている間に onForegroundExit
 * (グラスを外す等) が来ているとページ状態が落ちている。この状態で差分更新
 * (textContainerUpgrade) を送っても対象のコンテナが無く、レンズは「接続中」の
 * まま何も変わらない。ページ状態が落ちていたら foreground 再入場と同じく
 * ページごと組み直す。
 */
function redrawAfterPluginNavigationCancelled(): void {
  if (!isPageBuilt()) {
    log('遷移ブロック中にページ状態がリセットされていたので、ページごと再構築します')
    resetPageState()
    void (async () => {
      try {
        const { header, content, footer } = buildG2Frame()
        await sendShowScreen(header, content, footer)
      } catch (err) {
        log(`plugin 中止後のページ再構築エラー: ${err}`)
      }
    })()
    return
  }
  // このページは構築済みなので、次の showScreen が create にならないよう印を付けて差分更新
  markPageAlreadyBuilt()
  void refreshG2(true)
}

/** rootlist でタップされた時の分岐: セッション行なら開く、プラグイン行なら遷移する */
function activateSelectedFromRoot(): void {
  if (phase !== 'rootlist') return
  const row = currentRootRow()
  if (!row) return
  if (row.kind === 'plugin') {
    openG2Plugin(row.plugin)
    return
  }
  openSelectedFromRoot()
}

function openSelectedFromRoot(): void {
  if (phase !== 'rootlist') return
  const row = currentRootRow()
  const sel = row?.session ?? claudeSessions[0]
  if (!sel) return
  // セッション切替: 前回の in-flight fetch を中断してから新セッションに切替
  abortInFlightRefresh()
  settings.sessionName = sel.tmuxSessionName
  void persistSettings()
  log(`Opened Agent session: ${sel.tmuxSessionName}`)
  claudeChat = []
  chatLinesCache = []
  chatLinesCacheKey = ''
  claudeChatStatus = undefined
  claudeDeliveryWarning = null
  claudeChatLoading = true
  currentAgentSource = sel.source
  // 前セッションの用件と作りかけの回答を捨てる (応答画面から直接来た場合も含む)
  resetRespondStateForSessionChange()
  resetScroll()
  phase = 'idle'
  paintStatus()
  void refreshG2(true)
  updateRecordButton()
  renderClaudeSessionsList()  // WebView 側のハイライトを更新
  void refreshClaudeData()
  startOutputPolling()  // ポーリングタイマーをリセットし、次 tick を 1 interval 先に置く
}

function moveRespondCursor(delta: number): void {
  if (phase !== 'cc-response') return
  const flow = respondFlow
  if (!flow) { assertRespondFlowInvariant('moveRespondCursor'); return }
  const total = currentRespondRowCount()
  if (total === 0) return
  clearRespondError()
  flow.cursor = (flow.cursor + delta + total) % total
  void refreshG2(true)
}

/** cc-response 画面で click(タップ) された時の処理 */
async function handleCcResponseClick(): Promise<void> {
  if (phase !== 'cc-response' || !claudePending) return
  const flow = respondFlow
  if (!flow) { assertRespondFlowInvariant('handleCcResponseClick'); return }
  // 直前の送信が失敗している間のタップは、カーソルがどの行にあっても「再送」とする。
  // なぜ: 失敗した時のカーソルは最後に選んだ行 (Type something や Chat about this) に
  // 残っている。そのままタップを行の意味で解釈すると、再試行のつもりの操作が新しい
  // 録音を始めたり回答を作り直したりして、組み上がった回答を送る手段が画面から消える。
  // 再送しない操作 (カーソル移動 / 本文へ戻る) をすればエラー表示は解除され、
  // 以降のタップは通常どおり行の意味で扱われる。
  if (flow.error) {
    clearRespondError()
    await sendPendingResponseAndFinish()
    return
  }
  clearRespondError()
  if (claudePending.kind === 'permission') {
    await sendPendingResponseAndFinish()
    return
  }
  const q = claudePending.questions?.[flow.qIdx]
  if (!q) return
  const opts = q.options ?? []
  const submitRowIdx = q.multiSelect ? opts.length : -1
  const typeRowIdx = opts.length + (q.multiSelect ? 1 : 0)
  const chatRowIdx = typeRowIdx + 1

  // Chat about this 行: その質問のみ chat-about-this として全体キャンセル
  if (flow.cursor === chatRowIdx) {
    flow.answers[flow.qIdx] = { kind: 'chat-about-this' }
    await sendPendingResponseAndFinish()
    return
  }

  // Type something 行: 音声入力モードを開始
  if (flow.cursor === typeRowIdx) {
    flow.recording = true
    await startRecording()
    // 起動できなかった (ブリッジ無し / 未設定) 場合は用途フラグを戻す。
    // 立てっぱなしにすると、以降フローを畳むたびに存在しない録音を止めに行く。
    if (currentPhase() !== 'recording' && respondFlow === flow) flow.recording = false
    return
  }

  // Submit (multi-select のみ): 現在質問の選択を確定して次へ
  if (flow.cursor === submitRowIdx) {
    // 1 つも選ばずに確定すると「選択の無い回答」が TUI で確定してしまうので no-op。
    // 選び直せることが分かるよう、Submit 行に出している注意書きを描き直すだけにする。
    const cur = flow.answers[flow.qIdx]
    const selected = cur?.kind === 'predefined' ? cur.options ?? [] : []
    if (selected.length === 0) {
      log('multi-select: 選択が 0 件なので確定しません')
      void refreshG2(true)
      return
    }
    advanceToNextQuestionOrSubmit()
    return
  }

  // predefined option 行
  if (flow.cursor < opts.length) {
    const label = opts[flow.cursor].label
    if (q.multiSelect) {
      // toggle
      const cur = flow.answers[flow.qIdx]
      let arr = cur?.kind === 'predefined' ? cur.options ?? [] : []
      arr = arr.includes(label) ? arr.filter((l) => l !== label) : [...arr, label]
      flow.answers[flow.qIdx] = { kind: 'predefined', options: arr }
      void refreshG2(true)
    } else {
      // single-select: 即その値を answer に入れて次へ
      flow.answers[flow.qIdx] = { kind: 'predefined', option: label }
      advanceToNextQuestionOrSubmit()
    }
  }
}

function advanceToNextQuestionOrSubmit(): void {
  const flow = respondFlow
  if (!claudePending || !flow) return
  const total = claudePending.questions?.length ?? 0
  if (flow.qIdx + 1 < total) {
    // 次の質問はまず本文を読ませたいので、選択肢画面ではなく cc-message に戻る
    flow.qIdx++
    flow.cursor = 0
    backToCcMessage()
  } else {
    void sendPendingResponseAndFinish()
  }
}

/** cc-response → メッセージ閲覧画面 (cc-message) へ戻る。読み位置は先頭に戻す */
function backToCcMessage(): void {
  const flow = respondFlow
  if (!flow) { assertRespondFlowInvariant('backToCcMessage'); return }
  flow.msgScrollOffset = 0
  phase = 'cc-message'
  paintStatus()
  void refreshG2(true)
  updateRecordButton()
}

// ─── 応答フローの遷移 ──────────────────────────────────────────────────
// respondFlow を作る・畳む・差し替えるのはこの 4 つだけ。散らばった代入で
// 「一部だけ残る」状態を作らないための唯一の入り口。
//   enter(pending)   idle → cc-message (新しい用件への応答を始める)
//   rebind(pending)  応答中に用件が別物へ入れ替わった → 新しい用件の先頭から
//   complete()       送信が決着した (成功 / 用件入れ替わり) → 畳んで idle
//   reset(reason)    それ以外の理由で畳む (キャンセル / セッション切替 / 用件消滅)

/** 応答フローを開始する (idle → cc-message)。 */
function enterRespondFlow(pending: Pending): void {
  clearRespondError()
  respondFlow = {
    pendingId: pending.id,
    qIdx: 0,
    cursor: 0,
    msgScrollOffset: 0,
    answers: {},
    recording: false,
    inFlightSince: null,
    error: null,
  }
  phase = 'cc-message'
  paintStatus()
  void refreshG2(true)
  updateRecordButton()
}

/** 応答中に用件が別物へ入れ替わった時、新しい用件で組み直す (回答は引き継がない)。 */
function rebindRespondFlow(pending: Pending): void {
  clearRespondError()
  if (respondFlow?.recording) discardRespondRecording()
  respondFlow = {
    pendingId: pending.id,
    qIdx: 0,
    cursor: 0,
    msgScrollOffset: 0,
    answers: {},
    recording: false,
    inFlightSince: null,
    error: null,
  }
  phase = 'cc-message'
  paintStatus()
  void refreshG2(true)
  updateRecordButton()
}

/**
 * 応答フローを畳んで idle に戻す。
 * 録音 (Type something) の最中でも録音ごと捨てる: 戻る先の用件がもう無いのに
 * 録音だけ生かしておくと、確定した瞬間に行き先の無い回答ができる。
 *
 * @param endedFlow 「この処理が属していたフロー」。respondFlow が先に畳まれた後で
 *   遅れて決着した処理 (ASR の確定待ちなど) から呼ぶ時に渡す。渡すと respondFlow が
 *   既に null でも「応答フローの画面/録音に居た」と判断して idle まで戻す。
 *   通常の tmux 録音を巻き添えにしないよう、この判断は明示的に渡された時だけ行う。
 */
function resetRespondFlow(reason: string, endedFlow?: RespondFlow): void {
  const flow = respondFlow
  const wasActive = flow !== null || endedFlow != null || phase === 'cc-message' || phase === 'cc-response'
  clearRespondError()
  if (flow?.recording || endedFlow?.recording) discardRespondRecording()
  respondFlow = null
  if (!wasActive) return
  log(`応答フローを終了しました (${reason})`)
  if (phase === 'cc-message' || phase === 'cc-response' || phase === 'recording' || phase === 'finalizing') {
    phase = 'idle'
  }
  paintStatus()
  updateRecordButton()
  void refreshG2(true)
}

/** 送信が決着したので畳む。楽観的に用件も消す (取り違えないよう id 一致時だけ)。 */
function completeRespondFlow(pendingId: string): void {
  if (claudePending?.id === pendingId) claudePending = null
  resetRespondFlow('completed')
}

/**
 * Type something の録音を、確定させずに丸ごと捨てる。
 * 応答フローを畳む側から呼ぶので、ここでは phase を触らない (呼び出し側が決める)。
 */
function discardRespondRecording(): void {
  stopRecordingTimer()
  try { void bridge?.audioControl(false) } catch { /* ignore */ }
  rtSession?.abort()
  rtSession = null
  resetPcmCounter()
  recordingScrollOffset = 0
  recordingLinesCache = []
  recordingLinesCacheKey = ''
  liveTranscript = ''
  durationEl.textContent = '0.0s'
  recordingReady = false
}

/** 送信失敗の表示を消す (ユーザが次の操作をした時 / フローを畳む時)。 */
function clearRespondError(): void {
  if (respondErrorTimer) { clearTimeout(respondErrorTimer); respondErrorTimer = null }
  if (respondFlow) respondFlow.error = null
}

/** 送信失敗の表示を出し、一定時間後に自動で消す。 */
let respondErrorTimer: ReturnType<typeof setTimeout> | null = null
const RESPOND_ERROR_SHOW_MS = 8000
function showRespondError(message: string): void {
  if (!respondFlow) return
  respondFlow.error = message
  if (respondErrorTimer) clearTimeout(respondErrorTimer)
  respondErrorTimer = setTimeout(() => {
    respondErrorTimer = null
    if (!respondFlow?.error) return
    respondFlow.error = null
    void refreshG2(true)
  }, RESPOND_ERROR_SHOW_MS)
}

/**
 * phase と respondFlow の整合を実行時にも確かめる。
 * 「cc-* に居るのに flow が無い」状態が作れてしまうと、以降の操作が全部
 * 無反応になり (画面から出られない)、原因も画面に出ない。見つけたら記録して
 * idle へ落として自己回復する。
 */
function assertRespondFlowInvariant(where: string): void {
  const inRespondPhase = phase === 'cc-message' || phase === 'cc-response'
  if (inRespondPhase && !respondFlow) {
    log(`[bug] 応答画面なのに respondFlow が無い (${where}) — idle に戻します`)
    phase = 'idle'
    paintStatus()
    updateRecordButton()
    void refreshG2(true)
    return
  }
  if (!inRespondPhase && respondFlow && !flowIsInFlight(respondFlow) && !respondFlow.recording) {
    log(`[bug] 応答画面を離れているのに respondFlow が残っている (${where}) — 破棄します`)
    respondFlow = null
  }
}

/**
 * セッションが切り替わった時の応答系の後始末。
 * なぜ: 用件 (pending) はセッションごとのものなので、切替後もそのまま持っていると
 * 前のセッションの用件に対する作りかけの回答が、次に来た用件の画面に混ざる。
 * Type something の録音中 / 確定待ちでも、録音を捨てて idle へ落とす。
 */
function resetRespondStateForSessionChange(): void {
  claudePending = null
  resetRespondFlow('session-change')
}

/**
 * ポーリング結果と応答画面の突き合わせ。cc-message / cc-response を開いている間に
 * 対象の pending が消えた / 別物に入れ替わった場合の始末をする。
 * なぜ: 気付かずに操作を続けると、古い用件のつもりで作った回答が別の用件に送られる。
 *   - 消えた (別経路で承認済み等) → 構築中の回答を捨てて idle へ戻す
 *   - id が変わった → 回答を捨て、新しい用件の本文 (cc-message) の先頭から読み直させる
 * 送信中 (inFlightSince≠null) は触らない: 決着の後始末は送信側が自分で行う。
 */
function reconcileRespondPending(): void {
  // ポーリングのたびに phase と respondFlow の整合も確かめる (片方だけ残る状態の検出口)
  assertRespondFlowInvariant('poll')
  const flow = respondFlow
  if (!flow) return
  if (flowIsInFlight(flow)) return
  if (!claudePending) {
    log('応答対象の pending が消えたので idle に戻ります')
    resetRespondFlow('pending-gone')
    return
  }
  if (flow.pendingId === claudePending.id) return
  log('応答対象の pending が入れ替わったので、新しい用件の先頭から読み直します')
  rebindRespondFlow(claudePending)
}

async function sendPendingResponseAndFinish(): Promise<void> {
  const flow = respondFlow
  if (!claudePending || !flow) return
  const sessionName = settings.sessionName
  if (!sessionName) return
  // 応答は「この用件に対する回答」であることを id で明示する。サーバ側で現在の
  // pending と食い違っていたら 409 が返るので、取り違えた回答が通ることはない。
  const pendingId = claudePending.id
  if (flowIsInFlight(flow)) return   // 同じ用件への 2 通目 (再タップ) は出さない
  flow.inFlightSince = performance.now()
  flow.error = null
  // fetch が決着しないままになった場合の脱出口。時間切れで入力ガードだけ先に解く。
  // タイマーはこの送信専用に持つ (グローバルに 1 本だと、遅れて決着した古い送信の
  // 後始末が、次の送信の脱出口を消してしまう)。
  const guardTimer = setTimeout(() => releaseStuckInFlightGuard(flow), RESPOND_INFLIGHT_GUARD_MS)
  // 失敗したら回答を残して画面に留まる (作り直させない)。捨てるのは決着した時だけ。
  let outcome: 'sent' | 'stale' | 'failed' | 'interrupted' = 'failed'
  let failureMessage = ''
  try {
    if (claudePending.kind === 'permission') {
      const decision = flow.cursor === 0 ? 'allow' : 'deny'
      await client.respondClaude(sessionName, { kind: 'permission', decision, pendingId, lang: getLanguage() })
      log(`responded permission: ${decision}`)
    } else {
      const questions = claudePending.questions ?? []
      const answers = questions.map((q, i) => {
        const a = flow.answers[i]
        if (a?.kind === 'chat-about-this') {
          return { question: q.question, answerKind: 'chat-about-this' as const }
        }
        if (a?.kind === 'type-something') {
          return { question: q.question, answerKind: 'type-something' as const, text: a.text }
        }
        if (a?.kind === 'predefined') {
          if (q.multiSelect) {
            return { question: q.question, answerKind: 'predefined' as const, options: a.options ?? [] }
          }
          return { question: q.question, answerKind: 'predefined' as const, option: a.option ?? '' }
        }
        // 未回答 → 空回答 (サーバ側で弾かれる可能性あり)
        return { question: q.question, answerKind: 'predefined' as const, option: '' }
      })
      // lang は chat 履歴に残す回答整形文の言語 (Web UI と同じ扱いにする)
      await client.respondClaude(sessionName, { kind: 'question', answers, pendingId, lang: getLanguage() })
      log(`responded question (${answers.length} answers)`)
    }
    outcome = 'sent'
  } catch (e) {
    if (e instanceof PendingConflictError) {
      // 送信中に用件が入れ替わっていた (サーバ側でキー注入前に打ち切られている)。
      // 作った回答はもう行き先が無いので捨て、次のポーリングで新しい用件を取り直す。
      log('respond conflict: 応答先の用件が入れ替わっていたため回答を破棄します')
      outcome = 'stale'
    } else if (e instanceof RespondInterruptedError) {
      // キーを途中まで撃った後で打ち切られた。一部だけ TUI に届いている可能性があるので、
      // 「送っていない」とも「送った」とも言えない。回答は残すが自動では送り直さない
      // (二重に撃つと選択が壊れる)。送り直すかはユーザのタップに委ねる。
      failureMessage = (e as Error).message
      log(`respond interrupted: ${failureMessage} (一部送信済みの可能性あり)`)
      outcome = 'interrupted'
    } else {
      // タイムアウト / 500 / 別理由の 409。回答は残して画面に留まり、再試行させる。
      failureMessage = (e as Error).message
      log(`respond error: ${failureMessage}`)
      outcome = 'failed'
    }
  } finally {
    flow.inFlightSince = null
    clearTimeout(guardTimer)
    // POST の間に画面が別の用件へ移っていた (ポーリングで入れ替わり検知 / セッション切替 /
    // ダブルタップでキャンセル) 場合、新しい回答フローの状態を壊さないよう何もしない。
    // 後始末をするのは「今も自分が答えた用件を対象にしている」時だけ。
    if (respondFlow === flow && flow.pendingId === pendingId) {
      if (outcome === 'failed' || outcome === 'interrupted') {
        // 回答も cc-response 画面もそのまま残す。フッターに案内を出すだけ。
        showRespondError(outcome === 'interrupted' ? t('respondInterrupted') : t('respondFailedRetry'))
        void refreshG2(true)
      } else {
        completeRespondFlow(pendingId)
      }
    }
    // 状態の再同期はどちらの場合も行う (新しい用件の有無をサーバに聞き直す)
    void refreshClaudeData()
  }
}

function backToRoot(): void {
  if (phase !== 'idle') return
  log('back to root list')
  syncRootCursor()
  phase = 'rootlist'
  paintStatus()
  void refreshG2(true)
  updateRecordButton()
}

confirmBtn.addEventListener('click', () => { void confirmAndSend() })
discardBtn.addEventListener('click', () => { discardPending() })

// ─── Boot ──────────────────────────────────────────────────────────────
function setupLogToolbar(): void {
  const copyBtn = document.getElementById('copyLogBtn') as HTMLButtonElement | null
  const clearBtn = document.getElementById('clearLogBtn') as HTMLButtonElement | null

  copyBtn?.addEventListener('click', async () => {
    const text = logEl.textContent ?? ''
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      copyBtn.textContent = 'Copied!'
      setTimeout(() => { copyBtn.textContent = 'Copy' }, 1500)
    } catch (err) {
      console.error('[headlenss] copy failed', err)
    }
  })

  clearBtn?.addEventListener('click', () => {
    logEl.textContent = ''
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    promise.then(
      (v) => { window.clearTimeout(timer); resolve(v) },
      (e) => { window.clearTimeout(timer); reject(e) },
    )
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c])
}
function escapeAttr(s: string): string {
  return escapeHtml(s)
}

// ─── Toast ─────────────────────────────────────────────────────────────
let toastHideTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string, ms = 2500): void {
  toastEl.textContent = text
  toastEl.hidden = false
  // 1フレーム遅らせて opacity を上げる (display:none → block 直後に transition が効かないため)
  requestAnimationFrame(() => toastEl.classList.add('visible'))
  if (toastHideTimer) clearTimeout(toastHideTimer)
  toastHideTimer = setTimeout(() => {
    toastEl.classList.remove('visible')
    setTimeout(() => { toastEl.hidden = true }, 200)
  }, ms)
}

/** toast を即座に消す。自動で消すタイマーを止める側が、出しっぱなしを残さないために呼ぶ。 */
function hideToastNow(): void {
  toastEl.classList.remove('visible')
  toastEl.hidden = true
}

// ─── Claude セッション一覧 (WebView) ───────────────────────────────────
function claudeStatusLabel(status: string): string {
  switch (status) {
    case 'idle': return t('claudeStatusIdle')
    case 'busy': return t('claudeStatusBusy')
    case 'waiting-permission': return t('claudeStatusWaitPerm')
    case 'waiting-question': return t('claudeStatusWaitQ')
    default: return status
  }
}

function renderClaudeSessionsList(): void {
  if (!claudeSessionsListEl) return
  // サーバへ疎通していない(=実質「未認証」)間は Claude 関連 UI ごと隠す。
  // サーバ疎通が前提のフォーム/一覧をクリックできても何もできないので。
  const hideClaude = !serverProbeOk
  if (claudeSessionsCardEl) claudeSessionsCardEl.hidden = hideClaude
  if (newClaudeSessionCardEl) newClaudeSessionCardEl.hidden = hideClaude
  // summary に件数バッジ
  const countEl = document.getElementById('claudeSessionsCount')
  if (countEl) countEl.textContent = serverProbeOk ? `(${claudeSessions.length})` : ''
  if (!serverProbeOk) {
    claudeSessionsListEl.innerHTML = `<li class="claude-empty">${escapeHtml(serverErrorMsg || '(server not reachable)')}</li>`
    return
  }
  if (claudeSessions.length === 0) {
    claudeSessionsListEl.innerHTML = `<li class="claude-empty">${escapeHtml(t('claudeSessionsEmpty'))}</li>`
    return
  }
  claudeSessionsListEl.innerHTML = ''
  for (const s of claudeSessions) {
    const li = document.createElement('li')
    li.className = 'claude-item' + (s.tmuxSessionName === settings.sessionName ? ' active' : '')
    li.dataset.name = s.tmuxSessionName
    const status = s.status
    // ポーリング再描画で pending 確認状態が失われないよう、Map を見て復元する
    const isKillPending = pendingKillTimers.has(s.tmuxSessionName)
    const isKilling = killingSessions.has(s.tmuxSessionName)
    let killClass = 'claude-kill'
    let killLabel = '✕'
    let killDisabled = ''
    if (isKilling) {
      killClass = 'claude-kill kill-busy'
      killLabel = `${escapeHtml(t('claudeKillingBtn'))}<span class="kill-spinner" aria-hidden="true"></span>`
      killDisabled = ' disabled'
    } else if (isKillPending) {
      killClass = 'claude-kill kill-pending'
      killLabel = escapeHtml(t('claudeKillConfirmBtn'))
    }
    const agent = s.source === 'codex' ? 'Codex' : s.source === 'claude' ? 'Claude' : 'Agent'
    // 画面ブロック中は名前の横に警告を出す (status の dot はそのまま。status は正しいので変えない)
    const blockedMark = s.screenBlocked === true
      ? ` <span class="claude-blocked" title="${escapeAttr(t('claudeStatusBlocked'))}">⚠</span>`
      : ''
    li.innerHTML =
      `<span class="claude-status" data-status="${escapeAttr(status)}" title="${escapeAttr(claudeStatusLabel(status))}">●</span>` +
      `<div class="claude-info">` +
        `<div class="claude-name">${escapeHtml(s.tmuxSessionName)} <span class="agent-label">${agent}</span>${blockedMark}</div>` +
        `<div class="claude-cwd">${escapeHtml(s.cwd || '~')}</div>` +
      `</div>` +
      `<button class="${killClass}" data-action="kill" aria-label="kill ${escapeAttr(s.tmuxSessionName)}"${killDisabled}>${killLabel}</button>`
    claudeSessionsListEl.appendChild(li)
  }
}

claudeSessionsListEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const li = target.closest<HTMLLIElement>('.claude-item')
  if (!li) return
  const name = li.dataset.name
  if (!name) return
  // ✕ ボタンが押されたかどうかを優先判定
  const killBtn = target.closest<HTMLButtonElement>('.claude-kill')
  if (killBtn) {
    e.stopPropagation()
    handleKillButtonClick(name, killBtn)
    return
  }
  // 通常クリック → 選択 (settings.sessionName を更新)
  if (settings.sessionName !== name) {
    abortInFlightRefresh()
    settings.sessionName = name
    // 前セッションの用件と作りかけの回答を捨てる (G2 側の選択と同じ後始末)。
    // 応答画面を開いたままここから切り替えると、古い用件への回答が新しい
    // セッションの用件に適用されてしまうため。
    resetRespondStateForSessionChange()
    void persistSettings()
    renderClaudeSessionsList()
    renderSessionPills()
    log(`Active session set: ${name}`)
    if (phase === 'rootlist') {
      // rootlist のカーソル名も合わせる
      rootCursorKey = `s:${name}`
      void refreshG2(true)
    }
  }
})

reloadClaudeBtn.addEventListener('click', () => {
  void reloadClaudeSessions()
})

/**
 * 2タップ式の kill 確認。
 *  1回目: ✕ → "確定?" (赤色) に変化、3 秒で自動 revert
 *  2回目: 同じ名前で再タップ → 実際に kill 実行
 *
 * Even Realities WebView (Flutter InAppWebView) は window.confirm が
 * 実装されておらず常に false を返す模様。confirm を使わずに WebView
 * 内だけで完結する確認 UI を組む。
 */
const pendingKillTimers = new Map<string, ReturnType<typeof setTimeout>>()
// 確定後 → 実際にリストから消えるまで「停止中…」スピナーを出すための追跡
const killingSessions = new Set<string>()

function handleKillButtonClick(name: string, btn: HTMLButtonElement): void {
  if (killingSessions.has(name)) return  // 二重実行防止
  const existing = pendingKillTimers.get(name)
  if (existing) {
    // 2 回目: 確定 → 実行
    clearTimeout(existing)
    pendingKillTimers.delete(name)
    void doKillClaudeSession(name)
    return
  }
  // 1 回目: 確認状態へ遷移
  btn.classList.add('kill-pending')
  btn.textContent = t('claudeKillConfirmBtn')
  const timer = setTimeout(() => {
    pendingKillTimers.delete(name)
    // DOM が再描画で消えてる可能性に備えて null チェック
    if (btn.isConnected) {
      btn.classList.remove('kill-pending')
      btn.textContent = '✕'
    }
  }, 3000)
  pendingKillTimers.set(name, timer)
}

async function doKillClaudeSession(name: string): Promise<void> {
  log(`Killing Agent session: ${name}`)
  killingSessions.add(name)
  // 「停止中…」表示を即時反映
  renderClaudeSessionsList()
  try {
    await client.killSession(name)
    log(`Killed: ${name}`)
    await reloadClaudeSessions()
  } catch (e) {
    log(`killSession error: ${(e as Error).message}`)
  } finally {
    killingSessions.delete(name)
    // 失敗時もボタンを通常表示に戻す
    renderClaudeSessionsList()
  }
}

// ─── 新規 Claude セッション ────────────────────────────────────────────
function setNewClaudeStatus(kind: 'ok' | 'err' | 'busy' | 'muted', text: string): void {
  newClaudeStatusEl.className = `probe small ${kind === 'muted' ? 'muted' : kind}`
  newClaudeStatusEl.textContent = text
}

async function submitNewClaudeSession(e: Event): Promise<void> {
  e.preventDefault()
  if (!serverProbeOk) {
    setNewClaudeStatus('err', t('g2Unreachable'))
    return
  }
  const name = newClaudeNameEl.value.trim()
  const cwdRaw = newClaudeCwdEl.value.trim()
  if (!name) {
    setNewClaudeStatus('err', t('newClaudeNeedName'))
    return
  }
  const submitBtn = newClaudeForm.querySelector<HTMLButtonElement>('button[type="submit"]')
  if (submitBtn) submitBtn.disabled = true
  setNewClaudeStatus('busy', t('newClaudeStarting'))
  try {
    await client.createSession(name, {
      cwd: cwdRaw || undefined,
      startClaude: newAgentKindEl.value !== 'codex',
      startCodex: newAgentKindEl.value === 'codex',
    })
    log(`Started new agent session: ${name} cwd=${cwdRaw || '(home)'}`)

    // agent プロセスが ~/.claude/sessions/<PID>.json に登録されるまで時間がかかるので、
    // listClaudeSessions に新セッションが現れるまで polling する。
    // 起動成功 ≠ 即検出可能 なので、最大 ~12 秒まで 500ms 間隔でリトライ。
    const startedAt = Date.now()
    const POLL_TIMEOUT_MS = 12000
    let appeared = false
    setNewClaudeStatus('busy', `${t('newClaudeStarting')} ${t('newClaudeDetecting')}`)
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 500))
      await reloadClaudeSessions()
      if (claudeSessions.some((s) => s.tmuxSessionName === name)) {
        appeared = true
        break
      }
    }

    if (appeared) {
      // 検出成功: rootlist のカーソルを新セッションに合わせて、レンズへ即反映
      rootCursorKey = `s:${name}`
      setNewClaudeStatus('ok', `${t('newClaudeOk')} (${name})`)
      log(`Agent session "${name}" detected (took ${Date.now() - startedAt}ms)`)
    } else {
      // tmux session 自体は作成済みだが Claude の registry 登録が遅れているケース。
      // 一覧に出るのは遅延するが処理は成功扱いとする。
      setNewClaudeStatus('ok', `${t('newClaudeOk')} (${name}) ${t('newClaudeWaitDetect')}`)
      log(`Agent session "${name}" not yet registered after ${POLL_TIMEOUT_MS}ms — keep polling in background`)
    }
    newClaudeNameEl.value = ''
    newClaudeCwdEl.value = ''
    // 念押しで G2 レンズへ反映 (phase が rootlist でなくても次の遷移で乗る)
    if (phase === 'rootlist') void refreshG2(true)
  } catch (err) {
    setNewClaudeStatus('err', t('newClaudeFail') + (err as Error).message)
  } finally {
    if (submitBtn) submitBtn.disabled = false
  }
}

/**
 * 外部ブラウザを開きたいリンク (Speechmatics portal 等) のハンドラ。
 * Even Realities WebView が target="_blank" を外部ブラウザへ転送するかは未確認。
 *  - 成功すれば素直に開く
 *  - 失敗 (同一WebView内遷移 / 何も起きない) でも、URL を clipboard に
 *    コピーしておくのでユーザは手動で別ブラウザに貼って遷移できる
 */
function setupExternalLink(anchor: HTMLAnchorElement): void {
  anchor.addEventListener('click', async () => {
    const url = anchor.href
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
        showToast(t('toastUrlCopied'))
      } else {
        // 古い WebView 向けフォールバック
        const ta = document.createElement('textarea')
        ta.value = url
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy'); showToast(t('toastUrlCopied')) }
        catch { showToast(t('toastUrlCopyFail') + url, 6000) }
        document.body.removeChild(ta)
      }
    } catch {
      showToast(t('toastUrlCopyFail') + url, 6000)
    }
    // preventDefault しない: WebView が外部ブラウザに渡せるなら渡してほしいので素通り
  })
}

function refreshLangSelectorLabel(): void {
  const cur = getLanguage()
  langCurrentEl.textContent = LANGUAGE_LABELS[cur]
  langDropdownEl.querySelectorAll<HTMLLIElement>('li[data-lang]').forEach((li) => {
    li.classList.toggle('active', li.dataset.lang === cur)
  })
}

function setupLanguageSelector(): void {
  langToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const expanded = !langDropdownEl.hasAttribute('hidden')
    if (expanded) {
      langDropdownEl.setAttribute('hidden', '')
      langToggleBtn.setAttribute('aria-expanded', 'false')
    } else {
      langDropdownEl.removeAttribute('hidden')
      langToggleBtn.setAttribute('aria-expanded', 'true')
    }
  })
  langDropdownEl.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-lang]')
    if (!li) return
    const lang = li.dataset.lang as Language
    if (lang !== 'en' && lang !== 'ja') return
    void changeLanguage(lang)
    langDropdownEl.setAttribute('hidden', '')
    langToggleBtn.setAttribute('aria-expanded', 'false')
  })
  document.addEventListener('click', (e) => {
    if (!langDropdownEl.hasAttribute('hidden')) {
      const target = e.target as Node
      if (!langToggleBtn.contains(target) && !langDropdownEl.contains(target)) {
        langDropdownEl.setAttribute('hidden', '')
        langToggleBtn.setAttribute('aria-expanded', 'false')
      }
    }
  })
}

async function changeLanguage(lang: Language): Promise<void> {
  if (settings.language === lang) return
  settings.language = lang
  setLanguage(lang)
  applyTranslations()
  refreshLangSelectorLabel()
  // ステータスバー / Pending UI / 履歴 / セッションピル / Claude 一覧の表示文字列も即時更新
  paintStatus()
  updateRecordButton()
  updatePendingUI()
  renderSettings()
  renderHistory()
  renderSessionPills()
  renderClaudeSessionsList()
  setProbeText('muted', t('unset'))
  if (settings.serverBaseUrl) {
    // probe text を再計算するために軽く呼び直し
    void probeServer()
  }
  await persistSettings()
  // G2 レンズも「言語切替」を 1 つの画面遷移と扱って rebuildPageContainer で再描画。
  // プラグイン遷移中は描かない (refreshG2 と同じ理由: 「接続中」を上書きしてしまう)。
  if (bridge && !pluginNavBlocksG2Render) {
    try {
      await sendShowScreen(buildG2Header(), buildG2Content(), buildG2Footer())
    } catch (err) {
      log(`G2 re-render on lang change error: ${err}`)
    }
  }
}

async function boot(): Promise<void> {
  setupLogToolbar()
  setupLanguageSelector()
  setupExternalLink(obSmPortalLink)
  setRendererLog(log)
  newClaudeForm.addEventListener('submit', (e) => { void submitNewClaudeSession(e) })

  // 1. Bridge 接続 (必須)
  try {
    bridge = await withTimeout(waitForEvenAppBridge(), BRIDGE_TIMEOUT_MS)
    log('Connected to Even bridge')
  } catch {
    log('Even bridge not available — このアプリはG2 SDK経由でしか動作しません')
  }

  // G2 プラグインから戻ってきた場合、ホスト側セッションにはプラグインのコンテナが
  // 残っている。createStartUpPageContainer はセッションにつき 1 回きりなので、
  // 初回描画を rebuildPageContainer に切り替える (拒否されたら create へ戻る)。
  const returning = await consumeReturnFlag(bridge)
  if (returning.found) {
    log(`プラグインからの復帰を検出 (経路=${returning.via.join('+')}) — 初回描画を rebuild で行います`)
    markPageAlreadyBuilt()
  }

  // 2. G2画面初期化
  if (bridge) {
    initRenderer(bridge)
    // renderer 内から出る例外的な送信 (復帰後ガード再描画) も、この 1 本の直列路を通す
    setRendererExclusiveSender(runExclusiveG2Send)
    // 取り込み (performTakeover) の直前に no-op へ差し替えるので、取り込みに失敗して
    // headlenss に戻る時に同じ内容を再登録できるよう、登録処理を関数で持っておく。
    const installHandlers = (): void => setEventHandlers({
      // rootlist: 上下=カーソル / click=open / dbl=OS終了
      // pending:  上=送信 / 下=テキスト削除 / dbl=破棄して idle へ
      // idle:     上=過去ログ / 下=新しい方へ / dbl=root へ戻る
      // cc-message:  上下=本文スクロール / click=選択肢画面へ / dbl=キャンセルして idle へ
      // cc-response: 上下=選択肢移動 / dbl=cc-message へ戻る
      onScrollUp: () => {
        if (respondInputBlocked()) return  // 応答 POST 中は応答画面の入力を無視
        if (phase === 'rootlist') moveRootCursor(-1)
        else if (phase === 'pending') void confirmAndSend()
        else if (phase === 'idle') scrollBack()
        else if (phase === 'recording') recordingScrollBack()
        else if (phase === 'cc-message') ccMsgScrollBack()
        else if (phase === 'cc-response') moveRespondCursor(-1)
      },
      onScrollDown: () => {
        if (respondInputBlocked()) return  // 応答 POST 中は応答画面の入力を無視
        if (phase === 'rootlist') moveRootCursor(1)
        else if (phase === 'pending') removeLastSentence() // 末尾1文だけ削除。空になれば idle
        else if (phase === 'idle') scrollForward()
        else if (phase === 'recording') recordingScrollForward()
        else if (phase === 'cc-message') ccMsgScrollForward()
        else if (phase === 'cc-response') moveRespondCursor(1)
      },
      onClick: () => {
        if (respondInputBlocked()) return  // 応答 POST 中はタップも無視
        void toggleRecording()
      },
      // 二重クリック: 各 phase での「戻る/キャンセル」操作
      onDoubleClick: () => {
        // プラグインへの遷移待ちで固まっている場合は、まずそれを中止する。
        // (接続先が落ちていると Connecting 表示のまま戻れなくなるため)
        // 描画停止だけが残っている状態 (取り込み直前で失敗した等) も同じ口で解く。
        if (navigatingToPlugin || pluginNavBlocksG2Render) { cancelPluginNavigation(); return }
        // 応答 POST 中は「戻る/キャンセル」も無視する。ここだけ通していたので、
        // 送信中のダブルタップでフロー (と対象 pending の束縛) が消え、返ってきた
        // 応答の後始末が迷子になっていた。返事が来るまで待たせる。
        if (respondInputBlocked()) return
        if (phase === 'idle') backToRoot()
        else if (phase === 'recording') void abortRecording()  // 録音中止 (新しい文は追加しない)
        else if (phase === 'pending') discardPending()         // pending 全破棄 → idle
        else if (phase === 'cc-response') backToCcMessage()  // 選択肢画面 → 本文閲覧画面へ戻る
        else if (phase === 'cc-message') resetRespondFlow('cancel')  // 応答キャンセル → idle へ
        else if (
          phase === 'rootlist' ||
          phase === 'unconfigured' ||
          phase === 'boot' ||
          phase === 'error'
        ) {
          // Even Hub 審査要件: ルート画面に加え、設定前 (unconfigured) / 起動中 (boot) /
          // エラー (error) 画面でも double-tap で OS 終了ダイアログを出す。
          // API ログイン前でもアプリを終了できるようにするための対応。
          void bridge?.shutDownPageContainer(1)
        }
      },
      onAudio: (pcm) => {
        if (phase !== 'recording') return
        trackPcmFrame(pcm)
        rtSession?.send(pcm)
      },
      // G2 アプリ画面に戻ってきたとき: ページを再生成して最新の tmux 出力を再描画
      onForegroundEnter: () => {
        if (pluginNavBlocksG2Render) {
          // プラグイン遷移中 (location.assign 待ち等)。ここで描くと「接続中」が
          // headlenss の画面で上書きされ、遷移先が出るまでの間だけ一覧に戻って見える。
          log('foreground enter — plugin 遷移中なので再描画しません')
          return
        }
        log('foreground enter — re-rendering lens')
        resetPageState()
        void (async () => {
          try {
            await sendShowScreen(buildG2Header(), buildG2Content(), buildG2Footer())
          } catch (err) {
            log(`re-render error: ${err}`)
          }
          void refreshClaudeData()
          startOutputPolling()  // ポーリングタイマーをリセット
        })()
      },
      onForegroundExit: () => {
        // 録音中に離脱した場合はここで必ず後始末する。放置するとマイクが開いたまま、
        // 音声認識の WebSocket も開いたままになり、離脱のたびに積み上がる。
        // 録音済みの確定文 (pendingSentences) は abortRecording が保持する。
        if (phase === 'recording') {
          log('foreground exit during recording — aborting')
          void abortRecording()
        }
        // ページが破棄されている可能性に備え、次回入場時に createStartUpPageContainer に戻す
        resetPageState()
      },
      onLog: (msg) => log(msg),
    })
    reinstallG2EventHandlers = installHandlers
    installHandlers()
    try {
      await sendShowScreen(buildG2Header(), buildG2Content(), buildG2Footer())
      bridge.onEvenHubEvent(onEvenHubEvent)
    } catch (err) {
      log(`G2 initial render error: ${err}`)
    }
  }

  // 3. 設定ロード
  settings = await loadSettings(bridge)
  log(`Loaded settings: server=${settings.serverBaseUrl || '(none)'} session=${settings.sessionName} lang=${settings.language}`)
  applyClientBase()
  setScrollCooldownMs(settings.scrollCooldownMs) // events.ts に保存済みの値を反映
  // 設定の言語を反映 (WebView の data-i18n を一斉に書き換え + セレクタラベル)
  setLanguage(settings.language)
  applyTranslations()
  refreshLangSelectorLabel()
  renderSettings()

  // 4. UI events
  recordBtn.addEventListener('click', () => { void toggleRecording() })

  // 5. 初回 or 設定済みかで表示切替
  if (!isConfigured(settings)) {
    obServerUrlEl.value = settings.serverBaseUrl
    obSmKeyEl.value = settings.speechmaticsApiKey
    obFinishBtn.disabled = !settings.speechmaticsApiKey
    showOnboardingStep(settings.serverBaseUrl ? 2 : 1)
    setView('onboarding')
    if (settings.serverBaseUrl) void obProbe(settings.serverBaseUrl)
  } else {
    setView('dashboard')
  }

  // 6. 状態同期 + サーバ疎通
  renderHistory()
  recomputePhase()
  if (settings.serverBaseUrl) {
    await probeServer()
  } else {
    setProbeText('muted', t('unset'))
  }

  // boot 直後の最初の showScreen は phase='boot' で実行され "headlenss" だけが描かれる。
  // recomputePhase 内の refreshG2 は textContainerUpgrade 経由の差分更新だが、
  // シミュレータでは差分更新が反映されないケースがある。
  // ここで rebuildPageContainer 経路の showScreen を呼んで、現在の phase
  // (通常 'unconfigured') の内容を確実にレンズへ流す。
  // resetPageState は呼ばない (createStartUpPageContainer の二重発行を避ける)。
  if (bridge) {
    try {
      await sendShowScreen(buildG2Header(), buildG2Content(), buildG2Footer())
      log(`G2 lens rendered (phase=${phase})`)
    } catch (err) {
      log(`G2 final render error: ${err}`)
    }
  }

  // セッション一覧を定期的に更新
  startSessionsRefreshTimer()

  // tmux 出力ポーリング (idle時のみ実行)
  startOutputPolling()
  if (serverProbeOk) {
    // 起動直後にレンズが空表示になるのを避けるため、ポーリング待たずに即フェッチ
    void reloadClaudeSessions()
    void refreshClaudeData()
    // 念のため数百ms後にもう一度叩く (Claude Code 側の registry 書き込みタイミング次第で
    // 1回目で見えないケースがあるため)
    setTimeout(() => {
      if (!serverProbeOk) return
      void reloadClaudeSessions()
    }, 500)
  }
}

// G2 プラグインから history.back() で戻ってきた場合、WebView は履歴復帰 (bfcache)
// になることがある。復帰したページはブリッジ経路が死んでいることがあるため
// (even-loader が公式シミュレータで実測)、リロードして通常の boot 経路に戻す。
// reload 後の boot が初回描画を rebuild にできるよう、同期的にフラグを立ててから
// リロードする。
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return
  log('pageshow (履歴復帰) — リロードして再初期化します')
  markReturnReload()
  location.reload()
})

boot().catch((err) => {
  log(`Fatal: ${err}`)
  phase = 'error'
  serverErrorMsg = (err as Error).message
  paintStatus()
})
