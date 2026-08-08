#!/usr/bin/env python3
"""E2E: headlenss のセッション一覧から G2 プラグインを開き、戻ってくる検証。

公式シミュレータ (evenhub-simulator / xvfb) で以下を通しで確認する:

  1. headlenss が起動し、レンズにセッション一覧が出る
  2. 一覧にプラグイン行 (└ Greensky) がぶら下がる
  3. スクロールでプラグイン行にカーソルを合わせられる
  4. タップで遷移し、実際に greensky が開く
  5. ダブルタップでシムが横取りし、headlenss に戻る

greensky は無改変のまま、dev server (5173) を直接指す。

前提 (起動していなければ失敗する):
  - headlenss サーバ (3000)
  - greensky dev server (5173)
  - greensky の .headlenss-plugins.conf に Greensky = http://127.0.0.1:5173

中継サーバもプラグイン側の改変も使わない。headlenss が対象 HTML を取り込んで
自分のドキュメントを置き換え、戻る機構を自前で仕込む経路を検証する。

実行:
  /home/sato/works/even-hub-uploader/.venv/bin/python even/tools/e2e_plugin_launch.py
"""

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

EVEN = Path(__file__).resolve().parent.parent
SIMULATOR = EVEN / "node_modules/@evenrealities/evenhub-simulator/bin/index.js"
OUT_DIR = Path(os.environ.get("E2E_OUT_DIR", EVEN / "tools" / "e2e-out"))

HEADLENSS_SERVER = "http://127.0.0.1:3000"
APP_PORT = 5188          # このテスト専用の headlenss dev server
AUTOMATION_PORT = 9897
SESSION = "greensky"
PLUGIN_NAME = "Greensky"

results: list[tuple[bool, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((ok, name, detail))
    print(f"  [{'OK' if ok else 'NG'}] {name}" + (f"  ({detail})" if detail else ""))


def port_open(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def wait_port(port: int, proc: subprocess.Popen | None, label: str, tries: int = 200) -> None:
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


def console_text() -> str:
    try:
        return api("/api/console").decode("utf-8", errors="replace")
    except Exception as e:
        return f"<console取得失敗: {e}>"


def wait_console(substr: str, timeout_s: float = 20, count: int = 1) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if console_text().count(substr) >= count:
            return True
        time.sleep(0.5)
    return False


def screenshot(kind: str, name: str) -> None:
    try:
        data = api(f"/api/screenshot/{kind}")
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / name).write_bytes(data)
        print(f"       screenshot: {OUT_DIR / name} ({len(data)}B)")
    except Exception as e:
        print(f"       screenshot {kind} 失敗: {e}")


def preflight() -> bool:
    ok = True
    for port, label in ((3000, "headlenss サーバ"), (5173, "greensky dev")):
        alive = port_open(port)
        check(f"前提: {label} ({port}) が起動している", alive)
        ok = ok and alive
    try:
        with urllib.request.urlopen(f"{HEADLENSS_SERVER}/api/claude/sessions", timeout=10) as r:
            sessions = json.load(r)["sessions"]
        target = next((s for s in sessions if s["tmuxSessionName"] == SESSION), None)
        plugins = (target or {}).get("g2Plugins") or []
        check(
            f"前提: API が {SESSION} のプラグインを返す",
            any(p["name"] == PLUGIN_NAME for p in plugins),
            json.dumps(plugins, ensure_ascii=False),
        )
        ok = ok and bool(plugins)
    except Exception as e:
        check("前提: API が読める", False, str(e))
        ok = False
    return ok


def main() -> int:
    procs: list[subprocess.Popen] = []
    try:
        if not preflight():
            print("\n前提が満たされていないので中断します。")
            return 1

        print("\nheadlenss アプリの dev server を起動中...")
        procs.append(subprocess.Popen(
            ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(APP_PORT), "--strictPort"],
            cwd=EVEN, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        ))
        wait_port(APP_PORT, procs[-1], "headlenss dev server")

        print("シミュレータ起動中 (xvfb-run)...")
        seed = f"http://127.0.0.1:{APP_PORT}/e2e-seed.html?server={HEADLENSS_SERVER}&session={SESSION}"
        sim = subprocess.Popen(
            ["xvfb-run", "-a", "node", str(SIMULATOR), seed, "--automation-port", str(AUTOMATION_PORT)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        procs.append(sim)
        wait_port(AUTOMATION_PORT, sim, "simulator automation API", tries=300)
        api("/api/ping")

        # boot 完了は「レンズ描画完了」で判定する。bridge 接続ログは設定ロード前に
        # 出るため devMode が未反映で console に乗らない。
        booted = wait_console("G2 lens rendered (phase=rootlist)", 60)
        check("1. headlenss が起動し、レンズにセッション一覧が出る", booted)
        time.sleep(2)
        screenshot("glasses", "p1_rootlist.png")
        # 注意: ここで double_click を送ると rootlist では OS 終了ダイアログが出る。
        # seed 直後は既に rootlist なので何もしない。

        # カーソルを下へ送り、プラグイン行に当たるまで進める。
        # 行の内容はカーソル移動ログ (rootlist cursor=...) で判定する
        # (レンズ描画ログは content の 1 行目しか出ないため一覧全体は見えない)。
        moved = False
        rows_seen: list[str] = []
        for i in range(40):
            api("/api/input", {"action": "down"})
            time.sleep(0.35)
            txt = console_text()
            if "rootlist cursor=plugin" in txt:
                moved = True
                break
        for line in console_text().split("rootlist cursor=")[1:]:
            rows_seen.append(line.split('"')[0].strip())
        check("2. 一覧にプラグイン行がぶら下がる", moved,
              f"通過した行: {rows_seen[-8:]}")
        check("3. プラグイン行にカーソルを合わせられる", moved,
              f"{i + 1} 回の移動で到達" if moved else "到達せず")
        screenshot("glasses", "p2_cursor_on_plugin.png")

        # タップ → 遷移
        api("/api/input", {"action": "click"})
        navigating = wait_console("plugin を開きます", 15)
        taken = wait_console("plugin を取り込みます", 20)
        wrapped = wait_console("takeover: EvenAppBridge をラップしました", 30)
        check("4. タップで greensky が開く (取り込み方式)", navigating and taken and wrapped,
              f"open={navigating} takeover={taken} wrapped={wrapped}")
        time.sleep(3)
        screenshot("glasses", "p3_greensky.png")
        screenshot("webview", "p3_greensky_webview.png")

        # ダブルタップ → 復帰
        api("/api/input", {"action": "double_click"})
        intercepted = wait_console("を横取り", 20)
        returned = (
            wait_console("プラグインからの復帰を検出", 25)
            or wait_console("G2 lens rendered (phase=rootlist)", 25, count=2)
        )
        check("5. ダブルタップで headlenss に戻る", intercepted and returned,
              f"intercepted={intercepted} returned={returned}")
        time.sleep(2)
        screenshot("glasses", "p4_back_in_headlenss.png")

        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / "console.txt").write_text(console_text(), encoding="utf-8")
        print(f"\nconsole ログ: {OUT_DIR / 'console.txt'}")

    except Exception as e:
        check("実行", False, f"{type(e).__name__}: {e}")
    finally:
        for p in procs:
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGTERM)
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
