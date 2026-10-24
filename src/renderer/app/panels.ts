// Pannelli del dock (P-96): chiudibili, a tendina, spostabili e ingrandibili. P-98: posizionamento
// LIBERO dei pannelli — oltre al riordino nelle colonne, un pannello può essere trascinato ovunque
// dentro la finestra (posizione assoluta persistita) e riportato al dock con doppio click o
// «Reimposta layout». Logica PURA e deterministica (nessun DOM, nessun React): ordine per colonna,
// pannelli chiusi, ridotti, posizioni libere e persistenza in `localStorage` tra i riavvii del
// renderer. La UI (`Dock.tsx`) applica azioni e legge le posizioni reali; qui si decide solo lo
// stato, così i test coprono chiudi/riapri, riordino, massimizzazione, float e persistenza senza
// browser.
import type { Language } from '../../shared/contracts/index.ts';
import { translate, type MessageKey } from '../lib/i18n/index.ts';

/** I pannelli del dock. Gli id sono stabili: non si rinomina (testid/E2E li usano). */
export type PanelId = 'voice' | 'director' | 'approvals' | 'system' | 'agents' | 'tasks' | 'engines' | 'diag' | 'clock' | 'weather' | 'graphs' | 'humanoid' | 'calendar' | 'notes' | 'replies' | 'agenda' | 'chat';
export type PanelColumn = 'left' | 'right';

export interface PanelMeta {
  id: PanelId;
  /** Titolo mostrato nella testata e nel menu «Pannelli». */
  title: string;
  /** Colonna di partenza (il proprietario può spostarli). */
  column: PanelColumn;
  /** Widget (11/10/2026): spento finché il proprietario non lo accende dal menu «Widget»; acceso,
   *  segue tutte le regole delle schede (chiudi, tendina, sposta, ridimensiona, tutto schermo). */
  widget?: true;
}

export const PANELS: readonly PanelMeta[] = [
  { id: 'voice', title: 'Voce', column: 'left' },
  { id: 'director', title: 'Director', column: 'left' },
  { id: 'approvals', title: 'Approvazioni', column: 'left' },
  { id: 'system', title: 'Sistema', column: 'right' },
  { id: 'agents', title: 'Agenti', column: 'right' },
  { id: 'tasks', title: 'Task · Eventi', column: 'right' },
  { id: 'engines', title: 'Motori', column: 'right' },
  { id: 'diag', title: 'Diagnostica', column: 'right' },
  { id: 'clock', title: 'Orologio', column: 'left', widget: true },
  { id: 'weather', title: 'Meteo', column: 'right', widget: true },
  { id: 'graphs', title: 'Grafici', column: 'right', widget: true },
  { id: 'humanoid', title: 'Umanoide', column: 'left', widget: true },
  { id: 'calendar', title: 'Calendario', column: 'right', widget: true },
  { id: 'notes', title: 'Note', column: 'right', widget: true },
  { id: 'agenda', title: 'Agenda', column: 'right', widget: true },
  { id: 'replies', title: 'Ultime risposte', column: 'right', widget: true },
  // 24/10/2026: la chat è un pannello come l'Umanoide (spostabile, ridimensionabile, a tendina); si apre dal tasto «Chat».
  { id: 'chat', title: 'Chat', column: 'right', widget: true }
];

export const PANEL_IDS: readonly PanelId[] = PANELS.map((p) => p.id);
/** I widget: nascosti di partenza, si accendono dal menu «Widget». */
export const WIDGET_IDS: readonly PanelId[] = PANELS.filter((p) => p.widget).map((p) => p.id);
export const isWidget = (id: PanelId): boolean => WIDGET_IDS.includes(id);
/**
 * Widget accesi di partenza (11/10/2026, scelta del proprietario): l'Umanoide, fisso in cima alla
 * colonna di sinistra. Resta spegnibile; acceso, il menu lo rimette al suo posto (non libero).
 */
export const WIDGETS_ON_AT_START: readonly PanelId[] = ['humanoid'];
const onAtStart = (id: PanelId): boolean => WIDGETS_ON_AT_START.includes(id);

export function panelMeta(id: PanelId): PanelMeta {
  return PANELS.find((p) => p.id === id) as PanelMeta;
}

/** Chiavi dei titoli nei dizionari (area «shell»): il compilatore controlla che ogni pannello ne abbia una. */
const PANEL_TITLE_KEY: Record<PanelId, MessageKey> = {
  voice: 'shell.panel.voice', director: 'shell.panel.director', approvals: 'shell.panel.approvals', system: 'shell.panel.system',
  agents: 'shell.panel.agents', tasks: 'shell.panel.tasks', engines: 'shell.panel.engines', diag: 'shell.panel.diag',
  clock: 'shell.panel.clock', weather: 'shell.panel.weather', graphs: 'shell.panel.graphs', humanoid: 'shell.panel.humanoid',
  calendar: 'shell.panel.calendar', notes: 'shell.panel.notes', replies: 'shell.panel.replies', agenda: 'shell.panel.agenda', chat: 'shell.panel.chat'
};

/** Titolo del pannello nella lingua (in italiano è `panelMeta(id).title`). */
export function panelTitle(id: PanelId, lang: Language = 'it'): string {
  return translate(lang, PANEL_TITLE_KEY[id]);
}

/** Posizione assoluta (px) di un pannello libero: angolo in alto a sinistra dentro la finestra. */
export interface FloatPos {
  x: number;
  y: number;
}

/** Dimensioni (px) scelte dal proprietario per un pannello libero (P-99). */
export interface FloatSize {
  w: number;
  h: number;
}

/** Minimi di un pannello ridimensionato: sotto, testata e contenuto non sono più leggibili. */
export const FLOAT_MIN_WIDTH = 220;
export const FLOAT_MIN_HEIGHT = 120;
/** Limite di sicurezza delle dimensioni lette dall'archivio: oltre è un dato corrotto. */
export const FLOAT_SIZE_LIMIT = 5_000;

/** Stato del dock: ordine in ciascuna colonna (anche i chiusi restano in ordine), chiusi, ridotti,
 *  posizioni libere (P-98: un id senza posizione è ancorato al dock) e dimensioni scelte (P-99). */
export interface DockState {
  left: PanelId[];
  right: PanelId[];
  hidden: PanelId[];
  collapsed: PanelId[];
  floats: Partial<Record<PanelId, FloatPos>>;
  sizes: Partial<Record<PanelId, FloatSize>>;
  /** Versione del layout: 2 = schermo pulito (11/10/2026). Uno stato più vecchio si pulisce una volta. */
  layout?: number;
}

/**
 * Schermo pulito (11/10/2026, richiesta del proprietario): di partenza restano l'Umanoide e la scena
 * di VISIONE con gli agenti; tutto il resto si accende con una casella nel menu «Widget» o si apre
 * dalle linguette laterali. Niente si perde: i pannelli restano, solo spenti.
 */
export const CLEAN_LAYOUT = 2;

/** Gruppi tematici: sezioni del menu «Widget» e linguette laterali (cartelle). */
export const PANEL_GROUPS: ReadonlyArray<{ id: string; title: string; panels: readonly PanelId[] }> = [
  { id: 'agents', title: 'Agenti e lavoro', panels: ['agents', 'director', 'tasks', 'approvals', 'replies'] },
  { id: 'system', title: 'Sistema', panels: ['system', 'graphs', 'engines', 'diag'] },
  { id: 'voice', title: 'Voce', panels: ['voice'] },
  { id: 'info', title: 'Informazioni', panels: ['clock', 'calendar', 'agenda', 'weather', 'notes'] }
];

const GROUP_TITLE_KEY: Record<string, MessageKey> = {
  agents: 'shell.group.agents', system: 'shell.group.system', voice: 'shell.group.voice', info: 'shell.group.info', log: 'shell.group.log'
};

/** Titolo di un gruppo tematico (o della linguetta «log») nella lingua; un id ignoto torna com'è. */
export function groupTitle(id: string, lang: Language = 'it'): string {
  const key = GROUP_TITLE_KEY[id];
  return key === undefined ? id : translate(lang, key);
}

export const DOCK_STORAGE_KEY = 'visione.panelli.v1';
/** Chiave storica della tendina dei pannelli HUD (P-73/P-76): si migra, non si perde. */
export const LEGACY_MIN_KEY = 'visione.hud.ridotti';
/** Titoli del vecchio stato `visione.hud.ridotti` → id del dock. */
const LEGACY_TITLES: Record<string, PanelId> = {
  Voce: 'voice',
  Director: 'director',
  Approvazioni: 'approvals',
  Sistema: 'system',
  Agenti: 'agents',
  'Task · Eventi': 'tasks',
  Motori: 'engines',
  Diagnostica: 'diag'
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** I widget accesi di partenza in cima alla loro colonna. */
const atTop = (ids: PanelId[]): PanelId[] => [...ids.filter(onAtStart), ...ids.filter((id) => !onAtStart(id))];

export function defaultDock(): DockState {
  return {
    left: atTop(PANELS.filter((p) => p.column === 'left').map((p) => p.id)),
    right: atTop(PANELS.filter((p) => p.column === 'right').map((p) => p.id)),
    hidden: PANEL_IDS.filter((id) => !onAtStart(id)),
    collapsed: [],
    floats: {},
    sizes: {},
    layout: CLEAN_LAYOUT
  };
}

const isPanelId = (v: unknown): v is PanelId => typeof v === 'string' && (PANEL_IDS as readonly string[]).includes(v);

/** Limite di sicurezza delle coordinate lette dall'archivio: oltre è un dato corrotto. */
export const FLOAT_COORD_LIMIT = 20_000;

/** Legge una posizione libera da un valore ignoto: solo numeri finiti e ragionevoli. */
function readFloat(v: unknown): FloatPos | null {
  if (v === null || typeof v !== 'object') return null;
  const rec = v as Record<string, unknown>;
  const x = rec.x;
  const y = rec.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > FLOAT_COORD_LIMIT || Math.abs(y) > FLOAT_COORD_LIMIT) return null;
  return { x, y };
}

/** Legge dimensioni scelte da un valore ignoto: finite, positive e con minimi garantiti. */
function readSize(v: unknown): FloatSize | null {
  if (v === null || typeof v !== 'object') return null;
  const rec = v as Record<string, unknown>;
  const w = rec.w;
  const h = rec.h;
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w <= 0 || h <= 0 || w > FLOAT_SIZE_LIMIT || h > FLOAT_SIZE_LIMIT) return null;
  return { w: Math.max(FLOAT_MIN_WIDTH, Math.round(w)), h: Math.max(FLOAT_MIN_HEIGHT, Math.round(h)) };
}

/**
 * Normalizza un valore letto dall'archivio: id sconosciuti scartati, id validi una volta sola,
 * pannelli mancanti riaggiunti in fondo alla colonna di partenza. Regge qualunque JSON.
 */
export function normalizeDock(raw: unknown): DockState {
  const out: DockState = { left: [], right: [], hidden: [], collapsed: [], floats: {}, sizes: {} };
  const src = (raw !== null && typeof raw === 'object' ? raw : {}) as Partial<DockState>;
  const seen = new Set<PanelId>();
  for (const column of ['left', 'right'] as const) {
    const list = Array.isArray(src[column]) ? (src[column] as unknown[]) : [];
    for (const v of list) {
      if (isPanelId(v) && !seen.has(v)) {
        out[column].push(v);
        seen.add(v);
      }
    }
  }
  // Un id salvato nella colonna sbagliata resta dove il proprietario l'aveva messo; i mancanti
  // tornano nella colonna di default, nell'ordine di `PANELS`.
  const added: PanelId[] = [];
  for (const p of PANELS) {
    if (!seen.has(p.id)) {
      if (onAtStart(p.id)) out[p.column].unshift(p.id);
      else out[p.column].push(p.id);
      seen.add(p.id);
      added.push(p.id);
    }
  }
  for (const v of Array.isArray(src.hidden) ? (src.hidden as unknown[]) : []) {
    if (isPanelId(v) && !out.hidden.includes(v)) out.hidden.push(v);
  }
  // Un widget che l'archivio non conosceva ancora (stato salvato prima dei widget) parte spento,
  // salvo quelli accesi di partenza (l'Umanoide), che compaiono in cima alla loro colonna.
  for (const id of added) if (isWidget(id) && !onAtStart(id) && !out.hidden.includes(id)) out.hidden.push(id);
  for (const v of Array.isArray(src.collapsed) ? (src.collapsed as unknown[]) : []) {
    if (isPanelId(v) && !out.collapsed.includes(v)) out.collapsed.push(v);
  }
  // P-98: posizioni libere. Chiavi sconosciute o coordinate non finite/corrotte si scartano.
  const floats = src.floats;
  if (floats !== null && typeof floats === 'object' && !Array.isArray(floats)) {
    for (const [key, value] of Object.entries(floats as Record<string, unknown>)) {
      if (!isPanelId(key)) continue;
      const pos = readFloat(value);
      if (pos !== null) out.floats[key] = pos;
    }
  }
  // P-99: dimensioni scelte dai bordi. Solo per id validi; un pannello senza dimensioni usa il default.
  const sizes = src.sizes;
  if (sizes !== null && typeof sizes === 'object' && !Array.isArray(sizes)) {
    for (const [key, value] of Object.entries(sizes as Record<string, unknown>)) {
      if (!isPanelId(key)) continue;
      const size = readSize(value);
      if (size !== null) out.sizes[key] = size;
    }
  }
  // Schermo pulito: uno stato di prima si pulisce una volta sola (resta l'Umanoide); poi decide lui.
  if (src.layout !== CLEAN_LAYOUT) out.hidden = PANEL_IDS.filter((id) => !onAtStart(id));
  out.layout = CLEAN_LAYOUT;
  return out;
}

/** Migra il vecchio stato dei tasti «riduci» (`visione.hud.ridotti`) in quello nuovo del dock. */
function legacyCollapsed(raw: unknown): PanelId[] {
  if (raw === null || typeof raw !== 'object') return [];
  const rec = raw as Record<string, unknown>;
  const out: PanelId[] = [];
  for (const [title, id] of Object.entries(LEGACY_TITLES)) {
    if (rec[title] === true) out.push(id);
  }
  return out;
}

/** Legge lo stato del dock; con dati assenti o corrotti torna il layout di partenza (mai un crash). */
export function loadDock(storage: StorageLike | null = typeof localStorage === 'undefined' ? null : localStorage): DockState {
  let raw: unknown = null;
  let legacy: unknown = null;
  try {
    raw = JSON.parse(storage?.getItem(DOCK_STORAGE_KEY) ?? 'null');
  } catch {
    raw = null;
  }
  try {
    legacy = JSON.parse(storage?.getItem(LEGACY_MIN_KEY) ?? 'null');
  } catch {
    legacy = null;
  }
  const dock = normalizeDock(raw);
  if (raw === null) {
    for (const id of legacyCollapsed(legacy)) if (!dock.collapsed.includes(id)) dock.collapsed.push(id);
  }
  return dock;
}

export function saveDock(dock: DockState, storage: StorageLike | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try {
    storage?.setItem(DOCK_STORAGE_KEY, JSON.stringify(dock));
  } catch {
    // archivio locale non disponibile: lo stato vale per questa sessione
  }
}

export function isHidden(dock: DockState, id: PanelId): boolean {
  return dock.hidden.includes(id);
}

export function isCollapsed(dock: DockState, id: PanelId): boolean {
  return dock.collapsed.includes(id);
}

export function columnOf(dock: DockState, id: PanelId): PanelColumn {
  return dock.left.includes(id) ? 'left' : 'right';
}

/** Ordine visibile di una colonna: l'ordine salvato senza i pannelli chiusi. */
export function visibleIds(dock: DockState, column: PanelColumn): PanelId[] {
  return (column === 'left' ? dock.left : dock.right).filter((id) => !isHidden(dock, id));
}

/** La colonna ha almeno un pannello acceso e non libero? Senza, la colonna sparisce e resta la scena. */
export function columnInUse(dock: DockState, column: PanelColumn): boolean {
  return visibleIds(dock, column).some((id) => dock.floats[id] === undefined);
}

/** Accende o spegne un pannello dal menu: i widget con le loro regole, gli altri al loro posto. */
export function togglePanel(dock: DockState, id: PanelId, vw: number, vh: number): DockState {
  return isWidget(id) ? toggleWidget(dock, id, vw, vh) : toggleHidden(dock, id);
}

/** «Solo l'Umanoide»: tutto spento tranne i widget accesi di partenza (posizioni e misure restano). */
export function onlyEssentials(dock: DockState): DockState {
  return { ...dock, hidden: PANEL_IDS.filter((id) => !onAtStart(id)) };
}

/** «Accendi tutto»: ogni pannello e widget acceso, ognuno al suo posto. */
export function everythingOn(dock: DockState): DockState {
  return dock.hidden.length === 0 ? dock : { ...dock, hidden: [] };
}

/** Pannelli chiusi (i widget spenti non contano: si accendono dal loro menu). */
export function hiddenCount(dock: DockState): number {
  return dock.hidden.filter((id) => !isWidget(id)).length;
}

/** Widget accesi. */
export function widgetsOn(dock: DockState): PanelId[] {
  return WIDGET_IDS.filter((id) => !dock.hidden.includes(id));
}

/**
 * Accende o spegne un widget. Acceso per la prima volta (senza posizione), si posa LIBERO al centro
 * dello schermo, scalato per non coprire un altro widget: le colonne del dock sono già piene.
 */
export function toggleWidget(dock: DockState, id: PanelId, vw: number, vh: number): DockState {
  if (!isWidget(id)) return dock;
  const next = toggleHidden(dock, id);
  if (next.hidden.includes(id) || next.floats[id] !== undefined || onAtStart(id)) return next;
  return setFloat(next, id, freeSpot(next, id, vw, vh));
}

/**
 * Porta un pannello sullo schermo (tasto «Chat», tasto ⇱ delle linguette laterali): acceso e aperto; se era
 * spento e non ha un posto suo si posa libero nel primo punto vuoto. Da lì si sposta, si ridimensiona, si
 * piega e si chiude come l'Umanoide, e la posizione resta salvata.
 */
export function showPanel(dock: DockState, id: PanelId, vw: number, vh: number): DockState {
  const wasHidden = dock.hidden.includes(id);
  const shown: DockState = { ...dock, hidden: dock.hidden.filter((x) => x !== id), collapsed: dock.collapsed.filter((x) => x !== id) };
  return !wasHidden || shown.floats[id] !== undefined ? shown : setFloat(shown, id, freeSpot(shown, id, vw, vh));
}

/**
 * Mostra un pannello solo per il disegno (non si salva): l'Umanoide quando VISIONE parla si apre anche
 * se spento o piegato (preferenza «quando parla si apre e si ingrandisce»).
 */
export function withShown(dock: DockState, id: PanelId): DockState {
  if (!dock.hidden.includes(id) && !dock.collapsed.includes(id)) return dock;
  return { ...dock, hidden: dock.hidden.filter((x) => x !== id), collapsed: dock.collapsed.filter((x) => x !== id) };
}

/** Dopo una modifica fatta mentre il pannello era mostrato per il disegno: torna spento/piegato com'era. */
export function keepShownTemporary(next: DockState, original: DockState, id: PanelId): DockState {
  let out = next;
  if (original.hidden.includes(id) && !out.hidden.includes(id)) out = { ...out, hidden: [...out.hidden, id] };
  if (original.collapsed.includes(id) && !out.collapsed.includes(id)) out = { ...out, collapsed: [...out.collapsed, id] };
  return out;
}

/** Larghezza di un pannello libero senza misura scelta: la stessa del CSS `.dock-float`. */
export function floatWidth(vw: number): number {
  return Math.round(Math.min(320, Math.max(240, vw * 0.22)));
}
/** Altezza di partenza dei widget (px), misurata sul contenuto; al più il 74% della finestra (CSS). */
export const WIDGET_HEIGHT: Partial<Record<PanelId, number>> = { clock: 140, weather: 290, graphs: 420, humanoid: 430, calendar: 270, notes: 240, replies: 300, agenda: 360, chat: 600 };
/** Larghezza di partenza dei widget che la chiedono più ampia (px); al più il 40% della finestra. */
export const WIDGET_WIDTH: Partial<Record<PanelId, number>> = { humanoid: 360, agenda: 380, chat: 620 };

/** Ingombro di un pannello libero: dimensioni scelte dal proprietario, altrimenti quelle di partenza. */
export function floatBox(dock: DockState, id: PanelId, vw: number, vh: number): FloatSize {
  const wide = WIDGET_WIDTH[id];
  return dock.sizes[id] ?? { w: wide === undefined ? floatWidth(vw) : Math.min(wide, Math.round(vw * 0.4)), h: Math.min(Math.round(vh * 0.74), WIDGET_HEIGHT[id] ?? 260) };
}

/**
 * Primo punto libero per un pannello che diventa libero: prima la zona centrale (fra le due colonne
 * del dock), poi tutta la finestra, dall'alto a sinistra; si prende il primo posto che non copre un
 * altro pannello libero visibile. Se non c'è posto, a cascata dal centro: mai fuori dalla finestra.
 */
export function freeSpot(dock: DockState, id: PanelId, vw: number, vh: number): FloatPos {
  const me = floatBox(dock, id, vw, vh);
  const widgets = (Object.entries(dock.floats) as Array<[PanelId, FloatPos]>)
    .filter(([pid]) => pid !== id && !dock.hidden.includes(pid))
    .map(([pid, pos]) => ({ ...pos, ...floatBox(dock, pid, vw, vh) }));
  // Le colonne del dock con pannelli accesi (stesse misure del CSS: --left-w, --right-w). Il pannello
  // che si sta posando non conta: è lui a lasciare la colonna.
  const without: DockState = { ...dock, hidden: [...dock.hidden, id] };
  const columns: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (columnInUse(without, 'left')) columns.push({ x: 0, y: 0, w: 16 + Math.min(330, vw * 0.23), h: vh });
  if (columnInUse(without, 'right')) { const w = 16 + Math.min(340, vw * 0.25); columns.push({ x: vw - w, y: 0, w, h: vh }); }
  const gap = 12;
  const top = Math.round(Math.max(100, vh * 0.14));
  const bottom = vh - me.h - 50;
  const zones: Array<[number, number]> = [[Math.round(vw * 0.25), Math.round(vw * 0.75) - me.w], [8, vw - me.w - 8]];
  // Prima un posto che non copra né colonne né altri widget; se la finestra è troppo piena, uno che
  // copra una colonna ma mai un altro widget; solo alla fine la cascata.
  for (const obstacles of [[...widgets, ...columns], widgets]) {
    const free = (x: number, y: number): boolean => obstacles.every((o) => x + me.w + gap <= o.x || o.x + o.w + gap <= x || y + me.h + gap <= o.y || o.y + o.h + gap <= y);
    for (const [x0, x1] of zones) {
      for (let y = top; y <= bottom; y += 24) {
        for (let x = x0; x <= x1; x += 24) if (free(x, y)) return clampFloat({ x, y }, me.w, me.h, vw, vh);
      }
    }
  }
  const k = Math.max(0, WIDGET_IDS.indexOf(id));
  return clampFloat({ x: Math.round(vw / 2 - me.w / 2 + k * 36), y: Math.round(vh * 0.22 + k * 36) }, me.w, me.h, vw, vh);
}

/** Numero di pannelli con posizione libera (per il menu «Pannelli» e i test). */
export function floatingCount(dock: DockState): number {
  return Object.keys(dock.floats).length;
}

/** Posizione libera di un pannello, o `null` se è ancorato al dock. */
export function floatingOf(dock: DockState, id: PanelId): FloatPos | null {
  return dock.floats[id] ?? null;
}

/**
 * P-98: sposta un pannello in una posizione ASSOLUTA della finestra (posizione libera). L'ordine di
 * colonna resta salvato: «torna al dock» lo rimette esattamente dov'era. Coordinate non finite
 * ignorate; posizione identica = stato identico (nessun re-render).
 */
export function setFloat(dock: DockState, id: PanelId, pos: FloatPos): DockState {
  if (!PANEL_IDS.includes(id) || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return dock;
  const cur = dock.floats[id];
  if (cur !== undefined && cur.x === pos.x && cur.y === pos.y) return dock;
  return { ...dock, floats: { ...dock.floats, [id]: { x: pos.x, y: pos.y } } };
}

/** Riporta un pannello al dock (doppio click sulla testata): posizione e dimensioni libere si dimenticano. */
export function clearFloat(dock: DockState, id: PanelId): DockState {
  if (dock.floats[id] === undefined && dock.sizes[id] === undefined) return dock;
  const floats = { ...dock.floats };
  const sizes = { ...dock.sizes };
  delete floats[id];
  delete sizes[id];
  return { ...dock, floats, sizes };
}

/** Riporta TUTTI i pannelli al dock (usata da «Reimposta layout» insieme al layout di partenza). */
export function clearFloats(dock: DockState): DockState {
  return floatingCount(dock) === 0 && Object.keys(dock.sizes).length === 0 ? dock : { ...dock, floats: {}, sizes: {} };
}

/** Dimensioni scelte per un pannello libero, o `null` se usa il default della colonna (P-99). */
export function floatingSizeOf(dock: DockState, id: PanelId): FloatSize | null {
  return dock.sizes[id] ?? null;
}

/**
 * P-99: dimensioni di un pannello libero, validate e coi minimi garantiti. Non tocca il contenuto:
 * la UI decide poi come farlo scorrere. Valori non finiti o id ignoti = stato identico.
 */
export function setSize(dock: DockState, id: PanelId, size: FloatSize): DockState {
  if (!PANEL_IDS.includes(id) || !Number.isFinite(size.w) || !Number.isFinite(size.h)) return dock;
  const w = Math.min(FLOAT_SIZE_LIMIT, Math.max(FLOAT_MIN_WIDTH, Math.round(size.w)));
  const h = Math.min(FLOAT_SIZE_LIMIT, Math.max(FLOAT_MIN_HEIGHT, Math.round(size.h)));
  const cur = dock.sizes[id];
  if (cur !== undefined && cur.w === w && cur.h === h) return dock;
  return { ...dock, sizes: { ...dock.sizes, [id]: { w, h } } };
}

/** Lato da cui si trascina per ridimensionare (bordi e angoli della cornice). */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * P-99: rettangolo di un pannello libero dopo un trascinamento di ridimensionamento. Pura e
 * deterministica: mantiene i minimi, non esce dalla finestra e non restituisce mai NaN. Per i lati
 * ovest/nord sposta anche `x`/`y`; per gli angoli combina i due assi.
 */
export function resizeRect(start: Rect, handle: ResizeHandle, dx: number, dy: number, vw: number, vh: number): Rect {
  const vwSafe = Number.isFinite(vw) ? Math.max(FLOAT_MIN_WIDTH, vw) : FLOAT_MIN_WIDTH;
  const vhSafe = Number.isFinite(vh) ? Math.max(FLOAT_MIN_HEIGHT, vh) : FLOAT_MIN_HEIGHT;
  const s: Rect = {
    x: Number.isFinite(start.x) ? start.x : 0,
    y: Number.isFinite(start.y) ? start.y : 0,
    w: Number.isFinite(start.w) ? start.w : FLOAT_MIN_WIDTH,
    h: Number.isFinite(start.h) ? start.h : FLOAT_MIN_HEIGHT
  };
  const ddx = Number.isFinite(dx) ? dx : 0;
  const ddy = Number.isFinite(dy) ? dy : 0;
  let x = s.x;
  let y = s.y;
  let w = s.w;
  let h = s.h;
  if (handle.includes('e')) w = s.w + ddx;
  if (handle.includes('s')) h = s.h + ddy;
  if (handle.includes('w')) {
    w = s.w - ddx;
    x = s.x + ddx;
  }
  if (handle.includes('n')) {
    h = s.h - ddy;
    y = s.y + ddy;
  }
  // Minimi: il bordo opposto resta fermo (il pannello si ferma, non si sposta da solo).
  if (w < FLOAT_MIN_WIDTH) {
    if (handle.includes('w')) x = s.x + (s.w - FLOAT_MIN_WIDTH);
    w = FLOAT_MIN_WIDTH;
  }
  if (h < FLOAT_MIN_HEIGHT) {
    if (handle.includes('n')) y = s.y + (s.h - FLOAT_MIN_HEIGHT);
    h = FLOAT_MIN_HEIGHT;
  }
  // Dentro la finestra: prima si sposta, poi si riduce fino ai minimi (a schermo molto piccolo).
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (x + w > vwSafe) w = vwSafe - x;
  if (y + h > vhSafe) h = vhSafe - y;
  if (w < FLOAT_MIN_WIDTH || x + FLOAT_MIN_WIDTH > vwSafe) {
    w = Math.min(vwSafe, FLOAT_MIN_WIDTH);
    x = Math.max(0, vwSafe - w);
  }
  if (h < FLOAT_MIN_HEIGHT || y + FLOAT_MIN_HEIGHT > vhSafe) {
    h = Math.min(vhSafe, FLOAT_MIN_HEIGHT);
    y = Math.max(0, vhSafe - h);
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Posizione di rilascio valida dentro la finestra: il pannello resta raggiungibile (testata mai
 * fuori) e la posizione è un intero. `margin` è lo spazio in alto (testata/brand) da non coprire.
 */
export function clampFloat(pos: FloatPos, width: number, height: number, vw: number, vh: number, margin = 46): FloatPos {
  const w = Number.isFinite(width) ? Math.max(120, width) : 260;
  const h = Number.isFinite(height) ? Math.max(60, height) : 200;
  const maxX = Math.max(0, vw - Math.min(w, vw));
  const minY = Math.min(margin, Math.max(0, vh - 40));
  const maxY = Math.max(minY, vh - Math.min(h, 120));
  const x = Number.isFinite(pos.x) ? pos.x : 0;
  const y = Number.isFinite(pos.y) ? pos.y : minY;
  return { x: Math.round(Math.min(maxX, Math.max(0, x))), y: Math.round(Math.min(maxY, Math.max(minY, y))) };
}

/** Chiude o riapre un pannello: la posizione scelta (anche dopo uno spostamento) resta quella. */
export function toggleHidden(dock: DockState, id: PanelId): DockState {
  if (!PANEL_IDS.includes(id)) return dock;
  const hidden = dock.hidden.includes(id) ? dock.hidden.filter((p) => p !== id) : [...dock.hidden, id];
  return { ...dock, hidden };
}

/** Riapre tutti i PANNELLI; i widget restano come il proprietario li ha lasciati. */
export function showAll(dock: DockState): DockState {
  const hidden = dock.hidden.filter(isWidget);
  return hidden.length === dock.hidden.length ? dock : { ...dock, hidden };
}

/** «Reimposta posizioni»: tutto al suo posto nel dock e aperto; acceso o spento resta com'era. */
export function resetDock(dock: DockState): DockState {
  return { ...defaultDock(), hidden: [...dock.hidden] };
}

/** Tendina/espandi dal pannello (oltre alla tendina globale delle schede). */
export function toggleCollapsed(dock: DockState, id: PanelId): DockState {
  if (!PANEL_IDS.includes(id)) return dock;
  const collapsed = dock.collapsed.includes(id) ? dock.collapsed.filter((p) => p !== id) : [...dock.collapsed, id];
  return { ...dock, collapsed };
}

function sameOrder(a: PanelId[], b: PanelId[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Sposta un pannello nella colonna indicata, prima di `beforeId` (null = in fondo). Se la posizione
 * non cambia lo stato è identico (nessun re-render). Gli id sconosciuti sono ignorati.
 */
export function movePanel(dock: DockState, id: PanelId, column: PanelColumn, beforeId: PanelId | null): DockState {
  if (!PANEL_IDS.includes(id)) return dock;
  const left = dock.left.filter((p) => p !== id);
  const right = dock.right.filter((p) => p !== id);
  const target = column === 'left' ? left : right;
  const at = beforeId !== null && beforeId !== id ? target.indexOf(beforeId) : -1;
  target.splice(at >= 0 ? at : target.length, 0, id);
  if (sameOrder(left, dock.left) && sameOrder(right, dock.right)) return dock;
  return { ...dock, left, right };
}

/** Posizione di rilascio da un elenco di metà verticali reali (usata durante il trascinamento). */
export function dropBefore(rects: Array<{ id: PanelId; mid: number }>, y: number): PanelId | null {
  for (const r of rects) {
    if (y < r.mid) return r.id;
  }
  return null;
}
