// Mappa del codice (14/10/2026, P-107l): indice di file, simboli e import delle cartelle di lavoro degli
// agenti, fatto da VISIONE senza programmi esterni. Nel brief entra solo la parte che riguarda il
// compito (file e righe), così l'agente va dritto al punto invece di esplorare. Tutto resta sul PC.
import { z } from 'zod';

export const CODEMAP_LIMITS = {
  /** File indicizzati al massimo per cartella e dimensione massima di un file letto. */
  maxFiles: 20_000,
  maxFileBytes: 400 * 1024,
  maxSymbolsPerFile: 200,
  /** Caratteri della sezione del brief e file mostrati al massimo. */
  sectionChars: 2_000,
  filesShown: 8,
  /** Una cartella non si riesamina prima di questo intervallo. */
  rescanMs: 60_000
} as const;

export const codeRootSchema = z.strictObject({
  root: z.string().min(1).max(1024),
  enabled: z.boolean(),
  files: z.number().int().nonnegative(),
  symbols: z.number().int().nonnegative(),
  scannedAt: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** Oltre `maxFiles`: indicizzati solo i primi. */
  truncated: z.boolean(),
  scanning: z.boolean(),
  /** Usata da almeno un agente attivo. */
  inUse: z.boolean(),
  error: z.string().max(300).nullable()
});
export type CodeRoot = z.infer<typeof codeRootSchema>;
