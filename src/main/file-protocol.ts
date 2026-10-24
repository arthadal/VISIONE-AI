// Esplora VISIONE (11/10/2026): anteprime dentro VISIONE senza dare il filesystem al renderer.
// Due schemi serviti dal main: `visione-file://` (il contenuto di un'immagine, di un video o di un
// audio, con le richieste parziali per scorrere i video) e `visione-thumb://` (la miniatura di
// Windows: foto, video, prima pagina dei PDF). STESSA politica del file manager del core: solo
// sotto la home dell'utente e la home di VISIONE, mai nelle radici protette, e il percorso reale
// (dopo i collegamenti) deve restare dentro. Funzioni pure qui; il collegamento a Electron è in index.
import { isAbsolute, normalize, resolve, sep } from 'node:path';

export const FILE_SCHEME = 'visione-file';
export const THUMB_SCHEME = 'visione-thumb';

export interface FilePolicy {
  readonly home: string;
  readonly visionHome: string;
  readonly protectedRoots: readonly string[];
}

const canon = (p: string): string => {
  const abs = normalize(resolve(p));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
};
const inside = (root: string, p: string): boolean => {
  const r = canon(root);
  const f = canon(p);
  return f === r || f.startsWith(r.endsWith(sep) ? r : r + sep);
};

/** Il percorso si può mostrare? Stessa regola del core: radici consentite, mai quelle protette. */
export function isServablePath(path: string, policy: FilePolicy): boolean {
  if (!isAbsolute(path)) return false;
  if (!inside(policy.home, path) && !inside(policy.visionHome, path)) return false;
  return !policy.protectedRoots.some((r) => inside(r, path));
}

/** URL dello schema per un percorso (lo costruisce il renderer con la stessa forma). */
export function schemeUrl(scheme: string, path: string, size?: number): string {
  return `${scheme}://local/${encodeURIComponent(path)}${size !== undefined ? `?s=${size}` : ''}`;
}

/** Percorso e dimensione dall'URL; null se l'URL non è dello schema o il percorso non è assoluto. */
export function parseSchemeUrl(rawUrl: string, scheme: string): { path: string; size: number } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:` || url.hostname !== 'local') return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
  if (path.length === 0 || path.length > 1_000 || path.includes('\0') || !isAbsolute(path)) return null;
  const s = Number(url.searchParams.get('s') ?? 256);
  return { path: normalize(path), size: Number.isFinite(s) ? Math.min(1_024, Math.max(32, Math.round(s))) : 256 };
}

const MIME: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', opus: 'audio/ogg'
};

/** Tipo del contenuto servibile; null = non si serve (il resto si vede come miniatura o testo). */
export function mimeOf(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? null;
}

/** Intervallo di una richiesta parziale («bytes=0-», «bytes=100-199»); null = tutto il file. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (header === null || header.trim() === '') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    // «bytes=-500»: gli ultimi 500 byte.
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}
