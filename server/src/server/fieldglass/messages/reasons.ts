import type { MiddlewareHandler } from 'hono';

/** Public, additive localization keys. Clients translate these codes and retain
 * the accompanying English text as a fallback; never parse English for meaning. */
export type MessagesReasonCode =
  | 'group_read_only' | 'unsupported_service' | 'not_permitted' | 'send_failed'
  | 'ambiguous_target' | 'read_denied' | 'automation_denied' | 'target_unavailable'
  | 'delivery_unknown' | 'sent' | 'ready' | 'permission_unknown'
  | 'invalid_request' | 'not_found' | 'draft_conflict' | 'request_too_large'
  | 'unavailable' | 'not_mac' | 'stopping' | 'history_full'
  | 'restart_unavailable' | 'restart_requested';
export type MessagesReason = { reasonCode: MessagesReasonCode; reason: string };
export type Reply = { ok: true; state: 'sent' | 'unknown' } & MessagesReason;

export function replyState(state: Reply['state']): Reply {
  return state === 'sent'
    ? { ok: true, state, reasonCode: 'sent', reason: 'Messages accepted the reply.' }
    : { ok: true, state, reasonCode: 'delivery_unknown', reason: 'Delivery unknown — check Messages on your Mac before composing another reply.' };
}

export function errorReasonCode(status: number): MessagesReasonCode {
  switch (status) {
    case 400: return 'invalid_request';
    case 403: return 'not_permitted';
    case 404: return 'not_found';
    case 409: return 'send_failed';
    case 413: return 'request_too_large';
    case 429: return 'history_full';
    default: return 'unavailable';
  }
}

/** Covers errors emitted outside the child router too, notably the parent's
 * body limit and Hono's default 404. Register before those middleware layers,
 * only for the Messages paths. Existing English error text is preserved. */
export const messagesReasonCodes: MiddlewareHandler = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
  if (c.res.status < 400) return;
  const text = await c.res.clone().text();
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : { error: text };
  } catch { body = { error: text }; }
  if (typeof body.reasonCode === 'string') return;
  const headers = new Headers(c.res.headers);
  headers.delete('Content-Length');
  headers.set('Content-Type', 'application/json; charset=UTF-8');
  c.res = new Response(JSON.stringify({ ...body, reasonCode: errorReasonCode(c.res.status) }), { status: c.res.status, headers });
};
