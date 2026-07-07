import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

// Web UI の i18n。en を基本とし ja を併記する。
// 言語は localStorage に永続化し、セッション一覧画面の言語切替 UI から変更する。

export type Language = 'en' | 'ja';

const STORAGE_KEY = 'headlenss_web_lang';

const STRINGS = {
  // ── 共通 ──
  back:                   { en: '← Back',  ja: '← 戻る' },
  viewMode:               { en: 'View mode', ja: '表示モード' },
  attachImage:            { en: 'Attach image', ja: '画像を添付' },

  // ── SessionList ──
  appSubtitle:            { en: 'tmux sessions', ja: 'tmux セッション' },
  newSession:             { en: '+ new', ja: '+ 新規' },
  sessionNamePlaceholder: { en: 'session name', ja: 'セッション名' },
  sessionNameRule:        { en: 'Use only half-width letters, numbers, hyphens (-) and underscores (_). Max 40 characters. (Japanese and spaces are not allowed.)',
                            ja: '半角の英数字・ハイフン (-)・アンダースコア (_) のみ使えます。最大 40 文字です。(日本語やスペースは使えません)' },
  loading:                { en: 'loading...', ja: '読み込み中...' },
  noSessions:             { en: 'no sessions yet', ja: 'セッションがありません' },
  windowUnit:             { en: 'window', ja: 'ウィンドウ' },
  windowUnitPlural:       { en: 'windows', ja: 'ウィンドウ' },
  attached:               { en: 'attached', ja: '接続中' },
  language:               { en: 'Language', ja: '言語' },
  ccBusy:                 { en: 'running', ja: '実行中' },
  ccIdle:                 { en: 'idle', ja: '待機' },
  ccWaitingPermission:    { en: 'awaiting permission', ja: '承認待ち' },
  ccWaitingQuestion:      { en: 'awaiting answer', ja: '質問待ち' },
  starSession:            { en: 'Star session', ja: 'スターをつける' },
  unstarSession:          { en: 'Unstar session', ja: 'スターを外す' },
  codexHooksMissing:      { en: 'Codex hooks missing', ja: 'Codex hook 未導入' },
  codexHooksIncomplete:   { en: 'Codex hooks incomplete', ja: 'Codex hook 不完全' },
  codexHooksNeedTrust:    { en: 'Codex hooks need trust', ja: 'Codex hook 要確認' },
  releasedSession:        { en: 'released', ja: '解放済み' },
  releaseSession:         { en: 'Release tmux', ja: 'tmux を解放' },
  renameSession:          { en: 'Rename session', ja: 'セッション名を変更' },
  manualOrder:            { en: 'Manual order', ja: '手動並び替え' },
  moveUp:                 { en: 'Move up', ja: '上へ移動' },
  moveDown:               { en: 'Move down', ja: '下へ移動' },

  // ── ChatView: origin / agent labels ──
  originExternal:         { en: 'EXTERNAL', ja: '外部入力' },

  // ── ChatView: status / empty ──
  statusBusy:             { en: 'Agent is thinking', ja: 'エージェントが考えています' },
  statusWaitingPermission:{ en: 'Agent is waiting for permission', ja: 'エージェントが許可を待っています' },
  statusWaitingQuestion:  { en: 'Agent is waiting for an answer', ja: 'エージェントが質問を待っています' },
  chatEmpty:              { en: 'No messages yet.', ja: 'まだ会話がありません。' },
  showOlderMessages:      { en: 'Show older messages', ja: '過去のメッセージを表示' },
  hiddenMessagesCount:    { en: 'older messages hidden', ja: '件の過去メッセージを非表示中' },
  scrollToBottom:         { en: 'Scroll to bottom', ja: '一番下へスクロール' },
  codexHooksMissingTitle: { en: 'Codex hooks are not installed', ja: 'Codex hook が未導入です' },
  codexHooksIncompleteTitle:{ en: 'Codex hooks are incomplete', ja: 'Codex hook が不完全です' },
  codexHooksNeedTrustTitle:{ en: 'Codex hooks may need review', ja: 'Codex hook の確認が必要かもしれません' },
  codexHooksNeedTrustBody:{ en: 'Restart Codex and run /hooks to review and trust the HeadLenss hooks.', ja: 'Codex を再起動し、/hooks で HeadLenss hook を確認して trust してください。' },
  codexHooksMissingEvents:{ en: 'Missing events', ja: '不足イベント' },

  // ── ChatView: question / pending ──
  confirmCancelTitle:     { en: 'Confirm question cancellation', ja: '質問のキャンセル確認' },
  confirmAnswersTitle:    { en: 'Review your answers', ja: '回答内容の確認' },
  summaryChatAbout:       { en: '→ (Chat about this selected → question cancelled)',
                            ja: '→ (Chat about this を選択 → 質問キャンセル)' },
  freeTextParen:          { en: '(free text)', ja: '(自由記述)' },
  unanswered:             { en: '(unanswered)', ja: '(未回答)' },
  notePrefix:             { en: ' /note: ', ja: ' /補足: ' },
  sendingEllipsis:        { en: 'Sending…', ja: '送信中…' },
  sendCancellation:       { en: 'Send cancellation', ja: 'キャンセル送信' },
  send:                   { en: 'Send', ja: '送信' },
  unansweredRemain:       { en: 'Unanswered remain', ja: '未回答あり' },
  questionFromClaude:     { en: 'Question from agent', ja: 'エージェントからの質問' },
  multiSelectBadge:       { en: ' Multi-select', ja: ' 複数選択可' },
  notesPlaceholder:       { en: 'Optional note. Sent to Claude along with your choice.',
                            ja: '補足メモ (任意)。選んだ選択肢と一緒に Claude に届きます。' },
  typeSomethingBtn:       { en: '✎ Type something', ja: '✎ Type something(自由記述で答える)' },
  freeTextLabel:          { en: 'Free text', ja: '自由記述' },
  freeTextPlaceholder:    { en: 'Type your answer', ja: '自由記述してください' },
  cancelFreeText:         { en: 'Cancel free text and return to options',
                            ja: '自由記述をやめて選択肢に戻る' },
  chatAboutConfirm:       { en: 'Choosing "Chat about this" cancels the whole AskUserQuestion and switches to free conversation. Continue?',
                            ja: 'Chat about this を選ぶと、AskUserQuestion 全体がキャンセルされて自由対話に切り替わります。続けますか?' },
  chatAboutBtn:           { en: '💬 Chat about this', ja: '💬 Chat about this(質問をキャンセルして自由対話)' },
  toReview:               { en: 'To review →', ja: '確認へ →' },
  next:                   { en: 'Next →', ja: '次へ →' },
  permRequestTitle:       { en: 'Permission request from agent', ja: 'エージェントからの許可リクエスト' },
  permMessagePlaceholder: { en: 'Message (optional)', ja: 'メッセージ (任意)' },
  allow:                  { en: 'Allow', ja: '許可' },
  deny:                   { en: 'Deny', ja: '拒否' },

  // ── ChatView: errors ──
  sendErrorPrefix:        { en: 'Send error', ja: '送信エラー' },
  uploadFailedPrefix:     { en: 'Upload failed', ja: 'アップロード失敗' },
  respondFailedPrefix:    { en: 'Failed to send response', ja: '応答送信失敗' },
  unansweredQuestions:    { en: 'There are unanswered questions', ja: '未回答の質問があります' },

  // ── ChatView: input ──
  uploadingEllipsis:      { en: 'Uploading…', ja: 'アップロード中…' },
  messageInputPlaceholder:{ en: 'Type a message (PC: Enter to send / Shift+Enter for newline; mobile: use the send button)',
                            ja: 'メッセージを入力 (PCはEnter送信/Shift+Enter改行、スマホは送信ボタン)' },
  attachImageTitlePaste:  { en: 'Attach image (paste also works)', ja: '画像を添付 (ペーストもOK)' },

  // ── Split view ──
  splitView:              { en: 'Split view', ja: '分割表示' },
  splitViewHint:          { en: 'Select a session from the list', ja: 'リストからセッションを選択してください' },

  // ── SessionView ──
  attachImageTitleDnd:    { en: 'Attach image (paste, drag & drop also work)',
                            ja: '画像を添付 (ペースト・ドラッグ&ドロップもOK)' },
  fitToScreen:            { en: 'Fit to screen', ja: 'この画面に合わせる' },
  fitToScreenTitle:       { en: 'Re-fit the display to this screen size',
                            ja: 'この画面サイズに合わせて表示し直す' },
  sessionMissingPrefix:   { en: 'tmux session ', ja: 'tmux セッション ' },
  sessionMissingSuffix:   { en: ' does not exist.', ja: ' は存在しません。' },
  sessionMissingHint:     { en: 'Create it from the session list page first.',
                            ja: '先にセッション一覧画面で作成してください。' },
  backToList:             { en: '← back to list', ja: '← 一覧に戻る' },
} as const;

export type StringKey = keyof typeof STRINGS;

function resolveInitialLanguage(): Language {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'en' || v === 'ja') return v;
  } catch {
    /* localStorage 不可環境はデフォルトに落とす */
  }
  return 'en';
}

type LanguageContextValue = {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: StringKey) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(resolveInitialLanguage);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* 永続化できなくても画面上の切替は有効 */
    }
  }, []);

  const t = useCallback((key: StringKey): string => STRINGS[key][language], [language]);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within LanguageProvider');
  return ctx;
}

export const LANGUAGE_LABELS: Record<Language, string> = {
  en: 'English',
  ja: '日本語',
};
