import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../../src/core/bus/index.ts';
import {
  EVENT_DEFINITIONS,
  createEvent,
  isEvent,
  parseEvent,
  visioneEventSchema,
  type VisioneEvent
} from '../../src/shared/contracts/index.ts';

const ping = () => createEvent('command.accepted', { commandId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', type: 'system.ping', issuedBy: 'ui' });

describe('contratto degli eventi', () => {
  it('createEvent compila l\'envelope dal registro', () => {
    const e = createEvent('core.started', { pid: 42, attempt: 0 }, { now: 1_700_000_000_000 });
    expect(visioneEventSchema.parse(e)).toEqual(e);
    expect(e).toMatchObject({
      seq: null, ts: 1_700_000_000_000, type: 'core.started', category: 'system', durability: 'durable',
      source: { kind: 'system', id: 'main' }, target: null, causationId: null, severity: 'info', schema: 1
    });
    expect(e.correlationId).toBe(e.id);
    expect(isEvent(e, 'core.started') && e.payload.pid).toBe(42);
  });

  it('rifiuta payload non conformi', () => {
    // @ts-expect-error payload incompleto apposta
    expect(() => createEvent('core.started', { pid: 1 })).toThrow();
    // @ts-expect-error campo in pi√π apposta
    expect(() => createEvent('app.shutdown', { reason: 'x', extra: 1 })).toThrow();
  });

  it('ogni tipo registrato ha categoria valida e origine main o core', () => {
    for (const [type, def] of Object.entries(EVENT_DEFINITIONS)) {
      expect(type).toMatch(/^[a-z]+(\.[a-z]+)+$/);
      expect(['main', 'core']).toContain(def.origin);
      if (type.startsWith('app.') || type.startsWith('core.')) expect(def.origin).toBe('main');
      if (['system.', 'command.', 'state.'].some((p) => type.startsWith(p))) expect(def.origin).toBe('core');
    }
    expect(EVENT_DEFINITIONS['command.accepted'].durability).toBe('ephemeral');
    expect(EVENT_DEFINITIONS['core.crashed'].durability).toBe('durable');
  });

  it('parseEvent valida envelope, tipo, coerenza col registro, payload e origine', () => {
    const good = createEvent('app.started', { appVersion: '1', electronVersion: '44', pid: 1 });
    expect(parseEvent(JSON.parse(JSON.stringify(good)), 'main')).toEqual({ ok: true, event: good });
    expect(parseEvent(good, 'core')).toMatchObject({ ok: false, problem: expect.stringMatching(/non può provenire/) });
    expect(parseEvent({ ...good, type: 'app.unknown' })).toMatchObject({ ok: false, problem: expect.stringMatching(/non registrato/) });
    expect(parseEvent({ ...good, durability: 'ephemeral' })).toMatchObject({ ok: false });
    expect(parseEvent({ ...good, payload: { pid: 'x' } })).toMatchObject({ ok: false });
    expect(parseEvent({ ...good, id: 'non-ulid' })).toMatchObject({ ok: false });
    expect(parseEvent('stringa')).toMatchObject({ ok: false });
  });
});

describe('Event Bus', () => {
  it('consegna in modo asincrono e in ordine a tutti i sottoscrittori', async () => {
    const bus = createEventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe((e) => a.push(e.id));
    bus.subscribe((e) => b.push(e.id));
    const events = [ping(), ping(), ping()];
    for (const e of events) bus.publish(e);
    expect(a).toEqual([]); // nessuna consegna sincrona
    await bus.idle();
    expect(a).toEqual(events.map((e) => e.id));
    expect(b).toEqual(a);
  });

  it('applica i filtri e smette di consegnare dopo unsubscribe', async () => {
    const bus = createEventBus();
    const got: VisioneEvent[] = [];
    const sub = bus.subscribe((e) => got.push(e), { filter: (e) => e.durability === 'durable' });
    bus.publish(ping());
    bus.publish(createEvent('app.shutdown', { reason: 'test' }));
    await bus.idle();
    expect(got.map((e) => e.type)).toEqual(['app.shutdown']);
    sub.unsubscribe();
    bus.publish(createEvent('app.shutdown', { reason: 'dopo' }));
    await bus.idle();
    expect(got).toHaveLength(1);
  });

  it('isola gli errori dei sottoscrittori', async () => {
    const onListenerError = vi.fn();
    const bus = createEventBus({ onListenerError });
    const got: string[] = [];
    bus.subscribe(() => { throw new Error('rotto'); });
    bus.subscribe((e) => got.push(e.type));
    bus.publish(ping());
    await bus.idle();
    expect(got).toEqual(['command.accepted']);
    expect(onListenerError).toHaveBeenCalledOnce();
  });

  it('coda limitata: oltre il limite scarta e conta', async () => {
    const onOverflow = vi.fn();
    const bus = createEventBus({ onOverflow });
    const got: string[] = [];
    const sub = bus.subscribe((e) => got.push(e.id), { maxQueue: 2 });
    for (let i = 0; i < 5; i++) bus.publish(ping());
    await bus.idle();
    expect(got).toHaveLength(2);
    expect(sub.dropped).toBe(3);
    // L'avviso di overflow è limitato (anti tempesta di log): uno per episodio; il totale resta nello stato.
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(bus.stats().dropped).toBe(3);
  });

  it('troppi sottoscrittori attivi: avviso di probabile perdita, una sola volta', () => {
    const onLeakWarning = vi.fn();
    const bus = createEventBus({ onLeakWarning, maxSubscribers: 2 });
    const subs = [bus.subscribe(() => undefined), bus.subscribe(() => undefined), bus.subscribe(() => undefined), bus.subscribe(() => undefined)];
    expect(onLeakWarning).toHaveBeenCalledTimes(1);
    expect(onLeakWarning).toHaveBeenCalledWith(3);
    for (const s of subs) s.unsubscribe();
    expect(bus.stats().subscribers).toBe(0);
    bus.close();
  });

  it('un evento pubblicato da un sottoscrittore viene consegnato', async () => {
    const bus = createEventBus();
    const got: string[] = [];
    bus.subscribe((e) => {
      got.push(e.type);
      if (e.type === 'command.accepted') bus.publish(createEvent('app.shutdown', { reason: 'catena' }));
    });
    bus.publish(ping());
    await bus.idle();
    expect(got).toEqual(['command.accepted', 'app.shutdown']);
  });
});