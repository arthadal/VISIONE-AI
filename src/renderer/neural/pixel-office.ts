// Scena «ufficio pixel» di VISIONE (P-89): porting del campo neurale dell'overlay dell'ufficio di
// Munder (`C:\Users\matte\jarvis\munder-patch\rete-neural\rete-neurale.js`, sola lettura; VISIONE
// non incorpora quel file, ne riscrive il campo in three puro). Riferimento visivo: la cattura
// DPI-aware dell'overlay del 05/10/2026 (`p88/munder-core.png`).
//
// Composizione IDENTICA al riferimento (a qualità 2, senza riduzioni):
//   - 9.000 particelle di fondo su 7 strati orizzontali con onda e scorrimento;
//   - SFERA 3.200 punti su una spirale di Fibonacci (guscio, centro non riempito), rotazione
//     `t·0,00022` e inclinazione 0,38;
//   - 4 ANELLI da 900 punti (raggio 1,35 + a·0,28 · R, inclinazioni e velocità proprie);
//   - fascio orizzontale di 520 punti e il «cuore» luminoso al centro;
//   - colore e shader additivi del riferimento (alone `pow(1−r, 2,2)`, nucleo `pow(1−2,6r, 3)`),
//     fondo `#03060f`; niente bloom e niente pass post: il bagliore è quello della somma additiva.
//
// Adattamenti dichiarati (regole della casa e dati reali di VISIONE):
//   - i tempi avanzano SEMPRE mentre la scena è visibile (P-90: movimento ambientale continuo, anche a
//     riposo) e `reducedMotion` li ferma del tutto; quando la vista è nascosta il ciclo si ferma.
//     P-92: il movimento continuo non cambia la resa a riposo (valori P-89 intatti) e la qualità
//     adattiva usa isteresi + assestamento per non oscillare sotto la ricostruzione della scena;
//   - `vita` è il livello REALE (voce + stato del Director) e la somma delle energie reali dei nodi,
//     non il movimento dei personaggi dell'ufficio; `voce` è l'inviluppo del livello audio REALE
//     (microfono/TTS) e accende respiro e onde più marcati solo con stati reali `speaking`/`listening`;
//   - i nodi agenti reali sono sovrapposti (il globo del riferimento non ha i nostri dati): stessa
//     resa del riferimento (punto morbido con alone, colore bianco-blu `(0,55+0,45e, 0,92, 1,0)`,
//     respiro). P-97 (richiesta del proprietario): il **Director sta al centro come nucleo grande**
//     (il globo più grande, sopra la sfera), gli **agenti sono globi visibilmente più grandi dei
//     nodi generici** e disposti in modo **ordinato** su anelli regolari attorno al centro; i nodi
//     generici restano piccoli sull'ellisse deterministica di P-89 (hash dell'id). Le energie
//     vengono dagli stati REALI (lavoro/errore = 1, fermo = 0,3); la dimensione scala col lato
//     minore della scena, così l'ordine visivo regge a ogni finestra. P-98 (richiesta del
//     proprietario): gli **agenti sono ancora più grandi** (circa il doppio di P-97, sempre sotto il
//     Director) e la scena ha una **nuova fascia di microparticelle dinamiche** (`PIXEL_MICRO`:
//     deriva, orbita e brillio propri di ogni punto) oltre al campo del riferimento;
//   - le linee dei nodi (nodo→centro e coppie entro 340 px) usano il numero del riferimento
//     (max 24 nodi), come il suo `MAX_NODI`;
//   - gli impulsi degli eventi reali durano 1.400 ms e sono il punto caldo del riferimento: nessun
//     impulso decorativo, nascono solo dagli eventi di dominio veri (P-90).

import * as THREE from 'three';
import { safeCount, safeUnit } from '../lib/safe.ts';
import type { EdgeView, NodeView, PulseView } from './engine.ts';
import { systemState, type GraphNode, type SystemSignals } from './graph.ts';
import { leggeroSalta, QUALITA_ASSESTAMENTO, QUALITA_FINESTRA, qualitaPasso } from './qualita.ts';
import { voiceActivation } from './voce.ts';
import type { Label, RendererOpts, SceneRenderer, SceneStats } from './renderer3d.ts';

// ---------------------------------------------------------------------------------------------
// 1. I numeri del riferimento (identici a qualità piena)
// ---------------------------------------------------------------------------------------------

/** Particelle del campo di fondo (riferimento: `PARTICELLE`). */
export const PIXEL_PARTICELLE = 9_000;
/** Strati orizzontali del campo (riferimento: `STRATI`). */
export const PIXEL_STRATI = 7;
/** Punti della sfera (riferimento: `SFERA`). */
export const PIXEL_SFERA = 3_200;
/** Anelli attorno al nucleo (riferimento: `ANELLI`). */
export const PIXEL_ANELLI = 4;
/** Punti per anello (riferimento: `PER_ANELLO`). */
export const PIXEL_PER_ANELLO = 900;
/** Punti del fascio orizzontale (riferimento: `FASCIO`). */
export const PIXEL_FASCIO = 520;
/** Microparticelle dinamiche (P-98): moti propri, brillio e deriva, in aggiunta al campo. */
export const PIXEL_MICRO = 6_000;
/** Tetto dei nodi del grafo disegnati (riferimento: `MAX_NODI`). */
export const PIXEL_MAX_NODI = 24;
/** Durata di un impulso in ms (riferimento: `DURATA_IMPULSO`). */
export const PIXEL_PULSE_MS = 1_400;
/** Portata delle linee fra nodi in pixel CSS (riferimento: 340 × dpr). */
export const PIXEL_PORTATA = 340;
/** Tocco minimo per l'hover (stessa soglia di P-88). */
export const PIXEL_TOCCO_MIN = 16;

/** Scala dei conteggi per qualità (0/1/2): a 2 i numeri del riferimento sono esatti. */
const SCALA: readonly [number, number, number] = [0.3, 0.55, 1];

export interface PixelCounts {
  particelle: number;
  sfera: number;
  anelli: number;
  perAnello: number;
  fascio: number;
  strati: number;
  /** Microparticelle dinamiche (P-98). */
  micro: number;
}

/** Conteggi della scena a una certa qualità, con le guardie di allocazione (P-74). Pura: testata. */
export function pixelCounts(quality: 0 | 1 | 2): PixelCounts {
  const p = SCALA[quality] ?? SCALA[0];
  return {
    particelle: safeCount(PIXEL_PARTICELLE * p, PIXEL_PARTICELLE, 300),
    sfera: safeCount(PIXEL_SFERA * p, PIXEL_SFERA, 160),
    anelli: PIXEL_ANELLI,
    perAnello: safeCount(PIXEL_PER_ANELLO * p, PIXEL_PER_ANELLO, 60),
    fascio: safeCount(PIXEL_FASCIO * p, PIXEL_FASCIO, 40),
    strati: PIXEL_STRATI,
    micro: safeCount(PIXEL_MICRO * p, PIXEL_MICRO, 200)
  };
}

// ---------------------------------------------------------------------------------------------
// 2. Nodi reali: energia dagli stati veri e posizione stabile (pura: testata)
// ---------------------------------------------------------------------------------------------

const WORKING_STATUS: ReadonlySet<string> = new Set(['working', 'running', 'starting']);
const ERROR_STATUS: ReadonlySet<string> = new Set(['error', 'failed', 'crashed', 'denied', 'blocked', 'timed_out', 'timeout']);
const GONE_STATUS: ReadonlySet<string> = new Set(['stopped', 'cancelled', 'exited', 'gone', 'archived', 'expired']);

// ---------------------------------------------------------------------------------------------
// P-100 — Colore dei globi AGENTE dallo stato REALE (richiesta del proprietario). Semantica
// dichiarata, senza stati inventati:
//   - verde   = agente VIVO e senza problemi (istanza non terminale: fermo ma pronto, al lavoro…);
//   - rosso   = problema reale: stato `error`/`crashed` oppure limite di quota raggiunto (alert);
//   - bianco  = agente SPENTO o mai avviato (`created`, `stopped`, archiviato…).
// I nodi non-agente (Director, substrato, task…) restano della resa del riferimento.
// ---------------------------------------------------------------------------------------------

/** Semantica del globo di un agente: vivo, al lavoro, in problema, spento. */
export type AgentGlobeState = 'alive' | 'working' | 'problem' | 'off';

/** Stati in cui l'agente è SPENTO o mai avviato (bianco). */
const AGENT_OFF_STATUS: ReadonlySet<string> = new Set(['created', 'stopped', 'cancelled', 'exited', 'gone', 'archived', 'expired']);

/** Stato del globo dalla coppia (stato istanza, alert reale): pura, testabile. */
export function agentGlobeState(status: string, alert = false): AgentGlobeState {
  if (alert || ERROR_STATUS.has(status)) return 'problem';
  if (AGENT_OFF_STATUS.has(status)) return 'off';
  if (status === 'working' || status === 'running') return 'working';
  return 'alive';
}

/** Colori RGB del globo agente per semantica (0..1, come li usa il campo a punti). */
export const AGENT_GLOBE_RGB: Readonly<Record<AgentGlobeState, readonly [number, number, number]>> = {
  alive: [0.21, 0.86, 0.46],
  working: [0.5, 1.0, 0.68],
  problem: [1.0, 0.4, 0.34],
  off: [0.95, 0.98, 1.0]
};

/** Colore del globo agente dallo stato reale; input ignoti restano «vivo» (dichiarato). */
export function agentGlobeColor(status: string, alert = false): readonly [number, number, number] {
  return AGENT_GLOBE_RGB[agentGlobeState(status, alert)];
}

/**
 * Energia visiva di un nodo dallo stato REALE: chi lavora (o è in errore) brilla come un personaggio
 * in movimento del riferimento; chi è fermo resta tenue. Nessuno stato inventato.
 */
export function officeEnergyFor(kind: GraphNode['kind'], status: string): number {
  if (ERROR_STATUS.has(status) || WORKING_STATUS.has(status)) return 1;
  if (GONE_STATUS.has(status)) return 0.2;
  if (kind === 'director' || kind === 'visione') return 0.55;
  return 0.3;
}

/** Hash FNV-1a dell'id, in [0,1): posizione stabile nel tempo e indipendente dagli altri nodi. */
export function officeHash01(id: string, sale: number): number {
  let h = (2_166_136_261 ^ sale) >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return (h >>> 0) / 4_294_967_296;
}

/**
 * Posizione a schermo di un nodo generico (pixel CSS), deterministica per id: un'ellisse dentro
 * l'area visibile fra pannelli e barre (dichiarata; i nodi sono i personaggi della stanza e devono
 * restare cliccabili anche con la barra inferiore espansa: `--bottom-h` = 28vh), lontana dal nucleo.
 * Vale per tool, task, processi, approvazioni, memoria, VISIONE; Director e agenti hanno una
 * disposizione propria (P-97).
 */
export function officeNodePosition(id: string, width: number, height: number): [number, number] {
  const u = officeHash01(id, 1);
  const v = officeHash01(id, 2);
  const angolo = u * Math.PI * 2;
  const raggio = Math.sqrt(0.36 + 0.64 * v); // 0,6…1: lontano dal nucleo, dentro i bordi
  return [
    width * 0.5 + Math.cos(angolo) * raggio * width * 0.24,
    height * 0.365 + Math.sin(angolo) * raggio * height * 0.235
  ];
}

/** Agenti per anello: oltre questo numero si apre l'anello successivo (interlacciato). */
export const PIXEL_AGENTI_PER_ANELLO = 10;

/** Fattore del raggio del primo anello (rispetto al lato minore della scena). */
const AGENTI_R0 = 0.30;
/** Passo fra un anello e il successivo (rispetto al lato minore). */
const AGENTI_PASSO = 0.12;

/**
 * Posizione regolare di un agente (pixel CSS) attorno al nucleo (Director al centro): anelli
 * concentrici, slot equidistanti, anelli interlacciati di mezzo slot. Deterministico dall'indice
 * (l'ordine degli agenti è quello reale del grafo: nessun salto senza cambio di topologia) e
 * sempre dentro la scena, con i raggi contenuti nell'area libera fra pannelli e barre.
 */
export function officeAgentPosition(index: number, total: number, width: number, height: number): [number, number] {
  const per = PIXEL_AGENTI_PER_ANELLO;
  const i = Math.max(0, Math.floor(index));
  const totali = Math.max(1, Math.floor(total));
  const anello = Math.floor(i / per);
  const slot = i % per;
  const quanti = Math.max(1, Math.min(per, totali - anello * per));
  const min = Math.max(1, Math.min(width, height));
  const anelli = Math.max(1, Math.ceil(totali / per));
  // Raggi contenuti nella scena: il primo anello può usare il 30% del lato minore, gli altri si
  // spartiscono lo spazio residuo fino al limite (28% larghezza / 34% altezza).
  const maxR = Math.min(width * 0.28, height * 0.34);
  const r0 = Math.min(min * AGENTI_R0, maxR);
  const passo = anelli > 1 ? Math.min(min * AGENTI_PASSO, Math.max(0, maxR - r0) / (anelli - 1)) : 0;
  const raggio = r0 + anello * passo;
  const fase = -Math.PI / 2 + (anello * Math.PI) / per;
  const angolo = fase + (slot / quanti) * Math.PI * 2;
  return [width * 0.5 + Math.cos(angolo) * raggio, height * 0.5 + Math.sin(angolo) * raggio];
}

/**
 * Diametro CSS dei globi (P-97; P-98 e P-99 richieste del proprietario): il Director resta il nucleo
 * più grande al centro, ma gli agenti sono ora NETTAMENTE più grandi e chiaramente distinguibili dai
 * nodi generici (tool/task/processi/ecc.), mai il contrario. P-99: un altro aumento (~+12% sul
 * diametro a riposo) restando sotto il Director anche a piena energia. `minDim` è il lato minore
 * della scena: le proporzioni reggono a ogni finestra. `hot` = hover o selezione (il globo si
 * ingrandisce un poco, come nel riferimento).
 */
export function officeSizeCss(kind: GraphNode['kind'], energia: number, minDim: number, hot = false): number {
  const e = safeUnit(energia);
  const min = Number.isFinite(minDim) ? Math.max(1, minDim) : 1;
  const base =
    kind === 'director' ? min * (0.11 + e * 0.02)
    : kind === 'agent' ? min * (0.078 + e * 0.029)
    : kind === 'visione' ? min * (0.022 + e * 0.01)
    : min * (0.014 + e * 0.01);
  // L'hover ingrandisce un poco; per gli agenti l'aumento è più contenuto, così il Director resta
  // il globo più grande in OGNI condizione (anche agente acceso+sotto il puntatore).
  return base * (hot ? (kind === 'agent' ? 1.12 : 1.22) : 1);
}

// ---------------------------------------------------------------------------------------------
// 3. Il campo: punti tutti in pixel (come il riferimento, nessuna camera)
// ---------------------------------------------------------------------------------------------

/** Shader dei punti: identico al riferimento (`aPos/uSchermo`, alone e nucleo additivi). */
const PUNTI_VERTEX = /* glsl */ `
  uniform vec2 uSchermo;
  attribute float size;
  attribute float lum;
  varying vec3 vCol;
  varying float vLum;
  void main() {
    vec2 c = (position.xy / uSchermo) * 2.0 - 1.0;
    gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
    gl_PointSize = size;
    vCol = color;
    vLum = lum;
  }
`;
const PUNTI_FRAGMENT = /* glsl */ `
  varying vec3 vCol;
  varying float vLum;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    float alone = pow(1.0 - r, 2.2);
    float nucleo = pow(max(0.0, 1.0 - r * 2.6), 3.0);
    vec3 c = mix(vCol, vec3(1.0), nucleo * 0.85);
    gl_FragColor = vec4(c * vLum, (alone * 0.85 + nucleo) * vLum);
  }
`;
/** Shader delle linee: colore uniforme e luminosità per vertice, come il riferimento. */
const LINEE_VERTEX = /* glsl */ `
  uniform vec2 uSchermo;
  attribute float lum;
  varying float vLum;
  void main() {
    vec2 c = (position.xy / uSchermo) * 2.0 - 1.0;
    gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
    vLum = lum;
  }
`;
const LINEE_FRAGMENT = /* glsl */ `
  uniform vec3 uColore;
  varying float vLum;
  void main() { gl_FragColor = vec4(uColore * vLum, vLum * 0.55); }
`;

/** Generatore pseudo-casuale ripetibile (stessa distribuzione del riferimento, catture stabili). */
function generatore(seme: number): () => number {
  let s = seme >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

/** Nodo reale passato al campo: posizione in pixel CSS ed energia dallo stato vero. */
export interface UfficioNodo {
  x: number;
  y: number;
  energia: number;
}

export interface Ufficio {
  readonly group: THREE.Group;
  /** Vertici del campo (particelle + sfera + anelli + fascio + cuore). */
  readonly points: number;
  readonly counts: PixelCounts;
  /** `voce` (0..1) è l'attivazione REALE del parlato/ascolto: respiro e onde più marcati. */
  update(now: number, level: number, reducedMotion: boolean, width: number, height: number, pr: number, nodi: readonly UfficioNodo[], voce?: number): void;
  dispose(): void;
}

export function createUfficio(quality: 0 | 1 | 2): Ufficio {
  const counts = pixelCounts(quality);
  const rnd = generatore(20261006);

  // Il campo di fondo: strati orizzontali, ognuno con la sua onda (come il riferimento).
  const campo = new Float32Array(counts.particelle * 4);
  for (let i = 0; i < counts.particelle; i++) {
    const strato = i % PIXEL_STRATI;
    campo[i * 4] = rnd();
    campo[i * 4 + 1] = (strato + 0.5) / PIXEL_STRATI + (rnd() - 0.5) * 0.06;
    campo[i * 4 + 2] = rnd() * Math.PI * 2;
    campo[i * 4 + 3] = strato;
  }

  // La sfera: spirale di Fibonacci (distribuzione uniforme, niente grumi) — identica al riferimento.
  const sfera = new Float32Array(counts.sfera * 4);
  const aureo = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < counts.sfera; i++) {
    const y = 1 - (i / Math.max(1, counts.sfera - 1)) * 2;
    const raggio = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = aureo * i;
    sfera[i * 4] = Math.cos(theta) * raggio;
    sfera[i * 4 + 1] = y;
    sfera[i * 4 + 2] = Math.sin(theta) * raggio;
    sfera[i * 4 + 3] = rnd() * Math.PI * 2;
  }

  // Gli anelli: inclinazioni, raggi e velocità del riferimento.
  const anelli: Array<{ raggio: number; inclinaX: number; inclinaZ: number; velocita: number; fasi: Float32Array }> = [];
  for (let a = 0; a < PIXEL_ANELLI; a++) {
    anelli.push({
      raggio: 1.35 + a * 0.28,
      inclinaX: 1.15 + a * 0.22,
      inclinaZ: (a - 1.5) * 0.35,
      velocita: (a % 2 ? -1 : 1) * (0.18 + a * 0.07),
      fasi: Float32Array.from({ length: counts.perAnello }, () => rnd())
    });
  }

  // P-98: le microparticelle dinamiche. Ognuna ha posizione base, fase e velocità PROPRIE: deriva
  // orizzontale, orbita verticale e brillio individuale (movimento reale, non un campo statico).
  const micro = new Float32Array(counts.micro * 4);
  for (let i = 0; i < counts.micro; i++) {
    micro[i * 4] = rnd();
    micro[i * 4 + 1] = rnd();
    micro[i * 4 + 2] = rnd() * Math.PI * 2;
    micro[i * 4 + 3] = 0.35 + rnd() * 1.3;
  }

  const totale = counts.particelle + counts.sfera + PIXEL_ANELLI * counts.perAnello + counts.fascio + counts.micro + 1;
  const geometria = new THREE.BufferGeometry();
  const pos = new Float32Array(totale * 3);
  const col = new Float32Array(totale * 3);
  const siz = new Float32Array(totale);
  const lum = new Float32Array(totale);
  geometria.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geometria.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  geometria.setAttribute('size', new THREE.BufferAttribute(siz, 1).setUsage(THREE.DynamicDrawUsage));
  geometria.setAttribute('lum', new THREE.BufferAttribute(lum, 1).setUsage(THREE.DynamicDrawUsage));
  geometria.setDrawRange(0, totale);

  const materiale = new THREE.ShaderMaterial({
    vertexShader: PUNTI_VERTEX,
    fragmentShader: PUNTI_FRAGMENT,
    uniforms: { uSchermo: { value: new THREE.Vector2(1, 1) } },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true
  });
  const punti = new THREE.Points(geometria, materiale);
  punti.frustumCulled = false;
  const group = new THREE.Group();
  group.add(punti);

  let tempo = 0;
  let ultimo = 0;

  return {
    group,
    points: totale,
    counts,
    update(now, level, reducedMotion, width, height, pr, nodi, voce = 0) {
      const dt = ultimo === 0 ? 16 : Math.min(50, now - ultimo);
      ultimo = now;
      if (!reducedMotion) tempo += dt;
      const t = tempo;
      const W = Math.max(1, Math.round(width * pr));
      const H = Math.max(1, Math.round(height * pr));
      const r = pr;
      const vita = safeUnit(level);
      // Attivazione dalla voce REALE: respiro e onde più marcati, senza scatti (inviluppo morbido).
      const v = safeUnit(voce);
      (materiale.uniforms['uSchermo'] as { value: THREE.Vector2 }).value.set(W, H);

      let vi = 0;
      const scrivi = (x: number, y: number, cr: number, cg: number, cb: number, size: number, l: number): void => {
        pos[vi * 3] = x;
        pos[vi * 3 + 1] = y;
        pos[vi * 3 + 2] = 0;
        col[vi * 3] = cr;
        col[vi * 3 + 1] = cg;
        col[vi * 3 + 2] = cb;
        siz[vi] = size;
        lum[vi] = l;
        vi++;
      };

      // --- il campo: 7 strati che scivolano e ondeggiano; vicino a un nodo attivo si accendono ---
      const tempoCampo = t * 0.00035;
      const raggioVicino = 150 * r;
      for (let i = 0; i < counts.particelle; i++) {
        const x0 = campo[i * 4] as number;
        const y0 = campo[i * 4 + 1] as number;
        const fase = campo[i * 4 + 2] as number;
        const strato = campo[i * 4 + 3] as number;
        const scorri = (x0 + tempoCampo * (0.05 + strato * 0.012)) % 1;
        // L'onda si fa più ampia col parlato reale (P-90), senza cambiare la deriva di base.
        const onda =
          (Math.sin(scorri * 9 + fase + tempoCampo * 2) * (0.012 + vita * 0.03) +
            Math.sin(scorri * 21 - tempoCampo * 1.3 + strato) * (0.005 + vita * 0.012)) * (1 + v * 0.6);
        const x = scorri * W;
        const y = (y0 + onda) * H;
        let vicinanza = 0;
        for (let n = 0; n < nodi.length; n++) {
          const nodo = nodi[n] as UfficioNodo;
          const dx = x - nodo.x * r;
          const dy = y - nodo.y * r;
          const d2 = dx * dx + dy * dy;
          if (d2 < raggioVicino * raggioVicino) {
            vicinanza += (1 - Math.sqrt(d2) / raggioVicino) * nodo.energia;
          }
        }
        if (vicinanza > 1) vicinanza = 1;
        scrivi(x, y, 0.45 + vicinanza * 0.5, 0.72 + vicinanza * 0.2, 1.0, (1.4 + vicinanza * 2.4) * r, 0.24 + vicinanza * 0.7);
      }

      // --- le microparticelle dinamiche (P-98): deriva, orbita e brillio propri di ogni punto ---
      const tempoMicro = t * 0.00019;
      for (let i = 0; i < counts.micro; i++) {
        const x0 = micro[i * 4] as number;
        const y0 = micro[i * 4 + 1] as number;
        const fase = micro[i * 4 + 2] as number;
        const vel = micro[i * 4 + 3] as number;
        const deriva = (x0 + tempoMicro * vel * (0.55 + vel * 0.2)) % 1;
        const x = deriva * W;
        const y = y0 * H + Math.sin(t * 0.0009 * vel + fase) * (14 + vel * 20) * r + Math.cos(t * 0.0006 + fase * 1.7) * (5 + vel * 9) * r;
        const brillio = 0.5 + 0.5 * Math.sin(t * (0.0022 + vel * 0.0016) + fase * 3);
        scrivi(
          x, y,
          0.5 + brillio * 0.3,
          0.78 + brillio * 0.12,
          1.0,
          (0.8 + brillio * 1.5) * r,
          (0.1 + brillio * 0.3) * (0.8 + vita * 0.3 + v * 0.3)
        );
      }

      // --- il nucleo: la sfera ruota e respira sempre; col parlato reale il respiro è più marcato ---
      const cx = W * 0.5;
      const cy = H * 0.5;
      const R = Math.min(W, H) * (0.16 + vita * 0.025 + v * 0.012) * (1 + Math.sin(t * 0.0021) * (0.025 + v * 0.05));
      const giro = t * 0.00022;
      const cg = Math.cos(giro);
      const sg = Math.sin(giro);
      const inclina = 0.38;
      const ci = Math.cos(inclina);
      const si = Math.sin(inclina);
      for (let i = 0; i < counts.sfera; i++) {
        const px = sfera[i * 4] as number;
        const py = sfera[i * 4 + 1] as number;
        const pz = sfera[i * 4 + 2] as number;
        const x1 = px * cg + pz * sg;
        const z1 = -px * sg + pz * cg;
        const y2 = py * ci - z1 * si;
        const z2 = py * si + z1 * ci;
        const fronte = (z2 + 1) * 0.5;
        const sfarfalla = 0.75 + Math.sin(t * 0.006 + (sfera[i * 4 + 3] as number)) * (0.25 + v * 0.3);
        scrivi(
          cx + x1 * R,
          cy + y2 * R,
          0.35 + fronte * 0.35,
          0.72 + fronte * 0.2,
          1.0,
          (1.2 + fronte * 2.6) * r,
          (0.12 + fronte * 0.65) * sfarfalla * (0.85 + vita * 0.3 + v * 0.2)
        );
      }

      // --- i 4 anelli, inclinati fra loro: raggio, spessore e luminosità del riferimento ---
      for (let a = 0; a < PIXEL_ANELLI; a++) {
        const an = anelli[a] as (typeof anelli)[number];
        const rot = t * 0.001 * an.velocita;
        const cX = Math.cos(an.inclinaX);
        const sX = Math.sin(an.inclinaX);
        const cZ = Math.cos(an.inclinaZ);
        const sZ = Math.sin(an.inclinaZ);
        for (let i = 0; i < counts.perAnello; i++) {
          const ang = (an.fasi[i] as number) * Math.PI * 2 + rot;
          const spess = 1 + ((an.fasi[(i * 7) % counts.perAnello] as number) - 0.5) * 0.07;
          const x = Math.cos(ang) * an.raggio * spess;
          const y0 = 0;
          const z = Math.sin(ang) * an.raggio * spess;
          const y1 = y0 * cX - z * sX;
          const z1 = y0 * sX + z * cX;
          const x2 = x * cZ - y1 * sZ;
          const y2 = x * sZ + y1 * cZ;
          const fronte = (z1 / an.raggio + 1) * 0.5;
          scrivi(
            cx + x2 * R,
            cy + y2 * R,
            0.3 + fronte * 0.4,
            0.7 + fronte * 0.25,
            1.0,
            (1.0 + fronte * 2.2) * r,
            (0.08 + fronte * 0.5) * (0.8 + vita * 0.4 + v * 0.3)
          );
        }
      }

      // --- il fascio orizzontale che attraversa il nucleo ---
      for (let i = 0; i < counts.fascio; i++) {
        const u = (i / counts.fascio) * 2 - 1;
        const vicinoAlCentro = 1 - Math.abs(u);
        const scorre = Math.sin(t * 0.003 + i * 0.37) * 0.5 + 0.5;
        scrivi(
          cx + u * W * 0.5,
          cy + Math.sin(i * 12.9898) * R * 0.05 * (1 - vicinoAlCentro),
          0.55 + vicinoAlCentro * 0.45,
          0.85,
          1.0,
          (1.5 + vicinoAlCentro * 5) * r,
          Math.pow(vicinoAlCentro, 2.2) * (0.35 + scorre * 0.4) * (0.7 + vita * 0.5 + v * 0.4)
        );
      }

      // --- il cuore del nucleo: un bagliore unico, grande (come il riferimento) ---
      scrivi(cx, cy, 0.45, 0.8, 1.0, R * 1.35, Math.min(1, 0.55 + vita * 0.35 + v * 0.35));

      const attr = geometria.attributes as Record<string, THREE.BufferAttribute>;
      (attr['position'] as THREE.BufferAttribute).needsUpdate = true;
      (attr['color'] as THREE.BufferAttribute).needsUpdate = true;
      (attr['size'] as THREE.BufferAttribute).needsUpdate = true;
      (attr['lum'] as THREE.BufferAttribute).needsUpdate = true;
    },
    dispose() {
      geometria.dispose();
      materiale.dispose();
    }
  };
}

// ---------------------------------------------------------------------------------------------
// 4. Il renderer della variante: campo + nodi reali + hover/pick, stessa interfaccia della JARVIS
// ---------------------------------------------------------------------------------------------

const QUALITY_PIXEL = [
  { pixelRatio: 0.5, pulses: 80 },
  { pixelRatio: 0.75, pulses: 200 },
  { pixelRatio: 1, pulses: 480 }
] as const;
const MAX_NODES = 512;

export function createPixelOfficeRenderer(canvas: HTMLCanvasElement, opts: RendererOpts): SceneRenderer {
  let quality: 0 | 1 | 2 = 2;
  let motionOff = opts.reducedMotion;
  /** Modalità leggera (`ui.light`): qualità minima fissa e ~30 fotogrammi al secondo. */
  let light = false;
  /** Vista visibile (P-90): a vista nascosta il ciclo si ferma; a vista visibile gira SEMPRE. */
  let active = true;
  let context: 'ok' | 'lost' | 'restored' | 'unavailable' = 'ok';
  let restores = 0;
  let qualityChanges = 0;
  let nodes: NodeView[] = [];
  let edges: EdgeView[] = [];
  let signals: SystemSignals = { directorAt: 0, workAt: 0, errorAt: 0 };
  let width = canvas.clientWidth || 640;
  let height = canvas.clientHeight || 360;
  const pulses: Array<PulseView & { start: number }> = [];
  let pulsesTotal = 0;
  let pulsesDropped = 0;
  let frames = 0;
  let fps: number | null = null;
  let raf: number | null = null;
  let lastFrame = 0;
  let lastRenderAt = 0;
  const window_: number[] = [];
  /** Stato dell'isteresi della qualità adattiva (P-92): finestre buone/cattive consecutive. */
  const qualita: { buone: number; cattive: number } = { buone: 0, cattive: 0 };
  /** Fotogrammi non misurati dopo una ricostruzione (P-92): il costo di shader/buffer non è fps di regime. */
  let settleFrames = 0;
  let glowCount = 0;
  let coreEnergy = 0;
  /** Attivazione REALE del parlato/ascolto (inviluppo del livello voce, P-90). */
  let voce = 0;
  let hoverId: string | null = null;
  let selectedId: string | null = null;
  let pointerDown = false;
  let downX = 0;
  let downY = 0;
  let moved = false;
  /** Tempo decorativo (ms) accumulato solo mentre la scena è sveglia: guida il respiro dei nodi. */
  let tempoOverlay = 0;
  /** Posizioni a schermo (pixel CSS) dei nodi reali: stabili per id, ricalcolate al resize. */
  const posizioni = new Map<string, [number, number]>();
  /** Nodi del web/linee: i primi `PIXEL_MAX_NODI` per energia reale (come il tetto del riferimento). */
  let nodiLinea: NodeView[] = [];
  /** Pool riusato per il campo (nessuna allocazione per fotogramma). */
  const nodiCampo: UfficioNodo[] = [];

  let gl: {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
    ufficio: Ufficio;
    overlayGeom: THREE.BufferGeometry;
    overlayPunti: THREE.Points;
    lineGeom: THREE.BufferGeometry;
    linee: THREE.LineSegments;
    lineMateriale: THREE.ShaderMaterial;
  } | null = null;

  const color = new THREE.Color();

  const energiaDi = (n: NodeView): number => officeEnergyFor(n.kind, n.status);

  /** Energia visiva dello stato reale + respiro lento, come i personaggi del riferimento. */
  const sizeCss = (n: NodeView, hot: boolean): number => officeSizeCss(n.kind, energiaDi(n), Math.min(width, height), hot);

  /**
   * Posizioni P-97: Director al centro (sopra il nucleo), agenti su anelli regolari attorno a lui,
   * nodi generici piccoli sull'ellisse deterministica di P-89. L'ordine degli agenti è quello reale
   * del grafo (nessuna posizione inventata): cambia solo quando cambia la topologia.
   */
  const ricostruisciPosizioni = (): void => {
    posizioni.clear();
    const agenti = nodes.filter((n) => n.kind === 'agent');
    const indice = new Map(agenti.map((n, i) => [n.id, i]));
    for (const n of nodes) {
      if (n.kind === 'director') posizioni.set(n.id, [width * 0.5, height * 0.5]);
      else if (n.kind === 'agent') posizioni.set(n.id, officeAgentPosition(indice.get(n.id) ?? 0, agenti.length, width, height));
      else posizioni.set(n.id, officeNodePosition(n.id, width, height));
    }
  };

  const build = (): void => {
    const q = QUALITY_PIXEL[quality] as (typeof QUALITY_PIXEL)[number];
    const pr = Math.min(window.devicePixelRatio || 1, 2) * q.pixelRatio;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 2, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.max(0.5, pr));
    renderer.setSize(width, height, false);
    // Fondo del riferimento: clearColor(0,012; 0,024; 0,06) = #03060f. Misurato: con `setHex` three
    // scrive (2,6,10)-(3,6,15) come il riferimento; con `setRGB` grezzo il fondo schiariva a (8,15,23).
    renderer.setClearColor(0x03060f, 1);
    const scene = new THREE.Scene();
    // La camera non trasforma nulla: gli shader del campo proiettano da soli in pixel (come il
    // riferimento, che non usa matrici). Serve solo a `renderer.render`.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;
    const ufficio = createUfficio(quality);

    // Overlay: i nodi reali e gli impulsi, nello stesso formato a punti del campo.
    const overlayCap = MAX_NODES + q.pulses;
    const overlayGeom = new THREE.BufferGeometry();
    overlayGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(overlayCap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    overlayGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(overlayCap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    overlayGeom.setAttribute('size', new THREE.BufferAttribute(new Float32Array(overlayCap), 1).setUsage(THREE.DynamicDrawUsage));
    overlayGeom.setAttribute('lum', new THREE.BufferAttribute(new Float32Array(overlayCap), 1).setUsage(THREE.DynamicDrawUsage));
    overlayGeom.setDrawRange(0, 0);
    const overlayPunti = new THREE.Points(
      overlayGeom,
      new THREE.ShaderMaterial({
        vertexShader: PUNTI_VERTEX,
        fragmentShader: PUNTI_FRAGMENT,
        uniforms: { uSchermo: { value: new THREE.Vector2(1, 1) } },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        vertexColors: true
      })
    );
    overlayPunti.frustumCulled = false;

    // Linee: nodo→centro e coppie entro la portata, come il web del riferimento.
    const lineCap = PIXEL_MAX_NODI * PIXEL_MAX_NODI * 2 + 2;
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lineCap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    lineGeom.setAttribute('lum', new THREE.BufferAttribute(new Float32Array(lineCap), 1).setUsage(THREE.DynamicDrawUsage));
    lineGeom.setDrawRange(0, 0);
    const lineMateriale = new THREE.ShaderMaterial({
      vertexShader: LINEE_VERTEX,
      fragmentShader: LINEE_FRAGMENT,
      uniforms: { uSchermo: { value: new THREE.Vector2(1, 1) }, uColore: { value: new THREE.Color(0.35, 0.75, 1.0) } },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });
    const linee = new THREE.LineSegments(lineGeom, lineMateriale);
    linee.frustumCulled = false;

    scene.add(linee, overlayPunti, ufficio.group);
    gl = { renderer, scene, camera, ufficio, overlayGeom, overlayPunti, lineGeom, linee, lineMateriale };
    ricostruisciPosizioni();
    scriviLinee();
    // P-92: la scena appena costruita non è ancora a regime (shader da compilare, buffer nuovi):
    // le prime finestre non si misurano e l'isteresi riparte da zero.
    window_.length = 0;
    qualita.buone = 0;
    qualita.cattive = 0;
    settleFrames = QUALITA_ASSESTAMENTO;
  };

  /** Nodi per le linee: i più energici, come il tetto `MAX_NODI` del riferimento. */
  const scegliNodiLinea = (): void => {
    nodiLinea = [...nodes]
      .sort((a, b) => energiaDi(b) - energiaDi(a) || a.id.localeCompare(b.id))
      .slice(0, PIXEL_MAX_NODI);
  };

  /** Web delle linee: ogni nodo al centro + coppie vicine (portata 340 px, come il riferimento). */
  const scriviLinee = (): void => {
    if (!gl) return;
    const pr = gl.renderer.getPixelRatio();
    const W = width * pr;
    const H = height * pr;
    const geom = gl.lineGeom;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const lum = geom.getAttribute('lum') as THREE.BufferAttribute;
    let k = 0;
    const vertice = (x: number, y: number, l: number): void => {
      pos.setXYZ(k, x, y, 0);
      lum.setX(k, l);
      k++;
    };
    for (const n of nodiLinea) {
      const p = posizioni.get(n.id);
      if (!p) continue;
      const forza = 0.18 + energiaDi(n) * 0.6;
      vertice(p[0] * pr, p[1] * pr, forza);
      vertice(W * 0.5, H * 0.5, forza * 0.4);
    }
    for (let i = 0; i < nodiLinea.length; i++) {
      const a = nodiLinea[i] as NodeView;
      const pa = posizioni.get(a.id);
      if (!pa) continue;
      for (let j = i + 1; j < nodiLinea.length; j++) {
        const b = nodiLinea[j] as NodeView;
        const pb = posizioni.get(b.id);
        if (!pb) continue;
        const dx = (pa[0] - pb[0]) * pr;
        const dy = (pa[1] - pb[1]) * pr;
        const d = Math.sqrt(dx * dx + dy * dy);
        const portata = PIXEL_PORTATA * pr;
        if (d > portata) continue;
        const forza = (1 - d / portata) * (0.25 + (energiaDi(a) + energiaDi(b)) * 0.4);
        vertice(pa[0] * pr, pa[1] * pr, forza);
        vertice(pb[0] * pr, pb[1] * pr, forza);
      }
    }
    geom.setDrawRange(0, k);
    pos.needsUpdate = true;
    lum.needsUpdate = true;
  };

  /** Punti dell'overlay: nodi reali (energia, respiro, hover) e impulsi degli eventi veri. */
  const scriviOverlay = (decorativo: number, adesso: number): void => {
    if (!gl) return;
    const pr = gl.renderer.getPixelRatio();
    const geom = gl.overlayGeom;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const col = geom.getAttribute('color') as THREE.BufferAttribute;
    const siz = geom.getAttribute('size') as THREE.BufferAttribute;
    const lum = geom.getAttribute('lum') as THREE.BufferAttribute;
    const t = decorativo;
    let k = 0;
    let glow = 0;
    const n = Math.min(nodes.length, MAX_NODES);
    for (let i = 0; i < n; i++) {
      const nodo = nodes[i] as NodeView;
      const p = posizioni.get(nodo.id);
      if (!p) continue;
      const e = energiaDi(nodo);
      const hot = nodo.id === selectedId || nodo.id === hoverId;
      const respiro = 1 + Math.sin(t * 0.004 + p[0]) * 0.12;
      pos.setXYZ(k, p[0] * pr, p[1] * pr, 0);
      if (nodo.kind === 'agent') {
        // P-100: il globo dell'agente si colora dallo stato REALE (verde/rosso/bianco).
        const rgb = agentGlobeColor(nodo.status, nodo.alert === true);
        color.setRGB(rgb[0], rgb[1], rgb[2]);
      } else {
        color.setRGB(0.55 + e * 0.45, 0.92, 1.0);
      }
      col.setXYZ(k, color.r, color.g, color.b);
      // P-97: dimensione dal ruolo (Director > agenti > nodi generici), col respiro del riferimento.
      siz.setX(k, sizeCss(nodo, hot) * respiro * pr);
      lum.setX(k, 0.55 + e * 0.45);
      k++;
      if (nodo.kind === 'director' || nodo.kind === 'visione' || nodo.kind === 'agent') glow++;
    }
    // Impulsi: il punto caldo che corre fra i due nodi reali per 1.400 ms (riferimento).
    // La scadenza usa il tempo REALE (`adesso`), non quello decorativo del respiro.
    for (let i = pulses.length - 1; i >= 0; i--) {
      if (adesso - (pulses[i] as PulseView & { start: number }).start > PIXEL_PULSE_MS) pulses.splice(i, 1);
    }
    const capPulses = (QUALITY_PIXEL[quality] as (typeof QUALITY_PIXEL)[number]).pulses;
    for (const p of pulses) {
      if (k >= MAX_NODES + capPulses) break;
      const eta = adesso - p.start;
      const pa = posizioni.get(p.from);
      const pb = posizioni.get(p.to) ?? pa;
      if (!pa) continue;
      const u = eta / PIXEL_PULSE_MS;
      const luce = Math.sin(u * Math.PI);
      pos.setXYZ(k, (pa[0] + ((pb?.[0] ?? pa[0]) - pa[0]) * u) * pr, (pa[1] + ((pb?.[1] ?? pa[1]) - pa[1]) * u) * pr, 0);
      color.setRGB(1.0, 0.85, 0.55);
      col.setXYZ(k, color.r, color.g, color.b);
      siz.setX(k, 9 * pr * (0.6 + luce));
      lum.setX(k, luce);
      k++;
    }
    geom.setDrawRange(0, k);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    siz.needsUpdate = true;
    lum.needsUpdate = true;
    glowCount = glow;
  };

  const placeCamera = (): void => {
    if (!gl) return;
    gl.camera.position.set(0, 0, 1);
    gl.camera.lookAt(0, 0, 0);
  };

  const directorAt = (now: number): SceneStats['director'] => systemState(signals, now);

  const render = (now: number): void => {
    if (!gl || context === 'lost' || context === 'unavailable') return;
    const dt = lastRenderAt > 0 ? Math.min(0.05, (now - lastRenderAt) / 1000) : 0.016;
    lastRenderAt = now;
    if (!motionOff) tempoOverlay += dt * 1000;
    const state = directorAt(now);
    coreEnergy += ((state === 'idle' ? 0 : state === 'error' ? 0.72 : state === 'planning' ? 0.5 : 0.9) - coreEnergy) * Math.min(1, dt * 3);
    // Livello REALE (P-90): uscita TTS (analizzatore) e microfono in ascolto, poi l'energia del Director.
    const livelloReale = Math.max(safeUnit(opts.level?.() ?? 0), safeUnit(opts.reactor?.level ?? 0));
    voce = voiceActivation(opts.reactor?.state ?? state, livelloReale, dt, voce);
    // `vita` del riferimento = attività dei personaggi; qui = livello REALE (voce + Director) e
    // somma delle energie reali dei nodi.
    let energiaNodi = 0;
    for (const n of nodes) energiaNodi += energiaDi(n);
    const livello = Math.max(livelloReale, coreEnergy, Math.min(1, energiaNodi / 6));
    const pr = gl.renderer.getPixelRatio();
    // Pool riusato: la lista dei nodi del campo non alloca a ogni fotogramma.
    while (nodiCampo.length < nodiLinea.length) nodiCampo.push({ x: 0, y: 0, energia: 0 });
    nodiCampo.length = nodiLinea.length;
    for (let i = 0; i < nodiLinea.length; i++) {
      const n = nodiLinea[i] as NodeView;
      const p = posizioni.get(n.id) as [number, number];
      const slot = nodiCampo[i] as UfficioNodo;
      slot.x = p[0];
      slot.y = p[1];
      slot.energia = energiaDi(n);
    }
    gl.ufficio.update(performance.now(), livello, motionOff, width, height, pr, nodiCampo, voce);
    scriviOverlay(tempoOverlay, now);
    (gl.lineMateriale.uniforms['uSchermo'] as { value: THREE.Vector2 }).value.set(width * pr, height * pr);
    ((gl.overlayPunti.material as THREE.ShaderMaterial).uniforms['uSchermo'] as { value: THREE.Vector2 }).value.set(width * pr, height * pr);
    gl.renderer.render(gl.scene, gl.camera);
    frames++;
  };

  const setQuality = (q: 0 | 1 | 2): void => {
    if (q === quality || !gl) return;
    quality = q;
    qualityChanges++;
    gl.renderer.dispose();
    disposeScene();
    build();
    render(Date.now());
  };

  /** Qualità adattiva (P-90; P-92): assestamento dopo la ricostruzione e isteresi. Il ciclo
   *  continuo a riposo non deve far oscillare la qualità: scende solo dopo finestre cattive
   *  CONSECUTIVE, così la resa a regime resta quella piena di P-89 (q2, 100% di densità). */
  const adapt = (delta: number): void => {
    if (settleFrames > 0) {
      settleFrames--;
      return;
    }
    window_.push(delta);
    if (window_.length < QUALITA_FINESTRA) return;
    const avg = window_.reduce((a, b) => a + b, 0) / window_.length;
    window_.length = 0;
    fps = Math.round(1000 / avg);
    // In modalità leggera l'fps si misura ma la qualità resta la minima.
    if (light) return;
    const esito = qualitaPasso(fps, quality, qualita);
    qualita.buone = esito.stato.buone;
    qualita.cattive = esito.stato.cattive;
    if (esito.passo === 'giu') setQuality((quality - 1) as 0 | 1);
    else if (esito.passo === 'su') setQuality((quality + 1) as 1 | 2);
  };

  const loop = (t: number): void => {
    raf = null;
    // Modalità leggera: i fotogrammi in mezzo si saltano senza disegnare.
    if (!motionOff && active && lastFrame > 0 && leggeroSalta(light, t - lastFrame)) {
      raf = requestAnimationFrame(loop);
      return;
    }
    const now = Date.now();
    if (lastFrame > 0) adapt(t - lastFrame);
    lastFrame = t;
    render(now);
    if (!motionOff && active) {
      raf = requestAnimationFrame(loop);
    } else {
      // `reducedMotion` ferma tutto (come prima): nessun fps del presente da mostrare. A vista
      // nascosta il ciclo è in pausa e conserva l'ultima misura reale.
      if (motionOff) {
        fps = null;
        window_.length = 0;
      }
      lastFrame = 0;
      lastRenderAt = 0;
    }
    publish();
  };

  const kick = (): void => {
    if (!active || raf !== null || !gl || context === 'lost' || context === 'unavailable') return;
    raf = requestAnimationFrame(loop);
  };

  const disposeScene = (): void => {
    if (!gl) return;
    gl.overlayGeom.dispose();
    (gl.overlayPunti.material as THREE.Material).dispose();
    gl.lineGeom.dispose();
    gl.lineMateriale.dispose();
    gl.ufficio.dispose();
    gl = null;
  };

  const publish = (): void => opts.onStats?.(api.stats());

  // --- interazione: proiezione diretta in pixel (i nodi SONO in pixel CSS) --------------------
  const pick = (clientX: number, clientY: number): string | null => {
    if (!gl || nodes.length === 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: string | null = null;
    let bestD = Infinity;
    for (const n of nodes) {
      const p = posizioni.get(n.id);
      if (!p) continue;
      const r = Math.max(PIXEL_TOCCO_MIN, sizeCss(n, false) / 2);
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d <= r && d < bestD) {
        best = n.id;
        bestD = d;
      }
    }
    return best;
  };
  const setCursor = (id: string | null): void => {
    canvas.style.cursor = id !== null ? 'pointer' : '';
  };
  const onPointerDown = (e: PointerEvent): void => {
    pointerDown = true;
    moved = false;
    downX = e.clientX;
    downY = e.clientY;
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch {
      // puntatore sintetico (test): nessuna cattura possibile
    }
  };
  const hoverAt = (clientX: number, clientY: number): void => {
    const id = pick(clientX, clientY);
    if (id !== hoverId) {
      hoverId = id;
      setCursor(id);
      opts.onHover?.(id);
      kick();
    }
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (pointerDown) {
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      downX = e.clientX;
      downY = e.clientY;
      return;
    }
    hoverAt(e.clientX, e.clientY);
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (!pointerDown) hoverAt(e.clientX, e.clientY);
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (!pointerDown) return;
    pointerDown = false;
    try {
      canvas.releasePointerCapture?.(e.pointerId);
    } catch {
      // puntatore sintetico (test)
    }
    if (!moved) {
      selectedId = pick(e.clientX, e.clientY);
      opts.onSelect?.(selectedId);
      kick();
    }
  };
  const onPointerLeave = (): void => {
    if (hoverId !== null) {
      hoverId = null;
      setCursor(null);
      opts.onHover?.(null);
      kick();
    }
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);

  const onLost = (e: Event): void => {
    e.preventDefault();
    context = 'lost';
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    publish();
  };
  const onRestored = (): void => {
    try {
      gl?.renderer.dispose();
      disposeScene();
      build();
      context = 'restored';
      restores++;
      render(Date.now());
      kick(); // P-90: il movimento ambientale riparte subito anche dopo il ripristino del contesto
    } catch {
      context = 'unavailable';
    }
    publish();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  try {
    build();
    placeCamera();
    kick(); // P-90: la scena si anima appena è disponibile, prima ancora di ricevere il grafo
  } catch {
    context = 'unavailable';
  }

  const api: SceneRenderer = {
    setGraph(n, e, s) {
      nodes = n;
      edges = e;
      signals = s;
      ricostruisciPosizioni();
      scegliNodiLinea();
      scriviLinee();
      render(Date.now());
      kick();
      publish();
    },
    addPulses(list) {
      const now = Date.now();
      const cap = safeCount((QUALITY_PIXEL[quality] as (typeof QUALITY_PIXEL)[number]).pulses, 2_000, 0);
      for (const p of list) {
        pulsesTotal++;
        if (pulses.length >= cap) {
          pulsesDropped++;
          continue;
        }
        pulses.push({ ...p, start: now });
      }
      kick();
    },
    resize(w, h) {
      width = Math.max(1, Math.floor(w));
      height = Math.max(1, Math.floor(h));
      if (!gl) return;
      gl.renderer.setSize(width, height, false);
      ricostruisciPosizioni();
      scriviLinee();
      render(Date.now());
    },
    labels() {
      if (!gl) return [];
      // P-99: TUTTI i nodi hanno una label; `labelVisible` decide quando mostrarla (popover al hover).
      return nodes
        .map((n) => {
          const p = posizioni.get(n.id) ?? [width / 2, height / 2];
          const r = sizeCss(n, false) / 2;
          const hot = n.id === selectedId || n.id === hoverId;
          return {
            id: n.id,
            text: n.label,
            kind: n.kind,
            status: n.status,
            x: p[0] + r + 10,
            y: p[1] - 14,
            nx: p[0],
            ny: p[1],
            r,
            lastEventAt: n.lastEventAt,
            hot
          } satisfies Label;
        });
    },
    stats: () => ({
      fps,
      quality,
      nodes: nodes.length,
      edges: edges.length,
      pulsesActive: pulses.length,
      pulsesTotal,
      pulsesDropped,
      frames,
      context,
      restores,
      animating: raf !== null,
      qualityChanges,
      glow: glowCount,
      director: directorAt(Date.now()),
      reactor: opts.reactor?.state ?? directorAt(Date.now()),
      open: 1,
      spin: 0,
      selected: selectedId,
      hover: hoverId,
      core: gl?.ufficio.counts.sfera ?? 0,
      ambient: gl?.ufficio.counts.particelle ?? 0,
      trail: 0,
      dust: gl?.ufficio.counts.micro ?? 0,
      rings: (gl?.ufficio.counts.perAnello ?? 0) * PIXEL_ANELLI,
      stars: 0,
      post: false,
      voice: voce
    }),
    setSelection(id) {
      selectedId = id;
      kick();
      publish();
    },
    wake() {
      kick();
    },
    setActive(on) {
      if (active === on) return;
      active = on;
      if (!on) {
        if (raf !== null) cancelAnimationFrame(raf);
        raf = null;
        lastFrame = 0;
        lastRenderAt = 0;
        window_.length = 0;
        qualita.buone = 0;
        qualita.cattive = 0;
        publish();
      } else {
        // P-92: al ritorno la scena si riassesta prima di tornare a misurare l'fps.
        settleFrames = QUALITA_ASSESTAMENTO;
        kick();
      }
    },
    setLight(on) {
      if (light === on) return;
      light = on;
      window_.length = 0;
      qualita.buone = 0;
      qualita.cattive = 0;
      // Accesa: subito la qualità minima; spenta: si torna alla piena e da lì decide l'adattiva.
      setQuality(on ? 0 : 2);
      kick();
      publish();
    },
    setReducedMotion(on) {
      if (motionOff === on) return;
      motionOff = on;
      kick();
      publish();
    },
    pickAt: (x, y) => pick(x, y),
    dispose() {
      if (raf !== null) cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      canvas.style.cursor = '';
      gl?.renderer.dispose();
      disposeScene();
    }
  };
  return api;
}
