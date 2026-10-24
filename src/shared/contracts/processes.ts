// Contratto dei processi del CLI Runtime (VISIONE_AGENT_ARCHITECTURE §4, DECISIONI P-30).
// Un processo è un programma avviato dal core; non è un agente, né una sessione, né un task:
// può appartenere a ciascuno di essi tramite `owner`, che resta separato e facoltativo.
import { z } from 'zod';

export const processKindSchema = z.enum(['agent-turn', 'agent-session', 'probe', 'terminal', 'system']);
export type ProcessKind = z.infer<typeof processKindSchema>;

export const processIoSchema = z.enum(['pipes', 'pty']);
export type ProcessIo = z.infer<typeof processIoSchema>;

/**
 * Ciclo di vita. Non terminali: created (registrato, eventualmente in coda) → starting (spawn in
 * corso) → running → stopping (terminazione chiesta da VISIONE, con un motivo).
 * Terminali, uno solo per processo:
 * - exited: uscito da solo con codice 0
 * - failed: non avviabile (comando, cartella, permessi) o uscito da solo con codice ≠ 0
 * - crashed: terminato in modo anomalo (segnale, eccezione nativa) senza che VISIONE lo chiedesse
 * - stopped / timed_out / cancelled: terminato da VISIONE per stop, scadenza o annullamento
 * - lost: il core è caduto mentre il processo era vivo; deciso dalla riconciliazione all'avvio
 */
export const processStatusSchema = z.enum([
  'created', 'starting', 'running', 'stopping',
  'exited', 'failed', 'crashed', 'stopped', 'timed_out', 'cancelled', 'lost'
]);
export type ProcessStatus = z.infer<typeof processStatusSchema>;

export const TERMINAL_PROCESS_STATUSES: ReadonlySet<ProcessStatus> = new Set([
  'exited', 'failed', 'crashed', 'stopped', 'timed_out', 'cancelled', 'lost'
]);

export const PROCESS_TRANSITIONS: Readonly<Record<ProcessStatus, readonly ProcessStatus[]>> = {
  created: ['starting', 'cancelled', 'failed', 'lost'],
  starting: ['running', 'failed', 'stopping', 'lost'],
  running: ['stopping', 'exited', 'failed', 'crashed', 'lost'],
  stopping: ['stopped', 'timed_out', 'cancelled', 'lost'],
  exited: [],
  failed: [],
  crashed: [],
  stopped: [],
  timed_out: [],
  cancelled: [],
  lost: []
};

export function canProcessTransition(from: ProcessStatus, to: ProcessStatus): boolean {
  return PROCESS_TRANSITIONS[from].includes(to);
}

export function isTerminalProcessStatus(status: ProcessStatus): boolean {
  return TERMINAL_PROCESS_STATUSES.has(status);
}

/** Perché VISIONE termina un processo: decide lo stato terminale (stopped, timed_out, cancelled). */
export const stopIntentSchema = z.enum(['stop', 'timeout', 'cancel']);
export type StopIntent = z.infer<typeof stopIntentSchema>;

export const runtimeErrorCodeSchema = z.enum([
  'invalid_spec',         // specifica non valida (argomenti troppo lunghi, NUL, percorsi relativi)
  'policy_denied',        // eseguibile o cartella non consentiti dalla policy del runtime
  'not_found',            // comando inesistente
  'cwd_missing',          // cartella di lavoro inesistente
  'permission_denied',    // permessi insufficienti per avviare il processo
  'spawn_failed',         // altro errore del sistema operativo all'avvio
  'pty_unavailable',      // modalità PTY richiesta ma non disponibile
  'exit_nonzero',         // uscito da solo con codice diverso da 0
  'crashed',              // terminazione anomala
  'timeout',              // scaduto (avvio o durata massima)
  'cancelled',            // annullato
  'not_running',          // operazione su un processo non (ancora o più) in esecuzione
  'stdin_closed',         // ingresso non disponibile
  'unknown_process',      // id di processo sconosciuto
  'unreachable',          // il processo non risponde nemmeno al kill dell'albero
  'restart_limit',        // limite di riavvii raggiunto
  'queue_full',           // troppi processi
  'session_not_found',    // sessione del motore inesistente
  'provider_unavailable', // il motore non raggiunge il provider (credenziali, rete)
  'trust_required',       // il motore chiede al proprietario di confermare la fiducia nella cartella
  'limit_reached',        // il motore ha dichiarato l'esaurimento della quota (P-83)
  'engine_error'          // errore strutturato del motore non classificato altrimenti
]);
export type RuntimeErrorCode = z.infer<typeof runtimeErrorCodeSchema>;

export const runtimeErrorSchema = z.strictObject({
  code: runtimeErrorCodeSchema,
  message: z.string().max(500),
  retryable: z.boolean()
});
export type RuntimeError = z.infer<typeof runtimeErrorSchema>;

const RETRYABLE: ReadonlySet<RuntimeErrorCode> = new Set(['timeout', 'queue_full', 'provider_unavailable', 'spawn_failed']);

export function runtimeError(code: RuntimeErrorCode, message: string): RuntimeError {
  return { code, message: message.slice(0, 500), retryable: RETRYABLE.has(code) };
}

/** A chi appartiene un processo: concetti distinti, tutti facoltativi. */
export const processOwnerSchema = z.strictObject({
  agentId: z.string().max(64).nullable(),
  sessionId: z.string().max(128).nullable(),
  taskId: z.string().max(64).nullable(),
  adapter: z.string().max(64).nullable()
});
export type ProcessOwner = z.infer<typeof processOwnerSchema>;

export const NO_OWNER: ProcessOwner = { agentId: null, sessionId: null, taskId: null, adapter: null };

/** Vista di un processo per la UI e per i comandi (nessun argomento né variabile d'ambiente). */
export const processInfoSchema = z.strictObject({
  id: z.string(),
  pid: z.number().int().nonnegative().nullable(),
  status: processStatusSchema,
  kind: processKindSchema,
  io: processIoSchema,
  owner: processOwnerSchema,
  exe: z.string().max(260),
  cwd: z.string().max(1024),
  correlationId: z.string(),
  createdAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().nullable(),
  endedAt: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(40).nullable(),
  error: runtimeErrorSchema.nullable(),
  restartOf: z.string().nullable()
});
export type ProcessInfo = z.infer<typeof processInfoSchema>;
