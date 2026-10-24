// P-99 — rinomina del display name di un agente: `agents.rename` aggiorna la definizione (v+1) con
// evento/audit, lascia l'id interno invariato e non tocca sessione/istanza. Motori finti, nessuna rete.
import { afterEach, describe, expect, it } from 'vitest';
import { agentInput, createStack, type Stack } from '../orchestration-harness.ts';

const stacks: Stack[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) await s.close();
});
function stack(): Stack {
  const s = createStack();
  stacks.push(s);
  return s;
}

describe('P-99 — rinomina di un agente (display name)', () => {
  it('cambia il nome mostrato, non l\'id: versione +1, evento e audit', async () => {
    const s = stack();
    s.agents.define(agentInput('ag', 'motore-a'), 'owner', 'c1');
    const out = s.agents.rename('ag', 'Nuovo Nome', 'owner:test', 'corr-rename-1');
    expect(out).toEqual({ agentId: 'ag', name: 'Nuovo Nome', version: 2, changed: true });
    // L'id interno non cambia e la lettura mostra il nuovo nome.
    const views = s.agents.views({ includeArchived: false, breakerOf: () => 'closed' });
    expect(views.map((v) => [v.definition.id, v.definition.name])).toEqual([['ag', 'Nuovo Nome']]);
    expect(s.agents.active().map((d) => d.id)).toEqual(['ag']);
    // Evento `agent.definition.updated` con il nome reale e audit esplicito della rinomina.
    // Il bus consegna in microtask: si attende la coda prima di leggere gli eventi.
    await s.h.bus.idle();
    expect(s.events('agent.definition.updated').at(-1)?.payload).toMatchObject({ agentId: 'ag', name: 'Nuovo Nome', version: 2 });
    expect(s.audit.list(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'agent.rename', subject: 'ag', detail: expect.stringContaining('Nuovo Nome') })
    ]));
    // Rinominare con lo stesso nome: nessuna modifica né nuova versione.
    const same = s.agents.rename('ag', '  Nuovo Nome  ', 'owner:test', 'corr-rename-2');
    expect(same).toEqual({ agentId: 'ag', name: 'Nuovo Nome', version: 2, changed: false });
    // Agente sconosciuto e nome vuoto: errori espliciti.
    expect(() => s.agents.rename('ignoto', 'X', 'owner', 'c3')).toThrow(/sconosciuto/);
    expect(() => s.agents.rename('ag', '   ', 'owner', 'c4')).toThrow(/nome non valido/);
  });

  it('un agente vivo mantiene la sessione e riceve il nuovo nome al turno successivo', async () => {
    const s = stack();
    s.agents.define(agentInput('ag', 'motore-a'), 'owner', 'c1');
    const first = await s.agents.runTurn({
      taskId: 't1', agentId: 'ag', title: 'uno', spec: 'RISPOSTA:ok', acceptance: null,
      correlationId: 'corr-t1', attempt: 1, signal: new AbortController().signal
    });
    expect(first.status).toBe('succeeded');
    const sessionId = 'sessionId' in first ? first.sessionId : null;
    expect(s.agents.status('ag')).toBe('idle');
    s.agents.rename('ag', 'Capo', 'owner:test', 'corr-rename');
    const second = await s.agents.runTurn({
      taskId: 't2', agentId: 'ag', title: 'due', spec: 'RISPOSTA:ok2', acceptance: null,
      correlationId: 'corr-t2', attempt: 1, signal: new AbortController().signal
    });
    expect(second.status).toBe('succeeded');
    // Stessa sessione riusata (l'id non è cambiato), nome aggiornato nella definizione.
    expect('sessionId' in second ? second.sessionId : null).toBe(sessionId);
    expect(s.agents.get('ag')?.name).toBe('Capo');
  });
});
