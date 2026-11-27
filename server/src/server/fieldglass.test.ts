import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Hono } from 'hono';
import { createFieldglassModule } from './fieldglass/router.ts';
import { mountFieldglass } from './fieldglass/index.ts';
import { FieldglassStore, RETENTION_MS } from './fieldglass/store.ts';
import { CALENDAR_REFRESH_MS, CALENDAR_TIMEOUT_MS, CALENDAR_SETUP, CONNECTIONS_TTL_MS, calendarArgs, parseCalendar, parseConnections, type CommandRunner } from './fieldglass/providers.ts';
import type { Followup } from './fieldglass/types.ts';

const T0 = new Date(2026, 10, 26, 9, 0, 0).getTime();
const calendar = (id = 'calendar:event:instance') => JSON.stringify({ source: 'calendar', events: [{ id, start: '10:00', end: '10:30', title: 'Standup' }] });
const noProviders: CommandRunner = async (args) => args[0] === 'mcp' ? 'No MCP servers configured.' : '{"source":"none","events":[]}';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t: TestContext, options: Partial<Parameters<typeof createFieldglassModule>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'headlenss-fieldglass-'));
  const sent: { session: string; prompt: string }[] = [];
  let clock = T0;
  const module = createFieldglassModule({ dir, now: () => clock, runner: noProviders,
    sendPrompt: async (session, prompt) => { sent.push({ session, prompt }); }, ...options });
  t.after(async () => { module.stop(); await module.idle(); await rm(dir, { recursive: true, force: true }); });
  const app = new Hono().route('/api/fieldglass', module.router);
  const request = (path: string, method = 'GET', body?: unknown) => app.request(`/api/fieldglass${path}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { ...module, dir, sent, app, request, advance: (ms: number) => { clock += ms; } };
}

async function save(f: Awaited<ReturnType<typeof fixture>>, fields = { quote: "I'll send the outline by Friday." }): Promise<Followup> {
  const response = await f.request('/followups', 'POST', fields);
  assert.equal(response.status, 201);
  return response.json() as Promise<Followup>;
}

test('calendar refresh returns immediately, is single-flight, and merges preserved objectives', async (t) => {
  const pending = deferred<string>();
  let calls = 0;
  const f = await fixture(t, { runner: async () => { calls++; return pending.promise; } });
  const first = await f.request('/today/refresh', 'POST');
  assert.deepEqual(await first.json(), { refreshing: true });
  assert.deepEqual(await (await f.request('/today/refresh', 'POST')).json(), { refreshing: true });
  assert.equal((await (await f.request('/today')).json()).refreshing, true);
  assert.equal((await f.request('/objective', 'PUT', { eventId: 'calendar:event:instance', objective: 'Agree an owner' })).status, 200);
  pending.resolve(calendar());
  await f.idle();
  const today = await (await f.request('/today')).json();
  assert.equal(calls, 1);
  assert.equal(today.source, 'calendar');
  assert.equal(today.refreshing, false);
  assert.equal(today.events[0].objective, 'Agree an owner');
  assert.equal(today.updatedAt, T0);
  await f.request('/today/refresh', 'POST'); await f.idle();
  assert.equal((await (await f.request('/today')).json()).events[0].objective, 'Agree an owner');
});

test('calendar jobs are read-only, bounded, and send no saved quotes or objectives', async (t) => {
  let args: string[] = [];
  const f = await fixture(t, { runner: async (input) => { args = input; return calendar(); } });
  await save(f, { quote: 'PRIVATE QUOTE' });
  await f.request('/objective', 'PUT', { eventId: 'x', objective: 'PRIVATE OBJECTIVE' });
  await f.request('/today/refresh', 'POST'); await f.idle();
  assert.equal(args[0], '-p');
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--settings'));
  assert.ok(allowed.includes('mcp__claude_ai_Notion__notion-calendar-list-events'));
  assert.ok(allowed.every((tool) => /^mcp__claude_ai_Google_Calendar__gcal_(list|get)_/.test(tool) || tool === 'mcp__claude_ai_Notion__notion-calendar-list-events'));
  assert.ok(!args.join(' ').includes('PRIVATE'));
  assert.ok(calendarArgs(T0)[1].includes('2026-11-26'));
});

test('calendar parsing handles CLI envelopes and rejects malformed or invented shapes', () => {
  assert.equal(parseCalendar(JSON.stringify({ type: 'result', is_error: false, result: calendar() })).events[0].title, 'Standup');
  assert.equal(parseCalendar('```json\n' + calendar() + '\n```').events[0].title, 'Standup');
  for (const value of [
    calendar().replace('10:00', '25:00'),
    '{"source":"none","events":[{"id":"a","start":"10:00","end":"11:00","title":"bad"}]}',
    '{"source":"calendar","events":[],"transcript":"private"}',
    JSON.stringify({ type: 'result', is_error: true, result: calendar() }),
  ]) assert.throws(() => parseCalendar(value));
});

test('auth failures give setup directions; parse failures retain cache without sign-in advice', async (t) => {
  let output = calendar();
  const f = await fixture(t, { runner: async () => output });
  await f.request('/today/refresh', 'POST'); await f.idle();
  output = 'Not JSON, SECRET provider error';
  await f.request('/today/refresh', 'POST'); await f.idle();
  const cached = await (await f.request('/today')).json();
  assert.equal(cached.events.length, 1);
  assert.equal(cached.updatedAt, T0);
  assert.equal(cached.setup, undefined);
  assert.equal(cached.lastErrorKind, 'parse');
  assert.ok(!JSON.stringify(cached).includes('SECRET'));
  output = '{"source":"none","events":[],"googleSignedIn":false}';
  await f.request('/today/refresh', 'POST'); await f.idle();
  const absent = await (await f.request('/today')).json();
  assert.equal(absent.source, 'none');
  assert.deepEqual(absent.events, []);
  assert.equal(absent.setup.connector, 'Google Calendar');
});

test('calendar hard deadline cancels even an uncooperative runner and releases refresh state', async (t) => {
  let signal: AbortSignal | undefined;
  const f = await fixture(t, { calendarTimeoutMs: 20, runner: async (_, opts) => { signal = opts.signal; return new Promise(() => {}); } });
  await f.request('/today/refresh', 'POST'); await f.idle();
  assert.equal(signal?.aborted, true);
  const today = await (await f.request('/today')).json();
  assert.equal(today.refreshing, false);
  assert.equal(today.source, 'none');
  assert.equal(today.setup, undefined);
  assert.equal(today.lastErrorKind, 'timeout');
});

test('yesterday’s meetings are never presented as Today', async (t) => {
  const f = await fixture(t, { runner: async () => calendar() });
  await f.request('/today/refresh', 'POST'); await f.idle();
  f.advance(24 * 60 * 60 * 1000);
  const today = await (await f.request('/today')).json();
  assert.equal(today.source, 'none');
  assert.deepEqual(today.events, []);
  assert.ok(today.setup.steps[0].includes('Refresh'));
});

test('follow-up CRUD preserves quotes verbatim and refuses retention/sent metadata overrides', async (t) => {
  const f = await fixture(t);
  const quote = '  I’ll take it.\nDue Friday, "after lunch".  ';
  const item = await save(f, { quote });
  assert.equal(item.quote, quote);
  assert.equal(item.expiresAt, T0 + RETENTION_MS);
  const patch = await f.request(`/followups/${item.id}`, 'PATCH', { owner: 'Me', due: 'Friday', quote });
  assert.equal((await patch.json()).owner, 'Me');
  assert.equal((await f.request(`/followups/${item.id}`, 'PATCH', { expiresAt: 999 })).status, 400);
  assert.equal((await f.request('/followups', 'POST', { quote, sentAt: T0 })).status, 400);
  assert.equal((await f.request(`/followups/${item.id}`, 'DELETE')).status, 200);
  assert.deepEqual((await (await f.request('/followups')).json()).followups, []);
  assert.equal((await f.request(`/followups/${item.id}`, 'PATCH', { owner: 'Other' })).status, 404);
});

test('seven-day expiry deletes unsent records but preserves successful handoffs', async (t) => {
  const f = await fixture(t);
  const unsent = await save(f);
  const sent = await save(f);
  assert.equal((await f.request(`/followups/${sent.id}/send`, 'POST', { session: 'claude-work' })).status, 200);
  f.advance(RETENTION_MS);
  const items = (await (await f.request('/followups')).json()).followups;
  assert.deepEqual(items.map((item: Followup) => item.id), [sent.id]);
  const stored = await readFile(join(f.dir, 'data.json'), 'utf8');
  assert.ok(!stored.includes(unsent.id));
  assert.equal((await f.request(`/followups/${unsent.id}/send`, 'POST', { session: 'claude-work' })).status, 404);
});

test('handoff sends the required prompt once, records its session, and never runs connectors', async (t) => {
  const f = await fixture(t, { runner: async () => { assert.fail('Unexpected connector invocation'); } });
  const item = await save(f);
  await f.request(`/followups/${item.id}`, 'PATCH', { owner: 'Me', due: 'Friday' });
  assert.equal((await f.request(`/followups/${item.id}/send`, 'POST', { session: 'claude-work' })).status, 200);
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].prompt.includes(item.quote));
  assert.ok(f.sent[0].prompt.includes('"owner":"Me"'));
  assert.ok(f.sent[0].prompt.includes('"due":"Friday"'));
  assert.ok(f.sent[0].prompt.includes('Draft this as a task/follow-up in the tool I normally use; ask me before sending or creating anything.'));
  assert.equal((await f.request(`/followups/${item.id}/send`, 'POST', { session: 'claude-work' })).status, 409);
  assert.equal((await (await f.request('/followups')).json()).followups[0].sentTo, 'claude-work');
});

test('failed handoff is not marked sent; simultaneous handoff/edit/delete cannot duplicate or change it', async (t) => {
  const pending = deferred<void>();
  const entered = deferred<void>();
  const f = await fixture(t, { sendPrompt: async () => { entered.resolve(); return pending.promise; } });
  const item = await save(f);
  const request = f.request(`/followups/${item.id}/send`, 'POST', { session: 'claude-work' });
  await entered.promise;
  assert.equal((await f.request(`/followups/${item.id}/send`, 'POST', { session: 'claude-work' })).status, 409);
  assert.equal((await f.request(`/followups/${item.id}`, 'PATCH', { quote: 'replacement' })).status, 409);
  assert.equal((await f.request(`/followups/${item.id}`, 'DELETE')).status, 409);
  pending.reject(new Error('tmux failure'));
  assert.equal((await request).status, 500);
  assert.equal((await (await f.request('/followups')).json()).followups[0].sentAt, undefined);
});

test('connections parse only statuses, never persist endpoint URLs or tokens', () => {
  const list = parseConnections('Checking MCP server health...\nclaude.ai Google Calendar: https://private/?token=SECRET - ✓ Connected\nclaude.ai Slack: https://private/ - ! Needs authentication\nclaude.ai IRIS: https://private/ - ✗ Failed to connect');
  assert.equal(list.find((c) => c.id === 'google_calendar')?.status, 'connected');
  assert.equal(list.find((c) => c.id === 'slack')?.status, 'needs_auth');
  assert.equal(list.find((c) => c.id === 'iris')?.status, 'needs_auth');
  assert.equal(list.find((c) => c.id === 'gmail')?.status, 'not_configured');
  assert.ok(!JSON.stringify(list).includes('SECRET'));
  assert.throws(() => parseConnections('Please log in to Claude first'));
});

test('connection reads are nonblocking, cache ten minutes, and support Check again', async (t) => {
  let calls = 0;
  let pending = deferred<string>();
  const f = await fixture(t, { runner: async (args) => {
    if (args[0] !== 'mcp') return calendar(); // Check again also refreshes the sign-in probe.
    assert.deepEqual(args, ['mcp', 'list']); calls++; return pending.promise;
  } });
  const initial = await (await f.request('/connections')).json();
  assert.equal(initial.updatedAt, null);
  assert.ok(initial.connections.length);
  await nextTurn();
  pending.resolve('Google Calendar: https://example.invalid - Connected'); await f.idle();
  await f.request('/connections'); await f.request('/connections');
  assert.equal(calls, 1);
  assert.equal((await (await f.request('/connections')).json()).updatedAt, T0);
  f.advance(CONNECTIONS_TTL_MS);
  pending = deferred();
  await f.request('/connections');
  pending.resolve('No MCP servers configured.'); await f.idle();
  assert.equal(calls, 2);
  await f.request('/connections?refresh=1'); await f.idle();
  assert.equal(calls, 3);
});

test('field-test logging is append-only metadata, exports escaped CSV, and rejects audio/transcript', async (t) => {
  const f = await fixture(t);
  const event = { sessionId: 'session-1', kind: 'cue_shown', cueId: 'cue-1', at: T0, lastWordAt: T0 - 100, candidateAt: T0 - 50, renderedAt: T0, category: 'owner' };
  assert.equal((await f.request('/fieldtest', 'POST', { events: [event] })).status, 200);
  assert.equal((await f.request('/fieldtest', 'POST', { events: [{ sessionId: 's', kind: 'cue_retracted', at: T0, reason: '=HYPERLINK("bad"),\nline' }] })).status, 200);
  const response = await f.request('/fieldtest.csv');
  assert.match(response.headers.get('content-type')!, /text\/csv/);
  const csv = await response.text();
  assert.ok(csv.startsWith('sessionId,cueId,kind,lastWordAt,candidateAt,renderedAt,category,rating,reason,at\r\n'));
  assert.ok(csv.includes('"session-1"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad""),\nline"'));
  for (const extra of [{ audio: [1, 2] }, { transcript: 'private' }, { quote: 'private' }]) {
    assert.equal((await f.request('/fieldtest', 'POST', { events: [{ ...event, ...extra }] })).status, 400);
  }
  assert.equal((await f.request('/fieldtest', 'POST', { events: [{ ...event, at: 'now' }] })).status, 400);
  assert.equal((await f.store.read()).fieldtest.length, 2);
});

test('delete all cancels jobs and late results cannot resurrect any stored data', async (t) => {
  const entered = deferred<void>();
  const pending = deferred<string>();
  let signal: AbortSignal | undefined;
  const f = await fixture(t, { runner: async (_, opts) => { signal = opts.signal; entered.resolve(); return pending.promise; } });
  await save(f);
  await f.request('/objective', 'PUT', { eventId: 'a', objective: 'secret' });
  await f.request('/fieldtest', 'POST', { events: [{ sessionId: 's', kind: 'session_start', at: T0 }] });
  await f.request('/today/refresh', 'POST'); await entered.promise;
  assert.equal((await f.request('/data', 'DELETE')).status, 200);
  assert.equal(signal?.aborted, true);
  pending.resolve(calendar()); await nextTurn();
  assert.deepEqual(await readdir(f.dir), []);
  assert.deepEqual((await (await f.request('/followups')).json()).followups, []);
  assert.deepEqual((await (await f.request('/today')).json()).events, []);
  await f.request('/connections'); await nextTurn();
  assert.deepEqual(await readdir(f.dir), []);
  await f.request('/today/refresh', 'POST'); await f.idle();
  assert.equal((await (await f.request('/today')).json()).source, 'calendar');
});

test('delete all during a handoff never recreates its deleted quote', async (t) => {
  const entered = deferred<void>(); const pending = deferred<void>();
  const f = await fixture(t, { sendPrompt: async () => { entered.resolve(); return pending.promise; } });
  const item = await save(f);
  const send = f.request(`/followups/${item.id}/send`, 'POST', { session: 'claude-work' });
  await entered.promise; await f.request('/data', 'DELETE'); pending.resolve();
  assert.equal((await send).status, 409);
  assert.deepEqual(await readdir(f.dir), []);
});

test('atomic serialized persistence survives concurrent writes and a new module', async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 15 }, (_, i) => save(f, { quote: `Saved quote ${i}` })));
  const another = new FieldglassStore(f.dir);
  assert.equal((await another.read()).followups.length, 15);
  assert.deepEqual(await readdir(f.dir), ['data.json']);
  assert.equal((await stat(join(f.dir, 'data.json'))).mode & 0o777, 0o600);
  await f.request('/objective', 'PUT', { eventId: '__proto__', objective: 'safe opaque ID' });
  assert.equal(Object.getOwnPropertyDescriptor((await another.read()).objectives, '__proto__')?.value, 'safe opaque ID');
});

test('configured directory override works and delete leaves unrelated files alone', async (t) => {
  const f = await fixture(t);
  const before = process.env.HEADLENSS_FIELDGLASS_DIR;
  process.env.HEADLENSS_FIELDGLASS_DIR = f.dir;
  try { assert.equal(new FieldglassStore().dir, f.dir); }
  finally { if (before === undefined) delete process.env.HEADLENSS_FIELDGLASS_DIR; else process.env.HEADLENSS_FIELDGLASS_DIR = before; }
  await writeFile(join(f.dir, 'unrelated.txt'), 'keep');
  await writeFile(join(f.dir, '.data-11111111-1111-1111-1111-111111111111.tmp'), 'interrupted saved data');
  await save(f); await f.request('/data', 'DELETE');
  assert.deepEqual(await readdir(f.dir), ['unrelated.txt']);
});

test('invalid JSON, unexpected fields, oversized requests and invalid sessions are rejected', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.app.request('/api/fieldglass/followups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })).status, 400);
  assert.equal((await f.request('/followups', 'POST', { quote: ' ' })).status, 400);
  assert.equal((await f.request('/followups', 'POST', { quote: 'x'.repeat(140_000) })).status, 413);
  assert.equal((await f.request('/objective', 'PUT', { eventId: 'a', objective: false })).status, 400);
  const item = await save(f);
  assert.equal((await f.request(`/followups/${item.id}/send`, 'POST', { session: 'invalid\nsession' })).status, 400);
  assert.equal(f.sent.length, 0);
});

test('startup schedules cache jobs and retention without waiting for connectors', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calendarCalls = 0; let connectionCalls = 0;
  const f = await fixture(t, { runner: async (args) => {
    if (args[0] === 'mcp') connectionCalls++; else calendarCalls++;
    return noProviders(args, { signal: new AbortController().signal, cwd: '/unused' });
  } });
  const expired = await save(f); f.advance(RETENTION_MS);
  f.start(); f.start(); await f.idle();
  assert.equal((await f.store.read()).followups.some((item) => item.id === expired.id), false);
  assert.equal((await f.store.read()).connections.updatedAt, T0 + RETENTION_MS);
  assert.equal(calendarCalls, 1); assert.equal(connectionCalls, 1);
  f.advance(CALENDAR_REFRESH_MS); t.mock.timers.tick(CALENDAR_REFRESH_MS); await f.idle();
  assert.equal(calendarCalls, 2); assert.equal(connectionCalls, 2);
});

test('corrupt storage is reported without overwriting the user’s file', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'data.json'), '{corrupt');
  assert.equal((await f.request('/followups')).status, 500);
  assert.equal((await f.request('/followups', 'POST', { quote: 'do not overwrite' })).status, 500);
  assert.equal(await readFile(join(f.dir, 'data.json'), 'utf8'), '{corrupt');
});

test('production mount hands off through the existing input route and rejects non-Claude/blocked sessions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'headlenss-fieldglass-mount-'));
  const app = new Hono();
  let source = 'claude'; let blocked = false; let inputStatus: 200 | 409 = 200;
  const targetName = 'headlenss-feat-fieldglass-review-claude';
  const received: unknown[] = [];
  app.get('/api/claude/sessions', (c) => c.json({ sessions: [{ tmuxSessionName: targetName, source, status: blocked ? 'waiting-permission' : 'idle' }] }));
  app.post('/api/sessions/:name/input', async (c) => { assert.equal(c.req.param('name'), targetName); received.push(await c.req.json()); return c.json({ ok: inputStatus === 200 }, inputStatus); });
  const module = mountFieldglass(app, { dir, runner: noProviders, now: () => T0, listSessions: async () => [{ name: targetName }] });
  t.after(async () => { module.stop(); await module.idle(); await rm(dir, { recursive: true, force: true }); });
  await module.idle();
  const create = await app.request('/api/fieldglass/followups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"quote":"Exact words","meetingTitle":"Standup"}' });
  const item = await create.json() as Followup;
  const send = (session = targetName) => app.request(`/api/fieldglass/followups/${item.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session }) });
  assert.equal((await send('unlisted-session')).status, 404);
  source = 'codex'; assert.equal((await send()).status, 404);
  source = 'claude'; blocked = true; assert.equal((await send()).status, 409);
  assert.equal(received.length, 0);
  blocked = false; inputStatus = 409; assert.equal((await send()).status, 409);
  assert.equal((await module.store.read()).followups[0].sentAt, undefined);
  inputStatus = 200; assert.equal((await send()).status, 200);
  assert.equal((received[1] as { submit: boolean }).submit, true);
  assert.ok((received[1] as { text: string }).text.includes('"meetingTitle":"Standup"'));
});

test('Amendment 1: Google transport Connected is not a sign-in probe', async (t) => {
  const f = await fixture(t, { runner: async () => 'Google Calendar: https://example.invalid - Connected\nGmail: https://example.invalid - Connected\nGoogle Drive: https://example.invalid - Connected' });
  await f.request('/connections'); await f.idle();
  const result = await (await f.request('/connections')).json();
  for (const id of ['google_calendar', 'gmail', 'google_drive']) {
    const connection = result.connections.find((c: { id: string }) => c.id === id);
    assert.equal(connection.status, 'needs_auth');
    assert.match(connection.steps[0], /not been verified/);
  }
});

test('Amendment 1: auth-only Google tools produce needs_auth while Notion supplies Today', async (t) => {
  const output = JSON.stringify({
    source: 'calendar', lastSource: 'notion', lastError: "Google Calendar isn't signed in.", googleSignedIn: false,
    googleTools: { google_calendar: ['authenticate', 'complete_authentication'], gmail: ['authenticate'], google_drive: ['list_files'] },
    events: [{ id: 'notion:event-1', start: '11:00', end: '12:00', title: 'Planning' }],
  });
  const f = await fixture(t, { runner: async (args) => args[0] === 'mcp'
    ? 'Google Calendar: https://example.invalid - Connected\nGmail: https://example.invalid - Connected\nGoogle Drive: https://example.invalid - Connected' : output });
  f.start(); await f.idle();
  const today = await (await f.request('/today')).json();
  assert.equal(today.source, 'calendar');
  assert.equal(today.lastSource, 'notion');
  assert.equal(today.lastError, "[auth] Google Calendar isn't signed in.");
  assert.equal(today.lastErrorKind, 'auth');
  assert.equal(today.events[0].id, 'notion:event-1');
  assert.deepEqual(today.setup.steps, CALENDAR_SETUP.steps);
  assert.deepEqual(CALENDAR_SETUP.steps, [
    'On your Mac, open claude.ai in a browser and sign in.', 'Go to Settings → Connectors.',
    'Find Google Calendar and click Connect, then approve with your Google account.', 'Come back here and tap Check again.',
    "Or add today's meetings by hand below — no setup needed.",
  ]);
  const result = await (await f.request('/connections')).json();
  assert.equal(result.connections.find((c: { id: string }) => c.id === 'google_calendar').status, 'needs_auth');
  assert.equal(result.connections.find((c: { id: string }) => c.id === 'gmail').status, 'needs_auth');
  assert.equal(result.connections.find((c: { id: string }) => c.id === 'google_drive').status, 'connected');
  const persisted = await new FieldglassStore(f.dir).read();
  assert.equal(persisted.lastSource, 'notion');
  assert.equal(persisted.calendar.lastError, today.lastError);
});

test('Amendment 1: last-job sign-in failure overrides Connected; a verified success clears it', async (t) => {
  let output = JSON.stringify({ source: 'calendar', events: [], lastError: 'Google Calendar is not actually signed in.' });
  const f = await fixture(t, { runner: async (args) => args[0] === 'mcp' ? 'Google Calendar: endpoint - Connected' : output });
  f.start(); await f.idle();
  let today = await (await f.request('/today')).json();
  assert.equal(today.source, 'none');
  assert.equal(today.lastSource, 'none');
  assert.equal((await (await f.request('/connections')).json()).connections.find((c: { id: string }) => c.id === 'google_calendar').status, 'needs_auth');
  output = calendar();
  await f.request('/connections?refresh=1'); await f.idle();
  today = await (await f.request('/today')).json();
  assert.equal(today.lastSource, 'google');
  assert.equal(today.lastError, undefined);
  assert.equal((await (await f.request('/connections')).json()).connections.find((c: { id: string }) => c.id === 'google_calendar').status, 'connected');
});

test('Amendment 1: the default job deadline is twelve minutes and includes its probe/fallback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred<void>();
  let calls = 0; let signal: AbortSignal | undefined;
  const f = await fixture(t, { runner: async (_, options) => { calls++; signal = options.signal; entered.resolve(); return new Promise(() => {}); } });
  await f.request('/today/refresh', 'POST'); await entered.promise;
  await f.request('/today/refresh', 'POST');
  let finished = false;
  const completion = f.idle().then(() => { finished = true; });
  t.mock.timers.tick(11 * 60 * 1000); await nextTurn();
  assert.equal(finished, false); assert.equal(signal?.aborted, false);
  assert.equal(calls, 1);
  t.mock.timers.tick(60 * 1000); await completion;
  assert.equal(signal?.aborted, true);
  assert.equal(CALENDAR_TIMEOUT_MS, 12 * 60 * 1000);
  const today = await (await f.request('/today')).json();
  assert.equal(today.refreshing, false);
  assert.match(today.lastError, /timed out after 12 minutes/);
});

test('Amendment 1: manual meetings merge chronologically and objectives survive refresh/reload', async (t) => {
  const f = await fixture(t, { runner: async () => calendar() });
  const add = await f.request('/today/manual', 'POST', { start: '09:00', end: '09:30', title: 'Manual standup', objective: 'Original objective' });
  assert.equal(add.status, 201);
  const manual = await add.json();
  assert.match(manual.id, /^manual-/);
  let today = await (await f.request('/today')).json();
  assert.equal(today.source, 'manual'); assert.equal(today.lastSource, 'manual');
  assert.equal((await f.store.read()).lastSource, 'manual');
  assert.equal(today.events[0].objective, 'Original objective');
  await f.request('/objective', 'PUT', { eventId: manual.id, objective: 'Updated objective' });
  await f.request('/today/manual', 'POST', { start: '11:30', end: '12:00', title: 'Late meeting' });
  await f.request('/today/refresh', 'POST'); await f.idle();
  today = await (await f.request('/today')).json();
  assert.equal(today.source, 'calendar'); assert.equal(today.lastSource, 'google');
  assert.deepEqual(today.events.map((e: { start: string }) => e.start), ['09:00', '10:00', '11:30']);
  assert.equal(today.events[0].objective, 'Updated objective');
  assert.equal(today.events[0].day, undefined);
  const persisted = await new FieldglassStore(f.dir).read();
  assert.equal(persisted.manualEvents.length, 2);
  assert.equal(persisted.objectives[manual.id], 'Updated objective');
  await f.request('/today/refresh', 'POST'); await f.idle();
  assert.equal((await (await f.request('/today')).json()).events[0].objective, 'Updated objective');
  assert.equal((await f.request(`/today/manual/${manual.id}`, 'DELETE')).status, 200);
  assert.equal((await f.store.read()).objectives[manual.id], undefined);
  assert.equal((await f.request('/today/manual/calendar:event:instance', 'DELETE')).status, 404);
  f.advance(24 * 60 * 60 * 1000);
  assert.deepEqual((await (await f.request('/today')).json()).events, []);
});

test('Amendment 1: manual fallback remains usable when both providers fail and is deleted by privacy reset', async (t) => {
  const f = await fixture(t, { runner: async () => JSON.stringify({ source: 'none', lastSource: 'none', lastError: 'Google Calendar needs authentication; Notion Calendar is unavailable.', googleSignedIn: false, events: [] }) });
  await f.request('/today/manual', 'POST', { start: '14:00', end: '15:00', title: 'Saved by hand', objective: 'Choose a plan' });
  await f.request('/today/refresh', 'POST'); await f.idle();
  const today = await (await f.request('/today')).json();
  assert.equal(today.source, 'manual'); assert.equal(today.lastSource, 'manual');
  assert.equal(today.events.length, 1);
  assert.match(today.lastError, /Notion Calendar is unavailable/);
  assert.equal((await f.store.read()).lastSource, 'manual');
  await f.request('/data', 'DELETE');
  assert.deepEqual(await readdir(f.dir), []);
  assert.deepEqual((await (await f.request('/today')).json()).events, []);
  assert.equal((await (await f.request('/today')).json()).lastError, undefined);
});

test('Amendment 1: invalid manual events cannot create server data', async (t) => {
  const f = await fixture(t);
  for (const fields of [
    { start: '25:00', end: '11:00', title: 'Invalid hour' },
    { start: '10:00', end: '11:60', title: 'Invalid minute' },
    { start: '10:00', end: '11:00', title: '' },
    { start: '10:00', end: '11:00', title: 'Title', transcript: 'private' },
  ]) assert.equal((await f.request('/today/manual', 'POST', fields)).status, 400);
  assert.deepEqual(await readdir(f.dir), []);
});
