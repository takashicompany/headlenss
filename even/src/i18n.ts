// 簡易 i18n。WebView 全体と G2 レンズ表示の双方が同じテーブルを参照する。
//   currentLanguage を切り替えると次回 t() 呼び出しから新言語が返る。
//   WebView はセレクタ変更時に applyTranslations() で全 data-i18n 要素を即時更新、
//   G2 はポーリング/イベントで refreshG2 が呼ばれた時に自然に切り替わる。

export type Language = 'en' | 'ja'

const STRINGS = {
  // ─── App ─────────────────────────────────────────────────────
  appName:        { en: 'HeadLenss',                            ja: 'HeadLenss' },
  appTagline:     { en: 'Voice control for coding agents',        ja: '音声でエージェントを動かす' },

  // ─── Onboarding ──────────────────────────────────────────────
  step1of2:       { en: 'Step 1 / 2',                           ja: 'Step 1 / 2' },
  step2of2:       { en: 'Step 2 / 2',                           ja: 'Step 2 / 2' },
  ob1Title:       { en: 'Connect to your PC',                   ja: 'PC に接続' },
  ob1Desc:        { en: 'Paste the URL of the headlenss server running on your PC (shown in the terminal where you started it, e.g. http://<tailscale-ip>:3000).',
                    ja: 'PC で起動した headlenss server の URL を貼り付けてください。サーバ起動時にターミナルへ表示される URL (例: http://<tailscale-ip>:3000) です。' },
  ob1ProbeIdle:   { en: 'Auto-checks the URL as you type.',     ja: 'URL を入れると自動で確認します' },
  obNext:         { en: 'Next →',                               ja: '次へ →' },
  ob2Title:       { en: 'Speech-to-text key',                   ja: '音声認識キー' },
  ob2Desc:        { en: 'Speechmatics is used to transcribe your voice. Free up to 480 minutes per month.',
                    ja: '音声を文字に変換するために Speechmatics の API key を使います。月480分まで無料です。' },
  ob2GetKey:      { en: 'Get an API key →',                     ja: 'API key を取得 →' },
  obSmKeyPh:      { en: 'Paste API key',                        ja: 'API key を貼り付け' },
  obBack:         { en: '← Back',                               ja: '← 戻る' },
  obFinish:       { en: 'Start',                                ja: 'はじめる' },

  // ─── Top bar ─────────────────────────────────────────────────
  sessionLabel:   { en: '→ session',                            ja: '→ session' },

  // ─── Session pills (status messages) ─────────────────────────
  pillSetServerUrl:    { en: 'Set Server URL',                  ja: 'Server URL を設定してください' },
  pillServerDownPfx:   { en: 'Server unreachable: ',            ja: 'サーバ未接続: ' },
  pillNoSessions:      { en: 'No sessions. Create one below.',  ja: 'セッション無し。下から作成' },

  // ─── Probe (server URL check) ────────────────────────────────
  probeChecking:       { en: 'Checking…',                       ja: '確認中…' },
  probeUnreachablePfx: { en: "Can't connect: ",                 ja: '接続できません: ' },
  probeTyping:         { en: 'Typing…',                         ja: '入力中…' },

  // ─── G2 recording state ──────────────────────────────────────
  recConnecting:       { en: 'Connecting…',                     ja: '接続中…' },
  recStartedHint:      { en: 'Recording — please speak',        ja: '録音開始 — お話しください' },
  chatNoMsg:           { en: '(no messages yet)',               ja: '(まだ発言なし)' },
  chatLoading:         { en: 'Loading...',                      ja: '読み込み中...' },
  // Agent の動作状態を chat 末尾に出す待機行。サーバも同義の英語行を合成してくるが、
  // そちらは synthetic として捨て、表示はこのテーブルで行う (言語に追従させるため)。
  chatStatusThinking:  { en: '(thinking…)',                     ja: '(考え中…)' },
  chatStatusWaitPerm:  { en: '(awaiting permission…)',          ja: '(承認待ち…)' },
  chatStatusWaitQ:     { en: '(awaiting question…)',            ja: '(質問待ち…)' },
  // 送ったのにエージェントが受理した証拠 (フック) が期限内に来なかった時の注意。
  // tmux の画面が塞がっていると、キーは撃てても会話には入らない。
  chatDeliveryUnconfirmed: { en: '(!) It looks like your message did not arrive. Check the tmux screen.',
                             ja: '(!) 届いていないようです。tmux の画面を確認してください。' },
  rootListEmpty:       { en: '(no agent session)\n\nStart agent or Codex inside tmux',
                         ja: '(エージェントが動いている tmux が無い)\n\ntmux 内でエージェントを起動してください' },

  // ─── G2 cc-response (approve / answer) ───────────────────────
  approveTool:         { en: '⏸ Approve {name}',                ja: '⏸ {name} の承認' },
  multiBadge:          { en: ' [multi]',                        ja: ' [複数]' },
  // cc-message で本文を上限文字数で切り詰めた時に末尾へ出す省略表示
  ccMsgTruncated:      { en: '… (showing {shown} of {total} chars)',
                         ja: '… (全{total}文字中{shown}文字まで表示)' },
  submitOption:        { en: '> Submit',                        ja: '> Submit (確定)' },
  // 複数選択で 1 つも選ばれていない時、Submit 行に添える注意書き (押しても確定しない)
  submitNeedsPick:     { en: '(pick at least one)',             ja: '(1つ以上選択)' },
  voiceInputBadge:     { en: '(voice input)',                   ja: '(音声入力)' },
  // 応答の送信に失敗した時にフッターへ出す一時的な案内。回答は残したままなので再試行できる
  respondFailedRetry:  { en: 'Send failed — tap to retry',      ja: '送信に失敗 (タップで再試行)' },
  // キーを途中まで TUI に撃った後で用件が入れ替わり、打ち切られた場合。
  // 一部だけ届いている可能性があるので、送り直す前に端末側を確認してほしい
  respondInterrupted:  { en: 'Interrupted — may be partly sent', ja: '中断 (一部送信済みの可能性)' },
  // 送信が既定時間内に決着せず、入力ガードだけ先に解除した場合。届いたかは不明
  respondUnknownResult:{ en: 'Send result unknown — tap to retry', ja: '送信結果不明 (タップで再試行)' },

  // ─── New Agent session detection ────────────────────────────
  newClaudeDetecting:  { en: '(detecting…)',                    ja: '(検出中…)' },
  newClaudeWaitDetect: { en: '— Awaiting agent detection',     ja: '— エージェント検出待ち' },

  // ─── Claude Sessions list ────────────────────────────────────
  claudeSessionsHead:    { en: 'Agent sessions',               ja: 'エージェント セッション' },
  claudeSessionsEmpty:   { en: '(no Agent sessions)',          ja: '(エージェント セッションなし)' },
  claudeSessionsLoading: { en: 'Loading…',                      ja: '読み込み中…' },
  claudeStatusIdle:      { en: 'idle',                          ja: 'アイドル' },
  claudeStatusBusy:      { en: 'busy',                          ja: 'ビジー' },
  claudeStatusWaitPerm:  { en: 'awaiting permission',           ja: '承認待ち' },
  claudeStatusWaitQ:     { en: 'awaiting question',             ja: '質問待ち' },
  // 対話ウィザード等が tmux の画面を占有していて、送ったメッセージが会話に届かない状態。
  // status ではなく別フラグ (screenBlocked) から出す。
  claudeStatusBlocked:   { en: 'screen blocked',                ja: '画面が塞がっています' },
  claudeKillConfirm:     { en: 'Kill session "{name}"?',        ja: 'セッション "{name}" を終了しますか?' },
  claudeKillConfirmBtn:  { en: 'Confirm?',                      ja: '確定?' },
  claudeKillingBtn:      { en: 'Killing…',                      ja: '停止中…' },

  // ─── New Claude Session ──────────────────────────────────────
  newClaudeHead:  { en: 'New Agent session',                   ja: '新規 エージェント セッション' },
  newClaudeName:  { en: 'Session name',                         ja: 'セッション名' },
  newClaudeCwd:   { en: 'Working directory',                    ja: '作業ディレクトリ' },
  newAgentKind:   { en: 'Agent',                                ja: 'エージェント' },
  newClaudeStart: { en: 'Start agent',                         ja: 'エージェントを起動' },
  newClaudeNeedName: { en: 'Session name is required.',         ja: 'セッション名を入力してください。' },
  newClaudeStarting: { en: 'Starting…',                         ja: '起動中…' },
  newClaudeOk:    { en: 'Started ✓',                            ja: '起動しました ✓' },
  newClaudeFail:  { en: 'Failed: ',                             ja: '失敗: ' },

  // ─── Sections ────────────────────────────────────────────────
  sessionsHead:   { en: 'Sessions',                             ja: 'Sessions' },
  refresh:        { en: 'refresh',                              ja: 'refresh' },
  newSessionPh:   { en: 'new session name',                     ja: 'new session name' },
  newSessionBtn:  { en: '+ create',                             ja: '+ create' },
  pendingHead:    { en: 'Pending',                              ja: '確定待ち' },
  pendingDiscard: { en: '↓ Discard',                            ja: '↓ 破棄' },
  pendingConfirm: { en: '↑ Send',                               ja: '↑ 送信' },
  outputHead:     { en: 'Output',                               ja: 'Output' },
  noOutput:       { en: '(no output yet)',                      ja: '(no output yet)' },
  recentHead:     { en: 'Recent',                               ja: 'Recent' },
  clear:          { en: 'clear',                                ja: 'clear' },
  noHistory:      { en: '(nothing sent yet)',                   ja: '(まだ送信していません)' },

  // ─── Settings ────────────────────────────────────────────────
  settingsTitle:  { en: '⚙ Settings',                           ja: '⚙ 設定' },
  serverUrl:      { en: 'Server URL',                           ja: 'Server URL' },
  smApiKey:       { en: 'Speechmatics API key',                 ja: 'Speechmatics API key' },
  smLang:         { en: 'Language',                             ja: '言語' },
  smOperating:    { en: 'operating_point',                      ja: 'operating_point' },
  chatLines:      { en: 'Lens chat lines',                      ja: 'レンズ表示行数' },
  chatLinesDesc:  {
    en: 'Chat lines shown on the lens at once (1-7). More lets you read more, but too many can clip the bottom line.',
    ja: 'G2レンズに一度に表示するチャットの行数 (1〜7)。多いほど一度に読めるが、多すぎると最終行が下端で切れることがある。',
  },
  chatBottomSpacer:{ en: 'Add blank line below',                ja: '末尾に空行を1行足す' },
  chatBottomSpacerDesc: {
    en: 'Adds one blank line below the last line. Turn on if the last line looks cut off at the bottom.',
    ja: '最終行の下に空行を1行足す。最終行が下端で切れて見える時に ON にすると本文が収まりやすい。',
  },
  scrollLines:    { en: 'Scroll lines / gesture',               ja: 'スクロール行数/操作' },
  scrollLinesDesc: {
    en: 'Lines moved per scroll. Min 1, max equals the lens chat lines (set to max for full-page scrolling).',
    ja: 'スクロール1回で動く行数。最小1、最大はレンズ表示行数（最大にすると1画面ぶんのページ送り）。',
  },
  scrollCooldown: { en: 'Scroll cooldown (ms)',                 ja: 'スクロール間隔 (ms)' },
  scrollCooldownDesc: {
    en: 'Minimum gap between accepted scrolls (ms, 0-2000). Increase it to stop one swipe from scrolling twice.',
    ja: 'スクロールを受け付ける最小間隔 (ms, 0〜2000)。大きくすると1回のスワイプが二重に効いて2倍スクロールするのを抑えられる。',
  },
  scrollAnimTick: { en: 'Scroll anim speed (ms/line)',          ja: 'スクロール速度 (ms/行)' },
  scrollAnimTickDesc: {
    en: 'Delay per line of the scroll animation (ms, 0-1000, step 10). Smaller is faster. Scroll frames are sent without waiting for the lens to acknowledge them, so a smaller value really does scroll faster. Set 0 to disable the animation: jump straight to the target in a single update.',
    ja: 'スクロールアニメの1行あたりの待ち時間 (ms, 0〜1000, 10刻み)。小さいほど速い。スクロール中のコマはレンズ側の完了を待たずに送るので、小さくすればそのぶん速く動く。0 にするとアニメ無しで、目的位置へ一括スクロール（1回の更新でまとめて移動）。',
  },
  unset:          { en: '(unset)',                              ja: '未設定' },
  toastUrlCopied: { en: 'URL copied. Open it in your browser.', ja: 'URL をコピーしました。ブラウザで開いてください。' },
  toastUrlCopyFail:{ en: 'Failed to copy. URL: ',               ja: 'コピーに失敗。URL: ' },
  pickSession:    { en: 'Pick session on G2',                   ja: 'G2 でセッションを選択' },
  recBtn:         { en: 'Record',                               ja: 'Record' },
  recBtnStop:     { en: 'Stop',                                 ja: 'Stop' },
  recBtnPending:  { en: '↑Send / ↓Discard',                    ja: '↑送信 / ↓破棄' },
  finalizing:     { en: 'Finalizing…',                          ja: 'Finalizing…' },
  sending:        { en: 'Sending…',                             ja: 'Sending…' },

  // ─── G2 lens header (現在の phase タイトル) ──────────────────
  g2HeadBoot:         { en: 'Booting',                          ja: '起動中' },
  g2HeadSetup:        { en: 'Setup',                            ja: '初期設定' },
  g2HeadRoot:         { en: 'Sessions',                         ja: 'セッション' },
  g2HeadRecording:    { en: 'Recording',                        ja: '録音中' },
  g2HeadFinalizing:   { en: 'Transcribing',                     ja: '文字起こし中' },
  g2HeadPending:      { en: 'Pending',                          ja: '確認待ち' },
  g2HeadSending:      { en: 'Sending',                          ja: '送信中' },
  g2HeadCcResponse:   { en: 'Agent Prompt',                    ja: 'エージェント応答' },
  g2HeadError:        { en: 'Error',                            ja: 'エラー' },
  // 画面ブロック時のヘッダ。前にセッション名を足すので短く保つ (長いと名前が削られる)。
  // マークは丸括弧で囲った全角「！」。⚠ は G2 レンズのフォントに収録されておらず、
  // 幅の実測が置換文字と同じ = 実体が無い (レンズでは空白に見える) ため使わない。
  // 括弧で囲むのは、文中の句読点ではなく「印」だと一目で分かるようにするため。
  g2HeadBlocked:      { en: '(!) Check terminal',               ja: '(!) ターミナルを確認' },
  // 回答待ちのヘッダ。g2HeadBlocked と同じ流儀 (セッション名の後ろに置いて点滅させる) なので
  // 同じく短く保つ。マークは両方とも丸括弧の「?」。⏸ は G2 レンズのフォントに収録されて
  // いない疑いがある (Issue #72) ので使わない。質問待ち/承認待ちの区別は文言で伝える。
  g2HeadWaitQ:        { en: '(?) Question waiting',             ja: '(?) 質問待ち' },
  g2HeadWaitPerm:     { en: '(?) Approval waiting',             ja: '(?) 承認待ち' },

  // ─── G2 lens ─────────────────────────────────────────────────
  g2Booting:        { en: 'Booting…',                           ja: '起動中…' },
  g2Setup:          { en: 'SETUP MODE',                         ja: '初期設定中' },
  g2SetupHint:      { en: 'Open headlenss app on your phone',   ja: 'スマホで headlenss を設定してください' },
  g2BridgeMissing:  { en: 'G2 bridge not connected',            ja: 'G2 ブリッジ未接続' },
  g2SetUrl:         { en: 'Set Server URL',                     ja: 'Server URL を設定' },
  g2SetKey:         { en: 'Set Speechmatics key',               ja: 'API key を設定' },
  g2Unreachable:    { en: 'Server unreachable',                 ja: 'サーバへ接続できません' },
  g2ConfigureSess:  { en: 'Configure session',                  ja: 'セッションを設定' },
  g2Ready:          { en: 'Ready',                              ja: 'Ready' },
  g2Recording:      { en: 'Recording',                          ja: 'Recording' },
  g2Finalizing:     { en: 'Finalizing…',                        ja: 'Finalizing…' },
  g2PendingHint:    { en: '↑ Send / ↓ Discard',                ja: '↑ 送信 / ↓ 破棄' },
  g2Sending:        { en: 'Sending →',                          ja: 'Sending →' },
  g2NoSessions:     { en: '(no sessions)\nCreate one in app',   ja: '(セッション無し)\nスマホで作成' },
  g2NoSessionsBrief:{ en: 'No session',                         ja: 'セッション無し' },
  g2Sessions:       { en: 'Agent sessions',                    ja: 'エージェント セッション' },
  g2ClaudeAck:      { en: 'Agent waiting',                     ja: 'エージェント応答待ち' },
  // G2 footer (28全角文字 = 56半角文字 以内)。各 phase で利用可能な全操作を網羅する。
  // 共通記法: `Tap:X　↑↓:Y　2Tap:Z` (区切りは全角スペース U+3000、2Tap = double tap)
  g2FootRoot:       { en: 'Tap:Open　↑↓:Nav　2Tap:Exit',           ja: 'タップ:開く　↑↓:移動　2タップ:終了' },
  pluginConnecting: { en: 'Opening plugin...',                        ja: 'プラグインを開いています...' },
  g2FootRecOff:     { en: 'Tap:Done　2Tap:Cancel',                     ja: 'タップ:録音終了　2タップ:取消' },
  g2FootFinalizing: { en: 'Transcribing…',                                 ja: '文字起こし中…' },
  g2FootPending:    { en: 'Tap:Add　↑:Send　↓:Del　2Tap:Back', ja: 'タップ:追加　↑:送信　↓:削除　2タップ:戻る' },
  g2FootSending:    { en: 'Sending to tmux…',                              ja: 'tmuxに送信中…' },
  g2FootSetup:      { en: 'Set up on phone',                               ja: 'スマホで設定' },
  g2FootIdle:       { en: 'Tap:Rec　↑↓:Scroll　2Tap:Back',         ja: 'タップ:録音　↑↓:履歴　2タップ:戻る' },
  g2FootIdlePending:{ en: 'Tap:Answer　↑↓:Scroll　2Tap:Back',      ja: 'タップ:回答　↑↓:履歴　2タップ:戻る' },
  // cc-message: メッセージ全文の閲覧画面 (タップで選択肢画面へ)
  g2FootCcMessage:  { en: 'Tap:Choices　↑↓:Scroll　2Tap:Cancel',    ja: 'タップ:選択肢へ　↑↓:読む　2タップ:取消' },
  // cc-response: 選択肢画面。2Tap はキャンセルではなく cc-message へ戻る
  g2FootCcResponse: { en: '↑↓:Pick　Tap:OK　2Tap:Back',             ja: '↑↓:選択　タップ:確定　2タップ:戻る' },
  g2FootCcRespMulti:{ en: '↑↓:Pick　Tap:Toggle & Submit',          ja: '↑↓:選択　タップ:切替　Submitで確定' },
  g2FootCcRespRec:  { en: 'Tap:Done　2Tap:Cancel',                  ja: 'タップ:録音終了　2タップ:取消' },
  g2NoOutput:       { en: '(no output yet)',                    ja: '(まだ出力なし)' },
} as const

export type StringKey = keyof typeof STRINGS

let currentLanguage: Language = 'ja'
const listeners = new Set<(lang: Language) => void>()

export function getLanguage(): Language {
  return currentLanguage
}

export function setLanguage(lang: Language): void {
  if (currentLanguage === lang) return
  currentLanguage = lang
  for (const fn of listeners) fn(lang)
}

export function onLanguageChange(fn: (lang: Language) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function t(key: StringKey): string {
  return STRINGS[key]?.[currentLanguage] ?? key
}

/** WebView 全体に翻訳を反映する。各要素は data-i18n="key" / data-i18n-placeholder="key" / data-i18n-aria-label="key" を持てる */
export function applyTranslations(root: ParentNode = document): void {
  // textContent
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset.i18n as StringKey
    if (!key) continue
    el.textContent = t(key)
  }
  // placeholder
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    const key = el.dataset.i18nPlaceholder as StringKey
    if (!key) continue
    el.placeholder = t(key)
  }
  // aria-label
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
    const key = el.dataset.i18nAriaLabel as StringKey
    if (!key) continue
    el.setAttribute('aria-label', t(key))
  }
  // <html lang>
  document.documentElement.setAttribute('lang', currentLanguage)
}

export const LANGUAGE_LABELS: Record<Language, string> = {
  en: 'English',
  ja: '日本語',
}
