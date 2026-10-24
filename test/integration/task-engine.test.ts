// Fase 6 — Task Engine con un esecutore scriptato (nessun agente, nessun processo): ciclo di vita,
// dipendenze (soddisfatte, fallite, cicli), errori e nuovi tentativi, timeout, annullamento a
// cascata, transizioni non ammesse, task sconosciuti e duplicati, un turno per agente, recupero dopo
// una caduta, eventi correlati nel journal.
import { afterEach, describe, expect, it } from 'vitest';
import type { TurnRequest, TurnResult } from '../../src/core/agents/index.ts';
import { createAuditLog } from '../../src/core/audit/index.ts';
import { createTaskEngine, TaskEngineError, type NewTask, type TaskEngine, type TaskEngineHooks } from '../../src/core/tasks/index.ts';
import { taskError, type Task } from '../../src/shared/contracts/index.ts';
import { memoryLogger } from '../helpers.ts';
import { createRuntimeHarness, type RuntimeHarness } from '../runtime-harness.ts';

type Script = (req: TurnRequest, call: number) => Promise<TurnResult> | TurnResult;

class ScriptedExecutor {
  calls: TurnRequest[] = [];
  busy = new Set<string>();
  maxParallelPerAgent = 0;
  private readonly script: Script;
  constructor(script: Script) {
    this.script = script;
  }
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    this.calls.push(req);
    if (this.busy.has(req.agentId)) this.maxParallelPerAgent = 2;
    this.busy.add(req.agentId);
    try {
      return await this.script(req, this.calls.filter((c) => c.taskId === req.taskId).length);
    } finally {
      this.busy.delete(req.agentId);
    }
  }
  isBusy(agentId: string): boolean {
    return this.busy.has(agentId);
  }
}

const ok = (text: string): TurnResult => ({ status: 'succeeded', text, artifacts: [], sessionId: 'sess-1', processIds: ['proc-1'], turnId: 'turn-1' });
const fail = (message = 'errore del turno'): TurnResult => ({ status: 'failed', error: taskError('turn_failed', message, { retryable: true, runtimeCode: 'engine_error' }), sessionId: null, processIds: [], turnId: 'turn-x' });
/** Resta in corso finché il segnale non viene annullato. */
const hang = (req: TurnRequest): Promise<TurnResult> =>
  new Promise((resolve) => req.signal.addEventListener('abort', () => resolve({ status: 'cancelled', reason: String(req.signal.reason), sessionId: null, processIds: [], turnId: 't' }), { once: true }));

/** Hook minimi: l'agente indicato o `a1`; nuovo tentativo con lo stesso agente. */
const simpleHooks: TaskEngineHooks = {
  prepare: (task, busy) => {
    const agentId = task.assigneeAgentId ?? 'a1';
    return busy.has(agentId) ? { kind: 'defer', reason: 'occupato' } : { kind: 'run', agentId, reason: 'test' };
  },
  onAttemptFailed: (task) => ({ kind: 'retry', agentId: task.assigneeAgentId ?? 'a1', reason: 'riprova' })
};

const harnesses: RuntimeHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

function setup(script: Script, opts: { maxConcurrent?: number; timeoutMs?: number; maxAttempts?: number; h?: RuntimeHarness; hooks?: TaskEngineHooks } = {}) {
  const h = opts.h ?? createRuntimeHarness();
  if (!opts.h) harnesses.push(h);
  const executor = new ScriptedExecutor(script);
  const engine = createTaskEngine({
    db: h.db, events: h.emitter, log: memoryLogger('error').log, audit: createAuditLog(h.db), executor,
    maxConcurrent: opts.maxConcurrent ?? 4, defaultBudget: { timeoutMs: opts.timeoutMs ?? 5_000, maxAttempts: opts.maxAttempts ?? 2 }
  });
  engine.setHooks(opts.hooks ?? simpleHooks);
  const settle = async (): Promise<void> => {
    // Non attende i turni appesi di proposito (LENTO): solo il lavoro già pronto.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await h.idle();
    }
  };
  return { h, engine, executor, settle };
}

const step = (key: string, over: Partial<NewTask> = {}): NewTask => ({ key, kind: 'work', title: `Passo ${key}`, spec: `fai ${key}`, ...over });
const corr = { correlationId: 'corr-engine-0001' };
const statuses = (engine: TaskEngine, ids: string[]) => ids.map((id) => engine.get(id)?.status);

describe('Task Engine — ciclo di vita', () => {
  it('created → queued → running → succeeded; radice chiusa con l\'esito; risultato e tracce registrati', async () => {
    const { h, engine, settle } = setup((req) => ok(`risultato di ${req.title}`));
    const { root, tasks } = engine.createGoal({ title: 'Obiettivo', spec: 'spec', createdBy: 'owner', steps: [step('a')] }, corr);
    expect(root.status).toBe('created');
    expect(tasks[0]?.status).toBe('created');
    await settle();
    const task = engine.get(tasks[0]?.id as string) as Task;
    expect(task).toMatchObject({ status: 'succeeded', attempts: 1, assigneeAgentId: 'a1', sessionId: 'sess-1', processIds: ['proc-1'], turnId: 'turn-1',
      result: { outcome: 'success', summary: 'risultato di Passo a', producedBy: 'a1' }, error: null });
    expect(task.startedAt).not.toBeNull();
    expect(task.endedAt).not.toBeNull();
    expect(engine.get(root.id)?.status).toBe('succeeded');
    const changes = h.events.filter((e) => e.type === 'task.status.changed').map((e) => e.payload as { taskId: string; from: string; to: string });
    expect(changes.filter((c) => c.taskId === task.id).map((c) => `${c.from}→${c.to}`)).toEqual(['created→queued', 'queued→running', 'running→succeeded']);
    expect(changes.filter((c) => c.taskId === root.id).map((c) => `${c.from}→${c.to}`)).toEqual(['created→running', 'running→succeeded']);
    // Tutti gli eventi dei task portano la correlazione dell'obiettivo e sono nel journal.
    const taskEvents = h.events.filter((e) => e.category === 'task');
    expect(new Set(taskEvents.map((e) => e.correlationId))).toEqual(new Set(['corr-engine-0001']));
    expect(h.journal.read({ correlationId: 'corr-engine-0001', limit: 100 }).map((e) => e.type)).toEqual(taskEvents.map((e) => e.type));
    expect(engine.counts()).toMatchObject({ succeeded: 2, running: 0 });
  });

  it('fallimento: nuovo tentativo deciso dal Director, poi failed con errore strutturato oltre i tentativi', async () => {
    const { engine, executor, settle } = setup(() => fail('il motore ha risposto male'), { maxAttempts: 2 });
    const { root, tasks } = engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a')] }, corr);
    await settle();
    expect(executor.calls).toHaveLength(2);
    expect(engine.get(tasks[0]?.id as string)).toMatchObject({
      status: 'failed', attempts: 2, error: { code: 'turn_failed', message: 'il motore ha risposto male', runtimeCode: 'engine_error' }
    });
    expect(engine.get(root.id)).toMatchObject({ status: 'failed', error: { code: 'turn_failed' } });
  });

  it('passo di lavoro che risponde con un piano JSON (collaudo VM 24/10/2026): non vale, nuovo tentativo, poi il risultato', async () => {
    const plan = '{"steps":[{"key":"s1","title":"Leggere il file","spec":"leggi","agentId":"director","dependsOn":[]}]}';
    const { engine, settle } = setup((_r, call) => (call === 1 ? ok(plan) : ok('La parola è GIRASOLE-34')));
    const { tasks } = engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a')] }, corr);
    await settle();
    expect(engine.get(tasks[0]?.id as string)).toMatchObject({ status: 'succeeded', attempts: 2, result: { summary: 'La parola è GIRASOLE-34' } });
  });

  it('riuscita al secondo tentativo', async () => {
    const { engine, settle } = setup((_r, call) => (call === 1 ? fail() : ok('ok')));
    const { tasks } = engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a')] }, corr);
    await settle();
    expect(engine.get(tasks[0]?.id as string)).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('timeout: timed_out allo scadere, turno annullato, esito tardivo ignorato', async () => {
    const { engine, executor, settle } = setup(hang, { timeoutMs: 150 });
    const { root, tasks } = engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a')] }, corr);
    await settle();
    await new Promise((r) => setTimeout(r, 250));
    await settle();
    expect(engine.get(tasks[0]?.id as string)).toMatchObject({ status: 'timed_out', error: { code: 'timeout' } });
    expect(executor.calls[0]?.signal.aborted).toBe(true);
    expect(executor.calls[0]?.signal.reason).toBe('timeout');
    expect(engine.get(root.id)?.status).toBe('failed');
    expect(executor.calls).toHaveLength(1);
  });

  it('annullamento a cascata: radice e discendenti, turno in corso annullato, idempotente', async () => {
    const { engine, executor, settle } = setup(hang);
    const { root, tasks } = engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a'), step('b', { dependsOn: ['a'] })] }, corr);
    await settle();
    expect(statuses(engine, tasks.map((t) => t.id))).toEqual(['running', 'created']);
    const out = engine.cancel(root.id, 'basta così', 'owner', corr);
    expect(out.alreadyFinished).toBe(false);
    expect(new Set(out.cancelled)).toEqual(new Set([root.id, ...tasks.map((t) => t.id)]));
    await settle();
    expect(statuses(engine, [root.id, ...tasks.map((t) => t.id)])).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(executor.calls[0]?.signal.aborted).toBe(true);
    expect(engine.cancel(root.id, 'di nuovo', 'owner', corr)).toEqual({ cancelled: [], alreadyFinished: true });
  });

  it('annullare un figlio: i dipendenti diventano blocked, la radice fallisce', async () => {
    const { engine, settle } = setup(hang);
    const { root, tasks } = engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a'), step('b', { dependsOn: ['a'] })] }, corr);
    await settle();
    engine.cancel(tasks[0]?.id as string, 'non serve', 'owner', corr);
    await settle();
    expect(statuses(engine, [tasks[0]?.id as string, tasks[1]?.id as string, root.id])).toEqual(['cancelled', 'blocked', 'failed']);
  });
});

describe('Task Engine — dipendenze', () => {
  it('B parte solo dopo A riuscito; eventi di dipendenza soddisfatta', async () => {
    // Agenti diversi e turni con durata: senza l'attesa delle dipendenze partirebbero insieme.
    const order: string[] = [];
    const { h, engine, settle } = setup(async (req) => {
      order.push(`inizio ${req.title}`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`fine ${req.title}`);
      return ok(req.title);
    });
    const { tasks } = engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [
      step('c', { dependsOn: ['b'], assigneeAgentId: 'a3' }), step('b', { dependsOn: ['a'], assigneeAgentId: 'a2' }), step('a')
    ] }, corr);
    // Creati in ordine topologico.
    expect(tasks.map((t) => t.title)).toEqual(['Passo a', 'Passo b', 'Passo c']);
    expect(tasks[1]?.dependsOn).toEqual([tasks[0]?.id]);
    for (let i = 0; i < 20; i++) await settle();
    expect(order).toEqual(['inizio Passo a', 'fine Passo a', 'inizio Passo b', 'fine Passo b', 'inizio Passo c', 'fine Passo c']);
    const resolved = h.events.filter((e) => e.type === 'task.dependency.resolved').map((e) => e.payload);
    expect(resolved).toEqual([
      { taskId: tasks[1]?.id, dependsOn: tasks[0]?.id, outcome: 'satisfied', dependencyStatus: 'succeeded' },
      { taskId: tasks[2]?.id, dependsOn: tasks[1]?.id, outcome: 'satisfied', dependencyStatus: 'succeeded' }
    ]);
  });

  it('dipendenza fallita: il dipendente è blocked con dependency_failed e non parte mai', async () => {
    const { h, engine, executor, settle } = setup((req) => (req.title === 'Passo a' ? fail() : ok('x')), { maxAttempts: 1 });
    const { root, tasks } = engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a'), step('b', { dependsOn: ['a'] }), step('c')] }, corr);
    await settle();
    expect(statuses(engine, tasks.map((t) => t.id))).toEqual(['failed', 'blocked', 'succeeded']);
    expect(engine.get(tasks[1]?.id as string)?.error).toMatchObject({ code: 'dependency_failed' });
    expect(executor.calls.map((c) => c.title)).toEqual(['Passo a', 'Passo c']);
    expect(h.events.find((e) => e.type === 'task.dependency.resolved' && (e.payload as { outcome: string }).outcome === 'blocked')?.payload).toMatchObject({ dependsOn: tasks[0]?.id, dependencyStatus: 'failed' });
    expect(engine.get(root.id)).toMatchObject({ status: 'failed', error: { message: expect.stringMatching(/2 task su 3/) } });
  });

  it('dipendenza circolare: rifiutata prima di scrivere, nulla registrato', () => {
    const { h, engine } = setup(() => ok('x'));
    expect(() => engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })] }, corr))
      .toThrow(/dipendenza circolare tra: a, b/);
    expect(engine.list({ limit: 10 })).toEqual([]);
    expect(h.events.filter((e) => e.type === 'task.created')).toHaveLength(0);
  });
});

describe('Task Engine — errori di contratto e idempotenza', () => {
  it('task sconosciuto, transizioni non ammesse rifiutate, passi duplicati e limiti', async () => {
    const { engine, settle } = setup(() => ok('x'));
    expect(engine.get('inesistente')).toBeNull();
    expect(() => engine.cancel('inesistente', 'x', 'owner', corr)).toThrow(TaskEngineError);
    expect(() => engine.addTasks('inesistente', [step('a')], 'owner', corr)).toThrow(/sconosciuto/);
    const { tasks } = engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a')] }, corr);
    // resume/fail su un task che non è in attesa: rifiutati senza cambiare nulla.
    expect(engine.resume(tasks[0]?.id as string, 'x', corr)).toBe(false);
    await settle();
    expect(engine.fail(tasks[0]?.id as string, taskError('internal', 'x'), corr)).toBe(false);
    expect(engine.get(tasks[0]?.id as string)?.status).toBe('succeeded');
    expect(() => engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a'), step('b', { title: 'Passo a', spec: 'fai a' })] }, corr)).toThrow(/duplicato/);
    expect(() => engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => step(k)) }, corr)).toThrow(/al più 5/);
  });

  it('sotto-task duplicati sotto lo stesso genitore rifiutati; profondità massima 3; obiettivo chiuso', async () => {
    const { engine, settle } = setup(hang);
    const { root, tasks } = engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a')] }, corr);
    const a = tasks[0] as Task;
    const [b] = engine.addTasks(a.id, [step('b')], 'agent:a1', corr);
    expect(() => engine.addTasks(a.id, [step('b')], 'agent:a1', corr)).toThrow(/duplicato/);
    const [c] = engine.addTasks((b as Task).id, [step('c')], 'agent:a1', corr);
    expect(() => engine.addTasks((c as Task).id, [step('d')], 'agent:a1', corr)).toThrow(/profondità massima/);
    engine.cancel(root.id, 'fine', 'owner', corr);
    await settle();
    expect(() => engine.addTasks(a.id, [step('z')], 'agent:a1', corr)).toThrow(/già concluso/);
  });

  it('un agente esegue un task alla volta; il limite globale è rispettato', async () => {
    const { engine, executor, settle } = setup(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return ok('x');
    }, { maxConcurrent: 2 });
    engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a'), step('b'), step('c', { assigneeAgentId: 'a2' })] }, corr);
    await settle();
    expect(executor.maxParallelPerAgent).toBe(0);
    expect(executor.calls.map((c) => c.agentId).sort()).toEqual(['a1', 'a1', 'a2']);
  });

  it('attesa di approvazione: waiting senza consumare il tentativo, poi resume → eseguito', async () => {
    let approved = false;
    const hooks: TaskEngineHooks = {
      ...simpleHooks,
      prepare: (task, busy) => (approved ? simpleHooks.prepare(task, busy) : { kind: 'wait', approvalId: 'appr-1', reason: 'serve approvazione' })
    };
    const { engine, executor, settle } = setup(() => ok('x'), { hooks });
    const { tasks } = engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a')] }, corr);
    await settle();
    expect(engine.get(tasks[0]?.id as string)).toMatchObject({ status: 'waiting', attempts: 0, waitingOn: { kind: 'approval', ref: 'appr-1' } });
    expect(executor.calls).toHaveLength(0);
    approved = true;
    expect(engine.resume(tasks[0]?.id as string, 'approvato', corr)).toBe(true);
    await settle();
    expect(engine.get(tasks[0]?.id as string)).toMatchObject({ status: 'succeeded', attempts: 1, waitingOn: null });
  });
});

describe('Task Engine — recupero e spegnimento', () => {
  it('caduta durante un turno: al riavvio il task torna in coda (tentativo contato) e riparte; oltre i tentativi → lost', async () => {
    const h = createRuntimeHarness();
    harnesses.push(h);
    // Primo "core": il turno resta in corso e il processo del core sparisce (nessuno spegnimento).
    const first = setup(hang, { h, maxAttempts: 2 });
    const { tasks } = first.engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a'), step('b', { assigneeAgentId: 'a2', budget: { maxAttempts: 1 } })] }, corr);
    await first.settle();
    const ids = tasks.map((t) => t.id);
    expect(statuses(first.engine, ids)).toEqual(['running', 'running']);
    // Secondo "core" sullo stesso database.
    const second = setup((req) => ok(`ripreso ${req.title}`), { h });
    // b ha un solo tentativo: è stato consumato dalla caduta.
    const report = second.engine.recover();
    expect(report).toEqual({ requeued: 1, lost: 1, roots: 0 });
    expect(second.engine.get(ids[0] as string)).toMatchObject({ status: 'queued', attempts: 1, error: { code: 'lost', retryable: true } });
    expect(second.engine.get(ids[1] as string)).toMatchObject({ status: 'failed', error: { code: 'lost' } });
    second.engine.schedule();
    await second.settle();
    expect(second.engine.get(ids[0] as string)).toMatchObject({ status: 'succeeded', attempts: 2, result: { summary: 'ripreso Passo a' } });
    // Nessun task resta `running` senza un turno vivo.
    expect(second.engine.list({ status: ['running'] })).toEqual([]);
    first.executor.calls.forEach((c) => expect(c.signal.aborted).toBe(false));
  });

  it('spegnimento: i turni in corso sono annullati e i task tornano in coda senza perdere il tentativo', async () => {
    const { engine, executor, settle } = setup(hang);
    const { tasks } = engine.createGoal({ title: 'O', spec: 's', createdBy: 'owner', steps: [step('a')] }, corr);
    await settle();
    expect(await engine.suspend('chiusura', 1_000)).toBe(1);
    expect(engine.get(tasks[0]?.id as string)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(executor.calls[0]?.signal.aborted).toBe(true);
    engine.schedule();
    await settle();
    expect(executor.calls).toHaveLength(1);
  });
});
