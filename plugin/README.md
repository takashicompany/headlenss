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

## Agent skills (Claude Code / Codex)

`plugin/skills/` に同梱しているスキル (headlenss 自体の操作手順書) を**コピー**で
インストールする。配置先は 2 つで、同じ内容が両方に入る:

- Claude Code: `~/.claude/skills/<name>/`
- Codex: `$CODEX_HOME/skills/<name>/` (未設定なら `~/.codex/skills/<name>/`)

```bash
node /path/to/headlenss/plugin/skills/install.mjs
# または server/ で: npm run skills:install
```

同梱しているスキル:

| スキル | 内容 |
|---|---|
| `headlenss-new-session` | API で新しい tmux セッションを作る |
| `headlenss-g2-plugin` | 開発中の G2 プラグインをセッション一覧に出し、グラスから開く |
| `headlenss-dev-server` | headlenss のポートを奪わずに dev server を立てて tailnet に公開する |
| `headlenss-preview-tabs` | 作った HTML / dev server を Web UI のセッション画面のタブに出す |

- シンボリックリンクではなくコピーなので、リポジトリを移動・削除しても壊れない。
  更新は `git pull` 後にもう一度実行するだけ (冪等。中身が同じなら何もしない)。
- 同名スキルが既にあり、それが headlenss 由来でない場合は、その配置先の
  `skills-backup/<name>.bak.<timestamp>/` (例: `~/.claude/skills-backup/`、`~/.codex/skills-backup/`)
  に退避してから上書きする。退避したものは uninstall しても自動では戻らない (必要なら手で
  `skills/<name>/` へ戻す)。
- `HEADLENSS_SERVER_URL=http://<host>:3000` を付けて実行すると、`headlenss-new-session` スキル本文の
  API URL がそのホストに差し替わる。他のスキル (`headlenss-dev-server` / `headlenss-g2-plugin` /
  `headlenss-preview-tabs`) は headlenss と同じマシンで実行する手順書なので、本文のループバック
  URL はそのまま残す。

外すとき:

```bash
node /path/to/headlenss/plugin/skills/uninstall.mjs
# または server/ で: npm run skills:uninstall
```

インストール時に各ディレクトリへ `.headlenss-skill.json` (マーカー) を置いており、
uninstall は両方の配置先を走査して、それがあるディレクトリだけを消す (同名の自作スキルは残す)。

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
