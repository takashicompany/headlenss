import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { claudeRouter } from './claude/router.ts';
import * as store from './claude/store.ts';
import type { AskQuestion } from './claude/types.ts';

const NAME = 'respond-test';
const OTHER = 'respond-test-other';

/** pending を 1 件持つセッションを用意し、その pending id を返す。 */
function setupPending(name = NAME): string {
  store.removeSession(name);
  store.releaseRespondLock(name);
  store.upsertSession({
    ccSessionId: 'cc-1',
    tmuxPane: '%1',
    tmuxSessionName: name,
    cwd: '/tmp',
    source: 'claude',
  });
  return store.createPending(name, {
    kind: 'permission',
    hookEvent: 'PreToolUse',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
  }).id;
}

async function respond(body: unknown, name = NAME): Promise<Response> {
  return await claudeRouter.request(`/claude/sessions/${name}/respond`, {
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

test('同じ tmux を処理中に来た 2 件目は already_processing で弾く', async () => {
  const id = setupPending();
  // 1 件目が「応答処理中」の状態を作る。実際の処理は tmux へのキー注入などで
  // 数百 ms 掛かるが、mutex はボディ読み取り直後に立つので、この状態と等価。
  assert.equal(store.acquireRespondLock(NAME), true);
  const res = await respond({ kind: 'permission', decision: 'allow', pendingId: id });
  assert.equal(res.status, 409);
  const json = (await res.json()) as { code: string; currentPendingId: string };
  assert.equal(json.code, 'already_processing');
  assert.equal(json.currentPendingId, id);
  // 1 件目が終われば mutex は解放され、次の応答は弾かれない
  store.releaseRespondLock(NAME);
  const after = await respond({ kind: 'permission', decision: 'allow', pendingId: id });
  const afterJson = (await after.json()) as { code?: string };
  assert.notEqual(afterJson.code, 'already_processing');
  store.removeSession(NAME);
});

test('処理中の tmux へは「別の用件」への応答も弾く (キー注入が混ざらない)', async () => {
  setupPending();
  // 1 本目がキー注入している最中に用件が入れ替わり、新しい用件への応答が飛んできた状況。
  // 用件 id 単位の排他だと id が違うので素通りし、同じ TUI に 2 本ぶんの矢印と Enter が
  // 混ざる。tmux 単位の mutex なら、用件が違っても 2 本目は通さない。
  assert.equal(store.acquireRespondLock(NAME), true);
  const next = store.createPending(NAME, {
    kind: 'permission',
    hookEvent: 'PreToolUse',
    toolName: 'Write',
    toolInput: { file_path: '/tmp/x' },
  });
  const res = await respond({ kind: 'permission', decision: 'allow', pendingId: next.id });
  assert.equal(res.status, 409);
  const json = (await res.json()) as { code: string; currentPendingId: string };
  assert.equal(json.code, 'already_processing');
  // 「今どの用件を待っているか」はクライアントの取り直しに使うので返す
  assert.equal(json.currentPendingId, next.id);
  store.releaseRespondLock(NAME);
  store.removeSession(NAME);
});

test('mutex は tmux 単位なので、別セッションの応答は同時に処理できる', async () => {
  const id = setupPending();
  const otherId = setupPending(OTHER);
  assert.equal(store.acquireRespondLock(NAME), true);
  // 別 tmux は別の TUI なので待たせる理由が無い
  assert.equal(store.isRespondLocked(OTHER), false);
  const res = await respond({ kind: 'permission', decision: 'allow', pendingId: otherId }, OTHER);
  const json = (await res.json()) as { code?: string };
  assert.notEqual(json.code, 'already_processing');
  assert.equal(store.isRespondLocked(NAME), true);
  store.releaseRespondLock(NAME);
  assert.equal(id.length > 0, true);
  store.removeSession(NAME);
  store.removeSession(OTHER);
});

test('弾かれた 2 件目は mutex を横取り解放しない', async () => {
  const id = setupPending();
  assert.equal(store.acquireRespondLock(NAME), true);
  const res = await respond({ kind: 'permission', decision: 'allow', pendingId: id });
  assert.equal(res.status, 409);
  // 2 件目の finally が動いてしまうと、まだ処理中の 1 件目のロックが外れる
  assert.equal(store.isRespondLocked(NAME), true);
  store.releaseRespondLock(NAME);
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

test('ボディ読み取り中に用件が入れ替わったら、読み取り後の pending を基準に判定する', async () => {
  const id = setupPending();
  let nextId = '';
  const payload = JSON.stringify({ kind: 'permission', decision: 'allow', pendingId: id });
  const enc = new TextEncoder();
  // ボディを分割して流し、後半を流す直前に用件を差し替える。
  // サーバがボディ読み取り「前」の pending を掴んでいると、この差し替えを取りこぼす。
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(payload.slice(0, 10)));
      setTimeout(() => {
        nextId = store.createPending(NAME, {
          kind: 'permission',
          hookEvent: 'PreToolUse',
          toolName: 'Write',
          toolInput: { file_path: '/tmp/x' },
        }).id;
        controller.enqueue(enc.encode(payload.slice(10)));
        controller.close();
      }, 20);
    },
  });
  const req = new Request(`http://localhost/claude/sessions/${NAME}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stream,
    // Node の fetch は stream ボディに duplex 指定を要求する
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const res = await claudeRouter.request(req);
  assert.equal(res.status, 409);
  const json = (await res.json()) as { code: string; currentPendingId: string };
  assert.equal(json.code, 'pending_mismatch');
  // 差し替え後の用件が判定基準になっていること
  assert.notEqual(nextId, '');
  assert.equal(json.currentPendingId, nextId);
  // 弾かれた応答は mutex を握ったままにしない
  assert.equal(store.isRespondLocked(NAME), false);
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
    // 前の応答の mutex が解放されずに残っていないこと (2 周目も処理まで進める)
    assert.notEqual(json.code, 'already_processing');
  }
  assert.equal(store.isRespondLocked(NAME), false);
  store.removeSession(NAME);
});

/** AskUserQuestion の用件を 1 件用意し、その pending id を返す。 */
function setupQuestionPending(questions: AskQuestion[], name = NAME): string {
  store.removeSession(name);
  store.releaseRespondLock(name);
  store.upsertSession({
    ccSessionId: 'cc-1',
    tmuxPane: '%1',
    tmuxSessionName: name,
    cwd: '/tmp',
    source: 'claude',
  });
  return store.createPending(name, {
    kind: 'question',
    hookEvent: 'PreToolUse',
    toolName: 'AskUserQuestion',
    toolInput: {},
    questions,
  }).id;
}

const MULTI_Q: AskQuestion = {
  question: 'pick some',
  multiSelect: true,
  options: [{ label: 'A' }, { label: 'B' }],
};
const SINGLE_Q: AskQuestion = {
  question: 'pick one',
  options: [{ label: 'yes' }, { label: 'no' }],
};

test('複数選択で 1 つも選ばれていない回答は 400 で弾く (キー注入前)', async () => {
  const id = setupQuestionPending([MULTI_Q]);
  const res = await respond({
    kind: 'question',
    pendingId: id,
    answers: [{ question: 'pick some', answerKind: 'predefined', options: [] }],
  });
  assert.equal(res.status, 400);
  const json = (await res.json()) as { code: string; index: number };
  assert.equal(json.code, 'empty_multi_select');
  assert.equal(json.index, 0);
  // 弾いた時点で用件は残したまま (答え直させる) / mutex も解放されている
  assert.equal(store.getPending(NAME)?.id, id);
  assert.equal(store.isRespondLocked(NAME), false);
  store.removeSession(NAME);
});

test('複数選択でも 1 件以上選ばれていれば検証は通る', async () => {
  const id = setupQuestionPending([MULTI_Q]);
  const res = await respond({
    kind: 'question',
    pendingId: id,
    answers: [{ question: 'pick some', answerKind: 'predefined', options: ['A'] }],
  });
  // tmux が無い環境ではキー注入で 500 になるが、少なくとも検証では弾かれない
  assert.notEqual(res.status, 400);
  store.removeSession(NAME);
});

test('Chat about this は、複数選択の質問が未選択のまま混ざっていても通る', async () => {
  // 回帰テスト: 「Chat about this を選ぶ = 質問全体をキャンセル」なので、他の質問の
  // 回答は使われない。ここで empty_multi_select を返していた頃は、複数選択の質問を
  // 含む用件で Chat about this が永久に選べなかった。
  const id = setupQuestionPending([MULTI_Q, SINGLE_Q]);
  const res = await respond({
    kind: 'question',
    pendingId: id,
    answers: [
      { question: 'pick some', answerKind: 'predefined', options: [] },
      { question: 'pick one', answerKind: 'chat-about-this' },
    ],
  });
  const json = (await res.json()) as { code?: string };
  assert.notEqual(res.status, 400);
  assert.notEqual(json.code, 'empty_multi_select');
  store.removeSession(NAME);
});

test('回答が 1 件も無い / 質問数に足りない回答は 400 で弾く', async () => {
  for (const answers of [[], [{ question: 'pick some', answerKind: 'predefined', options: ['A'] }]]) {
    const id = setupQuestionPending([MULTI_Q, SINGLE_Q]);
    const res = await respond({ kind: 'question', pendingId: id, answers });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { code: string };
    assert.equal(json.code, 'answers_length_mismatch');
    // 副作用なし: 用件は残り、mutex も解放されている
    assert.equal(store.getPending(NAME)?.id, id);
    assert.equal(store.isRespondLocked(NAME), false);
    store.removeSession(NAME);
  }
});

test('提示されていない選択肢を指す回答は 400 で弾く', async () => {
  for (const answers of [
    // 単一選択に未定義のラベル
    [{ question: 'pick one', answerKind: 'predefined', option: 'maybe' }],
    // 単一選択が未回答 (空ラベル) のまま
    [{ question: 'pick one', answerKind: 'predefined', option: '' }],
  ]) {
    const id = setupQuestionPending([SINGLE_Q]);
    const res = await respond({ kind: 'question', pendingId: id, answers });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'unknown_option');
    assert.equal(store.getPending(NAME)?.id, id);
    store.removeSession(NAME);
  }
  // 複数選択でも、選ばれたラベルのどれかが未定義なら弾く
  const id = setupQuestionPending([MULTI_Q]);
  const res = await respond({
    kind: 'question',
    pendingId: id,
    answers: [{ question: 'pick some', answerKind: 'predefined', options: ['A', 'C'] }],
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code: string }).code, 'unknown_option');
  store.removeSession(NAME);
});

test('自由入力 (Type something) が空の回答は 400 で弾く', async () => {
  const id = setupQuestionPending([SINGLE_Q]);
  const res = await respond({
    kind: 'question',
    pendingId: id,
    answers: [{ question: 'pick one', answerKind: 'type-something', text: '   ' }],
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code: string }).code, 'empty_text');
  assert.equal(store.getPending(NAME)?.id, id);
  store.removeSession(NAME);
});

test('60 秒以上握られたままの mutex は次の取得時に回収される', async () => {
  // 何かの拍子に finally まで戻らなかった応答処理が残しても、その tmux への送信が
  // 永久に 409 になり続けない (画面から回復できる) ことを保証する。
  const id = setupPending();
  assert.equal(store.acquireRespondLock(NAME), true);
  assert.equal(store.acquireRespondLock(NAME), false);
  store.backdateRespondLockForTest(NAME, 61_000);
  const res = await respond({ kind: 'permission', decision: 'allow', pendingId: id });
  assert.notEqual(((await res.json()) as { code?: string }).code, 'already_processing');
  assert.equal(store.isRespondLocked(NAME), false);
  store.removeSession(NAME);
});
