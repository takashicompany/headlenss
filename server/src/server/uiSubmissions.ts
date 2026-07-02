/**
 * UI 送信テキストの追跡モジュール。
 * HeadLenss の Web UI (`POST /api/sessions/:name/input`) から送信されたテキストを
 * 記録し、後続の hook (user-prompt-submit) で UI 由来か外部注入かを判別する。
 *
 * エントリは per-session のリングバッファ (最大 20 件、TTL 10 分) で保持し、
 * matchUiSubmission() 成功時に消費 (削除) して、同一テキストの多重マッチを防ぐ。
 */

const TTL_MS = 10 * 60 * 1000; // 10 分
const MAX_ENTRIES = 20;

type Entry = {
  text: string;
  normalizedText: string;
  createdAt: number;
};

/** session 名 → エントリ配列 */
const buffers = new Map<string, Entry[]>();

function normalize(text: string): string {
  return text.trim();
}

/** UI 送信テキストを記録する */
export function recordUiSubmission(tmuxName: string, text: string): void {
  const normalized = normalize(text);
  if (!normalized) return;
  let buf = buffers.get(tmuxName);
  if (!buf) {
    buf = [];
    buffers.set(tmuxName, buf);
  }
  buf.push({ text, normalizedText: normalized, createdAt: Date.now() });
  // リングバッファ: 古い方から削除
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
}

/** hook テキストが UI 送信由来かどうかを判定する。マッチしたエントリは消費 (削除) される。 */
export function matchUiSubmission(tmuxName: string, hookText: string): boolean {
  const buf = buffers.get(tmuxName);
  if (!buf || buf.length === 0) return false;

  const now = Date.now();
  const normalizedHook = normalize(hookText);
  if (!normalizedHook) return false;

  // 期限切れエントリを先に除去
  for (let i = buf.length - 1; i >= 0; i--) {
    if (now - buf[i].createdAt > TTL_MS) buf.splice(i, 1);
  }

  // trimmed-equality (双方向): hook テキストと記録テキストが、
  // trim 後に完全一致するか、片方が他方を含むか (空白差異への耐性)
  for (let i = 0; i < buf.length; i++) {
    const entry = buf[i];
    if (
      entry.normalizedText === normalizedHook ||
      normalizedHook.startsWith(entry.normalizedText) ||
      entry.normalizedText.startsWith(normalizedHook)
    ) {
      // 消費: 1 回マッチしたら削除
      buf.splice(i, 1);
      return true;
    }
  }
  return false;
}
