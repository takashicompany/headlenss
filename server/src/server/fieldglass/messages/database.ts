import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MessagesReason, MessagesReasonCode } from './reasons.ts';

const APPLE_EPOCH = Date.UTC(2001, 0, 1);
const APPLE_SECONDS = '(CASE WHEN abs(lm.date) > 100000000000 THEN lm.date / 1000000000 ELSE lm.date END)';

// These are SELECTs only. IDs must pass threadId() before interpolation. Dates
// are cast to TEXT so JSON parsing cannot round nanosecond SQLite integers.
const THREAD_SELECT = `SELECT CAST(c.ROWID AS TEXT) AS id, c.guid, c.display_name, c.chat_identifier,
  c.service_name AS service, c.style,
  (SELECT json_group_array(h.id) FROM chat_handle_join hj JOIN handle h ON h.ROWID = hj.handle_id WHERE hj.chat_id = c.ROWID) AS handles,
  lm.text, hex(substr(lm.attributedBody, 1, 131072)) AS body, CAST(lm.date AS TEXT) AS date,
  (SELECT count(*) FROM chat_message_join uj JOIN message um ON um.ROWID = uj.message_id
    WHERE uj.chat_id = c.ROWID AND um.is_from_me = 0 AND um.is_read = 0) AS unread
  FROM chat c JOIN message lm ON lm.ROWID = (
    SELECT m.ROWID FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id
    WHERE j.chat_id = c.ROWID ORDER BY m.date DESC, m.ROWID DESC LIMIT 1)`;

export function threadId(value: string): string {
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid thread ID');
  return value;
}
export function threadsSql(now: number, id?: string): string {
  const where = id === undefined
    ? `${APPLE_SECONDS} >= ${Math.floor((now - APPLE_EPOCH) / 1000) - 7 * 86400}`
    : `c.ROWID = ${threadId(id)}`;
  return `/* fieldglass:threads */ ${THREAD_SELECT} WHERE ${where} ORDER BY ${APPLE_SECONDS} DESC, lm.ROWID DESC LIMIT ${id === undefined ? 10 : 1};`;
}
export function messagesSql(id: string): string {
  return `/* fieldglass:messages */ SELECT CAST(m.ROWID AS TEXT) AS id, m.is_from_me AS from_me,
    h.id AS sender, m.text, hex(substr(m.attributedBody, 1, 131072)) AS body, CAST(m.date AS TEXT) AS date
    FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE j.chat_id = ${threadId(id)} ORDER BY m.date DESC, m.ROWID DESC LIMIT 20;`;
}

// AddressBook is optional: a source using a different schema is simply skipped.
export const contactsSql = `/* fieldglass:contacts */ SELECT p.ZFULLNUMBER AS handle,
  trim(coalesce(r.ZFIRSTNAME, '') || ' ' || coalesce(r.ZLASTNAME, '')) AS name, r.ZORGANIZATION AS organization
  FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER
  UNION ALL SELECT e.ZADDRESS AS handle,
  trim(coalesce(r.ZFIRSTNAME, '') || ' ' || coalesce(r.ZLASTNAME, '')) AS name, r.ZORGANIZATION AS organization
  FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER;`;

export async function discoverContacts(home: string): Promise<string[]> {
  const sources = join(home, 'Library', 'Application Support', 'AddressBook', 'Sources');
  const entries = await readdir(sources, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(sources, entry.name, 'AddressBook-v22.abcddb'));
}

export function appleTime(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return 0;
  try {
    const number = BigInt(value);
    const millis = number > 100_000_000_000n || number < -100_000_000_000n ? number / 1_000_000n : number * 1000n;
    const result = Number(millis) + APPLE_EPOCH;
    return Number.isSafeInteger(result) && result >= 0 ? result : 0;
  } catch { return 0; }
}

export function decodeBody(text: unknown, hex: unknown): string {
  if (typeof text === 'string' && text.length) return text.replace(/\ufffc/g, '[attachment]');
  if (typeof hex !== 'string' || !hex.length || hex.length > 262144 || hex.length % 2 || !/^[\da-f]+$/i.test(hex)) return '[attachment]';
  const bytes = Buffer.from(hex, 'hex');
  // Best-effort NSArchiver NSString, not NSKeyedArchiver. Only accept a known
  // length-delimited UTF-8 value; printable archive metadata is not a message.
  if (!bytes.subarray(0, 13).equals(Buffer.from('\x04\x0bstreamtyped', 'binary'))) return '[attachment]';
  const nsString = bytes.indexOf(Buffer.from('NSString'));
  if (nsString < 0) return '[attachment]';
  const marker = bytes.indexOf(Buffer.from([0x84, 0x01, 0x2b]), nsString + 8);
  if (marker < 0 || marker > nsString + 64) return '[attachment]';
  let offset = marker + 3;
  let length = bytes[offset++];
  if (length === 0x81 && offset + 2 <= bytes.length) { length = bytes.readUInt16LE(offset); offset += 2; }
  else if (length === 0x82 && offset + 4 <= bytes.length) { length = bytes.readUInt32LE(offset); offset += 4; }
  else if (length >= 0x80) return '[attachment]';
  if (!length || offset + length > bytes.length || length > 131072) return '[attachment]';
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + length));
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded) ? '[attachment]' : decoded.replace(/\ufffc/g, '[attachment]');
  } catch { return '[attachment]'; }
}

export type Row = Record<string, unknown>;
export function parseRows(output: string): Row[] {
  // sqlite -json prints nothing for zero rows on some macOS versions.
  const parsed: unknown = output.trim() ? JSON.parse(output) : [];
  if (!Array.isArray(parsed) || parsed.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid SQLite response');
  return parsed as Row[];
}
export function handleKey(handle: string): string {
  return /^[+\d\s().-]+$/.test(handle) ? handle.replace(/[\s().-]/g, '') : handle.toLowerCase();
}
export function contactNames(rows: Row[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim()
      : typeof row.organization === 'string' ? row.organization.trim() : '';
    if (typeof row.handle === 'string' && name) names.set(handleKey(row.handle), name);
  }
  return names;
}

export type MessageThread = { id: string; name: string; isGroup: boolean; service: string;
  lastText: string; lastAt: number; unread: number; canReply: boolean; readOnlyReason?: string; reasonCode: MessagesReasonCode };
export function threadView(row: Row, names: Map<string, string>): { thread: MessageThread; guid: string; recipient: string } {
  const handles: unknown = typeof row.handles === 'string' ? JSON.parse(row.handles) : [];
  const participants = Array.isArray(handles) ? [...new Set(handles.filter((h): h is string => typeof h === 'string' && !!h))] : [];
  const guid = typeof row.guid === 'string' ? row.guid : '';
  const service = typeof row.service === 'string' ? row.service : '';
  const isGroup = participants.length > 1 || row.style === 43 || guid.includes(';+;');
  const recipient = participants.length === 1 ? participants[0] : '';
  const named = participants.map((handle) => names.get(handleKey(handle)) || handle).join(', ');
  const name = typeof row.display_name === 'string' && row.display_name.trim() ? row.display_name.trim()
    : named || (typeof row.chat_identifier === 'string' ? row.chat_identifier : '') || 'Unknown contact';
  const reason: MessagesReason | undefined = isGroup ? { reasonCode: 'group_read_only', reason: 'Group threads are read-only in v1.' }
    : !['iMessage', 'SMS'].includes(service) ? { reasonCode: 'unsupported_service', reason: 'Only existing iMessage and SMS threads can receive replies.' }
      : !recipient || !guid.startsWith(`${service};-;`) || /[\u0000-\u001f\u007f]/.test(recipient + guid)
        ? { reasonCode: 'ambiguous_target', reason: 'This thread has no unambiguous reply target. Open Messages on your Mac.' } : undefined;
  return { guid, recipient, thread: { id: threadId(String(row.id)), name, isGroup, service,
    lastText: decodeBody(row.text, row.body), lastAt: appleTime(row.date),
    unread: typeof row.unread === 'number' && row.unread > 0 ? Math.floor(row.unread) : 0,
    canReply: !reason, reasonCode: reason?.reasonCode ?? 'ready', ...(reason ? { readOnlyReason: reason.reason } : {}),
  } };
}
