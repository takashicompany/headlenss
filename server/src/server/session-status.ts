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
// 「フックを入れている Claude セッションほど /api/sessions では busy が見えない」
// という非対称が発生していた。両方をこの関数に通して同じ答えを返させる。

import type { SessionStatus } from './claude/types.ts';

/** store (フック由来) の状態。現在の実効ソースと一致する store のみ渡すこと。
 *  別 agent の残骸 store を渡してはいけない (undefined を渡す)。 */
export type StoreStatusInput = {
  status: SessionStatus;
  /** Stop hook 受信時刻。立っていればターンは終わっているので busy を抑止する。 */
  lastStopAt?: number;
} | undefined;

/** プロセス検出 (registry / pane 走査) 由来の状態。未検出なら undefined。 */
export type DetectedStatusInput = { status: SessionStatus } | undefined;

/**
 * Claude セッションの status を決める。
 * 検出の 'busy' を土台に、フックしか知らない 'waiting-*' を上書きし、
 * Stop hook 済みなら busy を idle に落とす。
 */
export function resolveClaudeStatus(
  store: StoreStatusInput,
  detected: DetectedStatusInput,
): SessionStatus {
  let status: SessionStatus = detected?.status === 'busy' ? 'busy' : 'idle';
  if (store && (store.status === 'waiting-permission' || store.status === 'waiting-question')) {
    status = store.status;
  }
  // registry の busy が idle に追いつく前でも、Stop hook が来ていればターンは終わり。
  if (status === 'busy' && store?.lastStopAt) status = 'idle';
  return status;
}

/**
 * Codex セッションの status を決める。
 * pane 走査で拾える 'waiting-permission' を土台にし、フック (store) が
 * idle 以外を主張していればそちらを優先する (busy はフックだけが知っている)。
 */
export function resolveCodexStatus(
  store: StoreStatusInput,
  detected: DetectedStatusInput,
): SessionStatus {
  let status: SessionStatus = detected?.status === 'waiting-permission' ? 'waiting-permission' : 'idle';
  if (store && store.status !== 'idle') status = store.status;
  return status;
}

/** 実効ソースで振り分ける入口。エンドポイントはこれだけを呼ぶ。 */
export function resolveSessionStatus(
  source: 'claude' | 'codex',
  store: StoreStatusInput,
  detected: DetectedStatusInput,
): SessionStatus {
  return source === 'claude'
    ? resolveClaudeStatus(store, detected)
    : resolveCodexStatus(store, detected);
}
