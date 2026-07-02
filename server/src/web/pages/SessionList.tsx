import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
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

function agentLabel(agent: Session['agent']): string {
  switch (agent) {
    case 'claude': return 'Claude';
    case 'codex': return 'Codex';
    default: return 'Agent';
  }
}

function lastChatLabel(lc: NonNullable<Session['lastChat']>, t: (key: StringKey) => string): string {
  if (lc.role === 'user') return lc.origin === 'external' ? t('originExternal') : 'YOU';
  switch (lc.agent) {
    case 'claude': return 'Claude';
    case 'codex': return 'Codex';
    default: return 'Agent';
  }
}

function claudeIndicator(
  status: ClaudeStatus | undefined,
  agent: Session['agent'],
  t: (key: StringKey) => string,
): string {
  const label = agentLabel(agent);
  switch (status) {
    case 'busy': return '● ' + label + ' ' + t('ccBusy');
    case 'idle': return '◯ ' + label + ' ' + t('ccIdle');
    case 'waiting-permission': return '⏸ ' + label + ' ' + t('ccWaitingPermission');
    case 'waiting-question': return '? ' + label + ' ' + t('ccWaitingQuestion');
    default: return '';
  }
}

export function SessionList({ onOpen, headerMetrics }: { onOpen: (name: string) => void; headerMetrics?: ReactNode }) {
  const { t, language, setLanguage } = useLanguage();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [newName, setNewName] = useState('');
  const [newCwd, setNewCwd] = useState('');
  const [newAgent, setNewAgent] = useState<'shell' | 'claude' | 'codex'>('shell');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starred, setStarred] = useState<Set<string>>(loadStarred);
  const [manualOrder, setManualOrder] = useState(loadManualOrder);
  const [order, setOrder] = useState<string[]>(loadOrder);

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
      setError(null);
    } catch (e) {
      setError((e as Error).message);
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
      setNewName('');
      setNewCwd('');
      setNewAgent('shell');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (name: string) => {
    if (!confirm(`Delete session "${name}" from HeadLenss?`)) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
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
    if (!nextName || nextName === name) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
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
    if (!confirm(`Release tmux for "${name}" but keep it in the list?`)) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(name)}/release`, { method: 'POST' });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const open = async (session: Session) => {
    if (!session.released) {
      onOpen(session.name);
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.name)}/mount`, { method: 'POST' });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await refresh();
      onOpen(session.name);
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
        <label className="lang-select">
          {t('language')}:
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
          >
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </select>
        </label>
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
          aria-label="start command"
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

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="muted">{t('loading')}</div>
      ) : sessions.length === 0 ? (
        <div className="muted">{t('noSessions')}</div>
      ) : (
        <ul className="session-list">
          {sortedSessions.map((s) => {
            const status = s.agent === 'codex' ? s.codexStatus ?? s.claudeStatus : s.claudeStatus;
            const cc = claudeIndicator(status, s.agent, t);
            const agentOnly = !cc && s.agent ? agentLabel(s.agent) : '';
            const codexHookLabel = s.agent === 'codex' && s.codexHookHealth?.status !== 'ok'
              ? s.codexHookHealth?.status === 'missing' ? t('codexHooksMissing') : t('codexHooksIncomplete')
              : s.agent === 'codex' && s.codexNeedsHookAttention ? t('codexHooksNeedTrust') : '';
            const isStarred = starred.has(s.name);
            return (
              <li key={s.name} className={s.released ? 'is-released' : undefined}>
                {manualOrder && <div className="session-reorder">
                  <button onClick={() => move(s.name, -1)} aria-label={t('moveUp')} title={t('moveUp')}>↑</button>
                  <button onClick={() => move(s.name, 1)} aria-label={t('moveDown')} title={t('moveDown')}>↓</button>
                </div>}
                <button
                  className={`session-star${isStarred ? ' is-starred' : ''}`}
                  onClick={() => toggleStar(s.name)}
                  aria-label={isStarred ? t('unstarSession') : t('starSession')}
                  aria-pressed={isStarred}
                >
                  {isStarred ? '★' : '☆'}
                </button>
                <button className="session-open" onClick={() => open(s)}>
                  <span className="session-name">{s.name}</span>
                  <span className="session-meta">
                    {s.windows} {t(s.windows === 1 ? 'windowUnit' : 'windowUnitPlural')}
                    {s.attached && ` • ${t('attached')}`}
                    {s.released && <span className="released-indicator"> • {t('releasedSession')}</span>}
                    {cc && <span className={`cc-indicator cc-${status}`}> • {cc}</span>}
                    {agentOnly && <span className="agent-indicator"> • {agentOnly}</span>}
                    {codexHookLabel && <span className="codex-hook-warning"> • {codexHookLabel}</span>}
                  </span>
                  {s.lastChat && (
                    <span className="session-last-chat">
                      {lastChatLabel(s.lastChat, t)}: {s.lastChat.text}
                    </span>
                  )}
                </button>
                <button className="session-action" onClick={() => rename(s.name)} aria-label={t('renameSession')} title={t('renameSession')}>
                  ✎
                </button>
                {!s.released && <button className="session-action" onClick={() => release(s.name)} aria-label={t('releaseSession')} title={t('releaseSession')}>
                  ⏏
                </button>}
                <button className="session-kill" onClick={() => remove(s.name)} aria-label={`delete ${s.name}`} title="Delete">
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
