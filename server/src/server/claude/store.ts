import { randomUUID } from 'node:crypto';
import type {
  ChatItem,
  ChatRole,
  ClaudeSession,
  HookDecision,
  Pending,
  SessionStatus,
} from './types.ts';
import { clearUiSubmissions } from '../uiSubmissions.ts';

const sessions = new Map<string, ClaudeSession>();
const pendingResolvers = new Map<string, (decision: HookDecision) => void>();

export function listSessions(): ClaudeSession[] {
  return Array.from(sessions.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function getSession(tmuxName: string): ClaudeSession | undefined {
  return sessions.get(tmuxName);
}

export function upsertSession(input: {
  ccSessionId: string;
  tmuxPane: string;
  tmuxSessionName: string;
  cwd: string;
  source?: 'claude' | 'codex';
  transcriptPath?: string;
}): ClaudeSession {
  const existing = sessions.get(input.tmuxSessionName);
  const now = Date.now();
  if (existing) {
    // 主 (agent) が別物に変わった = 別ランが同じ tmux 名を使い始めた。前の agent の
    // 会話 / 承認待ち / transcript を引き継ぐと混線・誤送信の元になるのでクリアする
    // (出所の不変性: chat/pending は常に現在の source のものだけになる)。
    const sourceChanged = !!input.source && !!existing.source && input.source !== existing.source;
    existing.ccSessionId = input.ccSessionId;
    existing.tmuxPane = input.tmuxPane;
    existing.cwd = input.cwd;
    if (input.source) existing.source = input.source;
    if (sourceChanged) {
      existing.chat = [];
      existing.transcriptPath = input.transcriptPath;
      existing.lastStopAt = undefined;
      existing.startedAt = now;
      if (existing.pending) {
        const resolver = pendingResolvers.get(existing.pending.id);
        if (resolver) {
          resolver({ event: 'PreToolUse', permissionDecision: 'deny', reason: 'agent-changed' });
          pendingResolvers.delete(existing.pending.id);
        }
        existing.pending = undefined;
      }
      existing.status = 'idle';
      clearUiSubmissions(input.tmuxSessionName);
    } else if (input.transcriptPath) {
      existing.transcriptPath = input.transcriptPath;
    }
    existing.lastSeenAt = now;
    return existing;
  }
  const fresh: ClaudeSession = {
    ccSessionId: input.ccSessionId,
    tmuxPane: input.tmuxPane,
    tmuxSessionName: input.tmuxSessionName,
    cwd: input.cwd,
    source: input.source,
    transcriptPath: input.transcriptPath,
    status: 'idle',
    startedAt: now,
    lastSeenAt: now,
    chat: [],
  };
  sessions.set(input.tmuxSessionName, fresh);
  return fresh;
}

export function removeSession(tmuxName: string): void {
  const s = sessions.get(tmuxName);
  if (s?.pending) {
    // Wake any long-poll waiter so it doesn't hang forever
    const resolver = pendingResolvers.get(s.pending.id);
    if (resolver) {
      resolver({ event: 'PreToolUse', permissionDecision: 'deny', reason: 'session-ended' });
      pendingResolvers.delete(s.pending.id);
    }
  }
  sessions.delete(tmuxName);
  clearUiSubmissions(tmuxName);
}

export function appendChat(
  tmuxName: string,
  role: ChatRole,
  text: string,
  opts?: { origin?: 'ui' | 'external'; agent?: 'claude' | 'codex' },
): void {
  const s = sessions.get(tmuxName);
  if (!s) return;
  if (!text.trim()) return;
  const item: ChatItem = { role, text, ts: Date.now() };
  if (opts?.origin) item.origin = opts.origin;
  if (opts?.agent) item.agent = opts.agent;
  s.chat.push(item);
  s.lastSeenAt = Date.now();
  // Cap chat history to last 200 items to keep memory bounded
  if (s.chat.length > 200) s.chat.splice(0, s.chat.length - 200);
}

export function getChat(tmuxName: string): ChatItem[] {
  return sessions.get(tmuxName)?.chat ?? [];
}

export function setStatus(tmuxName: string, status: SessionStatus): void {
  const s = sessions.get(tmuxName);
  if (!s) return;
  s.status = status;
  s.lastSeenAt = Date.now();
}

/** Stop hook 用: 「ターンが終わった」マーカーを立てる */
export function markStopped(tmuxName: string): void {
  const s = sessions.get(tmuxName);
  if (!s) return;
  s.lastStopAt = Date.now();
  s.lastSeenAt = Date.now();
}

/** user-prompt-submit hook 用: 新しいターンが始まるので Stop マーカーをクリア */
export function clearStopped(tmuxName: string): void {
  const s = sessions.get(tmuxName);
  if (!s) return;
  s.lastStopAt = undefined;
  s.lastSeenAt = Date.now();
}

export function createPending(
  tmuxName: string,
  partial: Omit<Pending, 'id' | 'createdAt'>,
): Pending {
  const s = sessions.get(tmuxName);
  if (!s) throw new Error(`session not found: ${tmuxName}`);
  const pending: Pending = {
    ...partial,
    id: randomUUID(),
    createdAt: Date.now(),
  };
  s.pending = pending;
  s.status = partial.kind === 'question' ? 'waiting-question' : 'waiting-permission';
  s.lastSeenAt = Date.now();
  return pending;
}

export function getPending(tmuxName: string): Pending | undefined {
  return sessions.get(tmuxName)?.pending;
}

export function clearPending(tmuxName: string): void {
  const s = sessions.get(tmuxName);
  if (!s) return;
  s.pending = undefined;
  s.status = 'idle';
  s.lastSeenAt = Date.now();
}

/**
 * Register a long-poll resolver that will be called when G2 responds (or session ends).
 * Returns a Promise that resolves to the hook decision.
 */
export function awaitPendingResolution(
  pendingId: string,
  timeoutMs: number,
): Promise<HookDecision> {
  return new Promise<HookDecision>((resolve) => {
    let settled = false;
    const onResolve = (decision: HookDecision) => {
      if (settled) return;
      settled = true;
      pendingResolvers.delete(pendingId);
      clearTimeout(timer);
      resolve(decision);
    };
    pendingResolvers.set(pendingId, onResolve);
    const timer = setTimeout(() => {
      onResolve({ event: 'PreToolUse', permissionDecision: 'ask', reason: 'timeout' });
    }, timeoutMs);
  });
}

export function resolvePending(pendingId: string, decision: HookDecision): boolean {
  const r = pendingResolvers.get(pendingId);
  if (!r) return false;
  r(decision);
  return true;
}
