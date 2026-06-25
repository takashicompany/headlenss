import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** `~/...` や相対パスをホーム基準で絶対パスに解決 */
function resolveCwd(input: string): string {
  const home = process.env.HOME ?? '/';
  if (input === '~') return home;
  if (input.startsWith('~/')) return path.join(home, input.slice(2));
  if (path.isAbsolute(input)) return input;
  return path.join(home, input);
}

export type Session = {
  name: string;
  created: number;
  /** 最終アクティビティ時刻 (ms)。tmux の `session_activity` を ms 化したもの。
   *  pane 内で何か出力があるたびに更新される。一覧の「最近触った順」ソートに使う。 */
  activity: number;
  windows: number;
  attached: boolean;
  cwd?: string;
  released?: boolean;
  releasedAt?: number;
};

const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

/**
 * tmux new-session の前置ラッパー (`.env` の HEADLENSS_TMUX_WRAPPER から
 * 空白区切りで読む)。systemd 環境では
 *   HEADLENSS_TMUX_WRAPPER="systemd-run --user --scope --quiet --collect --"
 * のように指定すると、tmux サーバが headlenss.service の cgroup から外れ、
 * systemctl restart で巻き添えにならない (= 今回の事故の根本対策)。
 * 未指定なら従来通り直接 tmux を起動する (macOS 等の非 systemd 環境向け)。
 */
function getTmuxWrapper(): { cmd: string; args: string[] } | null {
  const raw = (process.env.HEADLENSS_TMUX_WRAPPER ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { cmd: parts[0], args: parts.slice(1) };
}

/**
 * 新規 tmux セッションに注入する環境変数を `.env` の HEADLENSS_SESSION_ENV から読む。
 * `KEY=VALUE` を `;` 区切りで複数指定でき、それぞれ `new-session -e KEY=VALUE` になる。
 *   例: HEADLENSS_SESSION_ENV="TUSH_PUSH=on; GREETING=hello world"
 * `-e` で渡すとセッション環境に入るため、headlenss が起動する `claude` も、ユーザが
 * その pane で後から手動起動したコマンドも、後続ウィンドウも同じ値を継承する。
 * headlenss は中身を一切解釈しない (任意のフラグを通す汎用パススルー)。
 * 値に空白は含められるが `;` 自体は区切り文字なので含められない。
 */
function getSessionEnvArgs(): string[] {
  const raw = (process.env.HEADLENSS_SESSION_ENV ?? '').trim();
  if (!raw) return [];
  return raw
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.includes('='))
    .flatMap((pair) => ['-e', pair]);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getHeadlenssServerUrl(): string {
  const explicit = (process.env.HEADLENSS_SERVER_URL ?? '').trim();
  if (explicit) return explicit;
  const rawHost = process.env.HOST ?? '127.0.0.1';
  const host = rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost;
  const port = process.env.PORT ?? '3000';
  return `http://${host}:${port}`;
}

export function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error('invalid session name (use [a-zA-Z0-9_-], max 40 chars)');
  }
}

export async function listSessions(): Promise<Session[]> {
  try {
    const { stdout } = await exec('tmux', [
      'list-sessions',
      '-F',
      '#{session_name}\t#{session_created}\t#{session_activity}\t#{session_windows}\t#{session_attached}',
    ]);
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, created, activity, windows, attached] = line.split('\t');
        return {
          name,
          created: Number(created) * 1000,
          activity: Number(activity) * 1000,
          windows: Number(windows),
          attached: Number(attached) > 0,
        };
      });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (stderr.includes('no server running') || stderr.includes('error connecting')) return [];
    throw err;
  }
}

/**
 * tmux サーバ・セッションを headless ブラウザビューに最適化する設定を流す。
 * Claude Code 公式ドキュメント (code.claude.com/docs/en/terminal-config) で必須とされる
 * 3 設定をベースに、headlenss 固有の mouse/status を加えたもの。
 *
 *  - allow-passthrough on : 通知/プログレスバーを外側端末まで通す (Claude Code向け)
 *  - extended-keys on     : Shift+Enter 等の拡張キーを認識させる
 *  - terminal-features 'xterm*:extkeys'
 *                         : 外側端末が CSI u を受理できる旨を tmux に通知
 *                          (これが無いと extended-keys が pane へ伝わらない)
 *  - mouse off            : ホイールを tmux に取られず、ブラウザ側 xterm.js scrollback を効かせる
 *  - status off           : ステータスバーは Web UI で別表示するため非表示
 */
export async function configureSessionForHeadless(name: string): Promise<void> {
  validateName(name);
  // global / server option (全セッション共通)
  try { await exec('tmux', ['set', '-g', 'allow-passthrough', 'on']); } catch { /* ignore */ }
  try { await exec('tmux', ['set', '-s', 'extended-keys', 'on']); } catch { /* ignore */ }
  try { await exec('tmux', ['set', '-as', 'terminal-features', 'xterm*:extkeys']); } catch { /* ignore */ }
  // session option
  try { await exec('tmux', ['set', '-t', name, 'mouse', 'off']); } catch { /* ignore */ }
  try { await exec('tmux', ['set', '-t', name, 'status', 'off']); } catch { /* ignore */ }
}

export type CreateSessionOptions = {
  /** セッション開始時の作業ディレクトリ。`~`、`~/...`、相対パスはホーム基準で展開。
   *  ディレクトリが存在しなければ mkdir -p で作成する。 */
  cwd?: string;
  /** true なら新規シェル上で `claude -c || claude` を実行する (Claude Code 起動)。
   *  `claude -c` は過去会話の継続。失敗時 (該当会話無し等) は通常 `claude` にフォールバック。 */
  startClaude?: boolean;
  /** true なら新規シェル上で Codex を起動する。HeadLenss hooks が有効な cwd では chat view に登録される。 */
  startCodex?: boolean;
};

export async function createSession(
  name: string,
  options: CreateSessionOptions = {},
): Promise<void> {
  validateName(name);
  const home = process.env.HOME ?? '/';
  const targetCwd = options.cwd ? resolveCwd(options.cwd) : home;

  // cwd が指定されていれば作成 (存在すれば no-op、recursive: true なので親ごと作る)
  if (options.cwd) {
    try {
      await mkdir(targetCwd, { recursive: true });
    } catch (e) {
      throw new Error(`failed to create cwd "${targetCwd}": ${(e as Error).message}`);
    }
  }

  const wrapper = getTmuxWrapper();
  const tmuxArgs = [
    'new-session', '-d', '-c', targetCwd, '-s', name,
    ...getSessionEnvArgs(),
  ];
  if (wrapper) {
    await exec(wrapper.cmd, [...wrapper.args, 'tmux', ...tmuxArgs], { cwd: targetCwd });
  } else {
    await exec('tmux', tmuxArgs, { cwd: targetCwd });
  }
  await configureSessionForHeadless(name);

  if (options.startCodex) {
    await new Promise((r) => setTimeout(r, 300));
    const env = `HEADLENSS_SERVER_URL=${shellQuote(getHeadlenssServerUrl())}`;
    await sendKeys(name, `${env} codex resume --last || ${env} codex`, true);
    return;
  }

  if (options.startClaude) {
    // 新セッションのシェルがプロンプト準備完了するまで少し待つ
    await new Promise((r) => setTimeout(r, 300));
    // `claude -c` で過去会話継続を試み、失敗した場合は通常起動にフォールバック。
    // shell の `||` で分岐するので、bash/zsh/fish の最近のバージョンで動く。
    await sendKeys(name, 'claude -c || claude', true);

    // Claude Code 起動完了まで pane 内容を観察しながら trust prompt を捌く
    await advanceClaudeStartup(name);
  }
}

/**
 * `claude` コマンド送出後の起動シーケンスを pane 内容ベースで進める。
 *
 * 1. 信頼されていない作業ディレクトリでは「Is this a project you trust?」確認画面が
 *    表示される。ユーザの Enter を待っているため、確認画面を検出したら Enter を 1 回
 *    送って default 選択 "Yes, I trust this folder" を確定する。
 *    送らないと claude が完全起動せず ~/.claude/sessions/<PID>.json への self-register
 *    も行われず、後段の検出 API が新セッションを拾えない。
 * 2. claude main UI ("Welcome back" 等) を検出したら起動完了とみなし return。
 * 3. 既に信頼済みのディレクトリでは trust prompt は出ず、直接 main UI に着くため
 *    Enter は送らないまま return する。
 *
 * いずれの状態にも至らないまま timeout した場合はそのまま処理を抜ける (副作用なし)。
 */
async function advanceClaudeStartup(name: string, timeoutMs = 12000): Promise<void> {
  const TRUST_PROMPT_RE = /Is this a project you|trust this folder/i;
  const READY_RE        = /Welcome back|Tips for getting started|auto mode on/i;
  const POLL_INTERVAL_MS = 250;

  const deadline = Date.now() + timeoutMs;
  let trustConfirmed = false;
  while (Date.now() < deadline) {
    let content = '';
    try {
      content = await captureOutput(name, 60);
    } catch {
      // セッションが消えた/エラー: 諦める
      return;
    }
    // claude メインUIに到達済 → 完了
    if (READY_RE.test(content)) return;
    // trust prompt 表示中で未確定 → Enter で確定
    if (!trustConfirmed && TRUST_PROMPT_RE.test(content)) {
      try {
        await sendKeys(name, '', true);
        trustConfirmed = true;
      } catch {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/**
 * 「pty WebSocket 接続時に存在しないセッションを暗黙に auto-create する」設計は、
 * snapshot 復元と race して cwd が HOME に巻き戻る事故 (make-ss / agent の事例) の
 * 原因になったため廃止した。新規作成は明示的な POST /api/sessions だけに集約する。
 * pty WebSocket 経由でセッションが無い場合は `SessionNotFoundError` を throw して
 * 呼び出し側 (handlePtyConnection) が WebSocket を 4404 で close する。
 */
export class SessionNotFoundError extends Error {
  constructor(name: string) {
    super(`tmux session "${name}" not found`);
    this.name = 'SessionNotFoundError';
  }
}

/** セッションが存在することを要求。無ければ SessionNotFoundError を throw (auto-create しない)。 */
export async function requireSession(name: string): Promise<void> {
  validateName(name);
  try {
    await exec('tmux', ['has-session', '-t', name]);
  } catch {
    throw new SessionNotFoundError(name);
  }
  // 既存セッションには念のため headless 用設定を当て直す
  await configureSessionForHeadless(name);
}

export async function killSession(name: string): Promise<void> {
  validateName(name);
  await exec('tmux', ['kill-session', '-t', name]);
}

export async function getSessionCwd(name: string): Promise<string | undefined> {
  validateName(name);
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', name, '#{pane_current_path}']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function renameSession(name: string, nextName: string): Promise<void> {
  validateName(name);
  validateName(nextName);
  await exec('tmux', ['rename-session', '-t', name, nextName]);
}

export async function sendKeys(name: string, text: string, submit = false): Promise<void> {
  validateName(name);
  if (text.length > 0) {
    await exec('tmux', ['send-keys', '-t', name, '-l', text]);
  }
  if (submit) {
    await exec('tmux', ['send-keys', '-t', name, 'C-m']);
  }
}

export async function sendKey(name: string, key: string): Promise<void> {
  validateName(name);
  if (!/^[A-Za-z0-9_+-]+$/.test(key)) throw new Error('invalid key');
  await exec('tmux', ['send-keys', '-t', name, key]);
}

/**
 * セッションのアクティブpaneを capture-pane でテキスト化して返す。
 * `-p` stdout出力 / `-J` 折り返し行を結合 / `-S -<lines>` で開始行を相対指定。
 * 色エスケープは付かない (`-e` を渡さない)。
 */
export async function captureOutput(name: string, lines = 24): Promise<string> {
  validateName(name);
  const safeLines = Math.max(1, Math.min(2000, Math.floor(lines)));
  const { stdout } = await exec('tmux', [
    'capture-pane',
    '-t', name,
    '-p',
    '-J',
    '-S', `-${safeLines}`,
  ]);
  return stdout;
}
