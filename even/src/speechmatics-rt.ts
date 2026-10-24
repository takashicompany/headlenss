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
const JWT_TTL_SEC = 60
const STOP_TIMEOUT_MS = 8000
/** JWT 発行の締切。ここを過ぎたら接続そのものを諦める。 */
const JWT_TIMEOUT_MS = 8000
/** WebSocket が開いて RecognitionStarted が返るまでの締切。 */
const HANDSHAKE_TIMEOUT_MS = 8000

export type RTRegion = 'eu' | 'us'

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
  onDead?: (reason: string) => void
}

type ServerMessage =
  | { message: 'RecognitionStarted'; id?: string }
  | { message: 'AudioAdded'; seq_no: number }
  | { message: 'AddPartialTranscript'; metadata: { transcript: string } }
  | { message: 'AddTranscript'; metadata: { transcript: string } }
  | { message: 'EndOfTranscript' }
  | { message: 'Info'; type?: string; reason?: string }
  | { message: 'Warning'; type?: string; reason?: string }
  | { message: 'Error'; type?: string; reason?: string }

async function fetchJwt(apiKey: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(JWT_ENDPOINT, {
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
  private endWaiter: { resolve: (text: string) => void; reject: (err: Error) => void } | null = null
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
    const url = `wss://${region}.rt.speechmatics.com/v2?jwt=${encodeURIComponent(jwt)}`

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
        const waiter = this.endWaiter
        if (waiter) {
          // stop() の待ち中に閉じた: 手元にある分を確定として返す。
          this.endWaiter = null
          this.clearStopTimer()
          const text = this.fullTranscript()
          this.teardown()
          waiter.resolve(text)
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
    if (this.aborted || this.stopping) { this.teardown(); return }
    const onDead = this.opts?.onDead
    this.teardown()
    onDead?.(reason)
  }

  private handleServerMessage(msg: ServerMessage, onStarted: () => void): void {
    switch (msg.message) {
      case 'RecognitionStarted':
        onStarted()
        break
      case 'AddPartialTranscript':
        this.currentPartial = msg.metadata?.transcript ?? ''
        this.opts?.onPartial?.(this.fullTranscript())
        break
      case 'AddTranscript': {
        const text = msg.metadata?.transcript ?? ''
        if (text) this.finals.push(text)
        this.currentPartial = ''
        this.opts?.onFinal?.(this.finals.join(''))
        break
      }
      case 'EndOfTranscript': {
        const waiter = this.endWaiter
        this.endWaiter = null
        this.clearStopTimer()
        const text = this.finals.join('')
        this.teardown()
        waiter?.resolve(text)
        break
      }
      case 'Error': {
        const reason = `${msg.type ?? ''}${msg.reason ? `: ${msg.reason}` : ''}`
        const err = new Error(`Speechmatics RT Error ${reason}`)
        this.opts?.onError?.(err)
        const waiter = this.endWaiter
        this.endWaiter = null
        this.clearStopTimer()
        if (waiter) {
          this.teardown()
          waiter.reject(err)
        } else {
          this.die(`Speechmatics RT Error ${reason}`)
        }
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
  async stop(): Promise<string> {
    this.stopping = true
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // 既に閉じている/開けなかった。手元の確定分を返しつつ取り残しを掃除する。
      const text = this.finals.join('')
      this.teardown()
      return text
    }
    return new Promise<string>((resolve, reject) => {
      const settle = (fn: () => void): void => {
        this.clearStopTimer()
        this.endWaiter = null
        fn()
      }
      this.endWaiter = {
        resolve: (text) => settle(() => resolve(text.trim())),
        reject: (err) => settle(() => reject(err)),
      }
      // 保険のタイマーは送信より先に張る。送信が同期 throw しても、
      // 例外経路で必ず clear されるので取り残しにはならない。
      this.stopTimer = setTimeout(() => {
        this.stopTimer = null
        const waiter = this.endWaiter
        this.endWaiter = null
        const text = this.fullTranscript()
        this.teardown()
        waiter?.resolve(text)
      }, STOP_TIMEOUT_MS)
      try {
        this.ws!.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: this.seqNo }))
      } catch (err) {
        const waiter = this.endWaiter
        this.endWaiter = null
        this.clearStopTimer()
        this.teardown()
        if (waiter) waiter.reject(err as Error)
        else reject(err as Error)
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
