// Filtri dell'ascolto (P-106, richiesta del proprietario del 10/10/2026: «isolare i rumori» e «che
// ascolti solo la voce del proprietario»). Logica pura, senza modelli: i motori arrivano da `sherpa.ts`.
//  - soglia del rumore: un parlato troppo debole (RMS) non si trascrive;
//  - pulizia GTCRN (motore facoltativo) prima dello STT e dell'impronta;
//  - solo il proprietario: impronta vocale (ERes2Net) confrontata con quella registrata.
// Regola tarata il 10/10/2026 su voci reali (sr-data + LibriSpeech, estraneo MAI nella coorte):
// somiglianza ≥ 0,40 e margine ≥ 0,05 sulla voce di riferimento più simile → proprietario 10/11,
// estranei 0/138 (vedi docs/RIPRESA_PROGRAMMA_TESTER.md, P-106).

/** Impronta vocale di un segmento (16 kHz mono). */
export interface SpeakerEngine {
  readonly name: string;
  embed(samples: Float32Array): Float32Array;
}

/** Pulizia del rumore di un segmento (16 kHz mono, stessa lunghezza). */
export interface DenoiseEngine {
  readonly name: string;
  run(samples: Float32Array): Float32Array;
}

/** Impronta del proprietario salvata in locale (mai inviata, mai nei log). */
export interface OwnerProfile {
  readonly version: 1;
  /** Modello che ha prodotto l'impronta: con un modello diverso l'impronta non vale. */
  readonly model: string;
  readonly centroid: readonly number[];
  readonly samples: number;
  readonly createdAt: number;
  /** Somiglianza minima di ogni frase con le altre (qualità della registrazione). */
  readonly selfMin: number;
}

export const OWNER_LIMITS = {
  /** Sotto questa durata l'impronta è poco affidabile: il segmento non si giudica. */
  minVerifyMs: 1_000,
  /** Durata minima di una frase della registrazione. */
  enrollMinMs: 1_500,
  /** Frasi necessarie per salvare l'impronta. */
  enrollSamples: 3,
  /** Sotto questa qualità la registrazione va rifatta (frasi poco coerenti tra loro). */
  enrollMinQuality: 0.45
} as const;

export function rms(x: Float32Array): number {
  if (x.length === 0) return 0;
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

/** Campioni di una finestra di misura (128 ms a 16 kHz): la stessa della misura del rumore nella procedura guidata. */
export const LEVEL_WINDOW = 2_048;

/**
 * Livello del parlato: 90° percentile dell'RMS su finestre di 128 ms. La media dell'intera frase
 * (`rms`) conta anche le pause e, con un microfono rumoroso, scambiava una voce normale per
 * silenzio; il percentile guarda i tratti in cui si parla ed è confrontabile con la soglia
 * misurata nella stanza (stesse finestre, stesso percentile).
 */
export function speechLevel(x: Float32Array, window = LEVEL_WINDOW): number {
  if (x.length <= window) return rms(x);
  const levels: number[] = [];
  for (let i = 0; i + window <= x.length; i += window) levels.push(rms(x.subarray(i, i + window)));
  levels.sort((a, b) => a - b);
  return levels[Math.floor(levels.length * 0.9)] ?? 0;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    d += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : d / Math.sqrt(na * nb);
}

/** Media delle impronte normalizzate (ognuna pesa uguale, qualunque sia la sua norma). */
export function centroid(vectors: readonly ArrayLike<number>[]): Float32Array {
  const dim = vectors[0]?.length ?? 0;
  const out = new Float32Array(dim);
  for (const v of vectors) {
    let n = 0;
    for (let i = 0; i < dim; i++) n += v[i]! * v[i]!;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < dim; i++) out[i]! += v[i]! / n / vectors.length;
  }
  return out;
}

export type OwnerOutcome = 'owner' | 'stranger';
export interface OwnerDecision {
  readonly outcome: OwnerOutcome;
  /** Somiglianza con l'impronta del proprietario. */
  readonly score: number;
  /** Vantaggio sulla voce di riferimento più simile (null senza voci di riferimento). */
  readonly margin: number | null;
}

/** Proprietario se abbastanza simile E più simile a lui che a ogni voce di riferimento. */
export function judgeOwner(embedding: ArrayLike<number>, owner: ArrayLike<number>, cohort: readonly ArrayLike<number>[], minScore: number, minMargin: number): OwnerDecision {
  const score = cosine(embedding, owner);
  const best = cohort.length > 0 ? Math.max(...cohort.map((c) => cosine(embedding, c))) : null;
  const margin = best === null ? null : score - best;
  const ok = score >= minScore && (margin === null || margin >= minMargin);
  return { outcome: ok ? 'owner' : 'stranger', score, margin };
}

/** Qualità della registrazione: somiglianza di ogni frase con la media delle altre (min e media). */
export function enrollQuality(vectors: readonly ArrayLike<number>[]): { min: number; mean: number } {
  if (vectors.length < 2) return { min: 0, mean: 0 };
  const scores = vectors.map((v, i) => cosine(v, centroid(vectors.filter((_, j) => j !== i))));
  return { min: Math.min(...scores), mean: scores.reduce((a, b) => a + b, 0) / scores.length };
}

export function makeProfile(model: string, vectors: readonly ArrayLike<number>[], now: number): OwnerProfile {
  const c = centroid(vectors);
  return { version: 1, model, centroid: Array.from(c, (x) => Math.round(x * 1e6) / 1e6), samples: vectors.length, createdAt: now, selfMin: Math.round(enrollQuality(vectors).min * 1000) / 1000 };
}

/** Profilo dal file, solo se integro e prodotto dallo stesso modello; altrimenti null. */
export function parseProfile(raw: unknown, model: string): OwnerProfile | null {
  if (raw === null || typeof raw !== 'object') return null;
  const p = raw as Partial<OwnerProfile>;
  if (p.version !== 1 || p.model !== model || !Array.isArray(p.centroid) || p.centroid.length < 16 || p.centroid.length > 4_096) return null;
  if (!p.centroid.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  if (typeof p.samples !== 'number' || typeof p.createdAt !== 'number' || typeof p.selfMin !== 'number') return null;
  return { version: 1, model, centroid: p.centroid, samples: p.samples, createdAt: p.createdAt, selfMin: p.selfMin };
}

/** Ricampionamento lineare verso 16 kHz (voci di riferimento e voce di VISIONE per la coorte). */
export function to16k(x: Float32Array, from: number): Float32Array {
  if (from === 16_000) return x;
  const n = Math.floor((x.length * 16_000) / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i * from) / 16_000;
    const a = Math.floor(t);
    const f = t - a;
    out[i] = (x[a] ?? 0) * (1 - f) + (x[a + 1] ?? 0) * f;
  }
  return out;
}
