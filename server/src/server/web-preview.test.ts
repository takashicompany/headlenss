import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { readDeclarations, removeEntryFromConfText, resetG2PluginCache } from './g2-plugins.ts';
import { buildWebTabs, deleteWebTabFromRoot, resolveInside, servePreviewFromRoot } from './web-preview.ts';

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
  assert.deepEqual(tabs[0], { name: 'dev', kind: 'url', url: 'http://h:5173', g2: true });
  assert.equal(tabs[1].g2, false); // ファイル型はグラスに出ない
  assert.equal(tabs[1].name, 'レポート');
  assert.equal(tabs[1].kind, 'file');
  assert.match(tabs[1].url, /^\/preview\/mysession\/report\/index\.html\?v=\d+$/);
});

test('buildWebTabs: g2 だけを明示した URL は出さない (グラス専用)', async () => {
  await writeConf([
    'onlyG2 = http://h:5173 g2',
    'both   = http://h:5174 web g2',
    'onlyWeb = http://h:5175 web',
    'auto   = http://h:5176',
  ].join('\n'));
  assert.deepEqual(await buildWebTabs('mysession', root), [
    { name: 'both', kind: 'url', url: 'http://h:5174', g2: true },
    { name: 'onlyWeb', kind: 'url', url: 'http://h:5175', g2: false },
    { name: 'auto', kind: 'url', url: 'http://h:5176', g2: true },
  ]);
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

// ── タブを閉じる (宣言行の削除) ───────────────────────────────────────────

test('removeEntryFromConfText: 対象の行だけ消え、コメント・空行・他の行・CRLF は残る', () => {
  const text = '# 先頭コメント\r\nA = http://a.example:1 web\r\n\r\n# B の説明\r\nB = report/index.html # 行末コメント\r\nC = http://c.example:3\r\n';
  const out = removeEntryFromConfText(text, 'B');
  assert.equal(out.removed, 1);
  assert.equal(out.text, '# 先頭コメント\r\nA = http://a.example:1 web\r\n\r\n# B の説明\r\nC = http://c.example:3\r\n');
  // 名前の前方一致・部分一致では消さない / コメント内の同名は消さない
  const t2 = 'AB = x.html\n# A = y.html\nA = z.html\n';
  assert.equal(removeEntryFromConfText(t2, 'A').text, 'AB = x.html\n# A = y.html\n');
  // 無い名前なら何も変えない
  assert.deepEqual(removeEntryFromConfText(t2, 'Z'), { text: t2, removed: 0 });
});

test('removeEntryFromConfText: 重複していた後ろの行もまとめて消す (繰り上がって復活しない)', () => {
  const out = removeEntryFromConfText('A = a.html\nB = b.html\nA = other.html\n', 'A');
  assert.equal(out.removed, 2);
  assert.equal(out.text, 'B = b.html\n');
});

/** deleteWebTabFromRoot を実際のルートと同じパターンで叩く (URL デコードも込みで確かめる) */
function makeDeleteApp(): Hono {
  const app = new Hono();
  app.delete('/api/sessions/:name/webtabs/:entryName', (c) =>
    deleteWebTabFromRoot(c, c.req.param('name'), root, c.req.param('entryName')),
  );
  return app;
}

const del = (entry: string) =>
  makeDeleteApp().request(`/api/sessions/s/webtabs/${encodeURIComponent(entry)}`, { method: 'DELETE' });

test('タブ削除: 該当行だけが conf から消え、一覧からも消える', async () => {
  const conf =
    '# 成果物\nレポート 1 = report/index.html\nブラウザ確認 = http://127.0.0.1:9 web\n# 末尾コメント\n';
  await writeConf(conf);
  const res = await del('レポート 1');
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; tabs: { name: string }[] };
  assert.equal(json.ok, true);
  assert.deepEqual(json.tabs.map((t) => t.name), ['ブラウザ確認']);
  assert.equal(
    await readFile(join(root, '.headlenss-plugins.conf'), 'utf-8'),
    '# 成果物\nブラウザ確認 = http://127.0.0.1:9 web\n# 末尾コメント\n',
  );
  // キャッシュを手で捨てなくても、読み直した結果に反映されている
  assert.deepEqual((await readDeclarations(root)).map((e) => e.name), ['ブラウザ確認']);
  // 一時ファイルが残っていない
  const leftovers = (await readdir(root)).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('タブ削除: 最後の 1 件を消しても conf ファイル自体は残る', async () => {
  await writeConf('# だけ残る\nレポート = report/index.html\n');
  assert.equal((await del('レポート')).status, 200);
  assert.equal(await readFile(join(root, '.headlenss-plugins.conf'), 'utf-8'), '# だけ残る\n');
});

test('タブ削除: 存在しないエントリ・コメント内の名前・壊れた行・グラス専用は 404 で、conf は変わらない', async () => {
  const conf = '# 消えない = report/index.html\nこわれた行\nG2専用 = http://127.0.0.1:9 g2\nレポート = report/index.html\n';
  await writeConf(conf);
  for (const name of ['無い', '消えない', 'こわれた行', 'G2専用', 'レポー']) {
    const res = await del(name);
    assert.equal(res.status, 404, `404 であるべき: ${name}`);
  }
  assert.equal(await readFile(join(root, '.headlenss-plugins.conf'), 'utf-8'), conf);
});

test('タブ削除: conf が無いフォルダは 404 で、ファイルを作らない', async () => {
  await unlink(join(root, '.headlenss-plugins.conf')).catch(() => {});
  resetG2PluginCache();
  assert.equal((await del('レポート')).status, 404);
  assert.equal((await readdir(root)).includes('.headlenss-plugins.conf'), false);
});

test('タブ削除: エントリ名にパスを書いても、書き込むのはフォルダ直下の conf だけ', async () => {
  // フォルダの外に「conf らしきもの」を置いておき、触られないことを確かめる
  const outsideConf = join(outside, '.headlenss-plugins.conf');
  await writeFile(outsideConf, 'レポート = report/index.html\n');
  const conf = 'レポート = report/index.html\n';
  await writeConf(conf);
  for (const name of ['../outside/.headlenss-plugins.conf', '../../etc/passwd', '/etc/passwd', '..']) {
    const res = await del(name);
    assert.equal(res.status, 404, `404 であるべき: ${name}`);
  }
  assert.equal(await readFile(join(root, '.headlenss-plugins.conf'), 'utf-8'), conf);
  assert.equal(await readFile(outsideConf, 'utf-8'), 'レポート = report/index.html\n');
  await unlink(outsideConf);
});

test('タブ削除: conf がシンボリックリンクなら書き換えずに 409 (リンク先も無傷)', async () => {
  const target = join(outside, 'shared.conf');
  await writeFile(target, 'レポート = report/index.html\n');
  await unlink(join(root, '.headlenss-plugins.conf')).catch(() => {});
  await symlink(target, join(root, '.headlenss-plugins.conf'));
  resetG2PluginCache();
  try {
    assert.equal((await del('レポート')).status, 409);
    assert.equal(await readFile(target, 'utf-8'), 'レポート = report/index.html\n');
  } finally {
    await unlink(join(root, '.headlenss-plugins.conf'));
    await unlink(target);
  }
});
