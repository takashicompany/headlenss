import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  observeSessionStatus,
  pickClaudeDetected,
  pickEffectiveSource,
  pruneSessionStatusObservations,
  resetSessionStatusObservations,
  resolveSessionStatus,
  resolveTrackedSessionStatus,
  type ClaudeDetectedInput,
  type CodexDetectedInput,
  type LiveOwnerInput,
  type StoreStatusInput,
} from './session-status.ts';

const NAME = 'make15';

/** 引数の組み立てを 1 箇所にして、呼び出し側 (2 つのエンドポイント) の差を作らない。 */
function status(opts: {
  source: 'claude' | 'codex';
  store?: StoreStatusInput;
  claudeDetected?: ClaudeDetectedInput[];
  codexDetected?: CodexDetectedInput[];
  liveOwner?: LiveOwnerInput;
}) {
  return resolveSessionStatus({
    source: opts.source,
    tmuxSessionName: NAME,
    store: opts.store,
    claudeDetected: opts.claudeDetected ?? [],
    codexDetected: opts.codexDetected ?? [],
    liveOwner: opts.liveOwner,
  });
}

const claudeDet = (pid: number, s: 'idle' | 'busy'): ClaudeDetectedInput => ({
  pid,
  tmuxSessionName: NAME,
  status: s,
});

test('Claude: busy は検出側からしか来ない (フック導入済みでも拾う)', () => {
  // フックが入っている = store がある。store の status は idle のままだが、
  // registry が busy を報告しているなら busy を返す (これが今回の修正点)。
  assert.equal(
    status({ source: 'claude', store: { status: 'idle', source: 'claude' }, claudeDetected: [claudeDet(1, 'busy')] }),
    'busy',
  );
  // フック未導入 (store 無し) でも同じ。
  assert.equal(status({ source: 'claude', claudeDetected: [claudeDet(1, 'busy')] }), 'busy');
  // 検出が idle / 未検出なら idle。
  assert.equal(
    status({ source: 'claude', store: { status: 'idle', source: 'claude' }, claudeDetected: [claudeDet(1, 'idle')] }),
    'idle',
  );
  assert.equal(status({ source: 'claude' }), 'idle');
});

test('Claude: waiting-* はフック側からしか来ないので検出より優先', () => {
  assert.equal(
    status({
      source: 'claude',
      store: { status: 'waiting-permission', source: 'claude' },
      claudeDetected: [claudeDet(1, 'busy')],
    }),
    'waiting-permission',
  );
  assert.equal(
    status({
      source: 'claude',
      store: { status: 'waiting-question', source: 'claude' },
      claudeDetected: [claudeDet(1, 'busy')],
    }),
    'waiting-question',
  );
  assert.equal(
    status({ source: 'claude', store: { status: 'waiting-permission', source: 'claude' } }),
    'waiting-permission',
  );
});

test('Claude: Stop hook 済みなら registry の busy は idle に落とす', () => {
  assert.equal(
    status({
      source: 'claude',
      store: { status: 'idle', source: 'claude', lastStopAt: 1 },
      claudeDetected: [claudeDet(1, 'busy')],
    }),
    'idle',
  );
  // waiting-* は Stop マーカーがあっても潰さない (許可待ちは継続中)。検出が無い場合も同様。
  assert.equal(
    status({
      source: 'claude',
      store: { status: 'waiting-permission', source: 'claude', lastStopAt: 1 },
      claudeDetected: [claudeDet(1, 'busy')],
    }),
    'waiting-permission',
  );
  assert.equal(
    status({ source: 'claude', store: { status: 'waiting-question', source: 'claude', lastStopAt: 1 } }),
    'waiting-question',
  );
});

test('別 agent の残骸 store は status に混ぜない', () => {
  // live owner が claude に替わった直後、store には codex の残骸が残っている。
  assert.equal(
    status({
      source: 'claude',
      store: { status: 'waiting-permission', source: 'codex' },
      claudeDetected: [claudeDet(1, 'idle')],
    }),
    'idle',
  );
  // source 未設定の古い store も使わない (どちらのランのものか分からないため)。
  assert.equal(status({ source: 'claude', store: { status: 'waiting-question' } }), 'idle');
  assert.equal(
    status({ source: 'codex', store: { status: 'busy', source: 'claude' }, codexDetected: [] }),
    'idle',
  );
});

test('Codex: フックの busy を採用しつつ、pane 由来の waiting-permission も拾う', () => {
  assert.equal(status({ source: 'codex', store: { status: 'busy', source: 'codex' } }), 'busy');
  assert.equal(
    status({
      source: 'codex',
      store: { status: 'idle', source: 'codex' },
      codexDetected: [{ tmuxSessionName: NAME, status: 'waiting-permission' }],
    }),
    'waiting-permission',
  );
  assert.equal(
    status({ source: 'codex', codexDetected: [{ tmuxSessionName: NAME, status: 'waiting-permission' }] }),
    'waiting-permission',
  );
  assert.equal(status({ source: 'codex' }), 'idle');
});

test('Codex: lastStopAt は見ない (Stop 相当のフックが idle を直接書くため)', () => {
  // Claude 側と違い、Stop マーカーが立っていてもフックの busy はそのまま返す。
  assert.equal(
    status({ source: 'codex', store: { status: 'busy', source: 'codex', lastStopAt: 1 } }),
    'busy',
  );
});

test('Claude det の選択: live owner が claude なら owner PID 一致分のみ (fail-closed)', () => {
  const interactive = claudeDet(100, 'idle');
  const headless = claudeDet(200, 'busy'); // 同じ tmux セッションで動く `claude -p`
  const owner: LiveOwnerInput = { source: 'claude', pid: 100 };

  assert.equal(pickClaudeDetected(NAME, [interactive, headless], owner), interactive);
  // owner の PID が検出に出ていないなら「不明」に倒す (別 PID の busy を拾わない)。
  assert.equal(pickClaudeDetected(NAME, [headless], owner), undefined);
  // owner 不明 / codex のときは従来どおり名前一致 (同名なら後勝ち)。
  assert.equal(pickClaudeDetected(NAME, [interactive, headless], undefined), headless);
  assert.equal(pickClaudeDetected(NAME, [interactive, headless], { source: 'codex', pid: 300 }), headless);
  assert.equal(pickClaudeDetected('other', [interactive], undefined), undefined);
  // PID が一致しても tmux セッション名が違う検出結果は使わない (別セッションの状態を出さない)。
  const otherSession: ClaudeDetectedInput = { pid: 100, tmuxSessionName: 'other', status: 'busy' };
  assert.equal(pickClaudeDetected(NAME, [otherSession], owner), undefined);
});

test('実効ソース: live owner → store → claude 検出 → codex 検出 の順で決まる', () => {
  const signals = (over: Partial<Parameters<typeof pickEffectiveSource>[0]>) =>
    pickEffectiveSource({
      tmuxSessionName: NAME,
      claudeDetected: [],
      codexDetected: [],
      ...over,
    });

  // live owner が最優先 (store や検出が別 agent を指していても owner が勝つ)。
  assert.equal(
    signals({
      liveOwner: { source: 'codex', pid: 1 },
      store: { status: 'idle', source: 'claude' },
      claudeDetected: [claudeDet(1, 'idle')],
    }),
    'codex',
  );
  // owner 不明なら store で sticky。
  assert.equal(
    signals({ store: { status: 'idle', source: 'codex' }, claudeDetected: [claudeDet(1, 'idle')] }),
    'codex',
  );
  // owner も store も無ければ検出。claude 検出を先に見る (両方あっても claude)。
  assert.equal(
    signals({
      claudeDetected: [claudeDet(1, 'idle')],
      codexDetected: [{ tmuxSessionName: NAME, status: 'idle' }],
    }),
    'claude',
  );
  assert.equal(signals({ codexDetected: [{ tmuxSessionName: NAME, status: 'idle' }] }), 'codex');
  // 何も無ければ不明。source 未設定の古い store も判断材料にしない。
  assert.equal(signals({}), undefined);
  assert.equal(signals({ store: { status: 'idle' } }), undefined);
  // 別セッションの検出結果に引きずられない。
  assert.equal(signals({ claudeDetected: [{ pid: 1, tmuxSessionName: 'other', status: 'busy' }] }), undefined);
});

test('同一セッションに対話 claude と claude -p が居ても両エンドポイントで status が一致する', () => {
  // 回帰の再現: 名前一致 last-wins だと、対話 claude が idle なのに
  // ヘッドレスの `claude -p` (busy) を拾って busy になる。
  // status 判定は det の選択ごと共有関数に閉じているので、どちらの呼び出し側も同じ答えになる。
  const detected = [claudeDet(100, 'idle'), claudeDet(200, 'busy')];
  const owner: LiveOwnerInput = { source: 'claude', pid: 100 };
  const store: StoreStatusInput = { status: 'idle', source: 'claude' };

  assert.equal(status({ source: 'claude', store, claudeDetected: detected, liveOwner: owner }), 'idle');
  // 対話側が本当に busy なら busy になる (fail-closed が busy を殺していないことの確認)。
  assert.equal(
    status({
      source: 'claude',
      store,
      claudeDetected: [claudeDet(100, 'busy'), claudeDet(200, 'idle')],
      liveOwner: owner,
    }),
    'busy',
  );
});

test('statusChangedAt: 初回観測は今の時刻、同じ status が続く間は動かない', () => {
  resetSessionStatusObservations();
  assert.equal(observeSessionStatus(NAME, 'busy', 1_000), 1_000);
  // 同じ status を何度観測しても最初の時刻のまま (同一リクエスト内 / 並行リクエストでも安全)。
  assert.equal(observeSessionStatus(NAME, 'busy', 2_000), 1_000);
  assert.equal(observeSessionStatus(NAME, 'busy', 3_000), 1_000);
});

test('statusChangedAt: status が変わった時だけ更新される', () => {
  resetSessionStatusObservations();
  assert.equal(observeSessionStatus(NAME, 'busy', 1_000), 1_000);
  assert.equal(observeSessionStatus(NAME, 'waiting-permission', 2_000), 2_000);
  assert.equal(observeSessionStatus(NAME, 'idle', 3_000), 3_000);
  assert.equal(observeSessionStatus(NAME, 'idle', 4_000), 3_000);
  // 元の status に戻ったら「その時に入り直した」扱い。
  assert.equal(observeSessionStatus(NAME, 'busy', 5_000), 5_000);
  // セッションごとに独立。
  assert.equal(observeSessionStatus('other', 'busy', 6_000), 6_000);
  assert.equal(observeSessionStatus(NAME, 'busy', 7_000), 5_000);
});

test('statusChangedAt: 生きていない tmux セッションのエントリは掃除される', () => {
  resetSessionStatusObservations();
  observeSessionStatus(NAME, 'busy', 1_000);
  observeSessionStatus('other', 'busy', 1_000);
  pruneSessionStatusObservations([NAME]);
  // 残った方は時刻を保持。
  assert.equal(observeSessionStatus(NAME, 'busy', 2_000), 1_000);
  // 捨てられた方は初回観測扱いに戻る。
  assert.equal(observeSessionStatus('other', 'busy', 2_000), 2_000);
});

test('resolveTrackedSessionStatus: 解決した status と観測時刻を返す', () => {
  resetSessionStatusObservations();
  const input = {
    source: 'claude' as const,
    tmuxSessionName: NAME,
    store: { status: 'idle' as const, source: 'claude' as const },
    claudeDetected: [claudeDet(1, 'busy')],
    codexDetected: [],
  };
  assert.deepEqual(resolveTrackedSessionStatus(input, 1_000), { status: 'busy', statusChangedAt: 1_000 });
  // busy が続く間は時刻据え置き。
  assert.deepEqual(resolveTrackedSessionStatus(input, 2_000), { status: 'busy', statusChangedAt: 1_000 });
  // idle に落ちたら更新。
  assert.deepEqual(
    resolveTrackedSessionStatus({ ...input, claudeDetected: [claudeDet(1, 'idle')] }, 3_000),
    { status: 'idle', statusChangedAt: 3_000 },
  );
});
