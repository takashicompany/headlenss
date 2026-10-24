import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectG2Plugins,
  normalizeConfRelPath,
  parsePluginConf,
  resetG2PluginCache,
  showsOnWeb,
} from './g2-plugins.ts';

test('名前 = URL を読む (URL 型)', () => {
  const got = parsePluginConf([
    'Greensky       = http://ubook.mogera-fir.ts.net:5173',
    'Greensky proxy = http://ubook.mogera-fir.ts.net:6173',
  ].join('\n'));
  assert.deepEqual(got, [
    { name: 'Greensky', kind: 'url', url: 'http://ubook.mogera-fir.ts.net:5173', targets: null },
    { name: 'Greensky proxy', kind: 'url', url: 'http://ubook.mogera-fir.ts.net:6173', targets: null },
  ]);
});

test('コメントと空行を無視し、行末コメントも落とす', () => {
  const got = parsePluginConf([
    '# 開発用',
    '',
    '   ',
    'A = http://h:1  # 行末コメント',
  ].join('\n'));
  assert.deepEqual(got, [{ name: 'A', kind: 'url', url: 'http://h:1', targets: null }]);
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
  assert.deepEqual(got, [{ name: 'E', kind: 'url', url: 'https://h:2', targets: null }]);
});

test('名前が重複したら先勝ち (型が違っても同じ)', () => {
  assert.deepEqual(parsePluginConf('A = http://h:1\nA = http://h:2'), [
    { name: 'A', kind: 'url', url: 'http://h:1', targets: null },
  ]);
  assert.deepEqual(parsePluginConf('A = report/index.html\nA = http://h:2'), [
    { name: 'A', kind: 'file', relPath: 'report/index.html' },
  ]);
});

test('URL 内の = は壊さない (最初の = だけを区切りにする)', () => {
  const got = parsePluginConf('A = http://h:1/?x=1&y=2');
  assert.deepEqual(got, [{ name: 'A', kind: 'url', url: 'http://h:1/?x=1&y=2', targets: null }]);
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
    { name: 'dev', kind: 'url', url: 'http://h:5173', targets: null },
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


// ── 対象指定トークン (web / g2) ───────────────────────────────────────────

test('URL の後ろに web / g2 を書くと出す先を明示できる', () => {
  const got = parsePluginConf([
    'W  = http://h:1 web',
    'G  = http://h:2 g2',
    'WG = http://h:3 web g2',
    'GW = http://h:4 g2 web',
  ].join('\n'));
  assert.deepEqual(got, [
    { name: 'W', kind: 'url', url: 'http://h:1', targets: { web: true, g2: false } },
    { name: 'G', kind: 'url', url: 'http://h:2', targets: { web: false, g2: true } },
    { name: 'WG', kind: 'url', url: 'http://h:3', targets: { web: true, g2: true } },
    { name: 'GW', kind: 'url', url: 'http://h:4', targets: { web: true, g2: true } },
  ]);
});

test('対象指定は大文字小文字を問わない / 空白の量も問わない', () => {
  assert.deepEqual(parsePluginConf('A = http://h:1   WEB\tG2'), [
    { name: 'A', kind: 'url', url: 'http://h:1', targets: { web: true, g2: true } },
  ]);
});

test('知らないトークンが混ざった行は捨てる (黙って無指定に落とさない)', () => {
  const got = parsePluginConf([
    'typo  = http://h:1 wev',
    'mixed = http://h:2 web wev',
    'ok    = http://h:3 web',
  ].join('\n'));
  assert.deepEqual(got, [
    { name: 'ok', kind: 'url', url: 'http://h:3', targets: { web: true, g2: false } },
  ]);
});

test('ファイル型に対象指定を書いても無視され、パスは壊れない', () => {
  const got = parsePluginConf([
    'R = report/index.html g2',
    'S = report/index.html web g2',
  ].join('\n'));
  assert.deepEqual(got, [
    { name: 'R', kind: 'file', relPath: 'report/index.html' },
    { name: 'S', kind: 'file', relPath: 'report/index.html' },
  ]);
});

test('空白を含むファイル名は対象指定と取り違えない', () => {
  assert.deepEqual(parsePluginConf('R = 成果物/レポート 1.html'), [
    { name: 'R', kind: 'file', relPath: '成果物/レポート 1.html' },
  ]);
  // 末尾が既知のトークンでなければ 1 文字も剥がさない
  assert.deepEqual(parsePluginConf('R = a/b web.html'), [
    { name: 'R', kind: 'file', relPath: 'a/b web.html' },
  ]);
});

// ── showsOnWeb (Web のタブに出すか) ───────────────────────────────────────

test('showsOnWeb: g2 だけを明示したものだけ Web から外れる', () => {
  assert.equal(showsOnWeb({ name: 'a', kind: 'url', url: 'http://h:1', targets: null }), true);
  assert.equal(
    showsOnWeb({ name: 'a', kind: 'url', url: 'http://h:1', targets: { web: true, g2: false } }),
    true,
  );
  assert.equal(
    showsOnWeb({ name: 'a', kind: 'url', url: 'http://h:1', targets: { web: true, g2: true } }),
    true,
  );
  assert.equal(
    showsOnWeb({ name: 'a', kind: 'url', url: 'http://h:1', targets: { web: false, g2: true } }),
    false,
  );
  assert.equal(showsOnWeb({ name: 'a', kind: 'file', relPath: 'x.html' }), true);
});

// ── detectG2Plugins (対象指定つき) ────────────────────────────────────────
//
// 「応答があるものだけ出す」は従来どおりなので、実サーバで確かめる。

const STUB_HTML = '<!DOCTYPE html><html><head><title>stub</title></head><body>stub</body></html>';

function listen(): Promise<{ server: Server; url: string }> {
  return new Promise((ok) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(STUB_HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      ok({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function withConf<T>(text: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'headlenss-g2-'));
  try {
    await writeFile(join(dir, '.headlenss-plugins.conf'), text);
    resetG2PluginCache();
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetG2PluginCache();
  }
}

test('対象指定なしの URL は既定でグラスに出る (従来どおりの挙動)', async () => {
  const a = await listen();
  const b = await listen();
  try {
    await withConf([`A = ${a.url}`, `B = ${b.url}/x`].join('\n'), async (dir) => {
      assert.deepEqual(await detectG2Plugins(dir), [
        { name: 'A', url: a.url },
        { name: 'B', url: `${b.url}/x` },
      ]);
    });
  } finally {
    a.server.close();
    b.server.close();
  }
});

test('明示指定でグラスに出す先を絞れる (web は出ない / g2 と web g2 は出る)', async () => {
  const a = await listen();
  try {
    await withConf(
      [`W = ${a.url}/w web`, `G = ${a.url}/g g2`, `B = ${a.url}/b web g2`].join('\n'),
      async (dir) => {
        assert.deepEqual(await detectG2Plugins(dir), [
          { name: 'G', url: `${a.url}/g` },
          { name: 'B', url: `${a.url}/b` },
        ]);
      },
    );
  } finally {
    a.server.close();
  }
});

test('応答しない URL は対象指定に関わらず出ない', async () => {
  const dead = await listen();
  const deadUrl = dead.url;
  await new Promise<void>((ok) => dead.server.close(() => ok()));
  await withConf([`A = ${deadUrl}`, `B = ${deadUrl}/x g2`].join('\n'), async (dir) => {
    assert.deepEqual(await detectG2Plugins(dir), []);
  });
});

test('ファイル型はグラスに出ない (対象指定を書いても同じ)', async () => {
  await withConf('R = report/index.html g2', async (dir) => {
    assert.deepEqual(await detectG2Plugins(dir), []);
  });
});
