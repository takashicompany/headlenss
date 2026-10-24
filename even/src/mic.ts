/**
 * G2 マイク (bridge.audioControl) の呼び出しを 1 か所にまとめる。
 *
 * 方針は「ホストの返事を録音の前提にしない」こと。実機では audioControl の応答が
 * 返ってこないことがあり (SDK にはタイムアウトもリトライも無い)、その決着に
 * 録音の開始・停止をぶら下げると、返事が来ないだけで録音画面が丸ごと固まる。
 *
 *  1. 取得も解放も「出す」ことだけを保証する。決着は待てるだけ待って、
 *     待ちきれなければ呼び出し側は先へ進む (締切は呼び出し側が渡す)。
 *  2. 戻り値は失敗と見なさない。実機は開けていても false を返すことがある。
 *     false は診断カウンタに残すだけ。
 *  3. 失敗しても状態を持ち越さない。冷却窓も未決着カウントも持たない。
 *  4. 未決着の取得を永久に握らない。取得中フラグは時間で自然に失効し、
 *     resetMicState() でいつでも手動で解ける。ここが塞がると
 *     「次のタップで録音が始まらない」になる。
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

/**
 * 取得中フラグの自動失効。ホストが決着を返さないまま この時間を超えたら、
 * 次の取得要求はフラグを無視して出し直す (永久ラッチを作らない)。
 */
const OPEN_LATCH_MAX_MS = 10000

let getBridge: () => MicBridge | null = () => null
let log: (msg: string) => void = () => { /* noop until initMic */ }

let micState: MicState = 'closed'
/** 取得が走っている間だけ真。重ねて取得を出さないためだけに使う。 */
let openInFlight = false
/** 取得を出した時刻 (自動失効の判定用)。 */
let openInFlightSince = 0
/**
 * マイク操作の世代。取得/解放/リセットのたびに進む。
 * 遅れて決着した呼び出しが、その後に始まった別の操作の状態を書き戻さないための鍵。
 */
let micGen = 0
/** 診断用の通算カウンタ。 */
let hostCalls = 0
let hostFailures = 0
/** ホストが false を返した回数 (失敗扱いはしないが、実機の挙動として残す)。 */
let hostFalseReturns = 0
/** 締切内に決着しなかった呼び出しの回数。 */
let hostUnsettled = 0

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
  return `mic health: state=${micState} opening=${openInFlight} calls=${hostCalls}`
    + ` failures=${hostFailures} falses=${hostFalseReturns} unsettled=${hostUnsettled}`
}

/**
 * マイクの内部状態を手元だけで畳む。
 *
 * ホストが決着を返さないまま残った「取得中」を解いて、次の取得を出せるようにする。
 * 実機へは何も出さない (出すのは呼び出し側の closeMic の仕事)。
 */
export function resetMicState(reason: string): void {
  if (!openInFlight && micState === 'closed') return
  log(`mic: 状態をリセットします (${reason}) state=${micState} opening=${openInFlight}`)
  micGen++            // 走っている呼び出しの後始末を無効化する
  openInFlight = false
  openInFlightSince = 0
  micState = 'closed'
}

/**
 * マイクを取得する。
 *
 * 締切は置かず、戻り値も見ない。例外が出た時だけ失敗として返す。
 * 呼び出し側はこの Promise の決着を待たずに録音を進めてよい
 * (待つ場合も締切を自分で持つこと)。
 */
export function openMic(): Promise<MicOpenResult> {
  if (openInFlight) {
    const held = openInFlightSince > 0 ? Date.now() - openInFlightSince : 0
    if (held < OPEN_LATCH_MAX_MS) {
      log('mic: 取得がすでに走っているので重ねては出しません')
      return Promise.resolve({ ok: false, reason: 'busy' })
    }
    // ホストが決着を返さないまま時間が過ぎた。ここで諦めないと次の録音が永久に
    // 始まらないので、前の取得は無かったことにして出し直す。
    log(`mic: 前の取得が ${held}ms 決着しないので、取得を出し直します`)
    hostUnsettled++
    micGen++
    openInFlight = false
    openInFlightSince = 0
  }
  const b = getBridge()
  if (!b) {
    log('mic: G2 bridge が無いので取得できません')
    return Promise.resolve({ ok: false, reason: 'no-bridge' })
  }
  const gen = ++micGen
  openInFlight = true
  openInFlightSince = Date.now()
  return (async (): Promise<MicOpenResult> => {
    micState = 'opening'
    hostCalls++
    try {
      // 締切なしで待つ。戻り値 (false) は失敗と見なさない。
      const ret = await b.audioControl(true)
      if (ret === false) {
        hostFalseReturns++
        log('mic: audioControl(true) が false を返しました (実機は開いていることがあるので失敗にしません)')
      }
      if (gen === micGen) micState = 'open'
      return { ok: true, reason: 'ok' }
    } catch (err) {
      hostFailures++
      if (gen === micGen) micState = 'closed'
      log(`mic: audioControl(true) 失敗 (${err})`)
      return { ok: false, reason: 'failed' }
    } finally {
      if (gen === micGen) {
        openInFlight = false
        openInFlightSince = 0
      }
    }
  })()
}

/**
 * マイクを解放する。
 *
 * 例外は握りつぶす (後始末が呼び出し側を止めないため)。
 *
 * @param reason ログ用。どの経路から解放したか
 * @param waitMs 決着を待つ上限 (ms)。0 以下なら決着まで待つ。
 *               締切を超えたら false を返して呼び出し側を先へ進める
 *               (解放そのものはバックグラウンドで決着させる)。
 * @returns 締切内に解放が決着したか。失敗しても例外にはしない
 */
export function closeMic(reason: string, waitMs = 0): Promise<boolean> {
  const b = getBridge()
  if (!b) {
    micGen++
    openInFlight = false
    openInFlightSince = 0
    micState = 'closed'
    return Promise.resolve(true)
  }
  // 取得が未決着でも解放は出す。取得の後始末がこの後の状態を書き戻さないよう
  // 世代を進めてから出す。
  const gen = ++micGen
  openInFlight = false
  openInFlightSince = 0
  micState = 'closing'
  hostCalls++
  let settled = false
  const done = (async (): Promise<boolean> => {
    try {
      await b.audioControl(false)
      if (gen === micGen) micState = 'closed'
      return true
    } catch (err) {
      hostFailures++
      // 解放は「出した」ことが大事で、決着の真偽は追わない。
      // ここで握ったままの状態を残すと、次の取得が塞がれる方が害が大きい。
      if (gen === micGen) micState = 'closed'
      log(`mic: audioControl(false) 失敗 (${reason}): ${err}`)
      return false
    } finally {
      settled = true
    }
  })()
  if (waitMs <= 0) return done
  return Promise.race([
    done,
    new Promise<boolean>((resolve) => {
      setTimeout(() => {
        if (settled) return   // 先に決着していれば race の結果はそちら
        hostUnsettled++
        // 握ったままの扱いを残さない。実機へは解放を出し終えていて、
        // これ以上こちらから出来ることは無い。
        if (gen === micGen) micState = 'closed'
        log(`mic: audioControl(false) が ${waitMs}ms で決着しません (${reason}) — 待たずに先へ進みます`)
        resolve(false)
      }, waitMs)
    }),
  ])
}
