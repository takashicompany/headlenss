// セッションの動作状態 (idle / busy / waiting-*) を「フック由来の store」と
// 「プロセス検出由来の registry / pane 走査」からマージして 1 つに決める共有ロジック。
//
// なぜ共有が要るか:
//   - Claude のフックは status に 'busy' を書かない (書く経路が無い)。'busy' は
//     registry (~/.claude/sessions/<PID>.json) の検出結果からしか分からない。
//   - 逆に 'waiting-permission' / 'waiting-question' はフック (store) 側にしか無い。
//   - Codex はフックが 'busy' を書くが、'waiting-permission' は pane 走査でも拾える。
// つまりどちらか一方だけを見ると必ず取りこぼす。以前は /api/claude/sessions だけが
// このマージを行い、/api/sessions は store をそのまま返していたため、
// 「フックを導入している Claude セッションほど /api/sessions では busy が見えない」
// という非対称が発生していた。両方をこの関数に通して同じ答えを返させる。
//
// 「どの検出結果を使うか」もここに入れている。status のマージだけを共有しても、
// 呼び出し側で det の選び方が違えば結局エンドポイント間で答えがズレるため
// (同一 tmux セッションに対話 claude と `claude -p` が同居するケース)。

import type { SessionStatus } from './claude/types.ts';

export type AgentSource = 'claude' | 'codex';

/** store (フック由来) のうち status 判定に要る部分。source が実効ソースと一致しない
 *  「別 agent の残骸」はこの中で弾くので、呼び出し側は素の store を渡してよい。 */
export type StoreStatusInput = {
  status: SessionStatus;
  source?: AgentSource;
  /** Stop hook 受信時刻。立っていればターンは終わっているので busy を抑止する。 */
  lastStopAt?: number;
};

/** registry 検出 (process-detect) のうち status 判定に要る部分。 */
export type ClaudeDetectedInput = {
  pid: number;
  tmuxSessionName: string;
  status: SessionStatus;
};

/** Codex 検出 (pane 走査) のうち status 判定に要る部分。 */
export type CodexDetectedInput = {
  tmuxSessionName: string;
  status: SessionStatus;
};

/** live owner (今その画面を握っている本人)。判定不能なら undefined。 */
export type LiveOwnerInput = { source: AgentSource; pid: number };

/**
 * その tmux セッションの status 判定に使う Claude の検出結果を選ぶ。
 *
 * live owner が claude なら owner PID に一致する検出結果「だけ」を使う (fail-closed)。
 * 名前一致でフォールバックすると、同じ tmux セッション内で動いているヘッドレスの
 * `claude -p` (busy) を対話 claude (idle) と取り違えて busy を出してしまう。
 * owner が codex / 不明のときは従来どおり名前一致 (同名複数なら後勝ち)。
 */
export function pickClaudeDetected<T extends ClaudeDetectedInput>(
  tmuxSessionName: string,
  detected: readonly T[],
  liveOwner?: LiveOwnerInput,
): T | undefined {
  if (liveOwner?.source === 'claude') {
    return detected.find((d) => d.pid === liveOwner.pid);
  }
  let last: T | undefined;
  for (const d of detected) {
    if (d.tmuxSessionName === tmuxSessionName) last = d;
  }
  return last;
}

/** Codex 検出は PID を持たないので名前一致のみ (同名複数なら後勝ち)。 */
function pickCodexDetected<T extends CodexDetectedInput>(
  tmuxSessionName: string,
  detected: readonly T[],
): T | undefined {
  let last: T | undefined;
  for (const d of detected) {
    if (d.tmuxSessionName === tmuxSessionName) last = d;
  }
  return last;
}

export type ResolveStatusInput = {
  /** 実効ソース (live owner → store → 検出 の順で呼び出し側が決めたもの)。 */
  source: AgentSource;
  tmuxSessionName: string;
  /** 素の store。source が実効ソースと違えば残骸として無視される。 */
  store?: StoreStatusInput;
  claudeDetected: readonly ClaudeDetectedInput[];
  codexDetected: readonly CodexDetectedInput[];
  liveOwner?: LiveOwnerInput;
};

/**
 * セッションの status を決める両エンドポイント共通の入口。
 * 検出結果の選び方まで含めて 1 箇所に閉じてあるので、
 * 同じ入力なら /api/sessions と /api/claude/sessions は必ず同じ答えになる。
 */
export function resolveSessionStatus(input: ResolveStatusInput): SessionStatus {
  // store が実効ソースと別 agent (= 前のランの残骸) なら status は使わない。
  // source 未設定の古い store も「一致とみなさない」= 使わない (従来挙動どおり)。
  const store = input.store && input.store.source === input.source ? input.store : undefined;

  if (input.source === 'claude') {
    const det = pickClaudeDetected(input.tmuxSessionName, input.claudeDetected, input.liveOwner);
    let status: SessionStatus = det?.status === 'busy' ? 'busy' : 'idle';
    // waiting-* はフックしか知らないので検出より優先する。
    if (store && (store.status === 'waiting-permission' || store.status === 'waiting-question')) {
      status = store.status;
    }
    // registry の busy が idle に追いつく前でも、Stop hook が来ていればターンは終わり。
    if (status === 'busy' && store?.lastStopAt) status = 'idle';
    return status;
  }

  const det = pickCodexDetected(input.tmuxSessionName, input.codexDetected);
  // 既知事項: この pane 走査由来の waiting-permission は、capture-pane のスクロール
  // バック (直近 80 行) に許可プロンプトの残骸が残っている間は張り付くことがある。
  // /api/claude/sessions では以前からこの挙動で、今回の統一で /api/sessions
  // (PC Web の一覧) にも同じものが出るようになる。両者で整合する既存挙動なので
  // ここでは変更しない (直すなら検出側の別課題)。
  let status: SessionStatus = det?.status === 'waiting-permission' ? 'waiting-permission' : 'idle';
  // Codex はフックが busy まで書くので、idle 以外を主張していればフックを優先。
  // (Claude 側と違い lastStopAt は見ない: Stop 相当のフックが idle を直接書くため。)
  if (store && store.status !== 'idle') status = store.status;
  return status;
}
