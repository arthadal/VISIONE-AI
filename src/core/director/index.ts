// Director (VISIONE_AGENT_ARCHITECTURE §9, DECISIONI P-37…P-41): orchestrazione ad alto livello,
// indipendente dal motore. Riceve un obiettivo, produce e valida il piano (esplicito, RulePlanner o
// AgentPlanner con ripiego), decide chi esegue ogni task (router), applica la policy alle azioni
// dichiarate (approvazioni del proprietario, blocchi), decide i nuovi tentativi, tiene il breaker
// degli agenti e riassume i risultati. Non esegue nulla da sé: l'esecuzione è del Task Engine.
// Non è un secondo bus: pubblica fatti con l'emitter e reagisce agli eventi del bus esistente.
import { join } from 'node:path';
import { type TaskStatus,
  DIRECTOR_ADDRESS,
  isTerminalTaskStatus,
  planSchema,
  taskError,
  validatePlan,
  type AgentDefinition,
  type AgentMessage,
  type BreakerLevel,
  type ChatRequestDto,
  type DirectorDecisionKind,
  type Language,
  type PlanInput,
  type PlannerKind,
  type PlanStep,
  type RouteCandidate,
  type Task,
  type TaskBudget,
  type TaskError,
  type TaskResult
} from '../../shared/contracts/index.ts';
import { splitAttachments } from '../../shared/lib/attachments.ts';
import { humanReason } from '../../shared/lib/human-reason.ts';
import type { Logger } from '../../shared/node/logging.ts';
import { resolveWorkspace, TRUST_ACTION, type AgentManager } from '../agents/index.ts';
import type { ApprovalQueue } from '../approvals/index.ts';
import type { AuditLog } from '../audit/index.ts';
import type { EventBus } from '../bus/index.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { EventEmitter } from '../events/index.ts';
import type { ActionPolicy } from '../policy/index.ts';
import { TaskEngineError, type Correlation, type Dispatch, type NewTask, type Retry, type TaskEngine, type TaskEngineHooks } from '../tasks/index.ts';
import { withoutFacts } from '../memory/index.ts';

export interface SubmitInput {
  goal: string;
  title?: string;
  plan?: PlanInput;
  plannerAgentId?: string;
}

export interface Director {
  submit(input: SubmitInput, by: string, corr: Correlation): { rootTaskId: string; planner: PlannerKind; taskIds: string[] };
  readonly hooks: TaskEngineHooks;
  breakerOf(agentId: string): BreakerLevel;
  /** Messaggio di un agente diretto al Director (già validato dal canale a file). */
  onMessage(message: AgentMessage): void;
  /** Sottoscrive gli eventi che fanno avanzare l'orchestrazione. */
  start(): void;
  stop(): void;
}

export interface DirectorDeps {
  engine: TaskEngine;
  agents: AgentManager;
  approvals: ApprovalQueue;
  policy: ActionPolicy;
  audit: AuditLog;
  events: EventEmitter;
  bus: EventBus;
  log: Logger;
  agentsDir: string;
  workspaceDir: string;
  /** Risposta a un messaggio di un agente (scritta nella sua `inbox\`). */
  reply?: (to: AgentMessage, act: 'agree' | 'refuse', body: string) => void;
  /** Soglie del breaker: guasti consecutivi per steer, constrain, open. */
  breaker?: { steer: number; constrain: number; open: number };
  /** Agente di ripiego per il limite di quota (P-83), dalla config; null = solo ricerca generica. */
  limitFallbackAgentId?: string | null;
  /**
   * Chi comanda (P-105): l'agente che pianifica quando l'invio non indica né piano né pianificatore.
   * Letto a ogni invio (si cambia dalla procedura guidata senza riavvio); vuoto o archiviato = regole.
   */
  defaultPlannerAgentId?: () => string;
}

const SOURCE = { kind: 'director', id: 'director' } as const;
/** Codici per cui un nuovo tentativo non cambierebbe l'esito. */
const FINAL_ERRORS: ReadonlySet<TaskError['code']> = new Set(['policy_blocked', 'approval_denied', 'invalid_plan']);
const LEVEL_RANK: Record<BreakerLevel, number> = { closed: 0, steer: 1, constrain: 2, open: 3 };

/** RulePlanner: un obiettivo → un task al miglior agente (sempre disponibile). */
export function rulePlan(goal: string, title: string): NewTask[] {
  return [{ key: 'task', kind: 'work', title, spec: goal }];
}

/** Testo chiesto all'agente pianificatore: deve rispondere con un piano JSON validato con zod. */
export function planningPrompt(goal: string, agents: readonly AgentDefinition[], plannerId: string | null = null): string {
  const others = agents.filter((a) => a.id !== plannerId);
  return [
    'Sei il pianificatore di VISIONE. Scomponi l\'obiettivo in al più 5 passi eseguibili da questi agenti.',
    // 24/10/2026, dal proprietario: «deve orchestrare». Il piano dava ogni passo al pianificatore stesso.
    ...(plannerId && others.length > 0
      ? [
          `Tu (${plannerId}) coordini la squadra: dai ogni passo all'agente con la competenza giusta (agentId) e tieni per te solo ciò che nessun collega sa fare o la sintesi finale.`,
          'Quando il lavoro ha parti diverse (cercare, fare, controllare), usa più agenti; per una domanda semplice basta un passo all\'agente più adatto.'
        ]
      : []),
    '',
    `Obiettivo: ${goal}`,
    '',
    'Agenti disponibili (id · competenze · ruolo):',
    ...agents.map((a) => `- ${a.id} · ${a.competences.join(', ')} · ${a.role.slice(0, 200)}`),
    '',
    'Rispondi SOLO con un oggetto JSON, senza altro testo:',
    '{"steps":[{"key":"s1","title":"…","spec":"…","agentId":"<id facoltativo>","agents":["<id1>","<id2>"],"competence":"code|general|reasoning|review|research","dependsOn":[]}]}',
    'Usa "agents" (più id) per distribuire lo stesso passo a più agenti in parallelo; in quel caso non usare "agentId".'
  ].join('\n');
}

/** Estrae e valida il piano dal testo di un agente: `null` + motivo se non è valido. */
export function parseAgentPlan(text: string, known: ReadonlySet<string>): { ok: true; steps: PlanStep[] } | { ok: false; problem: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, problem: 'nessun oggetto JSON nella risposta' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { ok: false, problem: `JSON non valido: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: `piano non conforme: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`.slice(0, 300) };
  const dag = validatePlan(parsed.data.steps);
  if (!dag.ok) return { ok: false, problem: dag.problems.join('; ').slice(0, 300) };
  const unknown = parsed.data.steps.find((s) => (s.agentId !== undefined && !known.has(s.agentId)) || (s.agents ?? []).some((a) => !known.has(a)));
  if (unknown) return { ok: false, problem: `agente sconosciuto nel piano: ${unknown.agentId ?? (unknown.agents ?? []).find((a) => !known.has(a)) ?? '?'}` };
  return { ok: true, steps: parsed.data.steps };
}

/** Chiave sintetica di un figlio del fan-out: stabile e unica rispetto al passo base. */
export function fanKey(key: string, index: number): string {
  return `${key}__${index}`;
}

export function stepsToTasks(steps: readonly PlanStep[]): NewTask[] {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  /** Chiavi finali di un passo: i figli del fan-out, oppure la chiave stessa. */
  const terminals = (key: string): string[] => {
    const s = byKey.get(key);
    const count = s?.agents?.length ?? 0;
    return count > 0 ? Array.from({ length: count }, (_, i) => fanKey(key, i)) : [key];
  };
  const budget = (s: PlanStep): Partial<TaskBudget> => ({ ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}), ...(s.maxAttempts ? { maxAttempts: s.maxAttempts } : {}) });
  const out: NewTask[] = [];
  for (const s of steps) {
    // Le dipendenze si agganciano ai risultati finali: per un fan-out, a tutti i suoi figli.
    const dependsOn = s.dependsOn.flatMap(terminals);
    if (s.agents && s.agents.length > 0) {
      s.agents.forEach((agentId, i) => {
        out.push({
          key: fanKey(s.key, i), kind: 'work', title: `${s.title} [${agentId}]`.slice(0, 200), spec: s.spec,
          acceptance: s.acceptance ?? null, assigneeAgentId: agentId, competence: s.competence ?? null,
          dependsOn, actions: s.actions, priority: s.priority, budget: budget(s)
        });
      });
    } else {
      out.push({
        key: s.key, kind: 'work', title: s.title, spec: s.spec,
        acceptance: s.acceptance ?? null, assigneeAgentId: s.agentId ?? null, competence: s.competence ?? null,
        dependsOn, actions: s.actions, priority: s.priority, budget: budget(s)
      });
    }
  }
  return out;
}

export function createDirector(deps: DirectorDeps): Director {
  const { engine, agents, approvals, policy, audit, events, bus, log } = deps;
  const thresholds = deps.breaker ?? { steer: 2, constrain: 3, open: 4 };
  const breakers = new Map<string, { failures: number; level: BreakerLevel }>();
  let subscription: { unsubscribe(): void } | null = null;

  const decide = (decision: DirectorDecisionKind, task: Pick<Task, 'id' | 'rootId' | 'correlationId'> | null, agentId: string | null, reason: string, candidates: RouteCandidate[] = [], correlationId?: string): void => {
    events.emit('director.decision', {
      rootTaskId: task?.rootId ?? null, taskId: task?.id ?? null, decision, agentId, reason: reason.slice(0, 500), candidates: candidates.slice(0, 20)
    }, {
      source: SOURCE, target: agentId ? { kind: 'agent', id: agentId } : task ? { kind: 'task', id: task.id } : null,
      ...(task || correlationId ? { correlationId: correlationId ?? task?.correlationId } : {})
    });
  };

  const levelOf = (agentId: string): BreakerLevel => breakers.get(agentId)?.level ?? 'closed';

  const setBreaker = (agentId: string, failures: number, reason: string): void => {
    const prev = breakers.get(agentId) ?? { failures: 0, level: 'closed' as BreakerLevel };
    const level: BreakerLevel = failures >= thresholds.open ? 'open' : failures >= thresholds.constrain ? 'constrain' : failures >= thresholds.steer ? 'steer' : 'closed';
    breakers.set(agentId, { failures, level });
    if (level === prev.level) return;
    events.emit('agent.breaker.changed', { agentId, from: prev.level, to: level, failures, reason: reason.slice(0, 200) }, {
      source: SOURCE, target: { kind: 'agent', id: agentId }, ...(level === 'closed' ? { severity: 'info' as const } : {})
    });
    if (LEVEL_RANK[level] <= LEVEL_RANK[prev.level]) return;
    decide('breaker', null, agentId, `breaker ${prev.level} → ${level} dopo ${failures} errori consecutivi`);
    audit.record({ actor: 'director', action: 'agent.breaker', subject: agentId, decision: level, detail: reason });
    if (level === 'steer') {
      void agents.steer(agentId, 'VISIONE: gli ultimi tentativi sono falliti. Rileggi il compito, procedi per passi piccoli e verifica il risultato.').catch(() => false);
    } else if (level === 'open') {
      void agents.stop(agentId, { mode: 'graceful', reason: `breaker aperto dopo ${failures} errori consecutivi`, by: 'director' }).catch((err: unknown) => log.warn('stop per breaker non riuscito', { agentId, err }));
    }
  };

  const failure = (agentId: string, reason: string): void => setBreaker(agentId, (breakers.get(agentId)?.failures ?? 0) + 1, reason);

  /** Router: competenza dichiarata, disponibilità, carico, storico errori; ordine stabile per id. */
  const route = (task: Task, busy: ReadonlySet<string>, exclude: ReadonlySet<string> = new Set()): { agentId: string | null; candidates: RouteCandidate[]; anyCompatible: boolean } => {
    const defs = agents.active();
    const load = new Map<string, number>();
    for (const t of engine.list({ status: ['queued', 'running', 'waiting'], limit: 200 })) {
      if (t.assigneeAgentId && t.id !== task.id) load.set(t.assigneeAgentId, (load.get(t.assigneeAgentId) ?? 0) + 1);
    }
    let anyCompatible = false;
    const candidates: RouteCandidate[] = defs.map((d) => {
      const compatible = task.competence === null || d.competences.includes(task.competence);
      if (compatible && !exclude.has(d.id)) anyCompatible = true;
      const failures = breakers.get(d.id)?.failures ?? 0;
      const excluded = !compatible ? `competenza ${task.competence} assente`
        : exclude.has(d.id) ? 'escluso dopo un errore'
        : LEVEL_RANK[levelOf(d.id)] >= LEVEL_RANK.constrain ? `breaker ${levelOf(d.id)}`
        : busy.has(d.id) || agents.isBusy(d.id) ? 'occupato'
        : null;
      const score = (task.competence !== null && compatible ? 10 : 0) - (load.get(d.id) ?? 0) - failures * 5;
      return { agentId: d.id, score, excluded };
    });
    const best = candidates.filter((c) => c.excluded === null).sort((a, b) => b.score - a.score || (a.agentId < b.agentId ? -1 : 1))[0];
    return { agentId: best?.agentId ?? null, candidates, anyCompatible };
  };

  /** Policy sulle azioni dichiarate dal task, con le radici dell'agente scelto. */
  const gate = (task: Task, agent: AgentDefinition): Dispatch | null => {
    const roots = [resolveWorkspace(agent, deps.workspaceDir), join(deps.agentsDir, agent.id)];
    for (const action of task.actions) {
      const verdict = policy.classify(action, { actor: 'director', roots });
      if (verdict.class === 'block') {
        audit.record({ actor: 'director', action: `blocked:${action.kind}`, subject: action.target.slice(0, 200), decision: 'block', detail: `${task.id}: ${verdict.reason}`, correlationId: task.correlationId });
        decide('block', task, agent.id, verdict.reason);
        return { kind: 'fail', error: taskError('policy_blocked', verdict.reason) };
      }
      if (verdict.class === 'approval' && !approvals.isGranted(action.kind, action.target)) {
        const asked = approvals.request({
          kind: action.kind, target: action.target, reason: `${task.title}: ${verdict.reason}`, requestedBy: 'director', taskId: task.id, agentId: agent.id,
          correlationId: task.correlationId
        });
        decide('wait-approval', task, agent.id, `${verdict.reason} (richiesta ${asked.approval.id})`);
        return { kind: 'wait', approvalId: asked.approval.id, reason: `attesa dell'approvazione ${asked.approval.id}` };
      }
    }
    return null;
  };

  const hooks: TaskEngineHooks = {
    prepare(task, busy) {
      // Agente fissato (dal piano o da un tentativo precedente): solo lui; altrimenti il router.
      if (task.assigneeAgentId !== null) {
        const def = agents.get(task.assigneeAgentId);
        if (!def) return { kind: 'fail', error: taskError('no_agent', `agente ${task.assigneeAgentId} non disponibile (sconosciuto o archiviato)`) };
        if (busy.has(def.id) || agents.isBusy(def.id)) return { kind: 'defer', reason: 'agente occupato' };
        if (LEVEL_RANK[levelOf(def.id)] >= LEVEL_RANK.open) return { kind: 'fail', error: taskError('agent_unavailable', `breaker aperto per ${def.id}`) };
        const blocked = gate(task, def);
        if (blocked) return blocked;
        decide('assign', task, def.id, task.attempts === 0 ? 'agente indicato nel piano' : `nuovo tentativo con ${def.id}`);
        return { kind: 'run', agentId: def.id, reason: 'agente indicato' };
      }
      const r = route(task, busy);
      if (!r.agentId) {
        if (!r.anyCompatible) {
          decide('fail', task, null, 'nessun agente compatibile', r.candidates);
          return { kind: 'fail', error: taskError('no_agent', task.competence ? `nessun agente con competenza ${task.competence}` : 'nessun agente definito') };
        }
        return { kind: 'defer', reason: 'agenti compatibili occupati o sospesi' };
      }
      const def = agents.get(r.agentId) as AgentDefinition;
      const blocked = gate(task, def);
      if (blocked) return blocked;
      decide('assign', task, def.id, `scelto dal router (punteggio ${r.candidates.find((c) => c.agentId === def.id)?.score ?? 0})`, r.candidates);
      return { kind: 'run', agentId: def.id, reason: 'scelto dal router' };
    },

    onAttemptFailed(task, error, canRetry): Retry {
      const agentId = task.assigneeAgentId;
      if (agentId) failure(agentId, `${task.id}: ${error.code}`);
      if (!canRetry) {
        decide('fail', task, agentId, `tentativi esauriti (${task.attempts}/${task.budget.maxAttempts}) dopo ${error.code}`);
        return { kind: 'fail', reason: `tentativi esauriti: ${error.message}`.slice(0, 200) };
      }
      if (FINAL_ERRORS.has(error.code)) {
        decide('fail', task, agentId, `errore definitivo: ${error.code}`);
        return { kind: 'fail', reason: error.message };
      }
      // Limite di quota del motore (P-83): la stessa specifica passa subito a un agente di un motore
      // diverso (preferito quello indicato dalla config), senza ritentare il motore esaurito.
      if (error.runtimeCode === 'limit_reached') {
        const fallback = agents.fallback({
          exclude: new Set(agentId ? [agentId] : []),
          ...(deps.limitFallbackAgentId ? { preferred: deps.limitFallbackAgentId } : {})
        });
        if (fallback) {
          audit.record({
            actor: 'director', action: 'director.limit-fallback', subject: task.id, decision: 'reassign',
            detail: `${agentId ?? '—'} → ${fallback.agentId}: ${error.message}`.slice(0, 500), correlationId: task.correlationId
          });
          decide('reassign', task, fallback.agentId, `limite del motore raggiunto su ${agentId ?? '—'}: riassegnato a ${fallback.agentId} (${fallback.reason})`);
          return { kind: 'retry', agentId: fallback.agentId, reason: `limite raggiunto: riassegnato a ${fallback.agentId}` };
        }
        decide('fail', task, agentId, `limite del motore raggiunto e nessun agente alternativo disponibile`);
        return { kind: 'fail', reason: `limite raggiunto su ${agentId ?? '—'} e nessun agente di ripiego` };
      }
      // Primo fallimento: stesso agente (1×); poi un altro agente compatibile se il piano non lo fissa.
      if (agentId && task.attempts <= 1 && LEVEL_RANK[levelOf(agentId)] < LEVEL_RANK.constrain) {
        decide('retry', task, agentId, `nuovo tentativo con lo stesso agente dopo ${error.code}`);
        return { kind: 'retry', agentId, reason: `stesso agente dopo ${error.code}` };
      }
      const r = route({ ...task, assigneeAgentId: null }, new Set(), new Set(agentId ? [agentId] : []));
      if (r.agentId) {
        decide('reassign', task, r.agentId, `riassegnato dopo ${error.code} di ${agentId ?? '?'}`, r.candidates);
        return { kind: 'retry', agentId: r.agentId, reason: `altro agente compatibile: ${r.agentId}` };
      }
      if (agentId && LEVEL_RANK[levelOf(agentId)] < LEVEL_RANK.constrain) {
        decide('retry', task, agentId, `nessun altro agente compatibile: di nuovo ${agentId}`);
        return { kind: 'retry', agentId, reason: 'nessun altro agente compatibile' };
      }
      decide('fail', task, agentId, `nessun agente per un nuovo tentativo dopo ${error.code}`);
      return { kind: 'fail', reason: error.message };
    },

    onAttemptSucceeded(_task, agentId) {
      if ((breakers.get(agentId)?.failures ?? 0) > 0) setBreaker(agentId, 0, 'turno riuscito');
    },

    expand(task: Task, result: TaskResult): NewTask[] {
      const root = engine.get(task.rootId);
      const known = new Set(agents.active().map((a) => a.id));
      const parsed = parseAgentPlan(result.summary, known);
      if (parsed.ok) {
        // Il pianificatore che si tiene un passo di una competenza che lui non ha e un collega sì: il passo va al
        // collega (il router sceglie per competenza). 24/10/2026: il piano dava tutto al Director.
        const planner = task.assigneeAgentId;
        const self = planner ? agents.get(planner) : null;
        const team = agents.active().filter((a) => a.id !== planner);
        const steps = parsed.steps.map((s) => {
          if (!self || s.agentId !== planner || !s.competence || self.competences.includes(s.competence)) return s;
          if (!team.some((a) => a.competences.includes(s.competence!))) return s;
          decide('reassign', task, null, `passo «${s.title}» (${s.competence}) dal pianificatore a un collega con la competenza`);
          const { agentId: _drop, ...rest } = s;
          return rest;
        });
        const tasks = stepsToTasks(steps);
        events.emit('director.plan.created', { rootTaskId: task.rootId, planner: 'agent', taskIds: [], fallback: null }, { source: SOURCE, target: { kind: 'task', id: task.rootId }, correlationId: task.correlationId });
        return tasks;
      }
      decide('plan-fallback', task, task.assigneeAgentId, `piano dell'agente non valido: ${parsed.problem}`);
      events.emit('director.plan.created', { rootTaskId: task.rootId, planner: 'rule', taskIds: [], fallback: parsed.problem }, { source: SOURCE, target: { kind: 'task', id: task.rootId }, correlationId: task.correlationId });
      return rulePlan(root?.spec ?? task.spec, root?.title ?? task.title);
    }
  };

  const summarize = (root: Task): void => {
    const tasks = engine.list({ rootId: root.id, limit: 200 }).filter((t) => t.kind !== 'goal').reverse();
    const count = (s: Task['status']): number => tasks.filter((t) => t.status === s).length;
    const lines = tasks.map((t) => `- ${t.title} (${t.assigneeAgentId ?? '—'}): ${t.status}${t.result ? ` — ${t.result.summary.replace(/\s+/g, ' ').slice(0, 300)}` : t.error ? ` — ${t.error.message}` : ''}`);
    const outcome = root.status === 'succeeded' ? 'succeeded' : root.status === 'cancelled' ? 'cancelled' : 'failed';
    // La risposta vera: l'esito dell'ultimo passo riuscito che non sia il piano (è ciò che la voce legge).
    const last = [...tasks].reverse().find((t) => t.kind !== 'plan' && t.status === 'succeeded' && t.result);
    events.emit('director.summary', {
      rootTaskId: root.id, outcome,
      counts: { total: tasks.length, succeeded: count('succeeded'), failed: count('failed'), cancelled: count('cancelled'), timedOut: count('timed_out'), blocked: count('blocked') },
      text: [`Obiettivo "${root.title}": ${outcome}.`, ...lines].join('\n').slice(0, 4_000),
      // Senza le righe MEMORIA: sono appunti per gli altri agenti, non la risposta al proprietario.
      answer: last?.result ? withoutFacts(last.result.summary).slice(0, 4_000) || null : null
    }, { source: SOURCE, target: { kind: 'user', id: 'owner' }, correlationId: root.correlationId });
  };

  const onApproval = (approvalId: string, granted: boolean, causationId: string): void => {
    const approval = approvals.get(approvalId);
    if (!approval) return;
    const waiting = engine.list({ status: ['waiting'], limit: 200 });
    for (const t of waiting) {
      const ref = t.waitingOn?.kind === 'approval' ? approvals.get(t.waitingOn.ref) : null;
      const same = t.waitingOn?.ref === approvalId || (ref !== null && ref.kind === approval.kind && ref.target === approval.target);
      if (!same) continue;
      if (granted) {
        engine.resume(t.id, `approvazione ${approvalId} concessa`, { correlationId: t.correlationId, causationId });
      } else if (t.waitingOn?.ref === approvalId) {
        decide('fail', t, t.assigneeAgentId, `approvazione ${approvalId} negata dal proprietario`);
        engine.fail(t.id, taskError('approval_denied', `il proprietario ha negato: ${approval.kind} ${approval.target}`.slice(0, 500)), { correlationId: t.correlationId, causationId });
      }
    }
    // Fiducia negata: l'istanza in attesa non ha più motivo di restare aperta.
    if (!granted && approval.kind === TRUST_ACTION && approval.agentId && agents.status(approval.agentId) === 'waiting') {
      void agents.stop(approval.agentId, { mode: 'force', reason: 'fiducia nella cartella negata dal proprietario', by: 'director' });
    }
  };

  /** Il pianificatore scelto dal proprietario, se esiste ancora (P-105). */
  const defaultPlanner = (): string | null => {
    const id = deps.defaultPlannerAgentId?.().trim() ?? '';
    return id && agents.get(id) ? id : null;
  };

  const director: Director = {
    submit(input, by, corr) {
      const asked = splitAttachments(input.goal);
      const title = (input.title ?? (asked.text || asked.files.map((f) => f.name).join(', ')).replace(/\s+/g, ' ').slice(0, 80)).slice(0, 200);
      let planner: PlannerKind;
      let steps: NewTask[];
      if (input.plan) {
        planner = 'explicit';
        const parsed = planSchema.safeParse(input.plan);
        if (!parsed.success) throw new CommandFailure('invalid_payload', 'piano non valido');
        const unknown = parsed.data.steps.find((s) => (s.agentId !== undefined && !agents.get(s.agentId)) || (s.agents ?? []).some((a) => !agents.get(a)));
        if (unknown) throw new CommandFailure('invalid_payload', `agente sconosciuto o archiviato nel piano: ${unknown.agentId ?? (unknown.agents ?? []).find((a) => !agents.get(a)) ?? '?'}`);
        steps = stepsToTasks(parsed.data.steps);
      } else if (input.plannerAgentId) {
        planner = 'agent';
        if (!agents.get(input.plannerAgentId)) throw new CommandFailure('invalid_payload', `agente pianificatore sconosciuto: ${input.plannerAgentId}`);
        steps = [{ key: 'plan', kind: 'plan', title: `Piano: ${title}`.slice(0, 200), spec: planningPrompt(input.goal, agents.active(), input.plannerAgentId), assigneeAgentId: input.plannerAgentId }];
      } else if (defaultPlanner()) {
        planner = 'agent';
        steps = [{ key: 'plan', kind: 'plan', title: `Piano: ${title}`.slice(0, 200), spec: planningPrompt(input.goal, agents.active(), defaultPlanner()!), assigneeAgentId: defaultPlanner()! }];
      } else {
        planner = 'rule';
        steps = rulePlan(input.goal, title);
      }
      try {
        const out = engine.createGoal({ title, spec: input.goal, createdBy: by, steps }, corr);
        events.emit('director.goal.received', { rootTaskId: out.root.id, planner, chars: input.goal.length, by }, {
          source: SOURCE, target: { kind: 'task', id: out.root.id }, correlationId: corr.correlationId, causationId: corr.causationId ?? null
        });
        events.emit('director.plan.created', { rootTaskId: out.root.id, planner, taskIds: out.tasks.map((t) => t.id), fallback: null }, {
          source: SOURCE, target: { kind: 'task', id: out.root.id }, correlationId: corr.correlationId, causationId: corr.causationId ?? null
        });
        audit.record({ actor: by, action: 'director.submit', subject: out.root.id, decision: planner, detail: `${title} (${out.tasks.length} task)`, correlationId: corr.correlationId });
        return { rootTaskId: out.root.id, planner, taskIds: out.tasks.map((t) => t.id) };
      } catch (err) {
        if (err instanceof TaskEngineError) throw new CommandFailure('invalid_payload', err.message);
        throw err;
      }
    },

    hooks,

    breakerOf: levelOf,

    onMessage(message) {
      if (message.act !== 'propose') return;
      const refuse = (reason: string): void => {
        decide('proposal-rejected', null, message.from, reason, [], message.conversationId);
        deps.reply?.(message, 'refuse', reason);
      };
      const task = message.taskId ? engine.get(message.taskId) : null;
      if (!task) return refuse('proposta senza un task valido');
      if (task.assigneeAgentId !== message.from) return refuse(`il task ${task.id} non è assegnato a ${message.from}`);
      let raw: unknown;
      try {
        raw = JSON.parse(message.body);
      } catch {
        return refuse('il corpo della proposta non è un piano JSON');
      }
      const parsed = planSchema.safeParse(raw);
      if (!parsed.success) return refuse('piano proposto non conforme');
      try {
        const added = engine.addTasks(task.id, stepsToTasks(parsed.data.steps), `agent:${message.from}`, { correlationId: task.correlationId });
        decide('proposal-accepted', task, message.from, `${added.length} sotto-task proposti da ${message.from}`);
        deps.reply?.(message, 'agree', `accettati ${added.length} sotto-task: ${added.map((t) => t.id).join(', ')}`);
      } catch (err) {
        refuse(err instanceof Error ? err.message : String(err));
      }
    },

    start() {
      if (subscription) return;
      subscription = bus.subscribe((event) => {
        try {
          if (event.type === 'approval.granted' || event.type === 'approval.denied') {
            const p = event.payload as { approvalId: string };
            onApproval(p.approvalId, event.type === 'approval.granted', event.id);
          } else if (event.type === 'task.status.changed') {
            const p = event.payload as { taskId: string; kind: Task['kind']; to: Task['status'] };
            if (p.kind === 'goal' && isTerminalTaskStatus(p.to)) {
              const root = engine.get(p.taskId);
              if (root) summarize(root);
            } else if (p.to === 'timed_out') {
              const t = engine.get(p.taskId);
              if (t?.assigneeAgentId) failure(t.assigneeAgentId, `${t.id}: timeout`);
            }
          }
        } catch (err) {
          log.error('reazione del Director a un evento non riuscita', { type: event.type, err });
        }
      }, { name: 'director', filter: { types: ['approval.granted', 'approval.denied', 'task.status.changed'] } });
    },

    stop() {
      subscription?.unsubscribe();
      subscription = null;
    }
  };
  return director;
}

/**
 * Messaggio diretto del proprietario a un agente (Fase 21, P-67): una radice con un solo passo
 * assegnato a quell'agente. Non passa dal Director: nessuna pianificazione e nessun router — esegue
 * la sessione reale dell'agente scelto. Errore esplicito se l'agente non esiste o è archiviato.
 */
export function tellAgent(deps: { engine: TaskEngine; agents: AgentManager }, input: { agentId: string; text: string; title?: string; by: string }, corr: Correlation): { agentId: string; taskId: string; taskIds: string[] } {
  if (!deps.agents.get(input.agentId)) throw new CommandFailure('not_found', `agente sconosciuto o archiviato: ${input.agentId}`);
  const title = (input.title ?? `Messaggio a ${input.agentId}`).slice(0, 200);
  const out = deps.engine.createGoal({
    title,
    spec: input.text,
    // «:tell»: un messaggio a un agente (o la prova della guidata), non una richiesta della chat con VISIONE.
    createdBy: `owner:${input.by}:tell`,
    steps: [{ key: 'msg', kind: 'work', title, spec: input.text, assigneeAgentId: input.agentId }]
  }, corr);
  return { agentId: input.agentId, taskId: out.root.id, taskIds: out.tasks.map((t) => t.id) };
}

/**
 * «@nome …» all'inizio di una richiesta nella chat con VISIONE (24/10/2026, dal proprietario: «in chat devo poter
 * interagire con gli agenti»): il passo va a quell'agente, senza piano. Nome o id, maiuscole e spazi non contano.
 */
export function addressedAgent(goal: string, agents: readonly { id: string; name: string }[]): { agentId: string; text: string } | null {
  const m = /^\s*@([\p{L}\p{N}_.-]+)[\s,:]+([\s\S]+)$/u.exec(goal);
  if (!m) return null;
  const key = m[1]!.toLowerCase();
  const flat = (s: string): string => s.toLowerCase().replace(/\s+/g, '');
  const hit = agents.find((a) => flat(a.id) === key || flat(a.name) === key);
  const text = m[2]!.trim();
  return hit && text !== '' ? { agentId: hit.id, text } : null;
}

/**
 * Messaggi a un agente salvati prima del segno «:tell» (fino alla beta.30): la prova della guidata e i messaggi dal
 * pannello di un agente, col titolo che dà VISIONE stessa. Chi aggiorna non li vede nella chat con VISIONE.
 */
const LEGACY_TELL_TITLES = /^(?:Verifica della procedura guidata|Setup wizard check|Messaggio a [\w.-]+)$/;

/** Le richieste della chat con VISIONE: scritte o dette dal proprietario al Director (né gruppi, né messaggi a un agente). */
export function isOwnerRequest(createdBy: string, title = ''): boolean {
  if (LEGACY_TELL_TITLES.test(title)) return false;
  return createdBy === 'voice' || (createdBy.startsWith('owner') && createdBy !== 'owner:group' && !createdBy.endsWith(':tell'));
}

/**
 * La chat con VISIONE dal database (23/10/2026): le ultime richieste del proprietario, dalla più vecchia, con la risposta
 * vera (l'ultimo passo riuscito, come nel resoconto del Director) o il primo motivo di un insuccesso.
 */
export function ownerConversation(engine: TaskEngine, limit = 50, opts: { lang?: Language; clearedAt?: number } = {}): ChatRequestDto[] {
  const lang = opts.lang ?? 'it';
  const from = opts.clearedAt ?? 0;
  const roots = engine.list({ rootsOnly: true, limit: 200 })
    .filter((r) => isOwnerRequest(r.createdBy, r.title) && r.createdAt > from).slice(0, limit);
  return roots.reverse().map((root): ChatRequestDto => {
    const voice = root.createdBy === 'voice' || root.createdBy === 'owner:voice';
    // Il testo intero, non il titolo di 80 caratteri (24/10/2026); a voce lo spec è il prompt costruito: vale il titolo.
    const asked = voice ? { text: root.title, files: [] } : splitAttachments(root.spec);
    const base = { id: root.id, at: root.createdAt, text: (asked.text || root.title).slice(0, 4_000), files: asked.files, voice };
    const ended = root.endedAt ?? root.updatedAt;
    if (root.status === 'succeeded') {
      const steps = engine.list({ rootId: root.id, limit: 200 }).filter((t) => t.kind !== 'goal' && t.kind !== 'plan');
      const last = steps.find((t) => t.status === 'succeeded' && t.result);
      const answer = last?.result ? withoutFacts(last.result.summary).slice(0, 4_000) : '';
      return { ...base, status: 'succeeded', answer: answer || null, reason: null, answeredAt: ended };
    }
    if (root.status === 'cancelled') return { ...base, status: 'cancelled', answer: null, reason: null, answeredAt: ended };
    if (root.status === 'failed' || root.status === 'timed_out') {
      const failedStep = engine.list({ rootId: root.id, limit: 200 }).reverse().find((t) => t.kind !== 'goal' && t.error);
      // Il motivo come lo direbbe una persona (24/10/2026), non il messaggio tecnico.
      const reason = humanReason(failedStep?.error ?? root.error, lang).slice(0, 300);
      return { ...base, status: 'failed', answer: null, reason, answeredAt: ended };
    }
    return { ...base, status: 'open', answer: null, reason: null, answeredAt: null };
  });
}

export function registerDirectorCommands(deps: {
  router: CommandRouter; director: Director; engine: TaskEngine; approvals: ApprovalQueue; audit: AuditLog; agents: AgentManager;
  /** Lingua dei motivi nella chat con VISIONE; senza, italiano. */
  language?: () => Language;
  /** Da quando si mostra la chat con VISIONE («Svuota chat»); senza, da sempre. */
  chatClearedAt?: () => number;
}): void {
  const { router, director, engine, approvals, audit, agents } = deps;
  router.register('director.submit', (payload, ctx) => {
    const direct = payload.plan ? null : addressedAgent(payload.goal, agents.active());
    const title = payload.title ?? (direct ? direct.text.replace(/\s+/g, ' ').slice(0, 80) : undefined);
    const plan = payload.plan ?? (direct ? { steps: [{ key: 'risposta', title: title!, spec: direct.text, agentId: direct.agentId }] } : undefined);
    const out = director.submit(
      { goal: payload.goal, ...(title ? { title } : {}), ...(plan ? { plan } : {}), ...(payload.plannerAgentId ? { plannerAgentId: payload.plannerAgentId } : {}) },
      `owner:${ctx.command.issuedBy}`,
      { correlationId: ctx.command.correlationId, causationId: ctx.command.id }
    );
    return { ...out, correlationId: ctx.command.correlationId };
  });
  // Chat diretta (Fase 21, P-67): il proprietario parla a UN agente, senza Director.
  router.register('agents.tell', (payload, ctx) => tellAgent({ engine, agents }, {
    agentId: payload.agentId,
    text: payload.text,
    ...(payload.title ? { title: payload.title } : {}),
    by: ctx.command.issuedBy
  }, { correlationId: ctx.command.correlationId, causationId: ctx.command.id }));
  router.register('chat.history', (payload) => ({
    requests: ownerConversation(engine, payload.limit ?? 50, { lang: deps.language?.() ?? 'it', clearedAt: deps.chatClearedAt?.() ?? 0 })
  }));
  router.register('tasks.list', (payload) => ({
    tasks: engine.list({ ...(payload.rootId ? { rootId: payload.rootId } : {}), ...(payload.status ? { status: payload.status } : {}), rootsOnly: payload.rootsOnly, limit: payload.limit })
  }));
  router.register('tasks.get', (payload) => {
    const task = engine.get(payload.taskId);
    if (!task) throw new CommandFailure('not_found', `task sconosciuto: ${payload.taskId}`);
    return { task, children: engine.children(task.id) };
  });
  router.register('tasks.cancel', (payload, ctx) => {
    if (!engine.get(payload.taskId)) throw new CommandFailure('not_found', `task sconosciuto: ${payload.taskId}`);
    const out = engine.cancel(payload.taskId, payload.reason ?? `annullato dal proprietario (${ctx.command.issuedBy})`, `owner:${ctx.command.issuedBy}`, {
      correlationId: ctx.command.correlationId, causationId: ctx.command.id
    });
    return { taskId: payload.taskId, ...out };
  });
  // «Interrompi» (12/10/2026): i task non conclusi di un agente, o tutti gli obiettivi del Director.
  const OPEN: readonly TaskStatus[] = ['created', 'queued', 'running', 'waiting', 'blocked'];
  router.register('agents.interrupt', (payload, ctx) => {
    const reason = payload.reason ?? `interrotto dal proprietario (${ctx.command.issuedBy})`;
    const corr = { correlationId: ctx.command.correlationId, causationId: ctx.command.id };
    const cancelled = new Set<string>();
    for (const t of engine.list({ status: OPEN, limit: 500 })) {
      if (t.assigneeAgentId !== payload.agentId) continue;
      for (const id of engine.cancel(t.id, reason, `owner:${ctx.command.issuedBy}`, corr).cancelled) cancelled.add(id);
    }
    return { agentId: payload.agentId, cancelled: [...cancelled] };
  });
  router.register('director.interrupt', (payload, ctx) => {
    const reason = payload.reason ?? `interrotto dal proprietario (${ctx.command.issuedBy})`;
    const corr = { correlationId: ctx.command.correlationId, causationId: ctx.command.id };
    const goals = engine.list({ rootsOnly: true, status: OPEN, limit: 200 });
    const cancelled = new Set<string>();
    for (const g of goals) for (const id of engine.cancel(g.id, reason, `owner:${ctx.command.issuedBy}`, corr).cancelled) cancelled.add(id);
    return { cancelled: [...cancelled], goals: goals.length };
  });
  router.register('approvals.list', (payload) => ({ approvals: approvals.list({ ...(payload.status ? { status: payload.status } : {}), limit: payload.limit }) }));
  router.register('approvals.decide', (payload, ctx) => {
    // Solo il proprietario decide: mai il sistema, mai un agente.
    if (ctx.command.issuedBy !== 'ui') throw new CommandFailure('forbidden', 'solo il proprietario (UI) decide le approvazioni');
    const out = approvals.decide(payload.approvalId, payload.decision, 'owner', {
      ...(payload.note ? { note: payload.note } : {}), correlationId: ctx.command.correlationId, causationId: ctx.command.id
    });
    if (!out) throw new CommandFailure('not_found', `richiesta sconosciuta: ${payload.approvalId}`);
    return out;
  });
  router.register('audit.list', (payload) => ({ entries: audit.list(payload.limit), chain: audit.verify() }));
}

export { DIRECTOR_ADDRESS };
