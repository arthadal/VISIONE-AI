// Contratto dei task (VISIONE_AGENT_ARCHITECTURE §9-10, DECISIONI P-37). Un task è un'unità di
// lavoro orchestrata da VISIONE: non è un agente (chi la esegue), né una sessione (il contesto del
// motore), né un processo (il programma del sistema operativo). Li riferisce per id, separati.
import { z } from 'zod';
import { agentCompetenceSchema } from './agents.ts';
import { runtimeErrorCodeSchema } from './processes.ts';

/**
 * Ciclo di vita (P-37). Non terminali: created (registrato, dipendenze da risolvere) → queued
 * (eseguibile, in attesa di un agente libero) → running (turno in corso); waiting (approvazione del
 * proprietario o conferma richiesta dal motore). Terminali, uno solo per task: succeeded, failed,
 * cancelled, timed_out, blocked (una dipendenza non è riuscita: il task non partirà mai).
 * La radice (`goal`) passa da created a running al primo figlio avviato e chiude con l'esito dei figli.
 */
export const taskStatusSchema = z.enum([
  'created', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out', 'blocked'
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'blocked']);

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  created: ['queued', 'running', 'waiting', 'blocked', 'failed', 'cancelled', 'succeeded'],
  queued: ['running', 'waiting', 'failed', 'cancelled'],
  // queued: nuovo tentativo (stesso o altro agente) o ripresa dopo una caduta del core.
  running: ['succeeded', 'failed', 'cancelled', 'timed_out', 'queued', 'waiting'],
  waiting: ['queued', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  blocked: []
};

export function canTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

/** goal = radice creata dal Director per un obiettivo · work = eseguito da un agente · plan = turno di pianificazione. */
export const taskKindSchema = z.enum(['goal', 'work', 'plan']);
export type TaskKind = z.infer<typeof taskKindSchema>;

export const taskErrorCodeSchema = z.enum([
  'dependency_failed', // una dipendenza è terminata senza successo
  'no_agent',          // nessun agente compatibile e disponibile
  'policy_blocked',    // un'azione del task è bloccata dalla policy (non parte mai)
  'approval_denied',   // il proprietario ha negato l'approvazione
  'agent_unavailable', // l'agente non si avvia (motore assente, configurazione non valida)
  'turn_failed',       // il turno dell'agente è fallito
  'timeout',           // scaduto il tempo del tentativo
  'cancelled',         // annullato
  'lost',              // il core è caduto durante il turno e i tentativi sono finiti
  'invalid_plan',      // piano non valido
  'internal'           // errore inatteso
]);
export type TaskErrorCode = z.infer<typeof taskErrorCodeSchema>;

export const taskErrorSchema = z.strictObject({
  code: taskErrorCodeSchema,
  message: z.string().max(500),
  retryable: z.boolean(),
  /** Codice del CLI Runtime o dell'adapter, se l'errore viene da lì. */
  runtimeCode: runtimeErrorCodeSchema.nullable()
});
export type TaskError = z.infer<typeof taskErrorSchema>;

export function taskError(code: TaskErrorCode, message: string, opts: { retryable?: boolean; runtimeCode?: TaskError['runtimeCode'] } = {}): TaskError {
  return { code, message: message.slice(0, 500), retryable: opts.retryable ?? false, runtimeCode: opts.runtimeCode ?? null };
}

/** Azione da classificare (consentita / con approvazione / bloccata): VISIONE_SECURITY_MODEL §2. */
export const actionDescriptorSchema = z.strictObject({
  kind: z.string().min(1).max(100),
  target: z.string().max(1000),
  detail: z.record(z.string(), z.unknown()).optional()
});
export type ActionDescriptorInput = z.infer<typeof actionDescriptorSchema>;

export const actionClassSchema = z.enum(['allow', 'approval', 'block']);
export type ActionClass = z.infer<typeof actionClassSchema>;

export const taskBudgetSchema = z.strictObject({
  /** Tempo massimo di un tentativo (turno), poi `timed_out`. */
  timeoutMs: z.number().int().min(100).max(24 * 3_600_000),
  /** Tentativi complessivi (stesso agente o altro compatibile). */
  maxAttempts: z.number().int().min(1).max(5)
});
export type TaskBudget = z.infer<typeof taskBudgetSchema>;

export const taskResultSchema = z.strictObject({
  outcome: z.enum(['success', 'partial', 'failure']),
  summary: z.string().max(20_000),
  artifacts: z.array(z.string().max(1024)).max(50),
  producedBy: z.string().max(64)
});
export type TaskResult = z.infer<typeof taskResultSchema>;

const id = z.string().min(1).max(64);
const time = z.number().int().nonnegative();

/** Vista di un task (comandi, UI). Nessun segreto: spec e risultati passano dalla redazione. */
export const taskSchema = z.strictObject({
  id,
  kind: taskKindSchema,
  parentId: id.nullable(),
  rootId: id,
  correlationId: z.string().max(64),
  title: z.string().max(200),
  spec: z.string().max(20_000),
  acceptance: z.string().max(2_000).nullable(),
  status: taskStatusSchema,
  priority: z.number().int().min(0).max(3),
  assigneeAgentId: id.nullable(),
  competence: agentCompetenceSchema.nullable(),
  dependsOn: z.array(id).max(10),
  actions: z.array(actionDescriptorSchema).max(10),
  budget: taskBudgetSchema,
  attempts: z.number().int().nonnegative(),
  waitingOn: z.strictObject({ kind: z.enum(['approval', 'agent']), ref: z.string().max(200) }).nullable(),
  error: taskErrorSchema.nullable(),
  result: taskResultSchema.nullable(),
  sessionId: z.string().max(128).nullable(),
  processIds: z.array(z.string().max(64)).max(20),
  turnId: z.string().max(64).nullable(),
  createdBy: z.string().max(80),
  createdAt: time,
  updatedAt: time,
  startedAt: time.nullable(),
  endedAt: time.nullable()
});
export type Task = z.infer<typeof taskSchema>;

/** Limiti anti-loop del Director (VISIONE_AGENT_ARCHITECTURE §9). */
export const PLAN_LIMITS = { maxSteps: 5, maxDepth: 3, maxDependencies: 5 } as const;

const stepKey = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);

/** Passo di un piano: dichiarato dal proprietario, prodotto da un planner o proposto da un agente. */
export const planStepSchema = z.strictObject({
  key: stepKey,
  title: z.string().min(1).max(200),
  spec: z.string().min(1).max(20_000),
  acceptance: z.string().max(2_000).optional(),
  /** Agente scelto esplicitamente; altrimenti decide il router per competenza. */
  agentId: id.optional(),
  /**
   * Fan-out (Fase 10): lo stesso passo distribuito a più agenti in parallelo. Ogni agente produce il
   * suo risultato; il passo si intende soddisfatto quando tutti riescono. Un passo successivo che lo
   * dipende riceve tutti i risultati (Context Builder). Alternativo ad `agentId`.
   */
  agents: z.array(id).min(1).max(PLAN_LIMITS.maxSteps).optional(),
  competence: agentCompetenceSchema.optional(),
  dependsOn: z.array(stepKey).max(PLAN_LIMITS.maxDependencies).default([]),
  actions: z.array(actionDescriptorSchema).max(10).default([]),
  priority: z.number().int().min(0).max(3).default(1),
  timeoutMs: z.number().int().min(100).max(24 * 3_600_000).optional(),
  maxAttempts: z.number().int().min(1).max(5).optional()
});
export type PlanStep = z.output<typeof planStepSchema>;
export type PlanStepInput = z.input<typeof planStepSchema>;

export const planSchema = z.strictObject({
  steps: z.array(planStepSchema).min(1).max(PLAN_LIMITS.maxSteps)
});
export type Plan = z.output<typeof planSchema>;
export type PlanInput = z.input<typeof planSchema>;

export const plannerKindSchema = z.enum(['explicit', 'rule', 'agent']);
export type PlannerKind = z.infer<typeof plannerKindSchema>;

export type PlanValidation =
  | { ok: true; order: readonly string[] }
  | { ok: false; problems: string[] };

/**
 * Validazione deterministica di un piano: chiavi uniche, dipendenze esistenti, nessuna
 * dipendenza da sé, nessun ciclo. `order` è un ordine topologico stabile (a parità, l'ordine di
 * dichiarazione). Un ciclo è riportato con i passi coinvolti in ordine di dichiarazione.
 */
export function validatePlan(steps: readonly Pick<PlanStep, 'key' | 'dependsOn'>[]): PlanValidation {
  const problems: string[] = [];
  const index = new Map<string, number>();
  steps.forEach((s, i) => {
    if (index.has(s.key)) problems.push(`chiave duplicata: ${s.key}`);
    else index.set(s.key, i);
  });
  for (const s of steps) {
    for (const d of s.dependsOn) {
      if (d === s.key) problems.push(`${s.key} dipende da sé stesso`);
      else if (!index.has(d)) problems.push(`${s.key} dipende da un passo inesistente: ${d}`);
    }
    if (new Set(s.dependsOn).size !== s.dependsOn.length) problems.push(`${s.key}: dipendenze duplicate`);
  }
  if (problems.length > 0) return { ok: false, problems };

  // Kahn: si estrae sempre il primo passo pronto in ordine di dichiarazione.
  const remaining = new Map(steps.map((s) => [s.key, new Set(s.dependsOn)]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = steps.find((s) => remaining.get(s.key)?.size === 0);
    if (!ready) {
      const cycle = steps.filter((s) => remaining.has(s.key)).map((s) => s.key);
      return { ok: false, problems: [`dipendenza circolare tra: ${cycle.join(', ')}`] };
    }
    order.push(ready.key);
    remaining.delete(ready.key);
    for (const deps of remaining.values()) deps.delete(ready.key);
  }
  return { ok: true, order };
}
