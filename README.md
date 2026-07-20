**English** | [日本語](./README.ja.md)

# HeadLenss

HeadLenss is an app that lets you drive Claude Code running on your PC by voice from Even Realities G2 smart glasses.
It also lets you operate tmux sessions from a smartphone browser in both terminal mode and chat mode.

## Screenshots

### G2

#### Console
<img width="576" height="288" alt="glasses_20260519003446_bg" src="https://github.com/user-attachments/assets/b6f32ed7-43f6-4cf2-bbd3-ff25a4e3f18c" />

#### Ask User Question
<img width="576" height="288" alt="glasses_20260518233343_bg" src="https://github.com/user-attachments/assets/1a316c79-65a2-430e-8b65-3834022d8cb9" />

#### Session list
<img width="576" height="288" alt="glasses_20260518232302_bg" src="https://github.com/user-attachments/assets/330c34e7-e457-4281-8e90-609a4ce602dc" />

#### Voice input
<img width="576" height="288" alt="glasses_20260518225738_bg" src="https://github.com/user-attachments/assets/82fb73bb-6558-481d-aae5-2281116f5dc6" />

### Browser (smartphone)

#### Console view
<img height="500" alt="F876E784-FCD5-4FCC-9BC5-693610810920_1_201_a" src="https://github.com/user-attachments/assets/69054435-781d-4884-9a18-99ff46ad0165" />

#### Chat view
<img height="500" alt="AED91246-AF99-416F-8E15-DE5DCDEDBF9F_1_201_a" src="https://github.com/user-attachments/assets/a9eba4b8-5901-4946-a6c1-07d8000f3465" />

## System overview

```
G2 (microphone + display + touchpad)
  ↕ BLE 5.2
Smartphone (Even Realities app = Flutter WebView)
  └─ even/  G2 web app (TS + Vite)
       ├─ HTTPS → Speechmatics Realtime (audio → text)
       └─ HTTP  → PC (via Tailscale)
PC
  ├─ server/   Hono + tmux + Claude Code + Web UI
  └─ plugin/   Claude Code plugin (forwards hooks to the server)
       ↕ HTTP/WS
Browser (smartphone / PC, web UI)
```

## Repository layout

```
headlenss/
├── server/   # Server running on the PC (tmux management API + Web UI + ASR)
├── even/     # Even G2 app (TS web app running inside the smartphone WebView)
└── plugin/   # Claude Code plugin (forwards lifecycle hooks to the server)
```

## What It Can Do

### Codex support

HeadLenss can also surface Codex CLI sessions in the same browser/G2 chat view when Codex hooks are enabled.

Install the global Codex hooks once:

```bash
node /path/to/headlenss/plugin/codex-hooks/install.mjs
```

Restart Codex, open `/hooks`, and review/trust the HeadLenss hook definitions. After that, start Codex in any tmux session:

```bash
tmux new -s codex-work -c /path/to/your/project codex
```

The tmux session will appear in the HeadLenss browser/G2 session list, and its prompts, replies, and permission requests will appear in chat view.

Set `HEADLENSS_SERVER_URL` if your server is not `http://localhost:3000`.


- Access Claude Code (tmux) on your PC from G2.
- Send prompts using G2's voice input.
- Add and view tmux sessions from a web browser. Supports both PCs and smartphones.
- Two session display types are available: console-style and chat-style.

## Differences from even-terminal

- Can be launched from the menu on G2
- Can add new sessions (via the smartphone app)
- Control tmux via a web browser

## Requirements

- **PC**: Node.js 20+, tmux 3.0+ (Linux / macOS)
- **Tailscale account** (effectively required so the G2 / smartphone can reach the PC)
- **Even Realities G2** + paired smartphone + Even Realities app
  (not required if you only use the Web UI)
- **Speechmatics API key** (for G2-side real-time transcription; free up to 480 minutes / month)
  - Get one at: https://portal.speechmatics.com/
- **Claude Code v2.1+** (if you want the Claude Code integration)

## Setup

**The easiest path is to let an AI read the source code and walk you through setup.**

### 1. Install the server on your PC

```bash
git clone https://github.com/takashicompany/headlenss.git
cd headlenss/server
npm install
cp .env.example .env
# Edit .env (e.g. ASR_BACKEND). It works with the defaults too.
npm start
# → open http://localhost:3000/ in a browser to verify
```

To keep it running on Linux, a systemd unit is provided:
```bash
npm run service:install
sudo loginctl enable-linger $USER   # only once, if you want it to survive logout
```

> **Migration note:** If you are upgrading from a version that used `npm start` in the systemd unit, re-run `npm run service:install` once to regenerate the unit file. This ensures `systemctl --user restart headlenss` releases the port correctly.

For details (ASR backend selection, API reference, systemd operation) see [server/README.md](./server/README.md).

### 2. Reach the PC via Tailscale

Put the PC and the G2 phone / control devices into the same tailnet. Confirm the Tailscale IP with `tailscale ip -4`.
Verify that `http://<tailscale-ip>:3000/` opens in a browser.

If MagicDNS is enabled, `http://<hostname>.<tailnet>.ts.net:3000/` also works.

### 3. (Optional) Install the Claude Code plugin

Only if you want approval / question events from Claude Code to surface on the G2 or the Web UI.

```
# Inside Claude Code
/plugin marketplace add /path/to/headlenss
/plugin install headlenss@headlenss
```

After this, every Claude Code instance launched inside tmux will forward its lifecycle events to `http://localhost:3000/api/hooks/*`. See [plugin/README.md](./plugin/README.md) for details.

### 4. (Optional) Install the G2 app on your smartphone

Only if you use the physical G2.

```bash
cd even
npm install
npm run build
npm run pack       # produces headlenss.ehpk
npm run qr         # show a QR code
```

Scan the QR with the Even Realities app on your phone to install it.
On first launch, enter the following in the WebView settings:

- **Server base URL**: `http://<hostname>.<tailnet>.ts.net:3000`
- **Speechmatics API key**
- Target tmux session name

You also need to add your PC hostname and the Speechmatics endpoints to the `network` permission `whitelist` in `even/app.json` (see [even/README.md](./even/README.md)).

### 5. Use it

- **From the Web UI**: open `http://<PC hostname>:3000/`, create a tmux session, and operate it.
- **From G2**: tap to start / stop recording → swipe up to send to tmux / swipe down to discard. While idle the tail of the tmux screen is mirrored on the lens.

## Troubleshooting (can't connect from Even/G2)

"The server is running but the Even/G2 app won't connect" — the most common cause is
**over-restricting `ALLOWED_ORIGINS`**. A connection must pass **two independent gates**:

1. **Even WebView whitelist** (`even/app.json`) — if the Server base URL doesn't match an
   entry, the request is blocked on the device and never reaches the server.
2. **Server Origin allowlist** (`ALLOWED_ORIGINS` in `server/.env`) — the WebView sends
   an `Origin` header of `null` or `http://localhost`, so restricting it to only
   `https://<host>` returns **403** (CORS).

Fixes (easiest first):

- For tailnet-only use, keep **`ALLOWED_ORIGINS=*` (the default)** and restrict who can
  reach the server via Tailscale ACLs / firewall instead.
- If you must restrict it, also list the WebView origins:
  `ALLOWED_ORIGINS=null,http://localhost,https://<host>.<tailnet>.ts.net`

Debugging tip: `curl` sends no `Origin` header, so it returns 200 even when the allowlist
is restrictive — only browsers/WebViews get 403. Reproduce it with `-H "Origin: null"`.
When a request is rejected, the server logs `[cors] ⚠ ... 拒否しました`.

See [server/README.md](./server/README.md#接続できない-cors--origin-の-ハマりどころ) for details.

## License

MIT License — see [LICENSE](./LICENSE).

You may use, modify, and distribute it freely (including for commercial purposes). The software is provided as-is with no warranty, and the author assumes no liability for any damages arising from its use.
