// 「その tmux セッションの (アクティブな) pane の端末を握っている claude / codex
// プロセス」を現在の主 (owner) として特定する。
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
//
// 分類は ps の comm 列 (実行ファイルパス or プロセス名) で行い、/proc に依存しない
// (Linux/macOS 両対応)。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type AgentSource = 'claude' | 'codex';
export type PaneOwner = { tmuxSessionName: string; source: AgentSource; pid: number };

// 実行ファイルの置き場所 (macOS の ps comm は絶対パスを返す) と、プロセス名 (Linux の
// ps comm は短い名前 "claude"/"codex") の両対応。
const CLAUDE_EXE_RE = /\/\.local\/share\/claude\/versions\//;
const CODEX_EXE_RE = /\/\.codex\/packages\//;

function classifyComm(comm: string): AgentSource | null {
  if (CLAUDE_EXE_RE.test(comm)) return 'claude';
  if (CODEX_EXE_RE.test(comm)) return 'codex';
  const base = comm.split('/').pop() ?? comm;
  if (base === 'claude') return 'claude';
  if (base === 'codex') return 'codex';
  return null;
}

// ── 失敗時の throttle 付き警告 (握り潰して「主無し」に見せない) ──
const WARN_INTERVAL_MS = 30_000;
let lastWarnAt = 0;
function warnScanFailed(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.warn(message);
}

// ── TTL cache + singleflight ──
const TTL_MS = 2500;
let cache: { result: PaneOwner[]; expiresAt: number } | null = null;
let inFlight: Promise<PaneOwner[]> | null = null;

export function invalidatePaneOwnerCache(): void {
  cache = null;
}

/**
 * pane owner 一覧を返す。
 * @param force true の場合はキャッシュ/singleflight を無視して即時に新規スキャンする
 *   (キー注入前の安全確認など、鮮度が重要な用途向け)。結果でキャッシュも更新する。
 */
export async function detectPaneOwners(force = false): Promise<PaneOwner[]> {
  if (force) {
    const result = await detectPaneOwnersUncached();
    cache = { result, expiresAt: Date.now() + TTL_MS };
    return result;
  }
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

type PaneInfo = { session: string; priority: number };

async function detectPaneOwnersUncached(): Promise<PaneOwner[]> {
  // pane の tty ("/dev/pts/N") -> {session, priority}。
  // priority: アクティブ window かつアクティブ pane を最優先 (ユーザが今見ている pane)。
  let paneStdout: string;
  try {
    ({ stdout: paneStdout } = await exec(
      'tmux',
      ['list-panes', '-a', '-F', '#{pane_tty}\t#{session_name}\t#{window_active}\t#{pane_active}'],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (e) {
    // tmux サーバ不在 = 正常な「pane 0 件」。それ以外の失敗は上位に投げて「不明」扱いに
    // させる (握り潰して空を返すと誤って主を失う)。
    const stderr = String((e as { stderr?: unknown }).stderr ?? '');
    if (/no server running|no current (client|session)|error connecting/i.test(stderr)) return [];
    warnScanFailed(`[paneOwner] ⚠ tmux list-panes に失敗: ${(e as Error).message}`);
    throw e;
  }

  // ps の tty カラムは "/dev/" を含まない ("pts/N") ので突き合わせ用に揃える。
  const ptsToPane = new Map<string, PaneInfo>();
  for (const line of paneStdout.split('\n')) {
    const [tty, sess, winActive, paneActive] = line.split('\t');
    if (!tty || !sess) continue;
    const pts = tty.trim().replace(/^\/dev\//, '');
    const priority = (winActive === '1' ? 2 : 0) + (paneActive === '1' ? 1 : 0);
    // 同一 tty は 1 pane のはずだが、念のため priority 高い方を残す。
    const cur = ptsToPane.get(pts);
    if (!cur || priority > cur.priority) ptsToPane.set(pts, { session: sess, priority });
  }
  if (ptsToPane.size === 0) return [];

  // 全プロセスの (pid, tty, foreground-pgid, comm)。comm は実行ファイルパス or プロセス名。
  let psOut: string;
  try {
    ({ stdout: psOut } = await exec('ps', ['-eo', 'pid=,tty=,tpgid=,comm='], {
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (e) {
    warnScanFailed(`[paneOwner] ⚠ ps に失敗: ${(e as Error).message}`);
    throw e;
  }

  // session 名ごとに「最も優先度の高い pane に居る agent」を採用する。
  // 複数ペイン (Claude ペイン + Codex ペイン等) でも、アクティブ pane の主を選ぶ。
  const best = new Map<string, { owner: PaneOwner; priority: number; fg: boolean }>();
  for (const line of psOut.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // "PID TTY TPGID COMM..." (comm は空白を含みうるので rest として扱う)
    const m = trimmed.match(/^(\d+)\s+(\S+)\s+(-?\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const tty = m[2];
    const tpgid = Number(m[3]);
    const comm = m[4].trim();
    const pane = ptsToPane.get(tty);
    if (!pane) continue; // pane の端末を握っていない (ヘッドレス含む) → 無視
    const source = classifyComm(comm);
    if (!source) continue;
    const fg = tpgid === pid;
    const cur = best.get(pane.session);
    // 優先度: pane priority > foreground。より良い候補なら差し替え。
    if (
      !cur ||
      pane.priority > cur.priority ||
      (pane.priority === cur.priority && fg && !cur.fg)
    ) {
      best.set(pane.session, { owner: { tmuxSessionName: pane.session, source, pid }, priority: pane.priority, fg });
    }
  }
  return [...best.values()].map((b) => b.owner);
}
