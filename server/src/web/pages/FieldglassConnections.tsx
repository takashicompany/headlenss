import { useEffect, useState } from 'react';
import { useLanguage, type StringKey } from '../i18n.tsx';
import { fieldglassApi, type Connection } from '../fieldglass/api.ts';
import { fmt } from '../fieldglass/helpers.ts';
import { FIELDGLASS_STRINGS as STRINGS_KEYS } from '../fieldglass/strings.ts';
import { LoadError, Steps, timeLabel, useLoad , useErrorText } from './FieldglassShared.tsx';
import { CalendarError, GCAL_STEP_KEYS } from './FieldglassToday.tsx';

const STATUS: Record<Connection['status'], { key: StringKey; cls: string; order: number }> = {
  needs_auth: { key: 'fgStatusNeedsAuth', cls: 'fg-pill--warn', order: 0 },
  not_configured: { key: 'fgStatusNotConfigured', cls: '', order: 1 },
  connected: { key: 'fgStatusConnected', cls: 'fg-pill--ok', order: 2 },
};

export function isGoogleCalendar(c: Connection): boolean {
  return /google.?calendar|gcal/i.test(`${c.id} ${c.name}`);
}

/** Directions for a connection. Google Calendar always uses the exact Amendment 1 wording;
 *  others use the server's steps, or a plain fallback when the server sends none. */
function stepsFor(c: Connection, t: (k: StringKey) => string, lang: string): string[] {
  if (isGoogleCalendar(c)) return GCAL_STEP_KEYS.map((k) => t(k));
  // Server steps are English; in Japanese use the web's own localized steps (QA MINOR-3).
  if (c.steps?.length && lang === 'en') return c.steps;
  return fallbackSteps(c, t);
}

function fallbackSteps(c: Connection, t: (k: StringKey) => string): string[] {
  if (c.status === 'needs_auth') {
    return [t('fgStepsNeedsAuth1'), t('fgStepsNeedsAuth2'), t('fgStepsNeedsAuth3'), fmt(t('fgStepsNeedsAuth4'), { name: c.name }), t('fgStepsNeedsAuth5')];
  }
  return [t('fgStepsNotConf1'), t('fgStepsNotConf2'), fmt(t('fgStepsNotConf3'), { name: c.name }), t('fgStepsNotConf4')];
}

export function FieldglassConnections({ onOpenToday }: { onOpenToday: () => void }) {
  const { t, language } = useLanguage();
  const errorText = useErrorText();
  const { data, setData, error, loading, reload } = useLoad(() => fieldglassApi.connections());
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState('');
  // The calendar job's last error (Amendment 1) lives on /today; show it on the Google Calendar card.
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const loadCalendarError = () => {
    fieldglassApi.today().then((d) => setCalendarError(d.lastError ?? null)).catch(() => { /* optional */ });
  };
  useEffect(loadCalendarError, []);

  // `?refresh=1` starts a background `claude mcp list` on the Mac and returns the old cache at once,
  // so keep polling until updatedAt moves (or give up after ~2 min and show whatever is cached).
  const checkAgain = async () => {
    setChecking(true);
    setCheckErr('');
    const before = data?.updatedAt ?? null;
    try {
      let fresh = await fieldglassApi.connections(true);
      setData(fresh);
      for (let i = 0; i < 24 && fresh.updatedAt === before; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        fresh = await fieldglassApi.connections();
        setData(fresh);
      }
      loadCalendarError();
    } catch (e) {
      setCheckErr(errorText(e, 'fgErrCheck'));
    } finally {
      setChecking(false);
    }
  };

  if (loading && !data) return <p className="muted">{t('fgLoading')}</p>;
  if (error && !data) return <LoadError error={error} onRetry={reload} />;
  if (!data) return null;

  const list = [...data.connections].sort((a, b) => STATUS[a.status].order - STATUS[b.status].order || a.name.localeCompare(b.name));

  return (
    <section className="fg-section">
      <p>{t('fgConnectionsIntro')}</p>
      <div className="fg-toolbar">
        <span className="muted">
          {data.updatedAt ? fmt(t('fgUpdated'), { time: timeLabel(data.updatedAt, language) }) : t('fgNeverUpdated')}
        </span>
        <button type="button" className="fg-btn" onClick={checkAgain} disabled={checking}>
          {checking ? t('fgChecking') : t('fgCheckAgain')}
        </button>
      </div>
      {checking && <p className="fg-note" role="status">{t('fgCheckSlow')}</p>}
      {checkErr && <p className="error" role="alert">{checkErr}</p>}
      {list.length === 0 && <p className="muted">{t('fgNoConnections')}</p>}
      <ul className="fg-list">
        {list.map((c) => {
          const s = STATUS[c.status];
          const steps = stepsFor(c, t, language);
          const usedKey = `fgUse_${c.id}` as StringKey;
          const usedFor = language === 'en' || !(usedKey in STRINGS_KEYS) ? c.usedFor : t(usedKey);
          const gcal = isGoogleCalendar(c);
          return (
            <li key={c.id} className="fg-card">
              <div className="fg-event-head">
                <span className="fg-event-title">{c.name}</span>
                <span className={`fg-pill ${s.cls}`}>{t(s.key)}</span>
              </div>
              {usedFor && (
                <p className="fg-usedfor"><span className="fg-label">{t('fgUsedFor')}</span> {usedFor}</p>
              )}
              {gcal && calendarError && c.status !== 'connected' && <CalendarError message={calendarError} />}
              {c.status !== 'connected' && (
                <details className="fg-howto" open={c.status === 'needs_auth' || gcal}>
                  <summary>{t('fgHowToConnect')}</summary>
                  <Steps steps={steps} />
                  {gcal && (
                    <p className="fg-byhand">
                      <button type="button" className="fg-link" onClick={onOpenToday}>{t('fgOrByHandToday')}</button>
                    </p>
                  )}
                </details>
              )}
            </li>
          );
        })}
      </ul>
      <p className="muted fg-small">{t('fgReadOnlyNote')}</p>
    </section>
  );
}
