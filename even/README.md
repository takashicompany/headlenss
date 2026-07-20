# headlenss-even

Even Realities G2 用のWebアプリ。G2マイクの音声を **Speechmatics リアルタイム
WebSocket API** にストリーミング送信し、確定したテキストを headlenss サーバ
(`server/`) の `POST /api/sessions/:name/input` 経由で tmux セッションへ流し込む。

## 動作概要 (G2 操作モデル)

```
idle ──Click──> Recording ──Click──> Pending
                                       ├── ↑Scroll → Send to tmux → idle
                                       └── ↓Scroll → Discard → idle
```

- **クリック**: 録音 開始 / 停止
- 録音中の partial が逐次レンズに表示される (Speechmatics RT)
- 録音停止後は **確定テキストをレンズに表示**して、ユーザの判断を待つ:
  - **上スクロール (SCROLL_TOP)**: headlenss server へ送信して tmux に流す
  - **下スクロール (SCROLL_BOTTOM)**: テキスト破棄 (送信せず捨てる)
- Idle (録音していない) の間は **tmux の画面末尾をレンズにミラー表示**するので、
  送信した結果がレンズで確認できる (2秒間隔でポーリング)
- partial → final レイテンシは `max_delay: 1.0` で 1〜2秒
- API key は WebView 上の設定欄に入力、`bridge.setLocalStorage` + `localStorage` に保存

## 必要なもの

- Node.js 20 以上
- Speechmatics の API key (https://portal.speechmatics.com/ 月480分まで無料)
- 母艦PCで `headlenss/server` が稼働中
- (任意) Tailscale — G2/スマホから母艦PCにアクセスする場合

## 開発

```bash
cd even
npm install
npm run dev      # http://localhost:5177/
npm run qr       # QR表示 (Even Hubで読み込み)
npm run build
npm run pack     # headlenss.ehpk 生成
```

このアプリは G2 SDK ブリッジ経由でしか動作しません。ブラウザ単体で開いても録音できないので、
動作確認は実機 (G2+スマホEvenアプリ) かシミュレータで行ってください。

## アーキテクチャ

```
G2マイク (PCM 16kHz S16LE)
   ↓ BLE 経由でスマホへ
スマホEven Realitiesアプリ (Flutter WebView)
  └─ headlenss-even (このアプリ)
       │
       ├─ POST https://mp.speechmatics.com/v1/api_keys?type=rt
       │    (API key で 60s TTL の一時 JWT を取得)
       │
       ├─ WSS wss://eu.rt.speechmatics.com/v2?jwt=<...>
       │    (PCM チャンクを連投 → partial/final テキスト受信)
       │
       ├─ HTTP POST <server>/api/sessions/<name>/input
       │    (上スクロールで確定したテキストを tmux へ)
       │
       └─ HTTP GET  <server>/api/sessions/<name>/output?lines=30
            (idle時に2秒間隔でtmux画面を取得 → レンズに表示)
```

サーバを経由するのは **tmux にテキストを送るとき**だけ。音声と Speechmatics 認証は
ブラウザから直接行く。Speechmatics の JWT 発行エンドポイントは CORS 全公開
(`Access-Control-Allow-Origin: *`) なのでブラウザから直接呼べる。

## 設定 (WebView)

| 項目 | 説明 |
|---|---|
| Server base URL | headlenss server の base URL。例 `http://host.tailnet.ts.net:3000` |
| 送信先セッション | tmux セッション名。横並び pill から1タップで切替 |
| 送信後に Enter を打つ (Advanced) | tmux に `Enter` を送って即実行する |
| Speechmatics API key | 一時 JWT 発行用 |
| 言語 (Advanced) | `ja` / `en` 等 |
| operating_point (Advanced) | `enhanced` (推奨) / `standard` |

設定値は WebView の `localStorage` と Even Hub の `bridge.setLocalStorage` の両方に保存される。

## app.json の whitelist

`network` permission の `whitelist` には G2 アプリから叩く外部URLを書く必要がある。
最低限以下を追加する想定 (現状は空配列、自分の環境に合わせて編集):

```json
"whitelist": [
  "https://mp.speechmatics.com",
  "wss://eu.rt.speechmatics.com",
  "https://<your-host>.<your-tailnet>.ts.net:3000"
]
```

`wss://` を許容するかどうかなどは G2 アプリ側の挙動を実機で確認する必要あり。

### 繋がらない時 (whitelist と サーバー CORS の2ゲート)

このアプリからサーバーに繋ぐには **2つのゲートを両方通す**必要がある:

1. **この `whitelist`** — Server base URL がここに一致しないと WebView が通信を
   ブロックし、サーバーに到達すらしない。base URL を変えたら whitelist も合わせる。
2. **サーバー側の `ALLOWED_ORIGINS`** (`server/.env`) — この WebView は Origin ヘッダに
   `null` / `http://localhost` を送るため、サーバーがそれを許可していないと **403**。
   tailnet 内限定なら `ALLOWED_ORIGINS=*` のままが簡単で安全
   (詳細: [server/README.md](../server/README.md#接続できない-cors--origin-の-ハマりどころ))。

## ファイル構成

```
src/
├── main.ts             # ブート + 録音→RT→tmux送信フロー
├── audio.ts            # 受信PCMフレームのバイト数集計のみ
├── events.ts           # G2のクリック/スクロール/audioPcm ハンドラ
├── renderer.ts         # G2画面 (576x288)
├── settings.ts         # 設定の永続化 (bridge + localStorage)
├── server-client.ts    # headlenss server の HTTP クライアント
├── speechmatics-rt.ts  # Speechmatics Realtime WebSocket クライアント
└── styles.css
```

## 既知の制限

- 連続録音は安全のため 28s で停止 (G2の30s制限の手前)
- 同時 RT セッションは Free 枠で 2 まで (有料プランで増やせる)
- Speechmatics RT のアイドルタイムアウトは 60 分、最長 48 時間
- API key はWebView上に平文で保持される (tailnet 内端末前提)
- tmuxセッションが存在しない場合はオンボーディング完了時に `main` を自動作成
