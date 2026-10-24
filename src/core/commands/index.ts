// Router dei comandi del core: validazione, instradamento, idempotenza, timeout, annullamento.
// Ogni comando ha un solo gestore (modulo proprietario) e una sola risposta.
// Un comando è un'intenzione; ciò che ne accade sono eventi correlati (P-26): `command.rejected`
// (mai eseguito) oppure `command.accepted` → eventi del gestore → `command.completed`, tutti con il
// `correlationId` del comando e `causationId` = id del comando.
import {
  COMMAND_DEFINITIONS,
  commandEnvelopeSchema,
  commandError,
  failure,
  formatIssues,
  type CommandEnvelope,
  type CommandError,
  type CommandErrorCode,
  type CommandPayload,
  type CommandRegistry,
  type CommandResponse,
  type CommandResult,
  type CommandType,
  type CreateEventOptions,
  type EventPayload,
  type EventType
} from '../../shared/contracts/index.ts';
import type { Logger } from '../../shared/node/logging.ts';
import type { Db } from '../db/index.ts';
import type { EventEmitter } from '../events/index.ts';

/** Errore atteso lanciato da un gestore, tradotto in risposta con il suo codice. */
export class CommandFailure extends Error {
  readonly code: CommandErrorCode;
  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface HandlerContext {
  readonly command: CommandEnvelope;
  readonly signal: AbortSignal;
  /** Emette un evento correlato al comando (correlationId del comando, causationId = id del comando). */
  emit<T extends EventType>(type: T, payload: EventPayload<T>, opts?: Omit<CreateEventOptions, 'correlationId' | 'causationId'>): void;
}

export type CommandHandler<T extends CommandType> = (
  payload: CommandPayload<T>,
  ctx: HandlerContext
) => CommandResult<T> | Promise<CommandResult<T>>;

export interface CommandRouter {
  register<T extends CommandType>(type: T, handler: CommandHandler<T>): void;
  dispatch(raw: unknown): Promise<CommandResponse>;
  cancel(id: string, reason: string): boolean;
  /** Smette di accettare comandi nuovi (spegnimento); quelli in corso proseguono. */
  close(): void;
  /** Si risolve quando non ci sono comandi in corso o alla scadenza. */
  settled(deadlineMs: number): Promise<void>;
  readonly inFlight: number;
}

export interface RouterDeps {
  db: Db;
  events: EventEmitter;
  log: Logger;
  defaultTimeoutMs: number;
  /** Registro dei comandi (default: `COMMAND_DEFINITIONS`). */
  definitions?: CommandRegistry;
  now?: () => number;
}

type AnyHandler = (payload: unknown, ctx: HandlerContext) => unknown;

export function createCommandRouter(deps: RouterDeps): CommandRouter {
  const now = deps.now ?? Date.now;
  const definitions: CommandRegistry = deps.definitions ?? COMMAND_DEFINITIONS;
  const handlers = new Map<string, AnyHandler>();
  const inFlight = new Map<string, { promise: Promise<CommandResponse>; abort: AbortController }>();
  let accepting = true;

  const getStored = deps.db.prepare('SELECT result FROM idempotency WHERE command_id = ?');
  const putStored = deps.db.prepare('INSERT OR IGNORE INTO idempotency (command_id, result, ts) VALUES (?, ?, ?)');

  const correlated = (cmd: CommandEnvelope) => ({ correlationId: cmd.correlationId, causationId: cmd.id });

  const reject = (cmd: CommandEnvelope, response: CommandResponse): CommandResponse => {
    if (!response.ok) {
      deps.events.emit('command.rejected', {
        commandId: cmd.id,
        type: cmd.type.slice(0, 100),
        code: response.error.code,
        message: response.error.message.slice(0, 500)
      }, correlated(cmd));
    }
    return response;
  };

  const respond = (cmd: CommandEnvelope, started: number, response: CommandResponse, replayed: boolean): CommandResponse => {
    if (Object.hasOwn(definitions, cmd.type) && definitions[cmd.type]?.quiet === true) return response;
    deps.events.emit('command.completed', {
      commandId: cmd.id,
      type: cmd.type,
      ok: response.ok,
      durationMs: Math.max(0, now() - started),
      errorCode: response.ok ? null : response.error.code,
      replayed
    }, correlated(cmd));
    return response;
  };

  const execute = async (cmd: CommandEnvelope, def: CommandRegistry[string], abort: AbortController): Promise<CommandResponse> => {
    const started = now();
    const payload = def.payload.safeParse(cmd.payload);
    if (!payload.success) {
      return reject(cmd, failure(cmd.id, cmd.correlationId, 'invalid_payload', formatIssues(payload.error)));
    }
    if (def.quiet !== true) deps.events.emit('command.accepted', { commandId: cmd.id, type: cmd.type, issuedBy: cmd.issuedBy }, correlated(cmd));

    if (def.mutating) {
      const stored = getStored.get(cmd.id);
      if (stored) {
        const previous = JSON.parse(String(stored.result)) as CommandResponse;
        return respond(cmd, started, previous.ok ? { ...previous, replayed: true } : previous, true);
      }
    }

    const handler = handlers.get(cmd.type) as AnyHandler;
    const timeoutMs = def.timeoutMs ?? deps.defaultTimeoutMs;
    const ctx: HandlerContext = {
      command: cmd,
      signal: abort.signal,
      emit: (type, eventPayload, opts) => {
        deps.events.emit(type, eventPayload, { ...opts, ...correlated(cmd) });
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<CommandError>((resolve) => {
      const onAbort = (): void => {
        const reason: unknown = abort.signal.reason;
        resolve(reason === 'timeout'
          ? commandError('timeout', `nessuna risposta entro ${timeoutMs} ms`)
          : commandError('cancelled', typeof reason === 'string' ? reason : 'annullato'));
      };
      if (abort.signal.aborted) onAbort();
      else abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    timer = setTimeout(() => abort.abort('timeout'), timeoutMs);

    let response: CommandResponse;
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() => handler(payload.data, ctx)).then((data) => ({ data })),
        aborted.then((error) => ({ error }))
      ]);
      if ('error' in outcome) {
        response = { id: cmd.id, correlationId: cmd.correlationId, ok: false, error: outcome.error };
      } else {
        const result = def.result.safeParse(outcome.data);
        if (!result.success) {
          deps.log.error('risultato del gestore non conforme al contratto', {
            correlationId: cmd.correlationId, type: cmd.type, issues: formatIssues(result.error)
          });
          response = failure(cmd.id, cmd.correlationId, 'internal', 'risultato non conforme al contratto');
        } else {
          response = { id: cmd.id, correlationId: cmd.correlationId, ok: true, data: result.data, replayed: false };
        }
      }
    } catch (err) {
      if (err instanceof CommandFailure) {
        response = failure(cmd.id, cmd.correlationId, err.code, err.message);
      } else {
        deps.log.error('errore nel gestore del comando', { correlationId: cmd.correlationId, type: cmd.type, err });
        response = failure(cmd.id, cmd.correlationId, 'internal', err instanceof Error ? err.message : String(err));
      }
    } finally {
      clearTimeout(timer);
    }

    if (def.mutating && response.ok) {
      putStored.run(cmd.id, JSON.stringify(response), now());
    }
    return respond(cmd, started, response, false);
  };

  return {
    register(type, handler) {
      if (!Object.hasOwn(definitions, type)) throw new Error(`comando non presente nel registro: ${type}`);
      if (handlers.has(type)) throw new Error(`gestore già registrato per ${type}`);
      handlers.set(type, handler as AnyHandler);
    },

    dispatch(raw) {
      const envelope = commandEnvelopeSchema.safeParse(raw);
      if (!envelope.success) {
        const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id : 'unknown';
        return Promise.resolve(failure(id, id, 'invalid_command', formatIssues(envelope.error)));
      }
      const cmd = envelope.data;
      const def = Object.hasOwn(definitions, cmd.type) ? definitions[cmd.type] : undefined;
      if (!def || !handlers.has(cmd.type)) {
        return Promise.resolve(reject(cmd, failure(cmd.id, cmd.correlationId, 'unknown_command', `comando sconosciuto: ${cmd.type}`)));
      }
      const running = inFlight.get(cmd.id);
      if (running) return running.promise;
      if (!accepting) {
        return Promise.resolve(reject(cmd, failure(cmd.id, cmd.correlationId, 'shutting_down', 'il core si sta chiudendo')));
      }
      const abort = new AbortController();
      const promise = execute(cmd, def, abort).finally(() => inFlight.delete(cmd.id));
      inFlight.set(cmd.id, { promise, abort });
      return promise;
    },

    cancel(id, reason) {
      const running = inFlight.get(id);
      if (!running) return false;
      running.abort.abort(reason);
      return true;
    },

    close() {
      accepting = false;
    },

    async settled(deadlineMs) {
      const pending = [...inFlight.values()].map((r) => r.promise);
      if (pending.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, deadlineMs); })
      ]);
      clearTimeout(timer);
    },

    get inFlight() {
      return inFlight.size;
    }
  };
}
