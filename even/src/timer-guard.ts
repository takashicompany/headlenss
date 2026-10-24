// ─── one-shot タイマーの二重発火よけ ───────────────────────────────────
//
// なぜ要るか (SDK 0.0.10 以降の実装バグ):
//
// even_hub_sdk は 0.0.10 で「ShadowTimers」を入れた。WebView が背面に回されて
// 実タイマーが止められても時間を進められるよう、window.setTimeout / setInterval を
// 差し替えて、自前の待ち行列にも同じ予定を登録する。ホスト (Even App) は
// window.__tickShadowTimers(経過ms) を呼んで、その待ち行列を進める。
//
// 問題は one-shot (setTimeout) の後始末が片側にしか無いこと。SDK の実装は
//
//   ・登録時   … 実タイマーを 1 本張り、同じ予定を待ち行列にも入れる
//   ・tick 発火 … コールバックを呼び、待ち行列からは消す
//                 ★ 実タイマーを止めず、エントリの cleared も立てない
//   ・実タイマー発火 … エントリの cleared を見て、false ならコールバックを呼ぶ
//
// となっている。つまりホストが tick で先に発火させると、待ち行列からは消えるが
// 実タイマーは生き残ったままで、あとから同じコールバックがもう一度呼ばれる。
// 1 回だけ動くはずの処理が 2 回動く。
//
// さらに厄介なのは、こちらから止められないこと。SDK の clearTimeout は
// 「待ち行列を引いて、居たら実タイマーを止める」作りなので、tick 発火で
// 既に待ち行列から消えた後に clearTimeout を呼んでも空振りする
// (しかも SDK 内部の id をそのまま native の clearTimeout に渡してしまう)。
// try/finally で必ず clearTimeout する書き方をしていても防げない。
//
// 実測 (scratchpad の再現ハーネス, 実バンドルを node で読み込み):
//   setTimeout(fn,100) → __tickShadowTimers(200) → fn が 1 回
//   → 実タイマーの 100ms 到達 → fn がもう 1 回 (計 2 回)
//   0.0.10 / 0.0.14 で同じ。0.0.9 には ShadowTimers 自体が無い。
//
// 対処:
// アプリから張る one-shot を「高々 1 回しか呼ばれない」形に包む。SDK の
// setTimeout の上にもう一枚かぶせ、コールバックを一度きりのラッパに差し替える。
// 待ち行列そのものは活かしたままなので、背面に回された時に時間が進む利点は
// 失わない。どちらの経路が先に来ても、実際に走るのは最初の 1 回だけになる。
//
// setInterval は包まない (繰り返しは意図した動作)。
//
// SDK 側が将来これを直したら、このラッパは何もしないのと同じになる
// (二重に呼ばれなくなるだけで、1 回目は必ず通る) ので、外し忘れても害は無い。

/** 二重に包まないための目印。 */
const GUARD_MARK = '__headlenssOneShotGuard'

type Guarded = typeof window.setTimeout & { [GUARD_MARK]?: true }

/**
 * window.setTimeout を「コールバックが高々 1 回」の版に差し替える。
 *
 * 必ず SDK の読み込み後に呼ぶこと。SDK は import 時点で window.setTimeout を
 * 差し替えるので、先に呼ぶとこちらの包みが上書きされて意味が無くなる。
 * 何度呼んでも 2 枚目は掛からない。
 */
export function installOneShotTimerGuard(): boolean {
  if (typeof window === 'undefined') return false
  const base = window.setTimeout as Guarded
  if (base[GUARD_MARK]) return false

  const guarded = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    // 文字列コールバック等はそのまま流す (アプリでは使わないが、素通しにしておく)
    if (typeof handler !== 'function') {
      return base(handler, timeout, ...args)
    }
    let fired = false
    return base(
      (...cbArgs: unknown[]) => {
        // 2 回目以降は捨てる。例外で抜けても「呼んだ」扱いにしたいので先に立てる。
        if (fired) return
        fired = true
        ;(handler as (...a: unknown[]) => void)(...cbArgs)
      },
      timeout,
      ...args,
    )
  }) as Guarded

  guarded[GUARD_MARK] = true
  window.setTimeout = guarded
  return true
}
