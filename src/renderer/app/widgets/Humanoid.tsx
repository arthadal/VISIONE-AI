// Widget Umanoide (11/10/2026): busto di particelle che parla quando VISIONE parla e gira la testa
// verso il proprietario. Canvas 2D a fusione additiva (nessun secondo contesto WebGL accanto alla
// scena), al più 30 fotogrammi al secondo, fermo quando la scheda è piegata. La webcam è SPENTA
// finché il proprietario non la accende dal widget: le immagini si riducono a 64×48 in grigio, servono
// solo a trovare dove sta chi si muove e non escono dal renderer (né salvate, né inviate).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { VoiceState } from '../../../shared/contracts/index.ts';
import { HudPanel } from '../HudPanels.tsx';
import { useDockCollapsed } from '../Dock.tsx';
import { useT, type MessageKey } from '../../lib/i18n/index.ts';
import { useHumanoidPrefs } from './humanoid-prefs.ts';
import {
  ASSEMBLY_FLIGHT_S, ASSEMBLY_RISE_S, ASSEMBLY_TOTAL_S, assemblyDelay, assemblyPercent, assemblyProgress, buildFigure, FIGURE_BOTTOM, FIGURE_TOP, follow,
  GAZE_HOLD_MS, gazeFromCamera, gazeFromPointer, HEAD_CENTER_Y, humanoidStatus, MIN_MOTION_MASS, motionCentroid, MOTION_H, MOTION_W,
  mouthWave, NECK_PIVOT_Y, CORE_Y, PART, project, rotate, speechEnvelope, STERNUM
} from './humanoid-logic.ts';

const FRAME_MS = 1000 / 30;
/** Modalità leggera (`ui.light`): la figura si ridisegna ~15 volte al secondo. */
const LIGHT_FRAME_MS = 1000 / 15;
/** Fotogramma per il rilevatore di volti di Windows (grigio): abbastanza per un volto a 2 m. */
const FACE_W = 160;
const FACE_H = 120;
const BLUE = ['rgba(40,125,255,0.24)', 'rgba(60,155,255,0.44)', 'rgba(95,190,255,0.68)', 'rgba(185,232,255,0.95)'];
const ORANGE = ['rgba(255,125,35,0.4)', 'rgba(255,160,55,0.7)', 'rgba(255,215,130,0.95)'];

interface Live {
  speaking: boolean;
  level: number;
  busy: boolean;
  reducedMotion: boolean;
  light: boolean;
}


export function HumanoidWidget({ voice, level, busy, reducedMotion, light = false, grown = false, intro = false }: { voice: VoiceState | null; level: number; busy: boolean; reducedMotion: boolean; /** Modalità leggera: meno fotogrammi e niente webcam. */ light?: boolean; /** Ingrandito a sinistra mentre VISIONE parla. */ grown?: boolean; /** L'apertura grande al centro: niente webcam né comandi. */ intro?: boolean }) {
  const t = useT();
  const collapsed = useDockCollapsed() === true;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const figure = useMemo(() => buildFigure(7_000), []);
  const loadingLabel = t('widget.humanoid.loading');
  const speaking = voice?.speaking != null;
  const listening = voice?.listening === true;
  const live = useRef<Live>({ speaking, level, busy, reducedMotion, light });
  live.current = { speaking, level, busy, reducedMotion, light };
  const [prefs, setPrefs] = useHumanoidPrefs();
  // In modalità leggera la webcam resta spenta (la preferenza si conserva per quando la si toglie).
  const camera = prefs.camera && !intro && !light;
  const [camState, setCamState] = useState<{ phase: 'off' | 'starting' | 'live' | 'error'; error?: string }>({ phase: 'off' });
  // Sguardo dalla webcam (ultimo bersaglio e quando è stato visto) e dal puntatore.
  const camGaze = useRef<{ yaw: number; pitch: number; at: number; face: boolean } | null>(null);
  // Come segue: volto (rilevatore di Windows) o movimento (ripiego).
  const [tracker, setTracker] = useState<'face' | 'motion' | null>(null);
  const pointer = useRef<{ yaw: number; pitch: number; at: number } | null>(null);

  // Puntatore: a webcam spenta la testa guarda dove sta il mouse nella finestra.
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      pointer.current = { ...gazeFromPointer(e.clientX / Math.max(1, window.innerWidth), e.clientY / Math.max(1, window.innerHeight)), at: performance.now() };
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  // Webcam: solo se accesa dal proprietario e con la scheda aperta. Il volto lo trova il rilevatore di
  // Windows nel core (fotogramma 160×120 in grigio, mai salvato); se manca o non lo vede (girato, poca
  // luce), aiuta il movimento: la testa è la parte alta di chi si muove.
  useEffect(() => {
    if (!camera || collapsed) {
      camGaze.current = null;
      setCamState({ phase: 'off' });
      setTracker(null);
      return;
    }
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setCamState({ phase: 'starting' });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const small = document.createElement('canvas');
    small.width = MOTION_W;
    small.height = MOTION_H;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    const faceCanvas = document.createElement('canvas');
    faceCanvas.width = FACE_W;
    faceCanvas.height = FACE_H;
    const fctx = faceCanvas.getContext('2d', { willReadFrequently: true });
    const bg = new Float32Array(MOTION_W * MOTION_H);
    let primed = false;
    let faceOn = true;
    let faceFails = 0;
    // Rilevatore in errore: si va col movimento e si riprova il volto dopo un po' (mai per sempre,
    // salvo un Windows che non lo supporta).
    let faceRetryAt = 0;
    let faceNever = false;
    let asking = false;
    let faceSeenAt = 0;
    setTracker('face');
    const grayOf = (data: Uint8ClampedArray, n: number): Uint8Array => {
      const g = new Uint8Array(n);
      for (let i = 0; i < n; i++) g[i] = (data[i * 4]! * 0.3 + data[i * 4 + 1]! * 0.59 + data[i * 4 + 2]! * 0.11) | 0;
      return g;
    };
    const askFace = (): void => {
      if (!fctx || asking) return;
      asking = true;
      fctx.drawImage(video, 0, 0, FACE_W, FACE_H);
      const gray = grayOf(fctx.getImageData(0, 0, FACE_W, FACE_H).data, FACE_W * FACE_H);
      let bin = '';
      for (let i = 0; i < gray.length; i += 4096) bin += String.fromCharCode(...gray.subarray(i, i + 4096));
      void window.visione.vision.face(FACE_W, FACE_H, btoa(bin)).then((res) => {
        if (stopped) return;
        if (!res.ok) {
          // Rilevatore assente o in errore ripetuto: si resta sul movimento (lo dice la scritta).
          if (/support/i.test(res.error.message)) faceNever = true;
          if (++faceFails >= 3 || faceNever) {
            faceOn = false;
            faceRetryAt = performance.now() + 15_000;
            setTracker('motion');
          }
          return;
        }
        faceFails = 0;
        const best = res.data.faces.reduce<(typeof res.data.faces)[number] | null>((a, f) => (a === null || f.w * f.h > a.w * a.h ? f : a), null);
        if (best) {
          faceSeenAt = performance.now();
          camGaze.current = { ...gazeFromCamera((best.x + best.w / 2) / FACE_W, (best.y + best.h / 2) / FACE_H), at: faceSeenAt, face: true };
        }
      }).finally(() => {
        asking = false;
      });
    };
    void navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' }, audio: false })
      .then(async (s) => {
        if (stopped) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        stream = s;
        video.srcObject = s;
        await video.play();
        setCamState({ phase: 'live' });
        // Un giro ogni 60 ms: il volto appena il rilevatore è libero, il movimento quando il volto manca.
        const sample = (): void => {
          if (stopped) return;
          timer = setTimeout(sample, 60);
          if (!sctx || video.readyState < 2) return;
          if (!faceOn && !faceNever && performance.now() > faceRetryAt) {
            faceOn = true;
            faceFails = 0;
            setTracker('face');
          }
          if (faceOn) askFace();
          sctx.drawImage(video, 0, 0, MOTION_W, MOTION_H);
          const gray = grayOf(sctx.getImageData(0, 0, MOTION_W, MOTION_H).data, MOTION_W * MOTION_H);
          if (!primed) {
            bg.set(gray);
            primed = true;
            return;
          }
          // Lo sfondo si aggiorna sempre (così è pronto se il volto sparisce); il movimento guida solo senza volto.
          const m = motionCentroid(gray, bg);
          if (faceOn && performance.now() - faceSeenAt < 700) return;
          if (m.mass >= MIN_MOTION_MASS) camGaze.current = { ...gazeFromCamera(m.cx, m.cy), at: performance.now(), face: false };
        };
        sample();
      })
      .catch((err: unknown) => {
        if (!stopped) setCamState({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
      video.srcObject = null;
      camGaze.current = null;
    };
  }, [camera, collapsed]);

  // Disegno: un ciclo solo, fermo a scheda piegata o finestra nascosta. All'apertura la figura si
  // forma: le particelle arrivano in volo dal basso e la costruiscono fino alla testa, con la linea del
  // caricamento che sale. Le particelle si disegnano su un livello a parte, poi sfocato (bagliore) e nitido.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || collapsed) return;
    const ctx = canvas.getContext('2d');
    const layer = document.createElement('canvas');
    const lctx = layer.getContext('2d');
    if (!ctx || !lctx) return;
    let raf = 0;
    let last = 0;
    let yaw = 0;
    let pitch = 0;
    const t0 = performance.now();
    const fit = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      if (layer.width !== w || layer.height !== h) {
        layer.width = w;
        layer.height = h;
      }
    };
    // La misura si controlla all'inizio di ogni fotogramma, prima di disegnare: un ResizeObserver
    // ridimensionerebbe (e quindi svuoterebbe) la tela DOPO il disegno, e durante un'animazione di
    // dimensioni (l'apertura che va a sinistra) si vedrebbe vuota.
    fit();
    const { pos, nrm, from, part, seed, count } = figure;
    const delays = new Float32Array(count);
    for (let i = 0; i < count; i++) delays[i] = assemblyDelay(pos[i * 3 + 1]!, seed[i]!);
    const skipAssembly = live.current.reducedMotion;
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw);
      if (document.hidden || now - last < (live.current.light ? LIGHT_FRAME_MS : FRAME_MS)) return;
      const dt = last === 0 ? 0 : Math.min(0.1, (now - last) / 1000);
      last = now;
      fit();
      const L = live.current;
      const time = (now - t0) / 1000;
      const motion = L.reducedMotion ? 0 : 1;
      const assembling = !skipAssembly && time < ASSEMBLY_TOTAL_S;
      // Lampo del nucleo quando la figura è completa.
      const flash = skipAssembly ? 0 : Math.max(0, 1 - Math.abs(time - ASSEMBLY_TOTAL_S) / 0.7);
      const formed = skipAssembly ? 1 : Math.min(1, Math.max(0, (time - 2.0) / 1.4));
      // Sguardo: webcam (se ha visto qualcuno di recente), poi puntatore, poi un lento guardarsi intorno.
      const cam = camGaze.current;
      const ptr = pointer.current;
      let target = { yaw: Math.sin(time * 0.31) * 0.14 * motion, pitch: Math.sin(time * 0.23) * 0.04 * motion };
      if (cam && now - cam.at < GAZE_HOLD_MS) target = cam;
      else if (!cam && ptr && now - ptr.at < 6_000) target = ptr;
      const rate = cam && target === cam ? (cam.face ? 7 : 5) : 3.2;
      yaw = follow(yaw, assembling ? 0 : target.yaw, dt, rate);
      pitch = follow(pitch, assembling ? 0 : target.pitch, dt, rate);
      const env = speechEnvelope(time, L.speaking) * (L.reducedMotion ? 0.5 : 1);
      const listen = Math.min(1, L.level * 4);

      const W = canvas.width;
      const H = canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, W, H);
      const scale = Math.min((H * 0.92) / (FIGURE_TOP - FIGURE_BOTTOM), (W * 0.92) / 2.8);
      const cx = W / 2;
      const cy = H * 0.5 + ((FIGURE_TOP + FIGURE_BOTTOM) / 2) * scale;
      const px = Math.max(1, scale / 120);
      ctx.globalCompositeOperation = 'lighter';

      // Onde attorno alla testa: lente a riposo, escono verso l'esterno quando VISIONE parla.
      const [hx, hy] = project(...rotate(0, HEAD_CENTER_Y, 0, yaw * 0.3, 0, NECK_PIVOT_Y), cx, cy, scale);
      for (let i = 0; i < 7; i++) {
        const phase = (i / 7 + time * (0.04 + 0.22 * env) * motion) % 1;
        const radius = scale * (0.82 + phase * 1.0);
        const alpha = (0.1 + 0.2 * env + 0.06 * listen) * (1 - phase) * formed;
        if (alpha <= 0.002) continue;
        ctx.strokeStyle = `rgba(80,175,255,${alpha.toFixed(3)})`;
        ctx.lineWidth = px * 1.2;
        ctx.beginPath();
        // Come nella foto: archi che si interrompono dietro le spalle.
        ctx.arc(hx, hy, radius, Math.PI * 0.92, Math.PI * 2.08);
        ctx.stroke();
      }

      // Bagliore del nucleo nel volto: più forte quando parla, ascolta o la figura si è appena formata.
      const [kx, ky] = project(...rotate(0, CORE_Y, 0.12, yaw, pitch, NECK_PIVOT_Y), cx, cy, scale);
      const glowR = scale * (0.3 + 0.12 * env + 0.06 * listen + 0.2 * flash);
      const glow = ctx.createRadialGradient(kx, ky, 0, kx, ky, glowR);
      glow.addColorStop(0, `rgba(255,150,50,${((0.3 + 0.35 * env + 0.15 * listen + 0.5 * flash) * formed).toFixed(3)})`);
      glow.addColorStop(0.5, `rgba(255,110,30,${(0.12 * formed).toFixed(3)})`);
      glow.addColorStop(1, 'rgba(255,90,20,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(kx - glowR, ky - glowR, glowR * 2, glowR * 2);

      const blue = BLUE.map(() => new Path2D());
      const orange = ORANGE.map(() => new Path2D());
      const swirl = time * (0.35 + (L.busy ? 1.4 : 0)) * motion;
      // Piccolo (nella colonna) bastano metà delle particelle: meno lavoro per fotogramma, la scena
      // principale resta fluida. Grande (apertura, mentre parla) le disegna tutte.
      const stride = W * H < 350_000 ? 2 : 1;
      for (let i = 0; i < count; i += stride) {
        let x = pos[i * 3]!;
        let y = pos[i * 3 + 1]!;
        let z = pos[i * 3 + 2]!;
        const s = seed[i]!;
        const pt = part[i]!;
        const jitter = (0.0025 + env * 0.01) * motion;
        let alphaMul = 1;
        let waveGlow = 0;
        if (pt === PART.head || pt === PART.face) {
          // Parlato: anelli che partono dalla bocca e corrono sulla metà bassa della testa.
          const w = mouthWave(x, y, time, env);
          if (w.push !== 0) {
            x += nrm[i * 3]! * w.push;
            y += nrm[i * 3 + 1]! * w.push;
            z += nrm[i * 3 + 2]! * w.push;
          }
          waveGlow = w.glow;
        } else if (pt === PART.core) {
          // Nucleo: gira su sé stesso (più in fretta quando gli agenti lavorano) e si gonfia parlando.
          const a = swirl + s * 0.5;
          const dx = x;
          const dz = z - 0.12;
          const k = 1 + 0.25 * env + 0.1 * listen;
          x = (dx * Math.cos(a) - dz * Math.sin(a)) * k;
          z = 0.12 + (dx * Math.sin(a) + dz * Math.cos(a)) * k;
          y = CORE_Y + (y - CORE_Y) * k;
        } else if (pt === PART.body) {
          y += Math.sin(time * 1.3) * 0.007 * motion;
        } else if (pt === PART.drift) {
          // Particelle che si staccano dalla testa e si perdono verso destra.
          const life = (time * 0.09 * (0.6 + s) + s * 7) % 1;
          x += life * 0.9 * (motion || 0.2);
          y += life * 0.22 + Math.sin(time + s * 20) * 0.03 * motion;
          z -= life * 0.2;
          alphaMul = (1 - life) * formed;
        }
        if (jitter > 0) {
          x += Math.sin(time * 3.1 + s * 61) * jitter;
          y += Math.cos(time * 2.7 + s * 47) * jitter;
        }
        const headLike = pt === PART.head || pt === PART.face || pt === PART.core || pt === PART.drift;
        const ry0 = headLike ? yaw : yaw * 0.25;
        const rp0 = headLike ? pitch : 0;
        let [rx, ry, rz] = rotate(x, y, z, ry0, rp0, NECK_PIVOT_Y);
        const nz = rotate(nrm[i * 3]!, nrm[i * 3 + 1]!, nrm[i * 3 + 2]!, ry0, rp0, 0)[2];
        let flight = 0;
        if (assembling) {
          const a = assemblyProgress(time, delays[i]!);
          if (a < 1) {
            // In volo: dal punto di partenza al suo posto, con una curva di lato.
            const fx = from[i * 3]!;
            const fy = from[i * 3 + 1]!;
            const fz = from[i * 3 + 2]!;
            const bend = Math.sin(a * Math.PI) * 0.5 * (s - 0.5);
            rx = fx + (rx - fx) * a + bend;
            ry = fy + (ry - fy) * a;
            rz = fz + (rz - fz) * a;
            flight = 1 - a;
          }
        }
        const [sx, sy, k] = project(rx, ry, rz, cx, cy, scale);
        if (sx < -4 || sy < -4 || sx > W + 4 || sy > H + 4) continue;
        // Davanti più luminoso, dietro più spento; il bordo della sagoma brilla come nelle foto.
        const front = Math.min(1, Math.max(0, (nz + 0.6) / 1.4));
        const rim = pt === PART.head || pt === PART.body ? Math.pow(1 - Math.min(1, Math.abs(nz)), 2.2) : 0;
        let bright = (0.22 + 0.5 * front + 0.6 * rim) * alphaMul * (0.82 + 0.18 * Math.sin(time * 2.2 + s * 40));
        if (pt === PART.body) bright *= Math.min(1, Math.max(0.15, (ry - FIGURE_BOTTOM) / 0.45));
        // Il retro della testa quasi spento: il volto si legge come una superficie (con le orbite), non come un vetro.
        if ((pt === PART.head || pt === PART.face) && nz < -0.15) bright *= 0.18;
        bright += flight * 0.5 + waveGlow * 0.9;
        const size = px * (0.8 + 0.45 * k) * (1 + flight * 0.6);
        if (pt === PART.core || pt === PART.spine || pt === PART.face) {
          const lift = pt === PART.face ? 0.15 * env + 0.3 * flash : 0.25 * env + 0.4 * flash;
          const b = Math.min(2, Math.max(0, Math.floor((bright + lift) * 2.4)));
          orange[b]!.rect(sx, sy, size, size);
        } else {
          const b = Math.min(3, Math.floor(bright * 3.3));
          if (b >= 0) blue[b]!.rect(sx, sy, size, size);
        }
      }
      // Particelle su un livello a parte: una passata sfocata (bagliore) e una nitida.
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalCompositeOperation = 'source-over';
      lctx.clearRect(0, 0, W, H);
      lctx.globalCompositeOperation = 'lighter';
      BLUE.forEach((c, i) => {
        lctx.fillStyle = c;
        lctx.fill(blue[i]!);
      });
      ORANGE.forEach((c, i) => {
        lctx.fillStyle = c;
        lctx.fill(orange[i]!);
      });
      ctx.filter = `blur(${(3 * px).toFixed(1)}px)`;
      ctx.globalAlpha = 1;
      ctx.drawImage(layer, 0, 0);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.drawImage(layer, 0, 0);

      // Il fiore luminoso sullo sterno, dove finiscono i tendini.
      const [dx, dy] = project(...rotate(STERNUM[0], STERNUM[1], STERNUM[2], yaw * 0.25, 0, NECK_PIVOT_Y), cx, cy, scale);
      const dotR = scale * (0.12 + 0.03 * Math.sin(time * 2) * motion + 0.05 * env + 0.1 * flash);
      const dot = ctx.createRadialGradient(dx, dy, 0, dx, dy, dotR);
      dot.addColorStop(0, `rgba(215,240,255,${(0.95 * (assembling ? Math.min(1, time / 1.2) : 1)).toFixed(3)})`);
      dot.addColorStop(0.3, 'rgba(80,170,255,0.45)');
      dot.addColorStop(1, 'rgba(40,120,255,0)');
      ctx.fillStyle = dot;
      ctx.fillRect(dx - dotR, dy - dotR, dotR * 2, dotR * 2);

      // Caricamento: la linea che sale con la figura e la percentuale.
      if (assembling) {
        const h = Math.min(1, Math.max(0, (time - 0.2 - ASSEMBLY_FLIGHT_S * 0.7) / ASSEMBLY_RISE_S));
        const yLine = cy - (FIGURE_BOTTOM + h * (FIGURE_TOP - FIGURE_BOTTOM)) * scale;
        const fade = Math.min(1, (ASSEMBLY_TOTAL_S - time) / 0.6);
        const line = ctx.createLinearGradient(W * 0.08, 0, W * 0.92, 0);
        line.addColorStop(0, 'rgba(80,175,255,0)');
        line.addColorStop(0.5, `rgba(150,215,255,${(0.75 * fade).toFixed(3)})`);
        line.addColorStop(1, 'rgba(80,175,255,0)');
        ctx.fillStyle = line;
        ctx.fillRect(W * 0.08, yLine - px, W * 0.84, px * 2);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `rgba(150,215,255,${(0.9 * fade).toFixed(3)})`;
        ctx.font = `${Math.round(10 * px)}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'right';
        ctx.fillText(`${loadingLabel} ${assemblyPercent(time)}%`, W * 0.95, Math.max(12 * px, yLine - 5 * px));
      }
      ctx.globalCompositeOperation = 'source-over';
      canvas.dataset.yaw = yaw.toFixed(3);
      canvas.dataset.env = env.toFixed(2);
      canvas.dataset.formed = assembling ? String(assemblyPercent(time)) : '100';
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [figure, collapsed, loadingLabel]);

  const state = speaking ? 'speaking' : listening ? 'listening' : busy ? 'thinking' : 'idle';
  // Sotto la figura, grande (16/10/2026): cosa sta facendo VISIONE, anche quando si ingrandisce mentre parla.
  const status = humanoidStatus(voice, busy);
  const wakePhrase = voice?.wake.enabled === true && voice.wake.available ? voice.wake.phrase : '';
  const statusText = status === 'idle' && wakePhrase ? t('widget.humanoid.status.idleWake', { phrase: wakePhrase }) : t(`widget.humanoid.status.${status}` as MessageKey);
  const toggle = (): void => setPrefs({ camera: !camera });
  return (
    <HudPanel title={t('widget.humanoid.title')} status={t(`widget.humanoid.state.${state}` as MessageKey)} testId="widget-humanoid" className="widget widget-humanoid">
      <div className="wg-humanoid" data-state={state} data-grown={grown ? 'true' : 'false'}>
        <canvas ref={canvasRef} className="wg-humanoid-canvas" data-testid="widget-humanoid-canvas" aria-label={t('widget.humanoid.title')} role="img" />
        <div className="wg-humanoid-status" data-status={status} data-testid="widget-humanoid-status" role="status" aria-live="polite">
          <span className="wg-humanoid-dot" aria-hidden="true" />
          {statusText}
        </div>
        <div className="wg-humanoid-bar">
          <button type="button" className="small" onClick={toggle} aria-pressed={camera} disabled={light} title={light ? t('widget.humanoid.camera.light') : undefined} data-testid="widget-humanoid-camera">
            {camera ? t('widget.humanoid.camera.off') : t('widget.humanoid.camera.on')}
          </button>
          <span className="muted small" data-testid="widget-humanoid-camera-state" title={t('widget.humanoid.camera.privacy')}>
            {camState.phase === 'live' ? `● ${t('widget.humanoid.camera.live')} · ${t(tracker === 'face' ? 'widget.humanoid.tracker.face' : 'widget.humanoid.tracker.motion')}`
              : camState.phase === 'starting' ? t('widget.humanoid.camera.starting')
                : camState.phase === 'error' ? t('widget.humanoid.camera.error', { error: camState.error ?? '' })
                  : t('widget.humanoid.pointer')}
          </span>
        </div>
        <label className="small wg-humanoid-grow" title={t('widget.humanoid.grow.title')}>
          <input type="checkbox" checked={prefs.grow} onChange={(e) => setPrefs({ grow: e.target.checked })} data-testid="widget-humanoid-grow" /> {t('widget.humanoid.grow')}
        </label>
      </div>
    </HudPanel>
  );
}
