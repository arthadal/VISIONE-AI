// Widget aggiunti con lo schermo pulito (11/10/2026): griglia del Calendario e Ultime risposte degli agenti.
import { describe, expect, it } from 'vitest';
import type { VisioneEvent } from '../../src/shared/contracts/index.ts';
import { lastReplies, monthGrid, shiftMonth } from '../../src/renderer/app/widgets/more-logic.ts';

const msg = (id: string, agentId: string, text: string, final: boolean, ts: number): VisioneEvent => ({
  id, seq: null, ts, type: 'agent.message.text', category: 'agent', severity: 'info', durability: 'durable',
  source: { kind: 'visione', id: 'core' }, target: null, correlationId: 'c', causationId: null, schema: 1,
  payload: { agentId, turnId: 't', text, chars: text.length, final }
} as unknown as VisioneEvent);

describe('Calendario', () => {
  it('ottobre 2026 dal lunedì: 42 caselle, il primo cade di giovedì, oggi evidenziato una volta', () => {
    const cells = monthGrid(2026, 9, 1, new Date(2026, 9, 11, 12));
    expect(cells.length).toBe(42);
    // 1/10/2026 è un giovedì: tre caselle di settembre prima.
    expect(cells.slice(0, 4).map((c) => [c.day, c.inMonth])).toEqual([[28, false], [29, false], [30, false], [1, true]]);
    expect(cells.filter((c) => c.today).map((c) => c.key)).toEqual(['2026-10-11']);
    expect(cells.filter((c) => c.inMonth).length).toBe(31);
  });

  it('mese di un altro anno senza «oggi»; avanti e indietro attraverso l\'anno', () => {
    expect(monthGrid(2027, 0, 1, new Date(2026, 9, 11)).some((c) => c.today)).toBe(false);
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });
});

describe('Ultime risposte', () => {
  it('solo i testi finali dei turni, i più recenti prima, al più n; spazi ripuliti e testo lungo tagliato', () => {
    const events = [
      msg('a', 'esecutore', 'pezzo', false, 1),
      msg('b', 'esecutore', 'PRONTO', true, 2),
      msg('c', 'revisore', '  tutto   bene  ', true, 3),
      msg('d', 'ricercatore', 'x'.repeat(400), true, 4),
      msg('e', 'revisore', '   ', true, 5)
    ];
    const r = lastReplies(events, 2);
    expect(r.map((x) => x.agentId)).toEqual(['ricercatore', 'revisore']);
    expect(r[0]?.text.length).toBe(280);
    expect(r[1]?.text).toBe('tutto bene');
    expect(lastReplies(events).map((x) => x.id)).toEqual(['d', 'c', 'b']);
    expect(lastReplies([])).toEqual([]);
  });
});
