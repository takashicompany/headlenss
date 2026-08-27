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

export class HeadlenssClient {
  constructor(private base: string) {}

  setBase(base: string): void {
    this.base = base
  }

  private url(path: string): string {
    return `${trimTrailingSlash(this.base)}${path}`
  }

  async health(): Promise<{ ok: boolean }> {
    const res = await fetch(this.url('/api/health'))
    if (!res.ok) throw new Error(`health HTTP ${res.status}`)
    return (await res.json()) as { ok: boolean }
  }

  async listSessions(signal?: AbortSignal): Promise<Session[]> {
    const res = await fetch(this.url('/api/sessions'), { signal })
    if (!res.ok) throw new Error(`listSessions HTTP ${res.status}`)
    const data = (await res.json()) as { sessions: Session[] }
    return data.sessions
  }

  async sendKeys(name: string, opts: SendKeysOptions): Promise<void> {
    const res = await fetch(this.url(`/api/sessions/${encodeURIComponent(name)}/input`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: opts.text, submit: opts.submit }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`sendKeys HTTP ${res.status}: ${body.slice(0, 200)}`)
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
