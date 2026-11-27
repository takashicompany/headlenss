import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createMessagesModule, type MessagesOptions } from './fieldglass/messages/index.ts';
import { decodeBody, appleTime, contactsSql, threadsSql, messagesSql } from './fieldglass/messages/database.ts';
import { SEND_SCRIPT, type MessagesRunner } from './fieldglass/messages/commands.ts';
import { createFieldglassModule } from './fieldglass/router.ts';
import { DraftLog, SEND_RETENTION_MS } from './fieldglass/messages/drafts.ts';

const NOW = Date.UTC(2026, 10, 26, 18);
const APPLE_EPOCH = Date.UTC(2001, 0, 1);
const SENT = { ok: true, state: 'sent', reasonCode: 'sent', reason: 'Messages accepted the reply.' };
const UNKNOWN = { ok: true, state: 'unknown', reasonCode: 'delivery_unknown', reason: 'Delivery unknown — check Messages on your Mac before composing another reply.' };
const appleDate = (ms: number) => (BigInt(ms - APPLE_EPOCH) * 1_000_000n).toString();
const row = (overrides: Record<string, unknown> = {}) => ({ id: '7', guid: 'iMessage;-;+15555550101',
  display_name: '', chat_identifier: '+15555550101', service: 'iMessage', style: 45,
  handles: '["+15555550101"]', text: 'Latest message', body: '', date: appleDate(NOW), unread: 2, ...overrides });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t: TestContext, options: MessagesOptions = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'fieldglass-messages-'));
  const calls: { file: string; args: string[] }[] = [];
  const scheduled: (() => void)[] = [];
  const runner: MessagesRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === '/usr/bin/osascript') return { stdout: 'sent\n' };
    if (file === '/bin/launchctl') return { stdout: '' };
    const sql = args.at(-1)!;
    if (sql.includes('fieldglass:probe')) return { stdout: '[{"ok":1}]' };
    if (sql.includes('fieldglass:contacts')) return { stdout: '[{"handle":"+1 (555) 555-0101","name":"Example Person"}]' };
    if (sql.includes('fieldglass:messages')) return { stdout: JSON.stringify([
      { id: '9', from_me: 0, sender: '+15555550101', text: 'Newest', body: '', date: appleDate(NOW) },
      { id: '8', from_me: 1, sender: null, text: 'Older', body: '', date: appleDate(NOW - 1000) },
    ]) };
    return { stdout: JSON.stringify([row()]) };
  };
  const module = createMessagesModule({ runner, dir, home: '/fixture-home', now: () => NOW,
    nodePath: '/fixture/node', uid: 501, platform: 'darwin',
    contactDatabases: async () => ['/fixture-home/contacts.abcddb'],
    scheduleRestart: (run) => { scheduled.push(run); return () => { scheduled.splice(0); }; }, ...options });
  t.after(async () => { module.stop(); await rm(dir, { recursive: true, force: true }); });
  const app = new Hono().route('/api/fieldglass/messages', module.router);
  const request = (path: string, method = 'GET', body?: unknown) => app.request(`/api/fieldglass/messages${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { ...module, dir, calls, scheduled, request, runner };
}

test('messages status probes read access only and supplies exact permissions steps', async (t) => {
  const f = fixture(t);
  assert.equal(f.calls.length, 0, 'no startup reads');
  const response = await f.request('/status');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const status = await response.json();
  assert.deepEqual({ ...status, steps: [] }, { canRead: true, canSend: 'unknown', nodePath: '/fixture/node', steps: [],
    reasonCode: 'permission_unknown', reason: 'Messages send permission has not been confirmed yet.' });
  const steps = status.steps.join(' ');
  for (const wording of ['Full Disk Access', '/fixture/node', 'com.headlenss.server', 'Restart HeadLenss', 'Automation', 'Messages', 'Apple ID']) assert.ok(steps.includes(wording));
  assert.ok(f.calls.every((call) => call.file === '/usr/bin/sqlite3'));
  assert.ok(!f.calls.some((call) => call.args.join(' ').includes('fieldglass:contacts')));
});

test('denied database reads return setup help without raw stderr or message content', async (t) => {
  const f = fixture(t, { runner: async () => { throw new Error('Operation not permitted PRIVATE_MESSAGE'); } });
  assert.equal((await (await f.request('/status')).json()).canRead, false);
  const response = await f.request('/threads');
  assert.equal(response.status, 403);
  assert.match(await response.text(), /Full Disk Access/);
  const detail = await f.request('/threads/7');
  assert.equal(detail.status, 403);
  assert.ok(!(await detail.text()).includes('PRIVATE_MESSAGE'));
});

test('threads resolve contacts, preserve service and unread markers, and use only readonly SQLite', async (t) => {
  const f = fixture(t);
  const { threads } = await (await f.request('/threads')).json();
  assert.deepEqual(threads[0], { id: '7', name: 'Example Person', isGroup: false, service: 'iMessage',
    lastText: 'Latest message', lastAt: NOW, unread: 2, canReply: true, reasonCode: 'ready' });
  for (const call of f.calls) {
    assert.equal(call.file, '/usr/bin/sqlite3');
    assert.deepEqual(call.args.slice(0, 7), ['-readonly', '-json', '-batch', '-bail', '-init', '/dev/null', '-cmd']);
    assert.equal(call.args[7], 'PRAGMA query_only=ON;');
    assert.deepEqual(call.args.slice(8, 10), ['-cmd', '.timeout 1500']);
    assert.ok(call.args.includes('--'));
    assert.ok(!/\b(INSERT|UPDATE|DELETE|ATTACH|CREATE)\b/.test(call.args.at(-1)!));
  }
  assert.match(threadsSql(NOW), /LIMIT 10/);
  assert.ok(threadsSql(NOW).includes(String(Math.floor((NOW - APPLE_EPOCH) / 1000) - 7 * 86400)));
});

test('thread detail returns last 20 chronologically with contact sender and me marker', async (t) => {
  const f = fixture(t);
  const response = await f.request('/threads/7');
  const detail = await response.json();
  assert.equal(detail.thread.name, 'Example Person');
  assert.deepEqual(detail.messages, [
    { id: '8', fromMe: true, sender: 'Me', text: 'Older', at: NOW - 1000 },
    { id: '9', fromMe: false, sender: 'Example Person', text: 'Newest', at: NOW },
  ]);
  assert.match(messagesSql('7'), /LIMIT 20/);
});

test('best-effort contact failure falls back to handle; group and unsupported service are read-only', async (t) => {
  const f = fixture(t, { contactDatabases: async () => { throw new Error('denied'); }, runner: async () => ({ stdout: JSON.stringify([
    row(), row({ id: '8', guid: 'iMessage;+;group', style: 43, handles: '["+15555550101","person@example.invalid"]', display_name: 'Planning' }),
    row({ id: '9', service: 'RCS' }),
  ]) }) });
  const { threads } = await (await f.request('/threads')).json();
  assert.equal(threads[0].name, '+15555550101');
  assert.equal(threads[1].name, 'Planning');
  assert.equal(threads[1].isGroup, true);
  assert.equal(threads[1].canReply, false);
  assert.match(threads[1].readOnlyReason, /Group/);
  assert.equal(threads[2].canReply, false);
});

test('thread IDs cannot inject SQL and missing threads return 404', async (t) => {
  const f = fixture(t, { runner: async () => ({ stdout: '[]' }) });
  for (const id of ['0', '-1', '9007199254740992', '1%20OR%201=1', '7%3BDELETE']) {
    assert.equal((await f.request(`/threads/${id}`)).status, 400);
  }
  assert.equal((await f.request('/threads/7')).status, 404);
});

function typedBody(text: string) {
  const bytes = Buffer.from(text);
  const length = bytes.length < 128 ? Buffer.from([bytes.length]) : Buffer.from([0x81, bytes.length & 255, bytes.length >> 8]);
  return Buffer.concat([Buffer.from('\x04\x0bstreamtyped', 'binary'), Buffer.from('NSString'), Buffer.from([1, 0x94, 0x84, 1, 0x2b]), length, bytes, Buffer.from([0x86])]).toString('hex');
}

test('typedstream NSString decoder handles UTF-8 and 16-bit lengths without leaking archive metadata', () => {
  for (const text of ['Hello 🥽', 'long reply '.repeat(80)]) assert.equal(decodeBody(null, typedBody(text)), text);
  assert.equal(decodeBody('Plain text', 'bad'), 'Plain text');
  for (const body of ['', 'abcd', typedBody('hello').slice(0, -8), Buffer.from('NSString metadata only').toString('hex')]) {
    assert.equal(decodeBody(null, body), '[attachment]');
  }
  assert.equal(appleTime(appleDate(NOW)), NOW);
  assert.equal(appleTime(String((NOW - APPLE_EPOCH) / 1000)), NOW);
});

test('reply passes exact text and target only as argv, sends once, and remembers its result', async (t) => {
  const f = fixture(t);
  const text = '  Say "hello"\n日本語; $(touch /nope) `nope` \\ end  ';
  const body = { text, draftId: 'draft-one' };
  assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', body)).json(), SENT);
  assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', body)).json(), SENT);
  const sends = f.calls.filter((call) => call.file === '/usr/bin/osascript');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].args, ['-e', SEND_SCRIPT, '--', 'iMessage;-;+15555550101', 'iMessage', '+15555550101', text]);
  assert.ok(!SEND_SCRIPT.includes(text));
  assert.match(SEND_SCRIPT, /on run argv/);
  assert.match(SEND_SCRIPT, /chat id/);
  assert.equal((await (await f.request('/status')).json()).canSend, 'yes');
  assert.equal((await f.request('/threads/7/reply', 'POST', { ...body, text: 'changed' })).status, 409);
  assert.equal((await f.request('/threads/8/reply', 'POST', body)).status, 409);
});

test('simultaneous identical drafts share one send and uncertain results never retry', async (t) => {
  const pending = deferred<{ stdout: string }>();
  let sends = 0;
  const f = fixture(t, { runner: async (file) => {
    if (file === '/usr/bin/osascript') { sends++; return pending.promise; }
    return { stdout: JSON.stringify([row()]) };
  } });
  const body = { text: 'Only once', draftId: 'shared-draft' };
  const first = f.request('/threads/7/reply', 'POST', body);
  const second = f.request('/threads/7/reply', 'POST', body);
  for (let i = 0; i < 100 && sends === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(sends, 1);
  pending.reject(new Error('possibly sent PRIVATE_MESSAGE'));
  for (const response of await Promise.all([first, second, f.request('/threads/7/reply', 'POST', body)])) {
    assert.deepEqual(await response.json(), UNKNOWN);
  }
  assert.equal(sends, 1);
});

test('send timeout is unknown, bounded even for an uncooperative injected runner, and not retried', async (t) => {
  let sends = 0;
  const f = fixture(t, { sendTimeoutMs: 5, runner: async (file) => {
    if (file === '/usr/bin/osascript') { sends++; return new Promise(() => {}); }
    return { stdout: JSON.stringify([row()]) };
  } });
  const body = { text: 'Check Messages', draftId: 'timeout-draft' };
  assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', body)).json(), UNKNOWN);
  assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', body)).json(), UNKNOWN);
  assert.equal(sends, 1);
});

test('Automation denial is explicit and retryable without exposing private command errors', async (t) => {
  let sends = 0;
  const f = fixture(t, { runner: async (file) => {
    if (file === '/usr/bin/osascript') { sends++; return { stdout: 'denied\n', stderr: 'PRIVATE_MESSAGE' }; }
    return { stdout: JSON.stringify([row()]) };
  } });
  const body = { text: 'PRIVATE_MESSAGE', draftId: 'denied-draft' };
  for (let i = 0; i < 2; i++) {
    const response = await f.request('/threads/7/reply', 'POST', body);
    assert.equal(response.status, 403);
    const result = await response.text();
    assert.match(result, /Automation/);
    assert.ok(!result.includes(body.text));
  }
  assert.equal((await (await f.request('/status')).json()).canSend, 'denied');
  assert.equal(sends, 2);
});

test('groups and unsupported services cannot send; validation rejects missing/extra fields', async (t) => {
  for (const record of [row({ style: 43 }), row({ service: 'RCS' }), row({ guid: '', handles: '[]' })]) {
    let sends = 0;
    const f = fixture(t, { runner: async (file) => { if (file === '/usr/bin/osascript') sends++; return { stdout: JSON.stringify([record]) }; } });
    assert.equal((await f.request('/threads/7/reply', 'POST', { text: 'No send', draftId: 'blocked' })).status, 409);
    assert.equal(sends, 0);
  }
  const f = fixture(t);
  for (const body of [{}, { text: '', draftId: 'x' }, { text: 'x' }, { text: 'x', draftId: 'x', recipient: 'injected' },
    { text: 'x\u0000', draftId: 'x' }, { text: '\ud800', draftId: 'x' }, { text: 'x'.repeat(16001), draftId: 'x' }, { text: 'x', draftId: '../bad' }]) {
    assert.equal((await f.request('/threads/7/reply', 'POST', body)).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('restart responds before scheduling only its own LaunchAgent, with duplicate requests coalesced', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await (await f.request('/restart', 'POST')).json(), { ok: true, reasonCode: 'restart_requested', reason: 'HeadLenss restart requested.' });
  assert.equal(f.calls.length, 0);
  await f.request('/restart', 'POST');
  assert.equal(f.scheduled.length, 1);
  f.scheduled[0]();
  await nextTurn();
  assert.deepEqual(f.calls, [{ file: '/bin/launchctl', args: ['kickstart', '-k', 'gui/501/com.headlenss.server'] }]);
});

test('stopping cancels pending restart and non-Mac instances never invoke platform commands', async (t) => {
  const f = fixture(t);
  await f.request('/restart', 'POST');
  f.stop();
  assert.equal(f.scheduled.length, 0);
  const other = fixture(t, { platform: 'linux' });
  assert.equal((await (await other.request('/status')).json()).canRead, false);
  assert.equal((await other.request('/threads')).status, 409);
  assert.equal((await other.request('/restart', 'POST')).status, 409);
  assert.equal(other.calls.length, 0);
});

test('messages API is mounted by Fieldglass without activating a reader at construction', async (t) => {
  let calls = 0;
  const dir = mkdtempSync(join(tmpdir(), 'fieldglass-messages-mount-'));
  const module = createFieldglassModule({ dir, sendPrompt: async () => {}, runner: async () => '', messages: {
    home: '/fixture-home', platform: 'darwin', contactDatabases: async () => [],
    runner: async () => { calls++; return { stdout: '[{"ok":1}]' }; },
  } });
  t.after(async () => { module.stop(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(calls, 0);
  const response = await module.router.request('/messages/status');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).canRead, true);
  assert.equal(calls, 1);
});

test('24-hour send reservations survive module recreation and contain no message, contact, or draft text', async (t) => {
  const f = fixture(t);
  const body = { text: 'PRIVATE_BODY', draftId: 'PRIVATE_DRAFT_ID' };
  await f.request('/threads/7/reply', 'POST', body);
  const directory = join(f.dir, 'messages-sends');
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  const saved = await readFile(join(directory, files[0]), 'utf8');
  assert.deepEqual(JSON.parse(saved), { thread: '7', time: NOW, ok: true });
  assert.equal((await stat(join(directory, files[0]))).mode & 0o777, 0o600);
  f.stop();
  const restarted = fixture(t, { dir: f.dir });
  assert.deepEqual(await (await restarted.request('/threads/7/reply', 'POST', body)).json(), SENT);
  assert.equal(restarted.calls.filter((call) => call.file === '/usr/bin/osascript').length, 0);
  await new DraftLog(directory).prune(NOW + SEND_RETENTION_MS);
  assert.deepEqual(await readdir(directory), []);
});

test('unknown and damaged reservations block dispatch after restart; failure to reserve fails closed', async (t) => {
  const body = { text: 'PRIVATE_BODY', draftId: 'unknown-after-restart' };
  const f = fixture(t, { runner: async (file) => {
    if (file === '/usr/bin/osascript') throw new Error('PRIVATE_BODY');
    return { stdout: JSON.stringify([row()]) };
  } });
  assert.equal((await (await f.request('/threads/7/reply', 'POST', body)).json()).state, 'unknown');
  f.stop();
  const restarted = fixture(t, { dir: f.dir });
  assert.equal((await (await restarted.request('/threads/7/reply', 'POST', body)).json()).state, 'unknown');
  const directory = join(f.dir, 'messages-sends');
  await writeFile(join(directory, (await readdir(directory))[0]), '{');
  const damaged = fixture(t, { dir: f.dir });
  assert.equal((await (await damaged.request('/threads/7/reply', 'POST', body)).json()).state, 'unknown');
  assert.ok([...restarted.calls, ...damaged.calls].every((call) => call.file !== '/usr/bin/osascript'));
  const blocked = fixture(t);
  await writeFile(join(blocked.dir, 'messages-sends'), 'not a directory');
  assert.equal((await blocked.request('/threads/7/reply', 'POST', body)).status, 503);
  assert.ok(blocked.calls.every((call) => call.file !== '/usr/bin/osascript'));
});

test('clearing data removes the send log while keeping a completed draft from resending', async (t) => {
  const f = fixture(t);
  const body = { text: 'PRIVATE_BODY', draftId: 'delete-draft' };
  await f.request('/threads/7/reply', 'POST', body);
  await f.clear();
  assert.deepEqual(await readdir(join(f.dir, 'messages-sends')), []);
  assert.equal((await (await f.request('/threads/7/reply', 'POST', body)).json()).state, 'sent');
  assert.equal(f.calls.filter((call) => call.file === '/usr/bin/osascript').length, 1);
});

test('SMS uses the existing SMS chat and stale AppleScript targets are definite no-send failures', async (t) => {
  const scripts: string[][] = [];
  const f = fixture(t, { runner: async (file, args) => {
    if (file === '/usr/bin/osascript') { scripts.push(args); return { stdout: 'unavailable' }; }
    return { stdout: JSON.stringify([row({ service: 'SMS', guid: 'SMS;-;+15555550101' })]) };
  } });
  const body = { text: 'SMS reply', draftId: 'sms-draft' };
  for (let i = 0; i < 2; i++) assert.equal((await f.request('/threads/7/reply', 'POST', body)).status, 409);
  assert.equal(scripts.length, 2);
  assert.deepEqual(scripts[0].slice(-4), ['SMS;-;+15555550101', 'SMS', '+15555550101', body.text]);
});

test('unknown command errors never echo or log a private body; empty acknowledgements are unknown', async (t) => {
  const output: unknown[][] = [];
  for (const method of ['log', 'error', 'warn', 'debug'] as const) t.mock.method(console, method, (...args: unknown[]) => { output.push(args); });
  const privateText = 'SECRET_MESSAGE_CONTENT';
  let attempts = 0;
  const f = fixture(t, { runner: async (file) => {
    if (file === '/usr/bin/osascript') {
      if (++attempts === 1) throw Object.assign(new Error(`command failed ${privateText}`), { stdout: privateText, stderr: privateText });
      return { stdout: '', stderr: privateText };
    }
    return { stdout: JSON.stringify([row()]) };
  } });
  for (const draftId of ['error-draft', 'empty-draft']) {
    const response = await f.request('/threads/7/reply', 'POST', { text: privateText, draftId });
    assert.deepEqual(await response.json(), UNKNOWN);
  }
  assert.deepEqual(output, []);
  const directory = join(f.dir, 'messages-sends');
  for (const name of await readdir(directory)) assert.ok(!(await readFile(join(directory, name), 'utf8')).includes(privateText));
});

test('Delete all through the parent route cancels a pending reply without restoring its log or resending', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fieldglass-messages-delete-'));
  const entered = deferred<void>();
  const pending = deferred<{ stdout: string }>();
  let sends = 0;
  const module = createFieldglassModule({ dir, now: () => NOW, sendPrompt: async () => {}, runner: async () => '', messages: {
    home: '/fixture-home', platform: 'darwin', contactDatabases: async () => [],
    runner: async (file) => {
      if (file === '/usr/bin/osascript') { sends++; entered.resolve(); return pending.promise; }
      return { stdout: JSON.stringify([row()]) };
    },
  } });
  t.after(async () => { module.stop(); await rm(dir, { recursive: true, force: true }); });
  const reply = () => module.router.request('/messages/threads/7/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Private draft', draftId: 'cleared-inflight' }) });
  const response = reply();
  await entered.promise;
  assert.equal((await module.router.request('/data', { method: 'DELETE' })).status, 200);
  assert.equal((await (await response).json()).state, 'unknown');
  pending.resolve({ stdout: 'sent' });
  await nextTurn();
  assert.deepEqual(await readdir(join(dir, 'messages-sends')), []);
  assert.equal((await (await reply()).json()).state, 'unknown');
  assert.equal(sends, 1);
});

test('SQLite statements run against injected in-memory fixtures: 7-day top 10, last 20, contacts and readonly', async (t) => {
  // No OS runner, on-disk database, or user data. This built-in SQLite engine
  // validates the actual SQL instead of returning a canned response per query.
  const sqlite = await import('node:sqlite').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ERR_UNKNOWN_BUILTIN_MODULE') return null;
    throw error;
  });
  if (!sqlite) { t.skip('In-memory SQL integration requires Node 22; production uses /usr/bin/sqlite3.'); return; }
  const { DatabaseSync } = sqlite;
  const db = new DatabaseSync(':memory:');
  const contacts = new DatabaseSync(':memory:');
  t.after(() => { db.close(); contacts.close(); });
  db.exec(`CREATE TABLE chat (guid TEXT, display_name TEXT, chat_identifier TEXT, service_name TEXT, style INTEGER);
    CREATE TABLE handle (id TEXT);
    CREATE TABLE message (text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, is_read INTEGER, handle_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);`);
  contacts.exec(`CREATE TABLE ZABCDRECORD (Z_PK INTEGER, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT);
    CREATE TABLE ZABCDPHONENUMBER (ZFULLNUMBER TEXT, ZOWNER INTEGER);
    CREATE TABLE ZABCDEMAILADDRESS (ZADDRESS TEXT, ZOWNER INTEGER);
    INSERT INTO ZABCDRECORD VALUES (1, 'Example', 'Person', NULL);
    INSERT INTO ZABCDPHONENUMBER VALUES ('+1 (555) 555-0101', 1);
    INSERT INTO ZABCDEMAILADDRESS VALUES ('person@example.invalid', 1);`);
  for (let chat = 1; chat <= 12; chat++) {
    db.prepare('INSERT INTO chat (ROWID, guid, display_name, chat_identifier, service_name, style) VALUES (?, ?, ?, ?, ?, ?)')
      .run(chat, `iMessage;-;+1555555${String(chat).padStart(4, '0')}`, '', '+15555550101', 'iMessage', 45);
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(chat, '+15555550101');
    db.prepare('INSERT INTO chat_handle_join VALUES (?, ?)').run(chat, chat);
    for (let index = 0; index < 25; index++) {
      const id = chat * 100 + index;
      const at = NOW - chat * 1000 - (24 - index) * 60_000 - (chat === 12 ? 8 * 86400000 : 0);
      db.prepare('INSERT INTO message (ROWID, text, attributedBody, date, is_from_me, is_read, handle_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, index === 24 ? null : `Synthetic ${index}`, index === 24 ? Buffer.from(typedBody('Decoded preview'), 'hex') : null,
          BigInt(appleDate(at)), 0, index === 24 ? 0 : 1, chat);
      db.prepare('INSERT INTO chat_message_join VALUES (?, ?)').run(chat, id);
    }
  }
  const f = fixture(t, { runner: async (file, args) => {
    assert.equal(file, '/usr/bin/sqlite3');
    assert.equal(args[0], '-readonly');
    const target = args.at(-2)!.endsWith('contacts.abcddb') ? contacts : db;
    for (let i = 0; i < args.length; i++) if (args[i] === '-cmd') {
      const command = args[++i];
      // A result-producing PRAGMA here would corrupt sqlite3's JSON stream.
      if (!command.startsWith('.timeout ')) assert.deepEqual(target.prepare(command).all(), []);
    }
    return { stdout: JSON.stringify(target.prepare(args.at(-1)!).all()) };
  } });
  const { threads } = await (await f.request('/threads')).json();
  assert.equal(threads.length, 10);
  assert.deepEqual(threads.map((thread: { id: string }) => thread.id), Array.from({ length: 10 }, (_, index) => String(index + 1)));
  assert.equal(threads[0].name, 'Example Person');
  assert.equal(threads[0].lastText, 'Decoded preview');
  assert.equal(threads[0].unread, 1);
  assert.equal(threads[0].lastAt, NOW - 1000);
  const { messages } = await (await f.request('/threads/1')).json();
  assert.equal(messages.length, 20);
  assert.equal(messages[0].text, 'Synthetic 5');
  assert.equal(messages.at(-1).text, 'Decoded preview');
  assert.throws(() => db.exec('DELETE FROM message'), /readonly/);
  assert.throws(() => contacts.exec('DELETE FROM ZABCDRECORD'), /readonly/);
  assert.ok(contactsSql.includes('ZABCDEMAILADDRESS'));
});

test('round 4: thread and reply refusal codes preserve each English read-only reason', async (t) => {
  for (const [record, reasonCode, reason] of [
    [row({ style: 43 }), 'group_read_only', 'Group threads are read-only in v1.'],
    [row({ service: 'RCS' }), 'unsupported_service', 'Only existing iMessage and SMS threads can receive replies.'],
    [row({ handles: '[]' }), 'ambiguous_target', 'This thread has no unambiguous reply target. Open Messages on your Mac.'],
  ] as const) {
    const f = fixture(t, { runner: async () => ({ stdout: JSON.stringify([record]) }) });
    const list = await (await f.request('/threads')).json();
    const detail = await (await f.request('/threads/7')).json();
    for (const thread of [list.threads[0], detail.thread]) {
      assert.equal(thread.reasonCode, reasonCode);
      assert.equal(thread.readOnlyReason, reason);
      assert.equal(thread.canReply, false);
    }
    const body = { text: 'Unsent', draftId: 'read-only' };
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await f.request('/threads/7/reply', 'POST', body);
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: reason, reasonCode });
    }
  }
});

test('round 4: read and Automation permissions have codes on both errors and status', async (t) => {
  const denied = fixture(t, { runner: async () => { throw new Error('PRIVATE_REASON'); } });
  for (const endpoint of ['/threads', '/threads/7']) {
    const response = await denied.request(endpoint);
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.reasonCode, 'read_denied');
    assert.match(body.error, /Full Disk Access/);
    assert.ok(!JSON.stringify(body).includes('PRIVATE_REASON'));
  }
  const status = await (await denied.request('/status')).json();
  assert.equal(status.reasonCode, 'read_denied');
  assert.match(status.reason, /Full Disk Access/);
  const automation = fixture(t, { runner: async (file, args) => ({ stdout: file === '/usr/bin/osascript' ? 'denied'
    : args.at(-1)!.includes('fieldglass:probe') ? '[{"ok":1}]' : JSON.stringify([row()]) }) });
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await automation.request('/threads/7/reply', 'POST', { text: 'Unsent', draftId: 'denied' });
    const body = await response.json();
    assert.equal(body.reasonCode, 'automation_denied');
    assert.match(body.error, /Messages Automation permission was denied/);
  }
  const automationStatus = await (await automation.request('/status')).json();
  assert.equal(automationStatus.reasonCode, 'automation_denied');
  assert.match(automationStatus.reason, /Automation/);
});

test('round 4: validation, missing routes/threads, conflicts and restart failures have stable codes', async (t) => {
  const f = fixture(t);
  for (const [path, body, text] of [
    ['/threads/0/reply', { text: 'x', draftId: 'x' }, 'Invalid thread ID'],
    ['/threads/7/reply', { text: '', draftId: 'x' }, 'Invalid text'],
    ['/threads/7/reply', { text: 'x', draftId: '../x' }, 'Invalid draftId'],
    ['/threads/7/reply', { text: 'x', draftId: 'x', extra: true }, 'Unknown field'],
  ] as const) {
    const response = await f.request(path, 'POST', body);
    assert.deepEqual(await response.json(), { error: text, reasonCode: 'invalid_request' });
  }
  const invalidJson = await f.router.request('/threads/7/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.deepEqual(await invalidJson.json(), { error: 'Invalid JSON', reasonCode: 'invalid_request' });
  const missing = fixture(t, { runner: async () => ({ stdout: '[]' }) });
  assert.deepEqual(await (await missing.request('/threads/7')).json(), { error: 'Message thread not found', reasonCode: 'not_found' });
  assert.equal((await (await f.request('/missing')).json()).reasonCode, 'not_found');
  const draft = { text: 'Original', draftId: 'existing' };
  await f.request('/threads/7/reply', 'POST', draft);
  const conflict = await (await f.request('/threads/7/reply', 'POST', { ...draft, text: 'Changed' })).json();
  assert.equal(conflict.reasonCode, 'draft_conflict');
  assert.match(conflict.error, /already used/);
  const badUid = fixture(t, { uid: NaN });
  assert.deepEqual(await (await badUid.request('/restart', 'POST')).json(), {
    error: 'Cannot determine this server’s LaunchAgent user.', reasonCode: 'restart_unavailable',
  });
});

test('round 4: definite send failure, unknown outcome and replay retain distinct codes and English text', async (t) => {
  const target = fixture(t, { runner: async (file) => ({ stdout: file === '/usr/bin/osascript' ? 'unavailable' : JSON.stringify([row()]) }) });
  const failure = await (await target.request('/threads/7/reply', 'POST', { text: 'Unsent', draftId: 'target' })).json();
  assert.equal(failure.reasonCode, 'target_unavailable');
  assert.equal(failure.error, 'The original chat, recipient, or service is no longer available. Open Messages on the Mac.');
  const unknown = fixture(t, { runner: async (file) => {
    if (file === '/usr/bin/osascript') throw new Error('PRIVATE');
    return { stdout: JSON.stringify([row()]) };
  } });
  const body = { text: 'Private draft', draftId: 'unknown-state' };
  assert.deepEqual(await (await unknown.request('/threads/7/reply', 'POST', body)).json(), UNKNOWN);
  unknown.stop();
  const restarted = fixture(t, { dir: unknown.dir });
  assert.deepEqual(await (await restarted.request('/threads/7/reply', 'POST', body)).json(), UNKNOWN);
  assert.ok(restarted.calls.every((call) => call.file !== '/usr/bin/osascript'));
  const storage = fixture(t);
  await writeFile(join(storage.dir, 'messages-sends'), 'blocked');
  const storageError = await (await storage.request('/threads/7/reply', 'POST', body)).json();
  assert.equal(storageError.reasonCode, 'send_failed');
  assert.match(storageError.error, /Nothing was sent/);
});

test('round 4: stopped, unsupported-platform, unexpected and ready status paths are coded', async (t) => {
  const f = fixture(t);
  await f.request('/threads/7/reply', 'POST', { text: 'Confirmed', draftId: 'ready' });
  assert.equal((await (await f.request('/status')).json()).reasonCode, 'ready');
  f.stop();
  assert.equal((await (await f.request('/threads')).json()).reasonCode, 'stopping');
  assert.equal((await (await f.request('/status')).json()).reasonCode, 'stopping');
  const other = fixture(t, { platform: 'linux' });
  for (const path of ['/status', '/threads']) assert.equal((await (await other.request(path)).json()).reasonCode, 'not_mac');
  const broken = fixture(t, { runner: async () => ({ stdout: JSON.stringify([row({ id: 'invalid' })]) }) });
  assert.deepEqual(await (await broken.request('/threads')).json(), { error: 'Messages could not complete this request', reasonCode: 'unavailable' });
});

test('round 4: size-limit and unmatched-route codes survive the parent Fieldglass mount', async (t) => {
  const f = fixture(t);
  const tooLarge = { text: 'x'.repeat(140000), draftId: 'big' };
  assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', tooLarge)).json(), {
    error: 'Message request is too large', reasonCode: 'request_too_large',
  });
  const module = createFieldglassModule({ dir: f.dir, now: () => NOW, runner: async () => '', sendPrompt: async () => {},
    messages: { runner: async () => { throw new Error('No command expected'); }, home: '/fixture-home', contactDatabases: async () => [] },
  });
  t.after(() => module.stop());
  const app = new Hono().route('/api/fieldglass', module.router);
  const response = await app.request('/api/fieldglass/messages/threads/7/reply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tooLarge),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Fieldglass request is too large', reasonCode: 'request_too_large' });
  assert.equal((await (await app.request('/api/fieldglass/messages/missing')).json()).reasonCode, 'not_found');
  const unrelated = await app.request('/api/fieldglass/followups', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quote: 'x'.repeat(140000) }),
  });
  assert.deepEqual(await unrelated.json(), { error: 'Fieldglass request is too large' }, 'other APIs keep their contract');
});

test('round 5: definite preflight rejections allow the same draft to recover', async (t) => {
  for (const [reasonCode, status, rejectedRows] of [
    ['read_denied', 403, null], ['not_found', 404, []],
    ['group_read_only', 409, [row({ style: 43 })]],
    ['unsupported_service', 409, [row({ service: 'RCS' })]],
    ['ambiguous_target', 409, [row({ guid: '', handles: '[]' })]],
  ] as const) {
    let recovered = false;
    let sends = 0;
    const f = fixture(t, { runner: async (file) => {
      if (file === '/usr/bin/osascript') { sends++; return { stdout: 'sent' }; }
      if (!recovered && rejectedRows === null) throw new Error('Injected read denial');
      return { stdout: JSON.stringify(recovered ? [row()] : rejectedRows) };
    } });
    const body = { text: 'Confirmed synthetic reply', draftId: `recover-${reasonCode}` };
    const rejected = await f.request('/threads/7/reply', 'POST', body);
    assert.equal(rejected.status, status);
    assert.equal((await rejected.json()).reasonCode, reasonCode);
    assert.equal(sends, 0);
    recovered = true;
    assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', body)).json(), SENT, reasonCode);
    assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', body)).json(), SENT);
    assert.equal(sends, 1, 'only an explicit new request re-attempts; sent stays deduplicated');
  }
});

test('round 5: definite script rejection releases memory and disk before a same-ID retry', async (t) => {
  for (const [output, status, reasonCode] of [['denied', 403, 'automation_denied'], ['unavailable', 409, 'target_unavailable']] as const) {
    for (const restart of [false, true]) {
      let recovered = false;
      let sends = 0;
      const runner: MessagesRunner = async (file) => {
        if (file === '/usr/bin/osascript') { sends++; return { stdout: recovered ? 'sent' : output }; }
        return { stdout: JSON.stringify([row()]) };
      };
      const f = fixture(t, { runner });
      const body = { text: 'Confirmed synthetic reply', draftId: 'recover-script' };
      const rejected = await f.request('/threads/7/reply', 'POST', body);
      assert.equal(rejected.status, status);
      assert.equal((await rejected.json()).reasonCode, reasonCode);
      assert.deepEqual(await readdir(join(f.dir, 'messages-sends')), [], 'no rejection may remain on disk after the 4xx');
      assert.equal(sends, 1);
      recovered = true;
      if (restart) f.stop();
      const next = restart ? fixture(t, { runner, dir: f.dir }) : f;
      assert.deepEqual(await (await next.request('/threads/7/reply', 'POST', body)).json(), SENT);
      assert.deepEqual(await (await next.request('/threads/7/reply', 'POST', body)).json(), SENT);
      assert.equal(sends, 2, 'recovered send runs once, including after module recreation');
    }
  }
});

test('round 5: concurrent rejected attempts share one command, and a confirmed retry shares one new command', async (t) => {
  const started = deferred<void>();
  const pending = deferred<{ stdout: string }>();
  let sends = 0;
  const f = fixture(t, { runner: async (file) => {
    if (file !== '/usr/bin/osascript') return { stdout: JSON.stringify([row()]) };
    if (++sends === 1) { started.resolve(); return pending.promise; }
    return { stdout: 'sent' };
  } });
  const body = { text: 'One confirmed attempt', draftId: 'concurrent-retry' };
  const attempts = Array.from({ length: 40 }, () => f.request('/threads/7/reply', 'POST', body));
  await started.promise;
  await nextTurn();
  assert.equal(sends, 1);
  pending.resolve({ stdout: 'denied' });
  for (const response of await Promise.all(attempts)) {
    assert.equal(response.status, 403);
    assert.equal((await response.json()).reasonCode, 'automation_denied');
  }
  assert.equal(sends, 1, 'a rejection does not schedule a retry');
  const retries = await Promise.all(Array.from({ length: 40 }, () => f.request('/threads/7/reply', 'POST', body)));
  for (const response of retries) assert.deepEqual(await response.json(), SENT);
  assert.equal(sends, 2);
});

test('round 5: sent and unknown guards survive conflicts, lost read access and restart', async (t) => {
  for (const output of ['sent', 'unknown']) {
    const expected = output === 'sent' ? SENT : UNKNOWN;
    let lostReadAccess = false;
    let sends = 0;
    let reads = 0;
    const runner: MessagesRunner = async (file) => {
      if (file === '/usr/bin/osascript') { sends++; return { stdout: output }; }
      reads++;
      if (lostReadAccess) throw new Error('Injected read denial');
      return { stdout: JSON.stringify([row()]) };
    };
    const f = fixture(t, { runner });
    const body = { text: 'Do not duplicate', draftId: `terminal-${output}` };
    assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', body)).json(), expected);
    const conflict = await f.request('/threads/7/reply', 'POST', { ...body, text: 'Different' });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).reasonCode, 'draft_conflict');
    lostReadAccess = true;
    assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', body)).json(), expected);
    f.stop();
    const next = fixture(t, { runner, dir: f.dir });
    const wrongThread = await next.request('/threads/8/reply', 'POST', body);
    assert.equal(wrongThread.status, 409);
    assert.equal((await wrongThread.json()).reasonCode, 'draft_conflict');
    for (let i = 0; i < 2; i++) assert.deepEqual(await (await next.request('/threads/7/reply', 'POST', body)).json(), expected);
    assert.equal(sends, 1);
    assert.equal(reads, 1, 'terminal replay checks the durable guard before database preflight');
  }
});

test('round 5: inability to release a rejected reservation stays unknown and cannot resend', async (t) => {
  let sends = 0;
  const dir = mkdtempSync(join(tmpdir(), 'fieldglass-rejection-'));
  const f = fixture(t, { dir, runner: async (file) => {
    if (file !== '/usr/bin/osascript') return { stdout: JSON.stringify([row()]) };
    sends++;
    const logDir = join(dir, 'messages-sends');
    const [name] = await readdir(logDir);
    await writeFile(join(logDir, name), '{broken');
    return { stdout: 'denied' };
  } });
  const body = { text: 'Synthetic reply', draftId: 'unreleasable' };
  assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', body)).json(), UNKNOWN);
  assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', body)).json(), UNKNOWN);
  f.stop();
  const next = fixture(t, { dir });
  assert.deepEqual(await (await next.request('/threads/7/reply', 'POST', body)).json(), UNKNOWN);
  assert.equal(sends, 1);
  assert.equal(next.calls.length, 0);
});

test('round 5: a pre-dispatch storage failure is not retained as a rejected promise', async (t) => {
  const f = fixture(t);
  const path = join(f.dir, 'messages-sends');
  await writeFile(path, 'Injected storage obstruction');
  const body = { text: 'Confirmed synthetic reply', draftId: 'storage-recovery' };
  const failed = await f.request('/threads/7/reply', 'POST', body);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).reasonCode, 'send_failed');
  assert.ok(!f.calls.some((call) => call.file === '/usr/bin/osascript'));
  await rm(path);
  assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', body)).json(), SENT);
  assert.deepEqual(await (await f.request('/threads/7/reply', 'POST', body)).json(), SENT);
  assert.equal(f.calls.filter((call) => call.file === '/usr/bin/osascript').length, 1);
});

test('round 5: real lens and client recover a definite server rejection with the same confirmed draft', async (t) => {
  const { MessagesLens } = await import('../../../even/src/fieldglass/messages.ts');
  const { HeadlenssClient } = await import('../../../even/src/server-client.ts');
  const { getLanguage, setLanguage } = await import('../../../even/src/i18n.ts');
  let allowed = false;
  let sends = 0;
  const f = fixture(t, { runner: async (file) => {
    if (file === '/usr/bin/osascript') { sends++; return { stdout: allowed ? 'sent' : 'denied' }; }
    return { stdout: JSON.stringify([row()]) };
  } });
  const requests: { text: string; draftId: string }[] = [];
  const savedFetch = globalThis.fetch;
  const savedLanguage = getLanguage();
  t.after(() => { globalThis.fetch = savedFetch; setLanguage(savedLanguage); });
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, 'http://fixture.invalid', 'all HTTP stays in process');
    if (parsed.pathname.endsWith('/reply')) requests.push(JSON.parse(String(init?.body)));
    return f.router.request(parsed.pathname.replace('/api/fieldglass/messages', ''), init);
  };
  setLanguage('en');
  let clock = 1000;
  const client = new HeadlenssClient('http://fixture.invalid');
  let draft: import('../../../even/src/fieldglass/messages.ts').ReplyDraftView | null = {
    threadId: '7', name: 'Synthetic recipient', draftId: 'same-on-retry', text: 'Confirmed synthetic reply',
    recoveredPartial: false, serverBaseUrl: 'http://fixture.invalid',
  };
  const lens = new MessagesLens({ client: () => client, clientFor: () => client, now: () => clock,
    redraw: async () => {}, notice: () => {}, wrap: (text) => [text], exit: () => {},
    startReply: () => {}, backToDraft: () => {}, draft: () => draft, clearDraft: () => { draft = null; }, log: () => {},
  });
  t.after(() => lens.destroy());
  async function settleSend() {
    for (let i = 0; i < 200 && lens.screen === 'sending'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(lens.screen, 'result');
  }
  async function confirmAndSend() {
    assert.equal(lens.screen, 'confirm');
    const tag = lens.frameTag();
    assert.ok(tag);
    lens.onFrameRendered(tag);
    clock += 601;
    assert.equal(lens.confirmReady(), true);
    lens.onClick();
    await settleSend();
  }
  lens.openConfirm();
  await confirmAndSend();
  assert.equal(lens.result?.kind, 'failed');
  assert.equal(sends, 1);
  allowed = true;
  lens.onClick();
  assert.equal(lens.screen, 'confirm');
  assert.equal(sends, 1, 'Retry requires the new confirmation card before another send');
  await confirmAndSend();
  assert.equal(lens.result?.kind, 'sent');
  assert.equal(sends, 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0], 'same draftId and exact confirmed text on retry');
  assert.equal(draft, null);
});
