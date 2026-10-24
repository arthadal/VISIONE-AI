// Widget Umanoide (11/10/2026, richiesta del proprietario con foto e un reel di riferimento): busto di
// particelle come nelle foto — testa con volto (arcate, occhi, naso, labbra, orecchie) a linee
// orizzontali fitte e volto acceso d'arancio, collo con i tendini arancioni a V fino al punto luminoso
// sullo sterno, busto ad archi concentrici attorno allo sterno, onde attorno alla testa. All'avvio le
// particelle arrivano in volo e formano la figura dal basso all'alto, come un caricamento. Parla quando
// VISIONE parla e gira la testa verso il proprietario (webcam) o verso il puntatore. Qui solo calcolo
// puro e testato.

/** Parti della figura: decidono colore, rotazione (la testa gira tutta, il busto un quarto) e moto. */
export const PART = { head: 0, body: 1, core: 2, spine: 3, drift: 4, face: 5 } as const;
export type Part = (typeof PART)[keyof typeof PART];

export interface Figure {
  /** Posizioni a riposo (x a destra, y in alto, z verso chi guarda), 3 valori per particella. */
  pos: Float32Array;
  /** Normale approssimata della superficie (3 valori): il bordo della sagoma brilla come nelle foto. */
  nrm: Float32Array;
  /** Da dove arriva in volo la particella quando la figura si forma (3 valori). */
  from: Float32Array;
  part: Uint8Array;
  /** Valore casuale stabile per particella (sfarfallio, fase, vita delle particelle che si staccano). */
  seed: Float32Array;
  count: number;
}

/** Generatore pseudo-casuale con seme (mulberry32): figura uguale a ogni avvio e nei test. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Centro della testa, perno del collo, bocca e sterno (unità della figura: la testa è alta circa 1,4). */
export const HEAD_CENTER_Y = 0.6;
export const NECK_PIVOT_Y = -0.15;
export const MOUTH_Y = 0.22;
/** Centro del nucleo arancione: al centro del volto, all'altezza del naso (seconda foto). */
export const CORE_Y = 0.46;
export const STERNUM: readonly [number, number, number] = [0, -0.92, 0.3];
/** Estremi verticali della figura (per la formazione dal basso all'alto). */
export const FIGURE_TOP = 1.27;
export const FIGURE_BOTTOM = -1.62;

// Profilo della testa: altezza, mezza larghezza, centro e raggio in profondità. La calotta sporge
// dietro, tempie e zigomi, mascella e mento che avanzano e si stringono: una testa, non un uovo.
const HEAD_PROFILE: ReadonlyArray<readonly [number, number, number, number]> = [
  [1.27, 0, -0.05, 0], [1.24, 0.22, -0.05, 0.27], [1.16, 0.37, -0.06, 0.44], [1.03, 0.455, -0.06, 0.55],
  [0.87, 0.49, -0.05, 0.6], [0.72, 0.48, -0.02, 0.61], [0.58, 0.475, 0.01, 0.59], [0.46, 0.46, 0.04, 0.56],
  [0.32, 0.42, 0.08, 0.5], [0.18, 0.36, 0.13, 0.42], [0.07, 0.28, 0.18, 0.32], [-0.03, 0.17, 0.22, 0.2],
  [-0.09, 0, 0.24, 0]
];
export const HEAD_TOP = 1.27;
export const HEAD_BOTTOM = -0.09;

/** Sezione della testa all'altezza y: mezza larghezza, centro e raggio in profondità; null fuori. */
export function headSection(y: number): { rx: number; zc: number; rz: number } | null {
  if (!(y < HEAD_TOP && y > HEAD_BOTTOM)) return null;
  for (let i = 0; i < HEAD_PROFILE.length - 1; i++) {
    const a = HEAD_PROFILE[i]!;
    const b = HEAD_PROFILE[i + 1]!;
    if (y <= a[0] && y >= b[0]) {
      // Interpolazione a coseno: il contorno resta morbido fra un punto del profilo e l'altro.
      const t = (1 - Math.cos(((a[0] - y) / (a[0] - b[0])) * Math.PI)) / 2;
      return { rx: a[1] + (b[1] - a[1]) * t, zc: a[2] + (b[2] - a[2]) * t, rz: a[3] + (b[3] - a[3]) * t };
    }
  }
  return null;
}

/** Rilievo del volto (arcate, orbite, zigomi, naso, labbra, mento) sulla parte anteriore. */
export function faceRelief(x: number, y: number): number {
  const ax = Math.abs(x);
  const g = (v: number, c: number, w: number): number => Math.exp(-(((v - c) / w) ** 2));
  const brow = 0.045 * g(ax, 0.16, 0.12) * g(y, 0.79, 0.045);
  const eyes = -0.075 * g(ax, 0.165, 0.075) * g(y, 0.68, 0.05);
  const cheeks = 0.03 * g(ax, 0.26, 0.08) * g(y, 0.5, 0.08);
  const bridge = 0.05 * g(x, 0, 0.05) * g(y, 0.66, 0.08);
  const nose = 0.13 * g(x, 0, 0.06) * g(y, 0.45, 0.1) + 0.04 * g(ax, 0.06, 0.04) * g(y, 0.4, 0.04);
  const lips = 0.04 * g(x, 0, 0.11) * (g(y, MOUTH_Y + 0.03, 0.03) + g(y, MOUTH_Y - 0.035, 0.03)) - 0.02 * g(x, 0, 0.1) * g(y, MOUTH_Y, 0.012);
  const chin = 0.035 * g(x, 0, 0.1) * g(y, 0.03, 0.05);
  return brow + eyes + cheeks + bridge + nose + lips + chin;
}

/** Linea delle spalle (y) alla posizione u (-1…1): scende dal collo (trapezio) e si arrotonda sulla spalla. */
export function shoulderTop(u: number): number {
  const a = Math.min(1, Math.abs(u));
  return -0.2 - 0.46 * Math.pow(smooth(0.13, 0.74, a), 0.8) - 0.06 * a - 0.3 * smooth(0.82, 1, a);
}
/** Il collo esce dal busto fino alla fossetta sopra lo sterno: lì il busto non ha archi. */
const NECK_HALF = 0.2;
const NECK_BASE_Y = -0.46;
export const BODY_HALF_WIDTH = 1.3;

/** Superficie davanti del busto: profondità (z) e normale nel punto (x, y). */
function bodyFront(x: number, y: number): { z: number; n: [number, number, number] } {
  const u = Math.min(1, Math.abs(x) / BODY_HALF_WIDTH);
  const v = Math.min(1, Math.max(0, (shoulderTop(u) - y) / 1.1));
  const bulge = Math.pow(Math.max(0, 1 - u * u), 0.6);
  // Petto: due rilievi morbidi ai lati dello sterno, clavicole appena sotto le spalle.
  const pecs = 0.05 * Math.exp(-(((Math.abs(x) - 0.42) / 0.3) ** 2)) * Math.exp(-(((y + 1.12) / 0.22) ** 2));
  const clav = 0.03 * Math.exp(-(((y - (shoulderTop(u) - 0.16)) / 0.06) ** 2)) * (1 - u);
  const z = -0.1 + 0.4 * bulge * (1 + 0.12 * v) + pecs + clav;
  const nx = Math.sign(x) * u * 0.9;
  const nz = Math.sqrt(Math.max(0.05, 1 - nx * nx));
  return { z, n: [nx, 0.1, nz] };
}

/** Il busto contiene il punto (x, y)? Sotto la linea delle spalle, fuori dal collo, sopra il taglio. */
export function insideBody(x: number, y: number): boolean {
  const u = Math.abs(x) / BODY_HALF_WIDTH;
  if (u > 1 || y < FIGURE_BOTTOM) return false;
  if (Math.abs(x) < NECK_HALF && y > NECK_BASE_Y) return false;
  return y <= shoulderTop(u);
}

/**
 * Figura di `count` particelle (circa): testa e volto su linee orizzontali fitte, orecchie, collo,
 * tendini e nervi arancioni, busto ad archi attorno allo sterno, nucleo e particelle che si staccano.
 */
export function buildFigure(count = 5_600, seed = 7): Figure {
  const r = rng(seed);
  const pos: number[] = [];
  const nrm: number[] = [];
  const from: number[] = [];
  const part: number[] = [];
  const seeds: number[] = [];
  const add = (x: number, y: number, z: number, p: Part, n: readonly [number, number, number] = [0, 0, 1]): void => {
    pos.push(x, y, z);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    nrm.push(n[0] / l, n[1] / l, n[2] / l);
    part.push(p);
    seeds.push(r());
    // Arrivo in volo: da sotto e dai lati, larghi, come uno sciame che sale.
    const side = r() < 0.5 ? -1 : 1;
    from.push(side * (1.2 + r() * 2.6), FIGURE_BOTTOM - 0.4 - r() * 1.6, (r() - 0.5) * 3);
  };
  // Testa: linee orizzontali fitte; il volto attorno al centro si accende d'arancio (seconda foto).
  const levels: Array<{ y: number; s: { rx: number; zc: number; rz: number }; len: number }> = [];
  for (let y = HEAD_TOP - 0.012; y > HEAD_BOTTOM; y -= 0.027) {
    const s = headSection(y);
    if (s && s.rx > 0.02) levels.push({ y, s, len: Math.PI * (s.rx + s.rz) });
  }
  const headN = Math.round(count * 0.46);
  const headLen = levels.reduce((a, l) => a + l.len, 0);
  for (const { y, s, len } of levels) {
    const k = Math.max(4, Math.round((headN * len) / headLen));
    for (let i = 0; i < k; i++) {
      const th = ((i + r() * 0.4) / k) * Math.PI * 2;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      const x = cos * s.rx;
      let z = s.zc + sin * s.rz;
      const relief = sin > 0 ? faceRelief(x, y) * Math.pow(sin, 3) : 0;
      z += relief;
      const d = Math.hypot(x / 0.3, (y - 0.52) / 0.36);
      const face = sin > 0.3 && r() < 0.97 * Math.exp(-d * d * 0.8);
      add(x + (r() - 0.5) * 0.006, y + (r() - 0.5) * 0.005, z + (r() - 0.5) * 0.006, face ? PART.face : PART.head, [cos * s.rz, 0, sin * s.rx]);
    }
  }
  // Orecchie: una «C» di particelle per lato, tra occhi e bocca.
  for (const side of [-1, 1]) {
    for (let i = 0; i < Math.round(count * 0.012); i++) {
      const t = r();
      const a = -Math.PI / 2 + t * Math.PI * 1.25;
      const s = headSection(0.56) ?? { rx: 0.46, zc: 0, rz: 0.58 };
      add(side * (s.rx + 0.03 + Math.cos(a) * 0.035), 0.56 + Math.sin(a) * 0.13, -0.06 + Math.cos(a) * 0.05, PART.head, [side, 0, 0.2]);
    }
  }
  // Collo: anelli dietro il mento, un po' più largo alla base.
  const neckN = Math.round(count * 0.05);
  const neckLevels = 15;
  for (let j = 0; j < neckLevels; j++) {
    const y = 0.04 - (j / (neckLevels - 1)) * 0.48;
    const k = Math.round(neckN / neckLevels);
    for (let i = 0; i < k; i++) {
      const th = ((i + r() * 0.5) / k) * Math.PI * 2;
      const rx = 0.18 + 0.05 * smooth(-0.15, -0.44, y);
      add(Math.cos(th) * rx, y + (r() - 0.5) * 0.006, -0.06 + Math.sin(th) * 0.18, PART.body, [Math.cos(th), 0, Math.sin(th)]);
    }
  }
  // Busto: archi concentrici attorno allo sterno, tagliati dalla sagoma delle spalle (seconda foto).
  const bodyN = Math.round(count * 0.25);
  const arcs: Array<{ R: number; pts: Array<[number, number]> }> = [];
  let arcLen = 0;
  for (let R = 0.14; R < 2.0; R += 0.058) {
    const pts: Array<[number, number]> = [];
    for (let a = 0; a < 360; a += 1) {
      const ph = (a * Math.PI) / 180;
      const x = STERNUM[0] + Math.cos(ph) * R * 1.12;
      const y = STERNUM[1] + Math.sin(ph) * R * 0.86;
      if (insideBody(x, y)) pts.push([x, y]);
    }
    if (pts.length > 0) {
      arcs.push({ R, pts });
      arcLen += pts.length * R;
    }
  }
  for (const { R, pts } of arcs) {
    const k = Math.max(2, Math.round((bodyN * pts.length * R) / arcLen));
    for (let i = 0; i < k; i++) {
      const [x, y] = pts[Math.floor(r() * pts.length)]!;
      const f = bodyFront(x, y);
      add(x + (r() - 0.5) * 0.008, y + (r() - 0.5) * 0.008, f.z, PART.body, f.n);
    }
  }
  // Contorno delle spalle: la linea luminosa che chiude la sagoma.
  for (let i = 0; i < Math.round(count * 0.04); i++) {
    const u = -1 + 2 * r();
    const x = u * BODY_HALF_WIDTH;
    const y = shoulderTop(u) - r() * 0.01;
    if (Math.abs(x) < 0.24) continue;
    const f = bodyFront(x, y);
    add(x, y, f.z - 0.05, PART.body, [Math.sign(x) * 0.6, 0.8, 0.2]);
  }
  // Nucleo: nube arancione al centro della testa, più densa nel mezzo.
  for (let i = 0; i < Math.round(count * 0.04); i++) {
    const g = (): number => (r() + r() + r() - 1.5) / 1.5;
    add(g() * 0.15, CORE_Y + g() * 0.16, 0.12 + g() * 0.16, PART.core);
  }
  // Tendini del collo: una V arancione da dietro le orecchie allo sterno; poi nervi che si diramano.
  for (let i = 0; i < Math.round(count * 0.03); i++) {
    const side = r() < 0.5 ? -1 : 1;
    const t = r();
    add(side * (0.17 - 0.16 * t) + (r() - 0.5) * 0.015, 0.3 - t * 1.08, 0.0 + t * 0.29, PART.spine);
  }
  for (let b = 0; b < 7; b++) {
    let x = 0;
    let y = STERNUM[1] + 0.1;
    let dir = -Math.PI / 2 + (b - 3) * 0.32;
    for (let i = 0; i < 26; i++) {
      dir += (r() - 0.5) * 0.5;
      x += Math.cos(dir) * 0.022;
      y += Math.sin(dir) * 0.022;
      if (!insideBody(x, y)) break;
      add(x, y, bodyFront(x, y).z + 0.01, PART.spine);
    }
  }
  // Fiore luminoso sullo sterno.
  for (let i = 0; i < Math.round(count * 0.012); i++) {
    const a = r() * Math.PI * 2;
    const d = Math.pow(r(), 1.6) * 0.09;
    add(STERNUM[0] + Math.cos(a) * d, STERNUM[1] + Math.sin(a) * d, STERNUM[2] + 0.02, PART.spine);
  }
  // Particelle che si staccano dalla nuca e dal lato destro della testa (prima foto).
  for (let i = 0; i < Math.round(count * 0.06); i++) {
    const y = HEAD_CENTER_Y + (r() - 0.35) * 1.1;
    const s = headSection(y) ?? { rx: 0.3, zc: 0, rz: 0.3 };
    const th = -1.2 + r() * 1.5;
    add(Math.cos(th) * s.rx, y, s.zc - Math.abs(Math.sin(th)) * s.rz, PART.drift);
  }
  return {
    pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), from: Float32Array.from(from),
    part: Uint8Array.from(part), seed: Float32Array.from(seeds), count: part.length
  };
}

// --- Formazione all'avvio («come un caricamento») ------------------------------------------------

/** Durata della salita del fronte di formazione e del volo di ogni particella (s). */
export const ASSEMBLY_RISE_S = 2.4;
export const ASSEMBLY_FLIGHT_S = 0.9;
/** Fine della formazione: l'ultima particella in alto è arrivata. */
export const ASSEMBLY_TOTAL_S = 0.2 + ASSEMBLY_RISE_S + 0.3 + ASSEMBLY_FLIGHT_S;

/** Quando parte in volo la particella all'altezza y (dal basso all'alto, con un po' di sparpaglio). */
export function assemblyDelay(y: number, seed: number): number {
  const h = Math.min(1, Math.max(0, (y - FIGURE_BOTTOM) / (FIGURE_TOP - FIGURE_BOTTOM)));
  return 0.2 + h * ASSEMBLY_RISE_S + seed * 0.3;
}

/** Avanzamento del volo (0 = ancora lontana, 1 = al suo posto), con arrivo morbido. */
export function assemblyProgress(t: number, delay: number): number {
  const k = Math.min(1, Math.max(0, (t - delay) / ASSEMBLY_FLIGHT_S));
  return 1 - Math.pow(1 - k, 3);
}

/** Percentuale del caricamento mostrata accanto alla linea che sale. */
export function assemblyPercent(t: number): number {
  return Math.round(Math.min(1, Math.max(0, (t - 0.2 - ASSEMBLY_FLIGHT_S * 0.7) / ASSEMBLY_RISE_S)) * 100);
}

// --- Parlato: onde dalla bocca sulla metà bassa della testa ------------------------------------

/** Sopra questa altezza la testa non pulsa: le onde stanno dal naso in giù. */
export const WAVE_TOP_Y = 0.46;

/**
 * Onda del parlato nel punto (x, y) della testa al tempo t: anelli che partono dalla bocca e corrono
 * sulla metà bassa del volto. `push` sposta il punto lungo la normale (unità della figura), `glow`
 * ne aumenta la luce. Zero se VISIONE tace (env = 0) o sopra il naso.
 */
export function mouthWave(x: number, y: number, t: number, env: number): { push: number; glow: number } {
  if (env <= 0 || y > WAVE_TOP_Y) return { push: 0, glow: 0 };
  const d = Math.hypot(x, (y - MOUTH_Y) * 1.25);
  const fade = Math.exp(-d * 2.2) * smooth(WAVE_TOP_Y, WAVE_TOP_Y - 0.12, y);
  const wave = Math.sin(d * 30 - t * 13);
  return { push: env * 0.03 * wave * fade, glow: env * Math.max(0, wave) * fade };
}

// --- Rotazione, proiezione, parlato, sguardo -----------------------------------------------------

/** Rotazione intorno al perno del collo: yaw (destra/sinistra, positivo = naso verso destra) e pitch (positivo = naso in alto). */
export function rotate(x: number, y: number, z: number, yaw: number, pitch: number, pivotY: number): [number, number, number] {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const yy = y - pivotY;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [x1, yy * cp + z1 * sp + pivotY, -yy * sp + z1 * cp];
}

/** Distanza della camera: prospettiva leggera. */
export const CAMERA_D = 6;
/** Proiezione sullo schermo: centro (cx, cy) e scala in pixel per unità. */
export function project(x: number, y: number, z: number, cx: number, cy: number, scale: number): [number, number, number] {
  const k = CAMERA_D / (CAMERA_D - z);
  return [cx + x * scale * k, cy - y * scale * k, k];
}

/**
 * Inviluppo del parlato (0…1) al tempo `t` (s): la voce di Windows non dà il livello d'uscita, quindi
 * sillabe sintetiche, ~4,7 al secondo con pause irregolari. 0 quando VISIONE non parla.
 */
export function speechEnvelope(t: number, speaking: boolean): number {
  if (!speaking) return 0;
  const syll = Math.max(0, Math.sin(t * Math.PI * 2 * 4.7));
  const phrase = 0.55 + 0.45 * Math.sin(t * Math.PI * 2 * 0.9 + 1.3) * Math.sin(t * Math.PI * 2 * 0.37);
  return Math.min(1, Math.max(0, syll * phrase * 1.25));
}

/** Limiti dello sguardo (radianti). */
export const MAX_YAW = 0.6;
export const MAX_PITCH = 0.3;

/**
 * Bersaglio dello sguardo da un punto dell'immagine della webcam (0…1, immagine NON specchiata):
 * chi sta a sinistra nell'immagine è alla destra dello schermo, quindi il naso va a destra.
 */
export function gazeFromCamera(cx: number, cy: number): { yaw: number; pitch: number } {
  const clamp = (v: number, m: number): number => Math.min(m, Math.max(-m, v));
  return { yaw: clamp((0.5 - cx) * 2 * MAX_YAW, MAX_YAW), pitch: clamp((0.45 - cy) * 2 * MAX_PITCH, MAX_PITCH) };
}

/** Bersaglio dello sguardo dal puntatore (0…1 della finestra): la testa guarda verso il puntatore. */
export function gazeFromPointer(nx: number, ny: number): { yaw: number; pitch: number } {
  const clamp = (v: number, m: number): number => Math.min(m, Math.max(-m, v));
  return { yaw: clamp((nx - 0.5) * 2 * MAX_YAW * 0.8, MAX_YAW), pitch: clamp((0.5 - ny) * 2 * MAX_PITCH * 0.8, MAX_PITCH) };
}

/** Avvicinamento morbido dello sguardo (esponenziale, indipendente dai fotogrammi). */
export function follow(current: number, target: number, dtS: number, rate = 3.2): number {
  if (!Number.isFinite(target)) return current;
  const k = 1 - Math.exp(-Math.max(0, dtS) * rate);
  return current + (target - current) * k;
}

// --- Webcam: dove si muove chi sta davanti -------------------------------------------------------

/** Larghezza e altezza delle immagini ridotte su cui si cerca il movimento. */
export const MOTION_W = 96;
export const MOTION_H = 72;

/**
 * Dove sta la testa di chi si muove, in un fotogramma in scala di grigi (`gray`, MOTION_W×MOTION_H)
 * rispetto allo sfondo che si aggiorna piano (`bg`, modificato qui). Chi si sposta muove tutto il
 * busto: la testa è la parte ALTA della zona in movimento, quindi il centro si prende sul terzo
 * superiore di quella zona. `mass` = frazione di pixel che si muovono (poco movimento = non affidabile).
 */
export function motionCentroid(gray: ArrayLike<number>, bg: Float32Array, threshold = 22): { cx: number; cy: number; mass: number } {
  const w = MOTION_W;
  const len = Math.min(gray.length, bg.length);
  const h = Math.floor(len / w);
  const moving = new Uint8Array(len);
  const rows = new Uint16Array(h);
  let n = 0;
  for (let i = 0; i < len; i++) {
    const v = gray[i] as number;
    if (Math.abs(v - (bg[i] as number)) > threshold) {
      moving[i] = 1;
      rows[Math.floor(i / w)]!++;
      n++;
    }
    bg[i] = (bg[i] as number) * 0.9 + v * 0.1;
  }
  if (n === 0) return { cx: 0.5, cy: 0.5, mass: 0 };
  // Righe con abbastanza movimento (niente rumore isolato): la più alta e la più bassa.
  const minRow = Math.max(2, Math.round(w * 0.02));
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    if (rows[y]! >= minRow) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) {
    top = 0;
    bottom = h - 1;
  }
  const limit = top + Math.max(2, Math.round((bottom - top + 1) * 0.34));
  let sx = 0;
  let sy = 0;
  let k = 0;
  for (let y = top; y <= Math.min(limit, h - 1); y++) {
    for (let x = 0; x < w; x++) {
      if (moving[y * w + x]) {
        sx += x;
        sy += y;
        k++;
      }
    }
  }
  if (k === 0) return { cx: 0.5, cy: 0.5, mass: 0 };
  return { cx: (sx / k + 0.5) / w, cy: (sy / k + 0.5) / h, mass: n / len };
}

/** Frazione minima di pixel in movimento per spostare lo sguardo. */
export const MIN_MOTION_MASS = 0.01;
/** Dopo quanto senza movimento lo sguardo torna piano al centro (ms). */
export const GAZE_HOLD_MS = 8_000;

/** Stato mostrato sotto l'Umanoide (16/10/2026, richiesta del proprietario: in ascolto, sta lavorando o fermo). */
export type HumanoidStatus = 'speaking' | 'listening' | 'working' | 'idle' | 'off';

/**
 * Cosa sta facendo VISIONE, dal più urgente: parla; ti ascolta (tasto premuto o dopo la parola d'avvio);
 * un agente lavora; ferma, con la voce pronta o spenta. Lavorare viene prima di «voce spenta»: gli agenti
 * lavorano anche senza voce.
 */
export function humanoidStatus(voice: { status: string; listening: boolean; speaking: string | null; wake: { armed: boolean } } | null, busy: boolean): HumanoidStatus {
  if (voice?.speaking != null) return 'speaking';
  if (voice?.listening === true || voice?.wake.armed === true) return 'listening';
  if (busy) return 'working';
  return voice?.status === 'ready' ? 'idle' : 'off';
}
