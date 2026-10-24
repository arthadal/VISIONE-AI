// Browser di VISIONE (12/10/2026, richiesta del proprietario): il web dentro VISIONE, in una finestra
// come le altre (si ingrandisce a tutto schermo, si riduce, si chiude). Non è il browser predefinito di
// Windows — quello non si può incorporare — ma lo stesso motore (Chromium), con accessi e cookie suoi;
// «Apri nel browser predefinito» passa la pagina a quello di Windows. La pagina sta in un <webview>
// isolato: partizione a parte, niente preload né Node (guardie nel main, security.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n/index.ts';
import { addressToUrl, BROWSER_HOME, BROWSER_PARTITION } from './browser-logic.ts';

/** Ciò che si usa del <webview> di Electron (tipo locale: il renderer non importa i tipi di Electron). */
interface WebviewEl extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
}

export function BrowserPane({ start }: { start: string | null }) {
  const t = useT();
  const ref = useRef<WebviewEl | null>(null);
  const first = useRef(start && /^https?:/.test(start) ? start : BROWSER_HOME);
  const [address, setAddress] = useState(first.current);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const sync = (): void => {
      try {
        setNav({ back: wv.canGoBack(), forward: wv.canGoForward() });
        if (!editing) setAddress(wv.getURL());
      } catch {
        // prima di dom-ready i metodi non ci sono ancora
      }
    };
    const onReady = (): void => { setReady(true); sync(); };
    const onStart = (): void => { setLoading(true); setError(null); };
    const onStop = (): void => { setLoading(false); sync(); };
    const onNav = (): void => sync();
    const onTitle = (e: Event): void => setTitle(String((e as Event & { title?: string }).title ?? ''));
    const onFail = (e: Event): void => {
      const f = e as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      // -3 = navigazione interrotta (un clic su un altro link): non è un errore.
      if (f.isMainFrame === false || f.errorCode === -3) return;
      setError(f.errorDescription || String(f.errorCode ?? ''));
    };
    wv.addEventListener('dom-ready', onReady);
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    wv.addEventListener('page-title-updated', onTitle);
    wv.addEventListener('did-fail-load', onFail);
    return () => {
      wv.removeEventListener('dom-ready', onReady);
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('did-navigate', onNav);
      wv.removeEventListener('did-navigate-in-page', onNav);
      wv.removeEventListener('page-title-updated', onTitle);
      wv.removeEventListener('did-fail-load', onFail);
    };
  }, [editing]);

  const go = useCallback((input: string): void => {
    const url = addressToUrl(input);
    if (!url || !ref.current || !ready) return;
    setEditing(false);
    setAddress(url);
    void ref.current.loadURL(url).catch(() => { /* l'errore arriva da did-fail-load */ });
  }, [ready]);

  const external = (): void => {
    const url = ref.current && ready ? ref.current.getURL() : address;
    void window.visione.system.openExternal(url);
  };

  return (
    <div className="pane browser-pane" data-testid="win-browser">
      <form className="browser-bar" onSubmit={(e) => { e.preventDefault(); go(address); }}>
        <button type="button" onClick={() => ref.current?.goBack()} disabled={!nav.back} title={t('windows.browser.back')} aria-label={t('windows.browser.back')}>←</button>
        <button type="button" onClick={() => ref.current?.goForward()} disabled={!nav.forward} title={t('windows.browser.forward')} aria-label={t('windows.browser.forward')}>→</button>
        {loading
          ? <button type="button" onClick={() => ref.current?.stop()} title={t('windows.browser.stop')} aria-label={t('windows.browser.stop')}>✕</button>
          : <button type="button" onClick={() => ref.current?.reload()} disabled={!ready} title={t('windows.browser.reload')} aria-label={t('windows.browser.reload')}>⟳</button>}
        <button type="button" onClick={() => go(BROWSER_HOME)} disabled={!ready} title={t('windows.browser.home')} aria-label={t('windows.browser.home')}>⌂</button>
        <input
          className="browser-address"
          data-testid="browser-address"
          value={address}
          spellCheck={false}
          placeholder={t('windows.browser.placeholder')}
          aria-label={t('windows.browser.address')}
          onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setAddress(e.target.value)}
        />
        <button type="button" className="browser-external" onClick={external} title={t('windows.browser.externalTitle')} data-testid="browser-external">{t('windows.browser.external')}</button>
      </form>
      {error && <p className="error small browser-error">{t('windows.browser.failed', { error })}</p>}
      <div className="browser-view">
        <webview ref={ref as never} src={first.current} partition={BROWSER_PARTITION} data-testid="browser-webview" title={title} />
      </div>
    </div>
  );
}
