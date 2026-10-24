// Shader del reattore e mappa degli stati reali (fase G3, P-75). Estratto da `Reactor.tsx` per essere
// usato da due composizioni con lo STESSO shader: il mini-reactor delle card/finestre (un suo
// contesto WebGL) e il nucleo centrale della scena Neural (`neural/nucleo.ts`, stesso contesto della
// scena). Porting in three.js puro dello shader polare MIT di `jarvis_opensource`
// (`C:\Users\matte\jarvis\src\scene\Core.tsx`, © 2026 Aditya Dewaskar, licenza MIT; nel fork anche
// `src/scene/Scene.tsx` per spin/`uOpen`/bloom). Nessun dato inventato: qui vivono solo il disegno e
// la mappa degli stati reali (`CoreStateSnapshot` → colore/intensità/velocità).
import type { CoreStateSnapshot } from '../../shared/contracts/index.ts';

export type ReactorState = 'idle' | 'planning' | 'working' | 'error' | 'listening' | 'speaking';

export const REACTOR_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const REACTOR_FRAGMENT = /* glsl */ `
  uniform vec3  uColor;
  uniform vec3  uHot;
  uniform float uLevel;
  uniform float uPhase;
  uniform float uOpen;
  uniform float uZoom;
  uniform float uIntensity;
  uniform float uStyle;
  varying vec2 vUv;

  vec2 hash(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(dot(hash(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
          dot(hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
      mix(dot(hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
          dot(hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
      u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0; float a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
    return v;
  }
  float band(float r, float r0, float w) { return exp(-pow((r - r0) / w, 2.0)); }
  #define TAU 6.28318530718

  void main() {
    vec2 p = (vUv * 2.0 - 1.0) * uZoom;
    float r = length(p);
    float a = atan(p.y, p.x);
    vec2 ring = vec2(cos(a), sin(a));

    float wob   = fbm(ring * 2.6 + vec2(uPhase * 0.22, 0.0)) * 0.055;
    float grain = fbm(ring * 9.0 - vec2(uPhase * 0.4, 0.0)) * 0.020;
    float R = 0.74 + wob + grain + uLevel * 0.03;
    float erode = smoothstep(-0.25, 0.35, fbm(ring * 5.0 + vec2(uPhase * 0.5, 3.0)));

    float wSphere = clamp(1.0 - abs(uStyle - 1.0), 0.0, 1.0);
    float wWire   = clamp(1.0 - abs(uStyle - 2.0), 0.0, 1.0);
    float kOutline = mix(1.0, 0.45, wSphere) * mix(1.0, 0.70, wWire);
    float kDust    = mix(1.0, 0.30, wSphere) * mix(1.0, 0.80, wWire);
    float kLines   = mix(1.0, 0.35, wSphere) * mix(1.0, 3.00, wWire);
    float kMesh    = mix(1.0, 0.60, wSphere) * mix(1.0, 2.60, wWire);
    float kWash    = mix(1.0, 1.60, wSphere) * mix(1.0, 0.00, wWire);
    float kGlow    = mix(1.0, 2.20, wSphere) * mix(1.0, 0.30, wWire);

    float outer = band(r, R, 0.030) * (0.45 + erode * 0.6);
    float wall  = band(r, R - 0.055, 0.020) * 0.5;
    float edge  = band(r, R + 0.004, 0.007) * (0.5 + uLevel * 0.45);
    float speck = fbm(ring * 46.0 + vec2(uPhase * 0.15, 11.0));
    speck = pow(max(speck, 0.0), 3.0);
    float dust = speck * band(r, R + 0.028, 0.055) * (1.4 + uLevel);

    float sweepA = mod(uPhase * 0.55, TAU);
    float dA = mod(a - sweepA + TAU + 3.14159, TAU) - 3.14159;
    float wake = smoothstep(-2.6, -0.15, dA) * (1.0 - smoothstep(0.0, 0.22, dA));
    float radar = wake * band(r, R - 0.02, 0.075) * (0.55 + uLevel * 0.45);

    float lines = band(r, 0.615, 0.0035) * 0.45 + band(r, 0.560, 0.0030) * 0.28 + band(r, 0.470, 0.0035) * 0.36;
    float m1 = (sin(a * 96.0 + uPhase * 0.6) * 0.5 + 0.5) * (sin(r * 210.0) * 0.5 + 0.5);
    float m2 = (sin(a * 60.0 - uPhase * 0.4) * 0.5 + 0.5) * (sin(r * 150.0 - uPhase) * 0.5 + 0.5);
    float mesh = mix(m1, m2, 0.5);
    float core = smoothstep(0.40, 0.36, r);
    // G3 (P-75): nel centro della scena Neural il disco deve leggersi come nucleo luminoso anche a
    // riposo (il riferimento lo lascia più vuoto): un velo pieno sotto il disco tessuto.
    // G7 (P-78): il velo sale un poco e il bloom centrale si allarga, così il nodo reale del
    // Director al centro (viola) si legge come punto caldo del nucleo invece che come disco piatto.
    float coreFill = core * (0.15 + uLevel * 0.12);
    float coreTex = core * (0.06 * kWash + mesh * 0.16 * kMesh) * (0.55 + uLevel * 0.9);
    float coreEdge = band(r, 0.385, 0.010) * (0.65 + uLevel * 0.5);
    float pulse = band(r, fract(uPhase * 0.08) * 0.40, 0.020) * core * 0.55;
    float bloom = exp(-r * 3.4) * (0.32 + uLevel * 0.30);
    float bodyFill = wSphere * smoothstep(R + 0.02, R - 0.32, r) * (0.10 + uLevel * 0.10);

    float v = (outer + wall + edge + coreEdge) * kOutline + dust * kDust + radar + lines * kLines + coreFill + coreTex + pulse + bloom * kGlow + bodyFill;
    vec3 col = mix(uColor, uHot, clamp(edge * 1.3 + radar * 0.85 + pulse * 0.5 + dust * 0.4, 0.0, 1.0));
    v *= smoothstep(0.0, 0.35, uOpen - r * 0.45);
    v *= uIntensity;
    gl_FragColor = vec4(col * v, v);
  }
`;

export const REACTOR_COLOR: Record<ReactorState, string> = {
  idle: '#19c4c4',
  planning: '#19c4c4',
  working: '#2bd6a8',
  error: '#e5534b',
  listening: '#4aa8ff',
  speaking: '#00e5ff'
};
export const REACTOR_INTENSITY: Record<ReactorState, number> = { idle: 0.72, planning: 0.9, working: 1, error: 1.1, listening: 0.92, speaking: 1.05 };
/** Velocità dello sweep per stato reale (adattata da `spinFor` di `Scene.tsx`: dormant 0.25 ·
 *  listening 1.1 · speaking 1.4 · thinking 2.8 · tooling 3.6; l'errore resta agitato). */
export const REACTOR_SPIN: Record<ReactorState, number> = { idle: 0.25, planning: 2.8, working: 3.6, error: 3.0, listening: 1.1, speaking: 1.4 };

/** Stato reale del reattore: la voce prima di tutto (Fase 23), poi Director ed errore recente.
 *  La finestra di freschezza è la stessa della scena (`SIGNAL_WINDOW_MS = 6s`): una decisione vecchia
 *  non lascia il reattore in «planning» per sempre. */
const FRESH_MS = 6_000;
export function reactorState(core: CoreStateSnapshot | null): ReactorState {
  if (!core) return 'idle';
  if (core.voice.speaking !== null) return 'speaking';
  if (core.voice.listening) return 'listening';
  if (core.error.last && Date.now() - core.error.last.at < FRESH_MS) return 'error';
  if (core.director.activeGoals > 0) return 'working';
  const last = core.director.lastDecision;
  if (last && Date.now() - last.at < FRESH_MS) return 'planning';
  return 'idle';
}
