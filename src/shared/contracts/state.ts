// Stato corrente del core (VISIONE_EVENT_MODEL §5). Lo stato non è un evento né un comando: è la
// situazione attuale, derivata dagli eventi dal solo State Store del core e mostrata in sola
// lettura. Qui vivono lo schema dello snapshot e le transizioni ammesse del ciclo di vita.
import { z } from 'zod';
import { ULID_PATTERN } from '../lib/ulid.ts';
import { endpointSchema, severitySchema } from './events-base.ts';
import { agentStatusSchema } from './agents.ts';
import { processStatusSchema } from './processes.ts';
import { editionSchema } from './voice.ts';
import { taskStatusSchema, type TaskStatus } from './tasks.ts';
import { voiceStateSchema } from './voice.ts';

export const STATE_SCHEMA_VERSION = 4;

/** Ciclo di vita del core visto dal core stesso (il supervisore nel main ha il suo, `CoreState`). */
export const coreStatusSchema = z.enum(['starting', 'ready', 'stopping', 'stopped', 'crashed', 'recovering']);
export type CoreStatus = z.infer<typeof coreStatusSchema>;

/**
 * Transizioni ammesse. `null` = nessuna storia (primo avvio).
 * Avvio pulito: stopped → starting → ready → stopping → stopped.
 * Dopo un'uscita non pulita: <ultimo stato> → crashed (dedotto) → recovering → ready.
 */
export const CORE_TRANSITIONS: Readonly<Record<CoreStatus | 'none', readonly CoreStatus[]>> = {
  none: ['starting'],
  starting: ['ready', 'stopping', 'crashed'],
  ready: ['stopping', 'crashed'],
  stopping: ['stopped', 'crashed'],
  stopped: ['starting'],
  crashed: ['recovering'],
  recovering: ['ready', 'stopping', 'crashed']
};

export function canTransition(from: CoreStatus | null, to: CoreStatus): boolean {
  return CORE_TRANSITIONS[from ?? 'none'].includes(to);
}

export const applicationStatusSchema = z.enum(['starting', 'running', 'stopping']);
export const ipcStatusSchema = z.enum(['connected', 'disconnected']);
/** ok · degraded: il journal non accetta scritture, gli eventi durevoli attendono in memoria. */
export const databaseStatusSchema = z.enum(['ok', 'degraded']);

const count = z.number().int().nonnegative();
const time = z.number().int().nonnegative();

export const eventSummarySchema = z.strictObject({
  id: z.string().regex(ULID_PATTERN),
  seq: z.number().int().positive().nullable(),
  ts: time,
  type: z.string(),
  severity: severitySchema,
  source: endpointSchema,
  correlationId: z.string()
});
export type EventSummary = z.infer<typeof eventSummarySchema>;

export const MAX_ACTIVE_OPERATIONS = 50;

export const taskCountsSchema = z.strictObject(
  Object.fromEntries(taskStatusSchema.options.map((s) => [s, count])) as Record<TaskStatus, typeof count>
);
export type TaskCounts = Record<TaskStatus, number>;

export function emptyTaskCounts(): TaskCounts {
  return Object.fromEntries(taskStatusSchema.options.map((s) => [s, 0])) as TaskCounts;
}

export const operationSchema = z.strictObject({
  commandId: z.string(),
  type: z.string(),
  correlationId: z.string(),
  issuedBy: z.string(),
  startedAt: time
});
export type Operation = z.infer<typeof operationSchema>;

export const coreStateSnapshotSchema = z.strictObject({
  schema: z.literal(STATE_SCHEMA_VERSION),
  /** Id dell'avvio del processo core: cambia a ogni avvio, `revision` riparte da 0. */
  bootId: z.string().regex(ULID_PATTERN),
  revision: count,
  updatedAt: time,
  version: z.strictObject({ app: z.string(), core: z.string(), dbSchema: count, /** Edizione (P-104). */ edition: editionSchema }),
  application: z.strictObject({ status: applicationStatusSchema, since: time }),
  core: z.strictObject({
    status: coreStatusSchema,
    since: time,
    pid: count,
    startedAt: time,
    /** Ultimo stato registrato dall'avvio precedente (null = primo avvio). */
    previousRun: coreStatusSchema.nullable(),
    /** L'avvio precedente non si era chiuso in modo pulito. */
    recovered: z.boolean()
  }),
  ipc: z.strictObject({
    status: ipcStatusSchema,
    commandsCompleted: count,
    commandsFailed: count,
    commandsRejected: count,
    invalidFrames: count
  }),
  database: z.strictObject({
    status: databaseStatusSchema,
    journalLastSeq: count,
    journalCount: count,
    pendingWrites: count,
    lastError: z.string().max(500).nullable(),
    /** Nome del file messo da parte all'avvio perché illeggibile o corrotto. */
    quarantined: z.string().max(260).nullable(),
    corruptRows: count
  }),
  events: z.strictObject({
    last: eventSummarySchema.nullable(),
    sinceStart: count,
    rejected: count
  }),
  operations: z.strictObject({ active: z.array(operationSchema).max(MAX_ACTIVE_OPERATIONS), count }),
  /** Processi del CLI Runtime (Fase 5): derivati dagli eventi `process.*`. */
  processes: z.strictObject({
    /** Registrati e non ancora terminati (in coda, in avvio, in esecuzione, in chiusura). */
    active: count,
    /** Creati da questo avvio del core. */
    created: count,
    /** Terminati come failed, crashed o timed_out da questo avvio. */
    failed: count,
    last: z.strictObject({ processId: z.string(), status: processStatusSchema, at: time }).nullable()
  }),
  /** Agenti (Fase 6): definizioni attive e istanze vive, dagli eventi `agent.*`. */
  agents: z.strictObject({
    defined: count,
    /** Istanze non terminali (né stopped né crashed). */
    live: count,
    working: count,
    last: z.strictObject({ agentId: z.string(), status: agentStatusSchema, at: time }).nullable()
  }),
  /** Task (Fase 6): conteggi per stato (letti dalla tabella all'avvio, poi dagli eventi `task.*`). */
  tasks: z.strictObject({
    active: count,
    byStatus: taskCountsSchema,
    last: z.strictObject({ taskId: z.string(), status: taskStatusSchema, at: time }).nullable()
  }),
  director: z.strictObject({
    /** Obiettivi (task radice) non ancora terminati. */
    activeGoals: count,
    lastDecision: z.strictObject({ decision: z.string().max(40), taskId: z.string().nullable(), agentId: z.string().nullable(), at: time }).nullable()
  }),
  approvals: z.strictObject({ pending: count }),
  /** Voce (Fase 9): processo, push-to-talk, frase in riproduzione, dagli eventi `voice.*`. */
  voice: voiceStateSchema,
  error: z.strictObject({
    last: z.strictObject({ code: z.string(), message: z.string().max(500), at: time, correlationId: z.string().nullable() }).nullable(),
    count
  })
});
export type CoreStateSnapshot = z.infer<typeof coreStateSnapshotSchema>;
