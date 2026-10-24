// Motore della proiezione (DECISIONI P-47): gira nel Web Worker (`neural.worker.ts`) o, se il worker non
// è disponibile, nel thread della UI con lo stesso codice. Riceve eventi reali (live, caricamento dal
// journal, replay) e restituisce grafo e impulsi già posizionati: il thread principale disegna soltanto.
import type { VisioneEvent } from '../../shared/contracts/index.ts';
import { createGraph, ENDED_LINGER_MS, expireEnded, layout, nextExpiryAt, project, projectAll, setDirectorName, snapshotAgents, type Effect, type Graph, type GraphNode, type Pulse, type SystemSignals } from './graph.ts';

export interface NodeView {
  id: string;
  kind: GraphNode['kind'];
  label: string;
  status: string;
  /** P-100: problema reale oltre allo stato (limite del motore raggiunto): il globo diventa rosso. */
  alert?: boolean;
  position: [number, number, number];
  lastEventAt: number;
}
export interface EdgeView {
  key: string;
  from: [number, number, number];
  to: [number, number, number];
  lastEventAt: number;
  /** Numero di eventi reali che hanno usato questo arco: intensità visiva (Fase 12.5). */
  count: number;
}
export interface PulseView extends Pulse {
  fromPos: [number, number, number];
  toPos: [number, number, number];
}

export type ToEngine =
  | { type: 'load'; events: VisioneEvent[] }
  | { type: 'snapshot'; agents: Array<{ id: string; name: string; status: string; archived: boolean }>; director?: string }
  | { type: 'live'; events: VisioneEvent[] }
  | { type: 'replay'; events: VisioneEvent[]; speed: number }
  | { type: 'stop-replay' }
  /** Durata a schermo dei nodi conclusi (`ui.nodeLingerSec`, a caldo). */
  | { type: 'linger'; ms: number };

export type FromEngine =
  | { type: 'graph'; nodes: NodeView[]; edges: EdgeView[]; effects: Effect[]; counts: Graph['counts']; signals: SystemSignals }
  | { type: 'pulses'; pulses: PulseView[] }
  | { type: 'replay'; state: 'running' | 'done' | 'stopped'; done: number; total: number; seq: number | null };

/** Pausa massima tra due eventi del replay (tempo reale, prima della velocità). */
const MAX_REPLAY_GAP_MS = 2_000;
export interface NeuralEngineOptions {
  /** Orologio (test). */
  now?: () => number;
  /** Attesa massima di un controllo di scadenza (test con orologio finto); default nessun limite. */
  expiryMaxWaitMs?: number;
}

export function createNeuralEngine(post: (m: FromEngine) => void, opts: NeuralEngineOptions = {}): { handle(m: ToEngine): void } {
  const now = opts.now ?? Date.now;
  let g = createGraph();
  layout(g);
  let replay: { timer: ReturnType<typeof setTimeout> | null; stopped: boolean } | null = null;
  let lingerMs = ENDED_LINGER_MS;

  const postGraph = (): void => {
    const nodes = [...g.nodes.values()].map((n) => ({ id: n.id, kind: n.kind, label: n.label, status: n.status, alert: n.alert, position: n.position, lastEventAt: n.lastEventAt }));
    const edges: EdgeView[] = [];
    for (const e of g.edges.values()) {
      const a = g.nodes.get(e.from);
      const b = g.nodes.get(e.to);
      if (a && b) edges.push({ key: e.key, from: a.position, to: b.position, lastEventAt: e.lastEventAt, count: e.count });
    }
    post({ type: 'graph', nodes, edges, effects: g.effects.slice(-30), counts: { ...g.counts }, signals: { ...g.signals } });
    scheduleExpiry();
  };

  // P-102: senza nuovi eventi i nodi conclusi escono comunque dopo `lingerMs` (30 s di default). Nessun polling: un solo
  // timer, programmato all'istante della prossima scadenza (dal vivo; nel replay il tempo è quello
  // degli eventi). Il timer non tiene in vita il processo (test, worker).
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleExpiry(): void {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    if (replay) return;
    const at = nextExpiryAt(g, lingerMs);
    if (at === null) return;
    const wait = Math.max(0, Math.min(at - now(), opts.expiryMaxWaitMs ?? Number.POSITIVE_INFINITY));
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      if (replay) return;
      if (expireEnded(g, now(), lingerMs).length > 0) {
        layout(g);
        postGraph(); // riprogramma per il nodo successivo
      } else {
        scheduleExpiry();
      }
    }, wait);
    (expiryTimer as { unref?: () => void }).unref?.();
  }

  /** Proietta eventi con animazione: un impulso per evento di dominio. */
  const animate = (events: readonly VisioneEvent[]): void => {
    const pulses: Pulse[] = [];
    let changed = false;
    let topology = false;
    let latest = 0;
    for (const e of events) {
      const d = project(g, e);
      if (!d) continue;
      changed = true;
      topology ||= d.topology;
      latest = Math.max(latest, e.ts);
      if (d.pulse) pulses.push(d.pulse);
    }
    if (!changed) return;
    // P-102: il tempo della scena è quello degli eventi (anche nel replay compresso).
    if (expireEnded(g, latest, lingerMs).length > 0) topology = true;
    if (topology) layout(g);
    postGraph();
    const views: PulseView[] = [];
    for (const p of pulses) {
      const a = g.nodes.get(p.from);
      const b = g.nodes.get(p.to) ?? a;
      if (a && b) views.push({ ...p, fromPos: a.position, toPos: b.position });
    }
    if (views.length > 0) post({ type: 'pulses', pulses: views });
  };

  const stopReplay = (state: 'done' | 'stopped', done: number, total: number, seq: number | null): void => {
    if (replay?.timer) clearTimeout(replay.timer);
    replay = null;
    post({ type: 'replay', state, done, total, seq });
  };

  return {
    handle(m) {
      switch (m.type) {
        case 'load':
          if (replay) return;
          g = createGraph();
          projectAll(g, m.events);
          // P-102: il lavoro già concluso da più di `lingerMs` non torna in scena all'apertura.
          expireEnded(g, now(), lingerMs);
          layout(g);
          postGraph();
          return;
        case 'snapshot': {
          // Rubrica reale (come `eventiDaElenco` di Munder): nessun impulso, solo nodi vivi.
          if (replay) return;
          const changed = snapshotAgents(g, m.agents);
          // P-99: nome del Director dalla configurazione reale (label, mai un impulso).
          setDirectorName(g, m.director ?? 'Director');
          if (changed) layout(g);
          postGraph();
          return;
        }
        case 'live':
          // Durante il replay il live non tocca la scena: al ritorno si ricarica dal journal.
          if (!replay) animate(m.events);
          return;
        case 'linger': {
          // Durata scelta dal proprietario: vale subito. Più corta toglie ora i nodi già scaduti;
          // più lunga vale per quelli ancora in scena (gli usciti restano nel journal e nei Log).
          if (!Number.isFinite(m.ms)) return;
          lingerMs = Math.min(600_000, Math.max(5_000, Math.round(m.ms)));
          if (replay) return;
          if (expireEnded(g, now(), lingerMs).length > 0) layout(g);
          postGraph();
          return;
        }
        case 'stop-replay':
          if (replay) {
            replay.stopped = true;
            stopReplay('stopped', 0, 0, null);
          }
          return;
        case 'replay': {
          if (replay?.timer) clearTimeout(replay.timer);
          g = createGraph();
          layout(g);
          postGraph();
          const events = [...m.events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.ts - b.ts);
          // Guardia (P-74): una velocità non finita non deve trasformare il replay in un ciclo a vuoto.
          const speed = Number.isFinite(m.speed) ? Math.max(1, m.speed) : 1;
          const state = { timer: null as ReturnType<typeof setTimeout> | null, stopped: false };
          replay = state;
          let i = 0;
          const step = (): void => {
            if (state.stopped || replay !== state) return;
            // Eventi con lo stesso istante insieme; poi la pausa reale (compressa) fino al successivo.
            const batch: VisioneEvent[] = [];
            const t0 = events[i]?.ts ?? 0;
            while (i < events.length && (events[i] as VisioneEvent).ts === t0) batch.push(events[i++] as VisioneEvent);
            animate(batch);
            post({ type: 'replay', state: 'running', done: i, total: events.length, seq: batch.at(-1)?.seq ?? null });
            if (i >= events.length) {
              stopReplay('done', i, events.length, batch.at(-1)?.seq ?? null);
              return;
            }
            const gapRaw = (events[i] as VisioneEvent).ts - t0;
            const gap = Number.isFinite(gapRaw) ? Math.min(MAX_REPLAY_GAP_MS, Math.max(0, gapRaw)) : 0;
            state.timer = setTimeout(step, gap / speed);
          };
          step();
          return;
        }
      }
    }
  };
}
