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
    // PID だけでなく tmux セッション名も照合する。owner の PID は当該 pane 由来なので
    // 通常は一致するが、万一ズレた検出結果を拾って別セッションの状態を出さないため。
    return detected.find((d) => d.pid === liveOwner.pid && d.tmuxSessionName === tmuxSessionName);
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

/** 1 セッションについて分かっている材料一式。両エンドポイントはこれを組み立てて渡す。 */
export type SessionSignals = {
  tmuxSessionName: string;
  /** 素の store。実効ソースと source が違えば残骸として無視される。 */
  store?: StoreStatusInput;
  claudeDetected: readonly ClaudeDetectedInput[];
  codexDetected: readonly CodexDetectedInput[];
  liveOwner?: LiveOwnerInput;
};

/**
 * そのセッションの実効ソース (今その画面の主が claude か codex か) を決める。
 *
 * 優先順位: live owner (今その画面を握っている本人) → store (フック追跡) → 検出。
 * owner 不明時に勝手に切り替えない (sticky) のが狙い。
 * owner も store も無いときは claude 検出を先に見る。これは確度の優劣ではなく
 * /api/claude/sessions の既存挙動に合わせたもの (2 つの API で答えを一致させるのを優先。
 * registry にはヘッドレスの `claude -p` も載るので「registry の方が確か」ではない)。
 */
export function pickEffectiveSource(signals: SessionSignals): AgentSource | undefined {
  if (signals.liveOwner) return signals.liveOwner.source;
  if (signals.store?.source) return signals.store.source;
  if (pickClaudeDetected(signals.tmuxSessionName, signals.claudeDetected, signals.liveOwner)) return 'claude';
  if (pickCodexDetected(signals.tmuxSessionName, signals.codexDetected)) return 'codex';
  return undefined;
}

export type ResolveStatusInput = SessionSignals & {
  /** 実効ソース。pickEffectiveSource の結果を渡す。 */
  source: AgentSource;
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

// ───────── status の変化時刻トラッカー ─────────
//
// status はリクエストごとに計算していて履歴が無いため、クライアントからは
// 「この idle (= 完了) が自分の最後の確認より前の出来事か」を区別できない。
// そこでセッションごとに「直近に解決した status」と「それを最初に観測した時刻」を
// サーバのメモリに持ち、statusChangedAt として返す。
//
// 性質:
//   - あくまで「観測した日時」。検出キャッシュ (2.5 秒) とポーリング間隔のぶん、
//     実際の変化より数秒遅れることがある。
//   - メモリのみ (永続化しない)。サーバ再起動後は「再起動後に初めて観測した時刻」になる。
//   - status が変わらない限り更新しないので、同じリクエスト内や並行リクエストで
//     二重に観測しても値は動かない (no-op)。
//   - 既知事項: 並行リクエストで、古い検出キャッシュを掴んだ側が新しい検出を観測した
//     側より後に到着すると、記録が一瞬巻き戻ることがある (同じ busy 期間の中で
//     changedAt が数秒動く程度)。検出層の generation は「無効化のたびに増えるカウンタ」で
//     スキャンごとのスナップショット版数ではなく、しかも store (フック) 由来の入力には
//     版数が無いため、世代ガードでは観測順を正しく決められない。クライアントには
//     「秒単位で正確な時刻」ではなく「自分の最終確認より前か後か」の判定材料として
//     使ってもらう前提なので、ここでは対処しない。

type StatusObservation = { status: SessionStatus; changedAt: number };

const statusObservations = new Map<string, StatusObservation>();

/**
 * 解決済み status を記録し、その status に入ったと観測した時刻を返す。
 * 記録と同じ status なら何もせず既存の時刻を返す (初回観測は今の時刻)。
 */
export function observeSessionStatus(
  tmuxSessionName: string,
  status: SessionStatus,
  now: number = Date.now(),
): number {
  const prev = statusObservations.get(tmuxSessionName);
  if (prev && prev.status === status) return prev.changedAt;
  statusObservations.set(tmuxSessionName, { status, changedAt: now });
  return now;
}

/**
 * 1 セッションぶんの観測を捨てる。
 *
 * 実効ソースが不明になった (agent が居なくなった) 間は観測が止まるので、
 * そのまま残すと「フック未導入の claude が busy 中に落ちて、数時間後に同じ
 * セッションでまた busy になったら statusChangedAt が数時間前」になってしまう。
 * 観測できない状態に入ったら忘れて、次に観測できたときを初回として扱う。
 */
export function deleteSessionStatusObservation(tmuxSessionName: string): void {
  statusObservations.delete(tmuxSessionName);
}

/** 生きている tmux セッション名の集合に無いエントリを捨てる (kill / rename の掃除)。 */
export function pruneSessionStatusObservations(aliveNames: Iterable<string>): void {
  const alive = aliveNames instanceof Set ? aliveNames : new Set(aliveNames);
  for (const name of statusObservations.keys()) {
    if (!alive.has(name)) statusObservations.delete(name);
  }
}

/** テスト用: トラッカーを空にする。 */
export function resetSessionStatusObservations(): void {
  statusObservations.clear();
}

export type TrackedSessionStatus = {
  status: SessionStatus;
  /** その status に入ったとサーバが観測した時刻 (epoch ms)。startedAt / lastSeenAt と同じ形式。 */
  statusChangedAt: number;
};

/** status を解決し、同時に変化時刻を記録する。両エンドポイントはこれを使う。 */
export function resolveTrackedSessionStatus(
  input: ResolveStatusInput,
  now: number = Date.now(),
): TrackedSessionStatus {
  const status = resolveSessionStatus(input);
  return { status, statusChangedAt: observeSessionStatus(input.tmuxSessionName, status, now) };
}
