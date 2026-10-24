// Fase 16 — END-TO-END: catena completa
// OWNER → JARVIS → DIRECTOR → Event Bus → Task → Agent → Result → Event Bus → DIRECTOR → JARVIS → OWNER.
// Runtime REALE (processi figli) + adapter reali con CLI FINte (nessun motore, nessuna rete, nessun
// account): i provider sono mock dichiarati. Verifica correlation/task/agent ID, eventi, stato, tempi,
// memoria (fatto ripreso dal passo successivo) e persistenza al riavvio (nessuna perdita/duplicazione).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startCore, type CoreHandle, type CoreTransport } from '../../src/core/kernel/index.ts';
import {
  FRAME_VERSION,
  type CommandResponse,
  type CoreToMainFrameBody,
  type VisioneEvent,
  type Task
} from '../../src/shared/contracts/index.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { resolvePaths, type VisionePaths } from '../../src/shared/node/paths.ts';
import { fakeCliEnv, writeShim } from '../adapter-harness.ts';
import { tempHome } from '../helpers.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const MODEL = 'nvidia/nvidia/nemotron-3-super-120b-a12b';

class Transport implements CoreTransport {
  frames: CoreToMainFrameBody[] = [];
  private handler: ((raw: unknown) => void) | null = null;
  send(frame: CoreToMainFrameBody): void { this.frames.push(frame); }
  onFrame(h: (raw: unknown) => void): void { this.handler = h; }
  onDisconnect(): void { /* non usato */ }
  events(): VisioneEvent[] {
    return this.frames.flatMap((f) => (f.kind === 'evt' ? [f.event] : []));
  }
  private responses(id: string): CommandResponse[] {
    return this.frames.flatMap((f) => (f.kind === 'res' && f.response.id === id ? [f.response] : []));
  }
  async command<T = unknown>(type: string, payload: unknown = {}, opts: { id?: string; issuedBy?: 'ui' | 'system' } = {}): Promise<CommandResponse<T>> {
    const id = opts.id ?? ulid();
    const before = this.responses(id).length;
    this.handler?.({ v: FRAME_VERSION, kind: 'cmd', command: { id, type, ts: Date.now(), correlationId: id, issuedBy: opts.issuedBy ?? 'ui', payload } });
    for (let i = 0; i < 6_000 && this.responses(id).length === before; i++) await sleep(10);
    const res = this.responses(id)[before];
    if (!res) throw new Error(`nessuna risposta a ${type}`);
    return res as CommandResponse<T>;
  }
  async waitEvent(pred: (e: VisioneEvent) => boolean, ms = 60_000): Promise<VisioneEvent> {
    for (let waited = 0; waited < ms; waited += 20) {
      const found = this.events().find(pred);
      if (found) return found;
      await sleep(20);
    }
    throw new Error('evento atteso non arrivato');
  }
}

const cleanups: Array<() => void> = [];
const running: CoreHandle[] = [];
afterEach(async () => {
  for (const core of running.splice(0)) if (core.lifecycle === 'running') await core.stop('test', 9_000);
  while (cleanups.length > 0) cleanups.pop()?.();
});

function boot(paths: VisionePaths, env: Record<string, string | undefined>): { core: CoreHandle; transport: Transport } {
  const transport = new Transport();
  const core = startCore({ transport, paths, env, pid: 4646, coreVersion: '0.9.0-e2e', exit: () => undefined, logSinks: [], seedDefaultAgents: false, telemetry: { enabled: false }, offline: { enabled: false } });
  running.push(core);
  return { core, transport };
}

const agent = (id: string, adapter: string, competences: string[] = ['code']) => ({
  id, name: id, role: `agente ${id}`, competences, engine: { adapter, ...(adapter === 'opencode' ? { model: MODEL } : {}) },
  persona: { instructions: 'Rispondi in italiano.', language: 'it' }, workspace: { root: id, isolation: 'shared' }, permissions: 'read-only',
  limits: { maxTurnMinutes: 5, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }
});

describe('Fase 16 — End-to-end della catena completa', () => {
  it('OWNER→JARVIS→DIRECTOR→Bus→Task→Agent(fan-out, memoria)→Result→Bus→DIRECTOR→JARVIS→OWNER, persistente al riavvio', async () => {
    const h = tempHome('visione-fase16-');
    cleanups.push(h.cleanup);
    const bin = join(h.dir, 'fake-bin');
    writeShim(bin, 'opencode', 'test/fixtures/fake-opencode.mjs');
    writeShim(bin, 'claude', 'test/fixtures/fake-claude.mjs');
    const env = fakeCliEnv(bin, { NVIDIA_API_KEY: 'valore-di-prova' });
    const paths = resolvePaths(join(h.dir, 'home'));
    let { core, transport: t } = boot(paths, env);

    // OWNER definisce gli agenti (JARVIS li registra nel core).
    expect(await t.command('agents.define', { definition: agent('prod1', 'opencode') })).toMatchObject({ ok: true });
    expect(await t.command('agents.define', { definition: agent('prod2', 'opencode') })).toMatchObject({ ok: true });
    expect(await t.command('agents.define', { definition: agent('coord', 'claude-code', ['review']) })).toMatchObject({ ok: true });

    // OWNER invia la richiesta: fan-out a due agenti + coordinamento dipendente, con un fatto di memoria.
    const submitId = ulid();
    const submit = await t.command<{ rootTaskId: string; taskIds: string[]; correlationId: string }>('director.submit', {
      goal: 'Produci in due e coordina',
      title: 'Produci in due e coordina',
      plan: { steps: [
        { key: 'produci', title: 'Produci', spec: 'MEMORIA-FINTA valore16 RISPOSTA:prodotto', agents: ['prod1', 'prod2'] },
        { key: 'coordina', title: 'Coordina', spec: 'Coordina.\nRISPOSTA:finale', competence: 'review', dependsOn: ['produci'] }
      ] }
    }, { id: submitId });
    expect(submit).toMatchObject({ ok: true, data: { correlationId: submitId } });
    const { rootTaskId, taskIds } = (submit as { data: { rootTaskId: string; taskIds: string[] } }).data;
    expect(taskIds).toHaveLength(3); // due task del fan-out + il coordinamento

    // DIRECTOR analizza, pianifica, assegna; gli agenti eseguono; il risultato rientra; DIRECTOR/JARVIS sintetizzano.
    const summary = await t.waitEvent((e) => e.type === 'director.summary' && (e.payload as { rootTaskId: string }).rootTaskId === rootTaskId, 120_000);
    expect(summary.payload).toMatchObject({ outcome: 'succeeded', counts: { total: 3, succeeded: 3 } });

    // Un solo filo di causalità: ogni evento della catena porta il correlationId del comando OWNER.
    const page = await t.command<{ events: VisioneEvent[] }>('events.list', { correlationId: submitId, limit: 500 });
    const chain = (page as { data: { events: VisioneEvent[] } }).data.events;
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.every((e) => e.correlationId === submitId)).toBe(true);
    const types = chain.map((e) => e.type);
    for (const ty of ['director.goal.received', 'director.plan.created', 'task.created', 'director.decision', 'task.assigned', 'agent.turn.started', 'agent.turn.finished', 'task.result.recorded', 'director.summary']) {
      expect(types, ty).toContain(ty);
    }
    // Ordine coerente con l'implementazione reale: i task nascono con il goal, poi la decisione del
    // Director; i turni precedono i risultati, i risultati precedono la sintesi.
    const at = (ty: string): number => types.indexOf(ty);
    expect(at('task.created')).toBeLessThan(at('director.goal.received'));
    expect(at('director.goal.received')).toBeLessThan(at('director.plan.created'));
    expect(at('task.created')).toBeLessThan(at('agent.turn.started'));
    expect(at('agent.turn.started')).toBeLessThan(at('task.result.recorded'));
    expect(at('task.result.recorded')).toBeLessThan(at('director.summary'));
    const goal = chain.find((e) => e.type === 'director.goal.received');
    expect(summary.ts).toBeGreaterThanOrEqual(goal?.ts ?? 0); // tempi monotoni, non inventati

    // Task, agenti, risultati: identità corrette, nessun fantasma.
    const got = await t.command<{ task: Task; children: Task[] }>('tasks.get', { taskId: rootTaskId });
    const children = (got as { data: { children: Task[] } }).data.children;
    expect(children.map((c) => `${c.title}:${c.status}`)).toEqual(['Produci [prod1]:succeeded', 'Produci [prod2]:succeeded', 'Coordina:succeeded']);
    const producers = children.filter((c) => c.title.startsWith('Produci'));
    expect(new Set(producers.map((c) => c.assigneeAgentId))).toEqual(new Set(['prod1', 'prod2']));
    // Il testo reale del turno (il fatto di memoria è estratto dall'adapter, il resto è il risultato).
    expect(producers.every((c) => (c.result?.summary ?? '').includes('Fatto'))).toBe(true);
    expect(children.find((c) => c.title === 'Coordina')?.result?.summary).toBe('finale');
    for (const c of children) {
      expect(c.rootId).toBe(rootTaskId);
      expect(c.startedAt).not.toBeNull();
      expect((c.endedAt as number) >= (c.startedAt as number)).toBe(true);
    }
    // Nessun turno d'agente ancora vivo (le sessioni PTY persistenti di Claude Code possono restare).
    expect(core.runtime.list({ live: true }).filter((p) => p.kind === 'agent-turn')).toEqual([]);
    expect(core.state.snapshot()).toMatchObject({ tasks: { active: 0, byStatus: { succeeded: 4, running: 0, queued: 0 } }, director: { activeGoals: 0 } });

    // MEMORY: il fatto scritto durante il fan-out è nel brief del coordinatore (Context Builder).
    const built = t.events().filter((e) => e.type === 'memory.context.built').map((e) => e.payload as { agentId: string; taskId: string; file: string });
    const coordBuild = built.find((b) => b.agentId === 'coord');
    expect(coordBuild).toBeDefined();
    const brief = readFileSync((coordBuild as { file: string }).file, 'utf8');
    expect(brief).toContain('valore16');
    const found = await t.command<{ items: Array<{ scope: string; content: string }> }>('memory.search', { query: 'valore concordato' });
    expect((found as { data: { items: Array<{ content: string }> } }).data.items.map((i) => i.content)).toEqual(expect.arrayContaining([expect.stringContaining('valore16')]));

    // RESTART pulito sulla stessa home: stato persistente, nessuna perdita, nessuna duplicazione.
    await core.stop('fine scenario', 9_000);
    expect(core.runtime.list({ live: true })).toEqual([]); // nessun orfano dopo lo spegnimento
    ({ core, transport: t } = boot(paths, env));
    const after = await t.command<{ children: Task[] }>('tasks.get', { taskId: rootTaskId });
    const afterChildren = (after as { data: { children: Task[] } }).data.children;
    expect(afterChildren.map((c) => `${c.title}:${c.status}:${c.correlationId}`)).toEqual([
      `Produci [prod1]:succeeded:${submitId}`, `Produci [prod2]:succeeded:${submitId}`, `Coordina:succeeded:${submitId}`
    ]);
    const list = await t.command<{ tasks: Task[] }>('tasks.list', { rootId: rootTaskId, limit: 50 });
    expect((list as { data: { tasks: Task[] } }).data.tasks).toHaveLength(4); // goal + 3, nessuno in più
    expect(t.events().filter((e) => e.type === 'task.created')).toEqual([]); // nessuna ricreazione al riavvio
    expect(core.state.snapshot()).toMatchObject({ core: { status: 'ready', recovered: false }, tasks: { active: 0 } });
  }, 240_000);
});
