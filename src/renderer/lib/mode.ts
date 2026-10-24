// Modalità semplice / esperto (11/10/2026, prima dell'uscita): chi usa VISIONE ogni giorno vede solo ciò
// che gli serve; i dettagli da sviluppatore (provider, token, revisione dello stato, replay, registri,
// configurazione completa) restano a un interruttore di distanza. `ui.expert`, spenta di partenza, vale
// subito. Nel DOM: `<html data-expert>` e la classe `x-expert` sugli elementi da nascondere (CSS).
import { createContext, useContext } from 'react';

export const ExpertContext = createContext(false);

/** `true` in modalità esperto. */
export function useExpert(): boolean {
  return useContext(ExpertContext);
}

export function expertOf(config: Record<string, unknown>): boolean {
  return (config.ui as { expert?: unknown } | undefined)?.expert === true;
}

/** Modalità leggera (`ui.light`): `true` solo se accesa esplicitamente. */
export function lightOf(config: Record<string, unknown>): boolean {
  return (config.ui as { light?: unknown } | undefined)?.light === true;
}

/** Finestre dell'uso di tutti i giorni; le altre (telemetria, log, terminale, memoria) sono da esperto. */
const SIMPLE_WINDOWS: ReadonlySet<string> = new Set(['director', 'apps', 'files', 'browser', 'training', 'system', 'errors', 'approvals']);
export const windowVisible = (kind: string, expert: boolean): boolean => expert || SIMPLE_WINDOWS.has(kind);

/** Linguette e pannelli da esperto: il registro grezzo e la diagnostica interna. */
const EXPERT_TABS: ReadonlySet<string> = new Set(['log']);
const EXPERT_PANELS: ReadonlySet<string> = new Set(['diag']);
export const tabVisible = (id: string, expert: boolean): boolean => expert || !EXPERT_TABS.has(id);
export const panelVisible = (id: string, expert: boolean): boolean => expert || !EXPERT_PANELS.has(id);

/** Impostazioni mostrate in modalità semplice: voce e avvio; il resto della configurazione è da esperto. */
const SIMPLE_SETTINGS: ReadonlySet<string> = new Set([
  'voice.enabled', 'voice.volume', 'voice.startupBriefing', 'voice.startupPhrase', 'voice.announceStartup',
  'voice.speakSummaries', 'voice.announceApprovals', 'voice.tts.voice', 'voice.tts.rate', 'voice.wake.phrase',
  'voice.ownerOnly.enabled', 'ui.startWithWindows', 'ui.light'
]);
export const settingVisible = (path: string, expert: boolean): boolean => expert || SIMPLE_SETTINGS.has(path);
