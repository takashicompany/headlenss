import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const SEND_RETENTION_MS = 24 * 60 * 60 * 1000;
type Entry = { thread: string; time: number; ok: boolean };
const FILE = /^[a-f0-9]{64}\.json$/;

/** Optional 24h send log. Opaque hashed draft IDs are filenames; each record
 * contains exactly {thread,time,ok}. An unfinished reservation means unknown.
 * Nothing from a message body, recipient, contact, stdout or stderr is stored. */
export class DraftLog {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly dir: string) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private path(id: string) { return join(this.dir, `${createHash('sha256').update(id).digest('hex')}.json`); }
  private async read(path: string): Promise<Entry | null> {
    try {
      const data = JSON.parse(await readFile(path, 'utf8')) as Entry;
      return typeof data.thread === 'string' && Number.isFinite(data.time) && typeof data.ok === 'boolean' ? data : null;
    } catch { return null; } // A torn/unknown reservation must never permit a resend.
  }
  private async pruneFiles(now: number) {
    let files: string[];
    try { files = await readdir(this.dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const file of files) {
      if (!FILE.test(file) && !/^\.send-[a-f0-9-]{36}\.tmp$/.test(file)) continue;
      const path = join(this.dir, file);
      const entry = FILE.test(file) ? await this.read(path) : null;
      const time = entry?.time ?? (await stat(path)).mtimeMs;
      if (time <= now - SEND_RETENTION_MS) await rm(path, { force: true });
    }
  }
  prune(now: number) { return this.serial(() => this.pruneFiles(now)); }
  claim(id: string, thread: string, time: number): Promise<{ fresh: true; entry: Entry } | { fresh: false; entry: Entry | null }> {
    return this.serial(async () => {
      await this.pruneFiles(time);
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const path = this.path(id);
      let file;
      try { file = await open(path, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return { fresh: false, entry: await this.read(path) };
      }
      const entry = { thread, time, ok: false };
      try { await file.writeFile(JSON.stringify(entry)); await file.sync(); }
      finally { await file.close(); }
      return { fresh: true, entry };
    });
  }
  /** Only the owner of a fresh reservation may release a proven no-send.
   * Missing, changed or damaged records stay conservative: never erase a
   * sent/unknown guard merely because a later request was rejected. */
  releaseRejected(id: string, reservation: { thread: string; time: number }): Promise<void> {
    return this.serial(async () => {
      const path = this.path(id);
      const entry = await this.read(path);
      if (!entry || entry.ok || entry.thread !== reservation.thread || entry.time !== reservation.time) {
        throw new Error('Cannot release send reservation');
      }
      await rm(path);
    });
  }
  sent(id: string): Promise<void> {
    return this.serial(async () => {
      const path = this.path(id);
      const entry = await this.read(path);
      if (!entry) throw new Error('Missing send reservation');
      const temporary = join(this.dir, `.send-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({ ...entry, ok: true })); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    });
  }
  clear(): Promise<void> {
    return this.serial(async () => {
      let files: string[];
      try { files = await readdir(this.dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const file of files) if (FILE.test(file) || /^\.send-[a-f0-9-]{36}\.tmp$/.test(file)) await rm(join(this.dir, file), { force: true });
    });
  }
}
