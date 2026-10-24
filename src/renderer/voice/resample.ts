// Ricampionamento lineare del microfono (P-74): funzione pura, testabile, con guardie su lunghezze e
// frequenze. `new Float32Array(Infinity/-1)` è un crash del renderer; qui i valori anomali degradano
// a "nessun ricampionamento" (si restituisce una copia) invece di far cadere la finestra.
import { safeCount } from '../lib/safe.ts';

/** Tetto di sicurezza dell'uscita (~60 s a 16 kHz): nessun blocco reale del microfono si avvicina. */
export const MAX_RESAMPLE_SAMPLES = 1_000_000;

export function resample(input: Float32Array<ArrayBuffer>, from: number, to: number): Float32Array<ArrayBuffer> {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0 || from === to) return input.slice();
  const ratio = from / to;
  if (!Number.isFinite(ratio) || ratio <= 0) return input.slice();
  const length = safeCount(input.length / ratio, MAX_RESAMPLE_SAMPLES);
  if (length === 0) return new Float32Array(0);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const t = pos - i0;
    out[i] = (input[i0] ?? 0) * (1 - t) + (input[i1] ?? 0) * t;
  }
  return out;
}
