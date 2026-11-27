// headlenssサーバ (server/) とのHTTPクライアント。
// Speechmaticsから受け取ったテキストを tmux session に流し込むのが主目的。
// 加えて Claude Code hook 連携用エンドポイント (/api/claude/*) も叩く。

import { trimTrailingSlash } from './settings'

export type Session = {
  name: string
  created: number
  windows: number
  attached: boolean
}

export type SendKeysOptions = {
  text: string
  submit: boolean
}

export type ClaudeSessionStatus = 'idle' | 'busy' | 'waiting-permission' | 'waiting-question'

export type AgentSource = 'claude' | 'codex'

export type ClaudeSessionInfo = {
  tmuxSessionName: string
  cwd: string
  status: ClaudeSessionStatus
  startedAt: number
  lastSeenAt: number
  source?: AgentSource
  /** rootlist プレビュー用: 最後のメッセージ冒頭 (サーバ側で 48 文字に丸め済み)。 */
  lastChat?: string
  /**
   * 対話ウィザード等が tmux の画面を占有していて、通常の入力欄が見えていない。
   * status は idle/busy のままなので、送っても会話に届かないことはこれでしか分からない。
   * サーバは true のときだけ付けてくる (false は送らない)。
   */
  screenBlocked?: boolean
  /**
   * 送ったのに ACK (エージェントの UserPromptSubmit フック) が返ってこなかった
   * 直近の送信。サーバは未確認の間だけ付けてくる (確認できたら消える)。
   */
  deliveryWarning?: DeliveryWarning
  /** このセッションの作業フォルダ配下で動いている G2 プラグインの dev server。 */
  g2Plugins?: G2PluginInfo[]
}

/**
 * セッションのフォルダの宣言ファイルに書かれた G2 プラグイン。
 * サーバ側で疎通確認済みのものだけが降ってくる (= タップすれば必ず開ける)。
 */
export type G2PluginInfo = {
  /** 宣言ファイルに書かれた表示名 */
  name: string
  /** 宣言ファイルに書かれた URL。そのまま遷移先になる (組み立て直さない) */
  url: string
}

/**
 * 送達未確認の知らせ。tmux へのキー注入は成功しても、pane が塞がっていれば
 * 会話には入らない。エージェントがプロンプトを受理した証拠 (フック) が期限内に
 * 来なかった送信を、サーバがこの形で教えてくる。
 */
export type DeliveryWarning = {
  /** 未確認のまま残っている送信を投げた時刻 (epoch ms)。 */
  sentAt: number
}

export type ChatRole = 'user' | 'assistant'

export type ChatItem = {
  role: ChatRole
  text: string
  ts: number
  /** サーバが状態表示用に合成した行 (永続ログではない)。表示は status から作り直すので捨てる。 */
  synthetic?: boolean
}

export type ClaudeChatResponse = {
  chat: ChatItem[]
  source?: AgentSource
  /** Agent の動作状態。未知の値が増えても壊れないよう string も許容する。 */
  status?: ClaudeSessionStatus | string
  /** 送ったのに届いた確証が得られていない送信 (未確認の間だけ付く)。 */
  deliveryWarning?: DeliveryWarning
}

export type AskQuestionOption = { label: string; description?: string }

export type AskQuestion = {
  header?: string
  question: string
  multiSelect?: boolean
  options?: AskQuestionOption[]
}

export type Pending = {
  id: string
  kind: 'permission' | 'question'
  hookEvent: 'PreToolUse' | 'PermissionRequest'
  toolName: string
  toolInput: unknown
  questions?: AskQuestion[]
  createdAt: number
}

export type RespondInput = (
  | { kind: 'permission'; decision: 'allow' | 'deny'; message?: string }
  | {
      kind: 'question';
      answers: Array<{
        question: string;
        answerKind?: 'predefined' | 'type-something' | 'chat-about-this';
        option?: string;       // single-select predefined
        options?: string[];    // multi-select predefined
        text?: string;         // type-something
        notes?: string;
      }>;
    }
) & {
  /**
   * chat 履歴に残す回答整形文をどの言語で作るか (今 UI で選択中の言語)。
   * 未指定ならサーバは 'en' で整形する。
   */
  lang?: 'en' | 'ja'
  /** どの pending への回答かを明示する。サーバは現在の pending と不一致なら 409 を返す。 */
  pendingId?: string
}

/**
 * 応答 POST が「対象の用件が既に入れ替わっている」で弾かれた (409 code=pending_mismatch)
 * ことを表す。呼び出し側は構築中の回答を捨てて取り直す判断に使う。
 * 同じ 409 でも二重送信 (already_processing) 等はこれに含めない
 * (入れ替わっていないのに「入れ替わった」と案内してしまうため)。
 */
/** 応答 POST の上限時間 (ms)。サーバ側のキー注入と確認 (数百 ms〜数秒) より十分長く取る。 */
const RESPOND_TIMEOUT_MS = 15000
/** tmux への送信 (sendKeys) の締切。返らないと 'sending' 表示が固着する。 */
const SEND_KEYS_TIMEOUT_MS = 15000

/**
 * ms 後に abort する signal。
 * AbortSignal.timeout を持たない古い WebView では、それを呼ぶこと自体が例外になり
 * 「タイムアウトを付けたせいで送信できない」になるので、手組みの controller へ退避する。
 */
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), ms)
  return ctrl.signal
}

export class PendingConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PendingConflictError'
  }
}

/**
 * 応答 POST が「キーを途中まで TUI に撃った後で用件が入れ替わった」で打ち切られた
 * (409 code=injection_interrupted) ことを表す。
 *
 * pending_mismatch (1 つも撃っていない = 完全に無かったこと) と区別するのは、
 * こちらは「一部だけ届いている可能性がある」ため。同じ回答を自動で送り直すと
 * TUI に二重にキーが入って選択が壊れるので、呼び出し側は回答を残したまま
 * その旨を表示するだけにして、送り直すかどうかはユーザに委ねる。
 */
export class RespondInterruptedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RespondInterruptedError'
  }
}

/** HTTP 応答を受け取れた失敗。通信断/タイムアウトは送達不明として呼び出し側に残す。 */
export class PromptSendError extends Error {
  constructor(message: string, readonly deliveryUnknown: boolean) {
    super(message)
    this.name = 'PromptSendError'
  }
}

// ── Fieldglass (/api/fieldglass) ─────────────────────────────────────────
// 型はサーバ側 (server/src/server/fieldglass) と共有の契約 (SPEC.md) どおり。

/** 予定 1 件。start / end は Mac のローカル時刻 'HH:MM'。 */
export type FieldglassTodayEvent = { id: string; start: string; end: string; title: string; objective?: string }
export type FieldglassSetupHelp = { connector: string; steps: string[] }
export type FieldglassToday = {
  updatedAt: number | null
  /** AMENDMENT 1: 手入力の予定だけの日は 'manual'。 */
  source: 'calendar' | 'manual' | 'none'
  refreshing: boolean
  events: FieldglassTodayEvent[]
  setup?: FieldglassSetupHelp
  /** 直近のカレンダー取得の失敗理由 (平易な文)。 */
  lastError?: string
}
export type FieldglassFollowup = {
  id: string; quote: string; owner?: string; due?: string; eventId?: string; meetingTitle?: string
  createdAt: number; expiresAt: number; sentTo?: string; sentAt?: number
}
export type FieldglassFollowupInput = { quote: string; owner?: string; due?: string; eventId?: string; meetingTitle?: string }
export type FieldTestEvent = {
  sessionId: string; cueId?: string
  kind: 'cue_shown' | 'cue_retracted' | 'rated' | 'session_start' | 'session_end'
  lastWordAt?: number; candidateAt?: number; renderedAt?: number
  category?: string; rating?: string; reason?: string; at: number
}

/** サーバが Fieldglass を持っていない (古い headlenss server)。レンズでは「サーバ更新が必要」と出す。 */
export class FieldglassUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FieldglassUnavailableError'
  }
}

const FIELDGLASS_TIMEOUT_MS = 8000

// ── Messages (AMENDMENT 2: /api/fieldglass/messages) ─────────────────────
export type MessagesStatus = { canRead: boolean; canSend: 'yes' | 'unknown' | 'denied'; nodePath: string; steps: string[] }
export type MessagesThread = {
  id: string; name: string; isGroup: boolean; service: string; lastText: string; lastAt: number; unread: number
  /** 返信できるか (v1 はグループ等が読み取り専用)。項目が無い古いサーバでは true 扱い。 */
  canReply: boolean
  readOnlyReason?: string
  /** 理由のコード (codex が追加中の reasonCode)。レンズはこれを en/ja の文言に引き直す。 */
  readOnlyReasonCode?: string
}
export type MessagesMessage = { id: string; fromMe: boolean; sender: string; text: string; at: number }
export type MessagesThreadDetail = { thread: MessagesThread; messages: MessagesMessage[] }
export type MessagesReplyResult = { ok: true; state: 'sent' | 'unknown' }

/**
 * 返信の送信に失敗した。deliveryUnknown=false はサーバが理由付きで断った (4xx = 送っていない)。
 * true は通信断・タイムアウト・5xx など、Mac が送ったかどうか分からない場合。
 */
export class MessagesReplyError extends Error {
  constructor(message: string, readonly deliveryUnknown: boolean, readonly reason?: string, readonly status?: number, readonly reasonCode?: string) {
    super(message)
    this.name = 'MessagesReplyError'
  }
}

/** osascript での送信は数秒かかることがある。締切を過ぎたら「分からない」として扱う。 */
const MESSAGES_REPLY_TIMEOUT_MS = 30_000

export class HeadlenssClient {
  constructor(private base: string) {}

  setBase(base: string): void {
    this.base = base
  }

  private url(path: string): string {
    return `${trimTrailingSlash(this.base)}${path}`
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean }> {
    const res = await fetch(this.url('/api/health'), { signal: signal ?? timeoutSignal(8000) })
    if (!res.ok) throw new Error(`health HTTP ${res.status}`)
    return (await res.json()) as { ok: boolean }
  }

  async listSessions(signal?: AbortSignal): Promise<Session[]> {
    const res = await fetch(this.url('/api/sessions'), { signal })
    if (!res.ok) throw new Error(`listSessions HTTP ${res.status}`)
    const data = (await res.json()) as { sessions: Session[] }
    return data.sessions
  }

  /**
   * tmux セッションへ本文を流し込む。
   * 締切を必ず張る: ここが返らないと呼び出し側は 'sending' のまま操作を
   * 受け付けない画面に閉じ込められる (電波が切れた時に実際に起きる)。
   */
  async sendKeys(name: string, opts: SendKeysOptions): Promise<void> {
    const res = await fetch(this.url(`/api/sessions/${encodeURIComponent(name)}/input`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: opts.text, submit: opts.submit }),
      signal: timeoutSignal(SEND_KEYS_TIMEOUT_MS),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 400/500 等はキー注入の途中で失敗した可能性もある。注入前の拒否と
      // 分かる応答だけ「未送信」と扱い、他は保守的に送達不明とする。
      let code: unknown
      try { code = (JSON.parse(body) as { code?: unknown }).code } catch { /* non-JSON */ }
      const rejected = [401, 403, 404, 429].includes(res.status)
        || (res.status === 409 && code === 'already_processing')
      throw new PromptSendError(`sendKeys HTTP ${res.status}: ${body.slice(0, 200)}`, !rejected)
    }
  }

  /**
   * tmux セッションを作成。
   * @param name セッション名
   * @param opts.cwd 作業ディレクトリ (~/foo, /abs/path, または相対パス → home基準)。存在しなければ mkdir -p
   * @param opts.startClaude true で `claude -c || claude`、startCodex true で `codex resume --last || codex` を初期コマンドとして流す
   */
  async createSession(
    name: string,
    opts?: { cwd?: string; startClaude?: boolean; startCodex?: boolean },
  ): Promise<void> {
    const res = await fetch(this.url('/api/sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cwd: opts?.cwd, startClaude: opts?.startClaude === true, startCodex: opts?.startCodex === true }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`createSession HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
  }

  async killSession(name: string): Promise<void> {
    const res = await fetch(this.url(`/api/sessions/${encodeURIComponent(name)}`), {
      method: 'DELETE',
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`killSession HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
  }

  async getOutput(name: string, lines = 24): Promise<string> {
    const res = await fetch(
      this.url(`/api/sessions/${encodeURIComponent(name)}/output?lines=${lines}`),
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`getOutput HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as { text: string }
    return data.text
  }

  // ── Claude Code hook 連携 ──────────────────────────────────────────────

  async listClaudeSessions(signal?: AbortSignal): Promise<ClaudeSessionInfo[]> {
    const res = await fetch(this.url('/api/claude/sessions'), { signal })
    if (!res.ok) throw new Error(`listClaudeSessions HTTP ${res.status}`)
    const data = (await res.json()) as { sessions: ClaudeSessionInfo[] }
    return data.sessions
  }

  async getClaudeChat(name: string, signal?: AbortSignal, tail?: number): Promise<ClaudeChatResponse> {
    const qs = tail != null && tail > 0 ? `?tail=${tail}` : ''
    const res = await fetch(this.url(`/api/claude/sessions/${encodeURIComponent(name)}/chat${qs}`), { signal })
    if (res.status === 404) return { chat: [] }
    if (!res.ok) throw new Error(`getClaudeChat HTTP ${res.status}`)
    const data = (await res.json()) as ClaudeChatResponse
    return {
      chat: data.chat ?? [],
      source: data.source,
      status: data.status,
      deliveryWarning: data.deliveryWarning,
    }
  }

  async getClaudePending(name: string, signal?: AbortSignal): Promise<Pending | null> {
    const res = await fetch(this.url(`/api/claude/sessions/${encodeURIComponent(name)}/pending`), { signal })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`getClaudePending HTTP ${res.status}`)
    const data = (await res.json()) as { pending: Pending | null }
    return data.pending
  }

  // ── Fieldglass ──────────────────────────────────────────────────────
  // どれも締切付き。カレンダー取得そのものはサーバ側の裏仕事 (claude -p) なので、
  // ここはキャッシュを読むだけ = 速い。遅い応答を待ってレンズを止めない。

  private async fieldglassJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.url(`/api/fieldglass${path}`), {
      ...init,
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
      signal: init.signal ?? timeoutSignal(FIELDGLASS_TIMEOUT_MS),
    })
    if (res.status === 404 && path === '/today') throw new FieldglassUnavailableError('fieldglass API not found (server too old?)')
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`fieldglass ${path} HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
    return (await res.json()) as T
  }

  async fieldglassToday(signal?: AbortSignal): Promise<FieldglassToday> {
    const data = await this.fieldglassJson<Partial<FieldglassToday>>('/today', { signal })
    return {
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : null,
      source: data.source === 'calendar' || data.source === 'manual' ? data.source : 'none',
      refreshing: data.refreshing === true,
      events: Array.isArray(data.events) ? data.events.filter((e) => e && typeof e.id === 'string' && typeof e.title === 'string') : [],
      setup: data.setup,
      ...(typeof data.lastError === 'string' && data.lastError ? { lastError: data.lastError } : {}),
    }
  }

  async fieldglassRefreshToday(): Promise<void> {
    await this.fieldglassJson('/today/refresh', { method: 'POST', body: '{}' })
  }

  async fieldglassFollowups(): Promise<FieldglassFollowup[]> {
    const data = await this.fieldglassJson<{ followups?: FieldglassFollowup[] }>('/followups')
    return Array.isArray(data.followups) ? data.followups : []
  }

  async fieldglassSaveFollowup(input: FieldglassFollowupInput): Promise<FieldglassFollowup> {
    return this.fieldglassJson<FieldglassFollowup>('/followups', { method: 'POST', body: JSON.stringify(input) })
  }

  async fieldglassFieldTest(events: FieldTestEvent[]): Promise<void> {
    await this.fieldglassJson('/fieldtest', { method: 'POST', body: JSON.stringify({ events }) })
  }

  // ── Messages ──────────────────────────────────────────────────────────
  // 本文 (text) は URL にもログにも載せない。body だけで送る。

  async messagesStatus(): Promise<MessagesStatus> {
    const res = await fetch(this.url('/api/fieldglass/messages/status'), { signal: timeoutSignal(FIELDGLASS_TIMEOUT_MS) })
    if (res.status === 404) throw new FieldglassUnavailableError('messages API not found (server too old?)')
    if (!res.ok) throw new Error(`messages status HTTP ${res.status}`)
    const d = (await res.json()) as Partial<MessagesStatus>
    return {
      canRead: d.canRead === true,
      canSend: d.canSend === 'yes' || d.canSend === 'denied' ? d.canSend : 'unknown',
      nodePath: typeof d.nodePath === 'string' ? d.nodePath : '',
      steps: Array.isArray(d.steps) ? d.steps.filter((x): x is string => typeof x === 'string') : [],
    }
  }

  async messagesThreads(): Promise<MessagesThread[]> {
    const res = await fetch(this.url('/api/fieldglass/messages/threads'), { signal: timeoutSignal(FIELDGLASS_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`messages threads HTTP ${res.status}`)
    const d = (await res.json()) as { threads?: unknown }
    return Array.isArray(d.threads) ? d.threads.filter(isThread).map(normalThread) : []
  }

  async messagesThread(id: string): Promise<MessagesThreadDetail> {
    const res = await fetch(this.url(`/api/fieldglass/messages/threads/${encodeURIComponent(id)}`), { signal: timeoutSignal(FIELDGLASS_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`messages thread HTTP ${res.status}`)
    const d = (await res.json()) as { thread?: unknown; messages?: unknown }
    if (!isThread(d.thread)) throw new Error('messages thread: bad response')
    const messages = Array.isArray(d.messages) ? d.messages.filter((m): m is MessagesMessage =>
      !!m && typeof (m as MessagesMessage).id === 'string' && typeof (m as MessagesMessage).fromMe === 'boolean') : []
    return {
      thread: normalThread(d.thread),
      messages: messages.map((m) => ({ id: m.id, fromMe: m.fromMe, sender: typeof m.sender === 'string' ? m.sender : '',
        text: typeof m.text === 'string' ? m.text : '', at: typeof m.at === 'number' ? m.at : 0 })),
    }
  }

  /**
   * 返信を送る。draftId は下書きごとに 1 つ (サーバは同じ draftId の 2 回目を無視する)。
   * 送れたか分からない失敗は MessagesReplyError(deliveryUnknown=true) にする。呼び出し側は再送しない。
   */
  async messagesReply(id: string, input: { text: string; draftId: string }): Promise<MessagesReplyResult> {
    let res: Response
    try {
      res = await fetch(this.url(`/api/fieldglass/messages/threads/${encodeURIComponent(id)}/reply`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input.text, draftId: input.draftId }),
        signal: timeoutSignal(MESSAGES_REPLY_TIMEOUT_MS),
      })
    } catch (e) {
      throw new MessagesReplyError(`messages reply: ${(e as Error).name}`, true)
    }
    if (res.ok) {
      const d = (await res.json().catch(() => ({}))) as { ok?: unknown; state?: unknown }
      // 'sent' と明言された時だけ送れた扱い。それ以外の形は分からない扱い。
      return { ok: true, state: d.ok === true && d.state === 'sent' ? 'sent' : 'unknown' }
    }
    let reason: string | undefined
    let reasonCode: string | undefined
    try {
      const body = (await res.json()) as { reason?: unknown; error?: unknown; reasonCode?: unknown }
      reason = typeof body.reason === 'string' ? body.reason : typeof body.error === 'string' ? body.error : undefined
      reasonCode = typeof body.reasonCode === 'string' && /^[a-z_]{1,40}$/.test(body.reasonCode) ? body.reasonCode : undefined
    } catch { /* non-JSON */ }
    // 確定した拒否 = 4xx (408 以外) かつ reasonCode 付き。サーバはこの時 draftId を記録しないので、
    // 同じ draftId での再試行は改めて送信を試みる (合意した契約)。reasonCode の無い 4xx (プロキシ・
    // 古いサーバ) は送る前に断られた証拠にならないので「分からない」扱い = 再試行させない。
    const definite = res.status >= 400 && res.status < 500 && res.status !== 408 && reasonCode !== undefined
    throw new MessagesReplyError(`messages reply HTTP ${res.status}`, !definite, reason?.slice(0, 200), res.status, reasonCode)
  }

  async respondClaude(name: string, input: RespondInput): Promise<void> {
    // 必ず決着させる。サーバは tmux にキーを注入して確認するまで応答しないので
    // 数百 ms〜数秒かかるが、返ってこないままだと呼び出し側の送信中フラグが
    // 解除されず、以降その画面が一切操作できなくなる。
    let res: Response
    try {
      res = await fetch(this.url(`/api/claude/sessions/${encodeURIComponent(name)}/respond`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: timeoutSignal(RESPOND_TIMEOUT_MS),
      })
    } catch (e) {
      // タイムアウトは通常のエラーとして投げる (用件の入れ替わりではないので再試行可)
      if ((e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError') {
        throw new Error(`respondClaude timeout after ${RESPOND_TIMEOUT_MS}ms`)
      }
      throw e
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 409 のうち「応答先の用件が入れ替わっている」(code=pending_mismatch) だけを
      // 型で区別する。呼び出し側が「回答を捨てて取り直す」判断に使うため。
      // 他の 409 (already_processing / codex_still_waiting / not_awaitable) は
      // 用件が入れ替わったわけではないので通常のエラーとして扱う。
      let code: string | undefined
      try { code = (JSON.parse(body) as { code?: string }).code } catch { /* 非 JSON 応答 */ }
      if (res.status === 409 && code === 'pending_mismatch') {
        throw new PendingConflictError(`respondClaude HTTP 409: ${body.slice(0, 200)}`)
      }
      // 途中まで撃った後の打ち切り。無かったことにはできないので別の型で返す。
      if (res.status === 409 && code === 'injection_interrupted') {
        throw new RespondInterruptedError(`respondClaude HTTP 409: ${body.slice(0, 200)}`)
      }
      throw new Error(`respondClaude HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
  }
}

function isThread(x: unknown): x is MessagesThread {
  return !!x && typeof (x as MessagesThread).id === 'string' && typeof (x as MessagesThread).name === 'string'
}

function normalThread(x: MessagesThread): MessagesThread {
  return {
    id: x.id, name: x.name || x.id, isGroup: x.isGroup === true, service: typeof x.service === 'string' ? x.service : '',
    lastText: typeof x.lastText === 'string' ? x.lastText : '', lastAt: typeof x.lastAt === 'number' ? x.lastAt : 0,
    unread: typeof x.unread === 'number' && x.unread > 0 ? Math.floor(x.unread) : 0,
    canReply: (x as { canReply?: unknown }).canReply !== false,
    ...(typeof x.readOnlyReason === 'string' && x.readOnlyReason ? { readOnlyReason: x.readOnlyReason.slice(0, 200) } : {}),
    ...(() => {
      // サーバは readOnlyReasonCode か reasonCode のどちらかで送ってくる (codex の実装待ち)
      const raw = x as { readOnlyReasonCode?: unknown; reasonCode?: unknown }
      const code = typeof raw.readOnlyReasonCode === 'string' ? raw.readOnlyReasonCode : typeof raw.reasonCode === 'string' ? raw.reasonCode : undefined
      return code && /^[a-z_]{1,40}$/.test(code) ? { readOnlyReasonCode: code } : {}
    })(),
  }
}
