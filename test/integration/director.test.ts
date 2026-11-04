// Fase 6 — Director → Task Engine → Agent Manager → adapter (finti, in memoria) con Event Bus,
// journal, State Store-compatibile, approvazioni, audit e canale a file reali. DoD della fase:
// obiettivo scomposto e assegnato ad agenti di motori diversi con i risultati che tornano; azione
// "con approvazione" ferma finché il proprietario non decide; azione bloccata che non parte mai.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeError, type AgentMessage, type Task } from '../../src/shared/contracts/index.ts';
import { agentInput, createStack, fakeAdapter, type Stack } from '../orchestration-harness.ts';
import { createRuntimeHarness } from '../runtime-harness.ts';

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

describe('Revisione: prima la prova, poi il fatto (issue #1, idea 6)', () => {
  const review = async (s: Stack, work: string, check: string): Promise<Task[]> => {
    const out = s.director.submit({
      goal: 'Lavora e rivedi',
      plan: { steps: [
        { key: 'w', title: 'Lavora', spec: work, agentId: 'alfa' },
        { key: 'r', title: 'Rivedi', spec: check, competence: 'review', dependsOn: ['w'] }
      ] }
    }, 'owner:ui', corr(`corr-prova-${Math.random().toString(36).slice(2, 10)}`));
    await s.settle();
    return tasksOf(s, out.rootTaskId);
  };

  it('lavoro dichiarato senza nessuno strumento, né dal passo né dal Revisore: esito parziale con la nota', async () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b', { competences: ['review'] }), 'owner', 'c2');
    const [w, r] = await review(s, 'RISPOSTA:file creato e test passati', 'RISPOSTA:approvato');
    expect(w?.result?.outcome).toBe('success');
    expect(r).toMatchObject({ status: 'succeeded', result: { outcome: 'partial' } });
    expect(r?.result?.summary).toMatch(/^NON VERIFICATO da VISIONE[\s\S]*\n\napprovato$/);
    const recorded = s.events('task.result.recorded').find((e) => (e.payload as { taskId: string }).taskId === r?.id);
    expect(recorded?.payload).toMatchObject({ outcome: 'partial' });
  });

  it('con una prova (del passo o del Revisore), o se il passo non dichiara lavoro: esito riuscito', async () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b', { competences: ['review'] }), 'owner', 'c2');
    const fromWork = await review(s, 'COMANDO:npm test|12 passed\nRISPOSTA:test passati', 'RISPOSTA:approvato');
    const fromReviewer = await review(s, 'RISPOSTA:file creato', 'COMANDO:type nota.txt|ciao\nRISPOSTA:visto');
    const textOnly = await review(s, 'RISPOSTA:tre idee per una cena veloce', 'RISPOSTA:vanno bene');
    for (const [, r] of [fromWork, fromReviewer, textOnly]) expect(r?.result).toMatchObject({ outcome: 'success' });
    expect(fromReviewer[1]?.result?.summary).toBe('visto');
    // La prova nel registro è quella consegnata dal motore, legata al turno che ha chiuso il passo.
    const proof = s.events('tool.call.finished').find((e) => (e.payload as { turnId: string }).turnId === fromWork[0]?.turnId);
    expect(proof?.payload).toMatchObject({ tool: 'Bash', ok: true, input: 'npm test', output: '12 passed' });
  });

  it('il brief del Revisore mostra le prove registrate da VISIONE, o dice che non ce ne sono', async () => {
    const s = stack({ memory: true });
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b', { competences: ['review'] }), 'owner', 'c2');
    await review(s, 'COMANDO:npm test|12 passed\nRISPOSTA:test passati', 'RISPOSTA:approvato');
    await review(s, 'RISPOSTA:file creato', 'RISPOSTA:approvato');
    const [proven, bare] = s.adapters['motore-b']?.turns.map((t) => t.text) ?? [];
    expect(proven).toContain('Sei il revisore');
    expect(proven).toMatch(/## Prove registrate da VISIONE[\s\S]*Bash riuscito: npm test\n\s+uscita: 12 passed/);
    expect(bare).toMatch(/## Prove registrate da VISIONE[\s\S]*nessuno strumento eseguito visto da VISIONE/);
    // Il passo che lavora non riceve la regola del Revisore.
    expect(s.adapters['motore-a']?.turns[0]?.text).not.toContain('Sei il revisore');
  });
});

describe('Director — DoD: obiettivo scomposto, due agenti di motori diversi, risultati', () => {
  it('piano esplicito A → B su motori diversi: eseguiti in ordine, risultati, sintesi, correlazione unica', async () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'corr-def-1');
    s.agents.define(agentInput('beta', 'motore-b', { competences: ['review'] }), 'owner', 'corr-def-2');
    const out = s.director.submit({
      goal: 'Scrivi e rivedi una funzione',
      plan: { steps: [
        { key: 'scrivi', title: 'Scrivi', spec: 'Scrivi la funzione.\nCOMANDO:npm test|3 passed\nRISPOSTA:funzione scritta', agentId: 'alfa' },
        { key: 'rivedi', title: 'Rivedi', spec: 'Rivedi la funzione. RISPOSTA:revisione ok', competence: 'review', dependsOn: ['scrivi'] }
      ] }
    }, 'owner:ui', corr('corr-goal-0001'));
    expect(out.planner).toBe('explicit');
    expect(out.taskIds).toHaveLength(2);
    await s.settle();
    const [a, b] = tasksOf(s, out.rootTaskId);
    expect(a).toMatchObject({ status: 'succeeded', assigneeAgentId: 'alfa', result: { summary: 'funzione scritta', producedBy: 'alfa' } });
    expect(b).toMatchObject({ status: 'succeeded', assigneeAgentId: 'beta', result: { summary: 'revisione ok' } });
    expect(s.engine.get(out.rootTaskId)?.status).toBe('succeeded');
    // Motori diversi, ordine rispettato.
    expect(s.adapters['motore-a']?.turns.map((t) => t.taskId)).toEqual([a?.id]);
    expect(s.adapters['motore-b']?.turns.map((t) => t.taskId)).toEqual([b?.id]);
    expect((a?.endedAt as number) <= (b?.startedAt as number)).toBe(true);
    // Sessione e istanze: due agenti, sessioni salvate, istanze tornate inattive.
    expect(a?.sessionId).toBeTruthy();
    expect(s.agents.status('alfa')).toBe('idle');
    expect(s.agents.status('beta')).toBe('idle');
    const summary = s.events('director.summary')[0];
    expect(summary?.payload).toMatchObject({ rootTaskId: out.rootTaskId, outcome: 'succeeded', counts: { total: 2, succeeded: 2 } });
    expect((summary?.payload as { text: string }).text).toMatch(/funzione scritta[\s\S]*revisione ok/);
    // Un solo filo: comando → Director → task → agenti → sintesi.
    const thread = s.h.journal.read({ correlationId: 'corr-goal-0001', limit: 500 }).map((e) => e.type);
    for (const type of ['task.created', 'director.goal.received', 'director.plan.created', 'director.decision', 'task.assigned', 'task.status.changed',
      'agent.instance.created', 'agent.status.changed', 'agent.turn.started', 'agent.message.text', 'agent.turn.finished', 'task.result.recorded', 'director.summary']) {
      expect(thread, type).toContain(type);
    }
    const assignDecision = s.events('director.decision').find((e) => (e.payload as { taskId: string }).taskId === b?.id);
    expect(assignDecision?.payload).toMatchObject({ decision: 'assign', agentId: 'beta', candidates: expect.arrayContaining([expect.objectContaining({ agentId: 'alfa', excluded: 'competenza review assente' })]) });
  });

  it('RulePlanner: un obiettivo → un task al miglior agente per competenza', async () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({ goal: 'Fai una cosa semplice. RISPOSTA:fatto' }, 'owner:ui', corr('corr-rule-0001'));
    expect(out.planner).toBe('rule');
    await s.settle();
    expect(tasksOf(s, out.rootTaskId)).toMatchObject([{ status: 'succeeded', assigneeAgentId: 'alfa', result: { summary: 'fatto' } }]);
  });

  it('orchestrare (24/10/2026): il pianificatore che si tiene un passo di un collega lo passa al collega; il prompt lo chiede', async () => {
    const s = stack();
    const plan = { steps: [{ key: 'r', title: 'Rivedi', spec: 'RISPOSTA:rivisto', agentId: 'alfa', competence: 'review' }, { key: 's', title: 'Sintesi', spec: 'RISPOSTA:fatto', agentId: 'alfa', dependsOn: ['r'] }] };
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b', { competences: ['review'] }), 'owner', 'c2');
    const out = s.director.submit({ goal: `Obiettivo RISPOSTA:${JSON.stringify(plan)}`, title: 'Squadra', plannerAgentId: 'alfa' }, 'owner:ui', corr('corr-orch-0001'));
    await s.settle();
    const tasks = tasksOf(s, out.rootTaskId);
    expect(tasks.map((t) => `${t.title}:${t.assigneeAgentId}:${t.status}`)).toEqual(['Piano: Squadra:alfa:succeeded', 'Rivedi:beta:succeeded', 'Sintesi:alfa:succeeded']);
    expect(s.adapters['motore-a']?.turns[0]?.text).toMatch(/Tu \(alfa\) coordini la squadra/);
  });

  it('AgentPlanner: piano JSON valido dall\'agente pianificatore → passi eseguiti', async () => {
    const s = stack();
    const plan = { steps: [{ key: 's1', title: 'Uno', spec: 'Primo. RISPOSTA:uno', agentId: 'beta' }, { key: 's2', title: 'Due', spec: 'Secondo. RISPOSTA:due', dependsOn: ['s1'], agentId: 'beta' }] };
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b'), 'owner', 'c2');
    const out = s.director.submit({ goal: `Obiettivo pianificato RISPOSTA:${JSON.stringify(plan)}`, title: 'Pianificato', plannerAgentId: 'alfa' }, 'owner:ui', corr('corr-plan-0001'));
    expect(out.planner).toBe('agent');
    await s.settle();
    const tasks = tasksOf(s, out.rootTaskId);
    expect(tasks.map((t) => `${t.kind}:${t.title}:${t.status}:${t.assigneeAgentId}`)).toEqual(['plan:Piano: Pianificato:succeeded:alfa', 'work:Uno:succeeded:beta', 'work:Due:succeeded:beta']);
    // Il pianificatore ha ricevuto gli agenti disponibili e lo schema del piano.
    expect(s.adapters['motore-a']?.turns[0]?.text).toMatch(/- beta · code[\s\S]*"steps"/);
    expect(s.engine.get(out.rootTaskId)?.status).toBe('succeeded');
    expect(s.events('director.plan.created').map((e) => (e.payload as { planner: string }).planner)).toEqual(['agent', 'agent']);
  });

  it('P-105: chi comanda — senza pianificatore nell\'invio pianifica l\'agente scelto; cambia subito; vuoto o archiviato = regole', async () => {
    let chosen = 'alfa';
    const s = stack({ defaultPlannerAgentId: () => chosen });
    const plan = { steps: [{ key: 's1', title: 'Uno', spec: 'Primo. RISPOSTA:uno', agentId: 'beta' }] };
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b'), 'owner', 'c2');
    const first = s.director.submit({ goal: `Obiettivo RISPOSTA:${JSON.stringify(plan)}`, title: 'Scelto' }, 'owner:ui', corr('corr-def-0001'));
    expect(first.planner).toBe('agent');
    await s.settle();
    expect(tasksOf(s, first.rootTaskId).map((t) => `${t.kind}:${t.assigneeAgentId}`)).toEqual(['plan:alfa', 'work:beta']);
    // Cambiato dalla procedura guidata: vale al prossimo invio, senza riavvio.
    chosen = 'beta';
    const second = s.director.submit({ goal: `Altro RISPOSTA:${JSON.stringify(plan)}`, title: 'Cambiato' }, 'owner:ui', corr('corr-def-0002'));
    expect(tasksOf(s, second.rootTaskId)[0]).toMatchObject({ kind: 'plan', assigneeAgentId: 'beta' });
    chosen = '';
    expect(s.director.submit({ goal: 'Senza capo', title: 'Regole' }, 'owner:ui', corr('corr-def-0003')).planner).toBe('rule');
    chosen = 'nessuno';
    expect(s.director.submit({ goal: 'Capo sparito', title: 'Regole 2' }, 'owner:ui', corr('corr-def-0004')).planner).toBe('rule');
    // Un pianificatore indicato nell'invio vince sempre su quello predefinito.
    chosen = 'beta';
    const explicit = s.director.submit({ goal: `Esplicito RISPOSTA:${JSON.stringify(plan)}`, title: 'Esplicito', plannerAgentId: 'alfa' }, 'owner:ui', corr('corr-def-0005'));
    expect(tasksOf(s, explicit.rootTaskId)[0]).toMatchObject({ kind: 'plan', assigneeAgentId: 'alfa' });
  });

  it('AgentPlanner con piano non valido → ripiego sul RulePlanner, motivato', async () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({ goal: 'Obiettivo RISPOSTA:non è un piano', plannerAgentId: 'alfa' }, 'owner:ui', corr('corr-plan-0002'));
    await s.settle();
    const tasks = tasksOf(s, out.rootTaskId);
    expect(tasks.map((t) => t.kind)).toEqual(['plan', 'work']);
    expect(tasks[1]).toMatchObject({ status: 'succeeded', spec: 'Obiettivo RISPOSTA:non è un piano' });
    expect(s.events('director.decision').some((e) => (e.payload as { decision: string }).decision === 'plan-fallback')).toBe(true);
    expect(s.events('director.plan.created').at(-1)?.payload).toMatchObject({ planner: 'rule', fallback: 'nessun oggetto JSON nella risposta' });
  });

  it('richiesta non valida: agente sconosciuto nel piano, ciclo, pianificatore inesistente', () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    expect(() => s.director.submit({ goal: 'x', plan: { steps: [{ key: 'a', title: 'a', spec: 'a', agentId: 'nessuno' }] } }, 'o', corr('corr-bad-0001'))).toThrow(/sconosciuto/);
    expect(() => s.director.submit({ goal: 'x', plan: { steps: [{ key: 'a', title: 'a', spec: 'a', dependsOn: ['b'] }, { key: 'b', title: 'b', spec: 'b', dependsOn: ['a'] }] } }, 'o', corr('corr-bad-0002'))).toThrow(/circolare/);
    expect(() => s.director.submit({ goal: 'x', plannerAgentId: 'nessuno' }, 'o', corr('corr-bad-0003'))).toThrow(/pianificatore/);
    expect(s.engine.list({ limit: 10 })).toEqual([]);
  });
});

describe('Director — policy e approvazioni', () => {
  it('azione con approvazione: il task si ferma (nessun turno) finché il proprietario non approva', async () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const target = join(s.h.dir, 'fuori', 'report.md');
    const out = s.director.submit({ goal: 'g', plan: { steps: [{ key: 'a', title: 'Scrivi fuori', spec: 'RISPOSTA:scritto', actions: [{ kind: 'fs.write', target }] }] } }, 'o', corr('corr-appr-0001'));
    await s.settle();
    const [task] = tasksOf(s, out.rootTaskId);
    expect(task).toMatchObject({ status: 'waiting', waitingOn: { kind: 'approval' }, attempts: 0 });
    expect(s.adapters['motore-a']?.turns).toHaveLength(0);
    const pending = s.approvals.list({ status: 'pending' });
    expect(pending).toMatchObject([{ kind: 'fs.write', target, taskId: task?.id, status: 'pending' }]);
    await new Promise((r) => setTimeout(r, 100));
    await s.settle();
    expect(s.adapters['motore-a']?.turns).toHaveLength(0); // ancora fermo
    s.approvals.decide(pending[0]?.id as string, 'grant', 'owner');
    await s.settle();
    expect(s.engine.get(task?.id as string)).toMatchObject({ status: 'succeeded', result: { summary: 'scritto' } });
    expect(s.audit.list(20).map((e) => e.action)).toEqual(expect.arrayContaining(['approval.request:fs.write', 'approval.decide:fs.write']));
  });

  it('approvazione negata: il task fallisce con approval_denied e non parte mai', async () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({ goal: 'g', plan: { steps: [{ key: 'a', title: 'Installa', spec: 'x', actions: [{ kind: 'shell.exec', target: 'npm install qualcosa' }] }] } }, 'o', corr('corr-appr-0002'));
    await s.settle();
    s.approvals.decide(s.approvals.list({ status: 'pending' })[0]?.id as string, 'deny', 'owner', { note: 'no' });
    await s.settle();
    expect(tasksOf(s, out.rootTaskId)[0]).toMatchObject({ status: 'failed', error: { code: 'approval_denied' } });
    expect(s.engine.get(out.rootTaskId)?.status).toBe('failed');
    expect(s.adapters['motore-a']?.turns).toHaveLength(0);
  });

  it('azione bloccata: failed policy_blocked subito, nessuna richiesta, nessun turno, audit', async () => {
    const s = stack({ protectedRoots: ['C:\\Users\\prova\\munder-difflin'] });
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({ goal: 'g', plan: { steps: [
      { key: 'a', title: 'Pubblica', spec: 'x', actions: [{ kind: 'git', target: 'push origin main' }] },
      { key: 'b', title: 'Tocca munder', spec: 'y', actions: [{ kind: 'fs.write', target: 'C:\\Users\\prova\\munder-difflin\\x.ts' }] }
    ] } }, 'o', corr('corr-block-001'));
    await s.settle();
    expect(tasksOf(s, out.rootTaskId).map((t) => `${t.status}:${t.error?.code}`)).toEqual(['failed:policy_blocked', 'failed:policy_blocked']);
    expect(s.approvals.list()).toEqual([]);
    expect(s.adapters['motore-a']?.turns).toHaveLength(0);
    expect(s.adapters['motore-a']?.starts).toHaveLength(0);
    expect(s.audit.list(20).filter((e) => e.decision === 'block').map((e) => e.action)).toEqual(['blocked:git', 'blocked:fs.write']);
  });

  it('fiducia del motore nella cartella: richiesta in coda, istanza in attesa, poi approvata → avvio e turno', async () => {
    const s = stack({ adapters: [fakeAdapter('motore-a', { trust: true })] });
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({ goal: 'RISPOSTA:dopo la fiducia' }, 'o', corr('corr-trust-001'));
    await s.settle();
    const [task] = tasksOf(s, out.rootTaskId);
    expect(task).toMatchObject({ status: 'waiting', attempts: 0, waitingOn: { kind: 'approval' } });
    expect(s.agents.status('alfa')).toBe('waiting');
    const [req] = s.approvals.list({ status: 'pending' });
    expect(req).toMatchObject({ kind: 'engine.workspace.trust', target: join(s.workspaceDir, 'alfa'), agentId: 'alfa', taskId: task?.id });
    expect(s.adapters['motore-a']?.turns).toHaveLength(0);
    s.approvals.decide(req?.id as string, 'grant', 'owner');
    await s.settle();
    expect(s.engine.get(task?.id as string)).toMatchObject({ status: 'succeeded', attempts: 1, result: { summary: 'dopo la fiducia' } });
    expect(s.adapters['motore-a']?.starts).toEqual(['alfa', 'alfa']);
  });

  it('fiducia negata: task fallito, istanza fermata', async () => {
    const s = stack({ adapters: [fakeAdapter('motore-a', { trust: true })] });
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({ goal: 'x' }, 'o', corr('corr-trust-002'));
    await s.settle();
    s.approvals.decide(s.approvals.list({ status: 'pending' })[0]?.id as string, 'deny', 'owner');
    await s.settle();
    await new Promise((r) => setTimeout(r, 50));
    expect(tasksOf(s, out.rootTaskId)[0]).toMatchObject({ status: 'failed', error: { code: 'approval_denied' } });
    expect(s.agents.status('alfa')).toBeNull();
    expect(s.agents.views({ includeArchived: false, breakerOf: () => 'closed' })[0]?.instance?.status).toBe('stopped');
  });
});

describe('Director — errori, nuovi tentativi, breaker, annullamento', () => {
  it('passo che rimanda indietro un piano JSON (collaudo VM 24/10/2026): nuovo tentativo con il richiamo, mai il JSON al proprietario', async () => {
    const s = stack({ memory: true });
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({
      goal: 'Leggi il file',
      plan: { steps: [{ key: 's1', title: 'Leggi', spec: 'Leggi il file. RISPOSTA:{"steps":[{"key":"s1","title":"Leggi","spec":"x"}]}', agentId: 'alfa' }] }
    }, 'owner:ui', corr('corr-echo-0001'));
    await s.settle();
    const [t] = tasksOf(s, out.rootTaskId);
    expect(t).toMatchObject({ status: 'failed', attempts: 2 });
    const turns = s.adapters['motore-a']?.turns ?? [];
    expect(turns).toHaveLength(2);
    expect(turns[1]?.text).toMatch(/NON pianificare/);
    // Il JSON scartato non si ricopia nel brief, e il nuovo tentativo parte in una conversazione nuova del motore.
    expect(turns[1]?.text).toMatch(/alfa · succeeded: risposta scartata \(era un piano\)/);
    expect(turns[1]?.engineSessionId).toBe('');
  });

  it('passo dell\'agente che ha pianificato: parte in una conversazione nuova del motore, gli altri riprendono la loro', async () => {
    const s = stack();
    const plan = { steps: [{ key: 's1', title: 'Uno', spec: 'Primo. RISPOSTA:uno', agentId: 'alfa' }, { key: 's2', title: 'Due', spec: 'Secondo. RISPOSTA:due', agentId: 'beta', dependsOn: ['s1'] }] };
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b'), 'owner', 'c2');
    // Un turno precedente di beta: la sua sessione del motore esiste già.
    s.director.submit({ goal: 'Prima cosa RISPOSTA:ok', plan: { steps: [{ key: 'p', title: 'P', spec: 'RISPOSTA:ok', agentId: 'beta' }] } }, 'owner:ui', corr('corr-fresh-0000'));
    await s.settle();
    const out = s.director.submit({ goal: `Obiettivo RISPOSTA:${JSON.stringify(plan)}`, title: 'Pianificato', plannerAgentId: 'alfa' }, 'owner:ui', corr('corr-fresh-0001'));
    await s.settle();
    expect(s.engine.get(out.rootTaskId)?.status).toBe('succeeded');
    const a = s.adapters['motore-a']?.turns ?? [];
    expect(a.map((t) => t.engineSessionId)).toEqual(['', '']);
    expect(s.adapters['motore-b']?.turns.at(-1)?.engineSessionId).toBe('ses-beta');
    const summary = s.events('director.summary')[0]?.payload as { text: string } | undefined;
    expect(summary?.text ?? '').not.toMatch(/"steps"/);
  });

  it('fallimento: stesso agente una volta, poi un altro agente compatibile', async () => {
    const s = stack({ maxAttempts: 3 });
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b'), 'owner', 'c2');
    // Solo il motore A fallisce sempre: il terzo tentativo va a beta.
    s.adapters['motore-a']!.sendTurn = (async (ctx, input) => {
      s.adapters['motore-a']!.turns.push({ agentId: ctx.instance.agentId, taskId: input.taskId, text: input.text, turnId: input.turnId, model: ctx.definition.engine.model ?? null, effort: null, engineSessionId: ctx.instance.session?.engineSessionId ?? '' });
      ctx.emit({ kind: 'turn.finished', turnId: input.turnId, outcome: 'failed', error: runtimeError('engine_error', 'A rotto') });
      return { outcome: 'failed', error: runtimeError('engine_error', 'A rotto'), engineSessionId: null };
    });
    const out = s.director.submit({ goal: 'g', plan: { steps: [{ key: 'a', title: 'Compito', spec: 'RISPOSTA:salvato da beta' }] } }, 'o', corr('corr-retry-001'));
    await s.settle();
    const [task] = tasksOf(s, out.rootTaskId);
    expect(task).toMatchObject({ status: 'succeeded', attempts: 3, assigneeAgentId: 'beta', result: { summary: 'salvato da beta' } });
    // Al secondo errore consecutivo il breaker di alfa passa a steer (decisione registrata).
    expect(s.events('director.decision').map((e) => (e.payload as { decision: string }).decision)).toEqual(['assign', 'retry', 'assign', 'breaker', 'reassign', 'assign']);
    expect(s.events('task.assigned').map((e) => (e.payload as { agentId: string }).agentId)).toEqual(['alfa', 'beta']);
  });

  it('breaker: errori consecutivi → steer → constrain (escluso dal router) → open (fermato); un successo lo richiude', async () => {
    const s = stack({ maxAttempts: 1 });
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    for (let i = 0; i < 4; i++) {
      s.director.submit({ goal: `FALLISCI ${i}` }, 'o', corr(`corr-brk-000${i}`));
      await s.settle();
    }
    const changes = s.events('agent.breaker.changed').map((e) => `${(e.payload as { from: string }).from}→${(e.payload as { to: string }).to}`);
    expect(changes).toEqual(['closed→steer', 'steer→constrain']);
    expect(s.director.breakerOf('alfa')).toBe('constrain');
    // Escluso dal router: il quarto obiettivo resta in coda (agente sospeso), non fallisce.
    const last = s.engine.list({ rootsOnly: true, limit: 1 })[0] as Task;
    expect(tasksOf(s, last.id)[0]?.status).toBe('queued');
    expect(s.adapters['motore-a']?.turns).toHaveLength(3);
  });

  it('annullamento dell\'obiettivo: propaga ai figli e annulla il turno dell\'agente', async () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({ goal: 'g', plan: { steps: [{ key: 'a', title: 'Lungo', spec: 'LENTO' }, { key: 'b', title: 'Dopo', spec: 'x', dependsOn: ['a'] }] } }, 'o', corr('corr-cancel-01'));
    await s.settle();
    expect(s.agents.status('alfa')).toBe('working');
    const res = s.engine.cancel(out.rootTaskId, 'cambio di piani', 'owner:ui', corr('corr-cancel-02'));
    expect(res.cancelled).toHaveLength(3);
    await s.settle();
    expect(s.adapters['motore-a']?.cancels).toEqual(['alfa']);
    expect(tasksOf(s, out.rootTaskId).map((t) => t.status)).toEqual(['cancelled', 'cancelled']);
    expect(s.agents.status('alfa')).toBe('idle');
    expect(s.events('director.summary').at(-1)?.payload).toMatchObject({ outcome: 'cancelled', counts: { cancelled: 2 } });
  });

  it('annullamento durante l\'avvio dell\'istanza: nessun turno inviato, task annullato, istanza inattiva', async () => {
    const s = stack({ adapters: [fakeAdapter('motore-a', { startDelayMs: 150 })] });
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({ goal: 'RISPOSTA:non dovrebbe partire' }, 'o', corr('corr-cstart-01'));
    await new Promise((r) => setTimeout(r, 30));
    expect(s.adapters['motore-a']?.starts).toEqual(['alfa']);
    s.engine.cancel(out.rootTaskId, 'annullato subito', 'owner:ui', corr('corr-cstart-02'));
    await new Promise((r) => setTimeout(r, 250));
    await s.settle();
    expect(s.adapters['motore-a']?.turns).toHaveLength(0);
    expect(tasksOf(s, out.rootTaskId)[0]?.status).toBe('cancelled');
    expect(s.agents.status('alfa')).toBe('idle');
    expect(s.agents.isBusy('alfa')).toBe(false);
  });

  it('agente non avviabile: errore strutturato agent_unavailable con il codice del runtime', async () => {
    const s = stack({ adapters: [fakeAdapter('motore-a', { startError: runtimeError('not_found', 'CLI assente') })], maxAttempts: 1 });
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({ goal: 'x' }, 'o', corr('corr-start-001'));
    await s.settle();
    expect(tasksOf(s, out.rootTaskId)[0]).toMatchObject({ status: 'failed', error: { code: 'agent_unavailable', runtimeCode: 'not_found', message: 'CLI assente' } });
    expect(s.agents.status('alfa')).toBe('error');
  });

  it('nessun agente compatibile: failed no_agent', async () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({ goal: 'g', plan: { steps: [{ key: 'a', title: 'Ricerca', spec: 'x', competence: 'research' }] } }, 'o', corr('corr-noag-001'));
    await s.settle();
    expect(tasksOf(s, out.rootTaskId)[0]).toMatchObject({ status: 'failed', error: { code: 'no_agent' } });
  });
});

describe('Agent Registry', () => {
  it('definizione validata, versioni, archiviazione; cartelle fuori posto rifiutate', async () => {
    const s = stack({ protectedRoots: ['C:\\Users\\prova\\jarvis'] });
    expect(s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1')).toEqual({ agentId: 'alfa', version: 1, created: true });
    expect(s.agents.define(agentInput('alfa', 'motore-a', { name: 'Alfa 2' }), 'owner', 'c2')).toEqual({ agentId: 'alfa', version: 2, created: false });
    expect(() => s.agents.define(agentInput('x', 'motore-ignoto'), 'owner', 'c3')).toThrow(/adapter sconosciuto/);
    expect(() => s.agents.define(agentInput('y', 'motore-a', { workspace: { root: '..\\fuori', isolation: 'shared' } }), 'owner', 'c4')).toThrow(/uscire/);
    expect(() => s.agents.define(agentInput('z', 'motore-a', { workspace: { root: 'C:\\Users\\prova\\jarvis\\w', isolation: 'shared' } }), 'owner', 'c5')).toThrow(/non consentita/);
    expect(await s.agents.archive('alfa', 'owner', 'c7')).toEqual({ alreadyArchived: false });
    expect(await s.agents.archive('alfa', 'owner', 'c8')).toEqual({ alreadyArchived: true });
    expect(s.agents.get('alfa')).toBeNull();
    expect(s.agents.views({ includeArchived: true, breakerOf: () => 'closed' })).toMatchObject([{ archived: true, definition: { name: 'Alfa 2', version: 2 } }]);
    expect(s.events().filter((e) => e.type.startsWith('agent.definition.')).map((e) => e.type)).toEqual(['agent.definition.created', 'agent.definition.updated', 'agent.definition.archived']);
  });
});

describe('Messaggi FIPA-lite via file', () => {
  const message = (over: Partial<AgentMessage> & Pick<AgentMessage, 'from' | 'to'>): AgentMessage => ({
    id: `msg${Math.random().toString(36).slice(2, 12)}`, conversationId: 'conv-1', inReplyTo: null, act: 'inform', subject: 'ciao', body: 'testo',
    taskId: null, hops: 0, requiresReply: false, createdAt: Date.now(), ...over
  });
  const put = (s: Stack, agentId: string, name: string, content: unknown): void => {
    const dir = join(s.agentsDir, agentId, 'outbox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  };

  it('consegna nella inbox del destinatario, idempotente; mittente falso, JSON rotto e troppi passaggi rifiutati', async () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b'), 'owner', 'c2');
    const m = message({ from: 'alfa', to: 'beta', id: 'msg-uno-0001' });
    put(s, 'alfa', '001.json', m);
    put(s, 'alfa', '002.json', { ...m }); // stesso id: duplicato
    put(s, 'alfa', '003.json', message({ from: 'beta', to: 'alfa' })); // spacciato per beta
    put(s, 'alfa', '004.json', '{ rotto');
    put(s, 'alfa', '005.json', message({ from: 'alfa', to: 'beta', hops: 12 }));
    put(s, 'alfa', '006.json', message({ from: 'alfa', to: 'nessuno' }));
    expect(s.channel.scan()).toEqual({ accepted: 1, rejected: 4, duplicates: 1 });
    expect(s.channel.scan()).toEqual({ accepted: 0, rejected: 0, duplicates: 0 });
    const inbox = join(s.agentsDir, 'beta', 'inbox', 'msg-uno-0001.json');
    expect(JSON.parse(readFileSync(inbox, 'utf8'))).toMatchObject({ from: 'alfa', subject: 'ciao' });
    expect(readdirSync(join(s.agentsDir, 'alfa', 'outbox', 'rejected')).sort()).toEqual(['003.json', '004.json', '005.json', '006.json']);
    expect(existsSync(join(s.agentsDir, 'alfa', 'outbox', 'processed', '001.json'))).toBe(true);
    await s.h.bus.idle();
    const rejected = s.events('agent.message.rejected').map((e) => (e.payload as { problem: string }).problem);
    expect(rejected).toHaveLength(4);
    expect(rejected[0]).toMatch(/mittente dichiarato \(beta\) diverso dalla cartella \(alfa\)/);
    expect(rejected[2]).toMatch(/troppi passaggi/);
    expect(s.events('agent.message.sent')).toHaveLength(1);
  });

  it('proposta di sotto-task al Director dall\'agente assegnatario: accettata, eseguita, risposta in inbox', async () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b'), 'owner', 'c2');
    // Il passo di beta resta in corso e tiene aperto l'obiettivo mentre arriva la proposta di alfa.
    const out = s.director.submit({ goal: 'g', plan: { steps: [
      { key: 'a', title: 'Padre', spec: 'RISPOSTA:padre fatto', agentId: 'alfa' },
      { key: 'b', title: 'Aperto', spec: 'LENTO', agentId: 'beta' }
    ] } }, 'o', corr('corr-prop-0001'));
    await s.settle();
    const parent = tasksOf(s, out.rootTaskId)[0] as Task;
    expect(parent.status).toBe('succeeded');
    const proposal = message({ from: 'alfa', to: 'director', act: 'propose', taskId: parent.id, subject: 'sotto-task', body: JSON.stringify({ steps: [{ key: 'f', title: 'Figlio', spec: 'RISPOSTA:figlio fatto' }] }) });
    put(s, 'alfa', 'p1.json', proposal);
    put(s, 'alfa', 'p2.json', message({ ...proposal, id: 'msg-altro-0002', taskId: 'task-inventato' }));
    put(s, 'alfa', 'p3.json', message({ ...proposal, id: 'msg-altro-0003', from: 'alfa', taskId: tasksOf(s, out.rootTaskId)[1]?.id as string }));
    expect(s.channel.scan()).toMatchObject({ accepted: 3 });
    await s.settle();
    const child = s.engine.children(parent.id)[0];
    expect(child).toMatchObject({ title: 'Figlio', createdBy: 'agent:alfa', status: 'succeeded', result: { summary: 'figlio fatto' } });
    const replies = readdirSync(join(s.agentsDir, 'alfa', 'inbox')).map((n) => JSON.parse(readFileSync(join(s.agentsDir, 'alfa', 'inbox', n), 'utf8')) as AgentMessage);
    // Accettata solo quella sul proprio task: inventato e task di un altro agente rifiutati.
    expect(replies.map((r) => r.act).sort()).toEqual(['agree', 'refuse', 'refuse']);
    expect(replies.find((r) => r.act === 'agree')).toMatchObject({ from: 'director', to: 'alfa', inReplyTo: proposal.id, hops: 1 });
    expect(s.events('director.decision').map((e) => (e.payload as { decision: string }).decision)).toEqual(expect.arrayContaining(['proposal-accepted', 'proposal-rejected']));
  });
});

describe('Recupero dell\'orchestrazione dopo una caduta del core', () => {
  it('istanza aperta → stopped (sessione chiusa con l\'app), non crashed; task running → di nuovo in coda e completato da una nuova istanza con la sessione ripresa', async () => {
    const h = createRuntimeHarness();
    const first = createStack({ h });
    first.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = first.director.submit({ goal: 'g', plan: { steps: [{ key: 'a', title: 'Interrotto', spec: 'LENTO poi RISPOSTA:ripreso' }] } }, 'o', corr('corr-rec-00001'));
    await first.settle();
    expect(first.agents.status('alfa')).toBe('working');
    // Caduta: nessuno spegnimento ordinato. Nuovo "core" sullo stesso database, motore senza LENTO.
    first.director.stop();
    const second = createStack({ h, adapters: [fakeAdapter('motore-a')] });
    stacks.push(second);
    expect(second.agents.recover()).toBe(1);
    expect(second.engine.recover()).toMatchObject({ requeued: 1 });
    expect(second.agents.views({ includeArchived: false, breakerOf: () => 'closed' })[0]?.instance).toMatchObject({
      status: 'stopped',
      statusReason: 'sessione chiusa con l\'app precedente (processo non più controllato)'
    });
    second.adapters['motore-a']!.sendTurn = (async (ctx, input) => {
      ctx.emit({ kind: 'message.text', turnId: input.turnId, text: `ripreso con ${ctx.instance.session?.id ?? 'nessuna sessione'}`, final: true });
      return { outcome: 'completed', error: null, engineSessionId: 'ses-alfa' };
    });
    second.engine.schedule();
    await second.settle();
    const task = second.engine.list({ rootId: out.rootTaskId }).find((t) => t.kind === 'work');
    const firstSession = (h.db.prepare("SELECT id FROM agent_sessions WHERE agent_id = 'alfa' ORDER BY started_at LIMIT 1").get()?.id) as string;
    expect(task).toMatchObject({ status: 'succeeded', attempts: 2, result: { summary: `ripreso con ${firstSession}` } });
    expect(second.engine.get(out.rootTaskId)?.status).toBe('succeeded');
    // Il turno "fantasma" del primo core, se terminasse ora, non cambia più nulla.
    first.adapters['motore-a']?.pending.forEach((resolve) => resolve());
    await second.settle();
    expect(second.engine.get(task?.id as string)?.status).toBe('succeeded');
  });
});
