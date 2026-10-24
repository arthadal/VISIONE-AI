// Centro errori (P-95): la classificazione degli errori reali e il piano di riparazione sono puri e
// deterministici. Fixture sul contratto: nessun dato inventato, solo campi reali degli eventi.
import { describe, expect, it } from 'vitest';
import type { AgentView, Task, VisioneEvent } from '../../src/shared/contracts/index.ts';
import { errorEntryOf, instanceErrorEntry, mergeErrorEntries, pickRetryTask, repairFor } from '../../src/renderer/app/error-center.ts';

function event(type: string, severity: VisioneEvent['severity'], payload: Record<string, unknown>, ts = 1_000): VisioneEvent {
  return {
    id: `01J${String(ts).padStart(10, '0')}ABCDEFGHJKMNPQRS`, seq: ts, ts, type, category: 'agent',
    source: { kind: 'system', id: 'core' }, target: null, correlationId: 'corr-0001', causationId: null,
    severity, durability: 'durable', schema: 1, payload
  };
}

function task(over: Partial<Task> & { id: string }): Task {
  return {
    kind: 'work', parentId: null, rootId: 'root', correlationId: 'corr', title: 'task', spec: 'fai qualcosa',
    acceptance: null, status: 'failed', priority: 1, assigneeAgentId: 'coder', competence: 'code', dependsOn: [],
    actions: [], budget: { timeoutMs: 1000, maxAttempts: 2 }, attempts: 2, waitingOn: null,
    error: { code: 'turn_failed', message: 'x', retryable: true, runtimeCode: null }, result: null, sessionId: null,
    processIds: [], turnId: null, createdBy: 'ui', createdAt: 1, updatedAt: 10, startedAt: 1, endedAt: 10,
    ...over
  };
}

function view(over: Partial<AgentView['instance']> & { agentId: string }): AgentView {
  const { agentId, ...rest } = over;
  return {
    definition: {
      id: agentId, name: agentId, role: 'x', competences: ['general'],
      engine: { adapter: 'opencode', model: 'nvidia/nvidia/nemotron-3-super-120b-a12b' },
      persona: { instructions: 'x', language: 'it' }, workspace: { root: 'x', isolation: 'shared' },
      permissions: 'read-only', limits: { maxTurnMinutes: 5, maxTurnsPerTask: 1, maxConcurrentTasks: 1 },
      createdBy: 'owner', createdAt: 1, version: 1
    },
    archived: false,
    instance: {
      id: `inst-${agentId}`, agentId, status: 'error', statusReason: 'turno fallito: limit_reached',
      sessionId: null, currentTaskId: null, attempts: 1, createdAt: 5, startedAt: 6, lastEventAt: 7, endedAt: null, ...rest
    },
    session: null, breaker: 'closed', capabilities: []
  };
}

describe('centro errori: classificazione (P-95)', () => {
  it('solo gravità error/critical diventa una riga, con codice, messaggio ed entità reali', () => {
    expect(errorEntryOf(event('agent.turn.finished', 'info', { agentId: 'coder' }))).toBeNull();
    const e = errorEntryOf(event('agent.turn.finished', 'error', {
      agentId: 'coder', turnId: 't1', outcome: 'failed',
      error: { code: 'limit_reached', message: 'You\'ve hit your weekly limit', retryable: false }
    }));
    expect(e).toMatchObject({
      origin: 'event', code: 'limit_reached', at: 1_000, agentId: 'coder', entity: 'agente coder', retryable: false
    });
    expect(e?.message).toContain('weekly limit');
    const p = errorEntryOf(event('process.failed', 'error', {
      processId: 'p1', owner: { agentId: 'coder' }, error: { code: 'cwd_missing', message: 'cartella assente', retryable: false }
    }, 2_000));
    expect(p).toMatchObject({ code: 'cwd_missing', processId: 'p1', agentId: 'coder', entity: 'processo p1' });
  });

  it('i codici ANSI del TUI non finiscono nel pannello: il messaggio si legge', () => {
    const messy = '\u001b[38;2;255;107;128mYou\'ve hit your weekly limit\u001b[K\u001b[m';
    const e = errorEntryOf(event('agent.turn.finished', 'error', { agentId: 'claude', error: { code: 'limit_reached', message: messy, retryable: false } }))!;
    expect(e.message).toBe('You\'ve hit your weekly limit');
    expect(e.message).not.toContain('\u001b');
  });

  it('le istanze in errore/interrotte sono righe reali (con il motivo dell\'istanza)', () => {
    expect(instanceErrorEntry(view({ agentId: 'claude' }))).toMatchObject({ code: 'agent_error', severity: 'error' });
    const stale = instanceErrorEntry(view({ agentId: 'ultra', status: 'crashed', statusReason: 'core riavviato: processo non più controllato' }));
    expect(stale).toMatchObject({ code: 'sessione_chiusa', entity: 'agente ultra' });
    expect(instanceErrorEntry(view({ agentId: 'ok', status: 'idle', statusReason: null }))).toBeNull();
  });

  it('un\'istanza coperta da un evento dello stesso agente non si duplica; ordina dal più recente', () => {
    const ev = errorEntryOf(event('agent.turn.finished', 'error', { agentId: 'claude', error: { code: 'limit_reached', message: 'quota', retryable: false } }, 5_000))!;
    const inst = instanceErrorEntry(view({ agentId: 'claude', endedAt: 5_100 }))!;
    const other = instanceErrorEntry(view({ agentId: 'ultra', status: 'crashed', statusReason: 'processo terminato' }))!;
    const merged = mergeErrorEntries([ev], [inst, other]);
    // Una sola riga per claude (l'istanza è coperta dall'evento); l'istanza di ultra resta.
    expect(merged.filter((e) => e.agentId === 'claude')).toHaveLength(1);
    expect(merged.map((e) => e.id)).toEqual([ev.id, other.id]);
  });

  it('pickRetryTask prende il task fallito più recente di QUEL agente', () => {
    const tasks = [
      task({ id: 't1', endedAt: 100 }),
      task({ id: 't2', endedAt: 300, assigneeAgentId: 'other' }),
      task({ id: 't3', endedAt: 200 }),
      task({ id: 't4', status: 'succeeded', endedAt: 500 })
    ];
    expect(pickRetryTask(tasks, 'coder')?.id).toBe('t3');
    expect(pickRetryTask(tasks, 'other')?.id).toBe('t2');
    expect(pickRetryTask(tasks, 'nessuno')).toBeNull();
    expect(pickRetryTask(tasks, null)).toBeNull();
  });

  it('repairFor: quota → ERRORE FISSO; turno → rilancio; processo → agente o motori; core → verifica', () => {
    const fixed = repairFor(errorEntryOf(event('agent.turn.finished', 'error', { agentId: 'claude', error: { code: 'limit_reached', message: 'quota', retryable: false } }))!);
    expect(fixed).toMatchObject({ kind: 'fixed' });
    if (fixed.kind === 'fixed') expect(fixed.reason).toMatch(/quota/i);

    expect(repairFor(errorEntryOf(event('agent.turn.finished', 'error', { agentId: 'coder', error: { code: 'timeout', message: 'lento', retryable: true } }))!))
      .toMatchObject({ kind: 'retry-task', agentId: 'coder' });
    expect(repairFor(errorEntryOf(event('process.failed', 'error', { processId: 'p1', owner: { agentId: 'coder' }, error: { code: 'cwd_missing', message: 'x' } }))!))
      .toMatchObject({ kind: 'restart-agent', agentId: 'coder' });
    expect(repairFor(errorEntryOf(event('process.failed', 'error', { processId: 'p1', error: { code: 'x', message: 'y' } }))!))
      .toMatchObject({ kind: 'probe-engines' });
    expect(repairFor(errorEntryOf(event('core.crashed', 'error', { pid: 1, reason: 'exit' }))!)).toMatchObject({ kind: 'verify-core' });
    expect(repairFor(instanceErrorEntry(view({ agentId: 'ultra', status: 'crashed', statusReason: 'processo terminato' }))!)).toMatchObject({ kind: 'restart-agent', agentId: 'ultra' });
  });
});
