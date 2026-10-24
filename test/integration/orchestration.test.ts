// Fase 10 — Multi-Agent Orchestration: verifica che l'orchestrazione multi-agente passi dal
// Director/Task Engine già esistente (Fase 6) e dal Context Builder (Fase 7), senza un secondo
// sistema parallelo. Adapter finti in memoria: nessun motore, nessuna rete.
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '../../src/shared/contracts/index.ts';
import { agentInput, createStack, fakeAdapter, type Stack } from '../orchestration-harness.ts';

const stacks: Stack[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) await s.close();
});
function stack(opts: Parameters<typeof createStack>[0] = {}): Stack {
  const s = createStack(opts);
  stacks.push(s);
  return s;
}
const corr = (id: string) => ({ correlationId: id, causationId: id });
const tasksOf = (s: Stack, rootId: string): Task[] => s.engine.list({ rootId, limit: 50 }).filter((t) => t.kind !== 'goal').reverse();

/** Indici delle transizioni `running`/`succeeded` dei task di lavoro di un obiettivo. */
function workTransitions(s: Stack, rootId: string): { running: number[]; succeeded: number[] } {
  const changes = s.events('task.status.changed').filter((e) => {
    const p = e.payload as { rootId: string; kind: string };
    return p.rootId === rootId && p.kind === 'work';
  });
  const running: number[] = [];
  const succeeded: number[] = [];
  changes.forEach((e, i) => {
    const to = (e.payload as { to: string }).to;
    if (to === 'running') running.push(i);
    if (to === 'succeeded') succeeded.push(i);
  });
  return { running, succeeded };
}

describe('Fase 10 — Multi-Agent Orchestration', () => {
  it('1 task → 1 agente: piano esplicito, un solo turno', async () => {
    const s = stack();
    s.agents.define(agentInput('solo', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({ goal: 'Un solo passo', plan: { steps: [{ key: 'uno', title: 'Uno', spec: 'Fai. RISPOSTA:fatto', agentId: 'solo' }] } }, 'owner:ui', corr('corr-one-0001'));
    await s.settle();
    const [t] = tasksOf(s, out.rootTaskId);
    expect(t).toMatchObject({ status: 'succeeded', assigneeAgentId: 'solo', result: { summary: 'fatto', producedBy: 'solo' } });
    expect(s.engine.get(out.rootTaskId)?.status).toBe('succeeded');
    expect(s.adapters['motore-a']?.turns).toHaveLength(1);
  });

  it('1 task → più agenti: fan-out in parallelo con risultati aggregati', async () => {
    const s = stack({ adapters: [fakeAdapter('m-a'), fakeAdapter('m-b'), fakeAdapter('m-c')], maxConcurrent: 4 });
    for (const [id, adapter] of [['a', 'm-a'], ['b', 'm-b'], ['c', 'm-c']] as const) s.agents.define(agentInput(id, adapter), 'owner', `c-${id}`);
    const out = s.director.submit({
      goal: 'Analizza da tre punti di vista',
      plan: { steps: [{ key: 'analizza', title: 'Analizza', spec: 'Analizza. RISPOSTA:analisi', agents: ['a', 'b', 'c'] }] }
    }, 'owner:ui', corr('corr-fan-0001'));

    // Un solo passo dichiarato → tre task reali, uno per agente.
    expect(out.taskIds).toHaveLength(3);
    await s.settle();
    const tasks = tasksOf(s, out.rootTaskId);
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.status === 'succeeded')).toBe(true);
    expect(new Set(tasks.map((t) => t.assigneeAgentId))).toEqual(new Set(['a', 'b', 'c']));
    // Parallelo: tutti e tre passano a `running` prima che il primo finisca.
    const { running, succeeded } = workTransitions(s, out.rootTaskId);
    expect(running).toHaveLength(3);
    expect(Math.max(...running)).toBeLessThan(Math.min(...succeeded));
    // Aggregazione: la sintesi dell'obiettivo raccoglie tutti i risultati.
    expect(s.events('director.summary')[0]?.payload).toMatchObject({ rootTaskId: out.rootTaskId, outcome: 'succeeded', counts: { total: 3, succeeded: 3 } });
    expect(s.engine.get(out.rootTaskId)?.status).toBe('succeeded');
  });

  it('parallel tasks: passi indipendenti su agenti diversi corrono insieme', async () => {
    const s = stack();
    s.agents.define(agentInput('p1', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('p2', 'motore-b'), 'owner', 'c2');
    const out = s.director.submit({
      goal: 'Due lavori indipendenti',
      plan: { steps: [
        { key: 'x', title: 'X', spec: 'X. RISPOSTA:x', agentId: 'p1' },
        { key: 'y', title: 'Y', spec: 'Y. RISPOSTA:y', agentId: 'p2' }
      ] }
    }, 'owner:ui', corr('corr-par-0001'));
    await s.settle();
    const { running, succeeded } = workTransitions(s, out.rootTaskId);
    expect(running).toHaveLength(2);
    expect(Math.max(...running)).toBeLessThan(Math.min(...succeeded));
    expect(s.engine.get(out.rootTaskId)?.status).toBe('succeeded');
  });

  it('sequential tasks: la dipendenza parte solo dopo il passo precedente', async () => {
    const s = stack();
    s.agents.define(agentInput('q1', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('q2', 'motore-b'), 'owner', 'c2');
    const out = s.director.submit({
      goal: 'Prima poi',
      plan: { steps: [
        { key: 'primo', title: 'Primo', spec: 'Primo. RISPOSTA:primo', agentId: 'q1' },
        { key: 'secondo', title: 'Secondo', spec: 'Secondo. RISPOSTA:secondo', agentId: 'q2', dependsOn: ['primo'] }
      ] }
    }, 'owner:ui', corr('corr-seq-0001'));
    await s.settle();
    const [a, b] = tasksOf(s, out.rootTaskId);
    expect(a?.status).toBe('succeeded');
    expect(b?.status).toBe('succeeded');
    expect((a?.endedAt as number) <= (b?.startedAt as number)).toBe(true);
    // La dipendenza si risolve con il risultato del primo task.
    const resolved = s.events('task.dependency.resolved').filter((e) => (e.payload as { taskId: string }).taskId === b?.id);
    expect(resolved.map((e) => (e.payload as { outcome: string }).outcome)).toEqual(['satisfied']);
  });

  it('agent failure → retry: il task riesce al secondo tentativo', async () => {
    const s = stack({ maxAttempts: 2 });
    s.agents.define(agentInput('r1', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({
      goal: 'Fallisce una volta',
      plan: { steps: [{ key: 'r', title: 'R', spec: 'Primo tentativo. FALLISCI-UNA-VOLTA RISPOSTA:ok', agentId: 'r1' }] }
    }, 'owner:ui', corr('corr-retry-0001'));
    await s.settle();
    const [t] = tasksOf(s, out.rootTaskId);
    expect(t).toMatchObject({ status: 'succeeded', attempts: 2, assigneeAgentId: 'r1' });
    expect(s.adapters['motore-a']?.turns).toHaveLength(2);
    expect(s.engine.get(out.rootTaskId)?.status).toBe('succeeded');
  });

  it('result aggregation: il passo di coordinamento riceve i risultati del fan-out', async () => {
    const s = stack({ memory: true, adapters: [fakeAdapter('m-a'), fakeAdapter('m-b'), fakeAdapter('m-c')] });
    s.agents.define(agentInput('a', 'm-a'), 'owner', 'c-a');
    s.agents.define(agentInput('b', 'm-b'), 'owner', 'c-b');
    s.agents.define(agentInput('director', 'm-c'), 'owner', 'c-m');
    const out = s.director.submit({
      goal: 'Raccogli e coordina',
      plan: { steps: [
        { key: 'raccogli', title: 'Raccogli', spec: 'Dammi un dato. RISPOSTA:dato', agents: ['a', 'b'] },
        { key: 'aggrega', title: 'Aggrega', spec: 'Unisci i risultati. RISPOSTA:sintesi', agentId: 'director', dependsOn: ['raccogli'] }
      ] }
    }, 'owner:ui', corr('corr-agg-0001'));
    await s.settle();

    const tasks = tasksOf(s, out.rootTaskId);
    expect(tasks.map((t) => t.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    const coordinator = tasks.find((t) => t.assigneeAgentId === 'director');
    expect(coordinator?.result?.summary).toBe('sintesi');
    // Il brief del coordinatore contiene i risultati dei due agenti del fan-out (Context Builder).
    const brief = s.adapters['m-c']?.turns[0]?.text ?? '';
    expect(brief).toContain('Dipende da');
    expect(brief).toContain('Raccogli [a]');
    expect(brief).toContain('Raccogli [b]');
    expect(brief).toContain('dato');
    // Sintesi finale con tutti i risultati.
    const summary = s.events('director.summary')[0]?.payload as { counts: { total: number }; text: string };
    expect(summary.counts.total).toBe(3);
    expect(summary.text).toContain('sintesi');
    expect(summary.text).toContain('dato');
  });

  it('Director coordinatore: piano di fan-out prodotto dall\'agente pianificatore e poi eseguito', async () => {
    const s = stack({ adapters: [fakeAdapter('m-a'), fakeAdapter('m-b'), fakeAdapter('m-c')] });
    s.agents.define(agentInput('director', 'm-a'), 'owner', 'c-m');
    s.agents.define(agentInput('beta', 'm-b'), 'owner', 'c-b');
    s.agents.define(agentInput('gamma', 'm-c'), 'owner', 'c-g');
    const plan = {
      steps: [
        { key: 'raccogli', title: 'Raccogli', spec: 'Raccogli. RISPOSTA:dato', agents: ['beta', 'gamma'] },
        { key: 'coordina', title: 'Coordina', spec: 'Coordina. RISPOSTA:coordinato', agentId: 'director', dependsOn: ['raccogli'] }
      ]
    };
    const out = s.director.submit({ goal: `Coordina gli agenti RISPOSTA:${JSON.stringify(plan)}`, title: 'Coordinamento', plannerAgentId: 'director' }, 'owner:ui', corr('corr-director-0001'));
    expect(out.planner).toBe('agent');
    await s.settle();
    const tasks = tasksOf(s, out.rootTaskId);
    expect(tasks.map((t) => `${t.kind}:${t.status}:${t.assigneeAgentId}`)).toEqual([
      'plan:succeeded:director', 'work:succeeded:beta', 'work:succeeded:gamma', 'work:succeeded:director'
    ]);
    expect(s.engine.get(out.rootTaskId)?.status).toBe('succeeded');
  });

  it('workflow completo: fan-out parallelo + aggregazione + dipendenza sequenziale', async () => {
    const s = stack({ adapters: [fakeAdapter('m-a'), fakeAdapter('m-b'), fakeAdapter('m-c')] });
    s.agents.define(agentInput('a', 'm-a'), 'owner', 'c-a');
    s.agents.define(agentInput('b', 'm-b'), 'owner', 'c-b');
    s.agents.define(agentInput('director', 'm-c'), 'owner', 'c-m');
    const out = s.director.submit({
      goal: 'Workflow completo',
      plan: { steps: [
        { key: 'analizza', title: 'Analizza', spec: 'Analizza. RISPOSTA:analisi', agents: ['a', 'b'] },
        { key: 'produci', title: 'Produci', spec: 'Produci. RISPOSTA:prodotto', agentId: 'a' },
        { key: 'coordina', title: 'Coordina', spec: 'Coordina. RISPOSTA:finale', agentId: 'director', dependsOn: ['analizza', 'produci'] }
      ] }
    }, 'owner:ui', corr('corr-full-0001'));
    await s.settle();
    const tasks = tasksOf(s, out.rootTaskId);
    expect(tasks).toHaveLength(4);
    expect(tasks.every((t) => t.status === 'succeeded')).toBe(true);
    const coordinator = tasks.find((t) => t.assigneeAgentId === 'director');
    expect(coordinator?.dependsOn).toHaveLength(3); // due figli del fan-out + il passo singolo
    expect(s.events('director.summary')[0]?.payload).toMatchObject({ counts: { total: 4, succeeded: 4 } });
    expect(s.engine.get(out.rootTaskId)?.status).toBe('succeeded');
  });
});
