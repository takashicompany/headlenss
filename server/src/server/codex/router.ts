import { Hono } from 'hono';
import type { Context } from 'hono';
import { resolveTmuxSessionName } from '../claude/tmux-resolver.ts';
import * as store from '../claude/store.ts';
import { extractLastCodexAssistantText } from './transcript.ts';

export const codexRouter = new Hono();


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
  const tmuxName = await getTmuxName(c);
  console.log('[codex-hook] session-start tmux=' + tmuxName + ' src=' + (body.source ?? ''));
  if (!tmuxName) return emptyHookResponse(c);
  upsertCodexSession(tmuxName, c, body);
  store.setStatus(tmuxName, 'idle');
  return emptyHookResponse(c);
});

codexRouter.post('/hooks/codex/user-prompt-submit', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CodexHookPayload;
  const tmuxName = await getTmuxName(c);
  if (!tmuxName) return emptyHookResponse(c);
  if (!store.getSession(tmuxName)) upsertCodexSession(tmuxName, c, body);
  store.clearStopped(tmuxName);
  const text = (body.prompt ?? '').trim();
  console.log('[codex-hook] user-prompt tmux=' + tmuxName + ' len=' + text.length);
  if (text) store.appendChat(tmuxName, 'user', text);
  store.setStatus(tmuxName, 'busy');
  return emptyHookResponse(c);
});

codexRouter.post('/hooks/codex/stop', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CodexHookPayload;
  const tmuxName = await getTmuxName(c);
  console.log('[codex-hook] stop tmux=' + tmuxName + ' transcript=' + (body.transcript_path ?? '').slice(-40));
  if (!tmuxName) return emptyHookResponse(c);
  if (!store.getSession(tmuxName)) upsertCodexSession(tmuxName, c, body);
  const transcriptPath = body.transcript_path ?? '';
  if (transcriptPath) {
    const text = await extractLastCodexAssistantText(transcriptPath);
    if (text) store.appendChat(tmuxName, 'assistant', text);
  }
  store.markStopped(tmuxName);
  store.clearPending(tmuxName);
  store.setStatus(tmuxName, 'idle');
  return emptyHookResponse(c);
});

codexRouter.post('/hooks/codex/post-tool-use', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CodexHookPayload;
  const tmuxName = await getTmuxName(c);
  if (!tmuxName) return emptyHookResponse(c);
  if (!store.getSession(tmuxName)) upsertCodexSession(tmuxName, c, body);
  store.clearPending(tmuxName);
  return emptyHookResponse(c);
});

codexRouter.post('/hooks/codex/pre-tool-use', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CodexHookPayload;
  const tmuxName = await getTmuxName(c);
  if (tmuxName && !store.getSession(tmuxName)) upsertCodexSession(tmuxName, c, body);
  // Codex PreToolUse is a policy hook. headlenss only needs approvals/questions,
  // so allow Codex to continue to its normal PermissionRequest flow.
  return emptyHookResponse(c);
});

codexRouter.post('/hooks/codex/permission-request', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CodexHookPayload;
  const tmuxName = await getTmuxName(c);
  const toolName = body.tool_name ?? '';
  console.log('[codex-hook] permission-request tmux=' + tmuxName + ' tool=' + toolName);
  if (!tmuxName) return emptyHookResponse(c);
  if (!store.getSession(tmuxName)) upsertCodexSession(tmuxName, c, body);

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
