// 各 tmux セッションの「今その画面(アクティブ window のアクティブ pane)を握って
// 対話している agent (claude / codex)」を READ 時に判定する。表示専用の権威情報。
//
// 判定方法 (実機で claude/codex × 対話/サブ の 4 パターンを検証済み):
//   - tmux のアクティブ pane の tty を取り、その tty の「前面プロセスグループの主
//     (pid == tpgid)」を ps から特定し、実行ファイルで claude/codex を分類する。
//   - 対話中の claude / codex は pane の前面プロセスグループの主になる。
//   - ヘッドレスのサブエージェント (claude -p / codex exec) は controlling tty を持たず、
//     前面でもないので拾われない → 表示を乗っ取らない。
//   - 前面の主が agent と分類できなければ「owner 無し」を返し、呼び出し側は従来の
//     store 表示にフォールバックする (sticky。勝手に切り替えない)。
//
// store やフックには一切触れない。失敗は throw して「不明 (=sticky)」と区別する。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type AgentSource = 'claude' | 'codex';
export type LiveOwner = { source: AgentSource; pid: number };

// 実行ファイルの置き場所 (macOS の ps comm は絶対パス) と、プロセス名 (Linux の ps comm は
// 短縮名 "claude"/"codex") の両対応。comm のみを見る (args 全体は見ない: プロンプト文に
// 相手 agent 名やパスが混じって誤検出するのを避けるため)。
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

// ── 失敗時の throttle 付き警告 ──
// 消費側は .catch(()=>null) で sticky に倒すため、警告が無いと「ps が tpgid 非対応の
// ホスト等で無言のまま永久に効かない」事故が起きうる (#57 と同じ轍)。throttle して残す。
const WARN_INTERVAL_MS = 30_000;
let lastWarnAt = 0;
function warnScanFailed(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.warn(message);
}

// ── TTL cache + singleflight + generation (process-detect と同じ作法) ──
const TTL_MS = 2500;
let cache: { result: Map<string, LiveOwner>; expiresAt: number } | null = null;
let inFlight: Promise<Map<string, LiveOwner>> | null = null;
let generation = 0;

/** 次回呼び出しで再スキャンさせる (セッション作成/削除など server 起因の切替時に即時反映)。 */
export function invalidateLiveOwnerCache(): void {
  generation++;
  cache = null;
}

export async function detectLiveOwners(): Promise<Map<string, LiveOwner>> {
  const now = Date.now();
  if (cache && now < cache.expiresAt) return cache.result;
  if (inFlight) return inFlight;
  const genAtStart = generation;
  inFlight = detectLiveOwnersUncached().then(
    (result) => {
      if (generation === genAtStart) cache = { result, expiresAt: Date.now() + TTL_MS };
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

async function detectLiveOwnersUncached(): Promise<Map<string, LiveOwner>> {
  // アクティブ window の アクティブ pane の tty → session 名 (session ごとに 1 つ)。
  let paneStdout: string;
  try {
    ({ stdout: paneStdout } = await exec(
      'tmux',
      ['list-panes', '-a', '-F', '#{pane_tty}\t#{session_name}\t#{window_active}\t#{pane_active}'],
      { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (e) {
    // tmux サーバ不在 = 正常な「pane 0 件」。それ以外の失敗は throw して「不明」扱いに。
    const stderr = String((e as { stderr?: unknown }).stderr ?? '');
    if (/no server running|no current (client|session)|error connecting/i.test(stderr)) return new Map();
    warnScanFailed(`[live-owner] ⚠ tmux list-panes に失敗: ${(e as Error).message}`);
    throw e;
  }
  const ptsToSession = new Map<string, string>(); // "pts/N" -> session
  for (const line of paneStdout.split('\n')) {
    const [tty, sess, winActive, paneActive] = line.split('\t');
    if (!tty || !sess) continue;
    if (winActive !== '1' || paneActive !== '1') continue; // アクティブ pane のみ
    ptsToSession.set(tty.trim().replace(/^\/dev\//, ''), sess);
  }
  if (ptsToSession.size === 0) return new Map();

  // 各プロセスの (pid, tty, tpgid, comm)。tty が対象 pane で、かつ前面グループの主
  // (pid == tpgid) のプロセスだけを owner 候補にする。
  let psOut: string;
  try {
    ({ stdout: psOut } = await exec('ps', ['-eo', 'pid=,tty=,tpgid=,comm='], {
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (e) {
    warnScanFailed(`[live-owner] ⚠ ps に失敗 (tpgid 非対応ホスト等の可能性): ${(e as Error).message}`);
    throw e;
  }
  const owners = new Map<string, LiveOwner>();
  for (const line of psOut.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\S+)\s+(-?\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const tty = m[2];
    const tpgid = Number(m[3]);
    const comm = m[4].trim();
    const sess = ptsToSession.get(tty);
    if (!sess) continue; // 対象 pane の tty ではない (ヘッドレス含む)
    if (pid !== tpgid) continue; // 前面プロセスグループの主でない (ツール子プロセス等)
    const source = classifyComm(comm);
    if (!source) continue; // 前面の主が agent でない (shell / ツール実行中) → owner 無し
    owners.set(sess, { source, pid });
  }
  return owners;
}
