import { Hono } from 'hono';
import type { Context } from 'hono';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { detectClaudeSessions } from './process-detect.ts';
import { detectLiveOwners } from './live-owner.ts';
import * as store from './store.ts';
import { resolveTmuxSessionName } from './tmux-resolver.ts';
import { captureOutput, sendKey, sendKeys } from '../tmux.ts';
import { extractChatFromTranscript, extractLastAssistantText, sanitizeChatText } from './transcript.ts';
import { extractCodexChatFromTranscript } from '../codex/transcript.ts';
import { detectCodexSessions, getCodexHookHealth, isCodexPermissionPrompt } from '../codex/status.ts';
import { matchUiSubmission } from '../uiSubmissions.ts';
import { detectG2Plugins, tmuxSessionPaths, type G2Plugin } from '../g2-plugins.ts';
import {
  deleteSessionStatusObservation,
  pickClaudeDetected,
  pickEffectiveSource,
  pruneSessionStatusObservations,
  resolveTrackedSessionStatus,
} from '../session-status.ts';
import type { AskQuestion, ChatItem, HookDecision, Pending, RespondInput, SessionStatus } from './types.ts';

const exec = promisify(execFile);

/**
 * tmux pane のフォアグラウンドコマンドが codex かどうかを判定する。
 * Codex TUI が pane を所有している間に Claude がサブプロセスとして起動された
 * (例: `claude -p ...`) 場合、pane_current_command は依然 codex を示す。
 * ユーザが Codex を終了して Claude を起動した場合は claude/node 等になる。
 * エラー時は false を返す (録画漏れ回避: 迷ったら会話を記録する側に倒す)。
 */
async function isCodexForegroundInPane(tmuxNameOrPane: string): Promise<boolean> {
  try {
    const { stdout } = await exec('tmux', [
      'display-message',
      '-p',
      '-t', tmuxNameOrPane,
      '#{pane_current_command}',
    ]);
    return /\bcodex\b/i.test(stdout);
  } catch {
    return false;
  }
}

/** 現在 tmux server 上に存在しているセッション名集合を返す */
async function liveTmuxSessionNames(): Promise<Set<string>> {
  try {
    const { stdout } = await exec('tmux', ['list-sessions', '-F', '#{session_name}']);
    return new Set(stdout.trim().split('\n').filter(Boolean));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    // tmux server が居ない = セッション無し
    if (stderr.includes('no server running') || stderr.includes('error connecting')) {
      return new Set();
    }
    // それ以外のエラーは安全側として空集合扱いはせず投げる
    throw err;
  }
}

/** cwd と sessionId から transcript ファイルのパスを推定する */
function transcriptPathFor(cwd: string, sessionId: string): string {
  const encoded = cwd.replace(/\//g, '-');
  return pathResolve(homedir(), '.claude/projects', encoded, `${sessionId}.jsonl`);
}

export const claudeRouter = new Hono();

const PENDING_TIMEOUT_MS = 600_000;

async function clearStaleCodexPermissionIfTmuxNoLongerAsking(tmuxName: string): Promise<void> {
  const pending = store.getPending(tmuxName);
  if (!pending || pending.source !== 'codex' || pending.kind !== 'permission') return;
  // Keep the chat/G2 permission UI only while Codex is visibly waiting in tmux.
  // Auto-review or direct tmux approval can advance before PostToolUse/Stop reaches
  // headlenss, especially for Codex sessions that were started before hooks changed.
  try {
    const pane = await captureOutput(tmuxName, 80);
    const stillAsking = isCodexPermissionPrompt(pane);
    // capture の間に別の用件へ入れ替わっていることがあるので、見に行った当人だけを消す
    if (!stillAsking) store.clearPendingIfId(tmuxName, pending.id);
  } catch {
    // If tmux capture fails, leave the pending alone; normal cleanup paths can still clear it.
  }
}

async function getTmuxName(c: Context): Promise<string> {
  const pane = c.req.header('X-Tmux-Pane') ?? '';
  return resolveTmuxSessionName(pane);
}

/**
 * store の記録が「今その pane を握っている agent」とは別 agent の残骸か。
 *
 * true の間、その store 由来の表示 (chat / status / pending) は出さない
 * (store 自体は書き換えない = 表示の抑止だけ)。判定を 1 箇所に持つのは、
 * chat と pending で条件がずれると「会話は空なのに承認だけ出る」のような
 * 非対称が生まれるため。owner が取れない (=不明) 間は sticky に従来表示。
 *
 * 既知の制限 (挙動として受け入れているもの):
 * 同一 tmux セッション内の別 window に別エージェント (例: window0=Claude,
 * window1=Codex) が居る構成では、live owner が「アクティブ window のアクティブ
 * pane」から決まるため、ユーザが window を切り替えるだけで owner の source が
 * 変わる。すると store 側 (元の window のエージェント) が残骸と判定され、その間
 * pending / chat の表示が抑止される。表示が引っ込むだけで store は壊れず、window を
 * 戻せば元に戻る。/chat と /pending が同じ判定を共有しているぶん、少なくとも
 * 「会話は空なのに承認だけ出る」非対称は起きない (= /chat と整合する既知の制限)。
 */
function isStoreStale(
  session: { source?: 'claude' | 'codex' } | undefined,
  owner: { source: 'claude' | 'codex' } | undefined,
): boolean {
  return !!owner && !!session?.source && owner.source !== session.source;
}

type HookPayload = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: { questions?: AskQuestion[]; [k: string]: unknown };
  source?: string;
  // Stop / SubagentStop で送られる「今のターンの最終アシスタント本文」。
  // transcript は非同期書き込みでフック発火時にまだ今ターン分を含まないため、
  // 公式ドキュメントはこちらを使うよう指示している。
  // https://code.claude.com/docs/en/hooks
  last_assistant_message?: string | null;
};

// ───────── hooks (received from plugin) ─────────

claudeRouter.post('/hooks/session-start', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HookPayload;
  const tmuxName = await getTmuxName(c);
  const paneId = c.req.header('X-Tmux-Pane') ?? '';
  console.log(`[hook] session-start tmux=${tmuxName} src=${body.source ?? ''}`);
  if (!tmuxName) return c.json({});
  const existing = store.getSession(tmuxName);
  if (existing?.source === 'codex') {
    if (await isCodexForegroundInPane(paneId || tmuxName)) {
      // Codex TUI still owns the pane — this is a subprocess Claude; skip.
      return c.json({});
    }
  }
  // Always upsert (not lazy-create) so that source flips to 'claude'
  // when the user switches from Codex to Claude in the same pane.
  store.upsertSession({
    ccSessionId: body.session_id ?? '',
    tmuxPane: paneId,
    tmuxSessionName: tmuxName,
    cwd: body.cwd ?? '',
    source: 'claude',
  });
  return c.json({});
});

claudeRouter.post('/hooks/session-end', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HookPayload;
  const tmuxName = await getTmuxName(c);
  console.log(`[hook] session-end tmux=${tmuxName} src=${body.source ?? ''} (NOT clearing chat)`);
  // 注意: SessionEnd は prompt_input_exit など軽い理由でも発火するため、
  // ここで session を削除すると chat 履歴がリセットされて壊れる。
  // 起動中判定はレジストリ検出 (process-detect) に任せ、ここでは何もしない。
  return c.json({});
});

claudeRouter.post('/hooks/user-prompt-submit', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HookPayload;
  const tmuxName = await getTmuxName(c);
  const paneId = c.req.header('X-Tmux-Pane') ?? '';
  if (!tmuxName) return c.json({});
  // Lazy-create the session if SessionStart hook never fired
  if (!store.getSession(tmuxName)) {
    store.upsertSession({
      ccSessionId: body.session_id ?? '',
      tmuxPane: paneId,
      tmuxSessionName: tmuxName,
      cwd: body.cwd ?? '',
      source: 'claude',
    });
  }
  const existing = store.getSession(tmuxName);
  if (existing?.source === 'codex') {
    if (await isCodexForegroundInPane(paneId || tmuxName)) {
      // Codex TUI still owns the pane: this Claude hook is from a subprocess
      // spawned by Codex (e.g. claude -p) — keep it out of the main chat.
      return c.json({});
    }
    // The user switched this pane from Codex to Claude — reclaim the session.
    store.upsertSession({
      ccSessionId: body.session_id ?? '',
      tmuxPane: paneId,
      tmuxSessionName: tmuxName,
      cwd: body.cwd ?? '',
      source: 'claude',
    });
  }
  // 新しいターンが始まる: 前ターンの Stop マーカーをクリア
  store.clearStopped(tmuxName);
  const text = (body.prompt ?? '').trim();
  console.log(`[hook] user-prompt tmux=${tmuxName} len=${text.length}`);
  if (text) {
    const origin = matchUiSubmission(tmuxName, text) ? 'ui' as const : 'external' as const;
    store.appendChat(tmuxName, 'user', text, { origin });
  }
  return c.json({});
});

claudeRouter.post('/hooks/stop', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HookPayload;
  const tmuxName = await getTmuxName(c);
  const paneId = c.req.header('X-Tmux-Pane') ?? '';
  console.log(`[hook] stop tmux=${tmuxName} transcript=${(body.transcript_path ?? '').slice(-40)}`);
  if (!tmuxName) return c.json({});
  if (!store.getSession(tmuxName)) {
    store.upsertSession({
      ccSessionId: body.session_id ?? '',
      tmuxPane: paneId,
      tmuxSessionName: tmuxName,
      cwd: body.cwd ?? '',
      source: 'claude',
    });
  }
  const existing = store.getSession(tmuxName);
  if (existing?.source === 'codex') {
    if (await isCodexForegroundInPane(paneId || tmuxName)) {
      // Codex TUI still owns the pane: this Claude hook is from a subprocess
      // spawned by Codex (e.g. claude -p) — keep it out of the main chat.
      return c.json({});
    }
    // The user switched this pane from Codex to Claude — reclaim the session.
    store.upsertSession({
      ccSessionId: body.session_id ?? '',
      tmuxPane: paneId,
      tmuxSessionName: tmuxName,
      cwd: body.cwd ?? '',
      source: 'claude',
    });
  }
  // 今ターンの本文は payload の last_assistant_message を最優先で使う。
  // transcript は非同期書き込みなので、フック発火時点ではまだ今ターン分が
  // 書かれておらず、読みに行くと「1ターン前の返答」を拾ってしまう。
  // 古い Claude Code (フィールド未提供) 向けに transcript 読みを fallback で残す。
  let text = (body.last_assistant_message ?? '').trim();
  let textSource: 'payload' | 'transcript' = 'payload';
  const transcriptPath = body.transcript_path ?? '';
  if (!text && transcriptPath) {
    text = await extractLastAssistantText(transcriptPath);
    textSource = 'transcript';
  }
  console.log(`[hook] stop -> assistant text len=${text.length} src=${textSource}`);
  if (text) store.appendChat(tmuxName, 'assistant', text, { agent: 'claude' });
  // ターン終了マーカーを立てる: registry の busy が idle に追いつくまでの
  // ラグの間、考え中インジケータをこちらで先に消す。
  store.markStopped(tmuxName);
  return c.json({});
});

// PreToolUse hook は plugin/hooks/hooks.json で matcher: "AskUserQuestion" 限定。
// 「両側回答対応モード」: 即時 {} を return して TUI に質問を表示させる。
// pending を store に記録し、chat と TUI の両方から回答を受けられるようにする。
//   - chat で回答 → respond エンドポイントが tmux send-keys で TUI に矢印+Enter を注入
//   - TUI で直接回答 → transcript JSONL の tool_result で検出 → pending clear
claudeRouter.post('/hooks/pre-tool-use', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HookPayload & {
    tool_use_id?: string;
  };
  const tmuxName = await getTmuxName(c);
  const paneId = c.req.header('X-Tmux-Pane') ?? '';
  const toolName = body.tool_name ?? '';
  const toolInput = (body.tool_input ?? {}) as { questions?: AskQuestion[] };
  const isAskQ = toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions);
  console.log(`[hook] pre-tool-use tmux=${tmuxName} tool=${toolName} isAskQ=${isAskQ} toolUseId=${body.tool_use_id ?? ''}`);
  if (!tmuxName || !isAskQ) return c.json({});
  if (!store.getSession(tmuxName)) {
    store.upsertSession({
      ccSessionId: body.session_id ?? '',
      tmuxPane: paneId,
      tmuxSessionName: tmuxName,
      cwd: body.cwd ?? '',
      source: 'claude',
    });
  }
  const existing = store.getSession(tmuxName);
  if (existing?.source === 'codex') {
    if (await isCodexForegroundInPane(paneId || tmuxName)) {
      return c.json({});
    }
    store.upsertSession({
      ccSessionId: body.session_id ?? '',
      tmuxPane: paneId,
      tmuxSessionName: tmuxName,
      cwd: body.cwd ?? '',
      source: 'claude',
    });
  }

  store.createPending(tmuxName, {
    kind: 'question',
    hookEvent: 'PreToolUse',
    toolName,
    toolInput,
    questions: toolInput.questions,
    toolUseId: body.tool_use_id,
    transcriptPath: body.transcript_path,
  });

  // transcript watcher を起動: TUI で回答された場合の検出
  startTuiAnswerWatcher(tmuxName, body.tool_use_id ?? '', body.transcript_path ?? '');

  // 即時 return: TUI に質問を表示させる
  return c.json({});
});

/**
 * キー注入の途中で用件が入れ替わっていたことを表す。
 * 注入は「Down x N → Enter」のように前後関係のある一連の操作なので、途中で TUI が
 * 別の質問に変わっていたら以降のキーは全く別の意味になる。見つけ次第打ち切る。
 */
class PendingChangedError extends Error {
  constructor(
    readonly currentPendingId: string | undefined,
    /** 打ち切りまでに 1 つでもキーを送っていたか (= TUI に途中まで届いている可能性)。 */
    readonly injected: boolean,
  ) {
    super('pending changed during key injection');
    this.name = 'PendingChangedError';
  }
}

/**
 * 1 件の用件に対するキー注入口。
 *
 * すべての送信 (sendKey / sendKeys) をここに通し、送信の直前に必ず
 * 「開始時の用件が今も現役か」を見直す。なぜ 1 キーごとに見直すか: 注入は
 * 「Down x N → Enter」のように前後関係のある一連の操作で、間には TUI の追従を
 * 待つ wait が挟まる。その wait の間に用件が入れ替わると、以降の矢印と Enter は
 * 全く別の質問への操作になる。見つけ次第そこで打ち切る。
 *
 * ただしこれは「headlenss 側の用件の入れ替わり」しか見ていない。ユーザが tmux を
 * 直接触って TUI を操作している場合、headlenss 側からは排他も検知もできない
 * (tmux の TUI に対する排他制御は存在しない)。その場合はキーが混ざりうる。
 */
class TuiKeyInjector {
  /** 1 つでもキーを送ったか。「途中で打ち切った」と「一切撃っていない」の区別に使う。 */
  private sentAny = false;

  constructor(private readonly tmuxName: string, private readonly expectPendingId: string) {}

  /** 開始時の用件が今も現役かを確かめる。違っていたら PendingChangedError。 */
  private guard(): void {
    const cur = store.getPending(this.tmuxName);
    if (cur?.id === this.expectPendingId) return;
    console.log(
      `[respond] pending changed mid-injection: expect=${this.expectPendingId} current=${cur?.id ?? '(none)'} sentAny=${this.sentAny}`,
    );
    throw new PendingChangedError(cur?.id, this.sentAny);
  }

  /** 特殊キー (Down / Enter 等) を 1 つ送る。 */
  async key(key: string): Promise<void> {
    this.guard();
    // 実際に届いたかは execFile の成否では確定できない (timeout でも届きうる) ので、
    // 「撃った」側に倒して記録する。
    this.sentAny = true;
    await sendKey(this.tmuxName, key);
  }

  /** 文字列をそのまま流し込む (Type something の自由記述)。 */
  async text(text: string): Promise<void> {
    this.guard();
    this.sentAny = true;
    await sendKeys(this.tmuxName, text, false);
  }
}

/** AskUserQuestion の TUI に対して、選んだ option を矢印キー + Enter で注入する。
 *
 *  実機検証で判明した TUI 仕様:
 *  - 単一質問: 選択肢リストのみ。Down x N で focus 移動、Enter で選択 → 即送信
 *  - 複数質問: タブ式 UI。各質問で Down x N + Enter → 自動で次質問タブへ。
 *    最後の質問を確定すると別途「Submit answers / Cancel」確認画面に遷移。
 *    Submit answers がデフォルト focus なので、追加で Enter を 1 回送る。
 *  - 「Type something」(option N+1) は文字を入力すると自由記述モードになり、
 *    Enter で「{自由記述テキスト}」が answer として送られる。
 *    notes 付き回答はこのモード経由で「{label}: {notes}」の形で送る。
 *
 *  options が見つからない場合や questions/answers の長さがミスマッチした場合はスキップ。 */
async function sendAnswersToTui(
  tmuxName: string,
  answers: Array<{ question: string; option?: string; options?: string[]; text?: string; notes?: string; answerKind?: 'predefined' | 'type-something' | 'chat-about-this' }>,
  questions: AskQuestion[],
  expectPendingId: string,
): Promise<void> {
  console.log(`[respond] sendAnswersToTui tmux=${tmuxName} answers=${answers.length}`);
  // すべての送信はこの口を通す (送信ごとに用件の入れ替わりを見直す)。
  const keys = new TuiKeyInjector(tmuxName, expectPendingId);

  // 任意の質問に「chat-about-this」が含まれていたら、その質問の TUI で
  // 「Chat about this」を選択することで AskUserQuestion 全体が reject される。
  // 他の質問の回答は不要なので、最初の chat-about-this を見つけたらそこで終了。
  const chatIdx = answers.findIndex((a) => a.answerKind === 'chat-about-this');
  if (chatIdx >= 0) {
    const q = questions[chatIdx];
    if (q) {
      const predefinedCount = (q.options ?? []).length;
      // Chat about this は Type something のさらに 1 つ下 → Down x (predefinedCount + 1)
      console.log(`[respond] chat-about-this at q${chatIdx}: navigating to Chat about this`);
      // chatIdx に到達するまで前の質問は predefined option 1 を Enter で素通り
      // (実際には reject なので前の質問の選択は無視される。手っ取り早く Enter で進める。)
      for (let qi = 0; qi < chatIdx; qi++) {
        await keys.key('Enter');
        await wait(150);
      }
      for (let i = 0; i < predefinedCount + 1; i++) {
        await keys.key('Down');
        await wait(40);
      }
      await keys.key('Enter');
    }
    console.log(`[respond] sendAnswersToTui done (chat-about-this rejected)`);
    return;
  }

  for (let qi = 0; qi < answers.length; qi++) {
    const a = answers[qi];
    const q = questions[qi];
    if (!q) { console.log(`[respond]   q${qi}: question missing, skip`); continue; }
    const predefinedCount = (q.options ?? []).length;
    const kind = a.answerKind ?? 'predefined';

    if (kind === 'type-something') {
      // 明示的な Type something: text を生で送る
      const text = (a.text ?? '').trim();
      if (!text) { console.log(`[respond]   q${qi}: type-something but text empty, skip`); continue; }
      console.log(`[respond]   q${qi}: type-something path, text="${text.slice(0, 40)}"`);
      for (let i = 0; i < predefinedCount; i++) {
        await keys.key('Down');
        await wait(40);
      }
      await keys.text(text);
      await wait(80);
      await keys.key('Enter');
    } else {
      // predefined: multi-select (options 配列) vs single-select (option) で挙動が違う。
      const isMulti = !!q.multiSelect;
      const selectedSet = new Set<string>(
        a.options && a.options.length > 0
          ? a.options
          : a.option ? [a.option] : []
      );

      if (isMulti) {
        // multi-select: 各 option を順に focus し、選択対象なら Enter で toggle。
        // 全部回ったあと Type something(predefined+0)を素通り(Down)→ Submit(predefined+1)で Enter。
        console.log(`[respond]   q${qi}: multi-select, selected=${[...selectedSet].join(',')}`);
        for (let i = 0; i < predefinedCount; i++) {
          const lbl = (q.options ?? [])[i]?.label ?? '';
          if (selectedSet.has(lbl)) {
            await keys.key('Enter');
            await wait(40);
          }
          await keys.key('Down');
          await wait(40);
        }
        // 今 Type something に focus。Submit に進むのは Down 1 回。
        await keys.key('Down');
        await wait(40);
        // Submit で commit
        await keys.key('Enter');
      } else {
        // single-select: notes が付いていたら Type something 経由で「{option}: {notes}」を送る、
        // notes なしならそのまま option を選択。
        const note = a.notes?.trim();
        if (note) {
          console.log(`[respond]   q${qi}: predefined+notes -> Type something path`);
          for (let i = 0; i < predefinedCount; i++) {
            await keys.key('Down');
            await wait(40);
          }
          const textToType = `${a.option ?? ''}: ${note}`;
          await keys.text(textToType);
          await wait(80);
          await keys.key('Enter');
        } else {
          // option の実在は注入前の検証 (validateQuestionAnswers) 済み。
          // ここに来て見つからないのは想定外なので、撃たずに次へ進む。
          const optIdx = (q.options ?? []).findIndex((o) => o.label === a.option);
          if (optIdx < 0) { console.log(`[respond]   q${qi}: option "${a.option ?? ''}" not found, skip`); continue; }
          console.log(`[respond]   q${qi}: predefined optIdx=${optIdx}`);
          for (let i = 0; i < optIdx; i++) {
            await keys.key('Down');
            await wait(40);
          }
          await keys.key('Enter');
        }
      }
    }
    await wait(200);
  }
  // 最終 Review 画面の Submit answers を Enter で確定する必要があるケース:
  //  - 複数質問
  //  - 単一質問でも multi-select だと Review 画面が出る
  const hasMulti = answers.some((a, i) => {
    const q = questions[i];
    return q?.multiSelect === true && a.answerKind !== 'chat-about-this' && a.answerKind !== 'type-something';
  });
  if (answers.length >= 2 || hasMulti) {
    // 最後の Enter も「まだ同じ用件の Review 画面か」を確かめてから撃つ (keys.key が確認する)。
    console.log(`[respond] final Review screen detected, sending Enter to confirm`);
    await keys.key('Enter');
  }
  console.log(`[respond] sendAnswersToTui done`);
}

/** transcript JSONL を polling して、指定 tool_use_id の tool_result が現れたら pending clear。
 *  TUI 側でユーザが直接回答した場合の自動検出用。 */
type TuiWatcher = { toolUseId: string; cancel: () => void };
// toolUseId を持たせるのは、止めてよい watcher かを呼び出し側が照合できるようにするため
// (別の用件の watcher を巻き添えで止めると、その用件の TUI 回答検出が孤児になる)。
const tuiWatchers = new Map<string, TuiWatcher>();
/** watcher の寿命。これを過ぎたら自分で止まる (pending 側の待ち受けと同じ長さ)。 */
const TUI_WATCHER_MAX_MS = 600_000;
function startTuiAnswerWatcher(tmuxName: string, toolUseId: string, transcriptPath: string): void {
  if (!toolUseId || !transcriptPath) return;
  // 既存 watcher があれば止める(ありえないが念のため)
  tuiWatchers.get(tmuxName)?.cancel();

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = Date.now() + TUI_WATCHER_MAX_MS;

  // 終了口はこの 1 つだけ。TUI 回答の検出・期限切れ・cancel のどの経路から来ても、
  // 「タイマーを止める」と「自分がまだ登録中なら Map から自分を外す」を必ず行う。
  // なぜ登録を確かめるか: 後から別の watcher に差し替わっていた場合、遅れて呼ばれた
  // 終了処理が現役の登録を消してしまうため。逆に確かめずに消し忘れると、
  // 止まった watcher の登録だけが Map に残り (孤児)、respond 側の
  // 「watcher.toolUseId === pending.toolUseId」照合を狂わせる。
  function finish(reason: 'answered' | 'timeout' | 'cancel'): void {
    if (cancelled) return;
    cancelled = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (tuiWatchers.get(tmuxName) === entry) tuiWatchers.delete(tmuxName);
    if (reason !== 'cancel') {
      console.log(`[watcher] stopped (${reason}) tmux=${tmuxName} toolUseId=${toolUseId}`);
    }
  }
  const entry: TuiWatcher = { toolUseId, cancel: () => finish('cancel') };

  const tick = async (): Promise<void> => {
    timer = null;
    if (cancelled) return;
    if (Date.now() >= deadline) { finish('timeout'); return; }
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(transcriptPath, 'utf-8');
      // tool_result with matching tool_use_id を探す
      // JSONL なので一行ずつ。シンプルに文字列マッチで存在判定。
      if (raw.includes(`"tool_use_id":"${toolUseId}"`) && raw.includes('"type":"tool_result"')) {
        // より確実にするため行ごとに検証
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          if (!line.includes(toolUseId)) continue;
          try {
            const obj = JSON.parse(line) as { message?: { content?: unknown } };
            const content = obj.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block && typeof block === 'object' &&
                  (block as { type?: string }).type === 'tool_result' &&
                  (block as { tool_use_id?: string }).tool_use_id === toolUseId
                ) {
                  console.log(`[watcher] TUI answered (tool_use_id=${toolUseId}), clearing pending for ${tmuxName}`);
                  // 監視していた用件が今も現役の時だけ消す (次の用件を巻き込まない)
                  const cur = store.getPending(tmuxName);
                  if (cur?.toolUseId === toolUseId) store.clearPendingIfId(tmuxName, cur.id);
                  finish('answered');
                  return;
                }
              }
            }
          } catch { /* skip malformed line */ }
        }
      }
    } catch { /* file not yet readable etc */ }
    if (!cancelled) timer = setTimeout(() => { void tick(); }, 500);
  };
  timer = setTimeout(() => { void tick(); }, 500);
  tuiWatchers.set(tmuxName, entry);
}

claudeRouter.post('/hooks/permission-request', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HookPayload;
  const tmuxName = await getTmuxName(c);
  const paneId = c.req.header('X-Tmux-Pane') ?? '';
  const toolName = body.tool_name ?? '';
  console.log(`[hook] permission-request tmux=${tmuxName} tool=${toolName} hasQs=${Array.isArray((body.tool_input as { questions?: unknown })?.questions)}`);
  if (!tmuxName) return c.json({});
  // AskUserQuestion は PreToolUse 側で「両側回答対応モード」で扱うので、こちらでは何もしない。
  // (両方で pending を作ると競合する)
  if (toolName === 'AskUserQuestion') return c.json({});
  if (!store.getSession(tmuxName)) {
    store.upsertSession({
      ccSessionId: body.session_id ?? '',
      tmuxPane: paneId,
      tmuxSessionName: tmuxName,
      cwd: body.cwd ?? '',
      source: 'claude',
    });
  }
  const existing = store.getSession(tmuxName);
  if (existing?.source === 'codex') {
    if (await isCodexForegroundInPane(paneId || tmuxName)) {
      return c.json({});
    }
    store.upsertSession({
      ccSessionId: body.session_id ?? '',
      tmuxPane: paneId,
      tmuxSessionName: tmuxName,
      cwd: body.cwd ?? '',
      source: 'claude',
    });
  }

  const toolInput = body.tool_input ?? {};
  const isAskQ = toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions);

  const pending = store.createPending(tmuxName, {
    kind: isAskQ ? 'question' : 'permission',
    hookEvent: 'PermissionRequest',
    toolName,
    toolInput,
    questions: isAskQ ? toolInput.questions : undefined,
  });

  const decision = await store.awaitPendingResolution(pending.id, PENDING_TIMEOUT_MS);
  // 待っている間に別の用件が作られていることがある (タイムアウト時など)。
  // 自分が作った用件だけを消す。
  store.clearPendingIfId(tmuxName, pending.id);

  if (decision.event === 'PermissionRequest') {
    return c.json({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: decision.behavior, message: decision.message },
      },
    });
  }
  return c.json({});
});

// ───────── G2-facing endpoints ─────────

claudeRouter.get('/claude/sessions', async (c) => {
  // hook 経由で記録されているセッション (チャット履歴あり)
  const tracked = store.listSessions();

  // 現在生きている tmux セッションを取得し、tracked のうち既に消滅したものは
  // store からも消す (DELETE API 以外の経路で kill された場合への保険)。
  // tmux 側の取得に失敗した場合は cleanup 自体をスキップして既存挙動を維持する。
  let liveTmux: Set<string> | null = null;
  try {
    liveTmux = await liveTmuxSessionNames();
  } catch {
    liveTmux = null;
  }
  if (liveTmux) {
    for (const s of tracked) {
      if (!liveTmux.has(s.tmuxSessionName)) {
        store.removeSession(s.tmuxSessionName);
      }
    }
    // 死んだ / 改名された tmux セッションの status 変化時刻も一緒に捨てる。
    pruneSessionStatusObservations(liveTmux);
  }

  // 掃除後の tracked 一覧を取り直す
  const trackedAlive = liveTmux ? store.listSessions() : tracked;

  // 検出 + live owner (今その画面を握っている本人)。失敗は [] / null に倒して sticky。
  const [detected, codexDetected, liveOwners] = await Promise.all([
    detectClaudeSessions().catch(() => []),
    detectCodexSessions().catch(() => []),
    detectLiveOwners().catch(() => null),
  ]);

  const merged: Array<{
    tmuxSessionName: string;
    cwd: string;
    status: SessionStatus;
    /** 現在の status に入ったとサーバが観測した時刻 (epoch ms)。 */
    statusChangedAt: number;
    startedAt: number;
    lastSeenAt: number;
    source?: 'claude' | 'codex';
    codexHookHealth?: ReturnType<typeof getCodexHookHealth>;
    codexNeedsHookAttention?: boolean;
    lastChat?: string;
    /** セッションの作業フォルダ配下で動いている G2 プラグインの dev server */
    g2Plugins?: G2Plugin[];
  }> = [];

  const claudeByName = new Map(detected.map((d) => [d.tmuxSessionName, d]));
  const codexByName = new Map(codexDetected.map((d) => [d.tmuxSessionName, d]));
  const trackedByName = new Map(trackedAlive.map((s) => [s.tmuxSessionName, s]));

  // 対象セッション名: store・claude 検出・codex 検出・live owner の和集合 (1 名 1 エントリ)。
  const names = new Set<string>([
    ...trackedByName.keys(),
    ...claudeByName.keys(),
    ...codexByName.keys(),
    ...(liveOwners ? liveOwners.keys() : []),
  ]);

  for (const name of names) {
    if (liveTmux && !liveTmux.has(name)) continue;
    const st = trackedByName.get(name);
    const ownerEntry = liveOwners?.get(name);
    // Claude が owner のときは owner PID 一致の det「のみ」を使う (fail-closed)。
    // 同名 last-wins でヘッドレス claude の cwd/status を出さないため。
    // status 側も同じ選び方をする必要があるので、選択自体を共有関数に置いている。
    const cd = pickClaudeDetected(name, detected, ownerEntry);
    const xd = codexByName.get(name);

    // 実効ソース: live owner を最優先 → store → 検出。owner 不明時は sticky。
    // /api/sessions と同じ判定になるよう共有関数に寄せている。
    const signals = {
      tmuxSessionName: name,
      store: st,
      claudeDetected: detected,
      codexDetected,
      liveOwner: ownerEntry,
    };
    const effSource = pickEffectiveSource(signals);
    if (!effSource) {
      // agent 不明の間は status を観測できないので記録を忘れる
      // (再び agent が現れたときに古い statusChangedAt を引き継がないため)。
      deleteSessionStatusObservation(name);
      continue;
    }

    // store が実効ソースと別 agent (残骸) の場合、その cwd/status は使わない。
    const storeMatched = !!st && st.source === effSource;

    // G2 一覧のプレビュー用: 現在の主と一致する store chat の最後の非空メッセージ冒頭。
    // (別 agent の残骸チャットは出さない。hook 未追跡セッションでは空になる。)
    let lastChat: string | undefined;
    if (storeMatched) {
      const storeChat = store.getChat(name);
      for (let i = storeChat.length - 1; i >= 0; i--) {
        const txt = sanitizeChatText(storeChat[i].text).replace(/\s+/g, ' ').trim();
        if (txt) { lastChat = txt.slice(0, 48); break; }
      }
    }

    if (effSource === 'claude') {
      const sc = storeMatched ? st : undefined;
      const { status, statusChangedAt } = resolveTrackedSessionStatus({ ...signals, source: 'claude' });
      merged.push({
        tmuxSessionName: name,
        cwd: sc?.cwd || cd?.cwd || '',
        status,
        statusChangedAt,
        startedAt: sc?.startedAt ?? cd?.startedAt ?? 0,
        lastSeenAt: sc?.lastSeenAt ?? cd?.startedAt ?? 0,
        source: 'claude',
        lastChat,
      });
    } else {
      const sx = storeMatched ? st : undefined;
      const cwd = sx?.cwd || xd?.cwd || '';
      const { status, statusChangedAt } = resolveTrackedSessionStatus({ ...signals, source: 'codex' });
      merged.push({
        tmuxSessionName: name,
        cwd,
        status,
        statusChangedAt,
        startedAt: sx?.startedAt ?? xd?.startedAt ?? 0,
        lastSeenAt: sx?.lastSeenAt ?? xd?.lastSeenAt ?? 0,
        source: 'codex',
        codexHookHealth: cwd ? getCodexHookHealth(cwd) : undefined,
        codexNeedsHookAttention: xd?.needsHookAttention,
        lastChat,
      });
    }
  }

  // 各セッションの作業フォルダ配下で動いている G2 プラグインを付ける。
  // 検出結果は g2-plugins 側でキャッシュされるので、セッション数ぶん呼んでも
  // ポート走査は 1 回にまとまる。失敗しても一覧自体は返す。
  // cwd はフック由来なので、サーバ再起動直後やフック未導入のセッションでは空になる。
  // その場合は tmux の pane から直接引いて補う (検出はフォルダが要るため)。
  const panePaths = await tmuxSessionPaths().catch(() => new Map<string, string>());
  await Promise.all(merged.map(async (s) => {
    const cwd = s.cwd || panePaths.get(s.tmuxSessionName) || '';
    if (!cwd) return;
    const plugins = await detectG2Plugins(cwd).catch((e) => {
      console.warn(`[g2-plugins] ${s.tmuxSessionName}: ${(e as Error).message}`);
      return [] as G2Plugin[];
    });
    if (plugins.length > 0) s.g2Plugins = plugins;
  }));

  return c.json({ sessions: merged });
});

claudeRouter.get('/claude/sessions/:tmuxName/chat', async (c) => {
  const tmuxName = c.req.param('tmuxName');
  await clearStaleCodexPermissionIfTmuxNoLongerAsking(tmuxName);
  const session = store.getSession(tmuxName);

  // ── Always call (cached) detect for status resolution ──
  // Claude hooks never call store.setStatus('busy') — busy status comes ONLY
  // from the registry via detectClaudeSessions(). Detect functions are cached
  // (TTL + singleflight) so cache hits are memory-only and the perf win is
  // preserved. Store-first logic is kept ONLY for transcript-path resolution
  // (store cwd/ccSessionId preferred, detect as fallback).
  type DetResult = Awaited<ReturnType<typeof detectClaudeSessions>>[number] | undefined;
  type CodexDetResult = Awaited<ReturnType<typeof detectCodexSessions>>[number] | undefined;
  const [detected, codexDetected, liveOwners] = await Promise.all([
    detectClaudeSessions().catch(() => []),
    detectCodexSessions().catch(() => []),
    detectLiveOwners().catch(() => null),
  ]);
  // live owner (今その画面を握っている本人) を source の権威にする。
  const owner = liveOwners?.get(tmuxName);
  // Claude が owner のときは owner の PID に一致する det「のみ」を使う (fail-closed)。
  // 名前フォールバックすると、対話 claude の registry がまだ出ていない一瞬に、
  // 同名で拾える別の claude det (claude -p 等) の会話を出す恐れがあるため。
  // owner が codex / 不明のときは従来どおり名前一致で解決する。
  const det: DetResult = owner?.source === 'claude'
    ? detected.find((d) => d.pid === owner.pid)
    : detected.find((d) => d.tmuxSessionName === tmuxName);
  const codexDet: CodexDetResult = codexDetected.find((d) => d.tmuxSessionName === tmuxName);

  // 実効ソース: live owner を最優先 → store → 検出。owner 不明時は sticky。
  const effSource: 'claude' | 'codex' | undefined =
    owner?.source ?? session?.source ?? (det ? 'claude' : codexDet ? 'codex' : undefined);
  // store が現在の主と別 agent の残骸なら、その chat/transcript/status/pending は出さない
  // (表示の抑止のみ。store は書き換えない)。/pending も同じ判定を使う。
  const storeIsStale = isStoreStale(session, owner);

  // hook 経由で記録された chat (現在の主と一致する store のみ採用)
  const hookChat = storeIsStale ? [] : (session?.chat ?? []);

  // Parse tail query param (clamped 1..200, NaN-safe)
  const tailParam = c.req.query('tail');
  const raw = Number(tailParam);
  const tailN = tailParam && Number.isFinite(raw) && raw > 0
    ? Math.max(1, Math.min(200, Math.floor(raw)))
    : undefined;
  const transcriptLimit = tailN ?? 200;

  // transcript を読んで履歴を補完 (hook では取りこぼす過去分も拾える)。
  // Store-first: Claude sessions use store's cwd/ccSessionId when available;
  // only fall back to detect results when the store lacks them.
  // transcript は effectiveSource で先に分岐する (stale codex が Claude の transcript に
  // 落ちて誤表示するのを防ぐ)。
  let transcriptChat: ChatItem[] = [];
  if (effSource === 'codex') {
    // Codex の会話中身はフック由来の transcriptPath に頼る (現在の主と一致する store のみ)。
    // stale (live=codex だが store=claude) の間は該当パスが無いので空にする (誤って Claude の
    // 会話を出さない。codex フックが来れば自己回復)。
    if (!storeIsStale && session?.source === 'codex' && session.transcriptPath && existsSync(session.transcriptPath)) {
      transcriptChat = await extractCodexChatFromTranscript(session.transcriptPath, transcriptLimit, !!tailN);
    }
  } else if (effSource === 'claude') {
    // store が claude を指す時のみ store の cwd/ccSessionId を使い、それ以外 (stale/無し) は
    // live 検出 (owner PID 一致の det) を優先する。
    const storeClaude = !storeIsStale && session?.source === 'claude' ? session : undefined;
    const cwd = storeClaude?.cwd || det?.cwd || '';
    const ccSessionId = storeClaude?.ccSessionId || det?.ccSessionId || '';
    if (cwd && ccSessionId) {
      const path = transcriptPathFor(cwd, ccSessionId);
      if (existsSync(path)) {
        transcriptChat = await extractChatFromTranscript(path, transcriptLimit, !!tailN);
      }
    }
  }

  // hook 由来の chat も transcript と同じシステムタグサニタイズを通す
  // (! 付きで実行された bash コマンド等のラッパが残らないように)。
  // サニタイズ済み hookChat (全件)。enrichment 用の lookup は常にこれから作る。
  const allCleanedHookChat = hookChat
    .map((m) => ({ ...m, text: sanitizeChatText(m.text) }))
    .filter((m) => m.text.length > 0);
  // 補完は cleanedHookChat から (Codex+transcript は従来どおり全捨て)、
  // enrichment だけは全 hookChat から行う。
  let cleanedHookChat = effSource === 'codex' && transcriptChat.length > 0 ? [] : allCleanedHookChat;

  // In tail mode, pre-cut cleanedHookChat to its last tailN entries so a large
  // hookChat can't crowd out newer transcript entries after the final splice.
  if (tailN && cleanedHookChat.length > tailN) {
    cleanedHookChat = cleanedHookChat.slice(-tailN);
  }

  // hookChat の origin / agent を role:text キーで引けるルックアップを作成。
  // transcript 側のエントリが重複排除で勝つ際に、hook 側の origin / agent を引き継ぐ。
  // Codex でも全件から構築する (cleanedHookChat が空でも enrichment は有効にする)。
  const hookLookup = new Map<string, { origin?: 'ui' | 'external'; agent?: 'claude' | 'codex' }>();
  for (const m of allCleanedHookChat) {
    const key = `${m.role}:${m.text}`;
    if (m.origin || m.agent) hookLookup.set(key, { origin: m.origin, agent: m.agent });
  }

  // hook の最新分が transcript から漏れてる可能性に備えてマージ。
  // transcript を base にして、hook側の項目を text 一致で重複排除。
  // 最後に ts でソート: AskUserQuestion 回答の合成 user メッセージなど、
  // transcript に存在しないが時系列上は中間に位置する項目を正しい位置に置くため。
  // transcript 側エントリに hookChat の origin / agent を引き継ぐ (enrich)。
  const seen = new Set(transcriptChat.map((m) => `${m.role}:${m.text}`));
  const merged: ChatItem[] = transcriptChat.map((m) => {
    const key = `${m.role}:${m.text}`;
    const enrichment = hookLookup.get(key);
    if (enrichment) {
      // hook 側の値が優先される (transcript は origin/agent を持たないため)
      return { ...m, origin: enrichment.origin ?? m.origin, agent: enrichment.agent ?? m.agent };
    }
    return m;
  });
  // hookChat のうち transcript に無いエントリで補完 (cleanedHookChat を使用)。
  for (const m of cleanedHookChat) {
    const key = `${m.role}:${m.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(m);
    }
  }
  merged.sort((a, b) => a.ts - b.ts);

  // tail: return only the last N entries (before synthetic status injection)
  if (tailN && merged.length > tailN) {
    merged.splice(0, merged.length - tailN);
  }

  // det (process-detect で見つかった Claude セッション) も 404 判定に含める。
  // これが抜けていると、検出済みだが transcript がまだ空の Claude セッションを
  // 開いたときに 404 → チャットが空表示になってしまう。
  if (merged.length === 0 && !session && !det && !codexDet && !owner) {
    return c.json({ error: 'not found' }, 404);
  }
  // Claude Code の動作状態 (idle / busy / waiting-*) を一緒に返して、
  // chat UI 側で「考え中…」表示の有無を制御できるようにする。
  //
  // 優先順位の根拠:
  //   - 'waiting-*' は hook 経由(PermissionRequest/PreToolUse)でしか設定されない
  //   - 'busy' は registry (~/.claude/sessions/<PID>.json) 経由でしか検出されない
  //   - 'idle' はそれ以外
  // hook session.status は常に 'idle' か 'waiting-*' (busy になる経路がない)ため、
  // 単純な ?? チェーンでは registry 由来の 'busy' が永遠に拾われない。merge する。
  // status も effectiveSource に合わせる。stale な store 由来 status は混ぜない。
  let status: SessionStatus = 'idle';
  if (effSource === 'claude' && det?.status === 'busy') status = 'busy';
  if (effSource === 'codex' && codexDet?.status === 'waiting-permission') status = 'waiting-permission';
  if (!storeIsStale && (session?.status === 'waiting-permission' || session?.status === 'waiting-question')) {
    status = session.status;
  }
  // Stop hook が直近で発火していれば「ターン終了済み」なので busy を抑止。
  if (status === 'busy' && !storeIsStale && session?.lastStopAt) {
    status = 'idle';
  }

  // G2 アプリは status フィールドを読まない(描画は chat 配列だけ)ので、
  // 状態を 1 行のメッセージとして合成 chat 末尾に注入。`synthetic: true` を立てて
  // 永続化用ではないことを示し、PC chat はこれをフィルタして dot インジケータと
  // 二重表示にしないようにする。アニメーションは Date.now ベースで dot 数を回す。
  if (status !== 'idle') {
    const dots = '.'.repeat((Math.floor(Date.now() / 500) % 3) + 1);
    const text =
      status === 'busy' ? `(thinking${dots})`
      : status === 'waiting-permission' ? `(awaiting permission${dots})`
      : `(awaiting question${dots})`;
    merged.push({ role: 'assistant', text, ts: Date.now(), synthetic: true });
  }
  // pending (PreToolUse / PermissionRequest 待ち) も同梱して、
  // chat UI で許可応答 / 質問回答の UI を出せるようにする。
  // codex health は effSource=codex のときのみ。claude セッションに codex 情報が漏れないように。
  const codexHookHealth = effSource === 'codex'
    ? (!storeIsStale && session?.cwd ? getCodexHookHealth(session.cwd) : codexDet?.hookHealth)
    : undefined;
  return c.json({
    chat: merged,
    status,
    // stale (別 agent の残骸) の pending は表示しない (store は書き換えない=表示抑止のみ)。
    pending: storeIsStale ? null : (session?.pending ?? null),
    source: effSource,
    codexHookHealth: codexHookHealth ?? null,
    codexNeedsHookAttention: (effSource === 'codex' && codexDet?.needsHookAttention) ?? false,
  });
});

claudeRouter.get('/claude/sessions/:tmuxName/pending', async (c) => {
  const tmuxName = c.req.param('tmuxName');
  await clearStaleCodexPermissionIfTmuxNoLongerAsking(tmuxName);
  const session = store.getSession(tmuxName);
  // chat エンドポイントと同じ stale 判定を掛ける。ここだけ素通しすると、chat 側が
  // 「別 agent の残骸なので出さない」と決めた用件が pending だけ降ってきて、
  // クライアントが存在しない用件の応答画面を開いてしまう。
  // detectLiveOwners は TTL キャッシュ + singleflight なので追加コストはほぼ無い。
  const liveOwners = await detectLiveOwners().catch(() => null);
  if (isStoreStale(session, liveOwners?.get(tmuxName))) return c.json({ pending: null });
  const pending = session?.pending;
  if (!pending) return c.json({ pending: null });
  return c.json({ pending });
});

// 応答処理の流れ (この順序に意味がある):
//   1. ボディ読み取り     … await を挟むので、この間に用件が入れ替わりうる
//   2. mutex 取得         … 同じ tmux への応答処理は同時に 1 本だけ (2 本目は 409)
//   3. 用件の有無         … 無ければ 404 (この時点で確定する必要は無い。5 で取り直す)
//   4. stale 判定         … store の用件が「今その pane を握っている agent」と別 agent の
//                           残骸なら、そもそも表示していない用件なので受理しない
//   5. 最新 pending 取得  … 取るのは必ず mutex の中、かつ 4 の await の後。外や前で取ると、
//                           待たされている間に入れ替わった用件を掴んだまま処理してしまう
//   6. pendingId 検証     … クライアントが明示した用件と一致するか
//   7. 回答セットの検証   … 副作用の前にまとめて (不正なら 400、キーは 1 つも撃たない)
//   8. キー注入           … 送信 1 つごとに 5 の id を再検証する
//   9. ID 条件付き clear  … 自分が答えた用件が今も現役の時だけ消す
//  10. mutex 解放         … finally で必ず
claudeRouter.post('/claude/sessions/:tmuxName/respond', async (c) => {
  const tmuxName = c.req.param('tmuxName');
  const body = (await c.req.json().catch(() => null)) as RespondInput | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  // tmux 単位の mutex。応答処理には tmux へのキー注入という時間の掛かる await が
  // 挟まるので、2 本目 (グラスの再タップ / 別クライアント / 入れ替わった別用件) が
  // 並走すると同じ TUI に 2 本ぶんのキーが混ざる。
  if (!store.acquireRespondLock(tmuxName)) {
    const cur = store.getPending(tmuxName);
    console.log(`[respond] already processing: tmux=${tmuxName}`);
    return c.json(
      { error: 'already processing a response for this session', code: 'already_processing', currentPendingId: cur?.id ?? null },
      409,
    );
  }
  try {
    if (!store.getPending(tmuxName)) return c.json({ error: 'no pending interaction' }, 404);
    // /chat と /pending が「別 agent の残骸なので出さない」と決めた用件には応答させない。
    // 表示していない用件へのキー注入は、今その pane を握っている別のエージェントの TUI に
    // 撃ち込むことになる。副作用は何も起こさずに突き返す (回答はクライアントに残る)。
    // detectLiveOwners は TTL キャッシュ + singleflight なので追加コストはほぼ無い。
    const liveOwners = await detectLiveOwners().catch(() => null);
    if (isStoreStale(store.getSession(tmuxName), liveOwners?.get(tmuxName))) {
      console.log(`[respond] stale pending (owner is another agent): tmux=${tmuxName}`);
      return c.json(
        { error: 'pending belongs to another agent that no longer owns this pane', code: 'stale_pending' },
        409,
      );
    }
    // 処理対象の pending は、await (owner 判定) を挟んだ後に取り直す。
    // 先に掴んだものを持ち回すと、その await の間の入れ替わりを取りこぼす。
    const pending = store.getPending(tmuxName);
    if (!pending) return c.json({ error: 'no pending interaction' }, 404);
    // クライアントが応答対象を明示している場合、現在の pending と食い違っていたら受理しない。
    // 画面を開いている間に用件が入れ替わると、古い画面で作った回答が別の用件に適用されるため。
    // pendingId を送ってこない旧クライアントは従来どおり受理する (後方互換)。
    if (body.pendingId && body.pendingId !== pending.id) {
      console.log(`[respond] pending mismatch: body=${body.pendingId} current=${pending.id}`);
      return c.json({ error: 'pending mismatch', code: 'pending_mismatch', currentPendingId: pending.id }, 409);
    }
    return await processRespond(c, tmuxName, pending, body);
  } finally {
    store.releaseRespondLock(tmuxName);
  }
});

/** 回答セットの検証結果 (問題があった時だけ返す)。 */
type AnswerValidationError = { code: string; error: string; index?: number };

/**
 * AskUserQuestion への回答セットを、キー注入 (= 取り返しのつかない副作用) の前に
 * まとめて検証する。1 つでも問題があれば「キーを 1 つも撃たずに」400 で突き返す。
 *
 * なぜ「まとめて」なのか: 検証と注入が混ざっていると、途中まで撃ってから不正に
 * 気付くことになり、TUI が中途半端に進んだ状態で残る。
 *
 * chat-about-this を含むセットを素通しするのはバグ修正でもある:
 * 注入側 (sendAnswersToTui) は最初の chat-about-this を見つけた時点で
 * 「Chat about this」を選んで AskUserQuestion 全体を reject するので、他の質問の
 * 回答は一切使われない。にもかかわらず他の質問を検証していたため、複数選択の質問が
 * 1 つでも混ざっていると (未選択のまま chat-about-this を選ぶのが自然な操作なのに)
 * empty_multi_select で 400 になり、Chat about this が恒久的に選べなくなっていた。
 */
function validateQuestionAnswers(
  answers: Array<{
    question?: string;
    option?: string;
    options?: string[];
    text?: string;
    notes?: string;
    answerKind?: 'predefined' | 'type-something' | 'chat-about-this';
  }>,
  questions: AskQuestion[],
): AnswerValidationError | null {
  // (a) chat-about-this が 1 件でもあれば、そこで全体が reject される。
  //     他の質問の回答は使われないので検証しない。
  if (answers.some((a) => a.answerKind === 'chat-about-this')) return null;

  // (b) それ以外は、質問 1 件ずつに対応する回答が揃っていることから確かめる。
  if (answers.length !== questions.length) {
    return {
      code: 'answers_length_mismatch',
      error: `expected ${questions.length} answers but got ${answers.length}`,
    };
  }
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i];
    const q = questions[i];
    const kind = a.answerKind ?? 'predefined';
    if (kind === 'type-something') {
      // 自由入力が空だと TUI では「何も打たずに Enter」になり、空の回答が確定してしまう。
      if (!(a.text ?? '').trim()) {
        return { code: 'empty_text', error: 'type-something answer has empty text', index: i };
      }
      continue;
    }
    const labels = new Set((q.options ?? []).map((o) => o.label));
    if (q.multiSelect) {
      const selected = a.options && a.options.length > 0 ? a.options : a.option ? [a.option] : [];
      // 0 件のまま Submit を撃つと「選択の無い回答」がそのまま確定する。
      if (selected.length === 0) {
        return { code: 'empty_multi_select', error: 'multi-select answer has no selected option', index: i };
      }
      const unknown = selected.find((label) => !labels.has(label));
      if (unknown !== undefined) {
        return { code: 'unknown_option', error: `option "${unknown}" is not one of the offered choices`, index: i };
      }
      continue;
    }
    // 単一選択: 定義済みの選択肢でなければ、注入側は「見つからないので skip」しかできず、
    // 回答したつもりで何も送られない状態になる。ここで弾いて答え直させる。
    const option = a.option ?? '';
    if (!labels.has(option)) {
      return { code: 'unknown_option', error: `option "${option}" is not one of the offered choices`, index: i };
    }
  }
  return null;
}

/** respond の本処理。mutex を握った状態でのみ呼ばれる。 */
async function processRespond(
  c: Context,
  tmuxName: string,
  pending: Pending,
  body: RespondInput,
): Promise<Response> {
  console.log(`[respond] tmux=${tmuxName} kind=${body.kind} hookEvent=${pending.hookEvent}`);

  // 検証はキー注入 (= 取り返しのつかない副作用) より前にまとめて済ませる。
  // ここで弾いた場合、tmux には一切触れていない (用件もそのまま残す = 答え直せる)。
  if (body.kind === 'question') {
    if (!Array.isArray(body.answers)) {
      return c.json({ error: 'answers must be an array', code: 'invalid_answers' }, 400);
    }
    // TUI へのキー注入は PreToolUse の「両側回答対応モード」だけ。PermissionRequest 経由の
    // 質問は文字列に畳んで hook へ返すので、選択肢の対応検証は前者にのみ意味がある。
    if (pending.hookEvent === 'PreToolUse') {
      const invalid = validateQuestionAnswers(body.answers, pending.questions ?? []);
      if (invalid) {
        console.log(`[respond] invalid answers: ${invalid.code} (${invalid.error})`);
        return c.json({ error: invalid.error, code: invalid.code, index: invalid.index }, 400);
      }
    }
  }

  let decision: HookDecision;
  if (pending.hookEvent === 'PreToolUse') {
    if (body.kind === 'permission') {
      decision = {
        event: 'PreToolUse',
        permissionDecision: body.decision,
        reason: body.message,
      };
    } else if (body.kind === 'question') {
      // 「両側回答対応モード」の AskUserQuestion: hook は既に即時 return 済みで
      // resolver が無いので、TUI にキー注入することで TUI 側の質問 UI に回答させる。
      // TUI が回答を処理 → tool_result が transcript に書かれる → watcher が pending clear。
      // クライアント側にはここで成功を返してすぐ pending を消したフリ(楽観表示)をする。
      try {
        await sendAnswersToTui(tmuxName, body.answers, pending.questions ?? [], pending.id);
      } catch (e) {
        if (e instanceof PendingChangedError) {
          if (!e.injected) {
            // まだ 1 つもキーを撃っていない = 副作用なし。クライアントは「用件が入れ替わった」
            // 時と同じ後始末 (回答を捨てて取り直す) をすればよい。
            return c.json(
              { error: 'pending changed before sending keys', code: 'pending_mismatch', currentPendingId: e.currentPendingId ?? null },
              409,
            );
          }
          // 途中まで撃った後に用件が入れ替わった。TUI には一部のキーが届いている可能性が
          // あり、「送っていない」とは言えない。回答を捨てて取り直させる pending_mismatch とは
          // 区別して返し、クライアントには「一部送信済みかもしれない」と出させる
          // (自動での送り直しはしない。二重に撃つと選択が壊れる)。
          console.log(`[respond] injection interrupted after partial keys: tmux=${tmuxName}`);
          return c.json(
            { error: 'pending changed while sending keys (partially sent)', code: 'injection_interrupted', currentPendingId: e.currentPendingId ?? null },
            409,
          );
        }
        console.log(`[respond] sendAnswersToTui failed: ${(e as Error).message}`);
        return c.json({ error: `failed to send keys to tmux: ${(e as Error).message}` }, 500);
      }
      // chat 履歴に「ユーザがこう回答した」記録を残す。
      // chat / G2 両方の履歴で答えた内容が見えるようにするため。
      // 整形文の言語は Web UI で選択中の言語 (body.lang) に合わせる。未指定なら en。
      const isJa = body.lang === 'ja';
      const totalAnswers = body.answers.length;
      const summaryLines = body.answers.map((a, i) => {
        const head = totalAnswers > 1 ? `Q${i + 1}. ` : '';
        const kind = a.answerKind ?? 'predefined';
        let line: string;
        if (kind === 'chat-about-this') {
          line = isJa
            ? '→ (Chat about this を選択 / 質問をキャンセル)'
            : '→ (Chat about this selected / question cancelled)';
        } else if (kind === 'type-something') {
          line = `→ (Type something) ${a.text ?? ''}`;
        } else {
          // predefined: multi-select は options 配列、single-select は option
          const note = a.notes?.trim();
          if (a.options && a.options.length > 0) {
            line = `→ ${a.options.join(', ')}`;
          } else {
            const noteText = note ? (isJa ? ` (補足: ${note})` : ` (note: ${note})`) : '';
            line = `→ ${a.option ?? ''}${noteText}`;
          }
        }
        return `${head}${a.question}\n${line}`.trim();
      });
      store.appendChat(tmuxName, 'user', summaryLines.join('\n\n'), { origin: 'ui' });
      // pending を即 clear(楽観的)、watcher も止める。
      // キー注入の間に用件が入れ替わっていることがあるので、消すのは自分が答えた
      // 用件が今も現役の時だけ (新しい用件を巻き込んで消さない)。
      store.clearPendingIfId(tmuxName, pending.id);
      // watcher も「自分が答えた用件を見ているもの」の時だけ止める。
      // なぜ: キー注入の間に次の用件の watcher へ差し替わっていることがあり、
      // 無条件に止めると新しい用件の TUI 回答が検出されず pending が残り続ける。
      const watcher = tuiWatchers.get(tmuxName);
      if (watcher && watcher.toolUseId === pending.toolUseId) watcher.cancel();
      return c.json({ ok: true });
    } else {
      return c.json({ error: 'invalid response kind' }, 400);
    }
  } else {
    if (body.kind === 'permission') {
      if (pending.source === 'codex') {
        try {
          const before = await captureOutput(tmuxName, 60);
          if (!isCodexPermissionPrompt(before)) {
            store.clearPendingIfId(tmuxName, pending.id);
            return c.json({ ok: true, stale: true });
          }
          if (body.decision === 'allow') {
            await sendKey(tmuxName, 'Enter');
          } else {
            await sendKey(tmuxName, 'Down');
            await wait(80);
            await sendKey(tmuxName, 'Enter');
          }
          await wait(350);
          const after = await captureOutput(tmuxName, 40);
          if (isCodexPermissionPrompt(after)) {
            // 用件は入れ替わっていない (tmux がまだ同じ承認を出している) ので
            // pending_mismatch とは別の code にする。クライアントは通常のエラー扱い。
            return c.json({ error: 'Codex still appears to be waiting for approval in tmux. Open tmux view and approve there.', code: 'codex_still_waiting' }, 409);
          }
          store.clearPendingIfId(tmuxName, pending.id);
          return c.json({ ok: true });
        } catch (e) {
          return c.json({ error: 'failed to send keys to tmux: ' + (e as Error).message }, 500);
        }
      }
      decision = {
        event: 'PermissionRequest',
        behavior: body.decision,
        message: body.message,
      };
    } else if (body.kind === 'question') {
      const summary = body.answers
        .map((a) => {
          const base = `${a.question}: ${a.option}`;
          const note = a.notes?.trim();
          return note ? `${base} [${note}]` : base;
        })
        .join(' / ');
      decision = {
        event: 'PermissionRequest',
        behavior: 'deny',
        message: `User answered: ${summary}`,
      };
    } else {
      return c.json({ error: 'invalid response kind' }, 400);
    }
  }

  const ok = store.resolvePending(pending.id, decision);
  // 用件の入れ替わりではなく「その用件の待ち受けが既に終わっている」ので別 code。
  if (!ok) return c.json({ error: 'pending not awaitable (already resolved or timed out)', code: 'not_awaitable' }, 409);
  return c.json({ ok: true });
}
