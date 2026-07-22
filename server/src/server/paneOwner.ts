// 「その tmux pane の端末 (controlling tty) を握っている claude / codex プロセス」を
// 現在の“主 (owner)”として特定する。
//
// なぜ tty で見るのか:
//   - 対話中の claude / codex は、必ずその pane の tty を controlling terminal として握る。
//   - ヘッドレスのサブエージェント (claude -p / codex exec など) は tty を持たない → 除外。
//   - 同じ tmux で claude ⇄ codex を切り替えても、tty を握る本人が入れ替わるので追従する。
//   - プロセスの親子関係 (サブツリー) を見る方式は、対話 claude が codex サブエージェントを
//     呼ぶ (またはその逆) と両方見つかって破綻するが、tty 方式なら「画面につながっている
//     本人」だけを拾うので破綻しない。
// (claude/codex × 対話/サブエージェント の 4 パターンを実機で検証済み。)
//
// レジストリ (~/.claude/sessions) やフックより優先度が高い「今の主」の権威情報として使う。
// フック/store は「その主の会話中身」を補強するために引き続き利用する。

import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type AgentSource = 'claude' | 'codex';
export type PaneOwner = { tmuxSessionName: string; source: AgentSource; pid: number };

// 実行ファイルの置き場所で agent を同定する (プロセス名 comm はフォールバック)。
const CLAUDE_EXE_RE = /\/\.local\/share\/claude\/versions\//;
const CODEX_EXE_RE = /\/\.codex\/packages\//;

// ── TTL cache + singleflight (detectClaude/Codex と同じ思想) ──
const TTL_MS = 2500;
let cache: { result: PaneOwner[]; expiresAt: number } | null = null;
let inFlight: Promise<PaneOwner[]> | null = null;

export function invalidatePaneOwnerCache(): void {
  cache = null;
}

export async function detectPaneOwners(): Promise<PaneOwner[]> {
  const now = Date.now();
  if (cache && now < cache.expiresAt) return cache.result;
  if (inFlight) return inFlight;
  inFlight = detectPaneOwnersUncached().then(
    (result) => {
      cache = { result, expiresAt: Date.now() + TTL_MS };
      inFlight = null;
      return result;
    },
    (err) => {
      inFlight = null;
      throw err;
    },
  );
  return inFlight;
}

async function classify(pid: number): Promise<AgentSource | null> {
  let exe = '';
  try {
    exe = await readlink(`/proc/${pid}/exe`);
  } catch {
    /* 権限が無い / 消えた等。comm にフォールバックする。 */
  }
  if (CLAUDE_EXE_RE.test(exe)) return 'claude';
  if (CODEX_EXE_RE.test(exe)) return 'codex';
  if (!exe) {
    let comm = '';
    try {
      comm = (await readFile(`/proc/${pid}/comm`, 'utf-8')).trim();
    } catch {
      return null;
    }
    if (comm === 'claude') return 'claude';
    if (comm === 'codex') return 'codex';
  }
  return null;
}

async function detectPaneOwnersUncached(): Promise<PaneOwner[]> {
  // pane の tty ("/dev/pts/N") -> session 名
  let paneStdout: string;
  try {
    ({ stdout: paneStdout } = await exec(
      'tmux',
      ['list-panes', '-a', '-F', '#{pane_tty}\t#{session_name}'],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (e) {
    // tmux サーバ不在 = 正常な「pane 0 件」。それ以外の失敗は上位に投げて
    // 「不明」として扱わせる (握り潰して空を返すと誤って主を失う)。
    const stderr = String((e as { stderr?: unknown }).stderr ?? '');
    if (/no server running|no current (client|session)|error connecting/i.test(stderr)) return [];
    throw e;
  }

  // ps が出す tty カラムは "/dev/" を含まない ("pts/N") ので、突き合わせ用に揃える。
  const ptsToSession = new Map<string, string>();
  for (const line of paneStdout.split('\n')) {
    const [tty, sess] = line.split('\t');
    if (!tty || !sess) continue;
    ptsToSession.set(tty.trim().replace(/^\/dev\//, ''), sess);
  }
  if (ptsToSession.size === 0) return [];

  // 全プロセスの (pid, tty, foreground-pgid) を一括取得。
  const { stdout: psOut } = await exec('ps', ['-eo', 'pid=,tty=,tpgid='], {
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  const owners = new Map<string, PaneOwner>(); // tmuxName -> owner
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(-?\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const tty = m[2]; // "pts/12" もしくは "?"
    const tpgid = Number(m[3]);
    const sess = ptsToSession.get(tty);
    if (!sess) continue; // その pane の端末を握っていないプロセス (ヘッドレス含む) は無視
    const source = await classify(pid);
    if (!source) continue;
    // 同一 tty に複数該当したら foreground (tpgid==pid) を優先。
    const existing = owners.get(sess);
    if (!existing || tpgid === pid) owners.set(sess, { tmuxSessionName: sess, source, pid });
  }
  return [...owners.values()];
}
