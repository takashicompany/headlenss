// Offline flow tests: execute the real app state machine and HTTP client with
// fake DOM, lens, microphone, timers and fetch. No browser/server is started.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

let ts
try { ts = createRequire(import.meta.url)('typescript') }
catch { ts = createRequire(new URL('../../server/package.json', import.meta.url))('typescript') }

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const response = (status = 200, body = {}) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify(body), json: async () => body,
})
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

/** CueEngine 契約どおりの偽物。呼び出しを記録し、テストから show/retract を撃てる。 */
function fakeEngine(opts) {
  const listeners = new Set()
  const e = {
    opts, calls: [], segments: [], commitmentList: [],
    emit(ev) { for (const l of listeners) l(ev) },
    onSegment(seg) { e.segments.push(seg) },
    tick() { e.calls.push(['tick']) },
    setProfile(p) { e.calls.push(['setProfile', p]) },
    setWearer(s) { e.calls.push(['setWearer', s]) },
    setFocus(s) { e.calls.push(['setFocus', s]) },
    rate(id, r) { e.calls.push(['rate', id, r]) },
    dismiss(id) { e.calls.push(['dismiss', id]) },
    commitments() { return e.commitmentList },
    reset() { e.calls.push(['reset']); e.segments = [] },
    on(l) { listeners.add(l); return () => listeners.delete(l) },
  }
  return e
}

function app({ polling = false, realAsr = false, realEngine = false } = {}) {
  const frames = [], requests = [], timers = new Map(), elements = new Map()
  const control = {
    fetch: async () => { throw new Error('Unexpected fetch (network is disabled)') },
    transcript: 'Use the local cache.', recordings: 0,
    bytes: 1024, seconds: 1, micResult: { ok: true }, sockets: [],
  }
  const element = () => ({
    value: '', textContent: '', innerHTML: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, setAttribute() {},
    querySelectorAll: () => [],
  })
  let timerId = 0
  const context = vm.createContext({
    console: { log: (...m) => (control.console ??= []).push(m.join(' ')), warn() {}, error() {} },
    performance: { now: () => 100 }, Date, URL, URLSearchParams, AbortController, AbortSignal,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId },
    clearTimeout: (id) => timers.delete(id), setInterval: () => ++timerId, clearInterval() {},
    document: {
      getElementById: (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) },
      createElement: element, querySelectorAll: () => [], addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    location: { search: '', href: 'http://lens.invalid/' }, navigator: { userAgent: 'test' },
    fetch: (url, options = {}) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal })
      return control.fetch(url, options)
    },
    frames, exports: {},
  })
  context.window = context
  context.addEventListener = () => {}
  const mocks = {
    '@evenrealities/even_hub_sdk': {},
    // Approximate widths for layout/state assertions, not hardware typography validation.
    '@evenrealities/pretext': { getTextWidth: (s) => [...s].length * 10 },
    './renderer': {
      MAIN_INNER_WIDTH: 558, HEADER_INNER_WIDTH: 568,
      // Real executeFullRender can be driven in tests; each call records what reached the "SDK".
      showScreen: async (header, content) => { await control.renderGate?.promise; (control.rendered ??= []).push(content) },
      updateHeader: async () => {},
      updateContent: async (content) => { await control.renderGate?.promise; (control.rendered ??= []).push(content) },
      updateFooter: async () => {},
      resetPageState() {},
    },
    './audio': {
      getPcmByteLength: () => control.bytes, getRecordingSeconds: () => control.seconds,
      resetPcmCounter() {}, startRecordingClock() {}, stopRecordingClock() {}, trackPcmFrame() {},
    },
    './mic': {
      openMic: async () => {
        control.opens = (control.opens ?? 0) + 1
        // host acquisition still in flight: a per-open gate (queue) or one shared gate
        const gate = control.micGates?.length ? control.micGates.shift() : control.micGate
        if (gate) await gate.promise
        return control.micResult
      }, closeMic: async () => { control.closes = (control.closes ?? 0) + 1; return true },
      micIsHeld: () => false, micHealth: () => ({}), resetMicState() {},
    },
    './events': {}, './favorites': {}, './plugin-launch': {}, './plugin-takeover': {},
    './timer-guard': { installOneShotTimerGuard() {} },
    './speechmatics-rt': { recoverAsrText: (text, reason) => text.trim()
      ? { kind: 'recovered-partial', text: text.trim(), reason } : { kind: 'failure', text: '', reason }, SpeechmaticsRT: class {
      async start(opts) { control.recordings++; control.asr = opts; if (control.startError) throw control.startError }
      async stop() { if (control.onStop) await control.onStop(control.asr); if (control.stopError) throw control.stopError; return control.outcome ?? (control.transcript.trim()
        ? { kind: 'final', text: control.transcript.trim() } : { kind: 'failure', text: '', reason: 'no-speech' }) }
      fullTranscript() { return control.partial ?? '' }
      send() { control.pcmSent = (control.pcmSent ?? 0) + 1 }
      abort() { control.aborts = (control.aborts ?? 0) + 1 }
    } },
  }
  mocks['./fieldglass/cue-engine'] = {
    resetCueRatings: () => { control.ratingsReset = (control.ratingsReset ?? 0) + 1 },
    createCueEngine: (opts) => { control.engine = fakeEngine(opts); control.engines = [...(control.engines ?? []), control.engine]; return control.engine },
  }
  if (realAsr) delete mocks['./speechmatics-rt']
  if (realEngine) delete mocks['./fieldglass/cue-engine']
  context.WebSocket = class {
    static OPEN = 1
    readyState = 0
    sent = []
    constructor() { control.sockets.push(this) }
    send(data) { if (this.failSend) throw new Error('socket send failed'); this.sent.push(data) }
    close() { this.readyState = 3 }
    open() { this.readyState = 1; this.onopen?.() }
    message(message, transcript) { this.onmessage?.({ data: JSON.stringify({ message, metadata: { transcript } }) }) }
  }
  const modules = new Map()
  function compile(name) {
    let source = readFileSync(new URL(`${name}.ts`, import.meta.url), 'utf8')
    if (name === './main') {
      // Bootstrap is the only excluded entrypoint; tests drive the same flow functions
      // normally called by its installed gesture handlers.
      source = source.slice(0, source.lastIndexOf('\nboot().catch('))
    }
    source = source.replaceAll('import.meta.env.DEV', 'false')
    return ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    } }).outputText
  }
  // 取り込み元からの相対パスを src 基準の './x' に直す (fieldglass/lens.ts の '../i18n' 等)
  const resolve = (name, from) => name.startsWith('.') ? './' + posix.normalize(posix.join(posix.dirname(from), name)) : name
  function requireModule(rawName, from = './main') {
    const name = resolve(rawName, from)
    if (Object.hasOwn(mocks, name)) return mocks[name]
    if (!modules.has(name)) {
      assert.ok(['./i18n', './settings', './server-client', './speechmatics-rt', './fieldglass/lens', './fieldglass/cue-engine', './fieldglass/messages', './fieldglass/mic-arbiter'].includes(name), `Unexpected module ${name}`)
      const exports = {}
      modules.set(name, exports)
      vm.runInContext(`(function(require, exports) { ${compile(name)}\n})`, context)((n) => requireModule(n, name), exports)
    }
    return modules.get(name)
  }
  context.require = (n) => requireModule(n, './main')
  vm.runInContext(compile('./main'), context)
  const run = (code) => vm.runInContext(code, context)
  requireModule('./i18n').setLanguage('en')
  run(`
    settings = { ...settings, sessionName: 'original', serverBaseUrl: 'http://original.invalid', speechmaticsApiKey: 'test' };
    bridge = {}; serverProbeOk = true; phase = 'idle';
    refreshG2 = async () => { frames.push(buildG2Frame()) };
    applyClientBase();
    serverProbeOk = true;
  `)
  if (!polling) run('refreshClaudeData = async () => {}; claudeChatLoading = false')
  const draft = () => run(`ensurePromptDraft().sentences.push('Keep this prompt'); phase = 'pending'`)
  function question(count = 1, multi = false) {
    const questions = Array.from({ length: count }, (_, i) => ({
      question: `Which approach for step ${i + 1}?`, multiSelect: multi,
      options: [{ label: 'Local' }, { label: 'Remote' }],
    }))
    run(`claudePending = ${JSON.stringify({ id: 'request-1', kind: 'question', toolName: 'AskUserQuestion', questions })};
      enterRespondFlow(claudePending); phase = 'cc-response'; respondFlow.cursor = ${multi ? 3 : 2};`)
  }
  return { run, control, frames, requests, timers, draft, question, modules, elements }
}

test('failed send retains text, and retry uses the original session and server', async () => {
  const a = app(); a.draft()
  a.control.fetch = async () => response(404)
  await a.run('confirmAndSend()')
  assert.equal(a.run('phase'), 'pending')
  assert.equal(a.run('pendingSendText()'), 'Keep this prompt')
  assert.equal(a.run('promptDraft.delivery'), 'failed')
  assert.match(a.run('buildG2Header()'), /original.*Send failed/)
  assert.match(a.run('buildG2Footer()'), /Retry/)
  a.run("settings.sessionName = 'different'; settings.serverBaseUrl = 'http://different.invalid'; applyClientBase()")
  a.control.fetch = async () => response()
  await a.run('confirmAndSend()')
  assert.equal(a.requests[1].url, 'http://original.invalid/api/sessions/original/input')
  assert.equal(a.run('promptDraft'), null)
  assert.equal(a.run('history[0].session'), 'original')
})

test('timeout preserves draft and needs a separate explicit resend confirmation', async () => {
  const a = app(); a.draft()
  a.control.fetch = async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e }
  await a.run('confirmAndSend()')
  assert.equal(a.run('promptDraft.delivery'), 'unknown')
  assert.match(a.run('buildG2Header()'), /Delivery unknown/)
  assert.match(a.run('buildG2Content()'), /May have arrived/)
  await a.run('confirmAndSend()')
  assert.equal(a.requests.length, 1)
  assert.match(a.run('buildG2Footer()'), /May send twice/)
  a.control.fetch = async () => response()
  await a.run('confirmAndSend()')
  assert.equal(a.requests.length, 2)
  assert.equal(a.run('promptDraft'), null)
})

test('forced escape keeps the draft, does not record/resend, and ignores a late success', async () => {
  const a = app(); a.draft(); const request = deferred()
  a.control.fetch = () => request.promise
  const sending = a.run('confirmAndSend()')
  a.run('blockingPhaseSince = Date.now() - 4000')
  await a.run('toggleRecording()')
  assert.equal(a.run('phase'), 'pending')
  assert.equal(a.run('promptDraft.delivery'), 'unknown')
  assert.equal(a.control.recordings, 0)
  assert.equal(a.requests.length, 1)
  a.run("promptDraft.sentences.push('Additional detail')")
  request.resolve(response()); await sending
  assert.equal(a.run('phase'), 'pending')
  assert.match(a.run('pendingSendText()'), /Additional detail/)
  a.run('discardPending()')
  assert.equal(a.run('promptDraft'), null)
})

test('edit keeps an uncertain draft bound to its destination and requires reconfirmation', async () => {
  const a = app(); a.draft()
  a.run("promptDraft.delivery = 'unknown'; promptDraft.retryArmed = true; settings.sessionName = 'different'")
  await a.run('editPromptDraft()'); await settle()
  await a.run('stopRecordingToPending()')
  assert.equal(a.run('promptDraft.sessionName'), 'original')
  assert.equal(a.run('promptDraft.retryArmed'), false)
  assert.equal(a.run('promptDraft.delivery'), 'unknown')
  assert.match(a.run('pendingSendText()'), /Keep this prompt.*Use the local cache/)
  assert.equal(a.requests.length, 0)
})

test('a recording remains bound to its initial destination across a phone session switch', async () => {
  const a = app()
  await a.run('startRecording()'); await settle()
  a.run("settings.sessionName = 'different'; settings.serverBaseUrl = 'http://different.invalid'")
  await a.run('stopRecordingToPending()')
  a.control.fetch = async () => response()
  await a.run('confirmAndSend()')
  assert.equal(a.requests[0].url, 'http://original.invalid/api/sessions/original/input')
})

test('canceling an empty recording does not bind the next session to its old target', async () => {
  const a = app()
  await a.run('startRecording()'); await settle()
  await a.run('abortRecording()')
  assert.equal(a.run('promptDraft'), null)
  a.run("settings.sessionName = 'different'")
  await a.run('startRecording()'); await settle()
  await a.run('stopRecordingToPending()')
  assert.equal(a.run('promptDraft.sessionName'), 'different')
})

test('ambiguous HTTP failures require confirmation; known pre-injection rejection does not', async () => {
  const a = app(); a.draft()
  a.control.fetch = async () => response(400, { error: 'Enter failed after paste' })
  await a.run('confirmAndSend()')
  assert.equal(a.run('promptDraft.delivery'), 'unknown')
  a.control.fetch = async () => response(409, { code: 'already_processing' })
  await a.run('confirmAndSend()')
  assert.equal(a.requests.length, 1)
  await a.run('confirmAndSend()')
  assert.equal(a.run('promptDraft.delivery'), 'failed')
})

test('dictated answer is reviewable and unsent until confirmation', async () => {
  const a = app(); a.question()
  await a.run('handleCcResponseClick()'); await settle()
  await a.run('stopRecordingToPending()')
  assert.equal(a.run('phase'), 'cc-review')
  assert.equal(a.run('respondFlow.answers[0]'), undefined)
  assert.equal(a.requests.length, 0)
  assert.match(a.run('buildG2Content()'), /Which approach.*\n[\s\S]*Use the local cache/)
  assert.match(a.run('buildG2Header()'), /original.*Review answer/)
  assert.match(a.run('buildG2Footer()'), /Confirm/)
  const request = deferred(); a.control.fetch = () => request.promise
  a.run('confirmReviewedAnswer()')
  assert.match(a.run('buildG2Footer()'), /Sending response/)
  assert.equal(a.run('respondInputBlocked()'), true)
  await a.run('toggleRecording()')
  assert.equal(a.requests.length, 1)
  assert.equal(a.requests[0].body.answers[0].text, 'Use the local cache.')
  request.resolve(response()); await settle()
  assert.equal(a.run('phase'), 'idle')
  assert.match(a.run('buildG2Footer()'), /Response sent/)
})

test('review supports rerecord, scrolling, and back to choices without submitting', async () => {
  const a = app(); a.question()
  await a.run('handleCcResponseClick()'); await settle()
  await a.run('stopRecordingToPending()')
  a.control.transcript = 'A corrected answer. '.repeat(30)
  await a.run('recordAnswerAgain()'); await settle()
  await a.run('stopRecordingToPending()')
  assert.match(a.run('respondFlow.reviewText'), /corrected answer/)
  a.run('scrollAnswerReview(1)')
  assert.ok(a.run('respondFlow.reviewScrollOffset') > 0)
  assert.ok(a.run("buildG2Content().split('\\n').length") <= 7)
  a.run('backToAnswerChoices()')
  assert.equal(a.run('phase'), 'cc-response')
  assert.equal(a.run('respondFlow.reviewText'), null)
  assert.equal(a.requests.length, 0)
})

test('multi-question dictation only advances after review; stale review cannot submit', async () => {
  const a = app(); a.question(2)
  await a.run('handleCcResponseClick()'); await settle()
  await a.run('stopRecordingToPending()')
  assert.equal(a.run('respondFlow.qIdx'), 0)
  a.run('confirmReviewedAnswer()')
  assert.equal(a.run('respondFlow.qIdx'), 1)
  assert.equal(a.run('phase'), 'cc-message')
  assert.equal(a.requests.length, 0)
  a.run("phase = 'cc-review'; respondFlow.reviewText = 'stale'; claudePending.id = 'replacement'")
  a.run('confirmReviewedAnswer()')
  assert.equal(a.requests.length, 0)
  a.run('reconcileRespondPending()')
  assert.equal(a.run('phase'), 'cc-message')
  assert.equal(a.run('respondFlow.reviewText'), null)
})

test('predefined single-select remains immediate; multi-select waits for Submit', async () => {
  const a = app(); a.question(); a.control.fetch = async () => response()
  a.run('respondFlow.cursor = 0')
  await a.run('handleCcResponseClick()'); await settle()
  assert.equal(a.requests.length, 1)
  assert.equal(a.requests[0].body.answers[0].option, 'Local')
  a.question(1, true)
  a.run('respondFlow.cursor = 0')
  await a.run('handleCcResponseClick()')
  assert.equal(a.requests.length, 1)
  a.run('respondFlow.cursor = 2')
  await a.run('handleCcResponseClick()'); await settle()
  assert.equal(a.requests.length, 2)
})

test('permissions show Sending immediately, block duplicate taps, and retain failure for retry', async () => {
  const a = app(); const request = deferred()
  a.run("claudePending = { id: 'permission-1', kind: 'permission', toolName: 'Bash', toolInput: {} }; enterRespondFlow(claudePending); phase = 'cc-response'")
  a.control.fetch = () => request.promise
  const sending = a.run('handleCcResponseClick()')
  assert.match(a.frames.at(-1).footer, /Sending response/)
  await a.run('toggleRecording()')
  assert.equal(a.requests.length, 1)
  request.resolve(response(500)); await sending
  assert.equal(a.run('phase'), 'cc-response')
  assert.match(a.run('buildG2Footer()'), /Send failed/)
  a.control.fetch = async () => response()
  await a.run('handleCcResponseClick()')
  assert.equal(a.requests.length, 2)
  assert.match(a.run('buildG2Footer()'), /Response sent/)
})

test('late response feedback never overwrites a different session', async () => {
  const a = app(); a.question(); a.run('respondFlow.cursor = 0'); const request = deferred()
  a.control.fetch = () => request.promise
  await a.run('handleCcResponseClick()')
  a.run("settings.sessionName = 'different'; resetRespondStateForSessionChange()")
  request.resolve(response()); await settle()
  assert.doesNotMatch(a.run('buildG2Footer()'), /Response sent/)
})

test('header stays visible while scrolling, and distinguishes new replies from idle', () => {
  const a = app()
  a.run("claudeChatStatus = 'idle'; updateReplyFeedback('original', [], 'idle')")
  assert.match(a.run('buildG2Header()'), /Agent idle/)
  a.run("claudeChatStatus = 'busy'; updateReplyFeedback('original', [], 'busy'); scrollOffset = 40")
  assert.match(a.run('buildG2Header()'), /Working/)
  a.run("claudeChatStatus = 'idle'; updateReplyFeedback('original', [], 'idle')")
  assert.match(a.run('buildG2Header()'), /Agent idle/)
  a.run("claudeChatStatus = 'busy'; updateReplyFeedback('original', [{role: 'assistant', ts: 1, text: 'A new reply'}], 'busy')")
  a.run("claudeChatStatus = 'idle'; updateReplyFeedback('original', [{role: 'assistant', ts: 1, text: 'A new reply'}], 'idle')")
  assert.match(a.run('buildG2Header()'), /Reply ready/)
  a.run("claudePending = {kind: 'permission'}")
  assert.match(a.run('buildG2Header()'), /Approval/)
  a.run("claudePending = {kind: 'question'}")
  assert.match(a.run('buildG2Header()'), /Question/)
  a.run("settings.sessionName = 'other'; resetRespondStateForSessionChange(); updateReplyFeedback('other', [{role: 'assistant', ts: 1, text: 'Old reply'}], 'idle'); claudeChatLoading = false")
  assert.match(a.run('buildG2Header()'), /Agent idle/)
})

test('a question followed by busy/idle without a new reply does not imply reply completion', () => {
  const a = app()
  a.run("updateReplyFeedback('original', [], 'idle')")
  a.run("updateReplyFeedback('original', [{role: 'assistant', ts: 1, text: 'Please choose'}], 'waiting-question')")
  a.run("updateReplyFeedback('original', [{role: 'assistant', ts: 1, text: 'Please choose'}], 'busy')")
  a.run("updateReplyFeedback('original', [{role: 'assistant', ts: 1, text: 'Please choose'}], 'idle'); claudeChatStatus = 'idle'")
  assert.match(a.run('buildG2Header()'), /Agent idle/)
})

test('new menu labels fit the protocol limit in both languages', () => {
  const a = app(); const i18n = a.modules.get('./i18n')
  for (const lang of ['en', 'ja']) {
    i18n.setLanguage(lang)
    a.draft()
    for (const state of ['draft', 'failed', 'unknown']) {
      a.run(`promptDraft.delivery = '${state}'`)
      for (const item of a.run('lensMenuItems()')) assert.ok(Buffer.byteLength(item.itemName) <= 32)
    }
    a.question(); a.run("phase = 'cc-review'")
    for (const item of a.run('lensMenuItems()')) assert.ok(Buffer.byteLength(item.itemName) <= 32)
  }
})

test('ASR interruption preserves words as an unsent draft at the original destination', async () => {
  const a = app(); a.draft()
  await a.run('startRecording()'); await settle()
  a.run("settings.sessionName = 'other'")
  a.control.asr.onDead({ kind: 'recovered-partial', text: 'Words before disconnect', reason: 'socket closed' })
  await settle()
  assert.equal(a.run('phase'), 'pending')
  assert.equal(a.run('promptDraft.sessionName'), 'original')
  assert.match(a.run('pendingSendText()'), /Keep this prompt Words before disconnect/)
  assert.match(a.run('buildG2Content()'), /Connection lost.*review partial text/)
  assert.ok(a.control.closes > 0)
  assert.equal(a.requests.length, 0)
  a.modules.get('./i18n').setLanguage('ja')
  assert.match(a.run('buildG2Content()'), /接続が切れました/)
})

test('recovered answer goes to review and never advances or submits by itself', async () => {
  const a = app(); a.question(2)
  await a.run('handleCcResponseClick()'); await settle()
  a.control.asr.onDead({ kind: 'recovered-partial', text: 'My partial answer', reason: 'error' })
  await settle()
  assert.equal(a.run('phase'), 'cc-review')
  assert.equal(a.run('respondFlow.reviewPartial'), true)
  assert.equal(a.run('respondFlow.qIdx'), 0)
  assert.equal(a.run('respondFlow.answers[0]'), undefined)
  assert.match(a.run('answerReviewLines().join(String.fromCharCode(10))'), /Connection lost.*review partial text/)
  assert.equal(a.requests.length, 0)
  a.run('confirmReviewedAnswer()')
  assert.equal(a.run('respondFlow.qIdx'), 1)
  assert.equal(a.run('respondFlow.answers[0].text'), 'My partial answer')
  assert.equal(a.requests.length, 0)
})

test('stop exceptions recover available words; empty results show No speech captured', async () => {
  const a = app()
  await a.run('startRecording()'); await settle()
  a.control.stopError = new Error('broken stop'); a.control.partial = 'Keep the partial'
  await a.run('stopRecordingToPending()')
  assert.equal(a.run('phase'), 'pending')
  assert.equal(a.run('pendingSendText()'), 'Keep the partial')
  assert.equal(a.run('promptDraft.recoveredPartial'), true)
  a.run('discardPending()'); a.control.stopError = null; a.control.transcript = ''
  await a.run('startRecording()'); await settle()
  await a.run('stopRecordingToPending()')
  assert.equal(a.run('phase'), 'idle')
  assert.match(a.run('buildG2Footer()'), /No speech captured/)
  assert.equal(a.requests.length, 0)
})

test('startup, microphone, and empty mid-recording failures have distinct feedback', async () => {
  const a = app(); a.control.startError = new Error('handshake failed')
  await a.run('startRecording()'); await settle()
  assert.match(a.run('buildG2Footer()'), /Rec start failed \(ASR\)/)
  a.control.startError = null; a.control.bytes = 0; a.control.micResult = { ok: false, reason: 'failed' }
  await a.run('startRecording()'); await settle()
  assert.match(a.run('buildG2Footer()'), /Rec start failed \(mic\)/)
  assert.equal(a.run('recordingReady'), false)
  a.control.bytes = 1024; a.control.micResult = { ok: true }
  await a.run('startRecording()'); await settle()
  a.control.asr.onDead({ kind: 'failure', text: '', reason: 'connection closed' })
  await settle()
  assert.match(a.run('buildG2Footer()'), /Recording interrupted.*No speech captured/)
  assert.equal(a.run('phase'), 'idle')
})

async function beginRealAsr(a) {
  a.control.fetch = async () => response(200, { key_value: 'test-token' })
  await a.run('startRecording()'); await settle()
  const socket = a.control.sockets.at(-1)
  socket.open(); socket.message('RecognitionStarted'); await settle()
  return socket
}

for (const failure of ['timeout', 'close', 'error', 'send-throw']) {
  test(`real ASR stop ${failure} returns recovered partial text, not a final result`, async () => {
    const a = app({ realAsr: true }); const socket = await beginRealAsr(a)
    socket.message('AddTranscript', 'Saved '); socket.message('AddPartialTranscript', 'words')
    if (failure === 'send-throw') socket.failSend = true
    const stopped = a.run('stopRecordingToPending()'); await settle()
    if (failure === 'timeout') {
      const [id, timer] = [...a.timers].find(([, t]) => t.ms === 8000)
      a.timers.delete(id); timer.fn()
    } else if (failure === 'close') socket.onclose({ code: 1006 })
    else if (failure === 'error') socket.message('Error')
    await stopped
    assert.equal(a.run('phase'), 'pending')
    assert.equal(a.run('pendingSendText()'), 'Saved words')
    assert.equal(a.run('promptDraft.recoveredPartial'), true)
    assert.equal(socket.onmessage, null)
    assert.ok(a.requests.every(r => !r.url.includes('/input')))
  })
}

test('real ASR clean final and live disconnect are distinguished', async () => {
  const a = app({ realAsr: true }); const socket = await beginRealAsr(a)
  socket.message('AddTranscript', 'A final answer')
  const stopped = a.run('stopRecordingToPending()'); await settle()
  socket.message('EndOfTranscript'); await stopped
  assert.equal(a.run('promptDraft.recoveredPartial'), false)
  a.run('discardPending()')
  const next = await beginRealAsr(a)
  next.message('AddPartialTranscript', 'Unfinished words')
  next.onclose({ code: 1006 }); await settle()
  assert.equal(a.run('pendingSendText()'), 'Unfinished words')
  assert.equal(a.run('promptDraft.recoveredPartial'), true)
})

test('stale recovered answer cannot enter a replacement pending request', async () => {
  const a = app(); a.question()
  await a.run('handleCcResponseClick()'); await settle()
  const stopped = a.run("stopRecordingToPending({kind:'recovered-partial',text:'Old answer',reason:'lost'})")
  a.run("claudePending = {...claudePending, id:'replacement'}; rebindRespondFlow(claudePending)")
  await stopped
  assert.equal(a.run('respondFlow.pendingId'), 'replacement')
  assert.equal(a.run('respondFlow.reviewText'), null)
  assert.equal(a.run('promptDraft'), null)
  assert.equal(a.requests.length, 0)
})

test('draft deletion is undoable once, including the last chunk and an intervening addition', async () => {
  const a = app(); a.draft()
  assert.match(a.run('buildG2Footer()'), /2Tap:Discard/)
  a.run('removeLastSentence()')
  assert.equal(a.run('phase'), 'pending')
  assert.equal(a.run('pendingSendText()'), '')
  assert.ok(a.run("lensMenuItems().some(i => i.itemName === 'Undo last deletion')"))
  await a.run('startRecording()'); await settle(); await a.run('stopRecordingToPending()')
  a.run('undoLastDeletion()')
  assert.equal(a.run('pendingSendText()'), 'Keep this prompt Use the local cache.')
  a.run('undoLastDeletion()')
  assert.equal(a.run('pendingSentences().length'), 2)
  assert.ok(!a.run('lensMenuItems().some(i => i.itemID === LENS_MENU_ID_PROMPT_UNDO)'))
  a.run('removeLastSentence(); discardPending(); ensurePromptDraft()')
  assert.equal(a.run('promptDraft.lastDeletion'), null)
})

test('question details keep option labels paired with measured wrapped descriptions', () => {
  const a = app(); a.question(2)
  a.run(`claudePending.questions[0].options = [
    {label:'Local', description:'Private storage without a network. '.repeat(12)},
    {label:'Remote', description:'Shared access with a connection.'}
  ]; claudePending.id = 'described'; rebindRespondFlow(claudePending)`)
  const lines = a.run('ccMessageLines()')
  assert.ok(lines.indexOf('Local') < lines.findIndex(l => l.includes('Private storage')))
  assert.ok(lines.indexOf('Remote') < lines.findIndex(l => l.includes('Shared access')))
  assert.ok(lines.every(l => [...l].length * 10 <= a.run('CHAT_WRAP_PX')))
  a.run('ccMsgScrollForward()')
  assert.ok(a.run('flowMsgScroll()') > 0)
  a.run('respondFlow.qIdx = 1')
  assert.ok(!a.run('ccMessageLines().join(String.fromCharCode(10))').includes('Private storage'))
})

const cachedChat = Array.from({ length: 16 }, (_, i) => ({ role: 'assistant', text: `Message ${i}: ` + 'readable history '.repeat(8), ts: i + 1 }))
function healthyFetch(chat = cachedChat) {
  return async url => {
    if (url.endsWith('/api/health')) return response(200, { ok: true })
    if (url.endsWith('/pending')) return response(200, { pending: null })
    if (url.includes('/chat')) return response(200, { chat, status: 'idle' })
    return response(200, { sessions: [] })
  }
}

test('one poll failure leaves the screen intact; repeated failures retain cached chat and offer Retry', async () => {
  const a = app({ polling: true }); a.control.fetch = healthyFetch()
  await a.run('refreshClaudeData()'); a.run('scrollOffset = 7')
  const before = a.run('buildG2Content()')
  a.control.fetch = async () => { throw new Error('offline') }
  await a.run('refreshClaudeData()')
  assert.equal(a.run('serverOffline'), false)
  assert.equal(a.run('buildG2Content()'), before)
  await a.run('refreshClaudeData()'); await a.run('refreshClaudeData()')
  assert.equal(a.run('serverOffline'), true)
  assert.equal(a.run('phase'), 'idle')
  assert.equal(a.run('scrollOffset'), 7)
  assert.equal(a.run('buildG2Content()'), before)
  assert.match(a.run('buildG2Header()'), /Disconnected/)
  assert.match(a.run('buildG2Footer()'), /Offline · last update/)
  assert.ok(a.run('lensMenuItems().some(i => i.itemID === LENS_MENU_ID_RETRY_CONNECTION)'))
  a.control.fetch = healthyFetch()
  await a.run('retryConnection()')
  assert.equal(a.run('serverOffline'), false)
  assert.equal(a.run('settings.sessionName'), 'original')
  assert.equal(a.run('scrollOffset'), 7)
  assert.equal(a.run('buildG2Content()'), before)
  assert.equal(a.run('healthRetryTimer'), null)
})

test('setup and disconnected are distinct, with bounded automatic health backoff', async () => {
  const a = app({ polling: true })
  a.run("settings.serverBaseUrl = ''; applyClientBase(); recomputePhase()")
  assert.equal(a.run('phase'), 'unconfigured')
  assert.equal(a.run('buildG2Header()'), 'Not configured')
  a.run("settings.serverBaseUrl = 'http://offline.invalid'; applyClientBase()")
  a.control.fetch = async () => { throw new Error('offline') }
  await a.run('probeServer()')
  assert.equal(a.run('phase'), 'disconnected')
  assert.equal(a.run('buildG2Header()'), 'Disconnected')
  assert.ok(a.run('lensMenuItems().some(i => i.itemID === LENS_MENU_ID_RETRY_CONNECTION)'))
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
    const id = a.run('healthRetryTimer'), timer = a.timers.get(id)
    assert.equal(timer.ms, delay)
    a.timers.delete(id); timer.fn(); await settle()
  }
  a.control.fetch = healthyFetch()
  await a.run('retryConnection()')
  assert.equal(a.run('phase'), 'rootlist')
  assert.equal(a.run('serverOffline'), false)
  assert.equal(a.run('healthRetryTimer'), null)
})

test('hung polls have a deadline and do not accumulate or accept late data', async () => {
  const a = app({ polling: true }); const request = deferred()
  a.control.fetch = () => request.promise
  const first = a.run('refreshClaudeData()')
  await a.run('refreshClaudeData()'); await a.run('refreshClaudeData()')
  assert.equal(a.requests.length, 2)
  const [id, timer] = [...a.timers].find(([, t]) => t.ms === 10000)
  a.timers.delete(id); timer.fn(); await first
  assert.equal(a.run('refreshAbortCtrl'), null)
  assert.equal(a.run('pollFailures.chat'), 1)
  assert.ok(a.requests.every(r => r.signal.aborted))
  request.resolve(response(200, { chat: cachedChat, pending: null })); await settle()
  assert.equal(a.run('claudeChat.length'), 0)
})

test('old server recovery cannot update the new server; concurrent retries share one probe', async () => {
  const a = app({ polling: true }); const request = deferred()
  a.control.fetch = () => request.promise
  const retry = a.run('retryConnection()')
  await a.run('retryConnection()')
  assert.equal(a.requests.length, 1)
  a.run("settings.serverBaseUrl = 'http://new.invalid'; applyClientBase()")
  request.resolve(response(200, { ok: true })); await retry
  assert.equal(a.run('serverProbeOk'), false)
  assert.equal(a.run('listUpdatedAt'), 0)
  assert.equal(a.requests.length, 1)
})

test('health success alone keeps cached chat marked offline until data recovers', async () => {
  const a = app({ polling: true }); a.control.fetch = healthyFetch()
  await a.run('refreshClaudeData()'); const updated = a.run('chatUpdatedAt')
  a.run("notePollFailure('chat'); notePollFailure('chat'); notePollFailure('chat')")
  const healthy = healthyFetch()
  a.control.fetch = url => url.includes('/chat') ? Promise.reject(new Error('chat unavailable')) : healthy(url)
  await a.run('retryConnection()')
  assert.equal(a.run('serverOffline'), true)
  assert.equal(a.run('serverProbeOk'), false)
  assert.equal(a.run('chatUpdatedAt'), updated)
  assert.match(a.run('buildG2Footer()'), /Offline/)
  assert.ok(a.run('healthRetryTimer !== null'))
})

test('hung health probes expire and late results cannot mark the server connected', async () => {
  const a = app({ polling: true }); const request = deferred()
  a.control.fetch = () => request.promise
  const retry = a.run('retryConnection()')
  const [id, timer] = [...a.timers].find(([, t]) => t.ms === 8000)
  a.timers.delete(id); timer.fn(); await retry
  assert.equal(a.run('probeInFlight'), false)
  assert.equal(a.run('serverOffline'), true)
  assert.equal(a.requests[0].signal.aborted, true)
  request.resolve(response(200, { ok: true })); await settle()
  assert.equal(a.run('serverProbeOk'), false)
  assert.equal(a.requests.length, 1)
})

test('recovering with appended messages preserves the visible reading window', async () => {
  const a = app({ polling: true }); a.control.fetch = healthyFetch()
  await a.run('refreshClaudeData()'); a.run('scrollOffset = 8')
  const before = a.run('buildG2Content()')
  a.run("notePollFailure('chat'); notePollFailure('chat'); notePollFailure('chat')")
  a.control.fetch = healthyFetch([...cachedChat, {role:'assistant',text:'A new message after recovery.',ts:20}])
  await a.run('retryConnection()')
  assert.equal(a.run('buildG2Content()'), before)
  assert.ok(a.run('scrollOffset') > 8)
  assert.equal(a.run('settings.sessionName'), 'original')
})

for (const question of [false, true]) {
  test(`escaping a stuck ASR finalization keeps ${question ? 'the answer in review' : 'the prompt draft'}`, async () => {
    const a = app({ realAsr: true })
    if (question) { a.question(); a.run('respondFlow.recording = true') }
    const socket = await beginRealAsr(a)
    socket.message('AddPartialTranscript', 'Words worth keeping')
    const stopped = a.run('stopRecordingToPending()'); await settle()
    a.run('blockingPhaseSince = Date.now() - 4000')
    await a.run('toggleRecording()'); await stopped
    assert.equal(a.run('phase'), question ? 'cc-review' : 'pending')
    assert.equal(a.run(question ? 'respondFlow.reviewText' : 'pendingSendText()'), 'Words worth keeping')
    assert.equal(a.run(question ? 'respondFlow.reviewPartial' : 'promptDraft.recoveredPartial'), true)
    assert.equal(socket.onmessage, null)
    assert.ok(a.requests.every(r => !r.url.includes('/input') && !r.url.includes('/respond')))
  })
}

test('undo and Retry menu labels fit firmware limits in both languages', () => {
  const a = app(); a.draft(); a.run('removeLastSentence(); serverOffline = true')
  for (const lang of ['en', 'ja']) {
    a.modules.get('./i18n').setLanguage(lang)
    const items = a.run('lensMenuItems()')
    assert.ok(items.some(i => i.itemID === a.run('LENS_MENU_ID_PROMPT_UNDO')))
    assert.ok(items.some(i => i.itemID === a.run('LENS_MENU_ID_RETRY_CONNECTION')))
    assert.ok(items.length <= 10)
    for (const item of items) assert.ok(Buffer.byteLength(item.itemName) <= 32)
  }
})

// ─── Fieldglass ──────────────────────────────────────────────────────────

const TODAY = {
  updatedAt: 1, source: 'calendar', refreshing: false,
  events: [{ id: 'ev1', start: '00:00', end: '23:59', title: 'Rollout sync', objective: 'Pick an owner for the network check' }],
}
const sampleCue = (over = {}) => ({
  id: 'c1', category: 'owner', revision: 1, text: 'Who owns the network check?', why: 'Blocker raised, no owner yet.',
  evidence: { quote: 'We need somebody for the network check.', speaker: 'S2', endMs: 1900 }, createdAt: 0, expiresAt: 20000, ...over,
})

async function fieldglassApp(opts = {}) {
  const a = app(opts)
  a.control.fetch = async (url, options = {}) => {
    if (url.endsWith('/api/fieldglass/today')) return response(200, TODAY)
    if (url.endsWith('/api/fieldglass/followups') && (options.method ?? 'GET') === 'GET') return response(200, { followups: [] })
    if (url.endsWith('/api/fieldglass/followups')) return response(200, { id: 'f1', ...JSON.parse(options.body), createdAt: 1, expiresAt: 2 })
    if (url.endsWith('/api/fieldglass/fieldtest')) return response(200, { ok: true })
    throw new Error(`Unexpected fetch ${url}`)
  }
  a.run(`claudeSessions = [{ tmuxSessionName: 'work', cwd: '/x', status: 'idle', startedAt: 0, lastSeenAt: 0, source: 'claude' }]; phase = 'rootlist'`)
  await a.run('fieldglass.refreshToday()')
  const fg = (code) => a.run(code)
  const lens = () => ({ header: fg('buildG2Header()'), content: fg('buildG2Content()'), footer: fg('buildG2Footer()') })
  async function goLive() {
    fg(`rootCursorKey = 'fg'; activateSelectedFromRoot()`); await settle()
    fg('fieldglass.onClick()')            // home → consent
    fg('fieldglass.onClick()'); await settle()  // consent → mic
  }
  return { ...a, fg, lens, goLive }
}

test('Fieldglass is the first root row and shows the next meeting from /today', async () => {
  const a = await fieldglassApp()
  const view = a.fg('buildRootListView()').split('\n')
  assert.match(view[0], /Fieldglass\s+Next: 00:00 Rollout sync/)
  assert.match(view[1], /^  Messages/)
  assert.match(view[2], /work \[Claude\]/)
  a.fg(`rootCursorKey = 'fg'; activateSelectedFromRoot()`); await settle()
  assert.equal(a.fg('phase'), 'fieldglass')
  const l = a.lens()
  assert.match(l.header, /^FIELDGLASS · Work$/)
  assert.match(l.content, /00:00 Rollout sync/)
  assert.match(l.content, /Goal: Pick an owner/)
  assert.match(l.content, /○ Mic is off/)
  // 2Tap at home returns to the session list with the cursor still on Fieldglass
  a.fg('fieldglass.onDoubleClick()')
  assert.equal(a.fg('phase'), 'rootlist')
  assert.equal(a.fg('rootCursorKey'), 'fg')
})

test('root row degrades to setup / server-update hints instead of failing', async () => {
  const a = await fieldglassApp()
  a.control.fetch = async () => response(200, { updatedAt: null, source: 'none', refreshing: false, events: [], setup: { connector: 'Google Calendar', steps: ['x'] } })
  await a.run('fieldglass.refreshToday()')
  assert.match(a.fg('buildRootListView()'), /Set up calendar on phone/)
  a.control.fetch = async () => response(404, {})
  await a.run('fieldglass.refreshToday()')
  assert.match(a.fg('buildRootListView()'), /Update HeadLenss server/)
  // no agent sessions: Fieldglass row stays, old empty hint follows it
  a.fg('claudeSessions = []')
  const rows = a.fg('buildRootListView()').split('\n')
  assert.match(rows[0], /Fieldglass/)
  assert.ok(rows.some((r) => r.includes('no agent session')))
})

test('mic opens only after the consent screen, and LIVE is shown whenever it is open', async () => {
  const a = await fieldglassApp()
  a.fg(`rootCursorKey = 'fg'; activateSelectedFromRoot()`); await settle()
  a.fg('fieldglass.onClick()')
  assert.equal(a.fg('fieldglass.screen'), 'consent')
  assert.equal(a.control.recordings, 0)
  assert.equal(a.control.opens ?? 0, 0)
  assert.match(a.lens().content, /Tell the room first/)
  assert.doesNotMatch(a.lens().header, /●/)
  // 2Tap cancels without touching the mic
  a.fg('fieldglass.onDoubleClick()')
  assert.equal(a.fg('fieldglass.screen'), 'home')
  assert.equal(a.control.opens ?? 0, 0)
  a.fg('fieldglass.onClick()'); a.fg('fieldglass.onClick()'); await settle()
  assert.equal(a.control.recordings, 1)
  assert.equal(a.control.opens, 1)
  assert.equal(a.control.asr.diarization, true)
  assert.equal(a.control.asr.retainTranscript, false)
  assert.ok(a.control.asr.endOfUtteranceSilence > 0)
  const l = a.lens()
  assert.match(l.header, /^LISTEN · Work  ● LIVE \d\d:\d\d$/)
  assert.equal(l.content, '')  // silence is a valid output
  assert.equal(a.fg('statusForCurrentPhase().dot'), 'rec')
  // audio goes to the Fieldglass ASR only while live
  a.fg('fieldglass.onAudio(new Uint8Array(4))')
  assert.equal(a.control.pcmSent, 1)
})

test('a cue card shows hero + why; Tap = useful, Off target is in the hold menu', async () => {
  const a = await fieldglassApp()
  await a.goLive()
  const engine = a.control.engine
  assert.equal(engine.opts.profile, 'work')
  engine.emit({ type: 'show', cue: sampleCue() }); await settle()
  let l = a.lens()
  assert.match(l.header, /^CUE · Work  ● LIVE \d\d:\d\d$/)
  assert.equal(l.content.split('\n')[0], '？ Owner', 'line 1 is the category, never conversation text')
  assert.equal(l.content.split('\n')[1], 'Who owns the network check?')
  assert.match(l.content, /Blocker raised, no owner yet\./)
  assert.match(l.footer, /Tap:Got it/)
  const menu = a.fg('lensMenuItems()').map((m) => m.itemName)
  assert.deepEqual([...menu], ['Off target', 'That was me', 'Pause cues 15 min', 'End session'])
  a.fg('fieldglass.onClick()')
  assert.deepEqual(engine.calls.filter((c) => c[0] === 'rate' || c[0] === 'dismiss'), [['rate', 'c1', 'useful'], ['dismiss', 'c1']])
  assert.equal(a.fg('fieldglass.cue'), null)
  engine.emit({ type: 'show', cue: sampleCue({ id: 'c2' }) }); await settle()
  a.fg('fieldglass.onMenuItem(106)')
  assert.deepEqual(engine.calls.filter((c) => c[1] === 'c2'), [['rate', 'c2', 'off'], ['dismiss', 'c2']])
  // retract on resolution clears immediately; expiry shows "(old)" for one frame first
  engine.emit({ type: 'show', cue: sampleCue({ id: 'c3' }) }); await settle()
  engine.emit({ type: 'retract', cueId: 'c3', reason: 'resolved' }); await settle()
  assert.equal(a.lens().content, '')
  engine.emit({ type: 'show', cue: sampleCue({ id: 'c4' }) }); await settle()
  engine.emit({ type: 'retract', cueId: 'c4', reason: 'expired' }); await settle()
  assert.equal(a.lens().content.split('\n')[0], '？ Owner (old)')
  assert.equal(a.lens().content.split('\n')[1], 'Who owns the network check?')
})

test('That was me needs a known speaker; pause hides cues but keeps LIVE on', async () => {
  const a = await fieldglassApp()
  await a.goLive()
  const engine = a.control.engine
  a.fg('fieldglass.onMenuItem(107)')
  assert.match(a.fg('buildG2Footer()'), /Speaker unknown/)
  assert.equal(engine.calls.filter((c) => c[0] === 'setWearer').length, 0)
  a.control.asr.onSegment({ text: 'I can look at it', isFinal: true, speaker: 'S1', startMs: 0, endMs: 900 })
  a.fg('fieldglass.onMenuItem(107)')
  assert.deepEqual(engine.calls.find((c) => c[0] === 'setWearer'), ['setWearer', 'S1'])
  a.fg('fieldglass.onMenuItem(108)')  // pause
  engine.emit({ type: 'show', cue: sampleCue({ id: 'p1' }) }); await settle()
  assert.equal(a.fg('fieldglass.cue'), null)
  assert.ok(engine.calls.some((c) => c[0] === 'dismiss' && c[1] === 'p1'))
  assert.match(a.lens().header, /^PAUSED · Work  ● LIVE/)
  assert.match(a.lens().content, /Cues paused until/)
})

test('end session: confirm, mic off, transcript reset, quoted commitments saved only on Tap', async () => {
  const a = await fieldglassApp()
  await a.goLive()
  const engine = a.control.engine
  engine.commitmentList = [
    { id: 'k1', quote: "I'll run the network check by Friday", owner: 'S2', due: 'Friday', speaker: 'S2', endMs: 5000 },
    { id: 'k2', quote: 'I will send the notes', speaker: 'S1', endMs: 9000 },
  ]
  a.fg('fieldglass.onDoubleClick()')
  assert.equal(a.fg('fieldglass.screen'), 'confirmEnd')
  assert.match(a.lens().header, /● LIVE/)  // still listening until confirmed
  a.fg('fieldglass.onDoubleClick()')     // keep listening
  assert.equal(a.fg('fieldglass.screen'), 'live')
  a.fg('fieldglass.onDoubleClick()'); a.fg('fieldglass.onClick()'); await settle()
  assert.equal(a.fg('fieldglass.screen'), 'review')
  assert.equal(a.control.closes, 1)
  assert.ok(engine.calls.some((c) => c[0] === 'reset'))
  assert.equal(a.fg('fieldglass.live'), null)
  let l = a.lens()
  assert.match(l.header, /^REVIEW · 1\/2  ○ MIC OFF$/)
  assert.doesNotMatch(l.header, /●/)
  assert.match(l.content, /"I'll run the network check by Friday"/)
  assert.match(l.content, /Owner: S2/)
  assert.ok(a.requests.every((r) => !r.url.includes('/followups') || (r.body === undefined)), 'nothing saved before Tap')
  a.fg('fieldglass.onClick()'); await settle()
  const saved = a.requests.filter((r) => r.url.endsWith('/api/fieldglass/followups') && r.body)
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].body, { quote: "I'll run the network check by Friday", owner: 'S2', due: 'Friday', eventId: 'ev1', meetingTitle: 'Rollout sync' })
  assert.equal(a.fg('fieldglass.review.idx'), 1)  // advanced to the next one
  a.fg('fieldglass.onScroll(-1)')
  assert.match(a.lens().content, /Saved to Mac/)
  a.fg('fieldglass.onDoubleClick()')  // done: second quote is never sent
  assert.equal(a.requests.filter((r) => r.url.endsWith('/api/fieldglass/followups') && r.body).length, 1)
  assert.equal(a.fg('fieldglass.screen'), 'home')
  assert.equal(a.fg('fieldglass.review'), null)
  assert.match(a.fg('buildG2Footer()'), /Saved 1 · transcript cleared/)
})

test('phone leaving the app stops mic and ASR; Tap resumes on the same conversation', async () => {
  const a = await fieldglassApp()
  await a.goLive()
  const engine = a.control.engine
  a.fg(`fieldglass.suspend('foreground-exit')`); await settle()
  assert.equal(a.fg('fieldglass.screen'), 'suspended')
  assert.equal(a.fg('fieldglass.isLive()'), false)
  assert.equal(a.control.closes, 1)
  assert.match(a.lens().header, /^OFF · Phone left app  ○ MIC OFF$/)
  a.fg('fieldglass.onAudio(new Uint8Array(4))')
  assert.equal(a.control.pcmSent ?? 0, 0)
  a.fg('fieldglass.onClick()'); await settle()
  assert.equal(a.fg('fieldglass.screen'), 'live')
  assert.equal(a.control.recordings, 2)
  assert.equal(a.control.engine, engine, 'same conversation, no new engine')
  assert.match(a.lens().header, /● LIVE/)
})

test('a dropped ASR connection reconnects and keeps the audio timeline moving forward', async () => {
  const a = await fieldglassApp()
  await a.goLive()
  const first = a.control.asr
  first.onSegment({ text: 'first', isFinal: true, speaker: 'S2', startMs: 100, endMs: 500 })
  first.onDead({ kind: 'failure', text: '', reason: 'WebSocket closed (1006)' }); await settle()
  assert.match(a.lens().content, /Speech reconnecting/)
  assert.match(a.lens().header, /● LIVE/)  // mic still open while reconnecting
  const [id, timer] = [...a.timers].find(([, t]) => t.ms === 1000)
  a.timers.delete(id); timer.fn(); await settle()
  assert.equal(a.control.recordings, 2)
  // the stale connection can no longer feed the engine
  first.onSegment({ text: 'stale', isFinal: true, startMs: 0, endMs: 10 })
  a.control.asr.onSegment({ text: 'second', isFinal: true, speaker: 'S2', startMs: 0, endMs: 300 })
  const segs = a.control.engine.segments
  assert.deepEqual(segs.map((s) => s.text), ['first', 'second'])
  assert.ok(segs[1].startMs >= 0 && segs[1].endMs >= segs[1].startMs)
  assert.equal(a.control.opens, 1, 'mic is not reopened for an ASR reconnect')
})

test('ASR that keeps failing turns the mic off and offers Retry', async () => {
  const a = await fieldglassApp()
  a.control.startError = new Error('JWT fetch failed: HTTP 401')
  a.fg(`rootCursorKey = 'fg'; activateSelectedFromRoot()`); await settle()
  a.fg('fieldglass.onClick()'); a.fg('fieldglass.onClick()'); await settle()
  for (const ms of [1000, 2000, 4000, 8000]) {
    const [id, timer] = [...a.timers].find(([, t]) => t.ms === ms)
    a.timers.delete(id); timer.fn(); await settle()
  }
  assert.equal(a.fg('fieldglass.live.asrState'), 'failed')
  assert.equal(a.fg('fieldglass.isLive()'), false)
  assert.match(a.lens().content, /Speech stopped/)
  assert.match(a.lens().footer, /Tap:Retry/)
  assert.doesNotMatch(a.lens().header, /●/)
})

test('mic failure abandons the session without leaving anything behind', async () => {
  const a = await fieldglassApp()
  a.control.micResult = { ok: false, reason: 'failed' }
  await a.goLive()
  assert.equal(a.fg('fieldglass.screen'), 'home')
  assert.equal(a.fg('fieldglass.live'), null)
  assert.match(a.fg('buildG2Footer()'), /Mic failed to start/)
})

test('field test posts timing only when enabled', async () => {
  const a = await fieldglassApp()
  await a.goLive()
  a.control.engine.emit({ type: 'show', cue: sampleCue() }); await settle()
  await a.fg('fieldglass.flushFieldTest()')
  assert.equal(a.requests.filter((r) => r.url.endsWith('/fieldtest')).length, 0)
  a.fg('fieldglass.endLive()'); await settle(); a.fg('fieldglass.onDoubleClick()')
  a.fg('fieldglass.onMenuItem(105)')  // field test on
  assert.equal(a.fg('fieldglass.fieldTest'), true)
  await a.goLive()
  a.control.engine.emit({ type: 'show', cue: sampleCue({ id: 't1' }) }); await settle()
  await a.fg('executeFullRender(true)')  // the cue frame actually reaches the SDK
  await a.fg('fieldglass.flushFieldTest()')
  const posted = a.requests.filter((r) => r.url.endsWith('/fieldtest')).flatMap((r) => r.body.events)
  assert.deepEqual(posted.map((e) => e.kind), ['session_start', 'cue_shown'])
  const shown = posted[1]
  assert.equal(shown.cueId, 't1')
  assert.ok(shown.lastWordAt && shown.candidateAt && shown.renderedAt)
  assert.ok(shown.renderedAt >= shown.candidateAt)
})

test('only the live mic state starts or contains ●; no screen fakes it', async () => {
  const a = await fieldglassApp()
  a.fg(`rootCursorKey = 'fg'; activateSelectedFromRoot()`); await settle()
  for (const screen of ['home', 'consent', 'review', 'followups', 'suspended', 'confirmEnd']) {
    a.fg(`fieldglass.screen = '${screen}'`)
    assert.doesNotMatch(a.lens().header, /●/, screen)
  }
})

test('real cue engine: a blocker with no owner from another speaker produces one cue', async () => {
  const a = await fieldglassApp({ realEngine: true })
  await a.goLive()
  a.control.asr.onSegment({ text: 'We need somebody for the network check.', isFinal: true, speaker: 'S2', startMs: 800, endMs: 1900, endOfUtterance: true })
  a.control.asr.onSegment({ text: '', isFinal: true, startMs: 1900, endMs: 1900, endOfUtterance: true })
  await settle()
  const cue = a.fg('fieldglass.cue')
  assert.ok(cue, 'expected a cue')
  assert.match(a.lens().header, /^CUE · Work  ● LIVE/)
  assert.ok(a.lens().content.split('\n')[0].length <= 56)
})

test('Speechmatics: diarized results become speaker segments; plain recording config is unchanged', async () => {
  const a = app({ realAsr: true })
  const { segmentsFromResults } = a.modules.get('./speechmatics-rt')
  const w = (content, speaker, s, e, extra = {}) => ({ type: 'word', start_time: s, end_time: e, alternatives: [{ content, speaker }], ...extra })
  const p = (content, extra = {}) => ({ type: 'punctuation', start_time: 1.2, end_time: 1.2, attaches_to: 'previous', alternatives: [{ content }], ...extra })
  const segs = segmentsFromResults([w('We', 'S1', 0, 0.2), w('need', 'S1', 0.2, 0.5), p(','), w('Sure', 'S2', 0.6, 0.9), p('.', { is_eos: true }), w('hm', 'UU', 1.0, 1.1)], true, 'en')
  assert.deepEqual(JSON.parse(JSON.stringify(segs)), [
    { text: 'We need,', isFinal: true, speaker: 'S1', startMs: 0, endMs: 1200 },
    { text: 'Sure.', isFinal: true, speaker: 'S2', startMs: 600, endMs: 1200, endOfUtterance: true },
    { text: 'hm', isFinal: true, startMs: 1000, endMs: 1100 },
  ])
  const ja = segmentsFromResults([w('ネット', 'S1', 0, 0.2), w('確認', 'S1', 0.2, 0.4)], false, 'ja')
  assert.equal(ja[0].text, 'ネット確認')
  // ordinary voice input still sends the same StartRecognition (no diarization)
  a.control.fetch = async () => response(200, { key_value: 'k' })
  await a.run('startRecording()'); await settle()
  const socket = a.control.sockets.at(-1); socket.open()
  const config = JSON.parse(socket.sent[0])
  assert.equal(config.transcription_config.diarization, undefined)
  assert.equal(config.conversation_config, undefined)
  assert.equal(config.transcription_config.conversation_config, undefined)
})

test('Speechmatics continuous mode: segments, EndOfUtterance, and no transcript retained', async () => {
  const a = app({ realAsr: true })
  const { SpeechmaticsRT } = a.modules.get('./speechmatics-rt')
  a.control.fetch = async () => response(200, { key_value: 'k' })
  const rt = new SpeechmaticsRT()
  const segs = [], finals = []
  const started = rt.start({ apiKey: 'x', language: 'en', operatingPoint: 'enhanced', diarization: true, endOfUtteranceSilence: 0.7,
    retainTranscript: false, onSegment: (s) => segs.push(s), onFinal: (t) => finals.push(t) })
  await settle()
  const socket = a.control.sockets.at(-1); socket.open()
  const config = JSON.parse(socket.sent[0])
  assert.equal(config.transcription_config.diarization, 'speaker')
  // documented placement: transcription_config.conversation_config (not top-level)
  assert.equal(config.conversation_config, undefined)
  assert.equal(config.transcription_config.conversation_config.end_of_utterance_silence_trigger, 0.7)
  assert.ok(config.transcription_config.conversation_config.end_of_utterance_silence_trigger < config.transcription_config.max_delay)
  assert.deepEqual(Object.keys(config).sort(), ['audio_format', 'message', 'transcription_config'])
  socket.message('RecognitionStarted'); await started
  socket.onmessage({ data: JSON.stringify({ message: 'AddTranscript', metadata: { transcript: 'Hi there. ' },
    results: [{ type: 'word', start_time: 0, end_time: 0.3, alternatives: [{ content: 'Hi', speaker: 'S1' }] },
      { type: 'word', start_time: 0.3, end_time: 0.6, alternatives: [{ content: 'there', speaker: 'S1' }] }] }) })
  socket.onmessage({ data: JSON.stringify({ message: 'AddTranscript', metadata: { transcript: 'Next. ' }, results: [] }) })
  socket.onmessage({ data: JSON.stringify({ message: 'EndOfUtterance', metadata: { start_time: 0.6, end_time: 0.6 } }) })
  assert.deepEqual(segs.map((s) => [s.text, s.speaker, s.endOfUtterance ?? false]), [['Hi there', 'S1', false], ['', undefined, true]])
  assert.deepEqual(finals, ['Hi there. ', 'Next. '])
  assert.equal(rt.fullTranscript(), '')
  rt.abort()
})

test('Fieldglass lens strings fit the footer width and the menu byte limit in both languages', () => {
  const a = app()
  const i18n = a.modules.get('./i18n')
  // half-width = 1, everything else (full-width / CJK / glyphs) = 2 → must be ≤ 56
  const width = (s) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) < 0x2000 ? 1 : 2), 0)
  for (const lang of ['en', 'ja']) {
    i18n.setLanguage(lang)
    for (const key of ['fgFootHome', 'fgFootConsent', 'fgFootListen', 'fgFootCue', 'fgFootRetry', 'fgFootEnd', 'fgFootReview',
      'fgFootReviewNone', 'fgFootFollowups', 'fgFootSuspended', 'fgConsent1', 'fgConsent2', 'fgConsent3', 'fgConsent4', 'fgConsent5',
      'fgNoticeDone', 'fgNoticePaused', 'fgNoticeNoSpeaker', 'fgEndHint']) {
      assert.ok(width(i18n.t(key)) <= 56, `${lang} ${key}: ${i18n.t(key)}`)
    }
    for (const key of ['fgMenuWork', 'fgMenuEveryday', 'fgMenuListening', 'fgMenuFieldTest', 'fgMenuOffTarget', 'fgMenuThatWasMe',
      'fgMenuPause', 'fgMenuResume', 'fgMenuEnd', 'fgMenuResetMuted']) {
      assert.ok(Buffer.byteLength(i18n.t(key)) <= 32, `${lang} ${key}`)
    }
    assert.ok(Buffer.byteLength(i18n.tf('fgMenuFollowups', { n: 99 })) <= 32)
    // only the LIVE indicator may start with ●
    for (const [k, v] of Object.entries({ fgLive: 1, fgRootLive: 1, fgStatusLive: 0 })) assert.equal(i18n.t(k).startsWith('●'), v === 1, k)
  }
  i18n.setLanguage('en')
})

// ─── Fieldglass fix round 1 (each test reproduces a review finding) ─────────

test('[grok2 BLOCKER / codex2 #2] a mic open that completes after End or lock is closed again', async () => {
  for (const stopper of ['end', 'suspend']) {
    const a = await fieldglassApp()
    a.control.micGate = deferred()
    await a.goLive()
    assert.equal(a.control.opens, 1)  // acquisition sent, host has not answered yet
    if (stopper === 'end') { a.fg('fieldglass.onDoubleClick()'); a.fg('fieldglass.onClick()') }
    else a.fg(`fieldglass.suspend('foreground-exit')`)
    await settle()
    assert.equal(a.control.closes, 1, `${stopper}: closed immediately`)
    a.control.micGate.resolve(); await settle()  // host completes the old open afterwards
    assert.equal(a.control.closes, 2, `${stopper}: late open is closed again`)
    assert.equal(a.fg('fieldglass.isLive()'), false)
  }
})

test('[codex2 #2] a stale open never closes a newer session\'s mic', async () => {
  const a = await fieldglassApp()
  a.control.micGate = deferred()
  await a.goLive()
  a.fg(`fieldglass.suspend('foreground-exit')`); await settle()
  const oldGate = a.control.micGate
  a.control.micGate = null
  a.fg('fieldglass.onClick()'); await settle()   // resume → new acquisition (opens = 2)
  assert.equal(a.control.opens, 2)
  const closesBefore = a.control.closes
  oldGate.resolve(); await settle()              // the first open lands now
  assert.equal(a.control.closes, closesBefore, 'newer acquisition left open')
  assert.equal(a.fg('fieldglass.isLive()'), true)
})

test('[codex2 #1] when the first ASR connect fails, the automatic reconnect still opens the mic', async () => {
  const a = await fieldglassApp()
  a.control.startError = new Error('handshake timed out')
  await a.goLive()
  assert.equal(a.control.opens ?? 0, 0)
  a.control.startError = null
  const [id, timer] = [...a.timers].find(([, t]) => t.ms === 1000)
  a.timers.delete(id); timer.fn(); await settle()
  assert.equal(a.fg('fieldglass.live.asrState'), 'ok')
  assert.equal(a.control.opens, 1, 'mic opened after the successful reconnect')
  a.fg('fieldglass.onAudio(new Uint8Array(4))')
  assert.equal(a.control.pcmSent, 1)
})

test('[codex2 #3] End waits for the last final so a just-spoken promise reaches review', async () => {
  const a = await fieldglassApp({ realEngine: true })
  await a.goLive()
  a.control.onStop = async (opts) => {
    opts.onSegment({ text: "I'll send the report by Friday.", isFinal: true, speaker: 'S2', startMs: 100, endMs: 900, endOfUtterance: true })
  }
  a.fg('fieldglass.onDoubleClick()')
  const ended = a.fg('fieldglass.onClick(), fieldglass.endLive()')
  assert.equal(a.control.closes, 1, 'mic closed before draining')
  assert.match(a.lens().content, /Finishing last words/)
  a.fg('fieldglass.onDoubleClick()')  // input ignored while finishing
  await ended; await settle()
  assert.equal(a.fg('fieldglass.screen'), 'review')
  assert.equal(a.fg('fieldglass.review.items.length'), 1)
  assert.match(a.lens().content, /I'll send the report by Friday/)
  assert.equal(a.fg('fieldglass.live'), null)
})

test('[codex2 #4] speaker labels from a new ASR connection are scoped and the wearer is cleared', async () => {
  const a = await fieldglassApp()
  await a.goLive()
  a.control.asr.onSegment({ text: 'hello', isFinal: true, speaker: 'S1', startMs: 0, endMs: 400 })
  a.fg('fieldglass.onMenuItem(107)')  // That was me → S1
  a.control.asr.onDead({ kind: 'failure', text: '', reason: 'closed' }); await settle()
  const [id, timer] = [...a.timers].find(([, t]) => t.ms === 1000)
  a.timers.delete(id); timer.fn(); await settle()
  const engine = a.control.engine
  assert.deepEqual(engine.calls.filter((c) => c[0] === 'setWearer').map((c) => c[1]), ['S1', null])
  assert.ok(engine.calls.some((c) => c[0] === 'setFocus' && c[1] === null))
  assert.match(a.fg('buildG2Footer()'), /mark yourself again/)
  a.control.asr.onSegment({ text: 'other person', isFinal: true, speaker: 'S1', startMs: 0, endMs: 300 })
  assert.equal(engine.segments.at(-1).speaker, 'S1#2', 'new connection S1 is not the old S1')
})

test('[codex2 #5] That was me never falls back to a stale speaker', async () => {
  const a = await fieldglassApp()
  await a.goLive()
  const engine = a.control.engine
  a.control.asr.onSegment({ text: 'hi all', isFinal: true, speaker: 'S1', startMs: 0, endMs: 300 })
  // a cue whose evidence speaker is unknown
  engine.emit({ type: 'show', cue: sampleCue({ id: 'u1', evidence: { quote: 'We need somebody for beta.', endMs: 900 } }) }); await settle()
  a.fg('fieldglass.onMenuItem(107)')
  assert.match(a.fg('buildG2Footer()'), /Speaker unknown/)
  assert.equal(engine.calls.filter((c) => c[0] === 'setWearer').length, 0)
  // without a cue: an unknown non-empty turn clears the remembered speaker; an empty EOU does not set one
  a.fg('fieldglass.onClick()')  // dismiss cue
  a.control.asr.onSegment({ text: 'mumble', isFinal: true, startMs: 1000, endMs: 1200 })
  a.control.asr.onSegment({ text: '', isFinal: true, startMs: 1200, endMs: 1200, endOfUtterance: true })
  a.fg('fieldglass.onMenuItem(107)')
  assert.equal(engine.calls.filter((c) => c[0] === 'setWearer').length, 0)
})

test('[claudefg-server #3 / codex2 #7] manual-only Today shows the meeting on the lens via the real client', async () => {
  const a = await fieldglassApp()
  a.control.fetch = async () => response(200, { updatedAt: 5, source: 'manual', refreshing: false, lastSource: 'manual',
    lastError: "Google Calendar isn't signed in.", events: [{ id: 'manual-1', start: '00:00', end: '23:59', title: 'Hand-added 1:1', objective: 'Agree the plan' }] })
  await a.run('fieldglass.refreshToday()')
  assert.equal(a.fg('fieldglass.today.source'), 'manual')
  assert.equal(a.fg('fieldglass.today.lastError'), "Google Calendar isn't signed in.")
  assert.match(a.fg('buildRootListView()'), /Next: 00:00 Hand-added 1:1/)
  a.fg(`rootCursorKey = 'fg'; activateSelectedFromRoot()`); await settle()
  assert.match(a.lens().content, /Hand-added 1:1/)
  assert.match(a.lens().content, /Goal: Agree the plan/)
  assert.doesNotMatch(a.lens().content, /Calendar not connected/)
})

test('[codex2 #8] renderedAt is recorded only after the cue frame is really sent; coalesced cues are not "shown"', async () => {
  const a = await fieldglassApp()
  a.fg('fieldglass.fieldTest = true')
  await a.goLive()
  const engine = a.control.engine
  a.control.renderGate = deferred()
  engine.emit({ type: 'show', cue: sampleCue({ id: 'r1' }) }); await settle()
  const sending = a.fg('executeFullRender(true)'); await settle()
  await a.fg('fieldglass.flushFieldTest()')
  const shownBefore = a.requests.filter((r) => r.url.endsWith('/fieldtest')).flatMap((r) => r.body.events).filter((e) => e.kind === 'cue_shown')
  assert.equal(shownBefore.length, 0, 'not shown while the SDK send is pending')
  a.control.renderGate.resolve(); await sending
  // a second cue that is retracted before any frame carries it is never logged as shown
  a.control.renderGate = null
  engine.emit({ type: 'show', cue: sampleCue({ id: 'r2', text: 'Who owns the rollback?' }) }); await settle()
  engine.emit({ type: 'retract', cueId: 'r2', reason: 'superseded' }); await settle()
  await a.fg('executeFullRender(true)')
  await a.fg('fieldglass.flushFieldTest()')
  const shown = a.requests.filter((r) => r.url.endsWith('/fieldtest')).flatMap((r) => r.body.events).filter((e) => e.kind === 'cue_shown')
  assert.deepEqual(shown.map((e) => e.cueId), ['r1'])
})

test('[codex2 #9] a late render of an old session\'s cue is never logged under the next session', async () => {
  const a = await fieldglassApp()
  a.fg('fieldglass.fieldTest = true')
  await a.goLive()
  a.control.engine.emit({ type: 'show', cue: sampleCue({ id: 'old' }) }); await settle()
  const oldFrame = a.fg('buildG2Content()')
  a.fg('fieldglass.endLive()'); await settle(); a.fg('fieldglass.onDoubleClick()')
  await a.goLive()
  a.fg(`fieldglass.onFrameRendered(${JSON.stringify(oldFrame)})`)
  await a.fg('fieldglass.flushFieldTest()')
  const events = a.requests.filter((r) => r.url.endsWith('/fieldtest')).flatMap((r) => r.body.events)
  assert.equal(events.filter((e) => e.kind === 'cue_shown').length, 0)
})

test('[codex2 #10] destroy stops the Today refresh, the field-test timer, and drops late results', async () => {
  const a = await fieldglassApp()
  a.fg('fieldglass.fieldTest = true; fieldglass.startBackground()')
  await a.goLive()
  assert.ok(a.fg('fieldglass.todayTimer !== null'))
  const pending = deferred()
  a.control.fetch = async () => pending.promise
  a.fg('fieldglass.todayInFlight = false; fieldglass.today = null')
  const refreshing = a.fg('fieldglass.refreshToday()')
  a.fg(`fieldglass.destroy('app-exit')`)
  assert.equal(a.fg('fieldglass.todayTimer'), null)
  assert.equal(a.fg('fieldglass.fieldTestTimer'), null)
  assert.equal(a.fg('fieldglass.fieldTestQueue.length'), 0)
  assert.ok(![...a.timers.values()].some((t) => t.ms === 10_000), 'no field-test flush left behind')
  pending.resolve(response(200, TODAY)); await refreshing
  assert.equal(a.fg('fieldglass.today'), null, 'late /today result discarded')
})

test('[codex2 #11] an unsaved quote never reaches the app log, even in developer mode', async () => {
  const a = await fieldglassApp()
  a.fg('settings.devMode = true')
  await a.goLive()
  a.control.engine.commitmentList = [{ id: 'k1', quote: "I'll send the confidential report by Friday", speaker: 'S2', endMs: 5 }]
  await a.fg('fieldglass.endLive()'); await settle()
  await a.fg('executeFullRender(true)')
  assert.match(a.control.rendered.at(-1), /confidential report/, 'the lens itself does show it')
  assert.doesNotMatch(a.control.rendered.at(-1).split('\n')[0], /confidential/, 'not on the first line (renderer previews it)')
  a.fg('fieldglass.onDoubleClick()')  // done without saving
  assert.doesNotMatch(a.elements.get('log').textContent, /confidential/)
})

// ─── Messages (AMENDMENT 2: iMessage read + reply) ───────────────────────

const THREADS = [
  { id: 'chat;-;+15551234', name: 'Dana Lee', isGroup: false, service: 'iMessage', lastText: 'See you at 3?', lastAt: 2, unread: 2, canReply: true },
  { id: 'chat;+;team', name: 'Ops team', isGroup: true, service: 'iMessage', lastText: 'deploy done', lastAt: 1, unread: 1, canReply: false, readOnlyReason: 'Group threads are read-only in v1.' },
]
const THREAD = { thread: THREADS[0], messages: [
  { id: 'm1', fromMe: false, sender: '+15551234', text: 'Are we still on for the network check?', at: 1 },
  { id: 'm2', fromMe: true, sender: '', text: 'Yes', at: 2 },
  { id: 'm3', fromMe: false, sender: '+15551234', text: 'See you at 3?', at: 3 },
] }

async function messagesApp({ status = { canRead: true, canSend: 'yes', nodePath: '/opt/node', steps: [] }, reply } = {}) {
  const a = app()
  a.control.replies = []
  a.control.fetch = async (url, options = {}) => {
    if (url.endsWith('/api/fieldglass/messages/status')) return response(200, status)
    if (url.endsWith('/api/fieldglass/messages/threads')) return response(200, { threads: THREADS })
    if (url.includes('/reply')) { a.control.replies.push({ url, body: JSON.parse(options.body) }); return reply ? reply(a.control.replies.length) : response(200, { ok: true, state: 'sent' }) }
    if (url.includes('/api/fieldglass/messages/threads/')) return response(200, THREAD)
    if (url.includes('/api/fieldglass/')) return response(200, { updatedAt: null, source: 'none', refreshing: false, events: [] })
    throw new Error(`Unexpected fetch ${url}`)
  }
  a.run(`claudeSessions = []; phase = 'rootlist'`)
  // Messages tests render through the real send path: Send only works after the confirm frame reached the SDK.
  a.run(`refreshG2 = async () => { await executeFullRender(true) }; messages.confirmDwellMs = 0`)
  await a.run('messages.refreshSummary()')
  const lens = () => ({ header: a.run('buildG2Header()'), content: a.run('buildG2Content()'), footer: a.run('buildG2Footer()') })
  async function openDana() {
    a.run(`rootCursorKey = 'msg'; activateSelectedFromRoot()`); await settle()
    a.run('messages.onClick()'); await settle()  // open first thread
  }
  async function dictate(text) {
    a.control.transcript = text
    a.run('messages.onClick()'); await settle()        // Tap = reply → recording
    await a.run('stopRecordingToPending()'); await settle()
  }
  return { ...a, lens, openDana, dictate }
}

test('Messages row sits under Fieldglass with the unread count, or a setup hint', async () => {
  const a = await messagesApp()
  const rows = a.run('buildRootListView()').split('\n')
  assert.match(rows[0], /Fieldglass/)
  assert.match(rows[1], /Messages\s+3 new/)
  const b = await messagesApp({ status: { canRead: false, canSend: 'unknown', nodePath: '/opt/node', steps: ['x'] } })
  assert.match(b.run('buildRootListView()').split('\n')[1], /Messages\s+Set up on Mac/)
  b.run(`rootCursorKey = 'msg'; activateSelectedFromRoot()`); await settle()
  assert.match(b.lens().header, /SETUP · Messages/)
  assert.match(b.lens().content, /needs setup on the Mac/)
  assert.match(b.lens().footer, /Tap:Check again/)
})

test('thread list → thread view shows recent messages, scrolls, and polls only while open', async () => {
  const a = await messagesApp()
  a.run(`rootCursorKey = 'msg'; activateSelectedFromRoot()`); await settle()
  assert.equal(a.run('phase'), 'messages')
  let l = a.lens()
  assert.match(l.header, /MESSAGES \(2\)/)
  assert.match(l.content.split('\n')[0], /^▶ Dana Lee \(2\)$/)
  assert.match(l.content, /Ops team \[group\] \(1\)/)
  assert.doesNotMatch(l.content, /See you at 3/, 'no message previews in the list')
  assert.ok(a.run('messages.pollTimer !== null'), 'polling while a Messages screen is open')
  a.run('messages.onClick()'); await settle()
  l = a.lens()
  assert.equal(l.header, 'MSG · Dana Lee')
  assert.equal(l.content.split('\n')[0], '3 recent', 'first line carries no message text')
  assert.match(l.content, /Dana Lee: See you at 3\?/)
  assert.match(l.content, /Me: Yes/)
  assert.match(l.footer, /Tap:Reply/)
  const thread = a.requests.find((r) => r.url.includes('/threads/'))
  assert.ok(thread.url.endsWith('/threads/chat%3B-%3B%2B15551234'), 'thread id is URL-encoded')
  a.run('messages.onDoubleClick()'); a.run('messages.onDoubleClick()')  // thread → list → root
  assert.equal(a.run('phase'), 'rootlist')
  assert.equal(a.run('messages.pollTimer'), null, 'polling stops when Messages closes')
})

test('reply: dictate through the existing draft flow → confirm card with exact recipient + full text → Tap sends once', async () => {
  const a = await messagesApp()
  await a.openDana()
  const text = 'Yes, see you at three. I will bring the checklist and the spare cables.'
  a.control.transcript = text
  a.run('messages.onClick()'); await settle()
  assert.equal(a.run('phase'), 'recording')
  assert.equal(a.run('messages.pollTimer'), null, 'no polling while dictating')
  await a.run('stopRecordingToPending()'); await settle()
  assert.equal(a.run('phase'), 'pending')
  assert.match(a.lens().header, /→ Dana Lee/)
  assert.match(a.lens().footer, /^Tap:Review　↑↓:Read　Hold:Edit　2Tap:Discard$/)
  assert.equal(a.control.replies.length, 0)
  a.run('confirmAndSend()'); await settle()  // ↑ on the draft = go to the confirm card, NOT send
  assert.equal(a.run('phase'), 'messages')
  assert.equal(a.control.replies.length, 0, 'nothing sent before the confirm Tap')
  const l = a.lens()
  assert.equal(l.header, 'TO · Dana Lee')
  assert.equal(l.content.split('\n')[0], 'Send this message?')
  assert.match(l.content.replace(/\n/g, ' '), /Yes, see you at three\. I will bring the checklist and the spare cables\./)
  assert.match(l.footer, /Tap:Send/)
  assert.deepEqual([...a.run('lensMenuItems()').map((m) => m.itemName)], ['Discard reply'])
  a.run('messages.onClick()'); a.run('messages.onClick()'); await settle()  // double tap → still one send
  assert.equal(a.control.replies.length, 1)
  const sent = a.control.replies[0]
  assert.ok(sent.url.endsWith('/threads/chat%3B-%3B%2B15551234/reply'))
  assert.equal(sent.body.text, text)
  assert.ok(sent.body.draftId.length >= 8)
  assert.match(a.lens().content, /^Sent\./)
  assert.equal(a.run('promptDraft'), null)
  a.run('messages.onClick()'); await settle()
  assert.equal(a.run('messages.screen'), 'thread')
})

test('reply: an uncertain result shows Delivery unknown and never resends', async () => {
  for (const reply of [() => { throw new Error('network down') }, () => response(200, { ok: true, state: 'unknown' }), () => response(500, { error: 'x' })]) {
    const a = await messagesApp({ reply })
    await a.openDana(); await a.dictate('On my way')
    a.run('confirmAndSend()'); await settle()
    a.run('messages.onClick()'); await settle()
    assert.match(a.lens().content, /Delivery unknown/)
    assert.match(a.lens().content, /Check Messages/)
    assert.equal(a.run('promptDraft'), null, 'draft dropped: cannot be sent twice')
    a.run('messages.onClick()'); await settle()  // Tap = back to thread, not retry
    assert.equal(a.control.replies.length, 1)
    assert.equal(a.run('messages.screen'), 'thread')
  }
})

test('reply: a definite 4xx keeps the draft; Tap retries with the same draftId, 2Tap edits', async () => {
  const a = await messagesApp({ reply: (n) => n === 1 ? response(400, { reason: 'Group chats are read-only in v1', reasonCode: 'brand_new_code' }) : response(200, { ok: true, state: 'sent' }) })
  await a.openDana(); await a.dictate('Running late')
  a.run('confirmAndSend()'); await settle()
  a.run('messages.onClick()'); await settle()
  assert.match(a.lens().content, /Not sent\./)
  assert.match(a.lens().content, /Group chats are read-only in v1/)
  assert.ok(a.run('promptDraft !== null'))
  a.run('messages.onClick()'); await settle()  // Tap on Not-sent = show the confirm card again, not send
  assert.equal(a.control.replies.length, 1, 'a retry first shows the confirm card again')
  assert.equal(a.run('messages.screen'), 'confirm')
  a.run('messages.onClick()'); await settle()  // Send from the re-shown card
  assert.equal(a.control.replies.length, 2)
  assert.equal(a.control.replies[0].body.draftId, a.control.replies[1].body.draftId)
  assert.match(a.lens().content, /^Sent\./)
})

test('reply: 2Tap on confirm returns to the draft; hold Discard drops it without sending', async () => {
  const a = await messagesApp()
  await a.openDana(); await a.dictate('Sounds good')
  a.run('confirmAndSend()'); await settle()
  a.run('messages.onDoubleClick()')
  assert.equal(a.run('phase'), 'pending')
  assert.equal(a.run('pendingSendText()'), 'Sounds good')
  a.run('confirmAndSend()'); await settle()
  assert.equal(a.run('messages.onMenuItem(201)'), true)
  assert.equal(a.run('promptDraft'), null)
  assert.equal(a.run('messages.screen'), 'thread')
  assert.equal(a.control.replies.length, 0)
  // discarding from the draft (2Tap in pending) also returns to the thread, not the agent chat
  await a.dictate('Never mind'); a.run('discardPending()')
  assert.equal(a.run('phase'), 'messages')
  assert.equal(a.run('messages.screen'), 'thread')
})

test('reply: an empty dictation returns to the thread; a cut-off one is flagged on the confirm card', async () => {
  const a = await messagesApp()
  await a.openDana(); await a.dictate('')
  assert.equal(a.run('phase'), 'messages')
  assert.equal(a.run('messages.screen'), 'thread')
  assert.equal(a.run('promptDraft'), null)
  // batch-2 partial recovery: the ASR drops mid-reply
  a.run('messages.onClick()'); await settle()
  a.control.asr.onDead({ kind: 'recovered-partial', text: 'I can do Thursday', reason: 'closed' }); await settle()
  assert.equal(a.run('phase'), 'pending')
  assert.equal(a.run('promptDraft.recoveredPartial'), true)
  a.run('confirmAndSend()'); await settle()
  assert.match(a.lens().content, /Speech cut off: check the text/)
  assert.match(a.lens().content, /I can do Thursday/)
})

test('message text never reaches the app log, even in developer mode', async () => {
  const a = await messagesApp()
  a.run('settings.devMode = true')
  a.run(`refreshG2 = async () => { await executeFullRender(true) }`)
  await a.openDana(); await a.dictate('My secret plan for Friday')
  a.run('removeLastSentence()')
  a.run('undoLastDeletion()')
  a.run('confirmAndSend()'); await settle()
  a.run('messages.onClick()'); await settle()
  const logText = a.elements.get('log').textContent
  assert.doesNotMatch(logText, /secret plan/)
  assert.doesNotMatch(logText, /network check/)
  assert.match(logText, /reply send \(25 chars\)/)
})

test('server client: reply errors are split into definite (4xx) and unknown (network, 408, 5xx)', async () => {
  const a = app()
  const { HeadlenssClient } = a.modules.get('./server-client')
  const c = new HeadlenssClient('http://mac.invalid')
  const run = async (fetchImpl) => {
    a.control.fetch = fetchImpl
    try { return await c.messagesReply('t', { text: 'x', draftId: 'd' }) } catch (e) { return e }
  }
  assert.equal((await run(async () => response(403, { reason: 'Automation denied', reasonCode: 'automation_denied' }))).deliveryUnknown, false)
  assert.equal((await run(async () => response(403, { reason: 'Automation denied', reasonCode: 'automation_denied' }))).reason, 'Automation denied')
  assert.equal((await run(async () => response(408, {}))).deliveryUnknown, true)
  assert.equal((await run(async () => response(502, {}))).deliveryUnknown, true)
  assert.equal((await run(async () => { throw new Error('offline') })).deliveryUnknown, true)
  assert.equal((await run(async () => response(200, { ok: true }))).state, 'unknown', 'only an explicit "sent" counts as sent')
  const st = await run(async () => response(404, {}))
  assert.equal((await (async () => { a.control.fetch = async () => response(404, {}); try { await c.messagesStatus() } catch (e) { return e.name } })()), 'FieldglassUnavailableError')
  void st
})

test('Messages lens strings fit the footer width and the menu byte limit in both languages', () => {
  const a = app()
  const i18n = a.modules.get('./i18n')
  const width = (s) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) < 0x2000 ? 1 : 2), 0)
  for (const lang of ['en', 'ja']) {
    i18n.setLanguage(lang)
    for (const key of ['msgFootList', 'msgFootSetup', 'msgFootThread', 'msgFootConfirm', 'msgFootSending', 'msgFootResult',
      'msgFootFailed', 'msgFootPending', 'msgConfirmAsk', 'msgConfirmPartial', 'msgSetup1', 'msgSetup2', 'msgSetup3',
      'msgUnknown1', 'msgFailedHint', 'msgNoThreads', 'msgFootThreadRO', 'msgReadOnly', 'fgCatOwner', 'fgCatBlocker', 'fgCatRecall',
      'fgFollowupsSaved', 'fgFinishing', 'fgReviewAsk']) {
      assert.ok(width(i18n.t(key)) <= 56, `${lang} ${key}: ${i18n.t(key)}`)
    }
    for (const key of ['msgMenuDiscard', 'msgMenuReview']) assert.ok(Buffer.byteLength(i18n.t(key)) <= 32, `${lang} ${key}`)
  }
  i18n.setLanguage('en')
})

// ─── Fix round 2 (recheck-codex2-lens.md) ───────────────────────────────────

test('[recheck #2] a stopped owner\'s late open is closed even after another session came and went', async () => {
  const a = await fieldglassApp()
  const gateA = deferred()
  a.control.micGates = [gateA]
  await a.goLive()                                   // A: open in flight
  a.fg('fieldglass.endLive()'); await settle()        // End A (closes 1)
  a.fg('fieldglass.onDoubleClick()')                  // review → home
  a.fg('fieldglass.onClick()'); a.fg('fieldglass.onClick()'); await settle()  // B: opens normally
  assert.equal(a.control.opens, 2)
  a.fg('fieldglass.endLive()'); await settle()        // End B (closes 2)
  assert.equal(a.control.closes, 2)
  gateA.resolve(); await settle()                     // A's open lands now; nobody wants the mic
  assert.equal(a.control.closes, 3, 'late open closed again')
  assert.equal(a.fg('micArbiter.owner()'), null)
})

test('[recheck #12] Fieldglass\'s late open never closes an ordinary recording that owns the mic', async () => {
  const a = await fieldglassApp()
  const gateA = deferred()
  a.control.micGates = [gateA]
  await a.goLive()
  a.fg('fieldglass.endLive()'); await settle()
  a.fg('fieldglass.onDoubleClick()'); a.fg('fieldglass.onDoubleClick()')  // review → home → root
  assert.equal(a.fg('phase'), 'rootlist')
  a.fg(`phase = 'idle'`)
  await a.fg('startRecording()'); await settle()       // ordinary HeadLenss recording acquires the mic
  assert.equal(a.fg('phase'), 'recording')
  assert.equal(a.fg('micArbiter.owner()'), 'recording')
  const closes = a.control.closes
  gateA.resolve(); await settle()
  assert.equal(a.control.closes, closes, 'the recorder\'s mic is not closed')
  assert.equal(a.fg('phase'), 'recording')
  await a.fg('stopRecordingToPending()'); await settle()
  assert.equal(a.control.closes, closes + 1, 'the recorder closes its own mic')
})

test('[recheck #2] ordinary recording: a mic open that lands after the user cancelled is closed again', async () => {
  const a = app()
  const gate = deferred()
  a.control.micGates = [gate]
  a.run('startRecording()'); await settle()
  await a.run('abortRecording()'); await settle()
  const closes = a.control.closes ?? 0
  gate.resolve(); await settle()
  assert.equal(a.control.closes, closes + 1)
  assert.equal(a.run('micArbiter.owner()'), null)
})

test('[recheck #8/#9] a completed send of session A\'s cue frame never acknowledges session B\'s identical-looking cue', async () => {
  const a = await fieldglassApp()
  a.fg('fieldglass.fieldTest = true')
  await a.goLive()
  const sessionA = a.fg('fieldglass.live.id')
  a.control.engine.emit({ type: 'show', cue: sampleCue({ id: 'same' }) }); await settle()
  a.control.renderGate = deferred()
  const sendingA = a.fg('executeFullRender(true)'); await settle()   // A's frame is in flight at the SDK
  a.fg('fieldglass.endLive()'); await settle(); a.fg('fieldglass.onDoubleClick()')
  await a.goLive()
  const sessionB = a.fg('fieldglass.live.id')
  assert.notEqual(sessionA, sessionB)
  a.control.engine.emit({ type: 'show', cue: sampleCue({ id: 'same' }) }); await settle()  // same cue id + same text in B
  const gate = a.control.renderGate
  a.control.renderGate = null
  gate.resolve(); await sendingA                                      // only A's old frame completes
  await a.fg('fieldglass.flushFieldTest()')
  const shownEarly = a.requests.filter((r) => r.url.endsWith('/fieldtest')).flatMap((r) => r.body.events).filter((e) => e.kind === 'cue_shown')
  assert.equal(shownEarly.length, 0, 'A\'s completion does not count as B shown')
  await a.fg('executeFullRender(true)')                               // B's own frame is sent (re-sent even if text matches)
  await a.fg('fieldglass.flushFieldTest()')
  const shown = a.requests.filter((r) => r.url.endsWith('/fieldtest')).flatMap((r) => r.body.events).filter((e) => e.kind === 'cue_shown')
  assert.deepEqual(shown.map((e) => e.sessionId), [sessionB])
})

test('[recheck #11] transcript-derived text never appears in console or dev logs (cue, review, follow-ups)', async () => {
  const a = await fieldglassApp({ realEngine: true })
  a.fg('settings.devMode = true')
  await a.goLive()
  a.control.asr.onSegment({ text: 'We need somebody for the confidential report.', isFinal: true, speaker: 'S2', startMs: 800, endMs: 1900, endOfUtterance: true })
  a.control.asr.onSegment({ text: '', isFinal: true, startMs: 1900, endMs: 1900, endOfUtterance: true })
  await settle()
  assert.ok(a.fg('fieldglass.cue'), 'a cue is visible')
  await a.fg('executeFullRender(true)')
  assert.match(a.control.rendered.at(-1), /confidential report/, 'the wearer still sees it on the lens')
  a.fg('fieldglass.onMenuItem(108)'); await a.fg('executeFullRender(true)')  // pause screen
  a.control.asr.onSegment({ text: "I'll send the confidential report by Friday.", isFinal: true, speaker: 'S1', startMs: 2000, endMs: 2600, endOfUtterance: true })
  await a.fg('fieldglass.endLive()'); await settle()
  await a.fg('executeFullRender(true)')                                // review card with the quote
  a.fg('fieldglass.onDoubleClick()')
  // every frame the lens received keeps conversation text off body line 1 (renderer.ts previews line 1 to console)
  for (const frame of a.control.rendered) assert.doesNotMatch(frame.split('\n')[0], /confidential/i, frame.split('\n')[0])
  const consoleText = (a.control.console ?? []).join('\n')
  assert.doesNotMatch(consoleText, /confidential/i)
  assert.doesNotMatch(a.elements.get('log').textContent, /confidential/i)
})

test('[codex server contract] read-only threads (v1 groups) cannot start a reply and say why', async () => {
  const a = await messagesApp()
  const GROUP = { thread: THREADS[1], messages: [{ id: 'g1', fromMe: false, sender: 'Sam', text: 'deploy done', at: 1 }] }
  const base = a.control.fetch
  a.control.fetch = async (url, o) => url.includes('/threads/chat%3B%2B%3Bteam') ? response(200, GROUP) : base(url, o)
  a.run(`rootCursorKey = 'msg'; activateSelectedFromRoot()`); await settle()
  a.run('messages.onScroll(1)'); a.run('messages.onClick()'); await settle()
  assert.equal(a.lens().header, 'MSG · Ops team')
  assert.match(a.lens().content.split('\n')[0], /read-only/)
  assert.match(a.lens().footer, /^Tap:Why read-only/)
  a.run('messages.onClick()'); await settle()
  assert.match(a.lens().footer, /Group threads are read-only in v1\./, 'Tap explains why')
  assert.equal(a.run('phase'), 'messages', 'no recording started')
  assert.equal(a.control.recordings, 0)
})

test('[codex server contract] draftId is per exact text: same text retries reuse it, an edit gets a new one', async () => {
  const a = await messagesApp({ reply: (n) => n === 1 ? response(409, { error: 'The original chat is no longer available.', reasonCode: 'mystery_code' }) : response(200, { ok: true, state: 'sent' }) })
  await a.openDana(); await a.dictate('Running late')
  a.run('confirmAndSend()'); await settle()
  a.run('messages.onClick()'); await settle()      // 409 → Not sent, draft kept
  assert.match(a.lens().content, /no longer available/)
  a.run('messages.onDoubleClick()')                // edit: add a sentence
  a.control.transcript = 'Ten minutes.'
  await a.run('editPromptDraft()'); await settle()
  await a.run('stopRecordingToPending()'); await settle()
  a.run('confirmAndSend()'); await settle()
  assert.match(a.lens().content.replace(/\n/g, ' '), /Running late Ten minutes\./)
  a.run('messages.onClick()'); await settle()
  const [first, second] = a.control.replies
  assert.notEqual(first.body.draftId, second.body.draftId, 'edited text gets a fresh draftId')
  assert.equal(second.body.text, 'Running late Ten minutes.')
})

// ─── Fix round 4 (recheck2-codex2-lens.md #6–#8, qa-grok.md lens defects) ──────

const width10 = (s) => [...s].length * 10  // the harness font: every glyph is 10px

test('[recheck2 #6] a reply is sent to the server its draft was made on, even after the server setting changes', async () => {
  const a = await messagesApp()
  await a.openDana(); await a.dictate('PRIVATE_REPLY_FOR_DANA')
  a.run(`settings.serverBaseUrl = 'http://different.invalid'; applyClientBase()`)
  assert.equal(a.run('messages.threads'), null, 'old Mac\'s thread list is dropped')
  assert.equal(a.run('messages.thread'), null)
  a.run('confirmAndSend()'); await settle()
  assert.equal(a.lens().header, 'TO · Dana Lee')
  a.run('messages.onClick()'); await settle()
  assert.equal(a.control.replies.length, 1)
  assert.ok(a.control.replies[0].url.startsWith('http://original.invalid/'), a.control.replies[0].url)
})

test('[recheck2 #7] Send does nothing until the confirm card frame has actually rendered (and a short dwell)', async () => {
  const a = await messagesApp()
  await a.openDana(); await a.dictate('Be there at three')
  a.control.renderGate = deferred()                 // the SDK has not finished the next frame
  const opening = a.run('confirmAndSend()'); await settle()
  assert.equal(a.run('messages.screen'), 'confirm', 'logical state moved…')
  a.run('messages.onClick()'); a.run('messages.onClick()'); await settle()
  assert.equal(a.control.replies.length, 0, '…but the glasses still show the draft: no send')
  a.control.renderGate.resolve(); a.control.renderGate = null; await opening; await settle()
  a.run('messages.confirmDwellMs = 600')
  a.run('messages.onClick()'); await settle()
  assert.equal(a.control.replies.length, 0, 'a tap right after the card appears is ignored (dwell)')
  a.run('messages.confirmShownAt -= 1000')
  a.run('messages.onClick()'); await settle()
  assert.equal(a.control.replies.length, 1)
})

test('[recheck2 #7] leaving the confirm card or editing invalidates readiness; a stale frame cannot re-arm it', async () => {
  const a = await messagesApp()
  await a.openDana(); await a.dictate('Draft one')
  a.run('confirmAndSend()'); await settle()
  const staleTag = a.run('messages.frameTag()')
  assert.ok(a.run('messages.confirmReady()'))
  a.run('messages.onDoubleClick()')                 // back to the draft (edit)
  assert.equal(a.run('messages.confirmReady()'), false)
  a.control.renderGate = deferred()
  const opening = a.run('confirmAndSend()'); await settle()
  a.run(`messages.onFrameRendered(${JSON.stringify(staleTag)})`)  // an old card's completion
  assert.equal(a.run('messages.confirmReady()'), false, 'old frame does not arm the new card')
  a.run('messages.onClick()'); await settle()
  assert.equal(a.control.replies.length, 0)
  a.control.renderGate.resolve(); a.control.renderGate = null; await opening; await settle()
  a.run('messages.onClick()'); await settle()
  assert.equal(a.control.replies.length, 1)
})

test('[recheck2 #8] a poll that is in flight when Messages closes does not start more reads', async () => {
  const a = await messagesApp()
  await a.openDana()
  const held = deferred()
  const base = a.control.fetch
  a.control.fetch = async (url, o) => url.endsWith('/messages/threads') ? held.promise : base(url, o)
  const polling = a.run('messages.poll()'); await settle()
  a.control.transcript = 'x'
  a.run('messages.onClick()'); await settle()        // Tap = reply → dictation; polling stopped
  assert.equal(a.run('phase'), 'recording')
  const before = a.requests.length
  held.resolve(response(200, { threads: THREADS })); await polling; await settle()
  assert.equal(a.requests.slice(before).filter((r) => r.url.includes('/messages/threads/')).length, 0, 'no thread GET after closing')
})

test('[recheck2 #8] the real foreground-exit handler stops Messages polling; foreground enter resumes it', async () => {
  const a = await messagesApp()
  await a.openDana()
  assert.ok(a.run('messages.pollTimer !== null'))
  a.run('handleForegroundExit()')
  assert.equal(a.run('messages.pollTimer'), null)
  a.run('messages.resume()')
  assert.ok(a.run('messages.pollTimer !== null'))
})

test('[qa MAJOR] the reply draft is wrapped, kept to 7 lines, and ↑↓ only scroll it', async () => {
  const a = await messagesApp()
  await a.openDana()
  const long = 'This is a long sentence that will certainly need wrapping on the lens.'
  a.control.transcript = long
  a.run('messages.onClick()'); await settle(); await a.run('stopRecordingToPending()'); await settle()
  for (let i = 0; i < 7; i++) {
    a.control.transcript = `Sentence number ${i + 2} is different from the others, and it is long too.`
    await a.run('editPromptDraft()'); await settle(); await a.run('stopRecordingToPending()'); await settle()
  }
  assert.equal(a.run('pendingSentences().length'), 8)
  const view = () => a.lens().content.split('\n')
  let lines = view()
  assert.ok(lines.length <= 7, `${lines.length} lines`)
  for (const l of lines) assert.ok(width10(l) <= 558, `${width10(l)}px: ${l}`)
  assert.equal(lines[0], 'Reply to Dana Lee:')
  assert.match(lines.at(-1), /^▼ \d+\/\d+$/)
  const first = lines[1]
  a.run('scrollReplyDraft(1)'); a.run('scrollReplyDraft(1)')
  lines = view()
  assert.notEqual(lines[1], first, '↓ moves the window')
  assert.equal(a.run('pendingSentences().length'), 8, 'scrolling never deletes')
  assert.equal(a.control.replies.length, 0, 'scrolling never sends')
  assert.match(a.lens().footer, /Tap:Review　↑↓:Read　Hold:Edit/)
  assert.ok(a.run('lensMenuItems()').some((m) => m.itemName === 'Delete last sentence'))
  a.run('removeLastSentence()')
  assert.equal(a.run('pendingSentences().length'), 7, 'delete is on the hold menu')
  // finalizing with a long live transcript also stays inside the window
  a.run(`phase = 'finalizing'; liveTranscript = ${JSON.stringify(long.repeat(6))}`)
  assert.ok(a.lens().content.split('\n').length <= 7)
  for (const l of a.lens().content.split('\n')) assert.ok(width10(l) <= 558)
})

test('[qa MINOR] long thread names are fitted to the header; the confirm card still shows the full recipient', async () => {
  const a = await messagesApp()
  // the harness font is 10px per glyph, so the name must exceed 568px on its own (60+ glyphs)
  const name = 'これはとても長いグループ名でヘッダからはみ出すかどうかの確認用のとても長い名前です。さらに長くしておきます'
  const T = { ...THREADS[0], name }
  a.control.fetch = async (url, o) => {
    if (url.endsWith('/messages/status')) return response(200, { canRead: true, canSend: 'yes', nodePath: '/n', steps: [] })
    if (url.endsWith('/messages/threads')) return response(200, { threads: [T] })
    if (url.includes('/reply')) { a.control.replies.push({ url, body: JSON.parse(o.body) }); return response(200, { ok: true, state: 'sent' }) }
    if (url.includes('/messages/threads/')) return response(200, { thread: T, messages: THREAD.messages })
    return response(200, {})
  }
  await a.run('messages.refreshSummary()')
  await a.openDana()
  assert.ok(width10(a.lens().header) <= 568, `${width10(a.lens().header)}px`)
  await a.dictate('OK')
  assert.ok(width10(a.lens().header) <= 568)
  assert.ok(width10(a.lens().content.split('\n')[0]) <= 558, 'draft head fitted')
  a.run('confirmAndSend()'); await settle()
  assert.ok(width10(a.lens().header) <= 568)
  assert.ok(a.lens().content.replace(/\s/g, '').includes(`To:${name}`), 'full name is in the body')
})

test('[qa MINOR] footers list the gestures that are live on each screen', async () => {
  const a = await messagesApp()
  await a.openDana(); await a.dictate('Hi')
  a.run('confirmAndSend()'); await settle()
  assert.match(a.lens().footer, /Hold:Discard/)
  assert.deepEqual([...a.run('lensMenuItems()').map((m) => m.itemName)], ['Discard reply'])
  const f = await fieldglassApp()
  f.control.startError = new Error('JWT fetch failed: HTTP 401')
  f.fg(`rootCursorKey = 'fg'; activateSelectedFromRoot()`); await settle()
  f.fg('fieldglass.onClick()'); f.fg('fieldglass.onClick()'); await settle()
  for (const ms of [1000, 2000, 4000, 8000]) {
    const [id, timer] = [...f.timers].find(([, t]) => t.ms === ms)
    f.timers.delete(id); timer.fn(); await settle()
  }
  assert.equal(f.fg('fieldglass.live.asrState'), 'failed')
  assert.match(f.lens().footer, /Hold:Menu/, 'the live hold menu is still registered, so the footer says so')
  assert.ok(f.fg('lensMenuItems()').length > 0)
})

test('[qa MINOR / reasonCode] server reason codes become en/ja lens text; unknown codes fall back to the server text', async () => {
  const a = await messagesApp({ reply: () => response(409, { error: 'The original chat, recipient, or service is no longer available.', reasonCode: 'target_unavailable' }) })
  const RO = { ...THREADS[1], readOnlyReasonCode: 'group_read_only' }
  const base = a.control.fetch
  a.control.fetch = async (url, o) => url.endsWith('/messages/threads') ? response(200, { threads: [THREADS[0], RO] })
    : url.includes('/threads/chat%3B%2B%3Bteam') ? response(200, { thread: RO, messages: [] }) : base(url, o)
  await a.run('messages.refreshSummary()')
  const i18n = a.modules.get('./i18n')
  i18n.setLanguage('ja')
  try {
    a.run(`rootCursorKey = 'msg'; activateSelectedFromRoot()`); await settle()
    a.run('messages.onScroll(1)'); a.run('messages.onClick()'); await settle()
    a.run('messages.onClick()'); await settle()
    assert.match(a.lens().footer, /グループは今は読むだけです/)
    a.run('messages.onDoubleClick()')
    a.run('messages.onScroll(-1)'); a.run('messages.onClick()'); await settle()
    await a.dictate('了解')
    a.run('confirmAndSend()'); await settle()
    a.run('messages.onClick()'); await settle()
    assert.match(a.lens().content, /このチャットは使えません/)
    assert.doesNotMatch(a.lens().content, /no longer available/)
  } finally { i18n.setLanguage('en') }
  // unknown code → the server's own text
  const { reasonText } = a.modules.get('./fieldglass/messages')
  assert.equal(reasonText('brand_new_code', 'Server text'), 'Server text')
  assert.equal(reasonText(undefined, 'Server text'), 'Server text')
})

// ─── Fix round 5 (qa2-codex QA #2: Retry after a definite Messages rejection) ────
// A fake server that follows the agreed contract: draftId idempotency only replays results that
// were 'sent' or 'unknown'; a definite rejection (4xx + reasonCode) is not cached, so the same
// draftId re-attempts. `osascript` counts real send attempts.
function contractServer() {
  const results = new Map()  // draftId → { ok, state } (sent / unknown only)
  const srv = { osascript: 0, automationAllowed: false, timeoutNext: false }
  srv.reply = (body) => {
    if (results.has(body.draftId)) return response(200, results.get(body.draftId))
    if (!srv.automationAllowed) return response(403, { error: 'Allow HeadLenss to control Messages.', reasonCode: 'automation_denied' })
    srv.osascript++
    const out = srv.timeoutNext ? { ok: true, state: 'unknown', reasonCode: 'delivery_unknown' } : { ok: true, state: 'sent', reasonCode: 'sent' }
    srv.timeoutNext = false
    results.set(body.draftId, out)
    return response(200, out)
  }
  return srv
}

test('[qa2 #2] after a definite rejection, Retry (Review again → Send) re-attempts with the same draftId and can succeed', async () => {
  const srv = contractServer()
  const a = await messagesApp({ reply: (n) => srv.reply(a.control.replies[n - 1].body) })
  await a.openDana(); await a.dictate('On my way')
  a.run('confirmAndSend()'); await settle()
  a.run('messages.onClick()'); await settle()
  assert.match(a.lens().content, /^Not sent\./)
  assert.match(a.lens().footer, /Tap:Review again/)
  assert.ok(a.run('promptDraft !== null'), 'draft kept for retry')
  srv.automationAllowed = true                      // user grants Automation on the Mac
  a.run('messages.onClick()'); await settle()       // Review again → confirm card
  assert.equal(a.run('messages.screen'), 'confirm')
  a.run('messages.onClick()'); await settle()       // Send
  assert.match(a.lens().content, /^Sent\./)
  assert.equal(srv.osascript, 1, 'the retry really dispatched')
  const [first, second] = a.control.replies
  assert.equal(first.body.draftId, second.body.draftId, 'same draftId: the server re-attempts only because the rejection was not cached')
  assert.equal(a.run('promptDraft'), null)
})

test('[qa2 #2] Retry is never offered after an unknown result, and a replayed draftId does not dispatch twice', async () => {
  const srv = contractServer()
  srv.automationAllowed = true; srv.timeoutNext = true
  const a = await messagesApp({ reply: (n) => srv.reply(a.control.replies[n - 1].body) })
  await a.openDana(); await a.dictate('Running late')
  a.run('confirmAndSend()'); await settle()
  a.run('messages.onClick()'); await settle()
  assert.match(a.lens().content, /Delivery unknown/)
  assert.doesNotMatch(a.lens().footer, /Review again|Retry/)
  assert.deepEqual([...(a.run('lensMenuItems()') ?? [])], [], 'no Discard/Retry menu on an unknown result')
  a.run('messages.onClick()'); await settle()
  assert.equal(a.run('messages.screen'), 'thread', 'Tap only goes back')
  assert.equal(a.control.replies.length, 1)
  assert.equal(srv.osascript, 1)
})

test('[qa2 #2] a 4xx without a reasonCode is not treated as a definite rejection (no Retry)', async () => {
  const a = await messagesApp({ reply: () => response(400, { error: 'Bad Request' }) })  // e.g. a proxy, or an old server
  await a.openDana(); await a.dictate('Hello')
  a.run('confirmAndSend()'); await settle()
  a.run('messages.onClick()'); await settle()
  assert.match(a.lens().content, /Delivery unknown/)
  assert.equal(a.run('promptDraft'), null, 'dropped: we cannot prove nothing was sent')
  const { HeadlenssClient } = a.modules.get('./server-client')
  a.control.fetch = async () => response(403, { error: 'x', reasonCode: 'automation_denied' })
  const e = await new HeadlenssClient('http://mac.invalid').messagesReply('t', { text: 'x', draftId: 'd' }).catch((err) => err)
  assert.equal(e.deliveryUnknown, false)
  assert.equal(e.reasonCode, 'automation_denied')
  a.control.fetch = async () => response(403, { error: 'x' })
  const e2 = await new HeadlenssClient('http://mac.invalid').messagesReply('t', { text: 'x', draftId: 'd' }).catch((err) => err)
  assert.equal(e2.deliveryUnknown, true)
})
