// Fase 6 nel core completo: comandi della UI → Director → Task Engine → Agent Manager → adapter
// REALI (OpenCode e Claude Code) → CLI Runtime → processi reali delle CLI finte (shim npm in testa
// al PATH). Nessun motore reale, nessuna rete, nessun account. DoD: un obiettivo scomposto,
// assegnato a due agenti di motori diversi, i risultati tornano; la fiducia della cartella passa
// dalla coda delle approvazioni; idempotenza dei comandi; stato, eventi e journal coerenti.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/core/db/index.ts';
import { startCore, type CoreHandle, type CoreTransport } from '../../src/core/kernel/index.ts';
import {
  FRAME_VERSION,
  type Approval,
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
    for (let i = 0; i < 3_000 && this.responses(id).length === before; i++) await sleep(10);
    const res = this.responses(id)[before];
    if (!res) throw new Error(`nessuna risposta a ${type}`);
    return res as CommandResponse<T>;
  }
  async waitEvent(pred: (e: VisioneEvent) => boolean, ms = 30_000): Promise<VisioneEvent> {
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

function setup(extraEnv: Record<string, string> = {}): { paths: VisionePaths; env: Record<string, string | undefined> } {
  const h = tempHome('visione-orch-');
  cleanups.push(h.cleanup);
  const bin = join(h.dir, 'fake-bin');
  writeShim(bin, 'opencode', 'test/fixtures/fake-opencode.mjs');
  writeShim(bin, 'claude', 'test/fixtures/fake-claude.mjs');
  // Chiave fittizia: il finto controlla solo che la variabile esista (la config usa un riferimento).
  return { paths: resolvePaths(join(h.dir, 'home')), env: fakeCliEnv(bin, { NVIDIA_API_KEY: 'valore-di-prova', ...extraEnv }) };
}

function boot(paths: VisionePaths, env: Record<string, string | undefined>) {
  const transport = new Transport();
  const core = startCore({ transport, paths, env, pid: 4343, coreVersion: '0.6.0-test', exit: () => undefined, logSinks: [], seedDefaultAgents: false, telemetry: { enabled: false }, offline: { enabled: false } });
  running.push(core);
  return { core, transport };
}

const agent = (id: string, adapter: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, role: `agente ${id}`, competences: ['code'], engine: { adapter, ...(adapter === 'opencode' ? { model: MODEL } : {}) },
  persona: { instructions: 'Rispondi in italiano.', language: 'it' }, workspace: { root: id, isolation: 'shared' }, permissions: 'read-only',
  limits: { maxTurnMinutes: 5, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }, ...extra
});

async function waitTask(t: Transport, rootTaskId: string): Promise<VisioneEvent> {
  return t.waitEvent((e) => e.type === 'director.summary' && (e.payload as { rootTaskId: string }).rootTaskId === rootTaskId, 60_000);
}

describe('orchestrazione nel core con adapter reali e CLI finte', () => {
  it('DoD: obiettivo → due task su motori diversi (OpenCode → Claude Code), processi reali, risultati, stato e journal', async () => {
    const { paths, env } = setup();
    const { core, transport: t } = boot(paths, env);
    expect(await t.command('agents.define', { definition: agent('esecutore', 'opencode') })).toMatchObject({ ok: true, data: { agentId: 'esecutore', version: 1, created: true } });
    expect(await t.command('agents.define', { definition: agent('revisore', 'claude-code', { competences: ['review'] }) })).toMatchObject({ ok: true });
    expect(await t.command('agents.define', { definition: agent('rotto', 'opencode', { engine: { adapter: 'opencode', model: 'senzaprovider' } }) })).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });

    const submitId = ulid();
    const submit = await t.command<{ rootTaskId: string; taskIds: string[]; correlationId: string }>('director.submit', {
      goal: 'Produci e rivedi',
      title: 'Produci e rivedi',
      plan: { steps: [
        { key: 'produci', title: 'Produci', spec: 'Rispondi OK', agentId: 'esecutore' },
        { key: 'rivedi', title: 'Rivedi', spec: 'Rivedi il lavoro.\nRISPOSTA:revisione completata.', competence: 'review', dependsOn: ['produci'] }
      ] }
    }, { id: submitId });
    expect(submit).toMatchObject({ ok: true, data: { correlationId: submitId } });
    const { rootTaskId, taskIds } = (submit as { data: { rootTaskId: string; taskIds: string[] } }).data;
    // Comando duplicato (stesso id): nessun secondo obiettivo, risposta conservata.
    expect(await t.command('director.submit', { goal: 'Produci e rivedi' }, { id: submitId })).toMatchObject({ ok: true, replayed: true, data: { rootTaskId } });

    const summary = await waitTask(t, rootTaskId);
    expect(summary.payload).toMatchObject({ outcome: 'succeeded', counts: { total: 2, succeeded: 2 } });
    const got = await t.command<{ task: Task; children: Task[] }>('tasks.get', { taskId: rootTaskId });
    expect(got.ok).toBe(true);
    const children = (got as { data: { children: Task[] } }).data.children;
    expect(children.map((c) => `${c.title}:${c.status}:${c.assigneeAgentId}`)).toEqual(['Produci:succeeded:esecutore', 'Rivedi:succeeded:revisore']);
    expect(children[0]?.result?.summary).toBe('OK'); // testo reale della registrazione di OpenCode
    expect(children[1]?.result?.summary).toBe('revisione completata'); // dall'hook Stop del finto Claude Code
    expect(children.map((c) => c.id)).toEqual(taskIds);
    // Processi reali creati dal runtime per i task (OpenCode: turno; Claude Code: sessione PTY).
    const created = t.events().filter((e) => e.type === 'process.created').map((e) => e.payload as { kind: string; owner: { agentId: string | null; taskId: string | null } });
    expect(created).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'agent-turn', owner: expect.objectContaining({ agentId: 'esecutore', taskId: taskIds[0] }) }),
      expect.objectContaining({ kind: 'agent-session', owner: expect.objectContaining({ agentId: 'revisore' }) })
    ]));
    expect(children[0]?.processIds.length).toBeGreaterThan(0);
    expect(children[1]?.processIds.length).toBeGreaterThan(0);
    // Un solo filo dal comando alla sintesi, persistente nel journal.
    const page = await t.command<{ events: VisioneEvent[] }>('events.list', { correlationId: submitId, limit: 500 });
    const types = (page as { data: { events: VisioneEvent[] } }).data.events.map((e) => e.type);
    for (const type of ['task.created', 'director.goal.received', 'director.decision', 'task.assigned', 'agent.turn.started', 'agent.turn.finished', 'task.result.recorded', 'director.summary']) {
      expect(types, type).toContain(type);
    }
    // Stato del core coerente con gli eventi.
    await sleep(50);
    expect(core.state.snapshot()).toMatchObject({
      agents: { defined: 2 }, director: { activeGoals: 0 }, approvals: { pending: 0 },
      tasks: { active: 0, byStatus: { succeeded: 3, running: 0, queued: 0 } }
    });
    const agents = await t.command<{ agents: Array<{ definition: { id: string }; instance: { status: string } | null }> }>('agents.list', {});
    expect((agents as { data: { agents: Array<{ definition: { id: string }; instance: { status: string } | null }> } }).data.agents.map((a) => `${a.definition.id}:${a.instance?.status}`))
      .toEqual(['esecutore:idle', 'revisore:idle']);
    // Lo spegnimento ferma la sessione viva di Claude Code (nessun orfano).
    await core.stop('test', 9_000);
    expect(core.runtime.list({ live: true })).toEqual([]);
  }, 120_000);

  it('memoria (Fase 7): fatto dichiarato da OpenCode ritrovato da Claude Code nel brief, con processi reali; comandi memory.*', async () => {
    const { paths, env } = setup();
    const { transport: t } = boot(paths, env);
    expect(await t.command('agents.define', { definition: agent('esecutore', 'opencode') })).toMatchObject({ ok: true });
    expect(await t.command('agents.define', { definition: agent('revisore', 'claude-code', { competences: ['review'] }) })).toMatchObject({ ok: true });
    expect(await t.command('memory.write', { scope: 'global', content: 'Le risposte vanno date in italiano', title: 'Lingua', kind: 'preference', pinned: true }))
      .toMatchObject({ ok: true, data: { created: true, item: { scope: 'global', source: 'owner:ui', origin: 'command', pinned: true } } });
    expect(await t.command('memory.write', { scope: 'global', scopeId: 'x', content: 'y' })).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
    expect(await t.command('memory.write', { scope: 'agent', scopeId: 'nessuno', content: 'y' })).toMatchObject({ ok: false, error: { code: 'not_found' } });

    const submit = await t.command<{ rootTaskId: string; taskIds: string[] }>('director.submit', {
      goal: 'Concorda e controlla',
      plan: { steps: [
        { key: 'concorda', title: 'Concorda', spec: 'MEMORIA-FINTA porta4321', agentId: 'esecutore' },
        { key: 'controlla', title: 'Controlla', spec: 'Controlla il valore concordato.\nRISPOSTA:visto.', competence: 'review', dependsOn: ['concorda'] }
      ] }
    });
    const { rootTaskId, taskIds } = (submit as { data: { rootTaskId: string; taskIds: string[] } }).data;
    expect((await waitTask(t, rootTaskId)).payload).toMatchObject({ outcome: 'succeeded' });
    // Il fatto arriva dal testo reale dell'uscita di OpenCode (processo), il brief di Claude Code lo contiene.
    const built = t.events().filter((e) => e.type === 'memory.context.built').map((e) => e.payload as { agentId: string; taskId: string; file: string });
    expect(built.map((b) => b.agentId)).toEqual(['esecutore', 'revisore']);
    const brief = readFileSync(built[1]?.file as string, 'utf8');
    expect(brief).toMatch(/## Memoria pertinente[^#]*il valore concordato è porta4321/);
    expect(brief).toContain('(globale · preference) Lingua: Le risposte vanno date in italiano');
    const found = await t.command<{ items: Array<{ id: string; scope: string; scopeId: string; source: string; origin: string }> }>('memory.search', { query: 'valore concordato' });
    const fact = (found as { data: { items: Array<{ id: string; scope: string; scopeId: string; source: string; origin: string }> } }).data.items[0];
    expect(fact).toMatchObject({ scope: 'task', scopeId: taskIds[0], source: 'agent:esecutore', origin: 'turn' });
    expect(await t.command('memory.promote', { itemId: fact?.id })).toMatchObject({ ok: true, data: { created: true, item: { scope: 'global', origin: 'promotion' } } });
    expect(await t.command('memory.promote', { itemId: fact?.id })).toMatchObject({ ok: true, data: { created: false } });
    expect(await t.command('memory.promote', { itemId: 'inesistente' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    // Un agente vede la copia globale anche fuori da quell'obiettivo.
    const visible = await t.command<{ items: Array<{ scope: string }> }>('memory.search', { query: 'valore concordato', agentId: 'revisore' });
    expect((visible as { data: { items: Array<{ scope: string }> } }).data.items.map((i) => i.scope)).toEqual(['global']);
    expect(await t.command('memory.reflect', { agentId: 'esecutore' })).toMatchObject({ ok: true, data: { applied: false, reason: 'memory.md assente' } });
    expect(await t.command('memory.reflect', { agentId: 'nessuno' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await t.command('memory.search', { taskId: 'inesistente' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  }, 120_000);

  it('fiducia della cartella dal motore: approvazione in coda → il proprietario approva → conferma nel PTY → turno', async () => {
    const { paths, env } = setup({ FAKE_CLAUDE_TRUST: '1' });
    const { transport: t } = boot(paths, env);
    await t.command('agents.define', { definition: agent('revisore', 'claude-code') });
    const submit = await t.command<{ rootTaskId: string; taskIds: string[] }>('director.submit', { goal: 'Controlla.\nRISPOSTA:controllato.' });
    const { rootTaskId, taskIds } = (submit as { data: { rootTaskId: string; taskIds: string[] } }).data;
    await t.waitEvent((e) => e.type === 'approval.requested');
    const workspace = join(paths.workspaceDir, 'revisore');
    // Nessuna risposta al dialogo prima della decisione del proprietario.
    expect(existsSync(join(workspace, 'fake-claude-trust-answered'))).toBe(false);
    const list = await t.command<{ approvals: Approval[] }>('approvals.list', { status: 'pending' });
    const pending = (list as { data: { approvals: Approval[] } }).data.approvals;
    expect(pending).toMatchObject([{ kind: 'engine.workspace.trust', target: workspace, agentId: 'revisore', taskId: taskIds[0] }]);
    expect((await t.command<{ task: Task }>('tasks.get', { taskId: taskIds[0] as string }) as { data: { task: Task } }).data.task).toMatchObject({ status: 'waiting', waitingOn: { kind: 'approval', ref: pending[0]?.id } });
    // Solo il proprietario (UI) decide: il sistema no.
    expect(await t.command('approvals.decide', { approvalId: pending[0]?.id, decision: 'grant' }, { issuedBy: 'system' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    const decideId = ulid();
    expect(await t.command('approvals.decide', { approvalId: pending[0]?.id, decision: 'grant', note: 'cartella mia' }, { id: decideId })).toMatchObject({ ok: true, data: { alreadyDecided: false, approval: { status: 'granted' } } });
    expect(await t.command('approvals.decide', { approvalId: pending[0]?.id, decision: 'deny' }, { id: decideId })).toMatchObject({ ok: true, replayed: true });
    const summary = await waitTask(t, rootTaskId);
    expect(summary.payload).toMatchObject({ outcome: 'succeeded' });
    const keys = readFileSync(join(workspace, 'fake-claude-trust-answered'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string);
    expect(keys).toEqual(['\x1b[B', '\r']);
    const audit = await t.command<{ entries: Array<{ action: string; decision: string }>; chain: { ok: boolean } }>('audit.list', {});
    const data = (audit as { data: { entries: Array<{ action: string; decision: string }>; chain: { ok: boolean } } }).data;
    expect(data.chain.ok).toBe(true);
    expect(data.entries.map((e) => `${e.action}:${e.decision}`)).toEqual(expect.arrayContaining(['approval.request:engine.workspace.trust:pending', 'approval.decide:engine.workspace.trust:granted']));
  }, 120_000);

  it('comandi: task e approvazioni sconosciuti → not_found; annullamento idempotente; obiettivo non valido rifiutato', async () => {
    const { paths, env } = setup();
    const { transport: t } = boot(paths, env);
    expect(await t.command('tasks.get', { taskId: 'inesistente' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await t.command('tasks.cancel', { taskId: 'inesistente' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await t.command('approvals.decide', { approvalId: 'inesistente', decision: 'grant' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await t.command('agents.stop', { agentId: 'inesistente' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await t.command('director.submit', { goal: 'x', plan: { steps: [{ key: 'a', title: 'a', spec: 'a', dependsOn: ['a'] }] } })).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
    expect(await t.command('director.submit', { goal: '' })).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
    // Senza agenti: l'obiettivo si registra e il task fallisce con no_agent (nessun processo).
    const submit = await t.command<{ rootTaskId: string }>('director.submit', { goal: 'senza agenti' });
    const rootTaskId = (submit as { data: { rootTaskId: string } }).data.rootTaskId;
    const summary = await waitTask(t, rootTaskId);
    expect(summary.payload).toMatchObject({ outcome: 'failed', counts: { failed: 1 } });
    expect(await t.command('tasks.cancel', { taskId: rootTaskId })).toMatchObject({ ok: true, data: { alreadyFinished: true, cancelled: [] } });
    expect(t.events().filter((e) => e.type === 'process.created')).toEqual([]);
  }, 60_000);

  it('recupero: core caduto con un task in corso → al riavvio istanza stopped (sessione chiusa con l\'app), task di nuovo in coda e poi completato', async () => {
    const { paths, env } = setup();
    const first = boot(paths, env);
    await first.transport.command('agents.define', { definition: agent('esecutore', 'opencode') });
    // `lento` fa restare il turno di OpenCode in corso per 30 s.
    const submit = await first.transport.command<{ rootTaskId: string; taskIds: string[] }>('director.submit', { goal: 'turno lento' });
    const { rootTaskId, taskIds } = (submit as { data: { rootTaskId: string; taskIds: string[] } }).data;
    await first.transport.waitEvent((e) => e.type === 'agent.session.started' && (e.payload as { agentId: string }).agentId === 'esecutore', 60_000);
    expect(first.core.tasks.get(taskIds[0] as string)?.status).toBe('running');
    // Caduta simulata: istantanea coerente del database presa da SQLite durante il turno (come lo
    // trova un core dopo un kill). Il primo core poi si chiude; il secondo riparte dall'istantanea.
    const crashed = resolvePaths(join(paths.home, '..', 'home-dopo-caduta'));
    mkdirSync(crashed.dataDir, { recursive: true });
    const reader = openDb(paths.dbFile);
    reader.exec(`VACUUM INTO '${crashed.dbFile.replaceAll("'", "''")}'`);
    reader.close();
    await first.core.stop('fine del primo avvio', 9_000);
    // Il nuovo core trova il task `running` e l'istanza aperta: nessuno dei due può essere vivo.
    const second = boot(crashed, env);
    await second.transport.waitEvent((e) => e.type === 'task.status.changed' && (e.payload as { taskId: string; to: string }).taskId === taskIds[0] && (e.payload as { to: string }).to === 'queued', 90_000);
    const instance = second.transport.events().find((e) => e.type === 'agent.status.changed' && (e.payload as { to: string }).to === 'stopped');
    expect(instance?.payload).toMatchObject({ agentId: 'esecutore', reason: 'sessione chiusa con l\'app precedente (processo non più controllato)' });
    // Il turno ripreso è di nuovo lento: lo si annulla dal proprietario, l'obiettivo si chiude come annullato.
    await second.transport.waitEvent((e) => e.type === 'task.status.changed' && (e.payload as { taskId: string; to: string }).taskId === taskIds[0] && (e.payload as { to: string }).to === 'running', 90_000);
    await second.transport.waitEvent((e) => e.type === 'process.started' && (e.payload as { owner: { taskId: string | null } }).owner.taskId === taskIds[0], 60_000);
    // Brief di ripresa (Fase 7): il turno interrotto è dichiarato, e il motore lo riceve (allegato).
    const resumed = second.transport.events().find((e) => e.type === 'memory.context.built')?.payload as { file: string; attempt: number; resume: boolean };
    expect(resumed).toMatchObject({ attempt: 2, resume: true });
    const resumeBrief = readFileSync(resumed.file, 'utf8');
    expect(resumeBrief).toContain('## Ripresa\nTentativo 2 di 2.');
    expect(resumeBrief).toMatch(/esecutore · lost: turno interrotto dalla caduta del core/);
    const trace = join(crashed.workspaceDir, 'esecutore', 'fake-oc-last.json');
    for (let i = 0; i < 200 && !existsSync(trace); i++) await sleep(50);
    const sent = JSON.parse(readFileSync(trace, 'utf8')) as { fileText: string | null };
    expect(sent.fileText).toBe(resumeBrief);
    expect(await second.transport.command('tasks.cancel', { taskId: rootTaskId, reason: 'basta' })).toMatchObject({ ok: true, data: { alreadyFinished: false } });
    const summary = await waitTask(second.transport, rootTaskId);
    expect(summary.payload).toMatchObject({ outcome: 'cancelled' });
    expect(second.core.tasks.get(taskIds[0] as string)).toMatchObject({ status: 'cancelled', attempts: 2 });
    // Il task è annullato subito; il processo del turno termina subito dopo (stopping → cancelled).
    for (let i = 0; i < 200 && second.core.runtime.list({ live: true }).length > 0; i++) await sleep(50);
    expect(second.core.runtime.list({ live: true })).toEqual([]);
    expect(second.core.runtime.list().find((p) => p.owner.taskId === taskIds[0] && p.kind === 'agent-turn' && p.endedAt !== null)?.status).toBe('cancelled');
  }, 240_000);
});
