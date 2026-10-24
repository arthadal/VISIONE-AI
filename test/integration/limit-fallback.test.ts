// P-83 — Limite di quota di un motore → reinstradamento all'agente di ripiego con la STESSA
// specifica. Adapter finti in memoria: il turno `LIMITE` emette `limit.reached`, fallisce con
// `limit_reached` una volta per istanza e il Director riassegna (evento `task.assigned` +
// decisione + audit). Se non esiste un motore alternativo il task fallisce davvero, senza finte.
import { afterEach, describe, expect, it } from 'vitest';
import type { Task } from '../../src/shared/contracts/index.ts';
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
const corr = (id: string) => ({ correlationId: id, causationId: id });
const tasksOf = (s: Stack, rootId: string): Task[] => s.engine.list({ rootId, limit: 50 }).filter((t) => t.kind !== 'goal').reverse();

describe('P-83 — limite del motore e ripiego', () => {
  it('il task fallito per limite passa a un motore diverso con la stessa specifica', async () => {
    // Solo `motore-a` simula il limite: il ripiego `motore-b` riceve la stessa specifica e lavora.
    const s = stack({ adapters: [fakeAdapter('motore-a'), fakeAdapter('motore-b', { limit: false })] });
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b'), 'owner', 'c2');
    const out = s.director.submit({
      goal: 'Compito con limite simulato',
      plan: { steps: [{ key: 's', title: 'Lavora', spec: 'SPEC-UNICA con LIMITE', agentId: 'alfa' }] }
    }, 'owner:ui', corr('corr-limit-0001'));
    await s.settle();
    const [task] = tasksOf(s, out.rootTaskId);
    // Stessa specifica, motore diverso: alfa ha fallito per limite, beta ha ricevuto lo stesso testo.
    expect(task).toMatchObject({ status: 'succeeded', assigneeAgentId: 'beta' });
    expect(s.adapters['motore-a']?.turns).toHaveLength(1);
    expect(s.adapters['motore-b']?.turns).toHaveLength(1);
    expect(s.adapters['motore-b']?.turns[0]?.text).toContain('SPEC-UNICA con LIMITE');
    // Evento durevole del limite: una volta sola, con il motore che l'ha dichiarato.
    const limits = s.events('agent.limit.reached');
    expect(limits).toHaveLength(1);
    expect(limits[0]?.payload).toMatchObject({ agentId: 'alfa', adapter: 'motore-a', scope: 'session', resetAt: '3:00pm' });
    // Riassegnazione reale e auditata.
    const assigned = s.events('task.assigned').map((e) => e.payload as { agentId: string; previousAgentId: string | null; reason: string });
    expect(assigned.some((p) => p.agentId === 'beta' && p.previousAgentId === 'alfa' && /limite/i.test(p.reason))).toBe(true);
    expect(s.audit.list(50)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'director.limit-fallback', subject: task?.id, decision: 'reassign' })
    ]));
  });

  it('l\'agente di ripiego preferito dalla config vince sugli altri candidati', async () => {
    const s = stack({
      adapters: [fakeAdapter('motore-a'), fakeAdapter('motore-b', { limit: false }), fakeAdapter('motore-c', { limit: false })],
      limitFallbackAgentId: 'gamma'
    });
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    s.agents.define(agentInput('beta', 'motore-b'), 'owner', 'c2');
    s.agents.define(agentInput('gamma', 'motore-c'), 'owner', 'c3');
    const out = s.director.submit({
      goal: 'Compito con limite simulato',
      plan: { steps: [{ key: 's', title: 'Lavora', spec: 'SPEC con LIMITE', agentId: 'alfa' }] }
    }, 'owner:ui', corr('corr-limit-0002'));
    await s.settle();
    const [task] = tasksOf(s, out.rootTaskId);
    expect(task).toMatchObject({ status: 'succeeded', assigneeAgentId: 'gamma' });
    expect(s.adapters['motore-b']?.turns).toHaveLength(0);
    expect(s.adapters['motore-c']?.turns).toHaveLength(1);
  });

  it('senza un motore alternativo il task fallisce davvero (nessun ripiego inventato)', async () => {
    const s = stack({ adapters: [fakeAdapter('motore-a')] });
    s.agents.define(agentInput('alfa', 'motore-a'), 'owner', 'c1');
    const out = s.director.submit({
      goal: 'Compito con limite simulato',
      plan: { steps: [{ key: 's', title: 'Lavora', spec: 'SPEC con LIMITE', agentId: 'alfa' }] }
    }, 'owner:ui', corr('corr-limit-0003'));
    await s.settle();
    const [task] = tasksOf(s, out.rootTaskId);
    expect(task?.status).toBe('failed');
    // Un solo evento di limite, nessun turno su altri motori.
    expect(s.events('agent.limit.reached')).toHaveLength(1);
    expect(s.engine.get(out.rootTaskId)?.status).toBe('failed');
  });
});
