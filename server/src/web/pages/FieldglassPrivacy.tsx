import { useEffect, useRef, useState } from 'react';
import { useLanguage, type StringKey } from '../i18n.tsx';
import { fieldglassApi } from '../fieldglass/api.ts';
import { useErrorText } from './FieldglassShared.tsx';

const ROWS: [StringKey, StringKey, StringKey][] = [
  ['fgPrivAudio', 'fgPrivAudioWhere', 'fgPrivAudioLong'],
  ['fgPrivTranscript', 'fgPrivTranscriptWhere', 'fgPrivTranscriptLong'],
  ['fgPrivFollowups', 'fgPrivFollowupsWhere', 'fgPrivFollowupsLong'],
  ['fgPrivObjectives', 'fgPrivObjectivesWhere', 'fgPrivObjectivesLong'],
  ['fgPrivFieldTest', 'fgPrivFieldTestWhere', 'fgPrivFieldTestLong'],
];

export function FieldglassPrivacy() {
  const { t } = useLanguage();
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<'idle' | 'deleting' | 'done' | 'error'>('idle');
  const [err, setErr] = useState('');
  const errorText = useErrorText();
  // Keyboard focus must not fall to <body> when the button it's on unmounts (QA MINOR-5).
  // Confirm → Cancel (the safe choice); Cancel → back to "Delete all"; done/error → the status line.
  const startRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [focusNext, setFocusNext] = useState<'' | 'start' | 'cancel' | 'status'>('');
  useEffect(() => {
    if (!focusNext) return;
    const el = focusNext === 'start' ? startRef.current : focusNext === 'cancel' ? cancelRef.current : statusRef.current;
    el?.focus();
    setFocusNext('');
  }, [focusNext, confirming, state]);

  const deleteAll = async () => {
    setState('deleting');
    try {
      await fieldglassApi.deleteAll();
      setState('done');
      setConfirming(false);
      setFocusNext('status');
    } catch (e) {
      setErr(errorText(e, 'fgErrDelete'));
      setState('error');
      setFocusNext('status');
    }
  };

  return (
    <section className="fg-section">
      <p>{t('fgPrivacyIntro')}</p>
      <div className="fg-privacy">
        {ROWS.map(([what, where, howLong]) => (
          <div className="fg-card fg-priv-row" key={what}>
            <div className="fg-priv-what">{t(what)}</div>
            <dl>
              <dt>{t('fgPrivWhere')}</dt><dd>{t(where)}</dd>
              <dt>{t('fgPrivHowLong')}</dt><dd>{t(howLong)}</dd>
            </dl>
          </div>
        ))}
      </div>

      <h3 className="fg-h3">{t('fgPrivRules')}</h3>
      <ul className="fg-rules">
        <li>{t('fgPrivRule1')}</li>
        <li>{t('fgPrivRule2')}</li>
        <li>{t('fgPrivRule3')}</li>
        <li>{t('fgPrivRule4')}</li>
      </ul>

      <div className="fg-card fg-card--danger">
        <h3>{t('fgDeleteAll')}</h3>
        <p>{t('fgDeleteAllExplain')}</p>
        {!confirming ? (
          <button ref={startRef} type="button" className="fg-btn fg-btn--danger" onClick={() => { setConfirming(true); setState('idle'); setFocusNext('cancel'); }}>
            {t('fgDeleteAll')}
          </button>
        ) : (
          <div className="fg-row">
            <button type="button" className="fg-btn fg-btn--danger-solid" disabled={state === 'deleting'} onClick={deleteAll}>
              {state === 'deleting' ? t('fgSaving') : t('fgDeleteAllConfirm')}
            </button>
            <button ref={cancelRef} type="button" className="fg-btn" disabled={state === 'deleting'} onClick={() => { setConfirming(false); setFocusNext('start'); }}>{t('fgCancel')}</button>
          </div>
        )}
        {state === 'done' && <p ref={statusRef} tabIndex={-1} className="fg-ok" role="status">{t('fgDeletedAll')}</p>}
        {state === 'error' && <p ref={statusRef} tabIndex={-1} className="error" role="alert">{err}</p>}
      </div>
    </section>
  );
}
