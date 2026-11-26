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

function app() {
  const frames = [], requests = [], timers = new Map(), elements = new Map()
  const control = {
    fetch: async () => { throw new Error('Unexpected fetch (network is disabled)') },
    transcript: 'Use the local cache.', recordings: 0,
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
    fetch: (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) })
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
      getPcmByteLength: () => 1024, getRecordingSeconds: () => 1,
      resetPcmCounter() {}, startRecordingClock() {}, stopRecordingClock() {}, trackPcmFrame() {},
    },
    './mic': {
      openMic: async () => ({ ok: true }), closeMic: async () => true,
      micIsHeld: () => false, micHealth: () => ({}), resetMicState() {},
    },
    './events': {}, './favorites': {}, './plugin-launch': {}, './plugin-takeover': {},
    './timer-guard': { installOneShotTimerGuard() {} },
    './speechmatics-rt': { SpeechmaticsRT: class {
      async start() { control.recordings++ }
      async stop() { return control.transcript }
      abort() {}
    } },
  }
  const modules = new Map()
  function compile(name) {
    let source = readFileSync(new URL(`${name}.ts`, import.meta.url), 'utf8')
    if (name === './main') {
      // Bootstrap is the only excluded entrypoint; tests drive the same flow functions
      // normally called by its installed gesture handlers.
      source = source.slice(0, source.lastIndexOf('\nboot().catch('))
      source = source.replaceAll('import.meta.env.DEV', 'false')
    }
    return ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    } }).outputText
  }
  function requireModule(name) {
    if (Object.hasOwn(mocks, name)) return mocks[name]
    if (!modules.has(name)) {
      assert.ok(['./i18n', './settings', './server-client'].includes(name), `Unexpected module ${name}`)
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
    refreshClaudeData = async () => {};
    applyClientBase();
  `)
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
