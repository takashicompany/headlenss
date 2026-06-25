import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { validateName, type Session } from './tmux.ts';

export type RetainedSession = Session & {
  released: true;
  releasedAt: number;
  agent?: 'claude' | 'codex';
};

type RetainedFile = {
  version: 1;
  sessions: RetainedSession[];
};

const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? resolve(process.env.XDG_CONFIG_HOME, 'headlenss')
  : resolve(homedir(), '.config/headlenss');
const RETAINED_PATH = resolve(CONFIG_DIR, 'retained-sessions.json');

function loadFile(): RetainedFile {
  try {
    if (!existsSync(RETAINED_PATH)) return { version: 1, sessions: [] };
    const parsed = JSON.parse(readFileSync(RETAINED_PATH, 'utf8')) as RetainedFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return { version: 1, sessions: [] };
    return {
      version: 1,
      sessions: parsed.sessions.filter((s): s is RetainedSession =>
        typeof s?.name === 'string' &&
        typeof s.created === 'number' &&
        typeof s.activity === 'number' &&
        typeof s.releasedAt === 'number',
      ),
    };
  } catch {
    return { version: 1, sessions: [] };
  }
}

function saveFile(file: RetainedFile): void {
  mkdirSync(dirname(RETAINED_PATH), { recursive: true });
  const tmp = RETAINED_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, RETAINED_PATH);
}

export function listRetainedSessions(liveNames: Set<string>): RetainedSession[] {
  return loadFile().sessions.filter((s) => !liveNames.has(s.name));
}

export function hasRetainedSession(name: string): boolean {
  validateName(name);
  return loadFile().sessions.some((s) => s.name === name);
}

export function retainSession(session: Session & { agent?: 'claude' | 'codex' }): RetainedSession {
  validateName(session.name);
  const file = loadFile();
  const retained: RetainedSession = {
    ...session,
    windows: 0,
    attached: false,
    released: true,
    releasedAt: Date.now(),
  };
  file.sessions = [retained, ...file.sessions.filter((s) => s.name !== session.name)];
  saveFile(file);
  return retained;
}

export function removeRetainedSession(name: string): void {
  validateName(name);
  const file = loadFile();
  const next = file.sessions.filter((s) => s.name !== name);
  if (next.length === file.sessions.length) return;
  saveFile({ version: 1, sessions: next });
}

export function renameRetainedSession(name: string, nextName: string): RetainedSession {
  validateName(name);
  validateName(nextName);
  const file = loadFile();
  if (file.sessions.some((s) => s.name === nextName)) throw new Error('session name already exists');
  const idx = file.sessions.findIndex((s) => s.name === name);
  if (idx < 0) throw new Error('retained session not found');
  const updated = { ...file.sessions[idx], name: nextName, activity: Date.now() };
  file.sessions[idx] = updated;
  saveFile(file);
  return updated;
}
