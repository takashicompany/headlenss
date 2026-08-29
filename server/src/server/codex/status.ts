import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SessionStatus } from '../claude/types.ts';

const exec = promisify(execFile);

const REQUIRED_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
] as const;

export type CodexHookHealth = {
  status: 'ok' | 'missing' | 'incomplete';
  globalInstalled: boolean;
  projectInstalled: boolean;
  missingEvents: string[];
  hooksPath: string;
  projectHooksPath?: string;
  serverUrl: string;
  setupCommand: string;
  notes: string[];
};

export type DetectedCodexSession = {
  tmuxSessionName: string;
  cwd: string;
  status: SessionStatus;
  startedAt: number;
  lastSeenAt: number;
  hookHealth: CodexHookHealth;
  needsHookAttention: boolean;
};

function getHeadlenssServerUrl(): string {
  const explicit = (process.env.HEADLENSS_SERVER_URL ?? '').trim();
  if (explicit) return explicit;
  const rawHost = process.env.HOST ?? '127.0.0.1';
  const host = rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost;
  const port = process.env.PORT ?? '3000';
  return `http://${host}:${port}`;
}

function hookConfigHasEvent(config: unknown, event: string): boolean {
  if (!config || typeof config !== 'object') return false;
  const hooks = (config as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  const groups = (hooks as Record<string, unknown>)[event];
  if (!Array.isArray(groups)) return false;
  return groups.some((group) => {
    if (!group || typeof group !== 'object') return false;
    const handlers = (group as { hooks?: unknown }).hooks;
    if (!Array.isArray(handlers)) return false;
    return handlers.some((handler) => {
      if (!handler || typeof handler !== 'object') return false;
      const command = (handler as { command?: unknown }).command;
      return typeof command === 'string' && command.includes('headlenss-codex-hook.mjs');
    });
  });
}

function readHookConfig(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function resolveInstallScript(): string {
  const direct = resolve(process.cwd(), 'plugin/codex-hooks/install.mjs');
  if (existsSync(direct)) return direct;
  const fromServer = resolve(process.cwd(), '../plugin/codex-hooks/install.mjs');
  if (existsSync(fromServer)) return fromServer;
  return direct;
}

export function getCodexHookHealth(cwd?: string): CodexHookHealth {
  const hooksPath = resolve(homedir(), '.codex', 'hooks.json');
  const projectHooksPath = cwd ? resolve(cwd, '.codex', 'hooks.json') : undefined;
  const globalConfig = readHookConfig(hooksPath);
  const projectConfig = projectHooksPath ? readHookConfig(projectHooksPath) : null;

  const installedEvents = new Set<string>();
  for (const event of REQUIRED_HOOK_EVENTS) {
    if (hookConfigHasEvent(globalConfig, event) || hookConfigHasEvent(projectConfig, event)) {
      installedEvents.add(event);
    }
  }

  const missingEvents = REQUIRED_HOOK_EVENTS.filter((event) => !installedEvents.has(event));
  const globalInstalled = REQUIRED_HOOK_EVENTS.some((event) => hookConfigHasEvent(globalConfig, event));
  const projectInstalled = REQUIRED_HOOK_EVENTS.some((event) => hookConfigHasEvent(projectConfig, event));
  const status = missingEvents.length === 0 ? 'ok' : installedEvents.size > 0 ? 'incomplete' : 'missing';
  const notes: string[] = [];
  if (status === 'missing') {
    notes.push('HeadLenss Codex hooks are not installed. Install them, restart Codex, then trust them with /hooks.');
  } else if (status === 'incomplete') {
    notes.push('HeadLenss Codex hooks are installed, but some events are missing. Re-run the installer.');
  }
  if (status === 'ok') {
    notes.push('If this Codex session still does not appear, restart Codex and trust the HeadLenss hooks with /hooks.');
  }

  return {
    status,
    globalInstalled,
    projectInstalled,
    missingEvents,
    hooksPath,
    projectHooksPath,
    serverUrl: getHeadlenssServerUrl(),
    setupCommand: `node ${JSON.stringify(resolveInstallScript())}`,
    notes,
  };
}

async function capturePane(paneId: string, lines = 80): Promise<string> {
  const safeLines = Math.max(1, Math.min(2000, Math.floor(lines)));
  const { stdout } = await exec('tmux', [
    'capture-pane',
    '-t', paneId,
    '-p',
    '-J',
    '-S', `-${safeLines}`,
  ]);
  return stdout;
}

function isLikelyCodexPane(command: string, paneText: string): boolean {
  if (/\bcodex\b/i.test(command)) return true;
  return /OpenAI Codex|Codex CLI|approval policy|Auto Review|Would you like to run|No, and tell Codex/i.test(paneText);
}

export function isCodexPermissionPrompt(paneText: string): boolean {
  return /Would you like to run|Reviewing approval request|Press enter to confirm|Press enter to cancel|Yes, proceed|No, and tell Codex/i.test(paneText);
}

export function codexPaneNeedsHookAttention(paneText: string): boolean {
  return /\/hooks|hook.+review|review.+hook|trust.+hook|hook.+trust|not trusted|skipped.+hook/i.test(paneText);
}

// ── pane 走査 (TTL cache + singleflight) ──
//
// この走査 1 回で 2 つの答えを作る:
//   1. Codex セッションの検出結果 (従来どおり)
//   2. tmux セッションごとの「エージェントが居る pane」のテキスト
// 2 は画面ブロック検知 (screen-block.ts) が読む。走査済みのテキストを配るだけなので
// tmux 呼び出しは 1 本も増えない。キャッシュ・singleflight も共有する。
export type PaneScan = {
  codexSessions: DetectedCodexSession[];
  /** tmux セッション名 -> エージェント pane の capture-pane テキスト。 */
  paneTextBySession: Map<string, string>;
};

const DETECT_TTL_MS = 2500;
let paneScanCache: { result: PaneScan; expiresAt: number } | null = null;
let paneScanInFlight: Promise<PaneScan> | null = null;
// Generation counter: incremented on invalidation. An in-flight scan captures
// the generation at start and only writes its result to the cache when the
// generation still matches — preventing a stale scan that started before an
// invalidation from overwriting the (now-null) cache after it.
let paneScanGeneration = 0;

/** Invalidate the pane scan cache so the next call triggers a fresh scan. */
export function invalidateCodexDetectCache(): void {
  paneScanGeneration++;
  paneScanCache = null;
}

async function scanPanes(): Promise<PaneScan> {
  const now = Date.now();
  if (paneScanCache && now < paneScanCache.expiresAt) {
    return paneScanCache.result;
  }
  if (paneScanInFlight) return paneScanInFlight;
  const genAtStart = paneScanGeneration;
  paneScanInFlight = scanPanesUncached().then(
    (result) => {
      // Only cache if no invalidation occurred since scan started
      if (paneScanGeneration === genAtStart) {
        paneScanCache = { result, expiresAt: Date.now() + DETECT_TTL_MS };
      }
      paneScanInFlight = null;
      return result;
    },
    (err) => {
      paneScanInFlight = null;
      throw err;
    },
  );
  return paneScanInFlight;
}

export async function detectCodexSessions(): Promise<DetectedCodexSession[]> {
  return (await scanPanes()).codexSessions;
}

/**
 * tmux セッション名 -> エージェント pane のテキスト。
 * detectCodexSessions と同じ走査結果を配るだけで、追加の tmux 呼び出しは無い。
 */
export async function detectAgentPaneTexts(): Promise<Map<string, string>> {
  return (await scanPanes()).paneTextBySession;
}

/**
 * そのセッションで「ユーザが見ている / エージェントが居る」pane をどれだけ確からしく
 * 名乗れるか。同じセッションに dev server 用の window を足しても、エージェントの
 * pane を取り違えないよう順位を付けて選ぶ。
 */
function panePriority(command: string, isActive: boolean): number {
  const isAgent = /\b(claude|codex)\b/i.test(command);
  if (isAgent && isActive) return 3;
  if (isAgent) return 2;
  if (isActive) return 1;
  return 0;
}

async function scanPanesUncached(): Promise<PaneScan> {
  console.log('[detect] scan panes');

  let stdout = '';
  try {
    const result = await exec('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{session_created}\t#{session_activity}\t#{pane_id}\t#{pane_current_command}\t#{window_active}\t#{pane_active}\t#{pane_current_path}',
    ]);
    stdout = result.stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (stderr.includes('no server running') || stderr.includes('error connecting')) {
      return { codexSessions: [], paneTextBySession: new Map() };
    }
    throw err;
  }

  const bySession = new Map<string, DetectedCodexSession>();
  const paneTextBySession = new Map<string, string>();
  const paneTextRank = new Map<string, number>();
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [tmuxSessionName, created, activity, paneId, command, windowActive, paneActive, ...cwdParts] = line.split('\t');
    if (!tmuxSessionName) continue;
    const cwd = cwdParts.join('\t') || homedir();
    let paneText = '';
    try {
      paneText = await capturePane(paneId, 80);
    } catch {
      continue;
    }

    // 画面ブロック検知用のテキスト。順位が上の pane が来たら差し替える。
    const rank = panePriority(command ?? '', windowActive === '1' && paneActive === '1');
    if (rank > (paneTextRank.get(tmuxSessionName) ?? -1)) {
      paneTextRank.set(tmuxSessionName, rank);
      paneTextBySession.set(tmuxSessionName, paneText);
    }

    if (!isLikelyCodexPane(command ?? '', paneText)) continue;
    const hookHealth = getCodexHookHealth(cwd);
    bySession.set(tmuxSessionName, {
      tmuxSessionName,
      cwd,
      status: isCodexPermissionPrompt(paneText) ? 'waiting-permission' : 'idle',
      startedAt: Number(created) * 1000 || Date.now(),
      lastSeenAt: Number(activity) * 1000 || Date.now(),
      hookHealth,
      needsHookAttention: codexPaneNeedsHookAttention(paneText) || hookHealth.status !== 'ok',
    });
  }
  return {
    codexSessions: [...bySession.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    paneTextBySession,
  };
}
