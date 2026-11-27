// Offline contract/replay tests. The real pure TypeScript engine runs in a VM
// without DOM, SDK, network, localStorage, or timers; all time/storage is injected.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

let ts
try { ts = createRequire(import.meta.url)('typescript') }
catch { ts = createRequire(new URL('../../../server/package.json', import.meta.url))('typescript') }
const source = readFileSync(new URL('./cue-engine.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
} }).outputText
const context = vm.createContext({ exports: {} })
vm.runInContext(compiled, context)
const { createCueEngine, resetCueRatings, CUE_RATINGS_KEY } = context.exports
const plain = value => JSON.parse(JSON.stringify(value))
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/conversations.json', import.meta.url), 'utf8'))

function storage(initial) {
  const map = new Map(initial ? [[CUE_RATINGS_KEY, initial]] : [])
  const writes = []
  return { map, writes, get: key => map.get(key) ?? null, set(key, value) { writes.push([key, value]); map.set(key, value) } }
}
function harness(options = {}) {
  let time = 0
  const events = []
  const engine = createCueEngine({ profile: 'work', now: () => time, ...options })
  engine.on(event => events.push(plain(event)))
  const h = {
    engine, events,
    at(at) { time = at; return h },
    say(text, overrides = {}) {
      engine.onSegment({ text, isFinal: true, speaker: 'S2', startMs: time, endMs: time, ...overrides })
      return h
    },
    tick() { engine.tick(); return h },
    shows: () => events.filter(e => e.type === 'show'),
    retracts: () => events.filter(e => e.type === 'retract'),
    last: () => events.filter(e => e.type === 'show').at(-1)?.cue,
  }
  return h
}

for (const fixture of fixtures) test(`replay: ${fixture.name}`, () => {
  const h = harness({ profile: fixture.profile, lang: fixture.lang })
  if (fixture.wearer) h.engine.setWearer(fixture.wearer)
  if (fixture.focus) h.engine.setFocus(fixture.focus)
  for (const step of fixture.steps) {
    h.at(step.at).say(step.text, { ...step, speaker: step.speaker })
  }
  assert.deepEqual(h.shows().map(e => e.cue.category), fixture.shows)
  assert.deepEqual(h.retracts().map(e => e.reason), fixture.retracts)
  assert.deepEqual(plain(h.engine.commitments()).map(c => c.quote), fixture.commitments)
  let visible
  for (const e of h.events) {
    if (e.type === 'show') { assert.equal(visible, undefined); visible = e.cue.id }
    else { assert.equal(e.cueId, visible); visible = undefined }
  }
})

test('final evidence and injected-clock TTL are exact', () => {
  const h = harness().at(100_000).say('We need somebody for the network check.', { startMs: 800, endMs: 1900 })
  const c = h.last()
  assert.equal(c.createdAt, 100_000)
  assert.equal(c.expiresAt, 120_000)
  assert.equal(c.evidence.endMs, 1900)
  assert.equal(c.evidence.quote, 'We need somebody for the network check.')
  h.at(119_999).tick()
  assert.equal(h.retracts().length, 0)
  h.at(120_000).tick().tick()
  assert.deepEqual(h.retracts(), [{ type: 'retract', cueId: c.id, reason: 'expired' }])
})

test('interims neither publish, resolve, nor create commitments', () => {
  const h = harness().say('We need somebody for the network check.', { isFinal: false })
  h.at(1000).tick()
  assert.equal(h.shows().length, 0)
  h.say('We need somebody for the network check.')
  h.at(1500).say("I'll take it.", { isFinal: false })
  assert.equal(h.retracts().length, 0)
  assert.equal(h.engine.commitments().length, 0)
  h.at(2000).say("I'll take it.")
  assert.equal(h.retracts()[0].reason, 'resolved')
  assert.equal(h.engine.commitments().length, 1)
})

test('an explicitly unfinished final waits for EOU, including empty EOU', () => {
  const h = harness().say('We need somebody for the network check.', { endOfUtterance: false })
  assert.equal(h.shows().length, 0)
  h.at(100).say('', { endOfUtterance: true })
  assert.equal(h.shows().length, 1)
  assert.equal(h.last().createdAt, 100)
})

test('a repeated final carrying EOU flushes only once', () => {
  const h = harness().say('We need somebody for the network check.', { endOfUtterance: false })
  h.at(100).say('We need somebody for the network check.', { startMs: 0, endMs: 0, endOfUtterance: true })
  h.at(200).say('We need somebody for the network check.', { startMs: 0, endMs: 0, endOfUtterance: true })
  assert.equal(h.shows().length, 1)
})

test('settling fallback is bounded and new speech cancels pending cues', () => {
  const h = harness().say('We need somebody for the network check.', { endOfUtterance: false })
  h.at(349).tick()
  assert.equal(h.shows().length, 0)
  h.at(350).tick()
  assert.equal(h.shows().length, 1)
  const next = harness().say('We need somebody for the network check.', { endOfUtterance: false })
  next.at(100).say("I'll take", { isFinal: false })
  next.at(350).tick()
  assert.equal(next.shows().length, 0)
  next.at(500).say("I'll take it.")
  assert.equal(next.shows().length, 0)
})

test('split finals can resolve an issue before EOU', () => {
  const h = harness().say('We need somebody for the network check.', { endOfUtterance: false })
  h.at(200).say("I'll take it.", { endOfUtterance: true })
  assert.equal(h.shows().length, 0)
  assert.equal(h.engine.commitments().length, 1)
})

test('unfinished final prefixes bridge ASR chunks without using interims', () => {
  const h = harness().say('We still need', { endOfUtterance: false })
  h.at(100).say('somebody for the network check.', { endOfUtterance: true })
  assert.equal(h.last()?.category, 'owner')
  assert.equal(h.last().evidence.quote, 'We still need somebody for the network check.')
  const c = harness().say("I'll", { endOfUtterance: false })
  c.at(100).say('send the report by Friday.', { endOfUtterance: true })
  assert.equal(c.engine.commitments()[0]?.quote, "I'll send the report by Friday.")
})

test('unfinished prefixes cannot cross speakers, resets, or long silences', () => {
  for (const change of [h => h.engine.reset(), h => h.engine.setProfile('everyday'), h => h.at(3000)]) {
    const h = harness().say("I'll", { endOfUtterance: false })
    change(h)
    h.say('send the report by Friday.')
    assert.equal(h.engine.commitments().length, 0)
  }
  const h = harness().say("I'll", { endOfUtterance: false })
  h.at(100).say('send the report by Friday.', { speaker: 'S3' })
  assert.equal(h.engine.commitments().length, 0)
})

test('a suspended clock cannot publish a stale pending cue on resume', () => {
  for (const finish of [h => h.tick(), h => h.say('', { endOfUtterance: true }),
    h => h.say('We need somebody for alpha.', { startMs: 0, endMs: 0, endOfUtterance: true })]) {
    const h = harness().say('We need somebody for alpha.', { endOfUtterance: false })
    h.at(20_000)
    finish(h)
    assert.equal(h.shows().length, 0)
  }
})

test('a 30-second cooldown includes dismissed and expired cues', () => {
  const h = harness().say('We need somebody for alpha.')
  h.engine.dismiss(h.last().id)
  h.at(29_999).say('There is no deadline for beta.')
  assert.equal(h.shows().length, 1)
  h.at(30_000).say('We are blocked on gamma.')
  assert.equal(h.shows().length, 2)
  h.at(60_000).say('We need somebody for delta.')
  assert.equal(h.shows().length, 3)
})

test('four automatic cues per rolling ten minutes, inclusive expiry boundary', () => {
  const h = harness()
  for (const [i, name] of ['alpha', 'beta', 'gamma', 'delta'].entries()) h.at(i * 30_000).say(`We need somebody for ${name}.`)
  h.at(120_000).say('We need somebody for epsilon.')
  h.at(599_999).say('We need somebody for zeta.')
  assert.equal(h.shows().length, 4)
  h.at(600_000).say('We need somebody for eta.')
  assert.equal(h.shows().length, 5)
})

test('throttled candidates do not appear later without fresh speech', () => {
  const h = harness().say('We need somebody for alpha.')
  h.at(1000).say('We need somebody for beta.')
  h.at(30_000).tick()
  assert.equal(h.shows().length, 1)
})

test('same unresolved subject deduplicates across speakers', () => {
  const h = harness().say('We need somebody for the network check.')
  h.at(30_000).say('We still need someone for the network check.', { speaker: 'S3' })
  assert.equal(h.shows().length, 1)
})

test('a repeated issue can still retract its original visible cue', () => {
  const h = harness().say('We need somebody for the network check.')
  h.at(1000).say('We still need someone for the network check.', { speaker: 'S3' })
  h.at(2000).say("I'll take the network check.")
  assert.equal(h.retracts()[0]?.reason, 'resolved')
})

test('unrelated subjects do not resolve an open issue', () => {
  const h = harness().say('We need somebody for the network check.')
  h.at(1000).say("I'll take the design review.")
  assert.equal(h.retracts().length, 0)
  h.at(2000).say("I'll take the network check.")
  assert.equal(h.retracts()[0]?.reason, 'resolved')
})

test('negative and hypothetical answers do not resolve an issue', () => {
  const h = harness().say('There is no deadline for the report.')
  h.at(1000).say('It is not due Friday.')
  h.at(2000).say('Maybe by Friday.')
  h.at(3000).say('If it is due Friday, we can manage.')
  h.at(3100).say('Can we finish by Friday?')
  h.at(3200).say('Should it be due Friday?')
  h.at(3300).say('Is it due Friday?')
  assert.equal(h.retracts().length, 0)
  h.at(4000).say('It is due Friday.')
  assert.equal(h.retracts()[0].reason, 'resolved')
})

test('explicit deadline statements resolve, and commitments retain relative date wording', () => {
  const h = harness().say('There is no deadline for alpha.')
  h.at(1000).say('The deadline is Friday.')
  assert.equal(h.retracts()[0]?.reason, 'resolved')
  h.at(2000).say("I'll deliver the report by next week.")
  assert.equal(h.engine.commitments()[0].due, 'next week')
})

test('owner questions/missing ownership are not mistaken for resolutions', () => {
  for (const text of ['Who will own the network check?', 'The owner is missing for the network check.']) {
    const h = harness().say(text)
    assert.equal(h.last()?.category, 'owner')
    h.at(1000).say('Nobody will own the network check.')
    assert.equal(h.retracts().length, 0)
    h.at(2000).say('Alex will own the network check.')
    assert.equal(h.retracts()[0]?.reason, 'resolved')
  }
})

test('common missing-owner, deadline and decision formulations are covered', () => {
  for (const [text, category] of [
    ["We still don't have an owner for the rollout.", 'owner'],
    ['We are without an owner for the rollout.', 'owner'],
    ['Who is going to handle the rollout?', 'owner'],
    ["The deadline hasn't been set for the rollout.", 'date'],
    ["We haven't made a decision on the rollout.", 'decision'],
  ]) assert.equal(harness().say(text).last()?.category, category, text)
})

test('another speaker cannot resolve a personal recall or concern', () => {
  for (const [open, answer] of [
    ['Remind me what we agreed.', 'I remember now.'],
    ["I'm worried about the change.", 'My concern is resolved.'],
  ]) {
    const h = harness({ profile: 'listening' }).say(open)
    h.at(1000).say(answer, { speaker: 'S3' })
    h.at(2000).say(answer, { speaker: undefined })
    assert.equal(h.retracts().length, 0)
    h.at(3000).say(answer)
    assert.equal(h.retracts()[0]?.reason, 'resolved')
  }
})

test('a late transcript cannot resurrect a resolved topic', () => {
  const h = harness().say('We need somebody for alpha.', { startMs: 0, endMs: 1000 })
  h.at(2000).say("I'll take it.", { startMs: 1000, endMs: 2000 })
  h.at(35_000).say('We need somebody for alpha.', { startMs: 500, endMs: 1500 })
  assert.equal(h.shows().length, 1)
  assert.equal(h.retracts()[0].reason, 'resolved')
})

test('duplicate transcript deliveries are idempotent beyond cooldown', () => {
  const h = harness().say('We need somebody for alpha.')
  h.at(180_000).say('We need somebody for alpha.', { startMs: 0, endMs: 0 })
  assert.equal(h.shows().length, 1)
})

test('wearer turns never cue but still capture commitments and resolve', () => {
  const h = harness()
  h.engine.setWearer('S1')
  h.say('We need somebody for alpha.', { speaker: 'S1' })
  assert.equal(h.shows().length, 0)
  h.at(1000).say('We need somebody for beta.')
  h.at(2000).say("I'll take it.", { speaker: 'S1' })
  assert.equal(h.retracts()[0].reason, 'resolved')
  assert.equal(h.engine.commitments()[0].speaker, 'S1')
})

test('unknown speaker permits unattributed work questions only', () => {
  const h = harness().say('We need somebody for alpha.', { speaker: undefined })
  assert.equal(h.shows().length, 1)
  assert.equal(h.last().evidence.speaker, undefined)
  for (const speaker of [undefined, '', 'UU', 'unknown']) {
    const a = harness({ profile: 'listening' }).say("I'm worried about the change.", { speaker })
    assert.equal(a.shows().length, 0)
  }
})

test('focus and wearer corrections retract ineligible visible cues', () => {
  const h = harness().say('We need somebody for alpha.')
  h.engine.setFocus('S3')
  assert.equal(h.retracts()[0].reason, 'superseded')
  h.at(30_000).say('We need somebody for beta.')
  assert.equal(h.shows().length, 1)
  h.engine.setFocus(null)
  h.say('We need somebody for gamma.', { endMs: 30_001 })
  h.engine.setWearer('S2')
  assert.equal(h.retracts().at(-1).reason, 'superseded')
})

test('profile/focus/wearer changes invalidate pending finals', () => {
  for (const change of [e => e.setProfile('listening'), e => e.setFocus('S3'), e => e.setWearer('S2')]) {
    const h = harness().say('We need somebody for alpha.', { endOfUtterance: false })
    change(h.engine)
    h.at(1000).tick()
    assert.equal(h.shows().length, 0)
  }
})

test('three distinct off-target ratings persist profile/category mute; repeats do not', () => {
  const store = storage()
  const h = harness({ store })
  for (const [i, name] of ['alpha', 'beta', 'gamma'].entries()) {
    h.at(i * 30_000).say(`We need somebody for ${name}.`)
    h.engine.rate(h.last().id, 'off')
    h.engine.rate(h.last().id, 'off')
  }
  assert.equal(h.retracts().at(-1).reason, 'muted')
  h.at(90_000).say('We need somebody for delta.')
  assert.equal(h.shows().length, 3)
  const persisted = JSON.parse(store.get(CUE_RATINGS_KEY))
  assert.equal(persisted.counts.work.owner.off, 3)
  assert.equal(store.writes.length, 3)
  const restored = harness({ store }).say('We need somebody for epsilon.')
  assert.equal(restored.shows().length, 0)
  restored.say('There is no deadline for epsilon.', { endMs: 1 })
  assert.equal(restored.last().category, 'date')
  const everyday = harness({ store, profile: 'everyday' }).say('We need somebody for zeta.')
  assert.equal(everyday.shows().length, 1)
})

test('useful and off-target counters contain no quotes, voices, or people', () => {
  const store = storage()
  const h = harness({ store }).say('We need somebody for confidential-alpha.', { speaker: 'private-speaker' })
  h.engine.rate(h.last().id, 'useful')
  h.engine.rate('unknown', 'off')
  const saved = store.get(CUE_RATINGS_KEY)
  assert.equal(JSON.parse(saved).counts.work.owner.useful, 1)
  assert.doesNotMatch(saved, /confidential|private-speaker|quote|speaker|endMs|fg-cue/)
})

test('late ratings belong to the profile at display, even after dismissal', () => {
  const store = storage()
  const h = harness({ store }).say('We need somebody for alpha.')
  const id = h.last().id
  h.engine.dismiss(id)
  h.engine.setProfile('listening')
  h.engine.rate(id, 'off')
  const counts = JSON.parse(store.get(CUE_RATINGS_KEY)).counts
  assert.equal(counts.work.owner.off, 1)
  assert.equal(counts.listening.owner.off, 0)
})

test('explicit rating reset unmutes, persists, and never republishes old speech', () => {
  const store = storage()
  const h = harness({ store })
  for (const [i, name] of ['alpha', 'beta', 'gamma'].entries()) {
    h.at(i * 30_000).say(`We need somebody for ${name}.`)
    h.engine.rate(h.last().id, 'off')
  }
  resetCueRatings(h.engine, 'work')
  h.at(90_000).tick()
  assert.equal(h.shows().length, 3)
  h.say('We need somebody for delta.')
  assert.equal(h.shows().length, 4)
  assert.equal(JSON.parse(store.get(CUE_RATINGS_KEY)).counts.work.owner.off, 0)
  resetCueRatings(h.engine)
  assert.equal(harness({ store }).say('We need somebody for epsilon.').shows().length, 1)
})

test('malformed, version-mismatched, and unavailable rating stores do not break cues', () => {
  const stores = [storage('{'), storage('{"version":2}'), storage('{"version":1,"counts":{"work":{"owner":{"off":-3,"useful":"bad"}}}}'),
    { get() { throw new Error('read disabled') }, set() { throw new Error('write disabled') } }]
  for (const store of stores) {
    const h = harness({ store }).say('We need somebody for alpha.')
    assert.equal(h.shows().length, 1)
    assert.doesNotThrow(() => h.engine.rate(h.last().id, 'off'))
  }
})

test('reset clears conversation memory and mappings but preserves cooldown and learning', () => {
  const store = storage()
  const h = harness({ store })
  h.engine.setWearer('S1'); h.engine.setFocus('S2')
  h.say('We need somebody for alpha.')
  const id = h.last().id
  h.engine.rate(id, 'off')
  h.at(1000).say("I'll send the notes by Friday.", { speaker: 'S1' })
  assert.equal(h.engine.commitments().length, 1)
  h.engine.reset()
  assert.equal(h.engine.commitments().length, 0)
  assert.equal(h.retracts().at(-1).reason, 'reset')
  h.at(2000).say('We need somebody for alpha.', { speaker: 'S1', startMs: 0, endMs: 0 })
  assert.equal(h.shows().length, 1)
  h.at(30_000).say('We need somebody for alpha.', { speaker: 'S1', startMs: 1000, endMs: 1000 })
  assert.equal(h.shows().length, 2)
  assert.notEqual(h.last().id, id)
  assert.equal(JSON.parse(store.get(CUE_RATINGS_KEY)).counts.work.owner.off, 1)
})

test('reset cannot bypass the rolling four-cue limit', () => {
  const h = harness()
  for (let i = 0; i < 4; i++) {
    h.at(i * 30_000).say('We need somebody for alpha.')
    h.engine.reset()
  }
  h.at(120_000).say('We need somebody for alpha.')
  assert.equal(h.shows().length, 4)
})

test('commitments preserve exact quotes, explicit owners/dates, and unknown identity', () => {
  const h = harness()
  const quote = '  I’ll send the   report by Friday.  '
  h.say(quote, { speaker: undefined })
  h.at(1000).say('Alex will prepare the review by Monday.')
  const commitments = plain(h.engine.commitments())
  assert.equal(commitments[0].quote, quote)
  assert.equal(commitments[0].owner, undefined)
  assert.equal(commitments[0].speaker, undefined)
  assert.equal(commitments[0].due, 'Friday')
  assert.equal(commitments[1].owner, 'Alex')
  assert.equal(commitments[1].due, 'Monday')
})

test('conditional, negative, and non-action future speech is not a commitment', () => {
  const h = harness()
  for (const [i, text] of ["I won't send the report.", 'I will not send the report.',
    "Maybe I'll send the report.", "If it helps, I'll send the report.", "I'll be tired tomorrow.",
    'The example says "I will send the report".'].entries()) h.at(i * 1000).say(text)
  assert.equal(h.engine.commitments().length, 0)
})

test('commitment repetitions deduplicate and callers cannot mutate engine memory', () => {
  const h = harness().say("I'll send the report by Friday.")
  h.at(1000).say("I'll send the report by Friday.")
  assert.equal(h.engine.commitments().length, 1)
  const saved = h.engine.commitments()
  saved[0].quote = 'changed'
  saved.push({ id: 'fake', quote: 'fake', endMs: 1 })
  assert.equal(h.engine.commitments().length, 1)
  assert.equal(h.engine.commitments()[0].quote, "I'll send the report by Friday.")
})

test('listener errors/mutations are isolated and unsubscription works', () => {
  const h = harness()
  const bad = h.engine.on(e => { if (e.type === 'show') e.cue.evidence.quote = 'changed'; throw new Error('consumer') })
  const received = []
  const off = h.engine.on(e => received.push(plain(e)))
  h.say('We need somebody for alpha.')
  assert.equal(received[0].cue.evidence.quote, 'We need somebody for alpha.')
  bad(); off()
  h.engine.dismiss(h.last().id)
  assert.equal(received.length, 1)
})

test('reentrant consumer reset delivers show before retract to every subscriber', () => {
  const h = harness()
  h.engine.on(e => { if (e.type === 'show') h.engine.reset() })
  const received = []
  h.engine.on(e => received.push(e.type))
  h.say('We need somebody for alpha.')
  assert.deepEqual(received, ['show', 'retract'])
})

test('all localized heroes/why lines fit the lens grid', () => {
  const samples = ['We need somebody for alpha.', 'There is no deadline for alpha.',
    "We haven't decided between alpha and beta.", 'We are blocked on alpha.',
    "I'm worried about alpha.", 'Remind me what we agreed about alpha.']
  const width = s => [...s].reduce((n, c) => n + (c.codePointAt(0) > 0xff ? 2 : 1), 0)
  for (const lang of ['en', 'ja']) for (const text of samples) {
    const h = harness({ lang }).say(text)
    const cue = h.last()
    assert.ok(cue, `${lang}: ${text}`)
    assert.ok(width(cue.text) <= 56, cue.text)
    assert.ok(cue.why.split('\n').length <= 2)
    for (const line of cue.why.split('\n')) assert.ok(width(line) <= 56, line)
    assert.doesNotMatch(cue.text + cue.why, /confidence|confident|probably|\d+%/i)
  }
})

test('invalid timing and blank text cannot create cues', () => {
  const h = harness()
  for (const times of [{ startMs: -1, endMs: 0 }, { startMs: 100, endMs: 50 },
    { startMs: NaN, endMs: 100 }, { startMs: 0, endMs: Infinity }]) h.say('We need somebody for alpha.', times)
  h.say('   ')
  assert.equal(h.shows().length, 0)
})

test('backwards injected clocks do not bypass cooldown', () => {
  const h = harness().at(10_000).say('We need somebody for alpha.')
  h.at(-100_000).say('We need somebody for beta.', { startMs: 11_000, endMs: 11_000 })
  h.at(39_999).say('We need somebody for gamma.', { startMs: 12_000, endMs: 12_000 })
  assert.equal(h.shows().length, 1)
  h.at(40_000).say('We need somebody for delta.', { startMs: 13_000, endMs: 13_000 })
  assert.equal(h.shows().length, 2)
})

// Fix round 1: reviewer-provided utterances, with positive and unrelated controls.
test('review: owner questions never become commitments or resolve themselves', () => {
  for (const text of ['Who will send the deck?', 'Who will run the network check?',
    'Who will own the network check?', 'Who is going to own the network check?',
    'What will send the deck?', 'When will send the deck?', 'Where will send the deck?',
    'Why will send the deck?', 'How will send the deck?', 'Which will send the deck?',
    'Whose will send the deck?', 'Alex will send the notes?', "I'll take it?"]) {
    const h = harness().say(text)
    assert.equal(h.engine.commitments().length, 0, text)
    if (/^Who\b/.test(text)) assert.equal(h.last()?.category, 'owner', text)
  }
  const h = harness().say('Alex will send the notes.')
  assert.equal(h.engine.commitments()[0]?.owner, 'Alex')
})

test('review: named undertakings resolve matching and bare-pronoun owner answers', () => {
  for (const text of ['Priya will handle it.', 'Dana will run the network check by Thursday.',
    'Alex is going to send the network check.', 'Priya will handle that and send the results.']) {
    const h = harness().say('We still need somebody for the network check.')
    h.at(1000).say(text, { speaker: 'S3' })
    assert.equal(h.retracts()[0]?.reason, 'resolved', text)
    assert.ok(h.engine.commitments()[0]?.owner, text)
  }
  const h = harness().say('We need somebody for the network check.')
  h.at(1000).say('Priya will handle the design review.')
  assert.equal(h.retracts().length, 0)
})

test('review: contraction fragments cannot connect unrelated blocker topics', () => {
  for (const [issue, answer] of [
    ["We're blocked on billing.", "We're unblocked on auth now."],
    ["I'm blocked on billing.", "I'm unblocked on auth now."],
    ["Billing isn't ready, we're blocked on billing.", "Auth isn't broken, we're unblocked on auth now."],
    ["We've been blocked on billing.", "We've been unblocked on auth now."],
    ["We won't finish billing, we're blocked on billing.", "We won't need auth, we're unblocked on auth now."],
    ["We didn't finish billing, we're blocked on billing.", "We didn't need auth, we're unblocked on auth now."],
    ["Billing doesn't work, we're blocked on billing.", "Auth doesn't fail, we're unblocked on auth now."],
    ["Billing wasn't ready, we're blocked on billing.", "Auth wasn't broken, we're unblocked on auth now."],
    ["Billing checks aren't ready, we're blocked on billing.", "Auth tests aren't broken, we're unblocked on auth now."],
  ]) {
    const h = harness().say(issue)
    assert.equal(h.last()?.category, 'blocker', issue)
    h.at(3000).say(answer)
    assert.equal(h.retracts().length, 0, answer)
    h.at(4000).say("We're unblocked on billing now.")
    assert.equal(h.retracts()[0]?.reason, 'resolved', issue)
  }
})

test('review: scheduling and personal small talk do not consume blocker slots', () => {
  for (const text of ['I blocked my calendar from two to three.', 'We are stuck in conference room B.',
    'I am waiting on hold with the vendor.', "I'm waiting on my coffee.", 'I got stuck in traffic this morning.']) {
    const h = harness().say(text)
    assert.equal(h.shows().length, 0, text)
    h.at(1000).say('We are blocked on alpha.')
    assert.equal(h.last()?.category, 'blocker', text)
  }
  for (const text of ['We are blocked on alpha.', 'We are blocked by the API review.',
    'We are stuck on the API review.', 'I am waiting on design for the empty state.', 'There is a blocker for alpha.']) {
    assert.equal(harness().say(text).last()?.category, 'blocker', text)
  }
})

test('review: temporal availability is not a bare task acceptance', () => {
  for (const time of ['afternoon', 'morning', 'evening', 'tonight', 'Friday', 'week']) {
    const h = harness().say('We need somebody for the network check.')
    h.at(1000).say(`I can do this ${time}.`)
    assert.equal(h.retracts().length, 0, time)
    assert.equal(h.engine.commitments().length, 0, time)
  }
  for (const text of ['I can do this.', "I'll take it.", "I'll take it and send the results by Friday."]) {
    const h = harness().say('We need somebody for the network check.')
    h.at(1000).say(text)
    assert.equal(h.retracts()[0]?.reason, 'resolved', text)
    assert.equal(h.engine.commitments().length, 1, text)
  }
})

test('review: empty date subjects need a bare answer or explicit deadline', () => {
  for (const [issue, answer] of [
    ['There is no deadline for the launch.', "It's on Friday."],
    ['There is no deadline for the launch.', 'It is on Friday.'],
    ['期限が未定です。', '今日は移動します。'],
    ['期限が未定です。', '今日の天気はいいです。'],
    ['期限が未定です。', '明日は休みです。'],
    ['期限が未定です。', '来週は旅行です。'],
  ]) {
    const h = harness().say(issue)
    h.at(1000).say(answer)
    assert.equal(h.retracts().length, 0, answer)
  }
  for (const text of ['Friday.', 'On Friday.', 'The deadline is Friday.', 'It is due Friday.',
    'The launch should be on Friday.', "Let's launch on Friday."]) {
    const h = harness().say('There is no deadline for the launch.')
    h.at(1000).say(text)
    assert.equal(h.retracts()[0]?.reason, 'resolved', text)
  }
  for (const text of ['金曜日です。', '金曜日までに送ります。', '期限は明日です。']) {
    const h = harness({ lang: 'ja' }).say('期限が未定です。')
    h.at(1000).say(text)
    assert.equal(h.retracts()[0]?.reason, 'resolved', text)
  }
})

test('review: incidental negation does not block an affirmative owner or date answer', () => {
  const h = harness().say('We need somebody for the network check.')
  h.at(1000).say("Not a problem, I'll take it.")
  assert.equal(h.retracts()[0]?.reason, 'resolved')
  for (const text of ["I won't take it.", 'I will not take it.', "I can't take it.",
    'Nobody will own the network check.', 'Priya will not handle it.']) {
    const n = harness().say('We need somebody for the network check.')
    n.at(1000).say(text)
    assert.equal(n.retracts().length, 0, text)
    assert.equal(n.engine.commitments().length, 0, text)
  }
  for (const text of ['The launch should not be on Friday.', 'The launch is not on Friday.',
    'Maybe the launch is on Friday.', 'When is the launch due Friday?', 'Is the launch due Friday?']) {
    const n = harness().say('There is no deadline for the launch.')
    n.at(1000).say(text)
    assert.equal(n.retracts().length, 0, text)
  }
})

test('review: common explicit undertakings appear in commitment review', () => {
  for (const text of ["I'll get the report done by Friday.", "I'll look into it tomorrow.", "I'm on it.",
    "I'll fix the build.", "I'll make sure the build passes.", "I'll draft the notes.", "I'll set up the call.",
    "I'll sort out the build.", "I'll put together the slides.", "I'll reach out to Alex.",
    "I'll email Alex.", "I'll ping Alex.", 'Leave it with me.', "I've got it.", 'やります。', 'やっておきます。']) {
    const c = harness().say(text).engine.commitments()
    assert.equal(c.length, 1, text)
    assert.equal(c[0].quote, text)
  }
  assert.equal(harness().say("I'll look into it tomorrow.").engine.commitments()[0]?.due, 'tomorrow')
  for (const text of ["Maybe I'll fix the build.", "I'll get tired tomorrow.", "I'm on it?", 'やりますか？']) {
    assert.equal(harness().say(text).engine.commitments().length, 0, text)
  }
})

test('review: each undertaking keeps its own verbatim clause and date', () => {
  const h = harness().say('I’ll send the notes. Lunch is on Friday.')
  let cs = plain(h.engine.commitments())
  assert.equal(cs.length, 1)
  assert.equal(cs[0].quote, 'I’ll send the notes.')
  assert.equal(cs[0].due, undefined)
  const multi = harness().say('I’ll send the notes by Friday. Alex will write the spec.')
  cs = plain(multi.engine.commitments())
  assert.equal(cs.length, 2)
  assert.equal(cs[0].quote, 'I’ll send the notes by Friday.')
  assert.equal(cs[0].due, 'Friday')
  assert.equal(cs[0].owner, undefined)
  assert.equal(cs[1].quote, 'Alex will write the spec.')
  assert.equal(cs[1].owner, 'Alex')
  assert.equal(cs[1].due, undefined)
  multi.at(1000).say('Alex will write the spec.')
  assert.equal(multi.engine.commitments().length, 2)
  assert.equal(harness().say('I’ll deliver the report by next week.').engine.commitments()[0]?.due, 'next week')
})

test('review: common owner question and suggestion wordings produce an owner cue', () => {
  for (const text of ["Who's going to own the network check?", 'Somebody should own the network check.',
    'Someone should handle the rollout.', 'Who is going to handle the rollout?', 'Who will send the deck?']) {
    const h = harness().say(text)
    assert.equal(h.last()?.category, 'owner', text)
    assert.equal(h.engine.commitments().length, 0, text)
  }
})

test('review: short explicit task topics appear in localized heroes within the grid', () => {
  for (const lang of ['en', 'ja']) for (const [text, topic] of [
    ['We need somebody for the network check.', 'network check'],
    ['There is no deadline for the launch.', 'launch'],
    ['We are blocked on the API review.', 'API review'],
  ]) {
    const cue = harness({ lang }).say(text).last()
    assert.ok(cue.text.toLowerCase().includes(topic.toLowerCase()), cue.text)
    assert.ok([...cue.text].reduce((n, c) => n + (c.codePointAt(0) > 0xff ? 2 : 1), 0) <= 56, cue.text)
  }
  const long = harness().say(`We need somebody for the ${'extraordinarilylong'.repeat(5)} migration.`).last()
  assert.equal(long.text, 'Who will take ownership?')
  assert.equal(harness().say('We need somebody.').last().text, 'Who will take ownership?')
})

test('review: punctuation-free questions stay out of commitments', () => {
  for (const text of ['Who will send the deck', 'Who is going to own the network check',
    'When I will send the deck', 'What I will send tomorrow']) {
    assert.equal(harness().say(text).engine.commitments().length, 0, text)
  }
})

test('review: contrasting clauses preserve an unresolved blocker', () => {
  const h = harness().say("We are blocked on billing, but we're unblocked on auth.")
  assert.equal(h.last()?.category, 'blocker')
  h.at(1000).say("We're unblocked on billing now.")
  assert.equal(h.retracts()[0]?.reason, 'resolved')
})

// Fix round 2: re-check findings and controls for the empty-subject shortcut.
test('round 2: relative availability never accepts the latest owner issue', () => {
  for (const actor of ['I can', 'We can', 'Priya will']) for (const pronoun of ['this', 'that']) {
    for (const time of ['today', 'tomorrow', 'tonight', 'next week', 'next month', 'next Friday', 'next year']) {
      const text = `${actor} do ${pronoun} ${time}.`
      const h = harness().say('We need somebody for the network check.')
      h.at(1000).say(text, { speaker: 'S3' })
      assert.equal(h.retracts().length, 0, text)
      assert.equal(h.engine.commitments().length, 0, text)
    }
  }
  for (const text of ['I can do this.', 'I can do that.', "I'll take it.",
    "I'll take it by Friday.", "I'll take it tomorrow.", 'Priya will handle it.',
    "I'll take it and send the results by Friday."]) {
    const h = harness().say('We need somebody for the network check.')
    h.at(1000).say(text)
    assert.equal(h.retracts()[0]?.reason, 'resolved', text)
    assert.equal(h.engine.commitments().length, 1, text)
  }
})

test('round 2: removing only stop words does not imply a bare owner acceptance', () => {
  for (const text of ['I can do this or that.', 'I can do this and that.', 'Priya will handle this or that.',
    "I'll take Friday.", 'I can run tomorrow.']) {
    const h = harness().say('We need somebody for the network check.')
    h.at(1000).say(text)
    assert.equal(h.retracts().length, 0, text)
  }
  const jp = harness({ lang: 'ja' }).say('担当者が未定です。')
  jp.at(1000).say('私が担当します。')
  assert.equal(jp.retracts()[0]?.reason, 'resolved')
})

test('round 2: incidental relative dates do not set a task deadline', () => {
  for (const text of ['I read the report today.', 'The report arrived today.',
    'We discuss the report tomorrow.', 'We discuss the report next week.', 'The report looks fine tonight.']) {
    const h = harness().say('There is no deadline for the report.')
    h.at(1000).say(text)
    assert.equal(h.retracts().length, 0, text)
  }
  for (const text of ['Friday.', 'On Friday.', 'The deadline is Friday.', 'It is due Friday.',
    'The report is due tomorrow.', 'The report should be ready by Friday.',
    'The report will be ready before Friday.', "Let's launch the report on Friday."]) {
    const h = harness().say('There is no deadline for the report.')
    h.at(1000).say(text)
    assert.equal(h.retracts()[0]?.reason, 'resolved', text)
  }
  for (const due of ['today', 'tomorrow', 'tonight', 'next week', 'next month']) {
    assert.equal(harness().say(`I'll send the report ${due}.`).engine.commitments()[0]?.due, due)
  }
})

test('round 2: calendar words are not invented as named owners', () => {
  const words = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
    'Today', 'Tomorrow', 'Tonight', 'Next Monday', 'This Friday']
  for (const word of words) {
    const text = `${word} will review the plan.`
    const h = harness().say('We need somebody for the plan.')
    h.at(1000).say(text)
    assert.equal(h.engine.commitments().length, 0, text)
    assert.equal(h.retracts().length, 0, text)
  }
  for (const owner of ['Alex', 'Priya', 'June Park', 'May Chen', 'April Lee']) {
    const h = harness().say('We need somebody for the plan.')
    h.at(1000).say(`${owner} will review the plan.`)
    assert.equal(h.engine.commitments()[0]?.owner, owner)
    assert.equal(h.retracts()[0]?.reason, 'resolved', owner)
  }
})

test('round 2: explicit ownership acceptance survives the empty-subject guard', () => {
  for (const text of ["I'll take ownership.", 'Priya will take ownership.']) {
    const h = harness().say('We need somebody for the network check.')
    h.at(1000).say(text)
    assert.equal(h.retracts()[0]?.reason, 'resolved', text)
    assert.equal(h.engine.commitments().length, 1, text)
  }
})
