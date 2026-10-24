// CLI Runtime con processi reali innocui (node + CLI finta): ciclo di vita, I/O, terminazione,
// errori strutturati, eventi sul bus della Fase 4, journal e registro persistente.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchPath, type ProcessTools } from '../../src/core/runtime/index.ts';
import { createProcessTools } from '../../src/core/runtime/index.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { createRuntimeHarness, NODE, type RuntimeHarness } from '../runtime-harness.ts';

const harnesses: RuntimeHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});
function harness(extra?: Parameters<typeof createRuntimeHarness>[0]): RuntimeHarness {
  const h = createRuntimeHarness(extra);
  harnesses.push(h);
  return h;
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('avvio, uscita e I/O', () => {
  it('start: stdout e stderr separati, uscita 0 → exited, eventi in ordine con correlazione', async () => {
    const h = harness();
    const spec = h.spec(['both'], { owner: { agentId: 'director', sessionId: 'ses-1', taskId: 'task-9', adapter: 'prova' } });
    const r = await h.runtime.run(spec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output.result).toMatchObject({ status: 'exited', exitCode: 0, error: null });
    expect(r.output.stdout).toBe('riga-out-1\nriga-out-2\n');
    expect(r.output.stderr).toBe('riga-err-1\n');
    await h.idle();
    const mine = h.events.filter((e) => e.correlationId === spec.correlationId);
    const types = mine.map((e) => e.type);
    expect(types[0]).toBe('process.created');
    expect(types.indexOf('process.starting')).toBeLessThan(types.indexOf('process.started'));
    expect(types.at(-1)).toBe('process.exited');
    expect(types).toEqual(expect.arrayContaining(['process.stdout', 'process.stderr']));
    // proprietari distinti: agente, sessione, task, adapter
    expect(mine.find((e) => e.type === 'process.started')?.payload).toMatchObject({ owner: { agentId: 'director', sessionId: 'ses-1', taskId: 'task-9', adapter: 'prova' } });
    expect(mine.every((e) => e.target?.kind === 'process' && e.target.id === r.output.result.processId)).toBe(true);
  });

  it('exit code diverso da 0 → failed con errore exit_nonzero e coda dello stderr', async () => {
    const h = harness();
    const r = await h.runtime.run(h.spec(['exit', '3']));
    expect(r.ok && r.output.result).toMatchObject({ status: 'failed', exitCode: 3, error: { code: 'exit_nonzero' }, tail: 'esco con 3' });
  });

  it('crash (abort nativo) → crashed, distinto da un errore applicativo', async () => {
    const h = harness();
    const r = await h.runtime.run(h.spec(['abort']));
    expect(r.ok && r.output.result).toMatchObject({ status: 'crashed', error: { code: 'crashed' } });
    await h.idle();
    expect(h.events.some((e) => e.type === 'process.crashed' && e.severity === 'error')).toBe(true);
  });

  it('comando inesistente, cartella inesistente, script .cmd → failed con codici distinti, nessuna eccezione', async () => {
    const h = harness();
    const missingExe = join(h.dir, 'workspace', 'non-esiste.exe');
    h.runtime.policy.allowExecutable(missingExe);
    const a = await h.runtime.run({ ...h.spec([]), exe: missingExe, args: [] });
    expect(a.ok && a.output.result).toMatchObject({ status: 'failed', pid: null, error: { code: 'not_found' } });
    const b = await h.runtime.run(h.spec(['both'], { cwd: join(h.workspace, 'manca') }));
    expect(b.ok && b.output.result).toMatchObject({ status: 'failed', error: { code: 'cwd_missing' } });
    const cmd = join(h.dir, 'workspace', 'shim.cmd');
    h.runtime.policy.allowExecutable(cmd);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(cmd, '@echo off\r\n');
    const c = await h.runtime.run({ ...h.spec([]), exe: cmd, args: [] });
    expect(c.ok && c.output.result).toMatchObject({ status: 'failed', error: { code: 'invalid_spec' } });
  });

  it('working directory e ambiente controllati: cwd reale, PWD = cwd, variabili del core rimosse', async () => {
    const h = harness();
    const env = h.runtime.env(h.workspace, { visione: { VISIONE_AGENT_ID: 'director' }, adapter: { MIA_VAR: 'valore' } });
    const r = await h.runtime.run(h.spec(['echo-env', 'VISIONE_AGENT_ID', 'MIA_VAR', 'NODE_OPTIONS', 'VISIONE_HOME'], { env }));
    const out = r.ok ? JSON.parse(r.output.stdout) as { cwd: string; pwd: string; env: Record<string, string | null> } : null;
    expect(out?.cwd.toLowerCase()).toBe(h.workspace.toLowerCase());
    expect(out?.pwd).toBe(h.workspace);
    expect(out?.env).toEqual({ VISIONE_AGENT_ID: 'director', MIA_VAR: 'valore', NODE_OPTIONS: null, VISIONE_HOME: null });
  });

  it('argomenti come array senza shell: spazi, virgolette, a-capo e metacaratteri arrivano intatti', async () => {
    const h = harness();
    const args = ['con spazi', 'virgolette "doppie"', 'riga1\nriga2', '& | > < ^ %PATH% $HOME', ''];
    const r = await h.runtime.run(h.spec(['argv', ...args]));
    expect(r.ok && JSON.parse(r.output.stdout)).toEqual(args);
  });

  it('nessuna perdita di output: 20.000 righe, UTF-8 spezzato tra blocchi, ultima riga senza a-capo, riga lunghissima', async () => {
    const h = harness();
    const many = await h.runtime.run(h.spec(['lines', '20000']));
    expect(many.ok && many.output.stdout.split('\n').filter(Boolean).length).toBe(20_000);
    const utf = await h.runtime.run(h.spec(['split-utf8']));
    expect(utf.ok && utf.output.stdout).toBe('città €\nultima riga\n');
    const long = await h.runtime.run(h.spec(['long-line', '300000']));
    expect(long.ok && long.output.stdout).toBe('x'.repeat(300_000) + '\nfine\n');
    await h.idle();
    // Sul bus l'uscita arriva a blocchi ≤ 16 KiB con seq per processo senza buchi.
    const pid = long.ok ? long.output.result.processId : '';
    const out = h.events.filter((e) => e.type === 'process.stdout' && (e.payload as { processId: string }).processId === pid).map((e) => e.payload as { seq: number; text: string });
    expect(out.map((o) => o.seq)).toEqual(out.map((_, i) => i + 1));
    expect(out.map((o) => o.text).join('')).toBe('x'.repeat(300_000) + '\nfine\n');
    expect(out.every((o) => o.text.length <= 16_384)).toBe(true);
  });

  it('stdin: scrittura, evento process.input senza contenuto, chiusura → il processo esce', async () => {
    const h = harness();
    const started = h.runtime.start(h.spec(['echo-stdin'], { stdin: 'pipe' }));
    if (!started.ok) throw new Error(started.error.message);
    const p = started.process;
    const lines: string[] = [];
    p.onLine((l) => lines.push(l.text));
    await vi.waitFor(() => expect(p.status).toBe('running'));
    expect(p.write('ciao\n')).toEqual({ ok: true });
    await vi.waitFor(() => expect(lines).toContain('eco:ciao'));
    expect(p.closeInput()).toEqual({ ok: true });
    const r = await p.done;
    expect(r.status).toBe('exited');
    expect(lines).toEqual(['eco:ciao', 'stdin chiuso']);
    expect(p.write('dopo\n')).toMatchObject({ ok: false, error: { code: 'not_running' } });
    await h.idle();
    const input = h.events.find((e) => e.type === 'process.input');
    expect(input?.payload).toEqual({ processId: p.id, bytes: 5 });
  });

  it('stdin non aperto → stdin_closed', async () => {
    const h = harness();
    const started = h.runtime.start(h.spec(['sleep', '5000']));
    if (!started.ok) throw new Error('avvio');
    await vi.waitFor(() => expect(started.process.status).toBe('running'));
    expect(started.process.write('x')).toMatchObject({ ok: false, error: { code: 'stdin_closed' } });
  });
});

describe('terminazione', () => {
  it('stop ordinato: stdin chiuso → uscita entro la grazia → stopped; doppio stop idempotente', async () => {
    const h = harness();
    const started = h.runtime.start(h.spec(['echo-stdin'], { stdin: 'pipe' }));
    if (!started.ok) throw new Error('avvio');
    const p = started.process;
    await vi.waitFor(() => expect(p.status).toBe('running'));
    const [first, second] = await Promise.all([p.stop({ reason: 'fine lavoro' }), p.stop()]);
    expect(first).toMatchObject({ ok: true, alreadyFinished: false, result: { status: 'stopped', error: null } });
    expect(second).toEqual(first);
    const third = await h.runtime.stop(p.id);
    expect(third).toMatchObject({ ok: true, alreadyFinished: true, result: { status: 'stopped' } });
    await h.idle();
    const stopping = h.events.find((e) => e.type === 'process.stopping');
    expect(stopping?.payload).toMatchObject({ intent: 'stop', mode: 'graceful', reason: 'fine lavoro' });
    expect(h.events.filter((e) => e.type === 'process.stopped')).toHaveLength(1);
  });

  it('processo che ignora la richiesta gentile: dopo la grazia kill dell\'albero, anche dei figli', async () => {
    const h = harness();
    const started = h.runtime.start(h.spec(['spawn-child'], { stdin: 'pipe', stopGraceMs: 300 }));
    if (!started.ok) throw new Error('avvio');
    const p = started.process;
    let childPid = 0;
    p.onLine((l) => {
      const m = /^figlio (\d+)/.exec(l.text);
      if (m) childPid = Number(m[1]);
    });
    await vi.waitFor(() => expect(childPid).toBeGreaterThan(0));
    expect(alive(childPid)).toBe(true);
    const out = await p.stop({ reason: 'test albero' });
    expect(out).toMatchObject({ ok: true, result: { status: 'stopped' } });
    await vi.waitFor(() => expect(alive(childPid)).toBe(false), { timeout: 5_000 });
  });

  it('stop forzato: kill immediato senza grazia', async () => {
    const h = harness();
    const started = h.runtime.start(h.spec(['ignore-eof'], { stdin: 'pipe' }));
    if (!started.ok) throw new Error('avvio');
    await vi.waitFor(() => expect(started.process.status).toBe('running'));
    const t0 = Date.now();
    const out = await started.process.stop({ mode: 'force' });
    expect(out).toMatchObject({ ok: true, result: { status: 'stopped' } });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('timeout di avvio (nessun segnale) e di durata → timed_out con errore timeout', async () => {
    const h = harness();
    const a = await h.runtime.run(h.spec(['silent-sleep', '30000'], { startTimeoutMs: 300 }));
    expect(a.ok && a.output.result).toMatchObject({ status: 'timed_out', error: { code: 'timeout' } });
    const b = await h.runtime.run(h.spec(['sleep', '30000'], { runTimeoutMs: 400, stopGraceMs: 200 }));
    expect(b.ok && b.output.result).toMatchObject({ status: 'timed_out', error: { code: 'timeout' } });
    await h.idle();
    expect(h.events.filter((e) => e.type === 'process.timeout')).toHaveLength(2);
  });

  it('cancellazione con AbortSignal: in esecuzione e ancora in coda', async () => {
    const h = harness();
    const ctrl = new AbortController();
    // Il primo non dà segnali di vita: il secondo resta in coda (created) per `queueHoldMs`.
    const running = h.runtime.start(h.spec(['silent-sleep', '30000'], { signal: ctrl.signal, queueKey: 'motore' }));
    const queued = h.runtime.start(h.spec(['sleep', '30000'], { signal: ctrl.signal, queueKey: 'motore' }));
    if (!running.ok || !queued.ok) throw new Error('avvio');
    await vi.waitFor(() => expect(running.process.status).toBe('running'));
    expect(queued.process.status).toBe('created');
    ctrl.abort('richiesta dell\'utente');
    const [r1, r2] = await Promise.all([running.process.done, queued.process.done]);
    expect(r1).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
    expect(r2).toMatchObject({ status: 'cancelled', pid: null });
  });

  it('processo già terminato: stop restituisce l\'esito senza errori; id sconosciuto → unknown_process', async () => {
    const h = harness();
    const r = await h.runtime.run(h.spec(['both']));
    const id = r.ok ? r.output.result.processId : '';
    expect(await h.runtime.stop(id)).toMatchObject({ ok: true, alreadyFinished: true, result: { status: 'exited' } });
    expect(await h.runtime.stop('inesistente')).toMatchObject({ ok: false, error: { code: 'unknown_process' } });
  });

  it('processo non raggiungibile: il kill non lo termina → errore unreachable, nessuna attesa infinita', async () => {
    const tools: ProcessTools = { killTree: async () => false, inspect: async () => new Map() };
    const h = harness({ tools, killWaitMs: 300 });
    const started = h.runtime.start(h.spec(['sleep', '30000'], { gracefulStop: 'none' }));
    if (!started.ok) throw new Error('avvio');
    await vi.waitFor(() => expect(started.process.status).toBe('running'));
    const pid = started.process.pid as number;
    try {
      const out = await started.process.stop({ mode: 'force' });
      expect(out).toMatchObject({ ok: false, error: { code: 'unreachable' } });
      expect(started.process.status).toBe('stopping'); // nessuno stato inventato: l'esito arriverà con l'uscita
    } finally {
      await createProcessTools().killTree(pid);
    }
    expect(await started.process.done).toMatchObject({ status: 'stopped' });
  });
});

describe('policy, coda, limite, riavvii', () => {
  it('la policy rifiuta eseguibili e cartelle non consentiti e righe di comando troppo lunghe (nessun processo, nessun evento)', async () => {
    const h = harness();
    const notAllowed = h.runtime.start({ ...h.spec([]), exe: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'echo'] });
    expect(notAllowed).toMatchObject({ ok: false, error: { code: 'policy_denied' } });
    const outside = h.runtime.start(h.spec(['both'], { cwd: h.dir }));
    expect(outside).toMatchObject({ ok: false, error: { code: 'policy_denied' } });
    const relative = h.runtime.start({ ...h.spec([]), exe: 'node' });
    expect(relative).toMatchObject({ ok: false, error: { code: 'invalid_spec' } });
    const huge = h.runtime.start(h.spec(['argv', 'x'.repeat(40_000)]));
    expect(huge).toMatchObject({ ok: false, error: { code: 'invalid_spec' } });
    await h.idle();
    expect(h.events.filter((e) => e.type.startsWith('process.'))).toEqual([]);
  });

  it('coda di avvio per chiave: il secondo parte dopo il primo segnale di vita del primo', async () => {
    const h = harness();
    const a = h.runtime.start(h.spec(['sleep', '2000'], { queueKey: 'motore-condiviso' }));
    const b = h.runtime.start(h.spec(['both'], { queueKey: 'motore-condiviso' }));
    if (!a.ok || !b.ok) throw new Error('avvio');
    const rb = await b.process.done;
    expect(rb.status).toBe('exited');
    await h.idle();
    const startedA = h.events.find((e) => e.type === 'process.started' && (e.payload as { processId: string }).processId === a.process.id);
    const startingB = h.events.find((e) => e.type === 'process.starting' && (e.payload as { processId: string }).processId === b.process.id);
    expect(startedA && startingB && startingB.ts >= startedA.ts).toBe(true);
    expect((startingB?.payload as { waitedMs: number }).waitedMs).toBeGreaterThan(0);
  });

  it('limite di processi attivi → queue_full', async () => {
    const h = harness({ maxProcesses: 1 });
    const a = h.runtime.start(h.spec(['sleep', '5000']));
    expect(a.ok).toBe(true);
    expect(h.runtime.start(h.spec(['both']))).toMatchObject({ ok: false, error: { code: 'queue_full', retryable: true } });
  });

  it('riavvio controllato: solo sui crash, budget limitato, poi restart_limit (nessun ciclo infinito)', async () => {
    const h = harness();
    const sup = h.runtime.supervise(() => h.spec(['abort']), { maxRestarts: 2, windowMs: 60_000, backoffMs: [10, 20] });
    const end = await sup.done;
    expect(end).toMatchObject({ restarts: 2, error: { code: 'restart_limit' }, last: { status: 'crashed' } });
    await h.idle();
    const restarting = h.events.filter((e) => e.type === 'process.restarting').map((e) => e.payload as { attempt: number; restartOf: string; processId: string });
    expect(restarting.map((r) => r.attempt)).toEqual([1, 2]);
    const created = h.events.filter((e) => e.type === 'process.created').map((e) => e.payload as { processId: string; restartOf: string | null });
    expect(created).toHaveLength(3);
    expect(created[1]?.restartOf).toBe(created[0]?.processId);
    expect(created[2]?.restartOf).toBe(created[1]?.processId);
    // Un'uscita pulita non provoca riavvii.
    const ok = await h.runtime.supervise(() => h.spec(['both']), { maxRestarts: 3, windowMs: 1_000, backoffMs: [0] }).done;
    expect(ok).toMatchObject({ restarts: 0, error: null, last: { status: 'exited' } });
  });

  it('stop della supervisione: ferma il processo e i riavvii futuri', async () => {
    const h = harness();
    const sup = h.runtime.supervise(() => h.spec(['sleep', '30000'], { stdin: 'pipe' }), { maxRestarts: 5, windowMs: 60_000, backoffMs: [0] });
    await vi.waitFor(() => expect(sup.current?.status).toBe('running'));
    await sup.stop('basta');
    expect(await sup.done).toMatchObject({ restarts: 0, last: { status: 'stopped' } });
  });
});

describe('registro, journal e riconciliazione', () => {
  it('eventi durevoli nel journal e riga nel registro con agente, sessione e task distinti', async () => {
    const h = harness();
    const spec = h.spec(['both'], { owner: { agentId: 'a1', sessionId: 's1', taskId: 't1' } });
    const r = await h.runtime.run(spec);
    const id = r.ok ? r.output.result.processId : '';
    const journal = h.journal.read({ afterSeq: 0, limit: 100, correlationId: spec.correlationId }).map((e) => e.type);
    expect(journal).toEqual(['process.created', 'process.started', 'process.exited']); // gli effimeri non vanno nel journal
    const rec = h.runtime.history(10).find((x) => x.id === id);
    expect(rec).toMatchObject({ status: 'exited', agentId: 'a1', sessionId: 's1', taskId: 't1', exe: 'node.exe'.replace(/\.exe$/, process.platform === 'win32' ? '.exe' : '') });
    expect(rec?.endedAt).not.toBeNull();
    expect(h.runtime.list({ agentId: 'a1' }).map((p) => p.id)).toEqual([id]);
    expect(h.runtime.list({ agentId: 'altro' })).toEqual([]);
  });

  it('riconciliazione dopo una caduta del core: orfano vivo ucciso, pid riusato lasciato stare, sparito chiuso', async () => {
    const h = harness();
    const { spawn } = await import('node:child_process');
    const orphan = spawn(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise((r) => orphan.once('spawn', r));
    const now = Date.now();
    const insert = h.db.prepare(`INSERT INTO processes (id, pid, kind, io, status, exe, cwd, correlation_id, created_at, started_at)
      VALUES (?, ?, 'agent-turn', 'pipes', ?, ?, ?, ?, ?, ?)`);
    const ids = { orfano: ulid(), riusato: ulid(), sparito: ulid() };
    insert.run(ids.orfano, orphan.pid ?? 0, 'running', 'node.exe', h.workspace, 'c1', now, now);
    insert.run(ids.riusato, process.pid, 'running', 'node.exe', h.workspace, 'c2', now - 3_600_000, now - 3_600_000);
    insert.run(ids.sparito, 999_999, 'starting', 'node.exe', h.workspace, 'c3', now, null);
    const report = await h.runtime.reconcile();
    const byId = Object.fromEntries(report.outcomes.map((o) => [o.processId, o.outcome]));
    expect(byId).toEqual({ [ids.orfano]: 'killed', [ids.riusato]: 'pid-reused', [ids.sparito]: 'gone' });
    await vi.waitFor(() => expect(alive(orphan.pid ?? 0)).toBe(false));
    expect(alive(process.pid)).toBe(true);
    expect(h.runtime.history(10).filter((r) => Object.values(ids).includes(r.id)).every((r) => r.status === 'lost')).toBe(true);
    await h.idle();
    expect(h.events.filter((e) => e.type === 'process.reconciled')).toHaveLength(3);
    expect((await h.runtime.reconcile()).checked).toBe(0);
  });

  it('processo di un avvio precedente: stop → not_running', async () => {
    const h = harness();
    h.db.prepare(`INSERT INTO processes (id, pid, kind, io, status, exe, cwd, correlation_id, created_at, ended_at)
      VALUES ('vecchio', 1, 'probe', 'pipes', 'exited', 'x', 'y', 'c', 1, 2)`).run();
    expect(await h.runtime.stop('vecchio')).toMatchObject({ ok: false, error: { code: 'not_running' } });
  });

  it('discovery: CLI trovata nel PATH con versione, CLI assente → risultato strutturato', async () => {
    const h = harness();
    const found = await h.runtime.discovery.discover('node');
    expect(found).toMatchObject({ found: true, kind: 'exe', version: process.version });
    const missing = await h.runtime.discovery.discover('cli-che-non-esiste-visione');
    expect(missing).toMatchObject({ found: false, name: 'cli-che-non-esiste-visione' });
    expect(await h.runtime.discovery.discover('nome con spazi')).toMatchObject({ found: false, problem: 'nome di comando non valido' });
    const rows = h.db.prepare('SELECT name, status FROM cli_installations ORDER BY name').all();
    expect(rows).toEqual(expect.arrayContaining([{ name: 'node', status: 'found' }, { name: 'cli-che-non-esiste-visione', status: 'missing' }]));
    expect(existsSync(found.found ? found.exe : '')).toBe(true);
  });

  it("discovery: vince l'ordine delle cartelle del PATH (come where); nella stessa cartella .exe prima di .cmd", () => {
    const h = harness();
    const [first, second] = [join(h.dir, 'primo'), join(h.dir, 'secondo')];
    for (const d of [first, second]) mkdirSync(d, { recursive: true });
    writeFileSync(join(first, 'strumento.cmd'), '');
    writeFileSync(join(second, 'strumento.exe'), '');
    writeFileSync(join(second, 'strumento.cmd'), '');
    expect(searchPath('strumento', { Path: `${first};${second}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32'))
      .toEqual([join(first, 'strumento.cmd'), join(second, 'strumento.exe'), join(second, 'strumento.cmd')]);
  });
});
