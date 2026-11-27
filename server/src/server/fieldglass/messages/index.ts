import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { object, string, FieldglassError } from '../validation.ts';
import { runMessagesCommand, SEND_SCRIPT, type MessagesCommand, type MessagesRunner } from './commands.ts';
import { appleTime, contactNames, contactsSql, decodeBody, discoverContacts, handleKey,
  messagesSql, parseRows, threadId, threadsSql, threadView, type Row } from './database.ts';
import { DraftLog, SEND_RETENTION_MS } from './drafts.ts';
import { errorReasonCode, messagesReasonCodes, replyState, type MessagesReason, type MessagesReasonCode, type Reply } from './reasons.ts';

export type MessagesOptions = {
  runner?: MessagesRunner; home?: string; dir?: string; now?: () => number; nodePath?: string;
  uid?: number; platform?: string; contactDatabases?: () => Promise<string[]>;
  scheduleRestart?: (run: () => void) => () => void; sendTimeoutMs?: number;
};
class MessagesError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 | 429 | 503, public reasonCode: MessagesReasonCode) { super(message); }
}
type Draft = { thread: string; fingerprint: string; time: number; result: Promise<Reply> };
const READ_HELP = 'Cannot read Messages. Enable Full Disk Access for the node path shown in setup, then Restart HeadLenss. Check that Messages is signed in on this Mac.';
const AUTOMATION_HELP = 'Messages Automation permission was denied. Open System Settings → Privacy & Security → Automation and enable Messages. Check Messages before creating another draft.';

export function createMessagesModule(options: MessagesOptions = {}) {
  const runner = options.runner ?? runMessagesCommand;
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const nodePath = options.nodePath ?? process.execPath;
  const uid = options.uid ?? process.getuid?.();
  const platform = options.platform ?? process.platform;
  const chatDb = join(home, 'Library', 'Messages', 'chat.db');
  const listContacts = options.contactDatabases ?? (() => discoverContacts(home));
  const log = new DraftLog(join(options.dir ?? process.env.HEADLENSS_FIELDGLASS_DIR ?? join(home, '.headlenss', 'fieldglass'), 'messages-sends'));
  const active = new Set<AbortController>();
  // In-flight requests and exact-content checks are memory-only. The 24h log
  // reserves draft IDs before dispatch and survives an application restart.
  const drafts = new Map<string, Draft>();
  let canSend: 'yes' | 'unknown' | 'denied' = 'unknown';
  let stopped = false;
  let clearing = false;
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  let cancelRestart: (() => void) | undefined;
  const router = new Hono();
  router.use('*', messagesReasonCodes);
  router.use('*', bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: 'Message request is too large', reasonCode: 'request_too_large' }, 413) }));
  router.onError((error, c) => {
    if (error instanceof MessagesError) return c.json({ error: error.message, reasonCode: error.reasonCode }, error.status);
    if (error instanceof FieldglassError) return c.json({ error: error.message, reasonCode: errorReasonCode(error.status) }, error.status);
    if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON', reasonCode: 'invalid_request' }, 400);
    return c.json({ error: 'Messages could not complete this request', reasonCode: 'unavailable' }, 503);
  });
  function available() {
    if (stopped || clearing) throw new MessagesError('Messages is stopping or clearing data. Check Messages before retrying any reply.', 503, 'stopping');
    if (platform !== 'darwin') throw new MessagesError('Messages requires the HeadLenss server on your Mac.', 409, 'not_mac');
  }
  function maintainLog() {
    if (retentionTimer || stopped) return;
    const prune = () => {
      for (const [key, draft] of drafts) if (draft.time <= now() - SEND_RETENTION_MS) drafts.delete(key);
      void log.prune(now()).catch(() => {});
    };
    prune();
    retentionTimer = setInterval(prune, 60_000);
    retentionTimer.unref();
  }
  async function execute(file: MessagesCommand, args: string[], timeoutMs = 5000, maxBuffer = 8 * 1024 * 1024) {
    available();
    const controller = new AbortController();
    active.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new MessagesError('Messages command did not complete', 503, 'unavailable')), { once: true });
    });
    try { return await Promise.race([runner(file, args, { signal: controller.signal, maxBuffer }), cancelled]); }
    finally { clearTimeout(timeout); active.delete(controller); }
  }
  async function sqlite(path: string, sql: string): Promise<Row[]> {
    available();
    try {
      const result = await execute('/usr/bin/sqlite3', ['-readonly', '-json', '-batch', '-bail', '-init', '/dev/null',
        '-cmd', 'PRAGMA query_only=ON;', '-cmd', '.timeout 1500', '--', path, sql]);
      return parseRows(result.stdout);
    } catch { throw new MessagesError(READ_HELP, 403, 'read_denied'); }
  }
  async function names() {
    const rows: Row[] = [];
    try {
      // Best effort and bounded; no persistent contact cache. A denied or older
      // source schema does not stop message reads from working.
      const sources = (await listContacts()).slice(0, 16);
      await Promise.all(sources.map(async (path) => { try { rows.push(...await sqlite(path, contactsSql)); } catch {} }));
    } catch {}
    return contactNames(rows);
  }
  function validId(value: string) {
    try { return threadId(value); } catch { throw new MessagesError('Invalid thread ID', 400, 'invalid_request'); }
  }
  async function target(id: string) {
    const rows = await sqlite(chatDb, threadsSql(now(), id));
    if (!rows.length) throw new MessagesError('Message thread not found', 404, 'not_found');
    return rows[0];
  }
  router.get('/status', async (c) => {
    let canRead = false;
    let readFailure: MessagesReason | undefined;
    try {
      const rows = await sqlite(chatDb, '/* fieldglass:probe */ SELECT count(*) AS ok FROM (SELECT ROWID FROM message LIMIT 1);');
      canRead = rows.length === 1 && typeof rows[0].ok === 'number';
      if (!canRead) readFailure = { reasonCode: 'unavailable', reason: READ_HELP };
    } catch (error) {
      readFailure = error instanceof MessagesError ? { reasonCode: error.reasonCode, reason: error.message }
        : { reasonCode: 'unavailable', reason: READ_HELP };
    }
    // Read access takes precedence; clients still receive both permission flags.
    const statusReason: MessagesReason = readFailure ?? (canSend === 'denied' ? { reasonCode: 'automation_denied', reason: AUTOMATION_HELP }
      : canSend === 'yes' ? { reasonCode: 'ready', reason: 'Messages is ready.' }
        : { reasonCode: 'permission_unknown', reason: 'Messages send permission has not been confirmed yet.' });
    return c.json({ canRead, canSend, nodePath, ...statusReason, steps: [
      `1. On your Mac, open System Settings → Privacy & Security → Full Disk Access → +. Add ${nodePath}, the node binary running LaunchAgent com.headlenss.server, and turn it on. Then tap Restart HeadLenss.`,
      '2. On your first confirmed send, macOS asks to let HeadLenss control Messages. Click OK. If denied, open System Settings → Privacy & Security → Automation and enable Messages for the server process.',
      '3. Open Messages on the Mac and sign in to the same Apple ID as your iPhone. For SMS, also enable Text Message Forwarding to this Mac on your iPhone.',
      'Group threads are read-only in v1. If delivery is unknown, check Messages on the Mac before composing another reply.',
    ] });
  });
  router.get('/threads', async (c) => {
    const rows = await sqlite(chatDb, threadsSql(now()));
    const contacts = await names();
    return c.json({ threads: rows.slice(0, 10).map((row) => threadView(row, contacts).thread) });
  });
  router.get('/threads/:id', async (c) => {
    const id = validId(c.req.param('id'));
    const row = await target(id);
    const [rows, contacts] = await Promise.all([sqlite(chatDb, messagesSql(id)), names()]);
    return c.json({ thread: threadView(row, contacts).thread, messages: rows.slice(0, 20).reverse().map((row) => ({
      id: String(row.id), fromMe: row.from_me === 1,
      sender: row.from_me === 1 ? 'Me' : typeof row.sender === 'string' ? contacts.get(handleKey(row.sender)) || row.sender : 'Unknown sender',
      text: decodeBody(row.text, row.body), at: appleTime(row.date),
    })) });
  });
  async function send(id: string, text: string, draftId: string): Promise<Reply> {
    available();
    let reservation;
    try { reservation = await log.claim(draftId, id, now()); }
    catch { throw new MessagesError('Cannot reserve this reply safely. Nothing was sent; check HeadLenss storage.', 503, 'send_failed'); }
    if (!reservation.fresh) {
      if (reservation.entry && reservation.entry.thread !== id) throw new MessagesError('This draftId already belongs to another thread.', 409, 'draft_conflict');
      return replyState(reservation.entry?.ok ? 'sent' : 'unknown');
    }
    maintainLog();
    try {
      // Check terminal replay before preflight: lost read access must not turn
      // an earlier sent/unknown result into a new, retryable 4xx after restart.
      const { thread, guid, recipient } = threadView(await target(id), new Map());
      if (!thread.canReply) throw new MessagesError(thread.readOnlyReason!, 409, thread.reasonCode);
      let result: string;
      try {
        const command = await execute('/usr/bin/osascript', ['-e', SEND_SCRIPT, '--', guid, thread.service, recipient, text], options.sendTimeoutMs ?? 30_000, 16 * 1024);
        result = command.stdout.trim();
      } catch {
        // The command may have sent before failing, timing out, or losing its ACK.
        // Do not inspect/return raw exec errors; they may contain the full reply.
        return replyState('unknown');
      }
      if (result === 'denied') { canSend = 'denied'; throw new MessagesError(AUTOMATION_HELP, 403, 'automation_denied'); }
      if (result === 'unavailable') throw new MessagesError('The original chat, recipient, or service is no longer available. Open Messages on the Mac.', 409, 'target_unavailable');
      if (result === 'sent') {
        canSend = 'yes';
        // A failed success update leaves the durable reservation as unknown;
        // it never permits a second dispatch after a restart.
        await log.sent(draftId).catch(() => {});
        return replyState('sent');
      }
      return replyState('unknown');
    } catch (error) {
      if (error instanceof MessagesError && error.status >= 400 && error.status < 500) {
        // Only a definite no-send releases this attempt's fresh reservation.
        // Finish cleanup before returning the retryable rejection to the lens.
        try { await log.releaseRejected(draftId, reservation.entry); }
        catch { return replyState('unknown'); }
      }
      throw error;
    }
  }
  router.post('/threads/:id/reply', async (c) => {
    available();
    const id = validId(c.req.param('id'));
    const body = object(await c.req.json(), ['text', 'draftId']);
    const text = string(body.text, 'text', 16000);
    if (Buffer.from(text, 'utf8').toString('utf8') !== text) throw new MessagesError('Invalid text encoding', 400, 'invalid_request');
    const draftId = string(body.draftId, 'draftId', 128);
    if (!/^[a-zA-Z0-9_-]+$/.test(draftId)) throw new MessagesError('Invalid draftId', 400, 'invalid_request');
    // Do not trim, rewrite or split the user-confirmed text.
    const fingerprint = createHash('sha256').update(text).digest('hex');
    const existing = drafts.get(draftId);
    if (existing) {
      if (existing.thread !== id || existing.fingerprint !== fingerprint) throw new MessagesError('This draftId was already used for a different reply. Review a new draft before sending.', 409, 'draft_conflict');
      return c.json(await existing.result);
    }
    if (drafts.size >= 10000) throw new MessagesError('Reply history is full. Check Messages before restarting HeadLenss.', 429, 'history_full');
    // Reserve before the first await, so simultaneous requests share the result.
    const result = send(id, text, draftId).catch((error: unknown) => {
      // Concurrent callers still share the pending attempt. Rejections are
      // evicted; only sent/unknown outcomes remain as completed replay guards.
      if (drafts.get(draftId)?.result === result) drafts.delete(draftId);
      throw error;
    });
    drafts.set(draftId, { thread: id, fingerprint, time: now(), result });
    return c.json(await result);
  });
  router.post('/restart', (c) => {
    available();
    if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) throw new MessagesError('Cannot determine this server’s LaunchAgent user.', 409, 'restart_unavailable');
    if (!cancelRestart) {
      const schedule = options.scheduleRestart ?? ((run: () => void) => {
        const timer = setTimeout(run, 500);
        timer.unref();
        return () => clearTimeout(timer);
      });
      cancelRestart = schedule(() => {
        if (stopped) return;
        // Response is already returned. Never accept a user-supplied label/UID.
        void execute('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.headlenss.server`], 5000, 4096)
          .catch(() => {}).finally(() => { cancelRestart = undefined; });
      });
    }
    return c.json({ ok: true, reasonCode: 'restart_requested', reason: 'HeadLenss restart requested.' }, 202);
  });
  return { router, start: maintainLog, async clear() {
    clearing = true;
    try {
      for (const controller of active) controller.abort();
      await Promise.allSettled([...drafts.values()].map((draft) => draft.result));
      await log.clear();
      // Retain memory-only replay guards until expiry, including an interrupted
      // send. Deleting data must not turn a double tap into a second send.
    } finally { clearing = false; }
  }, stop() {
    stopped = true;
    if (retentionTimer) clearInterval(retentionTimer);
    cancelRestart?.(); cancelRestart = undefined;
    for (const controller of active) controller.abort();
  } };
}
