// Codex セッションの会話表示がサーバ再起動で空になる問題の恒久対策
// (スナップショットへの transcriptPath 保存 → 起動時の store 復元) のテスト。
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from './claude/store.ts';
import { collectCodexSnapshots, parseSnapshot, restoreCodexStoreEntries } from './persist.ts';

const NAME = 'persist-codex-test';

function makeTranscript(dir: string): string {
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, '{"type":"message","role":"assistant","content":"hi"}\n');
  return path;
}

/** saveSnapshot が書くのと同じ形の JSON を作る (tmux を叩かずに保存経路を再現する)。 */
function serialize(entries: ReturnType<typeof parseSnapshot>): string {
  return JSON.stringify({ version: 1, savedAt: Date.now(), sessions: entries });
}

function cleanup(): void {
  store.removeSession(NAME);
}

test('保存 → 復元のラウンドトリップで transcriptPath が戻る', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persist-codex-'));
  try {
    const transcriptPath = makeTranscript(dir);
    store.upsertSession({
      ccSessionId: 'codex-1',
      tmuxPane: '%42',
      tmuxSessionName: NAME,
      cwd: dir,
      source: 'codex',
      transcriptPath,
    });

    const codexByName = collectCodexSnapshots();
    assert.deepEqual(codexByName.get(NAME), {
      ccSessionId: 'codex-1',
      tmuxPane: '%42',
      cwd: dir,
      transcriptPath,
    });

    const raw = serialize([
      { tmuxSessionName: NAME, cwd: dir, hasClaude: true, codex: codexByName.get(NAME) },
    ]);

    // サーバ再起動 = store が空の状態
    cleanup();
    assert.equal(store.getSession(NAME), undefined);

    const entries = parseSnapshot(raw);
    restoreCodexStoreEntries(entries, new Set([NAME]));

    const restored = store.getSession(NAME);
    assert.ok(restored, 'store に復元されていること');
    assert.equal(restored.source, 'codex');
    assert.equal(restored.transcriptPath, transcriptPath);
    assert.equal(restored.ccSessionId, 'codex-1');
    assert.equal(restored.tmuxPane, '%42');
    assert.equal(restored.cwd, dir);
    // 会話本体は transcript から読むので chat は空・status は idle のまま
    assert.deepEqual(restored.chat, []);
    assert.equal(restored.status, 'idle');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcript ファイルが実在しなければ復元しない', () => {
  try {
    const entries = parseSnapshot(
      serialize([
        {
          tmuxSessionName: NAME,
          cwd: '/tmp',
          hasClaude: false,
          codex: {
            ccSessionId: 'codex-1',
            tmuxPane: '%42',
            cwd: '/tmp',
            transcriptPath: '/tmp/definitely-missing-headlenss-transcript.jsonl',
          },
        },
      ]),
    );
    restoreCodexStoreEntries(entries, new Set([NAME]));
    assert.equal(store.getSession(NAME), undefined);
  } finally {
    cleanup();
  }
});

test('tmux セッションが存在しない名前は復元しない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persist-codex-'));
  try {
    const transcriptPath = makeTranscript(dir);
    const entries = parseSnapshot(
      serialize([
        {
          tmuxSessionName: NAME,
          cwd: dir,
          hasClaude: false,
          codex: { ccSessionId: '', tmuxPane: '', cwd: dir, transcriptPath },
        },
      ]),
    );
    restoreCodexStoreEntries(entries, new Set());
    assert.equal(store.getSession(NAME), undefined);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('復元中に届いたフックの store を上書きしない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persist-codex-'));
  try {
    const transcriptPath = makeTranscript(dir);
    // 先に Claude のフックが登録された状態を作る
    store.upsertSession({
      ccSessionId: 'claude-1',
      tmuxPane: '%1',
      tmuxSessionName: NAME,
      cwd: dir,
      source: 'claude',
    });
    const entries = parseSnapshot(
      serialize([
        {
          tmuxSessionName: NAME,
          cwd: dir,
          hasClaude: true,
          codex: { ccSessionId: 'codex-1', tmuxPane: '%42', cwd: dir, transcriptPath },
        },
      ]),
    );
    restoreCodexStoreEntries(entries, new Set([NAME]));

    const kept = store.getSession(NAME);
    assert.ok(kept);
    assert.equal(kept.source, 'claude');
    assert.equal(kept.transcriptPath, undefined);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex を持たない旧形式のスナップショットも読める', () => {
  const raw = JSON.stringify({
    version: 1,
    savedAt: 1,
    sessions: [{ tmuxSessionName: 'old', cwd: '/home/x', hasClaude: true }],
  });
  const entries = parseSnapshot(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tmuxSessionName, 'old');
  assert.equal(entries[0].hasClaude, true);
  assert.equal(entries[0].codex, undefined);
});

test('codex フィールドが壊れていてもエントリ自体は残る', () => {
  const entries = parseSnapshot(
    JSON.stringify({
      version: 1,
      savedAt: 1,
      sessions: [
        { tmuxSessionName: 'a', cwd: '/x', hasClaude: false, codex: { ccSessionId: 'z' } },
        { tmuxSessionName: 'b', cwd: '/y', hasClaude: false, codex: 'nonsense' },
      ],
    }),
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].codex, undefined);
  assert.equal(entries[1].codex, undefined);
});

test('version 違い / 壊れた JSON は空配列', () => {
  assert.deepEqual(parseSnapshot(JSON.stringify({ version: 2, savedAt: 1, sessions: [] })), []);
  assert.deepEqual(parseSnapshot('{'), []);
  assert.deepEqual(parseSnapshot(JSON.stringify({ version: 1, savedAt: 1 })), []);
});
