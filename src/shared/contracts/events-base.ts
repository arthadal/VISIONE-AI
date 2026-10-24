// Parti di base del contratto degli eventi: envelope e tipi elementari. Separate dal registro
// (`events.ts`) perché lo schema dello stato (`state.ts`) le usa e il registro usa lo stato.
import { z } from 'zod';
import { ULID_PATTERN } from '../lib/ulid.ts';

export const severitySchema = z.enum(['debug', 'info', 'warning', 'error', 'critical']);
export type Severity = z.infer<typeof severitySchema>;

export const endpointKindSchema = z.enum([
  'visione', 'director', 'agent', 'tool', 'task', 'process', 'terminal', 'memory', 'voice',
  'model', 'user', 'system', 'ui'
]);
export const endpointSchema = z.strictObject({
  kind: endpointKindSchema,
  id: z.string().min(1).max(200)
});
export type Endpoint = z.infer<typeof endpointSchema>;

export const eventCategorySchema = z.enum([
  'agent', 'task', 'terminal', 'tool', 'file', 'git', 'memory', 'voice', 'system', 'error',
  'telemetry', 'ui', 'director', 'approval', 'process', 'assistant'
]);
export type EventCategory = z.infer<typeof eventCategorySchema>;

export const durabilitySchema = z.enum(['durable', 'ephemeral']);
export type Durability = z.infer<typeof durabilitySchema>;

/** Identificatore di correlazione o causa: ULID o id di comando. */
export const correlationIdSchema = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const visioneEventSchema = z.strictObject({
  id: z.string().regex(ULID_PATTERN),
  seq: z.number().int().positive().nullable(),
  ts: z.number().int().nonnegative(),
  type: z.string().min(3).max(100),
  category: eventCategorySchema,
  source: endpointSchema,
  target: endpointSchema.nullable(),
  correlationId: correlationIdSchema,
  causationId: correlationIdSchema.nullable(),
  severity: severitySchema,
  durability: durabilitySchema,
  schema: z.number().int().positive(),
  payload: z.unknown()
});
export type VisioneEvent = z.infer<typeof visioneEventSchema>;

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(radice)'}: ${issue.message}`)
    .join('; ');
}
