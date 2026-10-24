// Agent Registry e Agent Manager (VISIONE_AGENT_ARCHITECTURE §1-3, DECISIONI P-38).
// Registry: definizioni durevoli (`agent_definitions`), scritte dal proprietario.
// Manager: istanze (`agent_instances`) e sessioni (`agent_sessions`), unico proprietario di queste
// tabelle; avvia, ferma e fa eseguire turni agli agenti solo tramite gli adapter, che a loro volta
// creano processi solo tramite il CLI Runtime. Nessun nome di motore qui: solo `AgentAdapter`.
//
// Separazione dei concetti: un'istanza (agente vivo) ha una sessione (contesto del motore,
// riprendibile) ed esegue un turno alla volta per un task; i processi li possiede il runtime.
// Fase 7 (P-43): ogni turno è registrato in `turns` (brief inviato, esito, testo finale); il brief lo
// compone il Context Builder (`TurnContextProvider`), che chiude anche il turno lato memoria.
import { briefWithAttachments, copyAttachments } from './attachments.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
  agentDefinitionSchema,
  agentSessionSchema,
  canAgentTransition,
  taskError,
  TERMINAL_AGENT_STATUSES,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentInstance,
  type AgentSession,
  type AgentStatus,
  type AgentView,
  type BreakerLevel,
  type RuntimeError,
  type TaskError
} from '../../shared/contracts/index.ts';
import { ulid } from '../../shared/lib/ulid.ts';
import type { Logger } from '../../shared/node/logging.ts';
import { AdapterError, createAgentEventSink, type ActionGate, type AdapterContext, type AdapterRegistry, type AgentAdapter, type AgentEvent } from '../adapters/index.ts';
import type { ApprovalQueue } from '../approvals/index.ts';
import type { AuditLog } from '../audit/index.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { Db, Row } from '../db/index.ts';
import type { EventEmitter } from '../events/index.ts';
import type { ActionPolicy } from '../policy/index.ts';
import type { CliRuntime, HookServer } from '../runtime/index.ts';

/** Conferma che il motore pretende per lavorare in una cartella nuova (P-36, P-39). */
export const TRUST_ACTION = 'engine.workspace.trust';

export interface TurnRequest {
  readonly taskId: string;
  readonly agentId: string;
  readonly title: string;
  readonly spec: string;
  readonly acceptance: string | null;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly attempt: number;
  readonly signal: AbortSignal;
  /** File allegati dal proprietario (percorsi assoluti): l'agente ne riceve una copia nella sua cartella di lavoro. */
  readonly attachments?: readonly string[];
  /**
   * Il turno parte in una conversazione nuova del motore, senza la storia della sessione (collaudo in VM del
   * 24/10/2026: un modello piccolo che ha appena pianificato nella stessa sessione rimanda il piano invece di
   * eseguire). Vale per i motori a processo per turno; per i PTY la sessione resta quella aperta.
   */
  readonly freshSession?: boolean;
}

interface TurnTrace {
  readonly sessionId: string | null;
  readonly processIds: readonly string[];
  readonly turnId: string | null;
}

export type TurnResult =
  | ({ status: 'succeeded'; text: string; artifacts: string[] } & TurnTrace)
  | ({ status: 'failed'; error: TaskError } & TurnTrace)
  | ({ status: 'cancelled'; reason: string } & TurnTrace)
  | { status: 'waiting'; approvalId: string; reason: string };

/** Turno registrato in `turns` (Fase 7): brief inviato, esito, testo finale. */
export interface TurnRecord {
  readonly id: string;
  readonly agentId: string;
  readonly taskId: string | null;
  readonly attempt: number;
  /** `lost` = turno aperto quando il core è caduto. */
  readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'lost' | null;
  readonly outputText: string | null;
  readonly error: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface TurnBrief {
  readonly text: string;
  /** File del brief (`brief\<turno>.md`), vuoto se non scritto. */
  readonly ref: string;
  /** File della posta inclusi nel brief: archiviati dopo un turno riuscito. */
  readonly consumed: readonly string[];
}

/** Contesto dei turni (Context Builder, Fase 7): compone il brief e chiude il turno (memoria, posta, riflessione). */
export interface TurnContextProvider {
  build(input: { def: AgentDefinition; req: TurnRequest; turnId: string; agentDir: string; previous: readonly TurnRecord[] }): TurnBrief;
  afterTurn(input: { def: AgentDefinition; req: TurnRequest; turnId: string; outcome: 'succeeded' | 'failed' | 'cancelled'; text: string | null; brief: TurnBrief }): void;
}

// Brief minimo, senza memoria. Nessuna richiesta di scrivere file: nei motori con permessi interattivi
// aprirebbe un dialogo che ferma il turno (P-38). Il risultato è il testo finale; `results\<task>.md`,
// se l'agente lo scrive da sé, ha la precedenza.
export function minimalBrief(req: Pick<TurnRequest, 'title' | 'spec' | 'acceptance'>): string {
  return [
    `Compito: ${req.title}`,
    '',
    req.spec,
    ...(req.acceptance ? ['', `Criteri di accettazione: ${req.acceptance}`] : []),
    '',
    'Rispondi solo a QUESTO compito: le richieste precedenti di questa conversazione rimaste senza risposta (per esempio interrotte da un limite del servizio) sono chiuse e non vanno eseguite.',
    'Rispondi con il risultato finale.'
  ].join('\n');
}

const MINIMAL_CONTEXT: TurnContextProvider = {
  build: ({ req }) => ({ text: minimalBrief(req), ref: '', consumed: [] }),
  afterTurn: () => undefined
};

export interface AgentStartResult {
  readonly started: boolean;
  readonly status: AgentStatus | null;
  readonly approvalId: string | null;
  readonly reason: string | null;
}

export interface AgentModelOffer {
  readonly id: string;
  readonly source: 'configured' | 'probe';
  readonly detail: string | null;
}

export interface AgentModelsResult {
  readonly agentId: string;
  readonly adapter: string;
  readonly current: string | null;
  readonly selectable: boolean;
  readonly models: AgentModelOffer[];
  readonly effort: { readonly current: string | null; readonly options: string[] } | null;
  readonly live: boolean;
  readonly applies: 'next-turn' | 'next-session';
}

export interface AgentTuningResult {
  readonly agentId: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly version: number;
  readonly applies: 'next-turn' | 'next-session';
  readonly live: boolean;
}

export interface AgentManager {
  define(input: AgentDefinitionInput, by: string, correlationId: string): { agentId: string; version: number; created: boolean };
  archive(agentId: string, by: string, correlationId: string): Promise<{ alreadyArchived: boolean }>;
  /** Definizione attiva (non archiviata). */
  get(agentId: string): AgentDefinition | null;
  /** Definizioni attive in ordine di id (deterministico per il router). */
  active(): AgentDefinition[];
  views(opts: { includeArchived: boolean; breakerOf: (agentId: string) => BreakerLevel }): AgentView[];
  /** Esegue un turno per un task: avvia o riprende l'istanza se serve. Mai un'eccezione. */
  runTurn(req: TurnRequest): Promise<TurnResult>;
  /** Avvia o riprende la sessione senza un turno (P-83): alla wake la UI mostra il terminale. */
  ensure(agentId: string, by: string, correlationId: string): Promise<AgentStartResult>;
  /**
   * Agente di ripiego (P-83): adapter diverso da quelli esclusi, definizione valida, non occupato;
   * `preferred` (config) se disponibile. Nessun nome di motore: decide il registro degli adapter.
   */
  fallback(opts: { exclude: ReadonlySet<string>; preferred?: string | null }): { agentId: string; reason: string } | null;
  /** Modelli e potenza applicabili all'agente (P-83): config e probe dell'adapter. */
  models(agentId: string, opts?: { refresh?: boolean }): Promise<AgentModelsResult>;
  /** Cambia modello e/o potenza nella definizione (validati dall'adapter, auditati). */
  tuning(agentId: string, change: { model?: string; effort?: string | null }, by: string, correlationId: string): AgentTuningResult;
  /** P-99: rinomina il nome mostrato (display name); id interno invariato, evento/audit, v+1. */
  rename(agentId: string, name: string, by: string, correlationId: string): { agentId: string; name: string; version: number; changed: boolean };
  /** L'agente ha un turno in corso o si sta avviando. */
  isBusy(agentId: string): boolean;
  status(agentId: string): AgentStatus | null;
  steer(agentId: string, note: string): Promise<boolean>;
  stop(agentId: string, opts: { mode: 'graceful' | 'force'; reason: string; by: string; correlationId?: string }): Promise<boolean>;
  stopAll(reason: string, deadlineMs: number): Promise<number>;
  /** All'avvio del core: le istanze rimaste aperte non hanno più processi controllati → crashed. */
  recover(): number;
  counts(): { defined: number; live: number; working: number };
}

export interface AgentManagerDeps {
  db: Db;
  events: EventEmitter;
  log: Logger;
  adapters: AdapterRegistry;
  runtime: CliRuntime;
  hooks?: HookServer;
  audit: AuditLog;
  approvals: ApprovalQueue;
  policy: ActionPolicy;
  agentsDir: string;
  workspaceDir: string;
  now?: () => number;
  stopDeadlineMs?: number;
  /** Context Builder (Fase 7); assente = brief minimo. */
  context?: TurnContextProvider;
  /** `agents.defaultModel` (P-83): proposto tra i modelli applicabili quando l'adapter lo accetta. */
  defaultModel?: string;
}

const SOURCE = { kind: 'visione', id: 'agents' } as const;
const MAX_RESULT = 20_000;

interface Live {
  row: AgentInstance;
  def: AgentDefinition;
  adapter: AgentAdapter;
  ctx: AdapterContext;
  abort: AbortController;
  session: AgentSession | undefined;
  workspace: string;
  starting: boolean;
  turn: { turnId: string; taskId: string; correlationId: string; texts: string[]; finals: string[] } | null;
}

/** Cartella di lavoro di un agente: assoluta (scelta dal proprietario) o relativa a `workspace\`. */
export function resolveWorkspace(def: Pick<AgentDefinition, 'workspace'>, workspaceDir: string): string {
  const root = def.workspace.root;
  return isAbsolute(root) ? resolve(root) : resolve(workspaceDir, root);
}

export function createAgentManager(deps: AgentManagerDeps): AgentManager {
  const { db, events, log, adapters, runtime, audit, approvals, policy } = deps;
  const now = deps.now ?? Date.now;
  const stopDeadlineMs = deps.stopDeadlineMs ?? 10_000;
  const context = deps.context ?? MINIMAL_CONTEXT;
  const live = new Map<string, Live>();

  const q = {
    def: db.prepare('SELECT * FROM agent_definitions WHERE id = ?'),
    defs: db.prepare('SELECT * FROM agent_definitions ORDER BY id'),
    insertDef: db.prepare('INSERT INTO agent_definitions (id, name, adapter, definition, version, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'),
    updateDef: db.prepare('UPDATE agent_definitions SET name = ?, adapter = ?, definition = ?, version = ?, archived = 0, updated_at = ? WHERE id = ?'),
    archiveDef: db.prepare('UPDATE agent_definitions SET archived = 1, updated_at = ? WHERE id = ?'),
    insertInst: db.prepare('INSERT INTO agent_instances (id, agent_id, status, status_reason, session_id, current_task_id, attempts, created_at) VALUES (?, ?, ?, ?, ?, NULL, 0, ?)'),
    updateInst: db.prepare('UPDATE agent_instances SET status = ?, status_reason = ?, session_id = ?, current_task_id = ?, attempts = ?, started_at = ?, last_event_at = ?, ended_at = ? WHERE id = ?'),
    lastInst: db.prepare('SELECT * FROM agent_instances WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'),
    openInst: db.prepare("SELECT * FROM agent_instances WHERE status NOT IN ('stopped', 'crashed') ORDER BY created_at, id"),
    upsertSession: db.prepare(`INSERT INTO agent_sessions (id, agent_id, adapter, engine_session_id, model, resumable, started_at, last_turn_at, usage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET engine_session_id = excluded.engine_session_id,
      resumable = excluded.resumable, last_turn_at = excluded.last_turn_at, usage = COALESCE(excluded.usage, agent_sessions.usage)`),
    lastSession: db.prepare('SELECT * FROM agent_sessions WHERE agent_id = ? AND adapter = ? AND resumable = 1 ORDER BY IFNULL(last_turn_at, started_at) DESC, id DESC LIMIT 1'),
    anySession: db.prepare('SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY IFNULL(last_turn_at, started_at) DESC, id DESC LIMIT 1'),
    insertTurn: db.prepare('INSERT INTO turns (id, agent_id, session_id, task_id, correlation_id, attempt, input_ref, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    endTurn: db.prepare('UPDATE turns SET output_text = ?, outcome = ?, error = ?, ended_at = ? WHERE id = ?'),
    loseTurns: db.prepare("UPDATE turns SET outcome = 'lost', error = 'turno interrotto dalla caduta del core', ended_at = ? WHERE ended_at IS NULL"),
    taskTurns: db.prepare('SELECT * FROM turns WHERE task_id = ? ORDER BY started_at, id'),
    counts: db.prepare(`SELECT (SELECT COUNT(*) FROM agent_definitions WHERE archived = 0) AS defined,
      (SELECT COUNT(*) FROM agent_instances WHERE status NOT IN ('stopped', 'crashed')) AS live,
      (SELECT COUNT(*) FROM agent_instances WHERE status = 'working') AS working`)
  };

  const parseDef = (row: Row): AgentDefinition | null => {
    const parsed = agentDefinitionSchema.safeParse(JSON.parse(String(row.definition)));
    if (!parsed.success) {
      log.error('definizione di agente illeggibile: ignorata', { agentId: String(row.id) });
      return null;
    }
    return parsed.data;
  };
  const toInstance = (r: Row): AgentInstance => ({
    id: String(r.id),
    agentId: String(r.agent_id),
    status: String(r.status) as AgentStatus,
    statusReason: r.status_reason === null ? null : String(r.status_reason),
    sessionId: r.session_id === null ? null : String(r.session_id),
    currentTaskId: r.current_task_id === null ? null : String(r.current_task_id),
    attempts: Number(r.attempts),
    createdAt: Number(r.created_at),
    startedAt: r.started_at === null ? null : Number(r.started_at),
    lastEventAt: r.last_event_at === null ? null : Number(r.last_event_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at)
  });
  const toSession = (r: Row | undefined): AgentSession | null => {
    if (!r) return null;
    const parsed = agentSessionSchema.safeParse({
      id: String(r.id),
      engineSessionId: String(r.engine_session_id),
      adapter: String(r.adapter),
      ...(r.model === null ? {} : { model: String(r.model) }),
      startedAt: Number(r.started_at),
      ...(r.last_turn_at === null ? {} : { lastTurnAt: Number(r.last_turn_at) }),
      ...(r.usage === null ? {} : { usage: JSON.parse(String(r.usage)) as unknown }),
      resumable: Number(r.resumable) === 1
    });
    return parsed.success ? parsed.data : null;
  };

  const get = (agentId: string): AgentDefinition | null => {
    const row = q.def.get(agentId);
    if (!row || Number(row.archived) === 1) return null;
    return parseDef(row);
  };

  const saveRow = (row: AgentInstance): void => {
    q.updateInst.run(row.status, row.statusReason, row.sessionId, row.currentTaskId, row.attempts, row.startedAt, row.lastEventAt, row.endedAt, row.id);
  };

  /** Unico punto da cui passa una transizione di istanza: validata, registrata con l'evento. */
  const transition = (l: Live, to: AgentStatus, reason: string, corr?: { correlationId?: string; causationId?: string | null }): boolean => {
    const from = l.row.status;
    if (from === to) return true;
    if (!canAgentTransition(from, to)) {
      log.warn('transizione dell\'istanza rifiutata', { agentId: l.row.agentId, from, to, reason });
      return false;
    }
    const t = now();
    db.transaction(() => {
      l.row = {
        ...l.row,
        status: to,
        statusReason: reason.slice(0, 200),
        lastEventAt: t,
        ...(to === 'idle' && l.row.startedAt === null ? { startedAt: t } : {}),
        ...(TERMINAL_AGENT_STATUSES.has(to) ? { endedAt: t, currentTaskId: null } : {})
      };
      saveRow(l.row);
      events.emit('agent.status.changed', { instanceId: l.row.id, agentId: l.row.agentId, from, to, reason: reason.slice(0, 200) }, {
        source: SOURCE, target: { kind: 'agent', id: l.row.agentId },
        ...(corr?.correlationId ? { correlationId: corr.correlationId } : {}), ...(corr?.causationId ? { causationId: corr.causationId } : {}),
        ...(to === 'crashed' || to === 'error' ? { severity: 'warning' as const } : {})
      });
    });
    if (TERMINAL_AGENT_STATUSES.has(to)) live.delete(l.row.agentId);
    return true;
  };

  const saveSession = (l: Live): void => {
    const s = l.session;
    if (!s) return;
    q.upsertSession.run(s.id, l.row.agentId, s.adapter, s.engineSessionId, s.model ?? null, s.resumable ? 1 : 0, s.startedAt, s.lastTurnAt ?? null, s.usage ? JSON.stringify(s.usage) : null);
  };

  const onAgentEvent = (l: Live, bridge: (e: AgentEvent) => void, e: AgentEvent): void => {
    bridge(e);
    switch (e.kind) {
      case 'message.text':
        if (l.turn && e.turnId === l.turn.turnId) (e.final ? l.turn.finals : l.turn.texts).push(e.text);
        return;
      case 'session.started':
        if (l.session && l.session.engineSessionId !== e.engineSessionId) {
          l.session = { ...l.session, engineSessionId: e.engineSessionId, resumable: true };
          saveSession(l);
        }
        return;
      case 'usage':
        if (l.session && e.source === 'session') {
          l.session = { ...l.session, usage: e.usage };
          saveSession(l);
        }
        return;
      case 'process.exited':
        // Un processo che doveva restare vivo è uscito senza che VISIONE lo chiedesse.
        if (l.row.status === 'idle' || l.row.status === 'working') {
          transition(l, 'crashed', `processo del motore terminato (${e.exit}${e.code === undefined ? '' : `, codice ${e.code}`})`);
        }
        return;
      default:
        return;
    }
  };

  const createLive = (def: AgentDefinition, adapter: AgentAdapter, resume: AgentSession | null, corr: { correlationId: string }): Live => {
    const t = now();
    const id = ulid(t);
    const workspace = resolveWorkspace(def, deps.workspaceDir);
    const row: AgentInstance = {
      id, agentId: def.id, status: 'created', statusReason: 'nuova istanza', sessionId: resume?.id ?? null, currentTaskId: null,
      attempts: 0, createdAt: t, startedAt: null, lastEventAt: t, endedAt: null
    };
    const abort = new AbortController();
    const agentDir = join(deps.agentsDir, def.id);
    let l: Live;
    const bridge = createAgentEventSink({
      events,
      agentId: def.id,
      sessionId: () => l.session?.id ?? null,
      adapter: adapter.id,
      correlationId: () => l.turn?.correlationId,
      taskId: () => l.turn?.taskId ?? null
    });
    const ctx: AdapterContext = {
      get instance() {
        return { id: l.row.id, agentId: def.id, status: l.row.status, ...(l.session ? { session: l.session } : {}) };
      },
      // La definizione si rilegge a ogni uso: il cambio di modello/potenza (P-83) vale dal turno
      // successivo per i motori a processo per turno; per i PTY vale dalla sessione successiva.
      get definition() {
        return l.def;
      },
      runtime,
      agentDir,
      workspaceDir: workspace,
      ...(deps.hooks ? { hooks: deps.hooks } : {}),
      emit: (e) => onAgentEvent(l, bridge, e),
      signal: abort.signal,
      log: log.child(`agent:${def.id}`),
      get trustApproved() {
        return approvals.isGranted(TRUST_ACTION, workspace);
      }
    };
    l = { row, def, adapter, ctx, abort, session: resume ?? undefined, workspace, starting: false, turn: null };
    db.transaction(() => {
      q.insertInst.run(id, def.id, 'created', row.statusReason, null, t);
      events.emit('agent.instance.created', { instanceId: id, agentId: def.id, adapter: adapter.id, resumeSessionId: resume?.id ?? null }, {
        source: SOURCE, target: { kind: 'agent', id: def.id }, correlationId: corr.correlationId
      });
      events.emit('agent.status.changed', { instanceId: id, agentId: def.id, from: null, to: 'created', reason: 'nuova istanza' }, {
        source: SOURCE, target: { kind: 'agent', id: def.id }, correlationId: corr.correlationId
      });
    });
    live.set(def.id, l);
    return l;
  };

  type Ready = { kind: 'ready'; live: Live } | { kind: 'waiting'; approvalId: string; reason: string } | { kind: 'failed'; error: TaskError };

  /** Ciò che serve ad avviare una sessione: senza un task (wake) `taskId` è null. */
  interface StartRequest {
    readonly taskId: string | null;
    readonly correlationId: string;
    readonly causationId?: string | null;
  }

  /** Porta l'istanza in `idle`: la crea, la avvia o la riprende. */
  const ensureReady = async (def: AgentDefinition, adapter: AgentAdapter, req: StartRequest): Promise<Ready> => {
    const corr = { correlationId: req.correlationId, causationId: req.causationId ?? null };
    let l = live.get(def.id);
    // Definizione fresca (P-83): un cambio di modello/potenza vale da questo avvio.
    if (l) l.def = def;
    if (l && l.row.status === 'idle') return { kind: 'ready', live: l };
    if (l && !['error', 'waiting', 'created'].includes(l.row.status)) {
      return { kind: 'failed', error: taskError('agent_unavailable', `istanza in stato ${l.row.status}`, { retryable: true }) };
    }
    const workspace = resolveWorkspace(def, deps.workspaceDir);
    if (l?.row.status === 'waiting' && !approvals.isGranted(TRUST_ACTION, workspace)) {
      const open = approvals.request({ kind: TRUST_ACTION, target: workspace, reason: `l'agente ${def.id} attende la conferma della fiducia nella cartella`, requestedBy: `agent:${def.id}`, taskId: req.taskId, agentId: def.id, correlationId: req.correlationId });
      return { kind: 'waiting', approvalId: open.approval.id, reason: 'fiducia nella cartella da approvare' };
    }
    if (l && l.row.status === 'error') {
      // Ripartenza pulita: eventuali processi residui dell'istanza vengono fermati prima.
      await l.adapter.stop(l.ctx, 'force', stopDeadlineMs).catch((err: unknown) => log.warn('stop prima del riavvio non riuscito', { agentId: def.id, err }));
    }
    if (!l) {
      const resume = toSession(q.lastSession.get(def.id, adapter.id));
      l = createLive(def, adapter, resume, corr);
    }
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(deps.agentsDir, def.id, 'outbox'), { recursive: true });
    mkdirSync(join(deps.agentsDir, def.id, 'inbox'), { recursive: true });
    mkdirSync(join(deps.agentsDir, def.id, 'results'), { recursive: true });
    if (isAbsolute(def.workspace.root)) runtime.policy.allowRoot(workspace);

    l.starting = true;
    l.row = { ...l.row, attempts: l.row.attempts + 1, sessionId: l.session?.id ?? l.row.sessionId };
    transition(l, 'starting', l.session ? `ripresa della sessione ${l.session.id}` : 'avvio', corr);
    try {
      const session = await adapter.start(l.ctx, l.session);
      l.session = session;
      l.row = { ...l.row, sessionId: session.id, attempts: 0 };
      saveSession(l);
      transition(l, 'idle', 'sessione pronta', corr);
      return { kind: 'ready', live: l };
    } catch (err) {
      const rte: RuntimeError | null = err instanceof AdapterError ? err.error : null;
      if (rte?.code === 'trust_required') {
        const asked = approvals.request({
          kind: TRUST_ACTION, target: workspace,
          reason: `il motore dell'agente ${def.id} chiede di confermare la fiducia nella cartella di lavoro`,
          requestedBy: `agent:${def.id}`, taskId: req.taskId, agentId: def.id, correlationId: req.correlationId
        });
        transition(l, 'waiting', 'waiting:approval', corr);
        return { kind: 'waiting', approvalId: asked.approval.id, reason: 'fiducia nella cartella da approvare' };
      }
      const message = rte?.message ?? (err instanceof Error ? err.message : String(err));
      log.error('avvio dell\'agente non riuscito', { agentId: def.id, code: rte?.code ?? 'internal', message });
      transition(l, 'error', `avvio non riuscito: ${rte?.code ?? 'internal'}`.slice(0, 200), corr);
      return { kind: 'failed', error: taskError('agent_unavailable', message, { retryable: rte?.retryable ?? false, runtimeCode: rte?.code ?? null }) };
    } finally {
      l.starting = false;
    }
  };

  const toTurn = (r: Row): TurnRecord => ({
    id: String(r.id),
    agentId: String(r.agent_id),
    taskId: r.task_id === null ? null : String(r.task_id),
    attempt: Number(r.attempt),
    outcome: r.outcome === null ? null : (String(r.outcome) as TurnRecord['outcome']),
    outputText: r.output_text === null ? null : String(r.output_text),
    error: r.error === null ? null : String(r.error),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at)
  });

  /** Brief dal Context Builder; un suo errore non ferma il turno (brief minimo). */
  const buildBrief = (def: AgentDefinition, req: TurnRequest, turnId: string, agentDir: string): TurnBrief => {
    try {
      return context.build({ def, req, turnId, agentDir, previous: q.taskTurns.all(req.taskId).map(toTurn) });
    } catch (err) {
      log.error('brief del turno non composto: uso il brief minimo', { agentId: def.id, taskId: req.taskId, err });
      return { text: minimalBrief(req), ref: '', consumed: [] };
    }
  };

  const processIdsOf = (agentId: string, sessionId: string | null, since: number): string[] =>
    runtime
      .list({ agentId })
      .filter((p) => p.createdAt >= since || (sessionId !== null && p.owner.sessionId === sessionId && p.endedAt === null))
      .map((p) => p.id)
      .slice(-20);

  /** Chiusura del turno: sessione salvata, istanza aggiornata, esito per il Task Engine. */
  function finishTurn(
    l: Live,
    def: AgentDefinition,
    outcome: Awaited<ReturnType<AgentAdapter['sendTurn']>>,
    t: { turnId: string; since: number; resultsFile: string; corr: { correlationId: string; causationId: string | null }; cancelReason: string | null }
  ): TurnResult {
    const { turnId, since, resultsFile, corr, cancelReason } = t;
    const turn = l.turn ?? { texts: [], finals: [] };
    l.turn = null;
    if (l.session) {
      l.session = {
        ...l.session,
        lastTurnAt: now(),
        ...(outcome.engineSessionId ? { engineSessionId: outcome.engineSessionId, resumable: true } : {})
      };
      saveSession(l);
    }
    const trace: TurnTrace = { sessionId: l.session?.id ?? null, processIds: processIdsOf(def.id, l.session?.id ?? null, since), turnId };
    const stillOurs = l.row.status === 'working' && live.get(def.id) === l;
    if (stillOurs) l.row = { ...l.row, currentTaskId: null };

    if (outcome.outcome === 'completed') {
      if (stillOurs) transition(l, 'idle', 'turno completato', corr);
      let text = (turn.finals.length > 0 ? turn.finals : turn.texts).join('\n').trim();
      const artifacts: string[] = [];
      // `results\` è scritto dall'agente: dati non fidati, letti come testo e limitati.
      if (existsSync(resultsFile)) {
        try {
          text = readFileSync(resultsFile, 'utf8').slice(0, MAX_RESULT).trim() || text;
          artifacts.push(resultsFile);
        } catch (err) {
          log.warn('file dei risultati illeggibile', { agentId: def.id, err });
        }
      }
      return { status: 'succeeded', text: text.slice(0, MAX_RESULT), artifacts, ...trace };
    }
    if (outcome.outcome === 'cancelled' || cancelReason !== null) {
      if (stillOurs) transition(l, 'idle', 'turno annullato', corr);
      return { status: 'cancelled', reason: cancelReason ?? outcome.error?.message ?? 'annullato', ...trace };
    }
    const rte = outcome.error;
    if (stillOurs) transition(l, 'error', `turno fallito: ${rte?.code ?? 'engine_error'}`.slice(0, 200), corr);
    return {
      status: 'failed',
      error: taskError('turn_failed', rte?.message ?? 'turno fallito', { retryable: rte?.retryable ?? false, runtimeCode: rte?.code ?? null }),
      ...trace
    };
  }

  const manager: AgentManager = {
    define(input, by, correlationId) {
      const adapter = adapters.get(input.engine.adapter);
      if (!adapter) throw new CommandFailure('invalid_payload', `adapter sconosciuto: ${input.engine.adapter}`);
      const root = input.workspace.root;
      if (!isAbsolute(root) && normalize(root).split(sep).some((part) => part === '..')) {
        throw new CommandFailure('invalid_payload', 'la cartella di lavoro relativa non può uscire da workspace');
      }
      const workspace = resolveWorkspace(input, deps.workspaceDir);
      const verdict = policy.classify({ kind: 'fs.write', target: workspace }, { actor: 'owner', roots: [workspace] });
      if (verdict.class === 'block') throw new CommandFailure('forbidden', `cartella di lavoro non consentita: ${verdict.reason}`);
      const existing = q.def.get(input.id);
      const previous = existing ? parseDef(existing) : null;
      const t = now();
      const def: AgentDefinition = {
        ...input,
        createdBy: previous?.createdBy ?? by,
        createdAt: previous?.createdAt ?? t,
        version: (previous?.version ?? 0) + 1
      };
      const valid = adapter.validate(def);
      if (!valid.ok) throw new CommandFailure('invalid_payload', valid.problems.join('; ').slice(0, 2000));
      db.transaction(() => {
        if (existing) q.updateDef.run(def.name, def.engine.adapter, JSON.stringify(def), def.version, t, def.id);
        else q.insertDef.run(def.id, def.name, def.engine.adapter, JSON.stringify(def), def.version, t, t);
        audit.record({ actor: by, action: existing ? 'agent.update' : 'agent.define', subject: def.id, decision: 'done', detail: `${def.name} · ${def.engine.adapter} · v${def.version}`, correlationId });
        const wasArchived = existing !== undefined && Number(existing.archived) === 1;
        events.emit(existing && !wasArchived ? 'agent.definition.updated' : 'agent.definition.created', {
          agentId: def.id, name: def.name, adapter: def.engine.adapter, version: def.version, by
        }, { source: SOURCE, target: { kind: 'agent', id: def.id }, correlationId });
      });
      return { agentId: def.id, version: def.version, created: existing === undefined };
    },

    async archive(agentId, by, correlationId) {
      const row = q.def.get(agentId);
      if (!row) throw new CommandFailure('not_found', `agente sconosciuto: ${agentId}`);
      if (Number(row.archived) === 1) return { alreadyArchived: true };
      await manager.stop(agentId, { mode: 'graceful', reason: 'definizione archiviata', by, correlationId });
      db.transaction(() => {
        q.archiveDef.run(now(), agentId);
        audit.record({ actor: by, action: 'agent.archive', subject: agentId, decision: 'done', detail: '', correlationId });
        events.emit('agent.definition.archived', { agentId, by }, { source: SOURCE, target: { kind: 'agent', id: agentId }, correlationId });
      });
      return { alreadyArchived: false };
    },

    get,

    active() {
      return q.defs.all().filter((r) => Number(r.archived) === 0).map(parseDef).filter((d): d is AgentDefinition => d !== null);
    },

    views(opts) {
      return q.defs.all()
        .filter((r) => opts.includeArchived || Number(r.archived) === 0)
        .map((r): AgentView | null => {
          const def = parseDef(r);
          if (!def) return null;
          const inst = live.get(def.id)?.row ?? (() => {
            const last = q.lastInst.get(def.id);
            return last ? toInstance(last) : null;
          })();
          // Capacità dichiarate dall'adapter (P-83): la UI le usa per wake e selettori.
          const capabilities = [...(adapters.get(def.engine.adapter)?.capabilities ?? [])].sort();
          return { definition: def, archived: Number(r.archived) === 1, instance: inst, session: toSession(q.anySession.get(def.id)), breaker: opts.breakerOf(def.id), capabilities };
        })
        .filter((v): v is AgentView => v !== null);
    },

    async ensure(agentId, by, correlationId) {
      const def = get(agentId);
      if (!def) return { started: false, status: null, approvalId: null, reason: `agente sconosciuto o archiviato: ${agentId}` };
      const adapter = adapters.get(def.engine.adapter);
      if (!adapter) return { started: false, status: null, approvalId: null, reason: `adapter non disponibile: ${def.engine.adapter}` };
      const existing = live.get(agentId);
      if (existing) {
        existing.def = def; // definizione fresca (P-83)
        return { started: true, status: existing.row.status, approvalId: null, reason: null };
      }
      const ready = await ensureReady(def, adapter, { taskId: null, correlationId });
      const status = manager.status(agentId);
      if (ready.kind === 'ready') {
        audit.record({ actor: by, action: 'agent.start', subject: agentId, decision: 'done', detail: 'sessione avviata senza turno', correlationId });
        return { started: true, status, approvalId: null, reason: null };
      }
      if (ready.kind === 'waiting') {
        audit.record({ actor: by, action: 'agent.start', subject: agentId, decision: 'waiting', detail: ready.reason, correlationId });
        return { started: false, status, approvalId: ready.approvalId, reason: ready.reason };
      }
      audit.record({ actor: by, action: 'agent.start', subject: agentId, decision: 'failed', detail: ready.error.message.slice(0, 200), correlationId });
      return { started: false, status, approvalId: null, reason: ready.error.message };
    },

    fallback(opts) {
      const adaptersOf = (ids: Iterable<string>): Set<string> => {
        const out = new Set<string>();
        for (const id of ids) {
          const d = get(id);
          if (d) out.add(d.engine.adapter);
        }
        return out;
      };
      const excludedAdapters = adaptersOf(opts.exclude);
      const usable = (d: AgentDefinition): boolean => {
        if (opts.exclude.has(d.id) || excludedAdapters.has(d.engine.adapter)) return false;
        if (manager.isBusy(d.id)) return false;
        const a = adapters.get(d.engine.adapter);
        return a !== undefined && a.validate(d).ok;
      };
      if (opts.preferred) {
        const preferred = get(opts.preferred);
        if (preferred && usable(preferred)) return { agentId: preferred.id, reason: 'agente di ripiego configurato' };
      }
      for (const d of manager.active()) {
        if (usable(d)) return { agentId: d.id, reason: `motore alternativo (${d.engine.adapter})` };
      }
      return null;
    },

    async models(agentId, opts = {}) {
      const def = get(agentId);
      if (!def) throw new CommandFailure('not_found', `agente sconosciuto o archiviato: ${agentId}`);
      const adapter = adapters.get(def.engine.adapter);
      if (!adapter) throw new CommandFailure('not_found', `adapter non disponibile: ${def.engine.adapter}`);
      const offers = new Map<string, AgentModelOffer>();
      const consider = (id: string | null | undefined, source: 'configured' | 'probe', detail: string | null): void => {
        if (!id || offers.has(id)) return;
        const patched: AgentDefinition = { ...def, engine: { ...def.engine, model: id } };
        if (!adapter.validate(patched).ok) return;
        offers.set(id, { id, source, detail });
      };
      if (def.engine.model) consider(def.engine.model, 'configured', 'corrente');
      for (const other of manager.active()) {
        if (other.id !== def.id && other.engine.adapter === def.engine.adapter && other.engine.model) {
          consider(other.engine.model, 'configured', `agente ${other.id}`);
        }
      }
      if (deps.defaultModel) consider(deps.defaultModel, 'configured', 'agents.defaultModel');
      if (adapter.listModels) {
        try {
          const probed = await adapter.listModels(def, { workspaceDir: resolveWorkspace(def, deps.workspaceDir), refresh: opts.refresh ?? false });
          for (const m of probed) consider(m.id, 'probe', m.detail ?? null);
        } catch (err) {
          log.warn('elenco dei modelli non disponibile: mostro solo i configurati', { agentId, err });
        }
      }
      const tuning = adapter.tuning ? adapter.tuning(def) : null;
      const effort = tuning?.effort ?? null;
      const applies: 'next-turn' | 'next-session' = adapter.capabilities.has('turns.interactive') ? 'next-session' : 'next-turn';
      return {
        agentId, adapter: def.engine.adapter, current: def.engine.model ?? null,
        selectable: adapter.capabilities.has('model.select'), models: [...offers.values()],
        effort: effort ? { current: effort.current, options: [...effort.options] } : null,
        live: live.has(agentId), applies
      };
    },

    tuning(agentId, change, by, correlationId) {
      const def = get(agentId);
      if (!def) throw new CommandFailure('not_found', `agente sconosciuto o archiviato: ${agentId}`);
      const adapter = adapters.get(def.engine.adapter);
      if (!adapter) throw new CommandFailure('not_found', `adapter non disponibile: ${def.engine.adapter}`);
      const engine: AgentDefinition['engine'] = { ...def.engine };
      if (change.model !== undefined) {
        const model = change.model.trim();
        if (model === '') delete engine.model;
        else engine.model = model;
      }
      if (change.effort !== undefined) {
        const tuning = adapter.tuning?.(def) ?? null;
        if (!tuning?.effort) throw new CommandFailure('invalid_payload', `il motore ${def.engine.adapter} non dichiara la potenza (effort)`);
        const options: Record<string, unknown> = { ...(engine.options ?? {}) };
        if (change.effort === null || change.effort === '') delete options.effort;
        else options.effort = change.effort;
        if (Object.keys(options).length > 0) engine.options = options;
        else delete engine.options;
      }
      if (change.model !== undefined || change.effort !== undefined) {
        manager.define({
          id: def.id, name: def.name, role: def.role, competences: def.competences, engine,
          persona: def.persona, workspace: def.workspace, permissions: def.permissions, limits: def.limits
        }, by, correlationId);
      }
      const current = get(agentId) ?? def;
      const l = live.get(agentId);
      if (l) l.def = current;
      const effortValue = current.engine.options?.effort;
      return {
        agentId, model: current.engine.model ?? null,
        effort: typeof effortValue === 'string' ? effortValue : null,
        version: current.version,
        applies: adapter.capabilities.has('turns.interactive') ? 'next-session' : 'next-turn',
        live: l !== undefined
      };
    },

    /**
     * P-99 — rinomina il display name. Riusa `define` (validazione, versione +1, evento
     * `agent.definition.updated`), con in più un audit esplicito `agent.rename`: l'id interno non
     * cambia mai, quindi task, terminali e sessioni continuano a puntare all'agente giusto.
     */
    rename(agentId, name, by, correlationId) {
      const def = get(agentId);
      if (!def) throw new CommandFailure('not_found', `agente sconosciuto o archiviato: ${agentId}`);
      const clean = name.trim();
      if (clean.length === 0 || clean.length > 80) throw new CommandFailure('invalid_payload', 'nome non valido: 1..80 caratteri');
      if (clean === def.name) return { agentId, name: clean, version: def.version, changed: false };
      manager.define({
        id: def.id, name: clean, role: def.role, competences: def.competences, engine: def.engine,
        persona: def.persona, workspace: def.workspace, permissions: def.permissions, limits: def.limits
      }, by, correlationId);
      const current = get(agentId) ?? def;
      audit.record({
        actor: by, action: 'agent.rename', subject: agentId, decision: 'done',
        detail: `«${def.name}» → «${clean}» (id ${agentId} invariato, v${current.version})`, correlationId
      });
      return { agentId, name: clean, version: current.version, changed: true };
    },

    async runTurn(req) {
      const def = get(req.agentId);
      const none: TurnTrace = { sessionId: null, processIds: [], turnId: null };
      if (!def) return { status: 'failed', error: taskError('agent_unavailable', `agente sconosciuto o archiviato: ${req.agentId}`), ...none };
      const adapter = adapters.get(def.engine.adapter);
      if (!adapter) return { status: 'failed', error: taskError('agent_unavailable', `adapter non disponibile: ${def.engine.adapter}`), ...none };
      if (manager.isBusy(def.id)) return { status: 'failed', error: taskError('agent_unavailable', 'agente già al lavoro: un turno alla volta', { retryable: true }), ...none };
      if (req.signal.aborted) return { status: 'cancelled', reason: String(req.signal.reason ?? 'annullato'), ...none };

      // L'annullamento si ascolta da subito: può arrivare mentre l'istanza si avvia (P-38).
      let cancelReason: string | null = null;
      let turning: Live | null = null;
      const onAbort = (): void => {
        cancelReason = typeof req.signal.reason === 'string' ? req.signal.reason : 'annullato';
        const target = turning;
        if (target) void target.adapter.cancelTurn(target.ctx, cancelReason).catch((err: unknown) => log.warn('annullamento del turno non riuscito', { agentId: def.id, err }));
      };
      req.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const ready = await ensureReady(def, adapter, req);
        if (ready.kind === 'waiting') return { status: 'waiting', approvalId: ready.approvalId, reason: ready.reason };
        if (ready.kind === 'failed') return { status: 'failed', error: ready.error, ...none };
        // Annullato durante l'avvio: nessun turno inviato.
        if (cancelReason !== null) return { status: 'cancelled', reason: cancelReason, ...none };
        const l = ready.live;
        if (req.freshSession && l.session && l.session.engineSessionId !== '') l.session = { ...l.session, engineSessionId: '' };
        const corr = { correlationId: req.correlationId, causationId: req.causationId ?? null };
        const turnId = ulid(now());
        const since = now();
        const resultsFile = join(l.ctx.agentDir, 'results', `${req.taskId}.md`);
        const brief = buildBrief(def, req, turnId, l.ctx.agentDir);
        l.turn = { turnId, taskId: req.taskId, correlationId: req.correlationId, texts: [], finals: [] };
        l.row = { ...l.row, currentTaskId: req.taskId };
        q.insertTurn.run(turnId, def.id, l.session?.id ?? null, req.taskId, req.correlationId, req.attempt, brief.ref, since);
        transition(l, 'working', `task ${req.taskId}`, corr);
        turning = l;
        let outcome: Awaited<ReturnType<AgentAdapter['sendTurn']>>;
        try {
          const copies = copyAttachments(req.attachments ?? [], l.ctx.workspaceDir, turnId, now(), (path, why) => log.warn("allegato non dato all'agente", { agentId: def.id, path, why }));
          outcome = await l.adapter.sendTurn(l.ctx, {
            turnId, taskId: req.taskId, text: briefWithAttachments(brief.text, copies), correlationId: req.correlationId,
            ...(copies.length > 0 ? { attachments: copies.map((c) => c.copy) } : {})
          });
        } catch (err) {
          const rte = err instanceof AdapterError ? err.error : null;
          outcome = { outcome: 'failed', error: rte ?? { code: 'engine_error', message: (err instanceof Error ? err.message : String(err)).slice(0, 500), retryable: false }, engineSessionId: null };
        }
        const result = finishTurn(l, def, outcome, { turnId, since, resultsFile, corr, cancelReason: cancelReason as string | null });
        if (result.status === 'waiting') return result;
        const text = result.status === 'succeeded' ? result.text : null;
        const error = result.status === 'failed' ? `${result.error.code}: ${result.error.message}` : result.status === 'cancelled' ? result.reason : null;
        q.endTurn.run(text, result.status, error === null ? null : error.slice(0, 1_000), now(), turnId);
        try {
          context.afterTurn({ def, req, turnId, outcome: result.status, text, brief });
        } catch (err) {
          log.error('chiusura del turno (memoria) non riuscita', { agentId: def.id, taskId: req.taskId, err });
        }
        return result;
      } finally {
        req.signal.removeEventListener('abort', onAbort);
      }
    },


    isBusy(agentId) {
      const l = live.get(agentId);
      return l !== undefined && (l.turn !== null || l.starting);
    },

    status(agentId) {
      return live.get(agentId)?.row.status ?? null;
    },

    async steer(agentId, note) {
      const l = live.get(agentId);
      if (!l?.adapter.steer || !l.adapter.capabilities.has('control.steer')) return false;
      await l.adapter.steer(l.ctx, note);
      return true;
    },

    async stop(agentId, opts) {
      const l = live.get(agentId);
      if (!l) return false;
      const corr = opts.correlationId ? { correlationId: opts.correlationId } : undefined;
      audit.record({ actor: opts.by, action: 'agent.stop', subject: agentId, decision: opts.mode, detail: opts.reason, correlationId: opts.correlationId ?? null });
      if (!transition(l, 'stopping', opts.reason, corr)) return false;
      l.abort.abort(opts.reason);
      try {
        await l.adapter.stop(l.ctx, opts.mode, stopDeadlineMs);
      } catch (err) {
        log.warn('stop dell\'agente non riuscito: kill dei processi', { agentId, err });
        for (const p of runtime.list({ agentId, live: true })) await runtime.stop(p.id, { mode: 'force', reason: opts.reason });
      }
      // Nessun processo dell'agente deve sopravvivere allo stop.
      for (const p of runtime.list({ agentId, live: true })) await runtime.stop(p.id, { mode: 'force', reason: opts.reason });
      transition(l, 'stopped', opts.reason, corr);
      return true;
    },

    async stopAll(reason, deadlineMs) {
      const ids = [...live.keys()];
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(ids.map((id) => manager.stop(id, { mode: 'graceful', reason, by: 'system' }))),
        new Promise<void>((r) => { timer = setTimeout(r, deadlineMs); })
      ]);
      clearTimeout(timer);
      return ids.length;
    },

    recover() {
      // Turni aperti di un core caduto: chiusi come `lost` (il brief di ripresa lo dichiara).
      q.loseTurns.run(now());
      let n = 0;
      for (const r of q.openInst.all()) {
        const row = toInstance(r);
        // P-95: le istanze rimaste aperte non sono «schiantate»: i processi dell'app precedente
        // sono terminati con l'app. Si riconciliano come `stopped` (terminale, sessione
        // riprendibile), con il motivo reale; solo un'uscita anomala col core VIVO è `crashed`.
        const t = now();
        db.transaction(() => {
          q.updateInst.run('stopped', 'sessione chiusa con l\'app precedente (processo non più controllato)', row.sessionId, null, row.attempts, row.startedAt, t, t, row.id);
          events.emit('agent.status.changed', { instanceId: row.id, agentId: row.agentId, from: row.status, to: 'stopped', reason: 'sessione chiusa con l\'app precedente (processo non più controllato)' }, {
            source: SOURCE, target: { kind: 'agent', id: row.agentId }
          });
        });
        n++;
      }
      return n;
    },

    counts() {
      const r = q.counts.get();
      return { defined: Number(r?.defined ?? 0), live: Number(r?.live ?? 0), working: Number(r?.working ?? 0) };
    }
  };
  return manager;
}

/**
 * Gate delle azioni degli strumenti per gli adapter (P-39): policy → bloccata (negata e registrata),
 * con approvazione (negata finché il proprietario non approva quell'azione; richiesta in coda),
 * consentita (decide il motore). Mai un'attesa nell'hook: il motore riprova dopo la decisione.
 */
export function createActionGate(deps: {
  policy: ActionPolicy;
  approvals: ApprovalQueue;
  audit: AuditLog;
  events: EventEmitter;
  rootsOf: (agentId: string) => string[];
  /** Agente in modalità fiducia (P-102), scelto dal proprietario nella configurazione. */
  isTrusted?: (agentId: string) => boolean;
  log: Logger;
}): ActionGate {
  return (agentId, action) => {
    try {
      const trusted = deps.isTrusted?.(agentId) === true;
      const verdict = deps.policy.classify(action, { actor: 'agent', roots: deps.rootsOf(agentId), trusted });
      if (verdict.class === 'allow') {
        // Ciò che passa solo grazie alla fiducia resta tracciato: il proprietario lo rilegge nell'audit.
        if (verdict.rule.endsWith(':trusted')) {
          deps.audit.record({ actor: `agent:${agentId}`, action: `trusted:${action.kind}`, subject: action.target.slice(0, 200), decision: 'allow', detail: verdict.reason });
        }
        return null;
      }
      if (verdict.class === 'approval' && deps.approvals.isGranted(action.kind, action.target)) return { decision: 'allow', reason: 'approvato dal proprietario' };
      let approvalId: string | null = null;
      if (verdict.class === 'approval') {
        approvalId = deps.approvals.request({ kind: action.kind, target: action.target, reason: verdict.reason, requestedBy: `agent:${agentId}`, agentId, correlationId: ulid() }).approval.id;
      } else {
        deps.audit.record({ actor: `agent:${agentId}`, action: `blocked:${action.kind}`, subject: action.target.slice(0, 200), decision: 'block', detail: verdict.reason });
      }
      deps.events.emit('tool.call.denied', { agentId, tool: action.kind.slice(0, 100), classification: verdict.class, reason: verdict.reason, approvalId }, {
        source: { kind: 'visione', id: 'policy' }, target: { kind: 'agent', id: agentId }
      });
      const reason = verdict.class === 'block'
        ? `Bloccato dalla policy di VISIONE: ${verdict.reason}`
        : `Richiede l'approvazione del proprietario (richiesta ${approvalId}): ${verdict.reason}. Prosegui senza questa azione o riprova dopo la decisione.`;
      return { decision: 'deny', reason: reason.slice(0, 500) };
    } catch (err) {
      deps.log.error('gate delle azioni non riuscito: azione negata', { agentId, err });
      return { decision: 'deny', reason: 'errore interno della policy di VISIONE: azione negata per sicurezza' };
    }
  };
}

export function registerAgentCommands(deps: { router: CommandRouter; manager: AgentManager; breakerOf: (agentId: string) => BreakerLevel }): void {
  const { router, manager } = deps;
  router.register('agents.list', (payload) => ({ agents: manager.views({ includeArchived: payload.includeArchived, breakerOf: deps.breakerOf }) }));
  router.register('agents.define', (payload, ctx) => manager.define(payload.definition, `owner:${ctx.command.issuedBy}`, ctx.command.correlationId));
  router.register('agents.rename', (payload, ctx) => manager.rename(payload.agentId, payload.name, `owner:${ctx.command.issuedBy}`, ctx.command.correlationId));
  router.register('agents.archive', async (payload, ctx) => {
    const out = await manager.archive(payload.agentId, `owner:${ctx.command.issuedBy}`, ctx.command.correlationId);
    return { agentId: payload.agentId, alreadyArchived: out.alreadyArchived };
  });
  router.register('agents.stop', async (payload, ctx) => {
    if (!manager.get(payload.agentId)) throw new CommandFailure('not_found', `agente sconosciuto: ${payload.agentId}`);
    const stopped = await manager.stop(payload.agentId, { mode: payload.mode, reason: `stop richiesto (${ctx.command.issuedBy})`, by: `owner:${ctx.command.issuedBy}`, correlationId: ctx.command.correlationId });
    return { agentId: payload.agentId, stopped };
  });
  // P-83: avvio della sessione senza turno (wake → terminale) e menu modello/potenza.
  router.register('agents.start', async (payload, ctx) => {
    const out = await manager.ensure(payload.agentId, `owner:${ctx.command.issuedBy}`, ctx.command.correlationId);
    return { agentId: payload.agentId, ...out };
  });
  router.register('agents.models', (payload) => manager.models(payload.agentId, { refresh: payload.refresh }));
  router.register('agents.tuning', (payload, ctx) => manager.tuning(
    payload.agentId,
    { ...(payload.model !== undefined ? { model: payload.model } : {}), ...(payload.effort !== undefined ? { effort: payload.effort } : {}) },
    `owner:${ctx.command.issuedBy}`,
    ctx.command.correlationId
  ));
}
