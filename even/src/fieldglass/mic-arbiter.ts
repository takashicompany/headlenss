// G2 マイクの持ち主を 1 か所で決める (通常の HeadLenss 録音と Fieldglass で共有)。
//
// なぜ要るか:
//   mic.ts の世代管理は JS 側の状態しか守らない。ホストに出した audioControl(true) は取り消せないので、
//   止めた後に「遅れて開く」ことがある。その後始末 (閉じ直し) を各自がやると、
//   別の持ち主が今使っているマイクまで閉じてしまう (Fieldglass の後始末が通常録音を止めた、等)。
//
// 規則:
//   - 取得 (acquire) ごとに札 (token) を出す。持ち主は常に高々 1 人 (最後に取得した札)。
//   - 閉じる (release) のは今の持ち主の札だけ。古い札での release は何もしない (他人のマイクを閉じない)。
//   - 取得が遅れて決着した時、その札がもう持ち主でなければ:
//       ・誰もマイクを欲しがっていない → 閉じ直す (止めたのに開いたまま、を残さない)
//       ・別の誰かが今持っている → 触らない (その持ち主の取得・解放に任せる)
//   - closeAll はページ破棄など、持ち主に関係なく必ず閉じる経路専用。

export type MicOpenResult = { ok: boolean; reason?: string }

export interface MicIo {
  open(): Promise<MicOpenResult>
  close(reason: string, waitMs?: number): Promise<boolean>
}

export type MicTicket = { token: number; owner: string; result: Promise<MicOpenResult> }

export class MicArbiter {
  private current: { token: number; owner: string } | null = null
  private seq = 0

  constructor(private io: MicIo, private log: (msg: string) => void = () => {}) {}

  /** 今の持ち主 ('recording' / 'fieldglass' …)。誰も持っていなければ null。 */
  owner(): string | null { return this.current?.owner ?? null }

  isCurrent(token: number): boolean { return this.current?.token === token }

  /** マイクを取得する。前の持ち主がいれば、その札は以後無効 (release しても閉じない)。 */
  acquire(owner: string): MicTicket {
    const token = ++this.seq
    this.current = { token, owner }
    const result = this.io.open()
    const settled = (): void => {
      if (this.current?.token === token) return  // まだ自分が持ち主: 何もしない
      if (this.current === null) {
        // 止めた後に開いた。誰も使っていないので閉じ直す。
        this.log(`mic: ${owner} acquisition settled after release — closing again`)
        void this.io.close(`stale-after-open:${owner}`)
      }
      // 別の持ち主が今使っている → 閉じない
    }
    result.then(settled, settled)
    return { token, owner, result }
  }

  /** 持ち主として閉じる。持ち主でなければ何もしない (true を返す = 閉じる必要が無い)。 */
  release(token: number | null, reason: string, waitMs?: number): Promise<boolean> {
    if (token === null || this.current?.token !== token) return Promise.resolve(true)
    this.current = null
    return this.io.close(reason, waitMs)
  }

  /** 持ち主に関係なく閉じる (ページ破棄・アプリ終了の保険)。 */
  closeAll(reason: string, waitMs?: number): Promise<boolean> {
    this.current = null
    return this.io.close(reason, waitMs)
  }
}
