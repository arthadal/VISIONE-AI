// Polvere atmosferica (P-88): porting FEDELE di `Particles.tsx` dell'edizione JARVIS di Munder
// (`C:\Users\matte\munder-difflin\src\renderer\src\jarvis\scene\Particles.tsx`, MIT © 2026 Aditya
// Dewaskar — vedi `docs/decisions/LICENZE_E_PROVENIENZA.md`). Guscio di punti attorno alla sfera
// (raggio 1,9–4,5), rotazione per punto sul proprio asse, spinta col volume reale, dissolvenza sul
// fondo: stessi shader, stessi colori, stessa dimensione (1,6) del riferimento.
//
// Decorazione dichiarata: nessun numero, nessun dato. Da P-90 la rotazione gira SEMPRE mentre la
// scena e' visibile e si ferma solo con `reducedMotion` (o a vista nascosta, perche' il ciclo e' in
// pausa); la voce reale la spinge verso l'esterno.
import * as THREE from 'three';
import { safeCount, safeUnit } from '../lib/safe.ts';

/** Colore del riferimento (`#2a8cff`). La tinta di fase lo sposta di poco. */
const BLU = new THREE.Color('#2a8cff');

/** Conteggi per qualita' 0/1/2 (il riferimento JARVIS usa 4.000; P-98: piu' densa e piu' viva). */
export const DUST_COUNT: readonly [number, number, number] = [1_600, 4_000, 6_500];
export const DUST_MAX = 6_500;

/** Generatore pseudo-casuale ripetibile (stessa polvere a ogni avvio). */
function generatore(seme: number): () => number {
  let s = seme >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const vert = /* glsl */ `
  attribute float aSeme;
  attribute float aRadius;
  uniform float uTempo;
  uniform float uLivello;
  uniform float uDimensione;
  varying float vAlfa;
  void main() {
    // Rotazione per punto attorno all'asse Y: parallasse economica.
    float t = uTempo * (0.06 + aSeme * 0.05);
    float c = cos(t);
    float s = sin(t);
    vec3 p = vec3(position.x * c - position.z * s, position.y, position.x * s + position.z * c);
    // Il volume reale (voce) spinge il guscio verso l'esterno, piu' un micro-jitter.
    float push = 1.0 + uLivello * 0.35 + sin(uTempo * 2.0 + aSeme * 12.0) * 0.02;
    p *= push;
    // P-98: vita propria del pulviscolo — ogni punto oscilla e brilla col proprio ritmo
    // (dinamica visibile a riposo, senza toccare il volume reale della voce).
    p.y += sin(uTempo * (0.6 + aSeme * 0.9) + aSeme * 31.0) * (0.06 + aSeme * 0.12);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    // Dissolvenza sul fondo (lettura volumetrica) e assottigliamento verso il bordo esterno.
    float brillio = 0.7 + 0.3 * sin(uTempo * (1.1 + aSeme * 1.4) + aSeme * 19.0);
    vAlfa = smoothstep(-11.5, -2.5, mv.z) * (0.30 + uLivello * 0.35) * (1.0 - aRadius * 0.55) * brillio;
    // Dimensione prospettica: costante tarata per la camera a 6 unita' del riferimento.
    gl_PointSize = uDimensione * (1.0 + uLivello * 0.7) * (13.0 / -mv.z);
  }
`;
const frag = /* glsl */ `
  uniform vec3 uColore;
  uniform float uIntensita;
  varying float vAlfa;
  void main() {
    // Punti rotondi e morbidi.
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (r > 0.5) discard;
    float falloff = 1.0 - smoothstep(0.0, 0.5, r);
    gl_FragColor = vec4(uColore, vAlfa * falloff * uIntensita);
  }
`;

export interface Polvere {
  readonly group: THREE.Group;
  /** Punti della polvere (telemetria: `dust`). */
  readonly points: number;
  /** `livello`/`colore` da stato reale; `reducedMotion` ferma rotazione e tempo. */
  update(now: number, livello: number, colore: THREE.Color, reducedMotion: boolean): void;
  dispose(): void;
}

export function createPolvere(quality: 0 | 1 | 2): Polvere {
  const count = safeCount(DUST_COUNT[quality] ?? 0, DUST_MAX);
  const rnd = generatore(20261005);

  const pos = new Float32Array(count * 3);
  const semi = new Float32Array(count);
  const raggi = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Distribuzione uniforme sulla sfera, poi spinta in un guscio (potenza 2 del riferimento).
    const u = rnd() * 2 - 1;
    const t = rnd() * Math.PI * 2;
    const q = Math.sqrt(Math.max(0, 1 - u * u));
    const r = 1.9 + Math.pow(rnd(), 2) * 2.6;
    pos[i * 3] = Math.cos(t) * q * r;
    pos[i * 3 + 1] = u * r;
    pos[i * 3 + 2] = Math.sin(t) * q * r;
    semi[i] = rnd();
    raggi[i] = (r - 1.9) / 2.6;
  }

  const geometria = new THREE.BufferGeometry();
  geometria.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometria.setAttribute('aSeme', new THREE.BufferAttribute(semi, 1));
  geometria.setAttribute('aRadius', new THREE.BufferAttribute(raggi, 1));

  const materiale = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uTempo: { value: 0 },
      uLivello: { value: 0 },
      // P-88: punti piu' piccoli del riferimento per non velare il fondo (il riferimento della
      // cattura usa una nuvola piu' rada); la densita' resta quella della sorgente.
      uDimensione: { value: 1.4 },
      uIntensita: { value: 1 },
      uColore: { value: BLU.clone() }
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  const punti = new THREE.Points(geometria, materiale);
  punti.frustumCulled = false;
  const group = new THREE.Group();
  group.add(punti);

  const tinta = new THREE.Color();
  let tempo = 0;
  let ultimo = 0;
  return {
    group,
    points: count,
    update(now, livello, colore, reducedMotion) {
      const dt = ultimo === 0 ? 0.016 : Math.min(0.05, (now - ultimo) / 1000);
      ultimo = now;
      if (!reducedMotion) tempo += dt;
      (materiale.uniforms['uTempo'] as { value: number }).value = tempo;
      (materiale.uniforms['uLivello'] as { value: number }).value = safeUnit(livello);
      tinta.copy(BLU).lerp(colore, 0.25);
      (materiale.uniforms['uColore'] as { value: THREE.Color }).value.copy(tinta);
    },
    dispose() {
      geometria.dispose();
      materiale.dispose();
    }
  };
}
