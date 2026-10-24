// Disegno della scena Neural 3D di VISIONE — riscritta da zero in P-88 sulla SPECIFICA VISIVA
// dell'edizione JARVIS di Munder (MIT © 2026 Aditya Dewaskar; vedi
// `docs/decisions/LICENZE_E_PROVENIENZA.md`). La composizione e' quella del riferimento:
//
//   - camera a (0,0,6.2), fov 45, deriva lenta come `scene/Scene.tsx` (sin 0,13 / cos 0,17);
//   - al centro la Sfera di particelle a scala MONDO 1 (`sfera.ts`: gusci, archi laterali,
//     fascio, filamenti) con il suo nucleo luminoso al centro del fascio;
//   - attorno, la polvere atmosferica (`polvere.ts`, raggio 1,9–4,5);
//   - gli AGENTI sono i nodi reali del grafo, disegnati con lo shader a punti di `scene/Rete.tsx`
//     (dimensione e colore per vertice, disco morbido additivo), disposti sul globo dal layout;
//   - gli archi sono quelli degli eventi reali, con la luminosita' del riferimento ricavata dal
//     numero reale di eventi; gli impulsi hanno la scia di 7 particelle dello STESSO evento;
//   - bloom 0,6 / soglia 0,4 / raggio 0,42 con mipmapBlur + aberrazione cromatica + grana +
//     vignetta del riferimento (`post.ts`).
//
// Regole della casa: niente stato React per fotogramma (tutto mutato qui), qualita' adattiva, P-90:
// movimento ambientale SEMPRE attivo mentre la vista e' visibile (deriva, rotazione, scintillio),
// attivazione piu' marcata SOLO con stati voce reali, impulsi solo da eventi reali; `reducedMotion`
// spegne deriva, pass post e tempo dei punti; la vista nascosta mette il ciclo in pausa.
// Interazione: proiezione dei nodi in pixel CSS (niente raycast), hover con label e cursore, click =
// selezione/pannello (tecnica del riferimento).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { EdgeView, NodeView, PulseView } from './engine.ts';
import { createSfera, type Sfera } from './sfera.ts';
import { approachAngle, FOCUS_SCALE, focusOrbit, type Orbit } from './focus.ts';
import { createPolvere, type Polvere } from './polvere.ts';
import { createPost, type Post } from './post.ts';
import { createPixelOfficeRenderer } from './pixel-office.ts';
import { leggeroSalta, QUALITA_ASSESTAMENTO, QUALITA_FINESTRA, qualitaPasso } from './qualita.ts';
import { voiceActivation } from './voce.ts';
import { safeCount, safeUnit } from '../lib/safe.ts';
import { systemState, type DirectorState, type GraphNode, type SystemSignals } from './graph.ts';
import type { ReactorState } from '../reactor/shader.ts';

export type ContextState = 'ok' | 'lost' | 'restored' | 'unavailable';

/**
 * Variante della scena Neural (P-89): `jarvis` è la scena dei sorgenti JARVIS di Munder (P-88,
 * default); `pixel-office` è il globo dell'overlay dell'ufficio pixel di Munder
 * (`munder-patch/rete-neural/rete-neurale.js`, MIT): SFERA 3.200 + 7 strati + 4 anelli + 9.000
 * particelle. La scelta arriva da `ui.scene` (config) e si applica a caldo con `setScene`.
 */
export type SceneVariant = 'jarvis' | 'pixel-office';

/** Variante di scena reale dalla configurazione caricata (P-89): `jarvis` se assente o non valida. */
export function sceneOf(config: Record<string, unknown>): SceneVariant {
  const ui = config.ui;
  if (ui === null || typeof ui !== 'object' || Array.isArray(ui)) return 'jarvis';
  return (ui as Record<string, unknown>).scene === 'pixel-office' ? 'pixel-office' : 'jarvis';
}

export interface SceneStats {
  fps: number | null;
  quality: 0 | 1 | 2;
  nodes: number;
  edges: number;
  pulsesActive: number;
  pulsesTotal: number;
  pulsesDropped: number;
  frames: number;
  context: ContextState;
  restores: number;
  animating: boolean;
  qualityChanges: number;
  /** Nodi con alone del riferimento (Director, VISIONE, agenti): telemetria dello shader a punti. */
  glow: number;
  /** Stato reale del coordinatore derivato dagli eventi. */
  director: DirectorState;
  /** Stato reale del reactor centrale (Director + voce). */
  reactor: ReactorState;
  /** Nessun reveal: la Sfera di Munder e' sempre intera (campo mantenuto per la UI). */
  open: number;
  spin: number;
  /** Nodo selezionato e nodo sotto il puntatore (id reali). */
  selected: string | null;
  hover: string | null;
  /** Vertici della Sfera e della polvere; niente starfield in P-88 (il campo e' la polvere). */
  core: number;
  /** Agente inquadrato da vicino (zoom sull'agente) e quanto la sua sfera è cresciuta (0–1). */
  focus?: string | null;
  focusGrow?: number;
  ambient: number;
  /** Particelle di scia disegnate (posizioni passate dello stesso impulso). */
  trail: number;
  dust: number;
  rings: number;
  stars: number;
  /** Pass rumore+aberrazione+vignetta attivo (spento da `reducedMotion` o a qualita' 0). */
  post: boolean;
  /** Attivazione REALE della scena dalla voce (P-90): 0 a riposo, sale con parlato/ascolto. */
  voice: number;
}

export interface Label {
  id: string;
  text: string;
  kind: GraphNode['kind'];
  status: string;
  x: number;
  y: number;
  /** Centro del nodo in pixel CSS (per l'interazione/raycast), distinto dall'ancora della label. */
  nx: number;
  ny: number;
  /** Raggio del globo in pixel CSS: la label parte appena fuori, come `.rete-etichetta` di Munder. */
  r: number;
  /** Ultimo evento reale del nodo (ms): età del segnale nel popover di hover (P-98). */
  lastEventAt: number;
  /** Nodo selezionato o sotto il puntatore (per lo stile). */
  hot: boolean;
}

/** Scena disegnata (una delle varianti): stato, interazione e ciclo di vita. */
export interface SceneRenderer {
  setGraph(nodes: NodeView[], edges: EdgeView[], signals: SystemSignals): void;
  addPulses(pulses: PulseView[]): void;
  resize(width: number, height: number): void;
  labels(): Label[];
  stats(): SceneStats;
  setSelection(id: string | null): void;
  /** Stato reale del reactor o livello voce cambiati: sveglia il ciclo (no-op se gira). */
  wake(): void;
  /** Vista visibile/nascosta (P-90): a vista nascosta il ciclo si mette in pausa, al ritorno riparte. */
  setActive(on: boolean): void;
  /** Moto ridotto acceso/spento a caldo (spegne deriva e pass post senza ricostruire la scena). */
  setReducedMotion(on: boolean): void;
  /** Modalità leggera (`ui.light`, a caldo): qualità minima fissa e al massimo ~30 fotogrammi al secondo. */
  setLight(on: boolean): void;
  pickAt(clientX: number, clientY: number): string | null;
  dispose(): void;
}

/**
 * Punto d'ingresso della UI (P-89): sceglie la variante (`jarvis` | `pixel-office`) e la può
 * cambiare a caldo con `setScene` ricostruendo solo la scena, senza toccare motore e journal.
 */
export interface NeuralRenderer extends SceneRenderer {
  setScene(scene: SceneVariant): void;
}

export interface RendererOpts {
  reducedMotion: boolean;
  /** Variante della scena (P-89): default `jarvis`. */
  scene?: SceneVariant;
  /** Stato reale del reactor e livello voce, letti per fotogramma senza stato React. */
  reactor?: { state: ReactorState; level: number };
  /** Livello REALE per fotogramma (0..1): uscita TTS o microfono in ascolto (P-90). */
  level?: () => number;
  onStats?: (s: SceneStats) => void;
  onHover?: (id: string | null) => void;
  onSelect?: (id: string | null) => void;
  /** La camera si sta spostando (zoom sull'agente): le etichette vanno riproiettate. Al più ogni
   *  80 ms durante il volo, più una chiamata finale a camera ferma. */
  onView?: () => void;
}

/** Durata di un impulso: 1.200 ms come `Rete.tsx` di Munder. */
export const PULSE_MS = 1_200;
export const EDGE_FADE_MS = 8_000;
const MAX_NODES = 512;
const MAX_EDGES = 1_024;
/** Scia di un impulso: 7 particelle a qualita' piena (Munder), meno alle qualita' ridotte. */
const TRAIL_BY_QUALITY: readonly [number, number, number] = [4, 6, 7];
const trailFor = (q: 0 | 1 | 2): number => safeCount(TRAIL_BY_QUALITY[q] ?? 4, 7, 4);
/** Ritardo della coda in frazione della durata (Munder `SCIA_RITARDO`). */
const TRAIL_LAG = 0.16;
/** Camera del riferimento: posizione 6,2 e fov 45. */
export const CAMERA_Z = 6.2;
export const CAMERA_FOV = 45;
const QUALITY = [
  { pixelRatio: 0.5, pulses: 80 },
  { pixelRatio: 0.75, pulses: 200 },
  { pixelRatio: 1, pulses: 480 }
] as const;
/** Bloom del riferimento (`Scene.tsx`: 0,6 / soglia 0,4 / raggio 0,42, mipmapBlur); P-88 iter2:
 *  raggio e soglia più stretti per non allagare il vuoto interno del globo (misurato sul profilo
 *  radiale contro la cattura di Munder). */
export const BLOOM_STRENGTH = 0.55;
export const BLOOM_THRESHOLD = 0.55;
export const BLOOM_RADIUS = 0.3;

/** Colori dei nodi: la palette blu del riferimento, con gli stati leggibili. */
export const NODE_COLORS = {
  director: 0x7fd4ff,
  visione: 0xa78bfa,
  agent: 0x3f9fe0,
  working: 0xe6f8ff,
  error: 0xff6b6b,
  gone: 0x33414d,
  tool: 0xffffff,
  task: 0x6f93b8,
  memory: 0x9fdcff,
  process: 0x5f7f9f,
  approval: 0xffd479
} as const;
/**
 * P-100 — Colori dei globi AGENTE dallo stato reale, stessa semantica della scena ufficio pixel:
 * verde = vivo e senza problemi, rosso = problema (errore/crash/limite), bianco = spento o mai avviato.
 */
export const AGENT_GLOBE_COLORS = {
  alive: 0x35e07a,
  working: 0x7dffb2,
  problem: 0xff6b6b,
  off: 0xf2f7fa
} as const;
export const PULSE_COLORS = {
  message: 0x9fe8ff,
  delega: 0xffd479,
  risultato: 0x7dffb2,
  strumento: 0xffffff
} as const;

const WORKING_STATUS: ReadonlySet<string> = new Set(['working', 'running', 'starting']);
const ERROR_STATUS: ReadonlySet<string> = new Set(['error', 'failed', 'crashed', 'denied', 'blocked', 'timed_out', 'timeout']);
const GONE_STATUS: ReadonlySet<string> = new Set(['stopped', 'cancelled', 'exited', 'gone', 'archived', 'expired']);

/** Dimensione base dei nodi in unita' shader (`Rete.tsx`: direttore 2,4; agente 1,5; spento ×0,45). */
const BASE_SIZE: Record<GraphNode['kind'], number> = {
  visione: 2,
  // Il Director è il centro della scena: ben più grande degli agenti (1,5× uno che lavora, 2× uno fermo).
  // Non di più: il globo è un punto con il bagliore, e la sua area costa fotogrammi (prova e2e a 60 fps).
  director: 3.2,
  agent: 1.5,
  tool: 0.9,
  task: 0.95,
  memory: 1.4,
  process: 0.8,
  approval: 1.1
};

/**
 * Colore di un nodo da tipo e stato REALI (puro: provato nei test). P-100: i globi agente usano la
 * semantica verde/rosso/bianco; `alert` è il problema reale che non cambia lo stato (limite di quota).
 */
export function nodeColorFor(kind: GraphNode['kind'], status: string, alert = false): number {
  if (kind === 'agent') {
    if (alert || ERROR_STATUS.has(status)) return AGENT_GLOBE_COLORS.problem;
    if (GONE_STATUS.has(status) || status === 'created') return AGENT_GLOBE_COLORS.off;
    return status === 'working' || status === 'running' ? AGENT_GLOBE_COLORS.working : AGENT_GLOBE_COLORS.alive;
  }
  if (ERROR_STATUS.has(status)) return NODE_COLORS.error;
  if (kind === 'director') return NODE_COLORS.director;
  if (kind === 'visione') return NODE_COLORS.visione;
  if (GONE_STATUS.has(status)) return NODE_COLORS.gone;
  return NODE_COLORS[kind] ?? NODE_COLORS.agent;
}

/** Dimensione di un nodo da tipo e stato REALI (puro: provato nei test). */
export function nodeSizeFor(kind: GraphNode['kind'], status: string): number {
  let s = BASE_SIZE[kind] ?? 1;
  // Director e VISIONE non si rimpiccioliscono quando sono in pausa: restano il centro (11/10/2026).
  if (kind === 'director' || kind === 'visione') return s;
  if (WORKING_STATUS.has(status)) s = Math.max(s, kind === 'agent' ? 2.1 : 1.6);
  if (GONE_STATUS.has(status)) s *= 0.45;
  return s;
}

/** Colore di un impulso dalla causa REALE (stessa semantica di `Rete.tsx`). */
export function pulseColorFor(type: string): number {
  if (type === 'task.assigned' || type === 'director.decision' || type === 'director.plan.created') return PULSE_COLORS.delega;
  if (type === 'task.result.recorded') return PULSE_COLORS.risultato;
  if (type.startsWith('tool.')) return PULSE_COLORS.strumento;
  return PULSE_COLORS.message;
}

/** Shader dei punti del riferimento (`Rete.tsx`): disco morbido additivo con dimensione per vertice. */
const PUNTI_VERTEX = /* glsl */ `
  attribute float size;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const PUNTI_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    float a = exp(-r * r * 16.0) + 0.22 * exp(-r * r * 3.0);
    gl_FragColor = vec4(vColor, a);
  }
`;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function createJarvisRenderer(canvas: HTMLCanvasElement, opts: RendererOpts): SceneRenderer {
  let quality: 0 | 1 | 2 = 2;
  let motionOff = opts.reducedMotion;
  /** Modalità leggera (`ui.light`): qualità minima fissa e ~30 fotogrammi al secondo. */
  let light = false;
  /** Vista visibile (P-90): a vista nascosta il ciclo si ferma; a vista visibile gira SEMPRE. */
  let active = true;
  let context: ContextState = 'ok';
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
  let trailCount = 0;
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
  let camAz = 0;
  let camEl = 0;
  let camDist = CAMERA_Z;
  const camTarget = new THREE.Vector3();
  const desiredTarget = new THREE.Vector3();
  // Zoom sull'agente: agente inquadrato, orbita da ripristinare alla chiusura, orbita verso cui la
  // camera si sta muovendo (null = ferma o in mano all'utente), crescita della sfera dell'agente.
  let focusId: string | null = null;
  let savedOrbit: Orbit | null = null;
  let goal: Orbit | null = null;
  let grow = 0;
  let viewMoving = false;
  let lastViewAt = 0;
  const focusPos = new THREE.Vector3();
  const agentTint = new THREE.Color();
  let pointerDown = false;
  let downX = 0;
  let downY = 0;
  let moved = false;
  let elapsed = 0;

  let gl: {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    nodePoints: THREE.Points;
    nodeGeom: THREE.BufferGeometry;
    edgeLines: THREE.LineSegments;
    pulsePoints: THREE.Points;
    pulseGeom: THREE.BufferGeometry;
    pointMaterial: THREE.ShaderMaterial;
    sfera: Sfera;
    /** Sfera dell'agente inquadrato: la stessa costruzione e la stessa qualità della centrale. */
    agentSfera: Sfera;
    polvere: Polvere;
    composer: EffectComposer | null;
    bloomPass: UnrealBloomPass | null;
    post: Post | null;
  } | null = null;

  const color = new THREE.Color();
  const v = new THREE.Vector3();
  const world = new THREE.Vector3();

  const build = (): void => {
    const q = QUALITY[quality] as (typeof QUALITY)[number];
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 2, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    renderer.setPixelRatio(Math.max(0.5, (window.devicePixelRatio || 1) * q.pixelRatio));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x01060c, 1);
    const scene = new THREE.Scene();
    // Niente luci e niente nebbia: come il riferimento, tutto e' ShaderMaterial additivo.
    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, width / Math.max(1, height), 0.1, 200);

    // Punti dei nodi: buffer di dimensione fissa riscritti sul posto, mai ricreati per evento.
    const nodeGeom = new THREE.BufferGeometry();
    nodeGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_NODES * 3), 3, false).setUsage(THREE.DynamicDrawUsage));
    nodeGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_NODES * 3), 3, false).setUsage(THREE.DynamicDrawUsage));
    nodeGeom.setAttribute('size', new THREE.BufferAttribute(new Float32Array(MAX_NODES), 1, false).setUsage(THREE.DynamicDrawUsage));
    nodeGeom.setDrawRange(0, 0);

    const pointMaterial = new THREE.ShaderMaterial({
      vertexShader: PUNTI_VERTEX,
      fragmentShader: PUNTI_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true
    });
    const nodePoints = new THREE.Points(nodeGeom, pointMaterial);
    nodePoints.frustumCulled = false;

    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_EDGES * 6), 3, false).setUsage(THREE.DynamicDrawUsage));
    edgeGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_EDGES * 6), 3, false).setUsage(THREE.DynamicDrawUsage));
    edgeGeom.setDrawRange(0, 0);
    const edgeLines = new THREE.LineSegments(
      edgeGeom,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    edgeLines.frustumCulled = false;

    // Impulsi: punti con lo stesso shader dei nodi; capacita' fissa (qualita' 2 × scia piena).
    const maxPulseVerts = (QUALITY[2] as (typeof QUALITY)[number]).pulses * trailFor(2);
    const pulseGeom = new THREE.BufferGeometry();
    pulseGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPulseVerts * 3), 3, false).setUsage(THREE.DynamicDrawUsage));
    pulseGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxPulseVerts * 3), 3, false).setUsage(THREE.DynamicDrawUsage));
    pulseGeom.setAttribute('size', new THREE.BufferAttribute(new Float32Array(maxPulseVerts), 1, false).setUsage(THREE.DynamicDrawUsage));
    pulseGeom.setDrawRange(0, 0);
    const pulsePoints = new THREE.Points(pulseGeom, pointMaterial);
    pulsePoints.frustumCulled = false;

    // Sfera e polvere alla scala del riferimento (mondo 1).
    const sfera = createSfera(quality);
    const polvere = createPolvere(quality);
    const agentSfera = createSfera(quality);
    agentSfera.group.visible = false;

    scene.add(edgeLines, sfera.group, agentSfera.group, polvere.group, nodePoints, pulsePoints);

    // Bloom del riferimento; qualita' 0 = nessun composer. `multisampling` 0: niente bordi duri da
    // smussare in una scena di blob additivi e punti morbidi (stessa scelta di `Scene.tsx`).
    let composer: EffectComposer | null = null;
    let bloomPass: UnrealBloomPass | null = null;
    let post: Post | null = null;
    if (quality > 0) {
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        quality === 2 ? BLOOM_STRENGTH : BLOOM_STRENGTH * 0.6,
        BLOOM_RADIUS,
        BLOOM_THRESHOLD
      );
      (bloomPass as unknown as { mipmapBlur: boolean }).mipmapBlur = true;
      composer.addPass(bloomPass);
      composer.addPass(new OutputPass());
      post = createPost(quality);
      if (post) {
        post.setAspect(width / Math.max(1, height));
        post.setActive(!motionOff);
        composer.addPass(post.pass);
      }
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(width, height);
    }
    gl = { renderer, scene, camera, nodePoints, nodeGeom, edgeLines, pulsePoints, pulseGeom, pointMaterial, sfera, agentSfera, polvere, composer, bloomPass, post };
    // P-92: la scena appena costruita non è ancora a regime (shader da compilare, buffer nuovi):
    // le prime finestre non si misurano e l'isteresi riparte da zero.
    window_.length = 0;
    qualita.buone = 0;
    qualita.cattive = 0;
    settleFrames = QUALITA_ASSESTAMENTO;
  };

  /** Posizione della camera: orbita utente sopra la deriva lenta del riferimento. */
  const placeCamera = (): void => {
    if (!gl) return;
    // La deriva è in proporzione alla distanza: da vicino all'agente non deve far ballare l'inquadratura.
    const drift = camDist / CAMERA_Z;
    const driftX = motionOff ? 0 : Math.sin(elapsed * 0.13) * 0.35 * drift;
    const driftY = motionOff ? 0 : Math.cos(elapsed * 0.17) * 0.22 * drift;
    const ce = Math.cos(camEl);
    gl.camera.position.set(
      camTarget.x + Math.sin(camAz) * ce * camDist + driftX,
      camTarget.y + Math.sin(camEl) * camDist + driftY,
      camTarget.z + Math.cos(camAz) * ce * camDist
    );
    gl.camera.lookAt(camTarget);
  };

  /** Raggio in pixel CSS del globo di un nodo (stessa formula dello shader, per label e pick). */
  const screenRadius = (size: number, distance: number): number => {
    const dpr = gl?.renderer.getPixelRatio() ?? 1;
    return (size * 300) / Math.max(distance, 0.001) / dpr / 2;
  };

  /** Scrive posizioni, colori e dimensioni dei nodi (un'unica draw call di punti). */
  const writeNodes = (): void => {
    if (!gl) return;
    const geom = gl.nodeGeom;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const col = geom.getAttribute('color') as THREE.BufferAttribute;
    const siz = geom.getAttribute('size') as THREE.BufferAttribute;
    const n = Math.min(nodes.length, MAX_NODES);
    let glow = 0;
    for (let i = 0; i < n; i++) {
      const node = nodes[i] as NodeView;
      // L'agente inquadrato da vicino è il nucleo della sua sfera: niente ingrandimento da selezione.
      const hot = node.id === focusId ? 0.8 : node.id === selectedId ? 1.6 : node.id === hoverId ? 1.35 : 1;
      const size = nodeSizeFor(node.kind, node.status) * hot;
      pos.setXYZ(i, node.position[0], node.position[1], node.position[2]);
      color.setHex(hot > 1 ? 0xffffff : nodeColorFor(node.kind, node.status, node.alert === true));
      col.setXYZ(i, color.r, color.g, color.b);
      siz.setX(i, size);
      if (node.kind === 'director' || node.kind === 'visione' || node.kind === 'agent') glow++;
    }
    geom.setDrawRange(0, n);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    siz.needsUpdate = true;
    glowCount = glow;
  };

  /** Archi: luminosita' dal numero reale di eventi e dissolvenza dal tempo reale. */
  const writeEdges = (now: number): boolean => {
    if (!gl) return false;
    const geom = gl.edgeLines.geometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const col = geom.getAttribute('color') as THREE.BufferAttribute;
    const count = Math.min(edges.length, MAX_EDGES);
    let fading = false;
    for (let i = 0; i < count; i++) {
      const e = edges[i] as EdgeView;
      const age = now - e.lastEventAt;
      const recency = Math.max(0, 1 - age / EDGE_FADE_MS);
      const forza = Math.min(1, 0.25 + e.count * 0.08) * (0.25 + 0.75 * recency);
      if (age < EDGE_FADE_MS) fading = true;
      pos.setXYZ(i * 2, e.from[0], e.from[1], e.from[2]);
      pos.setXYZ(i * 2 + 1, e.to[0], e.to[1], e.to[2]);
      color.setHex(PULSE_COLORS.message).multiplyScalar(forza);
      col.setXYZ(i * 2, color.r, color.g, color.b);
      col.setXYZ(i * 2 + 1, color.r, color.g, color.b);
    }
    geom.setDrawRange(0, count * 2);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    return fading;
  };

  /** Impulsi: la testa piu' le posizioni passate dello STESSO evento (scia del riferimento). */
  const writePulses = (now: number): void => {
    if (!gl) return;
    const trail = trailFor(quality);
    for (let i = pulses.length - 1; i >= 0; i--) if (now - (pulses[i]?.start ?? now) > PULSE_MS) pulses.splice(i, 1);
    const geom = gl.pulseGeom;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const col = geom.getAttribute('color') as THREE.BufferAttribute;
    const siz = geom.getAttribute('size') as THREE.BufferAttribute;
    const cap = safeCount((QUALITY[quality] as (typeof QUALITY)[number]).pulses * trail, 4_000, 0);
    let j = 0;
    trailCount = 0;
    for (const p of pulses) {
      const t = Math.min(1, (now - p.start) / PULSE_MS);
      const base = pulseColorFor(p.type);
      for (let k = 0; k < trail; k++) {
        if (j >= cap) break;
        const tk = t - (k / trail) * TRAIL_LAG;
        if (tk < 0) break;
        if (opts.reducedMotion || p.from === p.to) v.set(p.toPos[0], p.toPos[1], p.toPos[2]);
        else {
          // Gobba: il flusso si legge come arco, non come una retta ferma (tecnica di `Rete.tsx`).
          const gobba = Math.sin(tk * Math.PI) * 0.22;
          v.set(
            p.fromPos[0] + (p.toPos[0] - p.fromPos[0]) * tk,
            p.fromPos[1] + (p.toPos[1] - p.fromPos[1]) * tk + gobba,
            p.fromPos[2] + (p.toPos[2] - p.fromPos[2]) * tk
          );
        }
        // Entra ed esce in dissolvenza e si spegne lungo la coda: la direzione si legge senza frecce.
        const coda = 1 - k / trail;
        const forza = Math.sin(tk * Math.PI) * coda * coda;
        color.setHex(base).multiplyScalar(Math.max(0, forza));
        pos.setXYZ(j, v.x, v.y, v.z);
        col.setXYZ(j, color.r, color.g, color.b);
        siz.setX(j, (k === 0 ? 1.8 : 1) * (0.45 + Math.max(0, forza)));
        if (k > 0) trailCount++;
        j++;
      }
    }
    geom.setDrawRange(0, j);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    siz.needsUpdate = true;
  };

  /** Idratazione dei punti: Sfera e polvere guidate da stato reale (Director + voce). */
  const writeGlobe = (now: number, state: DirectorState, attivo: number): void => {
    if (!gl) return;
    // Il blu del riferimento; solo l'errore reale tinge di rosso.
    const tinta = color.setHex(state === 'error' ? 0xff5a5a : 0x1c8cff);
    // `attivo` è l'inviluppo REALE del parlato/ascolto: gonfia la Sfera e respinge la polvere.
    const livello = Math.max(safeUnit(opts.reactor?.level ?? 0), coreEnergy, attivo);
    // Con un agente inquadrato la Sfera centrale resta dietro, attenuata: l'agente è in primo piano.
    gl.sfera.update(now, livello, tinta, motionOff, 1 - 0.65 * grow);
    gl.polvere.update(now, livello, tinta, motionOff);
    // Sfera dell'agente inquadrato: cresce dal suo nodo, segue la sua posizione, si tinge dello
    // stato REALE dell'agente (25%, come la centrale con la fase) e pulsa solo se sta lavorando.
    const focused = focusId !== null ? nodes.find((n) => n.id === focusId) : undefined;
    if (focused) focusPos.set(focused.position[0], focused.position[1], focused.position[2]);
    if (grow > 0.005) {
      gl.agentSfera.group.visible = true;
      gl.agentSfera.group.position.copy(focusPos);
      gl.agentSfera.setScale(FOCUS_SCALE * grow);
      agentTint.setHex(focused ? nodeColorFor(focused.kind, focused.status, focused.alert === true) : 0x1c8cff);
      const lavora = focused !== undefined && (focused.status === 'working' || focused.status === 'running');
      gl.agentSfera.update(now, lavora ? 0.55 : 0.12, agentTint, motionOff);
    } else gl.agentSfera.group.visible = false;
  };

  /** Zoom sull'agente: un agente selezionato si inquadra da vicino; altrimenti si torna a prima. */
  const refocus = (): void => {
    const node = selectedId !== null ? nodes.find((n) => n.id === selectedId) : undefined;
    if (node && node.kind === 'agent') {
      if (focusId === null) savedOrbit = { az: camAz, el: camEl, dist: camDist };
      focusId = node.id;
      goal = focusOrbit(node.position);
    } else if (focusId !== null) {
      focusId = null;
      goal = savedOrbit;
      savedOrbit = null;
    }
  };

  const orbitCamera = (dt: number): void => {
    const sel = selectedId !== null ? nodes.find((n) => n.id === selectedId) : undefined;
    if (sel) desiredTarget.set(sel.position[0], sel.position[1], sel.position[2]);
    else desiredTarget.set(0, 0, 0);
    // Col moto ridotto niente animazioni: la camera salta subito all'inquadratura.
    const k = motionOff ? 1 : Math.min(1, dt * 2.5);
    camTarget.lerp(desiredTarget, motionOff ? 1 : Math.min(1, dt * 3));
    if (goal) {
      camAz = approachAngle(camAz, goal.az, k);
      camEl += (goal.el - camEl) * k;
      camDist += (goal.dist - camDist) * k;
      if (Math.abs(approachAngle(camAz, goal.az, 1) - camAz) < 1e-3 && Math.abs(goal.el - camEl) < 1e-3 && Math.abs(goal.dist - camDist) < 1e-3) goal = null;
    }
    grow += ((focusId !== null ? 1 : 0) - grow) * (motionOff ? 1 : Math.min(1, dt * 3));
    placeCamera();
  };

  const publish = (): void => opts.onStats?.(api.stats());

  const directorAt = (now: number): DirectorState => systemState(signals, now);

  const render = (now: number): void => {
    if (!gl || context === 'lost' || context === 'unavailable') return;
    const dt = lastRenderAt > 0 ? Math.min(0.05, (now - lastRenderAt) / 1000) : 0.016;
    lastRenderAt = now;
    elapsed += dt;
    const state = directorAt(now);
    coreEnergy += ((state === 'idle' ? 0 : state === 'error' ? 0.72 : state === 'planning' ? 0.5 : 0.9) - coreEnergy) * Math.min(1, dt * 3);
    // Livello REALE (P-90): uscita TTS (analizzatore) e microfono in ascolto.
    const livelloReale = Math.max(safeUnit(opts.level?.() ?? 0), safeUnit(opts.reactor?.level ?? 0));
    voce = voiceActivation(opts.reactor?.state ?? state, livelloReale, dt, voce);
    orbitCamera(dt);
    const moving = goal !== null || (grow > 0.001 && grow < 0.999);
    if ((moving && now - lastViewAt >= 80) || (!moving && viewMoving)) {
      lastViewAt = now;
      opts.onView?.();
    }
    viewMoving = moving;
    writeGlobe(now, state, voce);
    writeEdges(now);
    writePulses(now);
    gl.post?.update(now);
    if (gl.composer) gl.composer.render();
    else gl.renderer.render(gl.scene, gl.camera);
    frames++;
  };

  const setQuality = (q: 0 | 1 | 2): void => {
    if (q === quality || !gl) return;
    quality = q;
    qualityChanges++;
    gl.renderer.dispose();
    disposeScene();
    build();
    writeNodes();
    render(Date.now());
  };

  /** Qualità adattiva (P-90; P-92): assestamento dopo la ricostruzione e isteresi. Il ciclo
   *  continuo a riposo non deve far oscillare la qualità: scende solo dopo finestre cattive
   *  CONSECUTIVE, così la resa a regime resta quella piena approvata (q2). */
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
    for (const geom of [gl.nodeGeom, gl.pulseGeom, gl.edgeLines.geometry]) geom.dispose();
    gl.pointMaterial.dispose();
    (gl.edgeLines.material as THREE.Material).dispose();
    gl.sfera.dispose();
    gl.agentSfera.dispose();
    gl.polvere.dispose();
    gl.post?.dispose();
    gl.bloomPass?.dispose();
    gl.composer?.dispose();
    gl = null;
  };

  // --- interazione spaziale: proiezione sullo schermo, come `nodiSchermo.ts` di Munder ----------
  // I nodi sono vertici di un'unica geometria e non hanno un oggetto proprio: niente raycast. Qui
  // si proietta ogni nodo in pixel CSS e si prende il piu' vicino al puntatore entro il proprio
  // raggio: e' la stessa ricerca del riferimento, con la stessa soglia minima di tocco.
  const TOCCO_MIN = 16;
  const pick = (clientX: number, clientY: number): string | null => {
    if (!gl || nodes.length === 0) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: string | null = null;
    let bestD = Infinity;
    for (const n of nodes) {
      v.set(n.position[0], n.position[1], n.position[2]).project(gl.camera);
      if (v.z < -1 || v.z > 1) continue;
      const nx = ((v.x + 1) / 2) * width;
      const ny = ((1 - v.y) / 2) * height;
      const distance = gl.camera.position.distanceTo(world.set(n.position[0], n.position[1], n.position[2]));
      const r = Math.max(TOCCO_MIN, screenRadius(nodeSizeFor(n.kind, n.status), distance));
      const d = Math.hypot(nx - x, ny - y);
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
      writeNodes();
      kick();
    }
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (pointerDown) {
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) {
        goal = null; // l'utente prende la camera: l'animazione dello zoom si ferma dov'è
        camAz -= dx * 0.006;
        camEl = clamp(camEl + dy * 0.006, -1.1, 1.1);
        downX = e.clientX;
        downY = e.clientY;
        kick();
      }
      return;
    }
    hoverAt(e.clientX, e.clientY);
  };
  // Fallback: alcuni input sintetici emettono solo `mousemove`.
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
      refocus();
      opts.onSelect?.(selectedId);
      writeNodes();
      kick();
    }
  };
  const onPointerLeave = (): void => {
    if (hoverId !== null) {
      hoverId = null;
      setCursor(null);
      opts.onHover?.(null);
      writeNodes();
      kick();
    }
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    goal = null;
    camDist = clamp(camDist * (1 + e.deltaY * 0.001), focusId !== null ? 1.2 : 3.4, 40);
    kick();
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });

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
      writeNodes();
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
      // L'agente inquadrato non c'è più (archiviato): si torna all'inquadratura di prima.
      if (focusId !== null && !n.some((x) => x.id === focusId)) {
        selectedId = null;
        refocus();
      }
      writeNodes();
      writeGlobe(Date.now(), directorAt(Date.now()), voce);
      render(Date.now());
      kick();
      publish();
    },
    addPulses(list) {
      const now = Date.now();
      const cap = safeCount((QUALITY[quality] as (typeof QUALITY)[number]).pulses / trailFor(quality), 2_000, 0);
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
      gl.camera.aspect = width / Math.max(1, height);
      gl.camera.updateProjectionMatrix();
      gl.composer?.setSize(width, height);
      gl.post?.setAspect(width / Math.max(1, height));
      render(Date.now());
    },
    labels() {
      const g = gl;
      if (!g) return [];
      const cam = g.camera;
      // P-99: TUTTI i nodi hanno una label (il popover di hover spiega anche tool/task/processo/
      // memoria/approvazione); la visibilità la decide `labelVisible` (fissa per agenti/Director/
      // substrato, al passaggio o con stato attivo per gli altri).
      return nodes
        .map((n) => {
          v.set(n.position[0], n.position[1], n.position[2]).project(cam);
          const nx = ((v.x + 1) / 2) * width;
          const ny = ((1 - v.y) / 2) * height;
          const distance = cam.position.distanceTo(v.set(n.position[0], n.position[1], n.position[2]));
          const hot = n.id === selectedId || n.id === hoverId;
          const size = nodeSizeFor(n.kind, n.status) * (hot ? 1.35 : 1);
          const r = screenRadius(size, distance);
          // Ancora della label a destra del globo, come `.rete-etichetta` di Munder.
          return { id: n.id, text: n.label, kind: n.kind, status: n.status, x: nx + r + 10, y: ny - 14, nx, ny, r, lastEventAt: n.lastEventAt, hot };
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
      spin: 0.06,
      selected: selectedId,
      hover: hoverId,
      core: gl?.sfera.points ?? 0,
      focus: focusId,
      focusGrow: grow,
      ambient: 0,
      trail: trailCount,
      dust: gl?.polvere.points ?? 0,
      rings: 0,
      stars: 0,
      post: gl?.post?.active ?? false,
      voice: voce
    }),
    setSelection(id) {
      selectedId = id;
      refocus();
      writeNodes();
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
      gl?.post?.setActive(!on);
      // Un frame per togliere (o rimettere) la grana dal fotogramma fermo; col moto spento il ciclo
      // resta fermo, con `reducedMotion` spento riparte e continua da solo (P-90).
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
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      canvas.style.cursor = '';
      gl?.renderer.dispose();
      disposeScene();
    }
  };
  return api;
}

// ---------------------------------------------------------------------------------------------
// Selettore di scena (P-89): un unico punto d'ingresso per la UI. La variante scelta si costruisce
// qui; `setScene` la cambia a caldo ricostruendo SOLO la scena (il client, il motore e il journal
// non vengono toccati) e rimandandole grafo e selezione correnti.
// ---------------------------------------------------------------------------------------------
export function createNeuralRenderer(canvas: HTMLCanvasElement, opts: RendererOpts): NeuralRenderer {
  let scene: SceneVariant = opts.scene ?? 'jarvis';
  const make = (v: SceneVariant): SceneRenderer => (v === 'pixel-office' ? createPixelOfficeRenderer(canvas, opts) : createJarvisRenderer(canvas, opts));
  let inner = make(scene);
  let last: { nodes: NodeView[]; edges: EdgeView[]; signals: SystemSignals } | null = null;
  // Stato vivo del facade: a un cambio di variante la nuova scena lo eredita (P-90).
  let activeOn = true;
  let reducedOn = opts.reducedMotion;
  let lightOn = false;
  return {
    setGraph(n, e, s) {
      last = { nodes: n, edges: e, signals: s };
      inner.setGraph(n, e, s);
    },
    addPulses(pulses) {
      inner.addPulses(pulses);
    },
    resize(w, h) {
      inner.resize(w, h);
    },
    labels() {
      return inner.labels();
    },
    stats() {
      return inner.stats();
    },
    setSelection(id) {
      inner.setSelection(id);
    },
    wake() {
      inner.wake();
    },
    setActive(on) {
      activeOn = on;
      inner.setActive(on);
    },
    setReducedMotion(on) {
      reducedOn = on;
      inner.setReducedMotion(on);
    },
    setLight(on) {
      lightOn = on;
      inner.setLight(on);
    },
    pickAt(x, y) {
      return inner.pickAt(x, y);
    },
    setScene(v) {
      if (v === scene) return;
      scene = v;
      const selected = inner.stats().selected;
      inner.dispose();
      inner = make(v);
      if (last) inner.setGraph(last.nodes, last.edges, last.signals);
      if (selected !== null) inner.setSelection(selected);
      inner.setActive(activeOn);
      inner.setReducedMotion(reducedOn);
      inner.setLight(lightOn);
    },
    dispose() {
      inner.dispose();
    }
  };
}
