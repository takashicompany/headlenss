#!/usr/bin/env python3
"""E2E: お気に入りセッション (★) の検証。

実機では長押しは OS の長押しメニューを開く操作なので、お気に入りの切替は
アプリ独自の長押しではなく **OS 長押しメニューの独自項目** に載せている。
このスクリプトはその経路を検証する。

公式シミュレータ (evenhub-simulator / xvfb) で、レンズへ実際に送られた本文と
登録されたメニューを見て以下を確かめる:

  1. ★ の無い行には詰め物を一切入れない (カーソルとセッション名の間に空白が無い)
  2. セッション一覧では独自メニュー項目「★ お気に入り切替」が登録される
  3. メニュー項目を選ぶ → ★ がカーソルの直後に詰めて付き、一覧の先頭へ移動する。
     カーソルは飛ばない
  4. もう一度選ぶ → ★ が外れ、元の位置に戻る
  5. プラグイン行 (└ …) にカーソルがある状態で選ぶ → 親セッションに作用する
     (プラグイン行は親の直下に従属したまま一緒に上がる)
  6. 素の長押し (LONG_PRESS_EVENT) ではお気に入りが動かない
     = OS メニューと二重に作用しない
  7. メニュー操作に巻き込まれたタップは無視される (勢いでセッションが開かない)
  8. セッションを開いた画面でも同じメニューで切り替えられる (作用先は開いている
     セッション)。一覧⇄セッションの遷移ではページを組み直さない
  9. ★ 付きセッションを開くとヘッダが「★セッション名」になり、外すと消える
 10. 再起動しても ★ が残る。**WebView の localStorage を消してから** リロードするので、
     復元できたならブリッジ側 KVS に保存できていた証拠になる (本番と同じ条件)

長押しも menuItemClickEvent もシミュレータの automation API (`/api/input`) では
送れない (up/down/click/double_click の 4 つだけ) ため、dev server 限定のイベント
注入口 (src/e2e-input.ts) を使う。アプリがこのスタブサーバの `/e2e/input` を
取りに来るので、そこへ注入したいイベントを積む。出荷ビルドにはこの経路は入らない
(import.meta.env.DEV で消える)。

本番サーバ (3000) も dev server (5177) もプロキシ (6177) も使わない。
このスクリプトが自前のスタブ API サーバを空きポートに立てる。tmux にも触らない。

実行:
  python3 even/tools/e2e_favorites.py
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
MENU_ITEM = "★ お気に入り切替"   # i18n ja の menuToggleFavorite
MENU_ID = 1                       # LENS_MENU_ID_TOGGLE_FAVORITE

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

HEADER_RE = re.compile(r'\[refreshG2\] firing \(phase=[\w-]+, force=\w+\) header="(.*)"$')
CONTENT_RE = re.compile(r"\[refreshG2\] content=(\".*?\") footer=(\".*?\")$")
# フッタの位置カウンタ「(3/4)」。一時通知が出ている間は現れない。
COUNTER_RE = re.compile(r"\((\d+)/(\d+)\)$")
# create/rebuild のたびに renderer が出す「今このページに載せたメニュー」。
MENU_RE = re.compile(r"\[renderer\] menu=(\[.*\])$")


class LensTail:
    def __init__(self) -> None:
        self.last_id = -1
        self.content = ""
        self.footer = ""
        self.header = ""
        self._pending_header: str | None = None
        self.menu: list[str] = []
        self.menu_log: list[list[str]] = []
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
                msg = str(e.get("message", ""))
                m = HEADER_RE.search(msg)
                if m:
                    self._pending_header = m.group(1)
                    continue
                m = CONTENT_RE.search(msg)
                if m:
                    if self._pending_header is not None:
                        self.header = self._pending_header
                        self._pending_header = None
                    try:
                        self.content = json.loads(m.group(1))
                        self.footer = json.loads(m.group(2))
                        self.count += 1
                    except Exception:
                        pass
                m = MENU_RE.search(msg)
                if m:
                    try:
                        self.menu = json.loads(m.group(1))
                        self.menu_log.append(self.menu)
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
    """素の長押し (押し始め + 離す) を注入する。実機と同じ 2 イベント順で送る。
    実機ではこのジェスチャーで OS の長押しメニューが開く。アプリ側はこれ自体には
    何も割り当てていないことを確かめるために使う。"""
    stub.push("long_press")
    time.sleep(0.5)
    stub.push("long_press_release")
    time.sleep(0.5)


def menu_click(item_id: int = MENU_ID) -> None:
    """OS 長押しメニューで独自項目が選ばれた (menuItemClickEvent) を注入する。
    実機の流れに合わせ、長押しでメニューを開いてから項目を選ぶ順で送る。"""
    stub.push("long_press")
    time.sleep(0.4)
    stub.push("long_press_release")
    time.sleep(0.4)
    stub.push(f"menu:{item_id}")
    time.sleep(0.5)


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
        # 前回の残骸が同じポートで生きていると、そちらに繋がったまま「起動した」と
        # 誤認して検証にならない。空いていることを先に確かめる。
        for port, label in ((APP_PORT, "dev server"), (AUTOMATION_PORT, "simulator")):
            if port_open(port):
                raise RuntimeError(f"port {port} が既に使われています ({label} の残骸?)。先に落としてください")
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

        # ─── 1. ★ 無しの行に余白を入れない ─────────────────────────
        check("1. ★ 未使用時は星も詰め物も入らない",
              all(STAR not in ln and STAR_PAD not in ln for ln in lines), show(lines))
        check("1. カーソルとセッション名の間に余分な空白が無い",
              any(ln.startswith(f"▶ {SESSIONS[0]}") for ln in lines), show(lines))
        expect_initial = [SESSIONS[0], SESSIONS[1], PLUGIN_NAME, SESSIONS[2]]
        got_initial = [row_index(lines, n) for n in expect_initial]
        check("1. 初期の並びは サーバ順 + プラグインが親の直下",
              got_initial == sorted(got_initial) and -1 not in got_initial,
              f"{expect_initial} -> {got_initial}: {show(lines)}")

        # ─── 2. 一覧では独自メニュー項目が登録される ────────────────
        check("2. セッション一覧に独自メニュー項目が登録される", lens.menu == [MENU_ITEM],
              f"menu={lens.menu}")

        # ─── 3. メニューから ★ を付ける → 先頭へ ────────────────────
        print("\n[メニューから ★ を付ける]")
        # カーソルは alpha (seed の session)。charlie (行 index 3) まで下げる
        for _ in range(3):
            send_input("down")
        lines, footer = lens.settle(1.2)
        check("3. 前提: カーソルが charlie の行にある", footer.endswith("(4/4)"),
              f"footer={footer!r} {show(lines)}")

        # 素の長押しだけでは何も起きない (OS メニューと二重に作用しない)
        long_press()
        lines_lp, footer_lp = lens.settle(1.2)
        check("6. 素の長押しだけでは ★ が動かない (OS メニューと二重作用しない)",
              all(STAR not in ln for ln in lines_lp) and "favorite " not in console_text(),
              f"{show(lines_lp)}")
        # 「届いていないから動かない」ではなく「届いた上で何もしていない」ことの確認。
        # 振り分けから漏れていれば events.ts が UNHANDLED を吐く。
        # = menuObject を登録した状態でも素の長押しはアプリまで来る → 独自動作を
        #   割り当てれば OS メニューと必ず二重に作用する、の根拠。
        check("6. 長押しイベント自体はアプリに届いている (取りこぼしではない)",
              "UNHANDLED" not in console_text(),
              [ln for ln in console_text().split("\n") if "UNHANDLED" in ln][:2])

        stub.push(f"menu:{MENU_ID}")
        lines, footer = lens.settle(1.5)
        print(f"    メニュー選択後: {show(lines)}  footer={footer!r}")
        check("3. 何が起きたかをフッタに出す", "★" in footer and SESSIONS[2] in footer,
              f"footer={footer!r}")
        check("3. charlie に ★ が付く", any(STAR in ln and SESSIONS[2] in ln for ln in lines), show(lines))
        check("3. ★ 付きが一覧の先頭に来る", row_index(lines, SESSIONS[2]) == 0, show(lines))
        check("3. ★ はカーソル記号の直後に詰めて置く (★ と名前の間も空けない)",
              any(ln.startswith(f"▶ {STAR}{SESSIONS[2]} ") for ln in lines), show(lines))
        check("3. ★ 無しの行には詰め物を入れない (機能導入前と同じ見た目)",
              all(STAR_PAD not in ln for ln in lines)
              and any(ln.startswith(f"  {SESSIONS[0]} ") for ln in lines), show(lines))
        check("3. ★ 以外の並びは崩れない (alpha, bravo, └devsite の順)",
              [row_index(lines, n) for n in [SESSIONS[0], SESSIONS[1], PLUGIN_NAME]] == [1, 2, 3],
              show(lines))
        check("3. ★ の付け外しではページを組み直さない (メニューは変わらないので差分更新のまま)",
              lens.menu == [MENU_ITEM], f"menu={lens.menu}")

        lines, footer = lens.wait_counter()
        check("3. カーソルは同じ行に付いていく (飛ばない)", footer.endswith("(1/4)"),
              f"footer={footer!r} {show(lines)}")

        # ─── 4 + 7. もう一度選んで解除。メニュー操作直後のタップは無視 ───
        print("\n[メニューから ★ を外す / 直後のタップ抑制]")
        menu_click()
        api("/api/input", {"action": "click"})   # メニューを閉じた勢いのタップ
        lines, footer = lens.settle(1.5)
        print(f"    解除後: {show(lines)}  footer={footer!r}")
        check("4. 解除もフッタで知らせる", "★" in footer and SESSIONS[2] in footer, f"footer={footer!r}")
        check("4. ★ が消える", all(STAR not in ln for ln in lines), show(lines))
        check("4. 解除後も詰め物は残らない", all(STAR_PAD not in ln for ln in lines), show(lines))
        check("4. 元の並びに戻る",
              [row_index(lines, n) for n in expect_initial] == [0, 1, 2, 3], show(lines))
        check("7. メニュー操作直後のタップでセッションが開かない (rootlist のまま)",
              "phase=idle" not in console_text(), "click が通ってセッションが開いてしまった")
        check("4. 1 回のメニュー選択で 1 回だけトグルされる",
              console_text().count("favorite off: charlie") == 1,
              f'favorite off の回数={console_text().count("favorite off: charlie")}')

        lines, footer = lens.wait_counter()
        check("4. カーソルは charlie に付いたまま", footer.endswith("(4/4)"),
              f"footer={footer!r} {show(lines)}")

        # ─── 5. プラグイン行にカーソル → 親セッションに作用 ─────────────
        print("\n[プラグイン行でメニューを使う]")
        # charlie(4/4) から 1 つ上げて プラグイン行 devsite(3/4) へ
        send_input("up")
        lines, footer = lens.settle(1.2)
        plugin_rows = [ln for ln in lines if PLUGIN_NAME in ln]
        check("5. 前提: カーソルがプラグイン行 (└ devsite) にある",
              footer.endswith("(3/4)") and bool(plugin_rows) and "▶" in plugin_rows[0],
              f"footer={footer!r} {show(lines)}")

        menu_click()
        lines, footer = lens.settle(1.5)
        print(f"    メニュー選択後: {show(lines)}  footer={footer!r}")
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

        # ─── 8. セッションを開いた画面でも同じメニューで切り替えられる ──
        print("\n[セッションを開いた画面でのお気に入り]")
        send_input("up")   # プラグイン行(2/4) -> bravo(1/4)
        lens.settle(1.0)
        rebuilds_before = len(lens.menu_log)
        send_input("click")   # セッションを開く -> phase=idle
        opened = wait_console("phase=idle", 20)
        check("8. 前提: セッションを開けた (chat 画面)", opened)
        lens.settle(2.0)
        check("8. セッションを開いた画面にも独自メニューが載っている",
              lens.menu == [MENU_ITEM], f"menu={lens.menu}")
        check("8. 一覧⇄セッションの遷移でページを組み直さない (差分更新のまま)",
              len(lens.menu_log) == rebuilds_before,
              f"menu 付きの再構築が {len(lens.menu_log) - rebuilds_before} 回増えた")

        # ヘッダにも ★ が出る (bravo は ★ 付きのまま開いた)
        check("9. ★ 付きセッションを開くとヘッダに ★ が出る",
              lens.header == f"{STAR}{SESSIONS[1]}", f"header={lens.header!r}")

        # 開いたまま解除 → ヘッダから ★ が消える
        menu_click()
        lines, footer = lens.settle(1.5)
        print(f"    解除後: header={lens.header!r} footer={footer!r}")
        check("8. 開いている画面でも ★ を外せる (作用先は開いているセッション)",
              "★" in footer and SESSIONS[1] in footer, f"footer={footer!r}")
        check("9. 外すとヘッダの ★ も消える",
              lens.header == SESSIONS[1], f"header={lens.header!r}")

        # もう一度付け直す (この後の再起動テストで ★ が残っていることを見るため)
        menu_click()
        lens.settle(1.5)
        print(f"    再付与後: header={lens.header!r}")
        check("8. 開いている画面で付け直せる",
              lens.header == f"{STAR}{SESSIONS[1]}", f"header={lens.header!r}")

        send_input("double_click")   # idle -> rootlist へ戻る
        back = wait_console("phase=rootlist, force=true", 20)
        lines, footer = lens.settle(2.0)
        check("8. 一覧へ戻ってもメニューは載ったまま", lens.menu == [MENU_ITEM],
              f"back={back} menu={lens.menu}")
        check("8. 開いている画面での操作が一覧にも反映されている",
              row_index(lines, SESSIONS[1]) == 0
              and any(STAR in ln and SESSIONS[1] in ln for ln in lines), show(lines))

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
        httpd.server_close()
        # npm run dev も xvfb-run も「自分の子」として本体を起こすので、親だけ
        # terminate すると vite / simulator が生き残る。残ると次回の実行がその
        # 残骸に繋がって検証にならないため、プロセスグループごと落とす
        # (Popen は start_new_session=True で起動している)。
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
