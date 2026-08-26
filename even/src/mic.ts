/**
 * G2 マイク (bridge.audioControl) のライフサイクルを 1 か所に集約する。
 *
 * これまで「マイクを閉じる」は録音中 (phase==='recording') の分岐の中でしか
 * 呼ばれておらず、取得に失敗した/取得を待っている間に停止された、という経路では
 * 一切呼ばれなかった。実機は「マイクを開いてから失敗を返す」ことがあるので、
 * その状態でアプリが何もしないとマイクは握られたまま残り、次の録音は
 * 「すでに開いている」として永久に失敗し続ける (アプリを再起動しても解けない)。
 *
 * ここでは次の 3 つを守る:
 *  1. audioControl の呼び出しは必ず 1 本の直列キューを通る。
 *     取得の決着前に解放を積んでも「後から出した解放が先に流れて効かない」ことがない。
 *  2. 取得が失敗 (false / 例外 / 時間切れ) したら、その場で必ず 1 回だけ
 *     補償の解放を出す。実機が開いていた場合の取り残しをここで解く。
 *  3. 解放は戻り値まで見る。false なら 1 回だけ出し直し、それでも駄目なら
 *     内部状態は closed 扱いにして次の取得を妨げない (握られたままより、
 *     次のタップで取得をやり直せる方が復帰の目がある)。
 */

/** 内部から見たマイクの状態。'closed' 以外は「アプリが握っている可能性がある」。 */
export type MicState = 'closed' | 'opening' | 'open' | 'closing'

/**
 * audioControl が返ってこない時に待つのをやめる上限。
 * renderer.ts のブリッジ送信と同じ流儀 (SDK 側は止められないので、
 * あくまで「こちらが待つのをやめる」ための保険)。時間切れは失敗扱いにして
 * 補償の解放へ倒す。
 */
const MIC_CONTROL_TIMEOUT_MS = 5000

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

export function currentMicGen(): number {
  return micGen
}

/** 持ち帰った世代がまだ最新か (= その後に別の取得/解放要求が積まれていないか)。 */
export function micGenIsCurrent(gen: number): boolean {
  return gen === micGen
}

/** 直列キューの末尾に積む。前の仕事が失敗しても後続は必ず動かす。 */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.then(() => undefined, () => undefined)
  return run
}

/**
 * audioControl を 1 回だけ叩く。時間切れは例外にする。
 * SDK の戻り値が boolean でない実装に備え、false と明示された時だけ失敗扱いにする
 * (従来の startRecording の判定と同じ)。
 */
async function callAudioControl(isOpen: boolean): Promise<boolean> {
  const b = getBridge()
  if (!b) throw new Error('G2 bridge not available')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const r = await Promise.race([
      b.audioControl(isOpen),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`audioControl(${isOpen}) timed out after ${MIC_CONTROL_TIMEOUT_MS}ms`)),
          MIC_CONTROL_TIMEOUT_MS,
        )
      }),
    ])
    return r !== false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * マイクを取得する。
 * 失敗時は内部で補償の解放まで済ませてから返すので、呼び出し側は畳むだけでよい。
 *
 * @returns ok=取得できたか / gen=この要求の世代 (await 後の追い越し確認に使う)
 */
export function openMic(): Promise<{ ok: boolean; gen: number }> {
  const gen = ++micGen
  return enqueue(async () => {
    micState = 'opening'
    try {
      if (await callAudioControl(true)) {
        micState = 'open'
        return { ok: true, gen }
      }
      log('mic: audioControl(true) が false を返しました — 補償の解放を出します')
    } catch (err) {
      log(`mic: audioControl(true) 失敗 (${err}) — 補償の解放を出します`)
    }
    // 実機は「マイクを開いた後に失敗を返す」ことがある。取り残しをここで必ず解く。
    micState = 'closing'
    try {
      await callAudioControl(false)
    } catch (err) {
      log(`mic: 補償の解放に失敗 (${err})`)
    }
    micState = 'closed'
    return { ok: false, gen }
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
  micGen++
  return enqueue(async () => {
    if (micState === 'closed' && !force) return true
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
        log(`mic: audioControl(false) が false (${reason}, ${i}/${attempts})`)
      } catch (err) {
        log(`mic: audioControl(false) 失敗 (${reason}, ${i}/${attempts}): ${err}`)
      }
    }
    // 解放しきれなかった。opening/closing のまま残すと次の取得を自分で塞いでしまうので
    // closed 扱いに倒す。次のタップで取得をやり直せる方が復帰の目がある。
    log(`mic: 解放できませんでした (${reason}) — 次の録音を妨げないよう closed 扱いにします`)
    micState = 'closed'
    return false
  })
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
