// Fase 18 — Window Manager: stato puro (deduplica, focus/z, minimizza/ripristina, geometria).
import { describe, expect, it } from 'vitest';
import type { AgentView, CoreStateSnapshot, VisioneEvent } from '../../src/shared/contracts/index.ts';
import { EMPTY_WINDOWS, clampBounds, defaultBounds, frontWindow, reduceWindows, snapBounds, windowId, type WindowsState, type WindowKind } from '../../src/renderer/windows/manager.ts';
import { windowStatus, type WindowStatusContext } from '../../src/renderer/windows/status.ts';

const open = (state: WindowsState, kind: Parameters<typeof windowId>[0], ref: string | null = null, title = String(kind)): WindowsState =>
  reduceWindows(state, { type: 'open', kind, ref, title, vw: 1200, vh: 800 });

describe('Fase 18 — Window Manager', () => {
  it('apre una finestra con id stabile e bounds dentro il viewport', () => {
    const s = open(EMPTY_WINDOWS, 'director');
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]).toMatchObject({ id: 'director', kind: 'director', ref: null, minimized: false });
    const b = s.windows[0]!.bounds;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(1200);
    expect(b.y + b.h).toBeLessThanOrEqual(800);
  });

  it('deduplica: riaprire la stessa entità porta in primo piano, non crea una seconda finestra', () => {
    let s = open(EMPTY_WINDOWS, 'agent', 'dwight', 'dwight');
    s = open(s, 'director');
    const zBefore = s.windows.find((w) => w.id === 'director')!.z;
    s = open(s, 'agent', 'dwight', 'dwight aggiornato');
    expect(s.windows).toHaveLength(2); // nessuna terza finestra
    const agent = s.windows.find((w) => w.id === 'agent:dwight')!;
    expect(agent.title).toBe('dwight aggiornato');
    expect(agent.z).toBeGreaterThan(zBefore); // davanti a Director
    expect(frontWindow(s)?.id).toBe('agent:dwight');
  });

  it('agenti diversi hanno finestre diverse (per agentId); task diversi per taskId', () => {
    let s = open(EMPTY_WINDOWS, 'agent', 'dwight');
    s = open(s, 'agent', 'jim');
    s = open(s, 'task', 'T1');
    s = open(s, 'task', 'T2');
    expect(s.windows.map((w) => w.id).sort()).toEqual(['agent:dwight', 'agent:jim', 'task:T1', 'task:T2']);
    // Riferimenti reali conservati per collegare la finestra all'entità.
    expect(s.windows.find((w) => w.id === 'agent:jim')?.ref).toBe('jim');
  });

  it('focus e riduzione: la finestra ridotta può essere ripristinata e resta unica', () => {
    let s = open(EMPTY_WINDOWS, 'director');
    s = reduceWindows(s, { type: 'minimize', id: 'director' });
    expect(s.windows[0]!.minimized).toBe(true);
    expect(frontWindow(s)).toBeNull();
    // Riaprire una finestra minimizzata la ripristina (non ne crea una seconda).
    s = open(s, 'director');
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]!.minimized).toBe(false);
    // minimize → restore conserva la geometria.
    const before = s.windows[0]!.bounds;
    s = reduceWindows(s, { type: 'minimize', id: 'director' });
    s = reduceWindows(s, { type: 'restore', id: 'director' });
    expect(s.windows[0]!.bounds).toEqual(before);
  });

  it('sposta e ridimensiona con vincoli; chiude e chiude tutte', () => {
    let s = open(EMPTY_WINDOWS, 'logs');
    s = reduceWindows(s, { type: 'setBounds', id: 'logs', bounds: clampBounds({ x: -50, y: -50, w: 100, h: 50 }, 1200, 800) });
    const b = s.windows[0]!.bounds;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.w).toBeGreaterThanOrEqual(300);
    expect(b.h).toBeGreaterThanOrEqual(200);
    s = reduceWindows(s, { type: 'close', id: 'logs' });
    expect(s.windows).toHaveLength(0);
    s = open(s, 'telemetry');
    s = open(s, 'memory');
    s = reduceWindows(s, { type: 'closeAll' });
    expect(s.windows).toHaveLength(0);
  });

  it('tendina: si chiude e si riapre; minimizza/ripristina e riapertura la dispiegano', () => {
    let s = open(EMPTY_WINDOWS, 'director');
    s = reduceWindows(s, { type: 'toggleShade', id: 'director' });
    expect(s.windows[0]!.shaded).toBe(true);
    s = reduceWindows(s, { type: 'toggleShade', id: 'director' });
    expect(s.windows[0]!.shaded).toBe(false);
    // Ri-piega, poi minimizza+ripristina: la finestra torna dispiegata.
    s = reduceWindows(s, { type: 'toggleShade', id: 'director' });
    s = reduceWindows(s, { type: 'minimize', id: 'director' });
    s = reduceWindows(s, { type: 'restore', id: 'director' });
    expect(s.windows[0]!.shaded).toBe(false);
    // Riaprire una finestra piegata la dispiega (deduplica invariata).
    s = reduceWindows(s, { type: 'toggleShade', id: 'director' });
    s = open(s, 'director');
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]!.shaded).toBe(false);
  });

  it('defaultBounds resta nel viewport anche con molte finestre', () => {
    for (let i = 0; i < 12; i++) {
      const b = defaultBounds(i, 1000, 700);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(1000);
      expect(b.y + b.h).toBeLessThanOrEqual(700);
    }
  });

  it('id stabili: kind senza riferimento, kind:ref con riferimento', () => {
    expect(windowId('director')).toBe('director');
    expect(windowId('agent', 'dwight')).toBe('agent:dwight');
    expect(windowId('task', 'T1')).toBe('task:T1');
  });

  it('aggancio ai bordi (P-68): sinistra, destra, alto; lontano resta libero; sgancio = trascinare via', () => {
    // Vicino al bordo sinistro (entro 24 px) → x allineata a 0.
    expect(snapBounds({ x: 10, y: 120, w: 400, h: 300 }, 1200, 800)).toEqual({ x: 0, y: 120, w: 400, h: 300 });
    // Vicino al bordo destro → appoggiata al bordo.
    expect(snapBounds({ x: 1200 - 400 - 8, y: 120, w: 400, h: 300 }, 1200, 800).x).toBe(800);
    // Vicino al bordo alto → y allineata a 0.
    expect(snapBounds({ x: 200, y: 12, w: 400, h: 300 }, 1200, 800).y).toBe(0);
    // Lontana dai bordi: geometria invariata (clampata al viewport).
    expect(snapBounds({ x: 200, y: 120, w: 400, h: 300 }, 1200, 800)).toEqual({ x: 200, y: 120, w: 400, h: 300 });
    // Sgancio: trascinata via dal bordo, resta libera.
    expect(snapBounds({ x: 60, y: 60, w: 400, h: 300 }, 1200, 800)).toEqual({ x: 60, y: 60, w: 400, h: 300 });
  });
});

// Fase G5 (P-77): la testata di ogni finestra mostra uno stato REALE (o `N/D` spento), con la spia
// del lessico `.term-spia`. Qui si verifica solo la proiezione pura, senza DOM.
describe('Fase G5 — stato delle finestre (P-77)', () => {
  const win = (kind: WindowKind, ref: string | null = null, title: string = kind) =>
    reduceWindows(EMPTY_WINDOWS, { type: 'open', kind, ref, title, vw: 1200, vh: 800 }).windows[0]!;
  const ctx = (over: Partial<WindowStatusContext> = {}): WindowStatusContext => ({
    ready: true, core: null, events: [], pingMs: null, agents: null, reducedMotion: false, ...over
  });
  const coreWith = (over: Record<string, unknown>): CoreStateSnapshot => over as unknown as CoreStateSnapshot;
  const ev = (over: Record<string, unknown>): VisioneEvent => over as unknown as VisioneEvent;

  it('Director/agente/telemetria: valore reale quando esiste, N/D spento quando manca', () => {
    const core = coreWith({ core: { status: 'ready' }, processes: { active: 2 }, approvals: { pending: 0 } });
    expect(windowStatus(win('director'), ctx({ core }))).toMatchObject({ text: 'ready', tone: 'on' });
    expect(windowStatus(win('director'), ctx())).toMatchObject({ text: 'N/D', tone: 'off' });
    const agents = [{ definition: { id: 'dwight' }, instance: { status: 'working' } }] as unknown as AgentView[];
    expect(windowStatus(win('agent', 'dwight'), ctx({ agents }))).toMatchObject({ text: 'AL LAVORO', tone: 'on' });
    expect(windowStatus(win('agent', 'jim'), ctx({ agents }))).toMatchObject({ text: 'N/D', tone: 'off' });
    expect(windowStatus(win('telemetry'), ctx())).toMatchObject({ text: 'N/D', tone: 'off' });
    expect(windowStatus(win('telemetry'), ctx({ pingMs: 42 }))).toMatchObject({ text: '42 ms', tone: 'on' });
  });

  it('task: lo stato viene dalla storia reale di QUEL task, mai dedotto da altri', () => {
    const events = [
      ev({ type: 'task.status.changed', payload: { taskId: 'T1', to: 'running' } }),
      ev({ type: 'task.status.changed', payload: { taskId: 'T2', to: 'failed' } })
    ];
    expect(windowStatus(win('task', 'T1'), ctx({ events }))).toMatchObject({ text: 'running', tone: 'on' });
    expect(windowStatus(win('task', 'T2'), ctx({ events }))).toMatchObject({ text: 'failed', tone: 'error' });
    expect(windowStatus(win('task', 'T3'), ctx({ events }))).toMatchObject({ text: 'N/D', tone: 'off' });
  });

  it('approvazioni, processi e preferenza di movimento: numeri e stati reali', () => {
    const core = coreWith({ core: { status: 'ready' }, processes: { active: 0 }, approvals: { pending: 2 } });
    expect(windowStatus(win('approvals'), ctx({ core }))).toMatchObject({ text: '2 in attesa', tone: 'warn' });
    expect(windowStatus(win('terminal'), ctx({ core }))).toMatchObject({ text: '0 proc', tone: 'idle' });
    expect(windowStatus(win('settings'), ctx({ reducedMotion: true }))).toMatchObject({ text: 'moto ridotto' });
    expect(windowStatus(win('settings'), ctx({ reducedMotion: false }))).toMatchObject({ text: 'moto pieno' });
  });
});
