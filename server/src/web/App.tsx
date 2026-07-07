import { useEffect, useState, type ReactNode } from 'react';
import { SessionList } from './pages/SessionList.tsx';
import { SessionView } from './pages/SessionView.tsx';
import { ChatView } from './pages/ChatView.tsx';
import { useLanguage } from './i18n.tsx';

type Mode = 'tmux' | 'chat';

type SystemStatus = {
  cpuPercent: number | null;
  memory: { usedPercent: number; used: number; total: number };
};
type Route =
  | { name: 'list' }
  | { name: 'session'; sessionName: string; mode: Mode };

// localStorage 上のセッション別モード設定。
//   { [sessionName]: 'chat'|'tmux', __default?: 'chat'|'tmux' }
// __default は「過去に何かしらモードを選んだことがあるユーザの新セッション初期値」。
const MODES_STORAGE_KEY = 'headlenss.modes';

type ModeMap = { __default?: Mode; [sessionName: string]: Mode | undefined };

function readModeMap(): ModeMap {
  try {
    const raw = localStorage.getItem(MODES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as ModeMap;
    return {};
  } catch {
    return {};
  }
}

function writeModeMap(map: ModeMap): void {
  try {
    localStorage.setItem(MODES_STORAGE_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

function readModeFromUrl(): Mode | null {
  const m = new URL(window.location.href).searchParams.get('mode');
  return m === 'chat' || m === 'tmux' ? m : null;
}

function readModeFromStorage(sessionName: string): Mode | null {
  const map = readModeMap();
  const v = map[sessionName] ?? map.__default;
  return v === 'chat' || v === 'tmux' ? v : null;
}

/** URL > localStorage[sessionName] > localStorage.__default > tmux の優先順。
 *  URL に mode が無ければ解決した値を URL に書き戻して以後 URL を真実とする
 *  (ブックマーク・共有を確実にするため)。 */
function resolveMode(sessionName: string): Mode {
  const fromUrl = readModeFromUrl();
  if (fromUrl) return fromUrl;
  const fromStorage = readModeFromStorage(sessionName);
  const mode: Mode = fromStorage ?? 'tmux';
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  window.history.replaceState(null, '', url.toString());
  return mode;
}

function getRoute(): Route {
  const m = window.location.pathname.match(/^\/sessions\/([^/]+)\/?$/);
  if (m) {
    const sessionName = decodeURIComponent(m[1]);
    return {
      name: 'session',
      sessionName,
      mode: resolveMode(sessionName),
    };
  }
  return { name: 'list' };
}

function setMode(sessionName: string, mode: Mode): void {
  const map = readModeMap();
  map[sessionName] = mode;
  // 新セッションを開いた時のフォールバックとして「最後に明示的に選んだモード」も覚えておく
  map.__default = mode;
  writeModeMap(map);
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  window.history.replaceState(null, '', url.toString());
}

const SPLIT_VIEW_STORAGE_KEY = 'headlenss_split_view';

function readSplitEnabled(): boolean {
  try {
    const v = localStorage.getItem(SPLIT_VIEW_STORAGE_KEY);
    if (v === 'false') return false;
    return true; // default enabled
  } catch {
    return true;
  }
}

function writeSplitEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SPLIT_VIEW_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch { /* ignore */ }
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return '-';
  const gb = value / 1024 / 1024 / 1024;
  return gb >= 10 ? gb.toFixed(0) + 'GB' : gb.toFixed(1) + 'GB';
}

export function App() {
  const { t } = useLanguage();
  const [route, setRoute] = useState<Route>(getRoute);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [isWide, setIsWide] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  const [splitEnabled, setSplitEnabled] = useState(readSplitEnabled);

  useEffect(() => {
    const onPop = () => setRoute(getRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)');
    const onChange = (e: MediaQueryListEvent) => setIsWide(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const res = await fetch('/api/system/status');
        if (!res.ok) return;
        const json = (await res.json()) as SystemStatus;
        if (!disposed) setSystemStatus(json);
      } catch { /* ignore */ }
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  const navigate = (path: string) => {
    window.history.pushState(null, '', path);
    setRoute(getRoute());
  };

  const switchMode = (mode: Mode) => {
    if (route.name !== 'session') return;
    setMode(route.sessionName, mode);
    setRoute(getRoute());
  };

  const toggleSplit = () => {
    setSplitEnabled((prev) => {
      const next = !prev;
      writeSplitEnabled(next);
      return next;
    });
  };

  const metrics = systemStatus ? (
    <div className="header-metrics" aria-label="PC usage">
      CPU {systemStatus.cpuPercent == null ? '-' : systemStatus.cpuPercent.toFixed(0) + '%'}
      <span>MEM {systemStatus.memory.usedPercent.toFixed(0)}% ({formatBytes(systemStatus.memory.used)} / {formatBytes(systemStatus.memory.total)})</span>
    </div>
  ) : null;

  // Split view toggle: only rendered on wide viewports
  const splitToggle = isWide ? (
    <label className="split-toggle">
      <input type="checkbox" checked={splitEnabled} onChange={toggleSplit} />
      {t('splitView')}
    </label>
  ) : null;

  const isSplitActive = isWide && splitEnabled;

  if (isSplitActive) {
    const rightPane = route.name === 'session'
      ? route.mode === 'chat'
        ? <ChatView key={route.sessionName} sessionName={route.sessionName} onBack={() => navigate('/')} onSwitchMode={switchMode} />
        : <SessionView key={route.sessionName} sessionName={route.sessionName} onBack={() => navigate('/')} onSwitchMode={switchMode} />
      : <div className="split-empty">{t('splitViewHint')}</div>;

    return (
      <div className="split-container">
        <div className="split-left">
          <SessionList
            onOpen={(name) => navigate(`/sessions/${encodeURIComponent(name)}`)}
            headerMetrics={metrics as ReactNode}
            activeSession={route.name === 'session' ? route.sessionName : undefined}
            splitToggle={splitToggle}
          />
        </div>
        <div className="split-right">
          {rightPane}
        </div>
      </div>
    );
  }

  // Classic mode
  const page = route.name === 'session'
    ? route.mode === 'chat'
      ? <ChatView sessionName={route.sessionName} onBack={() => navigate('/')} onSwitchMode={switchMode} />
      : <SessionView sessionName={route.sessionName} onBack={() => navigate('/')} onSwitchMode={switchMode} />
    : <SessionList onOpen={(name) => navigate(`/sessions/${encodeURIComponent(name)}`)} headerMetrics={metrics as ReactNode} splitToggle={splitToggle} />;

  return page;
}
