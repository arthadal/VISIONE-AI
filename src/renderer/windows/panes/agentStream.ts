// Terminale REALE dei motori headless (P-93): il tab TERMINAL di un agente con motore a processo
// per turno non ha una sessione PTY (i motori headless P-7 non aprono una shell), quindi mostra il
// flusso vero del turno così come arriva dal bridge degli adapter (`agent.*`, `tool.call.*`): niente
// prompt finti, niente righe inventate. Funzione pura e testata; la UI la rende in sola visualizzazione.
import type { Language, VisioneEvent } from '../../../shared/contracts/index.ts';
import { translate, type MessageKey, type Vars } from '../../lib/i18n/index.ts';

export interface AgentStreamLine {
  readonly id: string;
  readonly at: number;
  readonly kind: 'session' | 'turn' | 'text' | 'tool' | 'limit' | 'error';
  readonly text: string;
}

/** Tetto delle righe tenute dal terminale (le più recenti). */
export const MAX_STREAM_LINES = 400;

/** Codici ANSI del TUI (SGR/CSI/OSC): nel flusso testuale non sono visibili, si rimuovono. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

/** Testo di una riga: niente codici di controllo del terminale, niente spazi finali. */
function lineText(text: string): string {
  return text.replace(ANSI, '').replace(/\s+$/u, '').slice(0, 2_000);
}

/**
 * Unione dello storico caricato all'apertura (`events.list`) con gli eventi vivi della UI:
 * deduplica per id preservando l'ordine di arrivo (lo storico precede i vivi). Pura e testata.
 */
export function mergeStreamEvents(history: readonly VisioneEvent[], live: readonly VisioneEvent[]): VisioneEvent[] {
  const byId = new Map<string, VisioneEvent>();
  for (const e of history) byId.set(e.id, e);
  for (const e of live) byId.set(e.id, e);
  return [...byId.values()];
}

/** Proiezione del flusso di UN agente dagli eventi reali; fuori dalla finestra eventi = fuori anche qui. `lang`: lingua dei testi composti qui (di default l'italiano). */
export function agentStream(events: readonly VisioneEvent[], agentId: string, lang: Language = 'it'): AgentStreamLine[] {
  const t = (key: MessageKey, vars?: Vars): string => translate(lang, key, vars);
  const out: AgentStreamLine[] = [];
  const push = (e: VisioneEvent, kind: AgentStreamLine['kind'], text: string): void => {
    const clean = lineText(text);
    if (clean !== '') out.push({ id: e.id, at: e.ts, kind, text: clean });
  };
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (p.agentId !== agentId) continue;
    switch (e.type) {
      case 'agent.session.started':
        push(e, 'session', t('windows.stream.session', { id: String(p.engineSessionId ?? '') }));
        break;
      case 'agent.turn.started': {
        const task = typeof p.taskId === 'string' ? ` · task ${p.taskId.slice(-6)}` : '';
        push(e, 'turn', `${t('windows.stream.turnStarted')}${task}`);
        break;
      }
      case 'agent.message.text': {
        // Un messaggio può essere multi-riga: ogni riga è una riga di terminale.
        const lines = String(p.text ?? '').split(/\r?\n/u);
        lines.forEach((line, i) => {
          const clean = lineText(line);
          if (clean !== '') out.push({ id: `${e.id}-${i}`, at: e.ts, kind: 'text', text: clean });
        });
        break;
      }
      case 'tool.call.started':
        push(e, 'tool', t('windows.stream.toolStarted', { tool: String(p.tool ?? '?') }));
        break;
      case 'tool.call.finished': {
        const ms = typeof p.durationMs === 'number' ? ` · ${p.durationMs} ms` : '';
        push(e, 'tool', `${t(p.ok === false ? 'windows.stream.toolFinishedErr' : 'windows.stream.toolFinishedOk', { tool: String(p.tool ?? '?') })}${ms}`);
        break;
      }
      case 'tool.call.denied':
        push(e, 'tool', t('windows.stream.toolDenied', { tool: String(p.tool ?? '?'), reason: String(p.reason ?? '') }));
        break;
      case 'agent.limit.reached': {
        const reset = typeof p.resetAt === 'string' && p.resetAt !== '' ? ` · ${t('windows.stream.reset', { at: p.resetAt })}` : '';
        push(e, 'limit', `${t('windows.stream.limit', { scope: String(p.scope ?? ''), message: String(p.message ?? '') })}${reset}`);
        break;
      }
      case 'agent.turn.finished': {
        const outcome = String(p.outcome ?? '');
        if (outcome === 'completed') {
          push(e, 'turn', t('windows.stream.turnCompleted'));
        } else {
          const error = p.error as { message?: unknown } | null;
          const message = typeof error?.message === 'string' ? error.message : outcome;
          push(e, 'error', t(outcome === 'cancelled' ? 'windows.stream.turnCancelled' : 'windows.stream.turnFailed', { message }));
        }
        break;
      }
      default:
        break;
    }
  }
  return out.slice(-MAX_STREAM_LINES);
}
