import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isPaneId, isShellPane } from './agent-pane.ts';

test('pane ID の形だけを受け付ける', () => {
  assert.equal(isPaneId('%7'), true);
  assert.equal(isPaneId('%12'), true);
  // セッション名は pane ID ではない (これを取り違えると宛先がアクティブ pane に戻る)
  assert.equal(isPaneId('make15'), false);
  assert.equal(isPaneId(''), false);
  assert.equal(isPaneId('%'), false);
  assert.equal(isPaneId('%7a'), false);
  assert.equal(isPaneId('7'), false);
});

test('シェルの pane は「エージェントがいる」とみなさない', () => {
  // エージェント終了後にシェルへ戻った pane へ送ると、文字列がシェルの入力になる。
  for (const cmd of ['bash', 'zsh', 'sh', 'fish', 'pwsh', ' bash ']) {
    assert.equal(isShellPane(cmd), true, cmd);
  }
  // エージェントや dev server はシェル扱いしない (シェル判定は送信可否の否定側にのみ使う)
  for (const cmd of ['claude', 'codex', 'node', 'npm', 'vite', '']) {
    assert.equal(isShellPane(cmd), false, cmd);
  }
});
