// チャット整形コストの前後比較ベンチ。
//
// 実装は main.ts の原文をそのまま切り出して使う (手で写すとベンチと本番がずれるため)。
// 比較対象:
//   before = git の指定 ref の main.ts
//   after  = 作業ツリーの main.ts
//
// 使い方: node even/tools/perf/bench_chat.mjs [beforeRef]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractDecls } from './extract.mjs'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const BEFORE_REF = process.argv[2] || 'HEAD'
const CHAT_WRAP_PX = 576 - 2 * (8 + 1) - 2   // MAIN_INNER_WIDTH - 2

const PRELUDE = `
import { getTextWidth } from '${REPO}/even/node_modules/@evenrealities/pretext/dist/font_measure.js'
type ChatItem = { role: string; text: string }
type AgentSource = 'claude' | 'codex'
const t = (_k: string): string => '… (全{total}文字)'
const getLanguage = (): string => 'ja'
let currentAgentSource: AgentSource | undefined = 'claude'
`

const NAMES_AFTER = [
  'GLYPH_WIDTH_MEMO_MAX', 'glyphWidthMemo', 'glyphWidth', 'measuredWidth', 'advanceWidth',
  'CHAT_MSG_MAX_CHARS', 'CHAT_ITEM_LINES_CACHE_MAX', 'chatItemLinesCache',
  'chatItemLines', 'formatChatLines', 'wrapText', 'chatCacheKeyOf',
]
const NAMES_BEFORE = ['formatChatLines', 'wrapText', 'chatCacheKeyOf']

async function loadImpl(label, src, names) {
  const body = PRELUDE + extractDecls(src, names) +
    `\nexport { formatChatLines, wrapText, chatCacheKeyOf }\n`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${label}-`))
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
  const tmp = path.join(dir, 'impl.ts')
  fs.writeFileSync(tmp, body)
  // TS の型注釈だけを剥がす (中身は原文のまま)。未解決の型が出ても emit はされるので
  // 終了コードは見ない (見た目の一致確認とベンチ結果が本体の検証)。
  try {
    execFileSync(path.join(REPO, 'even/node_modules/.bin/tsc'),
      [tmp, '--target', 'es2022', '--module', 'es2022', '--moduleResolution', 'bundler',
       '--skipLibCheck', '--outDir', dir], { stdio: 'pipe' })
  } catch { /* 型エラーは無視 (emit 済み) */ }
  const outJs = path.join(dir, 'impl.js')
  if (!fs.existsSync(outJs)) throw new Error(`tsc emit failed for ${label}`)
  return await import(pathToFileURL(outJs).href)
}

const JA = 'レンズへの送信は直列化されており、待機枠は最新の1件だけを保持する。'
const EN = 'The pump serializes bridge sends so that at most one frame is in flight at any moment. '
function body(chars, seed) {
  let s = `[${seed}] `
  while (s.length < chars) s += (s.length % 400 < 200 ? JA : EN)
  return s.slice(0, chars).replace(/(.{120})/g, '$1\n')
}
function window20(per, gen) {
  return Array.from({ length: 20 }, (_, i) =>
    ({ role: i % 2 ? 'assistant' : 'user', text: body(per, gen + i) }))
}

function timed(fn, budgetMs = 500) {
  fn(); fn()
  const t0 = performance.now()
  let n = 0
  while (performance.now() - t0 < budgetMs) { fn(); n++ }
  return (performance.now() - t0) / n
}

/** 新着 1 件で 20 件窓が 1 つスライドしたときの整形コスト (実運用で毎回起きる形)。 */
function slideCost(impl, per) {
  let gen = 0
  const first = window20(per, gen)
  impl.formatChatLines(first, CHAT_WRAP_PX, 'claude')  // 初回 (キャッシュを温める)
  return timed(() => {
    gen++
    impl.formatChatLines(window20(per, gen), CHAT_WRAP_PX, 'claude')
  }, 500)
}

/** 完全に新しい 20 件を整形するコスト (キャッシュが効かない最悪ケース = 初回表示)。 */
function coldCost(impl, per) {
  let gen = 1000
  return timed(() => {
    gen += 100
    impl.formatChatLines(window20(per, gen), CHAT_WRAP_PX, 'claude')
  }, 500)
}

const main = async () => {
  const beforeSrc = execFileSync('git', ['-C', REPO, 'show', `${BEFORE_REF}:even/src/main.ts`]).toString()
  const afterSrc = fs.readFileSync(path.join(REPO, 'even/src/main.ts'), 'utf8')
  const before = await loadImpl('before', beforeSrc, NAMES_BEFORE)
  const after = await loadImpl('after', afterSrc, NAMES_AFTER)

  // 出力が一致することの確認 (上限未満の長さなら見た目は不変であるべき)
  for (const per of [100, 600, 2500]) {
    const w = window20(per, 7)
    const a = before.formatChatLines(w, CHAT_WRAP_PX, 'claude').join('\n')
    const b = after.formatChatLines(w, CHAT_WRAP_PX, 'claude').join('\n')
    console.log(`  出力一致 (${per}字/件, 上限${per <= 4000 ? '内' : '超'}): ${a === b ? 'OK' : 'MISMATCH'}`)
    if (a !== b) { console.log('--- before ---\n' + a.slice(0, 400) + '\n--- after ---\n' + b.slice(0, 400)) }
  }

  // 上限超過ケース: 4000 字までは before と同じ折り返し、その後に省略行が 1 行付くだけ
  {
    const w = window20(6000, 11).map((it) => ({ ...it, text: it.text.replace(/\r/g, '').trim() }))
    const len = w[0].text.length
    const b = before.formatChatLines(w, CHAT_WRAP_PX, 'claude')
    const a = after.formatChatLines(w, CHAT_WRAP_PX, 'claude')
    const cut = w.map((it) => ({ ...it, text: it.text.slice(0, 4000) }))
    const bCut = before.formatChatLines(cut, CHAT_WRAP_PX, 'claude')
    const notice = `… (全${len}文字)`
    const notices = a.filter((l) => l === notice).length
    const aNoNotice = a.filter((l) => l !== notice)
    console.log(`  上限超過 (${len}字/件): before ${b.length}行 → after ${a.length}行 ` +
      `(省略行 ${notices} 本 = 発言数)  4000字で切った before と本文一致: ` +
      `${aNoNotice.join('\n') === bCut.join('\n') ? 'OK' : 'MISMATCH'}`)
  }

  console.log(`\nbefore = ${BEFORE_REF}:even/src/main.ts / after = worktree`)
  console.log('\n== 新着 1 件で 20 件窓がスライドした時の formatChatLines 1 回 (ms) ==')
  console.log(' 字/件   総字数   before    after    削減')
  for (const per of [600, 2500, 5000]) {
    const total = per * 20
    const b = slideCost(before, per)
    const a = slideCost(after, per)
    console.log(` ${String(per).padStart(5)} ${String(total).padStart(8)} ${b.toFixed(2).padStart(8)} ${a.toFixed(2).padStart(8)} ${((1 - a / b) * 100).toFixed(1).padStart(7)}%`)
  }
  console.log('\n== 20 件すべて新規 (キャッシュ無効 = 初回表示) の formatChatLines 1 回 (ms) ==')
  console.log(' 字/件   総字数   before    after    削減')
  for (const per of [600, 2500, 5000]) {
    const total = per * 20
    const b = coldCost(before, per)
    const a = coldCost(after, per)
    console.log(` ${String(per).padStart(5)} ${String(total).padStart(8)} ${b.toFixed(2).padStart(8)} ${a.toFixed(2).padStart(8)} ${((1 - a / b) * 100).toFixed(1).padStart(7)}%`)
  }
}
main()
