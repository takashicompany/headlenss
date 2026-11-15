// POST /api/uploads の補助 (拡張子⇔MIME の対応表 / サイズ上限付きの本文読み込み)。
//
// 本文はメモリに溜めてから保存するため、上限なしだと巨大な動画でプロセスが落ちる。
// 上限を超えた時点で読み込みを打ち切り、413 を返せるようにする。

/** アップロード 1 件あたりの上限 (200MB)。画像には十分大きく、動画のために設けている */
export const UPLOAD_MAX_BYTES_DEFAULT = 200 * 1024 * 1024;

/** 実効上限。検証用に環境変数 HEADLENSS_UPLOAD_MAX_BYTES で小さくできる (本番は既定値) */
export function getUploadMaxBytes(): number {
  const v = Number(process.env.HEADLENSS_UPLOAD_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : UPLOAD_MAX_BYTES_DEFAULT;
}

export const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/x-matroska': 'mkv',
  'video/3gpp': '3gp',
  'video/x-msvideo': 'avi',
  'video/mpeg': 'mpeg',
};

export const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  '3gp': 'video/3gpp',
  avi: 'video/x-msvideo',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
};

export class UploadTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`file too large (max ${limit} bytes)`);
  }
}

/**
 * リクエスト本文を上限付きで読み込む。
 * Content-Length が上限超過なら読まずに、宣言が無い/偽りでも累計が上限を超えた時点で
 * UploadTooLargeError を投げる (それ以上メモリに溜めない)。
 */
export async function readBodyWithLimit(req: Request, limit: number): Promise<Buffer> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new UploadTooLargeError(limit);
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => { /* ignore */ });
      throw new UploadTooLargeError(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
