#!/usr/bin/env python3
"""長い会話を積んだ状態でヘッダ点滅の周期 (750ms) が保たれるかを実測する。

なぜ点滅周期で測るか: 点滅は「1.5 秒ごとのポーリング → 表示フレーム」「その 750ms 後に
非表示フレーム」という決まった間隔で送信が出る。整形が重くてメインスレッドが止まると
この間隔がそのまま伸びるので、外から見える一番素直な物差しになる。

ポートは 5177 / 6177 / 3000 を避ける。tmux にも本番サーバにも触らない。
使い方:
  python3 measure_chat_blink.py --even <even ディレクトリ> [--base-port 5341] [--window 40]
"""
import argparse, collections, json, os, re, signal, socket, subprocess, sys, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SESSION = "chatload"

ap = argparse.ArgumentParser()
ap.add_argument("--even", required=True, help="even/ ディレクトリ")
ap.add_argument("--base-port", type=int, default=5341)
ap.add_argument("--window", type=float, default=40.0, help="1 条件あたりの計測秒数")
ap.add_argument("--chars", default="0,2500,5000", help="1 メッセージあたりの文字数 (カンマ区切り)")
ap.add_argument("--label", default="")
args = ap.parse_args()

EVEN = Path(args.even).resolve()
SIMULATOR = EVEN / "node_modules/@evenrealities/evenhub-simulator/bin/index.js"
APP_PORT = args.base_port
AUTOMATION_PORT = args.base_port + 4590
STUB_PORT = args.base_port + 3500


class Stub:
    def __init__(self):
        self.lock = threading.Lock(); self.mode = "none"; self.chars = 0
    def set(self, m):
        with self.lock: self.mode = m
    def snap(self):
        with self.lock: return self.mode
    def session(self):
        m = self.snap(); now = int(time.time() * 1000)
        s = {"tmuxSessionName": SESSION, "cwd": "/tmp/chatload", "status": "idle",
             "startedAt": now - 60000, "lastSeenAt": now, "source": "claude", "lastChat": "stub"}
        if m in ("question", "both"): s["status"] = "waiting-question"
        elif m == "permission": s["status"] = "waiting-permission"
        if m in ("blocked", "both"): s["screenBlocked"] = True
        return s
    def pending(self):
        m = self.snap(); now = int(time.time() * 1000)
        if m in ("question", "both"):
            return {"id": "pending-q-1", "kind": "question", "hookEvent": "PreToolUse",
                    "toolName": "AskUserQuestion", "toolInput": {},
                    "questions": [{"question": "どちらにしますか", "header": "選択", "multiSelect": False,
                                   "options": [{"label": "A", "description": "案 A"},
                                               {"label": "B", "description": "案 B"}]}],
                    "createdAt": now - 5000}
        return None
    def chat(self):
        m = self.snap(); now = int(time.time() * 1000)
        st = "waiting-question" if m in ("question", "both") else "idle"
        per = self.chars
        if per <= 0:
            items = [{"role": "user", "text": "こんにちは", "ts": now - 20000},
                     {"role": "assistant", "text": "はい、なんでしょう", "ts": now - 19000}]
        else:
            JA = "レンズへの送信は直列化されており、待機枠は最新の1件だけを保持する。"
            EN = "The pump serializes bridge sends so at most one frame is in flight. "
            def body(n, seed):
                b = ""
                while len(b) < n: b += (JA if (len(b) // 200) % 2 == 0 else EN)
                return f"[{seed}] " + b[:n]
            items = []
            for i in range(20):
                # 末尾だけ毎回変える (エージェントの出力が伸びている状況の再現)
                seed = str(int(time.time() * 1000)) if i == 19 else str(i)
                items.append({"role": "user" if i % 2 else "assistant", "text": body(per, seed), "ts": now - 20000 + i * 100})
        return {"chat": items, "source": "claude", "status": st}


stub = Stub()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def _s(self, o, c=200):
        b = json.dumps(o).encode(); self.send_response(c)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS"); self.end_headers(); self.wfile.write(b)
    def do_OPTIONS(self): self._s({})
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/api/health": return self._s({"ok": True})
        if p == "/api/sessions":
            return self._s({"sessions": [{"name": SESSION, "created": int(time.time()) - 60, "windows": 1, "attached": False}]})
        if p == "/api/claude/sessions": return self._s({"sessions": [stub.session()]})
        if p == f"/api/claude/sessions/{SESSION}/chat": return self._s(stub.chat())
        if p == f"/api/claude/sessions/{SESSION}/pending": return self._s({"pending": stub.pending()})
        if p.startswith("/chars/"):
            stub.chars = int(p.rsplit("/", 1)[-1]); return self._s({"chars": stub.chars})
        if p.startswith("/ctl/"): stub.set(p.rsplit("/", 1)[-1]); return self._s({"mode": stub.snap()})
        self._s({"error": "nf", "path": p}, 404)


def port_open(p):
    with socket.socket() as s:
        s.settimeout(0.5); return s.connect_ex(("127.0.0.1", p)) == 0
def wait_port(p, proc, label, tries=300):
    for _ in range(tries):
        if port_open(p): return
        if proc and proc.poll() is not None: raise RuntimeError(f"{label} rc={proc.returncode}")
        time.sleep(0.25)
    raise RuntimeError(f"{label} not up on {p}")
def api(path, payload=None, method=None):
    url = f"http://127.0.0.1:{AUTOMATION_PORT}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"} if data else {}, method=method)
    with urllib.request.urlopen(req, timeout=15) as r: return r.read()
def entries(since=None):
    try:
        raw = api(f"/api/console?since_id={since}" if since is not None else "/api/console").decode("utf-8", "replace")
        return json.loads(raw).get("entries", [])
    except Exception: return []
def ctl(m):
    with urllib.request.urlopen(f"http://127.0.0.1:{STUB_PORT}/ctl/{m}", timeout=5) as r: r.read()
def chars(n):
    with urllib.request.urlopen(f"http://127.0.0.1:{STUB_PORT}/chars/{n}", timeout=5) as r: r.read()
def wait_console(sub, t=60):
    d = time.time() + t
    while time.time() < d:
        if any(sub in str(e.get("message", "")) for e in entries()): return True
        time.sleep(0.4)
    return False


HDR = re.compile(r'\[refreshG2\] firing \(phase=([\w-]+), force=\w+\) header="(.*)"$')
results = []


def jitter(label, seconds):
    base = entries(); last = max([e.get("id", -1) for e in base], default=-1)
    t0 = time.time(); time.sleep(seconds)
    new = [e for e in entries(last) if e.get("id", -1) > last]
    dt = time.time() - t0
    ts = [e.get("ts", 0) / 1000.0 for e in new if HDR.search(str(e.get("message", "")))]
    gaps = [round((b - a) * 1000) for a, b in zip(ts, ts[1:])]
    print(f"\n=== {label} ({dt:.0f}s) ===")
    print(f"   ヘッダ送信 {len(ts)} 回 / 期待 {int(seconds / 0.75)} 回前後")
    row = {"label": label, "n": len(ts), "expected": int(seconds / 0.75)}
    if gaps:
        g = sorted(gaps)
        off = sum(1 for x in gaps if abs(x - 750) > 200)
        print(f"   送信間隔 ms: 最小={g[0]} 中央={g[len(g)//2]} 最大={g[-1]} 平均={sum(gaps)/len(gaps):.0f}")
        print(f"   750ms から +-200ms 以上ずれた回数: {off} / {len(gaps)}")
        row.update(min=g[0], med=g[len(g)//2], max=g[-1], avg=round(sum(gaps)/len(gaps)), off=off, gaps=len(gaps))
    else:
        print("   ヘッダ送信なし (= 描画周期が破綻)")
        row.update(min=None, med=None, max=None, avg=None, off=None, gaps=0)
    results.append(row)


def main():
    procs = []
    httpd = ThreadingHTTPServer(("127.0.0.1", STUB_PORT), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        if port_open(APP_PORT) or port_open(AUTOMATION_PORT):
            raise RuntimeError(f"ポート {APP_PORT}/{AUTOMATION_PORT} が使用中 (前の実行が残っている)")
        procs.append(subprocess.Popen(
            ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(APP_PORT), "--strictPort"],
            cwd=EVEN, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True))
        wait_port(APP_PORT, procs[-1], "vite")
        seed = (f"http://127.0.0.1:{APP_PORT}/e2e-seed.html?server=http://127.0.0.1:{STUB_PORT}"
                f"&session={SESSION}&lang=ja")
        sim = subprocess.Popen(["xvfb-run", "-a", "node", str(SIMULATOR), seed, "--automation-port", str(AUTOMATION_PORT)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        procs.append(sim); wait_port(AUTOMATION_PORT, sim, "sim"); api("/api/ping")
        if not wait_console("G2 lens rendered (phase=rootlist)", 60): raise RuntimeError("boot failed")
        print(f"boot OK ({args.label or EVEN})")
        time.sleep(1.5)
        api("/api/input", {"action": "click"})
        if not wait_console("phase=idle", 20): print("WARN: idle 未確認")
        time.sleep(2.0)
        ctl("question")
        for per in [int(x) for x in args.chars.split(",")]:
            chars(per); time.sleep(5.0)
            jitter(f"1メッセージ {per} 文字 x20件 = {per*20/1024:.0f}KB" if per else "短いチャット (基準)", args.window)
        print("\nJSON " + json.dumps({"label": args.label, "rows": results}, ensure_ascii=False))
    finally:
        # プロセスグループごと落とす。npm / xvfb-run は子を残すので terminate だけだと
        # dev server が生き残り、次の実行が「前の実行のアプリ」に繋がってしまう。
        for p in procs:
            try: os.killpg(os.getpgid(p.pid), signal.SIGTERM)
            except Exception: pass
        time.sleep(1.5)
        for p in procs:
            try: os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except Exception: pass
        for _ in range(40):
            if not (port_open(APP_PORT) or port_open(AUTOMATION_PORT)): break
            time.sleep(0.5)
        else:
            print(f"WARN: ポート {APP_PORT}/{AUTOMATION_PORT} が解放されていません")
        httpd.shutdown()
    return 0


sys.exit(main())
