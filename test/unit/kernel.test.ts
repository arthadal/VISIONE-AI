// Il core nel processo dei test, con un canale finto: avvio, comandi, ingest, spegnimento, riavvio.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { startCore, type CoreHandle, type CoreTransport } from '../../src/core/kernel/index.ts';
import { createHookServer, hookPipeAddress } from '../../src/core/runtime/index.ts';
import {
  FRAME_VERSION,
  coreStateSnapshotSchema,
  createEvent,
  type AgentView,
  type CoreStateSnapshot,
  type CoreToMainFrameBody,
  type MainToCoreFrame,
  type VisioneEvent
} from '../../src/shared/contracts/index.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { resolvePaths, type VisionePaths } from '../../src/shared/node/paths.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

class FakeTransport implements CoreTransport {
  frames: CoreToMainFrameBody[] = [];
  private handler: ((raw: unknown) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;
  send(frame: CoreToMainFrameBody): void { this.frames.push(frame); }
  onFrame(h: (raw: unknown) => void): void { this.handler = h; }
  onDisconnect(h: () => void): void { this.disconnectHandler = h; }
  disconnect(): void { this.disconnectHandler?.(); }
  deliver(frame: Omit<MainToCoreFrame, 'v'> | Record<string, unknown>): void { this.handler?.({ v: FRAME_VERSION, ...frame }); }
  of<K extends CoreToMainFrameBody['kind']>(kind: K): Array<Extract<CoreToMainFrameBody, { kind: K }>> {
    return this.frames.filter((f): f is Extract<CoreToMainFrameBody, { kind: K }> => f.kind === kind);
  }
  async waitFor<K extends CoreToMainFrameBody['kind']>(kind: K, count = 1): Promise<Array<Extract<CoreToMainFrameBody, { kind: K }>>> {
    for (let i = 0; i < 200 && this.of(kind).length < count; i++) await new Promise((r) => setTimeout(r, 5));
    return this.of(kind);
  }
}

const cleanups: Array<() => void> = [];
const running: CoreHandle[] = [];
afterEach(async () => {
  for (const core of running.splice(0)) if (core.lifecycle === 'running') await core.stop('test', 1_000);
  while (cleanups.length > 0) cleanups.pop()?.();
});

function boot(paths: VisionePaths, hooksRetry: { ms: number; attempts: number } = { ms: 20, attempts: 3 }) {
  const transport = new FakeTransport();
  const exits: number[] = [];
  const core = startCore({ transport, paths, env: {}, pid: 4242, coreVersion: '0.3.0-test', exit: (c) => exits.push(c), logSinks: [], seedDefaultAgents: false, telemetry: { enabled: false }, offline: { enabled: false }, hooksRetry });
  running.push(core);
  return { core, transport, exits };
}

function newPaths(): VisionePaths {
  const h = tempHome();
  cleanups.push(h.cleanup);
  return resolvePaths(h.dir);
}

const durable = (t: FakeTransport) => t.of('evt').map((f) => f.event).filter((e) => e.durability === 'durable');

const command = (type: string, payload: unknown = {}) => {
  const id = ulid();
  return { id, type, ts: Date.now(), correlationId: id, issuedBy: 'ui' as const, payload };
};

const listAgents = async (t: FakeTransport): Promise<AgentView[]> => {
  const c = command('agents.list', { includeArchived: false });
  t.deliver({ kind: 'cmd', command: c });
  for (let i = 0; i < 200; i++) {
    const res = t.of('res').find((f) => f.response.id === c.id);
    if (res) return (res.response as { ok: true; data: { agents: AgentView[] } }).data.agents;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('agents.list senza risposta');
};

describe('kernel del core', () => {
  it('avvio: crea config e database, registra system.started, ciclo di vita e system.ready, invia ready', async () => {
    const paths = newPaths();
    const { transport } = boot(paths);
    expect(transport.of('ready')).toEqual([{ kind: 'ready', pid: 4242, coreVersion: '0.3.0-test', startupMs: expect.any(Number) }]);
    expect(existsSync(paths.dbFile)).toBe(true);
    expect(JSON.parse(readFileSync(paths.configFile, 'utf8')).version).toBe(1);
    await transport.waitFor('evt', 4);
    expect(durable(transport).map((e) => [e.type, e.seq])).toEqual([
      ['system.started', 1], ['system.lifecycle.changed', 2], ['system.lifecycle.changed', 3], ['system.ready', 4]
    ]);
    expect(durable(transport).filter((e) => e.type === 'system.lifecycle.changed').map((e) => e.payload))
      .toEqual([{ from: null, to: 'starting', reason: 'avvio', inferred: false }, { from: 'starting', to: 'ready', reason: 'avvio completato', inferred: false }]);
  });

  it('system.ping fa il giro comando → risposta, con eventi correlati', async () => {
    const { transport } = boot(newPaths());
    const c = command('system.ping', { echo: 'e2e' });
    transport.deliver({ kind: 'cmd', command: c });
    const [res] = await transport.waitFor('res');
    expect(res?.response).toMatchObject({ id: c.id, ok: true, data: { pong: true, echo: 'e2e', pid: 4242 } });
    await transport.waitFor('evt', 8);
    const chain = transport.of('evt').filter((f) => f.event.correlationId === c.correlationId);
    expect(chain.map((f) => f.event.type)).toEqual(['command.accepted', 'system.pong', 'command.completed']);
  });

  it('un frame cmd malformato riceve comunque una risposta di errore', async () => {
    const { transport } = boot(newPaths());
    transport.deliver({ kind: 'cmd', command: { id: 'abcdefgh1', type: 'system.ping' } });
    const [res] = await transport.waitFor('res');
    expect(res?.response).toMatchObject({ id: 'abcdefgh1', ok: false, error: { code: 'invalid_command' } });
  });

  it('heartbeat e ingest degli eventi del main', async () => {
    const { transport } = boot(newPaths());
    transport.deliver({ kind: 'hb', n: 7 });
    expect(transport.of('hb-ack')).toEqual([{ kind: 'hb-ack', n: 7 }]);
    const e = createEvent('core.started', { pid: 4242, attempt: 0 });
    transport.deliver({ kind: 'ingest', events: [e, createEvent('system.ready', { startupMs: 0, journalLastSeq: 0 })] });
    expect(transport.of('ingested')).toEqual([{ kind: 'ingested', ids: [e.id] }]);
    const forwarded = (await transport.waitFor('evt', 7)).map((f) => f.event);
    expect(forwarded.find((x) => x.id === e.id)?.seq).toBe(5);
    // Il tipo con origine sbagliata è rifiutato con un evento, il core prosegue.
    expect(forwarded.some((x) => x.type === 'system.event.rejected')).toBe(true);
  });

  it('spegnimento: system.stopped, frame stopped, database chiuso, uscita 0; poi rifiuta i comandi', async () => {
    const paths = newPaths();
    const { core, transport, exits } = boot(paths);
    transport.deliver({ kind: 'shutdown', reason: 'test', deadlineMs: 2_000 });
    await transport.waitFor('stopped');
    expect(core.lifecycle).toBe('stopped');
    await new Promise((r) => setTimeout(r, 80));
    expect(exits).toEqual([0]);
    const tail = durable(transport).slice(-3);
    expect(tail.map((e) => e.type)).toEqual(['system.lifecycle.changed', 'system.stopped', 'system.lifecycle.changed']);
    expect(tail.at(-1)?.payload).toMatchObject({ from: 'stopping', to: 'stopped' });
    // WAL chiuso con checkpoint: il file -wal è vuoto o assente.
    expect(!existsSync(`${paths.dbFile}-wal`) || readFileSync(`${paths.dbFile}-wal`).length === 0).toBe(true);
  });

  it('riavvio sulla stessa home: gli eventi della sessione precedente sono ancora leggibili', async () => {
    const paths = newPaths();
    const first = boot(paths);
    const marker = createEvent('app.shutdown', { reason: 'marcatore-riavvio' });
    first.transport.deliver({ kind: 'ingest', events: [marker] });
    await first.core.stop('test', 1_000);

    const second = boot(paths);
    const c = command('events.list', { limit: 100 });
    second.transport.deliver({ kind: 'cmd', command: c });
    const [res] = await second.transport.waitFor('res');
    expect(res?.response.ok).toBe(true);
    const events = (res?.response as { data: { events: VisioneEvent[] } }).data.events;
    const types = events.map((e) => e.type).filter((t) => t !== 'system.lifecycle.changed');
    expect(events.find((e) => e.id === marker.id)?.payload).toEqual({ reason: 'marcatore-riavvio' });
    expect(types).toEqual(['system.started', 'system.ready', 'app.shutdown', 'system.stopped', 'system.started', 'system.ready']);
  });

  it('errore fatale: system.error registrato, frame fatal, uscita 1', async () => {
    const { core, transport, exits } = boot(newPaths());
    core.fail(new Error('invariante violata'), 'test-fatal');
    await transport.waitFor('fatal');
    await new Promise((r) => setTimeout(r, 80));
    expect(transport.of('fatal')[0]?.message).toBe('test-fatal: invariante violata');
    expect(transport.of('evt').some((f) => f.event.type === 'system.error' && f.event.seq !== null)).toBe(true);
    expect(exits).toEqual([1]);
  });

  it('P-83: il modello predefinito va solo ai motori che lo dichiarano; l\'agente di ripiego esiste; un modello estraneo viene riparato', async () => {
    const paths = newPaths();
    mkdirSync(dirname(paths.configFile), { recursive: true });
    const model = 'nvidia/nvidia/nemotron-3-super-120b-a12b';
    writeFileSync(paths.configFile, JSON.stringify({ version: 1, agents: { seedDefaults: true, defaultModel: model } }));
    const bootSeeded = () => {
      const transport = new FakeTransport();
      const core = startCore({ transport, paths, env: {}, pid: 4242, coreVersion: '0.3.0-test', exit: () => undefined, logSinks: [], telemetry: { enabled: false }, offline: { enabled: false } });
      running.push(core);
      return { core, transport };
    };
    const first = bootSeeded();
    await first.transport.waitFor('ready');
    const agents = await listAgents(first.transport);
    const byId = new Map(agents.map((a) => [a.definition.id, a]));
    // Il motore headless dichiarato accetta il modello; l'agente del terminale interattivo no.
    expect(byId.get('director')?.definition.engine).toMatchObject({ adapter: 'opencode', model });
    expect(byId.get('esecutore')?.definition.engine.adapter).toBe('claude-code');
    expect(byId.get('esecutore')?.definition.engine.model).toBeUndefined();
    // P-91: i seed scelgono il primo motore che accetta la definizione (pty-generic non è
    // assegnabile senza `command`): `revisore` non fallisce più la creazione.
    expect(byId.get('revisore')?.definition.engine).toMatchObject({ adapter: 'opencode', model });
    // L'agente di ripiego è garantito dalla config (id neutro) e ha il modello reale.
    expect(byId.get('ripiego')?.definition.engine).toMatchObject({ adapter: 'opencode', model });
    await first.core.stop('test', 1_000);
    // Simula una home con il difetto vecchio: modello del motore headless finito sull'agente interattivo.
    const db = new DatabaseSync(paths.dbFile);
    const row = db.prepare('SELECT definition FROM agent_definitions WHERE id = ?').get('esecutore') as { definition: string };
    const def = JSON.parse(row.definition) as { engine: { model?: string }; version: number };
    def.engine.model = model;
    def.version += 1;
    db.prepare('UPDATE agent_definitions SET definition = ? WHERE id = ?').run(JSON.stringify(def), 'esecutore');
    db.close();
    const second = bootSeeded();
    await second.transport.waitFor('ready');
    const repaired = (await listAgents(second.transport)).find((a) => a.definition.id === 'esecutore');
    expect(repaired?.definition.engine.model).toBeUndefined();
    expect(repaired?.definition.version).toBe(3); // v1 di seed, v2 iniettata, v3 della riparazione
    expect(second.transport.of('evt').some((f) => f.event.type === 'agent.definition.updated')).toBe(true);
  }, 30_000);

  it('P-91: l\'agente coder è garantito con il modello dichiarato; senza modello non viene inventato', async () => {
    const paths = newPaths();
    mkdirSync(dirname(paths.configFile), { recursive: true });
    const model = 'nvidia/nvidia/nemotron-3-super-120b-a12b';
    const coderModel = 'nvidia/deepseek-ai/deepseek-v4.1-flash';
    writeFileSync(paths.configFile, JSON.stringify({ version: 1, agents: { seedDefaults: true, defaultModel: model, coder: { model: coderModel } } }));
    const bootSeeded = () => {
      const transport = new FakeTransport();
      const core = startCore({ transport, paths, env: {}, pid: 4242, coreVersion: '0.3.0-test', exit: () => undefined, logSinks: [], telemetry: { enabled: false }, offline: { enabled: false } });
      running.push(core);
      return { core, transport };
    };
    const first = bootSeeded();
    await first.transport.waitFor('ready');
    const coder = (await listAgents(first.transport)).find((a) => a.definition.id === 'coder');
    // Adapter che dichiara il modello di coding + permessi di scrittura nella sola cartella dell'agente.
    expect(coder?.definition.engine).toEqual({ adapter: 'opencode', model: coderModel });
    expect(coder?.definition).toMatchObject({ competences: ['code'], permissions: 'workspace-write', workspace: { root: 'coder', isolation: 'shared' } });
    await first.core.stop('test', 1_000);
    // Config senza alcun modello: il coder non si crea (nessun modello inventato).
    const bare = newPaths();
    mkdirSync(dirname(bare.configFile), { recursive: true });
    writeFileSync(bare.configFile, JSON.stringify({ version: 1, agents: { seedDefaults: true } }));
    const transport = new FakeTransport();
    const core = startCore({ transport, paths: bare, env: {}, pid: 4242, coreVersion: '0.3.0-test', exit: () => undefined, logSinks: [], telemetry: { enabled: false }, offline: { enabled: false } });
    running.push(core);
    await transport.waitFor('ready');
    expect((await listAgents(transport)).some((a) => a.definition.id === 'coder')).toBe(false);
  }, 30_000);

  it('P-93: l\'agente ultra è garantito con il modello Nemo Ultra dichiarato; senza modello non viene inventato', async () => {
    const paths = newPaths();
    mkdirSync(dirname(paths.configFile), { recursive: true });
    const ultraModel = 'nvidia/nvidia/nemotron-3-ultra-550b-a55b';
    writeFileSync(paths.configFile, JSON.stringify({ version: 1, agents: { seedDefaults: true, ultra: { model: ultraModel } } }));
    const bootSeeded = () => {
      const transport = new FakeTransport();
      const core = startCore({ transport, paths, env: {}, pid: 4242, coreVersion: '0.3.0-test', exit: () => undefined, logSinks: [], telemetry: { enabled: false }, offline: { enabled: false } });
      running.push(core);
      return { core, transport };
    };
    const first = bootSeeded();
    await first.transport.waitFor('ready');
    const ultra = (await listAgents(first.transport)).find((a) => a.definition.id === 'ultra');
    // Adapter che dichiara il modello + permessi di sola lettura: analizza e riferisce, non scrive.
    expect(ultra?.definition.engine).toEqual({ adapter: 'opencode', model: ultraModel });
    expect(ultra?.definition).toMatchObject({ competences: ['reasoning', 'general'], permissions: 'read-only', workspace: { root: 'ultra', isolation: 'shared' } });
    await first.core.stop('test', 1_000);
    // Config con modello esplicitamente vuoto: ultra non si crea (nessun modello inventato).
    const bare = newPaths();
    mkdirSync(dirname(bare.configFile), { recursive: true });
    writeFileSync(bare.configFile, JSON.stringify({ version: 1, agents: { seedDefaults: true, ultra: { model: '' } } }));
    const transport = new FakeTransport();
    const core = startCore({ transport, paths: bare, env: {}, pid: 4242, coreVersion: '0.3.0-test', exit: () => undefined, logSinks: [], telemetry: { enabled: false }, offline: { enabled: false } });
    running.push(core);
    await transport.waitFor('ready');
    expect((await listAgents(transport)).some((a) => a.definition.id === 'ultra')).toBe(false);
  }, 30_000);
});

describe('kernel — stato, recupero e IPC dello stato', () => {
  const stateOf = async (t: FakeTransport) => {
    const c = command('state.get');
    t.deliver({ kind: 'cmd', command: c });
    for (let i = 0; i < 200; i++) {
      const res = t.of('res').find((f) => f.response.id === c.id);
      if (res) return res.response as { ok: true; data: CoreStateSnapshot };
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('state.get senza risposta');
  };
  const pushed = (t: FakeTransport) =>
    t.of('evt').map((f) => f.event).filter((e) => e.type === 'state.changed').map((e) => (e.payload as { snapshot: CoreStateSnapshot }).snapshot);

  it('state.get restituisce uno snapshot valido e coerente con il journal', async () => {
    const { transport } = boot(newPaths());
    const res = await stateOf(transport);
    expect(res.ok).toBe(true);
    expect(coreStateSnapshotSchema.parse(res.data)).toEqual(res.data);
    expect(res.data).toMatchObject({
      core: { status: 'ready', pid: 4242, previousRun: null, recovered: false },
      database: { status: 'ok', journalLastSeq: 4, journalCount: 4 },
      ipc: { status: 'connected' },
      version: { core: '0.3.0-test', dbSchema: 16 }
    });
  });

  it('le variazioni di stato sono spinte come state.changed, raggruppate e con revisione crescente', async () => {
    const { transport } = boot(newPaths());
    await transport.waitFor('evt', 5);
    const first = pushed(transport);
    expect(first.length).toBe(1); // l'avvio produce una sola notifica (raggruppata)
    expect(first[0]?.core.status).toBe('ready');
    transport.deliver({ kind: 'cmd', command: command('system.ping') });
    for (let i = 0; i < 100 && pushed(transport).length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    const all = pushed(transport);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const revisions = all.map((s) => s.revision);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
    expect(all.at(-1)?.ipc.commandsCompleted).toBeGreaterThanOrEqual(1);
    // state.changed non diventa mai "ultimo evento" (nessun ciclo)
    expect(all.every((s) => s.events.last?.type !== 'state.changed')).toBe(true);
  });

  it('dopo un errore fatale il core successivo registra crashed → recovering → ready', async () => {
    const paths = newPaths();
    const first = boot(paths);
    first.core.fail(new Error('guasto di prova'), 'test-fatal');
    await first.transport.waitFor('fatal');
    await new Promise((r) => setTimeout(r, 80));

    const second = boot(paths);
    const s = (await stateOf(second.transport)).data;
    expect(s.core).toMatchObject({ status: 'ready', previousRun: 'crashed', recovered: true });
    expect(s.error.last).toMatchObject({ code: 'test-fatal', message: 'guasto di prova' });
    const transitions = durable(second.transport).filter((e) => e.type === 'system.lifecycle.changed').map((e) => e.payload);
    expect(transitions).toEqual([
      { from: 'crashed', to: 'recovering', reason: 'recupero dopo uscita non pulita', inferred: false },
      { from: 'recovering', to: 'ready', reason: 'recupero completato', inferred: false }
    ]);
  });

  it('uscita senza alcuna registrazione (processo ucciso): crashed dedotto, poi recovering → ready', async () => {
    const paths = newPaths();
    boot(paths); // resta "ready": per il journal è come un processo ucciso
    const second = boot(paths);
    await second.transport.waitFor('evt', 6);
    const transitions = durable(second.transport).filter((e) => e.type === 'system.lifecycle.changed');
    expect(transitions.map((e) => [e.payload, e.severity])).toEqual([
      [{ from: 'ready', to: 'crashed', reason: 'uscita non pulita (ultimo stato: ready)', inferred: true }, 'warning'],
      [{ from: 'crashed', to: 'recovering', reason: 'recupero dopo uscita non pulita', inferred: false }, 'info'],
      [{ from: 'recovering', to: 'ready', reason: 'recupero completato', inferred: false }, 'info']
    ]);
    const s = (await stateOf(second.transport)).data;
    expect(s.core).toMatchObject({ status: 'ready', previousRun: 'ready', recovered: true });
  });

  it('dopo una chiusura pulita il riavvio non è un recupero', async () => {
    const paths = newPaths();
    const first = boot(paths);
    await first.core.stop('test', 1_000);
    const second = boot(paths);
    expect((await stateOf(second.transport)).data.core).toMatchObject({ status: 'ready', previousRun: 'stopped', recovered: false });
  });

  it('database illeggibile all\'avvio: messo da parte, il core parte e lo dichiara', async () => {
    const paths = newPaths();
    mkdirSync(dirname(paths.dbFile), { recursive: true });
    writeFileSync(paths.dbFile, 'non sono un database '.repeat(100));
    const { transport } = boot(paths);
    expect(transport.of('ready')).toHaveLength(1);
    const s = (await stateOf(transport)).data;
    expect(s.database.quarantined).toMatch(/^visione\.db\.corrupt-\d+$/);
    await transport.waitFor('evt', 5);
    expect(durable(transport)[0]).toMatchObject({ type: 'system.db.quarantined', severity: 'error' });
  });

  it('frame non validi ed eventi sconosciuti: contati nello stato, il core continua a rispondere', async () => {
    const { transport } = boot(newPaths());
    transport.deliver({ kind: 'sconosciuto', x: 1 });
    const unknown = { ...createEvent('core.started', { pid: 1, attempt: 0 }), type: 'core.sconosciuto' };
    transport.deliver({ kind: 'ingest', events: [unknown] });
    const s = (await stateOf(transport)).data;
    expect(s.ipc.invalidFrames).toBe(1);
    expect(s.events.rejected).toBe(1);
    expect(transport.of('ingested').at(-1)).toEqual({ kind: 'ingested', ids: [] });
  });

  it('main disconnesso: spegnimento cooperativo (main-disconnected), system.stopped ed uscita 0', async () => {
    const { core, transport, exits } = boot(newPaths());
    await transport.waitFor('ready');
    transport.disconnect();
    await transport.waitFor('stopped');
    expect(core.lifecycle).toBe('stopped');
    // Il fatto è registrato come evento durevole: la UI/il main lo vedono.
    expect(transport.of('evt').some((f) => f.event.type === 'system.stopped')).toBe(true);
    for (let i = 0; i < 400 && !exits.includes(0); i++) await new Promise((r) => setTimeout(r, 5));
    expect(exits).toContain(0);
  });

  it('canale degli hook occupato: system.error NON fatale, il core parte comunque', async () => {
    const paths = newPaths();
    const blocker = createHookServer({ address: hookPipeAddress(paths.home), log: memoryLogger().log });
    await blocker.start();
    try {
      const { transport } = boot(paths);
      // Il core è pronto lo stesso (l'hook è un canale accessorio).
      expect(transport.of('ready')).toHaveLength(1);
      for (let i = 0; i < 400; i++) {
        if (transport.of('evt').some((f) => f.event.type === 'system.error')) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      const err = transport.of('evt').map((f) => f.event).find((e) => e.type === 'system.error');
      expect(err?.payload).toMatchObject({ code: 'hooks-unavailable', fatal: false });
      expect(err?.severity).toBe('error');
    } finally {
      await blocker.close();
    }
  });

  it('canale degli hook occupato dal core di prima (18/10/2026): si riprova e, liberato, parte senza errore', async () => {
    const paths = newPaths();
    const blocker = createHookServer({ address: hookPipeAddress(paths.home), log: memoryLogger().log });
    await blocker.start();
    const { core, transport } = boot(paths, { ms: 30, attempts: 100 });
    await new Promise((r) => setTimeout(r, 100));
    await blocker.close();
    // Liberato il pipe, il core lo prende: ci si collega e nessun system.error.
    let connected = false;
    for (let i = 0; i < 200 && !connected; i++) {
      connected = await new Promise<boolean>((resolve) => {
        const c = connect(hookPipeAddress(paths.home), () => { c.destroy(); resolve(true); });
        c.on('error', () => resolve(false));
      });
      if (!connected) await new Promise((r) => setTimeout(r, 10));
    }
    expect(connected).toBe(true);
    expect(transport.of('evt').some((f) => f.event.type === 'system.error')).toBe(false);
    await core.stop('test', 2_000);
  });
});
