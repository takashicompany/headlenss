// 画像・動画アップロードの共通ヘルパー (chat / tmux 両モードで利用)。
// サーバ側 POST /api/uploads は raw バイナリを受け取って path を返す。

export type UploadResult = { path: string; bytes: number };

/** 1 ファイルの上限 (サーバ側 UPLOAD_MAX_BYTES_DEFAULT と同じ 200MB)。送る前に弾くための目安 */
export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

/** input[type=file] の accept。iPadOS / iOS の写真ピッカーに動画を出すには video/* が必要 */
export const UPLOAD_ACCEPT = 'image/*,video/*';

/** サイズ超過 (送信前判定 or サーバの 413)。UI 側で i18n 文言に差し替える */
export class UploadTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super('file too large');
  }
}

export async function uploadFile(blob: Blob | File): Promise<UploadResult> {
  if (blob.size > UPLOAD_MAX_BYTES) throw new UploadTooLargeError(UPLOAD_MAX_BYTES);
  const headers: Record<string, string> = {
    'Content-Type': blob.type || 'application/octet-stream',
  };
  // File なら filename を渡して拡張子推定の保険にする
  if (blob instanceof File && blob.name) {
    // ヘッダは ISO-8859-1 しか通らないので、日本語名などは拡張子だけ残す
    headers['X-Filename'] = /^[\x20-\x7e]*$/.test(blob.name)
      ? blob.name
      : `file${blob.name.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] ?? ''}`;
  }
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers,
    body: blob,
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; maxBytes?: number };
    if (res.status === 413) throw new UploadTooLargeError(j.maxBytes ?? UPLOAD_MAX_BYTES);
    throw new Error(j.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as UploadResult;
}

function isUploadableType(type: string): boolean {
  return type.startsWith('image/') || type.startsWith('video/');
}

/** ペーストイベントの clipboardData から画像・動画ファイルだけを抽出 */
export function extractUploadableFromClipboard(items: DataTransferItemList): File[] {
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && isUploadableType(item.type)) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}

/** 配列から画像・動画ファイルだけ取り出す(input[type=file] / drop event 用) */
export function filterUploadableFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter((f) => isUploadableType(f.type));
}

/** エラー表示用の文言。サイズ超過は i18n 文言 (上限 MB を埋め込む) に差し替える */
export function uploadErrorMessage(e: unknown, tooLargeText: (maxMb: number) => string): string {
  if (e instanceof UploadTooLargeError) return tooLargeText(Math.round(e.maxBytes / 1024 / 1024));
  return (e as Error).message;
}
