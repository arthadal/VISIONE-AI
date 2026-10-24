// Modalità offline dell'Assistente (17/10/2026, richiesta del proprietario): senza rete VISIONE passa a un
// modello locale piccolo (scaricato solo su consenso) che fa le cose di base — promemoria, agenda, note,
// timer, liste, aprire le finestre, data e ora. Automatica quando cade la rete (disattivabile) o col tasto
// «Entra in modalità offline». Il modello non agisce da sé: riscrive la frase in un comando che le regole
// dell'Assistente già capiscono.
import { z } from 'zod';

export const OFFLINE_LIMITS = { textChars: 500, replyChars: 700 } as const;

export const offlineNetworkSchema = z.enum(['online', 'offline', 'unknown']);
export type OfflineNetwork = z.infer<typeof offlineNetworkSchema>;

/** `missing` = da scaricare; `idle` = scaricato, non in memoria; `loading` = si carica; `ready` = risponde. */
export const offlineModelStatusSchema = z.enum(['missing', 'downloading', 'idle', 'loading', 'ready', 'error']);
export type OfflineModelStatus = z.infer<typeof offlineModelStatusSchema>;

export const offlineStateSchema = z.strictObject({
  network: offlineNetworkSchema,
  /** Le richieste vanno al modello locale invece che agli agenti. */
  active: z.boolean(),
  /** Entrata col tasto: resta finché non si torna online col tasto, anche se la rete c'è. */
  manual: z.boolean(),
  /** Passaggio automatico quando cade la rete (impostazione `offline.auto`). */
  auto: z.boolean(),
  model: z.strictObject({
    status: offlineModelStatusSchema,
    name: z.string().max(80),
    license: z.string().max(40),
    sizeBytes: z.number().int().nonnegative(),
    received: z.number().int().nonnegative(),
    error: z.string().max(500).nullable()
  }),
  /** Memoria del PC sufficiente per il modello (consigliati 8 GB). */
  ramOk: z.boolean(),
  since: z.number().int().nonnegative()
});
export type OfflineState = z.infer<typeof offlineStateSchema>;

export const offlineChangeReasonSchema = z.enum(['network', 'manual', 'setting', 'model']);
export type OfflineChangeReason = z.infer<typeof offlineChangeReasonSchema>;

/** Esito di una richiesta offline: fatto dall'Assistente, risposta diretta, non possibile offline, non capita, da confermare. */
export const offlineOutcomeSchema = z.enum(['assisted', 'answered', 'refused', 'unknown', 'confirm', 'error']);
export type OfflineOutcome = z.infer<typeof offlineOutcomeSchema>;

export const offlineReplySchema = z.strictObject({
  reply: z.string().max(OFFLINE_LIMITS.replyChars),
  outcome: offlineOutcomeSchema,
  /** Cosa ha capito il modello (il comando riscritto), per trasparenza; null se non è servito. */
  understood: z.string().max(OFFLINE_LIMITS.textChars).nullable()
});
export type OfflineReply = z.infer<typeof offlineReplySchema>;
