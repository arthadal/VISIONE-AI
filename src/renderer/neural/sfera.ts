// Sfera neurale di VISIONE (P-88): porting FEDELE della "Sfera" dell'edizione JARVIS di Munder
// (`C:\Users\matte\munder-difflin\src\renderer\src\jarvis\scene\Sfera.tsx`, MIT © 2026 Aditya
// Dewaskar — vedi `docs/decisions/LICENZE_E_PROVENIENZA.md`). Non e' un'interpretazione: stessa
// costruzione (6 gusci da 2.600 punti, archi laterali tratteggiati, fascio centrale, filamenti),
// stessi colori, stessi conteggi, stessa rotazione 0,06 rad/s e stesso scintillio per punto.
//
// Scala MONDO 1: la sfera vive alla dimensione con cui e' stata autoria (raggio 1,32) e la camera
// del renderer sta a 6,2 con fov 45, ESATTAMENTE come `scene/Scene.tsx` di Munder. Le versioni
// precedenti la ingrandivano ×9 dentro una camera diversa: era quella la "bassa qualita'".
//
// Regole della casa: geometria costruita una volta (buffer fissi), due ShaderMaterial, nessuno
// stato React per fotogramma. L'unica cosa che reagisce e' `level` (voce reale + energia reale del
// Director): gonfia i gusci; da P-90 la rotazione e lo scintillio girano SEMPRE mentre la scena e'
// visibile (movimento ambientale continuo) e si fermano solo con `reducedMotion` o vista nascosta.
import * as THREE from 'three';
import { safeCount, safeUnit } from '../lib/safe.ts';

/** Il blu elettrico del riferimento. Il colore della fase lo tinge appena (25%). */
const BLU = new THREE.Color('#1c8cff');
const BLU_CALDO = new THREE.Color('#9fdcff');

/** I sei gusci del riferimento, in unita' mondo. */
const GUSCI = [0.62, 0.8, 0.96, 1.1, 1.22, 1.32];
/** Conteggi del riferimento a qualita' piena (Munder, Sfera.tsx). */
const PUNTI_PER_GUSCIO = 2_600;
const FILAMENTI = 2_600;
const ARCHI = 6;
const PUNTI_PER_ARCO = 520;
const PUNTI_FASCIO = 2_400;
/** Dimensione dei punti nel riferimento. */
const SCALA_PUNTI = 1.9;

/** Generatore pseudo-casuale ripetibile: la sfera e' la stessa a ogni avvio (seme del riferimento). */
function generatore(seme: number): () => number {
  let s = seme >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const vertPunti = /* glsl */ `
  attribute float aSeme;
  attribute float aLuce;
  uniform float uTempo;
  uniform float uGonfia;
  uniform float uScala;
  varying float vLuce;
  void main() {
    vec3 p = position * (1.0 + uGonfia * aLuce * 0.18);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // Scintillio lento e fisso per punto: decorazione, non attivita'.
    float sc = 0.65 + 0.35 * sin(uTempo * (0.6 + aSeme * 1.7) + aSeme * 40.0);
    vLuce = aLuce * sc;
    gl_PointSize = uScala * (0.6 + aSeme * 1.4) * (6.2 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const fragPunti = /* glsl */ `
  uniform vec3 uColore;
  uniform vec3 uCaldo;
  varying float vLuce;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (r > 0.5) discard;
    float a = smoothstep(0.5, 0.0, r);
    vec3 c = mix(uColore, uCaldo, a * a * 0.6);
    gl_FragColor = vec4(c * a * vLuce, 1.0);
  }
`;
const vertLinee = /* glsl */ `
  attribute float aLuce;
  uniform float uGonfia;
  varying float vLuce;
  void main() {
    vLuce = aLuce;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position * (1.0 + uGonfia * 0.12), 1.0);
  }
`;
const fragLinee = /* glsl */ `
  uniform vec3 uColore;
  varying float vLuce;
  void main() { gl_FragColor = vec4(uColore * vLuce, 1.0); }
`;

export interface Sfera {
  readonly group: THREE.Group;
  /** Vertici della sfera (telemetria: `core`). */
  readonly points: number;
  /** `level` = voce reale + energia reale; `color` = tinta di fase; `reducedMotion` ferma il tempo;
   *  `fade` (0–1) attenua la luce, per lasciare in primo piano l'agente inquadrato. */
  update(now: number, level: number, color: THREE.Color, reducedMotion: boolean, fade?: number): void;
  /** Scala della sfera: geometria E dimensione dei punti, così una sfera piccola guardata da vicino
   *  ha lo stesso aspetto della Sfera centrale (zoom sull'agente, 11/10/2026). */
  setScale(scale: number): void;
  dispose(): void;
}

export function createSfera(quality: 0 | 1 | 2): Sfera {
  const P = quality === 2 ? 1 : quality === 1 ? 0.55 : 0.3;
  // Guardie di allocazione (P-74): conteggi interi, non negativi, sotto un tetto.
  const puntiPerGuscio = safeCount(Math.max(80, PUNTI_PER_GUSCIO * P), 20_000, 80);
  const filamenti = safeCount(Math.max(80, FILAMENTI * P), 20_000, 80);
  const archi = safeCount(ARCHI, 32, 6);
  const puntiPerArco = safeCount(Math.max(40, PUNTI_PER_ARCO * P), 10_000, 40);
  const puntiFascio = safeCount(Math.max(80, PUNTI_FASCIO * P), 40_000, 80);

  const rnd = generatore(20260930);
  const pos: number[] = [];
  const semi: number[] = [];
  const luci: number[] = [];
  const puntoSulGuscio = (r: number): [number, number, number] => {
    const u = rnd() * 2 - 1;
    const t = rnd() * Math.PI * 2;
    const q = Math.sqrt(Math.max(0, 1 - u * u));
    const j = 1 + (rnd() - 0.5) * 0.035;
    return [Math.cos(t) * q * r * j, u * r * j, Math.sin(t) * q * r * j];
  };

  // 1. I gusci: piu' densi e piu' luminosi verso il centro (luce per guscio del riferimento).
  const sulGuscio: Array<Array<[number, number, number]>> = [];
  GUSCI.forEach((r, k) => {
    const lista: Array<[number, number, number]> = [];
    for (let i = 0; i < puntiPerGuscio; i++) {
      const p = puntoSulGuscio(r);
      lista.push(p);
      pos.push(p[0], p[1], p[2]);
      semi.push(rnd());
      // Sommati in additivo migliaia di punti bruciano il centro: luce bassa per punto, e' la
      // densita' a fare la luminosita'. P-88: alzata dal valore del sorgente (0.5) per leggere le
      // ragnatele dei gusci come nella cattura di riferimento, con un bloom piu' stretto.
      luci.push(0.58 - k * 0.05);
    }
    sulGuscio.push(lista);
  });
  // Da qui in poi archi e fascio: restano FERMI mentre i gusci ruotano, altrimenti gli archi
  // laterali girerebbero intorno alla sfera invece di starle ai lati.
  const nGusci = semi.length;

  // 2. Gli archi ai lati: cerchi tratteggiati nel piano YZ, sempre piu' lontani e tenui,
  //    speculari a destra e a sinistra — le "onde" del riferimento.
  for (let lato = -1; lato <= 1; lato += 2) {
    for (let a = 0; a < archi; a++) {
      const x = lato * (1.55 + a * 0.42);
      const r = 1.05 + Math.sin(a * 0.9) * 0.18 - a * 0.05;
      const luce = 0.75 - a * 0.1;
      for (let i = 0; i < puntiPerArco; i++) {
        const t = (i / puntiPerArco) * Math.PI * 2;
        // Tratteggio: si salta un tratto su tre, come le linee spezzate della foto.
        if (Math.floor(t * 6) % 3 === 2) continue;
        pos.push(x + (rnd() - 0.5) * 0.06, Math.sin(t) * r, Math.cos(t) * r * 0.55);
        semi.push(rnd());
        luci.push(luce);
      }
    }
  }

  // 3. Il fascio: una lama di punti stretta lungo l'asse X, piu' fitta e luminosa al centro.
  for (let i = 0; i < puntiFascio; i++) {
    const x = (rnd() * 2 - 1) * 4.6;
    const vicino = 1 - Math.min(1, Math.abs(x) / 4.6);
    pos.push(x, (rnd() - 0.5) * 0.07 * (0.4 + vicino), (rnd() - 0.5) * 0.3);
    semi.push(rnd());
    luci.push(0.35 + vicino * 0.75);
  }

  // 4. I filamenti: tratti corti fra punti vicini dello stesso guscio.
  const lin: number[] = [];
  const linLuce: number[] = [];
  for (let f = 0; f < filamenti; f++) {
    const k = Math.floor(rnd() * GUSCI.length);
    const lista = sulGuscio[k] as Array<[number, number, number]>;
    const a = lista[Math.floor(rnd() * lista.length)] as [number, number, number];
    let migliore: [number, number, number] | null = null;
    let dmin = Infinity;
    for (let prova = 0; prova < 24; prova++) {
      const b = lista[Math.floor(rnd() * lista.length)] as [number, number, number];
      const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      if (d > 1e-6 && d < dmin) {
        dmin = d;
        migliore = b;
      }
    }
    if (!migliore || dmin > 0.06) continue;
    lin.push(a[0], a[1], a[2], migliore[0], migliore[1], migliore[2]);
    const l = 0.32 - k * 0.035;
    linLuce.push(l, l);
  }

  const geometria = (da: number, a: number): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos.slice(da * 3, a * 3), 3));
    g.setAttribute('aSeme', new THREE.Float32BufferAttribute(semi.slice(da, a), 1));
    g.setAttribute('aLuce', new THREE.Float32BufferAttribute(luci.slice(da, a), 1));
    return g;
  };
  const punti = geometria(0, nGusci);
  const fissi = geometria(nGusci, semi.length);
  const linee = new THREE.BufferGeometry();
  linee.setAttribute('position', new THREE.Float32BufferAttribute(lin, 3));
  linee.setAttribute('aLuce', new THREE.Float32BufferAttribute(linLuce, 1));

  const matPunti = new THREE.ShaderMaterial({
    vertexShader: vertPunti,
    fragmentShader: fragPunti,
    uniforms: {
      uTempo: { value: 0 },
      uGonfia: { value: 0 },
      uScala: { value: SCALA_PUNTI },
      uColore: { value: BLU.clone() },
      uCaldo: { value: BLU_CALDO.clone() }
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const matLinee = new THREE.ShaderMaterial({
    vertexShader: vertLinee,
    fragmentShader: fragLinee,
    uniforms: { uGonfia: { value: 0 }, uColore: { value: BLU.clone() } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  const gusciGiranti = new THREE.Group();
  const gusci = new THREE.Points(punti, matPunti);
  gusci.frustumCulled = false;
  const fili = new THREE.LineSegments(linee, matLinee);
  fili.frustumCulled = false;
  gusciGiranti.add(gusci, fili);
  const fermi = new THREE.Points(fissi, matPunti);
  fermi.frustumCulled = false;
  const group = new THREE.Group();
  group.add(fermi, gusciGiranti);

  const tinta = new THREE.Color();
  let tempo = 0;
  let ultimo = 0;
  return {
    group,
    points: semi.length,
    update(now, level, color, reducedMotion, fade = 1) {
      const dt = ultimo === 0 ? 0.016 : Math.min(0.05, (now - ultimo) / 1000);
      ultimo = now;
      if (!reducedMotion) tempo += dt;
      // Blu del riferimento, appena tinto dalla fase (25%), come `Sfera.tsx`.
      tinta.copy(BLU).lerp(color, 0.25);
      const luce = safeUnit(fade, 1);
      tinta.multiplyScalar(luce);
      (matPunti.uniforms['uColore'] as { value: THREE.Color }).value.copy(tinta);
      (matPunti.uniforms['uCaldo'] as { value: THREE.Color }).value.copy(BLU_CALDO).multiplyScalar(luce);
      (matLinee.uniforms['uColore'] as { value: THREE.Color }).value.copy(tinta);
      (matPunti.uniforms['uTempo'] as { value: number }).value = tempo;
      // Il gonfiaggio del riferimento usa il volume reale (voce); NaN/∞ non devono toccare la GPU.
      (matPunti.uniforms['uGonfia'] as { value: number }).value = safeUnit(level);
      (matLinee.uniforms['uGonfia'] as { value: number }).value = safeUnit(level);
      if (!reducedMotion) gusciGiranti.rotation.y += dt * 0.06;
    },
    setScale(scale) {
      const s = Number.isFinite(scale) && scale > 0 ? scale : 1e-4;
      group.scale.setScalar(s);
      (matPunti.uniforms['uScala'] as { value: number }).value = SCALA_PUNTI * s;
    },
    dispose() {
      for (const g of [punti, fissi, linee]) g.dispose();
      matPunti.dispose();
      matLinee.dispose();
    }
  };
}
