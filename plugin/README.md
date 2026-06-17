# headlenss plugin

Claude Code プラグイン。Claude Code のライフサイクルイベント(`SessionStart`、`UserPromptSubmit`、`Stop`、`PreToolUse`、`PermissionRequest`、`SessionEnd`)を headlenss サーバーへ HTTP で転送する。

これにより、G2 スマートグラス側で:
- 起動中の Claude Code を持つ tmux セッション一覧
- そのセッションでのユーザー発言 + Claude の返事のチャット表示
- 承認/質問待ちの状態通知 + 応答 UI
が出せるようになる。

## 必要なもの

- Claude Code v2.1 以降
- headlenss サーバーが `http://localhost:3000` で起動していること
- tmux 配下で Claude Code を起動していること(`TMUX` / `TMUX_PANE` 環境変数があること)

## インストール

未公開。開発中はローカルディレクトリ指定で:
```
/plugin marketplace add /path/to/headlenss
/plugin install headlenss@headlenss
```

(マーケットプレイス JSON は別途用意予定)

## 動作

Claude Code がイベントを発火するたびに、headlenss サーバーの `/api/hooks/*` へ HTTP POST する。`PreToolUse` / `PermissionRequest` は long-poll(最大 600 秒)で待機状態をブロックし、G2 から応答が来たら hook レスポンスとして返す(承認/拒否/回答を Claude Code に伝える)。

## 設定

現状はサーバーURLが `http://localhost:3000` でハードコード。今後 `userConfig` で変更可能にする予定。

## Codex hooks

This plugin also includes Codex lifecycle hooks under `plugin/codex-hooks/` and `plugin/.codex-plugin/plugin.json`.

When installed as a Codex plugin, the hooks forward `SessionStart`, `UserPromptSubmit`, `Stop`, and `PermissionRequest` events to the headlenss server at `http://localhost:3000` by default. Set `HEADLENSS_SERVER_URL` before launching Codex to target a different server URL.

Install the global Codex hooks once:

```bash
node /path/to/headlenss/plugin/codex-hooks/install.mjs
```

This merges HeadLenss hook definitions into `~/.codex/hooks.json` and backs up any existing file before writing. Restart Codex, open `/hooks`, and review/trust the HeadLenss hook definitions.

After that, launch Codex inside any tmux session so the hook can resolve `TMUX_PANE` back to the headlenss tmux session:

```bash
tmux new -s codex-work -c /path/to/your/project codex
```

No HeadLenss Web UI session creation is required; the tmux session appears automatically after Codex starts and emits lifecycle events.

To remove the global Codex hooks:

```bash
node /path/to/headlenss/plugin/codex-hooks/uninstall.mjs
```

For HeadLenss development, this repository also includes project-local `.codex/hooks.json`, but global hooks are the normal setup for end users because they work from any project.
