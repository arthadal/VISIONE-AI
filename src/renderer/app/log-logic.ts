// Log leggibile (11/10/2026, richiesta del proprietario): nel log ci sono le operazioni importanti —
// cosa fanno e cosa toccano il Director e gli agenti, i problemi, le scritture — non la routine che
// arriva ogni secondo (telemetria, ping, livelli della voce, uscita grezza dei processi). La routine
// resta consultabile con un interruttore. Puro e testato: solo tipi dai contratti.
import type { Language, VisioneEvent } from '../../shared/contracts/index.ts';
import { translate, type MessageKey, type Vars } from '../lib/i18n/index.ts';

/** Eventi informativi ma ripetitivi: fuori dal log salvo richiesta. */
const ROUTINE_TYPES: ReadonlySet<string> = new Set([
  'telemetry.aggregate', 'voice.models.progress', 'voice.enroll.progress', 'agent.usage.updated',
  'memory.context.built', 'memory.index.updated', 'voice.ptt.pressed', 'voice.ptt.released',
  'voice.tts.started', 'voice.tts.finished', 'voice.tts.requested', 'voice.tts.interrupted'
]);

/**
 * Routine: tutto ciò che il contratto marca `debug` (telemetria al secondo, ping, comandi accettati,
 * stato, uscita dei processi, livelli voce), più le voci ripetitive qui sopra e i pezzi di testo non
 * finali di una risposta. Avvisi ed errori non sono MAI routine.
 */
export function isRoutine(e: VisioneEvent): boolean {
  if (e.severity === 'warning' || e.severity === 'error' || e.severity === 'critical') return false;
  if (e.severity === 'debug') return true;
  if (ROUTINE_TYPES.has(e.type)) return true;
  if (e.type === 'agent.message.text') return (e.payload as { final?: unknown }).final !== true;
  return false;
}

const TASK_STATUS: Record<string, MessageKey> = {
  created: 'windows.log.task.created', queued: 'windows.log.task.queued', running: 'windows.log.task.running', waiting: 'windows.log.task.waiting',
  succeeded: 'windows.log.task.succeeded', failed: 'windows.log.task.failed', cancelled: 'windows.log.task.cancelled',
  timed_out: 'windows.log.task.timed_out', blocked: 'windows.log.task.blocked'
};
const AGENT_STATUS: Record<string, MessageKey> = {
  created: 'windows.log.agentst.created', starting: 'windows.log.agentst.starting', idle: 'windows.log.agentst.idle', working: 'windows.log.agentst.working',
  waiting: 'windows.log.agentst.waiting', error: 'windows.log.agentst.error', stopping: 'windows.log.agentst.stopping', stopped: 'windows.log.agentst.stopped',
  crashed: 'windows.log.agentst.crashed', recovering: 'windows.log.agentst.recovering'
};
const DECISION: Record<string, MessageKey> = {
  assign: 'windows.log.decision.assign', retry: 'windows.log.decision.retry', reassign: 'windows.log.decision.reassign', fail: 'windows.log.decision.fail',
  'wait-approval': 'windows.log.decision.wait-approval', block: 'windows.log.decision.block', 'plan-fallback': 'windows.log.decision.plan-fallback',
  breaker: 'windows.log.decision.breaker', 'proposal-accepted': 'windows.log.decision.proposal-accepted', 'proposal-rejected': 'windows.log.decision.proposal-rejected'
};
const OUTCOME: Record<string, MessageKey> = {
  success: 'windows.log.outcome.success', partial: 'windows.log.outcome.partial', failure: 'windows.log.outcome.failure', succeeded: 'windows.log.outcome.succeeded',
  failed: 'windows.log.outcome.failed', cancelled: 'windows.log.outcome.cancelled', completed: 'windows.log.outcome.completed'
};

const cut = (s: unknown, n: number): string => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const shortId = (id: unknown): string => (typeof id === 'string' ? id.slice(-6) : '?');

/**
 * Frase per una riga del log (di default in italiano): chi, cosa fa, cosa tocca. `names` traduce gli id
 * degli agenti nei nomi scelti dal proprietario (assente = l'id). `lang` sceglie la lingua dei testi
 * composti qui; ciò che arriva dagli eventi (titoli, messaggi, percorsi) resta com'è. Un tipo senza frase
 * dedicata dà il tipo.
 */
export function describeEvent(e: VisioneEvent, names: Readonly<Record<string, string>> = {}, lang: Language = 'it'): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const t = (key: MessageKey, vars?: Vars): string => translate(lang, key, vars);
  const word = (map: Record<string, MessageKey>, v: unknown): string => (typeof v === 'string' ? (Object.prototype.hasOwnProperty.call(map, v) ? t(map[v] as MessageKey) : v) : '?');
  const who = (id: unknown): string => (typeof id === 'string' ? names[id] ?? id : t('windows.common.none'));
  switch (e.type) {
    case 'director.goal.received': return t('windows.log.goalReceived', { who: who(p.by) });
    case 'director.plan.created': {
      const n = Array.isArray(p.taskIds) ? p.taskIds.length : 0;
      return `${t('windows.log.planCreated', { n })}${p.fallback ? ` — ${t('windows.log.planFallback', { text: cut(p.fallback, 80) })}` : ''}`;
    }
    case 'director.decision':
      return `Director ${word(DECISION, p.decision)}${p.agentId ? ` → ${who(p.agentId)}` : ''}${p.reason ? `: ${cut(p.reason, 100)}` : ''}`;
    case 'director.summary': {
      const c = (p.counts ?? {}) as { total?: number; succeeded?: number };
      return t('windows.log.summary', { outcome: word(OUTCOME, p.outcome), done: c.succeeded ?? 0, total: c.total ?? 0 });
    }
    case 'task.created': return t('windows.log.taskCreated', { title: cut(p.title, 90), assignee: p.assigneeAgentId ? who(p.assigneeAgentId) : t('windows.log.toAssign') });
    case 'task.assigned': return t('windows.log.taskAssigned', { id: shortId(p.taskId), who: who(p.agentId) });
    case 'task.status.changed':
      return `Task ${shortId(p.taskId)}: ${p.from ? `${word(TASK_STATUS, p.from)} → ` : ''}${word(TASK_STATUS, p.to)}${p.reason ? ` (${cut(p.reason, 80)})` : ''}`;
    case 'task.result.recorded': return t('windows.log.taskResult', { who: who(p.producedBy), outcome: word(OUTCOME, p.outcome), summary: cut(p.summary, 120) });
    case 'agent.turn.started': return `${t('windows.log.turnStarted', { who: who(p.agentId) })}${p.taskId ? ` ${t('windows.log.onTask', { id: shortId(p.taskId) })}` : ''}`;
    case 'agent.turn.finished': return t('windows.log.turnFinished', { who: who(p.agentId), outcome: word(OUTCOME, p.outcome) });
    case 'agent.message.text': return t('windows.log.messageText', { who: who(p.agentId), text: cut(p.text, 140) });
    case 'agent.message.sent': return `${who(p.from)} → ${who(p.to)}: ${cut(p.subject, 100)}`;
    case 'agent.message.rejected': return t('windows.log.messageRejected', { who: who(p.agentId), problem: cut(p.problem, 100) });
    case 'agent.status.changed': return `${who(p.agentId)}: ${p.from ? `${word(AGENT_STATUS, p.from)} → ` : ''}${word(AGENT_STATUS, p.to)}`;
    case 'agent.limit.reached': return t('windows.log.limitReached', { who: who(p.agentId), message: cut(p.message, 100) });
    case 'agent.permission.requested': return t('windows.log.permissionRequested', { who: who(p.agentId) });
    case 'agent.breaker.changed': return t('windows.log.breakerChanged', { who: who(p.agentId) });
    case 'tool.call.started': return t('windows.log.toolStarted', { who: who(p.agentId), tool: cut(p.tool, 60) });
    case 'tool.call.finished': {
      const ms = typeof p.durationMs === 'number' ? ` in ${(p.durationMs / 1000).toFixed(1)} s` : '';
      return `${who(p.agentId)}: ${cut(p.tool, 60)} ${p.ok === true ? t('windows.log.toolSucceeded') : t('windows.log.toolFailed')}${ms}`;
    }
    case 'tool.call.denied': return `${who(p.agentId)}: ${cut(p.tool, 60)} ${p.classification === 'block' ? t('windows.log.toolBlocked') : t('windows.log.toolPending')} — ${cut(p.reason, 90)}`;
    case 'file.created': return t(p.kind === 'directory' ? 'windows.log.fileCreatedDir' : 'windows.log.fileCreatedFile', { path: cut(p.path, 140) });
    case 'file.renamed': return t('windows.log.fileRenamed', { from: cut(p.from, 70), to: cut(p.to, 70) });
    case 'file.deleted': return t(p.kind === 'directory' ? 'windows.log.fileDeletedDir' : 'windows.log.fileDeletedFile', { path: cut(p.path, 140) });
    case 'file.opened': return t('windows.log.fileOpened', { path: cut(p.path, 140) });
    case 'memory.item.written': return t('windows.log.memoryWritten', { title: cut(p.title, 90) });
    case 'memory.item.promoted': return t('windows.log.memoryPromoted');
    case 'memory.reflection.completed': return t('windows.log.memoryReflection');
    case 'memory.error': return t('windows.log.memoryError', { stage: cut(p.stage, 20), message: cut(p.message, 110) });
    case 'approval.requested': return t('windows.log.approvalRequested', { who: who(p.requestedBy), kind: cut(p.kind, 40), target: cut(p.target, 80) });
    case 'approval.granted': return t('windows.log.approvalGranted', { kind: cut(p.kind, 40), target: cut(p.target, 80) });
    case 'approval.denied': return t('windows.log.approvalDenied', { kind: cut(p.kind, 40), target: cut(p.target, 80) });
    case 'process.failed': case 'process.crashed': case 'process.timeout': {
      const owner = (p.owner ?? {}) as { agentId?: string | null };
      const what = t(e.type === 'process.timeout' ? 'windows.log.processTimedOut' : e.type === 'process.crashed' ? 'windows.log.processCrashed' : 'windows.log.processFailed');
      return `${t('windows.log.process', { id: shortId(p.processId) })}${owner.agentId ? ` ${t('windows.log.processOf', { who: who(owner.agentId) })}` : ''} ${what}${p.tail ? `: ${cut(p.tail, 100)}` : ''}`;
    }
    case 'system.config.changed': {
      const list = Array.isArray(p.changed) ? p.changed.slice(0, 4).join(', ') : '';
      return `${t('windows.log.configChanged', { list })}${p.restartRequired === true ? ` (${t('windows.log.restartRequired')})` : ''}`;
    }
    case 'system.error': return t('windows.log.systemError', { message: cut(p.message, 120) });
    case 'core.crashed': return t('windows.log.coreCrashed', { detail: cut(p.detail, 120) });
    case 'error.invariant': return t('windows.log.invariant', { message: cut(p.message ?? p.detail, 120) });
    case 'system.journal.degraded': return t('windows.log.journalDegraded');
    case 'system.db.quarantined': return t('windows.log.dbQuarantined');
    case 'voice.stt.final': return t('windows.log.sttFinal', { text: cut(p.text, 120) });
    case 'voice.command': return `${t('windows.log.voiceCommand', { action: cut(p.action, 40) })}${p.target ? ` → ${cut(p.target, 40)}` : ''}`;
    case 'voice.error': return t('windows.log.voiceError', { message: cut(p.message, 120) });
    case 'app.started': return t('windows.log.appStarted');
    case 'app.shutdown': return p.reason === 'relaunch' ? t('windows.log.appRelaunch') : t('windows.log.appShutdown');
    case 'core.ready': return t('windows.log.coreReady');
    default: return e.type;
  }
}
