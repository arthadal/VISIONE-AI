// Esplora VISIONE (11/10/2026): calcolo puro e testato della finestra — tipi di anteprima,
// percorso cliccabile, ordinamento, selezione multipla (clic, Ctrl, Maiusc), formati.
// Gli URL delle anteprime hanno la stessa forma di `src/main/file-protocol.ts` (provato nei test).
import type { Language } from '../../../shared/contracts/index.ts';

export interface ExplorerEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly size: number | null;
  readonly modifiedAt: number | null;
}

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other';
export type SortKey = 'name' | 'date' | 'size';

const EXT: Readonly<Record<PreviewKind, readonly string[]>> = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'],
  video: ['mp4', 'm4v', 'webm', 'ogv', 'mov'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'opus'],
  pdf: ['pdf'],
  text: ['txt', 'md', 'markdown', 'json', 'jsonl', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'htm', 'xml', 'csv', 'log', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'toml', 'bat', 'cmd', 'ps1', 'sh', 'py', 'cs', 'java', 'c', 'h', 'cpp', 'hpp', 'go', 'rs', 'sql', 'env', 'gitignore', 'vbs', 'reg'],
  other: []
};

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? (name.startsWith('.') ? name.slice(1).toLowerCase() : '') : name.slice(i + 1).toLowerCase();
}

export function previewKind(name: string): PreviewKind {
  const ext = extOf(name);
  for (const kind of ['image', 'video', 'audio', 'pdf', 'text'] as const) if (EXT[kind].includes(ext)) return kind;
  return 'other';
}

/** Ha una miniatura di Windows utile (foto, video, prima pagina del PDF)? */
export function hasThumb(name: string): boolean {
  const k = previewKind(name);
  return k === 'image' || k === 'video' || k === 'pdf';
}

/** Glifo del tipo, per i file senza miniatura. */
export function glyphOf(entry: Pick<ExplorerEntry, 'name' | 'kind'>): string {
  if (entry.kind === 'directory') return '▤';
  switch (previewKind(entry.name)) {
    case 'audio': return '♪';
    case 'text': return '≡';
    case 'video': return '▶';
    case 'image': return '◩';
    case 'pdf': return '▦';
    default: return '▢';
  }
}

/** Nome mostrato: come Esplora risorse, i collegamenti non mostrano «.lnk»/«.url». */
export function displayName(name: string): string {
  const m = /^(.+)\.(lnk|url)$/i.exec(name);
  return m ? m[1]! : name;
}

export const fileUrl = (path: string): string => `visione-file://local/${encodeURIComponent(path)}`;
export const thumbUrl = (path: string, size: number): string => `visione-thumb://local/${encodeURIComponent(path)}?s=${size}`;

const SEP = /[\\/]/;
const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase();

/**
 * Percorso cliccabile: dalla radice consentita che contiene il percorso (la più lunga), poi una
 * tappa per cartella. Sopra la radice non si sale (la politica del core lo negherebbe).
 */
export function crumbs(path: string, roots: ReadonlyArray<{ readonly name: string; readonly path: string }>): Array<{ label: string; path: string }> {
  const p = norm(path);
  const root = [...roots].filter((r) => p === norm(r.path) || p.startsWith(`${norm(r.path)}\\`) || p.startsWith(`${norm(r.path)}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  if (!root) return [{ label: path.split(SEP).filter(Boolean).pop() ?? path, path }];
  const out = [{ label: root.name, path: root.path }];
  const rest = path.slice(root.path.replace(/[\\/]+$/, '').length).split(SEP).filter(Boolean);
  let acc = root.path.replace(/[\\/]+$/, '');
  for (const part of rest) {
    acc = `${acc}\\${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

/** Cartelle sempre prima; poi per nome (naturale), data (recenti prima) o dimensione (grandi prima). */
export function sortEntries(entries: readonly ExplorerEntry[], key: SortKey, lang: Language = 'it'): ExplorerEntry[] {
  const byName = (a: ExplorerEntry, b: ExplorerEntry): number => a.name.localeCompare(b.name, lang === 'en' ? 'en' : 'it', { numeric: true, sensitivity: 'base' });
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    if (key === 'date') return (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) || byName(a, b);
    if (key === 'size') return (b.size ?? 0) - (a.size ?? 0) || byName(a, b);
    return byName(a, b);
  });
}

/** Selezione come in Esplora risorse: clic = solo quello, Ctrl = aggiunge/toglie, Maiusc = intervallo dall'ancora. */
export function selectAt(
  current: ReadonlySet<string>, entries: readonly ExplorerEntry[], index: number,
  mods: { ctrl: boolean; shift: boolean }, anchor: number | null
): { selection: Set<string>; anchor: number } {
  const entry = entries[index];
  if (!entry) return { selection: new Set(current), anchor: anchor ?? 0 };
  if (mods.shift && anchor !== null && entries[anchor]) {
    const [a, b] = anchor <= index ? [anchor, index] : [index, anchor];
    const range = entries.slice(a, b + 1).map((e) => e.path);
    const base = mods.ctrl ? new Set(current) : new Set<string>();
    for (const p of range) base.add(p);
    return { selection: base, anchor };
  }
  if (mods.ctrl) {
    const next = new Set(current);
    if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
    return { selection: next, anchor: index };
  }
  return { selection: new Set([entry.path]), anchor: index };
}

export function formatSize(bytes: number | null, lang: Language = 'it'): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : lang === 'en' ? v.toFixed(1) : v.toFixed(1).replace('.', ',')} ${units[u]}`;
}

/** `locale`: «it-IT» o «en-GB» (vedi `localeFor`). */
export function formatDate(ms: number | null, locale: string): string {
  if (ms === null) return '';
  return new Date(ms).toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Il drop è valido? Mai su sé stessi o dentro una propria sottocartella, mai nella stessa cartella per lo spostamento. */
export function canDrop(paths: readonly string[], targetDir: string, parentOf: (p: string) => string): boolean {
  const t = norm(targetDir);
  return paths.length > 0 && paths.every((p) => {
    const n = norm(p);
    return t !== n && !t.startsWith(`${n}\\`) && !t.startsWith(`${n}/`) && norm(parentOf(p)) !== t;
  });
}

export function parentPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return i <= 0 ? trimmed : trimmed.slice(0, i);
}

/**
 * Percorso accorciato per la barra: la radice, «…» (porta all'ultima tappa nascosta e ne mostra i
 * nomi) e le ultime `keep` tappe, così la cartella corrente si vede sempre.
 */
export function shortCrumbs(trail: ReadonlyArray<{ label: string; path: string }>, keep = 3): Array<{ label: string; path: string; hidden?: string }> {
  if (trail.length <= keep + 2) return [...trail];
  const hidden = trail.slice(1, trail.length - keep);
  return [trail[0]!, { label: '…', path: hidden.at(-1)!.path, hidden: hidden.map((c) => c.label).join(' › ') }, ...trail.slice(-keep)];
}
