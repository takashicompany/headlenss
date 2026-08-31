---
name: headlenss-dev-server
description: headlenss が動いているマシンで、Web アプリや Even G2 確認用の dev server を立てる時の標準手順。headlenss が占有するポート (既定: 443 / 80 / 3000) を奪わずに、tailnet からアクセスできる形で公開する。ポート番号と HTTPS 要件を決め、dev server を 0.0.0.0 で起動 → 必要なら tailscale serve --https=<port> で expose、という流れ。「dev server を立てて」「スマホ/グラスから開発中の画面を見たい」「tailnet に公開して」と言われた時に使う。
---

# headlenss のマシンで dev server を立てる

headlenss が動いているマシンは、外部からその PC を操作するための生命線になっている。
**headlenss が使っているポートを奪わずに**自分の dev server を tailnet 公開するための手順。

このスキルは環境非依存。ホスト名・ポートはすべて置き換える前提の例。まず「0. 環境を調べる」で
実際の値を確定させること。**推測しない。**

## 必ず守る制約 (= headlenss を汚さない)

典型的な構成では headlenss が次を占有している (手順 0 で実際の値を確認する)。

| ポート | 用途 |
|---|---|
| 3000 | headlenss サーバ本体 (systemd ユーザーサービス `headlenss` 等で常駐) |
| 443 / 80 | `tailscale serve` が headlenss サーバへ流す https / http ルート (公開している場合) |

- **headlenss が使っているポートを奪わない。** `:3000` を listen しているプロセスを
  `lsof` / `ss` で見つけても **kill しない**。
- **`tailscale serve reset` を使わない。** 全ポートの設定を消すので headlenss も巻き込む。
- **`tailscale serve --bg <target>` (= `--https=` 省略) を使わない。** 既定で `:443` を
  上書きし、headlenss のルートを奪う。
- 公開ルートに割り当てられているポート (既定 `:443` / `:80`) を `--https=` / `--http=` の
  対象にしない。

これらを事故で打たないよう、Claude Code の permissions で `tailscale serve` 系を `ask`
(確認プロンプト) にしておくとよい。

## 入力

- `<port>`: 使いたいポート番号 (5173, 8080, 8443 など)。headlenss の占有ポートと、
  既に listen 中のポートを避けて選ぶ (手順 0・1)。
- **HTTPS が必要か?**
  - Even WebView の secure context (getUserMedia, clipboard, Service Worker など) を使う
    → **YES (HTTPS 必須)**
  - ブラウザでの見た目確認だけ → **NO (HTTP で OK)**

## 0. 環境を調べる (最初に必ずやる)

```bash
# headlenss サーバのポート (既定 3000) が生きているか
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/health

# tailnet 上のホスト名
tailscale status --json | python3 -c "import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))"

# 既に tailscale serve で公開されているポート (= 触ってはいけない行)
sudo tailscale serve status
```

以後、ホスト名を `<host>.<tailnet>.ts.net` と書く。`tailscale serve status` の出力は
**作業前に控えておく** (後で「奪っていないこと」を照合するため)。

## 1. ポート空き確認

```bash
ss -tlnp 2>/dev/null | grep ":<port> " || echo "port <port> is free"
```

埋まっていたら別のポートを選ぶ。**先客のプロセスを止めない。** headlenss のポートが
出てきたら絶対に触らない。

## 2. dev server を 0.0.0.0 で起動

`localhost` (= 127.0.0.1) だけにバインドすると tailnet 経由では届かない。必ず `0.0.0.0`
(or `--host`) を指定する。

| ツール | コマンド例 |
|---|---|
| Vite | `npx vite --host --port <port> --strictPort` |
| Next.js | `next dev -H 0.0.0.0 -p <port>` |
| Bun (Hono 等) | `PORT=<port> bun --hot src/index.ts` (or サーバコードで `0.0.0.0` 明示) |
| Python 簡易 | `python3 -m http.server <port> --bind 0.0.0.0` |
| Node static | `npx serve -l tcp://0.0.0.0:<port> dist/` |

Vite は `--strictPort` を付けないと、埋まっている時に黙って別のポートへずれる。

## 3-A. HTTP で OK の場合

`tailscale serve` は **不要**。tailnet が peer 間通信を運ぶので、そのまま届く。

```
http://<host>.<tailnet>.ts.net:<port>/
```

## 3-B. HTTPS が要る場合

該当ポートだけを `tailscale serve` で expose する。**必ず `--https=<port>` を明示する。**

```bash
sudo tailscale serve --https=<port> --bg http://127.0.0.1:<port>
```

確認:

```bash
sudo tailscale serve status
```

期待する出力 (ポート 5173 を追加した場合の例):

```
https://<host>.<tailnet>.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:3000          ← headlenss (触らない)
https://<host>.<tailnet>.ts.net:5173 (tailnet only)
|-- / proxy http://127.0.0.1:5173          ← 自分が追加した行
```

**手順 0 で控えた行がすべてそのまま残っていること**を目視で確認する
(headlenss のルートも、他のアプリが公開している行も消えていないこと)。

```
https://<host>.<tailnet>.ts.net:<port>/
```

## 4. 後片付け

```bash
# 自分が追加したポートだけを外す
sudo tailscale serve --https=<port> off
```

`tailscale serve reset` は使わない (全ポートの設定が消える)。
dev server プロセスは各ツールの手順で止める (Ctrl-C / npm script など)。

## トラブル時

| 症状 | 確認 |
|---|---|
| tailnet からアクセスできない | `ss -tlnp \| grep ":<port>"` で listen address を確認。`127.0.0.1:<port>` になっていると届かない (`--host 0.0.0.0` を付け直す) |
| headlenss のポートを誰かが listen している | それが headlenss 本体。**kill しない**。別のポートを使う |
| 「ポートがふさがってる」と怒られた | 別のポートを選ぶ。headlenss のポートは奪わない |
| 万一 headlenss の公開ルートを奪ってしまった | `sudo tailscale serve --https=443 --bg http://127.0.0.1:3000` で復旧 (http ルートは `sudo tailscale serve --http=80 --bg http://127.0.0.1:3000`)。ポートは手順 0 で控えた実際の値に読み替える |

## 参考: ポートの選び方

| ポート | 用途 |
|---|---|
| headlenss の公開ルート (既定 443 / 80) | 固定、触らない |
| headlenss サーバ (既定 3000) | 固定、触らない |
| 5173 | Vite default — Web アプリ / G2 確認の第 1 候補 |
| 4173 | Vite preview default |
| 8080 / 8443 | 第 2 候補 |

同じマシンで他のアプリが動いていることがあるので、**選ぶ前に必ず `ss -tlnp` と
`tailscale serve status` で使用中のポートを確認する。**

## 関連

- 立てた dev server を G2 のプラグイン一覧に出したい場合は `headlenss-g2-plugin` スキルへ。
- 立てた dev server を headlenss の Web UI (PC / スマホ) のタブに出したい場合は
  `headlenss-preview-tabs` スキルへ。作った HTML をそのまま出す場合 (dev server 不要) も同じ。
- どちらも宣言ファイルは `.headlenss-plugins.conf` の 1 枚を共有する。出す先は URL の
  後ろのトークンで決める (`web` = ブラウザだけ / `g2` = グラスだけ / `web g2` = 両方)。
  **ブラウザで確認するためだけの dev server には `web` を明示する** — グラスの一覧に
  紛れ込まない。
