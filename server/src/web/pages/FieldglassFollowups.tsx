import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../i18n.tsx';
import { fieldglassApi, listSendTargets, type Followup } from '../fieldglass/api.ts';
import { daysLeft, fmt, pickDefaultSession } from '../fieldglass/helpers.ts';
import { LoadError, timeLabel, useErrorText, useLoad } from './FieldglassShared.tsx';

const LAST_SESSION_KEY = 'headlenss.fieldglass.sendSession';

function readLastSession(): string {
  try { return localStorage.getItem(LAST_SESSION_KEY) ?? ''; } catch { return ''; }
}
function writeLastSession(s: string): void {
  try { localStorage.setItem(LAST_SESSION_KEY, s); } catch { /* ignore */ }
}

/** Claude session names the server will accept; null while loading. */
type Sessions = string[] | null;

function FollowupCard({
  f, sessions, onChanged, onDeleted,
}: {
  f: Followup;
  sessions: Sessions;
  onChanged: (f: Followup) => void;
  onDeleted: (id: string) => void;
}) {
  const { t, language } = useLanguage();
  const [quote, setQuote] = useState(f.quote);
  const [owner, setOwner] = useState(f.owner ?? '');
  const [due, setDue] = useState(f.due ?? '');
  // No preselection until the sessions are known; then only a session the user chose before (QA MAJOR-1).
  const [session, setSession] = useState('');
  const touched = useRef(false);
  const [busy, setBusy] = useState<'' | 'save' | 'send' | 'delete'>('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!sessions) return;
    if (!touched.current) setSession(pickDefaultSession(sessions, readLastSession(), f.sentTo));
    else if (session && !sessions.includes(session)) setSession('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  const dirty = quote.trim() !== f.quote || owner.trim() !== (f.owner ?? '') || due.trim() !== (f.due ?? '');

  const errorText = useErrorText();

  const save = async (): Promise<boolean> => {
    if (!dirty) return true;
    setBusy('save');
    try {
      const updated = await fieldglassApi.patchFollowup(f.id, { quote: quote.trim(), owner: owner.trim(), due: due.trim() });
      onChanged(updated);
      setMsg({ kind: 'ok', text: t('fgSaved') });
      return true;
    } catch (e) {
      setMsg({ kind: 'err', text: errorText(e, 'fgErrSave') });
      return false;
    } finally {
      setBusy('');
    }
  };

  const send = async () => {
    if (!session) return;
    // Save edits first so the Mac sends exactly what is on screen.
    if (!(await save())) return;
    setBusy('send');
    try {
      await fieldglassApi.sendFollowup(f.id, session);
      writeLastSession(session);
      onChanged({ ...f, quote: quote.trim(), owner: owner.trim() || undefined, due: due.trim() || undefined, sentTo: session, sentAt: Date.now() });
      setMsg({ kind: 'ok', text: fmt(t('fgSentOk'), { session }) });
    } catch (e) {
      setMsg({ kind: 'err', text: errorText(e, 'fgErrSend') });
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    if (!window.confirm(t('fgConfirmDeleteFollowup'))) return;
    setBusy('delete');
    try {
      await fieldglassApi.deleteFollowup(f.id);
      onDeleted(f.id);
    } catch (e) {
      setMsg({ kind: 'err', text: errorText(e, 'fgErrDelete') });
      setBusy('');
    }
  };

  const left = daysLeft(f.expiresAt, Date.now());
  const expiry = f.sentTo
    ? fmt(t('fgSentTo'), { session: f.sentTo, time: timeLabel(f.sentAt, language) })
    : left <= 0 ? t('fgExpiresToday') : fmt(t('fgExpiresIn'), { n: left });

  return (
    <li className="fg-card">
      <div className="fg-event-head">
        {f.meetingTitle ? <span className="muted">{fmt(t('fgFrom'), { title: f.meetingTitle })}</span> : <span />}
        <span className={`fg-pill${f.sentTo ? ' fg-pill--ok' : ''}`}>{expiry}</span>
      </div>
      <label className="fg-label" htmlFor={`q-${f.id}`}>{t('fgQuote')}</label>
      <textarea id={`q-${f.id}`} className="fg-input fg-quote" rows={3} value={quote} onChange={(e) => setQuote(e.target.value)} />
      <p className="muted fg-small">{t('fgQuoteVerbatim')}</p>
      <div className="fg-grid2">
        <div>
          <label className="fg-label" htmlFor={`o-${f.id}`}>{t('fgOwner')}</label>
          <input id={`o-${f.id}`} className="fg-input" value={owner} onChange={(e) => setOwner(e.target.value)} />
        </div>
        <div>
          <label className="fg-label" htmlFor={`d-${f.id}`}>{t('fgDue')}</label>
          <input id={`d-${f.id}`} className="fg-input" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
      </div>
      {dirty && (
        <div className="fg-row">
          <button type="button" className="fg-btn" disabled={busy !== ''} onClick={() => void save()}>
            {busy === 'save' ? t('fgSaving') : t('fgSave')}
          </button>
          <span className="muted">{t('fgUnsaved')}</span>
        </div>
      )}
      <div className="fg-send">
        <label className="fg-label" htmlFor={`s-${f.id}`}>{t('fgSendTo')}</label>
        {sessions === null ? (
          <p className="muted">{t('fgLoading')}</p>
        ) : sessions.length === 0 ? (
          <p className="muted">{t('fgNoSessions')}</p>
        ) : (
          <div className="fg-row">
            <select
              id={`s-${f.id}`}
              className="fg-input fg-select"
              value={session}
              onChange={(e) => {
                touched.current = true;
                setSession(e.target.value);
                if (e.target.value) writeLastSession(e.target.value);
              }}
            >
              <option value="" disabled>{t('fgChooseSession')}</option>
              {sessions.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <button type="button" className="fg-btn fg-btn--primary" disabled={busy !== '' || !session || !quote.trim()} onClick={send}>
              {busy === 'send' ? t('fgSending') : f.sentTo ? t('fgSendAgain') : t('fgSend')}
            </button>
          </div>
        )}
        {sessions && sessions.length > 0 && !session && <p className="muted fg-small">{t('fgChooseSessionHint')}</p>}
        <p className="muted fg-small">{t('fgSendExplain')}</p>
      </div>
      {msg && <p className={msg.kind === 'ok' ? 'fg-ok' : 'error'} role="status">{msg.text}</p>}
      <div className="fg-row fg-row--end">
        <button type="button" className="fg-btn fg-btn--danger" disabled={busy !== ''} onClick={remove}>{t('fgDelete')}</button>
      </div>
    </li>
  );
}

export function FieldglassFollowups() {
  const { t } = useLanguage();
  const { data, setData, error, loading, reload } = useLoad(fieldglassApi.followups);
  const [sessions, setSessions] = useState<Sessions>(null);

  useEffect(() => {
    listSendTargets().then(setSessions).catch(() => setSessions([]));
  }, []);

  if (loading && !data) return <p className="muted">{t('fgLoading')}</p>;
  if (error && !data) return <LoadError error={error} onRetry={reload} />;
  if (!data) return null;

  const list = [...data.followups].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <section className="fg-section">
      {list.length === 0 && <p className="muted">{t('fgNoFollowups')}</p>}
      <ul className="fg-list">
        {list.map((f) => (
          <FollowupCard
            key={f.id}
            f={f}
            sessions={sessions}
            onChanged={(u) => setData((d) => d && { followups: d.followups.map((x) => (x.id === u.id ? u : x)) })}
            onDeleted={(id) => setData((d) => d && { followups: d.followups.filter((x) => x.id !== id) })}
          />
        ))}
      </ul>
    </section>
  );
}
