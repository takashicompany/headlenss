import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractChatFromTranscript, extractLastAssistantText, sanitizeChatText } from './claude/transcript.ts';

// 実 transcript から秘匿情報を除いて作った最小サンプル。
//  - claude-2.1.302.jsonl: Claude Code 2.1.300 以降の形式 (api-request-blob 等が混ざる)
//  - claude-legacy.jsonl : それ以前の形式
const FIXTURES = join(import.meta.dirname, 'fixtures', 'transcripts');
const NEW_FORMAT = join(FIXTURES, 'claude-2.1.302.jsonl');
const LEGACY = join(FIXTURES, 'claude-legacy.jsonl');

test('新形式: 会話は user/assistant 行だけから、実際の順序と時刻で取り出す', async () => {
  const chat = await extractChatFromTranscript(NEW_FORMAT);
  assert.deepEqual(
    chat.map((m) => [m.role, m.text, new Date(m.ts).toISOString()]),
    [
      ['user', 'G2 用のプラグインを作りたい', '2026-10-18T01:50:26.944Z'],
      ['assistant', 'The screens work. I will fix the link markup next.', '2026-10-18T01:50:31.000Z'],
      ['assistant', 'できました。', '2026-10-18T01:50:40.000Z'],
      ['user', 'urlくれ', '2026-10-19T23:54:15.192Z'],
      ['assistant', 'URL は次のとおりです。\n\n- https://example.invalid/app/', '2026-10-19T23:54:27.766Z'],
    ],
  );
});

test('新形式: api-request-blob の再送コピー・注入文脈を発言として数えない', async () => {
  const chat = await extractChatFromTranscript(NEW_FORMAT);
  const texts = chat.map((m) => m.text);
  // 再送コピーで同じ発言が重複しない
  assert.equal(texts.filter((t) => t.startsWith('The screens work.')).length, 1);
  assert.equal(texts.filter((t) => t === 'urlくれ').length, 1);
  // blob にしか無い注入文脈 / skill 本文 / compact 要約は出ない
  assert.ok(!texts.some((t) => t.includes('Base directory for this skill')));
  assert.ok(!texts.some((t) => t.includes('Tool loaded.')));
  assert.ok(!texts.some((t) => t.includes('total_tokens')));
  assert.ok(!texts.some((t) => t.includes('This session is being continued')));
});

test('新形式: 最後の項目は tmux に出ている最終回答 (tail 読みでも同じ)', async () => {
  for (const tail of [false, true]) {
    const chat = await extractChatFromTranscript(NEW_FORMAT, 2, tail);
    assert.equal(chat.length, 2);
    assert.equal(chat[0].text, 'urlくれ');
    assert.match(chat[1].text, /^URL は次のとおりです。/);
    assert.equal(chat[1].agent, 'claude');
  }
});

test('tail 読み: 末尾を大きな非会話行が占めていても limit 件まで遡って取り出す', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'headlenss-transcript-'));
  try {
    const path = join(dir, 'big.jsonl');
    const turn = (i: number) => [
      JSON.stringify({ type: 'user', timestamp: `2026-10-19T00:00:0${i}.000Z`, message: { role: 'user', content: `q${i}` } }),
      JSON.stringify({ type: 'assistant', timestamp: `2026-10-19T00:00:0${i}.500Z`, message: { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] } }),
    ];
    // 1 行 100KB の api-request-blob を 20 行 (= 約 2MB) 末尾に積む
    const blob = JSON.stringify({ type: 'api-request-blob', hash: 'h', message: { role: 'system', content: [{ type: 'text', text: 'x'.repeat(100_000) }] } });
    const lines = [...turn(1), ...turn(2), ...Array(20).fill(blob)];
    writeFileSync(path, `${lines.join('\n')}\n`);
    const chat = await extractChatFromTranscript(path, 3, true);
    assert.deepEqual(chat.map((m) => m.text), ['a1', 'q2', 'a2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('新形式: 時刻は transcript 由来で、取得時刻で埋めない', async () => {
  const before = Date.now();
  const chat = await extractChatFromTranscript(NEW_FORMAT);
  for (const m of chat) assert.ok(m.ts < before, `ts は過去の実時刻: ${m.text}`);
  // 時系列順に並んでいる
  for (let i = 1; i < chat.length; i++) assert.ok(chat[i].ts >= chat[i - 1].ts);
});

test('新形式: 最後の assistant 本文は再送コピーではなく最新の発言', async () => {
  assert.match(await extractLastAssistantText(NEW_FORMAT), /^URL は次のとおりです。/);
});

test('旧形式: 従来どおり読める (thinking/tool/meta/sidechain 除外、コマンドは名前だけ)', async () => {
  const chat = await extractChatFromTranscript(LEGACY);
  assert.deepEqual(
    chat.map((m) => [m.role, m.text, new Date(m.ts).toISOString()]),
    [
      ['user', 'こんにちは', '2026-09-01T10:00:00.000Z'],
      ['assistant', '調べます。', '2026-09-01T10:00:06.000Z'],
      ['user', '/commit-ai', '2026-09-01T10:00:09.000Z'],
      ['assistant', '完了しました。', '2026-09-01T10:00:10.000Z'],
    ],
  );
  assert.equal(await extractLastAssistantText(LEGACY), '完了しました。');
});

test('sanitizeChatText は属性付きの system-reminder も取り除く', () => {
  assert.equal(sanitizeChatText('本文<system-reminder id="x">\nnoise\n</system-reminder>'), '本文');
});
