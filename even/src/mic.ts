/**
 * G2 マイク (bridge.audioControl) のライフサイクルを 1 か所に集約する。
 *
 * これまで「マイクを閉じる」は録音中 (phase==='recording') の分岐の中でしか
 * 呼ばれておらず、取得に失敗した/取得を待っている間に停止された、という経路では
 * 一切呼ばれなかった。実機は「マイクを開いてから失敗を返す」ことがあるので、
 * その状態でアプリが何もしないとマイクは握られたまま残り、次の録音は
 * 「すでに開いている」として永久に失敗し続ける (アプリを再起動しても解けない)。
 *
 * ここで守ること:
 *  1. audioControl の呼び出しは必ず 1 本の直列キューを通る。
 *     取得の決着前に解放を積んでも「後から出した解放が先に流れて効かない」ことがない。
 *  2. 取得が失敗 (false / 例外 / 時間切れ) したら、その場で必ず 1 回だけ
 *     補償の解放を出す。ただし *待たない*。待つと失敗の後始末そのものが
 *     次の操作を塞ぐ (ホストが無応答のとき、待ち時間がそのまま画面の固まりになる)。
 *  3. ホストが無応答なら、待つのをやめるだけでなく「叩くのもやめる」。
 *     時間切れが 2 回続いたら冷却窓を張り、その間の要求はホストへ出さずに即失敗させる。
 *     決着していないホスト操作が 1 件でも残っている間も、新規の取得は 'stalled' で
 *     即失敗させる (詰まったホストに要求を積み増さない)。
 *  4. 失敗を closed に偽装しない。解放しきれていない状態は 'stalled' として持ち、
 *     micIsHeld() は真を返す。後片付けの経路 (foreground exit 等) が必ず拾える。
 */

/**
 * 内部から見たマイクの状態。
 * 'closed' 以外は「アプリ (あるいは実機) がマイクを握っている可能性がある」。
 * 'stalled' は「解放を出したが決着しなかった」= 握られたままかもしれない状態。
 */
export type MicState = 'closed' | 'opening' | 'open' | 'closing' | 'stalled'

/** openMic の結果。reason は診断とレンズ表示の出し分け用。 */
export type MicOpenResult = {
  ok: boolean
  gen: number
  reason: 'ok' | 'stalled' | 'stale' | 'failed' | 'busy'
}

/**
 * audioControl が返ってこない時に待つのをやめる上限。
 * SDK 側は止められないので、あくまで「こちらが待つのをやめる」ための保険。
 * 時間切れは失敗扱いにして補償の解放へ倒す。
 * 人が「反応しない」と感じるのは 1 秒あたりからなので、そこに合わせて短くする。
 */
const MIC_CONTROL_TIMEOUT_MS = 1500
/** これだけ連続で時間切れしたらホストは無応答とみなす。 */
const MIC_UNRESPONSIVE_LIMIT = 2
/** 無応答とみなした後、ホストを叩かずに即失敗させる冷却窓。 */
const MIC_COOLOFF_MS = 10000
/** 直列キューに積める要求の上限。これを超えた分は待たせずに即失敗させる。 */
const MIC_QUEUE_MAX = 4

interface MicBridge {
  audioControl(isOpen: boolean): Promise<boolean>
}

let getBridge: () => MicBridge | null = () => null
let log: (msg: string) => void = () => { /* noop until initMic */ }

let micState: MicState = 'closed'
/**
 * 取得/解放の要求ごとに進む世代。要求を出した側は自分の世代を持ち帰り、
 * await から戻った時点で「その後に別の要求が積まれていないか」を確かめられる。
 */
let micGen = 0
/** audioControl の直列キュー。ここに積んだ順にしか実機へ届かない。 */
let queue: Promise<void> = Promise.resolve()
/** キューに積んであってまだ走っていない仕事の数 (上限判定用)。 */
let queued = 0

/** ホストへ出したまま決着していない audioControl の本数 (= SDK 側の居座り)。 */
let pendingHostOps = 0
/** 連続した時間切れの回数。1 回でも決着したら 0 に戻す。 */
let consecutiveTimeouts = 0
/** この時刻までホストを叩かない (無応答ラッチ)。 */
let hostColdUntil = 0
/** 診断用の通算カウンタ。 */
let hostCalls = 0
let hostTimeouts = 0

/**
 * まだ走り出していない解放要求。連続した closeMic はここに畳んで 1 本にする
 * (ダブルタップや後片付けの重なりで、同じ解放を何本もホストへ出さない)。
 */
let coalescedClose: { promise: Promise<boolean>; reasons: string[] } | null = null

export function initMic(opts: { bridge: () => MicBridge | null; log: (msg: string) => void }): void {
  getBridge = opts.bridge
  log = opts.log
}

export function getMicState(): MicState {
  return micState
}

/** アプリがマイクを握っている可能性があるか (取得中/解放中/決着不明も含めて真)。 */
export function micIsHeld(): boolean {
  return micState !== 'closed'
}

export function currentMicGen(): number {
  return micGen
}

/** 持ち帰った世代がまだ最新か (= その後に別の取得/解放要求が積まれていないか)。 */
export function micGenIsCurrent(gen: number): boolean {
  return gen === micGen
}

/** 決着していないホスト操作の本数 (診断用)。 */
export function micPendingHostOps(): number {
  return pendingHostOps
}

/** マイク周りの健康状態を 1 行にまとめる (診断ダンプ用)。 */
export function micHealth(): string {
  const cool = Math.max(0, hostColdUntil - Date.now())
  return (
    `mic health: state=${micState} gen=${micGen} queued=${queued}` +
    ` hostPending=${pendingHostOps} calls=${hostCalls} timeouts=${hostTimeouts}` +
    ` consecTimeouts=${consecutiveTimeouts} coolOff=${cool}ms`
  )
}

/** 直列キューの末尾に積む。前の仕事が失敗しても後続は必ず動かす。 */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  queued++
  const wrapped = async (): Promise<T> => {
    queued--
    return job()
  }
  const run = queue.then(wrapped, wrapped)
  queue = run.then(() => undefined, () => undefined)
  return run
}

/**
 * audioControl を 1 回だけ叩く。時間切れは例外にする。
 * SDK の戻り値が boolean でない実装に備え、false と明示された時だけ失敗扱いにする
 * (従来の startRecording の判定と同じ)。
 *
 * 時間切れになった呼び出しは「決着していないホスト操作」として数え続ける。
 * 後から遅れて返ってきたらそこで減る (ホストが息を吹き返したことが分かる)。
 */
async function callAudioControl(isOpen: boolean): Promise<boolean> {
  const b = getBridge()
  if (!b) throw new Error('G2 bridge not available')
  const cool = hostColdUntil - Date.now()
  if (cool > 0) throw new Error(`host unresponsive (cool-off ${cool}ms)`)

  hostCalls++
  pendingHostOps++
  let settled = false
  const settle = (): void => {
    if (settled) return
    settled = true
    pendingHostOps--
  }
  // audioControl が同期例外を投げる実装でも Promise の拒否として扱えるようにする。
  const raw = (async () => {
    try {
      return await b.audioControl(isOpen)
    } finally {
      settle()
    }
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const r = await Promise.race([
      raw,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`audioControl(${isOpen}) timed out after ${MIC_CONTROL_TIMEOUT_MS}ms`)),
          MIC_CONTROL_TIMEOUT_MS,
        )
      }),
    ])
    consecutiveTimeouts = 0
    return r !== false
  } catch (err) {
    if (!settled) {
      // 時間切れ (ホストはまだ返していない)。無応答ラッチを進める。
      hostTimeouts++
      consecutiveTimeouts++
      if (consecutiveTimeouts >= MIC_UNRESPONSIVE_LIMIT && Date.now() >= hostColdUntil) {
        hostColdUntil = Date.now() + MIC_COOLOFF_MS
        log(`mic: host が ${consecutiveTimeouts} 回連続で応答しません — ${MIC_COOLOFF_MS}ms は叩きません`)
      }
    }
    throw err
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * マイクを取得する。
 * 失敗時は補償の解放を *出してから* 返す (決着は待たない)。呼び出し側は畳むだけでよい。
 *
 * @returns ok=取得できたか / gen=この要求の世代 (await 後の追い越し確認に使う)
 */
export function openMic(): Promise<MicOpenResult> {
  const gen = ++micGen
  // 取得を積んだ後の解放は、取得より前に積まれた解放へ畳んではいけない
  // (解放が取得の前に流れてしまい、取得したマイクが解放されないまま残る)。
  coalescedClose = null
  if (queued >= MIC_QUEUE_MAX) {
    log(`mic: 待ち行列が詰まっている (${queued}) ので取得要求を捨てます`)
    micState = 'stalled'
    return Promise.resolve({ ok: false, gen, reason: 'busy' })
  }
  return enqueue(async () => {
    // 追い越された取得要求 (後から解放/再取得が積まれている) はホストへ出さない。
    if (gen !== micGen) {
      log('mic: この取得要求は後続に追い越されたのでホストへ出しません')
      return { ok: false, gen, reason: 'stale' }
    }
    // 詰まったホストに要求を積み増さない。決着していない操作が残っている間は即失敗。
    if (pendingHostOps > 0) {
      log(`mic: 決着していないホスト操作が ${pendingHostOps} 件あるので取得を見送ります (stalled)`)
      micState = 'stalled'
      return { ok: false, gen, reason: 'stalled' }
    }
    if (Date.now() < hostColdUntil) {
      log('mic: host 無応答の冷却中なので取得を見送ります (stalled)')
      micState = 'stalled'
      return { ok: false, gen, reason: 'stalled' }
    }

    micState = 'opening'
    try {
      if (await callAudioControl(true)) {
        micState = 'open'
        return { ok: true, gen, reason: 'ok' }
      }
      log('mic: audioControl(true) が false を返しました — 補償の解放を出します')
    } catch (err) {
      log(`mic: audioControl(true) 失敗 (${err}) — 補償の解放を出します`)
    }
    // 実機は「マイクを開いた後に失敗を返す」ことがある。取り残しをここで必ず解く。
    // ただし決着は待たない: 待つとホスト無応答がそのまま画面の固まりになる。
    micState = 'closing'
    void callAudioControl(false).then(
      (ok) => {
        micState = ok ? 'closed' : 'stalled'
        if (!ok) log('mic: 補償の解放が false — 解放できたか不明なままにします (stalled)')
      },
      (err) => {
        micState = 'stalled'
        log(`mic: 補償の解放に失敗 (${err}) — 解放できたか不明なままにします (stalled)`)
      },
    )
    // 補償の決着を待たずに返す。ここでは「解けたと決めつけない」= stalled のまま。
    micState = 'stalled'
    return { ok: false, gen, reason: 'failed' }
  })
}

/**
 * マイクを解放する。
 *
 * @param reason ログ用。どの経路から解放したか
 * @param opts.force 内部状態が closed でも実機へ解放を出す (起動時リセット用)
 * @param opts.retryOnFalse false が返った時に 1 回だけ出し直すか (既定: する)
 * @returns 解放できたか。失敗しても例外にはしない (呼び出し側の畳み込みを止めない)
 */
export function closeMic(
  reason: string,
  opts: { force?: boolean; retryOnFalse?: boolean } = {},
): Promise<boolean> {
  const force = opts.force ?? false
  const attempts = (opts.retryOnFalse ?? true) ? 2 : 1

  // まだ走り出していない解放が積んであるなら、そこへ畳む (同じ解放を重ねて出さない)。
  if (coalescedClose && !force) {
    coalescedClose.reasons.push(reason)
    return coalescedClose.promise
  }

  micGen++
  const reasons = [reason]
  const promise = enqueue(async () => {
    if (coalescedClose && coalescedClose.reasons === reasons) coalescedClose = null
    const label = reasons.join('+')
    // 早期 return は「閉じていて、かつホストに未決着が無い」時だけ。
    // 未決着が残っている間は closed を信用しない (握られたままかもしれない)。
    if (micState === 'closed' && pendingHostOps === 0 && !force) return true
    if (!getBridge()) {
      micState = 'closed'
      return true
    }
    micState = 'closing'
    for (let i = 1; i <= attempts; i++) {
      try {
        if (await callAudioControl(false)) {
          micState = 'closed'
          return true
        }
        log(`mic: audioControl(false) が false (${label}, ${i}/${attempts})`)
      } catch (err) {
        log(`mic: audioControl(false) 失敗 (${label}, ${i}/${attempts}): ${err}`)
        // 冷却に入った/入っている間は出し直しても無駄なので、ここで打ち切る。
        if (Date.now() < hostColdUntil) break
      }
    }
    // 解放しきれなかった。closed に偽装すると「もう握っていない」と誤認され、
    // 後片付けの経路が二度と拾わなくなる。決着不明として stalled のまま残す。
    log(`mic: 解放できませんでした (${label}) — 状態は stalled のままにします`)
    micState = 'stalled'
    return false
  })
  if (!force) coalescedClose = { promise, reasons }
  return promise
}

/**
 * 起動時に 1 回だけ解放を出す。
 * 前回セッションが握ったまま終わっていた場合、アプリを再起動しても実機側は
 * 開きっぱなしのことがある。ここで無条件に 1 回解いておく (失敗は無視)。
 */
export async function resetMicAtBoot(): Promise<void> {
  log('mic: 起動時リセット — audioControl(false) を 1 回出します')
  await closeMic('boot-reset', { force: true, retryOnFalse: false })
}
