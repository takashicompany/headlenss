import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLanguage, type StringKey } from '../i18n.tsx';
import { describeError, fmt } from '../fieldglass/helpers.ts';

/** Loads `fn` once and on `reload()`. While `pollWhile(data)` is true, reloads every `pollMs`. */
export function useLoad<T>(fn: () => Promise<T>, opts?: { pollWhile?: (d: T) => boolean; pollMs?: number }) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const pollWhileRef = useRef(opts?.pollWhile);
  pollWhileRef.current = opts?.pollWhile;
  const pollMs = opts?.pollMs ?? 4000;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    try {
      const d = await fnRef.current();
      if (!alive.current) return;
      setData(d);
      setError(null);
      if (pollWhileRef.current?.(d)) timer.current = setTimeout(() => void reload(), pollMs);
    } catch (e) {
      if (!alive.current) return;
      setError(e);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [pollMs]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [reload]);

  return { data, setData, error, loading, reload };
}

/** Turns any thrown value into one user-facing line: offline / not available on this server / "<action failed>: reason". */
export function useErrorText(): (e: unknown, key: StringKey) => string {
  const { t } = useLanguage();
  return (e, key) => {
    const d = describeError(e);
    if (d.kind === 'offline') return t('fgOffline');
    if (d.kind === 'unavailable') return t('fgNotAvailable');
    return fmt(t(key), { error: d.detail });
  };
}

export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useLanguage();
  const errorText = useErrorText();
  return (
    <div className="fg-card fg-card--warn" role="alert">
      <p>{errorText(error, 'fgLoadError')}</p>
      <button type="button" className="fg-btn" onClick={onRetry}>{t('fgRetry')}</button>
    </div>
  );
}

export function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="fg-steps">
      {steps.map((s, i) => <li key={i}>{s}</li>)}
    </ol>
  );
}

export function timeLabel(ms: number | null | undefined, lang: string): string {
  if (!ms) return '';
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A 576×288-proportioned green-on-black preview of what the lens shows. Purely illustrative. */
export function LensPreview({ header, lines, footer, label }: { header: string; lines: string[]; footer: string; label: ReactNode }) {
  const body = [...lines.slice(0, 7)];
  while (body.length < 7) body.push('');
  return (
    <figure className="fg-lens" aria-label={typeof label === 'string' ? label : undefined}>
      <figcaption className="muted">{label}</figcaption>
      <div className="fg-lens-screen">
        <div className="fg-lens-line fg-lens-head">{header}</div>
        <div className="fg-lens-body">
          {body.map((l, i) => <div className="fg-lens-line" key={i}>{l || ' '}</div>)}
        </div>
        <div className="fg-lens-line fg-lens-foot">{footer}</div>
      </div>
    </figure>
  );
}
