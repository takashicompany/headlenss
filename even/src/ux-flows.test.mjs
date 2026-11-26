// Offline flow tests: execute the real app state machine and HTTP client with
// fake DOM, lens, microphone, timers and fetch. No browser/server is started.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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

function app({ polling = false, realAsr = false } = {}) {
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
    console: { log() {}, warn() {}, error() {} },
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
    './renderer': { MAIN_INNER_WIDTH: 558, HEADER_INNER_WIDTH: 568 },
    './audio': {
      getPcmByteLength: () => control.bytes, getRecordingSeconds: () => control.seconds,
      resetPcmCounter() {}, startRecordingClock() {}, stopRecordingClock() {}, trackPcmFrame() {},
    },
    './mic': {
      openMic: async () => control.micResult, closeMic: async () => { control.closes = (control.closes ?? 0) + 1; return true },
      micIsHeld: () => false, micHealth: () => ({}), resetMicState() {},
    },
    './events': {}, './favorites': {}, './plugin-launch': {}, './plugin-takeover': {},
    './timer-guard': { installOneShotTimerGuard() {} },
    './speechmatics-rt': { recoverAsrText: (text, reason) => text.trim()
      ? { kind: 'recovered-partial', text: text.trim(), reason } : { kind: 'failure', text: '', reason }, SpeechmaticsRT: class {
      async start(opts) { control.recordings++; control.asr = opts; if (control.startError) throw control.startError }
      async stop() { if (control.stopError) throw control.stopError; return control.outcome ?? (control.transcript.trim()
        ? { kind: 'final', text: control.transcript.trim() } : { kind: 'failure', text: '', reason: 'no-speech' }) }
      fullTranscript() { return control.partial ?? '' }
      abort() {}
    } },
  }
  if (realAsr) delete mocks['./speechmatics-rt']
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
  function requireModule(name) {
    if (Object.hasOwn(mocks, name)) return mocks[name]
    if (!modules.has(name)) {
      assert.ok(['./i18n', './settings', './server-client', './speechmatics-rt'].includes(name), `Unexpected module ${name}`)
      const exports = {}
      modules.set(name, exports)
      vm.runInContext(`(function(require, exports) { ${compile(name)}\n})`, context)(requireModule, exports)
    }
    return modules.get(name)
  }
  context.require = requireModule
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
