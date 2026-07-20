# headlenss-server

母艦PC上で動くサーバー。tmuxセッション管理APIと、ブラウザからtmuxを操作できるWeb UIを提供する。

将来的にG2(Even Realities G2)アプリからも同じサーバーへ音声入力やテキスト出力をやり取りする予定。

## 必要なもの

- Node.js 20 以上 (v20 / v22 / v24 で動作確認済)
- tmux 3.0 以上
- (任意) Tailscale — 他端末からアクセスする場合
- (任意) ASRバックエンド次第:
  - **whisper-cpp**(ローカル) を使う場合 → ビルドツール:
    - Ubuntu/Debian: `sudo apt install -y build-essential cmake git curl`
    - Fedora: `sudo dnf install -y gcc-c++ cmake git curl make`
    - macOS: `xcode-select --install && brew install cmake`
  - **AmiVoice**(クラウド) を使う場合 → ビルドツール不要。https://acp.amivoice.com/ でAPPKEY取得

> **メモ**: `node-pty` 自体はプリビルドバイナリ同梱フォーク(`@homebridge/node-pty-prebuilt-multiarch`)を使うのでビルド不要。

## インストール & 起動

### 1. 依存をインストール

```bash
git clone <repo-url> headlenss
cd headlenss/server

npm install
npm run build
```

### 2. `.env` で設定

```bash
cp .env.example .env
$EDITOR .env   # API key などを記入
```

選べる ASR バックエンド:

| バックエンド | install手間 | 速度 | 精度(日本語) | コスト |
|---|---|---|---|---|
| `speechmatics`(クラウド) | API key だけ | 速い | ○ | 月480分無料、以降約 $1.35/h |
| `amivoice`(クラウド) | API key + クレカ登録 | 速い | ◎(国産) | 月60分無料、以降約 ¥158/h |
| `whisper-cpp`(ローカル) | `npm run setup` でビルド + ~600MB DL | GPU有→速い、CPUのみ→遅い | ◎(large-v3-turbo) | 無料 |

`.env` の例(Speechmaticsを使う場合):
```
ASR_BACKEND=speechmatics
SPEECHMATICS_API_KEY=xxxxxxxx
SPEECHMATICS_LANG=ja
```

`whisper-cpp` を使う場合は事前に:
```bash
npm run setup    # whisper.cpp ビルド + ggml-large-v3-turbo-q5_0 DL (初回のみ)
```
ビルドツール(`build-essential` + `cmake`)が必要。詳細は[Required tools](#必要なもの)参照。

### 3. 起動方法を選ぶ

#### A. 開発・手動起動

```bash
npm start           # フォアグラウンドで起動
# Ctrl-C で停止
```

ブラウザで `http://localhost:3000/` を開けばtmuxセッション一覧が表示される。

#### B. systemd サービスとして常駐(Linux推奨)

ログアウト/再起動を跨いで自動起動させたい場合:

```bash
npm run service:install     # ~/.config/systemd/user/headlenss.service を作成 + 起動
npm run service:status      # ステータス確認
npm run service:logs        # ログをライブで見る
```

再起動後・ログアウト後も自動で動かしたければ、**1回だけ** sudo コマンドを実行:
```bash
sudo loginctl enable-linger $USER
```

これでマシン起動時に自動で headlenss が立ち上がるようになる。`.env` 内の値はサービスにそのまま読み込まれる(systemd unit が `EnvironmentFile=server/.env` を見ている)。

サービスの基本操作:
```bash
systemctl --user restart headlenss
systemctl --user stop headlenss
systemctl --user disable headlenss   # 自動起動を解除
```

> **macOS** で常駐させたい場合は systemd ではなく launchd を使う必要があります(現状 README では未サポート、tmux常駐で代用してください: `tmux new-session -d -s headlenss-server "cd path/to/server && npm start"`)。

## 開発モード

ソース変更でホットリロードしたい場合:

```bash
npm run dev
```

`http://localhost:5173/` をブラウザで開く。Viteのdev server が立ち上がり、`/api/*` と WebSocket は `http://localhost:3000` の Hono サーバーへプロキシされる。

## 環境変数

### サーバー
| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `3000` | リッスンポート |
| `HOST` | `127.0.0.1` | バインドアドレス。他端末から触らせるなら `0.0.0.0` を明示指定 |
| `ALLOWED_ORIGINS` | `*` (全許可) | CORS/WS の許可 Origin を CSV 指定。**絞ると Even/G2 アプリが繋がらなくなる場合あり** ([下記](#接続できない-cors--origin-の-ハマりどころ)) |

### ASR(音声認識)バックエンド選択
| 変数 | デフォルト | 説明 |
|---|---|---|
| `ASR_BACKEND` | `whisper-cpp` | `whisper-cpp` / `amivoice` / `speechmatics` |

### whisper-cpp バックエンド (ローカル、無料、`ASR_BACKEND=whisper-cpp`時)
| 変数 | デフォルト | 説明 |
|---|---|---|
| `WHISPER_MODEL` | `ggml-large-v3-turbo-q5_0.bin` | 使用するWhisperモデル。`models/`にダウンロードされる |
| `WHISPER_MODEL_PATH` | (auto) | モデルファイルの絶対パス。指定すれば`WHISPER_MODEL`を上書き |
| `WHISPER_BIN` | (auto) | `whisper-cli`バイナリのパス。指定すれば自前ビルドの`whisper.cpp`が使える |
| `WHISPER_LANG` | `auto` | デフォルト言語コード(`ja`, `en`等)。`auto`で自動判定 |
| `WHISPER_THREADS` | (CPUコア数) | whisper.cppのスレッド数 |
| `WHISPER_CPP_REF` | `master` | `npm run setup`時にcloneする whisper.cpp の git ref |

### AmiVoice バックエンド (クラウド、日本語特化、`ASR_BACKEND=amivoice`時)
| 変数 | デフォルト | 説明 |
|---|---|---|
| `AMIVOICE_APPKEY` | (必須) | AmiVoice API のAPPKEY。https://acp.amivoice.com/ で登録して取得 |
| `AMIVOICE_ENGINE` | `-a-general-input` | エンジンID。日本語音声入力なら `-a-general-input` または `-a2-ja-general` |
| `AMIVOICE_ALLOW_LOGGING` | `false` | `true`にするとログ取り版エンドポイントを使う(料金が安いがAmiVoice側に音声が保存される) |

### Speechmatics バックエンド (クラウド、多言語、`ASR_BACKEND=speechmatics`時)
| 変数 | デフォルト | 説明 |
|---|---|---|
| `SPEECHMATICS_API_KEY` | (必須) | Speechmatics API key。https://portal.speechmatics.com/ で登録して取得 |
| `SPEECHMATICS_LANG` | `ja` | 言語コード(`ja`, `en` 等)。固定値、`auto` 不可 |
| `SPEECHMATICS_OPERATING_POINT` | `enhanced` | `standard`(速い・安い)または `enhanced`(高精度・少し高い) |
| `SPEECHMATICS_MAX_WAIT_MS` | `60000` | ジョブ完了待ちの最大時間(ms) |
| `SPEECHMATICS_POLL_MS` | `500` | ジョブステータスのポーリング間隔(ms) |

## 他の端末から触る (Tailscale)

サーバーは `0.0.0.0` にバインドされているので、同一LANや**Tailscale tailnet 内の他端末**からそのままアクセスできる。

```bash
# このマシンのTailscale IPを確認
tailscale ip -4

# 他端末から:
# http://<このマシンのTailscale IP>:3000/
# http://<このマシンのhostname>:3000/        (MagicDNS)
# http://<hostname>.<tailnet>.ts.net:3000/   (FQDN)
```

### 接続できない (CORS / Origin の ハマりどころ)

Even/G2 アプリや Web UI から「サーバーは起動しているのに繋がらない」場合、
`ALLOWED_ORIGINS` の絞りすぎが原因のことが多い。**接続は2つの独立したゲートを
両方通す必要がある**:

1. **Even WebView の whitelist** (`even/app.json` の `network` permission) —
   Server base URL がここに一致しないと端末内でブロックされ、サーバーに到達すらしない。
2. **サーバーの Origin allowlist** (`ALLOWED_ORIGINS`) — WebView が送る Origin
   (`null` や `http://localhost`) を弾くと **403** になる。

症状での切り分け:

| 症状 | 疑うゲート | 対処 |
|---|---|---|
| サーバーログに何も出ない / リクエストが1件も届かない | ① whitelist or tailnet 到達性 | `even/app.json` の whitelist に base URL を合わせる。tailnet 疎通を確認 |
| サーバーログに `[cors] ⚠ ... 拒否しました` が出る | ② `ALLOWED_ORIGINS` | `ALLOWED_ORIGINS=*` に戻す、または `null,http://localhost` を追記 |

`curl` は Origin ヘッダを送らないため常に通ってしまい、ブラウザ/WebView だけが
403 になる。**疎通確認は Origin 付きで**行うと再現できる:

```bash
# Origin 無し (curl 既定) → allowlist を絞っていても 200 で通ってしまう
curl -s -o /dev/null -w "%{http_code}\n" http://<host>:3000/api/health

# WebView を模した Origin=null → 絞っていると 403 が返る (これが実際の失敗)
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: null" http://<host>:3000/api/health
```

tailnet 内限定で運用しているなら、`ALLOWED_ORIGINS=*` のままにして
接続元は Tailscale ACL / ファイアウォールで絞るのが最も簡単で安全。

### HTTPS化したい場合 (任意)

将来G2スマートグラスのアプリから接続するときは Mixed-Content 回避のためHTTPS推奨。Tailscaleなら`tailscale cert`で無料で証明書が取れる:

```bash
tailscale cert <hostname>.<tailnet>.ts.net
# -> <hostname>.<tailnet>.ts.net.crt と .key が生成される

# 環境変数を渡してサーバー起動 (将来TLS対応する想定)
TLS_CERT_PATH=./<hostname>.<tailnet>.ts.net.crt \
TLS_KEY_PATH=./<hostname>.<tailnet>.ts.net.key \
npm start
```

> **現状の実装**: HTTPS起動オプションはまだ未実装(HTTPのみ)。TailnetはWireGuardで暗号化されているので、ブラウザ→サーバー間の通信は実用上安全。G2連携フェーズでHTTPSを足す。

## API

| Method | Path | 説明 |
|---|---|---|
| `GET`  | `/api/health` | ヘルスチェック |
| `GET`  | `/api/sessions` | tmuxセッション一覧 |
| `POST` | `/api/sessions` | 新規セッション作成 (`{"name":"..."}`) |
| `DELETE` | `/api/sessions/:name` | セッション削除 |
| `POST` | `/api/sessions/:name/input` | セッションにテキストを送り込む(tmux send-keys) |
| `WS`   | `/api/sessions/:name/pty` | tmuxにアタッチするPTYストリーム (xterm.js想定) |
| `GET`  | `/api/asr/status` | 選択中のASRバックエンドが使える状態かを返す。`{"backend":"whisper-cpp","ok":true}` |
| `POST` | `/api/asr` | 音声を文字起こし。`?lang=ja` 等で言語指定可。`{"text":"...","language":"ja","durationMs":1234}`を返す |

### セッション入力(テキスト送信)

`POST /api/sessions/:name/input` でセッション内で動作中のシェル/コマンドにテキストを流し込める。
G2やWeb UIで音声→テキスト変換した結果を、ユーザー確認後にtmuxに送る用途。

リクエスト:
```json
{
  "text": "echo hello",
  "submit": true
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `text` | string (必須) | 送るテキスト。`tmux send-keys -l`(literal mode)で渡されるので、特殊キー名は解釈されず、そのままバイト列として入力される |
| `submit` | boolean (デフォルト false) | `true`なら送信後に Enter を打つ |

例:
```bash
# テキストだけ送る(コマンドラインに表示されるが実行されない)
curl -X POST -H 'content-type: application/json' \
  -d '{"text":"echo hi"}' \
  http://localhost:3000/api/sessions/foo/input

# テキスト + Enter で実行
curl -X POST -H 'content-type: application/json' \
  -d '{"text":"echo hi","submit":true}' \
  http://localhost:3000/api/sessions/foo/input

# Enter だけ(空テキスト + submit)
curl -X POST -H 'content-type: application/json' \
  -d '{"text":"","submit":true}' \
  http://localhost:3000/api/sessions/foo/input
```

存在しないセッションへ送ると 404。

### ASR (音声認識)

`POST /api/asr` の Content-Type:

- `audio/wav` / `audio/x-wav` — WAVファイル(16kHz mono推奨。whisper.cppは内部でリサンプル可、AmiVoiceは16kHz推奨)
- `audio/l16` / `audio/pcm` / `application/octet-stream` — 生PCM 16-bit / 16kHz / mono / S16LE(G2 SDKのフォーマット)

例:
```bash
curl -X POST -H 'content-type: audio/wav' \
  --data-binary @sample.wav \
  http://localhost:3000/api/asr
# {"text":"...", "language":"ja", "durationMs":1234}
```

### ASR バックエンドの比較

| 項目 | whisper-cpp(ローカル) | AmiVoice(クラウド) | Speechmatics(クラウド) |
|---|---|---|---|
| **install手間** | ビルドツール + ~600MB DL | API key取得のみ | API key取得のみ |
| **オフライン動作** | ✓ | ✗ | ✗ |
| **無料枠** | 全部無料 | 月60分 | **月480分** |
| **超過時の料金** | — | 約 ¥158/時間 (nolog汎用) | 約 ¥156/時間 (enhanced) |
| **日本語精度** | ◎(large-v3-turbo) | **◎◎(国産特化、トップ)** | ○ (WER 10-12%帯) |
| **英語精度** | ◎ | ○ | ◎ |
| **多言語対応** | ◎(多言語モデル) | △(日中英韓中心) | ◎(55+言語) |
| **レイテンシ(CPUのみVM)** | 遅い(~30秒/11s音声) | 速い(数秒) | **速い(~4秒/11s音声、実測)** |
| **レイテンシ(GPU/Apple Silicon)** | 速い(数秒) | 速い(数秒) | 速い |
| **プライバシー** | 完全ローカル | 音声が AmiVoice へ | 音声が Speechmatics へ |
| **オンプレ提供** | — | ✓(別契約) | ✓(コンテナで提供) |
| **クレカ登録** | 不要 | 必須(無料枠でも) | 不要(Free枠) |

#### 推奨マトリクス

- **個人開発・PoC・予算重視 → Speechmatics**(月480分無料、レイテンシ短い、英語日本語両対応)
- **日本語精度を極限まで → AmiVoice**(国産、業界特化エンジン)
- **オフライン必須・データ外部送信NG → whisper-cpp**(GPU/Apple Silicon機推奨)

### WebSocket メッセージ仕様

- **クライアント→サーバー**:
  - キーストローク: テキストフレーム (例: `"echo hi\r"`)
  - リサイズ: JSON `{"type":"resize","cols":80,"rows":24}`
- **サーバー→クライアント**: PTY出力をそのまま流す (テキスト/バイナリ両方ありうる)

セッション名は `[a-zA-Z0-9_-]` の最大40文字。WS接続時にセッションが存在しなければ WebSocket を close code `4404` で切る (旧来の自動作成は snapshot 復元と race して cwd が HOME に巻き戻る事故が出たため廃止)。新規作成は明示的に `POST /api/sessions` を叩く。

## フォルダ構成

```
server/
├── src/
│   ├── server/         # Hono APIサーバー、tmux制御、PTY中継、ASR
│   │   ├── index.ts
│   │   ├── tmux.ts
│   │   ├── pty.ts
│   │   └── asr/
│   │       ├── index.ts          # バックエンド選択(ASR_BACKEND env)
│   │       ├── types.ts
│   │       ├── wav.ts            # PCM→WAVヘッダ変換
│   │       ├── whisper-cpp.ts    # whisper.cpp 経由のローカル文字起こし
│   │       ├── amivoice.ts       # AmiVoice API 経由のクラウド文字起こし
│   │       └── speechmatics.ts   # Speechmatics API 経由のクラウド文字起こし
│   └── web/            # React + xterm.js のWeb UI
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── pages/
│       └── styles.css
├── scripts/
│   ├── setup-whisper.mjs           # whisper.cpp ビルド & モデルDL (npm run setup)
│   ├── install-systemd.mjs         # systemd --user サービス導入 (npm run service:install)
│   └── headlenss.service.template  # systemd unit テンプレ
├── .env.example            # `.env` の雛形 (.env はgitignore)
├── vendor/whisper.cpp/     # cloneされたwhisper.cpp (gitignore)
├── models/                 # Whisperモデルファイル (gitignore)
├── dist/web/               # `npm run build` の出力先
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## 認証について

現在は**認証なし**。Tailnet ACLに任せる前提。`HOST=127.0.0.1` で起動すればローカル限定にはできる。

将来 G2 アプリから外部公開する際は適切な認証を実装する想定。

## 制約・既知の挙動

- **セッション共有**: 同じtmuxセッションに複数のWS接続が来た場合、tmuxの仕様で全クライアントが同じビューを共有する。違うビューが欲しい場合は別セッションを作る。
- **node-pty フォーク**: 上流の `node-pty` はNode 24用のプリビルドが未対応のため、プリビルド同梱フォークを使用している。将来上流が対応したら戻す予定。
