// Chat di gruppo locale (22/10/2026): forma dei gruppi e dei messaggi che la UI riceve.
import { z } from 'zod';

export const groupMemberViewSchema = z.strictObject({
  agentId: z.string().max(64),
  role: z.string().max(80),
  name: z.string().max(200)
});

export const groupViewSchema = z.strictObject({
  id: z.string().max(64),
  name: z.string().max(60),
  members: z.array(groupMemberViewSchema).max(8),
  last: z.strictObject({ author: z.string().max(64), authorName: z.string().max(200), text: z.string().max(200), at: z.number().int() }).nullable(),
  /** Chi l'ha aperto: «owner» o l'id dell'agente (24/10/2026: gli agenti aprono gruppi da soli). */
  createdBy: z.string().max(64),
  createdByName: z.string().max(200),
  /** Il lavoro del proprietario per cui il Director ha aperto il gruppo; null per gli altri gruppi. */
  workRootId: z.string().max(64).nullable()
});
export type GroupViewDto = z.infer<typeof groupViewSchema>;

/** Un file allegato dal proprietario (24/10/2026): percorso sul disco e nome da mostrare. */
export const attachedFileSchema = z.strictObject({ path: z.string().max(1_000), name: z.string().max(260) });
export type AttachedFileDto = z.infer<typeof attachedFileSchema>;

/** `author`: «owner», «visione» (avvisi) o l'id dell'agente. */
export const groupMessageSchema = z.strictObject({
  id: z.string().max(64),
  groupId: z.string().max(64),
  author: z.string().max(64),
  authorName: z.string().max(200),
  text: z.string().max(4_000),
  files: z.array(attachedFileSchema).max(10),
  at: z.number().int()
});
export type GroupMessageDto = z.infer<typeof groupMessageSchema>;

/**
 * La chat con VISIONE (23/10/2026): una richiesta del proprietario e la sua risposta, lette dal database. Prima la chat
 * nasceva dagli ultimi 200 eventi della UI: in un turno d'agente la richiesta usciva dalla finestra e la risposta di un
 * gruppo finiva nella chat con VISIONE (VM, beta.30).
 */
export const chatRequestSchema = z.strictObject({
  id: z.string().max(64),
  at: z.number().int(),
  text: z.string().max(4_000),
  /** Allegati del proprietario (24/10/2026): le righe «📎» della richiesta. */
  files: z.array(attachedFileSchema).max(10),
  status: z.enum(['open', 'succeeded', 'failed', 'cancelled']),
  answer: z.string().max(4_000).nullable(),
  reason: z.string().max(300).nullable(),
  answeredAt: z.number().int().nullable(),
  /** Detta a voce: il testo è ciò che ha sentito il microfono (24/10/2026). */
  voice: z.boolean()
});
export type ChatRequestDto = z.infer<typeof chatRequestSchema>;
