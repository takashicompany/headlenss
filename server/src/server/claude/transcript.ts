import { open, readFile, stat } from 'node:fs/promises';

/**
 * Read the tail of a file efficiently: instead of reading the whole file,
 * read only the last chunk, discard the first partial line, and return the
 * remaining complete lines. Grows the chunk if fewer than `minLines` lines
 * are found, up to a maximum of ~2MB total read.
 *
 * Note: when reading from a mid-file offset, the first partial line may be
 * broken at a multi-byte UTF-8 boundary. This is safe because slice(1)
 * discards that partial line, and any remaining malformed lines are caught
 * by the caller's JSON.parse try/catch.
 */
export async function readTailLines(
  filePath: string,
  minLines: number,
): Promise<string[]> {
  const MAX_READ = 2 * 1024 * 1024; // 2MB cap
  let chunkSize = 256 * 1024; // start at 256KB

  let fileSize: number;
  try {
    const st = await stat(filePath);
    fileSize = st.size;
  } catch {
    return [];
  }

  if (fileSize === 0) return [];

  // If file is small enough, just read the whole thing
  if (fileSize <= chunkSize) {
    try {
      const raw = await readFile(filePath, 'utf-8');
      return raw.split('\n').filter((l) => l.trim());
    } catch {
      return [];
    }
  }

  // Open the file handle once before the grow-retry loop; close in finally.
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(filePath, 'r');
  } catch {
    return [];
  }

  try {
    while (chunkSize <= MAX_READ) {
      const readStart = Math.max(0, fileSize - chunkSize);
      const readLen = fileSize - readStart;
      let buf: Buffer;
      try {
        buf = Buffer.alloc(readLen);
        await fh.read(buf, 0, readLen, readStart);
      } catch {
        return [];
      }
      const raw = buf.toString('utf-8');
      // Discard the first partial line (unless we read from the start of the file)
      const lines = raw.split('\n');
      const completeLines = readStart > 0 ? lines.slice(1) : lines;
      const nonEmpty = completeLines.filter((l) => l.trim());
      if (nonEmpty.length >= minLines || chunkSize >= MAX_READ || readStart === 0) {
        return nonEmpty;
      }
      // Grow chunk and retry
      chunkSize = Math.min(chunkSize * 2, MAX_READ);
    }
    return [];
  } finally {
    await fh.close();
  }
}

type TranscriptLine = {
  type?: string;
  message?: { role?: string; content?: unknown };
  role?: string;
  content?: unknown;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  timestamp?: string;
};

/**
 * transcript の 1 行が「会話そのもの」(user / assistant の発言エントリ) かどうか。
 *
 * Claude Code 2.1.300 以降、transcript には API に送ったリクエスト本文を
 * 内容ハッシュ単位で保存する `type: "api-request-blob"` 行が混ざるようになった。
 * これは `message: { role, content }` を持つので role だけで判定すると発言に見えるが、
 * 中身は「過去の発言の再送コピー」+「system-reminder 等の注入文脈」で、
 * timestamp も isMeta も持たない。会話として数えると、過去の発言が重複し、
 * しかも時刻が無いぶん末尾 (=最新) に並んでしまう。
 *
 * そこで `type` を持つ行は `user` / `assistant` だけを会話として扱う。
 * `type` を持たない行 (旧来の/外部形式) は従来どおり role で判定する。
 */
function isConversationEntry(parsed: TranscriptLine): boolean {
  if (typeof parsed.type === 'string') {
    return parsed.type === 'user' || parsed.type === 'assistant';
  }
  return true;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const obj = block as { type?: string; text?: unknown };
      if (obj.type === 'text' && typeof obj.text === 'string') {
        parts.push(obj.text);
      }
    }
  }
  return parts.join('').trim();
}

type ContentBlock = { type?: string; text?: unknown; content?: unknown };

/**
 * Claude Code の transcript に含まれるシステムタグを人間向けにクリーニングする。
 *  - `<local-command-caveat>...</local-command-caveat>` : 内部用キャプション、完全削除
 *  - `<system-reminder>...</system-reminder>`           : 内部用注意書き、完全削除
 *  - `<bash-input>X</bash-input>`                       : `$ X` に変換
 *  - `<bash-stdout>X</bash-stdout>`                     : 中身だけ残す
 *  - `<bash-stderr>X</bash-stderr>`                     : 中身だけ残す
 *  - `<command-name>X</command-name>` を含むメッセージ  : メッセージ全体を `/X args`
 *    だけに収束 (skill 本体のテキストは捨てる)
 *  - 連続改行を 2 行までに圧縮
 */
export function sanitizeChatText(text: string): string {
  // <command-name> を含む user メッセージは「ユーザが /foo を打ち込んだ」直後に
  // skill 本体が展開された結果なので、本体テキストは表示せず、コマンド名だけ残す。
  // (例: /commit-ai を打つと長大な skill 説明が記録される → 履歴で見たいのは /commit-ai だけ)
  const cmdNameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmdNameMatch) {
    const cmdName = cmdNameMatch[1].trim();
    const cmdArgsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const cmdArgs = cmdArgsMatch ? cmdArgsMatch[1].trim() : '';
    return cmdArgs ? `${cmdName} ${cmdArgs}` : cmdName;
  }

  let s = text;
  s = s.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  // 新しい Claude Code は `<system-reminder id="...">` のように属性を付けることがある。
  s = s.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, '');
  s = s.replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, (_, cmd: string) => `$ ${cmd.trim()}`);
  s = s.replace(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/g, '$1');
  s = s.replace(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/g, '$1');
  // 念のため他の <foo>...</foo> 系も剥がす(残ると意味不明になる)。
  // ただし transcript 中にユーザが意図的に書いた XML/HTML タグは保持したいので、
  // 既知のラッパに限定し、上記で対応済み。残るのは plain text のはず。
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/** Claude Code が内部制御・サブエージェント通知・ローカルコマンド結果を
 *  role=user として transcript に書くことがある。これらはメインエージェントとの
 *  会話ではなく、tmux の通常会話にも出ないため chat view から除外する。 */
const TASK_NOTIFICATION_RE =
  /^\s*<task-notification>[\s\S]*<task-id>[\s\S]*<\/task-notification>\s*$/;
const LOCAL_COMMAND_STDOUT_RE = /^\s*<local-command-stdout>[\s\S]*<\/local-command-stdout>\s*$/;
const META_USER_TEXT_RE = /^(A session-scoped Stop hook is now active|Stop hook feedback:)/;

function isNonMainAgentTranscriptEntry(parsed: TranscriptLine, text: string): boolean {
  if (parsed.isMeta === true) return true;
  // /compact 後の「This session is being continued…」要約。transcript 専用で
  // tmux の会話には出ない (画面には "Conversation compacted" だけが出る)。
  if (parsed.isCompactSummary === true || parsed.isVisibleInTranscriptOnly === true) return true;
  if (TASK_NOTIFICATION_RE.test(text)) return true;
  if (LOCAL_COMMAND_STDOUT_RE.test(text)) return true;
  if (META_USER_TEXT_RE.test(text)) return true;
  return false;
}

/**
 * transcript JSONL からチャット履歴 (user prompt と assistant text) を順序通りに抽出する。
 * - tool_result / tool_use ブロックは除外
 * - sub-agent (isSidechain=true) は除外
 * - Claude Code のメタ制御・ローカルコマンド結果・サブエージェント通知は除外
 * - limit: 末尾 N 件のみ返す (デフォルト 200)
 */
export async function extractChatFromTranscript(
  transcriptPath: string,
  limit = 200,
  tailMode = false,
): Promise<Array<{ role: 'user' | 'assistant'; text: string; ts: number; agent?: 'claude' | 'codex' }>> {
  if (!transcriptPath) return [];

  let lines: string[];
  if (tailMode) {
    // Efficient tail read: only read the last portion of the file.
    // Transcript JSONL lines are not 1:1 with visible chat items (tool_use,
    // sidechain, meta lines are skipped), so request a margin so that
    // tail=10 reliably yields 10 visible items on typical transcripts.
    const minLines = Math.min(600, limit * 3);
    lines = await readTailLines(transcriptPath, minLines);
  } else {
    let raw: string;
    try {
      raw = await readFile(transcriptPath, 'utf-8');
    } catch {
      return [];
    }
    lines = raw.split('\n').filter((l) => l.trim());
  }

  const items: Array<{ role: 'user' | 'assistant'; text: string; ts: number; agent?: 'claude' | 'codex' }> = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    if (!isConversationEntry(parsed)) continue;
    if (parsed.isSidechain === true) continue;
    const role = parsed.message?.role ?? parsed.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = parsed.message?.content ?? parsed.content;
    let text = '';
    if (typeof content === 'string') {
      // user prompt の plain string ケース
      text = content.trim();
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      let hasOnlyTool = true;
      for (const block of content as ContentBlock[]) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
          hasOnlyTool = false;
        } else if (block.type === 'tool_use' || block.type === 'tool_result') {
          // skip
        } else {
          hasOnlyTool = false;
        }
      }
      // tool_result / tool_use のみで text が無いものはチャットに出さない
      if (hasOnlyTool) continue;
      text = parts.join('').trim();
    }
    if (!text) continue;
    if (isNonMainAgentTranscriptEntry(parsed, text)) continue;
    const cleaned = sanitizeChatText(text);
    if (!cleaned) continue;
    // 発言時刻は transcript エントリ自身の timestamp。取得時刻 (Date.now()) で埋めると
    // 過去の発言が「今」の位置に並び替えられ、hook 由来の chat とのマージ順も壊れる。
    // timestamp が欠けた行は後段で前後の発言の時刻から補う。
    const ts = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN;
    const item: { role: 'user' | 'assistant'; text: string; ts: number; agent?: 'claude' | 'codex' } = {
      role: role as 'user' | 'assistant',
      text: cleaned,
      ts,
    };
    // transcript 由来の assistant メッセージには agent: 'claude' を設定
    if (role === 'assistant') item.agent = 'claude';
    items.push(item);
  }
  fillMissingTimestamps(items);
  return items.slice(-limit);
}

/** timestamp を持たない項目に、直前 (無ければ直後) の項目の時刻を入れる。
 *  どれも時刻を持たない場合に限り取得時刻で埋める。 */
function fillMissingTimestamps(items: Array<{ ts: number }>): void {
  let prev = NaN;
  for (const it of items) {
    if (Number.isFinite(it.ts)) prev = it.ts;
    else if (Number.isFinite(prev)) it.ts = prev;
  }
  let next = NaN;
  for (let i = items.length - 1; i >= 0; i--) {
    if (Number.isFinite(items[i].ts)) next = items[i].ts;
    else items[i].ts = Number.isFinite(next) ? next : Date.now();
  }
}

/**
 * Extract the most recent assistant message text from a Claude Code transcript JSONL file.
 * Returns empty string if not found or unreadable.
 */
export async function extractLastAssistantText(transcriptPath: string): Promise<string> {
  if (!transcriptPath) return '';
  let raw: string;
  try {
    raw = await readFile(transcriptPath, 'utf-8');
  } catch {
    return '';
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(lines[i]) as TranscriptLine;
    } catch {
      continue;
    }
    // api-request-blob 等の再送コピーを「最新の発言」と誤読しない。
    if (!isConversationEntry(parsed)) continue;
    if (parsed.isSidechain === true) continue;
    const role = parsed.message?.role ?? parsed.role;
    if (role !== 'assistant') continue;
    const content = parsed.message?.content ?? parsed.content;
    const text = extractText(content);
    if (text) return text;
  }
  return '';
}
