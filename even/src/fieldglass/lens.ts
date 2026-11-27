// Fieldglass のレンズ側 (G2 の画面と操作)。
//
// HeadLenss の 1 画面 (main.ts の phase='fieldglass') の中で、次の小さな状態機械を回す:
//
//   home ──Tap──> consent ──Tap──> live ──2Tap──> confirmEnd ──Tap──> review ──2Tap──> home
//    │2Tap                │2Tap      │ ↑ 2Tap(続ける)┘                  (保存は Tap)
//    ↓                    ↓          │ foreground exit
//   (セッション一覧へ)    home        └──> suspended ──Tap──> live (再開) / 2Tap → confirmEnd
//   home ──長押し「Follow-ups」──> followups ──2Tap──> home
//
// 守ること (SPEC の red lines):
//   - マイクは consent 画面で Tap した後だけ開く。開いている (開きかけを含む) 間は
//     ヘッダに必ず「● LIVE mm:ss」。閉じたら 2 秒「○ MIC OFF」。他の状態は ● で始めない。
//   - 音声は保存しない。文字起こしは cue engine のメモリにだけあり、終了で reset する。
//     スマホから出ていくのは、review で利用者が Tap して保存した引用だけ。
//   - 話者不明ならエンジンが話者別のキューを出さない (ここでは「今のは自分」を不明時に拒否)。
//
// main.ts への依存は FgDeps に注入する (テストではフェイクを渡す)。

import { t, tf, getLanguage, type StringKey } from '../i18n'
import type {
  FieldglassFollowup,
  FieldglassFollowupInput,
  FieldglassToday,
  FieldglassTodayEvent,
  FieldTestEvent,
} from '../server-client'
import type { AsrOutcome, AsrSegment, SpeechmaticsRTOptions } from '../speechmatics-rt'
import type { OperatingPoint } from '../settings'
import type { Commitment, Cue, CueEngine, CueEngineOptions, EngineEvent, Profile } from './cue-engine'

// ─── 依存 ───────────────────────────────────────────────────────────────

export interface FieldglassApi {
  fieldglassToday(signal?: AbortSignal): Promise<FieldglassToday>
  fieldglassFollowups(): Promise<FieldglassFollowup[]>
  fieldglassSaveFollowup(input: FieldglassFollowupInput): Promise<FieldglassFollowup>
  fieldglassFieldTest(events: FieldTestEvent[]): Promise<void>
}

export interface FgAsr {
  start(opts: SpeechmaticsRTOptions): Promise<void>
  send(pcm: Uint8Array): void
  stop(): Promise<AsrOutcome>
  abort(): void
}

export interface FgStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface FgDeps {
  client(): FieldglassApi | null
  createEngine(opts: CueEngineOptions): CueEngine
  createAsr(): FgAsr
  /** 既存の HeadLenss 設定 (スマホで入力済みの Speechmatics key) を使う。未設定なら null。 */
  asrConfig(): { apiKey: string; language: string; operatingPoint: OperatingPoint } | null
  /** 共有のマイク持ち主 (fieldglass/mic-arbiter.ts)。通常録音と同じ 1 つを使う。 */
  mic: {
    acquire(owner: string): { token: number; result: Promise<{ ok: boolean; reason?: string }> }
    release(token: number | null, reason: string): Promise<unknown>
  }
  /** レンズを描き直す。force=true は間引き無し。描画の完了で resolve する。 */
  redraw(force?: boolean): Promise<void>
  /** フッタに数秒出す一時通知 (main の showG2Notice)。 */
  notice(text: string): void
  /** Fieldglass を出てセッション一覧へ戻る。 */
  exit(): void
  /** レンズ幅で折り返す (main の wrapText)。 */
  wrap(text: string): string[]
  store: FgStore
  log(msg: string): void
  /** 「的外れ」3 回でミュートしたカテゴリを全部戻す (cue-engine の resetCueRatings)。 */
  resetRatings?: () => void
  now?: () => number
}

export type FgScreen = 'home' | 'consent' | 'live' | 'confirmEnd' | 'review' | 'followups' | 'suspended'

type AsrState = 'idle' | 'connecting' | 'ok' | 'reconnecting' | 'failed'

/** 長押しメニューの itemID。main の 1〜8 と衝突しないよう 100 番台。 */
export const FG_MENU = {
  WORK: 101, EVERYDAY: 102, LISTENING: 103, FOLLOWUPS: 104, FIELD_TEST: 105,
  OFF_TARGET: 106, THAT_WAS_ME: 107, PAUSE: 108, END: 109, RESET_MUTED: 110,
} as const

export type FgMenuItem = { itemID: number; itemName: string }

const BODY_LINES = 7
const MIC_OFF_SHOW_MS = 2000
const OLD_CUE_SHOW_MS = 1500
const PAUSE_MS = 15 * 60 * 1000
const ASR_STOP_SETTLE_MS = 1500
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000]
const TODAY_REFRESH_MS = 5 * 60 * 1000
const FIELDTEST_FLUSH_MS = 10_000
/** 発話の終わりとみなす無音 (秒)。短いほど早くキューを出せるが、言いよどみで切れる。 */
const END_OF_UTTERANCE_S = 0.7
/** 確定までの最大待ち (秒)。Speechmatics の下限は 0.7。 */
const ASR_MAX_DELAY_S = 0.8

const PREF_PROFILE = 'fg.profile'
const PREF_FIELDTEST = 'fg.fieldtest'

const CATEGORY_KEY: Partial<Record<string, StringKey>> = {
  owner: 'fgCatOwner', date: 'fgCatDate', decision: 'fgCatDecision', blocker: 'fgCatBlocker', concern: 'fgCatConcern', recall: 'fgCatRecall',
}

const PROFILE_KEY: Record<Profile, StringKey> = {
  work: 'fgProfileWork', everyday: 'fgProfileEveryday', listening: 'fgProfileListening',
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    p.then((v) => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(null) })
  })
}

/** 今の時刻以降に終わる最初の予定 ('HH:MM' はゼロ埋めなので文字列比較でよい)。 */
export function nextEvent(events: FieldglassTodayEvent[], now: Date): FieldglassTodayEvent | null {
  const cur = hhmm(now)
  const upcoming = events.filter((e) => (e.end || e.start) > cur).sort((a, b) => a.start.localeCompare(b.start))
  return upcoming[0] ?? null
}

type ReviewState = {
  items: Commitment[]
  idx: number
  status: Record<string, 'saving' | 'saved' | 'failed'>
  event: FieldglassTodayEvent | null
}

type LiveSession = {
  id: string
  engine: CueEngine
  unsubscribe: () => void
  asr: FgAsr | null
  /** ASR 接続の世代。古い接続のコールバックを捨てるため。 */
  asrEpoch: number
  asrState: AsrState
  reconnectAttempt: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** マイクを開いた (開きかけを含む) か。true の間は必ず ● LIVE を出す。 */
  micOn: boolean
  /** ● LIVE の起点 (壁時計)。 */
  startedAt: number
  /** 最初の音声認識開始の壁時計。音声タイムライン (Segment.endMs) の 0 点。 */
  audioZeroAt: number | null
  /** 今の接続の音声 0 点が、セッションの音声タイムラインのどこに当たるか (ms)。 */
  audioBaseMs: number
  event: FieldglassTodayEvent | null
  /** 直近の (空でない) 発話の話者。不明な発話が来たら undefined に戻す。 */
  lastSpeaker: string | undefined
  /** この接続でマイクの取得を出したか (再接続で開き直さないため / 止めたら false)。 */
  micRequested: boolean
  /** 今のマイク取得の札 (MicArbiter)。閉じるのはこの札でだけ。null = 取得していない。 */
  micToken: number | null
  /** 一度でもマイクが開けたか (初回の失敗だけはセッションごと捨てる)。 */
  micEverOk: boolean
  /** 成功した ASR 接続の数。話者ラベル (S1…) は接続ごとの通し番号なので 2 本目から名前空間を分ける。 */
  connection: number
  /** 「今のは自分」を指定したか (再接続で無効になったことを知らせるため)。 */
  wearerSet: boolean
  /** 終了処理中 (最後の確定文を待っている)。キューは出さず、再接続もしない。 */
  ending: boolean
}

/** 描画が実際に済むまで cue_shown を記録しないための控え (セッション ID は描画前に確定させる)。 */
type PendingShown = {
  sessionId: string; cueId: string; seq: number; category: string; candidateAt: number; lastWordAt?: number
}

/**
 * フレームの身元札。main.ts がフレームを組んだ瞬間に frameTag() で受け取り、
 * そのフレームの送信が SDK で成功した後に onFrameRendered(tag) で返す。
 * 本文の文字列ではなく、このセッション・このキュー・この表示回 (seq) で照合する。
 */
export type FgFrameTag = { sessionId: string; cueId: string; seq: number }

export function sameFgTag(a: FgFrameTag | null | undefined, b: FgFrameTag | null | undefined): boolean {
  return !!a && !!b && a.sessionId === b.sessionId && a.cueId === b.cueId && a.seq === b.seq
}

export class FieldglassLens {
  screen: FgScreen = 'home'
  profile: Profile = 'work'
  fieldTest = false
  today: FieldglassToday | null = null
  todayProblem: 'old' | 'offline' | null = null
  followupCount: number | null = null
  followups: FieldglassFollowup[] | null = null
  followupsError = false
  followupsScroll = 0
  live: LiveSession | null = null
  cue: Cue | null = null
  oldCue: { cue: Cue; until: number } | null = null
  pausedUntil = 0
  micOffUntil = 0
  review: ReviewState | null = null

  private todayInFlight = false
  private todayTimer: ReturnType<typeof setInterval> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private fieldTestQueue: FieldTestEvent[] = []
  private fieldTestTimer: ReturnType<typeof setTimeout> | null = null
  private sessionCounter = 0
  /** /today 取得の世代。destroy 後に返ってきた結果を捨てる。 */
  private todayGen = 0
  private pendingShown: PendingShown | null = null
  private showSeq = 0
  /** 終了処理中 (最後の確定文を待つ間、最大 ASR_STOP_SETTLE_MS)。操作は受け付けない。 */
  finishing = false

  constructor(private deps: FgDeps) {
    this.reloadPrefs()
  }

  /** 保存済みのプロファイル / フィールドテスト設定を読み直す (起動時、保存領域の読込後)。 */
  reloadPrefs(): void {
    const p = this.deps.store.get(PREF_PROFILE)
    if (p === 'work' || p === 'everyday' || p === 'listening') this.profile = p
    this.fieldTest = this.deps.store.get(PREF_FIELDTEST) === '1'
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  // ─── 外から呼ばれる入口 (main.ts) ─────────────────────────────────────

  /** 予定を定期的に取りに行く (boot 時に 1 回呼ぶ)。 */
  startBackground(): void {
    if (this.todayTimer) return
    void this.refreshToday()
    this.todayTimer = setInterval(() => { void this.refreshToday() }, TODAY_REFRESH_MS)
  }

  /** セッション一覧から入ってきた。 */
  enter(): void {
    this.screen = 'home'
    this.startTick()
    void this.refreshToday().then(() => this.deps.redraw(true))
    void this.loadFollowupCount()
  }

  /** マイクが開いているか (開きかけを含む)。 */
  isLive(): boolean { return this.live?.micOn === true }

  /** Fieldglass の会話セッションが続いているか (一時停止中を含む)。 */
  hasSession(): boolean { return this.live !== null }

  /** セッション一覧の 1 行目 (カーソル記号の後ろ)。 */
  rootRowLabel(): string {
    const head = t('fgRootLabel')
    if (this.live?.micOn) return `${head}  ${tf('fgRootLive', { time: mmss(this.now() - this.live.startedAt) })}`
    return `${head}  ${this.todaySummary()}`
  }

  /** スマホの状態表示用。 */
  statusText(): string {
    if (this.live?.micOn) return tf('fgStatusLive', { time: mmss(this.now() - this.live.startedAt) })
    return t('fgStatusIdle')
  }

  // ─── 描画 ────────────────────────────────────────────────────────────

  header(): string {
    const prof = t(PROFILE_KEY[this.profile])
    let left: string
    switch (this.screen) {
      case 'home': left = tf('fgHeadHome', { profile: prof }); break
      case 'consent': left = t('fgHeadConsent'); break
      case 'confirmEnd': left = tf('fgHeadEnd', { profile: prof }); break
      case 'suspended': left = t('fgHeadSuspended'); break
      case 'followups': left = tf('fgHeadFollowups', { n: this.followups?.length ?? this.followupCount ?? 0 }); break
      case 'review': {
        const r = this.review
        left = r && r.items.length > 0 ? tf('fgHeadReview', { n: r.idx + 1, total: r.items.length }) : t('fgHeadReviewNone')
        break
      }
      case 'live':
      default:
        if (this.pausedUntil > this.now()) left = tf('fgHeadPaused', { profile: prof })
        else if (this.cue || this.oldCue) left = tf('fgHeadCue', { profile: prof })
        else left = tf('fgHeadListen', { profile: prof })
    }
    return `${left}  ${this.micIndicator()}`.trimEnd()
  }

  /** マイクの実態を示す印。開いていれば ● LIVE、閉じた直後 2 秒は ○ MIC OFF、それ以外は無し。 */
  micIndicator(): string {
    if (this.live?.micOn) return tf('fgLive', { time: mmss(this.now() - this.live.startedAt) })
    if (this.micOffUntil > this.now()) return t('fgMicOff')
    return ''
  }

  content(): string {
    return this.bodyLines().slice(0, BODY_LINES).join('\n')
  }

  private bodyLines(): string[] {
    switch (this.screen) {
      case 'home': return this.homeLines()
      case 'consent':
        return [t('fgConsent1'), t('fgConsent2'), t('fgConsent3'), '', t('fgConsent4'), t('fgConsent5')]
      case 'confirmEnd': return [t('fgEndConfirm'), '', ...this.deps.wrap(t('fgEndHint'))]
      case 'suspended': return [t('fgSuspended1'), '', t('fgSuspended2')]
      case 'followups': return this.followupLines()
      case 'review': return this.reviewLines()
      case 'live':
      default: return this.liveLines()
    }
  }

  private todaySummary(): string {
    if (this.todayProblem === 'old') return t('fgRootServerOld')
    const today = this.today
    if (!today) return t('fgRootLoading')
    // 手入力の予定 (source:'manual') もある。予定が 1 件でもあればそれを出す。
    if (today.source === 'none' && today.events.length === 0) return t('fgRootSetup')
    const ev = nextEvent(today.events, new Date(this.now()))
    if (!ev) return t('fgRootNoMeetings')
    return tf('fgRootNext', { time: ev.start, title: ev.title })
  }

  private homeLines(): string[] {
    const lines: string[] = []
    const today = this.today
    if (this.todayProblem === 'old') {
      lines.push(t('fgHomeServerOld'))
    } else if (!today) {
      lines.push(this.todayProblem === 'offline' ? t('fgHomeOffline') : t('fgRootLoading'))
    } else if (today.source === 'none' && today.events.length === 0) {
      lines.push(t('fgHomeCalSetup'), t('fgHomeCalSetupHint'))
    } else {
      const ev = nextEvent(today.events, new Date(this.now()))
      if (!ev) lines.push(t('fgHomeNoMeeting'))
      else {
        lines.push(...this.deps.wrap(tf('fgHomeNext', { time: ev.start, title: ev.title })).slice(0, 1))
        lines.push(...(ev.objective
          ? this.deps.wrap(tf('fgHomeObjective', { text: ev.objective })).slice(0, 2)
          : [t('fgHomeNoObjective')]))
      }
      if (this.todayProblem === 'offline') lines.push(t('fgHomeOffline'))
    }
    lines.push('', t('fgHomeMicOff'))
    if (this.followupCount !== null) lines.push(tf('fgHomeFollowups', { n: this.followupCount }))
    if (this.fieldTest) lines.push(t('fgHomeFieldTest'))
    return lines
  }

  private liveLines(): string[] {
    const live = this.live
    if (!live) return []
    if (live.asrState === 'connecting') return [t('fgConnecting')]
    if (live.asrState === 'failed') return [t('fgAsrFailed')]
    const lines: string[] = []
    if (this.pausedUntil > this.now()) {
      lines.push(tf('fgPausedUntil', { time: hhmm(new Date(this.pausedUntil)) }), t('fgPausedMicOn'))
    } else if (this.cue) {
      // 1 行目は種類 (会話由来の文を置かない: 描画経路が本文 1 行目を console に出すため)。2 行目からキュー。
      lines.push(t(CATEGORY_KEY[this.cue.category] ?? 'fgCatOther'), ...this.deps.wrap(this.cue.text).slice(0, 2), '', ...this.deps.wrap(this.cue.why).slice(0, 2))
    } else if (this.oldCue) {
      // 期限切れのキューは 1 コマだけ (old) を付けてから消す (読んでいる途中で黙って消さない)
      lines.push(`${t(CATEGORY_KEY[this.oldCue.cue.category] ?? 'fgCatOther')} ${t('fgCueOld')}`, ...this.deps.wrap(this.oldCue.cue.text).slice(0, 2))
    }
    // 聞き取り中でキューが無い = 本文は空。沈黙も正しい出力。
    if (live.asrState === 'reconnecting') {
      while (lines.length < BODY_LINES - 1) lines.push('')
      lines.push(t('fgReconnecting'))
    }
    return lines
  }

  private reviewLines(): string[] {
    const r = this.review
    if (this.finishing) return [t('fgFinishing')]
    if (!r || r.items.length === 0) return [t('fgReviewNone')]
    const c = r.items[r.idx]
    // 1 行目には引用を置かない: 描画経路 (renderer.ts) が本文 1 行目を console に出すため、
    // 保存しなかった引用がログに残ってしまう。
    const lines = [t('fgReviewAsk'), ...this.deps.wrap(`"${c.quote}"`).slice(0, 3)]
    if (c.owner) lines.push(tf('fgReviewOwner', { owner: c.owner }))
    if (c.due) lines.push(tf('fgReviewDue', { due: c.due }))
    const st = r.status[c.id]
    while (lines.length < BODY_LINES - 1) lines.push('')
    lines.push(st === 'saved' ? t('fgReviewSaved') : st === 'saving' ? t('fgReviewSaving') : st === 'failed' ? t('fgReviewSaveFail') : r.items.length > 1 ? `▼ ${r.idx + 1}/${r.items.length}` : '')
    return lines
  }

  private followupLineCache: string[] = []

  private followupLines(): string[] {
    if (this.followupsError) return [t('fgFollowupsFail')]
    if (!this.followups) return [t('fgFollowupsLoading')]
    if (this.followups.length === 0) return [t('fgFollowupsEmpty'), '', t('fgFollowupsHint')]
    const all: string[] = []
    for (const f of this.followups) {
      const meta = [f.owner, f.due].filter(Boolean).join(', ')
      all.push(...this.deps.wrap(`· ${f.quote}${meta ? ` (${meta})` : ''}`).slice(0, 3))
      if (f.sentTo) all.push(`  ${tf('fgFollowupSent', { to: f.sentTo })}`)
    }
    this.followupLineCache = all
    // 1 行目は件数 (保存した引用を 1 行目に置かない)
    const start = Math.min(this.followupsScroll, Math.max(0, all.length - (BODY_LINES - 1)))
    return [tf('fgFollowupsSaved', { n: this.followups.length }), ...all.slice(start, start + BODY_LINES - 1)]
  }

  footer(): string {
    switch (this.screen) {
      case 'home': return t('fgFootHome')
      case 'consent': return t('fgFootConsent')
      case 'confirmEnd': return t('fgFootEnd')
      case 'suspended': return t('fgFootSuspended')
      case 'followups': return t('fgFootFollowups')
      case 'review':
        if (this.finishing) return t('fgFootFinishing')
        return this.review && this.review.items.length > 0 ? t('fgFootReview') : t('fgFootReviewNone')
      case 'live':
      default:
        if (this.live?.asrState === 'failed') return t('fgFootRetry')
        return this.cue ? t('fgFootCue') : t('fgFootListen')
    }
  }

  /** 長押しメニュー。画面の境界でだけ変わる (変わるとページ再構築になるため)。 */
  menuItems(): FgMenuItem[] {
    if (this.screen === 'home') {
      return [
        { itemID: FG_MENU.WORK, itemName: t('fgMenuWork') },
        { itemID: FG_MENU.EVERYDAY, itemName: t('fgMenuEveryday') },
        { itemID: FG_MENU.LISTENING, itemName: t('fgMenuListening') },
        { itemID: FG_MENU.FOLLOWUPS, itemName: tf('fgMenuFollowups', { n: this.followupCount ?? 0 }) },
        { itemID: FG_MENU.FIELD_TEST, itemName: t('fgMenuFieldTest') },
        ...(this.deps.resetRatings ? [{ itemID: FG_MENU.RESET_MUTED, itemName: t('fgMenuResetMuted') }] : []),
      ]
    }
    if (this.screen === 'live') {
      return [
        { itemID: FG_MENU.OFF_TARGET, itemName: t('fgMenuOffTarget') },
        { itemID: FG_MENU.THAT_WAS_ME, itemName: t('fgMenuThatWasMe') },
        { itemID: FG_MENU.PAUSE, itemName: t(this.pausedUntil > 0 ? 'fgMenuResume' : 'fgMenuPause') },
        { itemID: FG_MENU.END, itemName: t('fgMenuEnd') },
      ]
    }
    return []
  }

  // ─── 操作 ────────────────────────────────────────────────────────────

  onClick(): void {
    if (this.finishing) return
    switch (this.screen) {
      case 'home': this.go('consent'); return
      case 'consent': void this.startLive(); return
      case 'confirmEnd': void this.endLive(); return
      case 'suspended': void this.resumeLive(); return
      case 'review': void this.saveCurrentCommitment(); return
      case 'live': {
        const live = this.live
        if (live?.asrState === 'failed') { void this.retryAsr(); return }
        const cue = this.cue
        if (cue && live) {
          live.engine.rate(cue.id, 'useful')
          live.engine.dismiss(cue.id)
          this.logField({ kind: 'rated', cueId: cue.id, category: cue.category, rating: 'useful' })
          this.clearCue()
          this.deps.notice(t('fgNoticeUseful'))
          void this.deps.redraw(true)
        }
        return
      }
      default: return
    }
  }

  onDoubleClick(): void {
    if (this.finishing) return
    switch (this.screen) {
      case 'home': this.leave(); return
      case 'consent': this.go('home'); return
      case 'live': this.go('confirmEnd'); return
      case 'suspended': this.go('confirmEnd'); return
      case 'confirmEnd': this.go(this.live?.micOn || this.live?.asrState === 'failed' ? 'live' : this.live ? 'suspended' : 'home'); return
      case 'review': this.finishReview(); return
      case 'followups': this.go('home'); return
      default: return
    }
  }

  onScroll(delta: 1 | -1): void {
    if (this.finishing) return
    if (this.screen === 'review' && this.review && this.review.items.length > 0) {
      const n = this.review.items.length
      this.review.idx = Math.max(0, Math.min(n - 1, this.review.idx + delta))
      void this.deps.redraw(true)
    } else if (this.screen === 'followups') {
      const max = Math.max(0, this.followupLineCache.length - (BODY_LINES - 1))
      this.followupsScroll = Math.max(0, Math.min(max, this.followupsScroll + delta))
      void this.deps.redraw(true)
    }
    // 他の画面ではスワイプは何もしない (スワイプで確定させない)
  }

  /** @returns この itemID を Fieldglass が扱ったか */
  onMenuItem(itemID: number): boolean {
    const live = this.live
    switch (itemID) {
      case FG_MENU.WORK: this.setProfile('work'); return true
      case FG_MENU.EVERYDAY: this.setProfile('everyday'); return true
      case FG_MENU.LISTENING: this.setProfile('listening'); return true
      case FG_MENU.FOLLOWUPS: void this.openFollowups(); return true
      case FG_MENU.FIELD_TEST:
        this.fieldTest = !this.fieldTest
        this.deps.store.set(PREF_FIELDTEST, this.fieldTest ? '1' : '0')
        this.deps.notice(t(this.fieldTest ? 'fgNoticeFieldOn' : 'fgNoticeFieldOff'))
        void this.deps.redraw(true)
        return true
      case FG_MENU.OFF_TARGET: {
        const cue = this.cue
        if (cue && live) {
          live.engine.rate(cue.id, 'off')
          live.engine.dismiss(cue.id)
          this.logField({ kind: 'rated', cueId: cue.id, category: cue.category, rating: 'off' })
          this.clearCue()
          this.deps.notice(t('fgNoticeOff'))
        }
        void this.deps.redraw(true)
        return true
      }
      case FG_MENU.THAT_WAS_ME: {
        if (!live) return true
        // キューが出ていればそのキューの話者だけを使う (不明なら断る)。古い話者で代用しない。
        const speaker = this.cue ? this.cue.evidence.speaker : live.lastSpeaker
        if (!speaker) {
          this.deps.notice(t('fgNoticeNoSpeaker'))
        } else {
          live.engine.setWearer(speaker)
          live.wearerSet = true
          // 自分の発言から出たキューは自分に向けて出す意味が無いので下げる
          if (this.cue && this.cue.evidence.speaker === speaker) {
            live.engine.dismiss(this.cue.id)
            this.clearCue()
          }
          this.deps.notice(tf('fgNoticeWearer', { speaker }))
        }
        void this.deps.redraw(true)
        return true
      }
      case FG_MENU.PAUSE:
        if (this.pausedUntil > 0) {
          this.pausedUntil = 0
          this.deps.notice(t('fgNoticeResumed'))
        } else {
          this.pausedUntil = this.now() + PAUSE_MS
          if (this.cue && live) live.engine.dismiss(this.cue.id)
          this.clearCue()
          this.deps.notice(t('fgNoticePaused'))
        }
        void this.deps.redraw(true)
        return true
      case FG_MENU.END:
        if (live) void this.endLive()
        return true
      case FG_MENU.RESET_MUTED:
        this.deps.resetRatings?.()
        this.deps.notice(t('fgNoticeResetMuted'))
        void this.deps.redraw(true)
        return true
      default:
        return false
    }
  }

  /** G2 マイクの PCM。live 中で ASR が繋がっている時だけ流す (それ以外は捨てる)。 */
  onAudio(pcm: Uint8Array): void {
    const live = this.live
    if (!live?.micOn || live.asrState !== 'ok') return
    live.asr?.send(pcm)
  }

  /** 1 秒ごと。期限切れの処理とヘッダの時計。 */
  tick(): void {
    const now = this.now()
    const live = this.live
    live?.engine.tick()
    if (this.oldCue && this.oldCue.until <= now) this.oldCue = null
    if (this.pausedUntil > 0 && this.pausedUntil <= now) {
      this.pausedUntil = 0
      if (this.screen === 'live') this.deps.notice(t('fgNoticeResumed'))
      void this.deps.redraw(true)
      return
    }
    // 時計 (● LIVE mm:ss / ○ MIC OFF の消灯) はヘッダだけが変わる。差分描画に任せる。
    if (live?.micOn || this.micOffUntil > now - 1000 || this.oldCue) void this.deps.redraw(false)
  }

  /**
   * スマホが HeadLenss を離れた (画面ロック・他アプリ)。マイクと音声認識を必ず止める。
   * 会話の中身 (エンジンの状態・約束) は残し、戻ってきたら Tap で再開できるようにする。
   */
  suspend(reason: string): void {
    const live = this.live
    if (!live) return
    this.deps.log(`fieldglass: suspend (${reason})`)
    this.stopAsrAndMic(live, `fieldglass-${reason}`)
    this.clearCue()
    if (this.screen === 'live' || this.screen === 'confirmEnd') this.screen = 'suspended'
  }

  /** ページごと消える。待たずに全部捨てる (約束も含めて残さない)。 */
  destroy(reason: string): void {
    const live = this.live
    if (live) {
      this.stopAsrAndMic(live, `fieldglass-${reason}`)
      live.unsubscribe()
      live.engine.reset()
      this.live = null
    }
    this.review = null
    this.finishing = false
    this.cue = null
    this.oldCue = null
    this.pendingShown = null
    this.stopTick()
    // 常駐の取得と送信も止める。ページが残っていても、壊した後に通信しない。
    if (this.todayTimer) clearInterval(this.todayTimer)
    this.todayTimer = null
    this.todayGen++  // 取得中の /today は返ってきても捨てる
    if (this.fieldTestTimer) clearTimeout(this.fieldTestTimer)
    this.fieldTestTimer = null
    this.fieldTestQueue = []  // 送れない計測は捨てる (ページが消える時に待てない)
  }

  // ─── 内部 ────────────────────────────────────────────────────────────

  private go(screen: FgScreen): void {
    this.screen = screen
    void this.deps.redraw(true)
  }

  private leave(): void {
    this.stopTick()
    this.deps.exit()
  }

  private startTick(): void {
    if (this.tickTimer) return
    this.tickTimer = setInterval(() => this.tick(), 1000)
  }

  private stopTick(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
  }

  private setProfile(p: Profile): void {
    this.profile = p
    this.deps.store.set(PREF_PROFILE, p)
    this.live?.engine.setProfile(p)
    this.deps.notice(tf('fgNoticeProfile', { profile: t(PROFILE_KEY[p]) }))
    void this.deps.redraw(true)
  }

  async refreshToday(): Promise<void> {
    const client = this.deps.client()
    if (!client || this.todayInFlight) return
    this.todayInFlight = true
    const gen = this.todayGen
    try {
      const today = await client.fieldglassToday()
      if (gen !== this.todayGen) return
      this.today = today
      this.todayProblem = null
    } catch (err) {
      if (gen !== this.todayGen) return
      this.todayProblem = (err as Error).name === 'FieldglassUnavailableError' ? 'old' : 'offline'
      this.deps.log(`fieldglass: today failed: ${(err as Error).message}`)
    } finally {
      this.todayInFlight = false
    }
  }

  private async loadFollowupCount(): Promise<void> {
    const client = this.deps.client()
    if (!client) return
    try {
      const list = await client.fieldglassFollowups()
      this.followupCount = list.length
      if (this.screen === 'home') void this.deps.redraw(true)
    } catch { /* 件数は出せないだけ */ }
  }

  private async openFollowups(): Promise<void> {
    this.followups = null
    this.followupsError = false
    this.followupsScroll = 0
    this.go('followups')
    const client = this.deps.client()
    try {
      if (!client) throw new Error('no server')
      this.followups = await client.fieldglassFollowups()
      this.followupCount = this.followups.length
    } catch {
      this.followupsError = true
    }
    if (this.screen === 'followups') void this.deps.redraw(true)
  }

  private clearCue(): void {
    this.cue = null
    this.oldCue = null
  }

  private async startLive(): Promise<void> {
    if (this.live) { this.go('live'); return }
    const cfg = this.deps.asrConfig()
    if (!cfg) {
      this.deps.notice(t('fgNoticeNoKey'))
      void this.deps.redraw(true)
      return
    }
    const now = this.now()
    const engine = this.deps.createEngine({
      profile: this.profile, now: () => this.now(), store: this.deps.store, lang: getLanguage(),
    })
    const live: LiveSession = {
      id: `fg-${now.toString(36)}-${++this.sessionCounter}`,
      engine,
      unsubscribe: () => {},
      asr: null,
      asrEpoch: 0,
      asrState: 'connecting',
      reconnectAttempt: 0,
      reconnectTimer: null,
      micOn: true,         // ここから ● LIVE (開きかけも「オン」として見せる = 安全側)
      startedAt: now,
      audioZeroAt: null,
      audioBaseMs: 0,
      event: this.today ? nextEvent(this.today.events, new Date(now)) : null,
      lastSpeaker: undefined,
      micRequested: false,
      micToken: null,
      micEverOk: false,
      connection: 0,
      wearerSet: false,
      ending: false,
    }
    live.unsubscribe = engine.on((e) => this.onEngineEvent(live, e))
    this.live = live
    this.cue = null
    this.oldCue = null
    this.pausedUntil = 0
    this.micOffUntil = 0
    this.screen = 'live'
    this.startTick()
    this.logField({ kind: 'session_start' })
    void this.deps.redraw(true)

    // 接続できたらマイクを開く (connectAsr の中)。初回接続に失敗しても、後の自動再接続で開く。
    await this.connectAsr(live)
  }

  /**
   * マイクの取得を出す (共有の MicArbiter 経由)。遅れて開いた時の閉じ直しは arbiter がやる:
   * もう誰も欲しがっていなければ閉じ、別の持ち主 (通常録音・次のセッション) がいれば触らない。
   * ここでは「まだこのセッションが欲しがっているか」だけを見て、失敗を扱う。
   */
  private requestMic(live: LiveSession): void {
    if (live.micRequested || !live.micOn) return
    live.micRequested = true
    const ticket = this.deps.mic.acquire('fieldglass')
    live.micToken = ticket.token
    const wanted = () => this.live === live && live.micOn && live.micRequested && live.micToken === ticket.token && !live.ending
    ticket.result.then((res) => {
      if (!wanted()) return
      if (res.ok || res.reason === 'busy') { live.micEverOk = true; return }
      this.onMicFailed(live, res.reason ?? '?')
    }, (err: unknown) => {
      if (wanted()) this.onMicFailed(live, (err as Error)?.message ?? 'error')
    })
  }

  private onMicFailed(live: LiveSession, reason: string): void {
    this.deps.log(`fieldglass: mic open failed (${reason})`)
    this.deps.notice(t('fgNoticeMicFail'))
    if (!live.micEverOk) { this.abandonLive(live); return }
    live.asrState = 'failed'
    this.stopAsrAndMic(live, 'fieldglass-mic-failed')
    void this.deps.redraw(true)
  }

  /** 開始に失敗した: 何も残さず home へ。 */
  private abandonLive(live: LiveSession): void {
    this.stopAsrAndMic(live, 'fieldglass-start-failed')
    live.unsubscribe()
    live.engine.reset()
    if (this.live === live) this.live = null
    this.screen = 'home'
    void this.deps.redraw(true)
  }

  /** @returns 繋がったか */
  private async connectAsr(live: LiveSession): Promise<boolean> {
    const cfg = this.deps.asrConfig()
    if (!cfg) { live.asrState = 'failed'; return false }
    const epoch = ++live.asrEpoch
    const asr = this.deps.createAsr()
    live.asr = asr
    live.asrState = live.audioZeroAt === null ? 'connecting' : 'reconnecting'
    const fresh = () => this.live === live && live.asrEpoch === epoch
    try {
      await asr.start({
        apiKey: cfg.apiKey,
        language: cfg.language,
        operatingPoint: cfg.operatingPoint,
        maxDelay: ASR_MAX_DELAY_S,
        enablePartials: true,
        diarization: true,
        endOfUtteranceSilence: END_OF_UTTERANCE_S,
        retainTranscript: false,
        onSegment: (seg) => { if (fresh()) this.onSegment(live, seg) },
        onError: (err) => this.deps.log(`fieldglass: ASR error: ${err.message}`),
        onDead: (outcome) => { if (fresh()) this.onAsrDead(live, 'reason' in outcome ? outcome.reason : outcome.kind) },
      })
    } catch (err) {
      if (!fresh()) return false
      this.deps.log(`fieldglass: ASR connect failed: ${(err as Error).message}`)
      live.asr = null
      this.scheduleReconnect(live)
      return false
    }
    if (!fresh()) { try { asr.abort() } catch { /* ignore */ } return false }
    const now = this.now()
    if (live.audioZeroAt === null) live.audioZeroAt = now
    else live.audioBaseMs = now - live.audioZeroAt
    live.asrState = 'ok'
    live.reconnectAttempt = 0
    live.connection++
    if (live.connection > 1) {
      // S1/S2 は接続ごとに出現順で振り直される (同じ人とは限らない)。前の接続での
      // 「今のは自分」や話者の絞り込みは引き継がない。必要ならもう一度指定してもらう。
      live.engine.setWearer(null)
      live.engine.setFocus(null)
      live.lastSpeaker = undefined
      if (live.wearerSet) { live.wearerSet = false; this.deps.notice(t('fgNoticeSpeakersReset')) }
    }
    // マイクがまだなら開く (初回接続 / 一時停止からの再開 / 初回失敗後の自動再接続)。
    // ふつうの切断からの再接続では開いたままなので出さない。
    this.requestMic(live)
    void this.deps.redraw(true)
    return true
  }

  private onAsrDead(live: LiveSession, reason: string): void {
    this.deps.log(`fieldglass: ASR died (${reason}) — reconnecting`)
    live.asr = null
    this.scheduleReconnect(live)
  }

  private scheduleReconnect(live: LiveSession): void {
    if (this.live !== live || !live.micOn || live.ending) return
    const delay = RECONNECT_DELAYS_MS[live.reconnectAttempt]
    if (delay === undefined) {
      // 諦める。聞き取れないのにマイクだけ開けておかない。
      live.asrState = 'failed'
      this.stopAsrAndMic(live, 'fieldglass-asr-failed')
      void this.deps.redraw(true)
      return
    }
    live.reconnectAttempt++
    live.asrState = live.audioZeroAt === null && live.reconnectAttempt === 1 ? 'connecting' : 'reconnecting'
    if (live.reconnectTimer) clearTimeout(live.reconnectTimer)
    live.reconnectTimer = setTimeout(() => {
      live.reconnectTimer = null
      if (this.live === live && live.micOn && !live.ending) void this.connectAsr(live)
    }, delay)
    void this.deps.redraw(true)
  }

  /** 失敗表示からの再試行 / 一時停止からの再開。 */
  private async retryAsr(): Promise<void> {
    const live = this.live
    if (!live) return
    live.micOn = true
    live.reconnectAttempt = 0
    this.micOffUntil = 0
    this.screen = 'live'
    void this.deps.redraw(true)
    await this.connectAsr(live)  // 繋がればマイクも開く (requestMic)
  }

  private resumeLive(): Promise<void> { return this.retryAsr() }

  /** ASR とマイクを止める。止めたら ○ MIC OFF を 2 秒出す。 */
  private stopAsrAndMic(live: LiveSession, reason: string): void {
    live.asrEpoch++  // 古い接続のコールバックを無効化
    if (live.reconnectTimer) { clearTimeout(live.reconnectTimer); live.reconnectTimer = null }
    const asr = live.asr
    live.asr = null
    if (asr) {
      // 正常に畳めればそれでよし、決着しなければ捨てる。どちらでも結果は使わない。
      void settleWithin(asr.stop(), ASR_STOP_SETTLE_MS).then(() => { try { asr.abort() } catch { /* ignore */ } })
    }
    this.releaseMic(live, reason)
    if (live.asrState !== 'failed') live.asrState = 'idle'
  }

  /** マイクを閉じる (取得中でも閉じる。遅れて開いたら requestMic の後始末がもう一度閉じる)。 */
  private releaseMic(live: LiveSession, reason: string): void {
    live.micRequested = false
    const token = live.micToken
    live.micToken = null
    // 自分の札でだけ閉じる。札が持ち主でなくなっていれば (他の誰かが取得した) 何もしない。
    if (token !== null) void this.deps.mic.release(token, reason)
    if (live.micOn) {
      live.micOn = false
      this.micOffUntil = this.now() + MIC_OFF_SHOW_MS
    }
  }

  private onSegment(live: LiveSession, seg: AsrSegment): void {
    // 2 本目以降の接続の話者は別名にする (前の接続の S1 と混ぜない)
    const speaker = seg.speaker && live.connection > 1 ? `${seg.speaker}#${live.connection}` : seg.speaker
    const shifted: AsrSegment = { ...seg, startMs: seg.startMs + live.audioBaseMs, endMs: seg.endMs + live.audioBaseMs }
    if (speaker) shifted.speaker = speaker
    else delete shifted.speaker
    // 空の EndOfUtterance は話者を持たないので、直近の話者を上書きしない
    if (seg.text.trim()) live.lastSpeaker = speaker
    live.engine.onSegment(shifted)
  }

  /**
   * main.ts から: このフレームの本文が実際にレンズへ送れた (SDK が応答した)。
   * キューの 1 行目を含むフレームが届いた時だけ cue_shown を記録する。
   * 間引かれた・失敗した・差し替わったフレームでは記録しない。
   */
  onFrameRendered(tag: FgFrameTag | null | undefined): void {
    const p = this.pendingShown
    // 送れたフレームが「今まだ記録待ちのキュー」を載せたフレームそのものの時だけ。古いセッション・
    // 古いキュー・差し替わったフレームの完了は、同じ文面でも一致しない。
    if (!p || !tag || !sameFgTag(tag, p)) return
    this.pendingShown = null
    this.logField({
      kind: 'cue_shown', cueId: p.cueId, category: p.category, sessionIdOverride: p.sessionId,
      lastWordAt: p.lastWordAt, candidateAt: p.candidateAt, renderedAt: this.now(),
    })
  }

  /**
   * いま組むフレームの身元札。記録待ちのキューが実際にこの画面に載っている時だけ返す
   * (main.ts はフレームを組むのと同じ同期区間で呼ぶ)。
   */
  frameTag(): FgFrameTag | null {
    const p = this.pendingShown
    if (!p || this.screen !== 'live' || this.cue?.id !== p.cueId || this.live?.id !== p.sessionId) return null
    return { sessionId: p.sessionId, cueId: p.cueId, seq: p.seq }
  }

  private onEngineEvent(live: LiveSession, e: EngineEvent): void {
    if (this.live !== live) return
    if (e.type === 'show') {
      // 一時停止中・別画面では出さない。エンジンには下げたことを伝えて、見えているつもりにさせない。
      if (this.pausedUntil > this.now() || this.screen !== 'live' || live.ending) {
        live.engine.dismiss(e.cue.id)
        return
      }
      this.cue = e.cue
      this.oldCue = null
      this.pendingShown = {
        sessionId: live.id, cueId: e.cue.id, seq: ++this.showSeq, category: e.cue.category, candidateAt: this.now(),
        lastWordAt: live.audioZeroAt !== null ? live.audioZeroAt + e.cue.evidence.endMs : undefined,
      }
      void this.deps.redraw(true)
      return
    }
    // retract
    if (this.pendingShown?.cueId === e.cueId) this.pendingShown = null  // 描画前に下がった = 見せていない
    if (this.cue?.id !== e.cueId) return
    const cue = this.cue
    this.cue = null
    this.oldCue = e.reason === 'expired' ? { cue, until: this.now() + OLD_CUE_SHOW_MS } : null
    this.logField({ kind: 'cue_retracted', cueId: e.cueId, category: cue.category, reason: e.reason })
    void this.deps.redraw(true)
  }

  /** 会話を終える (レンズの確認後 / スマホの停止ボタン)。マイクを切り、約束の確認へ。 */
  async endLive(): Promise<void> {
    const live = this.live
    if (!live) { this.go('home'); return }
    if (live.ending) return
    live.ending = true
    // 1. マイクは今すぐ切る。キューも再接続も止める。
    if (live.reconnectTimer) { clearTimeout(live.reconnectTimer); live.reconnectTimer = null }
    this.releaseMic(live, 'fieldglass-end')
    this.cue = null
    this.oldCue = null
    this.pendingShown = null
    this.finishing = true
    this.review = null
    this.screen = 'review'
    void this.deps.redraw(true)
    // 2. 言い終わった直後の確定文 (最後の約束) を受け取ってから閉じる。待つのは最大 1.5 秒。
    //    この間もこの接続のコールバックは有効 (エポックはまだ上げない)。
    const asr = live.asr
    if (asr && live.asrState === 'ok') await settleWithin(asr.stop(), ASR_STOP_SETTLE_MS)
    live.asrEpoch++
    live.asr = null
    try { asr?.abort() } catch { /* ignore */ }
    live.asrState = 'idle'
    if (this.live !== live) return  // 待っている間に破棄された
    this.finishing = false
    const items = live.engine.commitments().slice()
    // ここで文字起こしを捨てる。残るのは画面に出す約束の引用だけ (review が終われば消える)。
    live.unsubscribe()
    live.engine.reset()
    this.live = null
    this.cue = null
    this.oldCue = null
    this.pausedUntil = 0
    this.logField({ kind: 'session_end', sessionIdOverride: live.id })
    void this.flushFieldTest()
    this.review = { items, idx: 0, status: {}, event: live.event }
    this.screen = 'review'
    void this.deps.redraw(true)
  }

  private async saveCurrentCommitment(): Promise<void> {
    const r = this.review
    if (!r || r.items.length === 0) { this.finishReview(); return }
    const c = r.items[r.idx]
    const st = r.status[c.id]
    if (st === 'saving') return
    if (st === 'saved') {
      if (r.idx < r.items.length - 1) { r.idx++; void this.deps.redraw(true) }
      else this.finishReview()
      return
    }
    const client = this.deps.client()
    r.status[c.id] = 'saving'
    void this.deps.redraw(true)
    try {
      if (!client) throw new Error('no server')
      await client.fieldglassSaveFollowup({
        quote: c.quote, owner: c.owner, due: c.due,
        eventId: r.event?.id, meetingTitle: r.event?.title,
      })
      if (this.review !== r) return
      r.status[c.id] = 'saved'
      this.followupCount = (this.followupCount ?? 0) + 1
      if (r.idx < r.items.length - 1) r.idx++
    } catch (err) {
      this.deps.log(`fieldglass: save failed: ${(err as Error).message}`)
      if (this.review !== r) return
      r.status[c.id] = 'failed'
    }
    void this.deps.redraw(true)
  }

  private finishReview(): void {
    const r = this.review
    const saved = r ? Object.values(r.status).filter((s) => s === 'saved').length : 0
    this.review = null  // 保存しなかった引用もここで手放す
    this.screen = 'home'
    this.deps.notice(tf('fgNoticeDone', { n: saved }))
    void this.deps.redraw(true)
  }

  // ─── フィールドテスト記録 ─────────────────────────────────────────────

  private logField(ev: Omit<FieldTestEvent, 'sessionId' | 'at'> & { sessionIdOverride?: string }): void {
    if (!this.fieldTest) return
    const { sessionIdOverride, ...rest } = ev
    const sessionId = sessionIdOverride ?? this.live?.id
    if (!sessionId) return
    this.fieldTestQueue.push({ ...rest, sessionId, at: this.now() })
    if (!this.fieldTestTimer) {
      this.fieldTestTimer = setTimeout(() => { this.fieldTestTimer = null; void this.flushFieldTest() }, FIELDTEST_FLUSH_MS)
    }
  }

  async flushFieldTest(): Promise<void> {
    if (this.fieldTestTimer) { clearTimeout(this.fieldTestTimer); this.fieldTestTimer = null }
    const batch = this.fieldTestQueue.splice(0)
    const client = this.deps.client()
    if (batch.length === 0 || !client) return
    try {
      await client.fieldglassFieldTest(batch)
    } catch (err) {
      // 記録は測定用。失敗しても会話は止めない (取りこぼしはログに残す)
      this.deps.log(`fieldglass: field test post failed (${batch.length} events): ${(err as Error).message}`)
    }
  }
}

// ─── 設定の保存 (プロファイル・評価の記憶) ──────────────────────────────
// cue engine の store は同期 API。ブリッジの保存は非同期なので、メモリに持って
// 書くたびに localStorage とブリッジへ書き出す (起動時に loadFgStore で読む)。

type StorageBridge = {
  getLocalStorage(key: string): Promise<string>
  setLocalStorage(key: string, value: string): Promise<boolean>
}

const STORE_KEY = 'headlenss_fieldglass_v1'

export class FgPrefs implements FgStore {
  private data: Record<string, string> = {}
  constructor(private bridge: StorageBridge | null = null) {}

  async load(): Promise<void> {
    let raw: string | null = null
    try { raw = this.bridge ? await this.bridge.getLocalStorage(STORE_KEY) : null } catch { raw = null }
    if (!raw) { try { raw = localStorage.getItem(STORE_KEY) } catch { raw = null } }
    try {
      const parsed = raw ? JSON.parse(raw) as unknown : null
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') this.data[k] = v
      }
    } catch { /* 壊れていたら既定値 */ }
  }

  get(key: string): string | null { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null }

  set(key: string, value: string): void {
    this.data[key] = value
    const json = JSON.stringify(this.data)
    try { localStorage.setItem(STORE_KEY, json) } catch { /* ignore */ }
    void this.bridge?.setLocalStorage(STORE_KEY, json).catch(() => false)
  }
}
