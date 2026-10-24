// 「画面ブロック」検知。
//
// 何を見ているか:
//   Claude Code の TUI は、通常なら pane の下端に「入力欄」を描いている。
//   実キャプチャ (server/src/server/fixtures/panes/) で確認したとおり、その入力欄は
//
//       ──────────────────────────────  ← 罫線 (U+2500 が pane 幅ぶん)
//       ❯                               ← プロンプト行 (行頭が ❯)
//       ──────────────────────────────  ← 罫線
//
//   という 3 行の枠で、idle でも busy (esc to interrupt 表示中) でも必ず出ている。
//   ところが対話ウィザードや全画面ダイアログ (例: /auto-mode-setup) が前に出ると、
//   この枠ごと画面から消える。つまり「枠が無い = 通常の入力が届かない画面」。
//
// なぜ status で代替できないか:
//   ウィザードはフックを一切発火させないので store は idle のまま、registry も
//   busy にならない。status からは健常な idle と区別が付かず、メッセージを送っても
//   会話に届かないのに「idle」と報告してしまう。画面そのものを見るしかない。
//
// 誤検知を避けるための決め事:
//   - busy を弾かない: busy でも枠は出ているので、枠の有無だけで判定すれば
//     「考え中」を画面ブロックと取り違えない (fixtures/claude-busy-95col.txt で担保)。
//   - スクロールバックに残った過去の ❯ 行 (ウィザード起動時にエコーされた
//     `❯ /auto-mode-setup` 等) に釣られない。罫線・❯・罫線 の並びを要求する。
//   - waiting-permission / waiting-question は対象外。許可ダイアログも枠を隠すが、
//     そちらは HeadLenss が正規の応答経路を持っている (= 塞がっていない)。
//   - pane テキストが取れなかった (空) 時は判定しない。取得失敗を警告にしない。
//   - 一瞬の再描画で枠が欠けたコマを掴む可能性があるので、一定時間続けて
//     観測できたときだけ「塞がっている」と認める (下の CONFIRM_MS)。
//
// 対象は Claude のみ。Codex の TUI は入力欄の描き方が違うので、同じマーカーでは
// 判定できない (将来やるなら Codex の実キャプチャからマーカーを起こし、
// hasClaudeInputBox と並ぶ hasCodexInputBox を足して source で分岐させる)。

import type { SessionStatus } from './claude/types.ts';

export type AgentSource = 'claude' | 'codex';

/** 入力欄の罫線。pane 幅ぶん並ぶので長さの下限だけ決めておく。 */
const RULE_RE = /^[─━]{20,}$/;
/** 入力欄のプロンプト行。行頭 (字下げ無し) の ❯ / > のみ。
 *  ダイアログ内の選択カーソル (`  ❯ Also scan shell history`) は字下げされるので当たらない。 */
const PROMPT_RE = /^[❯>](\s|$)/;
/** 罫線 + 続きが 1 行に繋がってしまった場合に切り分けるための分解。
 *  capture-pane -J は「pane 幅ちょうどの行」を折り返しとみなして次行と繋ぐことがある。
 *  罫線は pane 幅ちょうどなので、その事故が起きても判定が崩れないようにしておく。 */
const RULE_PREFIX_RE = /^([─━]{20,})(.*)$/;

/** capture-pane のテキストを、判定に使う論理行に正規化する。 */
function toLogicalLines(paneText: string): string[] {
  const out: string[] = [];
  for (const raw of paneText.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const m = RULE_PREFIX_RE.exec(line);
    if (m && m[2] !== '') {
      out.push(m[1]);
      out.push(m[2]);
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Claude Code の入力欄 (罫線 / ❯ 行 / 罫線) が画面に出ているか。
 * 複数行入力中は ❯ 行の下に続きの行が入るので、罫線の対を下から探して
 * 「上の罫線の直後が ❯ 行」であればよい。
 */
export function hasClaudeInputBox(paneText: string): boolean {
  const lines = toLogicalLines(paneText);
  const rules: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (RULE_RE.test(lines[i])) rules.push(i);
  }
  for (let k = rules.length - 1; k >= 1; k--) {
    const top = rules[k - 1];
    const bottom = rules[k];
    if (bottom - top < 2) continue; // 罫線が連続 = 枠の中身が無い
    if (PROMPT_RE.test(lines[top + 1] ?? '')) return true;
  }
  return false;
}

/**
 * その pane テキストが「Claude は居るのに入力欄が見えていない」状態か。
 * テキストが取れていない (空) ときは判定しない (false)。
 */
export function isClaudeScreenBlocked(paneText: string | undefined): boolean {
  if (!paneText || !paneText.trim()) return false;
  return !hasClaudeInputBox(paneText);
}

// ───────── 「続いているか」の観測 ─────────
//
// 走査は 2.5 秒キャッシュ、クライアントのポーリングは 1.5 秒間隔なので、
// CONFIRM_MS を 3 秒にすると必ず 2 回以上別の走査で確認したことになる。
// 再描画途中の 1 コマだけを掴んで警告を出す事故を防ぐのが目的。
const CONFIRM_MS = 3_000;

const blockedSince = new Map<string, number>();

/** 観測を 1 件記録し、「十分続いたので塞がっていると認めてよいか」を返す。 */
function observeBlocked(tmuxSessionName: string, blockedNow: boolean, now: number): boolean {
  if (!blockedNow) {
    blockedSince.delete(tmuxSessionName);
    return false;
  }
  const since = blockedSince.get(tmuxSessionName);
  if (since === undefined) {
    blockedSince.set(tmuxSessionName, now);
    return false;
  }
  return now - since >= CONFIRM_MS;
}

export type ScreenBlockInput = {
  tmuxSessionName: string;
  /** 実効ソース (pickEffectiveSource の結果)。claude 以外は対象外。 */
  source: AgentSource | undefined;
  /** 解決済み status。waiting-* は正規の応答経路があるので対象外。 */
  status: SessionStatus | undefined;
  /** エージェント pane の capture-pane テキスト。未取得なら undefined。 */
  paneText: string | undefined;
};

/**
 * 画面ブロック判定の唯一の入口。2 つのエンドポイントが同じ答えを返すよう、
 * 「対象外の切り分け」「観測の記録」まで全部ここに閉じてある。
 */
export function resolveScreenBlocked(input: ScreenBlockInput, now: number = Date.now()): boolean {
  if (input.source !== 'claude') {
    blockedSince.delete(input.tmuxSessionName);
    return false;
  }
  if (input.status === 'waiting-permission' || input.status === 'waiting-question') {
    blockedSince.delete(input.tmuxSessionName);
    return false;
  }
  if (!input.paneText || !input.paneText.trim()) {
    // 取得できていない間は「前の観測」を持ち越さない (再取得できたら数えなおす)。
    blockedSince.delete(input.tmuxSessionName);
    return false;
  }
  return observeBlocked(input.tmuxSessionName, isClaudeScreenBlocked(input.paneText), now);
}

/** 生きている tmux セッション名の集合に無い観測を捨てる (kill / rename の掃除)。 */
export function pruneScreenBlockObservations(aliveNames: Iterable<string>): void {
  const alive = aliveNames instanceof Set ? aliveNames : new Set(aliveNames);
  for (const name of blockedSince.keys()) {
    if (!alive.has(name)) blockedSince.delete(name);
  }
}

/** テスト用: 観測を空にする。 */
export function resetScreenBlockObservations(): void {
  blockedSince.clear();
}

/** テスト用: 確定までの待ち時間 (ms)。 */
export const SCREEN_BLOCK_CONFIRM_MS = CONFIRM_MS;
