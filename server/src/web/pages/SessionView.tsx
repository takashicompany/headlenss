import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { extractImagesFromClipboard, filterImageFiles, uploadImage } from '../uploads.ts';
import { useLanguage } from '../i18n.tsx';

// 新WSプロトコル (server/pty.ts と対応):
//   client → server: { type: 'attach', cols, rows } / { type: 'input', data } /
//                    { type: 'resize', cols, rows } / { type: 'refresh' }
//   server → client: { type: 'screen', serialized } / { type: 'output', data } /
//                    { type: 'attached', cols, rows } / { type: 'exit', code }

type ServerMsg =
  | { type: 'screen'; serialized: string }
  | { type: 'output'; data: string }
  | { type: 'attached'; cols: number; rows: number }
  | { type: 'exit'; code: number };

type Mode = 'tmux' | 'chat';

export function SessionView({
  sessionName,
  onBack,
  onSwitchMode,
}: {
  sessionName: string;
  onBack: () => void;
  onSwitchMode: (m: Mode) => void;
}) {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  // 「この画面に合わせる」ボタンが呼ぶ実体。useEffect 内で確定する。
  const refitRef = useRef<(() => void) | null>(null);
  // PTY に文字列を送る関数の参照。ペースト/アップロードハンドラから呼ぶため。
  const sendInputRef = useRef<((data: string) => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // pty WebSocket がサーバから 4404 (session not found) で閉じられた時に立てる。
  // 立つと reconnect ループを止めて「セッションが無い」UI を出す。
  const [sessionMissing, setSessionMissing] = useState(false);

  // 画像をアップロード → 取得した path を `@path ` として PTY に流し込む。
  // Claude Code の TUI が `@/path/to/file.png` を画像参照として解釈する。
  const handleImageFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const f of files) {
        try {
          const r = await uploadImage(f);
          sendInputRef.current?.(`@${r.path} `);
        } catch (e) {
          setUploadError(`${t('uploadFailedPrefix')}: ${(e as Error).message}`);
        }
      }
    } finally {
      setUploading(false);
    }
  }, [t]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: '#0e0e10',
        foreground: '#e6e6e6',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    // xterm.js v5.5.0 は .xterm root に touchstart/touchmove を {passive:false} で attach し、
    // touchmove で preventDefault() を呼んで iOS のネイティブ慣性スクロールを殺している。
    // capture 段階で stopImmediatePropagation して xterm の内部ハンドラに届かせない。
    const xtermRoot = container.querySelector('.xterm') as HTMLElement | null;
    const swallowTouch = (e: Event) => e.stopImmediatePropagation();
    if (xtermRoot) {
      xtermRoot.addEventListener('touchstart', swallowTouch, { capture: true, passive: true });
      xtermRoot.addEventListener('touchmove', swallowTouch, { capture: true, passive: true });
      xtermRoot.addEventListener('touchend', swallowTouch, { capture: true, passive: true });
      xtermRoot.addEventListener('touchcancel', swallowTouch, { capture: true, passive: true });
    }

    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // 履歴を遡っている間は新規出力で勝手に最下部に飛ばないようにするフラグ。
    // .xterm-viewport の native scroll → xterm 内部 _handleScroll → onScroll で追従する。
    let userScrolledUp = false;
    const onScrollDisp = term.onScroll(() => {
      const buf = term.buffer.active;
      userScrolledUp = buf.viewportY < buf.baseY;
    });

    // Shift+Enter: bracketed paste で改行をペースト扱いに包んで送る (split-end と同じ)。
    //   Claude Code を含む多くの TUI 入力欄が DECSET 2004 を有効にしており、
    //   \x1b[200~ ... \x1b[201~ で囲まれた中身は「ペースト」として扱われ submit されない。
    //   xterm.js は customKeyEventHandler で return false しても直後に Enter のデフォルト
    //   バイト (\r) を別パスから onData に流すケースがあるため、ガード変数で1回だけ握り潰す。
    term.attachCustomKeyEventHandler((event) => {
      if (event.key === 'Enter' && event.shiftKey && event.type === 'keydown') {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: '\x1b[200~\n\x1b[201~' }));
        }
        armSuppress();
        return false;
      }
      return true;
    });

    const sendInput = (data: string) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    };
    sendInputRef.current = sendInput;
    const sendResize = (cols: number, rows: number) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    };

    // customKeyEventHandler が Shift+Enter で `return false` しても、xterm.js の
    // 後続パスで Enter のデフォルト byte (\r) が onData に流れてしまうため、
    // 次の1回だけ \r/\n を握り潰すフラグを介在させる。
    let suppressNextEnter = false;
    let suppressTimer: ReturnType<typeof setTimeout> | null = null;
    const armSuppress = () => {
      suppressNextEnter = true;
      if (suppressTimer) clearTimeout(suppressTimer);
      // 50ms 以内に onData が来なければ抑止解除 (誤抑止防止)
      suppressTimer = setTimeout(() => { suppressNextEnter = false; }, 50);
    };

    const onDataDisp = term.onData((data) => {
      if (suppressNextEnter && (data === '\r' || data === '\n' || data === '\r\n')) {
        suppressNextEnter = false;
        if (suppressTimer) { clearTimeout(suppressTimer); suppressTimer = null; }
        return;
      }
      suppressNextEnter = false;
      sendInput(data);
    });
    const onResizeDisp = term.onResize(({ cols, rows }) => sendResize(cols, rows));

    const fitAndPushSize = () => {
      try {
        fit.fit();
        sendResize(term.cols, term.rows);
      } catch { /* ignore intermittent layout errors */ }
    };

    const openWs = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${window.location.host}/api/sessions/${encodeURIComponent(sessionName)}/pty`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (disposed) { ws?.close(); return; }
        ws!.send(JSON.stringify({ type: 'attach', cols: term.cols, rows: term.rows }));
        term.focus();
      };

      ws.onmessage = (ev) => {
        let msg: ServerMsg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMsg; }
        catch { return; }
        switch (msg.type) {
          case 'screen': {
            // 再接続時 / 初回接続時に画面まるごと復元
            term.reset();
            term.write(msg.serialized, () => {
              if (!userScrolledUp) term.scrollToBottom();
            });
            break;
          }
          case 'output': {
            term.write(msg.data, () => {
              if (!userScrolledUp) term.scrollToBottom();
            });
            break;
          }
          case 'attached':
            // 確定サイズで即時 fit
            requestAnimationFrame(() => fitAndPushSize());
            // モード切替直後 (chat → tmux) などで初回 screen が空 / 不完全だった
            // ケースの保険として、少し遅らせて「⟳ fit ボタンを押したのと同じ動作」を
            // 自動実行: fit + resize 通知 + refresh で最新画面を取り直す。
            setTimeout(() => {
              if (disposed) return;
              refitRef.current?.();
            }, 400);
            break;
          case 'exit':
            term.write(`\r\n\x1b[33m[session exited: ${msg.code}]\x1b[0m\r\n`);
            break;
        }
      };

      ws.onclose = (event) => {
        if (disposed) return;
        // 4404 = サーバ側で tmux にセッションが無いと判定して閉じられた。
        // auto-create 設計を廃止したのでこの code が来たら reconnect しない。
        if (event.code === 4404) {
          setSessionMissing(true);
          return;
        }
        term.write('\r\n\x1b[31m[disconnected — retrying…]\x1b[0m\r\n');
        reconnectTimer = setTimeout(() => { if (!disposed) openWs(); }, 1500);
      };

      ws.onerror = () => {
        // onclose が続けて呼ばれるので再接続はそちらで
      };
    };

    openWs();

    const onWindowResize = () => fitAndPushSize();
    window.addEventListener('resize', onWindowResize);
    const ro = new ResizeObserver(() => fitAndPushSize());
    ro.observe(container);

    // ペースト時に画像が含まれていたらアップロードして @path を PTY に送る。
    // capture phase で xterm より先に拾う。テキストオンリーなら何もしないので
    // xterm の通常ペースト動作はそのまま。
    const onContainerPaste = (e: ClipboardEvent) => {
      const cd = e.clipboardData;
      if (!cd) return;
      const images = extractImagesFromClipboard(cd.items);
      if (images.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      void handleImageFiles(images);
    };
    container.addEventListener('paste', onContainerPaste, true);

    // ドラッグ&ドロップ
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.items).some((it) => it.kind === 'file')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const images = filterImageFiles(e.dataTransfer.files);
      if (images.length === 0) return;
      e.preventDefault();
      void handleImageFiles(images);
    };
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('drop', onDrop);

    // visualViewport.height を CSS 変数 --vvh に同期。
    // スマホでソフトウェアキーボードが出た時に xterm 表示領域をその上の可視領域だけに縮める。
    // デスクトップでは visualViewport.height = innerHeight なので影響なし。
    const syncVVH = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--vvh', `${h}px`);
      requestAnimationFrame(() => fitAndPushSize());
    };
    syncVVH();
    window.visualViewport?.addEventListener('resize', syncVVH);
    window.visualViewport?.addEventListener('scroll', syncVVH);

    // 「この画面に合わせる」ボタン用の実体。
    // tmux ペインは1サイズしか持てないので、複数クライアント (PC/スマホ) で
    // 同時接続している時は最後に resize した方が勝つ。今見ているクライアントで
    // 明示的に fit + resize + refresh を打って自分のサイズに揃え直す。
    const refit = () => {
      fitAndPushSize();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'refresh' }));
      }
    };
    refitRef.current = refit;

    // タブが visible になった時 / ウィンドウに focus が戻った時に自動 refit。
    // 別端末/別タブからこのページに切り替えた瞬間、自分のサイズで tmux を
    // 取り戻して最新画面を取得する。手動の fit ボタンと同じ動作。
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refit();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', refit);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener('resize', onWindowResize);
      window.visualViewport?.removeEventListener('resize', syncVVH);
      window.visualViewport?.removeEventListener('scroll', syncVVH);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', refit);
      document.documentElement.style.removeProperty('--vvh');
      refitRef.current = null;
      sendInputRef.current = null;
      container.removeEventListener('paste', onContainerPaste, true);
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('drop', onDrop);
      ro.disconnect();
      if (xtermRoot) {
        xtermRoot.removeEventListener('touchstart', swallowTouch, { capture: true } as EventListenerOptions);
        xtermRoot.removeEventListener('touchmove', swallowTouch, { capture: true } as EventListenerOptions);
        xtermRoot.removeEventListener('touchend', swallowTouch, { capture: true } as EventListenerOptions);
        xtermRoot.removeEventListener('touchcancel', swallowTouch, { capture: true } as EventListenerOptions);
      }
      onScrollDisp.dispose();
      onDataDisp.dispose();
      onResizeDisp.dispose();
      ws?.close();
      term.dispose();
    };
  }, [sessionName]);

  return (
    <div className="page-session">
      <header className="session-header">
        <button onClick={onBack} aria-label={t('back')}>
          {t('back')}
        </button>
        <span className="session-title">{sessionName}</span>
        <button
          type="button"
          className="session-attach"
          onClick={() => fileInputRef.current?.click()}
          aria-label={t('attachImage')}
          title={t('attachImageTitleDnd')}
          disabled={uploading}
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) {
              void handleImageFiles(filterImageFiles(e.target.files));
            }
            e.target.value = '';
          }}
        />
        <button
          className="session-refit"
          onClick={() => refitRef.current?.()}
          aria-label={t('fitToScreen')}
          title={t('fitToScreenTitle')}
        >
          ⟳ fit
        </button>
        <div className="mode-toggle" role="group" aria-label={t('viewMode')}>
          <button
            type="button"
            className="mode-toggle-btn active"
            aria-pressed={true}
          >
            tmux
          </button>
          <button
            type="button"
            className="mode-toggle-btn"
            onClick={() => onSwitchMode('chat')}
            aria-pressed={false}
          >
            chat
          </button>
        </div>
      </header>
      <div ref={containerRef} className="terminal-container" />
      {sessionMissing && (
        <div className="session-missing">
          <p>{t('sessionMissingPrefix')}<code>{sessionName}</code>{t('sessionMissingSuffix')}</p>
          <p>{t('sessionMissingHint')}</p>
          <button type="button" onClick={onBack}>{t('backToList')}</button>
        </div>
      )}
      {uploadError && <div className="chat-error">{uploadError}</div>}
    </div>
  );
}
