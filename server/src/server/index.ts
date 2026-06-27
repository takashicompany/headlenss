import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { WebSocketServer } from 'ws';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, freemem, loadavg, tmpdir, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { captureOutput, createSession, getSessionCwd, killSession, listSessions, renameSession, sendKey, sendKeys } from './tmux.ts';
import { handlePtyConnection } from './pty.ts';
import { getBackendName, isAsrReady, transcribePcm16, transcribeWav } from './asr/index.ts';
import { claudeRouter } from './claude/router.ts';
import { codexRouter } from './codex/router.ts';
import { detectCodexSessions, getCodexHookHealth } from './codex/status.ts';
import { detectClaudeSessions } from './claude/process-detect.ts';
import * as claudeStore from './claude/store.ts';
import { restoreSessions, saveSnapshot, startPeriodicSnapshot } from './persist.ts';
import { getRetainedSession, hasRetainedSession, listRetainedSessions, removeRetainedSession, renameRetainedSession, retainSession } from './retained-sessions.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(__dirname, '../../dist/web');

const PORT = Number(process.env.PORT ?? 3000);
// デフォルトはローカル限定 (127.0.0.1)。LAN/Tailscale 等から触らせるときだけ
// 環境変数で明示的に `HOST=0.0.0.0` (もしくは特定 IP) を指定する。
// 認証は無いので、開放するときは ALLOWED_ORIGINS と組み合わせて Origin で守ること。
const HOST = process.env.HOST ?? '127.0.0.1';

/**
 * 許可する Origin リスト。`.env` の `ALLOWED_ORIGINS` から CSV で受ける。
 * - 未指定 → デフォルトで `*` (全 origin 許可)。普通に動かしたい人向けの opt-out 設計。
 * - `*` を含む値 → wildcard 扱いで全 origin 許可。
 * - 具体的な origin を列挙 → その origin だけ許可 (= CSRF 対策として絞りたい人向け)。
 */
function parseAllowedOrigins(): string[] {
  const raw = (process.env.ALLOWED_ORIGINS ?? '').trim();
  if (!raw) return ['*'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const ALLOWED_ORIGINS = parseAllowedOrigins();
const ALLOW_ALL_ORIGINS = ALLOWED_ORIGINS.includes('*');

function isOriginAllowed(origin: string | undefined | null): boolean {
  if (ALLOW_ALL_ORIGINS) return true;
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

const app = new Hono();

// Origin が allowlist 外なら early-return 403。
// hono/cors だけだと「ACAO ヘッダを付けない」だけで body は処理されてしまうため、
// `Content-Type: text/plain` の単純リクエストで preflight をスキップする CSRF が成立する。
// `*` 指定時 (デフォルト含む) は全許可なのでこの早期 return は走らない。
// Origin が無いリクエスト (curl, Claude Code hook plugin の HTTP 呼び出し等) はそのまま通す。
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && !isOriginAllowed(origin)) {
    return c.json({ error: 'forbidden: origin not allowed' }, 403);
  }
  await next();
});
// hono/cors は `origin: '*'` で wildcard、 string[] でリスト指定の両対応。
app.use('/api/*', cors({ origin: ALLOW_ALL_ORIGINS ? '*' : ALLOWED_ORIGINS }));

app.get('/api/health', (c) => c.json({ ok: true }));

let lastCpuSample: { idle: number; total: number } | null = null;

function readCpuSample(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

function readSystemStatus(): {
  cpuPercent: number | null;
  loadAverage: number[];
  memory: { total: number; free: number; used: number; usedPercent: number };
} {
  const sample = readCpuSample();
  let cpuPercent: number | null = null;
  if (lastCpuSample) {
    const idleDelta = sample.idle - lastCpuSample.idle;
    const totalDelta = sample.total - lastCpuSample.total;
    if (totalDelta > 0) cpuPercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
  }
  lastCpuSample = sample;
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  return {
    cpuPercent,
    loadAverage: loadavg(),
    memory: {
      total,
      free,
      used,
      usedPercent: total > 0 ? (used / total) * 100 : 0,
    },
  };
}

app.get('/api/system/status', (c) => c.json(readSystemStatus()));

app.get('/api/sessions', async (c) => {
  const [sessions, detected, codexDetected] = await Promise.all([
    listSessions(),
    detectClaudeSessions().catch(() => []),
    detectCodexSessions().catch(() => []),
  ]);
  const detectedMap = new Map(detected.map((d) => [d.tmuxSessionName, d]));
  const codexMap = new Map(codexDetected.map((d) => [d.tmuxSessionName, d]));
  const liveNames = new Set(sessions.map((s) => s.name));
  const enriched = sessions.map((s) => {
    const tracked = claudeStore.getSession(s.name);
    const agent = tracked?.source ?? (codexMap.has(s.name) ? 'codex' : detectedMap.has(s.name) ? 'claude' : undefined);
    return {
      ...s,
      claudeStatus: tracked?.source === 'claude' ? tracked.status : detectedMap.get(s.name)?.status,
      agent,
      codexStatus: tracked?.source === 'codex' ? tracked.status : codexMap.get(s.name)?.status,
      codexHookHealth: codexMap.get(s.name)?.hookHealth ?? (agent === 'codex' ? getCodexHookHealth(tracked?.cwd) : getCodexHookHealth()),
      codexNeedsHookAttention: codexMap.get(s.name)?.needsHookAttention ?? false,
    };
  });
  for (const retained of listRetainedSessions(liveNames)) {
    enriched.push({
      ...retained,
      claudeStatus: undefined,
      agent: retained.agent,
      codexStatus: undefined,
      codexHookHealth: retained.agent === 'codex' ? getCodexHookHealth() : getCodexHookHealth(),
      codexNeedsHookAttention: false,
    });
  }
  return c.json({ sessions: enriched });
});

app.post('/api/sessions', async (c) => {
  const body = await c.req.json<{ name?: string; cwd?: string; startClaude?: boolean; startCodex?: boolean }>();
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  try {
    const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined;
    removeRetainedSession(body.name);
    await createSession(body.name, {
      cwd,
      startClaude: body.startClaude === true,
      startCodex: body.startCodex === true,
    });
    const source = body.startCodex === true ? 'codex' : body.startClaude === true ? 'claude' : undefined;
    if (source) {
      claudeStore.upsertSession({
        ccSessionId: 'web-' + randomUUID(),
        tmuxPane: body.name,
        tmuxSessionName: body.name,
        cwd: cwd ?? process.cwd(),
        source,
      });
    }
    // 直近の tmux 状態をスナップショットに反映 (再起動越しの復元に効く)
    void saveSnapshot();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.patch('/api/sessions/:name', async (c) => {
  const name = c.req.param('name');
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const nextName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!nextName) return c.json({ error: 'name is required' }, 400);
  try {
    const live = (await listSessions()).some((s) => s.name === name);
    const nextExists = (await listSessions()).some((s) => s.name === nextName) || hasRetainedSession(nextName);
    if (nextExists) throw new Error('session name already exists');
    if (live) {
      await renameSession(name, nextName);
    } else {
      renameRetainedSession(name, nextName);
    }
    const tracked = claudeStore.getSession(name);
    if (tracked) {
      claudeStore.removeSession(name);
      claudeStore.upsertSession({
        ccSessionId: tracked.ccSessionId,
        tmuxPane: tracked.tmuxPane,
        tmuxSessionName: nextName,
        cwd: tracked.cwd,
        source: tracked.source,
        transcriptPath: tracked.transcriptPath,
      });
    }
    void saveSnapshot();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post('/api/sessions/:name/release', async (c) => {
  const name = c.req.param('name');
  try {
    const sessions = await listSessions();
    const live = sessions.find((s) => s.name === name);
    if (!live) return c.json({ error: 'tmux session not found' }, 404);
    const tracked = claudeStore.getSession(name);
    const cwd = await getSessionCwd(name);
    retainSession({ ...live, cwd: cwd ?? tracked?.cwd ?? process.cwd(), agent: tracked?.source });
    await killSession(name);
    claudeStore.removeSession(name);
    void saveSnapshot();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post('/api/sessions/:name/mount', async (c) => {
  const name = c.req.param('name');
  try {
    const retained = getRetainedSession(name);
    if (!retained) return c.json({ error: 'retained session not found' }, 404);
    const live = (await listSessions()).some((s) => s.name === name);
    if (!live) {
      await createSession(name, {
        cwd: retained.cwd,
        startClaude: retained.agent === 'claude',
        startCodex: retained.agent === 'codex',
      });
    }
    removeRetainedSession(name);
    if (retained.agent) {
      claudeStore.upsertSession({
        ccSessionId: 'web-' + randomUUID(),
        tmuxPane: name,
        tmuxSessionName: name,
        cwd: retained.cwd,
        source: retained.agent,
      });
    }
    void saveSnapshot();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.delete('/api/sessions/:name', async (c) => {
  const name = c.req.param('name');
  try {
    const live = (await listSessions()).some((s) => s.name === name);
    if (live) await killSession(name);
    removeRetainedSession(name);
    // hook 経由で記録された Claude セッションエントリも合わせて削除する。
    // これをやらないと /api/claude/sessions に死んだ tmux セッションが残り続ける。
    claudeStore.removeSession(name);
    void saveSnapshot();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.get('/api/sessions/:name/output', async (c) => {
  const name = c.req.param('name');
  const lines = Number(c.req.query('lines') ?? 24);
  try {
    const text = await captureOutput(name, Number.isFinite(lines) ? lines : 24);
    return c.json({ text });
  } catch (e) {
    const msg = (e as Error).message;
    const status =
      msg.includes("can't find session") || msg.includes('no server running') ? 404 : 400;
    return c.json({ error: msg }, status);
  }
});

app.post('/api/sessions/:name/input', async (c) => {
  const name = c.req.param('name');
  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; submit?: unknown };
  if (typeof body.text !== 'string') {
    return c.json({ error: 'body must be { "text": string, "submit"?: boolean }' }, 400);
  }
  try {
    const tracked = claudeStore.getSession(name);
    const pane = body.submit === true ? await captureOutput(name, 120).catch(() => '') : '';
    const isCodex = body.submit === true && (
      tracked?.source === 'codex' ||
      /\bOpenAI Codex\b|\bCodex CLI\b|approval policy|Auto Review/i.test(pane) ||
      (await detectCodexSessions()).some((session) => session.tmuxSessionName === name)
    );
    if (body.submit === true && isCodex) {
      const visiblePaneTail = pane.slice(-3000);
      const shouldQueueInCodex = /esc to interrupt/i.test(visiblePaneTail);
      await sendKeys(name, body.text, false);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await sendKey(name, shouldQueueInCodex ? 'Tab' : 'Enter');
      return c.json({ ok: true, queued: shouldQueueInCodex });
    }
    await sendKeys(name, body.text, body.submit === true);
    return c.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    const status =
      msg.includes("can't find session") || msg.includes('no server running') ? 404 : 400;
    return c.json({ error: msg }, status);
  }
});

app.route('/api', claudeRouter);
app.route('/api', codexRouter);

// ───────── 画像アップロード (Web UI → Claude Code) ─────────
//
// 来たバイナリを tmp に保存して path を返すだけ。形式チェックや圧縮は Claude Code 側に任せる。
// (拡張子は Content-Type / X-Filename ヘッダから決める。不明なら .bin)
const UPLOAD_DIR = resolve(tmpdir(), 'headlenss-uploads');
const UPLOAD_TTL_MS = 60 * 60 * 1000;

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

async function ensureUploadDir(): Promise<void> {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

async function cleanupOldUploads(): Promise<void> {
  try {
    const files = await readdir(UPLOAD_DIR);
    const now = Date.now();
    for (const f of files) {
      try {
        const p = resolve(UPLOAD_DIR, f);
        const s = await stat(p);
        if (now - s.mtimeMs > UPLOAD_TTL_MS) await unlink(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

ensureUploadDir().catch(() => { /* ignore */ });
setInterval(() => { void cleanupOldUploads(); }, 30 * 60 * 1000);

app.post('/api/uploads', async (c) => {
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.length === 0) return c.json({ error: 'empty body' }, 400);
  const ct = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  // 拡張子の決定優先順: Content-Type → X-Filename ヘッダ → 'bin'
  let ext = MIME_TO_EXT[ct] ?? '';
  if (!ext) {
    const fn = c.req.header('x-filename') ?? '';
    const m = fn.match(/\.([a-zA-Z0-9]{1,8})$/);
    if (m) ext = m[1].toLowerCase();
  }
  if (!ext) ext = 'bin';
  await ensureUploadDir();
  const filename = `${Date.now()}-${randomUUID()}.${ext}`;
  const path = resolve(UPLOAD_DIR, filename);
  await writeFile(path, buf);
  return c.json({ path, bytes: buf.length });
});

// アップロード済画像の配信 (chat UI で `@/tmp/headlenss-uploads/...` を
// インライン画像表示するために必要)。
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

app.get('/api/uploads/:filename', (c) => {
  const filename = c.req.param('filename');
  // path traversal 防止: filename は単一パス要素のみ許可
  if (!/^[a-zA-Z0-9._-]+$/.test(filename) || filename.startsWith('.') || filename.includes('..')) {
    return c.json({ error: 'invalid filename' }, 400);
  }
  const path = resolve(UPLOAD_DIR, filename);
  if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
  const buf = readFileSync(path);
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  c.header('Content-Type', EXT_TO_MIME[ext] ?? 'application/octet-stream');
  c.header('Cache-Control', 'private, max-age=3600');
  return c.body(new Uint8Array(buf));
});

// .ehpk ダウンロード (G2 アプリ install 用)
const EVEN_DIR = resolve(__dirname, '../../../even');

/** even/ 配下から最新の headlenss[-x.y.z].ehpk を見つける (バージョンの semver 降順、なければ mtime 降順) */
function findLatestEhpk(): { name: string; path: string } | null {
  const candidates: Array<{ name: string; path: string; version: string | null; mtime: number }> = [];
  try {
    for (const f of readdirSync(EVEN_DIR)) {
      if (!/^headlenss(-[\d.]+)?\.ehpk$/i.test(f)) continue;
      const path = resolve(EVEN_DIR, f);
      const m = f.match(/^headlenss-([\d.]+)\.ehpk$/i);
      const version = m ? m[1] : null;
      candidates.push({ name: f, path, version, mtime: statSync(path).mtimeMs });
    }
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.version && b.version) return cmpSemver(b.version, a.version);
    if (a.version) return -1;
    if (b.version) return 1;
    return b.mtime - a.mtime;
  });
  const top = candidates[0];
  return { name: top.name, path: top.path };
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

app.get('/download/ehpk', (c) => {
  const latest = findLatestEhpk();
  if (!latest) {
    return c.json({ error: 'no .ehpk found in even/. run: cd even && npm run pack' }, 404);
  }
  const buf = readFileSync(latest.path);
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${latest.name}"`);
  c.header('Content-Length', String(buf.byteLength));
  return c.body(new Uint8Array(buf));
});

app.get('/api/asr/status', (c) => c.json({ backend: getBackendName(), ...isAsrReady() }));

app.post('/api/asr', async (c) => {
  const ready = isAsrReady();
  if (!ready.ok) return c.json({ error: ready.reason }, 503);

  const ct = (c.req.header('content-type') ?? 'application/octet-stream').toLowerCase();
  const lang = c.req.query('lang') || undefined;
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.length === 0) return c.json({ error: 'empty body' }, 400);

  try {
    let result;
    if (ct.startsWith('audio/wav') || ct.startsWith('audio/x-wav') || ct.startsWith('audio/wave')) {
      result = await transcribeWav(buf, lang);
    } else if (ct.startsWith('audio/l16') || ct.startsWith('audio/pcm') || ct === 'application/octet-stream') {
      result = await transcribePcm16(buf, lang);
    } else {
      return c.json({ error: `unsupported content-type: ${ct}. use audio/wav or audio/l16` }, 415);
    }
    return c.json(result);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

if (existsSync(WEB_DIST)) {
  const indexHtml = readFileSync(resolve(WEB_DIST, 'index.html'), 'utf-8');
  app.use('/*', serveStatic({ root: WEB_DIST }));
  app.get('/*', (c) => c.html(indexHtml));
} else {
  app.get('/', (c) =>
    c.text(
      'headlenss server is running, but the web UI has not been built yet.\n' +
        'Run `npm run build` to build the UI, or `npm run dev` for development mode.\n',
    ),
  );
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const host = info.address === '0.0.0.0' || info.address === '::' ? 'localhost' : info.address;
  console.log(`headlenss server listening:`);
  console.log(`  local:    http://${host}:${info.port}`);
  console.log(`  bound to: ${info.address}:${info.port}`);
  console.log(`  allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  // bind が外向き (0.0.0.0 / :: / 100.x 等) のときは「認証なし + 他端末から見える」状態の
  // 警告を出す。allowlist で守ってはいるが、ユーザがそれに気付かず公開していたら危ない。
  if (info.address === '0.0.0.0' || info.address === '::') {
    console.log(`  ⚠  HOST=${info.address} で listen 中: LAN/Tailscale 内の他端末から見えます。`);
    console.log(`     認証は無いため、ALLOWED_ORIGINS を必ず設定するか、`);
    console.log(`     Tailscale ACL / ファイアウォール で接続元を絞ってください。`);
  }
  if (!existsSync(WEB_DIST)) {
    console.log(`\nweb UI not built. run \`npm run build\` (or use \`npm run dev\`).`);
  }
  // バックグラウンドで前回スナップショットを復元 → 定期スナップショットを開始。
  // serve コールバックをブロックしたくないので fire-and-forget。
  void (async () => {
    try {
      await restoreSessions();
    } catch (e) {
      console.warn(`[persist] restoreSessions threw: ${(e as Error).message}`);
    }
    startPeriodicSnapshot();
  })();
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const m = (req.url ?? '').match(/^\/api\/sessions\/([^/?#]+)\/pty/);
  if (!m) {
    socket.destroy();
    return;
  }
  // WebSocket は CORS が効かないので、Origin を allowlist で検証して弾く。
  // ブラウザ以外 (curl 等) で Origin 無しの接続も拒否する側に倒す
  // (G2 アプリは HTTP しか使わないので影響なし、xterm.js は Web UI から
  //  同一 origin で開かれるので許可される)。
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin)) {
    socket.destroy();
    return;
  }
  const name = decodeURIComponent(m[1]);
  wss.handleUpgrade(req, socket, head, (ws) => handlePtyConnection(ws, name));
});
