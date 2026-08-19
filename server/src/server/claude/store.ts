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
    existing.ccSessionId = input.ccSessionId;
    existing.tmuxPane = input.tmuxPane;
    existing.cwd = input.cwd;
    if (input.source) existing.source = input.source;
    if (input.transcriptPath) existing.transcriptPath = input.transcriptPath;
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
 * id が一致する時だけ pending を消す。
 * 応答処理には await (tmux へのキー注入等) が挟まるので、その間に用件が別物へ
 * 入れ替わっていることがある。無条件に clearPending すると、後から出てきた
 * 新しい用件を「答え終わった古い用件のつもり」で消してしまう。
 * @returns 実際に消したら true
 */
export function clearPendingIfId(tmuxName: string, pendingId: string): boolean {
  const s = sessions.get(tmuxName);
  if (!s || s.pending?.id !== pendingId) return false;
  clearPending(tmuxName);
  return true;
}

// 応答処理中の tmux セッション名。
//
// なぜ「用件 (pending id) 単位」ではなく「tmux セッション単位」か:
// 応答処理が実際に触る資源は用件ではなく「その tmux の TUI」で、キー注入は
// 前後関係のある一連の操作 (Down x N → Enter → …) になっている。用件単位で
// 排他すると、注入の途中で用件が入れ替わった直後に別 id の応答が並走でき、
// 2 本ぶんの矢印と Enter が同じ TUI に混ざって選択が壊れる。同じ tmux への
// 応答処理は常に 1 本だけ通す。
// 値は取得時刻 (epoch ms)。時刻を持つのは下の「取り残されたロックの回収」のため。
const respondingTmuxNames = new Map<string, number>();

/**
 * ロックを握ったまま決着しない処理を諦める時間。
 *
 * なぜ必要か: 応答処理は tmux への execFile を挟む。execFile 側にも timeout を
 * 付けてあるが、それでも何かの拍子に finally まで戻らなければロックが残り、その
 * tmux への応答も chat 送信も以後ずっと 409 になる (画面から回復できない)。
 * 次に誰かがロックを取りに来た時、これを超えて握られているロックは強制的に
 * 解放してログに残す (定期タイマーは持たない = 誰も使っていない間は何もしない)。
 */
const RESPOND_LOCK_MAX_HOLD_MS = 60_000;

/** 応答処理の開始を宣言する (原子的な try-lock)。既にその tmux を処理中なら false。 */
export function acquireRespondLock(tmuxName: string): boolean {
  const heldSince = respondingTmuxNames.get(tmuxName);
  if (heldSince !== undefined) {
    const heldMs = Date.now() - heldSince;
    if (heldMs < RESPOND_LOCK_MAX_HOLD_MS) return false;
    // 取り残されたロック: 持ち主はもう戻ってこないものとして回収する。
    console.warn(`[respond] reaped stale lock tmux=${tmuxName} heldMs=${heldMs}`);
  }
  respondingTmuxNames.set(tmuxName, Date.now());
  return true;
}

/** acquireRespondLock の解放。応答処理の finally で必ず呼ぶ。 */
export function releaseRespondLock(tmuxName: string): void {
  respondingTmuxNames.delete(tmuxName);
}

/** テスト/診断用: その tmux が応答処理中か。 */
export function isRespondLocked(tmuxName: string): boolean {
  return respondingTmuxNames.has(tmuxName);
}

/** テスト用: ロックの取得時刻を巻き戻す (取り残されたロックの回収を再現する)。 */
export function backdateRespondLockForTest(tmuxName: string, ageMs: number): void {
  if (!respondingTmuxNames.has(tmuxName)) return;
  respondingTmuxNames.set(tmuxName, Date.now() - ageMs);
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
