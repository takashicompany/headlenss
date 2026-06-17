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
  return /OpenAI Codex|Codex CLI|\/permissions|\/model|tokens used|approval policy|Auto Review|Would you like to run/i.test(paneText);
}

export function isCodexPermissionPrompt(paneText: string): boolean {
  return /Would you like to run|Reviewing approval request|Press enter to confirm|Press enter to cancel|Yes, proceed|No, and tell Codex/i.test(paneText);
}

export function codexPaneNeedsHookAttention(paneText: string): boolean {
  return /\/hooks|hook.+review|review.+hook|trust.+hook|hook.+trust|not trusted|skipped.+hook/i.test(paneText);
}

export async function detectCodexSessions(): Promise<DetectedCodexSession[]> {
  let stdout = '';
  try {
    const result = await exec('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{session_created}\t#{session_activity}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}',
    ]);
    stdout = result.stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (stderr.includes('no server running') || stderr.includes('error connecting')) return [];
    throw err;
  }

  const bySession = new Map<string, DetectedCodexSession>();
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [tmuxSessionName, created, activity, paneId, command, ...cwdParts] = line.split('\t');
    if (!tmuxSessionName) continue;
    const cwd = cwdParts.join('\t') || homedir();
    let paneText = '';
    try {
      paneText = await capturePane(paneId, 80);
    } catch {
      continue;
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
  return [...bySession.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}
