#!/usr/bin/env python3
"""E2E: idle ヘッダの状態表示 (画面ブロック / 回答待ち) が点滅することの検証。

公式シミュレータ (evenhub-simulator / xvfb) で、レンズへ実際に送られたヘッダの
時系列を見て以下を確かめる:

  1. 質問待ち  : 「name　(?) 質問待ち」⇔「name」が 0.75 秒周期で交互になる
  2. 承認待ち  : 同上 (文言だけ (?) 承認待ち に変わる)
  3. 画面ブロック: 同上 ((!) ターミナルを確認)
  4. 同時成立  : ブロックが優先され、回答待ちの文言は出ない (点滅は 1 系統だけ)
  5. 解除      : どちらも無くなればヘッダはセッション名だけに戻り、点滅も止まる

本番サーバ (3000) も dev server (5177) もプロキシ (6177) も使わない。
このスクリプトが自前のスタブ API サーバを空きポートに立て、状態を外から
切り替えて検証する。tmux にも触らない。

観測点は `[refreshG2] firing (...) header="..."` のログ。シミュレータの
automation API (/api/console) を細かくポーリングし、新しく現れた行に
こちら側の時刻を打って時系列を組む。

実行:
  python3 even/tools/e2e_header_blink.py
"""

import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

EVEN = Path(__file__).resolve().parent.parent
SIMULATOR = EVEN / "node_modules/@evenrealities/evenhub-simulator/bin/index.js"

# 本番サーバ (3000) / dev server (5177) / プロキシ (6177) を避けた専用ポート
APP_PORT = 5321
AUTOMATION_PORT = 9911
STUB_PORT = 8821
SESSION = "blinktest"

# 期待文言 (i18n の ja)
WAIT_Q = "(?) 質問待ち"
WAIT_PERM = "(?) 承認待ち"
BLOCKED = "(!) ターミナルを確認"
SEP = "　"  # 全角スペース

BLINK_MS = 750

results: list[tuple[bool, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((ok, name, detail))
    print(f"  [{'OK' if ok else 'NG'}] {name}" + (f"  ({detail})" if detail else ""))


# ─── スタブ API サーバ ────────────────────────────────────────────────
# headlenss サーバのうち、アプリが idle 画面を出すために叩く分だけを返す。
# mode を外から差し替えることで、待ち状態の出現/消滅を再現する。

class Stub:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.mode = "none"      # none / question / permission / blocked / both

    def set(self, mode: str) -> None:
        with self.lock:
            self.mode = mode

    def snapshot(self) -> str:
        with self.lock:
            return self.mode

    def session(self) -> dict:
        mode = self.snapshot()
        now = int(time.time() * 1000)
        s = {
            "tmuxSessionName": SESSION,
            "cwd": "/tmp/blinktest",
            "status": "idle",
            "startedAt": now - 60_000,
            "lastSeenAt": now,
            "source": "claude",
            "lastChat": "stub session",
        }
        if mode in ("question", "both"):
            s["status"] = "waiting-question"
        elif mode == "permission":
            s["status"] = "waiting-permission"
        if mode in ("blocked", "both"):
            s["screenBlocked"] = True
        return s

    def pending(self) -> dict | None:
        mode = self.snapshot()
        now = int(time.time() * 1000)
        if mode in ("question", "both"):
            return {
                "id": "pending-q-1",
                "kind": "question",
                "hookEvent": "PreToolUse",
                "toolName": "AskUserQuestion",
                "toolInput": {},
                "questions": [{
                    "question": "どちらにしますか",
                    "header": "選択",
                    "multiSelect": False,
                    "options": [
                        {"label": "A", "description": "案 A"},
                        {"label": "B", "description": "案 B"},
                    ],
                }],
                "createdAt": now - 5_000,
            }
        if mode == "permission":
            return {
                "id": "pending-p-1",
                "kind": "permission",
                "hookEvent": "PreToolUse",
                "toolName": "Bash",
                "toolInput": {"command": "echo hi"},
                "createdAt": now - 5_000,
            }
        return None

    def chat(self) -> dict:
        mode = self.snapshot()
        now = int(time.time() * 1000)
        status = "idle"
        if mode in ("question", "both"):
            status = "waiting-question"
        elif mode == "permission":
            status = "waiting-permission"
        return {
            "chat": [
                {"role": "user", "text": "こんにちは", "ts": now - 20_000},
                {"role": "assistant", "text": "はい、なんでしょう", "ts": now - 19_000},
            ],
            "source": "claude",
            "status": status,
        }


stub = Stub()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a) -> None:  # サーバのアクセスログは黙らせる
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

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self._send({"ok": True})
        if path == "/api/sessions":
            return self._send({"sessions": [
                {"name": SESSION, "created": int(time.time()) - 60, "windows": 1, "attached": False},
            ]})
        if path == "/api/claude/sessions":
            return self._send({"sessions": [stub.session()]})
        if path == f"/api/claude/sessions/{SESSION}/chat":
            return self._send(stub.chat())
        if path == f"/api/claude/sessions/{SESSION}/pending":
            return self._send({"pending": stub.pending()})
        if path.startswith("/ctl/"):
            stub.set(path.rsplit("/", 1)[-1])
            return self._send({"mode": stub.snapshot()})
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


def console_entries() -> list[dict]:
    """automation API の console は {"entries":[{id, level, message, ts}, ...]} を返す。"""
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
        time.sleep(0.4)
    return False


def ctl(mode: str) -> None:
    with urllib.request.urlopen(f"http://127.0.0.1:{STUB_PORT}/ctl/{mode}", timeout=5) as r:
        r.read()


# ─── ヘッダ時系列の収集 ──────────────────────────────────────────────

HEADER_RE = re.compile(r'\[refreshG2\] firing \(phase=([\w-]+), force=\w+\) header="(.*)"$')


class HeaderTail:
    """console のヘッダ送信ログを id で追い、entry の ts (ms) を時刻として溜める。"""

    def __init__(self) -> None:
        self.last_id = -1
        self.events: list[tuple[float, str, str]] = []   # (t[秒], phase, header)
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
                m = HEADER_RE.search(str(e.get("message", "")))
                if m:
                    self.events.append((e.get("ts", 0) / 1000.0, m.group(1), m.group(2)))
            time.sleep(0.1)

    def close(self) -> None:
        self.stop.set()

    def collect(self, seconds: float) -> list[tuple[float, str, str]]:
        """これから seconds 秒ぶんに現れるヘッダ送信を集めて返す。"""
        start = len(self.events)
        time.sleep(seconds)
        return self.events[start:]


def describe(seq: list[tuple[float, str, str]]) -> str:
    return " | ".join(f"+{t - seq[0][0]:.2f}s {h!r}" for t, _p, h in seq) if seq else "(送信なし)"


def check_blink(label: str, seq: list[tuple[float, str, str]], badge: str) -> None:
    """seq が「name + badge」⇔「name」の交互で、切り替わり間隔が 0.75 秒前後か。"""
    idle = [(t, h) for t, p, h in seq if p == "idle"]
    if len(idle) < 4:
        check(f"{label}: ヘッダが繰り返し送られる", False, f"{len(idle)} 件しか出ていない: {describe(seq)}")
        return

    on = [h for _t, h in idle if badge in h]
    off = [h for _t, h in idle if badge not in h]
    check(f"{label}: 状態表示のコマが出る", len(on) >= 2,
          f"{len(on)} 件 例: {on[0]!r}" if on else "0 件")
    check(f"{label}: セッション名だけのコマが出る (= 消えるコマがある)", len(off) >= 2,
          f"{len(off)} 件 例: {off[0]!r}" if off else "0 件")

    # 並びは「セッション名　状態」。名前が先頭に来ていること。
    ok_order = all(h.startswith(SESSION) for _t, h in idle)
    check(f"{label}: セッション名が先、状態が後", ok_order, describe(idle_seq(seq))[:200])

    # 非表示コマはセッション名だけ
    ok_off = all(h == SESSION for h in off)
    check(f"{label}: 非表示コマはセッション名のみ", ok_off,
          f"例外: {[h for h in off if h != SESSION][:3]}")

    # 交互になっているか (同じ状態が 3 連続で続かない)
    states = [(badge in h) for _t, h in idle]
    run = 1
    worst = 1
    for a, b in zip(states, states[1:]):
        run = run + 1 if a == b else 1
        worst = max(worst, run)
    check(f"{label}: 表示⇔非表示が交互", worst <= 2, f"最長の連続={worst} 列={''.join('1' if s else '0' for s in states)}")

    # 切り替わり間隔が 0.75 秒前後 (ポーリング 1.5 秒の半分)
    gaps = [round((idle[i + 1][0] - idle[i][0]) * 1000) for i in range(len(idle) - 1)
            if states[i] != states[i + 1]]
    ok_gap = bool(gaps) and all(400 <= g <= 1200 for g in gaps)
    check(f"{label}: 切り替わり間隔が 0.75 秒前後", ok_gap, f"{gaps} ms")


def idle_seq(seq):
    return [(t, p, h) for t, p, h in seq if p == "idle"]


def main() -> int:
    procs: list[subprocess.Popen] = []
    httpd = ThreadingHTTPServer(("127.0.0.1", STUB_PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    tail: HeaderTail | None = None
    try:
        print(f"スタブ API サーバ: http://127.0.0.1:{STUB_PORT}")

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

        tail = HeaderTail()
        tail.start()

        # rootlist --click--> idle (先頭行 = スタブの唯一のセッション)
        time.sleep(1.5)
        api("/api/input", {"action": "click"})
        entered = wait_console("phase=idle", 20)
        check("0. セッションを開いて idle に入る", entered)

        # 1. 質問待ち
        print("\n[質問待ち]")
        ctl("question")
        time.sleep(2.0)                       # 反映待ち (ポーリング 1.5 秒)
        check_blink("1. 質問待ち", tail.collect(6.0), WAIT_Q)

        # 2. 承認待ち
        print("\n[承認待ち]")
        ctl("permission")
        time.sleep(2.5)
        check_blink("2. 承認待ち", tail.collect(6.0), WAIT_PERM)

        # 3. 画面ブロック (既存挙動の回帰確認)
        print("\n[画面ブロック]")
        ctl("blocked")
        time.sleep(2.5)
        check_blink("3. 画面ブロック", tail.collect(6.0), BLOCKED)

        # 4. 同時成立 → ブロックが優先。回答待ちの文言は一切出ない。
        # 直前をブロック単独にしておくと「変わっていないだけ」と区別できないので、
        # いったん質問待ちへ戻してから同時成立にする。
        print("\n[ブロック + 回答待ち]")
        ctl("question")
        time.sleep(2.5)
        seq_q2 = tail.collect(3.0)
        check("4. 前提: いったん質問待ちに戻る",
              any(WAIT_Q in h for _t, _p, h in idle_seq(seq_q2)), describe(idle_seq(seq_q2))[:160])
        ctl("both")
        time.sleep(2.5)
        seq_both = tail.collect(6.0)
        check_blink("4. 同時成立 (ブロック側)", seq_both, BLOCKED)
        leaked = [h for _t, p, h in idle_seq(seq_both) if WAIT_Q in h or WAIT_PERM in h]
        check("4. 同時成立: 回答待ちの文言は出ない (点滅は 1 系統)", not leaked, f"{leaked[:3]}")

        # 5. 解除 → セッション名だけに戻り、点滅も止まる
        print("\n[解除]")
        ctl("none")
        time.sleep(3.0)
        seq_clear = tail.collect(5.0)
        idle_clear = [h for _t, p, h in seq_clear if p == "idle"]
        badges = [h for h in idle_clear if any(b in h for b in (WAIT_Q, WAIT_PERM, BLOCKED))]
        check("5. 解除後は状態表示が消える", not badges, f"{badges[:3]}")
        check("5. 解除後のヘッダはセッション名のみ",
              all(h == SESSION for h in idle_clear),
              f"{sorted(set(idle_clear))[:3]}")
        # 点滅が止まる = 変化しないので送信自体が dedup で止まる
        check("5. 解除後は再送が止まる (点滅停止)", len(idle_clear) <= 2,
              f"5 秒間に {len(idle_clear)} 件")

        # 全区間を通して 56 文字の歯止めを超えていないこと
        too_long = [h for _t, _p, h in tail.events if len(h) > 56]
        check("6. ヘッダは 56 文字以内", not too_long, f"{too_long[:2]}")

    except Exception as e:
        check("実行", False, f"{type(e).__name__}: {e}")
    finally:
        try:
            out = Path(os.environ.get("E2E_OUT_DIR", EVEN / "tools" / "e2e-out"))
            out.mkdir(parents=True, exist_ok=True)
            (out / "header_blink_console.txt").write_text(console_text(), encoding="utf-8")
            if tail:
                (out / "header_blink_events.txt").write_text(
                    "\n".join(f"{t:.3f}\t{p}\t{h}" for t, p, h in tail.events), encoding="utf-8")
            print(f"\nconsole ログ: {out / 'header_blink_console.txt'}")
        except Exception as e:
            print(f"console 保存失敗: {e}")
        if tail:
            tail.close()
        httpd.shutdown()
        for p in procs:
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGTERM)
            except Exception:
                pass
        time.sleep(1.0)
        for p in procs:
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except Exception:
                pass

    print("\n" + "=" * 60)
    ng = [r for r in results if not r[0]]
    for ok, name, detail in results:
        print(f"[{'OK' if ok else 'NG'}] {name}" + (f"  ({detail})" if detail else ""))
    print(f"\n{len(results) - len(ng)}/{len(results)} 通過")
    return 1 if ng else 0


if __name__ == "__main__":
    sys.exit(main())
