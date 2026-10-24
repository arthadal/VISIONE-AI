// Start di VISIONE (11/10/2026, richiesta del proprietario): a schermo intero un tasto in basso a
// sinistra apre un pannello nello stile di VISIONE — ricerca unica (app, impostazioni, file), app
// fissate, cartelle rapide, recenti, accensione — con dentro il pulsante per lo Start vero di Windows.
// Qui il calcolo puro e testato; le preferenze (fissate, recenti) restano su questo PC.

export interface StartApp {
  readonly id: string;
  readonly name: string;
}

export interface StartPrefs {
  /** Id delle app fissate, nell'ordine scelto. */
  readonly pins: readonly string[];
  /** File e cartelle aperti di recente (il più recente prima). */
  readonly recent: ReadonlyArray<{ readonly path: string; readonly name: string; readonly kind: 'file' | 'directory' }>;
}

export const START_PREFS_KEY = 'visione.start.v1';
export const MAX_PINS = 12;
export const MAX_RECENT = 10;
export const EMPTY_START_PREFS: StartPrefs = { pins: [], recent: [] };

const fold = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Punteggio di una voce per la ricerca: inizio del nome > inizio di una parola > contenuto; -1 = no. */
export function matchScore(name: string, query: string): number {
  const q = fold(query.trim());
  if (q === '') return 0;
  const n = fold(name);
  if (n.startsWith(q)) return 3;
  if (n.split(/[\s\-_.()]+/).some((w) => w.startsWith(q))) return 2;
  return n.includes(q) ? 1 : -1;
}

/** App che corrispondono alla ricerca, le migliori prima (a parità, in ordine alfabetico della lingua `locale`). */
export function rankApps(apps: readonly StartApp[], query: string, limit = 8, locale = 'it'): StartApp[] {
  return apps
    .map((a) => ({ a, s: matchScore(a.name, query) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name, locale))
    .slice(0, limit)
    .map((x) => x.a);
}

/** Impostazioni che corrispondono (per etichetta o spiegazione), da aprire nella finestra Impostazioni. */
export function rankSettings(meta: Readonly<Record<string, { readonly label: string; readonly help?: string }>>, query: string, limit = 5, locale = 'it'): Array<{ path: string; label: string }> {
  if (query.trim() === '') return [];
  return Object.entries(meta)
    .map(([path, m]) => ({ path, label: m.label, s: Math.max(matchScore(m.label, query), matchScore(m.help ?? '', query) >= 2 ? 0 : -1) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => y.s - x.s || x.label.localeCompare(y.label, locale))
    .slice(0, limit)
    .map(({ path, label }) => ({ path, label }));
}

/** Fissa o sgancia un'app (al più `MAX_PINS`, le più vecchie escono). */
export function togglePin(prefs: StartPrefs, id: string): StartPrefs {
  if (prefs.pins.includes(id)) return { ...prefs, pins: prefs.pins.filter((p) => p !== id) };
  return { ...prefs, pins: [...prefs.pins, id].slice(-MAX_PINS) };
}

/** Aggiunge un file/cartella ai recenti (in testa, senza doppioni, al più `MAX_RECENT`). */
export function addRecent(prefs: StartPrefs, item: StartPrefs['recent'][number]): StartPrefs {
  const key = item.path.toLowerCase();
  return { ...prefs, recent: [item, ...prefs.recent.filter((r) => r.path.toLowerCase() !== key)].slice(0, MAX_RECENT) };
}

/** Lettura tollerante delle preferenze salvate (dati corrotti → vuoto, mai un errore). */
export function readStartPrefs(raw: string | null): StartPrefs {
  if (!raw) return EMPTY_START_PREFS;
  try {
    const v = JSON.parse(raw) as Partial<StartPrefs>;
    const pins = Array.isArray(v.pins) ? v.pins.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 200).slice(0, MAX_PINS) : [];
    const recent = Array.isArray(v.recent)
      ? v.recent.filter((r): r is StartPrefs['recent'][number] => r !== null && typeof r === 'object' && typeof r.path === 'string' && typeof r.name === 'string' && (r.kind === 'file' || r.kind === 'directory')).slice(0, MAX_RECENT)
      : [];
    return { pins, recent };
  } catch {
    return EMPTY_START_PREFS;
  }
}

/** Iniziali per la tessera di un'app senza icona: «Visual Studio Code» → «VS». */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
