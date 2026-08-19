---
name: headlenss-new-session
description: headlenss に新しい tmux セッション (エージェント作業場) を API で作る手順。「新しいセッションを作って」「〜用のセッションを立てて」「headlenss にセッションを追加して」と言われた時に使う。作ったセッションはスマホ/グラス (G2) の一覧に即座に出る。
---

# headlenss に新しいセッションを作る

headlenss サーバのセッション作成 API を 1 回叩くだけ。tmux を直接操作しない
(サーバが tmux 設定・検出・永続化まで面倒を見るため、`tmux new-session` を
手で打つとそれらが揃わない)。

以下のコマンドは headlenss サーバの API が `http://127.0.0.1:3000/api` で使える前提。
別のホスト・ポートの環境では URL を読み替える。

## 手順

### 1. サーバの確認

```
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/health
```

200 以外ならサーバが動いていない。常駐サービスとして入れてある環境
(Linux + systemd ユーザーサービス `headlenss`) なら `systemctl --user status headlenss` を
確認し、落ちていたら**ユーザーに報告する** (勝手に stop/kill しない。start は
`systemctl --user start headlenss` でよい)。サービス化していない環境では
サーバの起動方法をユーザーに確認する。

### 2. 作成

```
curl -s -X POST http://127.0.0.1:3000/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"name": "<セッション名>", "cwd": "<作業フォルダ>", "startClaude": true}'
```

成功すると `{"ok":true}`。失敗は 400 + `{"error":"..."}`。

| フィールド | 必須 | 内容 |
|---|---|---|
| `name` | ✔ | セッション名。**`[a-zA-Z0-9_-]` のみ、40 文字まで** (日本語・スペース不可)。一覧にそのまま出るので短く分かりやすく |
| `cwd` | - | 作業フォルダの絶対パス。省略時は `$HOME`。**存在しなければ親ごと自動作成される** (typo に注意) |
| `startClaude` | - | true で Claude Code を起動 (`claude -c` で前回会話の継続を試み、なければ新規) |
| `startCodex` | - | true で Codex を起動 (`codex resume --last` を試み、なければ新規)。startClaude と併用しない |

どちらの start も付けなければ素のシェルだけのセッションになる。
エージェント指定が無い依頼では `startClaude: true` を既定にし、迷ったらユーザーに聞く。

### 3. 確認

```
curl -s http://127.0.0.1:3000/api/sessions | python3 -c "import json,sys; print([s['name'] for s in json.load(sys.stdin)['sessions']])"
```

作った名前が一覧に入っていれば完了。スマホ Web・G2 の一覧にも同じものが出る。

## よくあるエラー

| エラー | 原因 |
|---|---|
| `invalid session name (use [a-zA-Z0-9_-], max 40 chars)` | 名前に日本語・スペース・記号が入っている。英数字とハイフンに直す |
| `duplicate session` | 同名セッションが既に存在する。**既存を消さず**、別名にするかユーザーに確認 |
| 接続できない | サーバ未起動、または URL が違う。手順 1 へ |

## してはいけないこと

- 既存セッションの削除 (`DELETE /api/sessions/:name`)・改名 (`PATCH`)・退避 (`release`) を
  この流れで勝手に行わない。**ユーザーが明示的に依頼した場合のみ。**
- `tmux new-session` / `tmux kill-session` の直接実行で代替しない。
- 既に同名がある場合に「作り直し」目的で削除しない (別ランの会話履歴が消える)。

## 前提

- headlenss サーバが稼働していること
- API のベース URL が `http://127.0.0.1:3000/api` 以外の環境では読み替える
  (別 PC の headlenss を操作する場合も同様に URL を差し替えるだけでよい)
