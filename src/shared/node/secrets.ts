// Riferimenti ai segreti. Un file di configurazione contiene solo il NOME di una variabile
// d'ambiente impostata dal proprietario, mai il valore (VISIONE_SECURITY_MODEL §4).
import { z } from 'zod';

export const secretRefSchema = z.strictObject({
  env: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'nome di variabile d\'ambiente in maiuscolo')
});
export type SecretRef = z.infer<typeof secretRefSchema>;

/** Valore del segreto o `undefined`. Il valore non va mai registrato né scritto su file. */
export function resolveSecret(ref: SecretRef, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[ref.env];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** Descrizione sicura per diagnostica e log: dice se il segreto è presente, non quale sia. */
export function describeSecret(ref: SecretRef, env: NodeJS.ProcessEnv = process.env): { ref: string; present: boolean } {
  return { ref: `env:${ref.env}`, present: resolveSecret(ref, env) !== undefined };
}
