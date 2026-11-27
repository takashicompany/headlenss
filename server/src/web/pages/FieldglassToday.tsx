import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLanguage, type StringKey } from '../i18n.tsx';
import { fieldglassApi, isManualEvent, type TodayEvent, type TodayResponse } from '../fieldglass/api.ts';
import { classifyCalendarError, fmt, hhmmToMinutes, lensHomeLines, nextEventIndex, nextQuarter, validateManualEvent } from '../fieldglass/helpers.ts';
import { LensPreview, LoadError, Steps, timeLabel, useLoad , useErrorText } from './FieldglassShared.tsx';

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function isPast(ev: TodayEvent): boolean {
  const end = hhmmToMinutes(ev.end);
  return end != null && end <= nowMinutes();
}

function ObjectiveEditor({ ev }: { ev: TodayEvent }) {
  const { t } = useLanguage();
  const errorText = useErrorText();
  const [value, setValue] = useState(ev.objective ?? '');
  const [saved, setSaved] = useState(ev.objective ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [err, setErr] = useState('');

  // A calendar refresh can bring a newer objective (e.g. set from another device). Adopt it unless the user is mid-edit.
  useEffect(() => {
    const incoming = ev.objective ?? '';
    if (value === saved && incoming !== saved) {
      setValue(incoming);
      setSaved(incoming);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ev.objective]);

  const dirty = value.trim() !== saved.trim();
  const save = async () => {
    setState('saving');
    try {
      await fieldglassApi.setObjective(ev.id, value.trim());
      setSaved(value.trim());
      setValue(value.trim());
      setState('saved');
    } catch (e) {
      setErr(errorText(e, 'fgErrSave'));
      setState('error');
    }
  };

  return (
    <div className="fg-objective">
      <label className="fg-label" htmlFor={`obj-${ev.id}`}>{t('fgObjective')}</label>
      <textarea
        id={`obj-${ev.id}`}
        className="fg-input"
        rows={2}
        maxLength={200}
        placeholder={t('fgObjectivePlaceholder')}
        value={value}
        onChange={(e) => { setValue(e.target.value); setState('idle'); }}
      />
      <div className="fg-row">
        <button type="button" className="fg-btn fg-btn--primary" disabled={!dirty || state === 'saving'} onClick={save}>
          {state === 'saving' ? t('fgSaving') : t('fgSave')}
        </button>
        {state === 'saved' && !dirty && <span className="fg-ok">{t('fgSaved')}</span>}
        {state === 'error' && <span className="error">{err}</span>}
        {dirty && state !== 'saving' && <span className="muted">{t('fgUnsaved')}</span>}
      </div>
    </div>
  );
}

/** Amendment 1, item 5: the exact Google Calendar setup wording. */
export const GCAL_STEP_KEYS: StringKey[] = ['fgGcalStep1', 'fgGcalStep2', 'fgGcalStep3', 'fgGcalStep4'];

/** Plain-language explanation of the last calendar job error, with the raw text behind "Details". */
export function CalendarError({ message }: { message: string }) {
  const { t } = useLanguage();
  const errorText = useErrorText();
  const kind = classifyCalendarError(message);
  const key: StringKey = kind === 'not_signed_in' ? 'fgErrNotSignedIn' : kind === 'timeout' ? 'fgErrTimeout' : 'fgErrOther';
  return (
    <div className="fg-card fg-card--warn" role="alert">
      <p>{t(key)}</p>
      <details className="fg-howto">
        <summary>{t('fgErrDetails')}</summary>
        <p className="muted fg-small fg-raw">{message}</p>
      </details>
    </div>
  );
}

function setupSteps(data: TodayResponse, t: (k: StringKey) => string): string[] {
  // Server-provided steps win only for a non-Google connector; Google uses the exact amendment wording.
  if (data.setup?.steps?.length && data.setup.connector && !/google/i.test(data.setup.connector)) return data.setup.steps;
  return GCAL_STEP_KEYS.map((k) => t(k));
}

function useElapsed(active: boolean): string {
  const startedAt = useRef<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) { startedAt.current = null; return; }
    if (startedAt.current == null) startedAt.current = Date.now();
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  if (!active || startedAt.current == null) return '0:00';
  const sec = Math.floor((Date.now() - startedAt.current) / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function ManualEventForm({ onAdded }: { onAdded: () => void }) {
  const { t } = useLanguage();
  const errorText = useErrorText();
  const [start, setStart] = useState(() => nextQuarter(new Date()));
  const [end, setEnd] = useState(() => nextQuarter(new Date(), 30));
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [state, setState] = useState<'idle' | 'adding' | 'added'>('idle');
  const [err, setErr] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = validateManualEvent({ start, end, title });
    if (v) {
      setErr(t(v === 'title' ? 'fgValTitle' : v === 'time' ? 'fgValTime' : 'fgValOrder'));
      return;
    }
    setErr('');
    setState('adding');
    try {
      await fieldglassApi.addManualEvent({ start, end, title: title.trim(), ...(objective.trim() ? { objective: objective.trim() } : {}) });
      setTitle('');
      setObjective('');
      setStart(end);
      setEnd(addMinutes(end, 30));
      setState('added');
      onAdded();
    } catch (e2) {
      setErr(errorText(e2, 'fgErrAdd'));
      setState('idle');
    }
  };

  return (
    <form className="fg-card fg-manual" onSubmit={submit} noValidate>
      <h3>{t('fgAddByHand')}</h3>
      <div className="fg-grid2">
        <div>
          <label className="fg-label" htmlFor="fg-m-start">{t('fgStart')}</label>
          <input id="fg-m-start" className="fg-input" type="time" step={300} value={start} onChange={(e) => { setStart(e.target.value); setState('idle'); }} required />
        </div>
        <div>
          <label className="fg-label" htmlFor="fg-m-end">{t('fgEnd')}</label>
          <input id="fg-m-end" className="fg-input" type="time" step={300} value={end} onChange={(e) => { setEnd(e.target.value); setState('idle'); }} required />
        </div>
      </div>
      <div>
        <label className="fg-label" htmlFor="fg-m-title">{t('fgMeetingTitle')}</label>
        <input id="fg-m-title" className="fg-input" maxLength={80} placeholder={t('fgMeetingTitlePh')} value={title} onChange={(e) => { setTitle(e.target.value); setState('idle'); }} required />
      </div>
      <div>
        <label className="fg-label" htmlFor="fg-m-obj">{t('fgObjectiveOptional')}</label>
        <input id="fg-m-obj" className="fg-input" maxLength={200} placeholder={t('fgObjectivePlaceholder')} value={objective} onChange={(e) => setObjective(e.target.value)} />
      </div>
      <div className="fg-row">
        <button type="submit" className="fg-btn fg-btn--primary" disabled={state === 'adding'}>
          {state === 'adding' ? t('fgAdding') : t('fgAdd')}
        </button>
        {state === 'added' && <span className="fg-ok">{t('fgAdded')}</span>}
        {err && <span className="error" role="alert">{err}</span>}
      </div>
      <p className="muted fg-small">{t('fgManualToday')}</p>
    </form>
  );
}

function addMinutes(hhmm: string, add: number): string {
  const m = Math.min(23 * 60 + 59, (hhmmToMinutes(hhmm) ?? 0) + add);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function FieldglassToday({ onOpenConnections }: { onOpenConnections: () => void }) {
  const { t, language } = useLanguage();
  const errorText = useErrorText();
  const { data, setData, error, loading, reload } = useLoad(fieldglassApi.today, { pollWhile: (d) => d.refreshing });
  const [refreshErr, setRefreshErr] = useState('');
  const elapsed = useElapsed(Boolean(data?.refreshing));

  const refresh = async () => {
    setRefreshErr('');
    try {
      await fieldglassApi.refreshToday();
      setData((d) => d && { ...d, refreshing: true });
      void reload();
    } catch (e) {
      setRefreshErr(errorText(e, 'fgErrRefresh'));
    }
  };

  const removeManual = async (id: string) => {
    if (!window.confirm(t('fgConfirmRemoveMeeting'))) return;
    try {
      await fieldglassApi.deleteManualEvent(id);
      setData((d) => d && { ...d, events: d.events.filter((e) => e.id !== id) });
      void reload();
    } catch (e) {
      setRefreshErr(errorText(e, 'fgErrDelete'));
    }
  };

  if (loading && !data) return <p className="muted">{t('fgLoading')}</p>;
  if (error && !data) return <LoadError error={error} onRetry={reload} />;
  if (!data) return null;

  // Server merges and sorts already; sort again so an older server or an optimistic update still reads in order.
  const events = [...data.events].sort((a, b) => (hhmmToMinutes(a.start) ?? 0) - (hhmmToMinutes(b.start) ?? 0));
  const nextIdx = nextEventIndex(events, nowMinutes());
  const next = nextIdx >= 0 ? events[nextIdx] : null;
  const errKind = data.lastError ? classifyCalendarError(data.lastError) : null;
  const calendarWorked = data.source === 'calendar' || data.lastSource === 'google' || data.lastSource === 'notion';
  // While the first-ever read is still running we don't know yet, so don't nag; a known "not signed in" always shows.
  const showSetup = errKind === 'not_signed_in'
    || (!calendarWorked && !data.refreshing && (data.setup != null || data.source === 'none'));
  const lensLines = lensHomeLines({ source: data.source, events, next }, {
    calSetup: t('fgLensCalSetup'), calSetupHint: t('fgLensCalSetupHint'), noMeeting: t('fgLensNoMeeting'),
    next: t('fgLensNext'), objective: t('fgLensObjective'), noObjective: t('fgLensNoObjective'), micOff: t('fgLensMicOff'),
  });
  const sourceLabel = data.lastSource === 'google' ? t('fgSrcGoogle') : data.lastSource === 'notion' ? t('fgSrcNotion')
    : data.source === 'manual' ? t('fgSrcManual') : null;

  return (
    <section className="fg-section">
      <div className="fg-toolbar">
        <span className="muted">
          {data.updatedAt ? fmt(t('fgUpdated'), { time: timeLabel(data.updatedAt, language) }) : t('fgNeverUpdated')}
          {sourceLabel && <> · {fmt(t('fgReadFrom'), { source: sourceLabel })}</>}
        </span>
        <button type="button" className="fg-btn" onClick={refresh} disabled={data.refreshing}>
          {data.refreshing ? t('fgChecking') : t('fgRefresh')}
        </button>
      </div>
      {data.refreshing && (
        <div className="fg-note fg-progress" role="status">
          <span className="fg-spinner" aria-hidden="true" />
          <div>
            <div>{t('fgRefreshing')}</div>
            <div className="muted fg-small">{fmt(t('fgRefreshingSub'), { elapsed })}</div>
          </div>
        </div>
      )}
      {refreshErr && <p className="error" role="alert">{refreshErr}</p>}
      {data.lastError && !data.refreshing && <CalendarError message={data.lastError} />}

      {showSetup && (
        <div className="fg-card fg-card--warn">
          <h3>{t('fgCalendarMissing')}</h3>
          <Steps steps={setupSteps(data, t)} />
          <p className="fg-byhand">{t('fgOrByHand')}</p>
          <button type="button" className="fg-btn" onClick={onOpenConnections}>{t('fgTabConnections')} →</button>
        </div>
      )}

      <LensPreview
        label={t('fgLensPreview')}
        header={t('fgLensHead')}
        lines={lensLines}
        footer={t('fgLensFoot')}
      />

      {events.length === 0 && !showSetup && !data.refreshing && <p className="muted">{t('fgNoEvents')}</p>}

      <ul className="fg-list">
        {events.map((ev, i) => {
          const manual = isManualEvent(ev);
          return (
            <li key={ev.id} className={`fg-card${i === nextIdx ? ' fg-card--next' : ''}${isPast(ev) ? ' fg-card--past' : ''}`}>
              <div className="fg-event-head">
                <span className="fg-time">{ev.start}–{ev.end}</span>
                <span className="fg-row">
                  {manual && <span className="fg-pill">{t('fgByHand')}</span>}
                  {i === nextIdx && <span className="fg-pill fg-pill--accent">{t('fgNext')}</span>}
                </span>
              </div>
              <div className="fg-event-title">{ev.title}</div>
              <ObjectiveEditor ev={ev} />
              {manual && (
                <div className="fg-row fg-row--end">
                  <button type="button" className="fg-btn fg-btn--danger" onClick={() => void removeManual(ev.id)}>{t('fgRemove')}</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {events.length > 0 && <p className="muted fg-small">{t('fgObjectiveKept')}</p>}

      <ManualEventForm onAdded={() => void reload()} />
    </section>
  );
}
