// Speechmatics Realtime WebSocket クライアント (ブラウザ直接接続)。
//
// 流れ:
//   1. POST https://mp.speechmatics.com/v1/api_keys?type=rt   (一時JWT発行)
//   2. wss://<region>.rt.speechmatics.com/v2?jwt=<...>        (接続)
//   3. StartRecognition JSON 送信
//   4. RecognitionStarted を受信したら start() resolve
//   5. AddAudio バイナリフレームを連投 (PCM s16le 16kHz mono、100ms チャンク推奨)
//   6. EndOfStream { last_seq_no } 送信 → EndOfTranscript 受信で確定テキストが揃う
//
// AddPartialTranscript : 中間結果 (上書きされうる、レンズの即時表示に使う)
// AddTranscript        : 確定テキスト (積み増し、最終的にこれを連結したものが結果)
//
// 決着の保証について:
//   このクライアントは「待ち続ける経路」を持たない。JWT 発行・WS ハンドシェイク・
//   EndOfTranscript 待ちのすべてに締切があり、どの経路から抜けても teardown() を
//   通ってソケットとコールバックが切り離される。切り離しは opts ごと捨てるので、
//   捨てたはずの接続が遅れて喋っても現在の録音表示を上書きすることはない。

import type { OperatingPoint } from './settings'

const JWT_ENDPOINT = 'https://mp.speechmatics.com/v1/api_keys?type=rt'

/**
 * E2E 検証用の接続先差し替え (dev server 限定)。
 *
 * 録音まわりの検証 (「接続中…」の間はタイマーを進めない、等) を自動化するには
 * Speechmatics の応答タイミングを外から操れる必要がある。本物のサービスに繋いで
 * 検証すると再現性が無く課金も走るので、dev 実行時だけスタブへ向けられるようにする。
 *
 * 本番ビルドでは import.meta.env.DEV が false に畳まれ、この関数の中身ごと
 * dead code elimination で消える (dist に接続先の分岐は 1 行も残らない)。
 */
type AsrEndpointOverride = { jwt?: string; wsBase?: string }
function asrOverride(): AsrEndpointOverride | null {
  if (!import.meta.env.DEV) return null
  return (window as unknown as { __headlenssAsrOverride?: AsrEndpointOverride })
    .__headlenssAsrOverride ?? null
}
const JWT_TTL_SEC = 60
const STOP_TIMEOUT_MS = 8000
/** JWT 発行の締切。ここを過ぎたら接続そのものを諦める。 */
const JWT_TIMEOUT_MS = 8000
/** WebSocket が開いて RecognitionStarted が返るまでの締切。 */
const HANDSHAKE_TIMEOUT_MS = 8000

export type RTRegion = 'eu' | 'us'

export type AsrOutcome =
  | { kind: 'final'; text: string }
  | { kind: 'recovered-partial'; text: string; reason: string }
  | { kind: 'failure'; text: ''; reason: string }

/** 異常終了でも受信済みの語句は残す。確定結果としては扱わない。 */
export function recoverAsrText(text: string, reason: string): AsrOutcome {
  const words = text.trim()
  return words ? { kind: 'recovered-partial', text: words, reason } : { kind: 'failure', text: '', reason }
}

export type SpeechmaticsRTOptions = {
  apiKey: string
  language: string
  operatingPoint: OperatingPoint
  region?: RTRegion
  maxDelay?: number     // 確定までの最大待機時間 (秒)、0.7〜4.0
  enablePartials?: boolean
  onPartial?: (text: string) => void  // 中間文字起こし (現在のpartial含む全文)
  onFinal?: (text: string) => void    // 確定文字起こし (確定分のみの全文)
  onError?: (err: Error) => void
  /**
   * 接続が録音中に死んだ (異常切断 / サーバ Error / 送信不能)。
   * stop()/abort() で畳んだ場合は呼ばれない。呼び出し側はこれを受けて
   * 録音 phase を畳む (受け取らないと「録音中」表示のまま無音を撮り続ける)。
   */
  onDead?: (outcome: AsrOutcome) => void
  /**
   * 話者分離 (diarization: 'speaker')。Fieldglass の連続セッション用。
   * 有効にすると結果の各語に S1/S2… の話者ラベルが付き、onSegment に載る。
   */
  diarization?: boolean
  /**
   * 発話の終わり (EndOfUtterance) を受け取る無音秒数。0 / 未指定なら要求しない。
   * Speechmatics の conversation_config.end_of_utterance_silence_trigger (0〜2 秒)。
   */
  endOfUtteranceSilence?: number
  /**
   * 語単位の時刻・話者付きの区切り (Fieldglass の cue engine 入力)。
   * 確定 (AddTranscript) は話者が変わるたびに 1 区切り、partial は全体で 1 区切り。
   * EndOfUtterance は text='' / endOfUtterance=true の区切りとして届く。
   */
  onSegment?: (seg: AsrSegment) => void
  /**
   * 確定文を全文として手元に溜め続けるか (既定 true = 従来の音声入力)。
   * 連続セッションでは false: 溜めない (メモリも本文も残さない)。
   * false のとき onFinal は直近 1 件の確定文だけを渡す。
   */
  retainTranscript?: boolean
}

/** 時刻・話者付きの文字起こし区切り。cue-engine の Segment と同じ形。 */
export type AsrSegment = {
  text: string
  isFinal: boolean
  /** ASR の話者ラベル (S1, S2…)。不明 (UU) や話者分離なしは undefined。 */
  speaker?: string
  /** この接続の音声開始からの ms (再接続時のずらしは呼び出し側で足す) */
  startMs: number
  endMs: number
  endOfUtterance?: boolean
}

type RtResult = {
  type?: 'word' | 'punctuation' | string
  start_time?: number
  end_time?: number
  is_eos?: boolean
  attaches_to?: 'previous' | 'next' | 'both' | 'none' | string
  alternatives?: Array<{ content?: string; speaker?: string; confidence?: number }>
}

/** スペースで語を区切らない言語 (Speechmatics の語は空白無しで連結する)。 */
const NO_SPACE_LANGS = new Set(['ja', 'cmn', 'yue', 'zh', 'th'])

function speakerOf(r: RtResult): string | undefined {
  const sp = r.alternatives?.[0]?.speaker
  return sp && sp !== 'UU' ? sp : undefined
}

/**
 * 結果配列を話者が連続する区間ごとの区切りにする (純関数・テスト用に export)。
 * 句読点は直前の語の話者に付ける (句読点には話者が付かないことがあるため)。
 */
export function segmentsFromResults(results: RtResult[], isFinal: boolean, language: string): AsrSegment[] {
  const spaced = !NO_SPACE_LANGS.has(language)
  const out: AsrSegment[] = []
  type Building = AsrSegment & { parts: string[] }
  let cur = null as Building | null
  for (const r of results) {
    const content = r.alternatives?.[0]?.content ?? ''
    if (!content) continue
    const punct = r.type === 'punctuation'
    const sp: string | undefined = punct ? (cur ? cur.speaker : undefined) : speakerOf(r)
    const startMs = Math.round((r.start_time ?? 0) * 1000)
    const endMs = Math.round((r.end_time ?? r.start_time ?? 0) * 1000)
    if (!cur || (!punct && sp !== cur.speaker)) {
      if (cur) out.push(finishSeg(cur, spaced))
      cur = { text: '', parts: [], isFinal, speaker: sp, startMs, endMs }
    }
    if (punct && cur.parts.length > 0 && r.attaches_to !== 'next') cur.parts[cur.parts.length - 1] += content
    else cur.parts.push(content)
    cur.endMs = Math.max(cur.endMs, endMs)
    if (r.is_eos) cur.endOfUtterance = true
  }
  if (cur) out.push(finishSeg(cur, spaced))
  return out
}

function finishSeg(seg: AsrSegment & { parts: string[] }, spaced: boolean): AsrSegment {
  const { parts, ...rest } = seg
  const out: AsrSegment = { ...rest, text: parts.join(spaced ? ' ' : '').trim() }
  if (out.speaker === undefined) delete out.speaker
  if (!out.endOfUtterance) delete out.endOfUtterance
  return out
}

type ServerMessage =
  | { message: 'RecognitionStarted'; id?: string }
  | { message: 'AudioAdded'; seq_no: number }
  | { message: 'AddPartialTranscript'; metadata: { transcript: string; start_time?: number; end_time?: number }; results?: RtResult[] }
  | { message: 'AddTranscript'; metadata: { transcript: string; start_time?: number; end_time?: number }; results?: RtResult[] }
  | { message: 'EndOfUtterance'; metadata?: { start_time?: number; end_time?: number }; start_time?: number; end_time?: number }
  | { message: 'EndOfTranscript' }
  | { message: 'Info'; type?: string; reason?: string }
  | { message: 'Warning'; type?: string; reason?: string }
  | { message: 'Error'; type?: string; reason?: string }

async function fetchJwt(apiKey: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(asrOverride()?.jwt ?? JWT_ENDPOINT, {
    signal,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl: JWT_TTL_SEC }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`JWT fetch HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = (await res.json()) as { key_value?: string }
  if (!data.key_value) throw new Error('JWT response missing key_value')
  return data.key_value
}

export class SpeechmaticsRT {
  private ws: WebSocket | null = null
  private seqNo = 0
  private finals: string[] = []
  private currentPartial = ''
  private endWaiter: { resolve: (outcome: AsrOutcome) => void; reject: (err: Error) => void } | null = null
  private failureReason = 'connection closed'
  private opts: SpeechmaticsRTOptions | null = null
  private startedAt = 0
  /** abort() 済み。以後 WebSocket を作らない (JWT 待ちの間に捨てられた場合の保険)。 */
  private aborted = false
  /** stop() 進行中。正常な畳み込みなので onDead は鳴らさない。 */
  private stopping = false
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private jwtTimer: ReturnType<typeof setTimeout> | null = null
  private ac: AbortController | null = null

  async start(opts: SpeechmaticsRTOptions): Promise<void> {
    if (!opts.apiKey) throw new Error('Speechmatics API key is empty')
    this.opts = opts
    this.startedAt = performance.now()
    this.aborted = false
    this.stopping = false

    // JWT 発行に締切を張る。ここが返らないと start() が永久に決着せず、
    // 呼び出し側は phase='recording' のまま何も起きない画面に閉じ込められる。
    const ac = new AbortController()
    this.ac = ac
    let jwt: string
    try {
      // signal だけでは足りない: 古い WebView の fetch は abort を無視することがある。
      // 締切そのものを race で持ち、どちらに転んでも 8 秒で決着させる。
      jwt = await new Promise<string>((res, rej) => {
        this.jwtTimer = setTimeout(() => {
          this.jwtTimer = null
          try { ac.abort() } catch { /* ignore */ }
          rej(new Error(`JWT fetch timed out after ${JWT_TIMEOUT_MS}ms`))
        }, JWT_TIMEOUT_MS)
        fetchJwt(opts.apiKey, ac.signal).then(res, rej)
      })
    } catch (err) {
      this.clearJwtTimer()
      const dead = this.aborted ? 'aborted before JWT' : `JWT fetch failed: ${(err as Error).message}`
      this.teardown()
      throw new Error(dead)
    }
    this.clearJwtTimer()
    if (this.aborted) {
      this.teardown()
      throw new Error('aborted before WebSocket open')
    }
    const region: RTRegion = opts.region ?? 'eu'
    const wsBase = asrOverride()?.wsBase ?? `wss://${region}.rt.speechmatics.com/v2`
    const url = `${wsBase}?jwt=${encodeURIComponent(jwt)}`

    return new Promise<void>((resolve, reject) => {
      if (this.aborted) {
        this.teardown()
        reject(new Error('aborted before WebSocket open'))
        return
      }
      let opened = false
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      // ハンドシェイクにも締切。onopen も onclose も来ないまま黙る実装があるため。
      const handshakeTimer = setTimeout(
        () => failOpen(`handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`),
        HANDSHAKE_TIMEOUT_MS,
      )

      const failOpen = (msg: string): void => {
        if (opened) return
        opened = true
        clearTimeout(handshakeTimer)
        // ソケットもハンドラも完全に切り離してから返す (取り残しを作らない)。
        this.teardown()
        reject(new Error(msg))
      }

      ws.onopen = () => {
        const config = {
          message: 'StartRecognition',
          audio_format: {
            type: 'raw',
            encoding: 'pcm_s16le',
            sample_rate: 16000,
          },
          transcription_config: {
            language: opts.language,
            operating_point: opts.operatingPoint,
            max_delay: opts.maxDelay ?? 1.0,
            max_delay_mode: 'flexible',
            enable_partials: opts.enablePartials ?? true,
            // 話者分離は Fieldglass の連続セッションだけ。従来の音声入力の設定は 1 バイトも変えない。
            ...(opts.diarization ? { diarization: 'speaker' } : {}),
            // conversation_config は transcription_config の中 (StartRecognition の直下ではない)。
            // https://docs.speechmatics.com/speech-to-text/realtime/turn-detection
            // 0〜2 秒、max_delay より小さく保つこと (同ページ)。
            ...(opts.endOfUtteranceSilence
              ? { conversation_config: { end_of_utterance_silence_trigger: opts.endOfUtteranceSilence } }
              : {}),
          },
        }
        try {
          ws.send(JSON.stringify(config))
        } catch (err) {
          failOpen(`StartRecognition send error: ${(err as Error).message}`)
        }
      }

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return
        let msg: ServerMessage
        try {
          msg = JSON.parse(ev.data) as ServerMessage
        } catch {
          return
        }
        if (!opened && msg.message === 'Error') {
          failOpen(`Speechmatics RT Error ${msg.type ?? ''}: ${msg.reason ?? ''}`)
          return
        }
        this.handleServerMessage(msg, () => {
          if (!opened) {
            opened = true
            clearTimeout(handshakeTimer)
            resolve()
          }
        })
      }

      ws.onerror = () => {
        if (!opened) {
          failOpen('WebSocket error')
          return
        }
        // 開いた後の異常。録音は続けられないので畳んで呼び出し側へ知らせる。
        this.die('WebSocket error')
      }

      ws.onclose = (e) => {
        if (!opened) {
          failOpen(`WebSocket closed before start (${e.code} ${e.reason || ''})`)
          return
        }
        // 録音中に切れた。取り残しを作らず、呼び出し側に畳ませる。
        this.die(`WebSocket closed (${e.code} ${e.reason || ''})`)
      }
    })
  }

  /**
   * 録音中に接続が死んだときの共通処理。
   * teardown() が opts を捨てるので、コールバックは先に手元へ取っておく。
   */
  private die(reason: string): void {
    if (this.aborted) { this.teardown(); return }
    this.failureReason = reason
    const outcome = recoverAsrText(this.fullTranscript(), reason)
    const waiter = this.endWaiter
    const onDead = this.opts?.onDead
    this.teardown()
    if (waiter) waiter.resolve(outcome)
    else if (!this.stopping) onDead?.(outcome)
  }

  private handleServerMessage(msg: ServerMessage, onStarted: () => void): void {
    switch (msg.message) {
      case 'RecognitionStarted':
        onStarted()
        break
      case 'AddPartialTranscript':
        this.currentPartial = msg.metadata?.transcript ?? ''
        this.opts?.onPartial?.(this.fullTranscript())
        this.emitSegments(msg.results, false)
        break
      case 'AddTranscript': {
        const text = msg.metadata?.transcript ?? ''
        const retain = this.opts?.retainTranscript !== false
        if (text && retain) this.finals.push(text)
        this.currentPartial = ''
        this.opts?.onFinal?.(retain ? this.finals.join('') : text)
        this.emitSegments(msg.results, true)
        break
      }
      case 'EndOfUtterance': {
        // 時刻は metadata 内 (docs の並びでは直下にも見えるので両方読む)。話者は付かない。
        const endMs = Math.round((msg.metadata?.end_time ?? msg.end_time ?? 0) * 1000)
        this.opts?.onSegment?.({ text: '', isFinal: true, startMs: endMs, endMs, endOfUtterance: true })
        break
      }
      case 'EndOfTranscript': {
        const waiter = this.endWaiter
        this.endWaiter = null
        this.clearStopTimer()
        const text = this.finals.join('')
        this.teardown()
        waiter?.resolve(text.trim() ? { kind: 'final', text: text.trim() } : { kind: 'failure', text: '', reason: 'no-speech' })
        break
      }
      case 'Error': {
        const reason = `${msg.type ?? ''}${msg.reason ? `: ${msg.reason}` : ''}`
        const err = new Error(`Speechmatics RT Error ${reason}`)
        this.opts?.onError?.(err)
        this.die(err.message)
        break
      }
      case 'Warning':
      case 'Info':
        // 必要なら opts.onError 等にフックするが、現状は黙って捨てる
        break
      default:
        break
    }
  }

  private emitSegments(results: RtResult[] | undefined, isFinal: boolean): void {
    const opts = this.opts
    if (!opts?.onSegment || !results?.length) return
    for (const seg of segmentsFromResults(results, isFinal, opts.language)) {
      // 呼び出し側の例外で受信ループを壊さない (次のメッセージも処理させる)
      try { opts.onSegment(seg) } catch (err) { opts.onError?.(err as Error) }
    }
  }

  /** PCM (s16le 16kHz mono) のバイナリチャンクを送る。100ms 単位推奨 */
  send(pcm: Uint8Array): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      // ArrayBufferを別領域にコピーしてSAB混入を避ける
      const out = new ArrayBuffer(pcm.byteLength)
      new Uint8Array(out).set(pcm)
      ws.send(out)
      this.seqNo += 1
    } catch (err) {
      // 送信が同期 throw する = 経路が死んでいる。例外を上へ投げると
      // 音声イベントハンドラごと巻き添えになるので、ここで畳んで知らせる。
      this.die(`audio send failed: ${(err as Error).message}`)
    }
  }

  /** EndOfStream を送り、EndOfTranscript を待って確定テキストを返す */
  async stop(): Promise<AsrOutcome> {
    this.stopping = true
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // 既に閉じている/開けなかった。手元の確定分を返しつつ取り残しを掃除する。
      const outcome = recoverAsrText(this.fullTranscript(), this.failureReason)
      this.teardown()
      return outcome
    }
    return new Promise<AsrOutcome>((resolve, reject) => {
      const settle = (fn: () => void): void => {
        this.clearStopTimer()
        this.endWaiter = null
        fn()
      }
      this.endWaiter = {
        resolve: (outcome) => settle(() => resolve(outcome)),
        reject: (err) => settle(() => reject(err)),
      }
      // 保険のタイマーは送信より先に張る。送信が同期 throw しても、
      // 例外経路で必ず clear されるので取り残しにはならない。
      this.stopTimer = setTimeout(() => {
        this.stopTimer = null
        const waiter = this.endWaiter
        this.endWaiter = null
        const outcome = recoverAsrText(this.fullTranscript(), 'stop-timeout')
        this.teardown()
        waiter?.resolve(outcome)
      }, STOP_TIMEOUT_MS)
      try {
        this.ws!.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: this.seqNo }))
      } catch (err) {
        this.die(`EndOfStream send failed: ${(err as Error).message}`)
      }
    })
  }

  private clearStopTimer(): void {
    if (this.stopTimer !== null) { clearTimeout(this.stopTimer); this.stopTimer = null }
  }

  private clearJwtTimer(): void {
    if (this.jwtTimer !== null) { clearTimeout(this.jwtTimer); this.jwtTimer = null }
  }

  /**
   * ソケット・タイマー・コールバックを完全に切り離す (何度呼んでも安全)。
   * opts まで捨てるのが要点: 捨てたはずの接続が遅れて喋っても、
   * onPartial/onFinal が無いので現在の録音表示を汚さない (ゾンビの根絶)。
   */
  private teardown(): void {
    this.clearStopTimer()
    this.clearJwtTimer()
    try { this.ac?.abort() } catch { /* ignore */ }
    this.ac = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null
      try { ws.close() } catch { /* ignore */ }
    }
    this.endWaiter = null
    this.opts = null
  }

  /** 強制切断 (エラー時など) */
  abort(): void {
    this.aborted = true
    const waiter = this.endWaiter
    this.endWaiter = null
    this.teardown()
    waiter?.reject(new Error('aborted'))
  }

  /** 現在の (partial 含む) 全文 */
  fullTranscript(): string {
    return (this.finals.join('') + this.currentPartial).trim()
  }

  elapsedMs(): number {
    return performance.now() - this.startedAt
  }
}
