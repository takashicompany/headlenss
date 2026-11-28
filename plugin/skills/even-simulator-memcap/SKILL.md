---
name: even-simulator-memcap
description: Even 公式シミュレータ (evenhub-simulator) を起動する時に必ず使う。シミュレータをメモリ上限付きの箱 (systemd-run --user --scope + MemoryMax) の中で起動し、メモリリークで肥大したシミュレータがマシン全体のメモリを食い尽くして無関係な tmux セッションやエージェントまで道連れにする事故を防ぐ。「シミュレータで確認して」「evenhub-simulator を起動」「xvfb-run でシミュレータを動かす」「E2E ハーネスを書く/直す」「G2 の表示を自動検証する」場面で、コマンドやスクリプトを書く前に読む。
---

# Even シミュレータはメモリ上限付きで起動する

Even 公式シミュレータ (`@evenrealities/evenhub-simulator`) は長時間動かすとメモリリークで
肥大することがある。**シミュレータは必ずメモリ上限付きの箱 (systemd のユーザー scope) の
中で起動する。** 直接起動・xvfb-run 経由の起動、手動でも E2E ハーネスからでも同じ。

このスキルは環境非依存。パス・ポートは例なので、プロジェクトの実際の値に置き換える。

## 1. 原則: 起動コマンドの前に箱を前置する

前置するのはこれだけ:

```
systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=1G --
```

- `MemoryMax=4G` … 物理メモリの上限。シミュレータの通常動作には十分な値
- `MemorySwapMax=1G` … スワップへの逃げ道も制限する (無制限だとスワップで粘って
  マシン全体が重くなる)
- `--unit=<名前>` を付けると箱の名前 (unit 名) を自分で決められる。後で確認・停止するので
  付けておくとよい (同名の箱が動いていると起動に失敗するので、PID などで一意にする)

### シェルから (xvfb-run 経由)

```bash
systemd-run --user --scope --unit=evensim-$$ \
  -p MemoryMax=4G -p MemorySwapMax=1G -- \
  xvfb-run -a node node_modules/@evenrealities/evenhub-simulator/bin/index.js \
  "http://127.0.0.1:5173/" --automation-port 9898
```

### Python の E2E ハーネスから (subprocess.Popen)

既存ハーネス (`even/tools/e2e_*.py`) は
`["xvfb-run", "-a", "node", str(SIMULATOR), seed, "--automation-port", str(AUTOMATION_PORT)]`
の形で起動している。これに箱を前置する:

```python
import os, subprocess

SIM_UNIT = f"evensim-{os.getpid()}"
MEMCAP = ["systemd-run", "--user", "--scope", "--quiet", f"--unit={SIM_UNIT}",
          "-p", "MemoryMax=4G", "-p", "MemorySwapMax=1G", "--"]

sim = subprocess.Popen(
    MEMCAP + ["xvfb-run", "-a", "node", str(SIMULATOR), seed,
              "--automation-port", str(AUTOMATION_PORT)],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
)
```

- `systemd-run --scope` は箱を作った後、そのまま指定コマンドに置き換わる。`sim.pid` は
  従来どおり xvfb-run の PID なので、`os.killpg(sim.pid, ...)` などの後片付けはそのまま使える
- 後片付けで念のため箱ごと止めるなら `systemctl --user stop <unit>.scope`
- `--quiet` は「Running as unit: ...」の表示を消すだけ (付けなくても動作は同じ)

### Node / シェルスクリプトの場合

`spawn("xvfb-run", [...])` なら `spawn("systemd-run", ["--user", "--scope", "-p",
"MemoryMax=4G", "-p", "MemorySwapMax=1G", "--", "xvfb-run", ...])` のように、
コマンドの先頭に同じ引数列を足すだけ。

## 2. 上限に達するとどうなるか

- 箱の中だけでカーネルの OOM 処理が走り、**シミュレータ (箱の中のプロセス) だけが死ぬ**。
  起動したシェルやハーネス、他の tmux セッションは無傷
- 呼び出し側から見ると、起動したプロセスがシグナルで異常終了する。OOM の後 systemd が
  箱ごと停止するため、どのシグナルで終わるかは構成次第 (実測: node 直接起動なら SIGKILL =
  シェルの終了コード 137 / Python の `returncode == -9`、xvfb-run 経由なら SIGTERM =
  `returncode == -15`)。**終了コードの値ではなく「想定外に終了した」ことで判定する。**
  automation API のポートは切断される
- ハーネスはこれを「シミュレータの起動失敗 / 切断」として検知し、**リトライするか、
  エラーとして報告する**。黙って成功扱いにしない。上限を引き上げて回避しない
- 何が起きたかは `journalctl --user -u <unit>.scope` で確認できる。
  `A process of this unit has been killed by the OOM killer.` /
  `Failed with result 'oom-kill'` が出ていれば上限による停止

## 3. なぜ必要か (実際に起きた事故)

2026-11-28、エージェントが起動した evenhub-simulator がメモリリークで実メモリ (RSS)
約 20GB まで肥大し、マシン全体のメモリを枯渇させた。カーネルの OOM キラーがシミュレータを
殺した際、systemd が**シミュレータを起動した tmux ペインの scope ごと**停止し、そのペインの
シェルを SIGKILL した。結果、**シミュレータと無関係な tmux セッション (とその中で動いていた
エージェント) が丸ごと消滅した。**

箱 (専用 scope) に入れておけば、OOM は箱の中で完結し、止まるのはシミュレータの箱だけになる。

## 4. 箱が効いていることを確認する

起動中に unit 名を指定して確認する (`--unit` で決めた名前 + `.scope`):

```bash
systemctl --user show evensim-12345.scope -p MemoryMax -p MemorySwapMax -p MemoryCurrent -p ActiveState
# 期待値:
#   MemoryMax=4294967296        (= 4G)
#   MemorySwapMax=1073741824    (= 1G)
#   MemoryCurrent=<現在の使用量>
#   ActiveState=active
```

`--unit` を付けずに起動した場合は、起動時に出る `Running as unit: run-XXXX.scope` の名前を使う。
動いている箱の一覧は `systemctl --user list-units --type=scope`。

### 上限で本当に止まるかの実測 (任意、数秒で終わる)

```bash
# 上限 256M の箱で 512MB 確保 → 箱の中だけ OOM で殺される (終了コード 137)
systemd-run --user --scope --unit=memcap-test-over-$$ -p MemoryMax=256M -p MemorySwapMax=0 -- \
  node -e 'const a=[];for(let i=0;i<512;i++)a.push(Buffer.alloc(1<<20,1));console.log("allocated")'
echo "exit=$?"          # → exit=137 ("allocated" は出ない)

# 上限内 (64MB) なら正常終了
systemd-run --user --scope --unit=memcap-test-ok-$$ -p MemoryMax=256M -p MemorySwapMax=0 -- \
  node -e 'const a=[];for(let i=0;i<64;i++)a.push(Buffer.alloc(1<<20,1));console.log("allocated")'
echo "exit=$?"          # → allocated / exit=0
```

### systemd-run が使えない環境

`systemctl --user show-environment` が失敗する (ユーザーの systemd / D-Bus に繋がらない
サンドボックス等) 場合、箱は作れない。**その場合は上限なしで起動せず**、
「ユーザー systemd が使えないためシミュレータを安全に起動できない」とユーザーに報告して指示を仰ぐ。

## 5. 禁止事項

- **上限を外してシミュレータを起動しない。** 「ちょっと確認するだけ」でも箱に入れる
- **長時間動かすシミュレータほど必須。** リークは時間とともに積み上がる
  (常駐させる・繰り返しテストを回す・放置する場合は特に)
- OOM で落ちたからといって上限を大きくする / 外すことで回避しない。落ちたこと自体を
  エラーとして報告し、必要なら定期的にシミュレータを再起動する設計にする

## 関連

- シミュレータに読ませる dev server の立て方 → `headlenss-dev-server`
- 開発中プラグインをグラス (実機 G2) で開く → `headlenss-g2-plugin`
