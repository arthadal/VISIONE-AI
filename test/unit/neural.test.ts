// Scena Neural 3D (Fase 8): proiezione pura degli eventi e motore del worker. DoD: ogni evento di
// dominio registrato ha un effetto tracciabile (con il suo id); nessun impulso senza un evento; posizioni
// ferme se la topologia non cambia; replay dal journal con un impulso per evento.
import { describe, expect, it } from 'vitest';
import { createEngine } from './neural-helpers.ts';
import {
  createGraph,
  DOMAIN_CATEGORIES,
  ENDED_LINGER_MS,
  expireEnded,
  isDomainEvent,
  layout,
  MAX_ENDED_TASKS,
  OUTPUT_TYPES,
  project,
  projectAll,
  SIGNAL_WINDOW_MS,
  snapshotAgents,
  systemState,
  type SystemSignals
} from '../../src/renderer/neural/graph.ts';
import { EVENT_DEFINITIONS, EVENT_TYPES, type VisioneEvent } from '../../src/shared/contracts/index.ts';

let n = 0;
function ev(type: string, payload: Record<string, unknown> = {}, over: Partial<VisioneEvent> = {}): VisioneEvent {
  const def = EVENT_DEFINITIONS[type as keyof typeof EVENT_DEFINITIONS];
  n++;
  return {
    id: `E${String(n).padStart(25, '0')}`, seq: n, ts: 1_000 + n, type, category: def?.category ?? 'system',
    source: { kind: 'visione', id: 'core' }, target: null, correlationId: 'c', causationId: null,
    severity: def?.severity ?? 'info', durability: def?.durability ?? 'durable', schema: 1, payload, ...over
  } as VisioneEvent;
}

/** Estremi plausibili per categoria, come li emette il core. */
function realistic(type: string): VisioneEvent {
  const cat = EVENT_DEFINITIONS[type as keyof typeof EVENT_DEFINITIONS].category;
  const payload = { agentId: 'alfa', taskId: 'T1', processId: 'P1', tool: 'Read', approvalId: 'A1', to: 'running', from: 'queued', owner: { agentId: 'alfa', sessionId: null, taskId: null, adapter: 'x' } };
  const target = cat === 'agent' ? { kind: 'agent' as const, id: 'alfa' } : cat === 'task' ? { kind: 'task' as const, id: 'T1' } : cat === 'process' ? { kind: 'process' as const, id: 'P1' }
    : cat === 'memory' ? { kind: 'memory' as const, id: 'M1' } : cat === 'terminal' ? { kind: 'terminal' as const, id: 'P2' } : null;
  return ev(type, payload, { target, source: cat === 'director' ? { kind: 'director', id: 'director' } : { kind: 'visione', id: 'core' } });
}

describe('proiezione degli eventi (Neural 3D)', () => {
  it('DoD: ogni tipo di evento di dominio registrato ha un effetto tracciabile; gli altri nessuno', () => {
    // Categorie di dominio dichiarate (P-47): fuori solo sistema, telemetria, voce, UI e i flussi di uscita.
    expect([...DOMAIN_CATEGORIES].sort()).toEqual(['agent', 'approval', 'director', 'error', 'file', 'git', 'memory', 'process', 'task', 'terminal', 'tool']);
    expect([...OUTPUT_TYPES].sort()).toEqual(['process.input', 'process.starting', 'process.stderr', 'process.stdout']);
    const domain = EVENT_TYPES.filter((t) => isDomainEvent({ type: t, category: EVENT_DEFINITIONS[t].category }));
    expect(domain.length).toBeGreaterThan(50);
    for (const type of EVENT_TYPES) {
      const g = createGraph();
      const e = realistic(type);
      const d = project(g, e);
      if (domain.includes(type)) {
        expect(d, type).not.toBeNull();
        expect(d?.effect, type).toMatchObject({ eventId: e.id, type });
        expect(d?.effect?.nodes.length, type).toBeGreaterThan(0);
        expect(d?.pulse?.eventId, type).toBe(e.id);
        expect(g.effects.at(-1)?.eventId).toBe(e.id);
      } else {
        expect(d, type).toBeNull();
        expect(DOMAIN_CATEGORIES.has(EVENT_DEFINITIONS[type].category) ? OUTPUT_TYPES.has(type) : true, type).toBe(true);
      }
    }
  });

  it('gerarchia, stati dai payload, archi solo tra sorgente e destinazione, archiviazione', () => {
    const g = createGraph();
    project(g, ev('agent.definition.created', { agentId: 'alfa', name: 'Alfa' }, { target: { kind: 'agent', id: 'alfa' } }));
    project(g, ev('agent.status.changed', { agentId: 'alfa', to: 'working' }, { source: { kind: 'visione', id: 'agents' }, target: { kind: 'agent', id: 'alfa' } }));
    project(g, ev('tool.call.started', { agentId: 'alfa', tool: 'Read' }, { source: { kind: 'agent', id: 'alfa' } }));
    project(g, ev('tool.call.finished', { agentId: 'alfa', tool: 'Read', ok: false, durationMs: 120 }, { source: { kind: 'agent', id: 'alfa' } }));
    project(g, ev('task.created', { taskId: 'T1', title: 'Scrivi' }, { target: { kind: 'task', id: 'T1' } }));
    project(g, ev('task.assigned', { taskId: 'T1', agentId: 'alfa' }, { source: { kind: 'director', id: 'director' }, target: { kind: 'agent', id: 'alfa' } }));
    expect(g.nodes.get('agent:alfa')).toMatchObject({ kind: 'agent', label: 'Alfa', status: 'working', parent: 'director' });
    expect(g.nodes.get('tool:alfa:Read')).toMatchObject({ kind: 'tool', parent: 'agent:alfa', status: 'error' });
    expect(g.nodes.get('task:T1')).toMatchObject({ label: 'Scrivi', status: 'created' });
    expect([...g.edges.keys()].sort()).toEqual(['agent:alfa>tool:alfa:Read', 'director>agent:alfa', 'visione>agent:alfa', 'visione>task:T1']);
    // Un evento senza destinazione non crea archi: lampo sulla sorgente.
    const solo = project(g, ev('memory.error', { agentId: null, stage: 'index', message: 'x' }, { source: { kind: 'visione', id: 'memory' } }));
    expect(solo?.edge).toBeNull();
    expect(solo?.pulse).toMatchObject({ from: 'memory', to: 'memory' });
    const archived = project(g, ev('agent.definition.archived', { agentId: 'alfa', by: 'owner' }, { target: { kind: 'agent', id: 'alfa' } }));
    expect(archived?.removed.sort()).toEqual(['agent:alfa', 'tool:alfa:Read']);
    expect(archived?.topology).toBe(true);
    expect(archived?.effect?.eventId).toBeDefined();
  });

  it('P-100: il limite raggiunto marca il nodo agente (alert) e riprende solo col turno successivo', () => {
    const g = createGraph();
    project(g, ev('agent.definition.created', { agentId: 'alfa', name: 'Alfa' }, { target: { kind: 'agent', id: 'alfa' } }));
    project(g, ev('agent.status.changed', { agentId: 'alfa', to: 'working' }, { target: { kind: 'agent', id: 'alfa' } }));
    expect(g.nodes.get('agent:alfa')?.alert).toBe(false);
    project(g, ev('agent.limit.reached', {
      agentId: 'alfa', sessionId: null, taskId: null, turnId: 't1', adapter: 'x', scope: 'session', message: 'limite raggiunto', resetAt: null
    }));
    expect(g.nodes.get('agent:alfa')?.alert).toBe(true);
    // Tornare fermo NON cancella il problema: il globo resta rosso finché non riprende a lavorare.
    project(g, ev('agent.status.changed', { agentId: 'alfa', to: 'idle' }, { target: { kind: 'agent', id: 'alfa' } }));
    expect(g.nodes.get('agent:alfa')?.alert).toBe(true);
    project(g, ev('agent.status.changed', { agentId: 'alfa', to: 'working' }, { target: { kind: 'agent', id: 'alfa' } }));
    expect(g.nodes.get('agent:alfa')?.alert).toBe(false);
    // Il Director non è un agente: il limite su un altro agente non lo tocca.
    expect(g.nodes.get('director')?.alert).toBe(false);
  });

  it('P-100: snapshot agenti — senza istanza lo stato è «created» (globo bianco), con istanza è quello reale', () => {
    const g = createGraph();
    const changed = snapshotAgents(g, [
      { id: 'mai', name: 'Mai Avviato', status: 'created', archived: false },
      { id: 'vivo', name: 'Vivo', status: 'working', archived: false },
      { id: 'spento', name: 'Spento', status: 'stopped', archived: false }
    ]);
    expect(changed).toBe(true);
    expect(g.nodes.get('agent:mai')).toMatchObject({ status: 'created', alert: false });
    expect(g.nodes.get('agent:vivo')).toMatchObject({ status: 'working' });
    expect(g.nodes.get('agent:spento')).toMatchObject({ status: 'stopped' });
    // L'archiviato non compare (non è vivo).
    snapshotAgents(g, [{ id: 'mai', name: 'Mai Avviato', status: 'created', archived: true }]);
    expect(g.nodes.has('agent:mai')).toBe(false);
    expect(g.nodes.has('agent:vivo')).toBe(false);
  });

  it('P-105: l\'agente «director» è il nodo del coordinatore anche negli eventi (niente doppione)', () => {
    // Collaudo 10/10/2026: nella scena c'erano «Director» e un secondo nodo «director».
    const g = createGraph();
    snapshotAgents(g, [{ id: 'director', name: 'Pippo', status: 'idle', archived: false }]);
    project(g, ev('agent.status.changed', { agentId: 'director', to: 'working' }, { target: { kind: 'agent', id: 'director' } }));
    project(g, ev('tool.call.started', { agentId: 'director', tool: 'Read' }, { source: { kind: 'agent', id: 'director' } }));
    project(g, ev('process.started', { processId: 'P9', owner: { agentId: 'director', sessionId: null, taskId: null, adapter: 'x' } }, { target: { kind: 'process', id: 'P9' } }));
    expect(g.nodes.has('agent:director')).toBe(false);
    expect(g.nodes.get('director')).toMatchObject({ kind: 'director', label: 'Pippo', status: 'working' });
    for (const node of g.nodes.values()) expect(node.parent, node.id).not.toBe('agent:director');
  });

  it('intensità da valori reali (token, durata), neutra altrimenti; nodi terminati limitati', () => {
    const g = createGraph();
    const tokens = project(g, ev('agent.usage.updated', { agentId: 'a', usage: { inputTokens: 9_000, outputTokens: 1_000 } }, { target: { kind: 'agent', id: 'a' } }));
    const neutral = project(g, ev('agent.turn.started', { agentId: 'a', turnId: 't' }, { target: { kind: 'agent', id: 'a' } }));
    expect(tokens?.pulse?.intensity).toBeGreaterThan(0.9);
    expect(neutral?.pulse?.intensity).toBe(0.5);
    for (let i = 0; i < MAX_ENDED_TASKS + 15; i++) {
      project(g, ev('task.status.changed', { taskId: `T${i}`, to: 'succeeded' }, { target: { kind: 'task', id: `T${i}` } }));
    }
    // Fase 17: la potatura è a lotti (meno scansioni per evento); il numero resta comunque limitato.
    const endedTasks = [...g.nodes.values()].filter((x) => x.kind === 'task');
    expect(endedTasks.length).toBeLessThanOrEqual(MAX_ENDED_TASKS);
    expect(endedTasks.length).toBeGreaterThan(0);
  });

  it('layout deterministico: le posizioni cambiano solo con la topologia (nessun moto senza eventi)', () => {
    const events = ['alfa', 'beta', 'gamma'].map((id) => ev('agent.definition.created', { agentId: id, name: id }, { target: { kind: 'agent', id } }));
    const a = createGraph();
    const b = createGraph();
    projectAll(a, events);
    projectAll(b, events);
    const pos = (g: ReturnType<typeof createGraph>) => [...g.nodes.values()].map((x) => `${x.id}@${x.position.map((v) => v.toFixed(3)).join(',')}`).sort();
    expect(pos(a)).toEqual(pos(b));
    const before = pos(a);
    const d = project(a, ev('agent.status.changed', { agentId: 'beta', to: 'idle' }, { target: { kind: 'agent', id: 'beta' } }));
    expect(d?.topology).toBe(false);
    layout(a);
    expect(pos(a)).toEqual(before);
  });
});

describe('Fase 12 — 3D Neural Command Center', () => {
  it('Director è il nodo centrale; agenti e connessioni provengono da eventi reali', () => {
    const g = createGraph();
    layout(g);
    expect(g.nodes.get('director')).toMatchObject({ label: 'Director', kind: 'director', position: [0, 0, 0] });
    expect(g.nodes.get('visione')?.position[1]).toBeLessThan(0); // VISIONE è il substrato, sotto Director

    project(g, ev('agent.definition.created', { agentId: 'alfa', name: 'Alfa' }, { target: { kind: 'agent', id: 'alfa' } }));
    project(g, ev('agent.definition.created', { agentId: 'beta', name: 'Beta' }, { target: { kind: 'agent', id: 'beta' } }));
    project(g, ev('task.assigned', { taskId: 'T1', agentId: 'alfa' }, { source: { kind: 'director', id: 'director' }, target: { kind: 'agent', id: 'alfa' } }));
    // Connessione Director → agente e agente ↔ agente: solo da `task.assigned` e `agent.message.sent`.
    const msg = project(g, ev('agent.message.sent', { messageId: 'M1', conversationId: 'cv', from: 'alfa', to: 'beta', act: 'inform', subject: 'dato', hops: 0, taskId: null }, { source: { kind: 'agent', id: 'alfa' }, target: { kind: 'agent', id: 'beta' } }));
    expect([...g.edges.keys()]).toEqual(expect.arrayContaining(['director>agent:alfa', 'agent:alfa>agent:beta']));
    expect(msg?.edge?.key).toBe('agent:alfa>agent:beta');
    expect(msg?.effect?.edge).toBe('agent:alfa>agent:beta');
    expect(msg?.pulse).toMatchObject({ from: 'agent:alfa', to: 'agent:beta' });
    // Profondità reale: gli agenti stanno su un piano diverso dal centro.
    layout(g);
    expect(g.nodes.get('agent:alfa')?.position[1]).toBeGreaterThan(0);
  });

  it('nessun nodo senza evento: il grafo iniziale ha solo Director e VISIONE, nessun arco', () => {
    const g = createGraph();
    expect([...g.nodes.keys()].sort()).toEqual(['director', 'visione']);
    expect(g.edges.size).toBe(0);
  });
});

describe('Fase 12.5 — Command Center visivo (solo dati reali)', () => {
  it('lo stato del coordinatore deriva da istanti reali e decade in idle', () => {
    const g = createGraph();
    const t0 = 50_000;
    // Solo un evento del Director: planning.
    project(g, ev('director.plan.created', { rootTaskId: 'R', planner: 'rule', taskIds: [], fallback: null }, { source: { kind: 'director', id: 'director' }, ts: t0 }));
    expect(g.signals.directorAt).toBe(t0);
    expect(systemState(g.signals, t0 + 100)).toBe('planning');
    // Un evento di lavoro reale ha precedenza: working.
    project(g, ev('agent.status.changed', { agentId: 'a', to: 'working' }, { target: { kind: 'agent', id: 'a' }, ts: t0 }));
    expect(g.signals.workAt).toBe(t0);
    expect(systemState(g.signals, t0 + 100)).toBe('working');
    // Senza nuovi eventi, tutto decade in idle.
    expect(systemState(g.signals, t0 + SIGNAL_WINDOW_MS + 1)).toBe('idle');
    // Un esito non riuscito ha la precedenza su tutto: error.
    project(g, ev('task.status.changed', { taskId: 'T', rootId: 'R', kind: 'work', from: 'running', to: 'failed', reason: 'x', attempt: 1, error: null }, { target: { kind: 'task', id: 'T' }, ts: t0 }));
    expect(g.signals.errorAt).toBe(t0);
    expect(systemState(g.signals, t0 + 100)).toBe('error');
  });

  it('gli archi portano il numero reale di eventi e il motore espone i segnali al rendering', () => {
    const src = { kind: 'director', id: 'director' } as const;
    const dst = { kind: 'agent', id: 'a' } as const;
    const g = createGraph();
    project(g, ev('task.assigned', { taskId: 'T', agentId: 'a' }, { source: src, target: dst }));
    project(g, ev('task.assigned', { taskId: 'T2', agentId: 'a' }, { source: src, target: dst }));
    expect(g.edges.get('director>agent:a')?.count).toBe(2);

    const { engine, messages } = createEngine();
    engine.handle({ type: 'live', events: [ev('director.decision', { rootTaskId: 'R', taskId: 'T', decision: 'assign', agentId: 'a', reason: 'x', candidates: [] }, { source: src, target: dst })] });
    const graph = messages.filter((m) => m.type === 'graph').at(-1);
    expect(graph).toBeDefined();
    expect((graph as { signals: SystemSignals }).signals.directorAt).toBeGreaterThan(0);
  });
});

describe('motore della scena (worker)', () => {
  it('caricamento silenzioso: grafo senza impulsi; poi un impulso per evento di dominio live; output dei processi ignorato', async () => {
    const { engine, messages, pulses } = createEngine();
    engine.handle({ type: 'load', events: [ev('agent.definition.created', { agentId: 'a', name: 'A' }, { target: { kind: 'agent', id: 'a' } })] });
    expect(pulses()).toHaveLength(0);
    expect(messages.filter((m) => m.type === 'graph').at(-1)).toMatchObject({ type: 'graph', counts: { domain: 1 } });
    engine.handle({ type: 'live', events: [
      ev('agent.status.changed', { agentId: 'a', to: 'working' }, { target: { kind: 'agent', id: 'a' } }),
      ev('process.stdout', { processId: 'P', seq: 1, text: 'x', stream: 'pty' }, { target: { kind: 'process', id: 'P' } }),
      ev('task.created', { taskId: 'T', title: 't' }, { target: { kind: 'task', id: 'T' } })
    ] });
    expect(pulses().map((p) => p.type)).toEqual(['agent.status.changed', 'task.created']);
    expect(pulses().every((p) => p.fromPos.length === 3 && p.toPos.length === 3)).toBe(true);
    // Solo output: niente grafo nuovo, niente impulsi.
    const count = messages.length;
    engine.handle({ type: 'live', events: [ev('process.stdout', { processId: 'P', seq: 2, text: 'y', stream: 'pty' })] });
    expect(messages.length).toBe(count);
  });

  it('replay dal journal: grafo azzerato, un impulso per evento in ordine di seq, avanzamento e fine; il live non tocca la scena', async () => {
    const { engine, messages, pulses } = createEngine();
    const events = Array.from({ length: 6 }, (_, i) => ev('agent.status.changed', { agentId: `a${i % 2}`, to: 'idle' }, { target: { kind: 'agent', id: `a${i % 2}` } }));
    engine.handle({ type: 'replay', events: [...events].reverse(), speed: 1_000 });
    engine.handle({ type: 'live', events: [ev('task.created', { taskId: 'X', title: 'x' }, { target: { kind: 'task', id: 'X' } })] });
    await new Promise((r) => setTimeout(r, 100));
    expect(pulses().map((p) => p.eventId)).toEqual(events.map((e) => e.id));
    const progress = messages.filter((m) => m.type === 'replay');
    expect(progress.at(-1)).toMatchObject({ state: 'done', done: 6, total: 6, seq: events.at(-1)?.seq });
    engine.handle({ type: 'stop-replay' });
    expect(messages.filter((m) => m.type === 'replay' && m.state === 'stopped')).toHaveLength(0); // già finito
  });
});

describe('P-102 — i nodi di lavoro concluso escono dalla scena dopo 30 s', () => {
  it('task, processo e strumento conclusi restano 30 s e poi escono; lavoro vivo, agenti e Director restano', () => {
    const g = createGraph();
    project(g, ev('task.status.changed', { taskId: 'T1', from: 'running', to: 'succeeded' }, { target: { kind: 'task', id: 'T1' }, ts: 10_000 }));
    project(g, ev('task.status.changed', { taskId: 'T2', from: 'queued', to: 'running' }, { target: { kind: 'task', id: 'T2' }, ts: 10_000 }));
    project(g, ev('tool.call.finished', { agentId: 'a', tool: 'Bash', ok: true }, { ts: 10_000 }));
    project(g, ev('tool.call.started', { agentId: 'a', tool: 'Read' }, { ts: 10_000 }));
    project(g, ev('process.exited', { processId: 'P1', status: 'exited', owner: { agentId: 'a' } }, { target: { kind: 'process', id: 'P1' }, ts: 10_000 }));
    expect(g.nodes.get('task:T1')?.status).toBe('succeeded');
    expect(g.nodes.get('tool:a:Bash')?.status).toBe('ok');
    expect(g.nodes.get('process:P1')?.status).toBe('exited');
    // Ancora dentro i 30 s: nulla esce.
    expect(expireEnded(g, 10_000 + ENDED_LINGER_MS - 1)).toEqual([]);
    expect(expireEnded(g, 10_000 + ENDED_LINGER_MS).sort()).toEqual(['process:P1', 'task:T1', 'tool:a:Bash']);
    for (const id of ['task:T2', 'tool:a:Read', 'agent:a', 'director', 'visione']) expect(g.nodes.has(id), id).toBe(true);
    // Un evento nuovo riporta in vita il conteggio da quell'istante (il nodo concluso riparte da 30 s).
    project(g, ev('task.status.changed', { taskId: 'T2', from: 'running', to: 'failed' }, { target: { kind: 'task', id: 'T2' }, ts: 50_000 }));
    expect(expireEnded(g, 50_000 + ENDED_LINGER_MS - 1)).toEqual([]);
    expect(expireEnded(g, 50_000 + ENDED_LINGER_MS)).toContain('task:T2');
  });

  it('motore dal vivo: il nodo concluso esce da solo dopo 30 s anche senza nuovi eventi', async () => {
    let clock = 100_000;
    const { engine, messages } = createEngine({ now: () => clock, expiryMaxWaitMs: 5 });
    const graphNodes = (): string[] => {
      const last = messages.filter((m) => m.type === 'graph').at(-1);
      return last?.type === 'graph' ? last.nodes.map((x) => x.id) : [];
    };
    engine.handle({ type: 'live', events: [ev('task.status.changed', { taskId: 'T9', from: 'running', to: 'succeeded' }, { target: { kind: 'task', id: 'T9' }, ts: 100_000 })] });
    expect(graphNodes()).toContain('task:T9');
    await new Promise((r) => setTimeout(r, 30));
    expect(graphNodes()).toContain('task:T9');
    clock = 100_000 + ENDED_LINGER_MS;
    await new Promise((r) => setTimeout(r, 40));
    expect(graphNodes()).not.toContain('task:T9');
  });

  it('caricamento dal journal: il lavoro concluso da tempo non torna in scena', () => {
    const { engine, messages } = createEngine({ now: () => 1_000_000 });
    engine.handle({ type: 'load', events: [
      ev('task.status.changed', { taskId: 'V', from: 'running', to: 'succeeded' }, { target: { kind: 'task', id: 'V' }, ts: 1_000 }),
      ev('task.status.changed', { taskId: 'W', from: 'queued', to: 'running' }, { target: { kind: 'task', id: 'W' }, ts: 1_000 })
    ] });
    const last = messages.filter((m) => m.type === 'graph').at(-1);
    const ids = last?.type === 'graph' ? last.nodes.map((x) => x.id) : [];
    expect(ids).not.toContain('task:V');
    expect(ids).toContain('task:W');
  });
});

describe('Fase 13 — Event-Driven Neural Launch (Event Bus → Neural 3D)', () => {
  const DIR = { kind: 'director', id: 'director' } as const;
  const AG = (id: string) => ({ kind: 'agent', id } as const);
  const TK = (id: string) => ({ kind: 'task', id } as const);
  const T0 = 50_000;

  it('Test 1: `task.assigned` (Director→Agent) produce l’impulso sul collegamento reale', () => {
    const g = createGraph();
    project(g, ev('agent.definition.created', { agentId: 'alfa', name: 'Alfa' }, { target: AG('alfa') }));
    const d = project(g, ev('task.assigned', { taskId: 'T1', rootId: 'R', agentId: 'alfa', previousAgentId: null, reason: 'router' }, { source: DIR, target: AG('alfa') }));
    expect(d?.pulse).toMatchObject({ from: 'director', to: 'agent:alfa' });
    expect(d?.effect?.edge).toBe('director>agent:alfa');
    expect(g.edges.get('director>agent:alfa')?.count).toBe(1);
  });

  it('Test 2: un risultato reale (`task.result.recorded`) torna Agent→Director', () => {
    const g = createGraph();
    project(g, ev('agent.definition.created', { agentId: 'alfa', name: 'Alfa' }, { target: AG('alfa') }));
    project(g, ev('task.created', { taskId: 'T1', kind: 'work', parentId: null, rootId: 'T1', title: 'x', assigneeAgentId: 'alfa', dependsOn: [], priority: 1, createdBy: 'director' }, { target: TK('T1') }));
    const d = project(g, ev('task.result.recorded', { taskId: 'T1', rootId: 'T1', outcome: 'success', summary: 'fatto', chars: 5, producedBy: 'alfa' }, { source: AG('alfa'), target: TK('T1') }));
    expect(d?.pulse).toMatchObject({ from: 'agent:alfa', to: 'director' });
    expect(d?.edge?.key).toBe('agent:alfa>director');
    // Il nodo del task non viene inventato né dimenticato: registra comunque l'evento reale.
    expect(g.nodes.get('task:T1')?.lastEventId).toBe(d?.effect?.eventId);
  });

  it('Test 2b: il messaggio reale di un agente al Director produce Agent→Director', () => {
    const g = createGraph();
    project(g, ev('agent.definition.created', { agentId: 'beta', name: 'Beta' }, { target: AG('beta') }));
    const d = project(g, ev('agent.message.sent', { messageId: 'M1', conversationId: 'cv', from: 'beta', to: 'director', act: 'inform', subject: 's', hops: 0, taskId: null }, { source: AG('beta'), target: DIR }));
    expect(d?.pulse).toMatchObject({ from: 'agent:beta', to: 'director' });
  });

  it('Test 2c: la sintesi del Director (`director.summary`) produce Director→JARVIS (VISIONE)', () => {
    const g = createGraph();
    const d = project(g, ev('director.summary', { rootTaskId: 'R', outcome: 'succeeded', counts: { total: 1, succeeded: 1, failed: 0, cancelled: 0, timedOut: 0, blocked: 0 }, text: 'ok' }, { source: DIR, target: { kind: 'user', id: 'owner' } }));
    expect(d?.pulse).toMatchObject({ from: 'director', to: 'visione' });
    expect(d?.edge?.key).toBe('director>visione');
  });

  it('Test 3: senza eventi la rete è idle (nessun nodo, arco o impulso oltre Director/VISIONE)', () => {
    const g = createGraph();
    expect([...g.nodes.keys()].sort()).toEqual(['director', 'visione']);
    expect(g.edges.size).toBe(0);
    const { engine, messages, pulses } = createEngine();
    engine.handle({ type: 'live', events: [] });
    expect(pulses()).toHaveLength(0);
    expect(messages.filter((m) => m.type === 'pulses')).toHaveLength(0);
  });

  it('Test 4: più assegnazioni reali producono ognuna il proprio impulso sul collegamento corretto', () => {
    const g = createGraph();
    const a = project(g, ev('task.assigned', { taskId: 'T1', rootId: 'R', agentId: 'alfa', previousAgentId: null, reason: 'router' }, { source: DIR, target: AG('alfa') }));
    const b = project(g, ev('task.assigned', { taskId: 'T2', rootId: 'R', agentId: 'beta', previousAgentId: null, reason: 'router' }, { source: DIR, target: AG('beta') }));
    expect(a?.pulse).toMatchObject({ from: 'director', to: 'agent:alfa' });
    expect(b?.pulse).toMatchObject({ from: 'director', to: 'agent:beta' });
    expect([...g.edges.keys()].sort()).toEqual(['director>agent:alfa', 'director>agent:beta']);
  });

  it('Test 5: errore e retry sono rappresentati solo quando accadono davvero', () => {
    const g = createGraph();
    // Solo lavoro reale: nessun allarme.
    project(g, ev('agent.status.changed', { instanceId: 'i', agentId: 'a', from: null, to: 'working', reason: 'x' }, { target: AG('a'), ts: T0 }));
    expect(systemState(g.signals, T0 + 100)).toBe('working');
    // Un retry reale (decisione del Director) → impulso Director→nuovo agente.
    const retry = project(g, ev('director.decision', { rootTaskId: 'R', taskId: 'T', decision: 'retry', agentId: 'b', reason: 'errore', candidates: [] }, { source: DIR, target: AG('b'), ts: T0 }));
    expect(retry?.pulse).toMatchObject({ from: 'director', to: 'agent:b' });
    // Un guasto reale: solo ora lo stato del coordinatore è `error`.
    project(g, ev('task.status.changed', { taskId: 'T', rootId: 'R', kind: 'work', from: 'running', to: 'failed', reason: 'x', attempt: 1, error: null }, { target: TK('T'), ts: T0 }));
    expect(g.signals.errorAt).toBe(T0);
    expect(systemState(g.signals, T0 + 100)).toBe('error');
  });

  it('Test 6: un’attività non reale NON produce alcun impulso', () => {
    for (const type of ['system.pong', 'system.lifecycle.changed', 'telemetry.sample', 'process.stdout', 'ui.command.issued', 'command.accepted']) {
      const g = createGraph();
      const e = ev(type, {});
      expect(project(g, e), type).toBeNull();
    }
    const { engine, pulses } = createEngine();
    engine.handle({ type: 'live', events: [ev('system.pong', { at: 1 }), ev('process.stdout', { processId: 'P', seq: 1, text: 'x', stream: 'pty' })] });
    expect(pulses()).toHaveLength(0);
  });

  it('Test 7 (P-88): lo snapshot della rubrica reale crea i nodi degli agenti — nessun impulso, archiviati fuori', () => {
    const { engine, messages, pulses } = createEngine();
    engine.handle({
      type: 'snapshot',
      agents: [
        { id: 'esecutore', name: 'Esecutore', status: 'idle', archived: false },
        { id: 'ripiego', name: 'Ripiego', status: 'working', archived: false }
      ]
    });
    expect(pulses()).toHaveLength(0);
    const last = () => messages.filter((m) => m.type === 'graph').at(-1) as unknown as { nodes: Array<{ id: string; label: string; status: string; kind: string }> };
    let nodes = last().nodes;
    expect(nodes.map((x) => x.id).sort()).toEqual(['agent:esecutore', 'agent:ripiego', 'director', 'visione']);
    expect(nodes.find((x) => x.id === 'agent:ripiego')).toMatchObject({ status: 'working', label: 'Ripiego', kind: 'agent' });
    // Un agente archiviato non è vivo: il suo nodo esce (stessa regola dell'evento `archive`).
    engine.handle({
      type: 'snapshot',
      agents: [
        { id: 'esecutore', name: 'Esecutore', status: 'idle', archived: true },
        { id: 'ripiego', name: 'Ripiego', status: 'idle', archived: false }
      ]
    });
    nodes = last().nodes;
    expect(nodes.map((x) => x.id).sort()).toEqual(['agent:ripiego', 'director', 'visione']);
    expect(nodes.find((x) => x.id === 'agent:ripiego')?.status).toBe('idle');
  });

  it('P-90: gli impulsi nascono SOLO da eventi reali, mai dal movimento ambientale', async () => {
    const { engine, messages, pulses } = createEngine();
    // Caricamento dal journal e rubrica reale: nodi sì, impulsi no (la scena si popola in silenzio).
    engine.handle({ type: 'load', events: [ev('agent.definition.created', { agentId: 'a', name: 'A' }, { target: AG('a') })] });
    engine.handle({ type: 'snapshot', agents: [{ id: 'b', name: 'B', status: 'working', archived: false }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(pulses()).toHaveLength(0);
    // Lotto misto: solo i due eventi di dominio reali producono il proprio impulso; l'output di un
    // processo (movimento di dati, non di lavoro) non ne produce alcuno.
    const reali = [
      ev('task.assigned', { taskId: 'T', rootId: 'R', agentId: 'a', previousAgentId: null, reason: 'router' }, { source: DIR, target: AG('a') }),
      ev('process.stdout', { processId: 'P', seq: 1, text: 'x', stream: 'pty' }, { target: { kind: 'process', id: 'P' } }),
      ev('task.result.recorded', { taskId: 'T', rootId: 'R', outcome: 'success', summary: 'fatto', chars: 5, producedBy: 'a' }, { source: AG('a'), target: TK('T') })
    ];
    engine.handle({ type: 'live', events: reali });
    expect(pulses().map((p) => p.eventId)).toEqual([reali[0]?.id, reali[2]?.id]);
    // Ogni impulso porta l'id dell'evento che lo ha causato: nessun impulso decorativo senza causa.
    const tutti = messages.filter((m) => m.type === 'pulses').flatMap((m) => m.pulses);
    expect(tutti.every((p) => p.eventId.length > 0 && p.type.length > 0)).toBe(true);
    expect(tutti.map((p) => p.from).sort()).toEqual(['agent:a', 'director'].sort());
  });
});
