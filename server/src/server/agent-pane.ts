// tmux セッション名から「エージェント (Claude / Codex) が動いている pane」を解決する。
//
// なぜ必要か:
//   `tmux send-keys -t <セッション名>` はセッションの**アクティブ pane**へ送る。
//   別ウィンドウ (dev server 等) を作るとそちらがアクティブになり、以降の音声入力が
//   まるごとそちらへ流れる。実際に、dev server を tmux ウィンドウで常駐させた結果、
//   音声入力が vite の標準入力に入り続けて Claude に一切届かない事故が起きた。
//
//   pane ID (`%7`) を直接指定すればアクティブかどうかに左右されない。
//   送信も画面取得も、必ずエージェントのいる pane だけを見る。
//
// 解決順 (上から順に採用):
//   1. 生きている Claude プロセスの PID から親を辿って当てた pane。
//      レジストリ由来の実 PID なので、コマンド名の見え方に依存せず、
//      「今そこでエージェントが動いている」ことまで同時に保証できる。
//   2. store が持つ pane (フックの X-Tmux-Pane = エージェント自身の $TMUX_PANE)。
//      ただし**その pane の前面がシェルなら採用しない** — エージェントが終了して
//      シェルに戻った pane へ送ると、文字列がシェルの入力として渡ってしまう。
//   3. セッション内で前面が claude/codex の pane。
//   4. どれも駄目ならセッション名 (従来動作)。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectClaudeSessions } from './claude/process-detect.ts';

const exec = promisify(execFile);

/** tmux の pane ID 形式 (`%12`)。 */
const PANE_ID_RE = /^%\d+$/;
/** 前面がエージェントとみなせるコマンド名。 */
const AGENT_CMD_RE = /\b(claude|codex)\b/i;
/**
 * 前面がシェルの pane。ここへ送ると文字列がシェルの入力になるため、
 * 「エージェントがいる」とは絶対にみなさない。
 * (エージェント名の網羅は環境差で破れるが、シェル名は破れても安全側に倒れる)
 */
const SHELL_CMD_RE = /^(bash|zsh|sh|fish|dash|ksh|csh|tcsh|nu|xonsh|pwsh|powershell)$/i;
/** 解決結果のキャッシュ TTL。チャット取得は 1.5 秒毎に走るので毎回 tmux を叩かない。 */
const CACHE_TTL_MS = 2000;

export function isPaneId(target: string): boolean {
  return PANE_ID_RE.test(target);
}

/** 前面がシェルの pane か (= 送ってはいけない pane か) */
export function isShellPane(cmd: string): boolean {
  return SHELL_CMD_RE.test(cmd.trim());
}

type PaneInfo = { paneId: string; panePid: number; session: string; cmd: string };

async function listPanes(): Promise<PaneInfo[]> {
  try {
    const { stdout } = await exec('tmux', [
      'list-panes', '-a', '-F',
      '#{pane_id}\t#{pane_pid}\t#{session_name}\t#{pane_current_command}',
    ], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
    const out: PaneInfo[] = [];
    for (const line of stdout.split('\n')) {
      const [paneId, panePid, session, cmd] = line.split('\t');
      if (!paneId || !session) continue;
      out.push({ paneId, panePid: Number(panePid), session, cmd: cmd ?? '' });
    }
    return out;
  } catch {
    return [];
  }
}

/** 全プロセスの pid→ppid。祖先を辿って pane を当てるのに使う (macOS / Linux 共通)。 */
async function getPpidMap(): Promise<Map<number, number>> {
  try {
    const { stdout } = await exec('ps', ['-Ao', 'pid=,ppid='], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
    const map = new Map<number, number>();
    for (const line of stdout.split('\n')) {
      const m = line.trim().split(/\s+/);
      const pid = Number(m[0]);
      const ppid = Number(m[1]);
      if (Number.isInteger(pid) && Number.isInteger(ppid)) map.set(pid, ppid);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** pid から親を辿り、最初に当たった pane の ID を返す。 */
function paneOfPid(pid: number, panePidToId: Map<number, string>, ppidMap: Map<number, number>): string | null {
  let cur = pid;
  for (let i = 0; i < 10; i++) {
    const paneId = panePidToId.get(cur);
    if (paneId) return paneId;
    const next = ppidMap.get(cur);
    if (!next || next === 1 || next === cur) return null;
    cur = next;
  }
  return null;
}

const cache = new Map<string, { at: number; target: string }>();

/**
 * セッション名から send-keys / capture-pane に渡す宛先を返す。
 * エージェントの pane が特定できれば `%N`、できなければセッション名。
 *
 * @param storedPane フック由来で store に保存されている pane (あれば渡す)
 */
export async function resolveAgentTarget(
  sessionName: string,
  storedPane?: string,
): Promise<string> {
  if (!sessionName) return sessionName;
  const now = Date.now();
  const hit = cache.get(sessionName);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.target;

  const panes = await listPanes();
  const inSession = panes.filter((p) => p.session === sessionName);
  const byId = new Map(inSession.map((p) => [p.paneId, p]));
  let target = sessionName;

  // 1. 生きている Claude プロセスの PID から pane を当てる。
  //    コマンド名の見え方 (claude / node / ラッパー) に依存しないうえ、
  //    「今まさに動いている」ことまで確かめられる最も強い根拠。
  const detected = await detectClaudeSessions().catch(() => []);
  const pids = detected.filter((d) => d.tmuxSessionName === sessionName).map((d) => d.pid);
  if (pids.length > 0) {
    const panePidToId = new Map(panes.map((p) => [p.panePid, p.paneId]));
    const ppidMap = await getPpidMap();
    for (const pid of pids) {
      const paneId = paneOfPid(pid, panePidToId, ppidMap);
      if (paneId && byId.has(paneId)) {
        target = paneId;
        break;
      }
    }
  }

  // 2. store の pane。エージェント自身が名乗ったものなので取り違えは無いが、
  //    その後エージェントが終了してシェルに戻っている場合があるため前面を確認する。
  if (target === sessionName && storedPane && isPaneId(storedPane)) {
    const pane = byId.get(storedPane);
    if (pane && !isShellPane(pane.cmd)) target = storedPane;
  }

  // 3. セッション内で前面が claude/codex の pane (Codex には PID 検出が無いためここで拾う)
  if (target === sessionName) {
    const agent = inSession.find((p) => AGENT_CMD_RE.test(p.cmd));
    if (agent) target = agent.paneId;
  }

  cache.set(sessionName, { at: Date.now(), target });
  return target;
}

/** テスト用: キャッシュを捨てる */
export function resetAgentPaneCache(): void {
  cache.clear();
}
