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
// 解決順:
//   1. store が持つ pane (フックの X-Tmux-Pane 由来 = そのエージェント自身の $TMUX_PANE)
//      が今も生きていればそれを使う
//   2. 無ければ tmux に問い合わせ、そのセッションで claude/codex が前面のペインを探す
//      (サーバ再起動直後などフック未記録の状態を自己修復する)
//   3. どちらも駄目ならセッション名を返す (従来動作)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** tmux の pane ID 形式 (`%12`)。 */
const PANE_ID_RE = /^%\d+$/;
/** エージェントとみなす前面コマンド名。 */
const AGENT_CMD_RE = /\b(claude|codex)\b/i;
/** 解決結果のキャッシュ TTL。チャット取得は 1.5 秒毎に走るので毎回 tmux を叩かない。 */
const CACHE_TTL_MS = 2000;

export function isPaneId(target: string): boolean {
  return PANE_ID_RE.test(target);
}

type PaneInfo = { paneId: string; session: string; cmd: string; active: boolean };

async function listPanes(): Promise<PaneInfo[]> {
  try {
    const { stdout } = await exec('tmux', [
      'list-panes', '-a', '-F',
      '#{pane_id}\t#{session_name}\t#{pane_current_command}\t#{pane_active}',
    ]);
    const out: PaneInfo[] = [];
    for (const line of stdout.split('\n')) {
      const [paneId, session, cmd, active] = line.split('\t');
      if (!paneId || !session) continue;
      out.push({ paneId, session, cmd: cmd ?? '', active: active === '1' });
    }
    return out;
  } catch {
    return [];
  }
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
  let target = sessionName;

  // 1. store の pane がこのセッションに現存するならそれが最も確か
  //    (そのエージェント自身が名乗った pane なので取り違えようがない)
  if (storedPane && isPaneId(storedPane) && inSession.some((p) => p.paneId === storedPane)) {
    target = storedPane;
  } else {
    // 2. セッション内でエージェントが前面に居る pane を探す。
    //    複数あればアクティブなものを優先し、無ければ最初の 1 つ。
    const agents = inSession.filter((p) => AGENT_CMD_RE.test(p.cmd));
    const chosen = agents.find((p) => p.active) ?? agents[0];
    if (chosen) target = chosen.paneId;
  }

  cache.set(sessionName, { at: Date.now(), target });
  return target;
}

/** テスト用: キャッシュを捨てる */
export function resetAgentPaneCache(): void {
  cache.clear();
}
