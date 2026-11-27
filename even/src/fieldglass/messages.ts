// Messages (iMessage を読む / 返信する) のレンズ側。SPEC AMENDMENT 2。
//
// 送るのは Mac (サーバの osascript)。レンズは次の画面だけを持つ:
//
//   list ──Tap──> thread ──Tap──> [録音 → 下書き確認: main.ts の既存フローをそのまま使う]
//    │2Tap          │2Tap            └─ ↑ (送信) で confirm へ
//    ↓              ↓
//   (一覧へ)       list            confirm ──Tap──> sending ──> result (Sent / Delivery unknown / Failed)
//                                     │2Tap = 下書きへ戻って編集   hold = Discard
//
// 守ること:
//   - 送信は confirm 画面の Tap だけ。宛先の名前と全文を必ず見せた後。自動送信・自動再送はしない。
//   - 結果が分からない (タイムアウト・通信断・state:'unknown') 時は「Delivery unknown」で止め、
//     再送させない (同じ draftId ならサーバは無視するが、それでも利用者に Messages を確認させる)。
//   - 本文はログに出さない (長さだけ)。描画経路 (renderer.ts) が本文 1 行目を console に出すので、
//     1 行目には会話の本文を置かない。
//   - 一覧の取得 (20 秒ごと) は Messages の画面が開いている間だけ。

import { t, tf, type StringKey } from '../i18n'
import type { MessagesReplyResult, MessagesStatus, MessagesThread, MessagesThreadDetail } from '../server-client'

export interface MessagesApi {
  messagesStatus(): Promise<MessagesStatus>
  messagesThreads(): Promise<MessagesThread[]>
  messagesThread(id: string): Promise<MessagesThreadDetail>
  messagesReply(id: string, input: { text: string; draftId: string }): Promise<MessagesReplyResult>
}

/** main.ts の下書き (PromptDraft) のうち、返信に要る分だけ。 */
export type ReplyDraftView = {
  threadId: string
  name: string
  draftId: string
  text: string
  /** 音声認識が途中で切れて、受け取れた語だけで作った下書き (batch-2 の部分回復)。 */
  recoveredPartial: boolean
  /** 下書きを作った時のサーバ。送信はここへ (設定が変わっても別の Mac へは送らない)。 */
  serverBaseUrl: string
}

/**
 * 送信確認カードのフレーム札。このフレームの送信が SDK で成功して初めて Send を受け付ける。
 * seq は確認カードを開くたびに増える。draftId / text が変わった (編集した) 札は無効。
 */
export type MsgFrameTag = { seq: number; draftId: string; text: string }

export function sameMsgTag(a: MsgFrameTag | null | undefined, b: MsgFrameTag | null | undefined): boolean {
  return !!a && !!b && a.seq === b.seq && a.draftId === b.draftId && a.text === b.text
}

/**
 * サーバの理由コード (codex: reasonCode) → レンズの文言 (en/ja)。知らないコードはサーバの文をそのまま出す。
 * コード表は SPEC への提案 (build-claude-fieldglass.md の Fix round 4 に記載)。
 */
const REASON_KEY: Record<string, StringKey> = {
  group_read_only: 'msgReasonGroupReadOnly',
  unsupported_service: 'msgReasonService',
  ambiguous_target: 'msgReasonAmbiguous',
  automation_denied: 'msgReasonAutomation',
  read_denied: 'msgReasonReadDenied',
  target_unavailable: 'msgReasonUnavailable',
  draft_conflict: 'msgReasonDraftConflict',
  not_mac: 'msgReasonNotMac',
  stopping: 'msgReasonStopping',
  history_full: 'msgReasonHistoryFull',
  not_found: 'msgReasonNotFound',
  not_permitted: 'msgReasonNotPermitted',
  send_failed: 'msgReasonSendFailed',
  invalid_request: 'msgReasonInvalid',
  request_too_large: 'msgReasonTooLarge',
}

export function reasonText(code: string | undefined, fallback: string | undefined): string | undefined {
  const key = code ? REASON_KEY[code] : undefined
  return key ? t(key) : fallback
}

export interface MessagesDeps {
  client(): MessagesApi | null
  /** 指定したサーバ専用の client (返信の送信用)。 */
  clientFor(serverBaseUrl: string): MessagesApi | null
  /** ヘッダ 1 行に収める (はみ出す分を … で切る)。 */
  fitHeader?(text: string): string
  redraw(force?: boolean): Promise<void>
  notice(text: string): void
  wrap(text: string): string[]
  /** セッション一覧へ戻る。 */
  exit(): void
  /** このスレッドへの返信を、既存の録音 → 下書きフローで始める。 */
  startReply(thread: { id: string; name: string }): void
  /** confirm から下書き確認 (pending) へ戻る (編集)。 */
  backToDraft(): void
  /** 今の返信下書き。無ければ null。 */
  draft(): ReplyDraftView | null
  /** 下書きを捨てる (送れた / 結果不明 / 破棄)。 */
  clearDraft(): void
  log(msg: string): void
  now?: () => number
}

export type MsgScreen = 'list' | 'thread' | 'confirm' | 'sending' | 'result'
type ResultState = { kind: 'sent' | 'unknown' | 'failed'; name: string; reason?: string; reasonCode?: string }

export const MSG_MENU = { DISCARD: 201 } as const

const BODY_LINES = 7
const POLL_MS = 20_000
/** 確認カードが実際に出てから Send を受け付けるまでの最小の間 (下書きでの連打がそのまま送信にならない)。 */
const CONFIRM_MIN_DWELL_MS = 600

export class MessagesLens {
  screen: MsgScreen = 'list'
  status: MessagesStatus | null = null
  statusProblem: 'old' | 'offline' | null = null
  threads: MessagesThread[] | null = null
  threadsError = false
  cursor = 0
  thread: MessagesThreadDetail | null = null
  threadId: string | null = null
  threadError = false
  /** 末尾から何行戻ったか (0 = 最新)。 */
  threadScroll = 0
  confirmScroll = 0
  result: ResultState | null = null
  /** 送信中の draftId (二重タップで 2 通目を出さない)。 */
  private sendingDraft: string | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  /** 取得結果の世代 (サーバ切替・破棄で上がる)。古い結果はどこにも書かない。 */
  private gen = 0
  /** 定期取得の世代 (画面を閉じる / 離脱 / 録音へ移るたびに上がる)。古い取得の続きは次を読みに行かない。 */
  private pollGen = 0
  private lineCache: string[] = []
  /** 確認カードを開いた回 (札の seq)。 */
  private confirmSeq = 0
  /** その回の確認カードが実際にレンズへ出た時刻。出るまで Send は無効。 */
  private confirmShownAt: number | null = null
  /** テスト用に短くできる最小の間。 */
  confirmDwellMs = CONFIRM_MIN_DWELL_MS

  constructor(private deps: MessagesDeps) {}

  // ─── 入口 ────────────────────────────────────────────────────────────

  /** 起動時に 1 回: 一覧の行 (未読数 / 要設定) のための取得。定期取得はしない。 */
  async refreshSummary(): Promise<void> {
    await this.loadStatus()
    if (this.status?.canRead) await this.loadThreads()
  }

  /** セッション一覧から入った。 */
  enter(): void {
    this.screen = 'list'
    this.result = null
    this.startPolling()
    void this.refreshAll()
  }

  /** 録音・下書き確認へ移る / 一覧へ戻る / アプリを離れた時。画面が閉じている間は取りに行かない。 */
  pause(): void { this.stopPolling() }

  /** アプリへ戻ってきた (Messages の画面が開いている時だけ main が呼ぶ)。 */
  resume(): void {
    this.startPolling()
    void this.refreshAll()
  }

  /**
   * サーバの設定が変わった。前の Mac のスレッド名・一覧・取得中の結果を全部捨てる。
   * 作りかけの返信は main 側で前のサーバに束縛されたまま (送るならそのサーバへ)。
   */
  serverChanged(): void {
    this.gen++
    this.stopPolling()
    this.status = null
    this.statusProblem = null
    this.threads = null
    this.threadsError = false
    this.thread = null
    this.threadId = null
    this.cursor = 0
    if (this.screen === 'list' || this.screen === 'thread') this.screen = 'list'
  }

  /** main.ts: 下書き確認で「確認へ」→ ここへ。宛先と全文を見せる確認画面。 */
  openConfirm(): void {
    const d = this.deps.draft()
    if (!d) return
    this.screen = 'confirm'
    this.confirmScroll = 0
    this.result = null
    // 新しい回。このカードのフレームが実際に出るまで Send は受け付けない。
    this.confirmSeq++
    this.confirmShownAt = null
    void this.deps.redraw(true)
  }

  /** いま組むフレームの札 (確認カードの時だけ)。 */
  frameTag(): MsgFrameTag | null {
    if (this.screen !== 'confirm') return null
    const d = this.deps.draft()
    return d ? { seq: this.confirmSeq, draftId: d.draftId, text: d.text } : null
  }

  /** main.ts: 札付きのフレームが SDK で送れた。今の確認カード (同じ回・同じ下書き・同じ本文) なら Send を有効にする。 */
  onFrameRendered(tag: MsgFrameTag): void {
    if (this.screen !== 'confirm' || this.confirmShownAt !== null) return
    if (sameMsgTag(tag, this.frameTag())) this.confirmShownAt = this.now()
  }

  /** 確認カードが出て、最小の間も過ぎたか。 */
  confirmReady(): boolean {
    return this.screen === 'confirm' && this.confirmShownAt !== null && this.now() - this.confirmShownAt >= this.confirmDwellMs
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** 録音を始めずに戻ってきた (空の録音を取り消した等) → スレッド画面へ。 */
  returnToThread(): void {
    this.screen = this.threadId ? 'thread' : 'list'
    this.startPolling()
    void this.refreshAll()
  }

  destroy(): void {
    this.stopPolling()
    this.gen++
    this.confirmShownAt = null
  }

  rootRowLabel(): string {
    const head = t('msgRootLabel')
    if (this.statusProblem === 'old') return `${head}  ${t('msgRootServerOld')}`
    if (this.status && !this.status.canRead) return `${head}  ${t('msgRootSetup')}`
    if (!this.threads) return head
    const unread = this.threads.reduce((n, th) => n + (th.unread > 0 ? th.unread : 0), 0)
    return unread > 0 ? `${head}  ${tf('msgRootNew', { n: unread })}` : head
  }

  // ─── 描画 ────────────────────────────────────────────────────────────

  header(): string {
    const h = this.rawHeader()
    return this.deps.fitHeader ? this.deps.fitHeader(h) : h
  }

  /** ヘッダが切られて宛先名が全部は見えないか (確認カードでは本文に全名を出す)。 */
  private headerTruncated(): boolean {
    const h = this.rawHeader()
    return !!this.deps.fitHeader && this.deps.fitHeader(h) !== h
  }

  private rawHeader(): string {
    switch (this.screen) {
      case 'thread': return tf('msgHeadThread', { name: this.thread?.thread.name ?? this.currentThread()?.name ?? '' })
      case 'confirm':
      case 'sending': return tf('msgHeadTo', { name: this.deps.draft()?.name ?? '' })
      case 'result': return tf('msgHeadTo', { name: this.result?.name ?? '' })
      case 'list':
      default: return this.needsSetup() ? t('msgHeadSetup') : tf('msgHeadList', { n: this.threads?.length ?? 0 })
    }
  }

  content(): string {
    return this.bodyLines().slice(0, BODY_LINES).join('\n')
  }

  footer(): string {
    switch (this.screen) {
      case 'thread': return (this.thread?.thread ?? this.currentThread())?.canReply === false ? t('msgFootThreadRO') : t('msgFootThread')
      case 'confirm': return t('msgFootConfirm')  // Tap:Send ↑↓:Read 2Tap:Edit Hold:Discard
      case 'sending': return t('msgFootSending')
      case 'result': return this.result?.kind === 'failed' ? t('msgFootFailed') : t('msgFootResult')
      case 'list':
      default: return this.needsSetup() ? t('msgFootSetup') : t('msgFootList')
    }
  }

  menuItems(): { itemID: number; itemName: string }[] {
    if (this.screen === 'confirm' || (this.screen === 'result' && this.result?.kind === 'failed')) {
      return [{ itemID: MSG_MENU.DISCARD, itemName: t('msgMenuDiscard') }]
    }
    return []
  }

  private needsSetup(): boolean {
    return this.statusProblem === 'old' || (this.status !== null && !this.status.canRead)
  }

  private currentThread(): MessagesThread | undefined {
    return this.threads?.find((th) => th.id === this.threadId)
  }

  private bodyLines(): string[] {
    switch (this.screen) {
      case 'thread': return this.threadLines()
      case 'confirm': return this.confirmLines()
      case 'sending': return [t('msgSending')]
      case 'result': return this.resultLines()
      case 'list':
      default: return this.listLines()
    }
  }

  private listLines(): string[] {
    if (this.statusProblem === 'old') return [t('msgServerOld')]
    if (this.status && !this.status.canRead) {
      return [t('msgSetup1'), t('msgSetup2'), '', t('msgSetup3')]
    }
    if (this.threadsError && !this.threads) return [t('msgLoadFail')]
    if (!this.threads) return [t('msgLoading')]
    if (this.threads.length === 0) return [t('msgNoThreads')]
    const n = this.threads.length
    this.cursor = Math.max(0, Math.min(this.cursor, n - 1))
    const start = Math.max(0, Math.min(this.cursor - 3, n - BODY_LINES))
    const lines: string[] = []
    for (let i = start; i < Math.min(start + BODY_LINES, n); i++) {
      const th = this.threads[i]
      const mark = i === this.cursor ? '▶ ' : '  '
      const unread = th.unread > 0 ? ` (${th.unread})` : ''
      const group = th.isGroup ? ` ${t('msgGroupMark')}` : ''
      // 一覧は名前と未読数だけ (本文のプレビューは出さない: 1 行目の console 出力に載るため)
      lines.push(this.deps.wrap(`${mark}${th.name}${group}${unread}`)[0] ?? '')
    }
    return lines
  }

  private threadLines(): string[] {
    if (this.threadError && !this.thread) return [t('msgLoadFail')]
    if (!this.thread) return [t('msgLoading')]
    const all: string[] = []
    for (const m of this.thread.messages) {
      const who = m.fromMe ? t('msgMe') : (this.thread.thread.isGroup ? (m.sender || '?') : this.thread.thread.name)
      all.push(...this.deps.wrap(`${who}: ${m.text || t('msgAttachment')}`))
    }
    this.lineCache = all
    // 1 行目は件数 (本文を置かない)。残り 6 行が会話の末尾 (スクロールで遡る)。
    const view = BODY_LINES - 1
    const end = Math.max(0, all.length - this.threadScroll)
    const shown = all.slice(Math.max(0, end - view), end)
    const count = this.threadScroll > 0 ? tf('msgOlder', { n: this.threadScroll }) : tf('msgCount', { n: this.thread.messages.length })
    const head = this.thread.thread.canReply ? count : `${count} · ${t('msgReadOnlyMark')}`
    return [head, ...(shown.length ? shown : [t('msgNoMessages')])]
  }

  private confirmLines(): string[] {
    const d = this.deps.draft()
    if (!d) return []
    // 1 行目は問い (本文を置かない)。宛先はヘッダ「TO · 名前」。全文を折り返して見せ、溢れたらスクロール。
    const text = this.deps.wrap(d.text)
    this.lineCache = text
    const lines = [t('msgConfirmAsk')]
    // ヘッダで名前が切れた時は、宛先の全名を本文に出す (誰に送るかを必ず全部見せる)
    if (this.headerTruncated()) lines.push(...this.deps.wrap(tf('msgConfirmTo', { name: d.name })).slice(0, 3))
    if (d.recoveredPartial) lines.push(t('msgConfirmPartial'))
    const room = BODY_LINES - lines.length - (text.length > BODY_LINES - lines.length ? 1 : 0)
    const start = Math.min(this.confirmScroll, Math.max(0, text.length - room))
    lines.push(...text.slice(start, start + room))
    if (text.length > room) lines.push(`▼ ${Math.min(start + room, text.length)}/${text.length}`)
    return lines
  }

  private resultLines(): string[] {
    const r = this.result
    if (!r) return []
    if (r.kind === 'sent') return [t('msgSent')]
    if (r.kind === 'unknown') return [t('msgUnknown1'), '', ...this.deps.wrap(t('msgUnknown2'))]
    const reason = reasonText(r.reasonCode, r.reason)
    return [t('msgFailed'), ...(reason ? this.deps.wrap(reason).slice(0, 3) : []), '', t('msgFailedHint')]
  }

  // ─── 操作 ────────────────────────────────────────────────────────────

  onClick(): void {
    switch (this.screen) {
      case 'list': {
        if (this.needsSetup()) { void this.refreshAll(); return }
        const th = this.threads?.[this.cursor]
        if (th) void this.openThread(th.id)
        return
      }
      case 'thread': {
        const th = this.thread?.thread ?? this.currentThread()
        const name = th?.name
        if (!this.threadId || !name) return
        if (th && !th.canReply) {
          // 読み取り専用 (v1 のグループ等)。録音を始めず、理由を出す。
          this.deps.notice(reasonText(th.readOnlyReasonCode, th.readOnlyReason) ?? t('msgReadOnly'))
          void this.deps.redraw(true)
          return
        }
        this.stopPolling()
        this.deps.startReply({ id: this.threadId, name })
        return
      }
      case 'confirm':
        // 確認カードが実際にレンズに出るまで (と、出てから少しの間) は送らない
        if (!this.confirmReady()) { this.deps.log('messages: tap ignored — confirm card not shown yet'); return }
        void this.send()
        return
      case 'result':
        // 確実に届いていない時だけ再試行できる。もう一度確認カードを見せてから (Send はそこで)。
        if (this.result?.kind === 'failed') { this.openConfirm(); return }
        this.result = null
        this.returnToThread()
        return
      default: return
    }
  }

  onDoubleClick(): void {
    switch (this.screen) {
      case 'list': this.stopPolling(); this.deps.exit(); return
      case 'thread': this.screen = 'list'; this.thread = null; this.threadId = null; void this.deps.redraw(true); return
      case 'confirm': this.leaveConfirm(); this.deps.backToDraft(); return  // 編集 (下書きはそのまま)
      case 'result':
        if (this.result?.kind === 'failed') { this.leaveConfirm(); this.deps.backToDraft(); return }
        this.result = null
        this.returnToThread()
        return
      default: return
    }
  }

  onScroll(delta: 1 | -1): void {
    if (this.screen === 'list' && this.threads?.length) {
      this.cursor = Math.max(0, Math.min(this.threads.length - 1, this.cursor + delta))
    } else if (this.screen === 'thread') {
      // ↑ = 古い方へ、↓ = 新しい方へ (HeadLenss の chat と同じ)
      const max = Math.max(0, this.lineCache.length - (BODY_LINES - 1))
      this.threadScroll = Math.max(0, Math.min(max, this.threadScroll - delta))
    } else if (this.screen === 'confirm') {
      this.confirmScroll = Math.max(0, this.confirmScroll + delta)
    } else return
    void this.deps.redraw(true)
  }

  onMenuItem(itemID: number): boolean {
    if (itemID !== MSG_MENU.DISCARD) return false
    if (this.screen === 'confirm' || this.screen === 'result') {
      this.leaveConfirm()
      this.deps.clearDraft()
      this.result = null
      this.deps.notice(t('msgNoticeDiscarded'))
      this.returnToThread()
    }
    return true
  }

  // ─── 内部 ────────────────────────────────────────────────────────────

  private async openThread(id: string): Promise<void> {
    this.threadId = id
    this.thread = null
    this.threadError = false
    this.threadScroll = 0
    this.screen = 'thread'
    void this.deps.redraw(true)
    await this.loadThread()
  }

  /** 確認カードを離れる: 準備済みの印を捨てる (次に開いた時はまたフレームの表示を待つ)。 */
  private leaveConfirm(): void {
    this.stopPolling()
    this.confirmShownAt = null
    this.confirmSeq++
  }

  private async send(): Promise<void> {
    const d = this.deps.draft()
    // 下書きを作った時のサーバへ送る (今の設定のサーバではない)
    const client = d ? this.deps.clientFor(d.serverBaseUrl) : null
    if (!d || !client || this.sendingDraft) return
    this.confirmShownAt = null
    if (!d.text.trim()) return
    this.sendingDraft = d.draftId
    this.screen = 'sending'
    void this.deps.redraw(true)
    this.deps.log(`messages: reply send (${d.text.length} chars)`)  // 本文は出さない
    let result: ResultState
    try {
      const res = await client.messagesReply(d.threadId, { text: d.text, draftId: d.draftId })
      result = { kind: res.state === 'sent' ? 'sent' : 'unknown', name: d.name }
    } catch (err) {
      const e = err as { name?: string; message?: string; reason?: string; reasonCode?: string; deliveryUnknown?: boolean }
      // 4xx (理由付き) = 確実に送っていない。通信断・タイムアウト・5xx = 送れたか分からない。
      result = e.deliveryUnknown === false
        ? { kind: 'failed', name: d.name, reason: e.reason, reasonCode: e.reasonCode }
        : { kind: 'unknown', name: d.name }
      this.deps.log(`messages: reply ${result.kind}`)
    } finally {
      this.sendingDraft = null
    }
    // 送れた / 分からない → 下書きを手放す (同じ文をもう一度送らせない)。失敗 → 残して再試行・編集できる。
    if (result.kind !== 'failed') this.deps.clearDraft()
    this.result = result
    this.screen = 'result'
    void this.deps.redraw(true)
    if (result.kind === 'sent') void this.loadThreads()
  }

  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => { void this.poll() }, POLL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.pollGen++  // 取得中の定期取得の続き (次の読み込み・描画) を止める
  }

  private async poll(): Promise<void> {
    const g = this.pollGen
    await this.loadThreads()
    if (g !== this.pollGen) return  // 待っている間に閉じた: 続けて読みに行かない
    if (this.screen === 'thread') await this.loadThread()
    if (g !== this.pollGen) return
    if (this.screen === 'list' || this.screen === 'thread') void this.deps.redraw(false)
  }

  private async refreshAll(): Promise<void> {
    const g = this.pollGen
    await this.loadStatus()
    if (g !== this.pollGen) return
    if (this.status?.canRead) await this.loadThreads()
    if (g !== this.pollGen) return
    if (this.screen === 'thread' && this.threadId) await this.loadThread()
    if (g !== this.pollGen) return
    void this.deps.redraw(true)
  }

  private async loadStatus(): Promise<void> {
    const client = this.deps.client()
    if (!client) return
    const gen = this.gen
    try {
      const status = await client.messagesStatus()
      if (gen !== this.gen) return
      this.status = status
      this.statusProblem = null
    } catch (err) {
      if (gen !== this.gen) return
      this.statusProblem = (err as Error).name === 'FieldglassUnavailableError' ? 'old' : 'offline'
    }
  }

  private async loadThreads(): Promise<void> {
    const client = this.deps.client()
    if (!client) return
    const gen = this.gen
    try {
      const threads = await client.messagesThreads()
      if (gen !== this.gen) return
      // カーソルはスレッド ID で保つ (並びが変わっても選んでいたものから動かない)
      const selected = this.threads?.[this.cursor]?.id
      this.threads = threads
      this.threadsError = false
      const idx = selected ? threads.findIndex((th) => th.id === selected) : -1
      if (idx >= 0) this.cursor = idx
    } catch {
      if (gen !== this.gen) return
      this.threadsError = true
    }
  }

  private async loadThread(): Promise<void> {
    const client = this.deps.client()
    const id = this.threadId
    if (!client || !id) return
    const gen = this.gen
    try {
      const detail = await client.messagesThread(id)
      if (gen !== this.gen || this.threadId !== id) return  // 別のスレッドへ移った後の古い結果は捨てる
      this.thread = detail
      this.threadError = false
    } catch {
      if (gen !== this.gen || this.threadId !== id) return
      this.threadError = true
    }
    if (this.screen === 'thread') void this.deps.redraw(true)
  }
}
