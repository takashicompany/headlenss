import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { resolveTmuxSessionName } from '../claude/tmux-resolver.ts';
import * as store from '../claude/store.ts';
import { extractLastCodexAssistantText } from './transcript.ts';
import { matchUiSubmission } from '../uiSubmissions.ts';

const exec = promisify(execFile);

export const codexRouter = new Hono();

/**
 * pane の前面が claude の間に届いた Codex フックは、Claude Code が spawn した
 * Codex サブプロセス (調査依頼など) のもの。ユーザーの会話ではないので、
 * その pane の chat / status / pending を一切書き換えない。
 *
 * claude/router.ts の isCodexForegroundInPane と対になる判定。前面が claude と
 * 確認できた時だけ弾く (前面が shell やラッパー名で取れない場合は従来通り通す)。
 */
async function isSpawnedByClaudeInPane(tmuxNameOrPane: string): Promise<boolean> {
  if (!tmuxNameOrPane) return false;
  try {
    const { stdout } = await exec('tmux', [
      'display-message',
      '-p',
      '-t', tmuxNameOrPane,
      '#{pane_current_command}',
    ]);
    return /\bclaude\b/i.test(stdout);
  } catch {
    return false;
  }
}


type CodexHookPayload = {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  permission_mode?: string;
  source?: string;
};

async function getTmuxName(c: Context): Promise<string> {
  const pane = c.req.header('X-Tmux-Pane') ?? '';
  return resolveTmuxSessionName(pane);
}

/**
 * フック送信元の tmux セッション名を返す。取り込むべきでない (Claude Code が
 * spawn した Codex の) フックなら空文字を返し、呼び出し側は何もせず返す。
 */
async function getOwnedTmuxName(c: Context): Promise<string> {
  const tmuxName = await getTmuxName(c);
  if (!tmuxName) return '';
  const pane = c.req.header('X-Tmux-Pane') ?? '';
  if (await isSpawnedByClaudeInPane(pane || tmuxName)) {
    console.log('[codex-hook] ignored (claude owns pane) tmux=' + tmuxName);
    return '';
  }
  return tmuxName;
}

function upsertCodexSession(tmuxName: string, c: Context, body: CodexHookPayload): void {
  store.upsertSession({
    ccSessionId: body.session_id ?? '',
    tmuxPane: c.req.header('X-Tmux-Pane') ?? '',
    tmuxSessionName: tmuxName,
    cwd: body.cwd ?? '',
    source: 'codex',
    transcriptPath: body.transcript_path ?? undefined,
  });
}

function emptyHookResponse(c: Context): Response {
  return c.json({});
}

codexRouter.post('/hooks/codex/session-start', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CodexHookPayload;
  const tmuxName = await getOwnedTmuxName(c);
  console.log('[codex-hook] session-start tmux=' + tmuxName + ' src=' + (body.source ?? ''));
  if (!tmuxName) return emptyHookResponse(c);
  upsertCodexSession(tmuxName, c, body);
  store.setStatus(tmuxName, 'idle');
  return emptyHookResponse(c);
});

codexRouter.post('/hooks/codex/user-prompt-submit', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CodexHookPayload;
  const tmuxName = await getOwnedTmuxName(c);
  if (!tmuxName) return emptyHookResponse(c);
  // Always upsert (not lazy-create) so that source flips to 'codex'
  // when the user switches from Claude to Codex in the same pane.
  upsertCodexSession(tmuxName, c, body);
  store.clearStopped(tmuxName);
  const text = (body.prompt ?? '').trim();
  console.log('[codex-hook] user-prompt tmux=' + tmuxName + ' len=' + text.length);
  if (text) {
    const origin = matchUiSubmission(tmuxName, text) ? 'ui' as const : 'external' as const;
    store.appendChat(tmuxName, 'user', text, { origin });
  }
  store.setStatus(tmuxName, 'busy');
  return emptyHookResponse(c);
});

codexRouter.post('/hooks/codex/stop', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CodexHookPayload;
  const tmuxName = await getOwnedTmuxName(c);
  console.log('[codex-hook] stop tmux=' + tmuxName + ' transcript=' + (body.transcript_path ?? '').slice(-40));
  if (!tmuxName) return emptyHookResponse(c);
  upsertCodexSession(tmuxName, c, body);
  // 「このフックが始まった時点で待っていた用件」を控える。以降 transcript 読みで
  // await を挟むので、その間に新しい用件が立っていることがある。無条件に消すと、
  // 後から出てきた用件を「終わった古い用件のつもり」で消してしまう。
  const pendingIdAtEntry = store.getPending(tmuxName)?.id;
  const transcriptPath = body.transcript_path ?? '';
  if (transcriptPath) {
    const text = await extractLastCodexAssistantText(transcriptPath);
    if (text) store.appendChat(tmuxName, 'assistant', text, { agent: 'codex' });
  }
  store.markStopped(tmuxName);
  if (pendingIdAtEntry) store.clearPendingIfId(tmuxName, pendingIdAtEntry);
  // status も同じ理屈で、新しい用件が立っていたらその waiting-* を潰さない。
  if (!store.getPending(tmuxName)) store.setStatus(tmuxName, 'idle');
  return emptyHookResponse(c);
});

codexRouter.post('/hooks/codex/post-tool-use', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CodexHookPayload;
  // pending の控えは tmux 名が分かった直後 (= このハンドラで最初に用件を観測できる
  // 時点) に取る。getOwnedTmuxName / upsert より後の処理で用件が入れ替わっても、
  // 消すのは「自分が始まった時に待っていた用件」だけにする。
  const tmuxName = await getOwnedTmuxName(c);
  if (!tmuxName) return emptyHookResponse(c);
  const pendingIdAtEntry = store.getPending(tmuxName)?.id;
  upsertCodexSession(tmuxName, c, body);
  if (pendingIdAtEntry) store.clearPendingIfId(tmuxName, pendingIdAtEntry);
  return emptyHookResponse(c);
});

codexRouter.post('/hooks/codex/pre-tool-use', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CodexHookPayload;
  const tmuxName = await getOwnedTmuxName(c);
  if (tmuxName) upsertCodexSession(tmuxName, c, body);
  // Codex PreToolUse is a policy hook. headlenss only needs approvals/questions,
  // so allow Codex to continue to its normal PermissionRequest flow.
  return emptyHookResponse(c);
});

codexRouter.post('/hooks/codex/permission-request', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CodexHookPayload;
  const tmuxName = await getOwnedTmuxName(c);
  const toolName = body.tool_name ?? '';
  console.log('[codex-hook] permission-request tmux=' + tmuxName + ' tool=' + toolName);
  if (!tmuxName) return emptyHookResponse(c);
  upsertCodexSession(tmuxName, c, body);

  store.createPending(tmuxName, {
    kind: 'permission',
    hookEvent: 'PermissionRequest',
    source: 'codex',
    toolName,
    toolInput: body.tool_input ?? {},
  });

  // Return immediately so Codex can show its native approval UI in tmux.
  // HeadLenss keeps a pending marker for chat/G2, and chat responses inject
  // keys into the tmux UI instead of resolving this hook long-poll.
  return emptyHookResponse(c);
});
