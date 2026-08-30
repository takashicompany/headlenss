import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeConfRelPath, parsePluginConf } from './g2-plugins.ts';

test('名前 = URL を読む (URL 型)', () => {
  const got = parsePluginConf([
    'Greensky       = http://ubook.mogera-fir.ts.net:5173',
    'Greensky proxy = http://ubook.mogera-fir.ts.net:6173',
  ].join('\n'));
  assert.deepEqual(got, [
    { name: 'Greensky', kind: 'url', url: 'http://ubook.mogera-fir.ts.net:5173' },
    { name: 'Greensky proxy', kind: 'url', url: 'http://ubook.mogera-fir.ts.net:6173' },
  ]);
});

test('コメントと空行を無視し、行末コメントも落とす', () => {
  const got = parsePluginConf([
    '# 開発用',
    '',
    '   ',
    'A = http://h:1  # 行末コメント',
  ].join('\n'));
  assert.deepEqual(got, [{ name: 'A', kind: 'url', url: 'http://h:1' }]);
});

test('壊れた行は捨てる: 区切り無し / 名前空 / 値空 / URL不正 / 非http', () => {
  const got = parsePluginConf([
    'no-separator-here',
    ' = http://h:1',
    'B =',
    'C = ::::',
    'D = ftp://h/x',
    'E = https://h:2',
  ].join('\n'));
  assert.deepEqual(got, [{ name: 'E', kind: 'url', url: 'https://h:2' }]);
});

test('名前が重複したら先勝ち (型が違っても同じ)', () => {
  assert.deepEqual(parsePluginConf('A = http://h:1\nA = http://h:2'), [
    { name: 'A', kind: 'url', url: 'http://h:1' },
  ]);
  assert.deepEqual(parsePluginConf('A = report/index.html\nA = http://h:2'), [
    { name: 'A', kind: 'file', relPath: 'report/index.html' },
  ]);
});

test('URL 内の = は壊さない (最初の = だけを区切りにする)', () => {
  const got = parsePluginConf('A = http://h:1/?x=1&y=2');
  assert.deepEqual(got, [{ name: 'A', kind: 'url', url: 'http://h:1/?x=1&y=2' }]);
});

// ── ファイル型 (Web のプレビュータブ専用) ────────────────────────────────

test('scheme が無い値は作業フォルダ相対のファイルとして読む', () => {
  const got = parsePluginConf([
    'レポート = report/index.html',
    '単体     = out.html',
    '入れ子   = a/b/c/index.html',
  ].join('\n'));
  assert.deepEqual(got, [
    { name: 'レポート', kind: 'file', relPath: 'report/index.html' },
    { name: '単体', kind: 'file', relPath: 'out.html' },
    { name: '入れ子', kind: 'file', relPath: 'a/b/c/index.html' },
  ]);
});

test('URL 型とファイル型は同じファイルに混在できる', () => {
  const got = parsePluginConf([
    'dev  = http://h:5173',
    'report = report/index.html',
  ].join('\n'));
  assert.deepEqual(got, [
    { name: 'dev', kind: 'url', url: 'http://h:5173' },
    { name: 'report', kind: 'file', relPath: 'report/index.html' },
  ]);
});

test('危険な相対パスは宣言の時点で落とす', () => {
  const bad = [
    '../etc/passwd',
    'a/../../etc/passwd',
    '/etc/passwd',
    '~/secret.html',
    '.env',
    '.git/config',
    'a/.git/config',
    'a\\b.html',
    'dir/',
    'a//b.html',
    'a:b.html',
    'a?b.html',
  ];
  for (const v of bad) {
    assert.equal(normalizeConfRelPath(v), null, `受け付けてはいけない: ${v}`);
  }
  const got = parsePluginConf(bad.map((v, i) => `n${i} = ${v}`).join('\n'));
  assert.deepEqual(got, []);
});

test('先頭の ./ と途中の . は取り除く', () => {
  assert.equal(normalizeConfRelPath('./report/index.html'), 'report/index.html');
  assert.equal(normalizeConfRelPath('a/./b.html'), 'a/b.html');
});

test('日本語や空白を含むファイル名も受け付ける', () => {
  assert.equal(normalizeConfRelPath('成果物/レポート 1.html'), '成果物/レポート 1.html');
});
