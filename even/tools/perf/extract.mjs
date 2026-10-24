// main.ts から指定の宣言だけを原文のまま切り出す (ベンチが実装を写し間違えないように)。
import fs from 'node:fs'

/** `const NAME`/`let NAME`/`function NAME` の宣言を、波括弧/行末まで原文で取り出す */
export function extractDecls(src, names) {
  const out = []
  for (const name of names) {
    const re = new RegExp(`^(?:const|let|function|type) ${name}\\b`, 'm')
    const m = re.exec(src)
    if (!m) throw new Error(`decl not found: ${name}`)
    const start = m.index
    // 宣言の終わりを探す: 最初の '{' からブレース対応、無ければ行末
    let i = start
    let brace = -1
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '\n' && brace === -1) break
      if (c === '{') { brace = i; break }
    }
    if (brace === -1) { out.push(src.slice(start, i)); continue }
    let depth = 0, j = brace, inStr = null, inTpl = 0
    for (; j < src.length; j++) {
      const c = src[j], p = src[j - 1]
      if (inStr) { if (c === inStr && p !== '\\') inStr = null; continue }
      if (c === "'" || c === '"' || c === '`') { inStr = c; continue }
      if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); if (j < 0) break; continue }
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) { j++; break } }
    }
    out.push(src.slice(start, j))
  }
  return out.join('\n\n')
}
