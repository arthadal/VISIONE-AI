import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RELAY_TIMEOUT_MARGIN_MS, createCommandRelay, parseUiCommand } from '../../src/main/command-relay.ts';
import {
  COMMAND_DEFINITIONS,
  IPC_CHANNELS,
  coreToMainFrameSchema,
  createEvent,
  mainToCoreFrameSchema,
  type CommandEnvelope,
  type CommandRegistry,
  type MainToCoreFrameBody
} from '../../src/shared/contracts/index.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { FakeTimers, memoryLogger } from '../helpers.ts';

function uiCommand(type: string, payload: unknown = {}): Record<string, unknown> {
  const id = ulid();
  return { id, type, ts: Date.now(), correlationId: id, payload };
}

describe('contratto IPC renderer → main', () => {
  it('accetta i comandi consentiti alla UI e imposta issuedBy lato main', () => {
    const raw = uiCommand('system.ping', { echo: 'x' });
    const parsed = parseUiCommand(raw);
    expect(parsed).toEqual({ ok: true, command: { ...raw, issuedBy: 'ui' } });
  });

  it('il renderer non può dichiarare chi invia', () => {
    const parsed = parseUiCommand({ ...uiCommand('system.ping'), issuedBy: 'system' });
    expect(parsed).toMatchObject({ ok: false, response: { error: { code: 'invalid_command' } } });
  });

  it('rifiuta envelope malformati, tipi sconosciuti e tipi non consentiti alla UI', () => {
    expect(parseUiCommand('ping')).toMatchObject({ ok: false, response: { id: 'unknown', error: { code: 'invalid_command' } } });
    expect(parseUiCommand({ ...uiCommand('system.ping'), id: '../../etc' })).toMatchObject({ ok: false, response: { error: { code: 'invalid_command' } } });
    expect(parseUiCommand(uiCommand('process.spawn'))).toMatchObject({ ok: false, response: { error: { code: 'unknown_command' } } });
    const registry: CommandRegistry = {
      ...COMMAND_DEFINITIONS,
      'system.internal': { payload: z.strictObject({}), result: z.strictObject({}), mutating: false, uiAllowed: false }
    };
    expect(parseUiCommand(uiCommand('system.internal'), registry)).toMatchObject({ ok: false, response: { error: { code: 'forbidden' } } });
  });

  it('i canali IPC sono fissi e prefissati', () => {
    for (const ch of Object.values(IPC_CHANNELS)) expect(ch).toMatch(/^visione:/);
  });
});

describe('frame main ↔ core', () => {
  it('valida i frame nei due versi e rifiuta versioni o tipi sconosciuti', () => {
    const command: CommandEnvelope = { ...(uiCommand('system.ping') as Omit<CommandEnvelope, 'issuedBy'>), issuedBy: 'ui' };
    expect(mainToCoreFrameSchema.safeParse({ v: 1, kind: 'cmd', command }).success).toBe(true);
    expect(mainToCoreFrameSchema.safeParse({ v: 2, kind: 'cmd', command }).success).toBe(false);
    expect(mainToCoreFrameSchema.safeParse({ v: 1, kind: 'exec', command: 'calc.exe' }).success).toBe(false);
    expect(mainToCoreFrameSchema.safeParse({ v: 1, kind: 'ingest', events: [createEvent('app.shutdown', { reason: 'x' })] }).success).toBe(true);
    expect(coreToMainFrameSchema.safeParse({ v: 1, kind: 'ready', pid: 1, coreVersion: '1', startupMs: 3 }).success).toBe(true);
    expect(coreToMainFrameSchema.safeParse({ v: 1, kind: 'res', response: { id: 'a', correlationId: 'a', ok: true, data: 1, replayed: false } }).success).toBe(true);
    expect(coreToMainFrameSchema.safeParse({ v: 1, kind: 'res', response: { ok: true } }).success).toBe(false);
  });
});

describe('inoltro dei comandi nel main', () => {
  function relayHarness(ready = true) {
    const timers = new FakeTimers();
    const sent: MainToCoreFrameBody[] = [];
    const relay = createCommandRelay({
      send: (f) => { if (!ready) return false; sent.push(f); return true; },
      defaultTimeoutMs: 30_000,
      log: memoryLogger().log,
      timers
    });
    return { relay, sent, timers };
  }
  const command = (type = 'system.ping'): CommandEnvelope => ({ ...(uiCommand(type) as Omit<CommandEnvelope, 'issuedBy'>), issuedBy: 'ui' });

  it('instrada la risposta del core alla richiesta giusta', async () => {
    const { relay, sent } = relayHarness();
    const c = command();
    const pending = relay.relay(c);
    expect(sent).toEqual([{ kind: 'cmd', command: c }]);
    relay.onResponse({ id: c.id, correlationId: c.id, ok: true, data: { pong: true }, replayed: false });
    expect(await pending).toMatchObject({ ok: true, data: { pong: true } });
    expect(relay.pending).toBe(0);
  });

  it('core non pronto → core_unavailable immediato', async () => {
    const { relay } = relayHarness(false);
    expect(await relay.relay(command())).toMatchObject({ ok: false, error: { code: 'core_unavailable', retryable: true } });
  });

  it('nessuna risposta → timeout e annullamento inviato al core', async () => {
    const { relay, sent, timers } = relayHarness();
    const c = command('system.ping');
    const pending = relay.relay(c);
    timers.advance((COMMAND_DEFINITIONS['system.ping'].timeoutMs ?? 0) + RELAY_TIMEOUT_MARGIN_MS);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(sent.at(-1)).toEqual({ kind: 'cancel', id: c.id, reason: 'timeout' });
  });

  it('il crash del core chiude tutte le attese; i duplicati in volo condividono la risposta', async () => {
    const { relay, sent } = relayHarness();
    const c = command();
    const a = relay.relay(c);
    const b = relay.relay(c);
    expect(sent).toHaveLength(1);
    relay.failAll('core_unavailable', 'core crashed');
    expect(await a).toMatchObject({ ok: false, error: { code: 'core_unavailable' } });
    expect(await b).toEqual(await a);
  });
});
