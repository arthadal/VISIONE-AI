// Fase 23 (P-70) — centro notifiche e sequenza di avvio: proiezioni pure di eventi/stato reali.
import { describe, expect, it } from 'vitest';
import type { CoreStateSnapshot, SupervisorSnapshot } from '../../src/shared/contracts/index.ts';
import { createEvent } from '../../src/shared/contracts/index.ts';
import { bootComplete, bootSteps } from '../../src/renderer/app/boot.ts';
import { collectNotices, countUnread, notificationOf } from '../../src/renderer/app/notifications.ts';

describe('Fase 23 — centro notifiche', () => {
  it('task e approvazioni producono notizie con bersaglio reale', () => {
    const ok = notificationOf(createEvent('task.result.recorded', { taskId: 'T1', rootId: 'T1', outcome: 'success', summary: 'fatto', chars: 5, producedBy: 'a1' }, { now: 100 }));
    expect(ok).toMatchObject({ severity: 'info', title: 'Task completato', target: { windowKind: 'task', ref: 'T1' } });

    const failed = notificationOf(createEvent('task.status.changed', { taskId: 'T2', rootId: 'T2', kind: 'work', from: 'running', to: 'failed', reason: 'errore', attempt: 1, error: null }, { now: 200 }));
    expect(failed).toMatchObject({ severity: 'error', title: 'Task failed', target: { windowKind: 'task', ref: 'T2' } });

    // Una cancellazione voluta non è una notizia.
    expect(notificationOf(createEvent('task.status.changed', { taskId: 'T3', rootId: 'T3', kind: 'work', from: 'running', to: 'cancelled', reason: 'annullato', attempt: 1, error: null }, { now: 300 }))).toBeNull();

    const approval = notificationOf(createEvent('approval.requested', { approvalId: 'A1', kind: 'bash', target: 'rm -rf', reason: 'serve permesso', requestedBy: 'agent:a1', taskId: null, agentId: 'a1' }, { now: 400 }));
    expect(approval).toMatchObject({ severity: 'warning', target: { windowKind: 'approvals', ref: null } });
  });

  it('agenti, processi, sistema e voce: solo gli esiti reali diventano notizie', () => {
    const agent = notificationOf(createEvent('agent.status.changed', { instanceId: 'i1', agentId: 'a1', from: 'working', to: 'crashed', reason: 'uscita', }, { now: 500 }));
    expect(agent).toMatchObject({ severity: 'error', target: { windowKind: 'agent', ref: 'a1' } });

    const proc = notificationOf(createEvent('process.crashed', {
      processId: 'p1', pid: 1234, owner: { agentId: 'a1', sessionId: null, taskId: 'T1', adapter: 'opencode' }, status: 'crashed',
      exitCode: 1, signal: null, durationMs: 10, error: { code: 'crashed', message: 'boom', retryable: false }, tail: '', stdoutBytes: 0, stderrBytes: 0
    }, { now: 600 }));
    expect(proc).toMatchObject({ severity: 'error', target: { windowKind: 'agent', ref: 'a1' } });

    const voice = notificationOf(createEvent('voice.error', { code: 'stt-failed', message: 'modello assente' }, { now: 700 }));
    expect(voice).toMatchObject({ severity: 'warning', target: null });

    const system = notificationOf(createEvent('system.error', { code: 'E1', message: 'guasto', fatal: false }, { now: 800 }));
    expect(system).toMatchObject({ severity: 'error', target: { windowKind: 'logs', ref: null } });

    // Un evento normale non è una notizia.
    expect(notificationOf(createEvent('app.started', { appVersion: '1.0.0', electronVersion: 'x', pid: 1 }, { now: 900 }))).toBeNull();
  });

  it('elenco più recenti prime, con tetto, e conteggio delle non lette', () => {
    const events = [100, 200, 300].map((t) => createEvent('voice.error', { code: `c${t}`, message: 'm' }, { now: t }));
    const notices = collectNotices(events, 2);
    expect(notices).toHaveLength(2);
    expect(notices[0]!.ts).toBe(300);
    expect(countUnread(notices, 150)).toBe(2);
    expect(countUnread(notices, 300)).toBe(0);
  });
});

describe('Fase 23 — sequenza di avvio (stati reali, mai finti)', () => {
  const sup = (state: string): SupervisorSnapshot => ({ state } as SupervisorSnapshot);
  const core = (over: { status?: string; db?: string; voice?: string; recovered?: boolean }): CoreStateSnapshot =>
    ({
      core: { status: over.status ?? 'ready', recovered: over.recovered ?? false },
      database: { status: over.db ?? 'ok', journalLastSeq: 12 },
      voice: { status: over.voice ?? 'ready' }
    } as unknown as CoreStateSnapshot);

  it('senza stato: tutte le tappe in attesa e avvio non completo', () => {
    expect(bootComplete(null, null)).toBe(false);
    expect(bootSteps(null, null).map((s) => s.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('core pronto: tappe verdi e avvio completo; la voce senza modelli è un avviso onesto', () => {
    expect(bootComplete(sup('ready'), core({}))).toBe(true);
    expect(bootSteps(sup('ready'), core({})).map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
    const warn = bootSteps(sup('ready'), core({ voice: 'unavailable' }));
    expect(warn.find((s) => s.id === 'voice')?.status).toBe('warn');
    expect(warn.find((s) => s.id === 'voice')?.detail).toBe('unavailable');
    // La sequenza non si chiude mentre la voce sta ancora caricando (la frase arriva alla fine).
    expect(bootComplete(sup('ready'), core({ voice: 'starting' }))).toBe(false);
    expect(bootComplete(sup('ready'), core({ voice: 'unavailable' }))).toBe(true);
  });

  it('supervisore in errore e database degradato restano dichiarati', () => {
    const steps = bootSteps(sup('failed'), core({ db: 'degraded' }));
    expect(steps.find((s) => s.id === 'supervisor')?.status).toBe('error');
    expect(steps.find((s) => s.id === 'database')?.status).toBe('warn');
  });
});
