// Contratto della memoria (Fase 7, VISIONE_DATA_MODEL §2, DECISIONI P-42…P-44): elementi in
// `memory_items` con ricerca FTS5, ambiti global/agent/task, fatti fissati, riflessione.
import { z } from 'zod';

export const memoryScopeSchema = z.enum(['global', 'agent', 'task']);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memoryKindSchema = z.enum(['fact', 'decision', 'lesson', 'summary', 'note', 'preference']);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

/** Da dove arriva un elemento: file `memory.md`, riga `MEMORIA:` di un turno, comando, riflessione, promozione. */
export const memoryOriginSchema = z.enum(['file', 'turn', 'command', 'reflection', 'promotion']);
export type MemoryOrigin = z.infer<typeof memoryOriginSchema>;

export const MEMORY_LIMITS = {
  titleChars: 200,
  contentChars: 4_000,
  /** Sezioni indicizzate per file `memory.md` (le successive sono ignorate e contate). */
  sectionsPerFile: 100,
  /** Oltre questa dimensione `memory.md` non è letto (errore visibile, nessuna modifica). */
  fileBytes: 256 * 1024,
  /** Righe `MEMORIA:` accettate da un turno. */
  factsPerTurn: 10,
  factChars: 1_000
} as const;

const id = z.string().min(1).max(64);
const time = z.number().int().nonnegative();

export const memoryItemSchema = z.strictObject({
  id,
  scope: memoryScopeSchema,
  /** agentId o taskId; null per la memoria globale. */
  scopeId: id.nullable(),
  kind: memoryKindSchema,
  title: z.string().max(MEMORY_LIMITS.titleChars),
  content: z.string().max(MEMORY_LIMITS.contentChars),
  /** 'agent:<id>' | 'owner:<attore>' | 'director' | 'reflection'. */
  source: z.string().max(80),
  origin: memoryOriginSchema,
  pinned: z.boolean(),
  supersededBy: id.nullable(),
  retiredAt: time.nullable(),
  createdAt: time,
  updatedAt: time
});
export type MemoryItem = z.infer<typeof memoryItemSchema>;
