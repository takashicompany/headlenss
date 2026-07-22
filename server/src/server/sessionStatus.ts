// セッションの活動状態 (idle / busy / waiting-*) を、web 一覧・G2 一覧・chat の
// すべてで同じ優先順位で解決するための単一リゾルバ。エンドポイント間で表示が
// 食い違わないようにする。
//
// 優先順位:
//   1. store が現在の主 (effSource) と一致する場合の waiting-permission / waiting-question
//      (フック由来。ユーザ応答待ちは最優先で見せる)
//   2. detection 由来の busy(Claude registry) / waiting-permission(Codex pane)
//   3. store 一致時の busy(フック由来)
//   4. それ以外は idle
//   - busy は Stop フック直後(store 一致 & lastStopAt)であれば idle に落とす。

import type { SessionStatus } from './claude/types.ts';

export function resolveSessionStatus(opts: {
  effSource: 'claude' | 'codex' | undefined;
  storeMatched: boolean;
  storeStatus?: SessionStatus;
  storeLastStopAt?: number;
  claudeBusy?: boolean; // Claude 検出 (registry) が busy
  codexWaitingPermission?: boolean; // Codex 検出 (pane) が承認待ち
}): SessionStatus {
  const { effSource, storeMatched, storeStatus, storeLastStopAt, claudeBusy, codexWaitingPermission } = opts;

  let status: SessionStatus = 'idle';
  if (effSource === 'claude' && claudeBusy) status = 'busy';
  if (effSource === 'codex' && codexWaitingPermission) status = 'waiting-permission';
  // store の waiting-* は detection より優先。
  if (storeMatched && (storeStatus === 'waiting-permission' || storeStatus === 'waiting-question')) {
    status = storeStatus;
  }
  // store の busy は、waiting でない場合のみ採用。
  if (storeMatched && storeStatus === 'busy' && status === 'idle') status = 'busy';
  // Stop 直後は busy を抑止。
  if (status === 'busy' && storeMatched && storeLastStopAt) status = 'idle';
  return status;
}
