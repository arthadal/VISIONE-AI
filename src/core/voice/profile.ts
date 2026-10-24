// Profilo della voce consigliato dalla prova del PC (16/10/2026, scelta del proprietario: tre livelli,
// consigliato da VISIONE e modificabile). La prova misura la voce VISIONE: tempo di calcolo / durata
// dell'audio (RTF), la migliore di tre (`voice/benchmark.ts`). Misure su questo PC (Core Ultra 5 125H): in carica
// 0,44-0,77; a batteria 0,7-1,2; con un solo thread 1,5. Sopra 1 la voce deve aspettare prima di parlare;
// nello stesso PC anche «hey visione» (Whisper su ogni voce sentita) pesa di più.
import type { Language, VoiceProfile } from '../../shared/contracts/index.ts';

/**
 * Fino a qui la voce VISIONE parla senza attese: il motore tiene una riserva del 15% sul costo di ogni
 * fotogramma (`RESERVE` 1,15 in `voice/pocket/engine.ts`), quindi oltre 1/1,15 ≈ 0,87 ogni frase parte in
 * ritardo. Non 0,7 (16/10/2026): su questo PC in carica la prova varia fra 0,55 e 0,77 da un minuto all'altro, e
 * con 0,7 il consiglio cambiava da una prova all'altra.
 */
export const FULL_MAX_RTF = 0.85;
/** Oltre, anche l'ascolto continuo è pesante: si consiglia solo il tasto. */
export const LIGHT_MAX_RTF = 1.2;

/**
 * Profilo consigliato. Senza misura (voce VISIONE assente) si resta prudenti con la voce di Windows; la voce
 * VISIONE parla solo italiano, quindi in inglese il massimo è `light`.
 */
export function recommendProfile(rtf: number | null, language: Language): VoiceProfile {
  if (rtf === null) return 'light';
  if (rtf > LIGHT_MAX_RTF) return 'minimal';
  if (rtf > FULL_MAX_RTF || language !== 'it') return 'light';
  return 'full';
}
