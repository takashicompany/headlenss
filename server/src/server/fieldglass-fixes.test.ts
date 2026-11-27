import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Hono } from 'hono';
import * as providers from './fieldglass/providers.ts';
import { createFieldglassModule, followupPrompt } from './fieldglass/router.ts';

const event = { id: 'event-1', start: '10:00', end: '11:00', title: 'A title with [brackets] and "quotes"' };
const valid = JSON.stringify({ source: 'calendar', lastSource: 'google', events: [event] });
const atHour = (hour: number, minute = 0) => new Date(2026, 10, 26, hour, minute).getTime();
const HALF_HOUR = 30 * 60 * 1000;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext, runner: providers.CommandRunner, initial = atHour(9)) {
  const dir = await mkdtemp(join(tmpdir(), 'fieldglass-fix-'));
  let time = initial;
  const sent: { session: string; prompt: string }[] = [];
  const module = createFieldglassModule({ dir, now: () => time, runner,
    sendPrompt: async (session, prompt) => { sent.push({ session, prompt }); } });
  const app = new Hono().route('/api/fieldglass', module.router);
  t.after(async () => { module.stop(); await module.idle(); await rm(dir, { recursive: true, force: true }); });
  const request = (path: string, method = 'GET', data?: unknown) => app.request(`/api/fieldglass${path}`, {
    method, ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
  });
  return { ...module, sent, request, setTime: (value: number) => { time = value; }, advance: (ms: number) => { time += ms; } };
}

test('fix #1: extract fenced/prefaced event arrays from result text; do not invent Google provenance', () => {
  for (const result of [
    `Here are your events:\n\`\`\`json\n${JSON.stringify([event])}\n\`\`\`\nDone.`,
    `Calendar results:\n${JSON.stringify([event])}\nNo other events.`,
    `For calendars ["work"], the events are:\n${JSON.stringify([event])}`,
  ]) {
    const parsed = providers.parseCalendar(JSON.stringify({ type: 'result', result }));
    assert.deepEqual(parsed.events, [event]);
    assert.equal(parsed.lastSource, 'none');
    assert.equal(parsed.googleProbes.google_calendar, undefined);
  }
  assert.equal(providers.parseCalendar(`Here is the JSON:\n\`\`\`json\n${valid}\n\`\`\``).events.length, 1);
});

test('fix #1: one invalid/duplicate event does not discard validated events', () => {
  const parsed = providers.parseCalendar(JSON.stringify({ type: 'result', result: JSON.stringify({
    source: 'calendar', lastSource: 'notion', events: [event, { ...event, id: 'bad', start: '25:00' }, event, null],
  }) }));
  assert.deepEqual(parsed.events, [event]);
  assert.match(parsed.lastError ?? '', /3.*invalid|invalid.*3/i);
  assert.throws(() => providers.parseCalendar(JSON.stringify([{ ...event, start: '25:00' }])), /valid|event/i);
  assert.throws(() => providers.parseCalendar('No JSON here'), /JSON|parse/i);
});

test('fix #2: automatic calendar failures back off, success resets, and explicit Refresh bypasses backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0; let output = '{"source":"none","events":[],"lastError":"Both calendar providers are unavailable."}';
  const f = await fixture(t, async (args) => {
    if (args[0] === 'mcp') return 'No MCP servers configured.';
    calls++; return output;
  });
  f.start(); await f.idle(); assert.equal(calls, 1);
  f.advance(HALF_HOUR); t.mock.timers.tick(HALF_HOUR); await f.idle(); assert.equal(calls, 2);
  f.advance(HALF_HOUR); t.mock.timers.tick(HALF_HOUR); await f.idle(); assert.equal(calls, 2, 'second failure must back off for an hour');
  await f.request('/today/refresh', 'POST'); await f.idle(); assert.equal(calls, 3);
  output = valid;
  await f.request('/today/refresh', 'POST'); await f.idle(); assert.equal(calls, 4);
  f.advance(HALF_HOUR); t.mock.timers.tick(HALF_HOUR); await f.idle(); assert.equal(calls, 5);
});

test('fix #2: confirmed sign-in failure suspends timed calendar jobs until an explicit retry', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const f = await fixture(t, async (args) => {
    if (args[0] === 'mcp') return 'Google Calendar: endpoint - Connected';
    calls++; return '{"source":"none","events":[],"googleSignedIn":false}';
  });
  f.start(); await f.idle(); assert.equal(calls, 1);
  f.advance(4 * HALF_HOUR); t.mock.timers.tick(4 * HALF_HOUR); await f.idle(); assert.equal(calls, 1);
  await f.request('/connections?refresh=1'); await f.idle(); assert.equal(calls, 2);
});

test('fix #2: automatic work runs only 06:00–22:00 local; deliberate refresh remains available', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls: string[] = [];
  const f = await fixture(t, async (args) => { calls.push(args[0]); return args[0] === 'mcp' ? 'No MCP servers configured.' : valid; }, atHour(5, 30));
  f.start(); await f.idle(); assert.equal(calls.length, 0);
  f.setTime(atHour(6)); t.mock.timers.tick(HALF_HOUR); await f.idle(); assert.ok(calls.includes('-p'));
  const beforeNight = calls.length;
  f.setTime(atHour(22)); t.mock.timers.tick(HALF_HOUR); await f.idle(); assert.equal(calls.length, beforeNight);
  await f.request('/today/refresh', 'POST'); await f.idle(); assert.equal(calls.length, beforeNight + 1);
});

test('fix #5: handoff contains one physical line and JSON preserves every original quote character', () => {
  const quote = 'First line\r\nSecond\tline / literal \\n and "quoted"\u2028text';
  const prompt = followupPrompt({ id: 'x', quote, owner: 'Me\nagain', due: 'Friday', meetingTitle: 'A\rB', createdAt: 0, expiresAt: 1 });
  assert.doesNotMatch(prompt, /[\r\n\t\u2028\u2029]/);
  const encoded = JSON.stringify({ quote, owner: 'Me\nagain', due: 'Friday', meetingTitle: 'A\rB' }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  assert.ok(prompt.includes(encoded));
  assert.equal(JSON.parse(encoded).quote, quote);
  assert.match(prompt, /ask me before sending or creating anything/);
});

test('fix #6 corrected by round 3: names unsupported by sendKeys fail before handoff', async (t) => {
  const f = await fixture(t, async () => valid);
  for (const session of ['headlenss-feat-fieldglass-review-claude-with-a-long-suffix', '会議フォローアップ 日本語']) {
    const created = await (await f.request('/followups', 'POST', { quote: 'Saved words' })).json();
    assert.equal((await f.request(`/followups/${created.id}/send`, 'POST', { session })).status, 400);
    assert.equal(f.sent.length, 0);
  }
});

test('fix #7: startup and concurrent Check again serialize all Claude jobs, connections first', async (t) => {
  const connection = deferred<string>(); const calendar = deferred<string>(); const entered = deferred<void>();
  const calls: string[] = []; let active = 0; let maximum = 0;
  const f = await fixture(t, async (args) => {
    active++; maximum = Math.max(maximum, active); calls.push(args[0]); entered.resolve();
    try { return await (args[0] === 'mcp' ? connection.promise : calendar.promise); } finally { active--; }
  });
  f.start(); await entered.promise;
  await f.request('/connections?refresh=1');
  await f.request('/today/refresh', 'POST');
  await nextTurn();
  assert.deepEqual(calls, ['mcp']);
  connection.resolve('No MCP servers configured.'); calendar.resolve(valid); await f.idle();
  assert.deepEqual(calls, ['mcp', '-p']); assert.equal(maximum, 1);
});

test('fix #8: CLI, parse, validation and provider failures stay distinct, without false sign-in setup', async (t) => {
  const fixtures: [string, providers.CommandRunner][] = [
    ['cli', async () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', stderr: 'claude unavailable on PATH' }); }],
    ['parse', async () => 'No JSON here'],
    ['validation', async () => JSON.stringify({ source: 'calendar', events: [{ ...event, start: '25:00' }] })],
    ['unavailable', async () => '{"source":"none","events":[],"lastError":"Neither calendar provider is available."}'],
  ];
  for (const [kind, runner] of fixtures) {
    const f = await fixture(t, runner);
    await f.request('/today/refresh', 'POST'); await f.idle();
    const today = await (await f.request('/today')).json();
    assert.equal(today.lastErrorKind, kind);
    assert.match(today.lastError, new RegExp(`^\\[${kind}\\]`));
    assert.equal(today.setup, undefined);
    if (kind === 'cli') { assert.match(today.lastError, /ENOENT/); assert.match(today.lastError, /claude unavailable on PATH/); }
  }
});

test('fix #8: CLI wrapper retains bounded, redacted stderr; never prints its command/prompt', async () => {
  const makeRunner = (providers as unknown as { createClaudeRunner?: (execute: () => Promise<never>) => providers.CommandRunner }).createClaudeRunner;
  assert.equal(typeof makeRunner, 'function');
  const runner = makeRunner!(async () => { throw Object.assign(new Error('command contains PRIVATE_PROMPT'), {
    code: 2, stderr: 'unknown option\nAuthorization: Bearer SUPERSECRET\napi_key=OTHERSECRET https://secret.example/path?token=URLSECRET ' + 'x'.repeat(500),
  }); });
  await assert.rejects(runner([], { cwd: '/unused', signal: new AbortController().signal }), (error: unknown) => {
    const message = String((error as Error).message);
    assert.match(message, /cli|exit 2/i); assert.match(message, /unknown option/);
    assert.doesNotMatch(message, /SUPERSECRET|OTHERSECRET|URLSECRET|PRIVATE_PROMPT/);
    assert.ok(message.length < 400); return true;
  });
});

test('fix #2: automatic failure backoff survives recreating the module', async (t) => {
  let calls = 0;
  const runner: providers.CommandRunner = async (args) => {
    if (args[0] === 'mcp') return 'No MCP servers configured.';
    calls++; return '{"source":"none","events":[]}';
  };
  const f = await fixture(t, runner);
  f.start(); await f.idle(); f.stop();
  const restarted = createFieldglassModule({ dir: f.store.dir, now: () => atHour(9, 5), runner, sendPrompt: async () => {} });
  t.after(async () => { restarted.stop(); await restarted.idle(); });
  restarted.start(); await restarted.idle();
  assert.equal(calls, 1);
});

test('fix #2/#7: a queued automatic calendar job rechecks local hours when its slot opens', async (t) => {
  const pending = deferred<string>(); const entered = deferred<void>();
  const calls: string[] = [];
  const f = await fixture(t, async (args) => {
    calls.push(args[0]); entered.resolve();
    return args[0] === 'mcp' ? pending.promise : valid;
  }, atHour(21, 59));
  f.start(); await entered.promise;
  f.setTime(atHour(22)); pending.resolve('No MCP servers configured.'); await f.idle();
  assert.deepEqual(calls, ['mcp']);
});

test('fix #7: Delete all cancels both running and queued kinds before a fresh explicit request', async (t) => {
  const entered = deferred<void>(); const pending = deferred<string>();
  const calls: string[] = [];
  const f = await fixture(t, async (args) => {
    calls.push(args[0]);
    if (args[0] === 'mcp') { entered.resolve(); return pending.promise; }
    return valid;
  });
  f.start(); await entered.promise;
  await f.request('/data', 'DELETE');
  pending.resolve('Google Calendar: endpoint - Connected');
  await f.request('/today/refresh', 'POST'); await f.idle();
  assert.deepEqual(calls, ['mcp', '-p']);
  assert.equal((await f.store.read()).connections.updatedAt, null);
  assert.equal((await (await f.request('/today')).json()).events.length, 1);
});

test('fix #8: parse failures retain a safe stderr excerpt and connection errors have diagnostics too', async (t) => {
  const f = await fixture(t, async (args) => {
    if (args[0] === 'mcp') throw Object.assign(new Error('do not disclose command'), { code: 2, stderr: 'unknown option\nsecret=HIDDEN' });
    return { stdout: 'No JSON here', stderr: 'truncated provider response\napi_key=HIDDEN' };
  });
  f.start(); await f.idle();
  const today = await (await f.request('/today')).json();
  assert.equal(today.lastErrorKind, 'parse');
  assert.match(today.lastError, /truncated provider response/);
  assert.doesNotMatch(today.lastError, /HIDDEN/);
  const connections = await (await f.request('/connections')).json();
  assert.equal(connections.lastErrorKind, 'cli');
  assert.match(connections.lastError, /unknown option/);
  assert.doesNotMatch(connections.lastError, /HIDDEN/);
});

const claudePaths = (home: string) => [
  join(home, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(home, '.claude/local/claude'),
];
const commandOptions = () => ({ cwd: '/fixture/work', signal: new AbortController().signal });

test('PATH hotfix: explicit Claude override is used verbatim and resolved only once', async () => {
  const binary = '/fixture/Claude tools/claude $(literal)';
  const env = { HOME: '/fixture/home', HEADLENSS_CLAUDE_BIN: binary };
  const calls: { file: string; args: string[] }[] = [];
  const options = commandOptions();
  const runner = providers.createClaudeRunner(async (file, args, receivedOptions) => {
    calls.push({ file, args });
    assert.equal(receivedOptions, options);
    return { stdout: 'injected' };
  }, { env, isExecutable: () => { assert.fail('explicit override must bypass discovery'); } });
  env.HEADLENSS_CLAUDE_BIN = '/fixture/changed';
  const calendar = providers.calendarArgs(atHour(9));
  const connections = ['mcp', 'list'];
  await runner(calendar, options);
  await runner(connections, options);
  assert.deepEqual(calls, [{ file: binary, args: calendar }, { file: binary, args: connections }]);
});

test('PATH hotfix: use the first executable in the required home and Homebrew search order', async () => {
  const paths = claudePaths('/fixture/home with spaces');
  for (let selected = 0; selected < paths.length; selected++) {
    const checked: string[] = [];
    const executed: string[] = [];
    const runner = providers.createClaudeRunner(async (file) => {
      executed.push(file);
      return { stdout: '' };
    }, { env: { HOME: '/fixture/home with spaces', PATH: '/usr/bin:/bin' }, isExecutable: (path) => {
      checked.push(path);
      return paths.indexOf(path) >= selected;
    } });
    await runner(['mcp', 'list'], commandOptions());
    await runner(providers.calendarArgs(atHour(9)), commandOptions());
    assert.deepEqual(executed, [paths[selected], paths[selected]]);
    assert.deepEqual(checked, paths.slice(0, selected + 1), 'discovery runs once, stops at the first executable');
  }
});

test('PATH hotfix: failed executable checks fall back to claude on PATH without repeated discovery', async () => {
  const paths = claudePaths('/fixture/home');
  const checked: string[] = [];
  const executed: string[] = [];
  let installedLater = false;
  const runner = providers.createClaudeRunner(async (file) => {
    executed.push(file);
    return { stdout: '' };
  }, { env: { HOME: '/fixture/home' }, isExecutable: (path) => {
    checked.push(path);
    if (path === paths[1]) throw Object.assign(new Error('injected inaccessible file'), { code: 'EACCES' });
    return installedLater;
  } });
  await runner(['mcp', 'list'], commandOptions());
  installedLater = true;
  await runner(providers.calendarArgs(atHour(9)), commandOptions());
  assert.deepEqual(executed, ['claude', 'claude']);
  assert.deepEqual(checked, paths);
});

test('PATH hotfix: both background job kinds use the one resolved binary with a LaunchAgent PATH', async (t) => {
  const home = '/fixture/home';
  const binary = claudePaths(home)[0];
  const checked: string[] = [];
  const calls: { file: string; kind: string }[] = [];
  const runner = providers.createClaudeRunner(async (file, args) => {
    calls.push({ file, kind: args[0] });
    return { stdout: args[0] === 'mcp' ? 'No MCP servers configured.' : valid };
  }, { env: { HOME: home, PATH: '/usr/bin:/bin' }, isExecutable: (path) => {
    checked.push(path);
    return path === binary;
  } });
  const f = await fixture(t, runner);
  f.start();
  await f.idle();
  assert.deepEqual(calls, [{ file: binary, kind: 'mcp' }, { file: binary, kind: '-p' }]);
  assert.deepEqual(checked, [binary]);
  assert.equal((await (await f.request('/today')).json()).events.length, 1);
});

test('PATH hotfix: ENOENT keeps its message and lists only attempted paths, never the prompt', async (t) => {
  const home = '/fixture/home';
  const paths = claudePaths(home);
  for (const mode of ['fallback', 'selected', 'override'] as const) {
    const override = '/fixture/custom claude';
    const env = { HOME: home, ...(mode === 'override' ? { HEADLENSS_CLAUDE_BIN: override } : {}) };
    const runner = providers.createClaudeRunner(async () => {
      throw Object.assign(new Error('spawn PRIVATE_PROMPT ENOENT'), { code: 'ENOENT', stderr: 'missing binary\nsecret=PRIVATE_SECRET' });
    }, { env, isExecutable: () => mode === 'selected' });
    const checkFailure = (error: unknown) => {
      const failure = error as { kind: string; message: string };
      assert.equal(failure.kind, 'cli');
      assert.ok(failure.message.includes('Claude executable was not found on PATH (ENOENT).'));
      assert.match(failure.message, /Tried:/);
      const tried = mode === 'override' ? [override] : mode === 'selected' ? paths.slice(0, 1) : paths;
      for (const path of tried) assert.ok(failure.message.includes(path), `diagnostic must include ${path}`);
      for (const path of paths.filter((path) => !tried.includes(path))) assert.ok(!failure.message.includes(path));
      assert.equal(failure.message.includes('claude (PATH)'), mode === 'fallback');
      assert.match(failure.message, /missing binary/);
      assert.doesNotMatch(failure.message, /PRIVATE_PROMPT|PRIVATE_SECRET/);
      return true;
    };
    await assert.rejects(runner(['-p', 'PRIVATE_PROMPT'], commandOptions()), checkFailure);
    const f = await fixture(t, runner);
    f.start();
    await f.idle();
    for (const path of ['/today', '/connections']) {
      const result = await (await f.request(path)).json();
      checkFailure({ kind: result.lastErrorKind, message: result.lastError });
    }
  }
});
