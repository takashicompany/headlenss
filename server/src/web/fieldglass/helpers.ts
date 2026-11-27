import { ApiError } from './errors.ts';
// Pure helpers for the Fieldglass web companion (no DOM, no React) so they can be unit-tested.

/** Replace `{name}` placeholders. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Whole days left until `expiresAt` (rounded up, never negative). */
export function daysLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 86_400_000));
}

/** "HH:MM" → minutes since midnight, or null when malformed. */
export function hhmmToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Index of the next or ongoing event (end > now), or -1. Events are assumed same-day. */
export function nextEventIndex(events: { start: string; end: string }[], nowMinutes: number): number {
  let best = -1;
  let bestStart = Infinity;
  events.forEach((e, i) => {
    const start = hhmmToMinutes(e.start);
    const end = hhmmToMinutes(e.end) ?? start;
    if (start == null || end == null) return;
    if (end > nowMinutes && start < bestStart) {
      best = i;
      bestStart = start;
    }
  });
  return best;
}

/** RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

export type FieldTestRow = Record<string, string>;

export function csvToObjects(rows: string[][]): FieldTestRow[] {
  if (rows.length < 2) return [];
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export type FieldTestSummary = {
  sessions: number;
  cuesShown: number;
  useful: number;
  offTarget: number;
  /** last word → rendered on lens, ms (cue_shown rows with both timestamps) */
  latency: { n: number; median: number; p95: number } | null;
  /** last word → cue candidate ready, ms */
  engine: { n: number; median: number; p95: number } | null;
};

function stats(values: number[]): { n: number; median: number; p95: number } | null {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return { n: v.length, median: percentile(v, 50), p95: percentile(v, 95) };
}

export function summarizeFieldTest(rows: FieldTestRow[]): FieldTestSummary {
  const sessions = new Set(rows.map((r) => r.sessionId).filter(Boolean));
  const shown = rows.filter((r) => r.kind === 'cue_shown');
  const rated = rows.filter((r) => r.kind === 'rated');
  const num = (s: string | undefined) => (s == null || s === '' ? NaN : Number(s));
  return {
    sessions: sessions.size,
    cuesShown: shown.length,
    useful: rated.filter((r) => r.rating === 'useful').length,
    offTarget: rated.filter((r) => r.rating === 'off').length,
    latency: stats(shown.map((r) => num(r.renderedAt) - num(r.lastWordAt))),
    engine: stats(shown.map((r) => num(r.candidateAt) - num(r.lastWordAt))),
  };
}

/** Format ms as "1.4 s". */
export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Turns a calendar job error into a plain-language category for the UI. The raw text is still shown as detail. */
export type CalendarErrorKind = 'not_signed_in' | 'timeout' | 'other';
export function classifyCalendarError(msg: string): CalendarErrorKind {
  if (/authenticat|sign(ed)?[ -]?in|not connected|needs[_ ]auth|oauth|unauthori[sz]ed|401/i.test(msg)) return 'not_signed_in';
  if (/time[sd]?[ -]?out|took too long|ETIMEDOUT|SIGTERM|killed/i.test(msg)) return 'timeout';
  return 'other';
}

/** Validates the "Add meeting by hand" form. Returns an error key or null. */
export function validateManualEvent(e: { start: string; end: string; title: string }): 'title' | 'time' | 'order' | null {
  if (!e.title.trim()) return 'title';
  const s = hhmmToMinutes(e.start);
  const en = hhmmToMinutes(e.end);
  if (s == null || en == null) return 'time';
  if (en <= s) return 'order';
  return null;
}

/** "HH:MM" for a Date rounded up to the next quarter hour, plus `addMin`. */
export function nextQuarter(d: Date, addMin = 0): string {
  const m = Math.min(23 * 60 + 45, Math.ceil((d.getHours() * 60 + d.getMinutes()) / 15) * 15 + addMin);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Accepts ms, seconds, or an ISO string; returns ms or null. */
export function toMs(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e11 ? v * 1000 : v) : null;
  if (/^\d+$/.test(v)) return toMs(Number(v));
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Unread may arrive as a count or a flag. */
export function unreadCount(v: number | boolean | null | undefined): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** One-line preview, whitespace collapsed, cut at `max` characters with an ellipsis. */
export function preview(text: string | null | undefined, max = 80): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/** Server steps may arrive pre-numbered ("1. …"). Numbered/plain lines become list steps; once numbering
 *  is in use, unnumbered lines are treated as notes shown under the list. */
export function splitSteps(lines: string[]): { steps: string[]; notes: string[] } {
  const numbered = lines.some((l) => /^\s*\d+[.)]\s+/.test(l));
  const steps: string[] = [];
  const notes: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    const m = /^\d+[.)]\s+(.*)$/s.exec(l);
    if (m) steps.push(m[1]);
    else if (numbered) notes.push(l);
    else steps.push(l);
  }
  return { steps, notes };
}

// ── Fix round 3 ──

/** Send-picker default: the session the user last chose, else the one this follow-up was sent to, else nothing.
 *  Never the first session in the list: a one-tap Send must not land somewhere the user didn't pick. */
export function pickDefaultSession(sessions: string[], last: string, sentTo: string | undefined): string {
  if (last && sessions.includes(last)) return last;
  if (sentTo && sessions.includes(sentTo)) return sentTo;
  return '';
}

export function claudeSendTargets(rows: { tmuxSessionName?: string; source?: string }[]): string[] {
  const names = rows.filter((r) => r.source === 'claude' && r.tmuxSessionName).map((r) => r.tmuxSessionName as string);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** ARIA tabs pattern: Left/Right wrap, Home/End jump. Other keys: null (not handled). */
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight': return (current + 1) % count;
    case 'ArrowLeft': return (current - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

export type ErrorKind = 'offline' | 'unavailable' | 'server';
/** fetch() throws TypeError when the Mac can't be reached; an ApiError carries the server's own reason. */
export function describeError(e: unknown): { kind: ErrorKind; detail: string } {
  if (e instanceof TypeError) return { kind: 'offline', detail: '' };
  if (e instanceof ApiError && e.unavailable) return { kind: 'unavailable', detail: '' };
  if (e instanceof Error) return { kind: 'server', detail: e.message };
  return { kind: 'server', detail: String(e) };
}

export type LensHomeStrings = { calSetup: string; calSetupHint: string; noMeeting: string; next: string; objective: string; noObjective: string; micOff: string };
/** Body of the glasses' Fieldglass home card, mirroring even/src/fieldglass/lens.ts (the lens wraps at ~56 half-width chars). */
export function lensHomeLines(
  today: { source: string; events: unknown[]; next: { start: string; title: string; objective?: string } | null },
  s: LensHomeStrings,
): string[] {
  const lines: string[] = [];
  if (today.source === 'none' && today.events.length === 0) lines.push(s.calSetup, s.calSetupHint);
  else if (!today.next) lines.push(s.noMeeting);
  else {
    lines.push(fmt(s.next, { time: today.next.start, title: today.next.title }).slice(0, 56));
    if (today.next.objective) {
      const o = fmt(s.objective, { text: today.next.objective });
      lines.push(o.slice(0, 56), ...(o.length > 56 ? [o.slice(56, 112)] : []));
    } else lines.push(s.noObjective);
  }
  lines.push('', s.micOff);
  return lines;
}
