// Schede della vista Terminale (P-94): sessioni morte mai mostrate, grazia «terminato» con rimozione
// automatica, × che nasconde subito. Logica pura, nessun React.
import { describe, expect, it } from 'vitest';
import type { TerminalSession } from '../../src/shared/contracts/index.ts';
import { EMPTY_TABS, END_GRACE_MS, hideTerminalTab, unhideTerminalTab, updateTerminalTabs } from '../../src/renderer/app/terminalTabs.ts';

const owner = { agentId: null, sessionId: null, taskId: null, adapter: null } as const;
const session = (processId: string, over: Partial<TerminalSession> = {}): TerminalSession => ({
  processId, kind: 'terminal', owner, status: 'running', interactive: true,
  title: `shell ${processId}`, createdAt: 1_000, endedAt: null, ...over
});
const ids = (list: TerminalSession[]): string[] => list.map((s) => s.processId);

describe('schede del terminale (P-94)', () => {
  it('non mostra le sessioni già terminate all\'apertura: niente schede morte', () => {
    const upd = updateTerminalTabs(EMPTY_TABS, [
      session('viva'),
      session('morta', { status: 'stopped', endedAt: 4_000 })
    ], 10_000);
    expect(ids(upd.visible)).toEqual(['viva']);
    expect(upd.ending).toEqual([]);
    expect(upd.nextDeadline).toBeNull();
  });

  it('una sessione vista viva resta «terminato» per la grazia e poi si chiude da sola', () => {
    const first = updateTerminalTabs(EMPTY_TABS, [session('a')], 1_000);
    expect(ids(first.visible)).toEqual(['a']);
    const ended = session('a', { status: 'stopped', endedAt: 5_000 });
    const second = updateTerminalTabs(first.memory, [ended], 5_500);
    expect(ids(second.visible)).toEqual(['a']);
    expect(ids(second.ending)).toEqual(['a']);
    expect(second.nextDeadline).toBe(5_000 + END_GRACE_MS);
    const third = updateTerminalTabs(second.memory, [ended], 5_000 + END_GRACE_MS + 1);
    expect(third.visible).toEqual([]);
    // Non riappare nemmeno a un aggiornamento successivo.
    const fourth = updateTerminalTabs(third.memory, [ended], 20_000);
    expect(fourth.visible).toEqual([]);
  });

  it('il × nasconde subito la scheda; le altre restano', () => {
    const first = updateTerminalTabs(EMPTY_TABS, [session('a'), session('b')], 1_000);
    const memory = hideTerminalTab(first.memory, 'a');
    const second = updateTerminalTabs(memory, [session('a'), session('b')], 1_100);
    expect(ids(second.visible)).toEqual(['b']);
  });

  it('se la chiusura fallisce la scheda torna visibile', () => {
    const first = updateTerminalTabs(EMPTY_TABS, [session('a')], 1_000);
    const hidden = hideTerminalTab(first.memory, 'a');
    expect(updateTerminalTabs(hidden, [session('a')], 1_100).visible).toEqual([]);
    const restored = unhideTerminalTab(hidden, 'a');
    expect(ids(updateTerminalTabs(restored, [session('a')], 1_200).visible)).toEqual(['a']);
  });
});
