// Centro errori (P-95): elenco REALE degli errori (eventi del journal con gravità error/critical e
// istanze di agente in errore) e piano di riparazione per ciascuno. Puro e testabile: la UI esegue
// solo i comandi reali (`agents.start`, `director.submit`, `engines.probe`, `system.ping`), ognuno
// tracciato da audit/eventi; ciò che non è riparabile lo dichiara «ERRORE FISSO» col motivo.
import type { AgentView, Language, Task, VisioneEvent } from '../../shared/contracts/index.ts';
import { translate } from '../lib/i18n/index.ts';

export interface ErrorEntry {
  id: string;
  /** Da dove arriva la riga: un evento del journal o lo stato di un'istanza di agente. */
  origin: 'event' | 'agent';
  /** Codice leggibile (codice dell'errore reale o tipo evento). */
  code: string;
  message: string;
  at: number;
  /** Entità coinvolta, come mostrata: «agente coder», «processo …», «core». */
  entity: string;
  eventType: string;
  severity: 'error' | 'critical';
  correlationId: string | null;
  agentId: string | null;
  processId: string | null;
  retryable: boolean | null;
}

export type RepairPlan =
  | { kind: 'restart-agent'; agentId: string }
  | { kind: 'retry-task'; agentId: string | null }
  | { kind: 'probe-engines' }
  | { kind: 'verify-core' }
  | { kind: 'fixed'; reason: string };

const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const asString = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const asBool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** Codici ANSI/SGR dei TUI (P-95): nel pannello si mostra testo leggibile, mai sequenze di controllo. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

/** Testo leggibile di un messaggio reale: ANSI e caratteri di controllo rimossi, spazi normalizzati. */
export function senzaAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/gu, ' ').trim();
}

/**
 * Una riga del centro errori da un evento reale, solo per gravità error/critical. Resta con UN solo
 * parametro (si passa anche a `.map`): per le righe nella lingua dell'interfaccia vedi `errorEntryIn`.
 */
export function errorEntryOf(event: VisioneEvent): ErrorEntry | null {
  return errorEntryIn(event, 'it');
}

/** Come `errorEntryOf`, con i testi composti qui (entità) nella lingua indicata. */
export function errorEntryIn(event: VisioneEvent, lang: Language): ErrorEntry | null {
  if (event.severity !== 'error' && event.severity !== 'critical') return null;
  const p = asRecord(event.payload);
  const err = asRecord(p.error);
  const owner = asRecord(p.owner);
  const agentId = asString(p.agentId) ?? asString(owner.agentId);
  const processId = asString(p.processId);
  const taskId = asString(p.taskId) ?? asString(owner.taskId);
  const code = asString(err.code) ?? asString(p.code) ?? asString(p.errorCode) ?? event.type;
  const message = asString(err.message) ?? asString(p.message) ?? asString(p.detail) ?? asString(p.reason)
    ?? asString(p.error) ?? event.type;
  const clean = senzaAnsi(message);
  const entity = event.target !== null
    ? `${event.target.kind} ${event.target.id}`
    : processId !== null
      ? translate(lang, 'shell.err.processEntity', { id: processId })
      : agentId !== null
        ? translate(lang, 'shell.err.agentEntity', { id: agentId })
        : taskId !== null
          ? translate(lang, 'shell.err.taskEntity', { id: taskId })
          : `${event.source.kind} ${event.source.id}`;
  return {
    id: event.id,
    origin: 'event',
    code,
    message: clean.slice(0, 500),
    at: event.ts,
    entity,
    eventType: event.type,
    severity: event.severity,
    correlationId: event.correlationId,
    agentId,
    processId,
    retryable: asBool(err.retryable) ?? asBool(p.retryable)
  };
}

/** Una riga del centro errori dallo stato reale di un'istanza di agente (error o interrotta). Un solo parametro, come `errorEntryOf`. */
export function instanceErrorEntry(view: AgentView): ErrorEntry | null {
  return instanceErrorEntryIn(view, 'it');
}

/** Come `instanceErrorEntry`, con i testi composti qui nella lingua indicata. */
export function instanceErrorEntryIn(view: AgentView, lang: Language): ErrorEntry | null {
  const inst = view.instance;
  if (inst === null) return null;
  if (inst.status !== 'error' && inst.status !== 'crashed') return null;
  const stale = typeof inst.statusReason === 'string' && /core riavviato/i.test(inst.statusReason);
  return {
    id: `istanza:${view.definition.id}:${inst.id}`,
    origin: 'agent',
    code: inst.status === 'error' ? 'agent_error' : stale ? translate(lang, 'shell.err.codeSessionClosed') : 'agent_crashed',
    message: inst.statusReason ?? (inst.status === 'error' ? translate(lang, 'shell.err.instanceError') : translate(lang, 'shell.err.crashedAbnormally')),
    at: inst.endedAt ?? inst.lastEventAt ?? inst.createdAt,
    entity: translate(lang, 'shell.err.agentEntity', { id: view.definition.id }),
    eventType: 'agent.instance',
    severity: 'error',
    correlationId: null,
    agentId: view.definition.id,
    processId: null,
    retryable: null
  };
}

/**
 * Unisce eventi e istanze senza duplicare lo stesso guasto: un'istanza in errore coperta da un
 * evento dello stesso agente entro 15 minuti non viene ripetuta. Ordina dal più recente.
 */
export function mergeErrorEntries(events: readonly ErrorEntry[], instances: readonly ErrorEntry[]): ErrorEntry[] {
  const merged = [...events];
  for (const inst of instances) {
    const covered = events.some((e) => e.agentId !== null && e.agentId === inst.agentId && Math.abs(e.at - inst.at) < 15 * 60_000);
    if (!covered) merged.push(inst);
  }
  return merged.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, 60);
}

/** Il task fallito più recente di quell'agente (per rilanciarlo via Director), o null. */
export function pickRetryTask(tasks: readonly Task[], agentId: string | null): Task | null {
  if (agentId === null) return null;
  const candidates = tasks
    .filter((t) => (t.status === 'failed' || t.status === 'timed_out') && t.assigneeAgentId === agentId)
    .sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt));
  return candidates[0] ?? null;
}

/**
 * Cosa si può fare davvero per un errore. «fixed» = non riparabile: si dichiara ERRORE FISSO col
 * motivo reale (quota del motore, errore interno, nessuna azione automatica).
 */
export function repairFor(entry: ErrorEntry, lang: Language = 'it'): RepairPlan {
  const text = `${entry.code} ${entry.message}`;
  if (/limit_reached|quota|rate.?limit/i.test(text)) {
    return { kind: 'fixed', reason: translate(lang, 'shell.err.fixQuota') };
  }
  switch (entry.eventType) {
    case 'agent.instance':
      return { kind: 'restart-agent', agentId: entry.agentId as string };
    case 'agent.turn.finished':
      return entry.agentId !== null ? { kind: 'retry-task', agentId: entry.agentId } : { kind: 'fixed', reason: translate(lang, 'shell.err.fixTurnNoAgent') };
    case 'process.failed':
    case 'process.crashed':
    case 'process.timeout':
    case 'process.lost':
      return entry.agentId !== null ? { kind: 'restart-agent', agentId: entry.agentId } : { kind: 'probe-engines' };
    case 'system.lifecycle.changed':
    case 'core.crashed':
    case 'system.error':
      return { kind: 'verify-core' };
    case 'command.completed':
      return { kind: 'fixed', reason: translate(lang, 'shell.err.fixCommand') };
  }
  return { kind: 'fixed', reason: translate(lang, 'shell.err.fixNone', { type: entry.eventType }) };
}
