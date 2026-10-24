import { describe, expect, it } from 'vitest';
import { CoreSupervisor, type CoreProcess } from '../../src/main/supervisor.ts';
import type { CoreState, EventPayload, MainToCoreFrameBody } from '../../src/shared/contracts/index.ts';
import { DEFAULT_CONFIG } from '../../src/shared/node/config.ts';
import { FakeTimers, memoryLogger } from '../helpers.ts';

class FakeCore implements CoreProcess {
  static nextPid = 100;
  readonly pid = FakeCore.nextPid++;
  sent: MainToCoreFrameBody[] = [];
  killed = false;
  private spawnL: ((pid: number) => void) | null = null;
  private messageL: ((raw: unknown) => void) | null = null;
  private exitL: ((code: number | null) => void) | null = null;
  private stderrL: ((t: string) => void) | null = null;

  send(frame: MainToCoreFrameBody): void { this.sent.push(frame); }
  kill(): void { this.killed = true; }
  onSpawn(l: (pid: number) => void): void { this.spawnL = l; }
  onMessage(l: (raw: unknown) => void): void { this.messageL = l; }
  onExit(l: (code: number | null) => void): void { this.exitL = l; }
  onStderr(l: (t: string) => void): void { this.stderrL = l; }

  spawned(): void { this.spawnL?.(this.pid); }
  ready(): void { this.messageL?.({ v: 1, kind: 'ready', pid: this.pid, coreVersion: 't', startupMs: 5 }); }
  frame(f: unknown): void { this.messageL?.(f); }
  stderr(t: string): void { this.stderrL?.(t); }
  exit(code: number | null): void { this.exitL?.(code); }
}

type Emitted = { type: string; payload: unknown };

function setup(overrides: Partial<typeof DEFAULT_CONFIG.supervisor> = {}) {
  const timers = new FakeTimers();
  const procs: FakeCore[] = [];
  const emitted: Emitted[] = [];
  const states: CoreState[] = [];
  const frames: unknown[] = [];
  const sup = new CoreSupervisor({
    factory: () => {
      const p = new FakeCore();
      procs.push(p);
      return p;
    },
    config: { ...DEFAULT_CONFIG.supervisor, ...overrides },
    appVersion: '0.3.0',
    log: memoryLogger().log,
    emit: (type, payload) => emitted.push({ type, payload }),
    onFrame: (f) => frames.push(f),
    onStateChange: (s) => states.push(s.state),
    timers
  });
  const last = (): FakeCore => procs.at(-1) as FakeCore;
  const boot = (): FakeCore => { const p = last(); p.spawned(); p.ready(); return p; };
  return { sup, timers, procs, emitted, states, frames, last, boot };
}

const types = (e: Emitted[]) => e.map((x) => x.type);
const payloadOf = <T extends 'core.crashed' | 'core.restarted'>(e: Emitted[], t: T) =>
  e.filter((x) => x.type === t).map((x) => x.payload as EventPayload<T>);

describe('supervisore del core', () => {
  it('avvio: starting → ready con core.started e core.ready', () => {
    const s = setup();
    s.sup.start();
    expect(s.sup.snapshot().state).toBe('starting');
    const p = s.boot();
    expect(s.sup.snapshot()).toMatchObject({ state: 'ready', pid: p.pid, appVersion: '0.3.0', totalRestarts: 0 });
    expect(types(s.emitted)).toEqual(['core.started', 'core.ready']);
    expect(s.states).toEqual(['starting', 'ready']);
  });

  it('inoltra i frame applicativi e invia solo quando è pronto', () => {
    const s = setup();
    s.sup.start();
    expect(s.sup.send({ kind: 'hb', n: 0 })).toBe(false);
    const p = s.boot();
    expect(s.sup.send({ kind: 'hb', n: 9 })).toBe(true);
    expect(p.sent).toContainEqual({ kind: 'hb', n: 9 });
    p.frame({ v: 1, kind: 'ingested', ids: ['a'] });
    p.frame({ v: 1, kind: 'qualcosa' }); // frame non valido: ignorato
    expect(s.frames).toEqual([{ v: 1, kind: 'ingested', ids: ['a'] }]);
  });

  it('crash: registra, riavvia dopo il backoff e annuncia core.restarted', () => {
    const s = setup();
    s.sup.start();
    const first = s.boot();
    first.stderr('Error: boom\n');
    first.exit(1);
    expect(s.sup.snapshot()).toMatchObject({ state: 'recovering', restartsInWindow: 1, totalRestarts: 1 });
    const [crash] = payloadOf(s.emitted, 'core.crashed');
    expect(crash).toMatchObject({ pid: first.pid, exitCode: 1, reason: 'exit', willRestart: true, nextDelayMs: 1_000, stderrTail: 'Error: boom\n' });
    expect(s.procs).toHaveLength(1);
    s.timers.advance(999);
    expect(s.procs).toHaveLength(1);
    s.timers.advance(1);
    expect(s.procs).toHaveLength(2);
    const second = s.boot();
    expect(s.sup.snapshot()).toMatchObject({ state: 'ready', pid: second.pid });
    expect(payloadOf(s.emitted, 'core.restarted')).toEqual([{ pid: second.pid, attempt: 1, downtimeMs: 1_000 }]);
    expect(s.states).toEqual(['starting', 'ready', 'crashed', 'recovering', 'ready']);
  });

  it('backoff crescente e resa oltre il limite di riavvii nella finestra', () => {
    const s = setup({ maxRestarts: 3, backoffMs: [100, 200, 400] });
    s.sup.start();
    const delays: Array<number | null> = [];
    for (let i = 0; i < 4; i++) {
      s.boot().exit(1);
      const crash = payloadOf(s.emitted, 'core.crashed').at(-1);
      delays.push(crash?.nextDelayMs ?? null);
      if (crash?.nextDelayMs) s.timers.advance(crash.nextDelayMs);
    }
    expect(delays).toEqual([100, 200, 400, null]);
    expect(s.sup.snapshot().state).toBe('failed');
    expect(payloadOf(s.emitted, 'core.crashed').at(-1)).toMatchObject({ willRestart: false, restartsInWindow: 4 });
    s.timers.advance(60_000);
    expect(s.procs).toHaveLength(4); // nessun altro tentativo
  });

  it('i crash fuori dalla finestra non contano', () => {
    const s = setup({ maxRestarts: 1, restartWindowMs: 10_000, backoffMs: [100], heartbeatTimeoutMs: 1_000_000 });
    s.sup.start();
    s.boot().exit(1);
    s.timers.advance(100);
    s.boot();
    s.timers.advance(20_000);
    s.last().exit(1);
    expect(s.sup.snapshot().state).toBe('recovering');
  });

  it('nessun ready entro startTimeoutMs → kill e crash start-timeout', () => {
    const s = setup({ startTimeoutMs: 1_000 });
    s.sup.start();
    const p = s.last();
    p.spawned();
    s.timers.advance(1_000);
    expect(p.killed).toBe(true);
    expect(payloadOf(s.emitted, 'core.crashed')[0]).toMatchObject({ reason: 'start-timeout' });
    p.exit(1); // l'uscita del processo ucciso non conta due volte
    expect(payloadOf(s.emitted, 'core.crashed')).toHaveLength(1);
  });

  it('Windows tiene fermo il processo nuovo oltre startTimeoutMs: si aspetta, il tempo del ready parte dallo spawn', () => {
    const s = setup({ startTimeoutMs: 15_000 });
    s.sup.start();
    const p = s.last();
    s.timers.advance(80_000); // VM da «vergine», 22/10/2026: il processo è comparso dopo più di un minuto
    expect(payloadOf(s.emitted, 'core.crashed')).toHaveLength(0);
    p.spawned();
    s.timers.advance(10_000);
    p.ready();
    expect(s.sup.snapshot().state).toBe('ready');
    expect(p.killed).toBe(false);
  });

  it('un core abbandonato che parte o risponde dopo si chiude subito: mai due core sullo stesso database', () => {
    const s = setup({ startTimeoutMs: 1_000 });
    s.sup.start();
    const stale = s.last();
    s.timers.advance(120_000); // il processo non è mai partito: si abbandona e se ne avvia un altro
    expect(payloadOf(s.emitted, 'core.crashed')[0]).toMatchObject({ reason: 'start-timeout' });
    s.timers.advance(5_000);
    const fresh = s.last();
    expect(fresh).not.toBe(stale);
    stale.killed = false;
    stale.spawned(); // Windows lo lascia partire solo adesso
    expect(stale.killed).toBe(true);
    stale.killed = false;
    stale.ready();
    expect(stale.killed).toBe(true);
    fresh.spawned();
    fresh.ready();
    expect(s.sup.snapshot()).toMatchObject({ state: 'ready', pid: fresh.pid });
  });

  it('heartbeat: senza risposta oltre heartbeatTimeoutMs il core è considerato bloccato', () => {
    const s = setup({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 3_000 });
    s.sup.start();
    const p = s.boot();
    s.timers.advance(2_000);
    expect(p.sent.filter((f) => f.kind === 'hb')).toHaveLength(2);
    p.frame({ v: 1, kind: 'hb-ack', n: 2 });
    s.timers.advance(3_000);
    expect(s.sup.snapshot().state).toBe('ready');
    s.timers.advance(1_000);
    expect(p.killed).toBe(true);
    expect(payloadOf(s.emitted, 'core.crashed')[0]).toMatchObject({ reason: 'heartbeat-timeout', willRestart: true });
  });

  it('heartbeat: un salto dell\'orologio (PC sospeso, VM ferma) non uccide un core sano (collaudo VM 24/10/2026)', () => {
    const s = setup({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 3_000 });
    s.sup.start();
    const p = s.boot();
    s.timers.advance(1_000);
    p.frame({ v: 1, kind: 'hb-ack', n: 1 });
    // Tutto fermo per un minuto, poi riparte: il primo controllo arriva tardi e non conta.
    s.timers.jump(60_000);
    s.timers.advance(1);
    expect(s.sup.snapshot().state).toBe('ready');
    expect(p.killed).toBe(false);
    // Se dopo il risveglio il core non risponde davvero, il controllo lo vede come sempre.
    s.timers.advance(5_000);
    expect(p.killed).toBe(true);
  });

  it('stop cooperativo: shutdown al core, uscita → stopped e core.stopped', async () => {
    const s = setup();
    s.sup.start();
    const p = s.boot();
    const stopped = s.sup.stop('app-quit', 20_000);
    expect(s.sup.snapshot().state).toBe('stopping');
    expect(p.sent.at(-1)).toEqual({ kind: 'shutdown', reason: 'app-quit', deadlineMs: 18_000 });
    p.exit(0);
    await stopped;
    expect(s.sup.snapshot()).toMatchObject({ state: 'stopped', pid: null, lastExit: { code: 0, reason: 'app-quit' } });
    expect(types(s.emitted).at(-1)).toBe('core.stopped');
    expect(payloadOf(s.emitted, 'core.crashed')).toHaveLength(0);
  });

  it('stop: se il core non esce entro la scadenza viene terminato', async () => {
    const s = setup();
    s.sup.start();
    const p = s.boot();
    const stopped = s.sup.stop('app-quit', 5_000);
    s.timers.advance(5_000);
    expect(p.killed).toBe(true);
    p.exit(null);
    await stopped;
    expect(s.sup.snapshot().state).toBe('stopped');
  });

  it('stop durante l\'attesa di un riavvio annulla il riavvio', async () => {
    const s = setup();
    s.sup.start();
    s.boot().exit(1);
    await s.sup.stop('app-quit');
    s.timers.advance(60_000);
    expect(s.procs).toHaveLength(1);
    expect(s.sup.snapshot().state).toBe('stopped');
  });

  it('errore di creazione del processo → crash spawn-error', () => {
    const timers = new FakeTimers();
    const emitted: Emitted[] = [];
    const sup = new CoreSupervisor({
      factory: () => { throw new Error('eseguibile mancante'); },
      config: { ...DEFAULT_CONFIG.supervisor, maxRestarts: 0 },
      appVersion: 't',
      log: memoryLogger().log,
      emit: (type, payload) => emitted.push({ type, payload }),
      onFrame: () => undefined,
      onStateChange: () => undefined,
      timers
    });
    sup.start();
    expect(sup.snapshot().state).toBe('failed');
    expect(emitted[0]).toMatchObject({ type: 'core.crashed', payload: { reason: 'spawn-error', detail: 'eseguibile mancante' } });
  });

  it('il frame fatal del core diventa il dettaglio del crash', () => {
    const s = setup();
    s.sup.start();
    const p = s.boot();
    p.frame({ v: 1, kind: 'fatal', message: 'uncaught-exception: boom' });
    p.exit(1);
    expect(payloadOf(s.emitted, 'core.crashed')[0]?.detail).toBe('uncaught-exception: boom');
  });
});
