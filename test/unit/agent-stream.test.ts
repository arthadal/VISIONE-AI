// P-93: terminale dei motori headless = stream REALE del turno. Qui si verifica la proiezione pura
// dagli eventi del bridge: niente righe inventate, l'ordine è quello reale e i casi limite
// (messaggi multi-riga, errori, limiti, agente diverso) sono coperti.
import { describe, expect, it } from 'vitest';
import type { VisioneEvent } from '../../src/shared/contracts/index.ts';
import { agentStream, MAX_STREAM_LINES, mergeStreamEvents } from '../../src/renderer/windows/panes/agentStream.ts';

const ev = (ts: number, type: string, payload: Record<string, unknown> = {}, severity = 'info'): VisioneEvent => ({
  id: `01J${String(ts).padStart(10, '0')}ABCDEFGHJKMNPQRS`, seq: ts, ts, type, category: 'agent',
  source: { kind: 'agent', id: 'ultra' }, target: null, correlationId: 'correlazione', causationId: null,
  severity: severity as VisioneEvent['severity'], durability: 'durable', schema: 1, payload
});

describe('P-93 — stream reale del turno (motori headless)', () => {
  it('turno completo: sessione, avvio, tool, testo, completamento — in ordine', () => {
    const events = [
      ev(100, 'agent.session.started', { agentId: 'ultra', engineSessionId: 'ses_abc123' }),
      ev(200, 'agent.turn.started', { agentId: 'ultra', taskId: 'tsk_0123456789', turnId: 'turn-1' }),
      ev(300, 'tool.call.started', { agentId: 'ultra', tool: 'read', turnId: 'turn-1' }),
      ev(400, 'tool.call.finished', { agentId: 'ultra', tool: 'read', ok: true, durationMs: 42, turnId: 'turn-1' }),
      ev(500, 'agent.message.text', { agentId: 'ultra', text: 'Sono NEMO ULTRA.', final: true, turnId: 'turn-1' }),
      ev(600, 'agent.turn.finished', { agentId: 'ultra', outcome: 'completed', error: null, turnId: 'turn-1' })
    ];
    const lines = agentStream(events, 'ultra');
    expect(lines.map((l) => [l.kind, l.text])).toEqual([
      ['session', 'sessione motore ses_abc123'],
      ['turn', 'turno avviato · task 456789'],
      ['tool', 'tool read avviato'],
      ['tool', 'tool read ok · 42 ms'],
      ['text', 'Sono NEMO ULTRA.'],
      ['turn', 'turno completato']
    ]);
  });

  it('solo l\'agente chiesto; messaggi multi-riga diventano più righe; errori e limiti reali', () => {
    const events = [
      ev(100, 'agent.message.text', { agentId: 'coder', text: 'prima riga\nseconda riga' }),
      ev(200, 'agent.message.text', { agentId: 'ultra', text: 'riga di ultra' }),
      ev(300, 'agent.turn.finished', { agentId: 'ultra', outcome: 'failed', error: { code: 'provider_unavailable', message: 'provider non disponibile' } }),
      ev(400, 'agent.limit.reached', { agentId: 'ultra', scope: 'weekly', message: '\u001b[38;2;255;107;128mYou\'ve hit your weekly limit\u001b[0m', resetAt: 'ott7,18' }),
      ev(500, 'agent.turn.finished', { agentId: 'ultra', outcome: 'cancelled', error: null }),
      ev(600, 'agent.usage.updated', { agentId: 'ultra', usage: { inputTokens: 12 } })
    ];
    const lines = agentStream(events, 'ultra');
    expect(lines.map((l) => l.text)).toEqual([
      'riga di ultra',
      'turno fallito: provider non disponibile',
      'limite weekly raggiunto: You\'ve hit your weekly limit · ripristino ott7,18',
      'turno annullato: cancelled'
    ]);
    expect(lines.find((l) => l.text === 'riga di ultra')?.kind).toBe('text');
    expect(lines.find((l) => l.text.startsWith('turno fallito'))?.kind).toBe('error');
    expect(lines.find((l) => l.text.startsWith('limite'))?.kind).toBe('limit');
    // Nessuna riga per l'evento usage (sta nel tab METRICS) né per l'altro agente.
    expect(agentStream(events, 'sconosciuto')).toEqual([]);
  });

  it('tiene al massimo MAX_STREAM_LINES righe, le più recenti', () => {
    const events = Array.from({ length: MAX_STREAM_LINES + 25 }, (_, i) => ev(1_000 + i, 'agent.message.text', { agentId: 'ultra', text: `riga ${i}` }));
    const lines = agentStream(events, 'ultra');
    expect(lines).toHaveLength(MAX_STREAM_LINES);
    expect(lines[0]?.text).toBe('riga 25');
    expect(lines.at(-1)?.text).toBe(`riga ${MAX_STREAM_LINES + 24}`);
  });

  it('storico + eventi vivi: deduplica per id e conserva l\'ordine', () => {
    const a = ev(100, 'agent.turn.started', { agentId: 'ultra' });
    const b = ev(200, 'agent.message.text', { agentId: 'ultra', text: 'risposta' });
    const c = ev(300, 'agent.turn.finished', { agentId: 'ultra', outcome: 'completed' });
    // Un evento già nello storico può riapparire nel flusso vivo (sottoscrizione): non si duplica.
    const merged = mergeStreamEvents([a, b], [b, c]);
    expect(merged.map((e) => e.id)).toEqual([a.id, b.id, c.id]);
    expect(agentStream(merged, 'ultra').map((l) => l.text)).toEqual(['turno avviato', 'risposta', 'turno completato']);
  });
});
