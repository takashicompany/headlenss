import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  EXT_TO_MIME,
  MIME_TO_EXT,
  UPLOAD_MAX_BYTES_DEFAULT,
  UploadTooLargeError,
  getUploadMaxBytes,
  readBodyWithLimit,
} from './uploads.ts';

function streamRequest(chunks: Uint8Array[], headers: Record<string, string> = {}): Request {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(c);
      ctrl.close();
    },
  });
  return new Request('http://x/api/uploads', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
}

test('既定の上限は 200MB', () => {
  assert.equal(UPLOAD_MAX_BYTES_DEFAULT, 200 * 1024 * 1024);
  const prev = process.env.HEADLENSS_UPLOAD_MAX_BYTES;
  delete process.env.HEADLENSS_UPLOAD_MAX_BYTES;
  assert.equal(getUploadMaxBytes(), UPLOAD_MAX_BYTES_DEFAULT);
  process.env.HEADLENSS_UPLOAD_MAX_BYTES = '1234';
  assert.equal(getUploadMaxBytes(), 1234);
  process.env.HEADLENSS_UPLOAD_MAX_BYTES = 'abc';
  assert.equal(getUploadMaxBytes(), UPLOAD_MAX_BYTES_DEFAULT);
  if (prev === undefined) delete process.env.HEADLENSS_UPLOAD_MAX_BYTES;
  else process.env.HEADLENSS_UPLOAD_MAX_BYTES = prev;
});

test('動画の MIME / 拡張子が双方向に引ける', () => {
  for (const [mime, ext] of [
    ['video/mp4', 'mp4'],
    ['video/quicktime', 'mov'],
    ['video/webm', 'webm'],
    ['video/x-m4v', 'm4v'],
  ]) {
    assert.equal(MIME_TO_EXT[mime], ext);
    assert.equal(EXT_TO_MIME[ext], mime);
  }
  assert.equal(MIME_TO_EXT['image/png'], 'png');
});

test('上限以内なら全バイトをそのまま返す', async () => {
  const req = streamRequest([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
  const buf = await readBodyWithLimit(req, 5);
  assert.deepEqual([...buf], [1, 2, 3, 4, 5]);
});

test('Content-Length が上限超過なら読まずに拒否', async () => {
  const req = streamRequest([new Uint8Array(3)], { 'content-length': '100' });
  await assert.rejects(readBodyWithLimit(req, 10), UploadTooLargeError);
});

test('Content-Length が無くても累計が上限を超えた時点で拒否', async () => {
  const req = streamRequest([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)]);
  await assert.rejects(readBodyWithLimit(req, 10), UploadTooLargeError);
});
