// Pass post-processing del riferimento JARVIS (chiusura G7, P-79): UN solo `ShaderPass` fullscreen che
// unisce aberrazione cromatica, grana e vignetta dopo il bloom, con le stesse formule della catena
// `postprocessing`/`@react-three/postprocessing` usata dal JARVIS del proprietario
// (`C:\Users\matte\jarvis\src\scene\Scene.tsx`: ChromaticAberration offset (0.00035, 0.0005) senza
// radial modulation, Noise `opacity 0.035` in OVERLAY, Vignette `eskil:false` offset 0.22 darkness
// 0.95; MIT © 2026 Aditya Dewaskar). Nessuna dipendenza nuova: `three/addons` (già in uso). Le
// intensità scalano con la qualità (0 = nessun pass: a qualità 0 il composer non esiste) e il pass è
// **spento** con `reducedMotion` (nessuna grana/aberrazione; la vignetta CSS resta).
//
// Adattamento alla catena di VISIONE: il pass vive DOPO `OutputPass`, quindi lavora in sRGB come li
// vede l'occhio; da P-90 la grana avanza col tempo mentre la scena è visibile (il ciclo gira sempre) e
// si ferma con `reducedMotion` o a vista nascosta.
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/** Offset dell'aberrazione cromatica del riferimento (coppia per R e B; il verde resta fermo). */
export const CA_OFFSET: readonly [number, number] = [0.00035, 0.0005];
/** Opacità della grana in OVERLAY (riferimento: 0.035). */
export const NOISE_OPACITY = 0.035;
/** Vignetta del riferimento (tecnica DEFAULT, `eskil:false`). */
export const VIGNETTE_OFFSET = 0.22;
export const VIGNETTE_DARKNESS = 0.95;

export interface PostParams {
  readonly ca: readonly [number, number];
  readonly noise: number;
  /** Quanto della vignetta del riferimento applicare (0 = nessuna). */
  readonly vignette: number;
}

/** Intensità adattive per qualità 0/1/2: a qualità 0 non c'è composer né pass. */
export function postParams(quality: 0 | 1 | 2): PostParams {
  if (quality <= 0) return { ca: [0, 0], noise: 0, vignette: 0 };
  const k = quality === 2 ? 1 : 0.6;
  return { ca: [CA_OFFSET[0] * k, CA_OFFSET[1] * k], noise: NOISE_OPACITY * k, vignette: quality === 2 ? 1 : 0.65 };
}

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2  uOffset;            // aberrazione cromatica (R e B; il verde resta fermo)
  uniform float uAspetto;           // width/height del canvas, come l'effetto del riferimento
  uniform float uRumore;            // opacità dell'overlay
  uniform float uTempo;             // grana animata mentre la scena disegna
  uniform float uVignetta;          // 1 = vignetta del riferimento piena, 0 = spenta
  uniform float uVignettaOffset;
  uniform float uVignettaDarkness;
  varying vec2 vUv;

  // Stessa rand() del common shader di three.js usata dal NoiseEffect del riferimento.
  float rand(const in vec2 uv) {
    const highp float a = 12.9898;
    const highp float b = 78.233;
    const highp float c = 43758.5453;
    highp float dt = dot(uv.xy, vec2(a, b));
    highp float sn = mod(dt, 3.141592653589793);
    return fract(sin(sn) * c);
  }

  // BlendFunction.OVERLAY (postprocessing): dst = colore, src = rumore.
  vec3 overlay(const in vec3 base, const in vec3 blend) {
    vec3 a = 2.0 * blend * base;
    vec3 b = 1.0 - 2.0 * (1.0 - blend) * (1.0 - base);
    return mix(a, b, step(vec3(0.5), base));
  }

  void main() {
    // 1. Aberrazione cromatica: shift = offset * vec2(1, aspect) (radialModulation false).
    vec2 shift = uOffset * vec2(1.0, uAspetto);
    vec4 col = vec4(0.0);
    col.r = texture2D(tDiffuse, vUv + shift).r;
    col.g = texture2D(tDiffuse, vUv).g;
    col.b = texture2D(tDiffuse, vUv - shift).b;
    col.a = texture2D(tDiffuse, vUv).a;

    // 2. Grana in overlay al valore del riferimento (0.035), animata come il NoiseEffect.
    float n = rand(vUv * (1.0 + uTempo));
    col.rgb = mix(col.rgb, overlay(col.rgb, vec3(n)), uRumore);

    // 3. Vignetta (tecnica DEFAULT: smoothstep(0.8, offset*0.799, d*(darkness+offset))).
    float d = distance(vUv, vec2(0.5));
    float v = smoothstep(0.8, uVignettaOffset * 0.799, d * (uVignettaDarkness + uVignettaOffset));
    col.rgb *= mix(1.0, v, uVignetta);

    gl_FragColor = col;
  }
`;

export interface Post {
  readonly pass: ShaderPass;
  /** True quando il pass disegna: spento da `reducedMotion` (telemetria/test). */
  readonly active: boolean;
  /** Accende/spegne il pass (moto ridotto): il composer salta i pass disabilitati. */
  setActive(on: boolean): void;
  setAspect(aspect: number): void;
  update(now: number): void;
  dispose(): void;
}

export function createPost(quality: 0 | 1 | 2): Post | null {
  const params = postParams(quality);
  if (params.vignette <= 0 && params.noise <= 0 && params.ca[0] === 0 && params.ca[1] === 0) return null;
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uOffset: { value: new THREE.Vector2(params.ca[0], params.ca[1]) },
      uAspetto: { value: 1 },
      uRumore: { value: params.noise },
      uTempo: { value: 0 },
      uVignetta: { value: params.vignette },
      uVignettaOffset: { value: VIGNETTE_OFFSET },
      uVignettaDarkness: { value: VIGNETTE_DARKNESS }
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT
  });
  let active = true;
  return {
    pass,
    get active() { return active; },
    setActive(on) {
      active = on;
      pass.enabled = on;
    },
    setAspect(aspect) {
      const u = pass.uniforms['uAspetto'] as { value: number };
      u.value = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
    },
    update(now) {
      if (!active) return;
      (pass.uniforms['uTempo'] as { value: number }).value = Number.isFinite(now) ? now / 1000 : 0;
    },
    dispose() {
      pass.dispose();
    }
  };
}
