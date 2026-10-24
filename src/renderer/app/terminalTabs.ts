// Schede della vista Terminale (P-94): comportamento da terminale normale. Le sessioni VIVE sono
// schede; quando una sessione termina resta al più END_GRACE_MS come «terminato» (per far leggere
// l'ultima uscita) e poi sparisce da sola; le sessioni già terminate prima dell'apertura della vista
// non compaiono (niente schede morte con errori `operation_failed: sessione terminata`). La chiusura
// con × nasconde la scheda subito. Logica pura, senza React: testabile da sola.
import type { TerminalSession } from '../../shared/contracts/index.ts';

/** Quanto una sessione terminata resta visibile come «terminato» prima di sparire. */
export const END_GRACE_MS = 4_000;

export interface TerminalTabMemory {
  /** processId visti vivi almeno una volta da questa vista (all'apertura le morte non si mostrano). */
  seenLive: ReadonlySet<string>;
  /** processId rimossi (× o fine grazia): non riappaiono più. */
  hidden: ReadonlySet<string>;
  /** processId in grazia «terminato» → scadenza (ms epoch). */
  ending: ReadonlyMap<string, number>;
}

export const EMPTY_TABS: TerminalTabMemory = { seenLive: new Set(), hidden: new Set(), ending: new Map() };

export interface TabsUpdate {
  memory: TerminalTabMemory;
  /** Schede mostrate (vive + terminate in grazia). */
  visible: TerminalSession[];
  /** Le schede terminate ancora mostrate (stato «terminato»). */
  ending: TerminalSession[];
  /** Prossima scadenza da riprogrammare, o null. */
  nextDeadline: number | null;
}

export function updateTerminalTabs(
  memory: TerminalTabMemory,
  sessions: readonly TerminalSession[],
  now: number,
  graceMs = END_GRACE_MS
): TabsUpdate {
  const seenLive = new Set(memory.seenLive);
  const hidden = new Set(memory.hidden);
  const ending = new Map(memory.ending);
  const visible: TerminalSession[] = [];
  const endingList: TerminalSession[] = [];
  for (const s of sessions) {
    if (hidden.has(s.processId)) continue;
    if (s.endedAt === null) {
      seenLive.add(s.processId);
      ending.delete(s.processId);
      visible.push(s);
      continue;
    }
    // Terminata: si mostra solo se era stata vista viva in questa vista (le morte storiche non tornano).
    if (!seenLive.has(s.processId)) continue;
    const deadline = ending.get(s.processId) ?? s.endedAt + graceMs;
    if (now >= deadline) {
      hidden.add(s.processId);
      ending.delete(s.processId);
      continue;
    }
    ending.set(s.processId, deadline);
    endingList.push(s);
    visible.push(s);
  }
  let nextDeadline: number | null = null;
  for (const d of ending.values()) nextDeadline = nextDeadline === null ? d : Math.min(nextDeadline, d);
  return { memory: { seenLive, hidden, ending }, visible, ending: endingList, nextDeadline };
}

/** Chiusura dal ×: la scheda sparisce subito (la sessione la termina il core). */
export function hideTerminalTab(memory: TerminalTabMemory, processId: string): TerminalTabMemory {
  const hidden = new Set(memory.hidden);
  hidden.add(processId);
  const ending = new Map(memory.ending);
  ending.delete(processId);
  return { seenLive: memory.seenLive, hidden, ending };
}

/** La chiusura è fallita (la sessione è viva): la scheda torna visibile al prossimo aggiornamento. */
export function unhideTerminalTab(memory: TerminalTabMemory, processId: string): TerminalTabMemory {
  if (!memory.hidden.has(processId)) return memory;
  return { seenLive: memory.seenLive, hidden: new Set([...memory.hidden].filter((id) => id !== processId)), ending: memory.ending };
}
