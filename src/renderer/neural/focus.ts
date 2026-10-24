// Zoom sull'agente (11/10/2026, richiesta del proprietario): un clic su un agente porta la camera
// davanti a lui e lo ingrandisce in primo piano con lo stesso aspetto della Sfera centrale; alla
// chiusura la camera torna dove era. Qui solo la geometria pura (testabile senza WebGL); il disegno
// sta in `renderer3d.ts`.

/** Scala della sfera dell'agente rispetto alla Sfera centrale (raggio 1,32 → 0,53). */
export const FOCUS_SCALE = 0.4;
/** Distanza della camera dall'agente: più vicina dell'inquadratura della Sfera centrale a riposo
 *  (6,2 × scala = 2,48), così l'agente appare più grande del centro: è lui in primo piano. */
export const FOCUS_DIST = 1.9;
/** Raggio della Sfera centrale (il guscio esterno): la camera non ci passa dentro. */
export const CORE_RADIUS = 1.32;

export interface Orbit {
  az: number;
  el: number;
  dist: number;
}

/**
 * Inquadratura di un agente in `pos`: la camera sta fuori, sulla retta che va dal centro all'agente
 * piegata verso chi guarda (+z) e appena dall'alto, così la Sfera centrale resta dietro e di lato.
 * Se da quel lato la Sfera si mette in mezzo (agente dietro la Sfera), la piega si riduce fino alla
 * retta dal centro all'agente, che per costruzione non la attraversa mai.
 */
export function focusOrbit(pos: readonly [number, number, number]): Orbit {
  const len = Math.hypot(pos[0], pos[1], pos[2]);
  const out = len > 1e-3 ? [pos[0] / len, pos[1] / len, pos[2] / len] : [0, 0, 0];
  let orbit: Orbit = { az: 0, el: 0, dist: FOCUS_DIST };
  for (const bend of [1, 0.75, 0.5, 0.25, 0]) {
    const x = out[0]! * 0.6;
    const y = out[1]! * 0.6 + 0.12 * bend;
    const z = out[2]! * 0.6 + bend;
    const n = Math.hypot(x, y, z);
    if (n < 1e-6) continue;
    orbit = { az: Math.atan2(x / n, z / n), el: Math.asin(Math.max(-1, Math.min(1, y / n))), dist: FOCUS_DIST };
    if (len <= 1e-3 || !crossesCore(orbitPosition(pos, orbit), pos)) return orbit;
  }
  return orbit;
}

/** Posizione della camera per un'orbita attorno a `target` (stessa formula di `placeCamera`). */
export function orbitPosition(target: readonly [number, number, number], o: Orbit): [number, number, number] {
  const ce = Math.cos(o.el);
  return [target[0] + Math.sin(o.az) * ce * o.dist, target[1] + Math.sin(o.el) * o.dist, target[2] + Math.cos(o.az) * ce * o.dist];
}

/** Avvicina un angolo al bersaglio per la via più corta (niente giri completi della camera). */
export function approachAngle(current: number, target: number, k: number): number {
  let d = (target - current) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return current + d * k;
}

/** Il segmento camera→agente passa dentro la Sfera centrale? (controllo dei test sul layout reale) */
export function crossesCore(from: readonly [number, number, number], to: readonly [number, number, number], radius = CORE_RADIUS): boolean {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const dd = d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!;
  const t = dd === 0 ? 0 : Math.max(0, Math.min(1, -(from[0] * d[0]! + from[1] * d[1]! + from[2] * d[2]!) / dd));
  return Math.hypot(from[0] + d[0]! * t, from[1] + d[1]! * t, from[2] + d[2]! * t) < radius;
}
