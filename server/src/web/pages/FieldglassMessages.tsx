import { useRef, useState } from 'react';
import { useLanguage, type StringKey } from '../i18n.tsx';
import { ApiError, fieldglassApi, serverAlive, type MessageThread, type MessagesStatus, type ThreadMessage } from '../fieldglass/api.ts';
import { fmt, preview, splitSteps, toMs, unreadCount } from '../fieldglass/helpers.ts';
import { LoadError, Steps, timeLabel, useLoad , useErrorText } from './FieldglassShared.tsx';

const SEND_LABEL: Record<MessagesStatus['canSend'], { key: StringKey; cls: string }> = {
  yes: { key: 'fgMsgSendYes', cls: 'fg-pill--ok' },
  unknown: { key: 'fgMsgSendUnknown', cls: '' },
  denied: { key: 'fgMsgSendDenied', cls: 'fg-pill--warn' },
};
const BUILTIN_STEPS: StringKey[] = ['fgMsgStep1', 'fgMsgStep2', 'fgMsgStep3', 'fgMsgStep4', 'fgMsgStep5'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The exact node path, selectable, with a Copy button that also works on plain-http tailnet pages. */
function NodePath({ path }: { path: string }) {
  const { t } = useLanguage();
  const errorText = useErrorText();
  const ref = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<'' | 'ok' | 'manual'>('');
  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(path);
      } else {
        ref.current?.select();
        if (!document.execCommand('copy')) throw new Error('copy refused');
      }
      setCopied('ok');
    } catch {
      ref.current?.select();
      setCopied('manual');
    }
  };
  return (
    <div className="fg-nodepath">
      <span className="fg-label">{t('fgMsgNodePath')}</span>
      <div className="fg-row fg-row--nowrap">
        <input
          ref={ref}
          className="fg-input fg-code"
          readOnly
          value={path}
          aria-label={t('fgMsgNodePath')}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
        />
        <button type="button" className="fg-btn" onClick={copy}>{copied === 'ok' ? t('fgCopied') : t('fgCopy')}</button>
      </div>
      {copied === 'manual' && <span className="muted fg-small">{t('fgCopyManual')}</span>}
      <span className="muted fg-small">{t('fgMsgNodePathTip')}</span>
    </div>
  );
}

function RestartButton({ onBack }: { onBack: () => void }) {
  const { t } = useLanguage();
  const errorText = useErrorText();
  const [state, setState] = useState<'idle' | 'confirm' | 'restarting' | 'done' | 'slow' | 'error'>('idle');
  const [err, setErr] = useState('');

  const restart = async () => {
    setState('restarting');
    try {
      await fieldglassApi.restartServer();
    } catch (e) {
      // A dropped connection (TypeError) is expected as the server goes down; only an HTTP error response is a failure.
      if (e instanceof ApiError) {
        setErr(errorText(e, 'fgErrRestart'));
        setState('error');
        return;
      }
    }
    // Wait for it to go away (or 5 s, if the restart was quicker than our polling), then come back.
    const started = Date.now();
    let sawDown = false;
    while (Date.now() - started < 60_000) {
      await sleep(1500);
      const up = await serverAlive();
      if (!up) sawDown = true;
      else if (sawDown || Date.now() - started > 5000) {
        setState('done');
        onBack();
        return;
      }
    }
    setState('slow');
  };

  return (
    <div className="fg-restart">
      <p className="muted fg-small">{t('fgRestartNote')}</p>
      {state === 'idle' || state === 'done' || state === 'slow' || state === 'error' ? (
        <button type="button" className="fg-btn" onClick={() => setState('confirm')}>↻ {t('fgRestart')}</button>
      ) : state === 'confirm' ? (
        <div className="fg-row">
          <button type="button" className="fg-btn fg-btn--primary" onClick={restart}>{t('fgRestartConfirm')}</button>
          <button type="button" className="fg-btn" onClick={() => setState('idle')}>{t('fgCancel')}</button>
        </div>
      ) : (
        <div className="fg-note fg-progress" role="status">
          <span className="fg-spinner" aria-hidden="true" />
          <span>{t('fgRestarting')}</span>
        </div>
      )}
      {state === 'done' && <p className="fg-ok" role="status">{t('fgRestartDone')}</p>}
      {state === 'slow' && <p className="error" role="alert">{t('fgRestartSlow')}</p>}
      {state === 'error' && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

function ThreadRow({ th }: { th: MessageThread }) {
  const { t, language } = useLanguage();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<ThreadMessage[] | null>(null);
  const [err, setErr] = useState('');
  const unread = unreadCount(th.unread);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !msgs) {
      try {
        setMsgs((await fieldglassApi.messageThread(th.id)).messages);
      } catch (e) {
        setErr(errorText(e, 'fgLoadError'));
      }
    }
  };

  return (
    <li className={`fg-card fg-thread${unread ? ' fg-thread--unread' : ''}`}>
      <div className="fg-event-head">
        <span className="fg-event-title">{th.name}</span>
        <span className="fg-row">
          {th.isGroup && <span className="fg-pill">{t('fgMsgGroup')}</span>}
          {th.canReply === false && <span className="fg-pill fg-pill--warn" title={th.readOnlyReason}>{t('fgMsgReadOnly')}</span>}
          {th.service && <span className="fg-pill">{th.service}</span>}
          {unread > 0 && <span className="fg-pill fg-pill--accent">{fmt(t('fgMsgUnread'), { n: unread })}</span>}
        </span>
      </div>
      <div className="fg-thread-last">
        <span className="fg-thread-text">{preview(th.lastText) || t('fgMsgAttachment')}</span>
        <span className="muted fg-small">{timeLabel(toMs(th.lastAt), language)}</span>
      </div>
      {th.canReply === false && th.readOnlyReason && <p className="muted fg-small">{th.readOnlyReason}</p>}
      <button type="button" className="fg-link fg-small" aria-expanded={open} onClick={toggle}>
        {open ? t('fgMsgHide') : t('fgMsgShow')}
      </button>
      {open && (
        <div className="fg-bubbles">
          {err && <p className="error">{err}</p>}
          {!msgs && !err && <p className="muted">{t('fgLoading')}</p>}
          {msgs?.map((m) => (
            <div key={m.id} className={`fg-bubble${m.fromMe ? ' fg-bubble--me' : ''}`}>
              {!m.fromMe && th.isGroup && <span className="fg-bubble-from">{m.sender}</span>}
              {m.fromMe && <span className="fg-bubble-from">{t('fgMsgYou')}</span>}
              <span className="fg-bubble-text">{m.text || t('fgMsgAttachment')}</span>
              <span className="fg-bubble-at">{timeLabel(toMs(m.at), language)}</span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

export function FieldglassMessages() {
  const { t } = useLanguage();
  const errorText = useErrorText();
  const status = useLoad(fieldglassApi.messagesStatus);
  const threads = useLoad(async () => {
    // Only ask for threads once reading works, so a locked-down Mac doesn't log failed reads.
    const s = await fieldglassApi.messagesStatus();
    return s.canRead ? (await fieldglassApi.messageThreads()).threads : null;
  });
  const [checking, setChecking] = useState(false);

  const checkAgain = async () => {
    setChecking(true);
    await Promise.all([status.reload(), threads.reload()]);
    setChecking(false);
  };

  if (status.loading && !status.data) return <p className="muted">{t('fgLoading')}</p>;
  if (status.error && !status.data) return <LoadError error={status.error} onRetry={status.reload} />;
  const s = status.data;
  if (!s) return null;

  const allSet = s.canRead && s.canSend === 'yes';
  const { steps, notes } = s.steps?.length ? splitSteps(s.steps) : { steps: BUILTIN_STEPS.map((k) => t(k)), notes: [] };
  const send = SEND_LABEL[s.canSend] ?? SEND_LABEL.unknown;

  return (
    <section className="fg-section">
      <p>{t('fgMsgIntro')}</p>
      <div className="fg-toolbar">
        <span />
        <button type="button" className="fg-btn" onClick={checkAgain} disabled={checking}>
          {checking ? t('fgChecking') : t('fgCheckAgain')}
        </button>
      </div>

      <div className="fg-card">
        <div className="fg-event-head">
          <span>{t('fgMsgRead')}</span>
          <span className={`fg-pill ${s.canRead ? 'fg-pill--ok' : 'fg-pill--warn'}`}>{t(s.canRead ? 'fgMsgReadOk' : 'fgMsgReadNo')}</span>
        </div>
        <div className="fg-event-head">
          <span>{t('fgMsgSend')}</span>
          <span className={`fg-pill ${send.cls}`}>{t(send.key)}</span>
        </div>
        {allSet && <p className="fg-ok">{t('fgMsgAllSet')}</p>}
      </div>

      <details className="fg-card fg-howto" open={!s.canRead || s.canSend === 'denied'}>
        <summary><strong>{t('fgMsgSetup')}</strong></summary>
        <Steps steps={steps} />
        {s.nodePath && <NodePath path={s.nodePath} />}
        {notes.map((n, i) => <p key={i} className="muted fg-small">{n}</p>)}
        <RestartButton onBack={() => void checkAgain()} />
      </details>

      <h3 className="fg-h3">{t('fgMsgThreads')}</h3>
      {!s.canRead ? (
        <p className="muted">{t('fgMsgThreadsLocked')}</p>
      ) : threads.error && !threads.data ? (
        <LoadError error={threads.error} onRetry={threads.reload} />
      ) : !threads.data ? (
        <p className="muted">{t('fgLoading')}</p>
      ) : threads.data.length === 0 ? (
        <p className="muted">{t('fgMsgNoThreads')}</p>
      ) : (
        <>
          <p className="muted fg-small">{t('fgMsgThreadsHint')}</p>
          <ul className="fg-list">
            {threads.data.map((th) => <ThreadRow key={th.id} th={th} />)}
          </ul>
        </>
      )}
    </section>
  );
}
