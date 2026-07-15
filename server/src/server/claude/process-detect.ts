import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type DetectedSession = {
  pid: number;
  ccSessionId: string;
  cwd: string;
  startedAt: number;
  status: 'idle' | 'busy';
  tmuxSessionName: string;
};

type RegistryEntry = {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  procStart?: string;
  status?: string;
};

// ── TTL cache + singleflight for detectClaudeSessions ──
const DETECT_TTL_MS = 2500;
let claudeDetectCache: { result: DetectedSession[]; expiresAt: number } | null = null;
let claudeDetectInFlight: Promise<DetectedSession[]> | null = null;

/** Invalidate the detect cache so the next call triggers a fresh scan. */
export function invalidateClaudeDetectCache(): void {
  claudeDetectCache = null;
}

/**
 * `~/.claude/sessions/<PID>.json` レジストリ(undocumented but reliable)を読んで
 * 生きている Claude Code プロセスを検出し、tmux session 名と紐付ける。
 */
export async function detectClaudeSessions(): Promise<DetectedSession[]> {
  const now = Date.now();
  if (claudeDetectCache && now < claudeDetectCache.expiresAt) {
    return claudeDetectCache.result;
  }
  if (claudeDetectInFlight) return claudeDetectInFlight;
  claudeDetectInFlight = detectClaudeSessionsUncached().then(
    (result) => {
      claudeDetectCache = { result, expiresAt: Date.now() + DETECT_TTL_MS };
      claudeDetectInFlight = null;
      return result;
    },
    (err) => {
      claudeDetectInFlight = null;
      throw err;
    },
  );
  return claudeDetectInFlight;
}

async function detectClaudeSessionsUncached(): Promise<DetectedSession[]> {
  console.log('[detect] scan claude');
  const dir = resolve(homedir(), '.claude/sessions');
  if (!existsSync(dir)) return [];

  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  type Candidate = { entry: RegistryEntry; pid: number };
  const candidates: Candidate[] = [];

  for (const f of files) {
    const pid = Number(f.replace('.json', ''));
    if (!Number.isFinite(pid) || pid <= 0) continue;

    let entry: RegistryEntry;
    try {
      entry = JSON.parse(readFileSync(resolve(dir, f), 'utf-8')) as RegistryEntry;
    } catch {
      continue;
    }

    // PID 生存確認
    try {
      process.kill(pid, 0);
    } catch {
      continue;
    }

    // PID再利用検出: /proc/<pid>/stat の field22 (starttime) と procStart 一致
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
      const fields = afterComm.split(' ');
      const starttime = fields[19]; // 1-indexed field 22 minus 3 (after pid + comm + state)
      if (entry.procStart && String(starttime) !== String(entry.procStart)) continue;
    } catch {
      // /proc を読めない (非Linux) ならスキップせず採用
    }

    candidates.push({ entry, pid });
  }

  if (candidates.length === 0) return [];

  const paneMap = await getTmuxPaneMap();
  const ppidMap = await getPpidMap();
  const result: DetectedSession[] = [];

  for (const { entry, pid } of candidates) {
    const tmuxName = findTmuxAncestor(pid, paneMap, ppidMap);
    if (!tmuxName) continue;

    result.push({
      pid,
      ccSessionId: entry.sessionId ?? '',
      cwd: entry.cwd ?? '',
      startedAt: entry.startedAt ?? 0,
      status: entry.status === 'busy' ? 'busy' : 'idle',
      tmuxSessionName: tmuxName,
    });
  }

  return result;
}

/** 与えられた pid から最大10段階上向きに親プロセスを辿り、tmux pane に当たれば session 名を返す。
 *  親 PID は `ps` 由来の pid→ppid マップで辿る (macOS / Linux 両対応)。
 *  旧実装は Linux 専用の `/proc/<pid>/status` を読んでいたため macOS では常に null になり、
 *  Claude セッションが 1 件も検出されなかった (= 今回の修正点)。 */
function findTmuxAncestor(
  startPid: number,
  paneMap: Map<number, string>,
  ppidMap: Map<number, number>,
): string | null {
  let cur = startPid;
  for (let i = 0; i < 10; i++) {
    const name = paneMap.get(cur);
    if (name) return name;
    const next = ppidMap.get(cur);
    if (!next || next === 1 || next === cur) return null;
    cur = next;
  }
  return null;
}

/** 全プロセスの pid→ppid マップ (`ps -Ao pid=,ppid=`)。macOS / Linux 共通。
 *  execFile (シェル無し) + 固定引数なので command injection の余地は無い。 */
async function getPpidMap(): Promise<Map<number, number>> {
  const run = promisify(execFile);
  try {
    const { stdout } = await run('ps', ['-Ao', 'pid=,ppid=']);
    const map = new Map<number, number>();
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) map.set(Number(m[1]), Number(m[2]));
    }
    return map;
  } catch {
    return new Map();
  }
}

async function getTmuxPaneMap(): Promise<Map<number, string>> {
  try {
    const { stdout } = await exec('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{pane_pid}|#{session_name}',
    ]);
    const map = new Map<number, string>();
    for (const line of stdout.split('\n')) {
      const [pidStr, name] = line.split('|');
      const pid = Number(pidStr);
      if (Number.isFinite(pid) && name) map.set(pid, name);
    }
    return map;
  } catch {
    return new Map();
  }
}
