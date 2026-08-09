import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveClaudeStatus, resolveCodexStatus, resolveSessionStatus } from './session-status.ts';

test('Claude: busy は検出側からしか来ない (フック導入済みでも拾う)', () => {
  // フックが入っている = store がある。store の status は idle のままだが、
  // registry が busy を報告しているなら busy を返す。
  assert.equal(resolveClaudeStatus({ status: 'idle' }, { status: 'busy' }), 'busy');
  // フック未導入 (store 無し) でも同じ。
  assert.equal(resolveClaudeStatus(undefined, { status: 'busy' }), 'busy');
  // 検出が idle / 未検出なら idle。
  assert.equal(resolveClaudeStatus({ status: 'idle' }, { status: 'idle' }), 'idle');
  assert.equal(resolveClaudeStatus(undefined, undefined), 'idle');
});

test('Claude: waiting-* はフック側からしか来ないので検出より優先', () => {
  assert.equal(resolveClaudeStatus({ status: 'waiting-permission' }, { status: 'busy' }), 'waiting-permission');
  assert.equal(resolveClaudeStatus({ status: 'waiting-question' }, { status: 'busy' }), 'waiting-question');
  assert.equal(resolveClaudeStatus({ status: 'waiting-permission' }, undefined), 'waiting-permission');
});

test('Claude: Stop hook 済みなら registry の busy は idle に落とす', () => {
  assert.equal(resolveClaudeStatus({ status: 'idle', lastStopAt: 1 }, { status: 'busy' }), 'idle');
  // waiting-* は Stop マーカーがあっても消さない (許可待ちは継続中)。
  assert.equal(
    resolveClaudeStatus({ status: 'waiting-permission', lastStopAt: 1 }, { status: 'busy' }),
    'waiting-permission',
  );
});

test('Codex: フックの busy を採用しつつ、pane 由来の waiting-permission も拾う', () => {
  assert.equal(resolveCodexStatus({ status: 'busy' }, undefined), 'busy');
  assert.equal(resolveCodexStatus({ status: 'idle' }, { status: 'waiting-permission' }), 'waiting-permission');
  assert.equal(resolveCodexStatus(undefined, { status: 'waiting-permission' }), 'waiting-permission');
  assert.equal(resolveCodexStatus(undefined, undefined), 'idle');
  // フックが idle 以外を主張していればそちらが勝つ。
  assert.equal(resolveCodexStatus({ status: 'waiting-question' }, { status: 'waiting-permission' }), 'waiting-question');
});

test('別 agent の残骸 store は渡さない前提: undefined なら検出だけで決まる', () => {
  assert.equal(resolveSessionStatus('claude', undefined, { status: 'busy' }), 'busy');
  assert.equal(resolveSessionStatus('codex', undefined, { status: 'waiting-permission' }), 'waiting-permission');
});

test('入口関数はソースごとに同じ結果を返す', () => {
  const store = { status: 'idle' as const };
  const det = { status: 'busy' as const };
  assert.equal(resolveSessionStatus('claude', store, det), resolveClaudeStatus(store, det));
  assert.equal(resolveSessionStatus('codex', store, det), resolveCodexStatus(store, det));
});
