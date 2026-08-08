import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isPaneId } from './agent-pane.ts';

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
