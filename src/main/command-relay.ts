// Inoltro dei comandi renderer → core (DECISIONI P-19). Il main non interpreta i comandi: valida
// l'envelope, verifica che il tipo sia consentito alla UI, imposta `issuedBy`, applica il timeout e
// restituisce `core_unavailable` se il core non c'è. La logica resta nel core.
import {
  COMMAND_DEFINITIONS,
  commandEnvelopeSchema,
  failure,
  formatIssues,
  type CommandEnvelope,
  type CommandErrorCode,
  type CommandRegistry,
  type CommandResponse,
  type MainToCoreFrameBody
} from '../shared/contracts/index.ts';
import type { Logger } from '../shared/node/logging.ts';
import { realTimers, type Timers } from './supervisor.ts';

/** Ciò che il renderer può inviare: `issuedBy` lo decide il main, non il renderer. */
const uiEnvelopeSchema = commandEnvelopeSchema.omit({ issuedBy: true });

export type UiCommandParse = { ok: true; command: CommandEnvelope } | { ok: false; response: CommandResponse };

export function parseUiCommand(raw: unknown, definitions: CommandRegistry = COMMAND_DEFINITIONS): UiCommandParse {
  const parsed = uiEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id.slice(0, 64) : 'unknown';
    return { ok: false, response: failure(id, id, 'invalid_command', formatIssues(parsed.error)) };
  }
  const cmd = parsed.data;
  const def = Object.hasOwn(definitions, cmd.type) ? definitions[cmd.type] : undefined;
  if (!def) {
    return { ok: false, response: failure(cmd.id, cmd.correlationId, 'unknown_command', `comando sconosciuto: ${cmd.type}`) };
  }
  if (!def.uiAllowed) {
    return { ok: false, response: failure(cmd.id, cmd.correlationId, 'forbidden', `comando non consentito alla UI: ${cmd.type}`) };
  }
  return { ok: true, command: { ...cmd, issuedBy: 'ui' } };
}

export interface CommandRelayDeps {
  /** Invia al core; false se il core non è pronto. */
  send: (frame: MainToCoreFrameBody) => boolean;
  defaultTimeoutMs: number;
  definitions?: CommandRegistry;
  log: Logger;
  timers?: Timers;
}

/** Margine oltre il timeout del core: di norma la risposta `timeout` arriva dal core stesso. */
export const RELAY_TIMEOUT_MARGIN_MS = 1_000;

export interface CommandRelay {
  relay(command: CommandEnvelope): Promise<CommandResponse>;
  onResponse(response: CommandResponse): void;
  /** Il core è caduto o si sta fermando: chiude tutte le attese. */
  failAll(code: CommandErrorCode, message: string): void;
  readonly pending: number;
}

interface Pending {
  promise: Promise<CommandResponse>;
  resolve: (response: CommandResponse) => void;
  timer: unknown;
}

export function createCommandRelay(deps: CommandRelayDeps): CommandRelay {
  const t = deps.timers ?? realTimers;
  const pending = new Map<string, Pending>();

  const settle = (id: string, response: CommandResponse): void => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    t.clearTimeout(entry.timer);
    entry.resolve(response);
  };

  return {
    relay(command) {
      const existing = pending.get(command.id);
      if (existing) return existing.promise;
      if (!deps.send({ kind: 'cmd', command })) {
        return Promise.resolve(failure(command.id, command.correlationId, 'core_unavailable', 'core non disponibile'));
      }
      const definitions: CommandRegistry = deps.definitions ?? COMMAND_DEFINITIONS;
      const def = Object.hasOwn(definitions, command.type) ? definitions[command.type] : undefined;
      const timeoutMs = (def?.timeoutMs ?? deps.defaultTimeoutMs) + RELAY_TIMEOUT_MARGIN_MS;
      let resolve!: (response: CommandResponse) => void;
      const promise = new Promise<CommandResponse>((r) => { resolve = r; });
      const timer = t.setTimeout(() => {
        deps.log.warn('comando senza risposta dal core', { correlationId: command.correlationId, type: command.type, timeoutMs });
        deps.send({ kind: 'cancel', id: command.id, reason: 'timeout' });
        settle(command.id, failure(command.id, command.correlationId, 'timeout', `nessuna risposta dal core entro ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(command.id, { promise, resolve, timer });
      return promise;
    },
    onResponse(response) {
      if (!pending.has(response.id)) {
        deps.log.debug('risposta senza richiesta in attesa', { id: response.id });
        return;
      }
      settle(response.id, response);
    },
    failAll(code, message) {
      for (const id of [...pending.keys()]) settle(id, failure(id, id, code, message));
    },
    get pending() {
      return pending.size;
    }
  };
}
