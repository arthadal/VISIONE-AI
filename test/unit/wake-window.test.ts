// Wake → finestra dell'agente (P-83): logica pura del renderer provata con eventi SINTETICI
// (l'e2e col microfono reale non è possibile in CI). Il bersaglio si sceglie per capacità
// dichiarate dall'adapter: turns.interactive + events.turnEnd; la storia del journal non apre nulla.
import { describe, expect, it } from 'vitest';
import type { AgentCapability, AgentView, VisioneEvent } from '../../src/shared/contracts/index.ts';
import { pickWakeAgent, wakeEventOf, wakePlan } from '../../src/renderer/windows/wake.ts';

function event(id: string, type: string, ts: number): VisioneEvent {
  return {
    id, seq: 1, ts, type, category: 'voice', source: { kind: 'voice', id: 'voice' }, target: null,
    correlationId: 'corr-0001', causationId: null, severity: 'info', durability: 'durable', schema: 1,
    payload: { phrase: 'hey visione', command: null }
  };
}

function view(id: string, capabilities: AgentCapability[], archived = false): AgentView {
  return {
    definition: {
      id, name: id.toUpperCase(), role: 'agente di prova', competences: ['code'],
      engine: { adapter: 'motore-test' },
      persona: { instructions: 'Rispondi in italiano.', language: 'it' },
      workspace: { root: id, isolation: 'shared' }, permissions: 'read-only',
      limits: { maxTurnMinutes: 5, maxTurnsPerTask: 10, maxConcurrentTasks: 1 },
      createdBy: 'test', createdAt: 0, version: 1
    },
    archived, instance: null, session: null, breaker: 'closed', capabilities
  };
}

const INTERACTIVE: AgentCapability[] = ['turns.interactive', 'events.turnEnd', 'model.select'];
const HEADLESS: AgentCapability[] = ['turns.headless', 'events.turnEnd', 'model.select'];
const PLAIN_PTY: AgentCapability[] = ['turns.interactive', 'terminal.input'];

describe('wake → terminale dell\'agente (P-83)', () => {
  it('wake fresca + agente interattivo → apre la sua finestra', () => {
    const plan = wakePlan([event('e1', 'voice.wake.detected', 1_000)], [view('claude-x', INTERACTIVE)], 900);
    expect(plan).toEqual({ kind: 'open', agentId: 'claude-x', name: 'CLAUDE-X' });
  });

  it('wake della storia (prima dell\'avvio del core) → ignorata, nessuna finestra', () => {
    const plan = wakePlan([event('e0', 'voice.wake.detected', 100)], [view('claude-x', INTERACTIVE)], 900);
    expect(plan).toEqual({ kind: 'ignore' });
  });

  it('nessuna wake recente → ignora', () => {
    expect(wakePlan([event('e2', 'agent.status.changed', 1_000)], [view('claude-x', INTERACTIVE)], 900)).toEqual({ kind: 'ignore' });
  });

  it('agente headless o PTY generico (senza events.turnEnd) → errore onesto, non una finestra finta', () => {
    expect(wakePlan([event('e1', 'voice.wake.detected', 1_000)], [view('head', HEADLESS), view('pty', PLAIN_PTY)], 900)).toMatchObject({ kind: 'error' });
    expect(wakePlan([event('e1', 'voice.wake.detected', 1_000)], [], 900)).toMatchObject({ kind: 'error' });
  });

  it('sceglie solo agenti con entrambe le capacità, in ordine stabile', () => {
    const agents = [view('a', PLAIN_PTY), view('b', HEADLESS), view('c', INTERACTIVE), view('d', INTERACTIVE)];
    expect(pickWakeAgent(agents)?.definition.id).toBe('c');
    expect(pickWakeAgent([view('z', INTERACTIVE, true)])).toBeNull();
    expect(wakeEventOf([event('x', 'voice.stt.final', 1), event('y', 'voice.wake.detected', 2)])?.id).toBe('y');
  });
});
