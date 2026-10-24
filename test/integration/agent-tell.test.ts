// Fase 21 (P-67) — chat diretta proprietario → agente. Un messaggio crea un task assegnato
// all'agente scelto, senza passare dal Director (nessuna pianificazione): il turno gira sulla
// sessione reale di quell'agente e gli eventi restano suoi (nessun cross-talk).
import { afterEach, describe, expect, it } from 'vitest';
import { tellAgent } from '../../src/core/director/index.ts';
import { agentInput, createStack, type Stack } from '../orchestration-harness.ts';

const stacks: Stack[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) await s.close();
});
function stack(opts: Parameters<typeof createStack>[0] = {}): Stack {
  const s = createStack(opts);
  stacks.push(s);
  return s;
}

describe('chat diretta owner → agente (agents.tell)', () => {
  it('il messaggio diventa un task dell\'agente scelto, eseguito sulla sua sessione, senza Director', async () => {
    const s = stack();
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b'), 'owner', 'c2');

    const out = tellAgent(
      { engine: s.engine, agents: s.agents },
      { agentId: 'alfa', text: 'Rispondi al proprietario. RISPOSTA:ciao dal canale diretto', by: 'ui' },
      { correlationId: 'corr-tell-0001', causationId: 'cmd-tell-0001' }
    );
    expect(out.agentId).toBe('alfa');
    await s.settle();

    const step = s.engine.get(out.taskIds[0] ?? '');
    expect(step).toMatchObject({ status: 'succeeded', assigneeAgentId: 'alfa', createdBy: 'owner:ui:tell' });
    expect(s.engine.get(out.taskId)?.status).toBe('succeeded');
    // Il turno è andato SOLO all'agente scelto.
    const adapterA = s.adapters['motore-a'];
    expect(adapterA).toBeDefined();
    expect(adapterA?.turns.map((t) => t.text).join('\n')).toContain('canale diretto');
    expect(s.adapters['motore-b']?.turns).toEqual([]);
    // Nessun passaggio dal Director: nessun obiettivo pianificato.
    expect(s.events('director.goal.received')).toEqual([]);
    expect(s.events('task.created').length).toBeGreaterThan(0);
    expect(s.events('task.result.recorded').length).toBeGreaterThan(0);
  });

  it('agente sconosciuto o archiviato: errore esplicito, nessun task creato', () => {
    const s = stack();
    expect(() =>
      tellAgent({ engine: s.engine, agents: s.agents }, { agentId: 'fantasma', text: 'x', by: 'ui' }, { correlationId: 'c' })
    ).toThrow(/sconosciuto/);
    expect(s.engine.list({ limit: 10 })).toEqual([]);
  });
});
