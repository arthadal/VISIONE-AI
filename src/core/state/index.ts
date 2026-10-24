// State Store del core (VISIONE_EVENT_MODEL §5). Lo stato è la situazione corrente; cambia solo
// osservando eventi già registrati (riduttore puro `reduceState`) o segnali interni del kernel
// (salute del journal, canale IPC). Nessun altro modulo lo modifica: ricevono `StateReader`.
// Gli snapshot sono oggetti congelati in profondità: condivisibili senza copia, mai mutabili.
//
// Persistenza (P-29): nello stato nulla è salvato a parte; ciò che serve dopo un riavvio è
// ricostruito dal journal (`recoverState`): ultimo stato del ciclo di vita (uscita pulita o no),
// stato dell'applicazione, ultimo evento, ultimo errore, contatori del journal. Operazioni attive,
// contatori IPC, eventi dall'avvio e revisione sono transitori e ripartono da zero.
import {
  canTransition,
  coreStatusSchema,
  emptyTaskCounts,
  isTerminalTaskStatus,
  TERMINAL_AGENT_STATUSES,
  isEvent,
  severityAtLeast,
  STATE_SCHEMA_VERSION,
  MAX_ACTIVE_OPERATIONS,
  type CoreStateSnapshot,
  type CoreStatus,
  type Edition,
  type EventSummary,
  type ProcessStatus,
  type VisioneEvent,
  type TaskCounts
} from '../../shared/contracts/index.ts';
import type { Journal } from '../journal/index.ts';

export type StateInput =
  | { kind: 'event'; event: VisioneEvent }
  | { kind: 'journal'; status: 'ok' | 'degraded'; pending: number; lastError: string | null; lastSeq: number | null; flushed: number }
  | { kind: 'ipc'; status: 'connected' | 'disconnected' }
  | { kind: 'invalid-frame' }
  | { kind: 'corrupt-row' };

const PROCESS_END_EVENTS: ReadonlySet<string> = new Set([
  'process.exited', 'process.failed', 'process.crashed', 'process.stopped', 'process.timeout', 'process.cancelled'
]);

export type StateListener = (snapshot: CoreStateSnapshot, changed: readonly string[]) => void;

/** Vista in sola lettura dello stato: è ciò che ricevono i moduli e (via IPC) la UI. */
export interface StateReader {
  snapshot(): CoreStateSnapshot;
  subscribe(listener: StateListener): () => void;
}

export interface StateStore extends StateReader {
  /** Unico punto di modifica: applica un input al riduttore e notifica se lo stato è cambiato. */
  apply(input: StateInput): readonly string[];
  readonly reader: StateReader;
}

/** Ciò che sopravvive a un riavvio, ricostruito dal journal. */
export interface RecoveredState {
  previousRun: CoreStatus | null;
  applicationRunning: boolean;
  lastEvent: EventSummary | null;
  lastError: CoreStateSnapshot['error']['last'];
  journalLastSeq: number;
  journalCount: number;
}

/**
 * Conteggi del dominio letti all'avvio dalle tabelle dei proprietari (Fase 6): agenti, task,
 * obiettivi, approvazioni. Da lì in poi li aggiornano solo gli eventi.
 */
export interface DomainCounts {
  agentsDefined: number;
  agentsLive: number;
  agentsWorking: number;
  tasks: TaskCounts;
  activeGoals: number;
  approvalsPending: number;
}

export function emptyDomainCounts(): DomainCounts {
  return { agentsDefined: 0, agentsLive: 0, agentsWorking: 0, tasks: emptyTaskCounts(), activeGoals: 0, approvalsPending: 0 };
}

export interface StateInit {
  /** Conteggi del dominio all'avvio (default: zero). */
  domain?: DomainCounts;
  bootId: string;
  pid: number;
  startedAt: number;
  appVersion: string;
  coreVersion: string;
  dbSchema: number;
  /** Edizione dell'app (P-104); assente = `sviluppo`. */
  edition?: Edition;
  quarantined: string | null;
  recovered: RecoveredState;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function summarize(event: VisioneEvent): EventSummary {
  return {
    id: event.id,
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    severity: event.severity,
    source: { ...event.source },
    correlationId: event.correlationId
  };
}

function errorOf(event: VisioneEvent): NonNullable<CoreStateSnapshot['error']['last']> {
  const p = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
  const text = (key: string): string | null => (typeof p[key] === 'string' && p[key] !== '' ? p[key] : null);
  return {
    code: text('code') ?? event.type,
    message: (text('message') ?? text('detail') ?? text('error') ?? text('reason') ?? event.type).slice(0, 500),
    at: event.ts,
    correlationId: event.correlationId
  };
}

export function initialState(init: StateInit, now: number): CoreStateSnapshot {
  const r = init.recovered;
  const d = init.domain ?? emptyDomainCounts();
  const activeTasks = Object.entries(d.tasks).reduce((n, [status, c]) => n + (isTerminalTaskStatus(status as keyof TaskCounts) ? 0 : c), 0);
  return deepFreeze({
    schema: STATE_SCHEMA_VERSION,
    bootId: init.bootId,
    revision: 0,
    updatedAt: now,
    version: { app: init.appVersion, core: init.coreVersion, dbSchema: init.dbSchema, edition: init.edition ?? 'sviluppo' },
    application: { status: r.applicationRunning ? 'running' : 'starting', since: now },
    core: {
      // Prima transizione del ciclo di vita (registrata subito dal kernel) in poi: valore reale.
      status: 'starting',
      since: now,
      pid: init.pid,
      startedAt: init.startedAt,
      previousRun: r.previousRun,
      recovered: r.previousRun !== null && r.previousRun !== 'stopped'
    },
    ipc: { status: 'connected', commandsCompleted: 0, commandsFailed: 0, commandsRejected: 0, invalidFrames: 0 },
    database: {
      status: 'ok',
      journalLastSeq: r.journalLastSeq,
      journalCount: r.journalCount,
      pendingWrites: 0,
      lastError: null,
      quarantined: init.quarantined,
      corruptRows: 0
    },
    events: { last: r.lastEvent, sinceStart: 0, rejected: 0 },
    operations: { active: [], count: 0 },
    processes: { active: 0, created: 0, failed: 0, last: null },
    agents: { defined: d.agentsDefined, live: d.agentsLive, working: d.agentsWorking, last: null },
    tasks: { active: activeTasks, byStatus: { ...d.tasks }, last: null },
    director: { activeGoals: d.activeGoals, lastDecision: null },
    approvals: { pending: d.approvalsPending },
    voice: { status: 'off', since: now, reason: null, pid: null, engines: null, listening: false, speaking: null, lastUtterance: null, wake: { enabled: false, phrase: '', available: false, armed: false }, voices: [], filters: { denoise: false, speaker: false, owner: false, ownerOnly: false, noiseGate: 0 }, talkTo: null },
    error: { last: r.lastError, count: 0 }
  } satisfies CoreStateSnapshot);
}

type Draft = { -readonly [K in keyof CoreStateSnapshot]: CoreStateSnapshot[K] };

/**
 * Riduttore puro: (stato, input) → nuovo stato e chiavi di primo livello cambiate.
 * Una transizione del ciclo di vita non ammessa viene ignorata e contata come errore.
 */
export function reduceState(state: CoreStateSnapshot, input: StateInput, now: number): { state: CoreStateSnapshot; changed: string[] } {
  const next: Draft = { ...state };
  const changed = new Set<string>();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    next[key] = value;
    changed.add(key);
  };

  switch (input.kind) {
    case 'event': {
      const e = input.event;
      if (e.type === 'state.changed') break; // lo stato non osserva le proprie notifiche
      set('events', { ...next.events, last: summarize(e), sinceStart: next.events.sinceStart + 1 });
      if (e.seq !== null) {
        set('database', {
          ...next.database,
          journalLastSeq: Math.max(next.database.journalLastSeq, e.seq),
          journalCount: next.database.journalCount + 1
        });
      }
      if (severityAtLeast(e.severity, 'error')) set('error', { last: errorOf(e), count: next.error.count + 1 });

      if (isEvent(e, 'system.lifecycle.changed')) {
        if (canTransition(e.payload.from, e.payload.to)) {
          set('core', { ...next.core, status: e.payload.to, since: e.ts });
        } else {
          set('error', {
            last: { code: 'invalid_transition', message: `${String(e.payload.from)} → ${e.payload.to}`, at: e.ts, correlationId: e.correlationId },
            count: next.error.count + 1
          });
        }
      } else if (isEvent(e, 'app.started')) {
        set('application', { status: 'running', since: e.ts });
      } else if (isEvent(e, 'app.shutdown')) {
        set('application', { status: 'stopping', since: e.ts });
      } else if (isEvent(e, 'command.accepted')) {
        const op = { commandId: e.payload.commandId, type: e.payload.type, correlationId: e.correlationId, issuedBy: e.payload.issuedBy, startedAt: e.ts };
        const active = next.operations.active.length < MAX_ACTIVE_OPERATIONS ? [...next.operations.active, op] : next.operations.active;
        set('operations', { active, count: next.operations.count + 1 });
      } else if (isEvent(e, 'command.completed')) {
        // `count` include le operazioni oltre il limite della lista: ogni accettato ha un completato.
        const active = next.operations.active.filter((op) => op.commandId !== e.payload.commandId);
        set('operations', { active, count: Math.max(0, next.operations.count - 1) });
        set('ipc', {
          ...next.ipc,
          commandsCompleted: next.ipc.commandsCompleted + 1,
          commandsFailed: next.ipc.commandsFailed + (e.payload.ok ? 0 : 1)
        });
        if (e.payload.errorCode === 'internal') {
          set('error', {
            last: { code: 'command_internal', message: `${e.payload.type} fallito`, at: e.ts, correlationId: e.correlationId },
            count: next.error.count + 1
          });
        }
      } else if (isEvent(e, 'command.rejected')) {
        set('ipc', { ...next.ipc, commandsRejected: next.ipc.commandsRejected + 1 });
      } else if (isEvent(e, 'system.event.rejected')) {
        set('events', { ...next.events, rejected: next.events.rejected + 1 });
      } else if (isEvent(e, 'process.created')) {
        set('processes', { ...next.processes, active: next.processes.active + 1, created: next.processes.created + 1 });
      } else if (PROCESS_END_EVENTS.has(e.type)) {
        const p = e.payload as { processId: string; status: ProcessStatus };
        set('processes', {
          ...next.processes,
          // Un processo di un avvio precedente (riconciliato) non era contato tra gli attivi.
          active: Math.max(0, next.processes.active - 1),
          failed: next.processes.failed + (p.status === 'failed' || p.status === 'crashed' || p.status === 'timed_out' ? 1 : 0),
          last: { processId: p.processId, status: p.status, at: e.ts }
        });
      } else if (isEvent(e, 'agent.definition.created')) {
        set('agents', { ...next.agents, defined: next.agents.defined + 1 });
      } else if (isEvent(e, 'agent.definition.archived')) {
        set('agents', { ...next.agents, defined: Math.max(0, next.agents.defined - 1) });
      } else if (isEvent(e, 'agent.status.changed')) {
        const { from, to } = e.payload;
        const wasLive = from !== null && !TERMINAL_AGENT_STATUSES.has(from);
        const isLive = !TERMINAL_AGENT_STATUSES.has(to);
        set('agents', {
          ...next.agents,
          live: Math.max(0, next.agents.live + (isLive ? 1 : 0) - (wasLive ? 1 : 0)),
          working: Math.max(0, next.agents.working + (to === 'working' ? 1 : 0) - (from === 'working' ? 1 : 0)),
          last: { agentId: e.payload.agentId, status: to, at: e.ts }
        });
      } else if (isEvent(e, 'task.created')) {
        set('tasks', {
          active: next.tasks.active + 1,
          byStatus: { ...next.tasks.byStatus, created: next.tasks.byStatus.created + 1 },
          last: { taskId: e.payload.taskId, status: 'created', at: e.ts }
        });
      } else if (isEvent(e, 'task.status.changed')) {
        const { from, to } = e.payload;
        const byStatus = { ...next.tasks.byStatus, [to]: next.tasks.byStatus[to] + 1 };
        if (from !== null) byStatus[from] = Math.max(0, byStatus[from] - 1);
        const delta = (isTerminalTaskStatus(to) ? 0 : 1) - (from === null || isTerminalTaskStatus(from) ? 0 : 1);
        set('tasks', { active: Math.max(0, next.tasks.active + delta), byStatus, last: { taskId: e.payload.taskId, status: to, at: e.ts } });
      } else if (isEvent(e, 'director.goal.received')) {
        set('director', { ...next.director, activeGoals: next.director.activeGoals + 1 });
      } else if (isEvent(e, 'director.summary')) {
        set('director', { ...next.director, activeGoals: Math.max(0, next.director.activeGoals - 1) });
      } else if (isEvent(e, 'director.decision')) {
        set('director', { ...next.director, lastDecision: { decision: e.payload.decision, taskId: e.payload.taskId, agentId: e.payload.agentId, at: e.ts } });
      } else if (isEvent(e, 'approval.requested')) {
        set('approvals', { pending: next.approvals.pending + 1 });
      } else if (isEvent(e, 'approval.granted') || isEvent(e, 'approval.denied')) {
        set('approvals', { pending: Math.max(0, next.approvals.pending - 1) });
      } else if (isEvent(e, 'voice.process.changed')) {
        const p = e.payload;
        const up = p.to === 'ready';
        set('voice', {
          ...next.voice, status: p.to, since: e.ts, reason: up ? null : p.reason, pid: p.pid, engines: up ? p.engines : next.voice.engines,
          // Un processo voce che non è pronto non ascolta né parla.
          listening: up ? next.voice.listening : false, speaking: up ? next.voice.speaking : null,
          wake: { ...next.voice.wake, armed: up ? next.voice.wake.armed : false }
        });
      } else if (isEvent(e, 'voice.wake.changed')) {
        const p = e.payload;
        set('voice', { ...next.voice, wake: { enabled: p.enabled, phrase: p.phrase, available: p.available, armed: p.enabled ? next.voice.wake.armed : false } });
      } else if (isEvent(e, 'voice.talk.changed')) {
        set('voice', { ...next.voice, talkTo: e.payload.talkTo });
      } else if (isEvent(e, 'voice.ptt.pressed')) {
        set('voice', {
          ...next.voice, listening: true,
          wake: e.payload.source === 'wake' ? { ...next.voice.wake, armed: true } : next.voice.wake
        });
      } else if (isEvent(e, 'voice.ptt.released')) {
        set('voice', {
          ...next.voice, listening: false,
          wake: e.payload.source === 'wake' ? { ...next.voice.wake, armed: false } : next.voice.wake
        });
      } else if (isEvent(e, 'voice.stt.final')) {
        set('voice', { ...next.voice, lastUtterance: { text: e.payload.text, at: e.ts } });
      } else if (isEvent(e, 'voice.tts.started')) {
        set('voice', { ...next.voice, speaking: e.payload.ttsId });
      } else if ((isEvent(e, 'voice.tts.finished') || isEvent(e, 'voice.tts.interrupted')) && next.voice.speaking === e.payload.ttsId) {
        set('voice', { ...next.voice, speaking: null });
      }
      break;
    }
    case 'journal':
      set('database', {
        ...next.database,
        status: input.status,
        pendingWrites: input.pending,
        lastError: input.lastError,
        journalLastSeq: input.lastSeq === null ? next.database.journalLastSeq : Math.max(next.database.journalLastSeq, input.lastSeq),
        journalCount: next.database.journalCount + input.flushed
      });
      break;
    case 'ipc':
      if (next.ipc.status !== input.status) set('ipc', { ...next.ipc, status: input.status });
      break;
    case 'invalid-frame':
      set('ipc', { ...next.ipc, invalidFrames: next.ipc.invalidFrames + 1 });
      break;
    case 'corrupt-row':
      set('database', { ...next.database, corruptRows: next.database.corruptRows + 1 });
      break;
  }

  if (changed.size === 0) return { state, changed: [] };
  next.revision = state.revision + 1;
  next.updatedAt = now;
  return { state: deepFreeze(next), changed: [...changed] };
}

export function createStateStore(init: StateInit, opts: { now?: () => number; onListenerError?: (err: unknown) => void } = {}): StateStore {
  const now = opts.now ?? Date.now;
  let state = initialState(init, now());
  const listeners = new Set<StateListener>();

  const reader: StateReader = {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };

  return {
    ...reader,
    reader,
    apply(input) {
      const out = reduceState(state, input, now());
      if (out.changed.length === 0) return out.changed;
      state = out.state;
      for (const listener of [...listeners]) {
        try {
          listener(state, out.changed);
        } catch (err) {
          opts.onListenerError?.(err);
        }
      }
      return out.changed;
    }
  };
}

const LIFECYCLE_COMPAT = ['system.started', 'system.ready', 'system.stopped'] as const;

/**
 * Ricostruzione minima dallo storico: legge pochi eventi mirati (indici della migrazione 2),
 * non riproduce l'intero journal. `parentPid` = pid del main che ha avviato questo core: un
 * `app.started` con lo stesso pid e nessun `app.shutdown` successivo significa app in esecuzione.
 */
export function recoverState(journal: Journal, parentPid: number | null): RecoveredState {
  let previousRun: CoreStatus | null = null;
  const lifecycle = journal.latest(['system.lifecycle.changed']);
  if (lifecycle) {
    const to = coreStatusSchema.safeParse((lifecycle.payload as { to?: unknown } | null)?.to);
    previousRun = to.success ? to.data : 'crashed';
  } else {
    // Journal scritto prima della Fase 4: si deduce dagli eventi di sistema.
    const legacy = journal.latest(LIFECYCLE_COMPAT);
    if (legacy) previousRun = legacy.type === 'system.stopped' ? 'stopped' : 'ready';
  }

  const app = journal.latest(['app.started', 'app.shutdown']);
  const appPid = (app?.payload as { pid?: unknown } | null)?.pid;
  const applicationRunning = app?.type === 'app.started' && parentPid !== null && appPid === parentPid;

  const last = journal.read({ limit: 1 })[0];
  const error = journal.lastError();
  return {
    previousRun,
    applicationRunning,
    lastEvent: last ? summarize(last) : null,
    lastError: error ? errorOf(error) : null,
    journalLastSeq: journal.lastSeq(),
    journalCount: journal.count()
  };
}

export type TransitionResult = { ok: true; from: CoreStatus | null; to: CoreStatus } | { ok: false; from: CoreStatus | null; to: CoreStatus; problem: string };

export interface Lifecycle {
  readonly current: CoreStatus | null;
  /** Unico punto da cui passa una transizione: validata, registrata come evento, poi applicata. */
  transition(to: CoreStatus, reason: string, opts?: { inferred?: boolean }): TransitionResult;
}

/**
 * Ciclo di vita del core. `emitChange` registra `system.lifecycle.changed` (lo stato lo osserva);
 * se la registrazione lancia, la transizione non avviene.
 */
export function createLifecycle(deps: {
  previous: CoreStatus | null;
  emitChange: (from: CoreStatus | null, to: CoreStatus, reason: string, inferred: boolean) => void;
  onRejected?: (result: TransitionResult) => void;
}): Lifecycle {
  let current = deps.previous;
  return {
    get current() {
      return current;
    },
    transition(to, reason, opts = {}) {
      const from = current;
      if (!canTransition(from, to)) {
        const result: TransitionResult = { ok: false, from, to, problem: `transizione non ammessa: ${String(from)} → ${to}` };
        deps.onRejected?.(result);
        return result;
      }
      deps.emitChange(from, to, reason, opts.inferred ?? false);
      current = to;
      return { ok: true, from, to };
    }
  };
}
