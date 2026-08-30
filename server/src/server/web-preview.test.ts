import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { resetG2PluginCache } from './g2-plugins.ts';
import { buildWebTabs, resolveInside, servePreviewFromRoot } from './web-preview.ts';

// テスト用の作業フォルダ。実ファイル・実シンボリックリンクで確かめる
// (パストラバーサル対策は realpath まで見るので、モックでは意味がない)。
let root = '';
let outside = '';

before(async () => {
  const base = mkdtempSync(join(tmpdir(), 'headlenss-preview-'));
  root = join(base, 'session');
  outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(join(root, 'report'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });

  await writeFile(join(root, 'index.html'), '<h1>root</h1>');
  await writeFile(join(root, 'report', 'index.html'), '<h1>report</h1>');
  await writeFile(join(root, 'report', 'style.css'), 'body{}');
  await writeFile(join(root, '.env'), 'SECRET=1');
  await writeFile(join(root, '.git', 'config'), '[core]');
  await writeFile(join(outside, 'secret.html'), 'TOP SECRET');
  await symlink(join(outside, 'secret.html'), join(root, 'escape.html'));
  await symlink(outside, join(root, 'escape-dir'));
});

after(() => {
  if (root) rmSync(resolve(root, '..'), { recursive: true, force: true });
});

async function writeConf(text: string): Promise<void> {
  await writeFile(join(root, '.headlenss-plugins.conf'), text);
  resetG2PluginCache(); // conf は 5 秒キャッシュされるので、書き換えたら捨てる
}

// ── resolveInside ─────────────────────────────────────────────────────────

test('resolveInside: フォルダの中のファイルは解決できる', async () => {
  assert.equal(await resolveInside(root, 'index.html'), join(root, 'index.html'));
  assert.equal(await resolveInside(root, 'report/index.html'), join(root, 'report', 'index.html'));
  // URL エンコードは decode してから解決する
  assert.equal(await resolveInside(root, 'report%2Findex.html'), join(root, 'report', 'index.html'));
});

test('resolveInside: パストラバーサルを弾く', async () => {
  const bad = [
    '../outside/secret.html',
    'report/../../outside/secret.html',
    '..%2Foutside%2Fsecret.html',
    '%2e%2e/outside/secret.html',
    // 二重エンコード (%252e%252e) は decode 1 回では `%2e%2e` にしかならないので
    // トラバーサルにはならないが、そんなファイルは無いので解決できないこと
    '%252e%252e/outside/secret.html',
    '..\\outside\\secret.html',
    'report\\index.html',
  ];
  for (const p of bad) {
    assert.equal(await resolveInside(root, p), null, `通してはいけない: ${p}`);
  }
});

test('resolveInside: 壊れたエンコードと NUL を弾く', async () => {
  assert.equal(await resolveInside(root, '%'), null);
  assert.equal(await resolveInside(root, '%zz'), null);
  assert.equal(await resolveInside(root, 'index.html%00.png'), null);
});

test('resolveInside: 隠しファイル / 隠しフォルダを弾く', async () => {
  assert.equal(await resolveInside(root, '.env'), null);
  assert.equal(await resolveInside(root, '.git/config'), null);
  assert.equal(await resolveInside(root, 'report/../.env'), null);
});

test('resolveInside: シンボリックリンクでの脱出を弾く', async () => {
  assert.equal(await resolveInside(root, 'escape.html'), null);
  assert.equal(await resolveInside(root, 'escape-dir/secret.html'), null);
});

test('resolveInside: 実在しないパスは null', async () => {
  assert.equal(await resolveInside(root, 'nope.html'), null);
});

// ── buildWebTabs ──────────────────────────────────────────────────────────

test('buildWebTabs: URL 型はそのまま、ファイル型は /preview の URL になる', async () => {
  await writeConf(['dev = http://h:5173', 'レポート = report/index.html'].join('\n'));
  const tabs = await buildWebTabs('mysession', root);
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs[0], { name: 'dev', kind: 'url', url: 'http://h:5173' });
  assert.equal(tabs[1].name, 'レポート');
  assert.equal(tabs[1].kind, 'file');
  assert.match(tabs[1].url, /^\/preview\/mysession\/report\/index\.html\?v=\d+$/);
});

test('buildWebTabs: 存在しないファイルの宣言は出さない', async () => {
  await writeConf('無い = report/missing.html');
  assert.deepEqual(await buildWebTabs('mysession', root), []);
});

test('buildWebTabs: フォルダの宣言は出さない (通常ファイルだけ)', async () => {
  // `report/` は書式で弾かれるので、そもそも宣言できない
  await writeConf('フォルダ = report/');
  assert.deepEqual(await buildWebTabs('mysession', root), []);
});

test('buildWebTabs: 宣言ファイルが無ければ空', async () => {
  await writeConf('');
  assert.deepEqual(await buildWebTabs('mysession', root), []);
});

test('buildWebTabs: セッション名と日本語ファイル名は URL エンコードされる', async () => {
  await mkdir(join(root, '成果物'), { recursive: true });
  await writeFile(join(root, '成果物', 'レポート.html'), 'x');
  await writeConf('R = 成果物/レポート.html');
  const tabs = await buildWebTabs('my_session-1', root);
  assert.equal(tabs.length, 1);
  assert.match(
    tabs[0].url,
    /^\/preview\/my_session-1\/%E6%88%90%E6%9E%9C%E7%89%A9\/%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88\.html\?v=\d+$/,
  );
});

// ── 配信 (/preview/<session>/<path>) ─────────────────────────────────────

/**
 * servePreviewFromRoot をテスト用の root に固定してリクエストする。
 *
 * 本番 (index.ts) と同じ形にする: ミドルウェアで拾い、その後ろに SPA の
 * フォールバックを置く。パターン登録だと Hono のルータが `..` を含むパスを
 * 一致させず、traversal の試行が SPA まで抜けてしまうため、その回帰も見る。
 */
function makeApp(): Hono {
  const app = new Hono();
  app.use('/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const path = c.req.path;
    if (path !== '/preview' && !path.startsWith('/preview/')) return next();
    const m = /^\/preview\/([^/]+)(\/.*)?$/.exec(path);
    if (m === null) return c.text('Not Found', 404);
    return servePreviewFromRoot(c, m[1], root, m[2]);
  });
  // SPA のフォールバック (ここに落ちたら preview 側が拾い損ねている)
  app.get('/*', (c) => c.html('<!doctype html>SPA'));
  return app;
}

test('配信: ファイル型を宣言していないセッションは 404 (フォルダを開放しない)', async () => {
  await writeConf('dev = http://h:5173'); // URL 型だけ
  const res = await makeApp().request('/preview/s/index.html');
  assert.equal(res.status, 404);
});

test('配信: 宣言があれば作業フォルダ配下を配信する', async () => {
  await writeConf('レポート = report/index.html');
  const app = makeApp();

  const html = await app.request('/preview/s/report/index.html');
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(html.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(html.headers.get('access-control-allow-origin'), '*');
  assert.equal(await html.text(), '<h1>report</h1>');

  // 宣言していない同フォルダの資材も出す (HTML が相対パスで読むため)
  const css = await app.request('/preview/s/report/style.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
});

test('配信: フォルダは index.html に落とす / 末尾なしは / へリダイレクト', async () => {
  await writeConf('レポート = report/index.html');
  const app = makeApp();

  const dir = await app.request('/preview/s/report');
  assert.equal(dir.status, 200);
  assert.equal(await dir.text(), '<h1>report</h1>');

  const rootDir = await app.request('/preview/s/');
  assert.equal(rootDir.status, 200);
  assert.equal(await rootDir.text(), '<h1>root</h1>');

  const noSlash = await app.request('/preview/s');
  assert.equal(noSlash.status, 302);
  assert.equal(noSlash.headers.get('location'), '/preview/s/');
});

test('配信: パストラバーサル・隠しファイル・symlink 脱出は 404', async () => {
  await writeConf('レポート = report/index.html');
  const app = makeApp();
  const bad = [
    // 素の `..` は fetch の URL 解決で潰れて /preview/ 配下に来ないので、
    // ここでは「エンコードして生き残る形」を見る (素の形は次のテスト)。
    '/preview/s/..%2F..%2Fetc%2Fpasswd',
    '/preview/s/report/..%2F..%2Foutside%2Fsecret.html',
    '/preview/s/%2e%2e/outside/secret.html',
    '/preview/s/.env',
    '/preview/s/.git/config',
    '/preview/s/escape.html',
    '/preview/s/escape-dir/secret.html',
    '/preview/s/report/style.css%00.html',
  ];
  for (const p of bad) {
    const res = await app.request(p);
    assert.equal(res.status, 404, `通してはいけない: ${p} (status ${res.status})`);
  }
});

test('配信: 正規化されていない `..` が届いても 404', async () => {
  // curl --path-as-is のように、生の `..` がそのままサーバまで来た場合。
  // fetch/Request では URL が正規化されて再現できないので、配信の本体を直接叩く。
  await writeConf('レポート = report/index.html');
  const app = new Hono();
  app.get('/probe', (c) => servePreviewFromRoot(c, 's', root, '/../../etc/passwd'));
  app.get('/probe2', (c) => servePreviewFromRoot(c, 's', root, '/report/../../outside/secret.html'));
  assert.equal((await app.request('/probe')).status, 404);
  assert.equal((await app.request('/probe2')).status, 404);
});

test('配信: HEAD は本文なしで Content-Length を返す', async () => {
  await writeConf('レポート = report/index.html');
  const res = await makeApp().request('/preview/s/report/index.html', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(Buffer.byteLength('<h1>report</h1>')));
  assert.equal(await res.text(), '');
});
