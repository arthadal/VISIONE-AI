// Contratti di governo (VISIONE_SECURITY_MODEL §2, §9; VISIONE_AGENT_ARCHITECTURE §1-3, §8):
// istanze degli agenti, approvazioni del proprietario, messaggi FIPA-lite tra agenti, audit log,
// decisioni del Director. Solo vocabolario e schemi: il comportamento vive nel core.
import { z } from 'zod';
import { agentCapabilitySchema, agentDefinitionSchema, agentSessionSchema, agentStatusSchema, type AgentStatus } from './agents.ts';

const id = z.string().min(1).max(64);
const time = z.number().int().nonnegative();

/**
 * Transizioni delle istanze (VISIONE_AGENT_ARCHITECTURE §2, P-37). In più rispetto alla tabella
 * dell'architettura: starting → waiting (il motore chiede una conferma del proprietario, es. la
 * fiducia nella cartella) e waiting → starting (confermata); created/error → crashed quando il core
 * riparte e trova l'istanza non chiusa. `crashed` e `stopped` sono finali per l'istanza: una nuova
 * istanza riprende la sessione salvata.
 */
export const AGENT_TRANSITIONS: Readonly<Record<AgentStatus | 'none', readonly AgentStatus[]>> = {
  none: ['created'],
  created: ['starting', 'stopping', 'stopped', 'crashed'],
  starting: ['idle', 'error', 'waiting', 'stopping', 'crashed'],
  idle: ['working', 'stopping', 'crashed', 'error'],
  working: ['idle', 'waiting', 'error', 'stopping', 'crashed'],
  waiting: ['working', 'starting', 'idle', 'stopping', 'crashed', 'error'],
  error: ['starting', 'idle', 'stopping', 'stopped', 'crashed'],
  stopping: ['stopped', 'crashed'],
  stopped: [],
  crashed: ['recovering'],
  recovering: ['idle', 'error', 'stopping']
};

export const TERMINAL_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set(['stopped', 'crashed']);

export function canAgentTransition(from: AgentStatus | null, to: AgentStatus): boolean {
  return AGENT_TRANSITIONS[from ?? 'none'].includes(to);
}

export const agentInstanceSchema = z.strictObject({
  id,
  agentId: id,
  status: agentStatusSchema,
  statusReason: z.string().max(200).nullable(),
  sessionId: z.string().max(128).nullable(),
  currentTaskId: id.nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: time,
  startedAt: time.nullable(),
  lastEventAt: time.nullable(),
  endedAt: time.nullable()
});
export type AgentInstance = z.infer<typeof agentInstanceSchema>;

export const breakerLevelSchema = z.enum(['closed', 'steer', 'constrain', 'open']);
export type BreakerLevel = z.infer<typeof breakerLevelSchema>;

/**
 * Vista di un agente per la UI: definizione, istanza corrente, sessione salvata, breaker e
 * capacità dichiarate dall'adapter (P-83: la UI sceglie cosa mostrare senza conoscere i motori —
 * es. il target della wake e i selettori di modello/potenza si basano sulle capacità).
 */
export const agentViewSchema = z.strictObject({
  definition: agentDefinitionSchema,
  archived: z.boolean(),
  instance: agentInstanceSchema.nullable(),
  session: agentSessionSchema.nullable(),
  breaker: breakerLevelSchema,
  capabilities: z.array(agentCapabilitySchema)
});
export type AgentView = z.infer<typeof agentViewSchema>;

// --- Approvazioni ------------------------------------------------------------------------------

export const approvalStatusSchema = z.enum(['pending', 'granted', 'denied']);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalSchema = z.strictObject({
  id,
  /** Tipo di azione (es. `fs.write`, `engine.workspace.trust`). */
  kind: z.string().max(100),
  target: z.string().max(1000),
  reason: z.string().max(500),
  requestedBy: z.string().max(80),
  taskId: id.nullable(),
  agentId: id.nullable(),
  correlationId: z.string().max(64),
  status: approvalStatusSchema,
  decidedBy: z.string().max(80).nullable(),
  note: z.string().max(500).nullable(),
  requestedAt: time,
  decidedAt: time.nullable()
});
export type Approval = z.infer<typeof approvalSchema>;

// --- Messaggi FIPA-lite (§8) ---------------------------------------------------------------------

export const MESSAGE_MAX_HOPS = 12;
export const messageActSchema = z.enum(['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done']);
export type MessageAct = z.infer<typeof messageActSchema>;
/** Solo questi atti obbligano a rispondere. */
export const REPLY_REQUIRED_ACTS: ReadonlySet<MessageAct> = new Set(['request', 'query', 'propose']);
/** Destinatario riservato: il Director. */
export const DIRECTOR_ADDRESS = 'director';

/** Messaggio scritto da un agente in `outbox\` (dati non fidati: validati e mai eseguiti). */
export const agentMessageSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  inReplyTo: z.string().max(64).nullable().default(null),
  from: id,
  to: id,
  act: messageActSchema,
  subject: z.string().min(1).max(200),
  body: z.string().max(20_000),
  taskId: id.nullable().default(null),
  hops: z.number().int().min(0).max(MESSAGE_MAX_HOPS),
  requiresReply: z.boolean().default(false),
  createdAt: time
});
export type AgentMessage = z.output<typeof agentMessageSchema>;

// --- Audit (§9) ---------------------------------------------------------------------------------

export const auditEntrySchema = z.strictObject({
  seq: z.number().int().positive(),
  ts: time,
  actor: z.string().max(80),
  action: z.string().max(100),
  subject: z.string().max(200).nullable(),
  decision: z.string().max(40),
  detail: z.string().max(2_000),
  correlationId: z.string().max(64).nullable(),
  prevHash: z.string().length(64),
  hash: z.string().length(64)
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

// --- Director ------------------------------------------------------------------------------------

export const directorDecisionKindSchema = z.enum([
  'assign', 'retry', 'reassign', 'fail', 'wait-approval', 'block', 'plan-fallback', 'breaker', 'proposal-accepted', 'proposal-rejected'
]);
export type DirectorDecisionKind = z.infer<typeof directorDecisionKindSchema>;

export const routeCandidateSchema = z.strictObject({
  agentId: id,
  score: z.number(),
  /** Motivo dell'esclusione; null = candidato valido. */
  excluded: z.string().max(200).nullable()
});
export type RouteCandidate = z.infer<typeof routeCandidateSchema>;
