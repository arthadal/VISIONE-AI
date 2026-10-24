// P-83 — Menu modello/potenza: `agents.models` unisce modelli configurati (corrente, altri agenti,
// defaultModel) e sondaggio reale dell'adapter; `agents.tuning` applica alla definizione con
// validazione dell'adapter e audit. Motori finti: nessuna rete, nessun modello inventato.
import { afterEach, describe, expect, it } from 'vitest';
import { agentInput, createStack, fakeAdapter, type Stack } from '../orchestration-harness.ts';

const stacks: Stack[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) await s.close();
});
function stack(opts: Parameters<typeof createStack>[0] = {}): Stack {
  const s = createStack(opts);
  stacks.push(s);
  return s;
}

describe('P-83 — modelli e potenza di un agente', () => {
  it('elenco: corrente + altri agenti dello stesso adapter + probe; potenza dichiarata dal motore', async () => {
    const adapter = fakeAdapter('motore-a', {
      models: ['motore-a/beta', 'motore-a/gamma'],
      effort: ['low', 'high'],
      capabilities: ['turns.headless', 'events.turnEnd', 'model.select']
    });
    const other = fakeAdapter('motore-b', { models: ['motore-b/delta'], capabilities: ['turns.headless', 'model.select'] });
    const s = stack({ adapters: [adapter, other] });
    s.agents.define(agentInput('ag', 'motore-a', { engine: { adapter: 'motore-a', model: 'motore-a/alfa' } }), 'owner', 'c1');
    s.agents.define(agentInput('ag2', 'motore-a', { engine: { adapter: 'motore-a', model: 'motore-a/epsilon' } }), 'owner', 'c2');
    const out = await s.agents.models('ag', { refresh: true });
    expect(out).toMatchObject({ adapter: 'motore-a', current: 'motore-a/alfa', selectable: true, live: false, applies: 'next-turn' });
    // Corrente e modello dell'altro agente (config) + i due sondati, senza duplicati e di altri adapter.
    expect(out.models.map((m) => m.id).sort()).toEqual(['motore-a/alfa', 'motore-a/beta', 'motore-a/epsilon', 'motore-a/gamma']);
    expect(out.models.find((m) => m.id === 'motore-a/beta')?.source).toBe('probe');
    expect(out.models.find((m) => m.id === 'motore-a/epsilon')?.detail).toBe('agente ag2');
    expect(out.effort).toEqual({ current: null, options: ['low', 'high'] });
  });

  it('applica modello e potenza: definizione aggiornata (v+1), visibile alla lettura e auditata', async () => {
    const adapter = fakeAdapter('motore-a', {
      models: ['motore-a/beta'],
      effort: ['low', 'high'],
      capabilities: ['turns.headless', 'events.turnEnd', 'model.select']
    });
    const s = stack({ adapters: [adapter] });
    s.agents.define(agentInput('ag', 'motore-a', { engine: { adapter: 'motore-a', model: 'motore-a/alfa' } }), 'owner', 'c1');
    const changed = s.agents.tuning('ag', { model: 'motore-a/beta', effort: 'high' }, 'owner:test', 'corr-tune-1');
    expect(changed).toMatchObject({ agentId: 'ag', model: 'motore-a/beta', effort: 'high', version: 2, applies: 'next-turn', live: false });
    const after = await s.agents.models('ag');
    expect(after.current).toBe('motore-a/beta');
    expect(after.effort?.current).toBe('high');
    expect(s.audit.list(20)).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'agent.update', subject: 'ag' })]));
    // Invalidare il modello non è possibile con l'adapter finto (validate accetta): qui si prova
    // solo che l'agente sconosciuto e la potenza non dichiarata falliscono in modo esplicito.
    expect(() => s.agents.tuning('ignoto', { model: 'x' }, 'owner', 'corr-tune-2')).toThrow(/sconosciuto/);
  });

  it('motore senza selezione modello o potenza: N/D onesto', async () => {
    const plain = fakeAdapter('motore-p', { capabilities: ['turns.headless', 'events.turnEnd'] });
    const s = stack({ adapters: [plain] });
    s.agents.define(agentInput('p', 'motore-p', { engine: { adapter: 'motore-p', model: 'motore-p/x' } }), 'owner', 'c1');
    const out = await s.agents.models('p');
    expect(out.selectable).toBe(false);
    expect(out.effort).toBeNull();
    expect(() => s.agents.tuning('p', { effort: 'high' }, 'owner', 'corr-tune-3')).toThrow(/non dichiara la potenza/);
  });

  it('P-100: modello e potenza scelti valgono nel turno VERO successivo e persistono', async () => {
    const adapter = fakeAdapter('motore-a', {
      models: ['motore-a/beta'],
      effort: ['low', 'high'],
      capabilities: ['turns.headless', 'events.turnEnd', 'model.select']
    });
    const s = stack({ adapters: [adapter] });
    s.agents.define(agentInput('ag', 'motore-a', { engine: { adapter: 'motore-a', model: 'motore-a/alfa' } }), 'owner', 'c1');
    // Primo turno col modello iniziale: l'adapter registra cosa riceve davvero.
    const first = await s.agents.runTurn({
      taskId: 't1', agentId: 'ag', title: 'uno', spec: 'RISPOSTA:ok', acceptance: null,
      correlationId: 'corr-t1', attempt: 1, signal: new AbortController().signal
    });
    expect(first.status).toBe('succeeded');
    // Scelta dal pannello (come la UI): `agents.tuning` valida e aggiorna la definizione con audit.
    const changed = s.agents.tuning('ag', { model: 'motore-a/beta', effort: 'high' }, 'owner:settings', 'corr-p100');
    expect(changed).toMatchObject({ model: 'motore-a/beta', effort: 'high', version: 2, applies: 'next-turn' });
    // Turno VERO successivo: modello e potenza persistiti arrivano all'adapter.
    const second = await s.agents.runTurn({
      taskId: 't2', agentId: 'ag', title: 'due', spec: 'RISPOSTA:ok2', acceptance: null,
      correlationId: 'corr-t2', attempt: 1, signal: new AbortController().signal
    });
    expect(second.status).toBe('succeeded');
    const calls = s.adapters['motore-a']?.turns ?? [];
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ model: 'motore-a/alfa', effort: null });
    expect(calls[1]).toMatchObject({ model: 'motore-a/beta', effort: 'high' });
    // Persistenza nel registro: la scelta resta dopo il turno e la definizione è v2.
    expect(s.agents.get('ag')).toMatchObject({ version: 2, engine: { model: 'motore-a/beta', options: { effort: 'high' } } });
    const after = await s.agents.models('ag');
    expect(after).toMatchObject({ current: 'motore-a/beta', effort: { current: 'high' } });
  });
});
