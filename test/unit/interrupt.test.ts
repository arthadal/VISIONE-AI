// «Interrompi» (12/10/2026, richiesta del proprietario): dal pannello di un agente si annullano i SUOI
// task non conclusi; dal Director tutti gli obiettivi non conclusi. Motore dei task finto, router vero.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalQueue } from '../../src/core/approvals/index.ts';
import type { AgentManager } from '../../src/core/agents/index.ts';
import type { AuditLog } from '../../src/core/audit/index.ts';
import { createEventBus } from '../../src/core/bus/index.ts';
import { createCommandRouter } from '../../src/core/commands/index.ts';
import { migrate, openDb } from '../../src/core/db/index.ts';
import { registerDirectorCommands, type Director } from '../../src/core/director/index.ts';
import { createEventEmitter } from '../../src/core/events/index.ts';
import { createJournal } from '../../src/core/journal/index.ts';
import type { TaskEngine } from '../../src/core/tasks/index.ts';
import type { CommandEnvelope } from '../../src/shared/contracts/index.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const cmd = (type: string, payload: unknown): CommandEnvelope => {
  const id = ulid();
  return { id, type, ts: Date.now(), correlationId: id, issuedBy: 'ui', payload };
};

function setup() {
  const h = tempHome();
  const db = openDb(join(h.dir, 'visione.db'));
  migrate(db);
  const bus = createEventBus();
  const events = createEventEmitter({ db, journal: createJournal(db), bus });
  const router = createCommandRouter({ db, events, log: memoryLogger().log, defaultTimeoutMs: 2_000 });
  const tasks = [
    { id: 'g1', kind: 'goal', status: 'running', assigneeAgentId: null },
    { id: 'g2', kind: 'goal', status: 'succeeded', assigneeAgentId: null },
    { id: 't1', kind: 'subtask', status: 'running', assigneeAgentId: 'coder' },
    { id: 't2', kind: 'subtask', status: 'queued', assigneeAgentId: 'coder' },
    { id: 't3', kind: 'subtask', status: 'running', assigneeAgentId: 'other' },
    { id: 't4', kind: 'subtask', status: 'failed', assigneeAgentId: 'coder' }
  ];
  const cancelled: Array<{ id: string; reason: string }> = [];
  const engine = {
    list: (f: { rootsOnly?: boolean; status?: readonly string[] } = {}) =>
      tasks.filter((t) => (!f.rootsOnly || t.kind === 'goal') && (!f.status || f.status.includes(t.status))),
    cancel: (id: string, reason: string) => { cancelled.push({ id, reason }); return { cancelled: [id], alreadyFinished: false }; }
  } as unknown as TaskEngine;
  registerDirectorCommands({
    router, engine, director: {} as Director, approvals: {} as ApprovalQueue, audit: {} as AuditLog, agents: {} as AgentManager
  });
  cleanups.push(() => { events.close(); bus.close(); db.close(); h.cleanup(); });
  return { router, cancelled };
}

describe('Interrompi', () => {
  it('dal pannello di un agente: solo i suoi task non conclusi, con il motivo', async () => {
    const s = setup();
    const res = await s.router.dispatch(cmd('agents.interrupt', { agentId: 'coder', reason: 'dal pannello' }));
    expect(res.ok && res.data).toEqual({ agentId: 'coder', cancelled: ['t1', 't2'] });
    expect(s.cancelled).toEqual([{ id: 't1', reason: 'dal pannello' }, { id: 't2', reason: 'dal pannello' }]);
    const none = await s.router.dispatch(cmd('agents.interrupt', { agentId: 'nessuno' }));
    expect(none.ok && none.data).toEqual({ agentId: 'nessuno', cancelled: [] });
  });

  it('dal Director: tutti gli obiettivi non conclusi', async () => {
    const s = setup();
    const res = await s.router.dispatch(cmd('director.interrupt', {}));
    expect(res.ok && res.data).toEqual({ cancelled: ['g1'], goals: 1 });
    expect(s.cancelled[0]!.reason).toMatch(/interrotto dal proprietario/);
  });
});
