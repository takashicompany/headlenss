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
  const json = (await res.json()) as { error: string; code: string; currentPendingId: string };
  assert.equal(json.error, 'pending mismatch');
  // クライアントは code で「用件が入れ替わった 409」だけを識別する
  assert.equal(json.code, 'pending_mismatch');
  assert.equal(json.currentPendingId, id);
  store.removeSession(NAME);
});

test('同じ用件を処理中に来た 2 件目は already_processing で弾く', async () => {
  const id = setupPending();
  // 1 件目が「応答処理中」の状態を作る。実際の処理は tmux へのキー注入などで
  // 数百 ms 掛かるが、claim は最初の await より前に立つので、この状態と等価。
  assert.equal(store.claimPendingForRespond(id), true);
  const res = await respond({ kind: 'permission', decision: 'allow', pendingId: id });
  assert.equal(res.status, 409);
  const json = (await res.json()) as { code: string; currentPendingId: string };
  assert.equal(json.code, 'already_processing');
  assert.equal(json.currentPendingId, id);
  // 1 件目が終われば claim は解放され、次の応答は弾かれない
  store.releasePendingForRespond(id);
  const after = await respond({ kind: 'permission', decision: 'allow', pendingId: id });
  const afterJson = (await after.json()) as { code?: string };
  assert.notEqual(afterJson.code, 'already_processing');
  store.removeSession(NAME);
});

test('処理中に用件が入れ替わったら、新しい pending は消さない', async () => {
  const id = setupPending();
  // 応答処理の途中で別の用件が来た状況を作る (createPending は既存を上書きする)
  const next = store.createPending(NAME, {
    kind: 'permission',
    hookEvent: 'PreToolUse',
    toolName: 'Write',
    toolInput: { file_path: '/tmp/x' },
  });
  assert.notEqual(next.id, id);
  // 古い用件を id 指定で消そうとしても、現役は新しい用件なので残る
  assert.equal(store.clearPendingIfId(NAME, id), false);
  assert.equal(store.getPending(NAME)?.id, next.id);
  // 現役の id なら消える
  assert.equal(store.clearPendingIfId(NAME, next.id), true);
  assert.equal(store.getPending(NAME), undefined);
  store.removeSession(NAME);
});

test('pendingId が一致する / 送ってこない応答は不一致では弾かない (後方互換)', async () => {
  const id = setupPending();
  for (const body of [
    { kind: 'permission', decision: 'allow', pendingId: id },
    { kind: 'permission', decision: 'allow' },
  ]) {
    const res = await respond(body);
    const json = (await res.json()) as { error?: string; code?: string };
    // hook の待ち受け (resolver) が無いテスト環境なので解決自体は失敗するが、
    // 少なくとも「不一致」では弾かれずに応答処理まで進んでいることを確認する。
    assert.notEqual(json.error, 'pending mismatch');
    // 前の応答の claim が解放されずに残っていないこと (2 周目も処理まで進める)
    assert.notEqual(json.code, 'already_processing');
  }
  store.removeSession(NAME);
});
