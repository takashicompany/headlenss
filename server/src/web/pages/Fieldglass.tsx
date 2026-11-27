import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { nextTabIndex } from '../fieldglass/helpers.ts';
import { useLanguage, type StringKey } from '../i18n.tsx';
import { FieldglassToday } from './FieldglassToday.tsx';
import { FieldglassFollowups } from './FieldglassFollowups.tsx';
import { FieldglassConnections } from './FieldglassConnections.tsx';
import { FieldglassPrivacy } from './FieldglassPrivacy.tsx';
import { FieldglassFieldTest } from './FieldglassFieldTest.tsx';
import { FieldglassMessages } from './FieldglassMessages.tsx';

export type FieldglassTab = 'today' | 'followups' | 'messages' | 'connections' | 'privacy' | 'fieldtest';

const TABS: { id: FieldglassTab; key: StringKey }[] = [
  { id: 'today', key: 'fgTabToday' },
  { id: 'followups', key: 'fgTabFollowups' },
  { id: 'messages', key: 'fgTabMessages' },
  { id: 'connections', key: 'fgTabConnections' },
  { id: 'privacy', key: 'fgTabPrivacy' },
  { id: 'fieldtest', key: 'fgTabFieldTest' },
];

export function readFieldglassTab(): FieldglassTab {
  const v = new URL(window.location.href).searchParams.get('tab');
  return TABS.some((t) => t.id === v) ? (v as FieldglassTab) : 'today';
}

/** Fieldglass web companion: /fieldglass?tab=<id>. The tab lives in the URL so links and reloads land in the same place. */
export function Fieldglass({ onBack }: { onBack: () => void }) {
  const { t } = useLanguage();
  const [tab, setTab] = useState<FieldglassTab>(readFieldglassTab);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const onPop = () => setTab(readFieldglassTab());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const select = (id: FieldglassTab) => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', id);
    window.history.replaceState(null, '', url.toString());
    setTab(id);
    window.scrollTo({ top: 0 });
  };

  // ARIA tabs pattern (QA MINOR-4): Left/Right/Home/End move focus and select (automatic activation).
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextTabIndex(index, e.key, TABS.length);
    if (next === null) return;
    e.preventDefault();
    select(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="page fg-page">
      <header className="page-header">
        <button type="button" className="fg-back" onClick={onBack}>{t('back')}</button>
        <div className="page-heading">
          <h1>{t('fgTitle')}</h1>
          <p className="muted">{t('fgSubtitle')}</p>
        </div>
      </header>
      <nav className="fg-tabs" role="tablist" aria-label={t('fgTitle')}>
        {TABS.map((x, i) => (
          <button
            key={x.id}
            ref={(el) => { tabRefs.current[i] = el; }}
            id={`fg-tab-${x.id}`}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            aria-controls="fg-tabpanel"
            tabIndex={tab === x.id ? 0 : -1}
            onKeyDown={(e) => onTabKey(e, i)}
            className={`fg-tab${tab === x.id ? ' fg-tab--on' : ''}`}
            onClick={() => select(x.id)}
          >
            {t(x.key)}
          </button>
        ))}
      </nav>
      <main role="tabpanel" id="fg-tabpanel" aria-labelledby={`fg-tab-${tab}`}>
        {tab === 'today' && <FieldglassToday onOpenConnections={() => select('connections')} />}
        {tab === 'followups' && <FieldglassFollowups />}
        {tab === 'messages' && <FieldglassMessages />}
        {tab === 'connections' && <FieldglassConnections onOpenToday={() => select('today')} />}
        {tab === 'privacy' && <FieldglassPrivacy />}
        {tab === 'fieldtest' && <FieldglassFieldTest />}
      </main>
    </div>
  );
}
