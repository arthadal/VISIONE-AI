// Fase G6 (P-78): gli effetti one-shot nascono SOLO da eventi reali conclusivi (task/agent/processi/
// voce/sistema). Qui si verifica la mappa pura, il cursore delle novità e la guardia sulla storia.
import { describe, expect, it } from 'vitest';
import type { VisioneEvent } from '../../src/shared/contracts/index.ts';
import { EFFECT_MS, eventsAfter, effectOf, isFresh, latestEffect } from '../../src/renderer/app/effects.ts';

const ev = (ts: number, type: string, payload: Record<string, unknown> = {}, severity = 'info'): VisioneEvent => ({
  id: `01J${String(ts).padStart(10, '0')}ABCDEFGHJKMNPQRS`, seq: ts, ts, type, category: 'task',
  source: { kind: 'system', id: 'core' }, target: null, correlationId: 'correlazione', causationId: null,
  severity: severity as VisioneEvent['severity'], durability: 'durable', schema: 1, payload
});

describe('G6 — effetti su eventi reali (P-78)', () => {
  it('task: completato → pulse, parziale → scan, fallito → glitch', () => {
    expect(effectOf(ev(100, 'task.result.recorded', { outcome: 'success' }))).toMatchObject({ kind: 'pulse', at: 100, cause: 'task.result.recorded' });
    expect(effectOf(ev(200, 'task.result.recorded', { outcome: 'partial' }))).toMatchObject({ kind: 'scan' });
    expect(effectOf(ev(300, 'task.result.recorded', { outcome: 'failure' }))).toMatchObject({ kind: 'glitch' });
    // Le transizioni intermedie non producono punteggiatura: solo timeout/blocco sono segnali.
    expect(effectOf(ev(400, 'task.status.changed', { to: 'running' }))).toBeNull();
    expect(effectOf(ev(500, 'task.status.changed', { to: 'timed_out' }))).toMatchObject({ kind: 'glitch' });
    expect(effectOf(ev(600, 'task.status.changed', { to: 'blocked' }))).toMatchObject({ kind: 'scan' });
  });

  it('agenti e processi: errore → glitch, recupero → scan, guasto → shake', () => {
    expect(effectOf(ev(100, 'agent.status.changed', { to: 'error' }))).toMatchObject({ kind: 'glitch' });
    expect(effectOf(ev(200, 'agent.status.changed', { to: 'crashed' }))).toMatchObject({ kind: 'glitch' });
    expect(effectOf(ev(300, 'agent.status.changed', { to: 'recovering' }))).toMatchObject({ kind: 'scan' });
    expect(effectOf(ev(400, 'agent.status.changed', { to: 'working' }))).toBeNull();
    expect(effectOf(ev(500, 'process.failed'))).toMatchObject({ kind: 'glitch' });
    expect(effectOf(ev(600, 'process.crashed'))).toMatchObject({ kind: 'shake' });
    expect(effectOf(ev(700, 'system.error', { code: 'X' }))).toMatchObject({ kind: 'glitch' });
    expect(effectOf(ev(800, 'core.crashed'))).toMatchObject({ kind: 'shake' });
  });

  it('voce: PTT premuto → flash, trascrizione → scan, errore → glitch; il livello non produce nulla', () => {
    expect(effectOf(ev(100, 'voice.ptt.pressed', { source: 'ui' }))).toMatchObject({ kind: 'flash' });
    expect(effectOf(ev(200, 'voice.stt.final', { text: 'ciao' }))).toMatchObject({ kind: 'scan' });
    expect(effectOf(ev(300, 'voice.error', { code: 'x' }))).toMatchObject({ kind: 'glitch' });
    expect(effectOf(ev(400, 'voice.level', { rms: 0.4 }))).toBeNull();
    // Eventi informativi che NON meritano un frame effect: la UI non deve «vibrare» senza motivo.
    expect(effectOf(ev(500, 'agent.message.sent'))).toBeNull();
    expect(effectOf(ev(600, 'tool.call.started', { tool: 'read' }))).toBeNull();
  });

  it('il cursore delle novità non ripropone la storia e regge i lotti', () => {
    const a = ev(100, 'task.result.recorded', { outcome: 'success' });
    const b = ev(200, 'task.result.recorded', { outcome: 'failure' });
    const c = ev(300, 'voice.ptt.pressed', { source: 'ui' });
    const win = [a, b, c];
    expect(eventsAfter(win, null)).toEqual([]);
    expect(eventsAfter(win, a.id)).toEqual([b, c]);
    expect(eventsAfter(win, c.id)).toEqual([]);
    // Id uscito dalla finestra: non si indovina, niente effetti su eventi vecchi.
    expect(eventsAfter(win, '01J9999999999ABCDEFGHJKMNPQRS')).toEqual([]);
  });

  it('la storia del journal non produce effetti; il core corrente sì', () => {
    const old = ev(1_000, 'task.result.recorded', { outcome: 'failure' });
    const live = ev(2_000, 'task.result.recorded', { outcome: 'success' });
    const startedAt = 1_500;
    expect(isFresh(old, startedAt)).toBe(false);
    expect(isFresh(live, startedAt)).toBe(true);
    expect(isFresh(live, null)).toBe(false);
  });

  it('in una raffica vince l\'ultimo evento reale; le durate sono dichiarate', () => {
    const fresh = [ev(100, 'voice.ptt.pressed', { source: 'ui' }), ev(200, 'task.result.recorded', { outcome: 'success' })];
    expect(latestEffect(fresh)).toMatchObject({ kind: 'pulse', cause: 'task.result.recorded' });
    expect(latestEffect([])).toBeNull();
    for (const ms of Object.values(EFFECT_MS)) expect(ms).toBeGreaterThan(0);
  });
});
