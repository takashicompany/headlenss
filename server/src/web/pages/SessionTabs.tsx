import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../i18n.tsx';

// セッション画面のタブ帯。`tmux | chat | <登録タブ...>` を 1 本に並べる。
//
// 登録タブは、セッションの作業フォルダの .headlenss-plugins.conf に書かれたもの
// (サーバ側 web-preview.ts が /api/sessions/<name>/webtabs で返す)。
// 見た目は従来のモード切替トグル (.mode-toggle) をそのまま伸ばしたもので、
// 登録が 0 件なら以前と同じ 2 ボタンの帯になる。

export type Mode = 'tmux' | 'chat' | 'preview';

export type WebTab = {
  /** 宣言ファイルに書かれた表示名。タブの見出しであり URL の `tab=` の値でもある */
  name: string;
  /** 'file' = 作業フォルダの中の HTML (headlenss が配信) / 'url' = dev server などの外部 URL */
  kind: 'url' | 'file';
  url: string;
};

/** タブ一覧のポーリング間隔。エージェントが成果物を足したら程なく現れればよい。 */
const POLL_MS = 30_000;

export type WebTabsState = {
  tabs: WebTab[];
  /** 1 度でも取得が終わったか (取得前に「タブが無い」と判断しないため) */
  loaded: boolean;
  /** 手動での再取得。プレビューの再読込ボタンから呼ぶ (?v=<mtime> を取り直す) */
  refresh: () => Promise<void>;
};

export function useWebTabs(sessionName: string): WebTabsState {
  const [tabs, setTabs] = useState<WebTab[]>([]);
  const [loaded, setLoaded] = useState(false);
  // 中身が変わっていないときに再描画しない (iframe の載せ替えを起こさないため)
  const sigRef = useRef<string>('');
  const disposedRef = useRef(false);

  const fetchTabs = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/webtabs`);
      if (!res.ok) return;
      const json = (await res.json()) as { tabs?: WebTab[] };
      const next = Array.isArray(json.tabs) ? json.tabs : [];
      if (disposedRef.current) return;
      const sig = JSON.stringify(next);
      if (sig !== sigRef.current) {
        sigRef.current = sig;
        setTabs(next);
      }
    } catch {
      /* 一時的な失敗は次のポーリングで回復する */
    } finally {
      if (!disposedRef.current) setLoaded(true);
    }
  }, [sessionName]);

  useEffect(() => {
    disposedRef.current = false;
    void fetchTabs();
    const timer = setInterval(() => void fetchTabs(), POLL_MS);
    return () => {
      disposedRef.current = true;
      clearInterval(timer);
    };
  }, [fetchTabs]);

  return { tabs, loaded, refresh: fetchTabs };
}

export function SessionTabs({
  mode,
  activeTab,
  tabs,
  onSwitchMode,
  onSwitchTab,
}: {
  mode: Mode;
  activeTab: string | null;
  tabs: WebTab[];
  onSwitchMode: (m: Mode) => void;
  onSwitchTab: (name: string) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="mode-toggle" role="group" aria-label={t('viewMode')}>
      <button
        type="button"
        className={`mode-toggle-btn${mode === 'tmux' ? ' active' : ''}`}
        onClick={() => onSwitchMode('tmux')}
        aria-pressed={mode === 'tmux'}
      >
        tmux
      </button>
      <button
        type="button"
        className={`mode-toggle-btn${mode === 'chat' ? ' active' : ''}`}
        onClick={() => onSwitchMode('chat')}
        aria-pressed={mode === 'chat'}
      >
        chat
      </button>
      {tabs.map((tab) => {
        const on = mode === 'preview' && activeTab === tab.name;
        return (
          <button
            key={tab.name}
            type="button"
            className={`mode-toggle-btn mode-toggle-btn--web${on ? ' active' : ''}`}
            onClick={() => onSwitchTab(tab.name)}
            aria-pressed={on}
            title={tab.name}
          >
            {tab.name}
          </button>
        );
      })}
    </div>
  );
}
