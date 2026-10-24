// Il CLI Runtime cablato nel core (Fase 5, P-35): comandi della UI, verifica dei motori con CLI
// finte, stop di un processo, spegnimento senza orfani, riconciliazione dopo una caduta del core,
// canale degli hook. Processi reali innocui (node), nessun motore reale, nessuna rete.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../../src/core/adapters/index.ts';
import { openDatabase } from '../../src/core/db/index.ts';
import { startCore, type CoreHandle, type CoreTransport } from '../../src/core/kernel/index.ts';
import { createProcessRegistry, hookPipeAddress, type ManagedProcess } from '../../src/core/runtime/index.ts';
import {
  FRAME_VERSION,
  NO_OWNER,
  type CommandResponse,
  type CoreToMainFrameBody,
  type ProcessOwner,
  type VisioneEvent
} from '../../src/shared/contracts/index.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { resolvePaths, type VisionePaths } from '../../src/shared/node/paths.ts';
import { fakeCliEnv, writeShim } from '../adapter-harness.ts';
import { tempHome } from '../helpers.ts';

class Transport implements CoreTransport {
  frames: CoreToMainFrameBody[] = [];
  private handler: ((raw: unknown) => void) | null = null;
  send(frame: CoreToMainFrameBody): void { this.frames.push(frame); }
  onFrame(h: (raw: unknown) => void): void { this.handler = h; }
  onDisconnect(): void { /* non usato */ }
  events(): VisioneEvent[] {
    return this.frames.flatMap((f) => (f.kind === 'evt' ? [f.event] : []));
  }
  private responses(id: string): CommandResponse[] {
    return this.frames.flatMap((f) => (f.kind === 'res' && f.response.id === id ? [f.response] : []));
  }
  /** Invia un comando come farebbe il main per la UI e attende la sua risposta. */
  async command(type: string, payload: unknown = {}, id = ulid()): Promise<CommandResponse> {
    const before = this.responses(id).length;
    this.handler?.({ v: FRAME_VERSION, kind: 'cmd', command: { id, type, ts: Date.now(), correlationId: id, issuedBy: 'ui', payload } });
    for (let i = 0; i < 1_500 && this.responses(id).length === before; i++) await sleep(10);
    const res = this.responses(id)[before];
    if (!res) throw new Error(`nessuna risposta a ${type}`);
    return res;
  }
  async waitEvent(pred: (e: VisioneEvent) => boolean, ms = 10_000): Promise<VisioneEvent> {
    for (let waited = 0; waited < ms; waited += 10) {
      const found = this.events().find(pred);
      if (found) return found;
      await sleep(10);
    }
    throw new Error('evento atteso non arrivato');
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const cleanups: Array<() => void> = [];
const running: CoreHandle[] = [];
const children: number[] = [];
afterEach(async () => {
  for (const core of running.splice(0)) if (core.lifecycle === 'running') await core.stop('test', 6_000);
  for (const pid of children.splice(0)) if (alive(pid)) process.kill(pid);
  while (cleanups.length > 0) cleanups.pop()?.();
});

function newPaths(): VisionePaths {
  const h = tempHome();
  cleanups.push(h.cleanup);
  return resolvePaths(h.dir);
}

function boot(paths: VisionePaths, opts: { env?: Record<string, string | undefined>; adapters?: () => AgentAdapter[] } = {}) {
  const transport = new Transport();
  const exits: number[] = [];
  const core = startCore({
    transport, paths, env: opts.env ?? {}, pid: 4242, coreVersion: '0.4.0-test', exit: (c) => exits.push(c), logSinks: [], seedDefaultAgents: false, telemetry: { enabled: false }, offline: { enabled: false },
    ...(opts.adapters ? { adapters: opts.adapters } : {})
  });
  running.push(core);
  return { core, transport, exits };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Processo innocuo che non esce da solo e ignora la fine di stdin. */
function sleeper(core: CoreHandle, paths: VisionePaths, owner: Partial<ProcessOwner> = NO_OWNER): ManagedProcess {
  core.runtime.policy.allowExecutable(process.execPath);
  const started = core.runtime.start({
    exe: process.execPath,
    args: ['-e', "console.log('pronto'); setInterval(() => {}, 1000)"],
    cwd: paths.workspaceDir,
    env: core.runtime.env(paths.workspaceDir),
    io: 'pipes',
    kind: 'system',
    owner,
    correlationId: ulid()
  });
  if (!started.ok) throw new Error(started.error.message);
  return started.process;
}

async function untilRunning(p: ManagedProcess): Promise<number> {
  for (let i = 0; i < 500 && p.status !== 'running'; i++) await sleep(10);
  expect(p.status).toBe('running');
  return p.pid ?? 0;
}

function fakeAdapter(id: string, probe: AgentAdapter['probe']): AgentAdapter {
  const unused = (): never => {
    throw new Error('non usato');
  };
  return {
    id, capabilities: new Set(), probe, validate: () => ({ ok: true }),
    start: unused, sendTurn: unused, cancelTurn: unused, stop: unused
  };
}

describe('CLI Runtime nel core', () => {
  it('engines.probe: ogni adapter del registro, errori di un adapter contenuti, nessun nome di motore nel core', async () => {
    const paths = newPaths();
    const { transport } = boot(paths, {
      adapters: () => [
        fakeAdapter('motore-a', () => Promise.resolve({ available: true, version: '1.2.3', path: 'C:\\bin\\a.exe', problems: [] })),
        fakeAdapter('motore-b', () => Promise.resolve({ available: false, problems: ['CLI non trovata'] })),
        fakeAdapter('motore-c', () => Promise.reject(new Error('guasto')))
      ]
    });
    const res = await transport.command('engines.probe', { refresh: true });
    expect(res).toMatchObject({ ok: true });
    expect(res.ok && res.data).toEqual({
      engines: [
        { adapter: 'motore-a', available: true, version: '1.2.3', path: 'C:\\bin\\a.exe', command: null, problems: [] },
        { adapter: 'motore-b', available: false, version: null, path: null, command: null, problems: ['CLI non trovata'] },
        { adapter: 'motore-c', available: false, version: null, path: null, command: null, problems: ['guasto'] }
      ]
    });
  });

  it('engines.probe con gli adapter inclusi e CLI finte: versione letta da processi probe, eventi system.cli.*', async () => {
    const paths = newPaths();
    const bin = join(paths.home, 'bin');
    writeShim(bin, 'opencode', 'test/fixtures/fake-opencode.mjs');
    writeShim(bin, 'claude', 'test/fixtures/fake-claude.mjs');
    const { core, transport } = boot(paths, { env: fakeCliEnv(bin) });
    const res = await transport.command('engines.probe', {});
    expect(res.ok).toBe(true);
    const engines = res.ok ? (res.data as { engines: Array<{ adapter: string; available: boolean; version: string | null }> }).engines : [];
    expect(engines.map((e) => [e.adapter, e.available, e.version])).toEqual([
      ['opencode', true, 'opencode v2.0.12-fake'],
      ['claude-code', true, '2.1.286-fake (Claude Code)'],
      // Fase 8: la CLI di `pty-generic` la sceglie ogni agente (verificata all'avvio dell'istanza).
      ['pty-generic', true, null]
    ]);
    const discovered = transport.events().filter((e) => e.type === 'system.cli.discovered').map((e) => e.payload as { name: string; kind: string });
    expect(discovered.map((d) => [d.name, d.kind]).sort()).toEqual([['claude', 'npm-shim'], ['opencode', 'npm-shim']]);
    // Le versioni sono processi `probe` del runtime: registrati, avviati, usciti; stato aggiornato.
    const probes = core.runtime.list().filter((p) => p.kind === 'probe');
    expect(probes).toHaveLength(2);
    expect(probes.every((p) => p.status === 'exited' && p.cwd === paths.runtimeDir)).toBe(true);
    await transport.waitEvent((e) => e.type === 'state.changed' && (e.payload as { snapshot: { processes: { created: number } } }).snapshot.processes.created === 2);
    expect(core.state.snapshot().processes).toMatchObject({ active: 0, created: 2, failed: 0, last: { status: 'exited' } });
    // Seconda verifica senza refresh: dalla cache, nessun processo nuovo.
    await transport.command('engines.probe', {});
    expect(core.runtime.list().filter((p) => p.kind === 'probe')).toHaveLength(2);
  });

  it('engines.probe senza CLI: motori non disponibili e system.cli.missing, nessun processo', async () => {
    const paths = newPaths();
    const { core, transport } = boot(paths, {
      env: fakeCliEnv(null, { LOCALAPPDATA: join(paths.home, 'vuota'), APPDATA: join(paths.home, 'vuota'), USERPROFILE: join(paths.home, 'vuota') }, { nodeDir: false })
    });
    const res = await transport.command('engines.probe', {});
    const engines = res.ok ? (res.data as { engines: Array<{ adapter: string; available: boolean }> }).engines : [];
    expect(engines.map((e) => [e.adapter, e.available])).toEqual([['opencode', false], ['claude-code', false], ['pty-generic', true]]);
    expect(transport.events().filter((e) => e.type === 'system.cli.missing')).toHaveLength(2);
    expect(core.runtime.list()).toEqual([]);
  });

  it('P-99: engines.probe con filtro verifica UN motore; adapter sconosciuto = not_found', async () => {
    const paths = newPaths();
    const { transport } = boot(paths, {
      adapters: () => [
        fakeAdapter('motore-a', () => Promise.resolve({ available: true, version: '1.0', path: 'C:\\bin\\a.exe', problems: [] })),
        fakeAdapter('motore-b', () => Promise.resolve({ available: false, problems: ['CLI non trovata'] }))
      ]
    });
    const one = await transport.command('engines.probe', { adapter: 'motore-b' });
    expect(one.ok).toBe(true);
    expect(one.ok && (one.data as { engines: Array<{ adapter: string; available: boolean; command: string | null }> }).engines)
      .toEqual([{ adapter: 'motore-b', available: false, version: null, path: null, command: null, problems: ['CLI non trovata'] }]);
    const missing = await transport.command('engines.probe', { adapter: 'ignoto' });
    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('P-99: engines.restart ri-verifica i motori e riavvia le sessioni in errore con evento e audit', async () => {
    const paths = newPaths();
    const broken: AgentAdapter = {
      ...fakeAdapter('motore-a', () => Promise.resolve({ available: true, version: '1.0', path: 'C:\\bin\\a.exe', problems: [] })),
      async start() {
        throw new Error('motore guasto');
      }
    };
    const { transport } = boot(paths, { adapters: () => [broken] });
    const defined = await transport.command('agents.define', {
      definition: {
        id: 'ag', name: 'Ag', role: 'agente di prova', competences: ['general'], engine: { adapter: 'motore-a' },
        persona: { instructions: 'x', language: 'it' }, workspace: { root: 'ag', isolation: 'shared' }, permissions: 'read-only',
        limits: { maxTurnMinutes: 5, maxTurnsPerTask: 10, maxConcurrentTasks: 1 }
      }
    });
    expect(defined.ok).toBe(true);
    // La sessione fallisce all'avvio: l'istanza resta in `error` (stato reale, nessun processo).
    const started = await transport.command('agents.start', { agentId: 'ag' });
    expect(started.ok).toBe(true);
    expect(started.ok && (started.data as { started: boolean; status: string | null }).started).toBe(false);
    // «Riavvia motori»: prova di nuovo, l'agente in errore viene ritentato e fallisce ancora → motivo vero.
    const restart = await transport.command('engines.restart', {});
    expect(restart.ok).toBe(true);
    const data = restart.ok ? (restart.data as { probes: Array<{ adapter: string }>; restarted: Array<{ agentId: string; ok: boolean; reason: string }>; failed: number }) : null;
    expect(data?.probes.map((p) => p.adapter)).toEqual(['motore-a']);
    expect(data?.restarted).toEqual([{ agentId: 'ag', ok: false, reason: 'motore guasto' }]);
    expect(data?.failed).toBe(1);
    const evt = await transport.waitEvent((e) => e.type === 'system.engines.restarted');
    expect(evt.payload).toMatchObject({ probed: 1, available: 1, restarted: 0, failed: 1, details: [{ agentId: 'ag', ok: false, reason: 'motore guasto' }] });
    const audit = await transport.command('audit.list', { limit: 50 });
    expect(audit.ok && (audit.data as { entries: Array<{ action: string; decision: string }> }).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'engines.restart', decision: 'partial' })
    ]));
  });

  it('runtime.processes e runtime.stop: lettura con proprietario, stop idempotente, id sconosciuto', async () => {
    const paths = newPaths();
    const { core, transport } = boot(paths);
    const p = sleeper(core, paths, { agentId: 'director', sessionId: 'ses-1', taskId: 'task-9', adapter: 'test' });
    const pid = await untilRunning(p);

    const listed = await transport.command('runtime.processes', { live: true });
    expect(listed.ok && listed.data).toEqual({ processes: [expect.objectContaining({
      id: p.id, pid, status: 'running', kind: 'system', owner: { agentId: 'director', sessionId: 'ses-1', taskId: 'task-9', adapter: 'test' }
    })] });
    // Nessun argomento né ambiente nella vista.
    expect(JSON.stringify(listed)).not.toContain('setInterval');

    const stopId = ulid();
    const stopped = await transport.command('runtime.stop', { processId: p.id, mode: 'graceful' }, stopId);
    expect(stopped).toMatchObject({ ok: true, data: { processId: p.id, status: 'stopped', alreadyFinished: false }, replayed: false });
    expect(alive(pid)).toBe(false);
    // Stesso comando ripetuto: risposta conservata (idempotenza del router).
    expect(await transport.command('runtime.stop', { processId: p.id }, stopId)).toMatchObject({ ok: true, replayed: true });
    // Nuovo comando sullo stesso processo: già terminato, nessun errore.
    expect(await transport.command('runtime.stop', { processId: p.id, mode: 'force' })).toMatchObject({
      ok: true, data: { status: 'stopped', alreadyFinished: true }
    });
    expect(await transport.command('runtime.stop', { processId: 'inesistente' })).toMatchObject({ ok: false, error: { code: 'not_found', retryable: false } });
    expect(await transport.command('runtime.processes', { live: true })).toMatchObject({ ok: true, data: { processes: [] } });

    // Eventi del processo nel journal, nell'ordine del ciclo di vita.
    const page = await transport.command('events.list', { types: ['process.created', 'process.started', 'process.stopping', 'process.stopped'] });
    const types = page.ok ? (page.data as { events: VisioneEvent[] }).events.map((e) => e.type) : [];
    expect(types).toEqual(['process.created', 'process.started', 'process.stopping', 'process.stopped']);
  });

  it('la UI non può avviare processi: nessun comando lo permette', async () => {
    const paths = newPaths();
    const { transport } = boot(paths);
    const res = await transport.command('runtime.start', { exe: 'cmd.exe', args: ['/c', 'echo'] });
    expect(res).toMatchObject({ ok: false, error: { code: 'unknown_command' } });
    const bad = await transport.command('runtime.stop', { processId: 'x', exe: 'cmd.exe' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
  });

  it('spegnimento del core: i processi vivi vengono fermati prima di system.stopped, nessun orfano', async () => {
    const paths = newPaths();
    const { core, transport } = boot(paths);
    const a = sleeper(core, paths);
    const b = sleeper(core, paths);
    const pids = [await untilRunning(a), await untilRunning(b)];
    await core.stop('test', 6_000);
    expect(pids.map(alive)).toEqual([false, false]);
    expect([a.status, b.status]).toEqual(['stopped', 'stopped']);
    const order = transport.events().filter((e) => e.type === 'process.stopped' || e.type === 'system.stopped').map((e) => e.type);
    expect(order).toEqual(['process.stopped', 'process.stopped', 'system.stopped']);
    // Canale degli hook chiuso con il core.
    await expect(new Promise((resolve, reject) => {
      const s = connect(hookPipeAddress(paths.home), () => { s.destroy(); resolve('aperto'); });
      s.on('error', reject);
    })).rejects.toThrow();
  });

  it('canale degli hook in ascolto dopo l\'avvio', async () => {
    const paths = newPaths();
    boot(paths);
    let connected = false;
    for (let i = 0; i < 100 && !connected; i++) {
      connected = await new Promise<boolean>((resolve) => {
        const s = connect(hookPipeAddress(paths.home), () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
      });
      if (!connected) await sleep(20);
    }
    expect(connected).toBe(true);
  });

  it('dopo una caduta del core: il processo rimasto vivo viene riconciliato e terminato all\'avvio successivo', async () => {
    const paths = newPaths();
    // Avvio precedente "caduto": il registro dice running, il processo è ancora vivo.
    boot(paths);
    await running.splice(0)[0]?.stop('preparazione', 6_000);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid ?? 0;
    children.push(pid);
    const { db } = openDatabase(paths.dbFile);
    const id = ulid();
    const at = Date.now();
    createProcessRegistry(db).insert({
      id, pid, status: 'running', kind: 'agent-session', io: 'pipes', owner: { ...NO_OWNER, agentId: 'director' },
      exe: process.execPath, cwd: paths.workspaceDir, correlationId: id, createdAt: at, startedAt: at, endedAt: null,
      exitCode: null, signal: null, error: null, restartOf: null
    });
    db.close();
    expect(alive(pid)).toBe(true);

    const { core, transport } = boot(paths);
    const reconciled = await transport.waitEvent((e) => e.type === 'process.reconciled', 20_000);
    expect(reconciled.payload).toEqual({ processId: id, pid, outcome: 'killed' });
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(20);
    expect(alive(pid)).toBe(false);
    // Il registro non lo considera più vivo: un secondo avvio non lo ritrova.
    await core.stop('test', 6_000);
    const again = boot(paths);
    await again.transport.waitEvent((e) => e.type === 'system.ready');
    await sleep(300);
    expect(again.transport.events().filter((e) => e.type === 'process.reconciled')).toEqual([]);
  }, 40_000);
});
