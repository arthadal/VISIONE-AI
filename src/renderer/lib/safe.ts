// Guardie di allocazione del renderer (P-74). I conteggi che finiscono in array e typed array devono
// essere interi finiti e non negativi: `new Array(NaN/-1/1e9)` e `new Float32Array(Infinity)` sono un
// crash del renderer (`RangeError: Invalid array length` / `Invalid typed array length`), non un
// dettaglio grafico. Queste funzioni sono pure e testate in `test/unit/renderer-safety.test.ts`.

/** Intero sicuro in `[0, max]`: non finiti → `fallback` (default 0), negativi → 0, decimali troncati. */
export function safeCount(value: number, max: number, fallback = 0): number {
  const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  const safeFallback = Number.isFinite(fallback) ? Math.min(cap, Math.max(0, Math.floor(fallback))) : 0;
  if (!Number.isFinite(value)) return safeFallback;
  const n = Math.floor(value);
  if (n <= 0) return 0;
  return Math.min(n, cap);
}

/** Intero sicuro in `[min, max]` (estremi riordinati se invertiti); non finito → `fallback` clampato. */
export function safeInt(value: number, min: number, max: number, fallback: number): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  const clamp = (n: number): number => Math.min(hi, Math.max(lo, n));
  if (!Number.isFinite(value)) return clamp(Number.isFinite(fallback) ? Math.floor(fallback) : lo);
  return clamp(Math.floor(value));
}

/** Valore in `[0, 1]` (per energie/livelli: NaN → fallback, ±∞ → estremo). */
export function safeUnit(value: number, fallback = 0): number {
  if (Number.isNaN(value)) return Math.min(1, Math.max(0, fallback));
  return Math.min(1, Math.max(0, value));
}
