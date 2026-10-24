// Proiezione pura dello stato della UI: snapshot del supervisore + stato del core + eventi + esiti
// dei comandi. Nessuna logica di dominio: lo stato del core arriva già calcolato dal core e qui
// viene solo tenuto (sola lettura); si decide soltanto quale snapshot è il più recente e quando
// risincronizzarsi (buco nella sequenza `seq`, core di nuovo pronto, journal di nuovo disponibile).
import type {
  CommandError,
  CoreStateSnapshot,
  PingResult,
  VisioneEvent,
  SupervisorSnapshot,
  SystemStatus
} from '../../shared/contracts/index.ts';

export const MAX_EVENTS = 200;

export type Connection = 'connecting' | 'connected' | 'disconnected';

export interface ViewState {
  supervisor: SupervisorSnapshot | null;
  /** Ultimo snapshot dello stato ricevuto dal core (null finché non arriva). */
  core: CoreStateSnapshot | null;
  /** Eventi recenti in ordine di arrivo logico (seq, poi ts), senza duplicati per id. */
  events: VisioneEvent[];
  lastSeq: number;
  needsResync: boolean;
  ping: { ok: true; rttMs: number; at: number; result: PingResult } | { ok: false; at: number; error: CommandError } | null;
  status: SystemStatus | null;
  lastError: CommandError | null;
}

export const initialState: ViewState = {
  supervisor: null,
  core: null,
  events: [],
  lastSeq: 0,
  needsResync: false,
  ping: null,
  status: null,
  lastError: null
};

export type Action =
  | { type: 'supervisor'; snapshot: SupervisorSnapshot }
  | { type: 'state'; snapshot: CoreStateSnapshot }
  | { type: 'event'; event: VisioneEvent }
  | { type: 'page'; events: VisioneEvent[]; lastSeq: number }
  | { type: 'ping'; at: number; rttMs: number; result: PingResult }
  | { type: 'ping-failed'; at: number; error: CommandError }
  | { type: 'status'; status: SystemStatus }
  | { type: 'error'; error: CommandError };

// Ordine totale per la vista: tempo dell'evento, poi seq, poi id. Il seq da solo non basta: gli
// eventi del main entrano nel journal dopo quelli del core che li segue (spool, P-23).
function order(a: VisioneEvent, b: VisioneEvent): number {
  return a.ts - b.ts
    || (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id);
}

// Percorso veloce per il flusso ordinato (il caso normale: un evento alla volta dal bus, in aumento
// di ts/seq). Evita di ricostruire la mappa e riordinare tutta la finestra a ogni evento; il percorso
// completo resta per i lotti e per gli eventi fuori ordine (spool del main, risincronizzazione).
function merge(current: VisioneEvent[], incoming: VisioneEvent[]): VisioneEvent[] {
  if (incoming.length === 1) {
    const e = incoming[0] as VisioneEvent;
    const last = current[current.length - 1];
    if (last === undefined || order(last, e) <= 0) {
      if (last !== undefined && last.id === e.id) {
        // Stesso evento in coda: si tiene la versione con `seq` (quella del journal).
        if (last.seq === null && e.seq !== null) {
          const events = current.slice();
          events[events.length - 1] = e;
          return events;
        }
        return current;
      }
      // Evento già presente altrove: riordino completo (raro).
      if (!current.some((x) => x.id === e.id)) {
        return current.length >= MAX_EVENTS ? [...current.slice(1), e] : [...current, e];
      }
    }
  }
  const byId = new Map(current.map((e) => [e.id, e]));
  // Lo stesso evento può arrivare prima senza seq (dal main) e poi con seq (dal journal).
  for (const e of incoming) {
    const prev = byId.get(e.id);
    if (!prev || (prev.seq === null && e.seq !== null)) byId.set(e.id, e);
  }
  return [...byId.values()].sort(order).slice(-MAX_EVENTS);
}

/** Lo snapshot ricevuto è più recente di quello tenuto? Un nuovo avvio del core riparte da revision 0. */
export function isNewerState(current: CoreStateSnapshot | null, next: CoreStateSnapshot): boolean {
  if (current === null) return true;
  if (current.bootId !== next.bootId) return next.core.startedAt >= current.core.startedAt;
  return next.revision > current.revision;
}

export function reduce(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case 'state': {
      if (!isNewerState(state.core, action.snapshot)) return state;
      const journalBack = state.core?.database.status === 'degraded' && action.snapshot.database.status === 'ok';
      return { ...state, core: action.snapshot, needsResync: state.needsResync || journalBack };
    }
    case 'supervisor': {
      const wasReady = state.supervisor?.state === 'ready';
      const isReady = action.snapshot.state === 'ready';
      return {
        ...state,
        supervisor: action.snapshot,
        // Un nuovo processo core va riverificato: la connessione torna "connecting" fino al ping.
        ping: wasReady && !isReady ? null : state.ping,
        needsResync: state.needsResync || (!wasReady && isReady)
      };
    }
    case 'event': {
      const e = action.event;
      let { lastSeq, needsResync } = state;
      if (e.seq !== null) {
        if (lastSeq > 0 && e.seq > lastSeq + 1) needsResync = true;
        lastSeq = Math.max(lastSeq, e.seq);
      }
      return { ...state, events: merge(state.events, [e]), lastSeq, needsResync };
    }
    case 'page':
      return {
        ...state,
        events: merge(state.events, action.events),
        lastSeq: Math.max(state.lastSeq, action.lastSeq),
        needsResync: false
      };
    case 'ping':
      return { ...state, ping: { ok: true, rttMs: action.rttMs, at: action.at, result: action.result } };
    case 'ping-failed':
      return { ...state, ping: { ok: false, at: action.at, error: action.error }, lastError: action.error };
    case 'status':
      return { ...state, status: action.status };
    case 'error':
      return { ...state, lastError: action.error };
  }
}

/** Stato del collegamento UI → main → core, derivato e mai memorizzato. */
export function connection(state: ViewState): Connection {
  if (state.supervisor?.state !== 'ready') return 'disconnected';
  if (state.ping?.ok && state.ping.at >= state.supervisor.since) return 'connected';
  return 'connecting';
}

export function lastEvent(state: ViewState): VisioneEvent | null {
  return state.events.at(-1) ?? null;
}

/** Lo snapshot del core è quello del processo attuale (altrimenti è l'ultimo noto di un core caduto). */
export function coreStateIsLive(state: ViewState): boolean {
  return state.supervisor?.state === 'ready' && state.core !== null && state.core.core.pid === state.supervisor.pid;
}
