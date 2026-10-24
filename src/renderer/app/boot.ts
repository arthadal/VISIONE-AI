// Sequenza di avvio (Fase 23, P-70): tappe REALI, sincronizzate con gli stati del supervisore e del
// core. Nessun setTimeout che finge un avvio: se una tappa non è pronta lo dice; se un componente è
// indisponibile (es. voce senza modelli) lo mostra come avviso, non come successo.
import type { CoreStateSnapshot, Language, SupervisorSnapshot } from '../../shared/contracts/index.ts';
import { translate } from '../lib/i18n/index.ts';

export type BootStepStatus = 'done' | 'active' | 'pending' | 'error' | 'warn';

export interface BootStep {
  readonly id: string;
  readonly label: string;
  readonly status: BootStepStatus;
  readonly detail: string | null;
}

export function bootComplete(sup: SupervisorSnapshot | null, core: CoreStateSnapshot | null): boolean {
  // La sequenza resta aperta finché la voce non è pronta o dichiarata (unavailable/failed/off):
  // la frase di avvio arriva alla fine, non nel vuoto dopo la chiusura (Fase 24).
  const voiceSettled = core !== null && core.voice.status !== 'starting';
  return sup?.state === 'ready' && core?.core.status === 'ready' && voiceSettled;
}

/** Le tappe nella lingua indicata (di partenza l'italiano; i testi dei dettagli sono i codici di stato reali). */
export function bootSteps(sup: SupervisorSnapshot | null, core: CoreStateSnapshot | null, lang: Language = 'it'): BootStep[] {
  const supState = sup?.state ?? null;
  const supStatus: BootStepStatus = supState === 'ready' ? 'done' : supState === 'failed' ? 'error' : supState ? 'active' : 'pending';
  const coreStatusRaw = core?.core.status ?? null;
  const coreStatus: BootStepStatus = coreStatusRaw === 'ready' ? 'done' : coreStatusRaw === 'crashed' || coreStatusRaw === 'stopped' ? 'error' : coreStatusRaw ? 'active' : 'pending';
  const voiceRaw = core?.voice.status ?? null;
  const voiceStatus: BootStepStatus = voiceRaw === 'ready' ? 'done' : voiceRaw === 'unavailable' || voiceRaw === 'failed' ? 'warn' : voiceRaw ? 'active' : 'pending';
  return [
    { id: 'supervisor', label: translate(lang, 'shell.boot.supervisor'), status: supStatus, detail: supState },
    { id: 'core', label: translate(lang, 'shell.boot.core'), status: coreStatus, detail: coreStatusRaw ? (core?.core.recovered ? translate(lang, 'shell.boot.coreRecovered', { status: coreStatusRaw }) : coreStatusRaw) : null },
    { id: 'database', label: translate(lang, 'shell.boot.database'), status: core ? (core.database.status === 'ok' ? 'done' : 'warn') : 'pending', detail: core ? `${core.database.status} · seq ${core.database.journalLastSeq}` : null },
    { id: 'voice', label: translate(lang, 'shell.boot.voice'), status: voiceStatus, detail: voiceRaw }
  ];
}
