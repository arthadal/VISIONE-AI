// Browser di VISIONE (12/10/2026): barra degli indirizzi. Un indirizzo resta un indirizzo; il resto è una
// ricerca (DuckDuckGo: niente profilazione; dichiarato nell'informativa). Funzioni pure, testate.

/** Partizione delle pagine del browser: deve coincidere con quella ammessa dal main (security-policy.ts). */
export const BROWSER_PARTITION = 'persist:visione-browser';
export const BROWSER_HOME = 'https://duckduckgo.com/';
const SEARCH = 'https://duckduckgo.com/?q=';

/** Ciò che si scrive nella barra → indirizzo da aprire (null se vuoto). */
export function addressToUrl(input: string): string | null {
  const s = input.trim();
  if (s === '') return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^about:blank$/i.test(s)) return 'about:blank';
  // «localhost:3000», «192.168.1.1», «esempio.it/percorso»: indirizzi senza schema.
  if (!/\s/.test(s) && (/^localhost(?::\d+)?(?:\/|$)/i.test(s) || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(s))) return `http://${s}`;
  if (!/\s/.test(s) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(s)) return `https://${s}`;
  return `${SEARCH}${encodeURIComponent(s)}`;
}
