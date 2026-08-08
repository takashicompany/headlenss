import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parsePluginConf } from './g2-plugins.ts';

test('名前 = URL を読む', () => {
  const got = parsePluginConf([
    'Greensky       = http://ubook.mogera-fir.ts.net:5173',
    'Greensky proxy = http://ubook.mogera-fir.ts.net:6173',
  ].join('\n'));
  assert.deepEqual(got, [
    { name: 'Greensky', url: 'http://ubook.mogera-fir.ts.net:5173' },
    { name: 'Greensky proxy', url: 'http://ubook.mogera-fir.ts.net:6173' },
  ]);
});

test('コメントと空行を無視し、行末コメントも落とす', () => {
  const got = parsePluginConf([
    '# 開発用',
    '',
    '   ',
    'A = http://h:1  # 行末コメント',
  ].join('\n'));
  assert.deepEqual(got, [{ name: 'A', url: 'http://h:1' }]);
});

test('壊れた行は捨てる: 区切り無し / 名前空 / URL空 / URL不正 / 非http', () => {
  const got = parsePluginConf([
    'no-separator-here',
    ' = http://h:1',
    'B =',
    'C = ::::',
    'D = ftp://h/x',
    'E = https://h:2',
  ].join('\n'));
  assert.deepEqual(got, [{ name: 'E', url: 'https://h:2' }]);
});

test('名前が重複したら先勝ち', () => {
  const got = parsePluginConf('A = http://h:1\nA = http://h:2');
  assert.deepEqual(got, [{ name: 'A', url: 'http://h:1' }]);
});

test('URL 内の = は壊さない (最初の = だけを区切りにする)', () => {
  const got = parsePluginConf('A = http://h:1/?x=1&y=2');
  assert.deepEqual(got, [{ name: 'A', url: 'http://h:1/?x=1&y=2' }]);
});
