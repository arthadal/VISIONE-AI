// Visualizer della voce (Fase 18): barre che reagiscono al **livello reale** del microfono, che il
// core pubblica come evento effimero `voice.level` (rms 0..1). Lo stato (IDLE/ASCOLTA/PENSA/PARLA/
// ERRORE) deriva dallo stato vero della voce nel core. Niente animazione casuale: a riposo le barre
// decadono a zero e il loop si ferma. Meccanismo ispirato a `jarvis_opensource/src/lib/audio.ts` (MIT).
import { useEffect, useRef, useState } from 'react';
import type { VisioneEvent, VoiceState } from '../../shared/contracts/index.ts';

const BARS = 28;
/** Sottoscrizione al livello reale del microfono; ritorna l'rms corrente (0..1). */
export function useVoiceLevel(): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const off = window.visione.events.subscribe((e: VisioneEvent) => {
      if (e.type !== 'voice.level') return;
      // Guardia (P-74): un RMS non finito non deve avvelenare barre e shader.
      const rms = Number((e.payload as { rms: number }).rms);
      setLevel(Number.isFinite(rms) ? Math.min(1, Math.max(0, rms)) : 0);
    });
    return off;
  }, []);
  return level;
}

export type VoiceVisualState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export function voiceVisualState(voice: VoiceState | null): VoiceVisualState {
  if (!voice) return 'idle';
  if (voice.status === 'failed') return 'error';
  if (voice.speaking != null) return 'speaking';
  if (voice.listening) return 'listening';
  if (voice.status === 'ready') return 'idle';
  return 'idle';
}

export function VoiceVisualizer({ voice, level }: { voice: VoiceState | null; level: number }) {
  const [bars, setBars] = useState<number[]>(() => new Array(BARS).fill(0));
  const target = useRef(level);
  target.current = level;
  // Loop di decadimento: parte col livello e si ferma quando è tutto a zero (nessun loop perpetuo).
  useEffect(() => {
    let raf: number | null = null;
    const step = (): void => {
      raf = null;
      setBars((prev) => {
        const next = prev.map((v, i) => {
          // Le barre centrali reagiscono di più: profilo a campana sul livello rms.
          const shape = 0.35 + 0.65 * Math.sin((i / (BARS - 1)) * Math.PI);
          const want = Math.min(1, target.current * shape * 1.6);
          return v + (want - v) * 0.35;
        });
        const active = next.some((v) => v > 0.02);
        if (active) raf = requestAnimationFrame(step);
        return next;
      });
    };
    raf = requestAnimationFrame(step);
    return () => { if (raf !== null) cancelAnimationFrame(raf); };
  }, [level]);

  const state = voiceVisualState(voice);
  return (
    <div className={`voice-visual state-${state}`} data-testid="voice-visual" data-voice-state={state} title={voice?.reason ?? undefined}>
      <div className="voice-bars" aria-hidden="true">
        {bars.map((v, i) => <span key={i} style={{ height: `${Math.round(8 + v * 92)}%` }} />)}
      </div>
      <span className="voice-visual-label mono small">{state.toUpperCase()}</span>
    </div>
  );
}
