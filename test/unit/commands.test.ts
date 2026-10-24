import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createEventBus } from '../../src/core/bus/index.ts';
import { CommandFailure, createCommandRouter, type CommandRouter } from '../../src/core/commands/index.ts';
import { migrate, openDb, type Db } from '../../src/core/db/index.ts';
import { createEventEmitter } from '../../src/core/events/index.ts';
import { createJournal } from '../../src/core/journal/index.ts';
import { createStateStore, recoverState } from '../../src/core/state/index.ts';
import { registerSystemCommands } from '../../src/core/system/index.ts';
import {
  COMMAND_DEFINITIONS,
  type CommandEnvelope,
  type CommandRegistry,
  type VisioneEvent
} from '../../src/shared/contracts/index.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

// Registro di prova: i comandi reali più comandi che esercitano i rami del router.
const TEST_DEFINITIONS: CommandRegistry = {
  ...COMMAND_DEFINITIONS,
  'test.write': { payload: z.strictObject({ value: z.string() }), result: z.strictObject({ n: z.number() }), mutating: true, uiAllowed: false },
  'test.slow': { payload: z.strictObject({}), result: z.strictObject({}), mutating: false, uiAllowed: false, timeoutMs: 50 },
  'test.fail': { payload: z.strictObject({ expected: z.boolean() }), result: z.strictObject({}), mutating: false, uiAllowed: false },
  'test.badresult': { payload: z.strictObject({}), result: z.strictObject({ ok: z.literal(true) }), mutating: false, uiAllowed: false }
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Harness {
  db: Db;
  router: CommandRouter;
  events: VisioneEvent[];
  writes: string[];
  idle: () => Promise<void>;
}

function harness(): Harness {
  const h = tempHome();
  const db = openDb(join(h.dir, 'visione.db'));
  cleanups.push(() => { db.close(); h.cleanup(); });
  migrate(db);
  const journal = createJournal(db);
  const bus = createEventBus();
  const events: VisioneEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const state = createStateStore({
    bootId: ulid(), pid: 1, startedAt: Date.now(), appVersion: 't', coreVersion: 't', dbSchema: 2, quarantined: null,
    recovered: recoverState(journal, null)
  });
  const emitter = createEventEmitter({ db, journal, bus, onCommitted: (evs) => evs.forEach((event) => state.apply({ kind: 'event', event })) });
  const router = createCommandRouter({ db, events: emitter, log: memoryLogger().log, defaultTimeoutMs: 1_000, definitions: TEST_DEFINITIONS });
  registerSystemCommands({ router, journal, state: state.reader, info: { coreVersion: 't', pid: 1, startedAt: Date.now(), schemaVersion: 1 } });
  const writes: string[] = [];
  router.register('test.write' as never, ((p: { value: string }) => { writes.push(p.value); return { n: writes.length }; }) as never);
  router.register('test.slow' as never, ((_p: unknown, ctx: { signal: AbortSignal }) =>
    new Promise((resolve) => { const t = setTimeout(resolve, 5_000); ctx.signal.addEventListener('abort', () => clearTimeout(t)); })) as never);
  router.register('test.fail' as never, ((p: { expected: boolean }) => {
    if (p.expected) throw new CommandFailure('invalid_payload', 'valore rifiutato');
    throw new Error('guasto imprevisto');
  }) as never);
  router.register('test.badresult' as never, (() => ({ ok: false })) as never);
  return { db, router, events, writes, idle: () => bus.idle() };
}

function cmd(type: string, payload: unknown, id = ulid()): CommandEnvelope {
  return { id, type, ts: Date.now(), correlationId: id, issuedBy: 'ui', payload };
}

describe('router dei comandi', () => {
  it('system.ping (comando) → command.accepted → system.pong (evento) → command.completed, tutti correlati', async () => {
    const h = harness();
    const c = cmd('system.ping', { echo: 'ciao' });
    const res = await h.router.dispatch(c);
    expect(res).toMatchObject({ ok: true, id: c.id, correlationId: c.id, replayed: false, data: { pong: true, echo: 'ciao', pid: 1 } });
    await h.idle();
    const chain = h.events.filter((e) => e.correlationId === c.correlationId);
    expect(chain.map((e) => e.type)).toEqual(['command.accepted', 'system.pong', 'command.completed']);
    expect(chain[1]?.payload).toEqual({ echo: 'ciao', pid: 1 });
    expect(chain[2]?.payload).toMatchObject({ commandId: c.id, ok: true, errorCode: null });
    for (const e of chain) {
      expect(e.correlationId).toBe(c.correlationId);
      expect(e.causationId).toBe(c.id);
      expect(e.seq).toBeNull();
    }
  });

  it('envelope non valido → invalid_command', async () => {
    const h = harness();
    expect(await h.router.dispatch({ id: 'x', type: 'system.ping' })).toMatchObject({ ok: false, error: { code: 'invalid_command', retryable: false } });
    expect(await h.router.dispatch(null)).toMatchObject({ ok: false, error: { code: 'invalid_command' } });
  });

  it('comando sconosciuto → unknown_command', async () => {
    const h = harness();
    expect(await h.router.dispatch(cmd('system.format', {}))).toMatchObject({ ok: false, error: { code: 'unknown_command' } });
  });

  it('payload non valido → invalid_payload, evento command.rejected e nessun command.accepted', async () => {
    const h = harness();
    const bad = cmd('system.ping', { echo: 42 });
    expect(await h.router.dispatch(bad)).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
    await h.idle();
    expect(h.events.filter((e) => e.correlationId === bad.id).map((e) => e.type)).toEqual(['command.rejected']);
    expect(await h.router.dispatch(cmd('events.list', { limit: 10_000 }))).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
  });

  it('comando mutante duplicato: eseguito una volta, risposta riprodotta dalla tabella idempotency', async () => {
    const h = harness();
    const c = cmd('test.write', { value: 'a' });
    const first = await h.router.dispatch(c);
    const second = await h.router.dispatch(c);
    expect(first).toMatchObject({ ok: true, data: { n: 1 }, replayed: false });
    expect(second).toMatchObject({ ok: true, data: { n: 1 }, replayed: true });
    expect(h.writes).toEqual(['a']);
    const stored = h.db.prepare('SELECT COUNT(*) AS n FROM idempotency').get();
    expect(stored?.n).toBe(1);
  });

  it('stesso id in volo: una sola esecuzione, stessa risposta', async () => {
    const h = harness();
    const c = cmd('test.write', { value: 'b' });
    const [a, b] = await Promise.all([h.router.dispatch(c), h.router.dispatch(c)]);
    expect(a).toEqual(b);
    expect(h.writes).toEqual(['b']);
  });

  it('timeout: risposta timeout ritentabile e gestore annullato', async () => {
    const h = harness();
    const res = await h.router.dispatch(cmd('test.slow', {}));
    expect(res).toMatchObject({ ok: false, error: { code: 'timeout', retryable: true } });
    expect(h.router.inFlight).toBe(0);
  });

  it('annullamento esplicito di un comando in corso', async () => {
    const h = harness();
    const c = cmd('test.slow', {});
    const pending = h.router.dispatch(c);
    expect(h.router.cancel(c.id, 'richiesto')).toBe(true);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled', message: 'richiesto' } });
    expect(h.router.cancel('inesistente', 'x')).toBe(false);
  });

  it('errori del gestore: attesi con il loro codice, imprevisti come internal', async () => {
    const h = harness();
    expect(await h.router.dispatch(cmd('test.fail', { expected: true }))).toMatchObject({ ok: false, error: { code: 'invalid_payload', message: 'valore rifiutato' } });
    expect(await h.router.dispatch(cmd('test.fail', { expected: false }))).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('un risultato non conforme al contratto non esce dal core', async () => {
    const h = harness();
    expect(await h.router.dispatch(cmd('test.badresult', {}))).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('in chiusura rifiuta i nuovi comandi con shutting_down', async () => {
    const h = harness();
    h.router.close();
    expect(await h.router.dispatch(cmd('system.ping', {}))).toMatchObject({ ok: false, error: { code: 'shutting_down', retryable: true } });
  });

  it('events.list e system.status leggono il journal', async () => {
    const h = harness();
    const status = await h.router.dispatch(cmd('system.status', {}));
    expect(status).toMatchObject({ ok: true, data: { schemaVersion: 1, journal: { lastSeq: 0, count: 0 } } });
    const list = await h.router.dispatch(cmd('events.list', {}));
    expect(list).toMatchObject({ ok: true, data: { events: [], lastSeq: 0 } });
  });

  it('registrare un comando fuori registro o due volte è un errore di programmazione', () => {
    const h = harness();
    expect(() => h.router.register('system.ping', () => ({ pong: true, echo: null, coreTs: 0, pid: 0, uptimeMs: 0 }))).toThrow(/già registrato/);
    expect(() => h.router.register('non.esiste' as never, (() => ({})) as never)).toThrow(/registro/);
  });
});
