/**
 * メッセージ送達 (ack) の追跡モジュール。
 *
 * 何を解決するか:
 *   HeadLenss は tmux にキーを撃つことでメッセージを送る。撃つこと自体はほぼ必ず
 *   成功するが、pane が塞がっている (ウィザード / ダイアログ / 別プロセスが前面)
 *   場合、その文字はエージェントの会話には入らない。送信 API が 200 を返しても
 *   「届いた」保証にはならない、というのがこの機構の出発点。
 *
 * どう確認するか:
 *   Claude Code / Codex CLI はどちらもプロンプトを受理した時点で UserPromptSubmit
 *   フックを HeadLenss に撃つ。つまりこのフックが「エージェントが受け取った」の
 *   唯一の一次情報 = ACK になる。送った本文とフックの本文を突き合わせて確認する。
 *
 * 状態遷移:
 *   created ──注入失敗──> injection_failed (終端)
 *      │
 *      ├──注入成功─────> awaiting_ack ──ACK 一致──> confirmed (終端)
 *      │                      └──8 秒経過──> unconfirmed ──遅れて一致──> confirmed_late
 *      │
 *      └──処理中のキューに投入───> queued ──ACK 一致──> confirmed
 *                                     │  (現ターンの Stop 到着で 8 秒タイマー開始)
 *                                     └──長期 TTL (10 分) 経過──> unconfirmed
 *
 *   queued だけ時間の扱いが違うのは、キューに入った本文は「今のターンが終わるまで」
 *   受理されないため。投入直後から 8 秒で切ると、正常にキューされた送信を必ず
 *   「届いていない」と誤報する。エージェントが処理中 (esc to interrupt 表示中) の
 *   送信がこれに当たる (Codex は Tab で積む / Claude Code は Enter で積まれる)。
 *
 * 正規化: trim + 連続空白 (改行含む) を単一スペースに圧縮。
 * マッチング: 正規化後の ACK 本文の中で、送った本文が「語の切れ目で丸ごと現れるか」を見る。
 * 入力欄に先客の書きかけが残っていたり、複数の送信が 1 つのプロンプトにまとめて受理されたりすると、
 * ACK 本文は送った本文より長くなる。詳しくは matchDeliveries のコメント。
 *
 * 元は「UI 送信かどうか (origin=ui/external) の判別」だけを行うモジュールだったので、
 * その役目 (confirmDelivery の origin) も引き続きここが持つ。
 */

/** 送達の状態。confirmed / confirmed_late / unconfirmed / injection_failed が終端。 */
export type DeliveryState =
  | 'created'
  | 'injection_failed'
  | 'awaiting_ack'
  | 'queued'
  | 'confirmed'
  | 'confirmed_late'
  | 'unconfirmed';

/** 注入後、ACK (UserPromptSubmit) を待つ時間。 */
const ACK_TIMEOUT_MS = 8_000;
/** キューに積まれた送信の上限。Stop が来ないまま放置された時の最後の砦。 */
const QUEUED_TTL_MS = 10 * 60 * 1000;
/** エントリ自体の保持上限。queued の長期 TTL より長くしないと、期限切れになる前に消える。 */
const ENTRY_TTL_MS = 15 * 60 * 1000;
/** セッションごとの保持件数上限。 */
const MAX_ENTRIES = 20;
/**
 * 同一イベントの二重フックとみなす時間窓。
 * global 設定と project 設定の両方に同じフックが入っていると、まったく同じ payload が
 * ほぼ同時 (数 ms〜数十 ms) に 2 回届く。一方で「利用者が同じ文面をもう一度送った」
 * ケースを二重フック扱いにすると、2 通目の送達が永久に確認されず誤報になる。
 * 人が送り直すのに要る時間より十分短く、二重フックの間隔より十分長い窓にする。
 */
const DUP_WINDOW_MS = 2_000;
/** 二重フック判定に使う既視キーの保持件数上限 (セッションごと)。 */
const MAX_SEEN_KEYS = 40;

type Delivery = {
  id: string;
  normalizedText: string;
  /** 送信 API がこの送達を作った時刻。警告の「いつ送ったか」もこれを使う。 */
  createdAt: number;
  state: DeliveryState;
  /** 非終端状態の期限 (epoch ms)。これを過ぎたら unconfirmed に落とす。 */
  deadline: number;
  /** エージェントの処理中キューに積まれた送信か。 */
  queued: boolean;
  /** queued の 8 秒タイマーを Stop 到着で開始済みか (Stop が複数回来ても伸ばさない)。 */
  queuedTimerStarted: boolean;
  confirmedAt?: number;
};

type SeenHook = {
  key: string;
  at: number;
  origin: 'ui' | 'external';
  deliveryId?: string;
};

/** session 名 → 送達エントリ (古い順) */
const deliveries = new Map<string, Delivery[]>();
/** session 名 → 既視フックキー (二重フック検出用、古い順) */
const seenHooks = new Map<string, SeenHook[]>();

let idSeq = 0;

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function isTerminal(state: DeliveryState): boolean {
  return state === 'confirmed' || state === 'confirmed_late'
    || state === 'unconfirmed' || state === 'injection_failed';
}

function bufferOf(tmuxName: string): Delivery[] {
  let buf = deliveries.get(tmuxName);
  if (!buf) {
    buf = [];
    deliveries.set(tmuxName, buf);
  }
  return buf;
}

/**
 * 期限切れの反映と、古いエントリの掃除。
 * タイマーは張らない (セッションが増えるほどタイマーが増えるのを避ける)。
 * 読み書きのたびにここを通すので、ポーリング間隔 (1.5 秒) の粒度で状態が進む。
 */
function evaluate(tmuxName: string, now: number): Delivery[] {
  const buf = deliveries.get(tmuxName);
  if (!buf) return [];
  for (const d of buf) {
    if (!isTerminal(d.state) && now >= d.deadline) d.state = 'unconfirmed';
  }
  for (let i = buf.length - 1; i >= 0; i--) {
    if (now - buf[i].createdAt > ENTRY_TTL_MS) buf.splice(i, 1);
  }
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
  if (buf.length === 0) deliveries.delete(tmuxName);
  return buf;
}

/** 送信 API が本文を tmux に撃つ「直前」に呼ぶ。返り値は送達 id (空文なら null)。 */
export function createDelivery(tmuxName: string, text: string, now: number = Date.now()): string | null {
  const normalized = normalize(text);
  if (!normalized) return null;
  const buf = bufferOf(tmuxName);
  const id = `d${now.toString(36)}-${++idSeq}`;
  buf.push({
    id,
    normalizedText: normalized,
    createdAt: now,
    state: 'created',
    // 注入結果の報告 (markDeliveryInjected/Failed) が来ないまま放置された場合でも
    // 宙に浮かせない。正常系ではこの期限が効く前に必ず上書きされる。
    deadline: now + ACK_TIMEOUT_MS,
    queued: false,
    queuedTimerStarted: false,
    confirmedAt: undefined,
  });
  evaluate(tmuxName, now);
  return id;
}

function findById(tmuxName: string, deliveryId: string): Delivery | undefined {
  return deliveries.get(tmuxName)?.find((d) => d.id === deliveryId);
}

/**
 * キー注入が成功した時に呼ぶ。
 * queued=true は処理中のエージェントのキューに積んだ場合 (現ターン終了までは受理されない)。
 * 注入報告より先に ACK が届いていた場合 (= 既に終端) は何もしない。
 */
export function markDeliveryInjected(
  tmuxName: string,
  deliveryId: string,
  opts: { queued: boolean },
  now: number = Date.now(),
): void {
  const d = findById(tmuxName, deliveryId);
  if (!d || d.state !== 'created') return;
  if (opts.queued) {
    d.queued = true;
    d.state = 'queued';
    d.deadline = d.createdAt + QUEUED_TTL_MS;
  } else {
    d.state = 'awaiting_ack';
    d.deadline = now + ACK_TIMEOUT_MS;
  }
}

/** キー注入自体が失敗した時に呼ぶ (tmux が無い等)。即座に終端 = 届いていない。 */
export function markDeliveryFailed(tmuxName: string, deliveryId: string): void {
  const d = findById(tmuxName, deliveryId);
  if (!d || d.state !== 'created') return;
  d.state = 'injection_failed';
}

/**
 * Stop (現ターン終了) を受けて、キュー投入済み送達の 8 秒タイマーを開始する。
 * ここから先はキューが掃けて UserPromptSubmit が来るはずなので、来なければ届いていない。
 */
export function startQueuedDeliveryTimer(tmuxName: string, now: number = Date.now()): void {
  const buf = evaluate(tmuxName, now);
  for (const d of buf) {
    if (d.state !== 'queued' || d.queuedTimerStarted) continue;
    d.queuedTimerStarted = true;
    d.deadline = Math.min(d.deadline, now + ACK_TIMEOUT_MS);
  }
}

/**
 * 正規化済みの ACK 本文 `hay` の中で、`needle` が「語の切れ目」に現れる位置を探す。
 * 前後は文字列の端か空白 1 つ (正規化後なので連続空白は無い) でなければならない。
 * 単なる部分一致を許すと、短い本文が無関係なプロンプトの一部に当たって偽陽性になる。
 */
function findSegment(hay: string, needle: string, from: number): number {
  let idx = hay.indexOf(needle, from);
  while (idx >= 0) {
    const leftOk = idx === 0 || hay[idx - 1] === ' ';
    const end = idx + needle.length;
    const rightOk = end === hay.length || hay[end] === ' ';
    if (leftOk && rightOk) return idx;
    idx = hay.indexOf(needle, idx + 1);
  }
  return -1;
}

/**
 * ACK 本文と送達の照合。
 *
 * なぜ完全一致だけでは足りないか:
 *   HeadLenss の送信は「エージェントの入力欄 (composer) に本文を追記して Enter」。
 *   入力欄は HeadLenss の持ち物ではないので、送る瞬間に既に他の本文が入っていることがある:
 *     - 前回の Enter が TUI の貼り付け判定に巻き込まれ、本文と改行が入力欄に残った
 *     - ユーザが tmux を直接触って書きかけを残していた / 履歴を呼び戻していた
 *     - 処理中に積んだ複数の送信をエージェントが 1 つのプロンプトにまとめて受理した
 *   このときフックが運んでくる本文は「入力欄全体」= 送った本文を含むもっと長い文字列になる。
 *   完全一致だけで見ると、届いているのに「届いていない」と誤報する。
 *
 * どう照合するか:
 *   送達を古い順に見ながら、ACK 本文を左から右へ 1 回だけなぞって「語の切れ目に現れるか」を
 *   見る。見つかった領域は消費して次の送達はその後ろから探すので、
 *     - 注入は送信順に入力欄に並ぶ (順序を守る)
 *     - 同じ文面を 2 通送ったのに ACK に 1 回しか現れなければ 1 通しか確認しない
 *   という性質が自然に出る。単一の完全一致はこの規則の特殊ケース。
 *
 * 届いていない送信は引き続き検出できる: 入力欄に入らなかった本文は ACK のどこにも現れない。
 */
function matchDeliveries(candidates: Delivery[], ackText: string): Delivery[] {
  const matched: Delivery[] = [];
  let cursor = 0;
  for (const d of candidates) {
    const at = findSegment(ackText, d.normalizedText, cursor);
    if (at < 0) continue;
    matched.push(d);
    cursor = at + d.normalizedText.length;
  }
  return matched;
}

export type ConfirmResult = {
  /** その本文が HeadLenss の UI 由来か (chat 表示のタグ付けに使う従来の用途)。 */
  origin: 'ui' | 'external';
  /** 一致した送達の id。 */
  deliveryId?: string;
  /** 同一イベントの二重フックと判定した (前回と同じ結果を返しており、二重に消費していない)。 */
  duplicate: boolean;
  /** 一致した送達の遷移後の状態。 */
  state?: DeliveryState;
};

/**
 * UserPromptSubmit フックの受信時に呼ぶ。エージェントが本文を受理した証拠なので、
 * 一致する送達を confirmed にする。1 つの ACK が複数の送達をまとめて含むことがあるため
 * (入力欄に溜まった本文がまとめて受理されるケース)、一致したものは全部確定させる。
 *
 * sessionId / turnId は二重フックの冪等化に使う。どちらも取れない時は冪等化しない
 * (「同じ文面を送り直した」と区別が付かないため。二重フックを素通ししても、
 *  2 回目は一致する送達が無くなっているだけで、誤って別の送達を確認することはない)。
 */
export function confirmDelivery(
  input: { tmuxName: string; text: string; sessionId?: string; turnId?: string },
  now: number = Date.now(),
): ConfirmResult {
  const { tmuxName } = input;
  const normalized = normalize(input.text);
  if (!tmuxName || !normalized) return { origin: 'external', duplicate: false };

  const identity = `${input.sessionId ?? ''} ${input.turnId ?? ''}`;
  const hasIdentity = identity !== ' ';
  const key = `${identity} ${normalized}`;
  if (hasIdentity) {
    const seen = seenHooks.get(tmuxName);
    const hit = seen?.find((s) => s.key === key && now - s.at <= DUP_WINDOW_MS);
    if (hit) {
      return {
        origin: hit.origin,
        deliveryId: hit.deliveryId,
        duplicate: true,
        state: hit.deliveryId ? findById(tmuxName, hit.deliveryId)?.state : undefined,
      };
    }
  }

  const buf = evaluate(tmuxName, now);
  let result: ConfirmResult = { origin: 'external', duplicate: false };
  // まだ確認待ちのものを優先して確定させる。見つからなければ、期限切れ後に遅れて
  // 届いたケースとして confirmed_late を見る (この優先順は変えない)。
  const matched = matchDeliveries(buf.filter((d) => !isTerminal(d.state)), normalized);
  const late = matched.length === 0
    ? matchDeliveries(buf.filter((d) => d.state === 'unconfirmed' || d.state === 'injection_failed'), normalized)
    : [];
  for (const d of matched) {
    d.state = 'confirmed';
    d.confirmedAt = now;
  }
  for (const d of late) {
    d.state = 'confirmed_late';
    d.confirmedAt = now;
  }
  const head = matched[0] ?? late[0];
  if (head) result = { origin: 'ui', deliveryId: head.id, duplicate: false, state: head.state };

  if (hasIdentity) {
    let seen = seenHooks.get(tmuxName);
    if (!seen) {
      seen = [];
      seenHooks.set(tmuxName, seen);
    }
    for (let i = seen.length - 1; i >= 0; i--) {
      if (now - seen[i].at > DUP_WINDOW_MS) seen.splice(i, 1);
    }
    seen.push({ key, at: now, origin: result.origin, deliveryId: result.deliveryId });
    if (seen.length > MAX_SEEN_KEYS) seen.splice(0, seen.length - MAX_SEEN_KEYS);
  }
  return result;
}

/** クライアントに載せる送達警告。confirmed になったセッションでは undefined になる。 */
export type DeliveryWarning = { sentAt: number };

/**
 * そのセッションの「最新の未確認送達」。
 *
 * 新しい方から見て、
 *   - 確認済み (confirmed / confirmed_late) に当たったら警告は出さない
 *     (その後に送ったものが届いている = 経路は生きている)
 *   - 未確認 (unconfirmed / injection_failed) に当たったらそれを警告として返す
 *   - まだ待っている最中 (created / awaiting_ack / queued) なら 1 つ前を見る
 * という順で決める。「直近 1 件だけ」を見ると、未確認の直後に送った 2 通目が
 * 待機中の間だけ警告が消えてしまうため。
 */
export function getDeliveryWarning(tmuxName: string, now: number = Date.now()): DeliveryWarning | undefined {
  const buf = evaluate(tmuxName, now);
  for (let i = buf.length - 1; i >= 0; i--) {
    const d = buf[i];
    if (d.state === 'confirmed' || d.state === 'confirmed_late') return undefined;
    if (d.state === 'unconfirmed' || d.state === 'injection_failed') return { sentAt: d.createdAt };
  }
  return undefined;
}

/** テスト・診断用: 送達エントリの現在値を取り出す。 */
export function getDeliveryState(tmuxName: string, deliveryId: string): DeliveryState | undefined {
  return findById(tmuxName, deliveryId)?.state;
}

/** セッション削除時に追跡を破棄する。 */
export function clearDeliveries(tmuxName: string): void {
  deliveries.delete(tmuxName);
  seenHooks.delete(tmuxName);
}

/** 生きている tmux セッション名の集合に無い追跡を捨てる (kill / rename の掃除)。 */
export function pruneDeliveries(aliveNames: Iterable<string>): void {
  const alive = aliveNames instanceof Set ? aliveNames : new Set(aliveNames);
  for (const name of [...deliveries.keys()]) {
    if (!alive.has(name)) deliveries.delete(name);
  }
  for (const name of [...seenHooks.keys()]) {
    if (!alive.has(name)) seenHooks.delete(name);
  }
}

/** テスト用: 全追跡を空にする。 */
export function resetDeliveriesForTest(): void {
  deliveries.clear();
  seenHooks.clear();
}

/** テスト用の定数公開 (期限の値をテストと二重管理しないため)。 */
export const DELIVERY_ACK_TIMEOUT_MS = ACK_TIMEOUT_MS;
export const DELIVERY_QUEUED_TTL_MS = QUEUED_TTL_MS;
export const DELIVERY_DUP_WINDOW_MS = DUP_WINDOW_MS;
export const DELIVERY_MAX_ENTRIES = MAX_ENTRIES;
export const DELIVERY_ENTRY_TTL_MS = ENTRY_TTL_MS;
