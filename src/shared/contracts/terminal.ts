// Terminale come vista (Fase 8, VISIONE_ARCHITECTURE §18, DECISIONI P-45): una sessione è un processo
// PTY del CLI Runtime (shell del proprietario, sessione di un agente). L'uscita viaggia con gli eventi
// `process.stdout` (flusso `pty`) già esistenti; il core tiene uno scrollback limitato per la vista.
import { z } from 'zod';
import { processKindSchema, processOwnerSchema, processStatusSchema } from './processes.ts';

export const TERMINAL_LIMITS = {
  /** Scrollback tenuto dal core per processo PTY. */
  scrollbackChars: 256 * 1024,
  /** Testo di un singolo comando `terminal.input`. */
  inputChars: 4_096,
  /** Sessioni terminate ancora consultabili. */
  keptClosed: 10,
  /** Shell aperte insieme dal proprietario. */
  maxShells: 4
} as const;

const time = z.number().int().nonnegative();
export const terminalColsSchema = z.number().int().min(10).max(500);
export const terminalRowsSchema = z.number().int().min(4).max(200);

export const terminalSessionSchema = z.strictObject({
  processId: z.string().max(64),
  kind: processKindSchema,
  owner: processOwnerSchema,
  status: processStatusSchema,
  /** Input e ridimensionamento dalla UI: shell del proprietario e agenti con capacità `terminal.input`. */
  interactive: z.boolean(),
  title: z.string().max(200),
  createdAt: time,
  endedAt: time.nullable()
});
export type TerminalSession = z.infer<typeof terminalSessionSchema>;
