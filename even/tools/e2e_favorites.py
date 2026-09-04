#!/usr/bin/env python3
"""E2E: お気に入りセッション (★) の検証。

公式シミュレータ (evenhub-simulator / xvfb) で、レンズへ実際に送られた本文を見て
以下を確かめる:

  1. ★ が 1 つも無い間は星の列を作らない (名前の開始位置が今までどおり)
  2. セッション行を長押し → ★ が付き、一覧の先頭へ移動する
  3. 並べ替えてもカーソルは同じ行に付いていく (飛ばない)
  4. もう一度長押し → ★ が外れ、元の位置に戻る
  5. プラグイン行 (└ …) にカーソルがある状態で長押し → 親セッションに作用する
     (プラグイン行は親の直下に従属したまま一緒に上がる)
  6. 長押しの直後に来るタップは無視される (★ を付けた勢いでセッションが開かない)
  7. 再起動しても ★ が残る。**WebView の localStorage を消してから** リロードするので、
     復元できたならブリッジ側 KVS に保存できていた証拠になる (本番と同じ条件)

長押しはシミュレータの automation API (`/api/input`) では送れない (up/down/click/
double_click の 4 つだけ) ため、dev server 限定のイベント注入口 (src/e2e-input.ts) を
使う。アプリがこのスタブサーバの `/e2e/input` を取りに来るので、そこへ注入したい
イベントを積む。出荷ビルドにはこの経路は入らない (import.meta.env.DEV で消える)。

本番サーバ (3000) も dev server (5177) もプロキシ (6177) も使わない。
このスクリプトが自前のスタブ API サーバを空きポートに立てる。tmux にも触らない。

実行:
  python3 even/tools/e2e_favorites.py
"""

import json
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

EVEN = Path(__file__).resolve().parent.parent
SIMULATOR = EVEN / "node_modules/@evenrealities/evenhub-simulator/bin/index.js"

# 本番サーバ (3000) / dev server (5177) / プロキシ (6177) / 他の E2E (5321,9911,8821) を避ける
APP_PORT = 5323
AUTOMATION_PORT = 9913
STUB_PORT = 8823

# 一覧に出す 3 セッション。bravo にだけ G2 プラグインをぶら下げる。
SESSIONS = ["alpha", "bravo", "charlie"]
PLUGIN_NAME = "devsite"

STAR = "★"        # ★
STAR_PAD = "　"    # 全角スペース (★ と同じ 20px)

results: list[tuple[bool, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((ok, name, detail))
    print(f"  [{'OK' if ok else 'NG'}] {name}" + (f"  ({detail})" if detail else ""))


# ─── スタブ API サーバ (+ イベント注入キュー) ─────────────────────────

class Stub:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.queue: deque[str] = deque()

    def push(self, *actions: str) -> None:
        with self.lock:
            self.queue.extend(actions)

    def drain(self) -> list[str]:
        with self.lock:
            out = list(self.queue)
            self.queue.clear()
            return out

    def sessions(self) -> list[dict]:
        now = int(time.time() * 1000)
        out = []
        for i, name in enumerate(SESSIONS):
            s = {
                "tmuxSessionName": name,
                "cwd": f"/tmp/{name}",
                "status": "idle",
                "startedAt": now - 60_000,
                # 未読マーク (*) が付くと行が揺れるので、既読側に倒しておく
                "lastSeenAt": now - 60_000 + i,
                "source": "claude",
            }
            if name == "bravo":
                s["g2Plugins"] = [{"name": PLUGIN_NAME, "url": f"http://127.0.0.1:{STUB_PORT}/plugin"}]
            out.append(s)
        return out


stub = Stub()


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

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self._send({"ok": True})
        if path == "/e2e/input":
            return self._send({"actions": stub.drain()})
        if path == "/api/sessions":
            return self._send({"sessions": [
                {"name": n, "created": int(time.time()) - 60, "windows": 1, "attached": False}
                for n in SESSIONS
            ]})
        if path == "/api/claude/sessions":
            return self._send({"sessions": stub.sessions()})
        m = re.match(r"^/api/claude/sessions/([^/]+)/chat$", path)
        if m:
            return self._send({"chat": [], "source": "claude", "status": "idle"})
        m = re.match(r"^/api/claude/sessions/([^/]+)/pending$", path)
        if m:
            return self._send({"pending": None})
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


# ─── レンズ本文の追跡 ───────────────────────────────────────────────
# devMode の `[refreshG2] content="..." footer="..."` を id で追い、最新の 1 枚を保つ。

CONTENT_RE = re.compile(r"\[refreshG2\] content=(\".*?\") footer=(\".*?\")$")
# フッタの位置カウンタ「(3/4)」。一時通知が出ている間は現れない。
COUNTER_RE = re.compile(r"\((\d+)/(\d+)\)$")


class LensTail:
    def __init__(self) -> None:
        self.last_id = -1
        self.content = ""
        self.footer = ""
        self.count = 0
        self.stop = threading.Event()
        self.th = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self.th.start()

    def reset(self) -> None:
        """リロード後にログ id が振り直されるわけではないが、古い画面を混ぜないため。"""
        self.content = ""
        self.footer = ""

    def _run(self) -> None:
        while not self.stop.is_set():
            for e in console_entries():
                eid = e.get("id", -1)
                if eid <= self.last_id:
                    continue
                self.last_id = eid
                m = CONTENT_RE.search(str(e.get("message", "")))
                if m:
                    try:
                        self.content = json.loads(m.group(1))
                        self.footer = json.loads(m.group(2))
                        self.count += 1
                    except Exception:
                        pass
            time.sleep(0.08)

    def close(self) -> None:
        self.stop.set()

    def settle(self, seconds: float = 1.2) -> tuple[list[str], str]:
        """しばらく待って、落ち着いた最後の 1 枚 (本文行, フッタ) を返す。"""
        time.sleep(seconds)
        return self.content.split("\n"), self.footer

    def wait_counter(self, timeout_s: float = 14) -> tuple[list[str], str]:
        """★ の付け外しはフッタに一時通知を出す (8 秒 or 次の操作で消える)。
        カーソル位置は通知が引っ込んでからでないと読めないので、位置カウンタ
        「(n/m)」が戻るまで待ってから最後の 1 枚を返す。"""
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            if COUNTER_RE.search(self.footer):
                break
            time.sleep(0.2)
        time.sleep(0.4)
        return self.content.split("\n"), self.footer


lens = LensTail()


def send_input(action: str) -> None:
    api("/api/input", {"action": action})
    time.sleep(0.35)


def long_press() -> None:
    """長押し (押し始め + 離す) を注入する。実機と同じ 2 イベント順で送る。"""
    stub.push("long_press")
    time.sleep(0.45)
    stub.push("long_press_release")
    time.sleep(0.45)


def show(lines: list[str]) -> str:
    return " / ".join(lines)


def row_index(lines: list[str], needle: str) -> int:
    for i, ln in enumerate(lines):
        if needle in ln:
            return i
    return -1


def main() -> int:
    procs: list[subprocess.Popen] = []
    httpd = ThreadingHTTPServer(("127.0.0.1", STUB_PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
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
                f"?server=http://127.0.0.1:{STUB_PORT}&session={SESSIONS[0]}&lang=ja")
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
        check("0. イベント注入口が開いている", wait_console("[e2e] input bridge on", 15))

        lens.start()
        lines, footer = lens.settle(2.5)
        print(f"    初期表示: {show(lines)}  footer={footer!r}")

        # ─── 1. ★ が無い間は星の列を作らない ───────────────────────
        check("1. ★ 未使用時は星の列を作らない (行頭がカーソルの直後から)",
              all(STAR not in ln and STAR_PAD not in ln for ln in lines), show(lines))
        expect_initial = [SESSIONS[0], SESSIONS[1], PLUGIN_NAME, SESSIONS[2]]
        got_initial = [row_index(lines, n) for n in expect_initial]
        check("1. 初期の並びは サーバ順 + プラグインが親の直下",
              got_initial == sorted(got_initial) and -1 not in got_initial,
              f"{expect_initial} -> {got_initial}: {show(lines)}")

        # ─── 2. セッション行を長押し → ★ が付いて先頭へ ─────────────
        print("\n[セッション行の長押し]")
        # カーソルは alpha (seed の session)。charlie (行 index 3) まで下げる
        for _ in range(3):
            send_input("down")
        lines, footer = lens.settle(1.2)
        check("2. 前提: カーソルが charlie の行にある", footer.endswith("(4/4)"),
              f"footer={footer!r} {show(lines)}")

        long_press()
        lines, footer = lens.settle(1.2)
        print(f"    長押し後: {show(lines)}  footer={footer!r}")
        check("2. 長押しした手応えをフッタに出す", "★" in footer and SESSIONS[2] in footer,
              f"footer={footer!r}")
        check("2. charlie に ★ が付く", any(STAR in ln and SESSIONS[2] in ln for ln in lines), show(lines))
        check("2. ★ 付きが一覧の先頭に来る", row_index(lines, SESSIONS[2]) == 0, show(lines))
        check("2. ★ は行の冒頭 (カーソル記号の直後)",
              any(re.match(rf"^(▶ |  ){STAR}{SESSIONS[2]} ", ln) for ln in lines), show(lines))
        check("2. ★ 無しの行は全角スペースで桁を揃える",
              all(re.match(rf"^(▶ |  )[{STAR}{STAR_PAD}]", ln) for ln in lines), show(lines))
        check("2. ★ 以外の並びは崩れない (alpha, bravo, └devsite の順)",
              [row_index(lines, n) for n in [SESSIONS[0], SESSIONS[1], PLUGIN_NAME]] == [1, 2, 3],
              show(lines))

        lines, footer = lens.wait_counter()
        check("3. カーソルは同じ行に付いていく (飛ばない)", footer.endswith("(1/4)"),
              f"footer={footer!r} {show(lines)}")

        # ─── 4 + 6. もう一度長押し → 解除。押している間のタップは無視される ───
        print("\n[再長押しで解除 / 長押し中のタップ抑制]")
        stub.push("long_press")          # 押し始め (ここで ★ が外れる)
        time.sleep(0.8)
        api("/api/input", {"action": "click"})   # 押しっぱなしの最中に来たタップ
        time.sleep(0.8)
        stub.push("long_press_release")  # 離す (ここでは何もしない)
        lines, footer = lens.settle(1.2)
        print(f"    解除後: {show(lines)}  footer={footer!r}")
        check("4. 解除もフッタで知らせる", "★" in footer and SESSIONS[2] in footer, f"footer={footer!r}")
        check("4. ★ が消える", all(STAR not in ln for ln in lines), show(lines))
        check("4. 星の列ごと畳まれる", all(STAR_PAD not in ln for ln in lines), show(lines))
        check("4. 元の並びに戻る",
              [row_index(lines, n) for n in expect_initial] == [0, 1, 2, 3], show(lines))
        check("6. 長押し中のタップでセッションが開かない (rootlist のまま)",
              "phase=idle" not in console_text(), "click が通ってセッションが開いてしまった")
        check("6. 1 回の長押しで 1 回だけトグルされる (離した時に二重発火しない)",
              console_text().count("favorite off: charlie") == 1,
              f'favorite off の回数={console_text().count("favorite off: charlie")}')

        lines, footer = lens.wait_counter()
        check("4. カーソルは charlie に付いたまま", footer.endswith("(4/4)"),
              f"footer={footer!r} {show(lines)}")

        # ─── 5. プラグイン行の長押し → 親セッションに作用 ─────────────
        print("\n[プラグイン行の長押し]")
        # charlie(4/4) から 1 つ上げて プラグイン行 devsite(3/4) へ
        send_input("up")
        lines, footer = lens.settle(1.2)
        plugin_rows = [ln for ln in lines if PLUGIN_NAME in ln]
        check("5. 前提: カーソルがプラグイン行 (└ devsite) にある",
              footer.endswith("(3/4)") and bool(plugin_rows) and "▶" in plugin_rows[0],
              f"footer={footer!r} {show(lines)}")

        long_press()
        lines, footer = lens.settle(1.2)
        print(f"    長押し後: {show(lines)}  footer={footer!r}")
        check("5. 親セッション bravo に対して働く (通知も親の名前)",
              "★" in footer and SESSIONS[1] in footer, f"footer={footer!r}")
        check("5. 親セッション bravo に ★ が付く",
              any(STAR in ln and SESSIONS[1] in ln for ln in lines), show(lines))
        check("5. プラグイン行自体には ★ を付けない",
              all(STAR not in ln for ln in lines if PLUGIN_NAME in ln), show(lines))
        check("5. bravo が先頭へ、プラグインは直下に従属したまま",
              row_index(lines, SESSIONS[1]) == 0 and row_index(lines, PLUGIN_NAME) == 1, show(lines))

        lines, footer = lens.wait_counter()
        check("5. カーソルはプラグイン行に付いていく", footer.endswith("(2/4)"),
              f"footer={footer!r} {show(lines)}")

        # ─── 7. 再起動 (localStorage を消してリロード) しても残る ─────
        print("\n[再起動後の復元 (WebView localStorage を消してから)]")
        before_id = lens.last_id
        stub.push("wipe_local_reload")
        rebooted = wait_console("G2 lens rendered (phase=rootlist)", 60)
        check("7. 再起動できた", rebooted)

        # 再起動後に出た [favorites] loaded 行を拾う
        loaded = ""
        deadline = time.time() + 20
        while time.time() < deadline and not loaded:
            for e in console_entries():
                if e.get("id", -1) <= before_id:
                    continue
                msg = str(e.get("message", ""))
                if "[favorites] loaded" in msg:
                    loaded = msg
            time.sleep(0.3)
        print(f"    {loaded}")
        check("7. ブリッジ側から復元している (localStorage は消してある)",
              "from=bridge" in loaded and "count=1" in loaded and "local=absent" in loaded,
              loaded or "(ログが見つからない)")

        lines, footer = lens.settle(3.0)
        print(f"    再起動後: {show(lines)}  footer={footer!r}")
        check("7. 再起動後も bravo に ★ が残る",
              any(STAR in ln and SESSIONS[1] in ln for ln in lines), show(lines))
        check("7. 再起動後も ★ 付きが先頭",
              row_index(lines, SESSIONS[1]) == 0 and row_index(lines, PLUGIN_NAME) == 1, show(lines))

    except Exception as e:
        check("実行", False, f"{type(e).__name__}: {e}")
    finally:
        lens.close()
        try:
            out = EVEN / "tools/e2e-out"
            out.mkdir(parents=True, exist_ok=True)
            (out / "favorites_console.txt").write_text(console_text(), encoding="utf-8")
            png = api("/api/screenshot/glasses")
            (out / "favorites_glasses.png").write_bytes(png)
        except Exception:
            pass
        httpd.shutdown()
        for p in procs:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    ng = [r for r in results if not r[0]]
    print(f"\n=== {len(results) - len(ng)}/{len(results)} OK ===")
    for ok, name, detail in ng:
        print(f"  NG: {name}  {detail}")
    return 1 if ng else 0


if __name__ == "__main__":
    sys.exit(main())
