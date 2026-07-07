import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
    if (v === 'true') return true;
    if (v === 'false') return false;
    // No stored value: default ON for fine pointer (PC), OFF for coarse pointer (touch)
    return !window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return !window.matchMedia('(pointer: coarse)').matches;
  }
}

function writeSplitEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SPLIT_VIEW_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch { /* ignore */ }
}

const SPLIT_RATIO_STORAGE_KEY = 'headlenss_split_ratio';
const DEFAULT_SPLIT_RATIO = 50;

function readSplitRatio(): number {
  try {
    const v = localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
    if (v == null) return DEFAULT_SPLIT_RATIO;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 20 && n <= 80) return n;
    return DEFAULT_SPLIT_RATIO;
  } catch {
    return DEFAULT_SPLIT_RATIO;
  }
}

function writeSplitRatio(ratio: number): void {
  try {
    localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(ratio));
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
  const [splitRatio, setSplitRatio] = useState(readSplitRatio);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

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

  const navigate = (path: string, options?: { replace?: boolean }) => {
    if (options?.replace) {
      window.history.replaceState(null, '', path);
    } else {
      window.history.pushState(null, '', path);
    }
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

  const isSplitActive = isWide && splitEnabled && route.name === 'session';

  // Keep latest clamped ratio in a ref so pointerup/cancel can persist without reading the DOM (fix 3)
  const latestRatioRef = useRef(splitRatio);

  const handleDividerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const divider = e.currentTarget;
    const pointerId = e.pointerId;
    divider.setPointerCapture(pointerId);
    isDraggingRef.current = true;
    divider.classList.add('dragging');
    document.body.style.userSelect = 'none';

    const onPointerMove = (ev: PointerEvent) => {
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const pct = Math.min(80, Math.max(20, (x / rect.width) * 100));
      latestRatioRef.current = pct;
      setSplitRatio(pct);
    };

    const cleanup = (ev?: PointerEvent) => {
      isDraggingRef.current = false;
      divider.classList.remove('dragging');
      document.body.style.userSelect = '';
      divider.removeEventListener('pointermove', onPointerMove);
      divider.removeEventListener('pointerup', cleanup);
      divider.removeEventListener('pointercancel', cleanup);
      divider.removeEventListener('lostpointercapture', cleanup);
      // Release pointer capture explicitly (fix 6)
      if (ev) {
        try {
          if (divider.hasPointerCapture(ev.pointerId)) {
            divider.releasePointerCapture(ev.pointerId);
          }
        } catch { /* ignore */ }
      }
      // Persist from ref, not the DOM (fix 3)
      writeSplitRatio(latestRatioRef.current);
    };

    divider.addEventListener('pointermove', onPointerMove);
    divider.addEventListener('pointerup', cleanup);
    divider.addEventListener('pointercancel', cleanup);        // fix 2
    divider.addEventListener('lostpointercapture', cleanup);   // fix 2
  }, []);

  // Fix 1: clean up userSelect if split container unmounts mid-drag
  useEffect(() => {
    if (!isSplitActive) {
      // Split just became inactive (viewport crossed below 1024px, toggle off, or navigated to list)
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.userSelect = '';
      }
    }
    return () => {
      // Component unmount: also clean up
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.userSelect = '';
      }
    };
  }, [isSplitActive]);

  // Fix 4: keyboard handler for divider accessibility
  const handleDividerKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = 2;
    let newRatio: number | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        newRatio = Math.max(20, latestRatioRef.current - step);
        break;
      case 'ArrowRight':
        newRatio = Math.min(80, latestRatioRef.current + step);
        break;
      case 'Home':
        newRatio = 20;
        break;
      case 'End':
        newRatio = 80;
        break;
      default:
        return;
    }
    e.preventDefault();
    latestRatioRef.current = newRatio;
    setSplitRatio(newRatio);
    writeSplitRatio(newRatio);
  }, []);

  const handleDividerDoubleClick = useCallback(() => {
    latestRatioRef.current = DEFAULT_SPLIT_RATIO;
    setSplitRatio(DEFAULT_SPLIT_RATIO);
    writeSplitRatio(DEFAULT_SPLIT_RATIO);
  }, []);

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

  if (isSplitActive) {
    const rightPane = route.mode === 'chat'
      ? <ChatView key={route.sessionName} sessionName={route.sessionName} onBack={() => navigate('/')} onSwitchMode={switchMode} />
      : <SessionView key={route.sessionName} sessionName={route.sessionName} onBack={() => navigate('/')} onSwitchMode={switchMode} />;

    return (
      <div className="split-container" ref={splitContainerRef}>
        <div className="split-left" style={{ width: `calc(${splitRatio}% - 3px)` }}>
          <SessionList
            onOpen={(name) => navigate(`/sessions/${encodeURIComponent(name)}`, { replace: true })}
            headerMetrics={metrics as ReactNode}
            activeSession={route.sessionName}
            splitToggle={splitToggle}
          />
        </div>
        <div
          className="split-divider"
          title={t('splitDividerTitle')}
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={Math.round(splitRatio)}
          aria-valuemin={20}
          aria-valuemax={80}
          tabIndex={0}
          onPointerDown={handleDividerPointerDown}
          onDoubleClick={handleDividerDoubleClick}
          onKeyDown={handleDividerKeyDown}
        />
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
