// Fase 8 nel core completo: terminale come vista (shell del proprietario e sessioni PTY degli agenti,
// adapter `pty-generic`) e impostazioni a runtime. Processi reali della CLI finta (`pty-echo`) nel PTY
// del CLI Runtime; nessun motore reale, nessuna rete.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startCore, type CoreHandle, type CoreTransport } from '../../src/core/kernel/index.ts';
import { FRAME_VERSION, type CommandResponse, type CoreToMainFrameBody, type VisioneEvent, type TerminalSession } from '../../src/shared/contracts/index.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { resolvePaths } from '../../src/shared/node/paths.ts';
import { fakeCliEnv, writeShim } from '../adapter-harness.ts';
import { tempHome } from '../helpers.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const FAKE_CLI = resolve('test/fixtures/fake-cli.mjs');

class Transport implements CoreTransport {
  frames: CoreToMainFrameBody[] = [];
  private handler: ((raw: unknown) => void) | null = null;
  send(frame: CoreToMainFrameBody): void { this.frames.push(frame); }
  onFrame(h: (raw: unknown) => void): void { this.handler = h; }
  onDisconnect(): void { /* non usato */ }
  events(type?: string): VisioneEvent[] {
    return this.frames.flatMap((f) => (f.kind === 'evt' && (!type || f.event.type === type) ? [f.event] : []));
  }
  async command<T = Record<string, unknown>>(type: string, payload: unknown = {}): Promise<CommandResponse<T>> {
    const id = ulid();
    this.handler?.({ v: FRAME_VERSION, kind: 'cmd', command: { id, type, ts: Date.now(), correlationId: id, issuedBy: 'ui', payload } });
    for (let i = 0; i < 3_000; i++) {
      const res = this.frames.find((f) => f.kind === 'res' && f.response.id === id);
      if (res && res.kind === 'res') return res.response as CommandResponse<T>;
      await sleep(10);
    }
    throw new Error(`nessuna risposta a ${type}`);
  }
  async until<T>(probe: () => T | Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
    let v = await probe();
    for (let waited = 0; !ok(v) && waited < ms; waited += 50) {
      await sleep(50);
      v = await probe();
    }
    if (!ok(v)) throw new Error(`condizione non raggiunta: ${JSON.stringify(v).slice(0, 300)}`);
    return v;
  }
}

const cores: CoreHandle[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const c of cores.splice(0)) if (c.lifecycle === 'running') await c.stop('fine test', 9_000);
  while (cleanups.length > 0) cleanups.pop()?.();
});

function boot(opts: { shell?: boolean } = {}) {
  const h = tempHome('visione-term-');
  cleanups.push(h.cleanup);
  const bin = join(h.dir, 'fake-bin');
  writeShim(bin, 'claude', 'test/fixtures/fake-claude.mjs');
  const paths = resolvePaths(join(h.dir, 'home'));
  const t = new Transport();
  const core = startCore({
    transport: t, paths, env: fakeCliEnv(bin, { NVIDIA_API_KEY: 'valore-di-prova' }), pid: 4545, coreVersion: '0.8.0-test', exit: () => undefined, logSinks: [], seedDefaultAgents: false, telemetry: { enabled: false }, offline: { enabled: false },
    ...(opts.shell === false ? { terminalShell: async () => null } : { terminalShell: async () => ({ exe: process.execPath, args: [FAKE_CLI, 'pty-echo'] }) })
  });
  cores.push(core);
  // La shell finta è node: consentita come lo sarebbe la PowerShell trovata dalla discovery.
  core.runtime.policy.allowExecutable(process.execPath);
  return { core, t, paths };
}

const sessions = async (t: Transport): Promise<TerminalSession[]> => ((await t.command<{ sessions: TerminalSession[] }>('terminal.list')) as { data: { sessions: TerminalSession[] } }).data.sessions;
const snapshot = async (t: Transport, processId: string): Promise<string> => {
  const r = await t.command<{ text: string }>('terminal.snapshot', { processId });
  return r.ok ? r.data.text : '';
};

describe('terminale come vista e impostazioni (Fase 8)', () => {
  it('shell del proprietario: apertura, uscita nello scrollback (process.stdout pty), input, resize, chiusura, audit', async () => {
    const { core, t } = boot();
    const opened = await t.command<{ session: TerminalSession }>('terminal.open', { cols: 90, rows: 25 });
    expect(opened).toMatchObject({ ok: true, data: { session: { kind: 'terminal', interactive: true, status: expect.any(String) } } });
    const id = (opened as { data: { session: TerminalSession } }).data.session.processId;
    await t.until(() => snapshot(t, id), (s) => s.includes('pronto tty=true cols=90'));
    expect(await t.command('terminal.input', { processId: id, data: 'ciao\r' })).toMatchObject({ ok: true, data: { bytes: 5 } });
    await t.until(() => snapshot(t, id), (s) => s.includes('ECO:ciao'));
    expect(await t.command('terminal.resize', { processId: id, cols: 120, rows: 40 })).toMatchObject({ ok: true, data: { resized: true } });
    await t.until(() => snapshot(t, id), (s) => s.includes('resize 120x40'));
    // L'uscita passa solo dagli eventi del runtime: nessun evento di terminale con il testo.
    const chunks = t.events('process.stdout').filter((e) => (e.payload as { processId: string }).processId === id);
    expect(chunks.every((e) => (e.payload as { stream: string }).stream === 'pty')).toBe(true);
    const snap = await t.command<{ seq: number; truncated: boolean }>('terminal.snapshot', { processId: id });
    expect(snap).toMatchObject({ ok: true, data: { truncated: false, seq: Math.max(...chunks.map((e) => (e.payload as { seq: number }).seq)) } });
    expect(t.events('terminal.session.opened')[0]?.payload).toMatchObject({ processId: id, by: 'owner:ui' });

    expect(await t.command('terminal.close', { processId: id })).toMatchObject({ ok: true, data: { closed: true } });
    await t.until(() => Promise.resolve(t.events('terminal.session.closed').length), (n) => n === 1);
    expect(await t.command('terminal.close', { processId: id })).toMatchObject({ ok: true, data: { closed: false } });
    expect(await t.command('terminal.input', { processId: id, data: 'x' })).toMatchObject({ ok: false, error: { code: 'operation_failed' } });
    expect((await sessions(t)).find((s) => s.processId === id)?.endedAt).not.toBeNull();
    expect(core.runtime.list({ live: true })).toEqual([]);
    const audit = await t.command<{ entries: Array<{ action: string }> }>('audit.list', { limit: 50 });
    expect((audit as { data: { entries: Array<{ action: string }> } }).data.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['terminal.open', 'terminal.close']));
    expect(await t.command('terminal.snapshot', { processId: 'inesistente' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  }, 60_000);

  it('limite delle shell e shell assente: errori espliciti, nessun processo', async () => {
    const { t } = boot();
    for (let i = 0; i < 4; i++) expect((await t.command('terminal.open', {})).ok).toBe(true);
    expect(await t.command('terminal.open', {})).toMatchObject({ ok: false, error: { code: 'operation_failed', message: expect.stringContaining('già 4 shell') } });
    const other = boot({ shell: false });
    expect(await other.t.command('terminal.open', {})).toMatchObject({ ok: false, error: { code: 'operation_failed', message: expect.stringContaining('nessuna shell') } });
    expect(other.core.runtime.list()).toEqual([]);
  }, 60_000);

  it('pty-generic: CLI scelta dal proprietario nel PTY, turno = testo consegnato, input dalla vista; sessione di Claude Code in sola lettura', async () => {
    const { core, t } = boot();
    const base = { persona: { instructions: 'x', language: 'it' }, permissions: 'read-only', limits: { maxTurnMinutes: 5, maxTurnsPerTask: 10, maxConcurrentTasks: 1 } };
    expect(await t.command('agents.define', { definition: { ...base, id: 'repl', name: 'REPL', role: 'cli locale', competences: ['general'], workspace: { root: 'repl', isolation: 'shared' }, engine: { adapter: 'pty-generic', options: { command: process.execPath, args: [FAKE_CLI, 'pty-echo'] } } } })).toMatchObject({ ok: true });
    expect(await t.command('agents.define', { definition: { ...base, id: 'senza', name: 'X', role: 'x', competences: ['general'], workspace: { root: 'x', isolation: 'shared' }, engine: { adapter: 'pty-generic', options: { command: 'nome con spazi' } } } })).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
    expect(await t.command('agents.define', { definition: { ...base, id: 'revisore', name: 'R', role: 'rivede', competences: ['review'], workspace: { root: 'revisore', isolation: 'shared' }, engine: { adapter: 'claude-code' } } })).toMatchObject({ ok: true });
    const submit = await t.command<{ rootTaskId: string }>('director.submit', { goal: 'g', plan: { steps: [
      { key: 'a', title: 'Saluta', spec: 'Scrivi saluti', agentId: 'repl' },
      { key: 'b', title: 'Rivedi', spec: 'Rivedi.\nRISPOSTA:ok.', agentId: 'revisore', dependsOn: ['a'] }
    ] } });
    const root = (submit as { data: { rootTaskId: string } }).data.rootTaskId;
    await t.until(() => Promise.resolve(t.events('director.summary').filter((e) => (e.payload as { rootTaskId: string }).rootTaskId === root).length), (n) => n === 1, 60_000);
    const tree = await t.command<{ children: Array<{ status: string; result: { summary: string } | null }> }>('tasks.get', { taskId: root });
    expect((tree as { data: { children: Array<{ status: string; result: { summary: string } | null }> } }).data.children[0]).toMatchObject({ status: 'succeeded', result: { summary: expect.stringContaining('testo consegnato alla CLI') } });

    const list = await sessions(t);
    const repl = list.find((s) => s.owner.agentId === 'repl');
    const claude = list.find((s) => s.owner.agentId === 'revisore');
    expect(repl).toMatchObject({ kind: 'agent-session', interactive: true, title: 'agente repl', owner: { adapter: 'pty-generic' } });
    expect(claude).toMatchObject({ kind: 'agent-session', interactive: false });
    // Il brief arriva alla CLI come righe digitate; l'eco lo dimostra.
    await t.until(() => snapshot(t, repl?.processId as string), (s) => s.includes('ECO:Compito: Saluta'));
    expect(await t.command('terminal.input', { processId: repl?.processId, data: 'a mano\r' })).toMatchObject({ ok: true });
    await t.until(() => snapshot(t, repl?.processId as string), (s) => s.includes('ECO:a mano'));
    expect(await t.command('terminal.input', { processId: claude?.processId, data: 'x' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    // 17/10/2026: il ridimensionamento non è input — vale anche in sola lettura (TUI disegnata per la finestra vera).
    expect(await t.command('terminal.resize', { processId: claude?.processId, cols: 80, rows: 20 })).toMatchObject({ ok: true, data: { resized: true } });
    expect((await snapshot(t, claude?.processId as string)).length).toBeGreaterThan(0);
    // P-94: il × della vista chiude anche le sessioni degli agenti. La chiusura passa dall'Agent
    // Manager: l'agente arriva a `stopped`, il suo processo non resta vivo e la sessione è terminata
    // (niente «crash» e nessun processo orfano).
    expect(await t.command('terminal.close', { processId: claude?.processId })).toMatchObject({ ok: true, data: { closed: true } });
    await t.until(() => Promise.resolve(core.runtime.list({ live: true, agentId: 'revisore' }).length), (n) => n === 0);
    await t.until(async () => (await sessions(t)).find((s) => s.processId === claude?.processId)?.endedAt ?? null, (v) => v !== null);
    expect(await t.command('agents.list', {})).toMatchObject({ ok: true, data: { agents: expect.arrayContaining([expect.objectContaining({ definition: expect.objectContaining({ id: 'revisore' }), instance: expect.objectContaining({ status: 'stopped' }) })]) } });
    expect(await t.command('agents.stop', { agentId: 'revisore' })).toMatchObject({ ok: true, data: { stopped: false } });
    // Lo stop dell'agente ferma anche la sua CLI (Ctrl+C gentile).
    expect(await t.command('agents.stop', { agentId: 'repl', mode: 'graceful' })).toMatchObject({ ok: true, data: { stopped: true } });
    await t.until(() => Promise.resolve(core.runtime.list({ live: true, agentId: 'repl' }).length), (n) => n === 0);
  }, 90_000);

  it('impostazioni: lettura, scrittura validata e atomica, audit, evento; segreti, versione e valori non validi rifiutati', async () => {
    const { t, paths } = boot();
    const got = await t.command<{ config: { director: { maxAttempts: number } }; source: string; restartRequired: boolean }>('config.get');
    expect(got).toMatchObject({ ok: true, data: { source: 'file', restartRequired: false, config: { version: 1, director: { maxAttempts: 2 } } } });
    const up = await t.command('config.update', { patch: { director: { maxAttempts: 3 }, memory: { searchLimit: 4 } } });
    expect(up).toMatchObject({ ok: true, data: { changed: ['director.maxAttempts', 'memory.searchLimit'], restartRequired: true } });
    const file = JSON.parse(readFileSync(paths.configFile, 'utf8')) as { director: { maxAttempts: number; taskTimeoutMs: number } };
    expect(file.director).toMatchObject({ maxAttempts: 3, taskTimeoutMs: 900_000 });
    expect(t.events('system.config.changed')[0]?.payload).toEqual({ changed: ['director.maxAttempts', 'memory.searchLimit'], by: 'owner:ui', restartRequired: true });
    expect(await t.command('config.get')).toMatchObject({ ok: true, data: { restartRequired: true, config: { director: { maxAttempts: 3 } } } });
    // Nessun cambiamento: nessun evento.
    expect(await t.command('config.update', { patch: { director: { maxAttempts: 3 } } })).toMatchObject({ ok: true, data: { changed: [] } });
    expect(t.events('system.config.changed')).toHaveLength(1);
    for (const patch of [{ director: { maxAttempts: 99 } }, { version: 2 }, { logging: { level: `nvapi-${'k'.repeat(24)}` } }, { inventata: true }]) {
      expect(await t.command('config.update', { patch })).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
    }
    expect(readFileSync(paths.configFile, 'utf8')).not.toContain('nvapi-');
    const audit = await t.command<{ entries: Array<{ action: string; detail: string }> }>('audit.list', { limit: 20 });
    expect((audit as { data: { entries: Array<{ action: string; detail: string }> } }).data.entries.find((e) => e.action === 'config.update')?.detail).toBe('director.maxAttempts, memory.searchLimit');
  }, 30_000);
});
