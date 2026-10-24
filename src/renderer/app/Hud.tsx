// Telemetry HUD (VISIONE_ARCHITECTURE §21, §26; Fase 14): console operativa JARVIS. Ogni metrica è
// `{valore|null, unità, stato, fonte, istante}`, mai inventata. Le misure di sistema arrivano dal
// campione reale `telemetry.sample` (null = N/D), quelle di orchestrazione dagli eventi del bus e
// dallo stato del core. Logica pura e formattazione in `hud-metrics.ts`.
// Fase G4 (P-76): il rendering del pannello SISTEMA vive in `HudPanels.tsx` (`SystemPanel`); questo
// file resta la sottoscrizione condivisa al bus (una sola per tutta la UI, P-73).
import { useEffect, useState } from 'react';
import type { VisioneEvent, TelemetrySample } from '../../shared/contracts/index.ts';
import { EMPTY_BUS_TELEMETRY, type BusTelemetry } from './hud-metrics.ts';

export type { BusTelemetry, Metric, MetricSection, MetricStatus } from './hud-metrics.ts';

const RATE_WINDOW_MS = 10_000;
/** Tetto dei campioni di frequenza tenuti in memoria (Fase 17): una tempesta non fa crescere l'array. */
const MAX_RATE_SAMPLES = 50_000;
/** Tetto delle mappe di correlazione in attesa di esito (turni/obiettivi mai conclusi). */
const MAX_PENDING = 5_000;

/** Misure dagli eventi reali del bus: frequenza, latenze, token, contesto, voce e sistema. */
export function useBusTelemetry(): BusTelemetry {
  const [snap, setSnap] = useState<BusTelemetry>(EMPTY_BUS_TELEMETRY);
  useEffect(() => {
    const times: number[] = [];
    const turns = new Map<string, number>();
    const goals = new Map<string, number>();
    const usage = new Map<string, { inTok: number; outTok: number; context: { used: number; size: number } | null }>();
    let lastTurn: { ms: number; at: number } | null = null;
    let goal: { ms: number; at: number } | null = null;
    let usageAt: number | null = null;
    let sttMs: number | null = null;
    let ttsMs: number | null = null;
    let bargeInMs: number | null = null;
    let voiceAt: number | null = null;
    let sys: TelemetrySample | null = null;
    let sysAt: number | null = null;
    const since = Date.now();
    const off = window.visione.events.subscribe((e: VisioneEvent) => {
      if (times.length < MAX_RATE_SAMPLES) times.push(Date.now());
      schedule();
      const p = e.payload as Record<string, unknown>;
      if (e.type === 'agent.turn.started' && turns.size < MAX_PENDING) turns.set(String(p.turnId), e.ts);
      if (e.type === 'agent.turn.finished') {
        const start = turns.get(String(p.turnId));
        if (start !== undefined) {
          lastTurn = { ms: e.ts - start, at: e.ts };
          turns.delete(String(p.turnId));
        }
      }
      // Latenza end-to-end di un obiettivo: dalla ricezione del goal alla sintesi del Director.
      if (e.type === 'director.goal.received' && goals.size < MAX_PENDING) goals.set(String(p.rootTaskId), e.ts);
      if (e.type === 'director.summary') {
        const start = goals.get(String(p.rootTaskId));
        if (start !== undefined) {
          goal = { ms: e.ts - start, at: e.ts };
          goals.delete(String(p.rootTaskId));
        }
      }
      if (e.type === 'agent.usage.updated') {
        const u = p.usage as { inputTokens?: number; outputTokens?: number; contextUsed?: number; contextSize?: number };
        usage.set(String(p.agentId), {
          inTok: u.inputTokens ?? 0,
          outTok: u.outputTokens ?? 0,
          context: u.contextUsed !== undefined && u.contextSize !== undefined ? { used: u.contextUsed, size: u.contextSize } : null
        });
        usageAt = e.ts;
      }
      // Voce (Fase 9): latenze reali dallo STT locale e dalla sintesi TTS.
      if (e.type === 'voice.stt.final') {
        sttMs = Number(p.latencyMs);
        voiceAt = e.ts;
      }
      if (e.type === 'voice.tts.started') {
        const first = typeof p.firstAudioMs === 'number' ? p.firstAudioMs : null;
        const synth = typeof p.synthMs === 'number' ? p.synthMs : null;
        ttsMs = first ?? synth;
        voiceAt = e.ts;
      }
      if (e.type === 'voice.tts.interrupted') {
        const b = p.bargeInMs;
        if (typeof b === 'number') bargeInMs = b;
        voiceAt = e.ts;
      }
      // Telemetria di sistema (Fase 14): l'ultimo campione reale ricevuto dal bus.
      if (e.type === 'telemetry.sample') {
        sys = p as unknown as TelemetrySample;
        sysAt = e.ts;
      }
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      timer = null;
      const now = Date.now();
      while (times.length > 0 && (times[0] as number) < now - RATE_WINDOW_MS) times.shift();
      const span = Math.min(RATE_WINDOW_MS, now - since);
      const usages = [...usage.values()];
      const contexts = usages.map((u) => u.context).filter((c): c is { used: number; size: number } => c !== null);
      setSnap({
        rate: span >= 2_000 ? Math.round((times.length / span) * 10_000) / 10 : null,
        rateAt: times.length > 0 ? now : null,
        lastTurnMs: lastTurn?.ms ?? null,
        lastTurnAt: lastTurn?.at ?? null,
        goalMs: goal?.ms ?? null,
        goalAt: goal?.at ?? null,
        tokensIn: usage.size > 0 ? usages.reduce((n, u) => n + u.inTok, 0) : null,
        tokensOut: usage.size > 0 ? usages.reduce((n, u) => n + u.outTok, 0) : null,
        tokensTotal: usage.size > 0 ? usages.reduce((n, u) => n + u.inTok + u.outTok, 0) : null,
        context: contexts.at(-1) ?? null,
        usageAt,
        sttMs,
        ttsMs,
        bargeInMs,
        voiceAt,
        sys,
        sysAt
      });
      if (times.length > 0) timer = setTimeout(tick, 1_000);
    };
    const schedule = (): void => {
      timer ??= setTimeout(tick, 1_000);
    };
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, []);
  return snap;
}
