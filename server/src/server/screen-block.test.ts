import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import {
  hasClaudeInputBox,
  isClaudeScreenBlocked,
  pruneScreenBlockObservations,
  resetScreenBlockObservations,
  resolveScreenBlocked,
  SCREEN_BLOCK_CONFIRM_MS,
} from './screen-block.ts';

// フィクスチャは全て実機の `tmux capture-pane -p -J -S -80` そのまま。
// 推測で書いたマーカーを固定しないよう、健常 (idle / busy) と占有中の実物を並べてある。
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/panes');
const pane = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8');

const IDLE_80 = 'claude-idle-80col.txt';
const IDLE_93 = 'claude-idle-93col.txt';
const IDLE_BG_AGENTS = 'claude-idle-bg-agents-95col.txt';
const BUSY_95 = 'claude-busy-95col.txt';
const WIZARD_90 = 'claude-wizard-auto-mode-setup-90col.txt';
const SHELL_44 = 'shell-prompt-44col.txt';

test('健常な Claude pane は入力欄が見えている (idle / 幅違い / 背景エージェント付き)', () => {
  for (const f of [IDLE_80, IDLE_93, IDLE_BG_AGENTS]) {
    assert.equal(hasClaudeInputBox(pane(f)), true, f);
    assert.equal(isClaudeScreenBlocked(pane(f)), false, f);
  }
});

test('busy (esc to interrupt 表示中) を画面ブロックと誤検知しない', () => {
  const text = pane(BUSY_95);
  // このフィクスチャが本当に busy 中のものであることを固定しておく
  // (別のキャプチャに差し替わって「busy を通した」担保が消えるのを防ぐ)。
  assert.ok(text.includes('esc to interrupt'));
  assert.equal(hasClaudeInputBox(text), true);
  assert.equal(isClaudeScreenBlocked(text), false);
});

test('ウィザードが画面を占有していると入力欄が見えない', () => {
  const text = pane(WIZARD_90);
  assert.ok(text.includes('Set up auto mode for your environment?'));
  // スクロールバックには起動時にエコーされた `❯ /auto-mode-setup` が残っている。
  // これに釣られて「健常」と誤判定しないことがこのテストの主眼。
  assert.ok(text.includes('❯ /auto-mode-setup'));
  assert.equal(hasClaudeInputBox(text), false);
  assert.equal(isClaudeScreenBlocked(text), true);
});

test('シェルだけの pane にも入力欄は無い', () => {
  assert.equal(hasClaudeInputBox(pane(SHELL_44)), false);
});

test('テキストが取れていない時は判定しない', () => {
  assert.equal(isClaudeScreenBlocked(undefined), false);
  assert.equal(isClaudeScreenBlocked(''), false);
  assert.equal(isClaudeScreenBlocked('   \n  \n'), false);
});

test('capture-pane -J で罫線と次行が繋がっても判定が崩れない', () => {
  const rule = '─'.repeat(80);
  const joined = ['some output', `${rule}❯ hello`, rule, '  hints'].join('\n');
  assert.equal(hasClaudeInputBox(joined), true);
});

test('罫線が連続しているだけ (枠の中身が無い) では入力欄とみなさない', () => {
  const rule = '─'.repeat(80);
  assert.equal(hasClaudeInputBox([rule, rule].join('\n')), false);
});

// ───────── resolveScreenBlocked (対象外の切り分け + 継続確認) ─────────

const NAME = 'hit-and-blow';

function resolve3(opts: {
  source?: 'claude' | 'codex';
  status?: 'idle' | 'busy' | 'waiting-permission' | 'waiting-question';
  paneText?: string;
  now: number;
}): boolean {
  return resolveScreenBlocked({
    tmuxSessionName: NAME,
    source: opts.source ?? 'claude',
    status: opts.status ?? 'idle',
    paneText: opts.paneText,
  }, opts.now);
}

test('ブロックが続いて初めて確定する (再描画の 1 コマで警告を出さない)', () => {
  resetScreenBlockObservations();
  const blocked = pane(WIZARD_90);
  assert.equal(resolve3({ paneText: blocked, now: 1000 }), false, '初回観測は保留');
  assert.equal(resolve3({ paneText: blocked, now: 1000 + SCREEN_BLOCK_CONFIRM_MS - 1 }), false);
  assert.equal(resolve3({ paneText: blocked, now: 1000 + SCREEN_BLOCK_CONFIRM_MS }), true);
});

test('入力欄が戻れば確定済みでも即座に解除され、観測もやり直しになる', () => {
  resetScreenBlockObservations();
  const blocked = pane(WIZARD_90);
  const healthy = pane(IDLE_80);
  assert.equal(resolve3({ paneText: blocked, now: 0 }), false);
  assert.equal(resolve3({ paneText: blocked, now: SCREEN_BLOCK_CONFIRM_MS }), true);
  assert.equal(resolve3({ paneText: healthy, now: SCREEN_BLOCK_CONFIRM_MS + 1 }), false);
  // やり直しなので、次にブロックしてもすぐには確定しない
  assert.equal(resolve3({ paneText: blocked, now: SCREEN_BLOCK_CONFIRM_MS + 2 }), false);
});

test('busy はブロック扱いにならない (実キャプチャで通す)', () => {
  resetScreenBlockObservations();
  const busy = pane(BUSY_95);
  assert.equal(resolve3({ status: 'busy', paneText: busy, now: 0 }), false);
  assert.equal(resolve3({ status: 'busy', paneText: busy, now: 10 * SCREEN_BLOCK_CONFIRM_MS }), false);
});

test('waiting-permission / waiting-question は対象外 (正規の応答経路があるため)', () => {
  for (const status of ['waiting-permission', 'waiting-question'] as const) {
    resetScreenBlockObservations();
    const blocked = pane(WIZARD_90);
    assert.equal(resolve3({ status, paneText: blocked, now: 0 }), false);
    assert.equal(resolve3({ status, paneText: blocked, now: 10 * SCREEN_BLOCK_CONFIRM_MS }), false);
  }
});

test('Codex / agent 不明のセッションは対象外', () => {
  const blocked = pane(WIZARD_90);
  for (const source of ['codex', undefined] as const) {
    resetScreenBlockObservations();
    const input = { tmuxSessionName: NAME, source, status: 'idle' as const, paneText: blocked };
    assert.equal(resolveScreenBlocked(input, 0), false);
    assert.equal(resolveScreenBlocked(input, 10 * SCREEN_BLOCK_CONFIRM_MS), false);
  }
});

test('pane テキストが欠けた回は観測を持ち越さない', () => {
  resetScreenBlockObservations();
  const blocked = pane(WIZARD_90);
  assert.equal(resolve3({ paneText: blocked, now: 0 }), false);
  assert.equal(resolve3({ paneText: undefined, now: 1000 }), false, '取得失敗は警告にしない');
  // 取得失敗で観測が消えているので、再開後は確定まで改めて CONFIRM_MS かかる
  assert.equal(resolve3({ paneText: blocked, now: 2000 }), false);
  assert.equal(resolve3({ paneText: blocked, now: 2000 + SCREEN_BLOCK_CONFIRM_MS - 1 }), false);
  assert.equal(resolve3({ paneText: blocked, now: 2000 + SCREEN_BLOCK_CONFIRM_MS }), true);
});

test('消えた tmux セッションの観測は prune で捨てられる', () => {
  resetScreenBlockObservations();
  const blocked = pane(WIZARD_90);
  assert.equal(resolve3({ paneText: blocked, now: 0 }), false);
  pruneScreenBlockObservations(new Set<string>());
  assert.equal(resolve3({ paneText: blocked, now: SCREEN_BLOCK_CONFIRM_MS }), false, '記録が消えたので数え直し');
  assert.equal(resolve3({ paneText: blocked, now: 2 * SCREEN_BLOCK_CONFIRM_MS }), true);
});
