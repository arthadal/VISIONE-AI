// Stato mostrato nella testata di ogni finestra (Fase G5, P-77). Vocabolario `.term-testa` del JARVIS
// del proprietario (MIT © 2026 Aditya Dewaskar, `src/ui/Terminali.tsx` e `src/ui/terminali.css`,
// fork `walterleonardo/jarvis_opensource`): spia di stato colorata + testo breve in mono. Qui vive
// solo la PROIEZIONE dei dati reali di VISIONE (core, agenti, eventi, telemetria, preferenze): dove
// non esiste uno stato dinamico si scrive `N/D` spento, mai un valore inventato.
import type { AgentView, CoreStateSnapshot, Language, VisioneEvent } from '../../shared/contracts/index.ts';
import { agentStateLabel } from '../app/hud-metrics.ts';
import { translate, type MessageKey, type Vars } from '../lib/i18n/index.ts';
import { reactorState } from '../reactor/shader.ts';
import type { WindowState } from './manager.ts';

export type WindowTone = 'on' | 'idle' | 'warn' | 'error' | 'off';

export interface WindowStatus {
  /** Testo breve (mono maiuscolo) a destra del titolo. */
  text: string;
  /** Colore della spia `.jwin-spia` (dal lessico `.term-spia`). */
  tone: WindowTone;
  /** Spiegazione estesa per il tooltip. */
  title: string;
}

export interface WindowStatusContext {
  ready: boolean;
  core: CoreStateSnapshot | null;
  events: readonly VisioneEvent[];
  pingMs: number | null;
  agents: readonly AgentView[] | null;
  reducedMotion: boolean;
}

const CORE_TONE: Record<string, WindowTone> = {
  ready: 'on',
  starting: 'warn',
  recovering: 'warn',
  stopping: 'warn',
  stopped: 'off',
  crashed: 'error'
};

const AGENT_TONE: Record<string, WindowTone> = {
  idle: 'idle',
  working: 'on',
  created: 'warn',
  starting: 'warn',
  waiting: 'warn',
  stopping: 'warn',
  recovering: 'warn',
  error: 'error',
  crashed: 'error',
  stopped: 'off'
};

const TASK_TONE: Record<string, WindowTone> = {
  done: 'on',
  running: 'on',
  created: 'warn',
  queued: 'warn',
  waiting: 'warn',
  blocked: 'error',
  failed: 'error',
  cancelled: 'off'
};

const VOICE_TONE: Record<string, WindowTone> = {
  idle: 'idle',
  planning: 'warn',
  working: 'on',
  listening: 'on',
  speaking: 'on',
  error: 'error'
};

/** Stato di un task dalla sua stessa storia di eventi (nessuna lettura extra). */
function taskStatusFromEvents(events: readonly VisioneEvent[], taskId: string | null): string | null {
  if (taskId === null) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e === undefined) continue;
    const p = e.payload as { taskId?: string };
    if (p.taskId !== taskId) continue;
    if (e.type === 'task.status.changed') {
      const to = (e.payload as { to?: unknown }).to;
      return typeof to === 'string' ? to : null;
    }
    if (e.type === 'task.result.recorded') {
      const outcome = (e.payload as { outcome?: unknown }).outcome;
      return typeof outcome === 'string' ? outcome : 'done';
    }
    if (e.type === 'task.created') return 'created';
    if (e.type === 'task.assigned') return 'queued';
  }
  return null;
}

/**
 * Stato della testata. `lang` (di default l'italiano di sempre) traduce i testi composti qui; i codici
 * di stato grezzi del core (`ready`, `running`…) restano quelli del core, come prima.
 */
export function windowStatus(win: WindowState, ctx: WindowStatusContext, lang: Language = 'it'): WindowStatus {
  const t = (key: MessageKey, vars?: Vars): string => translate(lang, key, vars);
  const na = t('windows.common.na');
  // Singolare/plurale: in italiano le due chiavi hanno lo stesso testo (identico a prima).
  const count = (n: number, one: MessageKey, other: MessageKey): string => t(n === 1 ? one : other, { n });
  switch (win.kind) {
    case 'director': {
      const s = ctx.core?.core.status ?? null;
      return {
        text: s ?? na,
        tone: s === null ? 'off' : (CORE_TONE[s] ?? 'idle'),
        title: t('windows.status.coreTitle', { status: s ?? na })
      };
    }
    case 'agent': {
      const view = ctx.agents?.find((a) => a.definition.id === win.ref) ?? null;
      const s = view?.instance?.status ?? null;
      if (s === null) {
        return { text: na, tone: 'off', title: t('windows.status.agentNoInstance', { who: win.ref ?? t('windows.status.agentThe') }) };
      }
      const label = agentStateLabel(s, view?.instance?.statusReason ?? null, lang);
      const reason = view?.instance?.statusReason;
      return {
        text: label,
        tone: AGENT_TONE[s] ?? 'idle',
        title: reason ? t('windows.status.agentTitleReason', { label, reason }) : t('windows.status.agentTitle', { label })
      };
    }
    case 'task': {
      const s = taskStatusFromEvents(ctx.events, win.ref);
      return {
        text: s ?? na,
        tone: s === null ? 'off' : (TASK_TONE[s] ?? 'idle'),
        title: s === null ? t('windows.status.taskNoEvents') : t('windows.status.taskTitle', { status: s })
      };
    }
    case 'telemetry': {
      const ms = ctx.pingMs;
      return {
        text: ms === null ? na : `${ms} ms`,
        tone: ms === null ? 'off' : ms <= 250 ? 'on' : 'warn',
        title: ms === null ? t('windows.status.pingNone') : t('windows.status.pingTitle', { ms })
      };
    }
    case 'logs':
      return { text: count(ctx.events.length, 'windows.status.eventsOne', 'windows.status.eventsOther'), tone: 'idle', title: t('windows.status.eventsTitle') };
    case 'errors': {
      const n = ctx.core?.error.count ?? null;
      return {
        text: n === null ? na : n > 0 ? count(n, 'windows.status.errorsOne', 'windows.status.errorsOther') : t('windows.status.noErrors'),
        tone: n === null ? 'off' : n > 0 ? 'warn' : 'on',
        title: n === null ? t('windows.status.errorsUnavailable') : t('windows.status.errorsTitle', { n })
      };
    }
    case 'terminal': {
      const n = ctx.core?.processes.active ?? null;
      return {
        text: n === null ? na : t('windows.status.procs', { n }),
        tone: n === null ? 'off' : n > 0 ? 'on' : 'idle',
        title: n === null ? t('windows.status.procsUnavailable') : t('windows.status.procsTitle', { n })
      };
    }
    case 'settings':
      return {
        text: ctx.reducedMotion ? t('windows.status.motionReduced') : t('windows.status.motionFull'),
        tone: 'idle',
        title: t('windows.status.motionTitle')
      };
    case 'memory':
      return { text: ctx.ready ? t('windows.status.memoryReady') : na, tone: ctx.ready ? 'idle' : 'off', title: t('windows.status.memoryTitle') };
    case 'approvals': {
      const n = ctx.core?.approvals.pending ?? null;
      return {
        text: n === null ? na : t('windows.status.approvalsPending', { n }),
        tone: n === null ? 'off' : n > 0 ? 'warn' : 'on',
        title: n === null ? t('windows.status.approvalsUnavailable') : t('windows.status.approvalsTitle', { n })
      };
    }
    case 'reactor': {
      const s = reactorState(ctx.core);
      return { text: s, tone: VOICE_TONE[s] ?? 'idle', title: t('windows.status.reactorTitle', { state: s }) };
    }
    case 'apps':
    case 'files':
    case 'browser':
    case 'training':
    case 'system':
      return { text: ctx.ready ? t('windows.status.ready') : na, tone: ctx.ready ? 'idle' : 'off', title: ctx.ready ? t('windows.status.coreReady') : t('windows.status.coreNotReady') };
  }
}
