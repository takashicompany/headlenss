import { useCallback, useState, type ReactNode } from 'react';
import { useLanguage } from '../i18n.tsx';
import type { WebTab } from './SessionTabs.tsx';

// 登録タブ (成果物 HTML / dev server) を iframe で表示する画面。
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

export function PreviewView({
  sessionName,
  tabs,
  activeTab,
  opened,
  loaded,
  hidden,
  onBack,
  onRefresh,
  modeTabs,
}: {
  sessionName: string;
  tabs: WebTab[];
  /** いま選ばれているタブ名。tabs に無い名前のこともある (宣言が消えた等) */
  activeTab: string | null;
  /** 一度でも開いたタブ名。ここに入っている iframe は DOM に残す */
  opened: string[];
  loaded: boolean;
  hidden: boolean;
  onBack: () => void;
  /** タブ一覧の取り直し (?v=<mtime> が変われば iframe も載せ替わる) */
  onRefresh: () => Promise<void>;
  modeTabs: ReactNode;
}) {
  const { t } = useLanguage();
  // 再読込は iframe を作り直す (同じ URL でも no-store なので取り直しになる)。
  const [reloadKeys, setReloadKeys] = useState<Record<string, number>>({});

  const active = tabs.find((tb) => tb.name === activeTab) ?? null;

  // https で開いている画面に http:// の URL は埋め込めない (mixed content)。
  // 出せないものを黙って白紙で出すより、理由と逃げ道を書く。
  const isBlockedMixed = (tab: WebTab): boolean =>
    window.location.protocol === 'https:' && tab.url.startsWith('http://');

  const reload = useCallback(() => {
    if (activeTab) setReloadKeys((prev) => ({ ...prev, [activeTab]: (prev[activeTab] ?? 0) + 1 }));
    void onRefresh();
  }, [activeTab, onRefresh]);

  return (
    <div className={`page-session preview-view${hidden ? ' preview-view--hidden' : ''}`}>
      <header className="session-header">
        <button onClick={onBack} aria-label={t('back')}>{t('back')}</button>
        <span className="session-title">{sessionName}</span>
        <button
          type="button"
          className="preview-action"
          onClick={reload}
          title={t('previewReload')}
          aria-label={t('previewReload')}
          disabled={active === null}
        >
          ↻
        </button>
        {active !== null && (
          <a
            className="preview-action preview-action--link"
            href={active.url}
            target="_blank"
            rel="noopener noreferrer"
            title={t('previewOpenExternal')}
          >
            ↗
          </a>
        )}
        {modeTabs}
      </header>

      <div className="preview-stage">
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
    </div>
  );
}
