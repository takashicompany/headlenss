import { useCallback, useState, type Ref } from 'react';
import { useLanguage } from '../i18n.tsx';
import type { WebTab } from './SessionTabs.tsx';

// チャット画面の中のタブ (gamelab と同じ構造)。
//
//   ┌───────────────────────────────┐
//   │ 会話 または 開いている成果物   │  ← どちらか一方
//   ├───────────────────────────────┤
//   │ [ チャット ][ レポート ][ … ] │  ← タブ帯 (画面のいちばん下 = 親指で届く位置)
//   └───────────────────────────────┘
//
// タブ帯はヘッダの tmux / chat とは同格ではない。チャットの中の切り替えなので、
// 登録タブが 0 件のセッションでは帯そのものを出さない (従来のチャット画面と同じ)。
//
// 一度開いたタブの iframe は DOM に残したまま display:none で隠す。
// (ブラウザのタブと同じ扱い。スクロール位置や入力途中の状態を失わない)
//
// sandbox の付け方が 2 通りある。
//   - ファイル型: headlenss と同じ origin から配信されるので、allow-same-origin を
//     与えずに閉じ込める (親の localStorage / DOM に触れない)。
//   - URL 型: 別 origin の dev server / PWA。ブラウザの origin 分離がそのまま効くうえ、
//     sandbox を付けると Service Worker や localStorage が死んで PWA の確認にならない
//     ので、通常の iframe として載せる。

/** https の画面に http:// の URL は埋め込めない (mixed content) */
export function isBlockedMixed(tab: WebTab): boolean {
  return window.location.protocol === 'https:' && tab.url.startsWith('http://');
}

/** 再読込 (iframe を作り直す) の管理。同じ URL でも no-store なので取り直しになる。 */
export function useFrameReload(): {
  reloadKeys: Record<string, number>;
  bumpReload: (name: string) => void;
} {
  const [reloadKeys, setReloadKeys] = useState<Record<string, number>>({});
  const bumpReload = useCallback((name: string) => {
    setReloadKeys((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
  }, []);
  return { reloadKeys, bumpReload };
}

/** ヘッダに出す ↻ / ↗。プレビューのタブを開いている間だけ出す。 */
export function PreviewActions({
  active,
  onReload,
}: {
  active: WebTab;
  onReload: () => void;
}) {
  const { t } = useLanguage();
  return (
    <>
      <button
        type="button"
        className="preview-action"
        onClick={onReload}
        title={t('previewReload')}
        aria-label={t('previewReload')}
      >
        ↻
      </button>
      <a
        className="preview-action preview-action--link"
        href={active.url}
        target="_blank"
        rel="noopener noreferrer"
        title={t('previewOpenExternal')}
        aria-label={t('previewOpenExternal')}
      >
        ↗
      </a>
    </>
  );
}

/** 開いている成果物。チャットのタブに戻っている間も DOM に残す (hidden で隠すだけ)。 */
export function PreviewStage({
  tabs,
  activeTab,
  opened,
  loaded,
  hidden,
  reloadKeys,
}: {
  tabs: WebTab[];
  /** いま選ばれているタブ名。tabs に無い名前のこともある (宣言が消えた等) */
  activeTab: string | null;
  /** 一度でも開いたタブ名。ここに入っている iframe は DOM に残す */
  opened: string[];
  loaded: boolean;
  hidden: boolean;
  reloadKeys: Record<string, number>;
}) {
  const { t } = useLanguage();
  const active = tabs.find((tb) => tb.name === activeTab) ?? null;

  return (
    <div className={`preview-stage${hidden ? ' preview-stage--hidden' : ''}`}>
      {tabs
        .filter((tb) => opened.includes(tb.name) && !isBlockedMixed(tb))
        .map((tb) => (
          <iframe
            key={`${tb.name}:${reloadKeys[tb.name] ?? 0}`}
            className={`preview-frame${tb.name === activeTab ? '' : ' preview-frame--off'}`}
            src={tb.url}
            title={tb.name}
            // ファイル型だけ閉じ込める (理由はファイル冒頭のコメント)
            {...(tb.kind === 'file' ? { sandbox: 'allow-scripts allow-pointer-lock' } : {})}
          />
        ))}

      {active !== null && isBlockedMixed(active) && (
        <div className="preview-notice">
          <div className="preview-notice__title">⚠ {t('previewMixedTitle')}</div>
          <div className="preview-notice__body">{t('previewMixedBody')}</div>
          <a
            className="preview-notice__link"
            href={active.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('previewOpenExternal')}
          </a>
          <code className="preview-notice__url">{active.url}</code>
        </div>
      )}

      {active === null && (
        <div className="preview-notice">
          {!loaded ? (
            <div className="preview-notice__body">{t('loading')}</div>
          ) : (
            <>
              <div className="preview-notice__title">{t('previewTabMissingTitle')}</div>
              <div className="preview-notice__body">{t('previewTabMissingBody')}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 画面のいちばん下のタブ帯。`チャット | <登録タブ…>` を 1 本に並べる。
 * 登録タブが無ければ呼び出し側で描画しない (帯そのものを出さない)。
 */
export function Tabstrip({
  tabs,
  activeTab,
  onSelect,
  stripRef,
}: {
  tabs: WebTab[];
  /** null = チャットのタブを開いている */
  activeTab: string | null;
  onSelect: (name: string | null) => void;
  /** 帯の実高さを測るため (「一番下へ」ボタンの位置に使う) */
  stripRef?: Ref<HTMLDivElement>;
}) {
  const { t } = useLanguage();
  return (
    <div className="tabstrip" role="tablist" ref={stripRef}>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === null}
        className={`tab${activeTab === null ? ' tab--on' : ''}`}
        onClick={() => onSelect(null)}
      >
        {t('previewChatTab')}
      </button>
      {tabs.map((tb) => {
        const on = tb.name === activeTab;
        return (
          <button
            key={tb.name}
            type="button"
            role="tab"
            aria-selected={on}
            title={tb.name}
            className={`tab${on ? ' tab--on' : ''}`}
            onClick={() => onSelect(tb.name)}
          >
            {tb.name}
          </button>
        );
      })}
    </div>
  );
}
