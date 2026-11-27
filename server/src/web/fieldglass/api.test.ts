import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, fieldglassApi } from './api.ts';

function stubFetch(body: string, init: { status?: number; contentType?: string }) {
  globalThis.fetch = (async () => new Response(body, {
    status: init.status ?? 200,
    headers: { 'Content-Type': init.contentType ?? 'application/json' },
  })) as typeof fetch;
}

test('an old server answering /api/* with the SPA index.html (200 text/html) reads as "not available"', async () => {
  stubFetch('<!doctype html><html></html>', { contentType: 'text/html' });
  await assert.rejects(fieldglassApi.messagesStatus(), (e: unknown) => e instanceof ApiError && e.unavailable === true && e.status === 404);
});

test('a 404 is "not available"; other errors keep the server message', async () => {
  stubFetch(JSON.stringify({ error: 'nope' }), { status: 404 });
  await assert.rejects(fieldglassApi.today(), (e: unknown) => e instanceof ApiError && e.unavailable === true);
  stubFetch(JSON.stringify({ error: 'Choose an active Claude session' }), { status: 409 });
  await assert.rejects(fieldglassApi.today(), (e: unknown) => e instanceof ApiError && !e.unavailable && e.message === 'Choose an active Claude session');
});

test('JSON 200 still parses; the CSV route rejects an HTML fallback', async () => {
  stubFetch(JSON.stringify({ followups: [] }), {});
  assert.deepEqual(await fieldglassApi.followups(), { followups: [] });
  stubFetch('<!doctype html>', { contentType: 'text/html' });
  await assert.rejects(fieldglassApi.fieldtestCsv(), (e: unknown) => e instanceof ApiError && e.unavailable === true);
});
