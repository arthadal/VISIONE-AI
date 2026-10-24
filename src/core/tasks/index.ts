// Task Engine (VISIONE_AGENT_ARCHITECTURE §10, DECISIONI P-37): esecuzione deterministica dei task.
// Unico proprietario di `tasks`, `task_dependencies`, `task_results`. Ogni transizione passa da un
// solo punto, è validata con `TASK_TRANSITIONS` e scritta con il suo evento `task.*` nella stessa
// transazione. Le decisioni (chi esegue, se riprovare, come espandere un piano) le prende il
// Director attraverso `TaskEngineHooks`; l'esecuzione passa dall'esecutore (Agent Manager →
// adapter → CLI Runtime): il Task Engine non crea mai processi.
//
// Ordine deterministico: priorità decrescente, poi ordine di creazione (rowid). Un agente esegue
// un task alla volta; al più `maxConcurrent` task in esecuzione.
import { createHash } from 'node:crypto';
import {
  canTaskTransition,
  emptyTaskCounts,
  isTerminalTaskStatus,
  PLAN_LIMITS,
  taskError,
  taskSchema,
  validatePlan,
  type ActionDescriptorInput,
  type AgentDefinition,
  type Task,
  type TaskBudget,
  type TaskCounts,
  type TaskError,
  type TaskKind,
  type TaskResult,
  type TaskStatus
} from '../../shared/contracts/index.ts';
import { splitAttachments } from '../../shared/lib/attachments.ts';
import { ulid } from '../../shared/lib/ulid.ts';
import type { Logger } from '../../shared/node/logging.ts';
import type { TurnRequest, TurnResult } from '../agents/index.ts';
import { looksLikePlan, PLAN_ECHO_ERROR } from './plan-echo.ts';

export { looksLikePlan, PLAN_ECHO_HINT } from './plan-echo.ts';
import type { AuditLog } from '../audit/index.ts';
import type { Db, Row } from '../db/index.ts';
import type { EventEmitter } from '../events/index.ts';

/** Esecutore dei turni (in produzione l'Agent Manager). */
export interface TaskExecutor {
  runTurn(req: TurnRequest): Promise<TurnResult>;
  isBusy(agentId: string): boolean;
}

export type Dispatch =
  | { kind: 'run'; agentId: string; reason: string }
  | { kind: 'wait'; approvalId: string; reason: string }
  | { kind: 'defer'; reason: string }
  | { kind: 'fail'; error: TaskError };

export type Retry = { kind: 'retry'; agentId: string; reason: string } | { kind: 'fail'; reason: string };

/** Decisioni prese dal Director (policy, router, errori, espansione dei piani). */
export interface TaskEngineHooks {
  /** Decide chi esegue un task pronto; `busy` = agenti già occupati (mai scelti: si rimanda). */
  prepare(task: Task, busy: ReadonlySet<string>): Dispatch;
  /** Chiamato dopo ogni tentativo fallito; `canRetry` false = tentativi esauriti (solo per registrarlo). */
  onAttemptFailed(task: Task, error: TaskError, canRetry: boolean): Retry;
  onAttemptSucceeded?(task: Task, agentId: string): void;
  /** Un task di pianificazione è riuscito: passi da aggiungere sotto la radice (stessa transazione). */
  expand?(task: Task, result: TaskResult): NewTask[];
}

export interface NewTask {
  readonly key: string;
  readonly kind: Exclude<TaskKind, 'goal'>;
  readonly title: string;
  readonly spec: string;
  readonly acceptance?: string | null;
  readonly assigneeAgentId?: string | null;
  readonly competence?: AgentDefinition['competences'][number] | null;
  /** Dipendenze tra i passi dello stesso lotto, per chiave. */
  readonly dependsOn?: readonly string[];
  readonly actions?: readonly ActionDescriptorInput[];
  readonly priority?: number;
  readonly budget?: Partial<TaskBudget>;
}

export class TaskEngineError extends Error {
  readonly code: 'not_found' | 'invalid_plan' | 'duplicate' | 'invalid_transition' | 'limit' | 'closed';
  constructor(code: TaskEngineError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface Correlation {
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface TaskEngine {
  /** Registra una radice (obiettivo) e i suoi passi, in una transazione. */
  createGoal(input: { title: string; spec: string; createdBy: string; steps: readonly NewTask[] }, corr: Correlation): { root: Task; tasks: Task[] };
  /** Aggiunge sotto-task a un task esistente non terminato della stessa radice. */
  addTasks(parentId: string, steps: readonly NewTask[], createdBy: string, corr: Correlation): Task[];
  get(taskId: string): Task | null;
  list(filter?: { rootId?: string; status?: readonly TaskStatus[]; rootsOnly?: boolean; limit?: number }): Task[];
  children(taskId: string): Task[];
  /** Annulla il task e, a cascata, i discendenti non terminati. Idempotente. */
  cancel(taskId: string, reason: string, by: string, corr: Correlation): { cancelled: string[]; alreadyFinished: boolean };
  /** waiting → queued (approvazione concessa). */
  resume(taskId: string, reason: string, corr: Correlation): boolean;
  /** waiting/queued → failed (approvazione negata, nessun agente). */
  fail(taskId: string, error: TaskError, corr: Correlation): boolean;
  setHooks(hooks: TaskEngineHooks): void;
  /** Valuta dipendenze e avvia i task pronti; idempotente, mai rientrante. */
  schedule(): void;
  /** All'avvio: task `running` di un core caduto → queued (tentativo contato) o failed `lost`. */
  recover(): { requeued: number; lost: number; roots: number };
  /** Spegnimento: niente nuovi avvii; i turni in corso sono annullati e i task tornano in coda. */
  suspend(reason: string, deadlineMs: number): Promise<number>;
  counts(): TaskCounts;
  activeGoals(): number;
  readonly running: number;
  /** Si risolve quando non ci sono esecuzioni in corso (test). */
  idle(): Promise<void>;
}

export interface TaskEngineDeps {
  db: Db;
  events: EventEmitter;
  log: Logger;
  audit: AuditLog;
  executor: TaskExecutor;
  maxConcurrent: number;
  defaultBudget: TaskBudget;
  now?: () => number;
}

const SOURCE = { kind: 'visione', id: 'tasks' } as const;
const MAX_SUMMARY_EVENT = 4_000;

export function specHash(kind: string, title: string, spec: string): string {
  return createHash('sha256').update(`${kind}\n${title}\n${spec}`).digest('hex');
}

interface Execution {
  readonly taskId: string;
  readonly agentId: string;
  readonly abort: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly done: Promise<void>;
}

export function createTaskEngine(deps: TaskEngineDeps): TaskEngine {
  const { db, events, log, audit, executor } = deps;
  const now = deps.now ?? Date.now;
  let hooks: TaskEngineHooks | null = null;
  const executions = new Map<string, Execution>();
  let scheduling = false;
  let again = false;
  let suspended = false;

  const q = {
    get: db.prepare('SELECT t.*, r.outcome AS r_outcome, r.summary AS r_summary, r.artifacts AS r_artifacts, r.produced_by AS r_by FROM tasks t LEFT JOIN task_results r ON r.task_id = t.id WHERE t.id = ?'),
    deps: db.prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ? ORDER BY rowid'),
    children: db.prepare('SELECT id FROM tasks WHERE parent_id = ? ORDER BY rowid'),
    ofRoot: db.prepare("SELECT id, status, kind FROM tasks WHERE root_id = ? AND kind <> 'goal' ORDER BY rowid"),
    byStatus: db.prepare('SELECT id FROM tasks WHERE status = ? ORDER BY priority DESC, rowid'),
    insert: db.prepare(`INSERT INTO tasks (id, kind, parent_id, root_id, correlation_id, title, spec, acceptance, status, priority, assignee_agent_id,
      competence, actions, budget, attempts, waiting_on, error, spec_hash, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, ?)`),
    insertDep: db.prepare('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)'),
    update: db.prepare(`UPDATE tasks SET status = ?, assignee_agent_id = ?, attempts = ?, waiting_on = ?, error = ?, session_id = ?, process_ids = ?,
      turn_id = ?, updated_at = ?, started_at = ?, ended_at = ? WHERE id = ?`),
    result: db.prepare('INSERT OR REPLACE INTO task_results (task_id, outcome, summary, artifacts, produced_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)'),
    counts: db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status'),
    activeRoots: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'goal' AND status IN ('created', 'queued', 'running', 'waiting')")
  };

  const json = <T>(v: unknown, fallback: T): T => {
    if (v === null || v === undefined) return fallback;
    try {
      return JSON.parse(String(v)) as T;
    } catch {
      return fallback;
    }
  };

  const toTask = (r: Row): Task | null => {
    const parsed = taskSchema.safeParse({
      id: String(r.id),
      kind: String(r.kind),
      parentId: r.parent_id === null ? null : String(r.parent_id),
      rootId: String(r.root_id),
      correlationId: String(r.correlation_id),
      title: String(r.title),
      spec: String(r.spec),
      acceptance: r.acceptance === null ? null : String(r.acceptance),
      status: String(r.status),
      priority: Number(r.priority),
      assigneeAgentId: r.assignee_agent_id === null ? null : String(r.assignee_agent_id),
      competence: r.competence === null ? null : String(r.competence),
      dependsOn: q.deps.all(String(r.id)).map((d) => String(d.depends_on)),
      actions: json(r.actions, []),
      budget: json(r.budget, deps.defaultBudget),
      attempts: Number(r.attempts),
      waitingOn: json(r.waiting_on, null),
      error: json(r.error, null),
      result: r.r_outcome === null || r.r_outcome === undefined ? null : {
        outcome: String(r.r_outcome), summary: String(r.r_summary), artifacts: json(r.r_artifacts, []), producedBy: String(r.r_by)
      },
      sessionId: r.session_id === null ? null : String(r.session_id),
      processIds: json(r.process_ids, []),
      turnId: r.turn_id === null ? null : String(r.turn_id),
      createdBy: String(r.created_by),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      startedAt: r.started_at === null ? null : Number(r.started_at),
      endedAt: r.ended_at === null ? null : Number(r.ended_at)
    });
    if (!parsed.success) {
      log.error('riga di task illeggibile: ignorata', { taskId: String(r.id) });
      return null;
    }
    return parsed.data;
  };

  const get = (taskId: string): Task | null => {
    const row = q.get.get(taskId);
    return row ? toTask(row) : null;
  };
  const mustGet = (taskId: string): Task => {
    const t = get(taskId);
    if (!t) throw new TaskEngineError('not_found', `task sconosciuto: ${taskId}`);
    return t;
  };

  type Patch = Partial<Pick<Task, 'assigneeAgentId' | 'attempts' | 'waitingOn' | 'error' | 'sessionId' | 'processIds' | 'turnId' | 'startedAt' | 'endedAt'>>;

  /** Unico punto di transizione: validata, riga ed evento nella stessa transazione. */
  const transition = (task: Task, to: TaskStatus, reason: string, corr: Correlation, patch: Patch = {}): Task => {
    if (!canTaskTransition(task.status, to)) {
      throw new TaskEngineError('invalid_transition', `transizione non ammessa per ${task.id}: ${task.status} → ${to}`);
    }
    const t = now();
    const next: Task = {
      ...task,
      ...patch,
      status: to,
      updatedAt: t,
      ...(to === 'running' && task.startedAt === null ? { startedAt: t } : {}),
      ...(isTerminalTaskStatus(to) ? { endedAt: t, waitingOn: null } : {}),
      ...(to === 'queued' || to === 'running' ? { waitingOn: patch.waitingOn ?? null } : {})
    };
    db.transaction(() => {
      q.update.run(next.status, next.assigneeAgentId, next.attempts, next.waitingOn ? JSON.stringify(next.waitingOn) : null, next.error ? JSON.stringify(next.error) : null,
        next.sessionId, JSON.stringify(next.processIds), next.turnId, next.updatedAt, next.startedAt, next.endedAt, next.id);
      const failedLike = to === 'failed' || to === 'timed_out' || to === 'blocked';
      events.emit('task.status.changed', {
        taskId: task.id, rootId: task.rootId, kind: task.kind, from: task.status, to, reason: reason.slice(0, 200), attempt: next.attempts,
        error: isTerminalTaskStatus(to) || to === 'queued' ? next.error : null
      }, {
        source: SOURCE, target: { kind: 'task', id: task.id }, correlationId: corr.correlationId, causationId: corr.causationId ?? null,
        ...(failedLike ? { severity: 'warning' as const } : {})
      });
    });
    return next;
  };

  const depthOf = (task: Task): number => {
    let depth = 0;
    let cur: Task | null = task;
    while (cur?.parentId) {
      depth++;
      cur = get(cur.parentId);
    }
    return depth;
  };

  const insertBatch = (parent: { id: string; rootId: string } | null, rootId: string, steps: readonly NewTask[], createdBy: string, corr: Correlation): Task[] => {
    if (steps.length > PLAN_LIMITS.maxSteps) throw new TaskEngineError('limit', `al più ${PLAN_LIMITS.maxSteps} passi per lotto (fan-out)`);
    const plan = validatePlan(steps.map((s) => ({ key: s.key, dependsOn: [...(s.dependsOn ?? [])] })));
    if (!plan.ok) throw new TaskEngineError('invalid_plan', plan.problems.join('; '));
    const hashes = new Set<string>();
    const ids = new Map<string, string>();
    for (const s of steps) {
      const h = specHash(s.kind, s.title, s.spec);
      if (hashes.has(h)) throw new TaskEngineError('duplicate', `passo duplicato: ${s.key}`);
      hashes.add(h);
    }
    const t = now();
    for (const key of plan.order) {
      const s = steps.find((x) => x.key === key) as NewTask;
      const id = ulid(t);
      ids.set(key, id);
      const budget: TaskBudget = { ...deps.defaultBudget, ...s.budget };
      try {
        q.insert.run(id, s.kind, parent?.id ?? null, rootId, corr.correlationId, s.title.slice(0, 200), s.spec, s.acceptance ?? null, s.priority ?? 1,
          s.assigneeAgentId ?? null, s.competence ?? null, JSON.stringify(s.actions ?? []), JSON.stringify(budget), specHash(s.kind, s.title, s.spec), createdBy, t, t);
      } catch (err) {
        if (/UNIQUE/i.test(String(err))) throw new TaskEngineError('duplicate', `task duplicato sotto lo stesso genitore: ${s.title}`);
        throw err;
      }
      const dependsOn = (s.dependsOn ?? []).map((d) => ids.get(d) as string);
      for (const d of dependsOn) q.insertDep.run(id, d);
      events.emit('task.created', {
        taskId: id, kind: s.kind, parentId: parent?.id ?? null, rootId, title: s.title.slice(0, 200), assigneeAgentId: s.assigneeAgentId ?? null,
        dependsOn, priority: s.priority ?? 1, createdBy
      }, { source: SOURCE, target: { kind: 'task', id }, correlationId: corr.correlationId, causationId: corr.causationId ?? null });
    }
    return plan.order.map((k) => mustGet(ids.get(k) as string));
  };

  /** Chiude la radice quando tutti i suoi task sono terminati (stessa transazione del figlio). */
  const settleRoot = (rootId: string, corr: Correlation): void => {
    const root = get(rootId);
    if (!root || isTerminalTaskStatus(root.status)) return;
    const tasks = q.ofRoot.all(rootId).map((r) => ({ id: String(r.id), status: String(r.status) as TaskStatus }));
    if (tasks.length === 0 || tasks.some((x) => !isTerminalTaskStatus(x.status))) return;
    const bad = tasks.filter((x) => x.status !== 'succeeded');
    if (bad.length === 0) {
      transition(root, 'succeeded', 'tutti i task riusciti', corr);
      return;
    }
    const first = get(bad[0]?.id as string);
    const error = taskError(first?.error?.code ?? 'dependency_failed', `${bad.length} task su ${tasks.length} non riusciti (primo: ${first?.title ?? '?'} → ${first?.status ?? '?'})`);
    transition(root, 'failed', 'task non riusciti', corr, { error });
  };

  /** Allegati del proprietario: le righe «📎» della richiesta (radice) e del passo. */
  const attachmentsOf = (task: Task): string[] => {
    const root = task.rootId !== task.id ? get(task.rootId) : null;
    return [...new Set([...splitAttachments(root?.spec ?? '').files, ...splitAttachments(task.spec).files].map((f) => f.path))];
  };

  const markRootRunning = (rootId: string, corr: Correlation): void => {
    const root = get(rootId);
    if (root && root.status === 'created') transition(root, 'running', 'primo task avviato', corr);
  };

  const corrOf = (task: Task): Correlation => ({ correlationId: task.correlationId });

  const plannerOf = db.prepare("SELECT assignee_agent_id AS agent FROM tasks WHERE root_id = ? AND kind = 'plan' ORDER BY created_at LIMIT 1");
  /** Conversazione nuova del motore: dopo un piano rimandato indietro, o per un passo dell'agente che l'ha pianificato. */
  const freshSessionFor = (task: Task, agentId: string): boolean => {
    if (task.kind === 'plan') return false;
    if (task.error?.message === PLAN_ECHO_ERROR) return true;
    const row = plannerOf.get(task.rootId) as { agent: string | null } | undefined;
    return row?.agent === agentId;
  };

  const startExecution = (task: Task, agentId: string, reason: string): void => {
    const corr = corrOf(task);
    const fresh = freshSessionFor(task, agentId);
    let running: Task;
    db.transaction(() => {
      if (task.assigneeAgentId !== agentId) {
        events.emit('task.assigned', { taskId: task.id, rootId: task.rootId, agentId, previousAgentId: task.assigneeAgentId, reason: reason.slice(0, 500) }, {
          source: { kind: 'director', id: 'director' }, target: { kind: 'agent', id: agentId }, correlationId: task.correlationId
        });
      }
      running = transition(task, 'running', `tentativo ${task.attempts + 1} con ${agentId}`, corr, { assigneeAgentId: agentId, attempts: task.attempts + 1, error: null, turnId: null });
      markRootRunning(task.rootId, corr);
    });
    const abort = new AbortController();
    const timer = setTimeout(() => onTimeout(task.id), (running! as Task).budget.timeoutMs);
    const done = (async () => {
      let result: TurnResult;
      try {
        result = await executor.runTurn({
          taskId: task.id, agentId, title: task.title, spec: task.spec, acceptance: task.acceptance, correlationId: task.correlationId,
          attempt: (running! as Task).attempts, signal: abort.signal, attachments: attachmentsOf(task),
          ...(fresh ? { freshSession: true } : {})
        });
      } catch (err) {
        log.error('esecutore dei turni: eccezione inattesa', { taskId: task.id, err });
        result = { status: 'failed', error: taskError('internal', err instanceof Error ? err.message : String(err)), sessionId: null, processIds: [], turnId: null };
      }
      clearTimeout(timer);
      executions.delete(task.id);
      try {
        complete(task.id, agentId, result);
      } catch (err) {
        log.error('chiusura del tentativo non riuscita', { taskId: task.id, err });
      }
      schedule();
    })();
    executions.set(task.id, { taskId: task.id, agentId, abort, timer, done });
  };

  const onTimeout = (taskId: string): void => {
    const exec = executions.get(taskId);
    const task = get(taskId);
    if (!exec || !task || task.status !== 'running') return;
    const error = taskError('timeout', `tentativo oltre ${task.budget.timeoutMs} ms`);
    transition(task, 'timed_out', 'tempo scaduto', corrOf(task), { error });
    settleRoot(task.rootId, corrOf(task));
    exec.abort.abort('timeout');
  };

  const complete = (taskId: string, agentId: string, result: TurnResult): void => {
    const task = get(taskId);
    // Annullato o scaduto nel frattempo: l'esito tardivo del turno non cambia nulla.
    if (!task || task.status !== 'running') return;
    const corr = corrOf(task);
    const trace = result.status === 'waiting' ? {} : { sessionId: result.sessionId, processIds: [...result.processIds], turnId: result.turnId };
    if (result.status === 'succeeded' && task.kind !== 'plan' && looksLikePlan(result.text)) {
      result = { status: 'failed', error: taskError('turn_failed', PLAN_ECHO_ERROR, { retryable: true }), sessionId: result.sessionId, processIds: result.processIds, turnId: result.turnId };
    }
    switch (result.status) {
      case 'succeeded': {
        const summary = result.text;
        const outcome: TaskResult = { outcome: 'success', summary, artifacts: result.artifacts, producedBy: agentId };
        db.transaction(() => {
          q.result.run(task.id, outcome.outcome, summary, JSON.stringify(outcome.artifacts), agentId, now());
          events.emit('task.result.recorded', {
            taskId: task.id, rootId: task.rootId, outcome: 'success', summary: summary.slice(0, MAX_SUMMARY_EVENT), chars: summary.length, producedBy: agentId
          }, { source: { kind: 'agent', id: agentId }, target: { kind: 'task', id: task.id }, correlationId: task.correlationId });
          const added = task.kind === 'plan' && hooks?.expand ? hooks.expand(task, outcome) : [];
          if (added.length > 0) insertBatch({ id: task.rootId, rootId: task.rootId }, task.rootId, added, 'director', corr);
          transition(task, 'succeeded', 'turno completato', corr, trace);
          settleRoot(task.rootId, corr);
        });
        hooks?.onAttemptSucceeded?.(get(task.id) as Task, agentId);
        return;
      }
      case 'waiting':
        // L'agente attende una conferma del proprietario: il tentativo non è stato consumato.
        transition(task, 'waiting', result.reason, corr, { attempts: Math.max(0, task.attempts - 1), waitingOn: { kind: 'approval', ref: result.approvalId } });
        return;
      case 'cancelled':
      case 'failed': {
        const error = result.status === 'failed' ? result.error : taskError('cancelled', `turno annullato: ${result.reason}`, { retryable: true });
        // Il Director è sempre informato (breaker), anche a tentativi esauriti; il budget lo applica il motore.
        const canRetry = task.attempts < task.budget.maxAttempts;
        const decision: Retry = hooks
          ? hooks.onAttemptFailed({ ...task, ...trace } as Task, error, canRetry)
          : { kind: 'fail', reason: `tentativi esauriti (${task.attempts}/${task.budget.maxAttempts})` };
        db.transaction(() => {
          if (decision.kind === 'retry' && task.attempts < task.budget.maxAttempts) {
            if (decision.agentId !== task.assigneeAgentId) {
              events.emit('task.assigned', { taskId: task.id, rootId: task.rootId, agentId: decision.agentId, previousAgentId: task.assigneeAgentId, reason: decision.reason.slice(0, 500) }, {
                source: { kind: 'director', id: 'director' }, target: { kind: 'agent', id: decision.agentId }, correlationId: task.correlationId
              });
            }
            transition(task, 'queued', `nuovo tentativo: ${decision.reason}`, corr, { ...trace, error, assigneeAgentId: decision.agentId });
          } else {
            transition(task, 'failed', decision.reason, corr, { ...trace, error });
            settleRoot(task.rootId, corr);
          }
        });
        return;
      }
    }
  };

  /** created → queued (dipendenze riuscite) o blocked (una dipendenza non riuscita). */
  const resolveDependencies = (): boolean => {
    let changed = false;
    for (const r of q.byStatus.all('created')) {
      const task = get(String(r.id));
      if (!task || task.kind === 'goal') continue;
      const depTasks = task.dependsOn.map((d) => get(d));
      const failed = depTasks.find((d) => d !== null && isTerminalTaskStatus(d.status) && d.status !== 'succeeded');
      const corr = corrOf(task);
      if (failed) {
        db.transaction(() => {
          events.emit('task.dependency.resolved', { taskId: task.id, dependsOn: failed.id, outcome: 'blocked', dependencyStatus: failed.status }, {
            source: SOURCE, target: { kind: 'task', id: task.id }, correlationId: task.correlationId
          });
          transition(task, 'blocked', `dipendenza ${failed.id} terminata come ${failed.status}`, corr, {
            error: taskError('dependency_failed', `la dipendenza "${failed.title}" è terminata come ${failed.status}`)
          });
          settleRoot(task.rootId, corr);
        });
        changed = true;
        continue;
      }
      if (depTasks.every((d) => d?.status === 'succeeded')) {
        db.transaction(() => {
          for (const d of depTasks) {
            events.emit('task.dependency.resolved', { taskId: task.id, dependsOn: (d as Task).id, outcome: 'satisfied', dependencyStatus: 'succeeded' }, {
              source: SOURCE, target: { kind: 'task', id: task.id }, correlationId: task.correlationId
            });
          }
          transition(task, 'queued', depTasks.length > 0 ? 'dipendenze soddisfatte' : 'pronto', corr);
        });
        changed = true;
      }
    }
    return changed;
  };

  const dispatchQueued = (): boolean => {
    if (!hooks || suspended) return false;
    let changed = false;
    const busyAgents = new Set([...executions.values()].map((e) => e.agentId));
    const isBusy = (agentId: string): boolean => busyAgents.has(agentId) || executor.isBusy(agentId);
    for (const r of q.byStatus.all('queued')) {
      if (executions.size >= deps.maxConcurrent) break;
      const task = get(String(r.id));
      if (!task || executions.has(task.id)) continue;
      const corr = corrOf(task);
      let decision: Dispatch;
      try {
        decision = hooks.prepare(task, new Set([...busyAgents].filter((a) => a !== '')));
      } catch (err) {
        log.error('decisione del Director non riuscita', { taskId: task.id, err });
        decision = { kind: 'fail', error: taskError('internal', err instanceof Error ? err.message : String(err)) };
      }
      switch (decision.kind) {
        case 'run':
          if (isBusy(decision.agentId)) continue;
          busyAgents.add(decision.agentId);
          startExecution(task, decision.agentId, decision.reason);
          changed = true;
          break;
        case 'wait':
          transition(task, 'waiting', decision.reason, corr, { waitingOn: { kind: 'approval', ref: decision.approvalId } });
          changed = true;
          break;
        case 'fail':
          db.transaction(() => {
            transition(task, 'failed', decision.error.message, corr, { error: decision.error });
            settleRoot(task.rootId, corr);
          });
          changed = true;
          break;
        case 'defer':
          break;
      }
    }
    return changed;
  };

  function schedule(): void {
    if (scheduling) {
      again = true;
      return;
    }
    scheduling = true;
    try {
      do {
        again = false;
        const a = resolveDependencies();
        const b = dispatchQueued();
        if (a || b) again = true;
      } while (again);
    } catch (err) {
      log.error('pianificazione dei task non riuscita', { err });
    } finally {
      scheduling = false;
    }
  }

  const engine: TaskEngine = {
    createGoal(input, corr) {
      const t = now();
      const rootId = ulid(t);
      const out = db.transaction(() => {
        q.insert.run(rootId, 'goal', null, rootId, corr.correlationId, input.title.slice(0, 200), input.spec, null, 1, null, null, '[]',
          JSON.stringify(deps.defaultBudget), specHash('goal', input.title, input.spec), input.createdBy, t, t);
        events.emit('task.created', {
          taskId: rootId, kind: 'goal', parentId: null, rootId, title: input.title.slice(0, 200), assigneeAgentId: null, dependsOn: [], priority: 1, createdBy: input.createdBy
        }, { source: SOURCE, target: { kind: 'task', id: rootId }, correlationId: corr.correlationId, causationId: corr.causationId ?? null });
        const tasks = insertBatch({ id: rootId, rootId }, rootId, input.steps, input.createdBy, corr);
        return { root: mustGet(rootId), tasks };
      });
      queueMicrotask(schedule);
      return out;
    },

    addTasks(parentId, steps, createdBy, corr) {
      const out = db.transaction(() => {
        const parent = mustGet(parentId);
        const root = mustGet(parent.rootId);
        if (isTerminalTaskStatus(root.status)) throw new TaskEngineError('closed', `obiettivo ${root.id} già concluso (${root.status})`);
        if (depthOf(parent) + 1 > PLAN_LIMITS.maxDepth) throw new TaskEngineError('limit', `profondità massima dei sotto-task (${PLAN_LIMITS.maxDepth}) superata`);
        return insertBatch(parent, parent.rootId, steps, createdBy, corr);
      });
      queueMicrotask(schedule);
      return out;
    },

    get,

    list(filter = {}) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (filter.rootId) {
        where.push('root_id = ?');
        params.push(filter.rootId);
      }
      if (filter.rootsOnly) where.push("kind = 'goal'");
      if (filter.status && filter.status.length > 0) {
        where.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
        params.push(...filter.status);
      }
      const sql = `SELECT id FROM tasks ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid DESC LIMIT ?`;
      params.push(filter.limit ?? 50);
      return db.prepare(sql).all(...params).map((r) => get(String(r.id))).filter((t): t is Task => t !== null);
    },

    children(taskId) {
      return q.children.all(taskId).map((r) => get(String(r.id))).filter((t): t is Task => t !== null);
    },

    cancel(taskId, reason, by, corr) {
      const task = mustGet(taskId);
      if (isTerminalTaskStatus(task.status)) return { cancelled: [], alreadyFinished: true };
      // Il task e i suoi discendenti (per una radice: tutti i task dell'obiettivo), in ordine di creazione.
      const subtree: Task[] = [];
      const visit = (t: Task): void => {
        subtree.push(t);
        for (const c of engine.children(t.id)) visit(c);
      };
      visit(task);
      const targets = subtree.filter((t) => !isTerminalTaskStatus(t.status));
      const toAbort: Execution[] = [];
      db.transaction(() => {
        audit.record({ actor: by, action: 'task.cancel', subject: taskId, decision: 'cancelled', detail: `${reason} (${targets.length} task)`, correlationId: corr.correlationId });
        // Figli prima del genitore: la radice si chiude per ultima.
        for (const t of [...targets].reverse()) {
          const fresh = mustGet(t.id);
          if (isTerminalTaskStatus(fresh.status)) continue;
          transition(fresh, 'cancelled', reason, { correlationId: fresh.correlationId, causationId: corr.causationId ?? null }, { error: taskError('cancelled', reason) });
          const exec = executions.get(t.id);
          if (exec) toAbort.push(exec);
        }
        settleRoot(task.rootId, corrOf(task));
      });
      for (const exec of toAbort) {
        clearTimeout(exec.timer);
        exec.abort.abort(`annullato: ${reason}`);
      }
      queueMicrotask(schedule);
      return { cancelled: targets.map((t) => t.id), alreadyFinished: false };
    },

    resume(taskId, reason, corr) {
      const task = get(taskId);
      if (!task || task.status !== 'waiting') return false;
      transition(task, 'queued', reason, { correlationId: task.correlationId, causationId: corr.causationId ?? null });
      queueMicrotask(schedule);
      return true;
    },

    fail(taskId, error, corr) {
      const task = get(taskId);
      if (!task || (task.status !== 'waiting' && task.status !== 'queued')) return false;
      db.transaction(() => {
        transition(task, 'failed', error.message, { correlationId: task.correlationId, causationId: corr.causationId ?? null }, { error });
        settleRoot(task.rootId, corrOf(task));
      });
      queueMicrotask(schedule);
      return true;
    },

    setHooks(h) {
      hooks = h;
    },

    schedule,

    recover() {
      let requeued = 0;
      let lost = 0;
      for (const r of q.byStatus.all('running')) {
        const task = get(String(r.id));
        if (!task) continue;
        const corr = corrOf(task);
        if (task.kind === 'goal') continue;
        db.transaction(() => {
          if (task.attempts < task.budget.maxAttempts) {
            transition(task, 'queued', 'ripresa dopo una caduta del core: turno interrotto', corr, { error: taskError('lost', 'turno interrotto dalla caduta del core', { retryable: true }) });
            requeued++;
          } else {
            transition(task, 'failed', 'caduta del core durante l\'ultimo tentativo', corr, { error: taskError('lost', 'turno interrotto dalla caduta del core e tentativi esauriti') });
            settleRoot(task.rootId, corr);
            lost++;
          }
        });
      }
      // Coerenza: radici rimaste aperte con tutti i task terminati (non dovrebbe accadere).
      let roots = 0;
      for (const status of ['created', 'running'] as const) {
        for (const r of q.byStatus.all(status)) {
          const t = get(String(r.id));
          if (t?.kind !== 'goal') continue;
          settleRoot(t.id, corrOf(t));
          if (isTerminalTaskStatus(mustGet(t.id).status)) roots++;
        }
      }
      return { requeued, lost, roots };
    },

    async suspend(reason, deadlineMs) {
      suspended = true;
      const list = [...executions.values()];
      for (const exec of list) {
        const task = get(exec.taskId);
        if (task?.status === 'running') {
          transition(task, 'queued', `spegnimento: ${reason}`.slice(0, 200), corrOf(task), { attempts: Math.max(0, task.attempts - 1) });
        }
        clearTimeout(exec.timer);
        exec.abort.abort(`spegnimento: ${reason}`);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(list.map((e) => e.done)), new Promise<void>((r) => { timer = setTimeout(r, deadlineMs); })]);
      clearTimeout(timer);
      return list.length;
    },

    counts() {
      const out = emptyTaskCounts();
      for (const r of q.counts.all()) {
        const s = String(r.status) as TaskStatus;
        if (s in out) out[s] = Number(r.n);
      }
      return out;
    },

    activeGoals() {
      return Number(q.activeRoots.get()?.n ?? 0);
    },

    get running() {
      return executions.size;
    },

    async idle() {
      while (executions.size > 0) await Promise.allSettled([...executions.values()].map((e) => e.done));
    }
  };
  return engine;
}
