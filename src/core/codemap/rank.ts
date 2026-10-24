// Mappa del codice (P-107l): dal testo del compito ai file e alle righe da guardare. Le parole del compito
// si cercano nei nomi dei simboli e nei percorsi; i file collegati dagli import (il grafo) dei più
// pertinenti salgono un po'. Come una «repo map»: poche righe al posto di un'esplorazione. Funzioni pure.
import { CODEMAP_LIMITS } from '../../shared/contracts/index.ts';
import type { CodeSymbol } from './symbols.ts';

export interface IndexedFile {
  readonly id: number;
  /** Relativo alla radice, con le barre in avanti. */
  readonly path: string;
  /** `importKey(path)`: come lo nominano gli import degli altri file. */
  readonly key: string;
  readonly symbols: readonly CodeSymbol[];
  readonly imports: readonly string[];
}

export interface Ranked {
  readonly file: IndexedFile;
  readonly score: number;
  /** Simboli trovati, dal più pertinente. */
  readonly matched: readonly CodeSymbol[];
  /** Entrato perché collegato (import) a questo file. */
  readonly via: string | null;
  /** Parte del punteggio dovuta alle parole del compito stesse (non alle traduzioni né al grafo). */
  readonly direct: number;
}

// Parole che non distinguono un file da un altro: articoli, verbi delle richieste, nomi generici.
const STOP = new Set(`
che per con del della delle dei degli nel nella nelle negli una uno gli non sono come dove quando anche piu poi questo questa
questi queste quello quella tutto tutti tutte fare fai fammi deve devi puoi essere stato stata alla alle allo dal dalla dai sul
sulla sui tra fra cosa cose solo prima dopo ogni mio mia miei tuo tua suo sua nostro nostra aggiungi modifica correggi crea
scrivi controlla verifica sistema metti togli usa usare rendi rimuovi voglio vorrei serve bisogna ancora invece molto bene male
nuovo nuova nuovi gia qui ecco quindi perche cerca trova mostra dimmi spiega fai fallo farlo deve dovrebbe quale quali
file files codice code funzione funzioni function functions classe classi class metodo metodi method progetto project
cartella folder app applicazione programma script riga righe line lines
the and for with from that this these those into when where what which should would could make add fix update change create
write check use all any some new not are was were has have can will please also then than there here only just about after
before each every need want like does doesn how why its our your their them they you
`.split(/\s+/).filter((w) => w.length > 0));

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

// Chi usa VISIONE scrive in italiano, il codice è quasi sempre in inglese: le parole italiane frequenti nei
// compiti portano con sé i nomi inglesi che si trovano nel codice (cercati con peso minore). La chiave è
// l'inizio della parola italiana.
const VOCAB: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['appunti', ['clipboard']], ['allegat', ['attach', 'attachment']], ['incoll', ['paste']], ['trascin', ['drag', 'drop']],
  ['terminal', ['terminal', 'shell']], ['interromp', ['interrupt', 'cancel']], ['promemori', ['reminder']],
  ['ricord', ['remind', 'reminder']], ['appuntament', ['appointment']], ['agend', ['agenda']],
  ['impostazion', ['settings', 'config']], ['avvio', ['start', 'startup', 'boot']], ['avvia', ['start', 'launch']],
  ['motor', ['engine', 'adapter']], ['finestr', ['window', 'pane']], ['pulsant', ['button']], ['salut', ['greeting', 'briefing']],
  ['tempo', ['time', 'duration']], ['tempi', ['time', 'duration']], ['durat', ['duration']], ['minut', ['minute']],
  ['giorn', ['day']], ['settiman', ['week']], ['ricerc', ['search']], ['cerca', ['search', 'find']],
  ['cartell', ['folder', 'directory']], ['scaric', ['download']], ['utent', ['user']], ['access', ['login', 'auth']],
  ['registr', ['log', 'record']], ['voce', ['voice', 'speech']], ['ascolt', ['listen', 'wake']], ['chiav', ['key']],
  ['memori', ['memory']], ['regol', ['rule', 'skill']], ['lingu', ['language', 'locale']], ['tradu', ['translate', 'i18n']],
  ['indirizz', ['address', 'url']], ['blocc', ['block', 'deny']], ['permett', ['allow']], ['spegn', ['shutdown', 'power']],
  ['chiud', ['close', 'quit']], ['salva', ['save']], ['elimin', ['delete', 'remove']], ['cancell', ['delete', 'remove']],
  ['cestin', ['trash']], ['spost', ['move']], ['copia', ['copy']], ['copiat', ['copy']], ['rinomin', ['rename']],
  // I file di una lingua finiscono spesso in «-en»: «when-en.ts», «intent-en.ts».
  ['notific', ['notify', 'notification']], ['ingles', ['english', 'en']], ['english', ['en']], ['schermat', ['screenshot', 'image']],
  ['immagin', ['image']], ['compit', ['task']], ['obiettiv', ['goal']], ['approvazion', ['approval']], ['fiduci', ['trust']],
  ['squadr', ['team']], ['grafic', ['chart', 'graph']], ['meteo', ['weather']], ['segnal', ['report']], ['licenz', ['license']],
  ['guida', ['guide', 'tour']], ['esplor', ['explorer']], ['pagin', ['page']], ['collegament', ['link', 'shortcut']],
  ['aggiorn', ['update', 'refresh']], ['installa', ['install', 'setup']], ['procedur', ['wizard', 'setup']],
  ['chiamat', ['call']], ['prezz', ['price']], ['carrell', ['cart']], ['fattur', ['invoice']], ['ordin', ['order']],
  ['pagament', ['payment']], ['prodott', ['product']], ['client', ['customer', 'client']], ['modul', ['form']],
  ['tabell', ['table']], ['elenc', ['list']], ['microfon', ['microphone', 'mic']], ['telecamer', ['camera', 'webcam']],
  ['volto', ['face']], ['scont', ['discount']], ['total', ['total']], ['somm', ['sum']], ['calcol', ['calculate', 'compute']],
  ['spedizion', ['shipping']], ['magazzin', ['inventory', 'stock']], ['iscri', ['signup', 'register']], ['accedi', ['login']],
  ['messaggi', ['message']], ['invia', ['send']], ['ricev', ['receive']], ['filtr', ['filter']], ['ordina', ['sort']],
  ['calendari', ['calendar']], ['event', ['event']], ['tema', ['theme']], ['scuro', ['dark']], ['stamp', ['print']],
  ['rumor', ['noise']], ['sveglia', ['wake', 'alarm']]
];

/**
 * Parole del compito utili alla ricerca (`terms`), traduzioni in inglese da cercare con peso minore
 * (`weak`) e nomi di file citati («context.ts»).
 */
export function taskTerms(text: string): { terms: string[]; weak: string[]; names: string[] } {
  const folded = fold(text);
  const names = [...new Set([...folded.matchAll(/[\w-]+\.[a-z][a-z0-9]{0,4}\b/g)].map((m) => m[0]).filter((n) => !/^\d/.test(n)))];
  const terms: string[] = [];
  const add = (w: string): void => {
    const t = w.toLowerCase();
    if (t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t) && !terms.includes(t)) terms.push(t);
  };
  for (const m of text.normalize('NFD').replace(/\p{M}+/gu, '').matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    const word = m[0];
    add(word);
    // «createContextBuilder» e «context_builder» trovano anche le parti.
    const parts = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').split(' ');
    if (parts.length > 1) for (const p of parts) add(p);
  }
  const weak: string[] = [];
  for (const t of terms) {
    for (const [key, english] of VOCAB) {
      if (!t.startsWith(key)) continue;
      for (const e of english) if (!terms.includes(e) && !weak.includes(e)) weak.push(e);
    }
  }
  return { terms: terms.slice(0, 24), weak: weak.slice(0, 16), names };
}

/** «createContextBuilder» → ['create', 'context', 'builder']. */
const partsOf = (name: string): string[] =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.\s]+/g, ' ').toLowerCase().split(' ').filter((p) => p.length > 0);

const commonPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

/** Peso di una parola contro un nome: uguale, una sua parte, contenuta, o con la stessa radice («parsed»/«parse»). */
export function nameWeight(t: string, name: string, parts: readonly string[], exported: boolean): number {
  if (name === t) return exported ? 7 : 6;
  if (parts.includes(t)) return 3;
  if (t.length < 4) return 0;
  if (name.includes(t)) return 2;
  if (t.length >= 5 && parts.some((p) => p.length >= 5 && Math.abs(p.length - t.length) <= 3 && commonPrefix(p, t) >= 5)) return 1.5;
  return 0;
}

const MIN_SCORE = 5;
/** Documenti (Markdown, testo) dopo il codice: servono, ma non è lì che si corregge. */
const DOC_FACTOR = 0.4;
const isDoc = (path: string): boolean => /\.(?:md|txt)$/i.test(path);
/** Riscontro minimo delle parole del compito stesse (non tradotte) perché la mappa entri. */
const MIN_DIRECT = 1;

/** I file da guardare per questo compito, dal più pertinente. */
export function rankFiles(files: readonly IndexedFile[], text: string, limit: number = CODEMAP_LIMITS.filesShown): Ranked[] {
  const { terms, weak, names } = taskTerms(text);
  const all = [...terms, ...weak];
  if (all.length === 0 && names.length === 0) return [];

  // Prima passata: quanto ogni parola trova in ogni file, e in quanti file compare.
  const raw: { f: IndexedFile; per: number[]; syms: Map<CodeSymbol, number>[] }[] = [];
  const df = new Array<number>(all.length).fill(0);
  for (const f of files) {
    const lowerPath = f.path.toLowerCase();
    const base = lowerPath.slice(lowerPath.lastIndexOf('/') + 1);
    const stem = base.replace(/\.[^.]+$/, '');
    const segParts = lowerPath.split('/').flatMap(partsOf);
    const symParts = f.symbols.map((s) => ({ s, n: s.name.toLowerCase(), parts: partsOf(s.name) }));
    const per: number[] = [];
    const syms: Map<CodeSymbol, number>[] = [];
    let any = names.includes(base);
    all.forEach((t, i) => {
      const pathScore = stem === t ? 6 : segParts.includes(t) ? 3 : t.length >= 4 && lowerPath.includes(t) ? 2 : 0;
      let symScore = 0;
      const hit = new Map<CodeSymbol, number>();
      for (const { s, n, parts } of symParts) {
        const w = nameWeight(t, n, parts, s.exported);
        if (w === 0) continue;
        hit.set(s, w);
        symScore += w;
      }
      const score = pathScore + Math.min(symScore, 8);
      per.push(score);
      syms.push(hit);
      if (score > 0) {
        df[i]! += 1;
        any = true;
      }
    });
    if (any) raw.push({ f, per, syms });
  }

  // Seconda passata: le parole rare pesano di più di quelle che compaiono ovunque nel progetto.
  const n = Math.max(files.length, 1);
  const factor = all.map((_, i) => {
    const rarity = Math.log(1 + n / Math.max(df[i]!, 1)) / Math.log(1 + n);
    return (0.25 + 1.35 * rarity) * (i >= terms.length ? 0.7 : 1);
  });
  const hits: Ranked[] = [];
  for (const { f, per, syms } of raw) {
    const base = f.path.toLowerCase().slice(f.path.lastIndexOf('/') + 1);
    let score = names.includes(base) ? 10 : 0;
    let direct = score;
    let covered = 0;
    const weight = new Map<CodeSymbol, number>();
    per.forEach((s, i) => {
      if (s === 0) return;
      covered += 1;
      score += s * factor[i]!;
      if (i < terms.length) direct += s * factor[i]!;
      for (const [sym, w] of syms[i]!) weight.set(sym, (weight.get(sym) ?? 0) + w * factor[i]!);
    });
    // Un file che copre più parole del compito vale più di uno che ne ripete una.
    if (covered > 1) score += 1.5 * (covered - 1);
    if (isDoc(f.path)) score *= DOC_FACTOR;
    if (score < MIN_SCORE) continue;
    const matched = [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0].line - b[0].line).map(([s]) => s);
    hits.push({ file: f, score, matched, via: null, direct });
  }
  // Le traduzioni aiutano a ordinare, ma da sole non bastano: un compito senza nessuna parola trovata
  // davvero nel codice (misura del 14/10: «ricordami di chiamare Luca», «che tempo fa domani») non è di
  // codice, e la mappa costerebbe token per niente.
  if (!hits.some((h) => h.direct >= MIN_DIRECT)) return [];
  hits.sort((a, b) => b.score - a.score || a.file.path.length - b.file.path.length);
  const top = hits.slice(0, limit);

  // Il grafo: per i primi file, chi importano e chi li importa (due per file, i più ricchi di simboli).
  const byKey = new Map(files.map((f) => [f.key, f]));
  const importers = new Map<string, IndexedFile[]>();
  for (const f of files) {
    for (const k of f.imports) {
      const list = importers.get(k);
      if (list) list.push(f);
      else importers.set(k, [f]);
    }
  }
  const shown = new Set(top.map((r) => r.file.id));
  const extra: Ranked[] = [];
  for (const r of top.slice(0, 4)) {
    const near = [
      ...r.file.imports.map((k) => byKey.get(k)).filter((f): f is IndexedFile => f !== undefined),
      ...(importers.get(r.file.key) ?? [])
    ].filter((f) => !shown.has(f.id) && f.symbols.length > 0)
      .sort((a, b) => b.symbols.length - a.symbols.length)
      .slice(0, 2);
    for (const f of near) {
      shown.add(f.id);
      extra.push({ file: f, score: r.score * 0.35, matched: [], via: r.file.path, direct: 0 });
    }
  }
  return [...top, ...extra].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Simboli da mostrare per un file: prima quelli trovati, poi i principali (esportati, non metodi). */
function symbolsFor(r: Ranked, max: number): CodeSymbol[] {
  const out = r.matched.slice(0, max);
  if (out.length < 3) {
    for (const s of r.file.symbols) {
      if (out.length >= Math.min(max, 4)) break;
      if (!out.includes(s) && s.kind !== 'method' && (s.exported || s.kind === 'section')) out.push(s);
    }
  }
  return out;
}

const clipName = (s: string): string => (s.length > 60 ? `${s.slice(0, 59)}…` : s);

/** Le righe della sezione del brief (vuoto se niente è pertinente). */
export function renderMap(root: string, total: number, ranked: readonly Ranked[], maxChars: number = CODEMAP_LIMITS.sectionChars): string[] {
  if (ranked.length === 0) return [];
  const lines = [`Cartella ${root} (${total} file indicizzati da VISIONE). File e righe che riguardano il compito, dal più pertinente: aprili prima di esplorare altro.`];
  let used = lines[0]!.length;
  for (const r of ranked) {
    const syms = symbolsFor(r, 6).map((s) => `${clipName(s.name)} (r. ${s.line})`).join(', ');
    const via = r.via ? ` · collegato a ${r.via.slice(r.via.lastIndexOf('/') + 1)}` : '';
    const line = `- ${r.file.path}${syms ? ` — ${syms}` : ''}${via}`.slice(0, 320);
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? lines : [];
}
