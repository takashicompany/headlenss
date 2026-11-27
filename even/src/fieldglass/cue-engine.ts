/** Phone-local conversation rules. No audio, networking, DOM, SDK or timers. */
export type Profile = 'work' | 'everyday' | 'listening'
export type CueCategory = 'owner' | 'date' | 'decision' | 'blocker' | 'concern' | 'recall'
export interface Segment {
  text: string; isFinal: boolean; speaker?: string
  startMs: number; endMs: number; endOfUtterance?: boolean
}
export interface Cue {
  id: string; category: CueCategory; revision: number; text: string; why: string
  evidence: { quote: string; speaker?: string; endMs: number }
  createdAt: number; expiresAt: number
}
export interface Commitment {
  id: string; quote: string; owner?: string; due?: string; speaker?: string; endMs: number
}
export type EngineEvent =
  | { type: 'show'; cue: Cue }
  | { type: 'retract'; cueId: string; reason: 'resolved' | 'expired' | 'superseded' | 'muted' | 'reset' }
export interface CueEngineOptions {
  profile: Profile; now: () => number
  store?: { get(key: string): string | null; set(key: string, value: string): void }
  lang?: 'en' | 'ja'
}
export interface CueEngine {
  onSegment(seg: Segment): void
  tick(): void
  setProfile(p: Profile): void
  setWearer(speaker: string | null): void
  setFocus(speaker: string | null): void
  rate(cueId: string, rating: 'useful' | 'off'): void
  dismiss(cueId: string): void
  commitments(): Commitment[]
  reset(): void
  on(listener: (e: EngineEvent) => void): () => void
}

const PROFILES: Profile[] = ['work', 'everyday', 'listening']
const CATEGORIES: CueCategory[] = ['owner', 'date', 'decision', 'blocker', 'concern', 'recall']
const TTL = 20_000
const COOLDOWN = 30_000
const WINDOW = 600_000
const SETTLE = 350
const MAX_PENDING_AGE = 2_000
const DEDUP = 120_000
export const CUE_RATINGS_KEY = 'fieldglass.cue-ratings.v1'

// Injected language keeps the pure engine independent of the application's
// global i18n/localStorage module. All generated user-facing copy lives here.
const i18n: Record<'en' | 'ja', Record<CueCategory, { text: string; why: string; topicText?: string }>> = {
  en: {
    owner: { text: 'Who will take ownership?', why: 'An owner is still needed.', topicText: 'Who owns {topic}?' },
    date: { text: 'What date should we agree on?', why: 'A date is still missing.', topicText: 'What date for {topic}?' },
    decision: { text: 'What needs to be decided?', why: 'A choice is still open.' },
    blocker: { text: 'What would unblock the next step?', why: 'A blocker was raised.', topicText: 'What would unblock {topic}?' },
    concern: { text: 'What would help with that concern?', why: 'The speaker expressed a concern.' },
    recall: { text: 'Which earlier agreement would help?', why: 'The speaker asked for a reminder.' },
  },
  ja: {
    owner: { text: '誰が担当しますか？', why: '担当者がまだ必要です。', topicText: '{topic}の担当は誰ですか？' },
    date: { text: 'いつまでに進めますか？', why: '日程がまだ決まっていません。', topicText: '{topic}はいつまでですか？' },
    decision: { text: '何を決める必要がありますか？', why: '選択がまだ残っています。' },
    blocker: { text: '次に進むには何が必要ですか？', why: '進行を妨げる問題が出ました。', topicText: '{topic}を進めるには何が必要ですか？' },
    concern: { text: 'その心配に何が役立ちますか？', why: '相手が心配を話しています。' },
    recall: { text: 'どの約束を確認しますか？', why: '相手が確認を求めています。' },
  },
}

type Rating = { useful: number; off: number }
type Ratings = Record<Profile, Record<CueCategory, Rating>>
function emptyRatings(): Ratings {
  return Object.fromEntries(PROFILES.map(p => [p, Object.fromEntries(
    CATEGORIES.map(c => [c, { useful: 0, off: 0 }]),
  )])) as Ratings
}
function readRatings(store: CueEngineOptions['store']): Ratings {
  const out = emptyRatings()
  try {
    const saved = JSON.parse(store?.get(CUE_RATINGS_KEY) ?? 'null')
    if (saved?.version !== 1) return out
    for (const p of PROFILES) for (const c of CATEGORIES) {
      for (const k of ['useful', 'off'] as const) {
        const n = saved.counts?.[p]?.[c]?.[k]
        if (Number.isSafeInteger(n) && n >= 0) out[p][c][k] = Math.min(n, 1_000_000)
      }
    }
  } catch { /* Storage is optional; malformed/unavailable storage is non-fatal. */ }
  return out
}

const ratingResets = new WeakMap<CueEngine, (profile?: Profile) => void>()
/** Explicit settings action; conversation reset deliberately preserves learning. */
export function resetCueRatings(engine: CueEngine, profile?: Profile): void {
  ratingResets.get(engine)?.(profile)
}

function normal(text: string): string {
  return text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim()
}
const WEEKDAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)'
const MONTH = '(?:january|february|march|april|may|june|july|august|september|october|november|december)'
const DUE = new RegExp(`\\b(?:by|before|on|due(?:\\s+(?:by|on))?|deadline is|date is)\\s+((?:next\\s+)?${WEEKDAY}|tomorrow|today|tonight|next (?:week|month)|(?:the\\s+)?end of (?:the\\s+)?(?:day|week|month)|eod|eow|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/:]\\d{1,2}(?:\\s*[ap]m)?|\\d{1,2}\\s*[ap]m)\\b`, 'i')
const JP_DUE = /(?:明日|今日|来週|今週|来月|月曜(?:日)?|火曜(?:日)?|水曜(?:日)?|木曜(?:日)?|金曜(?:日)?|土曜(?:日)?|日曜(?:日)?|\d{1,2}月\d{1,2}日|\d{1,2}日)(?:まで)?/
function dueIn(text: string): string | undefined {
  const bare = new RegExp(`^\\s*((?:next\\s+)?${WEEKDAY}|tomorrow|today|tonight)[.!?]?\\s*$`, 'i')
  return DUE.exec(text)?.[1] ?? bare.exec(text)?.[1]
    ?? /\b(?:tomorrow|today|tonight|next week|next month)\b/i.exec(text)?.[0] ?? JP_DUE.exec(text)?.[0]
}
function clauses(text: string): string[] {
  // Keep punctuation: a question must not become an affirmative undertaking.
  // Multi-clause quotes are exact source substrings, never reconstructed text.
  return (text.match(/[^.!?。！？;；\n]+[.!?。！？;；\n]*/g) ?? [])
    .flatMap(s => s.split(/,?\s+but\s+/i)).filter(s => s.trim())
}
function hypothetical(text: string): boolean {
  return /^(?:if\b|unless\b|suppose\b|imagine\b|what if\b|for example\b|["“「])/.test(text)
    || /\b(?:said|says|quoted|example|phrase|sentence)\b.*["“]/.test(text) || /^(?:もし|例えば)/.test(text)
}

function categoriesIn(s: string): CueCategory[] {
  if (hypothetical(s)) return []
  const found: CueCategory[] = []
  if (/\b(?:who(?: (?:will|can|should|could|is going to)|'s going to) (?:own|take|handle|do|run|send)|(?:somebody|someone) should (?:own|take|handle|run)|who(?:'s| is) (?:the owner|responsible)|(?:need|needs|needing) (?:an? |the )?(?:owner|someone|somebody)|no (?:clear )?owner|(?:owner|ownership) (?:is |still )?(?:missing|unclear|unassigned)|unassigned|without an owner|(?:don't have|do not have|haven't assigned) an owner)\b/.test(s)
    || /(?:担当者?(?:が|は)?(?:未定|いない|決まっていない)|誰が.{0,20}担当)/.test(s)) found.push('owner')
  if (/\b(?:no (?:agreed |clear )?(?:date|deadline)|(?:date|deadline) (?:is |still )?(?:missing|unclear|undecided|unknown)|(?:date|deadline) (?:hasn't|has not) been set|(?:need|needs) (?:an? |the )?(?:date|deadline)|by when|when (?:is|will|should|does).{0,60}(?:due|ready|finish|launch|happen|deliver|complete)|haven't (?:set|agreed).{0,20}(?:date|deadline))\b/.test(s)
    || /(?:期限|日程|納期).{0,12}(?:未定|決まっていない)|いつまで/.test(s)) found.push('date')
  if (/\b(?:(?:haven't|have not|can't|cannot|need to|must|still need to) (?:yet )?decid(?:e|ed)|(?:haven't|have not) made a decision|undecided|decision (?:is )?(?:pending|needed)|(?:need|needs) (?:a |the )?decision|which .{0,50}(?:choose|pick)|should we .{0,50}\bor\b)/.test(s)
    || /(?:まだ決まっていない|決める必要|どちらにする)/.test(s)) found.push('decision')
  if (/\b(?:blocked (?:on|by)|stuck on|blockers?|held up by|can't (?:proceed|move forward)|cannot (?:proceed|move forward)|waiting on (?!hold\b|(?:(?:my|the|a|our) )?(?:coffee|tea|lunch|dinner|food)\b)\w+)\b/.test(s)
    && !/\b(?:not|no longer|isn't|aren't|wasn't|weren't) (?:a |any )?(?:blocked|blocking|stuck|blocker)|\bno blockers?\b/.test(s)
    || /(?:行き詰ま|進められない|ブロッカーがある)/.test(s)) found.push('blocker')
  if (/\b(?:(?:i'm|i am|we're|we are|i feel|we feel) (?:really |so |a bit )?(?:worried|concerned|anxious|overwhelmed|afraid|upset)|i worry|my concern is|i'm struggling)\b/.test(s)
    || /(?:心配です|不安です|困っています)/.test(s)) found.push('concern')
  if (/\b(?:remind me|help me remember|what did (?:i|we) (?:promise|agree|decide)|can't remember|cannot remember|do you remember)\b/.test(s)
    || /(?:思い出せない|覚えていますか|約束.{0,10}確認したい)/.test(s)) found.push('recall')
  // Quoted examples and explicit denials are not unresolved issues.
  if (/\b(?:don't|do not|doesn't|does not) need\b/.test(s)) return found.filter(c => c !== 'owner' && c !== 'date' && c !== 'decision')
  return found
}

const ACTION = '(?:take|own|handle|do|run|send|deliver|finish|complete|prepare|review|check|write|update|follow up|schedule|book|call|ask|share|look into|fix|make sure|draft|set up|sort out|put together|reach out|email|ping|get(?= .+\\bdone\\b))'
const FIRST_PERSON_ACTION = new RegExp(`\\b(?:i'll|i will|we'll|we will|i can|we can) ${ACTION}\\b`)
const NAMED_ACTION = new RegExp(`^\\s*([A-Z][\\p{L}'’\\-]*(?: [A-Z][\\p{L}'’\\-]*)?) (?:will|is going to) ${ACTION}\\b`, 'u')
// A bare calendar word is ambiguous, not an explicit human identity. A full
// name such as "June Park" remains eligible because the whole phrase is tested.
const NOT_NAMES = new RegExp(`^(?:i|we|they|he|she|it|you|this|that|who|what|when|where|why|how|which|whose|nobody|someone|somebody|no one|${WEEKDAY}|${MONTH}|today|tomorrow|tonight|(?:next|this|last) (?:${WEEKDAY}|${MONTH}|week|month|year))$`, 'i')
const TEMPORAL_DO = new RegExp(`\\bdo (?:this|that) (?:today|tomorrow|tonight|(?:(?:next|this) )?(?:afternoon|morning|evening|week|month|year|${WEEKDAY}))\\b`, 'i')
type Undertaking = { owner?: string; due?: string }
function japaneseUndertaking(s: string): boolean {
  return /^(?:(?:私が|私たちが).{0,30})?(?:やります|やっておきます|担当します|引き受けます)[。！!\s]*$/.test(s)
    || /(?:私が|私たちが).{0,30}(?:送ります|確認します|対応します)/.test(s)
    || /までに(?:送ります|完了します|仕上げます)[。！!\s]*$/.test(s)
}
function commitmentIn(raw: string): Undertaking | undefined {
  const s = normal(raw)
  if (/[?？]/.test(s) || /^(?:who|what|when|where|why|how|which|whose)\b/.test(s)
    || hypothetical(s) || /\b(?:might|maybe|perhaps|would|could)\b|たら|かもしれ/.test(s)
    || TEMPORAL_DO.test(s)) return undefined
  // Require an affirmative action, not a question, availability, or future state.
  if (FIRST_PERSON_ACTION.test(s) || /\b(?:i'm on it|i am on it|leave it with me|i've got it|i have got it)\b/.test(s)
    || japaneseUndertaking(s)) return { due: dueIn(raw) }
  const named = NAMED_ACTION.exec(raw)
  if (named && !NOT_NAMES.test(named[1])) return { owner: named[1], due: dueIn(raw) }
  return undefined
}

function isBareDateAnswer(s: string): boolean {
  return new RegExp(`^(?:(?:on|by|before) )?(?:(?:next )?${WEEKDAY}|today|tomorrow|tonight|next (?:week|month))[.!。！]*$`).test(s)
    || new RegExp(`^(?:${JP_DUE.source})(?:です)?[。！!]*$`).test(s)
}
function explicitDeadline(s: string): boolean {
  return /\b(?:due|deadline|date)\b|(?:期限|日程|納期)|までに(?:送ります|完了します|仕上げます)/.test(s)
}
function resolutionsIn(raw: string, commitment?: Undertaking): CueCategory[] {
  const s = normal(raw)
  if (hypothetical(s) || /[?？]/.test(s)) return []
  const out: CueCategory[] = []
  if (commitment || /\b(?:is (?:the owner|responsible)|has an owner|owner is)\b/.test(s)
    && !/\b(?:who|nobody|no one|not|isn't|unassigned|missing|unclear|unknown)\b/.test(s)
    || /担当者?.{0,10}決まりました/.test(s)) out.push('owner')
  // Unmarked "today/tomorrow" is useful commitment metadata, but incidental
  // discussion of the same task on that day does not set its deadline.
  if (dueIn(s) && (isBareDateAnswer(s) || explicitDeadline(s) || DUE.test(s))
    && !/\b(?:not|isn't|can't|cannot|won't|maybe|perhaps|no|which|when|could|might|would)\b|^(?:can|should|shall|is|are|do|does)\b|未定|ではない|決まっていない/.test(s)
    && (subjects(s).length > 0 || isBareDateAnswer(s) || explicitDeadline(s))) out.push('date')
  if (/\b(?:let's go with|let us go with|we (?:have )?(?:decided|chose|selected)|decision is|we'll use|we will use)\b/.test(s)
    || /(?:に決めました|にしましょう|を選びました)/.test(s)) out.push('decision')
  if (/\b(?:unblocked|no longer (?:blocked|stuck)|blocker (?:is |has been )?(?:resolved|removed|fixed)|(?:we|i) can (?:now )?(?:proceed|move forward))\b/.test(s)
    || /(?:解決しました|進められます)/.test(s)) out.push('blocker')
  if (/\b(?:no longer worried|not worried anymore|concern (?:is |was )?resolved)\b/.test(s) || /心配.{0,8}なくなりました/.test(s)) out.push('concern')
  if (/\b(?:i remember now|now i remember|thanks for (?:the reminder|reminding me))\b/.test(s) || /思い出しました/.test(s)) out.push('recall')
  return out
}

const STOP = new Set(('a an the i we you they he she it this that these those is are was were be been being am ' +
  'has have had do does did to of for on in at with and or but by as from our my their your its ' +
  'still need needs needing some someone somebody any who when which what how can could should would will must going ' +
  'not no yet there let us take own handle run do owner ownership responsible missing unclear unassigned ' +
  'date deadline due agreed set ready finish happen deliver complete decide decided decision choose chose selected ' +
  'pending needed undecided unknown blocked blocker blocking stuck held up waiting proceed move forward ' +
  'go use now resolved removed fixed unblocked longer worried concern remember reminder thanks ' +
  'today tomorrow tonight next week month day end eod eow monday tuesday wednesday thursday friday saturday sunday ' +
  'january february march april may june july august september october november december ' +
  'll s t haven don').split(' '))
function subjects(text: string): string[] {
  const expanded = normal(text).replace(/\b[a-z]+n't\b/g, '').replace(/'(?:re|m|ve|ll|d|s)\b/g, '')
  return [...new Set((expanded.match(/[a-z]+/g) ?? []).filter(w => !STOP.has(w)))].sort()
}
function resolutionSubjects(category: CueCategory, clause: string, commitment?: Undertaking): string[] | null {
  if (category === 'owner' && commitment) {
    // Strip the explicit actor and undertaking verb, not the task noun phrase.
    let task = normal(clause)
    if (commitment.owner) task = task.slice(normal(commitment.owner).length).trim()
    const firstPerson = FIRST_PERSON_ACTION.exec(task)
    task = firstPerson ? task.slice(firstPerson.index + firstPerson[0].length).trim()
      : task.replace(new RegExp(`^(?:will|is going to) ${ACTION}\\b`), '').trim()
    // Only explicit acceptance can use the latest-task shortcut. An empty bag
    // of topic words is not evidence: "this or that" also contains only STOPs.
    if (/^(?:it|this|that|ownership)[.!。！]*$/.test(task)
      || new RegExp(`^(?:it|this|that),? and (?:(?:i'll|we'll|will|can) )?${ACTION}\\b`).test(task)
      || /^(?:i'm on it|i am on it|leave it with me|i've got it|i have got it)[.!]*$/.test(normal(clause))) return []
    const due = dueIn(task)
    const tail = task.replace(/^(?:it|this|that)\s+/, '').replace(/[.!]+$/, '')
    if (/^(?:it|this|that)\s+/.test(task) && due
      && [due, `by ${due}`, `before ${due}`, `on ${due}`].includes(tail)) return []
    const words = subjects(task)
    if (words.length) return words
    return japaneseUndertaking(normal(clause)) ? [] : null
  }
  return subjects(clause)
}
function topicIn(clause: string, category: CueCategory): string | undefined {
  const pattern = category === 'owner' ? /\b(?:for|own|handle|run|send|do|take)\s+(.+?)[.!?。！？]*$/i
    : category === 'date' ? /\b(?:date|deadline)\b.*?\bfor\s+(.+?)[.!?。！？]*$/i
      : category === 'blocker' ? /\b(?:blocked (?:on|by)|stuck on|waiting on)\s+(.+?)[.!?。！？]*$/i : null
  const topic = pattern?.exec(clause)?.[1]?.trim()
  // Only a short explicit phrase; ambiguous/long topics keep the generic copy.
  if (!topic || !/^[\p{L}\p{N} -]+$/u.test(topic) || topic.split(/\s+/).length > 5
    || /\b(?:and|or|but|it|this|that)\b/i.test(topic) || subjects(topic).length === 0) return undefined
  return topic
}
function heroText(issue: Issue, lang: 'en' | 'ja'): string {
  const copy = i18n[lang][issue.category]
  if (issue.topic && copy.topicText) {
    const topic = lang === 'ja' ? issue.topic.replace(/^(?:the|a|an) /i, '') : issue.topic
    const text = copy.topicText.replace('{topic}', topic)
    const width = [...text].reduce((n, c) => n + (c.codePointAt(0)! > 0xff ? 2 : 1), 0)
    if (width <= 56) return text
  }
  return copy.text
}
type Issue = { key: string; category: CueCategory; words: string[]; topic?: string; evidence: Cue['evidence']; at: number }
type RatedCue = { category: CueCategory; profile: Profile; rated: boolean }
function copyCue(cue: Cue): Cue { return { ...cue, evidence: { ...cue.evidence } } }

export function createCueEngine(opts: CueEngineOptions): CueEngine {
  let profile = opts.profile
  let wearer: string | null = null
  let focus: string | null = null
  let revision = 0
  let sequence = 0
  let time = -Infinity
  let latestAudioEnd = -Infinity
  let visible: Cue | null = null
  let visibleKey: string | null = null
  let pending: { issues: Issue[]; at: number; revision: number } | null = null
  // Keep only an unrecognized unfinished final prefix (e.g. "We still need").
  // This bridges ASR chunk boundaries without retaining a full transcript.
  let fragment: { seg: Segment; at: number } | null = null
  let lastShown = -Infinity
  const shownAt: number[] = []
  const seen = new Set<string>()
  const issues = new Map<string, Issue>()
  const shownKeys = new Map<string, number>()
  const ratedCues = new Map<string, RatedCue>()
  const savedCommitments: Commitment[] = []
  const commitmentKeys = new Set<string>()
  const listeners = new Set<(event: EngineEvent) => void>()
  const events: EngineEvent[] = []
  let emitting = false
  let ratings = readRatings(opts.store)
  const lang = opts.lang ?? 'en'

  function now(): number {
    const next = opts.now()
    if (Number.isFinite(next)) time = Math.max(time, next)
    if (!Number.isFinite(time)) time = 0
    return time
  }
  function emit(event: EngineEvent): void {
    events.push(event)
    if (emitting) return
    emitting = true
    try {
      while (events.length) {
        const next = events.shift()!
        for (const listener of [...listeners]) {
          try { listener(next.type === 'show' ? { type: 'show', cue: copyCue(next.cue) } : { ...next }) }
          catch { /* One consumer cannot interrupt the rules or other consumers. */ }
        }
      }
    } finally { emitting = false }
  }
  function retract(reason: Extract<EngineEvent, { type: 'retract' }>['reason']): void {
    if (!visible) return
    const cueId = visible.id
    visible = null; visibleKey = null
    emit({ type: 'retract', cueId, reason })
  }
  function persist(): void {
    try { opts.store?.set(CUE_RATINGS_KEY, JSON.stringify({ version: 1, counts: ratings })) }
    catch { /* Keep the in-memory rating even when persistence fails. */ }
  }
  function eligible(issue: Issue): boolean {
    const speaker = issue.evidence.speaker
    if (wearer !== null && speaker === wearer) return false
    if (focus !== null && speaker !== focus) return false
    if (profile === 'listening' && issue.category !== 'concern' && issue.category !== 'recall') return false
    // These two prompts explicitly refer to an individual speaker.
    if (!speaker && (issue.category === 'concern' || issue.category === 'recall')) return false
    return ratings[profile][issue.category].off < 3
  }
  function cleanup(at: number): void {
    while (shownAt.length && shownAt[0] <= at - WINDOW) shownAt.shift()
    for (const [key, value] of shownKeys) if (value <= at - DEDUP) shownKeys.delete(key)
    for (const [key, issue] of issues) if (issue.at <= at - WINDOW) issues.delete(key)
    if (visible && at >= visible.expiresAt) retract('expired')
  }
  function publish(candidates: Issue[], at: number): void {
    if (at - lastShown < COOLDOWN || shownAt.length >= 4) return
    const issue = candidates.find(c => issues.get(c.key) === c && eligible(c) && !shownKeys.has(c.key))
    if (!issue) return
    const copy = i18n[lang][issue.category]
    const cue: Cue = {
      id: `fg-cue-${++sequence}`, category: issue.category, revision,
      text: heroText(issue, lang), why: copy.why, evidence: { ...issue.evidence },
      createdAt: at, expiresAt: at + TTL,
    }
    retract('superseded')
    visible = cue
    visibleKey = issue.key
    lastShown = at
    shownAt.push(at)
    shownKeys.set(issue.key, at)
    ratedCues.set(cue.id, { category: cue.category, profile, rated: false })
    if (ratedCues.size > 128) ratedCues.delete(ratedCues.keys().next().value!)
    emit({ type: 'show', cue })
  }
  function resolve(category: CueCategory, words: string[], speaker?: string): void {
    const scoped = category === 'concern' || category === 'recall'
    const sameCategory = [...issues.values()].filter(i => i.category === category
      && (!scoped || speaker !== undefined && speaker === i.evidence.speaker))
    // Explicit subjects must overlap. Bare "I'll take it" resolves only the
    // most recent issue in that category, never every task in the conversation.
    const matches = words.length
      ? sameCategory.filter(i => i.words.length > 0 && i.words.some(w => words.includes(w)))
      : sameCategory.slice(-1)
    for (const issue of matches) {
      issues.delete(issue.key)
      shownKeys.delete(issue.key)
      if (visibleKey === issue.key) retract('resolved')
    }
  }
  function clearPending(): void { revision++; pending = null }

  const engine: CueEngine = {
    onSegment(seg) {
      if (typeof seg.text !== 'string' || !Number.isFinite(seg.startMs) || !Number.isFinite(seg.endMs)
        || seg.startMs < 0 || seg.endMs < seg.startMs) return
      const at = now()
      cleanup(at)
      // Empty final EOU messages are common in streaming adapters.
      if (!seg.text.trim()) {
        if (seg.isFinal && seg.endOfUtterance) fragment = null
        if (seg.isFinal && seg.endOfUtterance && pending) {
          const candidate = pending
          pending = null
          if (candidate.revision === revision && at - candidate.at <= MAX_PENDING_AGE) publish(candidate.issues, at)
        }
        return
      }
      if (!seg.isFinal) {
        // Never extract commitments, resolve, or display from a revisable partial.
        // New speech cancels a settled-but-not-yet-displayed candidate.
        if (pending && seg.endMs >= latestAudioEnd) clearPending()
        return
      }
      const duplicate = JSON.stringify([seg.startMs, seg.endMs, seg.speaker, seg.text])
      if (seen.has(duplicate)) {
        if (seg.endOfUtterance && pending) {
          const candidate = pending; pending = null
          if (candidate.revision === revision && at - candidate.at <= MAX_PENDING_AGE) publish(candidate.issues, at)
        }
        return
      }
      // A late provider result must not reopen an already-resolved topic.
      if (seg.endMs < latestAudioEnd) return
      seen.add(duplicate)
      if (seen.size > 256) seen.delete(seen.values().next().value!)
      const prefix = fragment
      fragment = null
      if (prefix && prefix.seg.speaker === seg.speaker && seg.startMs >= prefix.seg.endMs
        && seg.startMs - prefix.seg.endMs <= 1500 && at - prefix.at <= MAX_PENDING_AGE
        && prefix.seg.text.length + seg.text.length <= 2000) {
        const separator = lang === 'ja' || /\s$/.test(prefix.seg.text) || /^\s|^[,.;!?]/.test(seg.text) ? '' : ' '
        seg = { ...seg, startMs: prefix.seg.startMs, text: prefix.seg.text + separator + seg.text }
      }
      latestAudioEnd = seg.endMs
      clearPending()
      const label = seg.speaker?.trim()
      const speaker = label && !/^(?:uu|unknown)$/i.test(label) ? label : undefined
      const evidence = { quote: seg.text, speaker, endMs: seg.endMs }
      const candidates: Issue[] = []
      let hadResolution = false
      let hadCommitment = false
      const parts = clauses(seg.text)
      for (const raw of parts) {
        const clause = normal(raw)
        const commitment = commitmentIn(raw)
        if (commitment) {
          hadCommitment = true
          const quote = parts.length === 1 ? seg.text : raw.trim()
          const commitmentKey = JSON.stringify([speaker, normal(quote)])
          if (!commitmentKeys.has(commitmentKey)) {
            commitmentKeys.add(commitmentKey)
            savedCommitments.push({ id: `fg-commitment-${++sequence}`, quote, speaker,
              endMs: seg.endMs, ...commitment })
          }
        }
        const words = subjects(clause)
        const resolved = resolutionsIn(raw, commitment)
        hadResolution ||= resolved.length > 0
        for (const category of categoriesIn(clause).filter(c => !resolved.includes(c))) {
          const scopedSpeaker = category === 'concern' || category === 'recall' ? speaker ?? null : null
          const key = JSON.stringify([category, words.length ? words : [clause], scopedSpeaker])
          const issue: Issue = { key, category, words, topic: topicIn(raw, category), evidence, at }
          issues.set(key, issue)
          candidates.push(issue)
        }
        for (const category of resolved) {
          const resolutionWords = resolutionSubjects(category, clause, commitment)
          if (resolutionWords !== null) resolve(category, resolutionWords, speaker)
        }
      }
      // Avoid unbounded issue metadata during very long sessions.
      while (issues.size > 128) issues.delete(issues.keys().next().value!)
      const surviving = candidates.filter(c => issues.get(c.key) === c && eligible(c))
      if (!hadCommitment && candidates.length === 0 && !hadResolution && !seg.endOfUtterance
        && !/[.!?。！？]\s*$/.test(seg.text)) fragment = { seg: { ...seg }, at }
      if (seg.endOfUtterance === false) {
        if (surviving.length) pending = { issues: surviving, at, revision }
      } else publish(surviving, at)
    },
    tick() {
      const at = now()
      cleanup(at)
      if (pending && at - pending.at >= SETTLE) {
        const candidate = pending; pending = null
        if (candidate.revision === revision && at - candidate.at <= MAX_PENDING_AGE) publish(candidate.issues, at)
      }
    },
    setProfile(p) {
      if (!PROFILES.includes(p) || p === profile) return
      clearPending(); fragment = null; profile = p
      retract('superseded')
    },
    setWearer(speaker) {
      const value = speaker?.trim() || null
      if (value === wearer) return
      clearPending(); fragment = null; wearer = value
      if (visible && visible.evidence.speaker === wearer) retract('superseded')
    },
    setFocus(speaker) {
      const value = speaker?.trim() || null
      if (value === focus) return
      clearPending(); fragment = null; focus = value
      if (visible && focus !== null && visible.evidence.speaker !== focus) retract('superseded')
    },
    rate(cueId, rating) {
      const cue = ratedCues.get(cueId)
      if (!cue || cue.rated || (rating !== 'useful' && rating !== 'off')) return
      cue.rated = true
      ratings[cue.profile][cue.category][rating]++
      persist()
      if (ratings[cue.profile][cue.category].off >= 3 && profile === cue.profile) {
        if (pending) pending.issues = pending.issues.filter(i => i.category !== cue.category)
        if (visible?.category === cue.category) retract('muted')
      }
    },
    dismiss(cueId) { if (visible?.id === cueId) retract('superseded') },
    commitments() { return savedCommitments.map(c => ({ ...c })) },
    reset() {
      clearPending(); fragment = null; wearer = null; focus = null; latestAudioEnd = -Infinity
      issues.clear(); shownKeys.clear(); seen.clear(); ratedCues.clear()
      savedCommitments.length = 0; commitmentKeys.clear()
      retract('reset')
      // Cooldown/rolling cap survive reset so restarting cannot bypass them.
    },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  ratingResets.set(engine, p => {
    if (p !== undefined && !PROFILES.includes(p)) return
    if (p) ratings[p] = emptyRatings()[p]
    else ratings = emptyRatings()
    persist()
    // Unmuting never resurfaces an old candidate; wait for fresh speech.
    clearPending()
  })
  return engine
}
