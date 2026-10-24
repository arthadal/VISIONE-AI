// Window Manager del Command Center JARVIS (Fase 18). Stato puro e deterministico: nessun accesso al
// DOM. La UI chiama azioni; il riduttore produce il nuovo elenco di finestre. Deduplica per id
// (`kind` + riferimento): aprire due volte Director, o due volte lo stesso agente, **porta in primo
// piano** la finestra esistente invece di crearne una seconda. Chiudere una finestra è solo
// lifecycle della UI: non tocca agenti, task o processi.
export type WindowKind = 'director' | 'agent' | 'task' | 'telemetry' | 'logs' | 'terminal' | 'settings' | 'memory' | 'approvals' | 'reactor' | 'apps' | 'files' | 'system' | 'errors' | 'browser' | 'training';

export interface WindowBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WindowState {
  /** id stabile: `kind` da solo, oppure `kind:ref` (agentId/taskId). */
  id: string;
  kind: WindowKind;
  /** Riferimento reale (agentId, taskId) quando la finestra è legata a una entità. */
  ref: string | null;
  title: string;
  subtitle: string | null;
  bounds: WindowBounds;
  z: number;
  minimized: boolean;
  /** Ridotta a tendina: resta solo l'intestazione (doppio click o pulsante). */
  shaded: boolean;
  /** Geometria precedente alla minimizzazione (per ripristinarla). */
  restoredBounds: WindowBounds | null;
}

export interface WindowsState {
  windows: WindowState[];
  /** Contatore monotono per lo z-index (la finestra con z più alto è davanti). */
  top: number;
}

export const EMPTY_WINDOWS: WindowsState = { windows: [], top: 0 };

const DEFAULT_W = 420;
const DEFAULT_H = 470;
const MIN_W = 300;
const MIN_H = 200;
const EDGE = 16;
/** Finestre che nascono più grandi: l'Esplora ha barra laterale, contenuto e anteprima. */
const KIND_SIZE: Partial<Record<WindowKind, readonly [number, number]>> = { files: [980, 620], browser: [1120, 700], training: [760, 680] };

/** id stabile di una finestra: deduplica per tipo e riferimento. */
export function windowId(kind: WindowKind, ref: string | null = null): string {
  return ref === null ? kind : `${kind}:${ref}`;
}

/** Posizione di partenza: colonne ai bordi (il centro resta libero per la scena Neural). */
export function defaultBounds(seq: number, vw: number, vh: number, w = DEFAULT_W, h = DEFAULT_H): WindowBounds {
  const width = Math.max(MIN_W, Math.min(w, vw - EDGE * 2));
  const height = Math.max(MIN_H, Math.min(h, vh - 200));
  const col = seq % 2;
  const row = Math.floor(seq / 2);
  const x = col === 0 ? EDGE : Math.max(EDGE, vw - width - EDGE);
  // P-87: sotto la barra comandi dell'apertura (brand/nav/striscia agenti arrivano a ~100 px);
  // le finestre partono più in basso e la testata resta cliccabile.
  const y = Math.min(Math.max(122, vh - height - 120), 128 + row * 34);
  return { x, y, w: width, h: height };
}

export type WindowsAction =
  | { type: 'open'; kind: WindowKind; ref?: string | null; title: string; subtitle?: string | null; vw: number; vh: number; bounds?: WindowBounds }
  | { type: 'close'; id: string }
  | { type: 'focus'; id: string }
  | { type: 'minimize'; id: string }
  | { type: 'restore'; id: string }
  | { type: 'toggleShade'; id: string }
  | { type: 'setBounds'; id: string; bounds: WindowBounds }
  | { type: 'closeAll' };

/** Vincoli di geometria: dentro il viewport, mai sotto le dimensioni minime. */
export function clampBounds(bounds: WindowBounds, vw: number, vh: number): WindowBounds {
  const w = Math.max(MIN_W, Math.min(bounds.w, Math.max(MIN_W, vw - EDGE)));
  const h = Math.max(MIN_H, Math.min(bounds.h, Math.max(MIN_H, vh - EDGE)));
  const x = Math.max(0, Math.min(bounds.x, Math.max(0, vw - w)));
  const y = Math.max(0, Math.min(bounds.y, Math.max(0, vh - h)));
  return { x, y, w, h };
}

/**
 * Aggancio ai bordi (Fase 21b, P-68): al rilascio del trascinamento, se la finestra è entro
 * `threshold` px da un bordo si allinea a quel bordo (sinistra, destra o alto); altrimenti resta
 * dov'è. Lo sgancio è il trascinamento stesso: basta allontanarsi dal bordo prima di rilasciare.
 */
export function snapBounds(bounds: WindowBounds, vw: number, vh: number, threshold = 24): WindowBounds {
  const b = clampBounds(bounds, vw, vh);
  const x = b.x <= threshold ? 0 : vw - (b.x + b.w) <= threshold ? Math.max(0, vw - b.w) : b.x;
  const y = b.y <= threshold ? 0 : b.y;
  return { ...b, x, y };
}

export function reduceWindows(state: WindowsState, action: WindowsAction): WindowsState {
  switch (action.type) {
    case 'open': {
      const id = windowId(action.kind, action.ref ?? null);
      const existing = state.windows.find((w) => w.id === id);
      if (existing) {
        // Deduplica: porta davanti e ripristina; aggiorna i titoli (dati reali cambiati).
        const top = state.top + 1;
        return {
          top,
          windows: state.windows.map((w) => (w.id === id ? { ...w, z: top, minimized: false, shaded: false, title: action.title, subtitle: action.subtitle ?? w.subtitle } : w))
        };
      }
      const top = state.top + 1;
      const bounds = clampBounds(action.bounds ?? defaultBounds(state.windows.length, action.vw, action.vh, ...(KIND_SIZE[action.kind] ?? [])), action.vw, action.vh);
      const win: WindowState = {
        id, kind: action.kind, ref: action.ref ?? null, title: action.title, subtitle: action.subtitle ?? null,
        bounds, z: top, minimized: false, shaded: false, restoredBounds: null
      };
      return { top, windows: [...state.windows, win] };
    }
    case 'close':
      return { ...state, windows: state.windows.filter((w) => w.id !== action.id) };
    case 'focus': {
      const target = state.windows.find((w) => w.id === action.id);
      if (!target) return state;
      const top = state.top + 1;
      return { top, windows: state.windows.map((w) => (w.id === action.id ? { ...w, z: top, minimized: false } : w)) };
    }
    case 'minimize':
      return {
        ...state,
        windows: state.windows.map((w) => (w.id === action.id && !w.minimized ? { ...w, minimized: true, restoredBounds: w.bounds } : w))
      };
    case 'restore': {
      const top = state.top + 1;
      return { top, windows: state.windows.map((w) => (w.id === action.id ? { ...w, minimized: false, shaded: false, z: top, bounds: w.restoredBounds ?? w.bounds, restoredBounds: null } : w)) };
    }
    case 'toggleShade':
      return { ...state, windows: state.windows.map((w) => (w.id === action.id ? { ...w, shaded: !w.shaded, minimized: false } : w)) };
    case 'setBounds':
      return { ...state, windows: state.windows.map((w) => (w.id === action.id ? { ...w, bounds: action.bounds } : w)) };
    case 'closeAll':
      return state.windows.length === 0 ? state : { top: state.top, windows: [] };
  }
}

/** La finestra in primo piano non minimizzata, se esiste. */
export function frontWindow(state: WindowsState): WindowState | null {
  const visible = state.windows.filter((w) => !w.minimized);
  if (visible.length === 0) return null;
  return visible.reduce((a, b) => (b.z > a.z ? b : a));
}
