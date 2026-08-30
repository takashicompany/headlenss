import { useEffect, useState } from 'react';
import { SessionView } from './SessionView.tsx';
import { ChatView } from './ChatView.tsx';
import { PreviewView } from './PreviewView.tsx';
import { SessionTabs, useWebTabs, type Mode } from './SessionTabs.tsx';

// 1 セッションぶんの画面。tmux / chat / 登録タブ (プレビュー) を切り替える。
//
// tmux と chat は従来どおり排他でマウントする (WebSocket と xterm を二重に持たない)。
// プレビューだけは一度開いたら DOM に残し、display:none で隠す — iframe の中身
// (スクロール位置・入力途中・PWA の状態) を失わないため。
//
// タブ一覧の取得はこの層に 1 つだけ持つ。ヘッダのタブ帯は 3 つの画面が同じものを
// 共有するので、画面を切り替えても取り直しにならない。

export function SessionPane({
  sessionName,
  mode,
  tab,
  onBack,
  onSwitchMode,
}: {
  sessionName: string;
  mode: Mode;
  /** URL の `tab=` (mode が preview のときだけ意味を持つ) */
  tab: string | null;
  onBack: () => void;
  onSwitchMode: (mode: Mode, tab?: string) => void;
}) {
  const { tabs, loaded, refresh } = useWebTabs(sessionName);
  // 一度でも開いたタブ。iframe を残す対象 (ブラウザのタブと同じ扱い)
  const [opened, setOpened] = useState<string[]>([]);

  const activeTab = mode === 'preview' ? tab : null;

  useEffect(() => {
    if (activeTab === null) return;
    setOpened((prev) => (prev.includes(activeTab) ? prev : [...prev, activeTab]));
  }, [activeTab]);

  const modeTabs = (
    <SessionTabs
      mode={mode}
      activeTab={activeTab}
      tabs={tabs}
      onSwitchMode={(m) => onSwitchMode(m)}
      onSwitchTab={(name) => onSwitchMode('preview', name)}
    />
  );

  return (
    <>
      {mode === 'tmux' && (
        <SessionView sessionName={sessionName} onBack={onBack} modeTabs={modeTabs} />
      )}
      {mode === 'chat' && (
        <ChatView sessionName={sessionName} onBack={onBack} modeTabs={modeTabs} />
      )}
      {(mode === 'preview' || opened.length > 0) && (
        <PreviewView
          sessionName={sessionName}
          tabs={tabs}
          activeTab={activeTab}
          opened={opened}
          loaded={loaded}
          hidden={mode !== 'preview'}
          onBack={onBack}
          onRefresh={refresh}
          modeTabs={modeTabs}
        />
      )}
    </>
  );
}
