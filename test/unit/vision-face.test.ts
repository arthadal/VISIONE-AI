// Volto nella webcam (11/10/2026, widget Umanoide): servizio del core col rilevatore di Windows.
// Unità con un processo finto (protocollo, «non supportato», tempi, spegnimento a riposo) e una prova
// col PowerShell vero su Windows (fotogramma vuoto: nessun volto, risposta rapida).
import { afterEach, describe, expect, it } from 'vitest';
import { COMMAND_DEFINITIONS } from '../../src/shared/contracts/index.ts';
import { createFaceService, FACE_SCRIPT, parseFaces, type LineProcess } from '../../src/core/vision/index.ts';

function fakeProcess(reply: (req: { id: number; w: number; h: number; gray: string }) => unknown, ready: unknown = { ready: true }) {
  const lines: Array<(l: string) => void> = [];
  const exits: Array<(r: string) => void> = [];
  const state = { killed: false, written: 0 };
  const proc: LineProcess = {
    write: (line) => {
      state.written++;
      const req = JSON.parse(line) as { id: number; w: number; h: number; gray: string };
      const out = reply(req);
      if (out !== undefined) queueMicrotask(() => lines.forEach((h) => h(JSON.stringify(out))));
    },
    onLine: (h) => {
      lines.push(h);
      if (lines.length === 1) queueMicrotask(() => lines.forEach((x) => x(JSON.stringify(ready))));
    },
    onExit: (h) => exits.push(h),
    kill: () => {
      state.killed = true;
      exits.forEach((h) => h('ucciso'));
    }
  };
  return { proc, state };
}

const services: Array<{ close(): void }> = [];
afterEach(() => services.splice(0).forEach((s) => s.close()));

describe('volto nella webcam: servizio del core', () => {
  it('il contratto è silenzioso, piccolo e solo per il widget: fotogramma al più 160×120 in grigio', () => {
    const def = COMMAND_DEFINITIONS['vision.face'];
    expect(def.quiet).toBe(true);
    expect(def.mutating).toBe(false);
    expect(def.payload.safeParse({ width: 160, height: 120, gray: 'AAAA' }).success).toBe(true);
    expect(def.payload.safeParse({ width: 640, height: 480, gray: 'AAAA' }).success).toBe(false);
    expect(def.payload.safeParse({ width: 160, height: 120, gray: 'non base64!' }).success).toBe(false);
  });

  it('lo script rispetta i vincoli della riga di comando (niente virgolette doppie, backtick, ${ o barre rovesciate)', () => {
    expect(FACE_SCRIPT).not.toMatch(/["`\\]|\$\{/);
  });

  it('volti letti a gruppi di quattro numeri; valori strani scartati', () => {
    expect(parseFaces([10, 20, 30, 40, 1, 2, 3, 4])).toEqual([{ x: 10, y: 20, w: 30, h: 40 }, { x: 1, y: 2, w: 3, h: 4 }]);
    expect(parseFaces([])).toEqual([]);
    expect(parseFaces(null)).toEqual([]);
    expect(parseFaces([1, 2, 3])).toEqual([]);
    expect(parseFaces([1, 2, -3, 4])).toEqual([]);
    expect(parseFaces(Array.from({ length: 40 }, (_, i) => i)).length).toBe(5);
  });

  it('un fotogramma → la risposta del rilevatore; il processo parte una volta sola', async () => {
    let starts = 0;
    const fake = fakeProcess((req) => ({ id: req.id, ok: true, faces: [40, 30, 50, 60] }));
    const svc = createFaceService({ start: () => (starts++, fake.proc) });
    services.push(svc);
    const a = await svc.detect(160, 120, 'AAAA');
    const b = await svc.detect(160, 120, 'AAAA');
    expect(a.faces).toEqual([{ x: 40, y: 30, w: 50, h: 60 }]);
    expect(b.faces.length).toBe(1);
    expect(starts).toBe(1);
  });

  it('Windows senza rilevatore: errore chiaro, e non si riprova a ogni fotogramma', async () => {
    let starts = 0;
    const fake = fakeProcess(() => undefined, { ready: false, error: 'rilevatore di volti non supportato da questo Windows' });
    const svc = createFaceService({ start: () => (starts++, fake.proc) });
    services.push(svc);
    await expect(svc.detect(160, 120, 'AAAA')).rejects.toThrow(/non supportato/);
    await expect(svc.detect(160, 120, 'AAAA')).rejects.toThrow(/non supportato/);
    expect(starts).toBe(1);
  });

  it('risposta che non arriva: errore a tempo; a riposo il PowerShell si spegne', async () => {
    const fake = fakeProcess(() => undefined);
    const svc = createFaceService({ start: () => fake.proc, timeoutMs: 30, idleMs: 60 });
    services.push(svc);
    await expect(svc.detect(160, 120, 'AAAA')).rejects.toThrow(/in tempo/);
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.state.killed).toBe(true);
  });
});

describe('volto nella webcam: avvio bloccato (collaudo del 11/10/2026)', () => {
  it('un PowerShell che non dice mai «pronto» si chiude dopo il limite e al fotogramma dopo se ne avvia un altro', async () => {
    const procs: Array<ReturnType<typeof fakeProcess>> = [];
    const svc = createFaceService({
      start: () => {
        const f = procs.length === 0 ? fakeProcess(() => undefined, null) : fakeProcess((req) => ({ id: req.id, ok: true, faces: [] }));
        procs.push(f);
        return f.proc;
      },
      startMs: 40
    });
    services.push(svc);
    await expect(svc.detect(160, 120, 'AAAA')).rejects.toThrow(/non si è avviato/);
    expect(procs[0]?.state.killed).toBe(true);
    await expect(svc.detect(160, 120, 'AAAA')).resolves.toMatchObject({ faces: [] });
    expect(procs.length).toBe(2);
  });
});

describe.runIf(process.platform === 'win32')('volto nella webcam: il rilevatore di Windows vero', () => {
  it('fotogramma vuoto: nessun volto, risposta in tempo utile', async () => {
    const svc = createFaceService();
    services.push(svc);
    const gray = Buffer.alloc(160 * 120, 90).toString('base64');
    const first = await svc.detect(160, 120, gray);
    expect(first.faces).toEqual([]);
    const t0 = Date.now();
    const second = await svc.detect(160, 120, gray);
    expect(second.faces).toEqual([]);
    // Il primo avvia PowerShell; dal secondo è il tempo di un fotogramma.
    expect(Date.now() - t0).toBeLessThan(1_000);
  }, 30_000);
});
