// Centro notifiche (Fase 23, P-70): proiezione PURA degli eventi reali in notizie consultabili.
// Nessun evento o testo inventato: una notizia esiste solo se l'evento che la origina è accaduto.
// Click su una notizia → la finestra dell'entità reale (task/agente/approvazioni/log).
import type { Language, VisioneEvent } from '../../shared/contracts/index.ts';
import { translate, type MessageKey, type Vars } from '../lib/i18n/index.ts';

export type NoticeWindow = 'task' | 'agent' | 'approvals' | 'logs' | 'terminal';

export interface Notice {
  readonly id: string;
  readonly ts: number;
  readonly severity: 'info' | 'warning' | 'error';
  readonly title: string;
  readonly detail: string;
  readonly target: { windowKind: NoticeWindow; ref: string | null } | null;
}

/** Esiti di task che meritano una notizia (i cancellati volontari no). */
const TASK_FAILED: ReadonlySet<string> = new Set(['failed', 'timed_out', 'blocked']);

function str(p: Record<string, unknown>, key: string): string {
  return typeof p[key] === 'string' ? (p[key] as string) : '';
}

/** La notizia nella lingua indicata (di partenza l'italiano). */
export function notificationOf(e: VisioneEvent, lang: Language = 'it'): Notice | null {
  const p = e.payload as Record<string, unknown>;
  const t = (key: MessageKey, vars?: Vars): string => translate(lang, key, vars);
  switch (e.type) {
    case 'task.result.recorded': {
      const outcome = str(p, 'outcome');
      const label = outcome === 'success' ? t('shell.notice.taskDone') : outcome === 'partial' ? t('shell.notice.taskPartial') : t('shell.notice.taskFailed');
      return {
        id: e.id, ts: e.ts, severity: outcome === 'success' ? 'info' : 'warning', title: label,
        detail: `${str(p, 'taskId')} · ${str(p, 'summary').slice(0, 220)}`,
        target: { windowKind: 'task', ref: str(p, 'taskId') }
      };
    }
    case 'task.status.changed': {
      const to = str(p, 'to');
      if (!TASK_FAILED.has(to)) return null;
      return {
        id: e.id, ts: e.ts, severity: 'error', title: t('shell.notice.taskStatus', { to }),
        detail: `${str(p, 'taskId')} · ${str(p, 'reason')}`,
        target: { windowKind: 'task', ref: str(p, 'taskId') }
      };
    }
    case 'approval.requested':
      return {
        id: e.id, ts: e.ts, severity: 'warning', title: t('shell.notice.approvalAsked'),
        detail: `${str(p, 'kind')} · ${str(p, 'reason')}`,
        target: { windowKind: 'approvals', ref: null }
      };
    case 'approval.denied':
      return {
        id: e.id, ts: e.ts, severity: 'warning', title: t('shell.notice.approvalDenied'),
        detail: `${str(p, 'kind')} · ${str(p, 'target').slice(0, 200)}`,
        target: { windowKind: 'approvals', ref: null }
      };
    case 'agent.status.changed': {
      const to = str(p, 'to');
      if (to !== 'error' && to !== 'crashed' && to !== 'recovering') return null;
      return {
        id: e.id, ts: e.ts, severity: to === 'recovering' ? 'warning' : 'error', title: t('shell.notice.agentStatus', { to }),
        detail: `${str(p, 'agentId')} · ${str(p, 'reason')}`,
        target: { windowKind: 'agent', ref: str(p, 'agentId') }
      };
    }
    case 'agent.limit.reached':
      // Limite di quota del motore (P-83): notizia reale; il task passa all'agente di ripiego.
      return {
        id: e.id, ts: e.ts, severity: 'warning', title: t('shell.notice.limit', { scope: str(p, 'scope') }),
        detail: `${str(p, 'agentId')}${str(p, 'resetAt') ? ` · reset ${str(p, 'resetAt')}` : ''} · ${str(p, 'message').slice(0, 180)}`,
        target: { windowKind: 'agent', ref: str(p, 'agentId') }
      };
    case 'agent.breaker.changed':
      return {
        id: e.id, ts: e.ts, severity: 'warning', title: t('shell.notice.breaker', { to: str(p, 'to') }),
        detail: `${str(p, 'agentId')} · ${str(p, 'reason')}`,
        target: { windowKind: 'agent', ref: str(p, 'agentId') }
      };
    case 'process.failed':
    case 'process.crashed': {
      const owner = p.owner as { agentId?: string | null } | undefined;
      const error = p.error as { message?: string } | null | undefined;
      return {
        id: e.id, ts: e.ts, severity: 'error',
        title: e.type === 'process.crashed' ? t('shell.notice.processCrashed') : t('shell.notice.processFailed'),
        detail: `${str(p, 'processId')}${error?.message ? ` · ${error.message.slice(0, 180)}` : ''}`,
        target: owner?.agentId ? { windowKind: 'agent', ref: owner.agentId } : { windowKind: 'logs', ref: null }
      };
    }
    case 'system.error':
      return {
        id: e.id, ts: e.ts, severity: 'error', title: t('shell.notice.systemError', { code: str(p, 'code') }),
        detail: str(p, 'message').slice(0, 220),
        target: { windowKind: 'logs', ref: null }
      };
    case 'core.crashed':
      return { id: e.id, ts: e.ts, severity: 'error', title: t('shell.notice.coreCrashed'), detail: str(p, 'reason'), target: { windowKind: 'logs', ref: null } };
    case 'voice.error':
      return { id: e.id, ts: e.ts, severity: 'warning', title: t('shell.notice.voiceError', { code: str(p, 'code') }), detail: str(p, 'message').slice(0, 220), target: null };
    case 'voice.wake.detected': {
      const command = str(p, 'command');
      return {
        id: e.id, ts: e.ts, severity: 'info', title: t('shell.notice.wake', { phrase: str(p, 'phrase') }),
        detail: command.length > 0 ? t('shell.notice.wakeCommand', { command: command.slice(0, 200) }) : t('shell.notice.wakeWaiting'),
        target: null
      };
    }
    default:
      return null;
  }
}

/** Le notizie dagli eventi, più recenti prime, con tetto. */
export function collectNotices(events: readonly VisioneEvent[], limit = 50, lang: Language = 'it'): Notice[] {
  const out: Notice[] = [];
  for (const e of events) {
    const n = notificationOf(e, lang);
    if (n) out.push(n);
  }
  return out.slice(-limit).reverse();
}

export function countUnread(notices: readonly Notice[], seenTs: number): number {
  return notices.reduce((n, notice) => (notice.ts > seenTs ? n + 1 : n), 0);
}
