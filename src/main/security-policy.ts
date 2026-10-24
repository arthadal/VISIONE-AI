// Politica di rete e di origine del renderer (VISIONE_SECURITY_MODEL §1, §3). Funzioni pure:
// nessun import di `electron`, così sono testabili e riusate dalla configurazione di build (CSP).
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RendererOrigin {
  /** Cartella del renderer compilato (build); null in sviluppo. */
  readonly rendererDir: string | null;
  /** URL del server di sviluppo di Vite (solo sviluppo); null nella build. */
  readonly devServerUrl: string | null;
}

function insideDir(file: string, dir: string): boolean {
  const rel = relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sameDevOrigin(url: URL, devServerUrl: string | null): boolean {
  if (devServerUrl === null) return false;
  const dev = new URL(devServerUrl);
  const host = (h: string): string => (h === '127.0.0.1' || h === '[::1]' ? 'localhost' : h);
  return host(url.hostname) === host(dev.hostname) && url.port === dev.port;
}

/**
 * Una richiesta del renderer è consentita solo verso i file del renderer (build), il server di
 * sviluppo locale (http/ws, solo sviluppo), `data:`/`blob:` e gli strumenti di sviluppo.
 * Tutto il resto, in particolare qualunque host esterno, è bloccato.
 */
export function isAllowedRendererRequest(rawUrl: string, origin: RendererOrigin): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  switch (url.protocol) {
    case 'data:':
    case 'blob:':
    case 'devtools:':
      return true;
    // Anteprime dell'Esplora (11/10/2026): servite dal main, che rifà la politica sul percorso reale.
    case 'visione-file:':
    case 'visione-thumb:':
      return true;
    case 'file:':
      return origin.rendererDir !== null && insideDir(fileURLToPath(url), origin.rendererDir);
    case 'http:':
    case 'ws:':
      return sameDevOrigin(url, origin.devServerUrl);
    default:
      return false;
  }
}

/** Pagina da cui il main accetta messaggi IPC: solo l'entry del renderer di VISIONE. */
export function isTrustedRendererUrl(rawUrl: string, origin: RendererOrigin): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'file:') return origin.rendererDir !== null && insideDir(fileURLToPath(url), origin.rendererDir);
  if (url.protocol === 'http:') return sameDevOrigin(url, origin.devServerUrl);
  return false;
}

/**
 * Permessi del browser concessi alla pagina di VISIONE (mai ad altre origini): il microfono per la
 * voce (Fase 9), la webcam per il widget Umanoide (11/10/2026: solo se il proprietario lo accende dal
 * widget; le immagini restano nel renderer, mai salvate né inviate) e la SOLA SCRITTURA negli appunti (`clipboard-sanitized-write`) per i pulsanti «Copia»
 * della procedura guidata. P-105, collaudo del 10/10/2026: era negata e i comandi da copiare non si
 * copiavano. La lettura degli appunti resta negata: il renderer mostra testo generato dagli agenti e
 * non deve poter leggere ciò che l'utente ha copiato altrove.
 */
export function isAllowedRendererPermission(permission: string, trusted: boolean, mediaTypes?: readonly string[]): boolean {
  if (!trusted) return false;
  if (permission === 'media') return mediaTypes === undefined || (mediaTypes.length > 0 && mediaTypes.every((t) => t === 'audio' || t === 'video'));
  return permission === 'clipboard-sanitized-write';
}

/** Content-Security-Policy del renderer. In sviluppo consente solo il websocket HMR locale. */
/**
 * Browser di VISIONE (12/10/2026, richiesta del proprietario): la partizione separata delle sue pagine
 * (cookie e accessi a parte, nessun contatto con la sessione di VISIONE).
 */
export const BROWSER_PARTITION = 'persist:visione-browser';

/** Il browser apre solo pagine web: http, https e la pagina vuota. Niente file:, javascript:, schemi di VISIONE. */
export function isBrowsableUrl(url: string): boolean {
  if (url === 'about:blank') return true;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Permessi concessi alle pagine del browser: schermo intero e scrittura negli appunti; il resto no. */
export function isAllowedBrowserPermission(permission: string): boolean {
  return permission === 'fullscreen' || permission === 'clipboard-sanitized-write';
}

export function contentSecurityPolicy(dev: boolean): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // Esplora (11/10/2026): miniature e immagini dagli schemi del main (politica sul percorso reale).
    "img-src 'self' data: visione-file: visione-thumb:",
    "media-src visione-file:",
    "font-src 'self'",
    // I worker del Neural (blob:) sono generati dal renderer e non devono essere bloccati.
    "worker-src 'self' blob:",
    `connect-src 'self'${dev ? ' ws://localhost:*' : ''}`,
    "base-uri 'none'",
    "form-action 'none'",
    // Browser di VISIONE (12/10/2026): il suo <webview> conta come frame; solo pagine web. Nessun'altra
    // parte della pagina crea frame.
    "frame-src https: http:",
    "object-src 'none'"
  ].join('; ');
}
