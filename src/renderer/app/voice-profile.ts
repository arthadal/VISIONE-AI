// Profilo della voce (16/10/2026, scelta del proprietario): tre livelli, consigliati da una prova del PC e
// modificabili. Un profilo è solo una combinazione di due impostazioni che esistono già (motore del parlato
// e «hey visione»): qui la corrispondenza nei due sensi, senza stato.
import type { Language, VoiceProfile } from '../../shared/contracts/index.ts';

export const VOICE_PROFILES: readonly VoiceProfile[] = ['full', 'light', 'minimal'];

/** Cosa imposta ogni profilo. */
export const PROFILE_SETTINGS: Readonly<Record<VoiceProfile, { readonly provider: 'visione' | 'windows'; readonly wake: boolean }>> = {
  full: { provider: 'visione', wake: true },
  light: { provider: 'windows', wake: true },
  minimal: { provider: 'windows', wake: false }
};

const voiceOf = (config: Record<string, unknown>): Record<string, unknown> => {
  const v = config.voice;
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
};
const field = (obj: unknown, key: string): unknown => (obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>)[key] : undefined);

/**
 * Il profilo della configurazione attuale, o `custom` se le impostazioni sono state cambiate una per una
 * (per esempio voce VISIONE senza «hey visione», o un motore di sviluppo).
 */
export function profileOf(config: Record<string, unknown>): VoiceProfile | 'custom' {
  const voice = voiceOf(config);
  const provider = field(voice.tts, 'provider') ?? 'visione';
  const wake = field(voice.wake, 'enabled') === true;
  return VOICE_PROFILES.find((p) => PROFILE_SETTINGS[p].provider === provider && PROFILE_SETTINGS[p].wake === wake) ?? 'custom';
}

/** La voce VISIONE parla solo italiano: in un'altra lingua la Completa non si può scegliere. */
export function profileAvailable(profile: VoiceProfile, language: Language): boolean {
  return profile !== 'full' || language === 'it';
}

/** La modifica della configurazione per un profilo; `windowsVoice` vale per i profili con la voce di Windows. */
export function profilePatch(profile: VoiceProfile, windowsVoice: string | null): { voice: { tts: { provider: 'visione' | 'windows'; voice?: string }; wake: { enabled: boolean } } } {
  const s = PROFILE_SETTINGS[profile];
  const tts = s.provider === 'windows' && windowsVoice ? { provider: s.provider, voice: windowsVoice } : { provider: s.provider };
  return { voice: { tts, wake: { enabled: s.wake } } };
}

/**
 * La prova del PC detta in parole: quante volte più in fretta del necessario il PC prepara la voce VISIONE
 * (RTF 0,5 → «2»), o null se è più lento del necessario.
 */
export function speedTimes(rtf: number, language: Language): string | null {
  if (!(rtf > 0) || rtf >= 1) return null;
  const x = 1 / rtf;
  const text = x >= 10 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '');
  return language === 'it' ? text.replace('.', ',') : text;
}
