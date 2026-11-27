import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCalendarError, csvToObjects, daysLeft, fmt, hhmmToMinutes, nextEventIndex, nextQuarter, parseCsv, summarizeFieldTest, validateManualEvent, toMs, unreadCount, preview, splitSteps } from './helpers.ts';
import { FIELDGLASS_STRINGS } from './strings.ts';

test('fmt fills placeholders and leaves unknown ones', () => {
  assert.equal(fmt('Sent to {session} at {time}', { session: 'ops', time: '10:00' }), 'Sent to ops at 10:00');
  assert.equal(fmt('{a} {b}', { a: 1 }), '1 {b}');
});

test('daysLeft rounds up and never goes negative', () => {
  const day = 86_400_000;
  assert.equal(daysLeft(7 * day, 0), 7);
  assert.equal(daysLeft(6 * day + 1, 0), 7);
  assert.equal(daysLeft(1, 0), 1);
  assert.equal(daysLeft(0, 5), 0);
});

test('hhmmToMinutes validates', () => {
  assert.equal(hhmmToMinutes('09:30'), 570);
  assert.equal(hhmmToMinutes('9:05'), 545);
  assert.equal(hhmmToMinutes('24:00'), null);
  assert.equal(hhmmToMinutes('soon'), null);
});

test('nextEventIndex picks ongoing or next, skips ended and malformed', () => {
  const events = [
    { start: '08:00', end: '08:30' },
    { start: 'x', end: 'y' },
    { start: '11:00', end: '12:00' },
    { start: '09:45', end: '10:15' },
  ];
  assert.equal(nextEventIndex(events, 9 * 60), 3);
  assert.equal(nextEventIndex(events, 10 * 60), 3); // ongoing
  assert.equal(nextEventIndex(events, 10 * 60 + 20), 2);
  assert.equal(nextEventIndex(events, 13 * 60), -1);
});

test('parseCsv handles quotes, commas, newlines, CRLF and trailing newline', () => {
  const csv = 'a,b,c\r\n1,"x, y","he said ""hi"""\n2,"multi\nline",\n';
  assert.deepEqual(parseCsv(csv), [
    ['a', 'b', 'c'],
    ['1', 'x, y', 'he said "hi"'],
    ['2', 'multi\nline', ''],
  ]);
  assert.deepEqual(parseCsv(''), []);
});

test('summarizeFieldTest computes counts and latency percentiles', () => {
  const header = 'sessionId,cueId,kind,lastWordAt,candidateAt,renderedAt,category,rating,reason,at';
  const lines = [
    's1,,session_start,,,,,,,1',
    's1,c1,cue_shown,1000,1300,2000,owner,,,2',
    's1,c2,cue_shown,5000,5200,6500,date,,,3',
    's1,c1,rated,,,,owner,useful,,4',
    's2,c3,cue_shown,0,100,,blocker,,,5', // no renderedAt: excluded from lens latency
    's2,c3,rated,,,,blocker,off,,6',
  ];
  const rows = csvToObjects(parseCsv([header, ...lines].join('\n')));
  const s = summarizeFieldTest(rows);
  assert.equal(s.sessions, 2);
  assert.equal(s.cuesShown, 3);
  assert.equal(s.useful, 1);
  assert.equal(s.offTarget, 1);
  assert.deepEqual(s.latency, { n: 2, median: 1000, p95: 1500 });
  assert.deepEqual(s.engine, { n: 3, median: 200, p95: 300 });
});

test('every Fieldglass string has en and ja, and placeholders match', () => {
  for (const [key, v] of Object.entries(FIELDGLASS_STRINGS)) {
    assert.ok(v.en.length > 0 && v.ja.length > 0, key);
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    assert.equal(ph(v.en), ph(v.ja), `placeholders differ for ${key}`);
  }
});

test('classifyCalendarError maps server messages to plain categories', () => {
  assert.equal(classifyCalendarError('Google Calendar is not signed in (only authenticate tools available)'), 'not_signed_in');
  assert.equal(classifyCalendarError('needs_auth'), 'not_signed_in');
  // codex's GOOGLE_AUTH_ERROR in server/src/server/fieldglass/providers.ts
  assert.equal(classifyCalendarError("Google Calendar isn't signed in. Connect it in claude.ai Settings → Connectors."), 'not_signed_in');
  assert.equal(classifyCalendarError('Calendar job timed out after 720000 ms'), 'timeout');
  assert.equal(classifyCalendarError('claude exited with code 1'), 'other');
});

test('validateManualEvent', () => {
  assert.equal(validateManualEvent({ start: '10:00', end: '10:30', title: 'Standup' }), null);
  assert.equal(validateManualEvent({ start: '10:00', end: '10:30', title: '  ' }), 'title');
  assert.equal(validateManualEvent({ start: '', end: '10:30', title: 'x' }), 'time');
  assert.equal(validateManualEvent({ start: '10:30', end: '10:30', title: 'x' }), 'order');
});

test('nextQuarter rounds up and clamps to the day', () => {
  assert.equal(nextQuarter(new Date(2026, 0, 1, 9, 1)), '09:15');
  assert.equal(nextQuarter(new Date(2026, 0, 1, 9, 0)), '09:00');
  assert.equal(nextQuarter(new Date(2026, 0, 1, 9, 50), 30), '10:30');
  assert.equal(nextQuarter(new Date(2026, 0, 1, 23, 55), 30), '23:45');
});

test('toMs accepts ms, seconds and ISO strings', () => {
  assert.equal(toMs(1_795_000_000_000), 1_795_000_000_000);
  assert.equal(toMs(1_795_000_000), 1_795_000_000_000);
  assert.equal(toMs('1795000000000'), 1_795_000_000_000);
  assert.equal(toMs('2026-11-26T10:00:00Z'), Date.parse('2026-11-26T10:00:00Z'));
  assert.equal(toMs(''), null);
  assert.equal(toMs('soon'), null);
  assert.equal(toMs(undefined), null);
});

test('unreadCount and preview', () => {
  assert.equal(unreadCount(true), 1);
  assert.equal(unreadCount(false), 0);
  assert.equal(unreadCount(3), 3);
  assert.equal(unreadCount(-1), 0);
  assert.equal(preview('  hi\n  there '), 'hi there');
  assert.equal(preview('x'.repeat(100), 10), 'xxxxxxxxx…');
  assert.equal(preview(null), '');
});

test('splitSteps strips server numbering and separates notes', () => {
  assert.deepEqual(splitSteps(['1. Open Settings.', '2) Add node.', 'Group threads are read-only.', '']), {
    steps: ['Open Settings.', 'Add node.'], notes: ['Group threads are read-only.'],
  });
  assert.deepEqual(splitSteps(['Open Settings.', 'Add node.']), { steps: ['Open Settings.', 'Add node.'], notes: [] });
});

// ── Fix round 3 (qa-claude) ──
import { pickDefaultSession, claudeSendTargets, nextTabIndex, describeError, lensHomeLines } from './helpers.ts';
import { ApiError } from './api.ts';

test('MAJOR: picker defaults to the remembered session, else the last sentTo, else none (never the first session)', () => {
  const sessions = ['G2', 'qa-dummy-claude', 'other'];
  assert.equal(pickDefaultSession(sessions, 'qa-dummy-claude', undefined), 'qa-dummy-claude');
  assert.equal(pickDefaultSession(sessions, 'gone', 'other'), 'other');
  assert.equal(pickDefaultSession(sessions, 'gone', undefined), '');
  assert.equal(pickDefaultSession(sessions, '', undefined), '');
  assert.equal(pickDefaultSession([], 'qa-dummy-claude', undefined), '', 'sessions not loaded yet: no choice');
});

test('picker offers only active Claude sessions, as the server requires', () => {
  const got = claudeSendTargets([
    { tmuxSessionName: 'codex2', source: 'codex' },
    { tmuxSessionName: 'b-claude', source: 'claude' },
    { tmuxSessionName: 'a-claude', source: 'claude' },
    { tmuxSessionName: 'a-claude', source: 'claude' },
    { tmuxSessionName: '', source: 'claude' },
  ]);
  assert.deepEqual(got, ['a-claude', 'b-claude']);
});

test('tablist arrow keys wrap and support Home/End', () => {
  assert.equal(nextTabIndex(0, 'ArrowRight', 6), 1);
  assert.equal(nextTabIndex(5, 'ArrowRight', 6), 0);
  assert.equal(nextTabIndex(0, 'ArrowLeft', 6), 5);
  assert.equal(nextTabIndex(3, 'Home', 6), 0);
  assert.equal(nextTabIndex(3, 'End', 6), 5);
  assert.equal(nextTabIndex(3, 'Enter', 6), null);
});

test('describeError separates offline, not-available and server errors', () => {
  assert.deepEqual(describeError(new TypeError('Failed to fetch')), { kind: 'offline', detail: '' });
  assert.deepEqual(describeError(new ApiError(404, 'not found', true)), { kind: 'unavailable', detail: '' });
  assert.deepEqual(describeError(new ApiError(409, 'Resolve the question first')), { kind: 'server', detail: 'Resolve the question first' });
  assert.deepEqual(describeError('weird'), { kind: 'server', detail: 'weird' });
});

test('lens preview mirrors the glasses home card (lens.ts) line for line', () => {
  const s = { calSetup: 'Calendar not connected.', calSetupHint: 'Phone → Fieldglass → Connections', noMeeting: 'No more meetings today.',
    next: '{time} {title}', objective: 'Goal: {text}', noObjective: 'Goal: (set on phone)', micOff: '○ Mic is off.' };
  assert.deepEqual(lensHomeLines({ source: 'none', events: [], next: null }, s), ['Calendar not connected.', 'Phone → Fieldglass → Connections', '', '○ Mic is off.']);
  assert.deepEqual(lensHomeLines({ source: 'calendar', events: [{}], next: null }, s), ['No more meetings today.', '', '○ Mic is off.']);
  assert.deepEqual(lensHomeLines({ source: 'manual', events: [{}], next: { start: '10:00', title: 'Standup' } }, s), ['10:00 Standup', 'Goal: (set on phone)', '', '○ Mic is off.']);
  const long = 'x'.repeat(130);
  const lines = lensHomeLines({ source: 'calendar', events: [{}], next: { start: '10:00', title: 'Standup', objective: long } }, s);
  assert.equal(lines[1].length, 56);
  assert.equal(lines.length, 5, 'objective wraps to at most 2 lines');
});
