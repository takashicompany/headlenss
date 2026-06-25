import { useCallback, useEffect, useMemo, useState } from 'react';
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
  claudeStatus?: ClaudeStatus;
  codexStatus?: ClaudeStatus;
  agent?: 'claude' | 'codex';
  codexHookHealth?: CodexHookHealth;
  codexNeedsHookAttention?: boolean;
};

const STARRED_STORAGE_KEY = 'headlenss_starred_sessions';

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

function agentLabel(agent: Session['agent']): string {
  switch (agent) {
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

export function SessionList({ onOpen }: { onOpen: (name: string) => void }) {
  const { t, language, setLanguage } = useLanguage();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [newName, setNewName] = useState('');
  const [newCwd, setNewCwd] = useState('');
  const [newAgent, setNewAgent] = useState<'shell' | 'claude' | 'codex'>('shell');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starred, setStarred] = useState<Set<string>>(loadStarred);

  const toggleStar = useCallback((name: string) => {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      saveStarred(next);
      return next;
    });
  }, []);

  // スター優先 → 最終アクティビティ降順 で並べる。
  // スター済みの中も最終アクティビティ降順にすると、よく触る pin の中でも
  // 「今いじってるやつ」が一番上に来て自然。
  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const sa = starred.has(a.name) ? 1 : 0;
      const sb = starred.has(b.name) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return b.activity - a.activity;
    });
  }, [sessions, starred]);

  const refresh = async () => {
    try {
      const res = await fetch('/api/sessions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sessions: Session[] };
      setSessions(data.sessions);
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
    if (!confirm(`Kill session "${name}"?`)) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>headlenss</h1>
        <p className="muted">{t('appSubtitle')}</p>
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
            const codexHookLabel = s.agent === 'codex' && s.codexHookHealth?.status !== 'ok'
              ? s.codexHookHealth?.status === 'missing' ? t('codexHooksMissing') : t('codexHooksIncomplete')
              : s.agent === 'codex' && s.codexNeedsHookAttention ? t('codexHooksNeedTrust') : '';
            const isStarred = starred.has(s.name);
            return (
              <li key={s.name}>
                <button
                  className={`session-star${isStarred ? ' is-starred' : ''}`}
                  onClick={() => toggleStar(s.name)}
                  aria-label={isStarred ? t('unstarSession') : t('starSession')}
                  aria-pressed={isStarred}
                >
                  {isStarred ? '★' : '☆'}
                </button>
                <button className="session-open" onClick={() => onOpen(s.name)}>
                  <span className="session-name">{s.name}</span>
                  <span className="session-meta">
                    {s.windows} {t(s.windows === 1 ? 'windowUnit' : 'windowUnitPlural')}
                    {s.attached && ` • ${t('attached')}`}
                    {cc && <span className={`cc-indicator cc-${status}`}> • {cc}</span>}
                    {codexHookLabel && <span className="codex-hook-warning"> • {codexHookLabel}</span>}
                  </span>
                </button>
                <button className="session-kill" onClick={() => remove(s.name)} aria-label={`kill ${s.name}`}>
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
