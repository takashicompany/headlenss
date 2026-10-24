import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import {
  confirmDelivery,
  createDelivery,
  clearDeliveries,
  DELIVERY_ACK_TIMEOUT_MS,
  DELIVERY_DUP_WINDOW_MS,
  DELIVERY_ENTRY_TTL_MS,
  DELIVERY_MAX_ENTRIES,
  DELIVERY_QUEUED_TTL_MS,
  getDeliveryState,
  getDeliveryWarning,
  markDeliveryFailed,
  markDeliveryInjected,
  pruneDeliveries,
  resetDeliveriesForTest,
  startQueuedDeliveryTimer,
} from './uiSubmissions.ts';

// 時刻は全部引数で渡す (実時間を待たない)。T0 は適当な固定基準。
const T0 = 1_700_000_000_000;
const S = 'sess';

beforeEach(() => {
  resetDeliveriesForTest();
});

/** 送って注入成功まで進めた送達を作る。 */
function sent(text: string, at: number, opts?: { queued?: boolean }): string {
  const id = createDelivery(S, text, at);
  assert.ok(id);
  markDeliveryInjected(S, id, { queued: opts?.queued === true }, at);
  return id;
}

test('ACK が来れば confirmed になり、警告は出ない', () => {
  const id = sent('hello world', T0);
  assert.equal(getDeliveryState(S, id), 'awaiting_ack');
  assert.equal(getDeliveryWarning(S, T0 + 1_000), undefined);

  const res = confirmDelivery({ tmuxName: S, text: 'hello world', sessionId: 'cc1' }, T0 + 1_000);
  assert.equal(res.origin, 'ui');
  assert.equal(res.deliveryId, id);
  assert.equal(res.duplicate, false);
  assert.equal(getDeliveryState(S, id), 'confirmed');
  // 8 秒を過ぎても確認済みのまま。警告も出ない。
  assert.equal(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS + 5_000), undefined);
});

test('改行や連続空白の違いは正規化して一致させる', () => {
  const id = sent('line one\nline two', T0);
  const res = confirmDelivery({ tmuxName: S, text: '  line one   line two  ', sessionId: 'cc1' }, T0 + 100);
  assert.equal(res.origin, 'ui');
  assert.equal(getDeliveryState(S, id), 'confirmed');
});

test('ACK が来ないまま 8 秒経つと unconfirmed になり警告が立つ', () => {
  const id = sent('no agent here', T0);
  // 期限直前はまだ待っている = 警告を出さない (早すぎる誤報を防ぐ)
  assert.equal(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS - 1), undefined);
  assert.equal(getDeliveryState(S, id), 'awaiting_ack');

  const warning = getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS);
  assert.deepEqual(warning, { sentAt: T0 });
  assert.equal(getDeliveryState(S, id), 'unconfirmed');
});

test('期限切れ後に遅れて ACK が来たら confirmed_late になり警告が消える', () => {
  const id = sent('late one', T0);
  assert.ok(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS));

  const res = confirmDelivery({ tmuxName: S, text: 'late one', sessionId: 'cc1' }, T0 + 20_000);
  assert.equal(res.origin, 'ui');
  assert.equal(getDeliveryState(S, id), 'confirmed_late');
  assert.equal(getDeliveryWarning(S, T0 + 20_001), undefined);
});

test('注入自体が失敗したら待たずに警告が立つ', () => {
  const id = createDelivery(S, 'boom', T0);
  assert.ok(id);
  markDeliveryFailed(S, id);
  assert.equal(getDeliveryState(S, id), 'injection_failed');
  assert.deepEqual(getDeliveryWarning(S, T0 + 10), { sentAt: T0 });
});

test('注入報告より先に ACK が届いても確認済みを巻き戻さない', () => {
  const id = createDelivery(S, 'fast agent', T0);
  assert.ok(id);
  confirmDelivery({ tmuxName: S, text: 'fast agent', sessionId: 'cc1' }, T0 + 5);
  assert.equal(getDeliveryState(S, id), 'confirmed');
  markDeliveryInjected(S, id, { queued: false }, T0 + 10);
  assert.equal(getDeliveryState(S, id), 'confirmed');
});

test('二重フック (同一 session_id + turn_id + 本文) は 1 回ぶんしか消費しない', () => {
  const first = sent('same text', T0);
  const second = sent('same text', T0 + 50);

  const a = confirmDelivery({ tmuxName: S, text: 'same text', sessionId: 'cx1', turnId: 't1' }, T0 + 100);
  // global 設定と project 設定の二重フックで、同じ payload がすぐ後に届く
  const b = confirmDelivery({ tmuxName: S, text: 'same text', sessionId: 'cx1', turnId: 't1' }, T0 + 110);

  assert.equal(a.duplicate, false);
  assert.equal(a.deliveryId, first);
  assert.equal(b.duplicate, true);
  assert.equal(b.origin, 'ui');
  assert.equal(b.deliveryId, first, '二重フックは同じ送達を指す (2 通目を食わない)');
  assert.equal(getDeliveryState(S, first), 'confirmed');
  assert.equal(getDeliveryState(S, second), 'awaiting_ack', '2 通目はまだ確認待ちのまま');
});

test('同じ文面を送り直した場合は二重フック扱いにしない (窓を過ぎた再送)', () => {
  const first = sent('same text', T0);
  const second = sent('same text', T0 + DELIVERY_DUP_WINDOW_MS + 1_000);
  confirmDelivery({ tmuxName: S, text: 'same text', sessionId: 'cx1', turnId: 't1' }, T0 + 100);
  const b = confirmDelivery(
    { tmuxName: S, text: 'same text', sessionId: 'cx1', turnId: 't2' },
    T0 + DELIVERY_DUP_WINDOW_MS + 1_100,
  );
  assert.equal(b.duplicate, false);
  assert.equal(b.deliveryId, second);
  assert.equal(getDeliveryState(S, first), 'confirmed');
  assert.equal(getDeliveryState(S, second), 'confirmed');
});

test('turn_id も session_id も無いフックは冪等化せず、素通ししても誤確認しない', () => {
  const id = sent('anon', T0);
  const a = confirmDelivery({ tmuxName: S, text: 'anon' }, T0 + 10);
  const b = confirmDelivery({ tmuxName: S, text: 'anon' }, T0 + 20);
  assert.equal(a.origin, 'ui');
  assert.equal(a.deliveryId, id);
  // 2 回目は一致する送達がもう無いので external。別の送達を勝手に確認したりしない。
  assert.equal(b.origin, 'external');
  assert.equal(b.duplicate, false);
});

test('UI から送っていない本文は external のまま (従来の origin 判定)', () => {
  const res = confirmDelivery({ tmuxName: S, text: 'typed directly in tmux', sessionId: 'cc1' }, T0);
  assert.equal(res.origin, 'external');
  assert.equal(res.deliveryId, undefined);
  assert.equal(getDeliveryWarning(S, T0), undefined);
});

test('Codex の Tab キュー投入は 8 秒では切らず、Stop 到着からタイマーが動く', () => {
  const id = sent('queued msg', T0, { queued: true });
  assert.equal(getDeliveryState(S, id), 'queued');
  // 現ターンが長引いても、キュー投入直後の 8 秒では未達扱いにしない
  assert.equal(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS + 60_000), undefined);
  assert.equal(getDeliveryState(S, id), 'queued');

  // Stop (現ターン終了) から 8 秒でタイムアウト
  const stopAt = T0 + 120_000;
  startQueuedDeliveryTimer(S, stopAt);
  assert.equal(getDeliveryWarning(S, stopAt + DELIVERY_ACK_TIMEOUT_MS - 1), undefined);
  assert.deepEqual(getDeliveryWarning(S, stopAt + DELIVERY_ACK_TIMEOUT_MS), { sentAt: T0 });
  assert.equal(getDeliveryState(S, id), 'unconfirmed');
});

test('Stop で開始したタイマーは後続の Stop で延びない', () => {
  const id = sent('queued msg', T0, { queued: true });
  const stopAt = T0 + 1_000;
  startQueuedDeliveryTimer(S, stopAt);
  startQueuedDeliveryTimer(S, stopAt + 5_000);
  assert.deepEqual(getDeliveryWarning(S, stopAt + DELIVERY_ACK_TIMEOUT_MS), { sentAt: T0 });
  assert.equal(getDeliveryState(S, id), 'unconfirmed');
});

test('Stop が来ないままの queued も長期 TTL で未達に落ちる', () => {
  const id = sent('queued forever', T0, { queued: true });
  assert.equal(getDeliveryWarning(S, T0 + DELIVERY_QUEUED_TTL_MS - 1), undefined);
  assert.deepEqual(getDeliveryWarning(S, T0 + DELIVERY_QUEUED_TTL_MS), { sentAt: T0 });
  assert.equal(getDeliveryState(S, id), 'unconfirmed');
});

test('キュー投入した送信も ACK が来れば confirmed', () => {
  const id = sent('queued msg', T0, { queued: true });
  startQueuedDeliveryTimer(S, T0 + 1_000);
  const res = confirmDelivery({ tmuxName: S, text: 'queued msg', sessionId: 'cx1', turnId: 't9' }, T0 + 2_000);
  assert.equal(res.origin, 'ui');
  assert.equal(getDeliveryState(S, id), 'confirmed');
  assert.equal(getDeliveryWarning(S, T0 + 30_000), undefined);
});

test('未確認の後に送った 2 通目が待機中でも、警告は消えない', () => {
  sent('first', T0);
  // 1 通目が期限切れになった後に 2 通目を送る
  assert.ok(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS));
  sent('second', T0 + 10_000);
  assert.deepEqual(getDeliveryWarning(S, T0 + 10_100), { sentAt: T0 }, '待機中の 2 通目で警告を隠さない');
});

test('後から送ったものが確認できたら、古い未確認の警告は消える', () => {
  sent('first', T0);
  assert.ok(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS));
  sent('second', T0 + 10_000);
  confirmDelivery({ tmuxName: S, text: 'second', sessionId: 'cc1' }, T0 + 10_500);
  assert.equal(getDeliveryWarning(S, T0 + 10_600), undefined);
});

test('件数上限を超えると古いものから捨てる', () => {
  for (let i = 0; i < DELIVERY_MAX_ENTRIES + 5; i++) sent(`msg ${i}`, T0 + i);
  // 最古の送達はもう追跡していない (= 一致もしない)
  const res = confirmDelivery({ tmuxName: S, text: 'msg 0', sessionId: 'cc1' }, T0 + 100);
  assert.equal(res.origin, 'external');
  // 直近のものは追跡が生きている
  assert.equal(confirmDelivery({ tmuxName: S, text: `msg ${DELIVERY_MAX_ENTRIES + 4}`, sessionId: 'cc1' }, T0 + 101).origin, 'ui');
});

test('保持期限を過ぎたエントリは捨てられ、警告も残らない', () => {
  sent('old', T0);
  assert.ok(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS));
  assert.equal(getDeliveryWarning(S, T0 + DELIVERY_ENTRY_TTL_MS + 1), undefined);
});

test('セッション削除 / prune で追跡を捨てる', () => {
  sent('gone', T0);
  assert.ok(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS));
  clearDeliveries(S);
  assert.equal(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS), undefined);

  sent('gone again', T0);
  assert.ok(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS));
  pruneDeliveries(new Set(['other-session']));
  assert.equal(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS), undefined);
  // 生きているセッションは残す
  sent('kept', T0);
  pruneDeliveries(new Set([S]));
  assert.ok(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS));
});

test('空文の送信は追跡しない', () => {
  assert.equal(createDelivery(S, '   \n  ', T0), null);
  assert.equal(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS), undefined);
});

// ───────── 入力欄に他の本文が残っていた場合 (実測バグの再現) ─────────
//
// 実測 (visionote / 2026-09-02):
//   1 通目 (142 文字) は受理されて confirmed になったのに、その本文が
//   エージェントの入力欄に残ったままだった。次に 2 通目 (11 文字) を送ると、
//   エージェントは「1 通目 + CR + 2 通目」を 1 つのプロンプトとして受理し、
//   フックの本文は 154 文字になった。完全一致しか見ていなかったため 2 通目は
//   永久に確認されず、届いているのに「送信未確認」の警告が出続けた。

test('入力欄に残っていた本文ごと受理されても、送った本文が含まれていれば確認できる', () => {
  const stale = '前の送信が入力欄に残っていた本文';
  const id = sent('なんでそうなったの', T0);
  // フックが運ぶのは入力欄全体。CR は正規化で空白になる。
  const res = confirmDelivery(
    { tmuxName: S, text: `${stale}\rなんでそうなったの`, sessionId: 'cc1', turnId: 't1' },
    T0 + 100,
  );
  assert.equal(res.origin, 'ui');
  assert.equal(res.deliveryId, id);
  assert.equal(getDeliveryState(S, id), 'confirmed');
  assert.equal(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS + 1_000), undefined);
});

test('送った本文が先頭に来る合成 (後からユーザが書き足した) でも確認できる', () => {
  const id = sent('先に送った本文', T0);
  const res = confirmDelivery(
    { tmuxName: S, text: '先に送った本文\nユーザが後から書き足した分', sessionId: 'cc1', turnId: 't1' },
    T0 + 100,
  );
  assert.equal(res.origin, 'ui');
  assert.equal(getDeliveryState(S, id), 'confirmed');
});

test('複数の送信が 1 つのプロンプトにまとめて受理されたら、全部まとめて確認する', () => {
  const first = sent('ひとつめ', T0, { queued: true });
  const second = sent('ふたつめ', T0 + 500, { queued: true });
  const res = confirmDelivery(
    { tmuxName: S, text: 'ひとつめ\nふたつめ', sessionId: 'cc1', turnId: 't1' },
    T0 + 1_000,
  );
  assert.equal(res.origin, 'ui');
  assert.equal(getDeliveryState(S, first), 'confirmed');
  assert.equal(getDeliveryState(S, second), 'confirmed');
  assert.equal(getDeliveryWarning(S, T0 + DELIVERY_QUEUED_TTL_MS + 1), undefined);
});

test('まとめて受理されたうち、期限切れになっていた分は confirmed_late で拾う', () => {
  const old = sent('古い方', T0);
  // 8 秒で unconfirmed に落ちる
  assert.deepEqual(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS), { sentAt: T0 });
  const res = confirmDelivery({ tmuxName: S, text: '書きかけ 古い方', sessionId: 'cc1', turnId: 't1' }, T0 + 20_000);
  assert.equal(res.origin, 'ui');
  assert.equal(getDeliveryState(S, old), 'confirmed_late');
  assert.equal(getDeliveryWarning(S, T0 + 20_001), undefined);
});

test('同じ文面を 2 通送って ACK に 1 回しか現れなければ、確認するのは 1 通だけ', () => {
  const first = sent('おなじ文面', T0);
  const second = sent('おなじ文面', T0 + DELIVERY_DUP_WINDOW_MS + 1_000);
  confirmDelivery({ tmuxName: S, text: '書きかけ おなじ文面', sessionId: 'cc1', turnId: 't1' }, T0 + DELIVERY_DUP_WINDOW_MS + 1_100);
  assert.equal(getDeliveryState(S, first), 'confirmed');
  assert.equal(getDeliveryState(S, second), 'awaiting_ack', '2 通目はまだ確認待ちのまま');
  // 2 通目は届いていないので、期限が来れば警告が立つ (誤報を消すために本物まで消さない)
  assert.deepEqual(
    getDeliveryWarning(S, T0 + DELIVERY_DUP_WINDOW_MS + 1_000 + DELIVERY_ACK_TIMEOUT_MS),
    { sentAt: T0 + DELIVERY_DUP_WINDOW_MS + 1_000 },
  );
});

test('本文の一部にたまたま含まれるだけ (語の切れ目でない) では確認しない', () => {
  const id = sent('やる', T0);
  const res = confirmDelivery({ tmuxName: S, text: 'これはやるべきではない', sessionId: 'cc1', turnId: 't1' }, T0 + 100);
  assert.equal(res.origin, 'external');
  assert.equal(getDeliveryState(S, id), 'awaiting_ack');
  assert.deepEqual(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS), { sentAt: T0 });
});

test('届いていない送信は、無関係な本文の ACK が来ても未確認のまま警告が立つ', () => {
  const id = sent('この本文は pane に飲まれた', T0);
  confirmDelivery({ tmuxName: S, text: '利用者が直接打った別の本文', sessionId: 'cc1', turnId: 't1' }, T0 + 100);
  assert.equal(getDeliveryState(S, id), 'awaiting_ack');
  assert.deepEqual(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS), { sentAt: T0 });
});

// ───────── レース: 注入報告より先に ACK が来る ─────────

test('合成された ACK が markDeliveryInjected より先に届いても確認できる', () => {
  const id = createDelivery(S, '後から送った本文', T0);
  assert.ok(id);
  // sendKeys 完了前 (= created のまま) にフックが着弾する
  const res = confirmDelivery(
    { tmuxName: S, text: '入力欄の残り\r後から送った本文', sessionId: 'cc1', turnId: 't1' },
    T0 + 5,
  );
  assert.equal(res.origin, 'ui');
  assert.equal(getDeliveryState(S, id), 'confirmed');
  // 遅れて来た注入報告で巻き戻さない
  markDeliveryInjected(S, id, { queued: false }, T0 + 10);
  assert.equal(getDeliveryState(S, id), 'confirmed');
  assert.equal(getDeliveryWarning(S, T0 + DELIVERY_ACK_TIMEOUT_MS + 1_000), undefined);
});
