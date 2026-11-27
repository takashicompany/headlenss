import { useState } from 'react';
import { useLanguage } from '../i18n.tsx';
import { fieldglassApi } from '../fieldglass/api.ts';
import { csvToObjects, fmt, parseCsv, seconds, summarizeFieldTest, type FieldTestRow } from '../fieldglass/helpers.ts';
import { LoadError, useLoad } from './FieldglassShared.tsx';

const PREFERRED_COLUMNS = ['at', 'sessionId', 'kind', 'category', 'rating', 'reason', 'lastWordAt', 'candidateAt', 'renderedAt'];
const RECENT = 30;

function cellValue(col: string, v: string, lang: string): string {
  if (col === 'at' && v && Number.isFinite(Number(v))) {
    return new Date(Number(v)).toLocaleString(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  if (col === 'sessionId' && v.length > 8) return v.slice(0, 8);
  return v;
}

export function FieldglassFieldTest() {
  const { t, language } = useLanguage();
  const { data, error, loading, reload } = useLoad(async () => csvToObjects(parseCsv(await fieldglassApi.fieldtestCsv())));
  const [showAll, setShowAll] = useState(false);

  if (loading && !data) return <p className="muted">{t('fgLoading')}</p>;
  if (error && !data) return <LoadError error={error} onRetry={reload} />;
  if (!data) return null;

  const rows: FieldTestRow[] = [...data].reverse();
  const s = summarizeFieldTest(data);
  const present = new Set(data.flatMap((r) => Object.keys(r)));
  const columns = [...PREFERRED_COLUMNS.filter((c) => present.has(c)), ...[...present].filter((c) => !PREFERRED_COLUMNS.includes(c) && c !== 'cueId')];
  const visible = showAll ? rows : rows.slice(0, RECENT);
  const stat = (x: { n: number; median: number; p95: number } | null) =>
    x ? fmt(t('fgFtMedianP95'), { median: seconds(x.median), p95: seconds(x.p95), n: x.n }) : '—';

  return (
    <section className="fg-section">
      <p>{t('fgFieldTestIntro')}</p>
      <div className="fg-toolbar">
        <button type="button" className="fg-btn" onClick={() => void reload()}>{t('fgRefresh')}</button>
        <a className="fg-btn fg-btn--primary" href={fieldglassApi.fieldtestCsvUrl} download="fieldglass-fieldtest.csv">{t('fgDownloadCsv')}</a>
      </div>

      {data.length === 0 ? (
        <p className="muted">{t('fgNoFieldTest')}</p>
      ) : (
        <>
          <div className="fg-stats">
            <div className="fg-stat"><span className="fg-stat-n">{s.sessions}</span><span className="muted">{t('fgFtSessions')}</span></div>
            <div className="fg-stat"><span className="fg-stat-n">{s.cuesShown}</span><span className="muted">{t('fgFtCues')}</span></div>
            <div className="fg-stat"><span className="fg-stat-n">{s.useful}</span><span className="muted">{t('fgFtUseful')}</span></div>
            <div className="fg-stat"><span className="fg-stat-n">{s.offTarget}</span><span className="muted">{t('fgFtOff')}</span></div>
          </div>
          <dl className="fg-card fg-latency">
            <dt>{t('fgFtLatency')}</dt><dd>{stat(s.latency)}</dd>
            <dt>{t('fgFtEngine')}</dt><dd>{stat(s.engine)}</dd>
          </dl>
          <p className="muted fg-small">{t('fgFtTarget')}</p>

          <h3 className="fg-h3">{t('fgFtRecent')}</h3>
          <div className="fg-table-wrap">
            <table className="fg-table">
              <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {visible.map((r, i) => (
                  <tr key={i}>{columns.map((c) => <td key={c}>{cellValue(c, r[c] ?? '', language)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {!showAll && rows.length > RECENT && (
            <button type="button" className="fg-btn" onClick={() => setShowAll(true)}>{fmt(t('fgFtShowAll'), { n: rows.length })}</button>
          )}
        </>
      )}
    </section>
  );
}
