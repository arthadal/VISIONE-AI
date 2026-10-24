// Anti-collisione delle etichette della scena (P-95). Puro, senza DOM e senza three: riceve le
// label già proiettate dai renderer (JARVIS e ufficio pixel) e decide DOVE disegnarle, con
// priorità, offset e distanziamento. P-98 (richiesta del proprietario): le label degli AGENTI e del
// Director sono **sempre visibili e a posizione fissa** — l'algoritmo non le ritira più: se i posti
// vicini all'ancora sono occupati cerca in tutta l'area (scansione regolare) e, solo se l'area è
// davvero satura, sceglie la sovrapposizione minima. Nessun dato inventato: sposta solo le
// etichette reali, non cambia né testo né stato. Le info del popover (nome, ruolo, stato, provider,
// modello, sessione, ultimo segnale) sono calcolate da una funzione PURA testabile.
// Inglese (P-108): le funzioni che producono testo accettano una lingua facoltativa (default `it`: senza
// il parametro il testo è quello italiano di sempre); i dizionari stanno in `lib/i18n/areas/widgets.ts`.
import type { Language } from '../../shared/contracts/index.ts';
import { translate, type MessageKey } from '../lib/i18n/index.ts';
import { formatAgo } from '../lib/time.ts';

export interface SceneLabel {
  id: string;
  text: string;
  kind: string;
  status: string;
  x: number;
  y: number;
  /** Centro del nodo in pixel CSS (l'ancora della label, mai toccata). */
  nx: number;
  ny: number;
  /** Raggio del nodo in pixel CSS. */
  r: number;
  /** Nodo selezionato o sotto il puntatore. */
  hot: boolean;
}

export interface LabelArea {
  width: number;
  height: number;
}

/** P-100: margini dell'area utile (le colonne del dock, la topbar e la barra inferiore coprono la scena). */
export interface LabelInsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const NO_INSETS: LabelInsets = { left: 0, top: 0, right: 0, bottom: 0 };

/** Stati per cui una label resta visibile: gli inattivi si nominano al passaggio/selezione. */
export const ACTIVE_STATUS: ReadonlySet<string> = new Set([
  'working', 'running', 'queued', 'waiting', 'pending', 'starting', 'error', 'failed', 'blocked', 'timed_out'
]);

/**
 * La label è mostrata? P-98: agenti, Director e substrato sono SEMPRE visibili (posizione fissa);
 * gli altri nodi si nominano sotto il puntatore/selezione o quando il loro stato è attivo.
 */
export function labelVisible(label: Pick<SceneLabel, 'id' | 'kind' | 'status'>, hovered: string | null, selected: string | null): boolean {
  if (label.kind === 'agent') return true;
  return label.id === 'director' || label.id === 'visione'
    || label.id === hovered || label.id === selected
    || ACTIVE_STATUS.has(label.status);
}

/**
 * Dimensione stimata della label in pixel CSS: una riga con il nome (le info complete dell'hover
 * vivono nel popover, fuori dal flusso). La stima serve SOLO al posizionamento: il testo disegnato
 * resta quello reale.
 */
export function labelSize(label: Pick<SceneLabel, 'text'>): { w: number; h: number } {
  const w = Math.min(340, Math.max(56, Math.round(label.text.length * 9.4) + 26));
  const h = 20;
  return { w, h };
}

/** Priorità di piazzamento: hot prima, poi coordinatore e substrato, poi gli agenti attivi. */
export function labelPriority(label: Pick<SceneLabel, 'id' | 'kind' | 'status' | 'hot'>): number {
  if (label.hot) return 0;
  if (label.id === 'director') return 1;
  if (label.id === 'visione') return 2;
  if (label.kind === 'agent' && (label.status === 'working' || label.status === 'starting' || label.status === 'waiting' || label.status === 'error')) return 3;
  return 4;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 3;
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const overlapArea = (a: Box, b: Box): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * Piazzamento deterministico delle label visibili: ognuna cerca la prima posizione libera partendo
 * dall'ancora reale (a destra del nodo), poi impilando sopra/sotto, a sinistra, sotto/sopra il nodo
 * e infine con una scansione regolare di tutta l'area (la più vicina all'ancora). P-98: nessuna
 * label viene ritirata — se l'area è satura si sceglie la sovrapposizione minima.
 */
export function resolveLabelCollisions<T extends SceneLabel>(labels: readonly T[], area: LabelArea, insets: LabelInsets = NO_INSETS): T[] {
  // Prima del layout (canvas a 0) non si sposta nulla: si disegna dove proietta il renderer.
  if (area.width <= 40 || area.height <= 40) return labels.slice();
  const iL = Math.max(0, insets.left);
  const iT = Math.max(0, insets.top);
  const iR = Math.max(0, insets.right);
  const iB = Math.max(0, insets.bottom);
  const minX = PAD + iL;
  const minY = PAD + iT;
  const placed: Array<{ label: T; box: Box }> = [];
  const sorted = [...labels].sort((a, b) => labelPriority(a) - labelPriority(b) || a.y - b.y || a.id.localeCompare(b.id));
  for (const label of sorted) {
    const { w, h } = labelSize(label);
    const maxX = Math.max(minX, area.width - iR - w - PAD);
    const maxY = Math.max(minY, area.height - iB - h - PAD);
    const box = (x: number, y: number): Box => ({ x: clamp(x, minX, maxX), y: clamp(y, minY, maxY), w, h });
    const baseX = clamp(label.x, PAD, maxX);
    const baseY = clamp(label.y, PAD, maxY);
    const leftX = label.nx - label.r - 10 - w;
    const centerX = label.nx - w / 2;
    const downY = label.ny + label.r + 6;
    const upY = label.ny - label.r - 6 - h;
    const candidates: Box[] = [];
    // Destra: ancora, sotto, sopra, due passi sotto/sopra…
    for (let k = 0; k < 13; k++) {
      const dy = k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * (h + 4);
      candidates.push(box(baseX, baseY + dy));
    }
    // Sinistra: ancora, sotto, sopra.
    for (let k = 0; k < 7; k++) {
      const dy = k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * (h + 4);
      candidates.push(box(leftX, baseY + dy));
    }
    // Sotto e sopra al nodo (centrate sull'ancora del globo).
    candidates.push(box(centerX, downY));
    candidates.push(box(centerX, upY));
    let chosen = candidates.find((c) => !placed.some((p) => overlap(p.box, c))) ?? null;
    if (chosen === null) {
      // Scansione regolare dell'area utile: la prima posizione libera più vicina all'ancora reale.
      const stepY = h + 4;
      const stepX = Math.max(26, Math.round(w / 3));
      let best: { box: Box; d: number } | null = null;
      for (let y = minY; y <= maxY; y += stepY) {
        for (let x = minX; x <= maxX; x += stepX) {
          const c: Box = { x, y, w, h };
          if (placed.some((p) => overlap(p.box, c))) continue;
          const d = Math.hypot(c.x - label.x, c.y - label.y);
          if (best === null || d < best.d) best = { box: c, d };
        }
      }
      chosen = best?.box ?? null;
      if (chosen === null) {
        // Area satura: si piazza comunque (mai ritirata) nel punto di sovrapposizione minima.
        let minima = Infinity;
        for (const c of candidates) {
          const o = placed.reduce((sum, p) => sum + overlapArea(p.box, c), 0);
          if (o < minima) {
            minima = o;
            chosen = c;
          }
        }
      }
    }
    if (chosen !== null) placed.push({ label: { ...label, x: chosen.x, y: chosen.y }, box: chosen });
  }
  return placed.map((p) => p.label);
}

// --- Info del popover di hover (P-98): solo dati reali, funzione pura e testabile -----------------

// --- P-100: chiusura del popover con × (pura, testabile) -----------------------------------------

/**
 * Il proprietario ha chiuso il popover di un nodo con ×: resta chiuso finché il puntatore non
 * lascia il nodo, anche se il nodo è ancora caldo (hover o selezione). Immutabile.
 */
export function dismissPopover(closed: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(closed);
  next.add(id);
  return next;
}

/** Il puntatore lascia il nodo (o la scena): la chiusura si dimentica e il popover potrà riapparire. */
export function clearDismissed(closed: ReadonlySet<string>, id: string | null): ReadonlySet<string> {
  if (closed.size === 0) return closed;
  if (id === null) return new Set<string>();
  if (!closed.has(id)) return closed;
  return new Set([...closed].filter((x) => x !== id));
}

export interface NodeInfoField {
  k: string;
  v: string;
}

export interface NodeInfoInput {
  /** Ruolo mostrato (DIRETTORE/AGENTE/SUBSTRATO…): arriva dalla tabella della vista. */
  role: string;
  /** P-99: tipo del nodo (kind reale del grafo): serve alla spiegazione e alla riga «tipo». */
  kind?: string;
  text: string;
  status: string;
  /** Motivo REALE dello stato (istanza agente), se presente. */
  statusReason?: string | null;
  /** Adapter/provider reale della definizione dell'agente. */
  adapter?: string | null;
  /** Modello reale (definizione o sessione). */
  model?: string | null;
  /** Id della sessione reale (salvata o dell'istanza). */
  sessionId?: string | null;
  /** Ultimo evento reale ricevuto dal nodo (ms). */
  lastEventAt?: number;
  /** Adesso (ms) per l'età del segnale; iniettabile per i test. */
  now?: number;
  /** Lingua dei testi prodotti (valori «mai», «s fa», «MAI AVVIATO», spiegazione); default italiano. */
  lang?: Language;
}

/**
 * P-99 — spiegazione in italiano semplice di cos'è un nodo e perché c'è. Solo il tipo reale del
 * grafo decide il testo; nessun dato inventato, nessuna promessa sul futuro. Per gli stati di
 * errore la frase resta neutra: il motivo vero, se esiste, è nella riga «stato».
 */
export function nodeExplanation(kind: string, lang: Language = 'it'): string {
  switch (kind) {
    case 'visione':
      return translate(lang, 'widgets.neural.explain.visione');
    case 'director':
      return translate(lang, 'widgets.neural.explain.director');
    case 'agent':
      return translate(lang, 'widgets.neural.explain.agent');
    case 'tool':
      return translate(lang, 'widgets.neural.explain.tool');
    case 'task':
      return translate(lang, 'widgets.neural.explain.task');
    case 'memory':
      return translate(lang, 'widgets.neural.explain.memory');
    case 'process':
      return translate(lang, 'widgets.neural.explain.process');
    case 'approval':
      return translate(lang, 'widgets.neural.explain.approval');
    default:
      return translate(lang, 'widgets.neural.explain.default');
  }
}

/** Ruolo mostrato nella label (SUBSTRATO / COORDINATORE / AGENTE…); un tipo ignoto resta il suo nome in maiuscolo. */
export function nodeRoleLabel(kind: string, lang: Language = 'it'): string {
  switch (kind) {
    case 'visione': return translate(lang, 'widgets.neural.role.visione');
    case 'director': return translate(lang, 'widgets.neural.role.director');
    case 'agent': return translate(lang, 'widgets.neural.role.agent');
    case 'tool': return translate(lang, 'widgets.neural.role.tool');
    case 'task': return translate(lang, 'widgets.neural.role.task');
    case 'memory': return translate(lang, 'widgets.neural.role.memory');
    case 'process': return translate(lang, 'widgets.neural.role.process');
    case 'approval': return translate(lang, 'widgets.neural.role.approval');
    default: return kind.toUpperCase();
  }
}

/**
 * Nome mostrato di un nodo. I nodi di servizio nascono nel motore con un nome italiano di ripiego
 * («Memoria», «approvazione», «strumento»): qui, al momento di mostrarli, seguono la lingua. Ogni altro
 * nome (agenti, Director, task, strumenti veri) arriva dai dati e resta com'è.
 */
export function nodeDisplayName(id: string, kind: string, text: string, lang: Language = 'it'): string {
  if (id === 'memory' && text === 'Memoria') return translate(lang, 'widgets.neural.node.memory');
  if (kind === 'approval' && text === 'approvazione') return translate(lang, 'widgets.neural.node.approval');
  if (kind === 'tool' && text === 'strumento') return translate(lang, 'widgets.neural.node.tool');
  return text;
}

/**
 * Etichetta mostrata di una riga del popover. `NodeInfoField.k` resta l'identificatore stabile
 * (italiano, usato da chi riconosce le righe, p.es. «spiegazione»): la lingua cambia solo il testo mostrato.
 */
export function nodeFieldLabel(k: string, lang: Language = 'it'): string {
  const keys: Record<string, MessageKey> = {
    nome: 'widgets.neural.field.nome',
    ruolo: 'widgets.neural.field.ruolo',
    tipo: 'widgets.neural.field.tipo',
    stato: 'widgets.neural.field.stato',
    provider: 'widgets.neural.field.provider',
    modello: 'widgets.neural.field.modello',
    sessione: 'widgets.neural.field.sessione',
    'ultimo segnale': 'widgets.neural.field.ultimoSegnale',
    spiegazione: 'widgets.neural.field.spiegazione'
  };
  return Object.hasOwn(keys, k) ? translate(lang, keys[k]!) : k;
}

/**
 * Righe del popover di hover, nell'ordine richiesto: nome, ruolo, tipo, stato, provider, modello,
 * sessione, ultimo segnale, spiegazione. Un campo assente si dichiara «—» (mai inventato).
 */
export function nodeInfoFields(i: NodeInfoInput): NodeInfoField[] {
  const now = typeof i.now === 'number' && Number.isFinite(i.now) ? i.now : 0;
  const at = typeof i.lastEventAt === 'number' && i.lastEventAt > 0 ? i.lastEventAt : 0;
  const lang = i.lang ?? 'it';
  const ultimo = at > 0 && now > 0 ? formatAgo(now - at, lang) : translate(lang, 'widgets.neural.never');
  // P-100: per un AGENTE lo stato `created` significa «definito ma mai avviato» (globo bianco):
  // il popover lo dice in italiano semplice, il resto resta lo stato tecnico reale.
  const label = i.kind === 'agent' && i.status === 'created' ? translate(lang, 'widgets.neural.neverStarted') : i.status.toUpperCase();
  const stato = i.statusReason ? `${label} · ${i.statusReason}` : label;
  return [
    { k: 'nome', v: i.text },
    { k: 'ruolo', v: i.role },
    { k: 'tipo', v: i.kind ?? '—' },
    { k: 'stato', v: stato },
    { k: 'provider', v: i.adapter ? i.adapter : '—' },
    { k: 'modello', v: i.model ? i.model : '—' },
    { k: 'sessione', v: i.sessionId ? i.sessionId : '—' },
    { k: 'ultimo segnale', v: ultimo },
    { k: 'spiegazione', v: i.kind !== undefined ? nodeExplanation(i.kind, lang) : '—' }
  ];
}
