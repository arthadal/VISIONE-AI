// Applicazione della politica di sicurezza alla sessione e ai webContents di Electron.
import { app, type Session, type WebContents } from 'electron';
import type { Logger } from '../shared/node/logging.ts';
import { BROWSER_PARTITION, isAllowedBrowserPermission, isAllowedRendererPermission, isAllowedRendererRequest, isBrowsableUrl, isTrustedRendererUrl, type RendererOrigin } from './security-policy.ts';

export function installSessionGuards(session: Session, origin: RendererOrigin, log: Logger): void {
  const reported = new Set<string>();
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const allowed = isAllowedRendererRequest(details.url, origin);
    if (!allowed) {
      let key = details.url;
      try {
        key = new URL(details.url).origin;
      } catch {
        // URL non analizzabile: si registra così com'è
      }
      if (!reported.has(key)) {
        reported.add(key);
        log.warn('richiesta di rete del renderer bloccata', { origin: key, resourceType: details.resourceType });
      }
    }
    callback({ cancel: !allowed });
  });
  // Solo microfono e scrittura negli appunti alla pagina di VISIONE (`isAllowedRendererPermission`):
  // tutto il resto è negato.
  const trustedMedia = (url: string): boolean => isTrustedRendererUrl(url, origin) || (origin.rendererDir !== null && url.startsWith('file:'));
  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    if (isAllowedRendererPermission(permission, trustedMedia(details.requestingUrl), mediaTypes)) {
      callback(true);
      return;
    }
    log.warn('permesso negato al renderer', { permission, url: details.requestingUrl });
    callback(false);
  });
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    isAllowedRendererPermission(permission, trustedMedia(details.requestingUrl || requestingOrigin)));
}

/**
 * Niente nuove finestre, navigazione, webview. Unica eccezione (12/10/2026): il <webview> del browser
 * di VISIONE, nella sua partizione, senza preload né Node, isolato e in sandbox: la pagina web non vede
 * `window.visione` e non tocca nulla di VISIONE.
 */
export function hardenWebContents(contents: WebContents, log: Logger): void {
  if (contents.getType() === 'webview') {
    hardenBrowserPage(contents, log);
    return;
  }
  contents.setWindowOpenHandler(({ url }) => {
    log.warn('apertura di finestra negata', { url });
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) {
      event.preventDefault();
      log.warn('navigazione negata', { url });
    }
  });
  contents.on('will-redirect', (event, url) => {
    event.preventDefault();
    log.warn('redirect negato', { url });
  });
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    if (params.partition !== BROWSER_PARTITION || !isBrowsableUrl(params.src ?? '')) {
      event.preventDefault();
      log.warn('webview negata', { partition: params.partition });
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.webviewTag = false;
  });
}

/** Pagine del browser: navigano solo sul web; i «nuovi finestre» si aprono nella stessa scheda. */
function hardenBrowserPage(contents: WebContents, log: Logger): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isBrowsableUrl(url)) void contents.loadURL(url);
    return { action: 'deny' };
  });
  const guard = (event: { preventDefault(): void }, url: string): void => {
    if (isBrowsableUrl(url)) return;
    event.preventDefault();
    log.warn('navigazione del browser negata', { scheme: url.split(':')[0]?.slice(0, 20) });
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/** Sessione del browser: permessi minimi (schermo intero, scrittura negli appunti), il resto negato. */
export function installBrowserSession(browser: Session, log: Logger): void {
  browser.setPermissionRequestHandler((_wc, permission, callback) => {
    const ok = isAllowedBrowserPermission(permission);
    if (!ok) log.info('permesso negato a una pagina del browser', { permission });
    callback(ok);
  });
  browser.setPermissionCheckHandler((_wc, permission) => isAllowedBrowserPermission(permission));
}

export function installAppGuards(log: Logger): void {
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, log));
}
