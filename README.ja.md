[English](./README.md) | **日本語**

# HeadLenss

HeadLenss(ヘッドレンズ)は、Even Realities G2 スマートグラスから、PC上で動くClaude Codeを音声入力で操作するアプリです。
また、スマホのブラウザからtmuxセッションをターミナルモードとチャットモードの両方で操作することが可能です。

## スクリーンショット

### G2

#### コンソール画面
<img width="576" height="288" alt="glasses_20260519003446_bg" src="https://github.com/user-attachments/assets/b6f32ed7-43f6-4cf2-bbd3-ff25a4e3f18c" />

#### Ask User Question画面
<img width="576" height="288" alt="glasses_20260518233343_bg" src="https://github.com/user-attachments/assets/1a316c79-65a2-430e-8b65-3834022d8cb9" />

#### セッション一覧画面
<img width="576" height="288" alt="glasses_20260518232302_bg" src="https://github.com/user-attachments/assets/330c34e7-e457-4281-8e90-609a4ce602dc" />

#### 音声入力画面
<img width="576" height="288" alt="glasses_20260518225738_bg" src="https://github.com/user-attachments/assets/82fb73bb-6558-481d-aae5-2281116f5dc6" />

### ブラウザ(スマートフォン)

#### コンソールビュー
<img height="500" alt="F876E784-FCD5-4FCC-9BC5-693610810920_1_201_a" src="https://github.com/user-attachments/assets/69054435-781d-4884-9a18-99ff46ad0165" />

#### チャットビュー
<img height="500" alt="AED91246-AF99-416F-8E15-DE5DCDEDBF9F_1_201_a" src="https://github.com/user-attachments/assets/a9eba4b8-5901-4946-a6c1-07d8000f3465" />

## システム構成

```
G2 (マイク + ディスプレイ + タッチパッド)
  ↕ BLE 5.2
スマホ (Even Realities アプリ = Flutter WebView)
  └─ even/  G2用Webアプリ (TS+Vite)
       ├─ HTTPS → Speechmatics Realtime (音声 → テキスト)
       └─ HTTP  → PC (Tailscale経由)
PC
  ├─ server/   Hono + tmux + Claude Code + Web UI
  └─ plugin/   Claude Code プラグイン (hooks を server に転送)
       ↕ HTTP/WS
ブラウザ (スマホ/PC、Web画面)
```

## リポジトリ構成

```
headlenss/
├── server/   # PCで動くサーバー (tmux管理API + Web UI + ASR)
├── even/     # Even G2用アプリ (スマホWebView上で動くTS Webアプリ)
└── plugin/   # Claude Code / Codex のフック (lifecycle hooks → server) + 同梱スキル
```

## できること

- G2 から PC 上の Claude Code (tmux) にアクセスできる。
- G2 の音声入力でプロンプトを送れる。
- Web ブラウザから tmux セッションの追加と表示ができる。PC とスマホ両対応。
- セッションの表示方法は コンソールスタイル / チャットスタイル の 2 種類から選べる。

## even-terminal との違い

- G2 のメニューから起動できる
- 新しいセッションを追加できる (スマホアプリから)
- Web ブラウザ経由で tmux を操作できる

## 必要なもの (全体)

- **PC**: Node.js 20以上, tmux 3.0以上 (Linux/macOS)
- **Tailscale アカウント** (G2やスマホからPCに届かせるため事実上必須)
- **Even Realities G2** + ペアリング済みスマホ + Even Realities アプリ
  (Web UI だけ使うなら不要)
- **Speechmatics API key** (G2側のリアルタイム文字起こし用、月480分まで無料)
  - 取得: https://portal.speechmatics.com/
- **Claude Code v2.1以降** (Claude Code 連携を使う場合)

## 導入手順

**AIにソースコードを読んでもらってセットアップするのが楽です。**

### 1. サーバーをPCに入れる

```bash
git clone https://github.com/takashicompany/headlenss.git
cd headlenss/server
npm install
cp .env.example .env
# .env を編集 (ASR_BACKEND など。最低限は何も書かなくても起動はする)
npm start
# → http://localhost:3000/ にブラウザでアクセスして動作確認
```

Linux で常駐させたい場合は systemd unit が用意されている:
```bash
npm run service:install
sudo loginctl enable-linger $USER   # ログアウト後も動かす場合のみ、初回1回
```

> **アップグレード時の注意:** systemd unit が `npm start` を使っていた旧バージョンからの更新時は、`npm run service:install` を一度再実行してください。これにより `systemctl --user restart headlenss` でポートが正しく解放されるようになります。

詳細(ASRバックエンド選択・APIリファレンス・systemd運用)は [server/README.md](./server/README.md) を参照。

### 2. Tailscale でPCにアクセスできるようにする

PCとG2スマホ・操作端末を同じ tailnet に入れる。`tailscale ip -4` でTailscale IPを確認。
ブラウザから `http://<tailscale-ip>:3000/` を開けるか確認しておく。

MagicDNS が有効なら `http://<hostname>.<tailnet>.ts.net:3000/` でもアクセスできる。

### 3. フック(Claude Code / Codex)を入れる

承認待ち・質問待ち・会話などを G2 や Web UI に流すのに必要。**セットアップ時に一括で入れるのが楽:**

```bash
cd server
npm run hooks:install   # Claude Code と Codex 両方のフックを ~/.claude・~/.codex に書き込む
```

- サーバが `http://localhost:3000` 以外なら `HEADLENSS_SERVER_URL=http://<host>:3000 npm run hooks:install`。
- 入れた後、Claude Code / Codex を再起動し、`/hooks` で HeadLenss のフックを一度 trust する。
  **フックはセッション開始時に読み込まれるので、既に起動中のセッションには効かない**(効かせたいセッションは再起動する)。
- 外すときは `npm run hooks:uninstall`。

> Claude 側は `~/.claude/settings.json` に、Codex 側は `~/.codex/hooks.json` に直接書き込む方式。
> **マーケットプレイス版 (`/plugin install headlenss@headlenss`) と併用すると hook が二重発火する**ので、どちらか一方にすること。詳細は [plugin/README.md](./plugin/README.md) を参照。

### 4. (任意) 同梱の Claude Code スキルを入れる

Claude Code に headlenss 自体の操作方法を教えるスキル。

- `headlenss-new-session` — API で新しい tmux セッション(エージェント作業場)を作る。
- `headlenss-g2-plugin` — 開発中の G2 プラグインをセッション一覧に出し、グラスから開く。
- `headlenss-dev-server` — headlenss のポートを奪わずに dev server を立てて tailnet に公開する。

```bash
cd server
npm run skills:install   # plugin/skills/* を ~/.claude/skills/ にコピーする
```

- シンボリックリンクではなくコピーなので、リポジトリを移動・削除しても動く。`git pull` 後に再実行すれば更新される。外すときは `npm run skills:uninstall`。
- サーバが `http://127.0.0.1:3000` 以外なら `HEADLENSS_SERVER_URL=http://<host>:3000 npm run skills:install`。差し替わるのは `headlenss-new-session` スキルのみ (他のスキルは headlenss が動くマシン上で使う前提のため、ループバック表記のまま残る)。

### 5. (任意) G2アプリをスマホに入れる

実機 G2 を使う場合のみ。

```bash
cd even
npm install
npm run build
npm run pack       # headlenss.ehpk を生成
npm run qr         # QRコードを表示
```

スマホの Even Realities アプリで QR を読み込んでインストール。
初回起動時に WebView 内の設定画面で以下を入力する:

- **Server base URL**: `http://<hostname>.<tailnet>.ts.net:3000`
- **Speechmatics API key**
- 送信先 tmux セッション名

`even/app.json` の `network` permission whitelist に、PCのホスト名と
Speechmatics のエンドポイントを書く必要がある (詳細: [even/README.md](./even/README.md))。

### 6. 使う

- **Web UI から**: ブラウザで `http://<PCのホスト名>:3000/` を開き、tmuxセッションを作って操作。
- **G2 から**: クリックで録音開始/停止 → 上スワイプで tmux 送信 / 下スワイプで破棄。
  Idle中はtmux画面末尾がレンズに表示される。

## トラブルシューティング (Even/G2 から繋がらない時)

「サーバーは起動しているのに Even/G2 アプリから繋がらない」— 一番多いのは
**`ALLOWED_ORIGINS` の絞りすぎ**。接続は次の **2つのゲートを両方通す**必要がある:

1. **Even WebView の whitelist** (`even/app.json`) — Server base URL がここに
   一致しないと端末内でブロックされ、サーバーに到達すらしない。
2. **サーバーの Origin 許可** (`server/.env` の `ALLOWED_ORIGINS`) — WebView は
   Origin ヘッダに `null` や `http://localhost` を送るため、`https://<host>` 等
   だけに絞ると **CORS で 403** になる。

対処 (簡単な順):

- tailnet 内限定運用なら **`ALLOWED_ORIGINS=*`(既定)のまま**にする。接続元は
  Tailscale ACL / ファイアウォールで絞れば十分守れる。
- どうしても絞りたい場合は WebView の origin も列挙する:
  `ALLOWED_ORIGINS=null,http://localhost,https://<host>.<tailnet>.ts.net`

切り分けのコツ: `curl` は Origin を送らないので絞っていても 200 で通ってしまう。
`-H "Origin: null"` を付けて叩くと、ブラウザ/WebView と同じ 403 を再現できる。
絞った状態で弾かれると、サーバーログに `[cors] ⚠ ... 拒否しました` が出る。

詳細は [server/README.md](./server/README.md#接続できない-cors--origin-の-ハマりどころ) を参照。

## ライセンス

MIT License — 詳細は [LICENSE](./LICENSE) を参照。

利用は自由 (商用含む) ですが、本ソフトウェアは無保証で提供されます。利用したことによる損害等について作者は一切の責任を負いません。
