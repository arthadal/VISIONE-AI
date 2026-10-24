// Attivazione REALE della scena dalla voce (P-90): l'inviluppo di attacco/rilascio del livello audio
// vero (microfono in ascolto e uscita TTS mentre VISIONE parla). Entra solo con gli stati reali del
// reactor (`speaking`/`listening`) e decade a zero in ogni altro stato: nessuna attivazione finta,
// nessun movimento legato alla voce senza che la voce ci sia davvero. Pura e testata
// (`test/unit/renderer-safety.test.ts`).
import type { ReactorState } from '../reactor/shader.ts';

/** Tempi dell'inviluppo in secondi: attacco rapido, rilascio morbido (eleganza, nessuno scatto). */
export const VOCE_ATTACCO_S = 0.12;
export const VOCE_RILASCIO_S = 0.45;
/** Sotto questa soglia, con target zero, l'inviluppo scatta a ZERO esatto (P-92): a fine voce la
 *  scena torna esattamente alla resa di riposo P-89, senza code decimali. */
export const VOCE_SOGLIA_ZERO = 0.01;
/** Base tenuta dallo stato reale e modulata dal livello audio (0..1): parlare accende più che ascoltare. */
const BASE: Partial<Record<ReactorState, number>> = { speaking: 0.45, listening: 0.2 };

/** Obiettivo dell'attivazione dallo stato REALE e dal livello reale: 0 fuori da voce/parlato. */
export function voiceTarget(state: ReactorState, level: number): number {
  const base = BASE[state] ?? 0;
  if (base <= 0) return 0;
  // Stessa regola di `safeUnit`: NaN → 0, ±∞ → estremo, il resto clampato in [0,1].
  const l = Number.isNaN(level) ? 0 : Math.min(1, Math.max(0, level));
  return Math.min(1, base + l * (1 - base));
}

/** Passo dell'inviluppo (`dtS` in secondi): valori anomali non avvelenano lo shader. */
export function voiceActivation(state: ReactorState, level: number, dtS: number, prev: number): number {
  const target = voiceTarget(state, level);
  const dt = Number.isFinite(dtS) ? Math.min(0.05, Math.max(0, dtS)) : 0;
  const p = Number.isFinite(prev) ? Math.min(1, Math.max(0, prev)) : 0;
  if (dt === 0) return p;
  const tau = target >= p ? VOCE_ATTACCO_S : VOCE_RILASCIO_S;
  const next = p + (target - p) * (1 - Math.exp(-dt / tau));
  if (!Number.isFinite(next)) return 0;
  const clamped = Math.min(1, Math.max(0, next));
  // P-92: a fine voce (target zero) l'ultima coda scatta a ZERO esatto: la scena torna
  // bit-per-bit alla resa di riposo approvata P-89, non a un valore «quasi zero».
  if (target === 0 && clamped < VOCE_SOGLIA_ZERO) return 0;
  return clamped;
}
