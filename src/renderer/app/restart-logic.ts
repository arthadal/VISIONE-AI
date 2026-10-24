// Impostazioni a caldo o col riavvio (11/10/2026, richiesta del proprietario): una modifica che si può
// applicare subito si applica subito; se serve il riavvio compare una finestra che lo chiede e, se il
// Director o gli agenti stanno lavorando, avvisa e propone di riavviare quando hanno finito. Puro e
// testato: nessun accesso al core da qui.
import type { CoreStateSnapshot, Language } from '../../shared/contracts/index.ts';
import { translate } from '../lib/i18n/index.ts';

/** Chiavi che l'interfaccia o il core applicano subito: nessun riavvio. */
export const HOT_PATHS: ReadonlySet<string> = new Set([
  'ui.scene', 'ui.directorName', 'ui.nodeLingerSec', 'ui.language', 'ui.expert', 'ui.guideSeen', 'ui.light',
  'director.plannerAgentId', 'setup.completedVersion',
  // La wake ha il suo comando che la accende o spegne subito (P-81).
  'voice.wake.enabled',
  // 11/10/2026: il volume lo applica il renderer, l'avvio con Windows il main, il saluto lo legge il
  // core al momento: nessun riavvio.
  'voice.volume', 'voice.startupBriefing', 'voice.startupPhrase', 'voice.announceStartup', 'ui.startWithWindows'
]);

/** Il processo voce rilegge la configurazione quando riparte: basta riavviare lui (pochi secondi). */
export const isVoicePath = (path: string): boolean => path === 'voice' || path.startsWith('voice.');

export type ChangeKind = 'hot' | 'voice' | 'app';

/** Cosa serve perché le chiavi cambiate valgano: niente, il riavvio della voce o quello di VISIONE. */
export function changeKind(changed: readonly string[]): ChangeKind {
  let kind: ChangeKind = 'hot';
  for (const path of changed) {
    if (HOT_PATHS.has(path)) continue;
    if (isVoicePath(path)) kind = 'voice';
    else return 'app';
  }
  return kind;
}

export interface Busy {
  goals: number;
  tasks: number;
  agents: number;
  total: number;
}

/** Lavoro in corso del Director e degli agenti (dati reali del core; null = core non collegato). */
export function busyOf(core: CoreStateSnapshot | null): Busy | null {
  if (!core) return null;
  const goals = core.director.activeGoals;
  const tasks = core.tasks.active;
  const agents = core.agents.working;
  return { goals, tasks, agents, total: goals + tasks + agents };
}

/** Frase per la finestra: cosa è ancora in corso, senza voci a zero. */
export function busyText(b: Busy, lang: Language = 'it'): string {
  const parts: string[] = [];
  if (b.goals > 0) parts.push(b.goals === 1 ? translate(lang, 'shell.busy.goal1') : translate(lang, 'shell.busy.goals', { n: b.goals }));
  if (b.tasks > 0) parts.push(b.tasks === 1 ? translate(lang, 'shell.busy.task1') : translate(lang, 'shell.busy.tasks', { n: b.tasks }));
  if (b.agents > 0) parts.push(b.agents === 1 ? translate(lang, 'shell.busy.agent1') : translate(lang, 'shell.busy.agents', { n: b.agents }));
  return parts.join(', ');
}

/** Secondi di preavviso prima del riavvio automatico a lavoro finito (annullabile). */
export const IDLE_RESTART_COUNTDOWN_S = 10;
