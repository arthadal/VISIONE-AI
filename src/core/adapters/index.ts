// Adapter dei motori (VISIONE_AGENT_ARCHITECTURE §1, §5-7). Ogni motore vive in
// `adapters/<motore>/` e implementa `AgentAdapter`; nessun altro modulo conosce un motore.
// Runtime → Adapter → CLI: l'adapter costruisce comandi, ambiente e parser; il runtime avvia e
// controlla i processi; il resto di VISIONE vede solo `AgentEvent` normalizzati.
import {
  type AgentCapability,
  type AgentDefinition,
  type AgentSession,
  type AgentStatus,
  type AgentUsage,
  type ExitClass,
  type RuntimeError
} from '../../shared/contracts/index.ts';
import type { Logger } from '../../shared/node/logging.ts';
import type { EventEmitter } from '../events/index.ts';
import type { CliRuntime, HookServer } from '../runtime/index.ts';

export { createBuiltinAdapters, type BuiltinAdapterDeps } from './catalog/index.ts';
export { AdapterError } from './errors.ts';

/** Azione che la policy deve classificare (consentita / con approvazione / bloccata). */
export interface ActionDescriptor {
  readonly kind: string;
  readonly target: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Evento normalizzato dall'adapter verso l'Agent Manager (e, tramite il ponte, verso il bus). */
export type AgentEvent =
  | { kind: 'session.started'; engineSessionId: string }
  | { kind: 'turn.started'; turnId: string }
  | { kind: 'message.text'; turnId: string; text: string; final: boolean }
  | { kind: 'tool.started'; turnId: string; toolCallId: string; tool: string; input?: unknown }
  | { kind: 'tool.finished'; turnId: string; toolCallId: string; tool: string; ok: boolean; durationMs?: number }
  | { kind: 'permission.requested'; requestId: string; action: ActionDescriptor }
  | { kind: 'turn.finished'; turnId: string; outcome: 'completed' | 'cancelled' | 'failed'; error?: RuntimeError }
  | { kind: 'usage'; usage: AgentUsage; source: 'turn' | 'session' }
  | { kind: 'limit.reached'; turnId: string | null; scope: 'session' | 'weekly' | 'monthly' | 'fast' | 'unknown'; message: string; resetAt: string | null }
  | { kind: 'process.exited'; exit: ExitClass; code?: number; tail: string }
  | { kind: 'stalled'; quietMs: number };

export interface AgentInstanceView {
  readonly id: string;
  readonly agentId: string;
  readonly status: AgentStatus;
  readonly session?: AgentSession;
}

export interface AdapterContext {
  readonly instance: AgentInstanceView;
  readonly definition: AgentDefinition;
  /** Unico modo di creare processi. */
  readonly runtime: CliRuntime;
  /** Cartella del contratto a file con l'agente (`<home>/agents/<id>`). */
  readonly agentDir: string;
  /** Cartella di lavoro dell'agente (consentita dalla policy del runtime). */
  readonly workspaceDir: string;
  /** Canale degli hook (solo per i motori che li usano). */
  readonly hooks?: HookServer;
  emit(event: AgentEvent): void;
  readonly signal: AbortSignal;
  readonly log: Logger;
  /**
   * Il proprietario ha approvato la fiducia del motore nella cartella di lavoro (coda delle
   * approvazioni, P-39): solo allora l'adapter può confermare il dialogo del motore.
   */
  readonly trustApproved?: boolean;
}

/** Decisione di VISIONE su un'azione chiesta da un agente (policy + approvazioni, P-39). */
export type ActionGate = (agentId: string, action: ActionDescriptor) => { decision: 'allow' | 'deny'; reason: string } | null;

export interface TurnInput {
  readonly turnId: string;
  readonly taskId?: string;
  readonly text: string;
  readonly attachments?: readonly string[];
  readonly correlationId?: string;
}

export interface TurnOutcome {
  readonly outcome: 'completed' | 'cancelled' | 'failed';
  readonly error: RuntimeError | null;
  /** Sessione del motore dopo il turno (può nascere col primo turno). */
  readonly engineSessionId: string | null;
}

export interface AdapterProbe {
  available: boolean;
  version?: string;
  path?: string;
  /** P-99: comando reale eseguito per la verifica (eseguibile risolto + `--version`), se esiste. */
  command?: string;
  problems: string[];
}

/**
 * Un requisito del motore per la procedura guidata del primo avvio (P-105): stato rilevato davvero
 * e, se manca, cosa fare in italiano semplice. Il motore lo dichiara; il core lo raccoglie senza
 * sapere di che motore si tratta.
 */
export interface AdapterSetupItem {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  /** Se manca, il motore funziona lo stesso (es. modelli locali). */
  readonly optional: boolean;
  /**
   * Facoltativo per il motore ma indispensabile ai modelli di questo profilo (18/10/2026: senza la chiave del
   * fornitore la squadra proposta aveva tre agenti su quei modelli senza alcun avviso). La procedura lo segnala su quelle righe.
   */
  readonly forProfile?: string;
  /** Stato rilevato, in una riga. */
  readonly detail: string;
  /** Passi da fare se non è a posto. */
  readonly steps: readonly string[];
  /** Comandi da copiare in PowerShell. */
  readonly commands: readonly string[];
  /** Pagina ufficiale utile (download, chiavi). */
  readonly link?: string;
  /**
   * Azione offerta dalla procedura: terminale per l'accesso, campo per una chiave, oppure «Installa»: lo
   * script PowerShell dell'installatore ufficiale (resta nel core; alla UI vanno solo fonte e permesso).
   */
  readonly action?:
    | { readonly kind: 'login-terminal'; readonly args: readonly string[] }
    | { readonly kind: 'env-key'; readonly envName: string }
    | { readonly kind: 'install'; readonly source: string; readonly admin: boolean; readonly script: string; readonly verb?: 'install' | 'enable' };
}

/** Un modello scegliibile nei menu della procedura guidata (P-105), già nel formato della definizione. */
export interface AdapterCatalogEntry {
  readonly model: string;
  readonly label: string;
  /** Gruppo nel menu (il fornitore del modello, deciso dal motore). */
  readonly group: string;
  readonly endpointProfile?: string;
  /** Provato su questa installazione o consigliato: in cima al menu. */
  readonly recommended?: boolean;
  /** Ruolo per cui il motore consiglia il modello: la procedura ne ricava la squadra pronta. */
  readonly suggestedFor?: 'director' | 'code' | 'review' | 'research';
}

/** Esito della verifica reale di una chiave presso il servizio (P-105). Mai il valore della chiave. */
export interface AdapterKeyCheck {
  readonly ok: boolean;
  readonly detail: string;
}

/** Modello che l'adapter dichiara utilizzabile per una definizione (P-83). */
export interface AdapterModelOption {
  readonly id: string;
  /** Da dove viene il dato (sondaggio della CLI, catalogo dell'adapter): solo per la UI. */
  readonly detail?: string;
}

/** Potenza del motore (effort): opzioni reali dichiarate dall'adapter; null = non applicabile. */
export interface AdapterTuning {
  readonly effort: { readonly options: readonly string[]; readonly current: string | null } | null;
}

export interface AgentAdapter {
  readonly id: string;
  /** Nome del motore per le persone (procedura guidata, P-105); assente = l'id. */
  readonly label?: string;
  readonly capabilities: ReadonlySet<AgentCapability>;
  /**
   * File del motore che governano permessi o hook (P-102): la policy li custodisce — scriverli
   * chiede sempre il proprietario, anche in modalità fiducia. Senza ancore di fine riga: valgono sia
   * sui percorsi sia sul testo dei comandi.
   */
  readonly guardedPatterns?: readonly RegExp[];
  probe(opts?: { refresh?: boolean }): Promise<AdapterProbe>;
  validate(def: AgentDefinition): { ok: true } | { ok: false; problems: string[] };
  /**
   * Il modello è della famiglia di questo motore? (P-83). Usato per seed/riparazione e per non
   * offrire modelli inapplicabili; assente = il motore non dichiara un formato.
   */
  supportsModel?(model: string): boolean;
  /** Modelli realmente applicabili a questa definizione, sondati dalla CLI (P-83). */
  listModels?(def: AgentDefinition, probe: { workspaceDir: string; refresh?: boolean }): Promise<readonly AdapterModelOption[]>;
  /** Opzioni di potenza (effort) dichiarate dal motore per questa definizione (P-83). */
  tuning?(def: AgentDefinition): AdapterTuning;
  /** Requisiti per la procedura guidata, rilevati ora (P-105). */
  setup?(): Promise<readonly AdapterSetupItem[]>;
  /** Programma e argomenti per l'accesso al servizio del motore (P-105), avviati senza shell; null = non serve. */
  loginCommand?(): Promise<{ readonly exe: string; readonly args: readonly string[] } | null>;
  /** Modelli scegliibili nella procedura guidata (P-105): catalogo reale del motore. */
  catalog?(): Promise<readonly AdapterCatalogEntry[]>;
  /**
   * Verifica reale di una chiave dichiarata da un requisito `env-key` (P-105): `value` è quella appena
   * incollata, null = quella già nell'ambiente. Il valore non va mai in log, eventi o risultati.
   */
  verifyKey?(envName: string, value: string | null): Promise<AdapterKeyCheck>;
  /**
   * Verifica reale per il saluto di stato (12/10/2026): non solo «il programma c'è», ma l'accesso che
   * serve a QUESTI agenti (account collegato, chiave accettata dal servizio, servizio locale acceso).
   * Nessun turno; al più una domanda di due parole per modello in uso, dove il fornitore toglie i modelli
   * all'account (21/10/2026). Senza, il saluto si limita al programma installato.
   */
  health?(defs: readonly AgentDefinition[]): Promise<AdapterKeyCheck>;
  /**
   * Testo breve fuori dai turni (22/10/2026, la battuta del saluto): niente task né sessione, solo dove il motore
   * ha un servizio rapido per QUESTI agenti. null = non disponibile o non in tempo; mai un errore.
   */
  quickText?(defs: readonly AgentDefinition[], ask: QuickTextAsk, timeoutMs: number): Promise<string | null>;
  start(ctx: AdapterContext, resume?: AgentSession): Promise<AgentSession>;
  sendTurn(ctx: AdapterContext, input: TurnInput): Promise<TurnOutcome>;
  cancelTurn(ctx: AdapterContext, reason: string): Promise<void>;
  respondPermission?(ctx: AdapterContext, requestId: string, decision: 'allow' | 'deny', note?: string): Promise<void>;
  steer?(ctx: AdapterContext, note: string): Promise<void>;
  stop(ctx: AdapterContext, mode: 'graceful' | 'force', deadlineMs: number): Promise<void>;
  readUsage?(ctx: AdapterContext): Promise<AgentUsage | null>;
}

/** Richiesta di un testo breve fuori dai turni: `prefer` sceglie fra il modello più rapido e il più arguto. */
export interface QuickTextAsk {
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
  readonly prefer?: 'speed' | 'quality';
}

/** Registro degli adapter: chiave = `AgentDefinition.engine.adapter`. */
export interface AdapterRegistry {
  get(id: string): AgentAdapter | undefined;
  list(): readonly AgentAdapter[];
}

export function createAdapterRegistry(adapters: readonly AgentAdapter[]): AdapterRegistry {
  const byId = new Map(adapters.map((a) => [a.id, a]));
  return { get: (id) => byId.get(id), list: () => [...byId.values()] };
}

const MAX_TEXT = 4_000;

/**
 * Ponte AgentEvent → eventi VISIONE (`agent.*`, `tool.call.*`), uguale per ogni motore.
 * `correlationId` lega gli eventi del turno al comando o al task che lo ha chiesto.
 */
export function createAgentEventSink(deps: {
  events: EventEmitter;
  agentId: string;
  sessionId: () => string | null;
  adapter: string;
  correlationId: () => string | undefined;
  taskId?: () => string | null;
}): (event: AgentEvent) => void {
  const source = { kind: 'agent' as const, id: deps.agentId };
  const opts = () => {
    const c = deps.correlationId();
    return c === undefined ? { source } : { source, correlationId: c };
  };
  return (e) => {
    switch (e.kind) {
      case 'session.started':
        deps.events.emit('agent.session.started', { agentId: deps.agentId, sessionId: deps.sessionId(), engineSessionId: e.engineSessionId.slice(0, 200), adapter: deps.adapter }, opts());
        return;
      case 'turn.started':
        deps.events.emit('agent.turn.started', { agentId: deps.agentId, turnId: e.turnId, taskId: deps.taskId?.() ?? null }, opts());
        return;
      case 'turn.finished':
        deps.events.emit('agent.turn.finished', { agentId: deps.agentId, turnId: e.turnId, outcome: e.outcome, error: e.error ?? null },
          { ...opts(), ...(e.outcome === 'failed' ? { severity: 'error' as const } : {}) });
        return;
      case 'message.text':
        deps.events.emit('agent.message.text', { agentId: deps.agentId, turnId: e.turnId, text: e.text.slice(0, MAX_TEXT), chars: e.text.length, final: e.final }, opts());
        return;
      case 'usage':
        deps.events.emit('agent.usage.updated', { agentId: deps.agentId, sessionId: deps.sessionId(), source: e.source, usage: e.usage }, opts());
        return;
      case 'limit.reached':
        deps.events.emit('agent.limit.reached', {
          agentId: deps.agentId, sessionId: deps.sessionId(), taskId: deps.taskId?.() ?? null, turnId: e.turnId,
          adapter: deps.adapter, scope: e.scope, message: e.message.slice(0, 500), resetAt: e.resetAt
        }, opts());
        return;
      case 'permission.requested':
        deps.events.emit('agent.permission.requested', { agentId: deps.agentId, requestId: e.requestId.slice(0, 200), kind: e.action.kind.slice(0, 100), target: e.action.target.slice(0, 1000) }, opts());
        return;
      case 'tool.started':
        deps.events.emit('tool.call.started', { agentId: deps.agentId, turnId: e.turnId, toolCallId: e.toolCallId.slice(0, 200), tool: e.tool.slice(0, 100) }, { ...opts(), target: { kind: 'tool', id: e.tool.slice(0, 100) } });
        return;
      case 'tool.finished':
        deps.events.emit('tool.call.finished', { agentId: deps.agentId, turnId: e.turnId, toolCallId: e.toolCallId.slice(0, 200), tool: e.tool.slice(0, 100), ok: e.ok, durationMs: e.durationMs ?? null },
          { ...opts(), target: { kind: 'tool', id: e.tool.slice(0, 100) } });
        return;
      case 'process.exited':
      case 'stalled':
        // Già rappresentati dagli eventi `process.*` del runtime.
        return;
    }
  };
}
