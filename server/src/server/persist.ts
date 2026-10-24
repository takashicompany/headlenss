import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import * as claudeStore from './claude/store.ts';
import { detectClaudeSessions } from './claude/process-detect.ts';
import { createSession } from './tmux.ts';

const exec = promisify(execFile);

/**
 * 復元用スナップショット保存先。XDG 準拠 (XDG_CONFIG_HOME or ~/.config/headlenss)。
 * subuntu 再起動を跨いで「直前にどの tmux セッションが、どの cwd で、claude code 起動中だったか」
 * を記録するためのファイル。
 */
const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? resolve(process.env.XDG_CONFIG_HOME, 'headlenss')
  : resolve(homedir(), '.config/headlenss');
const SNAPSHOT_PATH = resolve(CONFIG_DIR, 'sessions.json');

/**
 * Codex セッションの会話表示を再起動越しに復元するための最小情報。
 *
 * なぜ必要か: Codex の会話中身は「フックが通知した transcriptPath」からしか読めず、
 * その値はメモリ上の store にしか無い。サーバを再起動すると store が空になるため、
 * 次の Codex フックが届くまで会話が空表示になっていた (実機で再現)。
 * Claude 側は cwd + ccSessionId から transcript を再検出できるのでここには入れない。
 */
type CodexSnapshot = {
  ccSessionId: string;
  tmuxPane: string;
  cwd: string;
  transcriptPath: string;
};

type SnapshotEntry = {
  tmuxSessionName: string;
  cwd: string;
  hasClaude: boolean;
  /** source='codex' の store エントリがあった時だけ付く (省略可能な追加フィールド)。 */
  codex?: CodexSnapshot;
};

/**
 * version は 1 のまま据え置く。
 * codex は「あれば使う」だけの追加フィールドで、
 *   - 旧バージョンが書いた codex 無しのファイルを新コードが読める (前方互換)
 *   - 新コードが書いたファイルを旧バージョンが読める (codex を無視するだけ = 後方互換)
 * の双方が成り立つため。version を上げると、切り戻した旧コードが
 * `version !== 1` で全エントリを捨て、tmux セッションの復元ごと失う。
 */
type SnapshotFile = {
  version: 1;
  savedAt: number;
  sessions: SnapshotEntry[];
};

/**
 * `tmux list-panes -a` で「セッション名 → 代表 pane の current_path」マップを作る。
 * tmux server が無い (正常): 空 Map を返す。tmux 自体が異常: null を返してスナップショットを更新させない。
 */
async function readTmuxSnapshot(): Promise<Map<string, string> | null> {
  try {
    const { stdout } = await exec('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{pane_current_path}',
    ]);
    const byName = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [name, cwd] = line.split('\t');
      // 同一セッション内の複数 pane は最初の 1 つを採用 (代表 pane)
      if (!byName.has(name)) byName.set(name, cwd ?? '');
    }
    return byName;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (stderr.includes('no server running') || stderr.includes('error connecting')) {
      // tmux サーバ無し: 「pristine 状態 (= snapshot を空に上書き)」と「persist の対象である
      // 稼働中のサーバが一時的に落ちた状態」が区別できないため、安全側に倒して null を返す
      // (= 今回の save は skip し既存 snapshot を保持)。
      // 真に「セッション 0 件」を反映したい場合は API DELETE が個別に save を走らせる
      // (= tmux server が稼働している正常経路) ので、ここで空 Map を返す必要はない。
      // この設計を変えるまで、s5-tmux-dead-no-clobber の再発防止になる。
      return null;
    }
    console.warn(`[persist] tmux list-panes failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * store から Codex セッションの復元情報を集める (会話表示に要る最小限)。
 * transcriptPath が無いものは復元しても意味が無いので落とす。
 * export しているのはテスト用 (save 経路は tmux を叩くのでユニットテストで回せない)。
 */
export function collectCodexSnapshots(): Map<string, CodexSnapshot> {
  const byName = new Map<string, CodexSnapshot>();
  for (const s of claudeStore.listSessions()) {
    if (s.source !== 'codex' || !s.transcriptPath) continue;
    byName.set(s.tmuxSessionName, {
      ccSessionId: s.ccSessionId,
      tmuxPane: s.tmuxPane,
      cwd: s.cwd,
      transcriptPath: s.transcriptPath,
    });
  }
  return byName;
}

/**
 * 現在の tmux 状態 + claude セッション情報をスナップショットファイルに書き出す。
 * tmux 異常時は既存ファイルを上書きしない (空で潰さない)。書き込みは tmp → rename で原子化。
 */
// restoreSessions 完了までは saveSnapshot を no-op にする。
// 起動直後、 restore が直列で createSession していく最中に並列 POST が来ると、
// readTmuxSnapshot は「復元途中の tmux 状態」を読んで、未復元 entry が消えた snapshot で
// 上書きしてしまう (scenario s15 で再現確認済の race)。
// restore 完了までは save を全部 skip して既存 snapshot を保持する。
let restoreInProgress = true;

export async function saveSnapshot(): Promise<void> {
  if (restoreInProgress) return;
  const tmuxMap = await readTmuxSnapshot();
  if (tmuxMap === null) return;

  // claude code が動いている tmux セッションの集合を作る。
  // 2 系統を OR でマージする:
  //   1) claudeStore.listSessions() ─ プラグインの hook (SessionStart 等) で登録されたもの
  //   2) detectClaudeSessions() ─ ~/.claude/sessions/ レジストリから検出されたもの (hook が
  //      何らかの理由で届かない時のフォールバック。/api/claude/sessions も同じ 2 系統マージ)
  // 1 だけだと、tmux pane 内で `claude` を手動起動して plugin の hook が届かない場合
  // hasClaude=false で保存されて restart 越しに claude が再起動されない、というバグになる
  // (実機で再現確認済)。
  const claudeNames = new Set<string>(
    claudeStore.listSessions().map((s) => s.tmuxSessionName),
  );
  try {
    const detected = await detectClaudeSessions();
    for (const d of detected) claudeNames.add(d.tmuxSessionName);
  } catch (e) {
    console.warn(`[persist] detectClaudeSessions failed in saveSnapshot: ${(e as Error).message}`);
  }

  // セッションの cwd は「最新の pane の作業ディレクトリを追跡する」ポリシー:
  // 各 save で `tmux list-panes -a` の pane_current_path をそのまま上書き保存する。
  // ユーザが pane 内で `cd` した場所が次回の restart 後の復元先になる。
  // 過去にあった「初回登録時の cwd を維持」設計は、Web UI から cwd 未指定で
  // 立てた瞬間に HOME が固定化され、後からユーザが正しい場所に cd しても反映
  // されない問題を起こしたため撤回した (8693827 を revert)。
  const codexByName = collectCodexSnapshots();
  const sessions: SnapshotEntry[] = [];
  for (const [name, currentCwd] of tmuxMap) {
    const entry: SnapshotEntry = {
      tmuxSessionName: name,
      cwd: currentCwd,
      hasClaude: claudeNames.has(name),
    };
    const codex = codexByName.get(name);
    if (codex) entry.codex = codex;
    sessions.push(entry);
  }

  const file: SnapshotFile = {
    version: 1,
    savedAt: Date.now(),
    sessions,
  };

  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    const tmp = `${SNAPSHOT_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2));
    await rename(tmp, SNAPSHOT_PATH);
  } catch (e) {
    console.warn(`[persist] saveSnapshot failed: ${(e as Error).message}`);
  }
}

/** codex フィールドの形を検証する。壊れていれば undefined (エントリ自体は捨てない)。 */
function parseCodexSnapshot(raw: unknown): CodexSnapshot | undefined {
  const c = raw as Partial<CodexSnapshot> | undefined;
  if (!c || typeof c !== 'object') return undefined;
  if (typeof c.transcriptPath !== 'string' || !c.transcriptPath) return undefined;
  return {
    ccSessionId: typeof c.ccSessionId === 'string' ? c.ccSessionId : '',
    tmuxPane: typeof c.tmuxPane === 'string' ? c.tmuxPane : '',
    cwd: typeof c.cwd === 'string' ? c.cwd : '',
    transcriptPath: c.transcriptPath,
  };
}

/**
 * スナップショット JSON を SnapshotEntry[] にする。
 * codex を持たない旧形式もそのまま読める (codex は undefined になるだけ)。
 * export しているのはテスト用。
 */
export function parseSnapshot(raw: string): SnapshotEntry[] {
  let parsed: SnapshotFile;
  try {
    parsed = JSON.parse(raw) as SnapshotFile;
  } catch {
    return [];
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) return [];
  const entries: SnapshotEntry[] = [];
  for (const e of parsed.sessions) {
    if (
      typeof e?.tmuxSessionName !== 'string' ||
      typeof e?.cwd !== 'string' ||
      typeof e?.hasClaude !== 'boolean'
    ) {
      continue;
    }
    const entry: SnapshotEntry = {
      tmuxSessionName: e.tmuxSessionName,
      cwd: e.cwd,
      hasClaude: e.hasClaude,
    };
    const codex = parseCodexSnapshot(e.codex);
    if (codex) entry.codex = codex;
    entries.push(entry);
  }
  return entries;
}

async function loadSnapshot(): Promise<SnapshotEntry[]> {
  try {
    return parseSnapshot(await readFile(SNAPSHOT_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * サーバ起動時に呼ぶ復元処理。
 *
 * - スナップショットファイルを読み、各エントリについて tmux セッションを再生成する
 * - 既に同名のセッションが立っていればスキップ (重複作成しない)
 * - `hasClaude: true` のセッションは `claude -c` も走らせる (createSession 内部で env による
 *   resume-prompt 抑止と TUI フォールバックが効く)
 * - 各セッションは直列に起動する (claude 起動が並列で重なるのを避けるため)
 *
 * 個別の失敗は warn ログを出して次へ進む。
 */
export async function restoreSessions(): Promise<void> {
  try {
    await restoreSessionsImpl();
  } finally {
    // restore 完了後にだけ saveSnapshot が動くようにする。 並列 POST race の対策。
    restoreInProgress = false;
  }
}

async function restoreSessionsImpl(): Promise<void> {
  const entries = await loadSnapshot();
  if (entries.length === 0) {
    console.log('[persist] no snapshot to restore');
    return;
  }

  const current = await readTmuxSnapshot();
  const existing = new Set<string>(current ? current.keys() : []);

  console.log(
    `[persist] restoring ${entries.length} session(s) from ${SNAPSHOT_PATH}`,
  );

  // tmux セッションとして存在する (= 既に居た or 今作れた) 名前。
  // Codex の store 復元はここに載った名前だけに限る (存在しない tmux の
  // 幽霊エントリを store に足さない)。
  const liveNames = new Set<string>();

  for (const entry of entries) {
    if (existing.has(entry.tmuxSessionName)) {
      console.log(`[persist] skip ${entry.tmuxSessionName} (already running)`);
      liveNames.add(entry.tmuxSessionName);
      continue;
    }
    console.log(
      `[persist] restore ${entry.tmuxSessionName} cwd=${entry.cwd} claude=${entry.hasClaude}`,
    );
    try {
      await createSession(entry.tmuxSessionName, {
        cwd: entry.cwd || undefined,
        startClaude: entry.hasClaude,
      });
      liveNames.add(entry.tmuxSessionName);
    } catch (e) {
      console.warn(
        `[persist] restore ${entry.tmuxSessionName} failed: ${(e as Error).message}`,
      );
    }
  }

  restoreCodexStoreEntries(entries, liveNames);
}

/**
 * スナップショットの codex 情報を store に戻す。
 *
 * これが無いと、サーバ再起動後は次の Codex フックが届くまで会話表示が空になる。
 * 復元するのは「表示のための材料」だけで、status は idle・chat は空のまま
 * (会話本体は transcript から読む)。
 *
 * 復元しない条件:
 *   - tmux セッションが存在しない (liveNames に無い)
 *   - transcript ファイルが実在しない (消えた古いセッションを復活させない)
 *   - 既に store にエントリがある (復元中に届いたフックを上書きしない)
 *
 * 「実は今 Claude が動いている pane」への誤表示は、復元された source='codex' の
 * store を live owner と突き合わせる既存ガード (claude/router.ts の isStoreStale)
 * が引き続き抑止する。ここでは store を足すだけで、その判定には手を入れない。
 */
export function restoreCodexStoreEntries(
  entries: readonly SnapshotEntry[],
  liveNames: ReadonlySet<string>,
): void {
  for (const entry of entries) {
    const codex = entry.codex;
    if (!codex) continue;
    if (!liveNames.has(entry.tmuxSessionName)) continue;
    if (!existsSync(codex.transcriptPath)) {
      console.log(
        `[persist] skip codex restore ${entry.tmuxSessionName} (transcript missing)`,
      );
      continue;
    }
    if (claudeStore.getSession(entry.tmuxSessionName)) continue;
    claudeStore.upsertSession({
      ccSessionId: codex.ccSessionId,
      tmuxPane: codex.tmuxPane,
      tmuxSessionName: entry.tmuxSessionName,
      cwd: codex.cwd || entry.cwd,
      source: 'codex',
      transcriptPath: codex.transcriptPath,
    });
    console.log(`[persist] codex store restored ${entry.tmuxSessionName}`);
  }
}

let persistTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 定期スナップショット。事故起動 (停電・OOM kill 等) で API hook が走らずに死んだ場合の保険。
 * 通常は createSession / killSession 直後の saveSnapshot() でカバーできる。
 */
export function startPeriodicSnapshot(intervalMs = 30000): void {
  if (persistTimer) return;
  persistTimer = setInterval(() => {
    void saveSnapshot();
  }, intervalMs);
}

export function stopPeriodicSnapshot(): void {
  if (persistTimer) {
    clearInterval(persistTimer);
    persistTimer = null;
  }
}
