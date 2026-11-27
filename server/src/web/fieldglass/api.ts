import { claudeSendTargets } from './helpers.ts';
import { ApiError } from './errors.ts';

export { ApiError };
// Fieldglass web companion: API client for /api/fieldglass (SPEC.md "Server API").
// Types mirror the shared contract exactly. Pure helpers live in ./helpers.ts.

export type TodayEvent = {
  id: string; start: string; end: string; title: string; objective?: string;
  /** Amendment 1: events added by hand. Not in the written contract; we also accept an id prefixed "manual". */
  manual?: boolean; source?: string;
};
export type ManualEventInput = { start: string; end: string; title: string; objective?: string };
export type SetupHelp = { connector: string; steps: string[] };
export type TodayResponse = {
  updatedAt: number | null;
  source: 'calendar' | 'manual' | 'none';
  refreshing: boolean;
  events: TodayEvent[];
  setup?: SetupHelp;
  /** Amendment 1: why the last calendar job failed, if it did. */
  lastError?: string;
  lastSource?: 'google' | 'notion' | 'manual' | 'none';
};

export function isManualEvent(e: TodayEvent): boolean {
  return e.manual === true || e.source === 'manual' || /^manual[-_:]/.test(e.id);
}
export type Followup = {
  id: string;
  quote: string;
  owner?: string;
  due?: string;
  eventId?: string;
  meetingTitle?: string;
  createdAt: number;
  expiresAt: number;
  sentTo?: string;
  sentAt?: number;
};
export type Connection = {
  id: string;
  name: string;
  status: 'connected' | 'needs_auth' | 'not_configured';
  usedFor: string;
  steps: string[];
};
export type ConnectionsResponse = { updatedAt: number | null; connections: Connection[] };

// Amendment 2: iMessage (read on the Mac; the web companion never sends).
export type MessagesStatus = { canRead: boolean; canSend: 'yes' | 'unknown' | 'denied'; nodePath: string; steps: string[] };
export type MessageThread = {
  id: string; name: string; isGroup: boolean; service: string;
  lastText: string; lastAt: number | string; unread: number | boolean;
  /** codex's server adds these: group threads are read-only on the glasses in v1. */
  canReply?: boolean; readOnlyReason?: string;
};
export type ThreadMessage = { id: string; fromMe: boolean; sender: string; text: string; at: number | string };

const BASE = '/api/fieldglass';

function isJson(res: Response): boolean {
  return /\bjson\b/i.test(res.headers.get('Content-Type') ?? '');
}
function isHtml(res: Response): boolean {
  return /text\/html/i.test(res.headers.get('Content-Type') ?? '');
}
const notAvailable = () => new ApiError(404, 'not available', true);

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } : init?.headers,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch { /* body is not JSON */ }
    throw new ApiError(res.status, msg, res.status === 404);
  }
  // The existing SPA fallback answers unknown GET /api/* with index.html (200). Treat that as "not available".
  if (!isJson(res)) throw notAvailable();
  try {
    return (await res.json()) as T;
  } catch {
    throw notAvailable();
  }
}

export const fieldglassApi = {
  today: () => call<TodayResponse>('/today'),
  refreshToday: () => call<{ refreshing: boolean }>('/today/refresh', { method: 'POST' }),
  setObjective: (eventId: string, objective: string) =>
    call<{ ok: true }>('/objective', { method: 'PUT', body: JSON.stringify({ eventId, objective }) }),

  addManualEvent: (e: ManualEventInput) =>
    call<unknown>('/today/manual', { method: 'POST', body: JSON.stringify(e) }),
  deleteManualEvent: (id: string) =>
    call<{ ok: true }>(`/today/manual/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  followups: () => call<{ followups: Followup[] }>('/followups'),
  createFollowup: (f: { quote: string; owner?: string; due?: string; eventId?: string; meetingTitle?: string }) =>
    call<Followup>('/followups', { method: 'POST', body: JSON.stringify(f) }),
  patchFollowup: (id: string, patch: { quote?: string; owner?: string; due?: string }) =>
    call<Followup>(`/followups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteFollowup: (id: string) => call<{ ok: true }>(`/followups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sendFollowup: (id: string, session: string) =>
    call<{ ok: true }>(`/followups/${encodeURIComponent(id)}/send`, { method: 'POST', body: JSON.stringify({ session }) }),

  // `refresh=1` is a hint only; the contract's GET returns the cache either way.
  connections: (refresh = false) => call<ConnectionsResponse>(`/connections${refresh ? '?refresh=1' : ''}`),

  fieldtestCsv: async (): Promise<string> => {
    const res = await fetch(`${BASE}/fieldtest.csv`);
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`, res.status === 404);
    if (isHtml(res)) throw notAvailable();
    return res.text();
  },
  fieldtestCsvUrl: `${BASE}/fieldtest.csv`,

  messagesStatus: () => call<MessagesStatus>('/messages/status'),
  messageThreads: () => call<{ threads: MessageThread[] }>('/messages/threads'),
  messageThread: (id: string) =>
    call<{ thread: MessageThread; messages: ThreadMessage[] }>(`/messages/threads/${encodeURIComponent(id)}`),
  // Restarts only HeadLenss's own LaunchAgent. The server answers before it goes down.
  restartServer: () => call<unknown>('/messages/restart', { method: 'POST' }),

  deleteAll: () => call<{ ok: true }>('/data', { method: 'DELETE' }),
};

/** Sessions a follow-up can be sent to. Uses the same source the server's send route checks
 *  (`/api/claude/sessions`, `source === 'claude'`), so the picker never offers a session the server will refuse. */
export async function listSendTargets(): Promise<string[]> {
  const res = await fetch('/api/claude/sessions');
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`, res.status === 404);
  if (!isJson(res)) throw notAvailable();
  const data = (await res.json()) as { sessions?: { tmuxSessionName?: string; source?: string }[] };
  return claudeSendTargets(data.sessions ?? []);
}

/** Cheap liveness probe used while the server restarts. */
export async function serverAlive(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}
