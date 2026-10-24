// Contratti delle entità agente (docs/architecture/VISIONE_AGENT_ARCHITECTURE.md §1-2).
// Solo il vocabolario condiviso con la UI; il comportamento arriva con la Fase 5.
import { z } from 'zod';

/** Cosa sa fare un motore: dichiarato dall'adapter, mai dedotto dal nome dell'eseguibile. */
export const agentCapabilitySchema = z.enum([
  'turns.headless', 'turns.interactive', 'session.resume', 'session.assignId', 'events.tools',
  'events.turnEnd', 'control.deny', 'control.steer', 'control.halt', 'usage.tokens',
  'usage.context', 'model.select',
  /** Fase 8: il proprietario può scrivere nel PTY dell'agente dalla vista Terminale (`pty-generic`). */
  'terminal.input'
]);
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;

export const agentStatusSchema = z.enum([
  'created', 'starting', 'idle', 'working', 'waiting', 'error', 'stopping', 'stopped', 'crashed', 'recovering'
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/** Classificazione dell'uscita di un processo del CLI Runtime. */
export const exitClassSchema = z.enum(['clean', 'error', 'killed', 'crashed', 'not-found', 'start-timeout']);
export type ExitClass = z.infer<typeof exitClassSchema>;

export const agentCompetenceSchema = z.enum(['code', 'general', 'reasoning', 'review', 'research']);

/** Il "chi" di un agente: durevole, scritto dal proprietario o dal Director con approvazione. */
export const agentDefinitionSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  role: z.string().max(2000),
  competences: z.array(agentCompetenceSchema).min(1),
  engine: z.strictObject({
    /** Chiave del registro degli adapter, non un elenco chiuso. */
    adapter: z.string().min(1).max(64),
    model: z.string().max(200).optional(),
    endpointProfile: z.string().max(64).optional(),
    options: z.record(z.string(), z.unknown()).optional()
  }),
  persona: z.strictObject({ instructions: z.string().max(20_000), language: z.enum(['it', 'en']) }),
  workspace: z.strictObject({ root: z.string().min(1), isolation: z.enum(['shared', 'worktree']) }),
  permissions: z.string().min(1).max(64),
  limits: z.strictObject({
    maxTurnMinutes: z.number().int().positive(),
    maxTurnsPerTask: z.number().int().positive(),
    maxConcurrentTasks: z.literal(1)
  }),
  createdBy: z.string().min(1),
  createdAt: z.number().int(),
  version: z.number().int().positive()
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

/** Uso riportato dal motore: solo valori reali, mai stime. */
export const agentUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  contextUsed: z.number().int().nonnegative().optional(),
  contextSize: z.number().int().nonnegative().optional()
});
export type AgentUsage = z.infer<typeof agentUsageSchema>;

/** La conversazione del motore, riprendibile. */
export const agentSessionSchema = z.strictObject({
  id: z.string(),
  engineSessionId: z.string(),
  adapter: z.string(),
  model: z.string().optional(),
  startedAt: z.number().int(),
  lastTurnAt: z.number().int().optional(),
  usage: agentUsageSchema.optional(),
  resumable: z.boolean()
});
export type AgentSession = z.infer<typeof agentSessionSchema>;
