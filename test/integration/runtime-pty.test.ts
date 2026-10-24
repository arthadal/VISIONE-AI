// Modalità PTY del CLI Runtime (node-pty / ConPTY reale) con la CLI finta interattiva.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeHarness, type RuntimeHarness } from '../runtime-harness.ts';

const harnesses: RuntimeHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

describe('processi in PTY', () => {
  it('terminale reale: TTY, eco dell\'ingresso, resize, Ctrl+C come stop gentile → stopped', async () => {
    const h = createRuntimeHarness();
    harnesses.push(h);
    const started = h.runtime.start(h.spec(['pty-echo'], { io: 'pty', pty: { cols: 90, rows: 25 } }));
    if (!started.ok) throw new Error(started.error.message);
    const p = started.process;
    let screen = '';
    p.onLine((chunk, stream) => {
      expect(stream).toBe('pty');
      screen += chunk.text;
    });
    await vi.waitFor(() => expect(screen).toContain('pronto tty=true cols=90'), { timeout: 10_000 });
    expect(p.write('ciao')).toEqual({ ok: true });
    await vi.waitFor(() => expect(screen).toContain('ECO:ciao'), { timeout: 5_000 });
    expect(p.resize(100, 40)).toEqual({ ok: true });
    await vi.waitFor(() => expect(screen).toContain('resize 100x40'), { timeout: 5_000 });
    const out = await p.stop({ reason: 'chiusura gentile', graceMs: 5_000 });
    expect(out).toMatchObject({ ok: true, result: { status: 'stopped' } });
    expect(screen).toContain('ctrl-c ricevuto');
    await h.idle();
    expect(h.events.some((e) => e.type === 'process.stdout' && (e.payload as { stream: string }).stream === 'pty')).toBe(true);
  }, 30_000);

  it('uscita da sola con codice ≠ 0 dal PTY → failed; resize su pipe → invalid_spec', async () => {
    const h = createRuntimeHarness();
    harnesses.push(h);
    const started = h.runtime.start(h.spec(['pty-echo'], { io: 'pty' }));
    if (!started.ok) throw new Error(started.error.message);
    let screen = '';
    started.process.onLine((c) => { screen += c.text; });
    await vi.waitFor(() => expect(screen).toContain('pronto'), { timeout: 10_000 });
    started.process.write('quit');
    expect(await started.process.done).toMatchObject({ status: 'failed', exitCode: 7, error: { code: 'exit_nonzero' } });
    const pipes = h.runtime.start(h.spec(['sleep', '5000']));
    if (!pipes.ok) throw new Error('avvio');
    expect(pipes.process.resize(80, 20)).toMatchObject({ ok: false, error: { code: 'invalid_spec' } });
  }, 30_000);

  it('PTY non disponibile (modulo nativo assente) → failed con pty_unavailable, il core prosegue', async () => {
    const h = createRuntimeHarness({ loadPty: () => Promise.reject(new Error('modulo nativo assente')) });
    harnesses.push(h);
    const r = await h.runtime.run(h.spec(['pty-echo'], { io: 'pty' }));
    expect(r.ok && r.output.result).toMatchObject({ status: 'failed', error: { code: 'pty_unavailable' } });
    expect((await h.runtime.run(h.spec(['both']))).ok).toBe(true);
  });
});
