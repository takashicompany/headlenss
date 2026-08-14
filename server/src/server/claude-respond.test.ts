import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { claudeRouter } from './claude/router.ts';
import * as store from './claude/store.ts';

const NAME = 'respond-test';

/** pending を 1 件持つセッションを用意し、その pending id を返す。 */
function setupPending(): string {
  store.removeSession(NAME);
  store.upsertSession({
    ccSessionId: 'cc-1',
    tmuxPane: '%1',
    tmuxSessionName: NAME,
    cwd: '/tmp',
    source: 'claude',
  });
  return store.createPending(NAME, {
    kind: 'permission',
    hookEvent: 'PreToolUse',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
  }).id;
}

async function respond(body: unknown): Promise<Response> {
  return await claudeRouter.request(`/claude/sessions/${NAME}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('pendingId が現在の pending と違う応答は 409 で弾く', async () => {
  const id = setupPending();
  const res = await respond({ kind: 'permission', decision: 'allow', pendingId: `${id}-stale` });
  assert.equal(res.status, 409);
  const json = (await res.json()) as { error: string; currentPendingId: string };
  assert.equal(json.error, 'pending mismatch');
  assert.equal(json.currentPendingId, id);
  store.removeSession(NAME);
});

test('pendingId が一致する / 送ってこない応答は不一致では弾かない (後方互換)', async () => {
  const id = setupPending();
  for (const body of [
    { kind: 'permission', decision: 'allow', pendingId: id },
    { kind: 'permission', decision: 'allow' },
  ]) {
    const res = await respond(body);
    const json = (await res.json()) as { error?: string };
    // hook の待ち受け (resolver) が無いテスト環境なので解決自体は失敗するが、
    // 少なくとも「不一致」では弾かれずに応答処理まで進んでいることを確認する。
    assert.notEqual(json.error, 'pending mismatch');
  }
  store.removeSession(NAME);
});
