// Proiezione degli eventi nel grafo della scena Neural 3D (VISIONE_ARCHITECTURE §27, DECISIONI P-47).
// Funzioni pure, eseguite nel Web Worker (e nei test): `project(grafo, evento) → GraphDelta`, poi il
// layout. Solo eventi reali del bus: niente eventi sintetici. Ogni evento di dominio produce un effetto
// tracciabile (con il suo id); le posizioni cambiano solo quando la topologia cambia per un evento.
// Gerarchia: VISIONE → Director → Agent → Tool (+ satelliti task, memoria, processi, approvazioni).
// Director è il coordinatore (il Director): nodo centrale e distintivo della scena.
// Fase 13 — Event-Driven Neural Launch: Director→Agent da `task.assigned`/`director.decision(assign)`;
// il ritorno di un risultato va Agent→Director (`task.result.recorded`, instradato al coordinatore) e
// Director→JARVIS da `director.summary` (target → VISIONE). A scena ferma non esiste alcun impulso.
import type { Endpoint, EventCategory, VisioneEvent } from '../../shared/contracts/index.ts';

export type NodeKind = 'visione' | 'director' | 'agent' | 'tool' | 'task' | 'memory' | 'process' | 'approval';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  parent: string | null;
  status: string;
  /**
   * P-100: problema reale che non è uno stato dell'istanza (limite di quota raggiunto dal motore):
   * il globo lo mostra rosso finché l'agente non riprende a lavorare. Dato reale, mai inventato.
   */
  alert: boolean;
  createdAt: number;
  lastEventAt: number;
  lastEventId: string | null;
  events: number;
  position: [number, number, number];
}

export interface GraphEdge {
  key: string;
  from: string;
  to: string;
  lastEventAt: number;
  lastEventId: string;
  count: number;
}

/** Un impulso = un evento: da `from` a `to` (uguali = lampo sul nodo). */
export interface Pulse {
  eventId: string;
  type: string;
  from: string;
  to: string;
  at: number;
  /** 0..1 da valori reali del payload (token, durata), altrimenti neutra (0.5). */
  intensity: number;
}

/** Traccia dell'effetto di un evento sulla scena. */
export interface Effect {
  eventId: string;
  type: string;
  seq: number | null;
  at: number;
  nodes: string[];
  edge: string | null;
}

export interface GraphDelta {
  upserted: string[];
  removed: string[];
  edge: GraphEdge | null;
  pulse: Pulse | null;
  effect: Effect | null;
  /** La topologia è cambiata: serve un nuovo layout. */
  topology: boolean;
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  effects: Effect[];
  /** Eventi di dominio proiettati / eventi ignorati (non di dominio). */
  counts: { domain: number; ignored: number };
  /** Istanti reali dell'ultima attività per tipo (Fase 12.5): guidano lo stato di Director. */
  signals: SystemSignals;
  /** Nodi task/processo in stato terminale (Fase 17): la potatura non scorre il grafo a ogni evento. */
  ended: { task: number; process: number };
}

/** Stato del coordinatore derivato SOLO dagli istanti reali degli eventi (nessuno stato inventato). */
export type DirectorState = 'idle' | 'planning' | 'working' | 'error';

export interface SystemSignals {
  /** Ultimo evento del Director (piano, decisione, obiettivo, sintesi). */
  directorAt: number;
  /** Ultimo evento di lavoro reale (agente/task che parte, strumento). */
  workAt: number;
  /** Ultimo evento di errore reale (gravità error/critical o esito non riuscito). */
  errorAt: number;
}

/** Finestra entro cui un segnale è ancora "fresco": oltre, lo stato torna a idle da solo. */
export const SIGNAL_WINDOW_MS = 6_000;

/** Stato effettivo a un istante dato: decade in `idle` senza nuovi eventi (nessun timer). */
export function systemState(signals: SystemSignals, now: number): DirectorState {
  const fresh = (at: number): boolean => at > 0 && now - at < SIGNAL_WINDOW_MS;
  if (fresh(signals.errorAt)) return 'error';
  if (fresh(signals.workAt)) return 'working';
  if (fresh(signals.directorAt)) return 'planning';
  return 'idle';
}

export const MAX_EFFECTS = 200;
// P-102: tetto di sicurezza per le raffiche (la regola normale è l'uscita dopo `ENDED_LINGER_MS`).
export const MAX_ENDED_TASKS = 15;
export const MAX_ENDED_PROCESSES = 10;

/** Categorie di dominio: ogni evento registrato di queste categorie ha un effetto sulla scena. */
export const DOMAIN_CATEGORIES: ReadonlySet<EventCategory> = new Set<EventCategory>(['agent', 'task', 'director', 'tool', 'memory', 'approval', 'process', 'terminal', 'file', 'git', 'error']);
/** Flussi di uscita dei processi: contenuto dei terminali, non eventi di dominio (P-45). */
export const OUTPUT_TYPES: ReadonlySet<string> = new Set(['process.stdout', 'process.stderr', 'process.input', 'process.starting']);

export function isDomainEvent(e: Pick<VisioneEvent, 'type' | 'category'>): boolean {
  return DOMAIN_CATEGORIES.has(e.category) && !OUTPUT_TYPES.has(e.type);
}

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'blocked', 'exited', 'crashed', 'stopped', 'timeout', 'granted', 'denied', 'expired']);
/** Esiti che valgono come errore reale per lo stato del coordinatore (Fase 12.5). */
const FAILED_STATES: ReadonlySet<string> = new Set(['failed', 'crashed', 'denied', 'blocked', 'timed_out', 'error']);

export function createGraph(): Graph {
  const g: Graph = { nodes: new Map(), edges: new Map(), effects: [], counts: { domain: 0, ignored: 0 }, signals: { directorAt: 0, workAt: 0, errorAt: 0 }, ended: { task: 0, process: 0 } };
  ensure(g, 'visione', 'visione', 'VISIONE', null, 0);
  ensure(g, 'director', 'director', 'Director', 'visione', 0);
  return g;
}

function ensure(g: Graph, id: string, kind: NodeKind, label: string, parent: string | null, at: number): { node: GraphNode; created: boolean } {
  const existing = g.nodes.get(id);
  if (existing) return { node: existing, created: false };
  const node: GraphNode = { id, kind, label, parent, status: 'idle', alert: false, createdAt: at, lastEventAt: 0, lastEventId: null, events: 0, position: [0, 0, 0] };
  g.nodes.set(id, node);
  return { node, created: true };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * L'agente con id «director» (quello che comanda, creato dalla procedura guidata) È il nodo del
 * coordinatore, come in `snapshotAgents` (P-99). Prima gli eventi creavano anche «agent:director»:
 * nella scena comparivano «Director» e un doppione «director» (collaudo P-105, 10/10/2026).
 */
function coordinatorAlias<T extends { id: string; kind: NodeKind; label: string; parent: string | null }>(spec: T): T {
  if (spec.id === 'agent:director') return { ...spec, id: 'director', kind: 'director', label: 'Director', parent: 'visione' };
  if (spec.parent === 'agent:director') return { ...spec, parent: 'director' };
  return spec;
}

/** Nodo di un estremo dell'evento (null se non rappresentato nella scena). */
function endpointNode(ep: Endpoint | null, payload: Record<string, unknown>): { id: string; kind: NodeKind; label: string; parent: string | null } | null {
  if (!ep) return null;
  switch (ep.kind) {
    case 'agent': return { id: `agent:${ep.id}`, kind: 'agent', label: ep.id, parent: 'director' };
    case 'director': return { id: 'director', kind: 'director', label: 'Director', parent: 'visione' };
    case 'task': return { id: `task:${ep.id}`, kind: 'task', label: str(payload.title) ?? ep.id.slice(-6), parent: 'director' };
    case 'memory': return { id: 'memory', kind: 'memory', label: 'Memoria', parent: 'visione' };
    case 'process':
    case 'terminal': {
      const owner = payload.owner as { agentId?: string | null } | undefined;
      return { id: `process:${ep.id}`, kind: 'process', label: ep.id.slice(-6), parent: owner?.agentId ? `agent:${owner.agentId}` : 'visione' };
    }
    case 'tool': return null;
    case 'visione': return ep.id === 'memory' ? { id: 'memory', kind: 'memory', label: 'Memoria', parent: 'visione' } : { id: 'visione', kind: 'visione', label: 'VISIONE', parent: null };
    default: return { id: 'visione', kind: 'visione', label: 'VISIONE', parent: null };
  }
}

/** Intensità da valori reali: token, durata; altrimenti neutra. */
export function intensityOf(e: VisioneEvent): number {
  const p = e.payload as Record<string, unknown>;
  const usage = p.usage as Record<string, number | undefined> | undefined;
  if (usage) {
    const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    if (tokens > 0) return Math.min(1, 0.3 + Math.log10(tokens) / 6);
  }
  const ms = typeof p.durationMs === 'number' ? p.durationMs : null;
  if (ms !== null && ms > 0) return Math.min(1, 0.3 + Math.log10(ms) / 6);
  if (e.severity === 'error' || e.severity === 'critical') return 1;
  return 0.5;
}

function removeNode(g: Graph, id: string, removed: string[]): void {
  const node = g.nodes.get(id);
  if (!node) return;
  g.nodes.delete(id);
  if ((node.kind === 'task' || node.kind === 'process') && TERMINAL_STATES.has(node.status)) {
    g.ended[node.kind] = Math.max(0, g.ended[node.kind] - 1);
  }
  removed.push(id);
  for (const [key, edge] of g.edges) if (edge.from === id || edge.to === id) g.edges.delete(key);
  for (const n of [...g.nodes.values()]) if (n.parent === id) removeNode(g, n.id, removed);
}

/** Tiene limitati i nodi terminati (task, processi): restano i più recenti. */
function prune(g: Graph, removed: string[]): void {
  for (const [kind, max] of [['task', MAX_ENDED_TASKS], ['process', MAX_ENDED_PROCESSES]] as const) {
    if (g.ended[kind] <= max) continue; // sotto il limite non si scorre né si ordina nulla
    const ended: GraphNode[] = [];
    for (const n of g.nodes.values()) if (n.kind === kind && TERMINAL_STATES.has(n.status)) ended.push(n);
    ended.sort((a, b) => b.lastEventAt - a.lastEventAt);
    // Potatura a lotti: si tiene la metà più recente, così non gira a ogni singolo evento.
    for (const n of ended.slice(Math.max(1, Math.floor(max / 2)))) removeNode(g, n.id, removed);
  }
}

/**
 * P-102 — I nodi di lavoro concluso (task, processi, strumenti, approvazioni) restano visibili per
 * questo tempo dall'ultimo evento reale, poi escono dalla scena: la scena mostra il lavoro, non lo
 * storico (che resta nel journal, nei Log e nel pannello dei task).
 */
export const ENDED_LINGER_MS = 30_000;
const EXPIRING_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['task', 'process', 'tool', 'approval']);
/** Stati conclusi: i terminali più gli esiti di uno strumento (`ok`/`error`). */
const FINISHED_STATES: ReadonlySet<string> = new Set([...TERMINAL_STATES, 'ok', 'error']);

/** Istante in cui scadrà il prossimo nodo concluso; null se non ce n'è nessuno (nessun timer). */
export function nextExpiryAt(g: Graph, lingerMs = ENDED_LINGER_MS): number | null {
  let at: number | null = null;
  for (const n of g.nodes.values()) {
    if (!EXPIRING_KINDS.has(n.kind) || !FINISHED_STATES.has(n.status)) continue;
    const due = n.lastEventAt + lingerMs;
    if (at === null || due < at) at = due;
  }
  return at;
}

/** Toglie i nodi di lavoro concluso da almeno `ENDED_LINGER_MS` all'istante `now`; ritorna gli id tolti. */
export function expireEnded(g: Graph, now: number, lingerMs = ENDED_LINGER_MS): string[] {
  const removed: string[] = [];
  for (const n of [...g.nodes.values()]) {
    if (!EXPIRING_KINDS.has(n.kind) || !FINISHED_STATES.has(n.status) || !g.nodes.has(n.id)) continue;
    if (now - n.lastEventAt >= lingerMs) removeNode(g, n.id, removed);
  }
  return removed;
}

/**
 * Applica un evento al grafo. `null` per un evento non di dominio (contato, nessun effetto); per
 * ogni evento di dominio un effetto con il suo id e almeno un nodo toccato (impulso o lampo).
 */
export function project(g: Graph, e: VisioneEvent): GraphDelta | null {
  if (!isDomainEvent(e)) {
    g.counts.ignored++;
    return null;
  }
  g.counts.domain++;
  const p = e.payload as Record<string, unknown>;
  const upserted = new Set<string>();
  const removed: string[] = [];
  let topology = false;
  let maybePrune = false;
  const touch = (raw: { id: string; kind: NodeKind; label: string; parent: string | null }): GraphNode => {
    const spec = coordinatorAlias(raw);
    if (spec.parent && spec.parent !== spec.id && !g.nodes.has(spec.parent)) {
      const parentKind: NodeKind = spec.parent.startsWith('agent:') ? 'agent' : spec.parent === 'director' ? 'director' : 'visione';
      touch({ id: spec.parent, kind: parentKind, label: spec.parent.replace(/^agent:/, ''), parent: parentKind === 'agent' ? 'director' : parentKind === 'director' ? 'visione' : null });
    }
    const { node, created } = ensure(g, spec.id, spec.kind, spec.label, spec.parent, e.ts);
    if (created) topology = true;
    node.lastEventAt = e.ts;
    node.lastEventId = e.id;
    node.events++;
    upserted.add(node.id);
    return node;
  };
  // Aggiorna lo stato tenendo il conteggio dei terminali (task/processo): la potatura sa quando serve.
  const setNodeStatus = (node: GraphNode, status: string): void => {
    if (node.kind === 'task' || node.kind === 'process') {
      const was = TERMINAL_STATES.has(node.status);
      const now = TERMINAL_STATES.has(status);
      node.status = status;
      if (!was && now) {
        g.ended[node.kind]++;
        maybePrune = true;
      } else if (was && !now) {
        g.ended[node.kind] = Math.max(0, g.ended[node.kind] - 1);
      }
    } else {
      node.status = status;
    }
  };

  // Estremi: sorgente e destinazione dichiarate; in mancanza, gli id del payload.
  const agentId = str(p.agentId);
  const taskId = str(p.taskId);
  let src = endpointNode(e.source, p);
  let dst = endpointNode(e.target, p);
  if (!dst && agentId && src?.id !== `agent:${agentId}`) dst = { id: `agent:${agentId}`, kind: 'agent', label: agentId, parent: 'director' };
  if (!dst && taskId) dst = { id: `task:${taskId}`, kind: 'task', label: str(p.title) ?? taskId.slice(-6), parent: 'director' };
  if (e.category === 'tool' && agentId) {
    const tool = str(p.tool) ?? str(p.name) ?? 'strumento';
    const toolNode = { id: `tool:${agentId}:${tool}`, kind: 'tool' as const, label: tool, parent: `agent:${agentId}` };
    src = { id: `agent:${agentId}`, kind: 'agent', label: agentId, parent: 'director' };
    dst = toolNode;
  }
  if (e.category === 'approval') {
    const id = str(p.approvalId) ?? e.id;
    dst = { id: `approval:${id}`, kind: 'approval', label: str(p.kind) ?? 'approvazione', parent: 'director' };
    src ??= { id: 'director', kind: 'director', label: 'Director', parent: 'visione' };
  }
  if (!src) src = { id: 'visione', kind: 'visione', label: 'VISIONE', parent: null };
  // Il processo di un agente nasce sotto l'agente proprietario.
  const owner = p.owner as { agentId?: string | null } | undefined;
  if (dst?.kind === 'process' && owner?.agentId) dst.parent = `agent:${owner.agentId}`;

  // Ritorno al coordinatore (Fase 13). Un risultato prodotto da un agente è consegnato al Director,
  // proprietario del piano: l'origine è l'agente reale (`source`), la destinazione è il nodo Director
  // (il task, figlio del Director nella topologia costruita dagli eventi, resta comunque aggiornato).
  // Nessun evento nuovo e nessun evento "per scopi visivi": si instrada un evento che esiste già.
  const declaredDst = dst;
  const toCoordinator = e.type === 'task.result.recorded' && src.kind === 'agent';
  if (toCoordinator) dst = { id: 'director', kind: 'director', label: 'Director', parent: 'visione' };

  const s = touch(src);
  const d = dst ? touch(dst) : null;
  // Anche quando il risultato è instradato a Director, il nodo del task registra l'evento reale.
  if (toCoordinator && declaredDst && declaredDst.id !== s.id && declaredDst.id !== d?.id) touch(declaredDst);

  // Stato dei nodi dai valori reali del payload.
  switch (e.type) {
    case 'agent.status.changed':
    case 'task.status.changed':
      if (d) setNodeStatus(d, String(p.to));
      // P-100: quando l'agente riprende davvero a lavorare, il problema «limite» è finito.
      if (e.type === 'agent.status.changed' && d && (p.to === 'working' || p.to === 'starting')) d.alert = false;
      break;
    // P-100: il limite di quota è un problema reale del motore (globo rosso) anche se lo stato
    // dell'istanza resta `idle`: si segnala sul nodo agente e si azzera al turno successivo.
    case 'agent.limit.reached':
      if (d) d.alert = true;
      break;
    case 'agent.definition.created':
    case 'agent.definition.updated':
      if (d) {
        d.label = str(p.name) ?? d.label;
        if (d.status === 'idle') setNodeStatus(d, 'defined');
      }
      break;
    case 'task.created':
      if (d) {
        setNodeStatus(d, 'created');
        d.label = str(p.title) ?? d.label;
      }
      break;
    case 'tool.call.started':
      if (d) setNodeStatus(d, 'running');
      break;
    case 'tool.call.finished':
      if (d) setNodeStatus(d, p.ok === false ? 'error' : 'ok');
      break;
    case 'tool.call.denied':
      if (d) setNodeStatus(d, 'denied');
      break;
    case 'approval.requested':
      if (d) setNodeStatus(d, 'pending');
      break;
    case 'approval.granted':
      if (d) setNodeStatus(d, 'granted');
      break;
    case 'approval.denied':
      if (d) setNodeStatus(d, 'denied');
      break;
    default:
      if (e.category === 'process' && d && typeof p.status === 'string') setNodeStatus(d, p.status);
      else if (e.type.startsWith('process.') && d) setNodeStatus(d, e.type.slice('process.'.length));
      break;
  }

  // Segnali reali per lo stato del coordinatore (Fase 12.5): solo eventi realmente accaduti.
  if (e.category === 'director') g.signals.directorAt = e.ts;
  if (e.category === 'agent' && e.type === 'agent.status.changed' && p.to === 'working') g.signals.workAt = e.ts;
  if (e.category === 'task' && e.type === 'task.status.changed' && (p.to === 'running' || p.to === 'queued')) g.signals.workAt = e.ts;
  if (e.category === 'tool' && e.type === 'tool.call.started') g.signals.workAt = e.ts;
  if (e.severity === 'error' || e.severity === 'critical') g.signals.errorAt = e.ts;
  if ((e.category === 'task' || e.category === 'agent' || e.category === 'process') && typeof p.to === 'string' && FAILED_STATES.has(p.to)) g.signals.errorAt = e.ts;

  // Archi solo da eventi con sorgente e destinazione diverse.
  let edge: GraphEdge | null = null;
  if (d && d.id !== s.id) {
    const key = `${s.id}>${d.id}`;
    edge = g.edges.get(key) ?? { key, from: s.id, to: d.id, lastEventAt: e.ts, lastEventId: e.id, count: 0 };
    edge.lastEventAt = e.ts;
    edge.lastEventId = e.id;
    edge.count++;
    g.edges.set(key, edge);
  }

  if (e.type === 'agent.definition.archived' && d) {
    removeNode(g, d.id, removed);
    topology = true;
  }
  const before = removed.length;
  if (maybePrune) prune(g, removed);
  if (removed.length > before) topology = true;

  const effect: Effect = { eventId: e.id, type: e.type, seq: e.seq, at: e.ts, nodes: [...upserted], edge: edge && g.edges.has(edge.key) ? edge.key : null };
  g.effects.push(effect);
  if (g.effects.length > MAX_EFFECTS) g.effects.splice(0, g.effects.length - MAX_EFFECTS);
  const pulse: Pulse = { eventId: e.id, type: e.type, from: s.id, to: d && g.nodes.has(d.id) ? d.id : s.id, at: e.ts, intensity: intensityOf(e) };
  return { upserted: [...upserted].filter((id) => g.nodes.has(id)), removed, edge: effect.edge ? edge : null, pulse, effect, topology };
}

/**
 * Layout deterministico (nessuna simulazione: nessun movimento senza eventi), sulla disposizione
 * dell'edizione JARVIS di Munder (P-88): Director al CENTRO del globo, gli agenti su una spirale
 * di Fibonacci attorno a lui (la stessa distribuzione della Rete di Munder: raggio 2,15, apertura
 * in verticale ±0,85, profondità ridotta a 0,55), VISIONE davanti e in basso come la voce, i
 * satelliti (strumenti e processi) in orbita stretta attorno al loro agente, task e approvazioni
 * su un anello esterno. Deterministico per costruzione (ordinamento stabile): un agente non salta
 * di posto quando ne arriva un altro.
 */
export function layout(g: Graph): void {
  const byKind = (a: GraphNode, b: GraphNode): number => a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  // Un solo passaggio: bucket per tipo e figli raggruppati per genitore (prima si scansionava il
  // grafo una volta per tipo e una per agente).
  const agents: GraphNode[] = [];
  const tasks: GraphNode[] = [];
  const approvals: GraphNode[] = [];
  const toolsByParent = new Map<string, GraphNode[]>();
  const procsByParent = new Map<string, GraphNode[]>();
  const push = (map: Map<string, GraphNode[]>, key: string, node: GraphNode): void => {
    const list = map.get(key);
    if (list) list.push(node);
    else map.set(key, [node]);
  };
  for (const n of g.nodes.values()) {
    if (n.kind === 'agent') agents.push(n);
    else if (n.kind === 'task') tasks.push(n);
    else if (n.kind === 'approval') approvals.push(n);
    else if (n.kind === 'tool') push(toolsByParent, n.parent ?? '', n);
    else if (n.kind === 'process') push(procsByParent, n.parent ?? '', n);
  }
  agents.sort(byKind);
  tasks.sort(byKind);
  approvals.sort(byKind);
  for (const list of toolsByParent.values()) list.sort(byKind);
  for (const list of procsByParent.values()) list.sort(byKind);

  const ring = (nodes: GraphNode[], radius: number, y: number, center: [number, number, number] = [0, 0, 0], phase = 0): void => {
    nodes.forEach((n, i) => {
      const a = phase + (i / Math.max(1, nodes.length)) * Math.PI * 2;
      n.position = [center[0] + Math.cos(a) * radius, center[1] + y, center[2] + Math.sin(a) * radius];
    });
  };
  const visione = g.nodes.get('visione');
  // VISIONE davanti e in basso come J.A.R.V.I.S. davanti alla squadra (`disponi` di Rete.tsx).
  if (visione) visione.position = [0, -1.55, 1.15];
  const director = g.nodes.get('director');
  if (director) director.position = [0, 0, 0];
  const memory = g.nodes.get('memory');
  if (memory) memory.position = [0, -2.35, 0];
  // Agenti: spirale aurea su una sfera di raggio 2,15 (Munder, `disponi`): y ±0,85, z ×0,55.
  const n = Math.max(agents.length, 1);
  const RAGGIO_AGENTI = 2.15;
  agents.forEach((a, i) => {
    const ang = i * 2.399963229728653;
    const y = n === 1 ? 0 : (0.5 - i / (n - 1)) * 1.7;
    const r = RAGGIO_AGENTI * Math.sqrt(1 - Math.min(0.85, Math.abs(y) / 1.7) ** 2);
    a.position = [Math.cos(ang) * r, y, Math.sin(ang) * r * 0.55];
  });
  for (const a of agents) {
    ring(toolsByParent.get(a.id) ?? [], 0.55, 0.3, a.position);
    ring(procsByParent.get(a.id) ?? [], 0.45, -0.3, a.position, Math.PI / 4);
  }
  ring(procsByParent.get('visione') ?? [], 0.5, -0.3, visione?.position ?? [0, 0, 0], Math.PI / 4);
  ring(tasks, 3, -0.7, [0, 0, 0], Math.PI / 7);
  ring(approvals, 3.2, 1.1);
}

/** Applica una sequenza di eventi senza animazioni (caricamento iniziale e ripristino del live). */
export function projectAll(g: Graph, events: readonly VisioneEvent[]): number {
  let topology = false;
  let n = 0;
  for (const e of events) {
    const d = project(g, e);
    if (d) {
      n++;
      topology ||= d.topology;
    }
  }
  if (topology || n > 0) layout(g);
  return n;
}

/** Riga reale della rubrica degli agenti (snapshot, non un evento: vedi `snapshotAgents`). */
export interface AgentSnapshot {
  id: string;
  name: string;
  status: string;
  archived: boolean;
}

/**
 * P-99 — nome mostrato del Director (`ui.directorName`): il coordinatore non è un agente del
 * registro, quindi il suo display name arriva qui e aggiorna la label del nodo, senza toccare
 * l'id «director» usato da eventi, archi e click. `true` = la label è cambiata.
 */
export function setDirectorName(g: Graph, name: string): boolean {
  const director = g.nodes.get('director');
  const clean = name.trim();
  if (!director || clean === '' || director.label === clean) return false;
  director.label = clean;
  return true;
}

/**
 * Snapshot della rubrica REALE degli agenti nel grafo, come `eventiDaElenco` della Rete di Munder:
 * i nodi degli agenti esistono appena l'app li conosce, anche se la loro definizione e' piu' vecchia
 * della coda del journal letta all'apertura. Non e' un evento inventato: ogni riga e' un agente che
 * esiste nel registro, e lo stato viene dall'istanza reale (`instance.status`), o `idle` se non ne
 * ha una. Gli archiviati non sono vivi e il loro nodo viene tolto (stessa regola di `archive`).
 * P-99: il nome mostrato segue la definizione (anche dopo una rinomina); un agente con id
 * «director» non crea un doppione: aggiorna il nodo del coordinatore.
 * Restituisce `true` quando la topologia e' cambiata (serve un nuovo layout).
 */
export function snapshotAgents(g: Graph, agents: readonly AgentSnapshot[]): boolean {
  let topology = false;
  const presenti = new Set<string>();
  for (const a of agents) {
    if (a.archived) continue;
    const name = a.name || a.id;
    if (a.id === 'director') {
      // Il coordinatore ha gia' il suo nodo: qui si allinea solo il nome reale.
      const director = g.nodes.get('director');
      if (director && name !== '') director.label = name;
      continue;
    }
    const id = `agent:${a.id}`;
    presenti.add(id);
    const { node, created } = ensure(g, id, 'agent', name, 'director', Date.now());
    if (created) topology = true;
    // P-99: la label segue il nome reale della definizione (rinomina visibile senza riavvio).
    if (node.label !== name) node.label = name;
    // Lo stato è quello dichiarato dall'istanza reale. P-100: «created» (definito ma senza istanza)
    // è lo stato vero di un agente mai avviato e il globo lo mostra bianco (spento/mai avviato).
    if (a.status) node.status = a.status;
  }
  for (const node of [...g.nodes.values()]) {
    if (node.kind !== 'agent' || presenti.has(node.id)) continue;
    removeNode(g, node.id, []);
    topology = true;
  }
  return topology;
}
