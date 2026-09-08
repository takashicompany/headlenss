// G2 SDK 経由の audioEvent.audioPcm (16kHz / S16LE / mono) を受け取る側の集計。
// リアルタイム接続では Speechmatics へ直接 PCM チャンクを流し続けるので、
// 過去フレームをまとめてバッファする必要は無い。
//
// 録音時間は「壁時計 (計測開始時刻からの経過)」で数える。受信 PCM のバイト数から
// 割り出すと、ホストがマイクを開けずに PCM が 1 バイトも来なかった時に、実際には
// 録音画面に居るのに 0.0s のまま止まって見える。バイト数は「音が来ていたか」の
// 判定 (getPcmByteLength() === 0) にだけ使う。
//
// 計測の起点は「録音ボタンを押した時」ではなく「発話を受け付け始めた時」。
// ASR 接続と G2 マイク取得が終わるまでレンズは「接続中…」を出していて、ユーザは
// まだ喋ってはいけない。その間の秒数まで数えると、実際に喋った長さと表示が食い違う。
// 起点を打つまで getRecordingSeconds() は 0 を返す (= 接続中は 0.0s のまま)。

const SAMPLE_RATE = 16000
const BITS_PER_SAMPLE = 16
const CHANNELS = 1

let totalBytes = 0
/** 録音開始時刻 (ms)。0 なら録音していない。 */
let startedAtMs = 0
/** 録音停止時刻 (ms)。0 なら計測中。停止後は経過秒をここで止める。 */
let stoppedAtMs = 0

export function trackPcmFrame(pcm: Uint8Array): void {
  totalBytes += pcm.byteLength
}

/** 録音の計測を最初から始める (バイト数も経過時間もリセット)。 */
export function resetPcmCounter(): void {
  totalBytes = 0
  startedAtMs = 0
  stoppedAtMs = 0
}

/**
 * 録音時間の計測を開始する。呼ぶのは「発話の受け付けが始まった時点」
 * (レンズが「接続中…」から「録音中」に変わる時) であって、録音ボタンを
 * 押した時ではない。呼ばれるまで getRecordingSeconds() は 0 を返す。
 */
export function startRecordingClock(): void {
  startedAtMs = Date.now()
  stoppedAtMs = 0
}

/**
 * 録音停止。以降 getRecordingSeconds() は停止時点の値を返し続ける。
 * 計測開始前 (接続中に停止した場合) は何もしない = 0.0s のままになる。
 */
export function stopRecordingClock(): void {
  if (startedAtMs !== 0 && stoppedAtMs === 0) stoppedAtMs = Date.now()
}

/** 発話受付開始からの経過秒 (停止後は停止時点で固定。開始前は 0)。 */
export function getRecordingSeconds(): number {
  if (startedAtMs === 0) return 0
  const end = stoppedAtMs !== 0 ? stoppedAtMs : Date.now()
  return Math.max(0, (end - startedAtMs) / 1000)
}

/** 受信した PCM の総バイト数。「音が来ていたか」の判定にだけ使う。 */
export function getPcmByteLength(): number {
  return totalBytes
}

export const AUDIO_FORMAT = {
  sampleRate: SAMPLE_RATE,
  bitsPerSample: BITS_PER_SAMPLE,
  channels: CHANNELS,
}
