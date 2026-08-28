/**
 * G2 マイク (bridge.audioControl) の呼び出しを 1 か所にまとめる。
 *
 * 方針は「実機で失敗しないことが確かめられている素朴なやり方」に合わせる:
 *
 *  1. 取得は締切を置かずに待つ。実機は取得に数秒かかることがあり、こちらが
 *     勝手に見切ると「実機はマイクを開いたのにアプリだけ失敗扱い」になる。
 *     2.7.7 で入れた 1.5 秒の締切は、この形で録音開始の失敗を作っていた。
 *  2. 戻り値は見ない。実機は開けていても false を返すことがある。
 *     失敗と見なすのは例外 (SDK が明確に拒否した) だけ。
 *  3. 失敗しても状態を持ち越さない。冷却窓も未決着カウントも持たないので、
 *     1 回失敗した次のタップは何事も無かったように録音を始められる。
 *
 * 残す仕掛けは 1 つだけ: 取得が走っている間に取得を重ねない (多重取得の防止)。
 * 待ちが万一固まった時の逃げ道は、画面側の強制リセット (一定時間後のタップ) が持つ。
 */

/** 内部から見たマイクの状態。'closed' 以外は握っている可能性がある。 */
export type MicState = 'closed' | 'opening' | 'open' | 'closing'

/** openMic の結果。reason は診断用。 */
export type MicOpenResult = {
  ok: boolean
  reason: 'ok' | 'busy' | 'failed' | 'no-bridge'
}

interface MicBridge {
  audioControl(isOpen: boolean): Promise<boolean>
}

let getBridge: () => MicBridge | null = () => null
let log: (msg: string) => void = () => { /* noop until initMic */ }

let micState: MicState = 'closed'
/** 取得が走っている間だけ真。重ねて取得を出さないためだけに使う。 */
let openInFlight = false
/** 診断用の通算カウンタ。 */
let hostCalls = 0
let hostFailures = 0

export function initMic(opts: { bridge: () => MicBridge | null; log: (msg: string) => void }): void {
  getBridge = opts.bridge
  log = opts.log
}

export function getMicState(): MicState {
  return micState
}

/** アプリがマイクを握っている可能性があるか (取得中/解放中も含めて真)。 */
export function micIsHeld(): boolean {
  return micState !== 'closed'
}

/** マイク周りの状態を 1 行にまとめる (診断ダンプ用)。 */
export function micHealth(): string {
  return `mic health: state=${micState} opening=${openInFlight} calls=${hostCalls} failures=${hostFailures}`
}

/**
 * マイクを取得する。
 *
 * 締切は置かず、戻り値も見ない。例外が出た時だけ失敗として返す。
 * 失敗しても内部には何も残さないので、次の取得はそのまま試せる。
 */
export function openMic(): Promise<MicOpenResult> {
  if (openInFlight) {
    log('mic: 取得がすでに走っているので重ねては出しません')
    return Promise.resolve({ ok: false, reason: 'busy' })
  }
  const b = getBridge()
  if (!b) {
    log('mic: G2 bridge が無いので取得できません')
    return Promise.resolve({ ok: false, reason: 'no-bridge' })
  }
  openInFlight = true
  return (async (): Promise<MicOpenResult> => {
    micState = 'opening'
    hostCalls++
    try {
      // 締切なしで待つ。戻り値 (false) は失敗と見なさない。
      await b.audioControl(true)
      micState = 'open'
      return { ok: true, reason: 'ok' }
    } catch (err) {
      hostFailures++
      micState = 'closed'
      log(`mic: audioControl(true) 失敗 (${err})`)
      return { ok: false, reason: 'failed' }
    } finally {
      openInFlight = false
    }
  })()
}

/**
 * マイクを解放する。
 *
 * こちらも締切なし。例外は握りつぶす (後始末が呼び出し側を止めないため)。
 *
 * @param reason ログ用。どの経路から解放したか
 * @returns 解放を出せたか。失敗しても例外にはしない
 */
export async function closeMic(reason: string): Promise<boolean> {
  const b = getBridge()
  if (!b) {
    micState = 'closed'
    return true
  }
  micState = 'closing'
  hostCalls++
  try {
    await b.audioControl(false)
    micState = 'closed'
    return true
  } catch (err) {
    hostFailures++
    // 解放は「出した」ことが大事で、決着の真偽は追わない。
    // ここで握ったままの状態を残すと、次の取得が塞がれる方が害が大きい。
    micState = 'closed'
    log(`mic: audioControl(false) 失敗 (${reason}): ${err}`)
    return false
  }
}
