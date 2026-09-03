// PC / スマホの Web UI に出す「プレビュータブ」の一覧と、その静的配信。
//
// 目的は「エージェントが作った成果物を、チャットから 1 タップで見る」こと。
// 宣言は G2 プラグインと同じ `.headlenss-plugins.conf` を共有する (g2-plugins.ts)。
//
//   URL 型  (`名前 = http://...`)  … dev server / PWA。iframe にそのまま載せる
//   ファイル型 (`名前 = report/index.html`) … セッションの作業フォルダの中の HTML。
//                                            headlenss サーバ自身が配信する
//
// タブに出すのは、URL 型で `g2` だけを明示したもの (= グラス専用) を除く全部。
// ファイル型はそもそもグラスから開けないので常にここに出る。
//
// タブはチャット画面の下の帯に並ぶ (ヘッダの tmux / chat とは別の切り替え)。
//
// 配信 URL は `/preview/<セッション名>/<相対パス>`。ルートはそのセッションの作業フォルダで、
// **ファイル型を 1 件以上宣言しているセッションだけ**配信を有効にする。宣言していない
// セッションのフォルダは 1 バイトも出さない (全セッションの cwd を無条件で公開しない)。
//
// 宣言したファイル「だけ」ではなくフォルダ配下を配信するのは、HTML が相対パスで
// CSS / JS / 画像を読むため。宣言はあくまで「このセッションでプレビューを使う」という
// 意思表示と、タブに出す入口の指定。
//
// パスの安全性は 2 段構え。
//   1. 宣言の時点 (g2-plugins.ts の normalizeConfRelPath) で `..` や隠しセグメントを落とす
//   2. 配信の時点 (このファイルの resolveInside) で、URL から来た任意のパスを同じ基準で
//      落としたうえで realpath 比較し、シンボリックリンクでの脱出も塞ぐ
//
// 常に no-store。エージェントが直した瞬間に反映されないと意味がないため。

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { readDeclarations, showsOnWeb, tmuxSessionPaths } from './g2-plugins.ts';
import { getSessionCwd } from './tmux.ts';

/** tmux.ts の validateName と同じ規則 (セッション名はそのまま URL に載る) */
const SESSION_NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

/** 配信 URL の接頭辞。web 側 (PreviewStage の iframe) と揃えること。 */
export const PREVIEW_PREFIX = '/preview';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function contentType(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** エージェントが直した瞬間に反映されないと意味がないので、成果物は常に no-store */
const NO_CACHE = 'no-cache, no-store, must-revalidate';

/**
 * `/preview/<session>/<rest>` の `<rest>` を、作業フォルダの中の実ファイルへ解決する。
 * フォルダ外に出るパス・シンボリックリンク越しの脱出・隠しファイルを弾く。
 * 解決できなければ null (呼び出し側は 404 を返す)。
 */
export async function resolveInside(root: string, rest: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  // `..` を含むパスは正規化で内側に丸められる前に弾く
  // (`%2e%2e%2f` のような二重エンコードも decode 後にここで落ちる)
  if (decoded.split(/[/\\]/).some((seg) => seg === '..')) return null;
  if (decoded.includes('\\')) return null;

  const normalized = path.posix.normalize('/' + decoded).replace(/^\/+/, '');
  if (normalized.startsWith('..')) return null;
  // `.git` の中身や `.env` は宣言できないだけでなく、配信もしない
  if (normalized.split('/').some((seg) => seg.startsWith('.'))) return null;

  const abs = path.resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;

  // シンボリックリンクで外に出るケースも塞ぐ
  try {
    const real = await realpath(abs);
    const realRoot = await realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return real;
  } catch {
    return null;
  }
}

/** Web UI のタブ 1 件 */
export type WebTab = {
  /** 宣言ファイルに書かれた表示名 (タブの見出し兼 URL の `tab=` の値) */
  name: string;
  kind: 'url' | 'file';
  /** iframe / 別タブに渡す URL。ファイル型は `/preview/...?v=<mtime>` */
  url: string;
};

/** tmux セッション名 → 作業フォルダ。一覧の cwd より tmux の pane を信じる。 */
export async function resolveSessionCwd(sessionName: string): Promise<string | null> {
  if (!SESSION_NAME_RE.test(sessionName)) return null;
  const paths = await tmuxSessionPaths().catch(() => new Map<string, string>());
  const fromList = paths.get(sessionName);
  if (fromList) return fromList;
  // tmux list-panes のキャッシュに乗っていない (作りたてなど) 場合は直接引く
  const direct = await getSessionCwd(sessionName).catch(() => undefined);
  return direct ?? null;
}

function encodeRelPath(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/');
}

/**
 * 作業フォルダの宣言から Web UI のタブ一覧を組み立てる。
 *
 * - `g2` だけを明示した宣言 (= グラス専用) は出さない。
 * - URL 型は宣言のまま出す。疎通確認はしない (dev server の再起動中にタブが消えると、
 *   iframe の載せ替え先が無くなって「押せない」状態になる。Web 側には再読込ボタンが
 *   あるので、届かないことは開いてみれば分かる。グラス側の「一覧に出た = 必ず開ける」
 *   とは要件が違う)。
 * - ファイル型は実在する通常ファイルだけ出す。URL には更新時刻を `?v=` で付ける
 *   (コミットしていないファイルでも、直した瞬間に iframe を載せ替えられるように)。
 */
export async function buildWebTabs(sessionName: string, sessionCwd: string): Promise<WebTab[]> {
  const entries = await readDeclarations(sessionCwd);
  const tabs: WebTab[] = [];
  for (const e of entries) {
    if (!showsOnWeb(e)) continue;
    if (e.kind === 'url') {
      tabs.push({ name: e.name, kind: 'url', url: e.url });
      continue;
    }
    const abs = await resolveInside(sessionCwd, e.relPath);
    if (abs === null) continue;
    let mtime: number;
    try {
      const st = await stat(abs);
      if (!st.isFile()) continue;
      mtime = Math.floor(st.mtimeMs);
    } catch {
      continue;
    }
    tabs.push({
      name: e.name,
      kind: 'file',
      url: `${PREVIEW_PREFIX}/${encodeURIComponent(sessionName)}/${encodeRelPath(e.relPath)}?v=${mtime}`,
    });
  }
  return tabs;
}

/** GET /api/sessions/:name/webtabs */
export async function handleWebTabs(c: Context): Promise<Response> {
  const name = c.req.param('name') ?? '';
  if (!SESSION_NAME_RE.test(name)) {
    return c.json({ error: 'invalid session name (use [a-zA-Z0-9_-], max 40 chars)' }, 400);
  }
  const cwd = await resolveSessionCwd(name);
  // セッションが見つからない / まだ tmux から引けない場合も、一覧としては空を返す。
  // (タブ帯を出す側は「無ければ出さない」だけなので、404 にする意味がない。)
  if (!cwd) return c.json({ tabs: [] });
  const tabs = await buildWebTabs(name, cwd).catch((e) => {
    console.warn(`[web-preview] ${name}: ${(e as Error).message}`);
    return [] as WebTab[];
  });
  return c.json({ tabs });
}

function sendHeaders(absPath: string, size: number): Record<string, string> {
  return {
    'Content-Type': contentType(absPath),
    'Content-Length': String(size),
    'Cache-Control': NO_CACHE,
    // iframe は sandbox="allow-scripts" (allow-same-origin なし) で読み込むので、
    // 成果物は opaque origin になり、親の localStorage / DOM には触れない。
    'X-Content-Type-Options': 'nosniff',
    // opaque origin からのリクエストは Origin: null で飛ぶ。CORS を通す扱いにしておかないと
    // 成果物が type="module" や fetch を使った瞬間に読み込み拒否される
    // (ここで配信するのは自分の作業フォルダのファイルだけなので * で問題ない)。
    'Access-Control-Allow-Origin': '*',
  };
}

/**
 * GET|HEAD /preview/<session>/<rest>
 *
 * ファイル型を 1 件以上宣言しているセッションだけ、その作業フォルダを配信する。
 */
export async function servePreview(c: Context): Promise<Response> {
  // 正規化されていない生のパスで判定する。`new URL(...).pathname` は WHATWG の
  // 規則で `..` を解決してしまうので、traversal を試したリクエストが別のパスに
  // 化けてしまう (`/preview/s/../../etc/passwd` → `/etc/passwd`)。
  const m = /^\/preview\/([^/]+)(\/.*)?$/.exec(c.req.path);
  if (m === null) return c.text('Not Found', 404);

  let sessionName: string;
  try {
    sessionName = decodeURIComponent(m[1] ?? '');
  } catch {
    return c.text('Not Found', 404);
  }
  if (!SESSION_NAME_RE.test(sessionName)) return c.text('Not Found', 404);

  const root = await resolveSessionCwd(sessionName);
  if (!root) return c.text('Not Found', 404);

  return servePreviewFromRoot(c, sessionName, root, m[2], new URL(c.req.url).search);
}

/**
 * 配信の本体 (セッション名 → フォルダの解決を済ませたあと)。
 * テストから tmux 抜きで叩けるように分けている。
 */
export async function servePreviewFromRoot(
  c: Context,
  sessionName: string,
  root: string,
  rest: string | undefined,
  search = '',
): Promise<Response> {
  // 宣言していないセッションのフォルダは配信しない。
  // (ファイル型が 0 件 = この機能を使っていないセッション)
  const entries = await readDeclarations(root);
  if (!entries.some((e) => e.kind === 'file')) return c.text('Not Found', 404);

  // `/preview/<session>` → `/preview/<session>/` (相対パスの解決を正しくするため)
  if (rest === undefined) {
    return c.redirect(`${PREVIEW_PREFIX}/${encodeURIComponent(sessionName)}/${search}`, 302);
  }

  const relative = rest.replace(/^\//, '') || 'index.html';
  const abs = await resolveInside(root, relative);
  if (abs === null) return c.text('Not Found', 404);

  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(abs);
  } catch {
    return c.text('Not Found', 404);
  }

  if (st.isDirectory()) {
    const index = await resolveInside(root, path.posix.join(relative, 'index.html'));
    if (index === null) return c.text('Not Found', 404);
    try {
      const ist = await stat(index);
      if (!ist.isFile()) return c.text('Not Found', 404);
      return sendFile(c, index, ist.size);
    } catch {
      return c.text('Not Found', 404);
    }
  }

  // 通常ファイル以外 (FIFO / デバイス等) は配信しない
  if (!st.isFile()) return c.text('Not Found', 404);
  return sendFile(c, abs, st.size);
}

function sendFile(c: Context, absPath: string, size: number): Response {
  const headers = sendHeaders(absPath, size);
  if (c.req.method === 'HEAD') return c.body(null, 200, headers);
  const stream = Readable.toWeb(createReadStream(absPath)) as unknown as ReadableStream;
  return c.body(stream, 200, headers);
}
