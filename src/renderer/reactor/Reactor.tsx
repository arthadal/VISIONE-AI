// Reactor del Command Center (Fase 18). Porting in three.js puro dello shader polare MIT di
// `jarvis_opensource` (src/scene/Core.tsx, © Aditya Dewaskar, MIT): un solo quad camera-facing con
// rumore fbm, bordo eroso, sweep radar e disco tessuto. Qui è guidato da **segnali reali** di VISIONE:
// livello voce (rms), stato del Director (idle/planning/working/error) e attività. Nessun moto casuale:
// a sistema fermo resta al minimo; lo sweep è la sola animazione e si ferma con `reducedMotion`.
// Fase G3 (P-75): shader e mappa stati vivono in `./shader.ts`, condivisi col nucleo centrale della
// scena Neural (stesso disegno, un solo posto in cui modificarlo).
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { REACTOR_COLOR as COLOR, REACTOR_FRAGMENT as fragment, REACTOR_INTENSITY as INTENSITY, REACTOR_VERTEX as vertex, type ReactorState } from './shader.ts';

export type { ReactorState };

export function Reactor({ size = 84, level = 0, state = 'idle', reducedMotion = false, className = '' }: { size?: number; level?: number; state?: ReactorState; reducedMotion?: boolean; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const target = useRef({ level, state });
  target.current = { level, state };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: false });
    } catch {
      return; // WebGL assente: il reactor semplicemente non compare (nessun fallback finto)
    }
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const uniforms = {
      uColor: { value: new THREE.Color(COLOR.idle) },
      uHot: { value: new THREE.Color('#c9fdff') },
      uLevel: { value: 0 },
      uPhase: { value: 0 },
      uOpen: { value: 0 },
      uZoom: { value: 1.35 },
      uIntensity: { value: INTENSITY.idle },
      uStyle: { value: 0 }
    };
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader: vertex, fragmentShader: fragment, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    scene.add(mesh);
    const colorTarget = new THREE.Color(COLOR.idle);

    let raf: number | null = null;
    let last = 0;
    let pending = 0;
    let lastDraw = 0;
    let visible = !document.hidden;
    const FRAME_MS = 33; // ~30 fps: il reactor non deve rubare frame alla scena Neural
    const onVisibility = (): void => { visible = !document.hidden; if (visible) kick(); else cancel(); };
    const loop = (t: number): void => {
      raf = null;
      const dt = last > 0 ? Math.min(0.05, (t - last) / 1000) : 0.016;
      last = t;
      pending += dt;
      if (t - lastDraw >= FRAME_MS) {
        lastDraw = t;
        const step = pending;
        pending = 0;
        const { level: lv, state: st } = target.current;
        uniforms.uPhase.value += step * (0.35 + uniforms.uLevel.value * 0.7) * (reducedMotion ? 0 : 1);
        uniforms.uLevel.value += (Math.max(0, Math.min(1, lv)) - uniforms.uLevel.value) * Math.min(1, step * 8);
        uniforms.uOpen.value += (1 - uniforms.uOpen.value) * Math.min(1, step * 1.6);
        uniforms.uIntensity.value += (INTENSITY[st] - uniforms.uIntensity.value) * Math.min(1, step * 3);
        colorTarget.set(COLOR[st]);
        (uniforms.uColor.value as THREE.Color).lerp(colorTarget, Math.min(1, step * 2.5));
        renderer.render(scene, camera);
      }
      if (visible) raf = requestAnimationFrame(loop);
    };
    const cancel = (): void => { if (raf !== null) cancelAnimationFrame(raf); raf = null; last = 0; };
    const kick = (): void => { if (raf === null && visible) raf = requestAnimationFrame(loop); };
    document.addEventListener('visibilitychange', onVisibility);
    kick();
    return () => {
      cancel();
      document.removeEventListener('visibilitychange', onVisibility);
      mesh.geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, [size, reducedMotion]);

  return <canvas ref={canvasRef} className={`reactor ${className}`} width={size} height={size} data-testid="reactor" data-state={state} aria-hidden="true" />;
}
