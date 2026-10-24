// Stato del core visto dal supervisore nel main (VISIONE_ARCHITECTURE §4).
import { z } from 'zod';

/**
 * starting → ready; uscita inattesa → crashed → recovering (attesa + nuovo avvio) → ready;
 * oltre il limite di riavvii → failed; chiusura → stopping → stopped.
 */
export const coreStateSchema = z.enum(['starting', 'ready', 'stopping', 'stopped', 'crashed', 'recovering', 'failed']);
export type CoreState = z.infer<typeof coreStateSchema>;

export const supervisorSnapshotSchema = z.strictObject({
  state: coreStateSchema,
  since: z.number().int(),
  pid: z.number().int().nullable(),
  appVersion: z.string(),
  restartsInWindow: z.number().int().nonnegative(),
  totalRestarts: z.number().int().nonnegative(),
  nextRestartAt: z.number().int().nullable(),
  lastExit: z
    .strictObject({ at: z.number().int(), code: z.number().int().nullable(), reason: z.string() })
    .nullable()
});
export type SupervisorSnapshot = z.infer<typeof supervisorSnapshotSchema>;
