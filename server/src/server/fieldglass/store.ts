import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FieldglassData } from './types.ts';

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export function emptyData(): FieldglassData {
  return {
    version: 1, calendar: { updatedAt: null, day: null, source: 'none', events: [], lastSource: 'none', googleProbes: {}, retry: { failures: 0, nextAttemptAt: 0, authBlocked: false } },
    manualEvents: [], manualUpdatedAt: null, lastSource: 'none',
    objectives: {}, followups: [], connections: { updatedAt: null, connections: [] }, fieldtest: [],
  };
}

/** One serialized, atomically replaced JSON snapshot; telemetry is append-only within it.
 * No transcript/audio field exists. Importing this module performs no IO. */
export class FieldglassStore {
  readonly dir: string;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(dir = process.env.HEADLENSS_FIELDGLASS_DIR ?? join(homedir(), '.headlenss', 'fieldglass')) { this.dir = dir; }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }

  async ensureDirectory(): Promise<void> { await mkdir(this.dir, { recursive: true, mode: 0o700 }); }

  private async load(): Promise<FieldglassData> {
    let text: string;
    try { text = await readFile(join(this.dir, 'data.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyData(); throw error; }
    let data: FieldglassData;
    try { data = JSON.parse(text) as FieldglassData; } catch { throw new Error('Invalid Fieldglass storage'); }
    if (data?.version !== 1 || !data.calendar || !data.objectives || !data.connections || !Array.isArray(data.followups) || !Array.isArray(data.fieldtest)) {
      throw new Error('Invalid Fieldglass storage'); // Never silently overwrite a corrupt file.
    }
    // Additive Amendment 1 fields: preserve any cache written by the first v1 module.
    data.manualEvents ??= [];
    data.manualUpdatedAt ??= null;
    data.calendar.lastSource ??= data.calendar.source === 'calendar' ? 'google' : 'none';
    data.calendar.googleProbes ??= {};
    data.calendar.retry ??= { failures: 0, nextAttemptAt: 0, authBlocked: data.calendar.source === 'none' && data.calendar.googleProbes.google_calendar === 'needs_auth' };
    data.lastSource ??= data.calendar.lastSource;
    return data;
  }

  private async save(data: FieldglassData): Promise<void> {
    await this.ensureDirectory();
    const temporary = join(this.dir, `.data-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(data)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.dir, 'data.json'));
    } finally { await rm(temporary, { force: true }); }
  }

  read(): Promise<FieldglassData> { return this.serial(() => this.load()); }

  private async cleanupTemps(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of names) {
      if (/^\.data-[0-9a-f-]{36}\.tmp$/.test(name)) await rm(join(this.dir, name), { force: true });
    }
  }

  update<T>(mutate: (data: FieldglassData) => T): Promise<T> {
    return this.serial(async () => {
      const data = await this.load();
      const result = mutate(data);
      await this.save(data);
      return result;
    });
  }

  prune(now: number): Promise<void> {
    return this.serial(async () => {
      // Recover files left by a process exit during an atomic write. This runs
      // in the same queue as saves, so an active temporary file is never removed.
      await this.cleanupTemps();
      const data = await this.load();
      const retained = data.followups.filter((item) => item.sentAt !== undefined || item.expiresAt > now);
      if (retained.length !== data.followups.length) { data.followups = retained; await this.save(data); }
    });
  }

  clear(): Promise<void> {
    // Never recursively remove the override directory (it may contain unrelated files).
    return this.serial(async () => {
      await rm(join(this.dir, 'data.json'), { force: true });
      await this.cleanupTemps();
    });
  }
}
