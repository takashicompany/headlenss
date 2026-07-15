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
}

export type ChatRole = 'user' | 'assistant'

export type ChatItem = {
  role: ChatRole
  text: string
  ts: number
}

export type ClaudeChatResponse = {
  chat: ChatItem[]
  source?: AgentSource
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

export type RespondInput =
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

  async listSessions(): Promise<Session[]> {
    const res = await fetch(this.url('/api/sessions'))
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

  async listClaudeSessions(): Promise<ClaudeSessionInfo[]> {
    const res = await fetch(this.url('/api/claude/sessions'))
    if (!res.ok) throw new Error(`listClaudeSessions HTTP ${res.status}`)
    const data = (await res.json()) as { sessions: ClaudeSessionInfo[] }
    return data.sessions
  }

  async getClaudeChat(name: string, signal?: AbortSignal): Promise<ClaudeChatResponse> {
    const res = await fetch(this.url(`/api/claude/sessions/${encodeURIComponent(name)}/chat`), { signal })
    if (res.status === 404) return { chat: [] }
    if (!res.ok) throw new Error(`getClaudeChat HTTP ${res.status}`)
    const data = (await res.json()) as ClaudeChatResponse
    return { chat: data.chat ?? [], source: data.source }
  }

  async getClaudePending(name: string, signal?: AbortSignal): Promise<Pending | null> {
    const res = await fetch(this.url(`/api/claude/sessions/${encodeURIComponent(name)}/pending`), { signal })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`getClaudePending HTTP ${res.status}`)
    const data = (await res.json()) as { pending: Pending | null }
    return data.pending
  }

  async respondClaude(name: string, input: RespondInput): Promise<void> {
    const res = await fetch(this.url(`/api/claude/sessions/${encodeURIComponent(name)}/respond`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`respondClaude HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
  }
}
