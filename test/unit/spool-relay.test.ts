import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMainEventRelay } from '../../src/main/event-relay.ts';
import { createSpool } from '../../src/main/spool.ts';
import { createEvent, type MainToCoreFrameBody, type VisioneEvent } from '../../src/shared/contracts/index.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});
function spoolFile(): string {
  const h = tempHome();
  cleanups.push(h.cleanup);
  return join(h.dir, 'runtime', 'main-events.jsonl');
}

describe('spool degli eventi del main', () => {
  it('sopravvive a un riavvio del main e scarta ciò che il core ha confermato', () => {
    const file = spoolFile();
    const { log } = memoryLogger();
    const a = createEvent('core.stopped', { pid: 3, exitCode: 0, reason: 'app-quit' });
    const b = createEvent('app.shutdown', { reason: 'quit' });
    const first = createSpool(file, log);
    first.add(a);
    first.add(b);
    const second = createSpool(file, log);
    expect(second.list()).toEqual([a, b]);
    second.remove([a.id]);
    expect(createSpool(file, log).list()).toEqual([b]);
  });

  it('scarta righe corrotte o eventi non del main', () => {
    const file = spoolFile();
    const { log, records } = memoryLogger();
    const good = createEvent('app.shutdown', { reason: 'x' });
    createSpool(file, log);
    writeFileSync(file, `${JSON.stringify(good)}\n{rotto\n${JSON.stringify(createEvent('system.stopped', { reason: 'x', uptimeMs: 1 }))}\n`);
    expect(createSpool(file, log).list()).toEqual([good]);
    expect(records.filter((r) => r.level === 'warn')).toHaveLength(2);
  });

  it('ha un limite: oltre, i più vecchi vengono scartati', () => {
    const file = spoolFile();
    const spool = createSpool(file, memoryLogger().log, 3);
    const events = Array.from({ length: 5 }, (_, i) => createEvent('app.shutdown', { reason: `r${i}` }));
    for (const e of events) spool.add(e);
    expect(spool.list()).toEqual(events.slice(2));
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3);
  });
});

describe('relay degli eventi del main', () => {
  it('UI subito, core quando è pronto, spool svuotato solo dopo la conferma', () => {
    const file = spoolFile();
    let ready = false;
    const toCore: MainToCoreFrameBody[] = [];
    const toUi: VisioneEvent[] = [];
    const spool = createSpool(file, memoryLogger().log);
    const relay = createMainEventRelay({
      spool,
      sendToCore: (f) => { if (!ready) return false; toCore.push(f); return true; },
      toRenderer: (e) => toUi.push(e),
      toRendererState: () => undefined,
      log: memoryLogger().log
    });
    const crash = relay.emit('core.crashed', {
      pid: 1, exitCode: 1, reason: 'exit', detail: 'x', stderrTail: '', restartsInWindow: 1, willRestart: true, nextDelayMs: 1_000
    });
    expect(toUi.map((e) => e.id)).toEqual([crash.id]);
    expect(toCore).toEqual([]);
    expect(spool.list()).toHaveLength(1);

    ready = true;
    relay.flush();
    expect(toCore).toEqual([{ kind: 'ingest', events: [crash] }]);
    expect(spool.list()).toHaveLength(1); // non ancora confermato
    relay.onIngested([crash.id]);
    expect(spool.list()).toHaveLength(0);
  });
});
