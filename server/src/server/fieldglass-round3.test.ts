import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Hono } from 'hono';
import { mountFieldglass } from './fieldglass/index.ts';
import { createFieldglassModule } from './fieldglass/router.ts';
import { defaultConnections, parseConnections } from './fieldglass/providers.ts';
import { validateName } from './tmux.ts';

const NOW = new Date(2026, 10, 26, 2).getTime(); // No automatic connector jobs.
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Execute the unmodified input handler and tmux module source. Only OS/pane
 * discovery and unrelated lock/delivery state are replaced. Importing index.ts
 * directly would start the production server, which this test must never do. */
async function inputHarness(app: Hono) {
  const commands: { file: string; args: string[] }[] = [];
  const execute = async (file: string, args: string[]) => {
    assert.equal(file, 'tmux');
    assert.ok(['capture-pane', 'send-keys'].includes(args[0]));
    commands.push({ file, args });
    return { stdout: 'Claude ready', stderr: '' };
  };
  const execFile = Object.assign(() => { throw new Error('Unexpected unpromisified OS call'); }, { [promisify.custom]: execute });
  const source = await readFile(new URL('./tmux.ts', import.meta.url), 'utf8');
  const transpile = (input: string) => ts.transpileModule(input, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as { sendKeys: (name: string, text: string, submit: boolean) => Promise<void>;
    captureOutput: (name: string, lines: number) => Promise<string> } };
  const dependencies: Record<string, unknown> = {
    'node:child_process': { execFile },
    'node:fs/promises': { mkdir: () => { throw new Error('Unexpected filesystem write'); } },
    'node:path': path, 'node:util': { promisify },
    './agent-pane.ts': { resolveAgentTarget: async () => '%42' },
    './claude/store.ts': { getSession: () => ({ source: 'claude' }) },
  };
  runInNewContext(transpile(source), { module, exports: module.exports, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected tmux dependency: ${name}`);
    return dependencies[name];
  }, process: { env: {} } });
  const server = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  const start = server.indexOf("app.post('/api/sessions/:name/input',");
  const end = server.indexOf('// ───────── Web UI', start);
  assert.ok(start >= 0 && end > start, 'actual input handler boundaries must be identifiable');
  let inputRequests = 0;
  app.use('/api/sessions/:name/input', async (_, next) => { inputRequests++; await next(); });
  runInNewContext(transpile(server.slice(start, end)), {
    app, ...module.exports, acquireTmuxLockWithWait: async () => true,
    claudeStore: { getSession: () => ({ source: 'claude' }), releaseRespondLock: () => {} },
    createDelivery: () => 'fixture-delivery', markDeliveryFailed: () => {}, markDeliveryInjected: () => {},
  });
  return { commands, inputRequests: () => inputRequests };
}

async function mounted(t: TestContext, names: string[]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fieldglass-round3-'));
  const app = new Hono();
  const transport = await inputHarness(app);
  let live = [...names];
  let listFailure = false;
  let listCalls = 0;
  app.get('/api/claude/sessions', (c) => c.json({ sessions: names.map((tmuxSessionName) => ({ tmuxSessionName, source: 'claude', status: 'idle' })) }));
  const options = { dir, now: () => NOW, runner: async () => { throw new Error('Unexpected connector job'); },
    listSessions: async () => { listCalls++; if (listFailure) throw new Error('Private process diagnostic'); return live.map((name) => ({ name })); },
  };
  const module = mountFieldglass(app, options);
  t.after(async () => { module.stop(); await module.idle(); await rm(dir, { recursive: true, force: true }); });
  const send = async (session: string) => {
    const item = await (await app.request('/api/fieldglass/followups', json({ quote: 'Exact saved words\n日本語' }))).json();
    return app.request(`/api/fieldglass/followups/${item.id}/send`, json({ session }));
  };
  return { ...module, ...transport, app, send, live: (value: string[]) => { live = value; },
    failList: () => { listFailure = true; }, listCalls: () => listCalls };
}

test('QA #1 / recheck #6: Fieldglass rejects exactly the unsupported tmux names before input handoff', async (t) => {
  const names = ['a'.repeat(41), 'qa-dummy-codex-日本語', '会議フォローアップ 日本語', 'qa space', 'qa:1', 'qa.1'];
  const f = await mounted(t, names);
  for (const name of names) {
    assert.throws(() => validateName(name), /invalid session name/);
    const direct = await f.app.request(`/api/sessions/${encodeURIComponent(name)}/input`, json({ text: 'Fixture only', submit: true }));
    assert.equal(direct.status, 400, 'actual input handler and sendKeys reject this name');
    const before = f.inputRequests();
    const response = await f.send(name);
    assert.equal(response.status, 400, 'Fieldglass must reject locally rather than convert input validation into 502');
    assert.equal(f.inputRequests(), before);
  }
  assert.deepEqual(f.commands, [], 'no OS command was invoked');
  assert.ok((await f.store.read()).followups.every((item) => item.sentAt === undefined));
});

test('QA #1: supported 40-character names reach real sendKeys as literal argv after live-list validation', async (t) => {
  const name = 'qa_' + 'a'.repeat(37);
  validateName(name);
  const f = await mounted(t, [name]);
  assert.equal((await f.send(name)).status, 200);
  assert.equal(f.listCalls(), 1, 'mount must query the real tmux session list via its injectable reader');
  assert.equal(f.commands.length, 3); // capture, literal prompt, Enter
  assert.equal(f.commands[1].args[0], 'send-keys');
  assert.deepEqual(Array.from(f.commands[1].args.slice(1, 4)), ['-t', '%42', '-l']);
  assert.ok(f.commands[1].args[4].includes('Exact saved words\\n日本語'));
  assert.equal((await f.store.read()).followups[0].sentTo, name);
});

test('QA #1: stale tracked entries and tmux prefix matches cannot bypass exact live membership', async (t) => {
  const f = await mounted(t, ['qa-old', 'qa-prefix']);
  f.live(['qa-prefix-longer']);
  for (const name of ['qa-old', 'qa-prefix']) assert.equal((await f.send(name)).status, 404);
  assert.equal(f.inputRequests(), 0);
  assert.deepEqual(f.commands, []);
  assert.ok((await f.store.read()).followups.every((item) => item.sentAt === undefined));
});

test('QA #1: live session-list failure stops handoff without leaking process diagnostics', async (t) => {
  const f = await mounted(t, ['qa-active']);
  f.failList();
  const response = await f.send('qa-active');
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('Private process diagnostic'));
  assert.equal(f.inputRequests(), 0);
});

test('QA #3: manual end must be strictly later on the same day; rejected requests do not write', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fieldglass-interval-'));
  const module = createFieldglassModule({ dir, now: () => NOW, runner: async () => '', sendPrompt: async () => {} });
  t.after(async () => { module.stop(); await module.idle(); await rm(dir, { recursive: true, force: true }); });
  for (const [start, end] of [['16:00', '15:00'], ['10:00', '10:00'], ['23:30', '00:30']]) {
    const response = await module.router.request('/today/manual', json({ start, end, title: 'Invalid range', objective: 'Do not store' }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /end.*after.*start/i);
    assert.deepEqual(await readdir(dir), []);
  }
  for (const [start, end] of [['00:00', '00:01'], ['23:58', '23:59']]) {
    assert.equal((await module.router.request('/today/manual', json({ start, end, title: 'Valid range' }))).status, 201);
  }
  const before = await readFile(path.join(dir, 'data.json'), 'utf8');
  assert.equal((await module.router.request('/today/manual', json({ start: '09:00', end: '08:59', title: 'Invalid range' }))).status, 400);
  assert.equal(await readFile(path.join(dir, 'data.json'), 'utf8'), before);
});

test('QA #4: misleading MCP names remain unconfigured and retain setup directions', () => {
  const connections = parseConnections('Notion Backup: Connected\nSlack Archive: Connected\nFake Google Calendar: Connected\nNotionBackup: Connected\nS.l.a.c.k: Connected');
  assert.deepEqual(connections, defaultConnections());
});

test('QA #4: only explicit aliases match, regardless of misleading entries and their order', () => {
  for (const lines of [
    ['Notion Backup: Connected', 'Notion: Needs authentication', 'Slack Archive: Connected', 'claude.ai Slack: Failed to connect'],
    ['claude.ai Slack: Failed to connect', 'Slack Archive: Connected', 'Notion: Needs authentication', 'Notion Backup: Connected'],
  ]) {
    const result = parseConnections(lines.join('\n'));
    assert.equal(result.find((item) => item.id === 'notion')?.status, 'needs_auth');
    assert.equal(result.find((item) => item.id === 'slack')?.status, 'needs_auth');
  }
  const result = parseConnections('\x1b[32mclaude.ai Google Calendar\x1b[0m: https://fixture.invalid/ - ✓ Connected\nslack: Connected\ngoogle_drive: Connected\nmonday.com: Connected');
  for (const id of ['google_calendar', 'slack', 'google_drive', 'monday']) assert.equal(result.find((item) => item.id === id)?.status, 'connected');
  assert.ok(!JSON.stringify(result).includes('fixture.invalid'));
  assert.throws(() => parseConnections('Please log in to Claude first'));
  assert.deepEqual(parseConnections('No MCP servers configured.'), defaultConnections());
});
