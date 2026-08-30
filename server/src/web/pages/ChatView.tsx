import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import {
  useFixedStyleWithIOsKeyboard,
  useIOsKeyboardHeight,
} from 'react-ios-keyboard-viewport';
import { extractImagesFromClipboard, filterImageFiles, uploadImage } from '../uploads.ts';
import { useLanguage } from '../i18n.tsx';

type ChatMessage = { role: 'user' | 'assistant'; text: string; ts: number; synthetic?: boolean; origin?: 'ui' | 'external'; agent?: 'claude' | 'codex' };
type SessionStatus = 'idle' | 'busy' | 'waiting-permission' | 'waiting-question';
const INITIAL_VISIBLE_MESSAGES = 20;
const VISIBLE_MESSAGES_STEP = 20;
// 楽観投稿がサーバ側に取り込まれず一致しなかった場合の保険。
// 破棄条件は「会話がこの投稿より新しいメッセージまで進んだ(=取り残された)」を主とし、
// ターン処理中にキューされた投稿(まだ新しいサーバメッセージが無い)は消さない。
// SUPERSEDE_GRACE は hook 書き込み順の前後を吸収する猶予。TTL は「新しいメッセージが
// 二度と来ない idle セッションで取り残された場合」の最終保険で、通常のターンより十分長くする。
const OPTIMISTIC_SUPERSEDE_GRACE_MS = 10_000;
const OPTIMISTIC_PENDING_TTL_MS = 15 * 60_000;

type AskQuestionOption = { label: string; description?: string };
type AskQuestion = {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options?: AskQuestionOption[];
};
type Pending = {
  id: string;
  kind: 'permission' | 'question';
  toolName: string;
  toolInput: unknown;
  questions?: AskQuestion[];
  createdAt: number;
};

type CodexHookHealth = {
  status: 'ok' | 'missing' | 'incomplete';
  missingEvents: string[];
  setupCommand: string;
  notes: string[];
};

/** 表示用前処理: `@/tmp/headlenss-uploads/<file>` を見つけたら markdown image
 *  記法 `![](/api/uploads/<file>)` に置き換え、チャットバブル内でインライン
 *  画像として表示できるようにする。
 *  Claude Code が読む元の文字列(transcript / hook 由来)は path のままなので、
 *  画像参照の意味は壊さない。 */
function inlineUploadedImages(text: string): string {
  return text.replace(
    /@(\/tmp\/headlenss-uploads\/([a-zA-Z0-9._-]+))/g,
    (_match, _full: string, filename: string) => `![](/api/uploads/${filename})`,
  );
}

// 楽観投稿(ユーザが打った生テキスト)と、サーバ保存側 (sanitizeChatText で trim /
// 3連続改行の圧縮などが掛かったテキスト) を突き合わせるための正規化。空白差で一致を
// 取り逃して楽観投稿が消えず最下部に残る不具合を防ぐ。
function normalizeForMatch(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function sameChatMessages(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].role !== b[i].role ||
      a[i].text !== b[i].text ||
      a[i].ts !== b[i].ts ||
      a[i].synthetic !== b[i].synthetic ||
      a[i].origin !== b[i].origin ||
      a[i].agent !== b[i].agent
    ) {
      return false;
    }
  }
  return true;
}

const markdownComponents: Components = {
  a: ({ children, href, ...rest }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  ),
  // loose list で react-markdown が <li><p>...</p></li> を出すと
  // 空白テキストノードが li 内に残って anonymous block boxes が
  // 余分な高さを生む。<p> 単独子の場合は <p> を剥がして tight list と
  // 同じ DOM 構造に揃える。
  li: ({ children, ...rest }) => {
    const arr = React.Children.toArray(children);
    const meaningful = arr.filter((c) =>
      typeof c === 'string' ? c.trim().length > 0 : true,
    );
    if (
      meaningful.length === 1 &&
      React.isValidElement(meaningful[0]) &&
      (meaningful[0] as React.ReactElement).type === 'p'
    ) {
      const p = meaningful[0] as React.ReactElement<{ children?: React.ReactNode }>;
      return <li {...rest}>{p.props.children}</li>;
    }
    return <li {...rest}>{children}</li>;
  },
};

const ChatMessageItem = React.memo(function ChatMessageItem({
  message,
  isPending,
  t,
}: {
  message: ChatMessage;
  isPending: boolean;
  t: (key: import('../i18n.tsx').StringKey) => string;
}) {
  const renderedText = useMemo(() => inlineUploadedImages(message.text), [message.text]);

  // ラベル: user = 'YOU'、assistant = agent 名 / 'Agent'(fallback)
  let roleLabel: string;
  if (message.role === 'user') {
    roleLabel = 'YOU';
  } else {
    roleLabel = message.agent === 'claude' ? 'Claude'
              : message.agent === 'codex' ? 'Codex'
              : 'Agent';
  }

  return (
    <div
      className={`chat-msg chat-msg-${message.role}${isPending ? ' chat-msg-pending' : ''}`}
    >
      <div className="chat-msg-role">{roleLabel}</div>
      <div className="chat-msg-bubble markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={markdownComponents}
        >
          {renderedText}
        </ReactMarkdown>
      </div>
    </div>
  );
});

export function ChatView({
  sessionName,
  onBack,
  modeTabs,
}: {
  sessionName: string;
  onBack: () => void;
  /** ヘッダに置くタブ帯 (`tmux | chat | 登録タブ…`)。SessionPane が組み立てる */
  modeTabs: ReactNode;
}) {
  const { t, language } = useLanguage();
  // サーバから返ってくる確定 chat
  const [serverChat, setServerChat] = useState<ChatMessage[]>([]);
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_MESSAGES);
  // 送信直後の楽観的表示メッセージ。サーバ側 (transcript / hook) に同じ user メッセージが
  // 出てきたら自動的にここから取り除く。
  const [pending, setPending] = useState<ChatMessage[]>([]);
  // Claude Code の動作状態。busy / waiting-* の時に「考え中」インジケータを表示。
  const [status, setStatus] = useState<SessionStatus>('idle');
  // pending interaction: AskUserQuestion / 許可リクエストの待ち状態
  // (chat の楽観的更新用 `pending` とは別物。InterAction の意味で `pendingInter`)
  const [pendingInter, setPendingInter] = useState<Pending | null>(null);
  const [source, setSource] = useState<'claude' | 'codex' | undefined>(undefined);
  const [codexHookHealth, setCodexHookHealth] = useState<CodexHookHealth | null>(null);
  const [codexNeedsHookAttention, setCodexNeedsHookAttention] = useState(false);
  // 対話ウィザード等が tmux の画面を占有していて、ここから送っても会話に届かない状態。
  // status は idle/busy のまま正しいので、これだけが「送っても届かない」の根拠になる。
  const [screenBlocked, setScreenBlocked] = useState(false);
  // 送ったのに ACK (UserPromptSubmit) が返ってこなかった直近の送信。
  // サーバは未確認の間だけ載せてくるので、確認できたら自動的に消える。
  const [deliveryWarning, setDeliveryWarning] = useState<{ sentAt: number } | null>(null);
  // 質問への回答種別 (predefined / type-something / chat-about-this)
  const [qKind, setQKind] = useState<Record<number, 'predefined' | 'type-something' | 'chat-about-this'>>({});
  // predefined 用: 選んだ option の label (単一選択)
  const [qSelections, setQSelections] = useState<Record<number, string>>({});
  // predefined multi-select 用: 選んだ option label の配列
  const [qSelectionsMulti, setQSelectionsMulti] = useState<Record<number, string[]>>({});
  // predefined 用: 選んだ option に添える補足メモ(任意。単一選択のみ)
  const [qNotes, setQNotes] = useState<Record<number, string>>({});
  // type-something 用: 自由記述テキスト
  const [qFreeText, setQFreeText] = useState<Record<number, string>>({});
  // 現在表示している質問の index。最後まで進むと totalQ になり、確認&送信画面を出す
  const [currentQIdx, setCurrentQIdx] = useState(0);
  // 許可リクエスト用のメッセージ
  const [permMessage, setPermMessage] = useState('');
  const [respondingPending, setRespondingPending] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLFormElement>(null);
  const lastLenRef = useRef(0);
  const userScrolledUpRef = useRef(false);
  const scrollAfterPendingConfirmRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // iOS Safari (iPhone のみ) でソフトキーボードが出ている間、 chat-input form を
  // visualViewport の下端に absolute で貼り付けて、 iOS 自動パンを起こさせない
  // ようにする。 keyboardHeight=0 のとき (= 非 iPhone / キーボード閉) は
  // fixedBottom = {} (= 空オブジェクト) になり、 normal flex flow に戻る。
  // ChatGPT/Claude.ai 等の主要 AI チャットも自前で visualViewport ハンドラを
  // 書いている分野で、 これは小さな専用フック (16KB / zero deps / MIT) を使った
  // 同等パターン。
  const keyboardHeight = useIOsKeyboardHeight();
  const { fixedBottom: chatInputKeyboardStyle } = useFixedStyleWithIOsKeyboard();

  // chat-input form の実高さを ResizeObserver で測って CSS var に書き出す。
  // chat-input が absolute 化したとき、 chat-scroller がその真下に空間を確保
  // (padding-bottom = chatInputH + keyboardH) するための材料。
  const [chatInputHeight, setChatInputHeight] = useState(0);
  useEffect(() => {
    const el = chatInputRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setChatInputHeight(el.offsetHeight));
    ro.observe(el);
    setChatInputHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  // keyboard 開いている間だけ、 chat-scroller に padding-bottom を加える。
  // chat-input は absolute になって flex flow から外れるので、 そのままだと
  // 最新メッセージが chat-input の下に潜って見えなくなる。
  // padding-bottom = keyboardH + chatInputH で「chat-input の上端」 まで
  // コンテンツを押し上げる。 keyboard 閉じてる時は 0 で副作用なし。
  const scrollerPaddingBottom =
    keyboardHeight > 0 ? `${keyboardHeight + chatInputHeight}px` : undefined;

  // 表示は server + pending を順に並べる(pending は常に末尾、ts 順)。
  // origin==='external' の user メッセージは web chat では非表示。
  // 初期表示は直近分だけに絞り、必要に応じて上部ボタンで過去分を追加する。
  const isExternalUser = (m: ChatMessage) => m.role === 'user' && m.origin === 'external';
  const displayChat = useMemo(() => {
    return [...serverChat, ...pending].filter((m) => !isExternalUser(m));
  }, [serverChat, pending]);
  // pending (楽観的投稿) は origin==='external' にならないので、
  // filteredServerCount が displayChat 内の server 由来メッセージ数と一致する。
  const filteredServerCount = useMemo(
    () => serverChat.filter((m) => !isExternalUser(m)).length,
    [serverChat],
  );
  const visibleStart = Math.max(0, displayChat.length - visibleLimit);
  const visibleChat = useMemo(() => {
    return displayChat.slice(visibleStart);
  }, [displayChat, visibleStart]);
  const hasOlderChat = visibleStart > 0;

  const distanceFromBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, []);

  const syncScrollState = useCallback(() => {
    const distance = distanceFromBottom();
    userScrolledUpRef.current = distance >= 64;
    setShowScrollToBottom(distance > 240);
  }, [distanceFromBottom]);

  // 末尾へ即時スクロール。 markdown / 画像の遅延レイアウトで scrollHeight が後から
  // 伸びるケースに耐えるよう、即時 + 次フレーム + 80ms 後 の 3 回試行する。
  // ref しか触らないので依存配列は空で OK。
  const scrollToBottom = useCallback(() => {
    const pin = () => {
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    userScrolledUpRef.current = false;
    setShowScrollToBottom(false);
    pin();
    requestAnimationFrame(pin);
    setTimeout(() => {
      pin();
      syncScrollState();
    }, 80);
  }, [syncScrollState]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(`/api/claude/sessions/${encodeURIComponent(sessionName)}/chat`);
        if (!res.ok) {
          // 404 = まだ chat 履歴なし。エラー表示はしない。
          if (res.status !== 404) throw new Error(`HTTP ${res.status}`);
          if (!disposed) {
            setServerChat([]);
            setScreenBlocked(false);
            setDeliveryWarning(null);
          }
        } else {
          const json = (await res.json()) as {
            chat: ChatMessage[];
            status?: SessionStatus;
            pending?: Pending | null;
            source?: 'claude' | 'codex';
            codexHookHealth?: CodexHookHealth | null;
            codexNeedsHookAttention?: boolean;
            screenBlocked?: true;
            deliveryWarning?: { sentAt: number };
          };
          if (!disposed) {
            // 合成メッセージ (status 表示用に server 側で動的注入したもの) は
            // PC chat では dot インジケータが既にあるので除外。G2 はこれを表示する。
            const next = (json.chat ?? []).filter((m) => !m.synthetic);
            setServerChat((prev) => sameChatMessages(prev, next) ? prev : next);
            if (json.status) setStatus(json.status);
            setSource(json.source);
            setCodexHookHealth(json.codexHookHealth ?? null);
            setCodexNeedsHookAttention(json.codexNeedsHookAttention === true);
            setScreenBlocked(json.screenBlocked === true);
            setDeliveryWarning(json.deliveryWarning ?? null);
            // pending が変わった(or null になった)ら入力中の選択肢/メモを破棄して
            // 別の質問に持ち越さないようにする
            setPendingInter((prev) => {
              const incoming = json.pending ?? null;
              if (prev?.id !== incoming?.id) {
                setQSelections({});
                setQSelectionsMulti({});
                setQNotes({});
                setQFreeText({});
                setQKind({});
                setPermMessage('');
                setCurrentQIdx(0);
              }
              return incoming;
            });
            // pending のうち、サーバ側に取り込まれたものを除去 (role+text 一致で判定)。
            // 同一文言を 2 回送るケースに備えて 1 件だけ消す。
            setPending((prev) => {
              if (prev.length === 0) return prev;
              const remaining: ChatMessage[] = [];
              const consumed = new Set<number>();
              let confirmed = false;
              const nowTs = Date.now();
              // サーバ側に記録済みの最新 ts。これがこの楽観投稿より新しければ「会話が
              // 進んだのに取り込まれなかった=取り残された」と判断できる。
              const newestServerTs = next.reduce((m, x) => (x.ts > m ? x.ts : m), 0);
              for (const pm of prev) {
                let matchedIdx = -1;
                for (let i = 0; i < next.length; i++) {
                  if (consumed.has(i)) continue;
                  const s = next[i];
                  // サーバ側は sanitize (trim 等) 済みなので、正規化して突き合わせる。
                  if (s.role === pm.role && normalizeForMatch(s.text) === normalizeForMatch(pm.text)) {
                    matchedIdx = i;
                    break;
                  }
                }
                if (matchedIdx === -1) {
                  const age = nowTs - pm.ts;
                  // 会話がこの投稿より新しいメッセージまで進んでいる (取り残された) か、
                  // 超長時間 (TTL) 一致しないものだけ破棄。ターン処理中でキュー待ちの投稿
                  // (まだ新しいサーバメッセージが無い) は破棄しない=消えない。
                  const superseded = newestServerTs > pm.ts && age > OPTIMISTIC_SUPERSEDE_GRACE_MS;
                  if (!superseded && age <= OPTIMISTIC_PENDING_TTL_MS) remaining.push(pm);
                } else {
                  consumed.add(matchedIdx);
                  confirmed = true;
                }
              }
              if (confirmed) scrollAfterPendingConfirmRef.current = true;
              return remaining;
            });
          }
        }
        if (!disposed) setError(null);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
      if (!disposed) timer = setTimeout(tick, 1500);
    };
    tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionName]);

  useEffect(() => {
    setVisibleLimit(INITIAL_VISIBLE_MESSAGES);
  }, [sessionName]);

  // displayChat が伸びたら自動末尾追従(履歴遡り中はしない)
  useEffect(() => {
    if (displayChat.length > lastLenRef.current && !userScrolledUpRef.current) {
      scrollToBottom();
    }
    lastLenRef.current = displayChat.length;
  }, [displayChat.length, scrollToBottom]);

  // 楽観的 user 投稿が serverChat の確定メッセージに置き換わる時は、
  // DOM 上では pending の灰色吹き出しが消えて白い確定吹き出しに置換される。
  // メッセージ数が増えないため通常の length 監視では拾えないので、専用に末尾へ戻す。
  useEffect(() => {
    if (!scrollAfterPendingConfirmRef.current) return;
    scrollAfterPendingConfirmRef.current = false;
    scrollToBottom();
  }, [pending.length, serverChat, scrollToBottom]);

  // 状態が変化(idle → busy 等)した時にも末尾追従。ユーザが下にいたなら、
  // 新しく現れた「考え中」インジケータが見える位置に揃える。
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      scrollToBottom();
    }
  }, [status, scrollToBottom]);

  const onScroll = () => {
    syncScrollState();
  };

  const send = useCallback(async () => {
    const text = input;
    if (!text.trim() || sending) return;

    // 楽観的 UI 更新: 送信直後にチャット表示へ即時反映
    const optimistic: ChatMessage = { role: 'user', text, ts: Date.now() };
    setPending((p) => [...p, optimistic]);
    setInput('');
    // 送信は「ユーザが意図して末尾へ戻りたい」操作なので、
    // useEffect 経由の auto-scroll ガードに頼らず明示的に末尾固定する。
    scrollToBottom();

    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, submit: true }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      // 送信失敗時は楽観的メッセージを取り除いて入力欄に戻す
      setPending((p) => p.filter((m) => m !== optimistic));
      setInput(text);
      setError((e as Error).message);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [input, sending, sessionName, scrollToBottom]);

  // スマホ等のタッチデバイスでは Enter を送信に使わない (PC キーボードと違い
  // ソフトキーボードでは改行入力に Enter を使うのが自然)。pointer: coarse で
  // 判定: タッチ主体のデバイスのみ true。物理キーボード接続のタブレットなど
  // 例外はあるが、送信ボタンが常にあるので機能的には支障なし。
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    const isTouch =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(pointer: coarse)').matches;
    if (isTouch) return; // 改行扱い (preventDefault しない)
    e.preventDefault();
    void send();
  };

  // 画像をサーバにアップロード → 取得した path を `@path ` 形式でカーソル位置に挿入。
  // Claude Code は `@/path/to/file.png` で画像を読み込める(v2.1.121+ で自動圧縮)。
  const insertAtCursor = useCallback((text: string) => {
    const ta = inputRef.current;
    setInput((prev) => {
      if (!ta) return prev + text;
      const start = ta.selectionStart ?? prev.length;
      const end = ta.selectionEnd ?? prev.length;
      const next = prev.slice(0, start) + text + prev.slice(end);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          const pos = start + text.length;
          inputRef.current.setSelectionRange(pos, pos);
          inputRef.current.focus();
        }
      });
      return next;
    });
  }, []);

  const handleImageFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of files) {
        try {
          const r = await uploadImage(f);
          insertAtCursor(`@${r.path} `);
        } catch (e) {
          setError(`${t('uploadFailedPrefix')} (${f.name}): ${(e as Error).message}`);
        }
      }
    } finally {
      setUploading(false);
    }
  }, [insertAtCursor, t]);

  const onPaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = extractImagesFromClipboard(e.clipboardData.items);
    if (images.length > 0) {
      e.preventDefault();
      await handleImageFiles(images);
    }
  }, [handleImageFiles]);

  // pending への応答送信
  const respondToPending = useCallback(async (
    body: { kind: 'permission'; decision: 'allow' | 'deny'; message?: string }
       | {
           kind: 'question';
           answers: Array<{
             question: string;
             answerKind?: 'predefined' | 'type-something' | 'chat-about-this';
             option?: string;
             options?: string[];
             text?: string;
             notes?: string;
           }>;
         },
  ) => {
    if (!pendingInter || respondingPending) return;
    setRespondingPending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/claude/sessions/${encodeURIComponent(sessionName)}/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // lang: chat 履歴に残る回答整形文をブラウザ選択言語でサーバに作らせる
          // pendingId: 画面を開いている間に用件が入れ替わっていたらサーバに弾かせる
          // (古い画面で作った回答が別の用件に適用されるのを防ぐ)
          body: JSON.stringify({ ...body, lang: language, pendingId: pendingInter.id }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      // 楽観的にローカル pending を消す。次の poll でサーバ側からも消える(が一足早く UI 反映)。
      setPendingInter(null);
      setQSelections({});
      setQNotes({});
      setPermMessage('');
    } catch (e) {
      setError(`${t('respondFailedPrefix')}: ${(e as Error).message}`);
    } finally {
      setRespondingPending(false);
    }
  }, [pendingInter, respondingPending, sessionName, language, t]);

  const submitQuestion = useCallback(() => {
    if (!pendingInter?.questions) return;
    const answers = pendingInter.questions.map((q, i) => {
      const kind = qKind[i] ?? 'predefined';
      if (kind === 'chat-about-this') {
        return { question: q.question, answerKind: 'chat-about-this' as const };
      }
      if (kind === 'type-something') {
        return {
          question: q.question,
          answerKind: 'type-something' as const,
          text: qFreeText[i] ?? '',
        };
      }
      const multi = q.multiSelect;
      if (multi) {
        return {
          question: q.question,
          answerKind: 'predefined' as const,
          options: qSelectionsMulti[i] ?? [],
        };
      }
      return {
        question: q.question,
        answerKind: 'predefined' as const,
        option: qSelections[i] ?? '',
        notes: (qNotes[i] ?? '').trim() || undefined,
      };
    });
    // 検証: predefined は option 必須、type-something は text 必須、
    // chat-about-this は何も必要なし。chat-about-this が含まれている場合は他の質問は無視。
    if (answers.some((a) => a.answerKind === 'chat-about-this')) {
      void respondToPending({ kind: 'question', answers });
      return;
    }
    if (answers.some((a) => {
      if (a.answerKind === 'predefined') {
        // multi-select は options 配列、single-select は option
        if (a.options) return a.options.length === 0;
        return !a.option;
      }
      if (a.answerKind === 'type-something') return !(a.text ?? '').trim();
      return false;
    })) {
      setError(t('unansweredQuestions'));
      return;
    }
    void respondToPending({ kind: 'question', answers });
  }, [pendingInter, qSelections, qSelectionsMulti, qNotes, qFreeText, qKind, respondToPending, t]);

  const submitPermission = useCallback((decision: 'allow' | 'deny') => {
    void respondToPending({
      kind: 'permission',
      decision,
      message: permMessage.trim() || undefined,
    });
  }, [permMessage, respondToPending]);

  // textarea の高さを行数に合わせて伸ばす。max-height は CSS 側で打ち、
  // 越えた分は overflow-y: auto でスクロール。input が空になったら 1 行に戻す。
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    // textarea の伸縮で .chat-scroller (flex:1) のビューポート高さが変わる。
    // 末尾に居たユーザを置き去りにしないよう、入力で textarea が伸びた瞬間も
    // 末尾追従する。手で上に遡って読んでいるユーザは userScrolledUpRef が true
    // なので触らない。
    if (!userScrolledUpRef.current) {
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [input]);

  return (
    <div className="page-session chat-view">
      <header className="session-header">
        <button onClick={onBack} aria-label={t('back')}>{t('back')}</button>
        <span className="session-title">{sessionName}</span>
        {modeTabs}
      </header>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="chat-scroller"
        style={scrollerPaddingBottom ? { paddingBottom: scrollerPaddingBottom } : undefined}
      >
        {screenBlocked && (
          <div className="chat-diagnostic chat-diagnostic-blocked">
            <div className="chat-diagnostic-title">⚠ {t('screenBlockedTitle')}</div>
            <div className="chat-diagnostic-body">{t('screenBlockedBody')}</div>
          </div>
        )}

        {source === 'codex' && codexHookHealth && (codexHookHealth.status !== 'ok' || codexNeedsHookAttention) && (
          <div className="chat-diagnostic">
            <div className="chat-diagnostic-title">
              {codexHookHealth.status === 'missing'
                ? t('codexHooksMissingTitle')
                : codexHookHealth.status === 'incomplete'
                ? t('codexHooksIncompleteTitle')
                : t('codexHooksNeedTrustTitle')}
            </div>
            <div className="chat-diagnostic-body">
              {codexHookHealth.notes[0] ?? t('codexHooksNeedTrustBody')}
              {codexHookHealth.missingEvents.length > 0 && (
                <div>{t('codexHooksMissingEvents')}: {codexHookHealth.missingEvents.join(', ')}</div>
              )}
            </div>
            <code className="chat-diagnostic-command">{codexHookHealth.setupCommand}</code>
          </div>
        )}

        {displayChat.length === 0 ? (
          <div className="chat-empty">{t('chatEmpty')}</div>
        ) : (
          <>
            {hasOlderChat && (
              <button
                type="button"
                className="chat-show-older"
                onClick={() => setVisibleLimit((limit) => limit + VISIBLE_MESSAGES_STEP)}
              >
                {t('showOlderMessages')}
                <span>{visibleStart} {t('hiddenMessagesCount')}</span>
              </button>
            )}
            {visibleChat.map((m, i) => {
              const globalIndex = visibleStart + i;
              const isPending = globalIndex >= filteredServerCount;
              return (
                <ChatMessageItem
                  key={m.role + ':' + m.ts + ':' + globalIndex + ':' + m.text.slice(0, 32)}
                  message={m}
                  isPending={isPending}
                  t={t}
                />
              );
            })}
          </>
        )}
        {status !== 'idle' && (
          <div className={`chat-status chat-status-${status}`}>
            <span className="chat-status-dot" aria-hidden="true" />
            <span className="chat-status-text">
              {status === 'busy' && t('statusBusy')}
              {status === 'waiting-permission' && t('statusWaitingPermission')}
              {status === 'waiting-question' && t('statusWaitingQuestion')}
            </span>
          </div>
        )}

        {pendingInter?.kind === 'question' && pendingInter.questions && pendingInter.questions.length > 0 && (() => {
          const totalQ = pendingInter.questions.length;
          const idx = Math.max(0, Math.min(currentQIdx, totalQ));
          // 各質問が回答済みか
          const isAnswered = (i: number): boolean => {
            const k = qKind[i] ?? 'predefined';
            if (k === 'chat-about-this') return true;
            if (k === 'type-something') return (qFreeText[i] ?? '').trim().length > 0;
            // predefined: multi-select は配列に 1 件以上、single-select は label がある
            const q = pendingInter.questions?.[i];
            if (q?.multiSelect) return (qSelectionsMulti[i] ?? []).length > 0;
            return typeof qSelections[i] === 'string' && (qSelections[i] as string).length > 0;
          };
          const allAnswered = pendingInter.questions.every((_q, i) => isAnswered(i));
          const hasChatAbout = pendingInter.questions.some((_q, i) => qKind[i] === 'chat-about-this');

          // 確認&送信画面
          if (idx === totalQ) {
            return (
              <div className="chat-pending">
                <div className="chat-pending-title">
                  {hasChatAbout ? t('confirmCancelTitle') : t('confirmAnswersTitle')}
                </div>
                {pendingInter.questions.map((q, qi) => {
                  const k = qKind[qi] ?? 'predefined';
                  return (
                    <div key={qi} className="chat-pending-summary">
                      <div className="chat-pending-summary-q">
                        Q{qi + 1}. {q.question}
                      </div>
                      <div className="chat-pending-summary-a">
                        {k === 'chat-about-this' && t('summaryChatAbout')}
                        {k === 'type-something' && (
                          <>→ <span style={{ fontStyle: 'italic' }}>{t('freeTextParen')}</span> {qFreeText[qi] ?? ''}</>
                        )}
                        {k === 'predefined' && (() => {
                          const isMulti = !!q.multiSelect;
                          if (isMulti) {
                            const arr = qSelectionsMulti[qi] ?? [];
                            if (arr.length === 0) return <em>{t('unanswered')}</em>;
                            return <>→ {arr.join(', ')}</>;
                          }
                          if (!qSelections[qi]) return <em>{t('unanswered')}</em>;
                          return (
                            <>
                              → {qSelections[qi]}
                              {qNotes[qi]?.trim() && (
                                <span className="chat-pending-summary-note">{t('notePrefix')}{qNotes[qi]}</span>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}
                <div className="chat-pending-actions">
                  <button
                    type="button"
                    className="chat-pending-back"
                    onClick={() => setCurrentQIdx(totalQ - 1)}
                    disabled={respondingPending}
                  >
                    {t('back')}
                  </button>
                  <button
                    type="button"
                    className="chat-pending-submit"
                    onClick={submitQuestion}
                    disabled={respondingPending || (!allAnswered && !hasChatAbout)}
                  >
                    {respondingPending
                      ? t('sendingEllipsis')
                      : hasChatAbout
                      ? t('sendCancellation')
                      : allAnswered
                      ? t('send')
                      : t('unansweredRemain')}
                  </button>
                </div>
              </div>
            );
          }

          const q = pendingInter.questions[idx];
          const kind = qKind[idx] ?? 'predefined';
          const selected = qSelections[idx];
          const isMulti = !!q.multiSelect;
          const multiArr = qSelectionsMulti[idx] ?? [];
          return (
            <div className="chat-pending">
              <div className="chat-pending-title">
                {t('questionFromClaude')} ({idx + 1} / {totalQ}){isMulti && <span className="chat-pending-multi-badge">{t('multiSelectBadge')}</span>}
              </div>
              <div className="chat-pending-q">
                {q.header && <div className="chat-pending-header">{q.header}</div>}
                <div className="chat-pending-qtext">{q.question}</div>

                {/* predefined 選択肢: multi-select はチェックボックス相当 / single-select は radio 相当 */}
                <div className="chat-pending-options">
                  {(q.options ?? []).map((opt, oi) => {
                    const active = kind === 'predefined' && (
                      isMulti ? multiArr.includes(opt.label) : selected === opt.label
                    );
                    return (
                      <button
                        key={oi}
                        type="button"
                        className={`chat-pending-option${active ? ' active' : ''}${isMulti ? ' multi' : ''}`}
                        onClick={() => {
                          setQKind((k) => ({ ...k, [idx]: 'predefined' }));
                          if (isMulti) {
                            // toggle
                            setQSelectionsMulti((s) => {
                              const cur = s[idx] ?? [];
                              const next = cur.includes(opt.label)
                                ? cur.filter((l) => l !== opt.label)
                                : [...cur, opt.label];
                              return { ...s, [idx]: next };
                            });
                            // multi-select は手動で「次へ」を押してもらう(自動進行しない)
                          } else {
                            setQSelections((s) => ({ ...s, [idx]: opt.label }));
                            if (!(qNotes[idx] ?? '').trim()) {
                              setCurrentQIdx(idx + 1);
                            }
                          }
                        }}
                        disabled={respondingPending || kind === 'type-something'}
                      >
                        <span className="chat-pending-option-check">
                          {isMulti ? (active ? '☑' : '☐') : (active ? '●' : '○')}
                        </span>
                        <span className="chat-pending-option-body">
                          <div className="chat-pending-option-label">{opt.label}</div>
                          {opt.description && (
                            <div className="chat-pending-option-desc">{opt.description}</div>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {/* 補足メモ (single-select の predefined option を選んだときに添えて送れる) */}
                {kind !== 'type-something' && !isMulti && (
                  <textarea
                    className="chat-pending-notes"
                    placeholder={t('notesPlaceholder')}
                    rows={1}
                    value={qNotes[idx] ?? ''}
                    onChange={(e) => setQNotes((n) => ({ ...n, [idx]: e.target.value }))}
                    disabled={respondingPending}
                  />
                )}

                {/* Type something */}
                {kind !== 'type-something' ? (
                  <button
                    type="button"
                    className="chat-pending-extra"
                    onClick={() => setQKind((k) => ({ ...k, [idx]: 'type-something' }))}
                    disabled={respondingPending}
                  >
                    {t('typeSomethingBtn')}
                  </button>
                ) : (
                  <div className="chat-pending-typesomething">
                    <div className="chat-pending-typesomething-label">{t('freeTextLabel')}</div>
                    <textarea
                      className="chat-pending-notes"
                      placeholder={t('freeTextPlaceholder')}
                      rows={2}
                      value={qFreeText[idx] ?? ''}
                      onChange={(e) => setQFreeText((n) => ({ ...n, [idx]: e.target.value }))}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="chat-pending-cancel-type"
                      onClick={() => {
                        setQKind((k) => { const { [idx]: _, ...rest } = k; return rest; });
                        setQFreeText((n) => { const { [idx]: _, ...rest } = n; return rest; });
                      }}
                    >
                      {t('cancelFreeText')}
                    </button>
                  </div>
                )}

                {/* Chat about this */}
                <button
                  type="button"
                  className="chat-pending-chat-about"
                  onClick={() => {
                    if (window.confirm(t('chatAboutConfirm'))) {
                      setQKind((k) => ({ ...k, [idx]: 'chat-about-this' }));
                      setCurrentQIdx(totalQ); // 直接確認画面へ
                    }
                  }}
                  disabled={respondingPending}
                >
                  {t('chatAboutBtn')}
                </button>
              </div>
              <div className="chat-pending-actions">
                <button
                  type="button"
                  className="chat-pending-back"
                  onClick={() => setCurrentQIdx(idx - 1)}
                  disabled={idx === 0 || respondingPending}
                >
                  {t('back')}
                </button>
                {isAnswered(idx) && (
                  <button
                    type="button"
                    className="chat-pending-next"
                    onClick={() => setCurrentQIdx(idx + 1)}
                    disabled={respondingPending}
                  >
                    {idx + 1 === totalQ ? t('toReview') : t('next')}
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {pendingInter?.kind === 'permission' && (
          <div className="chat-pending">
            <div className="chat-pending-title">{t('permRequestTitle')}</div>
            <div className="chat-pending-tool">tool: <code>{pendingInter.toolName}</code></div>
            <pre className="chat-pending-toolinput">
              {(() => {
                try { return JSON.stringify(pendingInter.toolInput, null, 2); }
                catch { return String(pendingInter.toolInput); }
              })()}
            </pre>
            <textarea
              className="chat-pending-notes"
              placeholder={t('permMessagePlaceholder')}
              rows={1}
              value={permMessage}
              onChange={(e) => setPermMessage(e.target.value)}
            />
            <div className="chat-pending-actions">
              <button
                type="button"
                className="chat-pending-submit allow"
                onClick={() => submitPermission('allow')}
                disabled={respondingPending}
              >
                {t('allow')}
              </button>
              <button
                type="button"
                className="chat-pending-submit deny"
                onClick={() => submitPermission('deny')}
                disabled={respondingPending}
              >
                {t('deny')}
              </button>
            </div>
          </div>
        )}
      </div>
      {showScrollToBottom && (
        <button
          type="button"
          className="chat-floating-bottom"
          onClick={scrollToBottom}
          aria-label={t('scrollToBottom')}
          title={t('scrollToBottom')}
          style={{ bottom: `${(keyboardHeight > 0 ? keyboardHeight : 0) + chatInputHeight + 12}px` }}
        >
          <span aria-hidden="true">↓</span>
          {t('scrollToBottom')}
        </button>
      )}
      {error && <div className="chat-error">{t('sendErrorPrefix')}: {error}</div>}
      {/* 送達未確認の注意は入力欄のすぐ上に出す (次に送るかどうかの判断材料なので)。
          画面ブロックの注意が出ている時は原因が同じなので、そちらに任せて重ねない。 */}
      {deliveryWarning && !screenBlocked && (
        <div className="chat-delivery-warning">⚠ {t('deliveryUnconfirmed')}</div>
      )}
      <form
        ref={chatInputRef}
        className="chat-input"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
        style={
          keyboardHeight > 0
            ? { ...chatInputKeyboardStyle, left: 0, right: 0 }
            : undefined
        }
      >
        <button
          type="button"
          className="chat-attach"
          onClick={() => fileInputRef.current?.click()}
          aria-label={t('attachImage')}
          title={t('attachImageTitlePaste')}
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
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={uploading ? t('uploadingEllipsis') : t('messageInputPlaceholder')}
          rows={1}
          disabled={sending}
        />
        <button type="submit" disabled={sending || !input.trim()}>
          {sending ? '...' : t('send')}
        </button>
      </form>
    </div>
  );
}
