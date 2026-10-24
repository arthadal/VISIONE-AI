// Stato verso la UI: instradamento nel main (state.changed sul canale dello stato, mai su quello
// degli eventi), API IPC dello stato, proiezione del renderer (snapshot più recente, sola lettura).
import { describe, expect, it } from 'vitest';
import { parseUiCommand } from '../../src/main/command-relay.ts';
import { createMainEventRelay } from '../../src/main/event-relay.ts';
import { createSpool } from '../../src/main/spool.ts';
import { coreStateIsLive, initialState, isNewerState, reduce } from '../../src/renderer/state/projection.ts';
import { createStateStore } from '../../src/core/state/index.ts';
import {
  IPC_CHANNELS,
  createEvent,
  type CoreStateSnapshot,
  type VisioneEvent,
  type SupervisorSnapshot
} from '../../src/shared/contracts/index.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { join } from 'node:path';
import { memoryLogger, tempHome } from '../helpers.ts';

function snapshot(opts: { bootAt?: number; pid?: number; changes?: number; db?: 'ok' | 'degraded' } = {}): CoreStateSnapshot {
  const store = createStateStore({
    bootId: ulid(opts.bootAt ?? 1_000), pid: opts.pid ?? 7, startedAt: opts.bootAt ?? 1_000, appVersion: '0.4.0', coreVersion: '0.4.0',
    dbSchema: 2, quarantined: null,
    recovered: { previousRun: null, applicationRunning: false, lastEvent: null, lastError: null, journalLastSeq: 0, journalCount: 0 }
  }, { now: () => 5_000 });
  for (let i = 0; i < (opts.changes ?? 0); i++) store.apply({ kind: 'invalid-frame' });
  if (opts.db === 'degraded') store.apply({ kind: 'journal', status: 'degraded', pending: 1, lastError: 'x', lastSeq: null, flushed: 0 });
  return store.snapshot();
}

const sup = (state: SupervisorSnapshot['state'], pid: number | null): SupervisorSnapshot => ({
  state, since: 1, pid, appVersion: '0.4.0', restartsInWindow: 0, totalRestarts: 0, nextRestartAt: null, lastExit: null
});

describe('API IPC dello stato', () => {
  it('state.get, events.list ed events.get sono consentiti alla UI; nessun comando di scrittura dello stato', () => {
    for (const [type, payload] of [['state.get', {}], ['events.list', { limit: 5, correlationId: 'CORR00000001' }], ['events.get', { id: 'x' }]] as const) {
      const id = ulid();
      expect(parseUiCommand({ id, type, ts: 1, correlationId: id, payload }).ok, type).toBe(true);
    }
    const id = ulid();
    expect(parseUiCommand({ id, type: 'state.set', ts: 1, correlationId: id, payload: {} })).toMatchObject({ ok: false, response: { error: { code: 'unknown_command' } } });
    expect(IPC_CHANNELS.statePush).toBe('visione:state');
  });

  it('il main instrada state.changed sul canale dello stato e gli altri eventi su quello degli eventi', () => {
    const h = tempHome();
    try {
      const toUi: VisioneEvent[] = [];
      const toState: CoreStateSnapshot[] = [];
      const relay = createMainEventRelay({
        spool: createSpool(join(h.dir, 'spool.jsonl'), memoryLogger().log),
        sendToCore: () => true,
        toRenderer: (e) => toUi.push(e),
        toRendererState: (s) => toState.push(s),
        log: memoryLogger().log
      });
      const snap = snapshot();
      relay.forwardCoreEvent(createEvent('state.changed', { snapshot: snap, changed: ['core'] }));
      relay.forwardCoreEvent(createEvent('system.pong', { echo: null, pid: 1 }));
      expect(toState).toEqual([snap]);
      expect(toUi.map((e) => e.type)).toEqual(['system.pong']);
    } finally {
      h.cleanup();
    }
  });
});

describe('proiezione dello stato nel renderer', () => {
  it('tiene lo snapshot più recente: revisione per lo stesso avvio, nuovo avvio sempre accettato', () => {
    const r0 = snapshot();
    const r2 = { ...r0, revision: 2 };
    const r1 = { ...r0, revision: 1 };
    expect(isNewerState(null, r0)).toBe(true);
    expect(isNewerState(r2, r1)).toBe(false); // fuori ordine: scartato
    expect(isNewerState(r1, r2)).toBe(true);
    const nextBoot = snapshot({ bootAt: 9_000 });
    expect(isNewerState(r2, nextBoot)).toBe(true); // nuovo core: revision ripartita da 0
    expect(isNewerState(nextBoot, r2)).toBe(false);

    let s = reduce(initialState, { type: 'state', snapshot: r2 });
    s = reduce(s, { type: 'state', snapshot: r1 });
    expect(s.core?.revision).toBe(2);
  });

  it('il ritorno del journal da degraded a ok chiede una risincronizzazione', () => {
    let s = reduce(initialState, { type: 'state', snapshot: snapshot({ db: 'degraded' }) });
    expect(s.needsResync).toBe(false);
    const ok = { ...snapshot({ changes: 3 }) };
    s = reduce(s, { type: 'state', snapshot: { ...ok, bootId: s.core?.bootId ?? ok.bootId } });
    expect(s.needsResync).toBe(true);
  });

  it('lo stato è "vivo" solo se viene dal processo core attuale', () => {
    let s = reduce(initialState, { type: 'state', snapshot: snapshot({ pid: 7 }) });
    s = reduce(s, { type: 'supervisor', snapshot: sup('ready', 7) });
    expect(coreStateIsLive(s)).toBe(true);
    s = reduce(s, { type: 'supervisor', snapshot: sup('crashed', null) });
    expect(coreStateIsLive(s)).toBe(false);
    expect(s.core?.core.pid).toBe(7); // l'ultimo noto resta visibile, marcato come tale
  });

  it('la proiezione non modifica lo snapshot ricevuto (congelato dal core, copiato via IPC)', () => {
    const snap = snapshot();
    const s = reduce(initialState, { type: 'state', snapshot: snap });
    expect(s.core).toBe(snap);
    expect(Object.isFrozen(s.core)).toBe(true);
  });
});
