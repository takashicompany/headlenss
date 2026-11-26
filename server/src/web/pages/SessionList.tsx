import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLanguage, type Language, type StringKey } from '../i18n.tsx';

type ClaudeStatus = 'idle' | 'busy' | 'waiting-permission' | 'waiting-question';

type CodexHookHealth = {
  status: 'ok' | 'missing' | 'incomplete';
  missingEvents: string[];
  setupCommand: string;
  notes: string[];
};

type Session = {
  name: string;
  created: number;
  /** ms。tmux の session_activity を ms 化したもの。「最近触った順」のソートキー。 */
  activity: number;
  windows: number;
  attached: boolean;
  released?: boolean;
  claudeStatus?: ClaudeStatus;
  codexStatus?: ClaudeStatus;
  agent?: 'claude' | 'codex';
  codexHookHealth?: CodexHookHealth;
  codexNeedsHookAttention?: boolean;
  /** 対話ウィザード等が tmux の画面を占有していて、送ったメッセージが会話に届かない。
   *  status は idle/busy のまま (正しい) なので、警告はこのフラグだけが根拠になる。 */
  screenBlocked?: boolean;
  lastChat?: { role: 'user' | 'assistant'; text: string; ts: number; agent?: 'claude' | 'codex'; origin?: 'ui' | 'external' };
};

const STARRED_STORAGE_KEY = 'headlenss_starred_sessions';
const ORDER_STORAGE_KEY = 'headlenss_session_order';
const ORDER_MODE_STORAGE_KEY = 'headlenss_session_order_mode';

/** localStorage からスター済みセッション名の集合を読む。型/JSON 不正は空集合に倒す。 */
function loadStarred(): Set<string> {
  try {
    const raw = localStorage.getItem(STARRED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function saveStarred(starred: Set<string>): void {
  try {
    localStorage.setItem(STARRED_STORAGE_KEY, JSON.stringify([...starred]));
  } catch {
    /* private mode 等で書けなくても UI 上の挙動は維持 */
  }
}

function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function saveOrder(order: string[]): void {
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch { /* ignore */ }
}

function loadManualOrder(): boolean {
  try {
    return localStorage.getItem(ORDER_MODE_STORAGE_KEY) === 'manual';
  } catch {
    return false;
  }
}

function saveManualOrder(enabled: boolean): void {
  try {
    localStorage.setItem(ORDER_MODE_STORAGE_KEY, enabled ? 'manual' : 'activity');
  } catch { /* ignore */ }
}

function lastChatLabel(lc: NonNullable<Session['lastChat']>, t: (key: StringKey) => string): string {
  if (lc.role === 'user') return lc.origin === 'external' ? t('originExternal') : 'YOU';
  switch (lc.agent) {
    case 'claude': return 'Claude';
    case 'codex': return 'Codex';
    default: return 'Agent';
  }
}

function sessionAgentStatus(s: Session): ClaudeStatus | undefined {
  return s.agent === 'codex' ? s.codexStatus ?? s.claudeStatus : s.claudeStatus;
}

type StatusPill = {
  kind: 'running' | 'idle' | 'permission' | 'question' | 'blocked';
  label: string;
};

/** 行に出す状態は 1 つ。画面ブロックは status より先に出す (送っても届かないため)。 */
function statusPill(s: Session, t: (key: StringKey) => string): StatusPill | null {
  if (s.screenBlocked) return { kind: 'blocked', label: t('screenBlocked') };
  switch (sessionAgentStatus(s)) {
    case 'busy': return { kind: 'running', label: t('ccBusy') };
    case 'idle': return { kind: 'idle', label: t('ccIdle') };
    case 'waiting-permission': return { kind: 'permission', label: t('needsPermission') };
    case 'waiting-question': return { kind: 'question', label: t('needsAnswer') };
    default: return null;
  }
}

function waitingKind(s: Session): 'permission' | 'question' | null {
  switch (sessionAgentStatus(s)) {
    case 'waiting-permission': return 'permission';
    case 'waiting-question': return 'question';
    default: return null;
  }
}

function fillName(template: string, name: string): string {
  return template.replaceAll('{name}', name);
}

type Props = {
  /** chat: true はその遷移だけ chat で開く。並びの既定モードは変えない。 */
  onOpen: (name: string, opts?: { chat?: boolean }) => void;
  headerMetrics?: ReactNode;
  activeSession?: string;
  splitToggle?: ReactNode;
};

export function SessionList({ onOpen, headerMetrics, activeSession, splitToggle }: Props) {
  const { t, language, setLanguage } = useLanguage();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [newName, setNewName] = useState('');
  const [newCwd, setNewCwd] = useState('');
  const [newAgent, setNewAgent] = useState<'shell' | 'claude' | 'codex'>('shell');
  // 作成・削除などユーザ操作の失敗。一覧ポーリングでは消さない。
  const [error, setError] = useState<string | null>(null);
  // 一覧の取得が届いていない。直前の sessions は残し、空一覧とは別に出す。
  const [unreachable, setUnreachable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starred, setStarred] = useState<Set<string>>(loadStarred);
  const [manualOrder, setManualOrder] = useState(loadManualOrder);
  const [order, setOrder] = useState<string[]>(loadOrder);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // 開いている ⋯。Escape と、取り消した confirm/prompt のあとでここに戻す。
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreMenuTrigger = () => {
    menuTriggerRef.current?.focus();
  };

  useEffect(() => {
    if (!menuFor) return;
    const onPointer = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('[data-session-menu]')) return;
      setMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuFor(null);
      restoreMenuTrigger();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  const toggleStar = useCallback((name: string) => {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      saveStarred(next);
      return next;
    });
  }, []);

  const sortedSessions = useMemo(() => {
    if (manualOrder) {
      const index = new Map(order.map((name, i) => [name, i]));
      return [...sessions].sort((a, b) => {
        const ia = index.get(a.name) ?? Number.MAX_SAFE_INTEGER;
        const ib = index.get(b.name) ?? Number.MAX_SAFE_INTEGER;
        if (ia !== ib) return ia - ib;
        return b.activity - a.activity;
      });
    }
    return [...sessions].sort((a, b) => {
      const sa = starred.has(a.name) ? 1 : 0;
      const sb = starred.has(b.name) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return b.activity - a.activity;
    });
  }, [manualOrder, order, sessions, starred]);

  const refresh = async () => {
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sessions: Session[] };
      setSessions(data.sessions);
      setOrder((prev) => {
        const names = data.sessions.map((session) => session.name);
        const next = [...prev.filter((name) => names.includes(name)), ...names.filter((name) => !prev.includes(name))];
        saveOrder(next);
        return next;
      });
      // 届いたときだけ unreachable を下ろす。操作エラーはここから触らない。
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          cwd: newCwd.trim() || undefined,
          startClaude: newAgent === 'claude',
          startCodex: newAgent === 'codex',
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setError(null);
      setNewName('');
      setNewCwd('');
      setNewAgent('shell');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (name: string) => {
    if (!confirm(fillName(t('confirmDelete'), name))) {
      restoreMenuTrigger();
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setError(null);
      setOrder((prev) => {
        const next = prev.filter((n) => n !== name);
        saveOrder(next);
        return next;
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rename = async (name: string) => {
    const nextName = prompt(t('renameSession'), name)?.trim();
    if (!nextName || nextName === name) {
      restoreMenuTrigger();
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setError(null);
      setOrder((prev) => {
        const next = prev.map((n) => n === name ? nextName : n);
        saveOrder(next);
        return next;
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const release = async (name: string) => {
    if (!confirm(fillName(t('confirmRelease'), name))) {
      restoreMenuTrigger();
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(name)}/release`, { method: 'POST' });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setError(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const open = async (session: Session, chat = false) => {
    const go = () => onOpen(session.name, chat ? { chat: true } : undefined);
    if (!session.released) {
      go();
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.name)}/mount`, { method: 'POST' });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setError(null);
      await refresh();
      go();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setManualOrderMode = (enabled: boolean) => {
    setManualOrder(enabled);
    saveManualOrder(enabled);
  };

  const move = (name: string, delta: -1 | 1) => {
    setOrder((prev) => {
      const names = sortedSessions.map((session) => session.name);
      const base = [...prev.filter((n) => names.includes(n)), ...names.filter((n) => !prev.includes(n))];
      const idx = base.indexOf(name);
      const nextIdx = idx + delta;
      if (idx < 0 || nextIdx < 0 || nextIdx >= base.length) return prev;
      const next = [...base];
      [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
      saveOrder(next);
      return next;
    });
  };

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header-row">
          <div className="page-heading">
            <h1>HeadLenss</h1>
            <p className="muted">{t('appSubtitle')}</p>
          </div>
          {headerMetrics}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
          <label className="lang-select" style={{ marginBottom: 0 }}>
            {t('language')}:
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
            >
              <option value="en">English</option>
              <option value="ja">日本語</option>
            </select>
          </label>
          {splitToggle}
        </div>
      </header>

      <form className="create-form" onSubmit={create}>
        <input
          type="text"
          placeholder={t('sessionNamePlaceholder')}
          value={newName}
          onChange={(e) => {
            // 再入力されたらカスタムエラーをクリアする
            e.currentTarget.setCustomValidity('');
            setNewName(e.target.value);
          }}
          onInvalid={(e) => e.currentTarget.setCustomValidity(t('sessionNameRule'))}
          pattern="[a-zA-Z0-9_\-]+"
          maxLength={40}
          title={t('sessionNameRule')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <input
          type="text"
          placeholder="working directory (optional)"
          value={newCwd}
          onChange={(e) => setNewCwd(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <select
          value={newAgent}
          onChange={(e) => setNewAgent(e.target.value as 'shell' | 'claude' | 'codex')}
          aria-label={t('startCommand')}
        >
          <option value="shell">shell</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        <button type="submit">{t('newSession')}</button>
      </form>

      <div className="session-toolbar">
        <label>
          <input
            type="checkbox"
            checked={manualOrder}
            onChange={(e) => setManualOrderMode(e.target.checked)}
          />
          {t('manualOrder')}
        </label>
      </div>

      {/* 常に DOM に残して、届かなくなった瞬間を aria-live が読めるようにする。 */}
      <div
        className={unreachable ? 'conn-status' : 'conn-status conn-status--off'}
        role="status"
        aria-live="polite"
      >
        {unreachable ? t('serverUnreachable') : ''}
      </div>
      <div
        className={error ? 'error' : 'error is-off'}
        role="status"
        aria-live="polite"
      >
        {error && (
          <>
            <span>{error}</span>
            <button
              type="button"
              className="error-dismiss"
              onClick={() => setError(null)}
              aria-label={t('dismissError')}
            >
              ×
            </button>
          </>
        )}
      </div>

      {loading ? (
        <div className="muted">{t('loading')}</div>
      ) : sessions.length === 0 && !unreachable ? (
        <div className="muted">{t('noSessions')}</div>
      ) : sessions.length === 0 ? null : (
        <>
          {/* 待ちのセッションだけを上に並べる。本体の手動順は動かさない。 */}
          {sortedSessions.some((s) => waitingKind(s)) && (
            <section className="needs-you" aria-label={t('needsYou')}>
              <div className="needs-you-title">{t('needsYou')}</div>
              <ul>
                {sortedSessions.map((s) => {
                  const kind = waitingKind(s);
                  if (!kind) return null;
                  return (
                    <li key={s.name}>
                      <button type="button" onClick={() => open(s, true)}>
                        <span className="needs-you-name">{s.name}</span>
                        <span className={`status-pill status-pill--${kind}`}>
                          {kind === 'permission' ? t('needsPermission') : t('needsAnswer')}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <ul className="session-list">
            {sortedSessions.map((s) => {
              const pill = statusPill(s, t);
              const isStarred = starred.has(s.name);
              const menuOpen = menuFor === s.name;
              const actionsId = `session-actions-${encodeURIComponent(s.name)}`;
              return (
                <li key={s.name} className={[s.released && 'is-released', activeSession === s.name && 'session-active'].filter(Boolean).join(' ') || undefined}>
                  <div className="session-row">
                    {manualOrder && <div className="session-reorder">
                      <button type="button" onClick={() => move(s.name, -1)} aria-label={t('moveUp')} title={t('moveUp')}>↑</button>
                      <button type="button" onClick={() => move(s.name, 1)} aria-label={t('moveDown')} title={t('moveDown')}>↓</button>
                    </div>}
                    <button
                      type="button"
                      className={`session-star${isStarred ? ' is-starred' : ''}`}
                      onClick={() => toggleStar(s.name)}
                      aria-label={isStarred ? t('unstarSession') : t('starSession')}
                      aria-pressed={isStarred}
                    >
                      {isStarred ? '★' : '☆'}
                    </button>
                    <button type="button" className="session-open" onClick={() => open(s)}>
                      <span className="session-name">{s.name}</span>
                      {pill && (
                        <span
                          className={`status-pill status-pill--${pill.kind}`}
                          title={pill.kind === 'blocked' ? t('screenBlockedBody') : undefined}
                        >
                          {pill.label}
                        </span>
                      )}
                      {s.released && <span className="released-indicator">{t('releasedSession')}</span>}
                    </button>
                    <div className="session-more" data-session-menu="">
                      <button
                        type="button"
                        className="session-more-btn"
                        aria-label={t('moreActions')}
                        aria-expanded={menuOpen}
                        aria-controls={menuOpen ? actionsId : undefined}
                        ref={menuOpen ? menuTriggerRef : undefined}
                        onClick={() => setMenuFor(menuOpen ? null : s.name)}
                      >
                        ⋯
                      </button>
                    </div>
                  </div>
                  {menuOpen && (
                    <ul className="session-menu" id={actionsId} data-session-menu="">
                      <li>
                        <button type="button" onClick={() => { setMenuFor(null); void rename(s.name); }}>
                          {t('renameSession')}
                        </button>
                      </li>
                      {!s.released && (
                        <li>
                          <button type="button" onClick={() => { setMenuFor(null); void release(s.name); }}>
                            {t('releaseSession')}
                          </button>
                        </li>
                      )}
                      <li>
                        <button
                          type="button"
                          className="is-danger"
                          aria-label={`${t('deleteSession')} ${s.name}`}
                          onClick={() => { setMenuFor(null); void remove(s.name); }}
                        >
                          {t('deleteSession')}
                        </button>
                      </li>
                    </ul>
                  )}
                  {s.lastChat && (
                    <button
                      type="button"
                      className="session-last-chat"
                      onClick={() => open(s)}
                      title={`${lastChatLabel(s.lastChat, t)}: ${s.lastChat.text}`}
                    >
                      {lastChatLabel(s.lastChat, t)}: {s.lastChat.text}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
