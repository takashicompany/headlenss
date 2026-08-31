// セッションのフォルダに置かれた宣言ファイルから、そのセッションに紐づく
// 「開けるもの」を読む。G2 (グラス) のプラグイン一覧と、Web UI のプレビュータブが
// 同じ 1 枚のファイルを共有する。
//
// 置き場所: <セッションの作業フォルダ>/.headlenss-plugins.conf
// 形式:     1 行 1 件の `名前 = 値`。`#` 以降と空行は無視する。
//
//   # dev server (URL 型)
//   Greensky       = http://ubook.mogera-fir.ts.net:5173
//   Greensky proxy = http://ubook.mogera-fir.ts.net:6173 g2   ← 出す先を明示
//
//   # 出来上がった HTML (ファイル型) — Web のプレビュータブ専用
//   レポート = report/index.html
//
// 値の書き方で 2 つの型に分かれる。
//
// - **URL 型**: `scheme:` で始まる値。http / https のみ扱う。
//   完全な形 (scheme + host + port) で書く。ここから推測はしない。
//   「ポートだけ書けばホストは補う」形式は採らない — 補う部分が推測になり、
//   サーバの公開方法 (リバースプロキシ等) が違うと届かない URL ができるため。
//
// - **ファイル型**: それ以外の値。セッションの作業フォルダからの**相対パス**として
//   読む。`/` 始まり・`~` 始まり・`..`・`.` 始まりのセグメント (隠しファイル)・
//   `\` `:` `?` `#` を含むものは受け付けない (パースの時点で落とす)。
//
// 出す先 (グラス / ブラウザ) は型と「対象指定」で決まる。
//
// - **ファイル型は常に Web のプレビュータブだけ**。グラスは WebView ごと URL へ
//   遷移するので、ローカルのファイルパスは意味を持たない。
// - **URL 型は対象指定で決まる**。値の後ろに空白区切りで `web` / `g2` を書く。
//
//     名前 = <URL> web       … Web のタブだけ (ブラウザ専用のプレビュー)
//     名前 = <URL> g2        … グラスの一覧だけ
//     名前 = <URL> web g2    … 両方
//     名前 = <URL>           … 無指定 → 下の自動判定に委ねる
//
//   URL に空白は書けないので、後ろのトークンと取り違える心配はない
//   (対象指定を足す前に書かれた宣言はそのまま無指定として読まれる)。
//
// 無指定の URL 型は「グラス用に立てたものか」を自動で判定する。判定材料は
// **シム注入の有無**。グラスから開いたプラグインがダブルタップで headlenss へ
// 戻れるのは、遷移先の HTML に even-loader のシムが入っているからで、
// これが入っているページは実質「グラス向けに用意されたもの」と言える。
//
//   疎通確認の GET に `?even_loader=1` を付け、返ってきた HTML に
//   シム注入のマーカー (SHIM_MARKERS) があれば **グラス + Web**、
//   無ければ **Web 専用** と見なす。
//
// この判定を通らないのに**グラスに出したい**場合 (プロキシも Vite プラグインも
// 使わず、素の dev server の URL を直接書いている場合) は、対象指定 `g2` を
// 明示的に書く。明示指定は自動判定より優先される。
//
// URL 型はグラスの一覧に出す前に、サーバから実際に接続して応答を確認する。
// 「一覧に出た = 必ず開ける」を保証するのが目的で、書きっぱなしで古くなった
// エントリや、まだ dev server を起動していないエントリは自動的に落ちる。
// (ファイル型の「実在確認」は web-preview.ts 側で行う。)

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** セッションのフォルダ直下に置く宣言ファイル名 */
export const PLUGIN_CONF_NAME = '.headlenss-plugins.conf';

export type G2Plugin = {
  /** 宣言ファイルに書かれた表示名 */
  name: string;
  /** 宣言ファイルに書かれた URL (そのまま遷移先になる) */
  url: string;
};

/**
 * URL 型の「出す先」の明示指定。`null` は無指定 (= 自動判定に委ねる)。
 * 両方 false になる書き方は無い (トークンが 1 つでもあればどちらかが立つ)。
 */
export type PluginTargets = { web: boolean; g2: boolean };

/** 宣言 1 件。URL 型かファイル型かで持つものが違う。 */
export type PluginEntry =
  | {
      name: string;
      kind: 'url';
      url: string;
      /** 値の後ろに書かれた `web` / `g2`。書かれていなければ null (自動判定) */
      targets: PluginTargets | null;
    }
  | {
      name: string;
      kind: 'file';
      /** セッションの作業フォルダからの相対パス (正規化済み・`/` 区切り) */
      relPath: string;
    };

/** 疎通確認の待ち上限。dev server は同じ機体なので、応答しなければ落ちていると見なす。 */
const REACH_TIMEOUT_MS = 1500;
/** 確認結果のキャッシュ TTL。セッション一覧は 1.5 秒ごとに引かれるので毎回は叩かない。 */
const CACHE_TTL_MS = 5000;

/** `scheme:` で始まっているか。ここで URL 型かファイル型かを分ける。 */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * ファイル型で受け付けるセグメントの文字種。
 * `\0` `/` `\` `:` `?` `#` を弾く。`:` を弾くのは URL との取り違えを防ぐため、
 * `?` `#` を弾くのは配信 URL に付けるクエリ (`?v=<mtime>`) と混ざらないようにするため。
 */
const FILE_SEGMENT_RE = /^[^\0/\\:?#]+$/;

/** 対象指定に書けるトークン。値の後ろに空白区切りで並べる。 */
const TARGET_TOKENS: readonly string[] = ['web', 'g2'];

/**
 * 対象指定トークンの並びを解釈する。知らないトークンが 1 つでも混ざれば null。
 *
 * 書き間違い (`wev` 等) を黙って「無指定」に落とすと、意図と違う側に出たまま
 * 気づけない。呼び出し側は null を受けたら行ごと捨てて warn に理由を出す。
 */
function parseTargetTokens(tokens: string[]): PluginTargets | null {
  const t: PluginTargets = { web: false, g2: false };
  for (const raw of tokens) {
    const tok = raw.toLowerCase();
    if (tok === 'web') t.web = true;
    else if (tok === 'g2') t.g2 = true;
    else return null;
  }
  return t;
}

/**
 * ファイル型の値から、後ろに付いた対象指定トークンだけを切り離す。
 *
 * ファイル名には空白を書けるので (`成果物/レポート 1.html`)、URL 型のように
 * 「最初の空白より後ろは全部トークン」とは読めない。**末尾から続く既知の
 * トークンだけ**を剥がし、それ以外は値の一部として残す。
 */
function stripTrailingTargetTokens(value: string): { head: string; tokens: string[] } {
  let head = value;
  const tokens: string[] = [];
  for (;;) {
    const m = /^(.*\S)\s+(\S+)$/.exec(head);
    if (m === null) break;
    if (!TARGET_TOKENS.includes(m[2].toLowerCase())) break;
    tokens.unshift(m[2]);
    head = m[1];
  }
  return { head, tokens };
}

/**
 * 宣言ファイルに書かれたファイル型の値を、作業フォルダからの相対パスに正規化する。
 * 受け付けられない書き方なら null。
 *
 * ここで弾くのは「書式として不正なもの」だけで、実在確認はしない (配信側の仕事)。
 * ただしパストラバーサルはこの時点で落とし切る (`..`)。隠しセグメント (`.` 始まり) も
 * 落とすので、`.git/config` や `.env` を宣言することはできない。
 */
export function normalizeConfRelPath(raw: string): string | null {
  if (!raw) return null;
  if (raw.includes('\0')) return null;
  if (raw.includes('\\')) return null;
  if (raw.startsWith('/')) return null; // 絶対パスは受け付けない
  if (raw.startsWith('~')) return null; // ホーム展開もしない
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '.') continue; // `./x` や `a/./b` は素通しでよい
    if (seg === '') return null; // `//` や末尾 `/` (= フォルダ指定) は受け付けない
    if (seg === '..') return null;
    if (seg.startsWith('.')) return null; // 隠しファイル / 隠しフォルダ
    if (!FILE_SEGMENT_RE.test(seg)) return null;
    out.push(seg);
  }
  if (out.length === 0) return null;
  return out.join('/');
}

/**
 * 宣言ファイルを 1 行ずつ解釈する。
 * 壊れた行は黙って捨てず、理由付きで warn に出す (書き間違いに気づけるように)。
 */
export function parsePluginConf(text: string, where = ''): PluginEntry[] {
  const out: PluginEntry[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // 行末コメントも落とす。値に # が入ることは想定しない。
    const line = lines[i].split('#')[0].trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      console.warn(`[g2-plugins] ${where}:${i + 1} '名前 = 値' の形式ではありません: ${line}`);
      continue;
    }
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!name || !value) {
      console.warn(`[g2-plugins] ${where}:${i + 1} 名前か値が空です: ${line}`);
      continue;
    }

    // 重複は先勝ち。型に関わらず名前が一意 (Web のタブ名にもそのまま使う)。
    const dup = seen.has(name);

    if (SCHEME_RE.test(value)) {
      // `scheme:` で始まる = URL 型のつもり。値は「URL + 対象指定トークン」。
      // URL に空白は書けないので、最初の空白より後ろは対象指定として読む。
      const sp = value.search(/\s/);
      const urlText = sp < 0 ? value : value.slice(0, sp);
      const tokens = sp < 0 ? [] : value.slice(sp).trim().split(/\s+/);
      let targets: PluginTargets | null = null;
      if (tokens.length > 0) {
        targets = parseTargetTokens(tokens);
        if (targets === null) {
          console.warn(
            `[g2-plugins] ${where}:${i + 1} URL の後ろに書けるのは web / g2 だけです: ${tokens.join(' ')}`,
          );
          continue;
        }
      }
      // http/https 以外はここで落とす
      // (ファイル型として読み直すと、書き間違いが黙って別物として通ってしまう)。
      let parsed: URL;
      try {
        parsed = new URL(urlText);
      } catch {
        console.warn(`[g2-plugins] ${where}:${i + 1} URL として解釈できません: ${urlText}`);
        continue;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        console.warn(`[g2-plugins] ${where}:${i + 1} http/https 以外は扱えません: ${urlText}`);
        continue;
      }
      if (dup) {
        console.warn(`[g2-plugins] ${where}:${i + 1} 名前が重複しています (後の行を無視): ${name}`);
        continue;
      }
      seen.add(name);
      out.push({ name, kind: 'url', url: urlText, targets });
      continue;
    }

    // ファイル型は常に Web のタブ専用なので、対象指定を書く意味が無い。
    // 書かれていたら (とくに `g2`) 黙って通さず、無視することを伝える。
    const { head, tokens: fileTokens } = stripTrailingTargetTokens(value);
    if (fileTokens.length > 0) {
      console.warn(
        `[g2-plugins] ${where}:${i + 1} ファイル型は Web のタブ専用です。対象指定は無視します: ${fileTokens.join(' ')}`,
      );
    }
    const relPath = normalizeConfRelPath(head);
    if (relPath === null) {
      console.warn(
        `[g2-plugins] ${where}:${i + 1} URL でも作業フォルダ内の相対パスでもありません: ${head}`,
      );
      continue;
    }
    if (dup) {
      console.warn(`[g2-plugins] ${where}:${i + 1} 名前が重複しています (後の行を無視): ${name}`);
      continue;
    }
    seen.add(name);
    out.push({ name, kind: 'file', relPath });
  }
  return out;
}

/** 宣言ファイルの読み込み結果のキャッシュ。1 セッションぶんの conf を TTL 内で使い回す。 */
const confCache = new Map<string, { at: number; entries: PluginEntry[] }>();

/**
 * セッションのフォルダから宣言を読む。ファイルが無ければ空。
 *
 * G2 一覧 (1.5 秒ごと) と Web のプレビュータブ、静的配信の 3 箇所から引かれるので
 * 疎通確認と同じ TTL でキャッシュする。
 */
export async function readDeclarations(sessionCwd: string): Promise<PluginEntry[]> {
  if (!sessionCwd) return [];
  const now = Date.now();
  const hit = confCache.get(sessionCwd);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.entries;

  const path = resolve(sessionCwd, PLUGIN_CONF_NAME);
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      console.warn(`[g2-plugins] ${path} を読めません: ${(e as Error).message}`);
    }
    confCache.set(sessionCwd, { at: Date.now(), entries: [] });
    return [];
  }
  const entries = parsePluginConf(text, path);
  confCache.set(sessionCwd, { at: Date.now(), entries });
  return entries;
}

/**
 * 「グラス向けに用意されたページか」の判定に使う、シム注入のマーカー。
 * Plugin Loader のプロキシ (proxy/server.ts) が HTML の `<head>` 直後に差し込む
 * 実物の文字列で、even 側の isProxyInjected (plugin-takeover.ts) と同じもの。
 */
const SHIM_MARKERS = ['__EVEN_LOADER_FROM_PROXY=1', '/__even-loader/shim.js'];

/**
 * 自動判定のために読む HTML の上限。マーカーは `<head>` 直後に入るので、
 * 先頭だけ読めば足りる (大きな成果物ページを丸ごとメモリに載せない)。
 */
const PROBE_BODY_LIMIT = 256 * 1024;

/** 遷移時に headlenss が付けるのと同じクエリ。シムはこれを見て戻る動作を有効にする。 */
const LOADER_PARAM = 'even_loader';

/** 疎通確認の結果。 */
type Probe = {
  /** 応答があったか (ステータスコードは問わない) */
  ok: boolean;
  /** シム注入のマーカーが見つかったか (= グラス向けと見なす) */
  shim: boolean;
};

/** 疎通確認の URL に `?even_loader=1` を付ける (シム注入の有無を実地に見るため)。 */
function withLoaderParam(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(LOADER_PARAM, '1');
    return u.toString();
  } catch {
    return url;
  }
}

/** 応答本文の先頭だけを読む。途中で切れてもそこまでで判定する。 */
async function readBodyHead(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
      if (out.length >= limit) break;
    }
  } catch {
    // 途中で切れた場合もここまでの内容で判定する
  } finally {
    // 残りを捨てて接続を解放する (放置すると GC まで保持される)
    await reader.cancel().catch(() => {});
  }
  return out;
}

/**
 * URL に実際に繋いで、(1) 応答があるか (2) シムが注入されているか を確かめる。
 *
 * ステータスコードは問わない (404 でも「サーバは生きている」ので開ける)。
 * リダイレクトは追わない — 従来どおり「応答があれば届く」の判定を保ちたいだけで、
 * 追跡すると宣言と違うページを見て判定してしまう。
 * (リダイレクトを返すページは本文が無いので、自動判定では Web 専用になる。
 *  グラスに出したければ対象指定 `g2` を明示する。)
 */
async function probe(url: string): Promise<Probe> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REACH_TIMEOUT_MS);
  try {
    const res = await fetch(withLoaderParam(url), {
      method: 'GET',
      signal: ctrl.signal,
      redirect: 'manual',
    });
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.includes('text/html')) {
      await res.body?.cancel().catch(() => {});
      return { ok: true, shim: false };
    }
    const head = await readBodyHead(res, PROBE_BODY_LIMIT);
    return { ok: true, shim: SHIM_MARKERS.some((m) => head.includes(m)) };
  } catch {
    return { ok: false, shim: false };
  } finally {
    clearTimeout(timer);
  }
}

const probeCache = new Map<string, { at: number; result: Probe }>();

async function probeCached(url: string): Promise<Probe> {
  const now = Date.now();
  const hit = probeCache.get(url);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.result;
  const result = await probe(url);
  probeCache.set(url, { at: Date.now(), result });
  return result;
}

/**
 * その宣言を Web UI のプレビュータブに出すか。
 *
 * ファイル型は常に出す。URL 型は明示指定が無ければ出す (自動判定は「グラスにも
 * 出すか」だけを決めるもので、Web からは常に見られる)。`g2` だけを明示した
 * ものだけが Web から外れる。
 */
export function showsOnWeb(entry: PluginEntry): boolean {
  if (entry.kind !== 'url') return true;
  return entry.targets === null || entry.targets.web;
}

/**
 * セッションのフォルダに宣言された G2 プラグインのうち、いま実際に応答するものを返す。
 * 宣言ファイルが無ければ空 (この機能を使っていないセッション)。
 *
 * ファイル型は headlenss サーバが配信するローカルのファイルで、グラスからは開けない。
 * URL 型のうち「グラス対象」のものだけを出す (対象指定が無ければシム注入で自動判定)。
 */
export async function detectG2Plugins(sessionCwd: string): Promise<G2Plugin[]> {
  if (!sessionCwd) return [];
  const declared = (await readDeclarations(sessionCwd)).filter(
    (d): d is Extract<PluginEntry, { kind: 'url' }> =>
      d.kind === 'url' && (d.targets === null || d.targets.g2),
  );
  if (declared.length === 0) return [];
  const checked = await Promise.all(
    declared.map(async (d) => {
      const p = await probeCached(d.url);
      if (!p.ok) return null;
      // 無指定はシム注入の有無で決める。明示の `g2` は注入が無くても出す。
      if (d.targets === null && !p.shim) return null;
      return { name: d.name, url: d.url };
    }),
  );
  return checked.filter((d): d is G2Plugin => d !== null);
}

let pathCache: { at: number; byName: Map<string, string> } | null = null;

/**
 * tmux セッション名 → その pane の現在フォルダ。
 *
 * セッション一覧の cwd は store (フック由来) と検出結果から作られるため、
 * サーバ再起動直後やフック未導入のセッションでは空になる。宣言ファイルの
 * 置き場所が分からないと成立しないので、tmux から直接引いて補う。
 */
export async function tmuxSessionPaths(): Promise<Map<string, string>> {
  const now = Date.now();
  if (pathCache && now - pathCache.at < CACHE_TTL_MS) return pathCache.byName;
  const byName = new Map<string, string>();
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const { stdout } = await exec('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}']);
    for (const line of stdout.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      const name = line.slice(0, tab);
      const path = line.slice(tab + 1).trim();
      // 同名セッションに複数 pane がある場合は最初の 1 つを採用する。
      if (path && !byName.has(name)) byName.set(name, path);
    }
  } catch {
    // tmux が居ない / エラー時は空のまま (呼び出し側は元の cwd を使う)
  }
  pathCache = { at: Date.now(), byName };
  return byName;
}

/** テスト用: キャッシュを捨てる */
export function resetG2PluginCache(): void {
  probeCache.clear();
  confCache.clear();
  pathCache = null;
}
