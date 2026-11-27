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
  probeOk:             { en: 'Connected',                       ja: '接続済み' },
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
  // チャット 1 発言が長すぎる時、表示用に切り詰めた末尾へ添える行。
  // 折り返し (px 計測) のコストを 1 発言あたりで頭打ちにするための制限であることが
  // 読み手に伝わるよう、元の文字数を必ず出す。
  chatMsgTruncated:    { en: '… ({total} chars total)',         ja: '… (全{total}文字)' },
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
  respondSending:     { en: 'Sending response…',                 ja: '回答を送信中…' },
  respondSent:        { en: 'Response sent',                     ja: '回答を送信しました' },
  respondChanged:     { en: 'Request changed — check again',     ja: '用件が変わりました。再確認してください' },
  reviewAnswer:       { en: 'Review answer',                     ja: '回答を確認' },
  reviewAnswerText:   { en: 'Your answer:',                      ja: 'あなたの回答:' },
  reviewConfirm:      { en: 'Confirm answer',                    ja: '回答を確定' },
  g2FootReview:       { en: 'Tap:Confirm ↑↓:Read 2Tap:Choices',   ja: 'タップ:確定 ↑↓:読む 2タップ:選択肢' },
  promptFailed:       { en: 'Send failed',                       ja: '送信失敗' },
  promptUnknown:      { en: 'Delivery unknown',                  ja: '送達不明' },
  promptUnknownHint:  { en: 'May have arrived. Check before retrying.', ja: '届いた可能性あり。再送前に確認してください。' },
  promptRetryConfirm: { en: 'May send twice. ↑:Resend Tap:Edit',  ja: '二重送信の可能性 ↑:再送 タップ:編集' },
  g2FootPromptRetry:  { en: 'Tap:Edit ↑:Retry ↓:Del 2Tap:Discard', ja: 'タップ:編集 ↑:再送 ↓:削除 2タップ:破棄' },
  promptEmpty:        { en: '(empty draft)',                     ja: '(下書きは空です)' },
  asrPartialWarning: { en: 'Connection lost — review partial text', ja: '接続が切れました — 途中の文字起こしを確認' },
  asrNoSpeech:       { en: 'No speech captured · tap to retry', ja: '音声を取得できませんでした · タップで再試行' },
  asrLostNoSpeech:   { en: 'Recording interrupted · No speech captured', ja: '録音が中断されました · 音声を取得できませんでした' },
  disconnected:     { en: 'Disconnected', ja: '未接続' },
  notConfigured:    { en: 'Not configured', ja: '未設定' },
  offlineLastUpdate:{ en: 'Offline · last update {time}', ja: 'オフライン · 最終更新 {time}' },
  offlineNoData:    { en: 'Offline · no cached data', ja: 'オフライン · 保存済みデータなし' },
  connectionRetryHint: { en: 'Retry from the hold menu', ja: '長押しメニューから再試行' },
  menuRetryConnection: { en: 'Retry connection', ja: '接続を再試行' },
  menuPromptUndo:   { en: 'Undo last deletion', ja: '直前の削除を戻す' },
  promptSent:         { en: 'Prompt sent: {name}',               ja: '送信しました: {name}' },

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
  // 回答待ちのヘッダ。g2HeadBlocked と同じ流儀 (セッション名の後ろに常時表示) なので
  // 同じく短く保つ。マークは両方とも丸括弧の「?」。⏸ は G2 レンズのフォントに収録されて
  // いない疑いがある (Issue #72) ので使わない。質問待ち/承認待ちの区別は文言で伝える。
  g2HeadWaitQ:        { en: '(?) Question',                     ja: '(?) 質問待ち' },
  g2HeadWaitPerm:     { en: '(?) Approval',                     ja: '(?) 承認待ち' },
  g2HeadWorking:     { en: 'Working',                          ja: '作業中' },
  g2HeadReplyReady:  { en: 'Reply ready',                       ja: '返信あり' },
  g2HeadAgentIdle:   { en: 'Agent idle',                        ja: '待機中' },

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
  g2FootPending:    { en: 'Tap:Add ↑:Send ↓:Del 2Tap:Discard', ja: 'タップ:追加 ↑:送信 ↓:削除 2タップ:破棄' },
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

  // ─── G2 一時通知 (フッタに数秒だけ出す。56半角以内) ──────────────
  // 録音が始まらなかった理由。レンズだけを見ていても切り分けられるよう、
  // 「音声認識サービス側」「グラスのマイク側」「それ以外」を必ず書き分ける。
  g2NoticeRecFailAuth: { en: 'Rec start failed (auth/quota {code})', ja: '録音開始に失敗 (認証/枠 {code})' },
  g2NoticeRecFailAsr:  { en: 'Rec start failed (ASR)',               ja: '録音開始に失敗 (音声認識)' },
  g2NoticeRecFailMic:  { en: 'Rec start failed (mic)',               ja: '録音開始に失敗 (マイク)' },
  g2NoticeRecFail:     { en: 'Rec start failed',                     ja: '録音開始に失敗' },
  // お気に入り (★) の付け外し。長押しは押した手応えが無いので、何が起きたかを必ず出す。
  g2NoticeStarred:     { en: 'Starred: {name}',                      ja: '★ を付けました: {name}' },
  g2NoticeUnstarred:   { en: 'Unstarred: {name}',                    ja: '★ を外しました: {name}' },
  // ★ の切替が効く画面 (一覧 / セッションを開いている画面) の外でメニュー項目が
  // 届いた時の案内。対象セッションが決まらないので何もできない、を伝える。
  g2NoticeFavoriteNA:  { en: 'No session selected',                   ja: 'セッションが選ばれていません' },

  // ─── G2 OS 長押しメニューの独自項目 (32 UTF-8 バイト以内) ────────────
  // 「登録 / 解除」で出し分けないのは、menuObject が create/rebuild にしか載らず
  // カーソル行ごとに文言を変えると 1 行動かすたびにページ再構築が要るため。
  // 何が起きたかは実行後にフッタの一時通知で知らせる。
  menuToggleFavorite:  { en: '★ Toggle favorite',                    ja: '★ お気に入り切替' },
  menuPromptSend:      { en: 'Send draft',                           ja: '下書きを送信' },
  menuPromptRetry:     { en: 'Retry send',                           ja: '再送' },
  menuPromptResend:    { en: 'Resend anyway',                        ja: '再送する' },
  menuPromptEdit:      { en: 'Edit (add voice)',                     ja: '編集 (音声追加)' },
  menuPromptDiscard:   { en: 'Discard draft',                        ja: '下書きを破棄' },
  menuReviewRecord:    { en: 'Record answer again',                  ja: '回答を録り直す' },
  menuReviewChoices:   { en: 'Back to choices',                      ja: '選択肢へ戻る' },

  // ─── Fieldglass (会議中のキュー + 約束 → フォローアップ) ──────────────
  // 行は 56 半角 / 28 全角以内。メニュー項目 (fgMenu*) は 32 UTF-8 バイト以内。
  // 「● LIVE」はマイクが開いている間だけに使う。他の状態の文言は ● で始めない。
  fgRootLabel:       { en: 'Fieldglass',                           ja: 'Fieldglass' },
  fgRootNext:        { en: 'Next: {time} {title}',                 ja: '次: {time} {title}' },
  fgRootNoMeetings:  { en: 'No meetings',                          ja: '予定なし' },
  fgRootSetup:       { en: 'Set up calendar on phone',             ja: 'スマホでカレンダー設定' },
  fgRootLoading:     { en: 'Loading today…',                       ja: '予定を読込中…' },
  fgRootServerOld:   { en: 'Update HeadLenss server',              ja: 'サーバの更新が必要' },
  fgRootLive:        { en: '● LIVE {time}',                        ja: '● LIVE {time}' },
  fgHeadHome:        { en: 'FIELDGLASS · {profile}',               ja: 'FIELDGLASS · {profile}' },
  fgHeadConsent:     { en: 'READY · Consent',                      ja: 'READY · 同意' },
  fgHeadListen:      { en: 'LISTEN · {profile}',                   ja: 'LISTEN · {profile}' },
  fgHeadCue:         { en: 'CUE · {profile}',                      ja: 'CUE · {profile}' },
  fgHeadPaused:      { en: 'PAUSED · {profile}',                   ja: 'PAUSED · {profile}' },
  fgHeadEnd:         { en: 'END? · {profile}',                     ja: 'END? · {profile}' },
  fgHeadReview:      { en: 'REVIEW · {n}/{total}',                 ja: 'REVIEW · {n}/{total}' },
  fgHeadReviewNone:  { en: 'REVIEW',                               ja: 'REVIEW' },
  fgHeadFollowups:   { en: 'FOLLOW-UPS ({n})',                     ja: 'FOLLOW-UPS ({n})' },
  fgHeadSuspended:   { en: 'OFF · Phone left app',                 ja: 'OFF · アプリ離脱' },
  fgLive:            { en: '● LIVE {time}',                        ja: '● LIVE {time}' },
  fgMicOff:          { en: '○ MIC OFF',                            ja: '○ MIC OFF' },
  fgProfileWork:     { en: 'Work',                                 ja: '仕事' },
  fgProfileEveryday: { en: 'Everyday',                             ja: '日常' },
  fgProfileListening:{ en: 'Listening',                            ja: '傾聴' },
  fgHomeNoMeeting:   { en: 'No more meetings today.',              ja: '今日の予定はもうありません。' },
  fgHomeNext:        { en: '{time} {title}',                       ja: '{time} {title}' },
  fgHomeObjective:   { en: 'Goal: {text}',                         ja: '目的: {text}' },
  fgHomeNoObjective: { en: 'Goal: (set on phone)',                 ja: '目的: (スマホで設定)' },
  fgHomeCalSetup:    { en: 'Calendar not connected.',              ja: 'カレンダー未接続。' },
  fgHomeCalSetupHint:{ en: 'Phone → Fieldglass → Connections',     ja: 'スマホ → Fieldglass → 接続' },
  fgHomeServerOld:   { en: 'Server has no Fieldglass yet.',        ja: 'サーバが Fieldglass 未対応です。' },
  fgHomeOffline:     { en: 'Mac unreachable (cues still work)',    ja: 'Mac 未接続 (キューは動きます)' },
  fgHomeMicOff:      { en: '○ Mic is off.',                        ja: '○ マイクはオフです。' },
  fgHomeFollowups:   { en: 'Follow-ups: {n}',                      ja: 'フォローアップ: {n}' },
  fgHomeFieldTest:   { en: 'Field test: on',                       ja: 'フィールドテスト: ON' },
  fgFootHome:        { en: 'Tap:Start cues　Hold:Menu　2Tap:Back',  ja: 'タップ:開始　長押し:メニュー　2タップ:戻る' },
  fgConsent1:        { en: 'Tell the room first:',                 ja: '先に周りへ伝えてください:' },
  fgConsent2:        { en: '"I\'m using live captions',             ja: '「メガネで字幕を使っています。' },
  fgConsent3:        { en: ' on my glasses. OK?"',                 ja: '　いいですか？」' },
  fgConsent4:        { en: 'Audio is never saved.',                ja: '音声は保存しません。' },
  fgConsent5:        { en: 'Words stay on this phone.',            ja: '文字起こしはこのスマホ内のみ。' },
  fgFootConsent:     { en: 'Tap:Start mic　2Tap:Cancel',            ja: 'タップ:マイク開始　2タップ:取消' },
  fgConnecting:      { en: 'Starting mic…',                        ja: 'マイクを開始中…' },
  fgReconnecting:    { en: 'Speech reconnecting…',                 ja: '音声認識に再接続中…' },
  fgAsrFailed:       { en: 'Speech stopped. Tap to retry.',        ja: '音声認識が停止。タップで再試行。' },
  fgPausedUntil:     { en: 'Cues paused until {time}.',            ja: '{time} までキュー停止中。' },
  fgPausedMicOn:     { en: 'Mic stays on. Hold → Resume.',         ja: 'マイクはオン。長押し→再開' },
  fgCueOld:          { en: '(old)',                                ja: '(古い)' },
  // キューの 1 行目 (種類)。会話由来の文を 1 行目に置かないための見出し。
  fgCatOwner:        { en: '？ Owner',                              ja: '？ 担当' },
  fgCatDate:         { en: '？ Date',                               ja: '？ 期限' },
  fgCatDecision:     { en: '？ Decision',                           ja: '？ 決定' },
  fgCatBlocker:      { en: '！ Blocker',                            ja: '！ 障害' },
  fgCatConcern:      { en: '！ Concern',                            ja: '！ 懸念' },
  fgCatRecall:       { en: '→ Recall',                             ja: '→ 想起' },
  fgCatOther:        { en: '？ Cue',                                ja: '？ キュー' },
  fgFollowupsSaved:  { en: 'Saved on Mac: {n}',                    ja: 'Mac に保存: {n} 件' },
  fgFootListen:      { en: 'Hold:Menu　2Tap:End',                   ja: '長押し:メニュー　2タップ:終了' },
  fgFootCue:         { en: 'Tap:Got it　Hold:Menu　2Tap:End',       ja: 'タップ:OK　長押し:メニュー　2タップ:終了' },
  fgFootRetry:       { en: 'Tap:Retry　Hold:Menu　2Tap:End',         ja: 'タップ:再試行　長押し:メニュー　2タップ:終了' },
  fgEndConfirm:      { en: 'End this conversation?',               ja: 'この会話を終了しますか？' },
  fgEndHint:         { en: 'Mic turns off. Transcript is dropped.', ja: 'マイクを切り、文字起こしを消します。' },
  fgFootEnd:         { en: 'Tap:End　2Tap:Keep listening',          ja: 'タップ:終了　2タップ:続ける' },
  fgReviewNone:      { en: 'No commitments heard.',                ja: '約束は聞き取れませんでした。' },
  fgReviewAsk:       { en: 'Save as a follow-up?',                 ja: 'フォローアップに保存しますか？' },
  fgFinishing:       { en: 'Mic off. Finishing last words…',       ja: 'マイクオフ。最後の発言を確定中…' },
  fgFootFinishing:   { en: 'One moment…',                          ja: 'お待ちください…' },
  fgNoticeSpeakersReset:{ en: 'Speech reconnected: mark yourself again', ja: '再接続: もう一度「今のは自分」を' },
  fgReviewOwner:     { en: 'Owner: {owner}',                       ja: '担当: {owner}' },
  fgReviewDue:       { en: 'Due: {due}',                           ja: '期限: {due}' },
  fgReviewSaved:     { en: '→ Saved to Mac',                       ja: '→ Mac に保存済み' },
  fgReviewSaving:    { en: 'Saving…',                              ja: '保存中…' },
  fgReviewSaveFail:  { en: 'Save failed. Tap to retry.',           ja: '保存失敗。タップで再試行。' },
  fgFootReview:      { en: 'Tap:Save　↑↓:Move　2Tap:Done',          ja: 'タップ:保存　↑↓:移動　2タップ:完了' },
  fgFootReviewNone:  { en: 'Tap/2Tap:Done',                        ja: 'タップ/2タップ:完了' },
  fgNoticeDone:      { en: 'Saved {n} · transcript cleared',       ja: '{n} 件保存 · 文字起こし消去' },
  fgFollowupsEmpty:  { en: 'No follow-ups saved.',                 ja: '保存済みのフォローアップなし。' },
  fgFollowupsHint:   { en: 'Send them from the phone.',            ja: '送信はスマホから。' },
  fgFollowupSent:    { en: '→ sent to {to}',                       ja: '→ {to} へ送信済み' },
  fgFollowupsLoading:{ en: 'Loading…',                             ja: '読み込み中…' },
  fgFollowupsFail:   { en: 'Could not load from Mac.',             ja: 'Mac から読めませんでした。' },
  fgFootFollowups:   { en: '↑↓:Scroll　2Tap:Back',                  ja: '↑↓:スクロール　2タップ:戻る' },
  fgSuspended1:      { en: 'Mic stopped: phone left the app.',     ja: 'アプリを離れたのでマイクを停止。' },
  fgSuspended2:      { en: 'Tap to resume listening.',             ja: 'タップで聞き取りを再開。' },
  fgFootSuspended:   { en: 'Tap:Resume　2Tap:End',                  ja: 'タップ:再開　2タップ:終了' },
  fgNoticeWearer:    { en: 'Noted: {speaker} is you',              ja: '{speaker} をあなたとして記録' },
  fgNoticeNoSpeaker: { en: 'Speaker unknown — not changed',        ja: '話者不明のため変更なし' },
  fgNoticeOff:       { en: 'Marked off target',                    ja: '的外れとして記録' },
  fgNoticeUseful:    { en: 'Marked useful',                        ja: '役立ったとして記録' },
  fgNoticeNoKey:     { en: 'Set Speechmatics key on phone',        ja: 'スマホで音声認識キーを設定' },
  fgNoticeMicFail:   { en: 'Mic failed to start',                  ja: 'マイクを開始できません' },
  fgNoticeFieldOn:   { en: 'Field test logging on',                ja: 'フィールドテスト記録 ON' },
  fgNoticeFieldOff:  { en: 'Field test logging off',               ja: 'フィールドテスト記録 OFF' },
  fgNoticeProfile:   { en: 'Profile: {profile}',                   ja: 'プロファイル: {profile}' },
  fgNoticePaused:    { en: 'Cues paused 15 min (mic on)',          ja: 'キュー15分停止 (マイクはオン)' },
  fgNoticeResumed:   { en: 'Cues resumed',                         ja: 'キュー再開' },
  fgMenuWork:        { en: 'Profile: Work',                        ja: '仕事モード' },
  fgMenuEveryday:    { en: 'Profile: Everyday',                    ja: '日常モード' },
  fgMenuListening:   { en: 'Profile: Listening',                   ja: '傾聴モード' },
  fgMenuFollowups:   { en: 'Follow-ups ({n})',                     ja: 'フォローアップ({n})' },
  fgMenuFieldTest:   { en: 'Field test on/off',                    ja: 'フィールドテスト切替' },
  fgMenuOffTarget:   { en: 'Off target',                           ja: '的外れ' },
  fgMenuThatWasMe:   { en: 'That was me',                          ja: '今のは自分' },
  fgMenuPause:       { en: 'Pause cues 15 min',                    ja: 'キュー15分停止' },
  fgMenuResume:      { en: 'Resume cues',                          ja: 'キュー再開' },
  fgMenuEnd:         { en: 'End session',                          ja: 'セッション終了' },
  fgMenuResetMuted:  { en: 'Reset muted cues',                     ja: 'ミュート解除' },
  fgNoticeResetMuted:{ en: 'Muted cue types restored',             ja: 'ミュートしたキューを戻しました' },
  fgStatusLive:      { en: 'Fieldglass ● LIVE {time}',             ja: 'Fieldglass ● LIVE {time}' },
  fgStatusIdle:      { en: 'Fieldglass (mic off)',                 ja: 'Fieldglass (マイクオフ)' },

  // ─── Messages (iMessage を読む / 返信する。送信は Mac) ──────────────────
  // 本文の 1 行目に会話の文を置かない文言を使う (描画経路が 1 行目を console に出すため)。
  msgRootLabel:      { en: 'Messages',                             ja: 'メッセージ' },
  msgRootNew:        { en: '{n} new',                              ja: '新着 {n}' },
  msgRootSetup:      { en: 'Set up on Mac',                        ja: 'Mac で設定' },
  msgRootServerOld:  { en: 'Update HeadLenss server',              ja: 'サーバの更新が必要' },
  msgHeadList:       { en: 'MESSAGES ({n})',                       ja: 'MESSAGES ({n})' },
  msgHeadSetup:      { en: 'SETUP · Messages',                     ja: 'SETUP · メッセージ' },
  msgHeadThread:     { en: 'MSG · {name}',                         ja: 'MSG · {name}' },
  msgHeadTo:         { en: 'TO · {name}',                          ja: 'TO · {name}' },
  msgSetup1:         { en: 'Messages needs setup on the Mac.',     ja: 'Mac でメッセージの設定が必要です。' },
  msgSetup2:         { en: 'Phone: Fieldglass → Messages',         ja: 'スマホ: Fieldglass → メッセージ' },
  msgSetup3:         { en: 'Tap to check again.',                  ja: 'タップで再確認。' },
  msgServerOld:      { en: 'Server has no Messages yet.',          ja: 'サーバがメッセージ未対応です。' },
  msgLoading:        { en: 'Loading…',                             ja: '読み込み中…' },
  msgLoadFail:       { en: 'Could not load from Mac.',             ja: 'Mac から読めませんでした。' },
  msgNoThreads:      { en: 'No messages in the last 7 days.',      ja: '7 日以内のメッセージはありません。' },
  msgNoMessages:     { en: '(no messages)',                        ja: '(メッセージなし)' },
  msgGroupMark:      { en: '[group]',                              ja: '[グループ]' },
  msgMe:             { en: 'Me',                                   ja: '自分' },
  msgAttachment:     { en: '[attachment]',                         ja: '[添付]' },
  msgCount:          { en: '{n} recent',                           ja: '最近の {n} 件' },
  msgOlder:          { en: '↑ older (-{n})',                       ja: '↑ 過去 (-{n})' },
  msgConfirmAsk:     { en: 'Send this message?',                   ja: 'このメッセージを送りますか？' },
  msgConfirmPartial: { en: '(！) Speech cut off: check the text',   ja: '(！) 音声が途中で切れました。確認を' },
  msgSending:        { en: 'Sending from your Mac…',               ja: 'Mac から送信中…' },
  msgSent:           { en: 'Sent.',                                ja: '送信しました。' },
  msgUnknown1:       { en: 'Delivery unknown.',                    ja: '送信できたか不明です。' },
  msgUnknown2:       { en: 'Check Messages on your phone before sending again.', ja: '送り直す前にスマホのメッセージを確認してください。' },
  msgFailed:         { en: 'Not sent.',                            ja: '送信されませんでした。' },
  msgFailedHint:     { en: 'Tap to review and send again.',        ja: 'タップで確認して送り直せます。' },
  msgFootList:       { en: 'Tap:Open　↑↓:Move　2Tap:Back',          ja: 'タップ:開く　↑↓:移動　2タップ:戻る' },
  msgFootSetup:      { en: 'Tap:Check again　2Tap:Back',            ja: 'タップ:再確認　2タップ:戻る' },
  msgFootThread:     { en: 'Tap:Reply　↑↓:Scroll　2Tap:Back',       ja: 'タップ:返信　↑↓:スクロール　2タップ:戻る' },
  msgFootThreadRO:   { en: 'Tap:Why read-only　↑↓:Scroll　2Tap:Back', ja: 'タップ:理由　↑↓:スクロール　2タップ:戻る' },
  msgReadOnly:       { en: 'This thread is read-only',             ja: 'このスレッドは読み取り専用です' },
  msgReadOnlyMark:   { en: 'read-only',                            ja: '読み取り専用' },
  msgFootConfirm:    { en: 'Tap:Send　↑↓:Read　2Tap:Edit　Hold:Discard', ja: 'タップ:送信　↑↓:読む　2タップ:編集　長押し:破棄' },
  msgFootSending:    { en: 'Sending…',                             ja: '送信中…' },
  msgFootResult:     { en: 'Tap/2Tap:Back to thread',              ja: 'タップ/2タップ:スレッドへ' },
  msgFootFailed:     { en: 'Tap:Review again　2Tap:Edit　Hold:Discard', ja: 'タップ:再確認　2タップ:編集　長押し:破棄' },
  // 返信の下書き: ↑↓ は読むだけ (送信・削除にしない)。追加録音・末尾削除・取り消しは長押しメニュー。
  msgFootPending:    { en: 'Tap:Review　↑↓:Read　Hold:Edit　2Tap:Discard', ja: 'タップ:確認　↑↓:読む　長押し:編集　2タップ:破棄' },
  msgDraftTo:        { en: '→ {name}',                             ja: '→ {name}' },
  msgDraftHead:      { en: 'Reply to {name}:',                     ja: '{name} への返信:' },
  msgMenuDiscard:    { en: 'Discard reply',                        ja: '返信を破棄' },
  msgMenuDeleteLast: { en: 'Delete last sentence',                 ja: '最後の文を削除' },
  msgConfirmTo:      { en: 'To: {name}',                           ja: '宛先: {name}' },
  // サーバの理由コード (reasonCode) → 文言。知らないコードはサーバの文 (英語) をそのまま出す。
  msgReasonGroupReadOnly:{ en: 'Group chats are read-only for now.', ja: 'グループは今は読むだけです。' },
  msgReasonService:  { en: 'Only iMessage and SMS threads can be answered.', ja: '返信できるのは iMessage と SMS だけです。' },
  msgReasonAmbiguous:{ en: 'Unclear recipient. Reply on the Mac.',  ja: '宛先が特定できません。Mac で返信を。' },
  msgReasonAutomation:{ en: 'Allow HeadLenss to control Messages: Mac Settings → Privacy → Automation.', ja: 'Mac の設定 → プライバシー → オートメーションで「メッセージ」を許可してください。' },
  msgReasonReadDenied:{ en: 'Mac cannot read Messages yet. See setup on the phone.', ja: 'Mac がメッセージを読めません。スマホの設定手順を見てください。' },
  msgReasonUnavailable:{ en: 'This chat is no longer available. Open Messages on the Mac.', ja: 'このチャットは使えません。Mac のメッセージを開いてください。' },
  msgReasonDraftConflict:{ en: 'This draft changed. Review it again.', ja: '下書きが変わりました。もう一度確認してください。' },
  msgReasonNotMac:   { en: 'Messages needs the HeadLenss server on a Mac.', ja: 'メッセージは Mac 上のサーバでのみ使えます。' },
  msgReasonStopping: { en: 'HeadLenss is restarting. Check Messages first.', ja: 'HeadLenss を再起動中です。先にメッセージを確認してください。' },
  msgReasonHistoryFull:{ en: 'Too many replies saved. Check Messages first.', ja: '返信の記録が満杯です。先にメッセージを確認してください。' },
  msgReasonNotFound: { en: 'Thread not found.',                    ja: 'スレッドが見つかりません。' },
  msgReasonNotPermitted:{ en: 'Replies are not allowed for this thread.', ja: 'このスレッドには返信できません。' },
  msgReasonSendFailed:{ en: 'Messages on the Mac refused the reply.', ja: 'Mac のメッセージが返信を受け付けませんでした。' },
  msgReasonInvalid:  { en: 'The reply could not be read. Dictate it again.', ja: '返信を読み取れませんでした。もう一度話してください。' },
  msgReasonTooLarge: { en: 'This reply is too long to send.',       ja: '返信が長すぎて送れません。' },
  msgMenuReview:     { en: 'Review & send',                        ja: '確認して送信' },
  msgNoticeDiscarded:{ en: 'Reply discarded',                      ja: '返信を破棄しました' },
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

/** t() の結果の {name} を置き換える。値に含まれる {…} は再置換しない。 */
export function tf(key: StringKey, vars: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
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
