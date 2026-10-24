// Contract test con le CLI reali (opt-in: `npm run test:contract`, VISIONE_CONTRACT=1). Non girano in
// `npm test`: usano i motori installati e le credenziali già presenti nell'ambiente dell'utente
// (mai lette né stampate da VISIONE). Costo: un turno breve sull'endpoint NVIDIA già configurato;
// Claude Code viene solo avviato fino all'hook SessionStart e fermato, senza alcun prompt.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterError, createClaudeCodeAdapter, screenText } from '../../src/core/adapters/claude-code/index.ts';
import { createOpencodeAdapter } from '../../src/core/adapters/opencode/index.ts';
import { createHookServer, hookPipeAddress } from '../../src/core/runtime/index.ts';
import type { VisioneEvent } from '../../src/shared/contracts/index.ts';
import { adapterContext, createRuntimeHarness, definition } from '../adapter-harness.ts';
import { memoryLogger } from '../helpers.ts';
import type { RuntimeHarness } from '../runtime-harness.ts';
import { classify, watchConnections, type Connection } from './netwatch.ts';

const ENABLED = process.env.VISIONE_CONTRACT === '1';
const MODEL = process.env.VISIONE_CONTRACT_MODEL ?? 'nvidia/nvidia/nemotron-3-super-120b-a12b';
/** Approvazione esplicita del proprietario per la fiducia di Claude Code (P-39): VISIONE risponde
 *  «sì» leggendo l'opzione selezionata a schermo, senza mai toccare la configurazione di Claude. */
const TRUST_CLAUDE = process.env.VISIONE_CONTRACT_TRUST === '1';
const CLAUDE_WORKSPACE = join(process.env.LOCALAPPDATA ?? tmpdir(), 'VISIONE-contract', 'claude-workspace');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function harness(): RuntimeHarness {
  const h = createRuntimeHarness({ inheritedEnv: process.env, stopGraceMs: 5_000 });
  cleanups.push(() => h.cleanup());
  return h;
}

/** Osserva le connessioni dei processi figli di questo processo di test (pronta prima del turno). */
async function watchChildren(): Promise<() => Promise<Connection[]>> {
  const watch = watchConnections(process.pid);
  cleanups.push(() => void watch.stop());
  await watch.ready;
  return () => watch.stop();
}

function report(title: string, rows: Awaited<ReturnType<typeof classify>>): void {
  const lines = rows.map((r) => `  ${r.verdict.padEnd(8)} ${r.address}:${r.port} ${r.host ?? ''} (pid ${r.pid} ${r.name})`);
  console.log(`${title}\n${lines.length > 0 ? lines.join('\n') : '  nessuna connessione campionata'}`);
}

describe.skipIf(!ENABLED)('contract — motori reali', () => {
  it('OpenCode + NVIDIA: un turno reale attraverso adapter e runtime, eventi e token reali, rete osservata', async () => {
    const h = harness();
    const adapter = createOpencodeAdapter();
    adapter.attach(h.runtime);
    const probe = await adapter.probe({ refresh: true });
    expect(probe.available, probe.problems.join('; ')).toBe(true);
    expect(process.env.NVIDIA_API_KEY ? 'presente' : 'assente', 'NVIDIA_API_KEY nell\'ambiente dell\'utente').toBe('presente');

    const def = definition({ engine: { adapter: 'opencode', model: MODEL } });
    const t = adapterContext(h, def, { correlationId: 'CONTRACT-OPENCODE' });
    await adapter.start(t.ctx);
    const connections = await watchChildren();
    const out = await adapter.sendTurn(t.ctx, { turnId: 'contract-1', taskId: 'task-contract', text: 'Rispondi soltanto con la parola OK.' });
    const seen = await connections();
    await h.idle();

    expect(out, JSON.stringify(out.error)).toMatchObject({ outcome: 'completed', error: null });
    expect(out.engineSessionId).toMatch(/^ses_/);
    const text = t.events.filter((e) => e.kind === 'message.text').map((e) => (e.kind === 'message.text' ? e.text : '')).join('');
    expect(text.toUpperCase()).toContain('OK');
    const usage = t.events.find((e) => e.kind === 'usage' && e.source === 'session');
    expect(usage?.kind === 'usage' && usage.usage.inputTokens).toBeGreaterThan(0);

    // Sul bus: processo del turno con proprietario, poi export della sessione; eventi normalizzati.
    const types = h.events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['process.created', 'process.started', 'process.exited', 'agent.session.started', 'agent.turn.started', 'agent.message.text', 'agent.turn.finished', 'agent.usage.updated']));
    const turn = h.runtime.list().find((p) => p.kind === 'agent-turn');
    expect(turn).toMatchObject({ status: 'exited', owner: { agentId: def.id, taskId: 'task-contract', adapter: 'opencode' } });
    // Nessun segreto negli eventi.
    expect(JSON.stringify(h.events)).not.toContain(process.env.NVIDIA_API_KEY ?? '§');

    // `api.opencode.ai` è traffico proprio della CLI (catalogo/telemetria del fornitore), non di
    // VISIONE: documentato in DECISIONI P-66. Restano inattesi tutti gli altri host esterni.
    const rows = await classify(seen, ['integrate.api.nvidia.com'], ['api.opencode.ai']);
    report('connessioni di OpenCode durante il turno:', rows);
    // L'osservatore funziona (campiona almeno le connessioni locali del motore); un turno breve può
    // chiudere la connessione HTTPS tra due campioni: non è un errore, viene solo riportato.
    expect(seen.length, 'osservatore delle connessioni senza campioni').toBeGreaterThan(0);
    if (!rows.some((r) => r.verdict === 'atteso')) console.log('  (connessione verso NVIDIA non campionata: turno più breve dell\'intervallo)');
    // Proprietà di sicurezza: nessun host esterno diverso dall'endpoint del profilo.
    expect(rows.filter((r) => r.verdict === 'inatteso')).toEqual([]);
    expect(h.runtime.list({ live: true })).toEqual([]);
  }, 180_000);

  it('Claude Code: avvio interattivo reale fino all\'hook SessionStart, senza prompt, poi stop gentile senza orfani', async () => {
    const h = harness();
    const hooks = createHookServer({ address: hookPipeAddress(h.dir), log: memoryLogger('error').log });
    await hooks.start();
    cleanups.push(() => hooks.close());
    const adapter = createClaudeCodeAdapter({ shimDir: join(h.dir, 'runtime', 'shims'), startTimeoutMs: 60_000 });
    adapter.attach(h.runtime);
    const probe = await adapter.probe({ refresh: true });
    expect(probe.available, probe.problems.join('; ')).toBe(true);

    const def = definition({ engine: { adapter: 'claude-code' } });
    const base = adapterContext(h, def, { hooks, correlationId: 'CONTRACT-CLAUDE', ...(TRUST_CLAUDE ? { trustApproved: true } : {}) });
    // Cartella fissa e vuota: la fiducia di Claude Code la conferma il proprietario (a mano una
    // volta sola, oppure con `VISIONE_CONTRACT_TRUST=1`: approvazione esplicita, P-39).
    mkdirSync(CLAUDE_WORKSPACE, { recursive: true });
    h.runtime.policy.allowRoot(CLAUDE_WORKSPACE);
    const t = { ...base, ctx: Object.create(base.ctx, { workspaceDir: { value: CLAUDE_WORKSPACE } }) as typeof base.ctx };
    cleanups.push(() => adapter.stop(t.ctx, 'force', 5_000));
    const connections = await watchChildren();
    let screen = '';
    const sub = h.bus.subscribe((e: VisioneEvent) => {
      if (e.type === 'process.started') {
        h.runtime.get((e.payload as { processId: string }).processId)?.onLine((line) => { screen += line.text; });
      }
    });
    cleanups.push(() => sub.unsubscribe());

    let session;
    try {
      session = await adapter.start(t.ctx);
    } catch (err) {
      if (err instanceof AdapterError && err.error.code === 'trust_required') {
        throw new Error(`Claude Code chiede la fiducia per ${CLAUDE_WORKSPACE}: è una decisione del proprietario, VISIONE non risponde al suo posto. `
          + 'Una tantum: aprire un terminale in quella cartella, eseguire `claude.cmd`, scegliere "Yes, I trust this folder", uscire; '
          + 'oppure lanciare il contract con `VISIONE_CONTRACT_TRUST=1` (approvazione esplicita del proprietario, P-39).');
      }
      console.log(`schermo di Claude Code (coda):\n${screenText(screen).slice(-1500)}`);
      throw err;
    }
    expect(session.engineSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.events[0]).toEqual({ kind: 'session.started', engineSessionId: session.engineSessionId });
    expect(hooks.stats.accepted).toBeGreaterThan(0);
    const proc = h.runtime.list({ live: true }).find((p) => p.kind === 'agent-session');
    const pid = proc?.pid ?? 0;
    expect(pid).toBeGreaterThan(0);

    await adapter.stop(t.ctx, 'graceful', 15_000);
    const seen = await connections();
    await h.idle();
    const ended = h.runtime.list().find((p) => p.kind === 'agent-session');
    expect(ended?.status).toBe('stopped');
    expect(h.runtime.list({ live: true })).toEqual([]);
    expect(alive(pid)).toBe(false);
    expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(['agent.session.started', 'process.stopping', 'process.stopped']));

    // Rete di Claude Code all'avvio: solo osservata e riportata (impostazioni dell'utente).
    report('connessioni di Claude Code all\'avvio:', await classify(seen, ['api.anthropic.com']));
  }, 180_000);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
