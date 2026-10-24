// 11/10/2026 (richieste del proprietario): impostazioni a caldo o col riavvio, log leggibile senza la
// routine, durata dei nodi a schermo e widget Umanoide (figura, sguardo, parlato, movimento in webcam).
import { describe, expect, it } from 'vitest';
import { EVENT_DEFINITIONS, type CoreStateSnapshot, type VisioneEvent } from '../../src/shared/contracts/index.ts';
import { busyOf, busyText, changeKind } from '../../src/renderer/app/restart-logic.ts';
import { describeEvent, isRoutine } from '../../src/renderer/app/log-logic.ts';
import { clampLinger, leaves, nodeLingerOf } from '../../src/renderer/app/settings-meta.ts';
import {
  ASSEMBLY_TOTAL_S, assemblyDelay, assemblyPercent, assemblyProgress, buildFigure, FIGURE_BOTTOM, FIGURE_TOP, follow, gazeFromCamera,
  gazeFromPointer, headSection, humanoidStatus, insideBody, MAX_PITCH, MAX_YAW, motionCentroid, MOTION_H, MOTION_W, mouthWave, MOUTH_Y, PART, project,
  rotate, speechEnvelope, WAVE_TOP_Y
} from '../../src/renderer/app/widgets/humanoid-logic.ts';
import { createEngine } from './neural-helpers.ts';

let n = 0;
function ev(type: string, payload: Record<string, unknown> = {}, over: Partial<VisioneEvent> = {}): VisioneEvent {
  const def = EVENT_DEFINITIONS[type as keyof typeof EVENT_DEFINITIONS];
  n++;
  return {
    id: `E${String(n).padStart(25, '0')}`, seq: n, ts: 1_000 + n, type, category: def?.category ?? 'system',
    source: { kind: 'visione', id: 'core' }, target: null, correlationId: 'c', causationId: null,
    severity: def?.severity ?? 'info', durability: def?.durability ?? 'durable', schema: 1, payload, ...over
  } as VisioneEvent;
}

describe('impostazioni: a caldo, solo voce o riavvio', () => {
  it('scena, nomi, durata dei nodi, lingua e wake valgono subito; la voce riparte da sola; il resto chiede il riavvio', () => {
    expect(changeKind(['ui.scene', 'ui.nodeLingerSec', 'ui.directorName', 'ui.language', 'voice.wake.enabled'])).toBe('hot');
    expect(changeKind(['voice.noiseGate', 'ui.scene'])).toBe('voice');
    expect(changeKind(['voice.tts.voice', 'director.maxConcurrentTasks'])).toBe('app');
    expect(changeKind(['policy.trustedAgents'])).toBe('app');
    expect(changeKind([])).toBe('hot');
  });

  it('lavoro in corso dai dati del core: obiettivi, task, agenti; la frase salta le voci a zero', () => {
    expect(busyOf(null)).toBeNull();
    const core = { director: { activeGoals: 1 }, tasks: { active: 2 }, agents: { working: 0 } } as unknown as CoreStateSnapshot;
    const b = busyOf(core);
    expect(b?.total).toBe(3);
    expect(b && busyText(b)).toBe('1 obiettivo del Director, 2 task');
    expect(busyText({ goals: 0, tasks: 0, agents: 2, total: 2 })).toBe('2 agenti al lavoro');
  });
});

describe('log leggibile: niente routine, una frase per riga', () => {
  it('telemetria al secondo, ping e livelli voce sono routine; avvisi ed errori mai', () => {
    expect(isRoutine(ev('telemetry.sample'))).toBe(true);
    expect(isRoutine(ev('telemetry.aggregate'))).toBe(true);
    expect(isRoutine(ev('voice.level', { rms: 0.1 }))).toBe(true);
    expect(isRoutine(ev('system.pong'))).toBe(true);
    expect(isRoutine(ev('agent.message.text', { agentId: 'a', text: 'pez', final: false }))).toBe(true);
    expect(isRoutine(ev('agent.message.text', { agentId: 'a', text: 'fatto', final: true }))).toBe(false);
    expect(isRoutine(ev('task.created', { title: 'x' }))).toBe(false);
    expect(isRoutine(ev('system.event.rejected'))).toBe(false);
    expect(isRoutine(ev('telemetry.sample', {}, { severity: 'warning' }))).toBe(false);
  });

  it('chi fa cosa e cosa tocca, con i nomi scelti dal proprietario', () => {
    const names = { esecutore: 'Esecutore', director: 'Jarvis' };
    expect(describeEvent(ev('task.created', { taskId: 'T1', title: 'Scrivi il report', assigneeAgentId: 'esecutore' }), names)).toBe('Task creato: «Scrivi il report» → Esecutore');
    expect(describeEvent(ev('tool.call.finished', { agentId: 'esecutore', tool: 'Write', ok: false, durationMs: 1500 }), names)).toBe('Esecutore: Write FALLITO in 1.5 s');
    expect(describeEvent(ev('file.created', { path: 'C:\\x\\a.txt', kind: 'file' }))).toBe('Creato il file C:\\x\\a.txt');
    expect(describeEvent(ev('director.decision', { decision: 'assign', agentId: 'esecutore', reason: 'scrittura' }), names)).toBe('Director assegna → Esecutore: scrittura');
    expect(describeEvent(ev('system.config.changed', { changed: ['ui.fullscreen'], restartRequired: true }))).toBe('Impostazioni cambiate: ui.fullscreen (valgono dal riavvio)');
    expect(describeEvent(ev('system.journal.degraded'))).toContain('scrittura');
    expect(describeEvent(ev('qualcosa.di.nuovo'))).toBe('qualcosa.di.nuovo');
    // Payload incompleto: frase comunque, mai un'eccezione.
    for (const type of Object.keys(EVENT_DEFINITIONS)) expect(() => describeEvent(ev(type)), type).not.toThrow();
  });
});

describe('durata dei nodi a schermo', () => {
  it('lettura dalla configurazione con ripiego a 30 s e limiti 5…600', () => {
    expect(nodeLingerOf({ ui: { nodeLingerSec: 90 } })).toBe(90);
    expect(nodeLingerOf({ ui: {} })).toBe(30);
    expect(nodeLingerOf({ ui: { nodeLingerSec: 'x' } })).toBe(30);
    expect(clampLinger(1)).toBe(5);
    expect(clampLinger(9_999)).toBe(600);
    expect(clampLinger(Number.NaN)).toBe(30);
    expect(leaves({ ui: { nodeLingerSec: 30, fullscreen: true } }).map((l) => l.path)).toEqual(['ui.fullscreen']);
  });

  it('il motore applica subito la durata nuova: più corta toglie ora il nodo concluso', () => {
    let clock = 100_000;
    const { engine, messages } = createEngine({ now: () => clock });
    const nodes = (): string[] => {
      const last = messages.filter((m) => m.type === 'graph').at(-1);
      return last?.type === 'graph' ? last.nodes.map((x) => x.id) : [];
    };
    engine.handle({ type: 'live', events: [ev('task.status.changed', { taskId: 'T9', from: 'running', to: 'succeeded' }, { target: { kind: 'task', id: 'T9' }, ts: 100_000 })] });
    expect(nodes()).toContain('task:T9');
    clock = 110_000;
    engine.handle({ type: 'linger', ms: 60_000 });
    expect(nodes()).toContain('task:T9');
    engine.handle({ type: 'linger', ms: 5_000 });
    expect(nodes()).not.toContain('task:T9');
    expect(() => engine.handle({ type: 'linger', ms: Number.NaN })).not.toThrow();
  });
});

describe('widget Umanoide', () => {
  it('stato sotto la figura (16/10/2026): parla, ascolta, lavora, fermo o voce spenta, dal più urgente', () => {
    const v = (over: { status?: string; listening?: boolean; speaking?: string | null; armed?: boolean } = {}) =>
      ({ status: over.status ?? 'ready', listening: over.listening ?? false, speaking: over.speaking ?? null, wake: { armed: over.armed ?? false } });
    expect(humanoidStatus(v({ speaking: 'tts-1', listening: true }), true)).toBe('speaking');
    expect(humanoidStatus(v({ listening: true }), true)).toBe('listening');
    expect(humanoidStatus(v({ armed: true }), false)).toBe('listening');
    expect(humanoidStatus(v(), true)).toBe('working');
    expect(humanoidStatus(v({ status: 'off' }), true)).toBe('working');
    expect(humanoidStatus(v(), false)).toBe('idle');
    expect(humanoidStatus(v({ status: 'off' }), false)).toBe('off');
    expect(humanoidStatus(null, false)).toBe('off');
  });

  it('figura stabile: stesse particelle a ogni avvio, tutte le parti presenti, nessun valore non finito', () => {
    const a = buildFigure(3_000);
    const b = buildFigure(3_000);
    expect(a.count).toBe(b.count);
    expect(Array.from(a.pos.slice(0, 30))).toEqual(Array.from(b.pos.slice(0, 30)));
    expect(a.count).toBeGreaterThan(2_500);
    for (const p of Object.values(PART)) expect(a.part.includes(p), `parte ${p}`).toBe(true);
    expect(a.pos.every((v) => Number.isFinite(v))).toBe(true);
    // Le spalle sono molto più larghe della testa.
    const maxX = (part: number): number => {
      let m = 0;
      for (let i = 0; i < a.count; i++) if (a.part[i] === part) m = Math.max(m, Math.abs(a.pos[i * 3] ?? 0));
      return m;
    };
    expect(maxX(PART.body)).toBeGreaterThan(maxX(PART.head) * 2);
    expect(headSection(5)).toBeNull();
  });

  it('rotazione: yaw positivo porta il naso a destra, pitch positivo in alto; la distanza dal perno non cambia', () => {
    expect(rotate(0, 0.4, 0.6, 0.5, 0, -0.2)[0]).toBeGreaterThan(0);
    expect(rotate(0, 0.4, 0.6, 0, 0.3, -0.2)[1]).toBeGreaterThan(0.4);
    const [rx, ry, rz] = rotate(0.3, 0.5, 0.2, 0.7, -0.2, -0.2);
    expect(Math.hypot(rx, ry + 0.2, rz)).toBeCloseTo(Math.hypot(0.3, 0.7, 0.2), 9);
    expect(project(1, 1, 0, 100, 100, 50)).toEqual([150, 50, 1]);
  });

  it('sguardo: chi sta a sinistra nell\'immagine della webcam è alla destra dello schermo; limiti rispettati', () => {
    expect(gazeFromCamera(0.2, 0.45).yaw).toBeGreaterThan(0);
    expect(gazeFromCamera(0.8, 0.45).yaw).toBeLessThan(0);
    expect(Math.abs(gazeFromCamera(-5, 9).yaw)).toBeLessThanOrEqual(MAX_YAW);
    expect(Math.abs(gazeFromCamera(-5, 9).pitch)).toBeLessThanOrEqual(MAX_PITCH);
    expect(gazeFromPointer(0.9, 0.5).yaw).toBeGreaterThan(0);
    expect(gazeFromPointer(0.5, 0.1).pitch).toBeGreaterThan(0);
    expect(follow(0, 1, 0)).toBe(0);
    expect(follow(0, 1, 10)).toBeCloseTo(1, 6);
    expect(follow(0.3, Number.NaN, 0.1)).toBe(0.3);
  });

  it('parlato: zero quando VISIONE tace, tra 0 e 1 quando parla, con sillabe (non costante)', () => {
    expect(speechEnvelope(1.23, false)).toBe(0);
    const vals = Array.from({ length: 200 }, (_, i) => speechEnvelope(i / 60, true));
    expect(vals.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(Math.max(...vals)).toBeGreaterThan(0.5);
    expect(vals.filter((v) => v === 0).length).toBeGreaterThan(20);
  });

  it('webcam: la testa è la parte alta di chi si muove; immagine ferma = nessun movimento', () => {
    const bg = new Float32Array(MOTION_W * MOTION_H).fill(40);
    const frame = new Uint8Array(MOTION_W * MOTION_H).fill(40);
    expect(motionCentroid(frame, bg).mass).toBe(0);
    // Una persona che si sposta a sinistra nell'immagine: testa in alto, busto sotto.
    for (let y = 10; y < 70; y++) for (let x = 12; x < 30; x++) frame[y * MOTION_W + x] = 200;
    const m = motionCentroid(frame, bg);
    expect(m.mass).toBeGreaterThan(0.03);
    expect(m.cx).toBeGreaterThan(0.18);
    expect(m.cx).toBeLessThan(0.26);
    // Il centro di tutto sarebbe a metà altezza (0,55): la testa sta nel terzo alto.
    expect(m.cy).toBeLessThan(0.36);
    expect(gazeFromCamera(m.cx, m.cy).yaw).toBeGreaterThan(0);
    // Lo sfondo impara: se la persona resta ferma a lungo, smette di essere movimento.
    for (let i = 0; i < 80; i++) motionCentroid(frame, bg);
    expect(motionCentroid(frame, bg).mass).toBe(0);
  });

  it('parlando pulsa a onde solo la metà bassa della testa, dalla bocca; zitto, niente onde', () => {
    expect(mouthWave(0, MOUTH_Y, 1, 0)).toEqual({ push: 0, glow: 0 });
    expect(mouthWave(0, WAVE_TOP_Y + 0.1, 1, 1)).toEqual({ push: 0, glow: 0 });
    const samples = Array.from({ length: 60 }, (_, i) => mouthWave(0.05, MOUTH_Y - 0.05, i / 30, 1));
    expect(Math.max(...samples.map((w) => w.push))).toBeGreaterThan(0.005);
    expect(Math.min(...samples.map((w) => w.push))).toBeLessThan(-0.005);
    expect(samples.every((w) => w.glow >= 0 && w.glow <= 1)).toBe(true);
    // Lontano dalla bocca l'onda si spegne.
    const far = Math.max(...Array.from({ length: 60 }, (_, i) => Math.abs(mouthWave(0.45, 0.0, i / 30, 1).push)));
    const near = Math.max(...samples.map((w) => Math.abs(w.push)));
    expect(far).toBeLessThan(near);
  });

  it('formazione all\'avvio: dal basso all\'alto, ogni particella arriva al suo posto, poi 100%', () => {
    expect(assemblyDelay(FIGURE_BOTTOM, 0)).toBeLessThan(assemblyDelay(FIGURE_TOP, 0));
    expect(assemblyProgress(0, 1)).toBe(0);
    expect(assemblyProgress(10, 1)).toBe(1);
    const mid = assemblyProgress(1.3, 1);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // Tutte le particelle sono arrivate entro la fine della formazione.
    expect(assemblyProgress(ASSEMBLY_TOTAL_S, assemblyDelay(FIGURE_TOP, 1))).toBe(1);
    expect(assemblyPercent(0)).toBe(0);
    expect(assemblyPercent(ASSEMBLY_TOTAL_S)).toBe(100);
    const f = buildFigure(2_000);
    expect(f.from.length).toBe(f.count * 3);
    // Partono da sotto la figura.
    for (let i = 0; i < f.count; i += 97) expect(f.from[i * 3 + 1]!).toBeLessThan(FIGURE_BOTTOM);
  });

  it('busto: archi solo dentro la sagoma, il collo resta libero', () => {
    expect(insideBody(0, -1.0)).toBe(true);
    expect(insideBody(0, -0.3)).toBe(false);
    expect(insideBody(1.5, -1.0)).toBe(false);
    expect(insideBody(0.9, -0.3)).toBe(false);
  });
});
