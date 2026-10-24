// Addestramento (14/10/2026, P-107k): regole di lavoro che l'utente sceglie dal catalogo di VISIONE o
// scrive da sé. Entrano nel brief di un agente SOLO quando il compito le riguarda (parole chiave), o in
// ogni turno se l'utente lo sceglie: il costo in token si vede prima di attivarle. Tutto resta sul PC.
import { z } from 'zod';

export const TRAINING_LIMITS = {
  titleChars: 80,
  ruleChars: 600,
  keywordChars: 40,
  keywords: 20,
  /** Regole scritte dall'utente, al massimo. */
  custom: 50,
  /** Regole al massimo in un turno e caratteri della sezione del brief. */
  perTurn: 4,
  sectionChars: 1_200
} as const;

export const skillCategorySchema = z.enum(['tokens', 'code', 'research', 'writing', 'safety', 'method', 'custom']);
export type SkillCategory = z.infer<typeof skillCategorySchema>;

export const skillOriginSchema = z.enum(['catalog', 'custom']);
export type SkillOrigin = z.infer<typeof skillOriginSchema>;

export const skillSchema = z.strictObject({
  id: z.string().min(1).max(64),
  origin: skillOriginSchema,
  category: skillCategorySchema,
  title: z.string().max(TRAINING_LIMITS.titleChars),
  /** Per l'utente: cosa cambia nel lavoro degli agenti (vuoto per le regole scritte dall'utente). */
  explain: z.string().max(600),
  /** Il testo che riceve l'agente. */
  rule: z.string().max(TRAINING_LIMITS.ruleChars),
  /** Di cosa deve parlare il compito, in parole leggibili (le parole chiave esatte sono in `keywords`). */
  topics: z.string().max(400),
  keywords: z.array(z.string().max(TRAINING_LIMITS.keywordChars)).max(TRAINING_LIMITS.keywords),
  /** In ogni turno invece che solo quando il compito la riguarda. */
  always: z.boolean(),
  active: z.boolean(),
  /** Stima dei token che costa quando entra in un turno. */
  tokens: z.number().int().nonnegative(),
  /** Turni in cui è entrata davvero. */
  uses: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative().nullable(),
  /** Spenta: quanti dei compiti recenti dell'utente l'avrebbero fatta entrare (consiglio). */
  suggested: z.number().int().nonnegative()
});
export type Skill = z.infer<typeof skillSchema>;

export const customSkillInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(TRAINING_LIMITS.titleChars),
  rule: z.string().trim().min(1).max(TRAINING_LIMITS.ruleChars),
  keywords: z.array(z.string().trim().min(2).max(TRAINING_LIMITS.keywordChars)).max(TRAINING_LIMITS.keywords).default([]),
  always: z.boolean().default(false)
});
export type CustomSkillInput = z.input<typeof customSkillInputSchema>;
