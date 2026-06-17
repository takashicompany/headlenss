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

function extractMessage(line: CodexTranscriptLine): { role: 'user' | 'assistant'; text: string } | null {
  if (line.type !== 'response_item') return null;
  if (!line.payload || typeof line.payload !== 'object') return null;
  const payload = line.payload as CodexMessagePayload;
  if (payload.type !== 'message') return null;
  if (payload.role !== 'user' && payload.role !== 'assistant') return null;
  const text = sanitizeChatText(extractText(payload.content));
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
