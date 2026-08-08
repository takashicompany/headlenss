// セッションのフォルダに置かれた宣言ファイルから、G2 プラグインの URL を読む。
//
// 置き場所: <セッションの作業フォルダ>/.headlenss-plugins.conf
// 形式:     1 行 1 件の `名前 = URL`。`#` 以降と空行は無視する。
//
//   # 開発用
//   Greensky       = http://ubook.mogera-fir.ts.net:5173
//   Greensky proxy = http://ubook.mogera-fir.ts.net:6173
//
// URL は完全な形 (scheme + host + port) で書く。ここから推測はしない。
// 「ポートだけ書けばホストは補う」形式は採らない — 補う部分が推測になり、
// サーバの公開方法 (リバースプロキシ等) が違うと届かない URL ができるため。
//
// 一覧に出す前に、サーバから実際に接続して応答を確認する。
// 「一覧に出た = 必ず開ける」を保証するのが目的で、書きっぱなしで古くなった
// エントリや、まだ dev server を起動していないエントリは自動的に落ちる。

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

/** 宣言 1 件 (疎通確認前) */
type Declared = G2Plugin;

/** 疎通確認の待ち上限。dev server は同じ機体なので、応答しなければ落ちていると見なす。 */
const REACH_TIMEOUT_MS = 1500;
/** 確認結果のキャッシュ TTL。セッション一覧は 1.5 秒ごとに引かれるので毎回は叩かない。 */
const CACHE_TTL_MS = 5000;

/**
 * 宣言ファイルを 1 行ずつ解釈する。
 * 壊れた行は黙って捨てず、理由付きで warn に出す (書き間違いに気づけるように)。
 */
export function parsePluginConf(text: string, where = ''): Declared[] {
  const out: Declared[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // 行末コメントも落とす。URL に # が入ることは想定しない。
    const line = lines[i].split('#')[0].trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      console.warn(`[g2-plugins] ${where}:${i + 1} '名前 = URL' の形式ではありません: ${line}`);
      continue;
    }
    const name = line.slice(0, eq).trim();
    const url = line.slice(eq + 1).trim();
    if (!name || !url) {
      console.warn(`[g2-plugins] ${where}:${i + 1} 名前か URL が空です: ${line}`);
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      console.warn(`[g2-plugins] ${where}:${i + 1} URL として解釈できません: ${url}`);
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn(`[g2-plugins] ${where}:${i + 1} http/https 以外は扱えません: ${url}`);
      continue;
    }
    if (seen.has(name)) {
      console.warn(`[g2-plugins] ${where}:${i + 1} 名前が重複しています (後の行を無視): ${name}`);
      continue;
    }
    seen.add(name);
    out.push({ name, url });
  }
  return out;
}

/** セッションのフォルダから宣言を読む。ファイルが無ければ空。 */
async function readDeclarations(sessionCwd: string): Promise<Declared[]> {
  const path = resolve(sessionCwd, PLUGIN_CONF_NAME);
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      console.warn(`[g2-plugins] ${path} を読めません: ${(e as Error).message}`);
    }
    return [];
  }
  return parsePluginConf(text, path);
}

/**
 * URL に実際に繋いで応答があるか確かめる。
 * ステータスコードは問わない (404 でも「サーバは生きている」ので開ける)。
 */
async function isReachable(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REACH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'manual' });
    // body を破棄して接続を解放する (放置すると GC まで保持される)
    await res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const reachCache = new Map<string, { at: number; ok: boolean }>();

async function isReachableCached(url: string): Promise<boolean> {
  const now = Date.now();
  const hit = reachCache.get(url);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.ok;
  const ok = await isReachable(url);
  reachCache.set(url, { at: Date.now(), ok });
  return ok;
}

/**
 * セッションのフォルダに宣言された G2 プラグインのうち、いま実際に応答するものを返す。
 * 宣言ファイルが無ければ空 (この機能を使っていないセッション)。
 */
export async function detectG2Plugins(sessionCwd: string): Promise<G2Plugin[]> {
  if (!sessionCwd) return [];
  const declared = await readDeclarations(sessionCwd);
  if (declared.length === 0) return [];
  const checked = await Promise.all(
    declared.map(async (d) => ((await isReachableCached(d.url)) ? d : null)),
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
  reachCache.clear();
  pathCache = null;
}
