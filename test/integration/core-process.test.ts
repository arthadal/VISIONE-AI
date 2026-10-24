// Core in un processo separato reale (child_process di Node al posto del utilityProcess) con lo
// stesso cablaggio del main: avvio, ping, kill → crash rilevato → riavvio → ricollegamento,
// spegnimento cooperativo, persistenza degli eventi attraverso i riavvii.
import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCoreLink, type CoreLink } from '../../src/main/core-link.ts';
import { createSpool } from '../../src/main/spool.ts';
import type { CoreProcessFactory } from '../../src/main/supervisor.ts';
import {
  FRAME_VERSION,
  coreStateSnapshotSchema,
  type CommandEnvelope,
  type CoreState,
  type CoreStateSnapshot,
  type EventPage,
  type VisioneEvent
} from '../../src/shared/contracts/index.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { DEFAULT_CONFIG, type VisioneConfig } from '../../src/shared/node/config.ts';
import { resolvePaths } from '../../src/shared/node/paths.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

const CORE_ENTRY = resolve('src/core/index.ts');

function nodeCoreFactory(home: string, pids: number[]): CoreProcessFactory {
  return () => {
    const child = fork(CORE_ENTRY, [], {
      env: { ...process.env, VISIONE_HOME: home, VISIONE_APP_VERSION: '0.3.0-it', VISIONE_MAIN_PID: String(process.pid) },
      execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=ExperimentalWarning'],
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    return {
      send: (frame) => {
        if (child.connected) child.send({ v: FRAME_VERSION, ...frame });
      },
      kill: () => {
        child.kill();
      },
      onSpawn: (listener) => child.once('spawn', () => {
        pids.push(child.pid ?? 0);
        listener(child.pid ?? 0);
      }),
      onMessage: (listener) => child.on('message', listener),
      onExit: (listener) => child.once('exit', (code) => listener(code)),
      onStderr: (listener) => {
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', listener);
        child.stdout?.resume();
      }
    };
  };
}

const config: VisioneConfig = {
  ...DEFAULT_CONFIG,
  supervisor: { ...DEFAULT_CONFIG.supervisor, backoffMs: [200], heartbeatIntervalMs: 500, heartbeatTimeoutMs: 5_000, stopTimeoutMs: 5_000 }
};

interface Harness {
  link: CoreLink;
  states: CoreState[];
  coreStates: CoreStateSnapshot[];
  uiEvents: VisioneEvent[];
  pids: number[];
}

const links: CoreLink[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const link of links.splice(0)) await link.supervisor.stop('test-cleanup', 5_000);
  while (cleanups.length > 0) cleanups.pop()?.();
});

function connect(home: string): Harness {
  const states: CoreState[] = [];
  const uiEvents: VisioneEvent[] = [];
  const coreStates: CoreStateSnapshot[] = [];
  const pids: number[] = [];
  const { log } = memoryLogger('warn');
  const link = createCoreLink({
    factory: nodeCoreFactory(home, pids),
    config,
    appVersion: '0.3.0-it',
    spool: createSpool(resolvePaths(home).spoolFile, log),
    log,
    toRenderer: { event: (e) => uiEvents.push(e), state: (s) => coreStates.push(s), supervisor: (s) => states.push(s.state) }
  });
  links.push(link);
  return { link, states, coreStates, uiEvents, pids };
}

async function until<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout in attesa di: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function uiCommand(type: string, payload: unknown = {}): CommandEnvelope {
  const id = ulid();
  return { id, type, ts: Date.now(), correlationId: id, issuedBy: 'ui', payload };
}

async function journal(link: CoreLink): Promise<VisioneEvent[]> {
  const res = await link.commands.relay(uiCommand('events.list', { afterSeq: 0, limit: 500 }));
  if (!res.ok) throw new Error(`events.list fallito: ${res.error.code}`);
  return (res.data as EventPage).events;
}

describe('core in un processo separato', () => {
  it('avvio, ping, crash rilevato, riavvio con ricollegamento, eventi registrati', async () => {
    const h = tempHome();
    cleanups.push(h.cleanup);
    const { link, states, uiEvents, pids } = connect(h.dir);

    link.events.emit('app.started', { appVersion: '0.3.0-it', electronVersion: 'none', pid: process.pid });
    link.supervisor.start();
    await until(() => link.supervisor.isReady, 'core pronto');

    const ping = await link.commands.relay(uiCommand('system.ping', { echo: 'it' }));
    expect(ping).toMatchObject({ ok: true, data: { pong: true, echo: 'it', pid: pids[0] } });
    expect(pids[0]).not.toBe(process.pid);

    // Uccisione esterna del processo core.
    const firstPid = pids[0] as number;
    process.kill(firstPid, 'SIGKILL');
    await until(() => states.includes('crashed') && link.supervisor.isReady && pids.length === 2, 'riavvio dopo il crash');
    expect(states).toEqual(['starting', 'ready', 'crashed', 'recovering', 'ready']);
    expect(link.supervisor.snapshot()).toMatchObject({ state: 'ready', totalRestarts: 1, pid: pids[1] });
    expect(pids[1]).not.toBe(firstPid);

    const again = await link.commands.relay(uiCommand('system.ping', {}));
    expect(again).toMatchObject({ ok: true, data: { pid: pids[1] } });

    // Gli eventi del supervisore arrivano nel journal del nuovo core e alla UI.
    const events = await until(async () => {
      const all = await journal(link);
      return all.some((e) => e.type === 'core.restarted') ? all : undefined;
    }, 'core.crashed/core.restarted nel journal');
    const types = events.map((e) => e.type);
    for (const t of ['app.started', 'core.started', 'core.ready', 'core.crashed', 'core.restarted', 'system.started', 'system.ready']) {
      expect(types).toContain(t);
    }
    const crash = events.find((e) => e.type === 'core.crashed');
    expect(crash?.payload).toMatchObject({ pid: firstPid, reason: 'exit', willRestart: true });
    expect(uiEvents.some((e) => e.type === 'core.crashed')).toBe(true);
    expect(createSpool(resolvePaths(h.dir).spoolFile, memoryLogger().log).list()).toEqual([]);
  });

  it('spegnimento cooperativo e persistenza degli eventi attraverso un riavvio completo', async () => {
    const h = tempHome();
    cleanups.push(h.cleanup);

    const first = connect(h.dir);
    first.link.supervisor.start();
    await until(() => first.link.supervisor.isReady, 'primo core pronto');
    const before = await journal(first.link);
    await first.link.supervisor.stop('app-quit', 5_000);
    expect(first.link.supervisor.snapshot()).toMatchObject({ state: 'stopped', lastExit: { code: 0, reason: 'app-quit' } });
    links.splice(links.indexOf(first.link), 1);

    // core.stopped è nello spool (il core era già uscito): lo registra il core successivo.
    const second = connect(h.dir);
    second.link.supervisor.start();
    await until(() => second.link.supervisor.isReady, 'secondo core pronto');
    const after = await until(async () => {
      const all = await journal(second.link);
      return all.some((e) => e.type === 'core.stopped') ? all : undefined;
    }, 'core.stopped del primo avvio nel journal');

    const afterIds = new Set(after.map((e) => e.id));
    for (const e of before) expect(afterIds.has(e.id), `${e.type} sopravvive al riavvio`).toBe(true);
    const types = after.map((e) => e.type);
    expect(types).toContain('system.stopped');
    expect(after.find((e) => e.type === 'core.stopped')?.payload).toMatchObject({ exitCode: 0, reason: 'app-quit' });
  });

  it('comandi durante il crash: core_unavailable, mai una risposta persa', async () => {
    const h = tempHome();
    cleanups.push(h.cleanup);
    const { link, pids } = connect(h.dir);
    link.supervisor.start();
    await until(() => link.supervisor.isReady, 'core pronto');
    process.kill(pids[0] as number, 'SIGKILL');
    await until(() => !link.supervisor.isReady, 'crash rilevato');
    const res = await link.commands.relay(uiCommand('system.ping', {}));
    expect(res).toMatchObject({ ok: false, error: { code: 'core_unavailable', retryable: true } });
    await until(() => link.supervisor.isReady, 'core di nuovo pronto');
    expect(await link.commands.relay(uiCommand('system.ping', {}))).toMatchObject({ ok: true });
  });
});

describe('stato ed eventi del core in un processo reale', () => {
  it('state.get e notifiche di stato: valori reali del processo, correlazione comando → eventi', async () => {
    const h = tempHome();
    cleanups.push(h.cleanup);
    const { link, coreStates, uiEvents, pids } = connect(h.dir);
    link.events.emit('app.started', { appVersion: '0.4.0-it', electronVersion: 'none', pid: process.pid });
    link.supervisor.start();
    await until(() => link.supervisor.isReady, 'core pronto');

    const res = await link.commands.relay(uiCommand('state.get'));
    expect(res.ok).toBe(true);
    const snap = (res as { data: CoreStateSnapshot }).data;
    expect(coreStateSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.core).toMatchObject({ status: 'ready', pid: pids[0], recovered: false });
    expect(snap.database).toMatchObject({ status: 'ok' });

    // Lo stato arriva per notifica, senza richiederlo, e riflette l'app.started ingerito.
    await until(() => coreStates.some((s) => s.application.status === 'running'), 'stato spinto con app in esecuzione');
    expect(coreStates.at(-1)?.core.pid).toBe(pids[0]);

    // system.ping → command.accepted → system.pong → command.completed, stessa correlazione.
    const ping = uiCommand('system.ping', { echo: 'corr' });
    expect(await link.commands.relay(ping)).toMatchObject({ ok: true });
    const chain = await until(() => {
      const c = uiEvents.filter((e) => e.correlationId === ping.correlationId);
      return c.length >= 3 ? c : undefined;
    }, 'eventi correlati al ping');
    expect(chain.map((e) => e.type)).toEqual(['command.accepted', 'system.pong', 'command.completed']);
    expect(chain.every((e) => e.causationId === ping.id)).toBe(true);
    expect(uiEvents.some((e) => e.type === 'state.changed')).toBe(false); // lo stato ha il suo canale

    // events.get e filtri di events.list
    const ready = (await journal(link)).find((e) => e.type === 'system.ready') as VisioneEvent;
    expect(await link.commands.relay(uiCommand('events.get', { id: ready.id }))).toMatchObject({ ok: true, data: { event: { id: ready.id, seq: ready.seq } } });
    const onlyLifecycle = await link.commands.relay(uiCommand('events.list', { types: ['system.lifecycle.changed'], limit: 10 }));
    expect((onlyLifecycle as { data: EventPage }).data.events.map((e) => (e.payload as { to: string }).to)).toEqual(['starting', 'ready']);
  });

  it('kill reale del core: il nuovo core ricostruisce lo stato (crashed dedotto → recovering → ready, app in esecuzione)', async () => {
    const h = tempHome();
    cleanups.push(h.cleanup);
    const { link, pids } = connect(h.dir);
    link.events.emit('app.started', { appVersion: '0.4.0-it', electronVersion: 'none', pid: process.pid });
    link.supervisor.start();
    await until(() => link.supervisor.isReady, 'core pronto');
    await until(async () => (await journal(link)).some((e) => e.type === 'app.started'), 'app.started registrato');

    process.kill(pids[0] as number, 'SIGKILL');
    await until(() => link.supervisor.isReady && pids.length === 2, 'riavvio dopo il kill');
    const res = await link.commands.relay(uiCommand('state.get'));
    const snap = (res as { data: CoreStateSnapshot }).data;
    expect(snap.core).toMatchObject({ status: 'ready', pid: pids[1], previousRun: 'ready', recovered: true });
    expect(snap.application.status).toBe('running'); // ricostruito: stesso main, nessuno shutdown
    const lifecycle = (await journal(link)).filter((e) => e.type === 'system.lifecycle.changed').map((e) => e.payload as { from: string | null; to: string; inferred: boolean });
    expect(lifecycle.map((p) => `${String(p.from)}→${p.to}${p.inferred ? '*' : ''}`)).toEqual([
      'null→starting', 'starting→ready', 'ready→crashed*', 'crashed→recovering', 'recovering→ready'
    ]);
  });
});
