export type ChatRole = 'user' | 'assistant';

export type ChatItem = {
  role: ChatRole;
  text: string;
  ts: number;
  /** サーバ側で動的に注入した「合成メッセージ」(transcript には永続化されない、
   *  状態通知用などに使われる)。クライアントは true なら表示有無を選べる。 */
  synthetic?: boolean;
};

export type SessionStatus = 'idle' | 'busy' | 'waiting-permission' | 'waiting-question';

export type AskQuestionOption = {
  label: string;
  description?: string;
};

export type AskQuestion = {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options?: AskQuestionOption[];
};

export type Pending = {
  id: string;
  kind: 'permission' | 'question';
  hookEvent: 'PreToolUse' | 'PermissionRequest';
  source?: 'claude' | 'codex';
  toolName: string;
  toolInput: unknown;
  questions?: AskQuestion[];
  createdAt: number;
  /** AskUserQuestion 用: tool_use_id と transcript path。
   *  hook を即時 return して TUI に表示させる「両側回答対応モード」で、
   *  TUI 経由で回答が確定したことを transcript の tool_result で検出するために使う。 */
  toolUseId?: string;
  transcriptPath?: string;
};

export type ClaudeSession = {
  ccSessionId: string;
  tmuxPane: string;
  tmuxSessionName: string;
  cwd: string;
  source?: 'claude' | 'codex';
  transcriptPath?: string;
  status: SessionStatus;
  startedAt: number;
  lastSeenAt: number;
  chat: ChatItem[];
  pending?: Pending;
  /** Stop hook 受信時刻。次の user-prompt-submit が来るまで「ターン終了済み」フラグとして使う。
   *  registry の busy が遅れて idle に追いつかない時、考え中インジケータを早めに消すために参照。 */
  lastStopAt?: number;
};

export type HookHeaders = {
  tmuxPane: string;
  tmux?: string;
};

/** AskUserQuestion への各質問への回答。TUI の 3 経路 (predefined / type-something /
 *  chat-about-this) に対応する。default は predefined。 */
export type QuestionAnswer = {
  question: string;
  /** 'predefined' (省略時): option / options で予定選択肢を選ぶ。
   *    - 単一選択: option (label 1 つ) を指定
   *    - 複数選択 (multiSelect: true): options (label 配列) を指定
   *    notes が付いていれば「Type something」経由で「{option}: {notes}」を送信(単一選択時のみ)。
   *  'type-something': text 必須、TUI の Type something に切り替えて text を送信。
   *  'chat-about-this': TUI の Chat about this を選んで AskUserQuestion 全体を reject。
   *    複数質問でも 1 件でもこれが含まれていたらその時点で reject される。 */
  answerKind?: 'predefined' | 'type-something' | 'chat-about-this';
  /** 単一選択時の選んだ option label */
  option?: string;
  /** 複数選択時の選んだ option label 配列 */
  options?: string[];
  text?: string;
  notes?: string;
};

export type RespondInput = (
  | { kind: 'permission'; decision: 'allow' | 'deny'; message?: string }
  | { kind: 'question'; answers: Array<QuestionAnswer> }
) & {
  // chat 履歴に残す回答整形文をどの言語で作るか (Web UI で選択中の言語)。
  // 未指定なら 'en'。
  lang?: 'en' | 'ja';
};

export type HookDecision =
  | { event: 'PreToolUse'; permissionDecision: 'allow' | 'deny' | 'ask'; reason?: string; updatedInput?: unknown }
  | { event: 'PermissionRequest'; behavior: 'allow' | 'deny'; message?: string };
