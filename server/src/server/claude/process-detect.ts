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
// Generation counter: incremented on invalidation. An in-flight scan captures
// the generation at start and only writes its result to the cache when the
// generation still matches — preventing a stale scan that started before an
// invalidation from overwriting the (now-null) cache after it.
let claudeDetectGeneration = 0;

/** Invalidate the detect cache so the next call triggers a fresh scan. */
export function invalidateClaudeDetectCache(): void {
  claudeDetectGeneration++;
  claudeDetectCache = null;
}

// ── Rate-limited diagnostic warnings ──
// 検出は過去に「無言で全滅」した (getPpidMap/getTmuxPaneMap が失敗しても空 Map を
// 返す設計だったため、findTmuxAncestor が全 candidate を取りこぼし『Claude 0 件』を
// 成功扱いでキャッシュしていた)。原因が journal に一切残らず調査が難航したので、
// 異常状態を構造化して warn する。ポーリング (数秒間隔) で溢れないよう key ごとに
// 一定間隔だけ出す。
const WARN_INTERVAL_MS = 30_000;
const lastWarnAt = new Map<string, number>();
function warnThrottled(key: string, message: string): void {
  const now = Date.now();
  if (now - (lastWarnAt.get(key) ?? 0) < WARN_INTERVAL_MS) return;
  lastWarnAt.set(key, now);
  console.warn(message);
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
  const genAtStart = claudeDetectGeneration;
  claudeDetectInFlight = detectClaudeSessionsUncached().then(
    (result) => {
      // Only cache if no invalidation occurred since scan started
      if (claudeDetectGeneration === genAtStart) {
        claudeDetectCache = { result, expiresAt: Date.now() + DETECT_TTL_MS };
      }
      claudeDetectInFlight = null;
      return result;
    },
    (err) => {
      claudeDetectInFlight = null;
      // 失敗はキャッシュされない (成功パスのみキャッシュする) ので次回すぐ再スキャンされる。
      // 無言で 0 件を返す旧挙動と違い、ここで必ず痕跡を残す。
      warnThrottled(
        'detect-scan-failed',
        `[detect] ⚠ Claude 検出スキャンが失敗しました: ${(err as Error).message}。` +
          `今回は検出分をスキップします (hook/store 追跡分は影響なし)。`,
      );
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

  // getPpidMap/getTmuxPaneMap は throw する (失敗を握り潰さない) ので、ここに来て
  // maps が空 = 本当に tmux/プロセスが無いケース。ただし「生きた candidate はあるのに
  // 1 件も tmux に紐付かない」状態は、出力フォーマット崩れや親子関係の追跡漏れなど
  // 想定外のサインなので構造化して warn する (無言全滅の再発検知)。
  if (candidates.length > 0 && result.length === 0) {
    warnThrottled(
      'detect-zero-match',
      `[detect] ⚠ Claude candidate ${candidates.length} 件に対し tmux 紐付けが 0 件でした ` +
        `(paneMap=${paneMap.size}, ppidMap=${ppidMap.size})。tmux/ps の出力が想定外か、` +
        `pane との親子関係を辿れていない可能性があります。`,
    );
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
  // 失敗は握り潰さず throw する。空 Map を返すと findTmuxAncestor が全 candidate を
  // 取りこぼし、「Claude セッション 0 件」を成功扱いでキャッシュしてしまう (過去の事故)。
  // タイムアウトと maxBuffer を明示してハング/切り詰めも検知できるようにする。
  const { stdout } = await exec('ps', ['-Ao', 'pid=,ppid='], {
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const map = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}

async function getTmuxPaneMap(): Promise<Map<number, string>> {
  let stdout: string;
  try {
    ({ stdout } = await exec('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{pane_pid}|#{session_name}',
    ], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (e) {
    // tmux サーバが居ない = 正常な「pane 0 件」。それ以外の失敗 (timeout / 予期せぬ
    // エラー) は握り潰さず throw し、上位で「検出失敗」として扱わせる (無言全滅を防ぐ)。
    const stderr = String((e as { stderr?: unknown }).stderr ?? '');
    if (/no server running|no current (client|session)|error connecting/i.test(stderr)) {
      return new Map();
    }
    throw e;
  }
  const map = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const [pidStr, name] = line.split('|');
    const pid = Number(pidStr);
    if (Number.isFinite(pid) && name) map.set(pid, name);
  }
  return map;
}
