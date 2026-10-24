// Wake → finestra dell'agente (P-83). Logica PURA e testabile: dalla storia eventi reali e dalle
// viste reali degli agenti decide cosa fare. Le capacità vengono dall'adapter (nessun nome di
// motore qui): il target è un agente con terminale interattivo e turni osservabili via hook —
// qualunque adattatore le dichiari. Un evento della storia (journal riprodotto
// all'avvio) non apre nulla; se nessun agente ha quelle capacità lo dice, non apre finestre finte.
import type { AgentCapability, AgentView, Language, VisioneEvent } from '../../shared/contracts/index.ts';
import { translate } from '../lib/i18n/index.ts';

export type WakePlan =
  | { kind: 'ignore' }
  | { kind: 'open'; agentId: string; name: string }
  | { kind: 'error'; message: string };

/** Capacità necessarie al bersaglio della wake: PTY interattivo + fine turno strutturata. */
const WAKE_CAPABILITIES: readonly AgentCapability[] = ['turns.interactive', 'events.turnEnd'];

/** L'ultimo evento di wake nella finestra della UI, se c'è. */
export function wakeEventOf(events: readonly VisioneEvent[]): VisioneEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as VisioneEvent;
    if (e.type === 'voice.wake.detected') return e;
  }
  return null;
}

/** Un evento precedente all'avvio del core è storia del journal: non si esegue di nuovo. */
export function isFreshWake(e: VisioneEvent, coreStartedAt: number | null): boolean {
  return coreStartedAt === null || e.ts >= coreStartedAt;
}

/** Primo agente (ordine stabile per id) con le capacità del bersaglio wake. */
export function pickWakeAgent(agents: readonly AgentView[]): AgentView | null {
  return agents.find((a) => !a.archived && WAKE_CAPABILITIES.every((c) => a.capabilities.includes(c))) ?? null;
}

/** Piano completo: ignora (nessuna wake fresca), apri l'agente, oppure errore reale da mostrare. */
export function wakePlan(events: readonly VisioneEvent[], agents: readonly AgentView[], coreStartedAt: number | null, lang: Language = 'it'): WakePlan {
  const e = wakeEventOf(events);
  if (!e || !isFreshWake(e, coreStartedAt)) return { kind: 'ignore' };
  const agent = pickWakeAgent(agents);
  if (!agent) {
    return {
      kind: 'error',
      message: translate(lang, 'windows.wake.noAgent')
    };
  }
  return { kind: 'open', agentId: agent.definition.id, name: agent.definition.name || agent.definition.id };
}
