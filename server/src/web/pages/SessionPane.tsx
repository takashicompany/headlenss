import { SessionView } from './SessionView.tsx';
import { ChatView } from './ChatView.tsx';
import { ModeToggle, type Mode } from './SessionTabs.tsx';

// 1 セッションぶんの画面。ヘッダの tmux / chat でどちらを出すかを決める。
//
// 登録タブ (成果物 / dev server) はチャットの中のタブなので、この層では扱わない
// (ChatView が画面下のタブ帯として持つ)。tmux の画面にはタブ帯を出さない。

export function SessionPane({
  sessionName,
  mode,
  tab,
  onBack,
  onSwitchMode,
}: {
  sessionName: string;
  mode: Mode;
  /** URL の `tab=` (mode が chat のときだけ意味を持つ)。null = チャットのタブ */
  tab: string | null;
  onBack: () => void;
  onSwitchMode: (mode: Mode, tab?: string | null) => void;
}) {
  const modeTabs = <ModeToggle mode={mode} onSwitchMode={(m) => onSwitchMode(m)} />;

  if (mode === 'chat') {
    return (
      <ChatView
        sessionName={sessionName}
        onBack={onBack}
        modeTabs={modeTabs}
        tab={tab}
        onSwitchTab={(name) => onSwitchMode('chat', name)}
      />
    );
  }
  return <SessionView sessionName={sessionName} onBack={onBack} modeTabs={modeTabs} />;
}
