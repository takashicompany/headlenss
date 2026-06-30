import { readFile } from 'node:fs/promises';
import { sanitizeChatText } from '../claude/transcript.ts';

type CodexTranscriptLine = {
  timestamp?: string;
  type?: string;
  payload?: unknown;
};

type CodexMessagePayload = {
  type?: string;
  role?: string;
  content?: unknown;
  message?: unknown;
};

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: unknown };
    if ((b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('').trim();
}

/** Codex は承認レビュー・環境注入・中断通知などの内部イベントも
 *  response_item/message として transcript に残す。これらは tmux の通常会話ではなく、
 *  chat view に出すとメイン会話に見えて順序も崩れる。 */
const CODEX_INTERNAL_USER_RE =
  /^\s*(<environment_context>|<subagent_notification>|<turn_aborted>|<task>|<skill>|<skills_instructions>|The following is the Codex agent history)/;
const CODEX_AUTO_REVIEWER_RESULT_RE = /^\s*\{\s*("outcome"\s*:|"risk_level"[\s\S]*"outcome"\s*:)/;

function isCodexInternalMessage(role: string, text: string): boolean {
  if (role === 'user' && CODEX_INTERNAL_USER_RE.test(text)) return true;
  if (role === 'assistant' && CODEX_AUTO_REVIEWER_RESULT_RE.test(text)) return true;
  return false;
}

function extractMessage(line: CodexTranscriptLine): { role: 'user' | 'assistant'; text: string } | null {
  if (!line.payload || typeof line.payload !== 'object') return null;
  const payload = line.payload as CodexMessagePayload;

  // Codex の通常会話は event_msg にも保存される。response_item/message は
  // 承認レビューや環境注入などの内部メッセージも多く混ざるため、event_msg を優先する。
  if (line.type === 'event_msg') {
    const role = payload.type === 'user_message' ? 'user' : payload.type === 'agent_message' ? 'assistant' : undefined;
    if (!role) return null;
    const rawText = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (isCodexInternalMessage(role, rawText)) return null;
    const text = sanitizeChatText(rawText);
    if (!text) return null;
    return { role, text };
  }

  if (line.type !== 'response_item') return null;
  if (payload.type !== 'message') return null;
  if (payload.role !== 'user' && payload.role !== 'assistant') return null;
  const rawText = extractText(payload.content);
  if (isCodexInternalMessage(payload.role, rawText)) return null;
  const text = sanitizeChatText(rawText);
  if (!text) return null;
  return { role: payload.role, text };
}

export async function extractCodexChatFromTranscript(
  transcriptPath: string,
  limit = 200,
): Promise<Array<{ role: 'user' | 'assistant'; text: string; ts: number }>> {
  if (!transcriptPath) return [];
  let raw: string;
  try {
    raw = await readFile(transcriptPath, 'utf-8');
  } catch {
    return [];
  }
  const items: Array<{ role: 'user' | 'assistant'; text: string; ts: number }> = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: CodexTranscriptLine;
    try {
      parsed = JSON.parse(line) as CodexTranscriptLine;
    } catch {
      continue;
    }
    const msg = extractMessage(parsed);
    if (!msg) continue;
    const key = msg.role + ':' + msg.text;
    if (seen.has(key)) continue;
    seen.add(key);
    const ts = parsed.timestamp ? Date.parse(parsed.timestamp) : Date.now();
    items.push({ ...msg, ts: Number.isFinite(ts) ? ts : Date.now() });
  }
  return items.slice(-limit);
}

export async function extractLastCodexAssistantText(transcriptPath: string): Promise<string> {
  if (!transcriptPath) return '';
  const chat = await extractCodexChatFromTranscript(transcriptPath, 200);
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i].role === 'assistant') return chat[i].text;
  }
  return '';
}
