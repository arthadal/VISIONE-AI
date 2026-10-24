// Comandi vocali di ambiente nel renderer (Fase 22, P-69): il core riconosce l'azione e la manda
// con l'evento `voice.command`; qui la si risolve con il contesto REALE della UI (finestra in primo
// piano, agenti noti, finestre aperte) in un piano eseguibile. Funzione pura: nessun DOM, testabile.
import type { VoiceCommandAction } from '../../shared/contracts/index.ts';
import type { WindowKind } from '../windows/manager.ts';

/** Le finestre che `open-window` può aprire (i nomi parlati stanno in shared/lib/window-names.ts, lato core). */
const OPENABLE: readonly WindowKind[] = ['settings', 'training', 'files', 'apps', 'browser', 'system', 'errors', 'approvals', 'memory', 'director'];

export interface VoiceCommandPayload {
  readonly utteranceId: string;
  readonly action: VoiceCommandAction;
  readonly target: string | null;
  readonly text: string;
}

export interface VoiceUiContext {
  /** Id delle finestre aperte (id stabili del Window Manager). */
  readonly openIds: readonly string[];
  readonly frontKind: WindowKind | null;
  readonly frontRef: string | null;
  readonly agents: ReadonlyArray<{ id: string; name: string }>;
  /** Numeri reali dallo snapshot del core; null = stato non disponibile. */
  readonly status: { agentsWorking: number; tasksActive: number; activeGoals: number; processesActive: number } | null;
}

export type VoiceUiPlan =
  | { kind: 'open'; windowKind: WindowKind; ref: string | null; title: string | null; subtitle: string | null }
  | { kind: 'close'; id: string }
  | { kind: 'speak'; text: string };

const norm = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

/** Trova l'agente pronunciato; se `target` è null usa quello della finestra in primo piano. */
function findAgent(target: string | null, ctx: VoiceUiContext): { id: string; name: string } | null {
  if (target === null || norm(target) === '') {
    if (ctx.frontKind === 'agent' && ctx.frontRef) {
      return ctx.agents.find((a) => a.id === ctx.frontRef) ?? { id: ctx.frontRef, name: ctx.frontRef };
    }
    return null;
  }
  const t = norm(target);
  return (
    ctx.agents.find((a) => norm(a.id) === t || norm(a.name) === t) ??
    ctx.agents.find((a) => norm(a.id).includes(t) || norm(a.name).includes(t)) ??
    null
  );
}

export function resolveVoiceCommand(cmd: VoiceCommandPayload, ctx: VoiceUiContext): VoiceUiPlan {
  switch (cmd.action) {
    case 'open-director':
      return { kind: 'open', windowKind: 'director', ref: null, title: 'Director', subtitle: 'coordinatore' };
    case 'open-window': {
      // «apri le impostazioni» (17/10/2026): il nome lo riconosce il core, qui arriva già il tipo di finestra.
      const kind = OPENABLE.find((k) => k === cmd.target);
      return kind ? { kind: 'open', windowKind: kind, ref: null, title: null, subtitle: null } : { kind: 'speak', text: 'Finestra sconosciuta.' };
    }
    case 'open-agent':
    case 'open-terminal': {
      const agent = findAgent(cmd.target, ctx);
      if (!agent) {
        return {
          kind: 'speak',
          text: cmd.target ? `Nessun agente corrisponde a ${cmd.target}.` : 'Nessun agente selezionato: dimmi il nome.'
        };
      }
      // La finestra dell'agente apre di default il suo terminale (Terminal Mode, Fase 21).
      return { kind: 'open', windowKind: 'agent', ref: agent.id, title: agent.name, subtitle: 'sessione reale' };
    }
    case 'close-terminal': {
      if (cmd.target !== null && norm(cmd.target) !== '') {
        const agent = findAgent(cmd.target, ctx);
        if (agent && ctx.openIds.includes(`agent:${agent.id}`)) return { kind: 'close', id: `agent:${agent.id}` };
        return { kind: 'speak', text: 'Nessun terminale aperto per quell\'agente.' };
      }
      if (ctx.openIds.includes('terminal')) return { kind: 'close', id: 'terminal' };
      if (ctx.frontKind === 'agent' && ctx.frontRef) return { kind: 'close', id: `agent:${ctx.frontRef}` };
      if (ctx.frontKind === 'terminal') return { kind: 'close', id: 'terminal' };
      return { kind: 'speak', text: 'Nessun terminale aperto.' };
    }
    case 'close-window': {
      if (ctx.frontKind === null) return { kind: 'speak', text: 'Nessuna finestra aperta.' };
      const id = ctx.frontRef ? `${ctx.frontKind}:${ctx.frontRef}` : ctx.frontKind;
      if (!ctx.openIds.includes(id)) return { kind: 'speak', text: 'Nessuna finestra da chiudere.' };
      return { kind: 'close', id };
    }
    case 'find-file': {
      // Esplora VISIONE si apre già con la ricerca nelle cartelle dell'utente (Desktop, Documenti…).
      if (cmd.target === null || cmd.target.trim() === '') return { kind: 'speak', text: 'Dimmi il nome del file da cercare.' };
      return { kind: 'open', windowKind: 'files', ref: `find:${cmd.target.trim()}`, title: null, subtitle: null };
    }
    case 'status': {
      if (!ctx.status) return { kind: 'speak', text: 'Stato non disponibile.' };
      const s = ctx.status;
      const agents = s.agentsWorking === 1 ? '1 agente al lavoro' : `${s.agentsWorking} agenti al lavoro`;
      const tasks = s.tasksActive === 1 ? '1 task attivo' : `${s.tasksActive} task attivi`;
      const goals = s.activeGoals === 1 ? '1 obiettivo attivo' : `${s.activeGoals} obiettivi attivi`;
      return { kind: 'speak', text: `${agents}, ${tasks}, ${goals}.` };
    }
  }
}
