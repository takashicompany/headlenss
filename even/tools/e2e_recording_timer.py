#!/usr/bin/env python3
"""E2E: 録音タイマーが「本当に喋っていい時」から進むことの検証。

以前は録音ボタンを押した瞬間を起点にしていたため、レンズに「接続中…」を出して
いる間 (音声認識への接続と G2 マイクの取得) もヘッダの秒数が進んでいた。
起点を「発話の受け付けが始まった時点」= レンズが「録音中」に変わる時点へ移した。

公式シミュレータ (evenhub-simulator / xvfb) で、レンズへ実際に送られたヘッダと
本文の時系列を見て以下を確かめる:

  1. 接続が遅い場合 (3 秒遅延) でも、「接続中…」の間ヘッダは 0.0s のまま
  2. 「録音中」に変わってから秒数が進み始める。押してから経過した時間ではなく
     受け付け開始からの時間になっている
  3. 停止するとその時点の値で止まる (以降の待ち時間は録音長に入らない)
  4. 接続が速い通常ケースでも同じように進む (回帰)
  5. 音声認識への接続に失敗した場合、録音画面ごと畳まれタイマーが残らない

Speechmatics の応答タイミングを外から操るため、このスクリプトが JWT 発行と
リアルタイム WebSocket のスタブを立て、dev server 限定の差し替え口
(src/speechmatics-rt.ts の asrOverride) 経由でアプリをそちらへ向ける。
本番ビルドではこの差し替えは dead code elimination で消える。

本番サーバ (3000) も dev server (5177) もプロキシ (6177) も使わない。
tmux にも触らない。実際の音声は流さない (PCM が 0 でもタイマーの検証はできる)。

実行:
  python3 even/tools/e2e_recording_timer.py
"""

import base64
import hashlib
import json
import os
import re
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

EVEN = Path(__file__).resolve().parent.parent
SIMULATOR = EVEN / "node_modules/@evenrealities/evenhub-simulator/bin/index.js"

# 他のハーネス (5321/9911/8821, 5323/9913/8823) と本番系を避けた専用ポート
APP_PORT = 5325
AUTOMATION_PORT = 9915
STUB_PORT = 8825
SESSION = "rectest"

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# i18n(ja) の文言
CONNECTING = "接続中…"
REC_HINT = "録音開始 — お話しください"
HEAD_REC = "録音中"

# G2 マイク取得の決着待ち上限 (main.ts の MIC_OPEN_SETTLE_MS)。シミュレータは
# audioControl に応じないので、接続確立からこの時間だけ遅れて「録音中」になる。
MIC_SETTLE_S = 2.0

results: list[tuple[bool, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((ok, name, detail))
    print(f"  [{'OK' if ok else 'NG'}] {name}" + (f"  ({detail})" if detail else ""))


# ─── スタブ (headlenss API + Speechmatics RT) ────────────────────────

class Stub:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        # RecognitionStarted を返すまでの待ち (秒)
        self.connect_delay = 0.3
        # True にすると JWT 発行を 500 で落とす (接続失敗ケース)
        self.fail_jwt = False

    def set(self, **kw) -> None:
        with self.lock:
            for k, v in kw.items():
                setattr(self, k, v)

    def get(self, k: str):
        with self.lock:
            return getattr(self, k)

    def session(self) -> dict:
        now = int(time.time() * 1000)
        return {
            "tmuxSessionName": SESSION,
            "cwd": "/tmp/rectest",
            "status": "idle",
            "startedAt": now - 60_000,
            "lastSeenAt": now - 60_000,
            "source": "claude",
        }


stub = Stub()


def ws_send_text(sock: socket.socket, payload: str) -> None:
    """サーバ -> クライアントのテキストフレーム (マスク無し)。"""
    data = payload.encode("utf-8")
    header = bytearray([0x81])
    n = len(data)
    if n < 126:
        header.append(n)
    elif n < 1 << 16:
        header.append(126)
        header += struct.pack(">H", n)
    else:
        header.append(127)
        header += struct.pack(">Q", n)
    sock.sendall(bytes(header) + data)


def ws_read_frame(sock: socket.socket) -> tuple[int, bytes] | None:
    """クライアント -> サーバのフレームを 1 つ読む。(opcode, payload) / None=切断。"""
    def readn(n: int) -> bytes | None:
        buf = b""
        while len(buf) < n:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    head = readn(2)
    if head is None:
        return None
    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F
    if length == 126:
        ext = readn(2)
        if ext is None:
            return None
        length = struct.unpack(">H", ext)[0]
    elif length == 127:
        ext = readn(8)
        if ext is None:
            return None
        length = struct.unpack(">Q", ext)[0]
    mask = readn(4) if masked else b""
    if masked and mask is None:
        return None
    payload = readn(length) if length else b""
    if payload is None:
        return None
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def serve_ws(sock: socket.socket, key: str) -> None:
    """Speechmatics RT の最小スタブ。接続確立を任意に遅らせられる。"""
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    sock.sendall(
        b"HTTP/1.1 101 Switching Protocols\r\n"
        b"Upgrade: websocket\r\n"
        b"Connection: Upgrade\r\n"
        b"Sec-WebSocket-Accept: " + accept.encode() + b"\r\n\r\n"
    )
    delay = stub.get("connect_delay")

    def announce() -> None:
        # StartRecognition の到着は待たない (待っても検証したい性質は変わらない)。
        time.sleep(delay)
        try:
            ws_send_text(sock, json.dumps({"message": "RecognitionStarted", "id": "e2e"}))
        except Exception:
            pass

    threading.Thread(target=announce, daemon=True).start()

    try:
        while True:
            frame = ws_read_frame(sock)
            if frame is None:
                break
            opcode, payload = frame
            if opcode == 0x8:  # close
                break
            if opcode == 0x1:  # text
                try:
                    msg = json.loads(payload.decode("utf-8"))
                except Exception:
                    continue
                if msg.get("message") == "EndOfStream":
                    ws_send_text(sock, json.dumps({"message": "EndOfTranscript"}))
            # binary (AddAudio) は捨てる。PCM の内容はこの検証に関係しない。
    except Exception:
        pass
    finally:
        try:
            sock.close()
        except Exception:
            pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a) -> None:
        pass

    def _send(self, obj: dict, code: int = 200) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._send({})

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        if path == "/e2e/asr/jwt":
            if stub.get("fail_jwt"):
                return self._send({"error": "e2e forced failure"}, 500)
            return self._send({"key_value": "e2e-jwt"})
        self._send({"error": "not found", "path": path}, 404)

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path == "/e2e/asr/ws":
            key = self.headers.get("Sec-WebSocket-Key")
            if not key:
                return self._send({"error": "not a websocket handshake"}, 400)
            # ここから先はこのスレッドが生の TCP を使う。HTTP の後始末はさせない。
            self.close_connection = True
            serve_ws(self.connection, key)
            return
        if path == "/api/health":
            return self._send({"ok": True})
        if path == "/e2e/input":
            return self._send({"actions": []})
        if path == "/api/sessions":
            return self._send({"sessions": [
                {"name": SESSION, "created": int(time.time()) - 60, "windows": 1, "attached": False},
            ]})
        if path == "/api/claude/sessions":
            return self._send({"sessions": [stub.session()]})
        if re.match(r"^/api/claude/sessions/[^/]+/chat$", path):
            return self._send({"chat": [], "source": "claude", "status": "idle"})
        if re.match(r"^/api/claude/sessions/[^/]+/pending$", path):
            return self._send({"pending": None})
        if path.startswith("/ctl/delay/"):
            stub.set(connect_delay=float(path.rsplit("/", 1)[-1]))
            return self._send({"connect_delay": stub.get("connect_delay")})
        if path.startswith("/ctl/failjwt/"):
            stub.set(fail_jwt=path.rsplit("/", 1)[-1] == "1")
            return self._send({"fail_jwt": stub.get("fail_jwt")})
        self._send({"error": "not found", "path": path}, 404)


# ─── automation API ─────────────────────────────────────────────────

def port_open(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def wait_port(port: int, proc: subprocess.Popen | None, label: str, tries: int = 300) -> None:
    for _ in range(tries):
        if port_open(port):
            return
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(f"{label} が起動前に終了しました (rc={proc.returncode})")
        time.sleep(0.25)
    raise RuntimeError(f"{label} が起動しませんでした (port {port})")


def api(path: str, payload: dict | None = None) -> bytes:
    url = f"http://127.0.0.1:{AUTOMATION_PORT}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


def ctl(path: str) -> None:
    with urllib.request.urlopen(f"http://127.0.0.1:{STUB_PORT}{path}", timeout=5) as r:
        r.read()


def console_entries() -> list[dict]:
    try:
        raw = api("/api/console").decode("utf-8", errors="replace")
        return json.loads(raw).get("entries", [])
    except Exception:
        return []


def console_text() -> str:
    return "\n".join(str(e.get("message", "")) for e in console_entries())


def wait_console(substr: str, timeout_s: float = 30) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if substr in console_text():
            return True
        time.sleep(0.3)
    return False


# ─── レンズフレームの時系列 ─────────────────────────────────────────
# ヘッダ (秒数) と本文 (接続中… / 録音中) を同じ時間軸に並べる。

HEADER_RE = re.compile(r'\[refreshG2\] firing \(phase=([\w-]+), force=\w+\) header="(.*)"$')
CONTENT_RE = re.compile(r"\[refreshG2\] content=(\".*?\") footer=(\".*?\")$")
SECONDS_RE = re.compile(r"(\d+\.\d)s\s*$")


class Frame:
    __slots__ = ("t", "phase", "header", "content")

    def __init__(self, t: float, phase: str, header: str, content: str) -> None:
        self.t, self.phase, self.header, self.content = t, phase, header, content

    @property
    def seconds(self) -> float | None:
        m = SECONDS_RE.search(self.header)
        return float(m.group(1)) if m else None

    @property
    def connecting(self) -> bool:
        return CONNECTING in self.content

    def __repr__(self) -> str:
        return f"{self.header!r}/{'接続中' if self.connecting else '録音中'}"


class LensTail:
    """`firing (...) header="..."` と、その直後の content 行を 1 フレームに束ねる。"""

    def __init__(self) -> None:
        self.last_id = -1
        self.frames: list[Frame] = []
        self.pending: tuple[float, str, str] | None = None
        self.stop = threading.Event()
        self.th = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self.th.start()

    def _run(self) -> None:
        while not self.stop.is_set():
            for e in console_entries():
                eid = e.get("id", -1)
                if eid <= self.last_id:
                    continue
                self.last_id = eid
                msg = str(e.get("message", ""))
                ts = e.get("ts", 0) / 1000.0
                m = HEADER_RE.search(msg)
                if m:
                    self.pending = (ts, m.group(1), m.group(2))
                    continue
                m = CONTENT_RE.search(msg)
                if m and self.pending is not None:
                    t, phase, header = self.pending
                    self.pending = None
                    try:
                        content = json.loads(m.group(1))
                    except Exception:
                        content = ""
                    self.frames.append(Frame(t, phase, header, content))
            time.sleep(0.08)

    def close(self) -> None:
        self.stop.set()

    def collect(self, seconds: float) -> list[Frame]:
        start = len(self.frames)
        time.sleep(seconds)
        return self.frames[start:]


lens = LensTail()


def rec_frames(frames: list[Frame]) -> list[Frame]:
    return [f for f in frames if f.phase == "recording"]


def describe(frames: list[Frame]) -> str:
    if not frames:
        return "(フレーム無し)"
    t0 = frames[0].t
    return " | ".join(f"+{f.t - t0:.1f}s {f.header}{'[接続中]' if f.connecting else ''}"
                      for f in frames[:14])


def send_input(action: str, settle: float = 0.35) -> None:
    api("/api/input", {"action": action})
    time.sleep(settle)


def main() -> int:
    procs: list[subprocess.Popen] = []
    httpd = ThreadingHTTPServer(("127.0.0.1", STUB_PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        for port, label in ((APP_PORT, "dev server"), (AUTOMATION_PORT, "simulator")):
            if port_open(port):
                raise RuntimeError(f"port {port} が既に使われています ({label} の残骸?)")
        print(f"スタブ (headlenss API + Speechmatics RT): http://127.0.0.1:{STUB_PORT}")

        print("headlenss アプリの dev server を起動中...")
        procs.append(subprocess.Popen(
            ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(APP_PORT), "--strictPort"],
            cwd=EVEN, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        ))
        wait_port(APP_PORT, procs[-1], "headlenss dev server")

        print("シミュレータ起動中 (xvfb-run)...")
        seed = (f"http://127.0.0.1:{APP_PORT}/e2e-seed.html"
                f"?server=http://127.0.0.1:{STUB_PORT}&session={SESSION}&lang=ja")
        sim = subprocess.Popen(
            ["xvfb-run", "-a", "node", str(SIMULATOR), seed, "--automation-port", str(AUTOMATION_PORT)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        procs.append(sim)
        wait_port(AUTOMATION_PORT, sim, "simulator automation API")
        api("/api/ping")

        booted = wait_console("G2 lens rendered (phase=rootlist)", 60)
        check("0. アプリが起動しセッション一覧が出る", booted)
        if not booted:
            raise RuntimeError("起動しなかったので以降は測れません")
        check("0. 音声認識の接続先が検証スタブに向いている",
              wait_console("[e2e] input bridge on", 15))

        lens.start()

        # rootlist --tap--> idle
        send_input("click", 1.0)
        check("0. セッションを開いて idle に入る", wait_console("phase=idle", 20))
        time.sleep(1.0)

        # ─── 1〜3. 接続が 3 秒遅れるケース ───────────────────────────
        print("\n[接続が 3 秒遅れる録音]")
        ctl("/ctl/delay/3.0")
        time.sleep(0.5)
        tap_at = time.time()
        api("/api/input", {"action": "click"})   # idle -> recording
        frames = rec_frames(lens.collect(9.0))
        print(f"    {describe(frames)}")

        check("1. 録音画面のフレームが取れている", len(frames) >= 6, f"{len(frames)} 件")
        connecting = [f for f in frames if f.connecting]
        ready = [f for f in frames if not f.connecting]
        check("1. 「接続中…」のコマがある", len(connecting) >= 4, f"{len(connecting)} 件")
        check("2. 「録音中」に変わったコマがある", len(ready) >= 4, f"{len(ready)} 件")

        bad = [f for f in connecting if f.seconds != 0.0]
        check("1. 「接続中…」の間ヘッダは 0.0s のまま",
              not bad, f"0.0s でないコマ: {[f.header for f in bad][:4]}")

        if ready:
            first_ready = ready[0]
            check("2. 「録音中」になった直後は 0 秒付近から始まる",
                  (first_ready.seconds or 0) <= 0.6, f"{first_ready.header!r}")
            # 押してからの経過時間ではないこと: 接続 3 秒 + マイク待ちのぶん、
            # 押した時刻からの実経過より秒数が明確に小さい。
            elapsed_since_tap = first_ready.t - tap_at
            check("2. 押した時刻ではなく受け付け開始からの時間になっている",
                  elapsed_since_tap >= 2.5 and (first_ready.seconds or 0) < elapsed_since_tap - 2.0,
                  f"押してから {elapsed_since_tap:.1f}s 経過, ヘッダ {first_ready.header!r}")
            secs = [f.seconds for f in ready if f.seconds is not None]
            check("2. 「録音中」以降は秒数が進む",
                  len(secs) >= 3 and secs[-1] > secs[0],
                  f"{secs[:8]}")
            check("2. ヘッダの表記は「録音中 X.Xs」",
                  all(f.header.startswith(HEAD_REC) for f in ready),
                  f"{[f.header for f in ready[:3]]}")
            check("2. 本文が「録音中」の案内に変わる",
                  all(REC_HINT in f.content for f in ready),
                  f"{ready[0].content!r}")

        # ─── 3. 停止すると止まる ────────────────────────────────────
        print("\n[停止すると止まる]")
        last_rec = rec_frames(lens.frames)[-1]
        api("/api/input", {"action": "click"})   # recording -> finalizing
        time.sleep(4.0)
        after = rec_frames(lens.frames)
        stopped_at_value = after[-1].seconds
        time.sleep(3.0)
        after2 = rec_frames(lens.frames)
        check("3. 停止後は recording のフレームが増えない",
              len(after2) == len(after), f"{len(after)} -> {len(after2)}")
        check("3. 停止時点の値で止まっている",
              stopped_at_value is not None and stopped_at_value >= (last_rec.seconds or 0),
              f"停止直前 {last_rec.header!r} / 最後 {after[-1].header!r}")
        check("3. 録音画面から抜けている",
              lens.frames[-1].phase != "recording", f"phase={lens.frames[-1].phase}")

        # ─── 4. 接続が速い通常ケース (回帰) ─────────────────────────
        print("\n[通常の録音 (接続 0.3 秒)]")
        ctl("/ctl/delay/0.3")
        # 直前の録音の後始末 (finalizing -> idle) を待つ
        deadline = time.time() + 15
        while time.time() < deadline and lens.frames[-1].phase not in ("idle", "pending"):
            time.sleep(0.4)
        time.sleep(1.0)
        api("/api/input", {"action": "click"})
        frames = rec_frames(lens.collect(8.0))
        print(f"    {describe(frames)}")
        ready = [f for f in frames if not f.connecting]
        conn = [f for f in frames if f.connecting]
        check("4. 通常ケースでも接続中は 0.0s",
              all(f.seconds == 0.0 for f in conn), f"{[f.header for f in conn][:4]}")
        secs = [f.seconds for f in ready if f.seconds is not None]
        check("4. 通常ケースで秒数が進む", len(secs) >= 3 and secs[-1] > secs[0], f"{secs[:8]}")
        api("/api/input", {"action": "click"})   # 停止
        time.sleep(4.0)

        # ─── 5. 接続失敗で録音ごと畳まれる ──────────────────────────
        print("\n[音声認識への接続に失敗する]")
        ctl("/ctl/failjwt/1")
        deadline = time.time() + 15
        while time.time() < deadline and lens.frames[-1].phase not in ("idle", "pending"):
            time.sleep(0.4)
        time.sleep(1.0)
        before = len(lens.frames)
        api("/api/input", {"action": "click"})
        time.sleep(6.0)
        new = lens.frames[before:]
        print(f"    {describe(new)}")
        recs = rec_frames(new)
        check("5. 接続失敗なら録音画面に居座らない",
              lens.frames[-1].phase != "recording", f"phase={lens.frames[-1].phase}")
        check("5. 失敗までの間もタイマーは 0.0s のまま (数え始めない)",
              all(f.seconds == 0.0 for f in recs), f"{[f.header for f in recs][:5]}")
        check("5. 失敗理由がレンズに出る",
              "録音開始に失敗" in "\n".join(f.header for f in new) or
              "録音開始に失敗" in console_text(),
              "通知が見当たらない")
        ctl("/ctl/failjwt/0")

    except Exception as e:
        check("実行", False, f"{type(e).__name__}: {e}")
    finally:
        lens.close()
        try:
            out = EVEN / "tools/e2e-out"
            out.mkdir(parents=True, exist_ok=True)
            (out / "recording_timer_console.txt").write_text(console_text(), encoding="utf-8")
        except Exception:
            pass
        httpd.shutdown()
        httpd.server_close()
        # npm / xvfb-run は本体を子として起こすので、プロセスグループごと落とす
        for p in procs:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(os.getpgid(p.pid), sig)
                except Exception:
                    pass
                try:
                    p.wait(timeout=5)
                    break
                except Exception:
                    continue

    ng = [r for r in results if not r[0]]
    print(f"\n=== {len(results) - len(ng)}/{len(results)} OK ===")
    for ok, name, detail in ng:
        print(f"  NG: {name}  {detail}")
    return 1 if ng else 0


if __name__ == "__main__":
    sys.exit(main())
