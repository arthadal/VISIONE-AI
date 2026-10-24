// Contract test della Fase 7 con il motore reale (opt-in: `npm run test:contract`, VISIONE_CONTRACT=1).
// Due agenti OpenCode/NVIDIA nello stesso obiettivo: il primo dichiara un fatto con la riga
// `MEMORIA:` del protocollo (P-43), il secondo lo riceve nel brief composto dal Context Builder e lo
// usa. Costo: due turni brevissimi sul provider già configurato; nessun turno di Claude Code.
// Credenziali mai lette né stampate da VISIONE.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { startCore, type CoreHandle, type CoreTransport } from '../../src/core/kernel/index.ts';
import { FRAME_VERSION, type CommandResponse, type CoreToMainFrameBody, type MemoryItem, type VisioneEvent, type Task } from '../../src/shared/contracts/index.ts';
import { containsSecret } from '../../src/shared/lib/redact.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { resolvePaths } from '../../src/shared/node/paths.ts';
import { tempHome } from '../helpers.ts';

const ENABLED = process.env.VISIONE_CONTRACT === '1';
const MODEL = process.env.VISIONE_CONTRACT_MODEL ?? 'nvidia/nvidia/nemotron-3-super-120b-a12b';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class Transport implements CoreTransport {
  frames: CoreToMainFrameBody[] = [];
  private handler: ((raw: unknown) => void) | null = null;
  send(frame: CoreToMainFrameBody): void { this.frames.push(frame); }
  onFrame(h: (raw: unknown) => void): void { this.handler = h; }
  onDisconnect(): void { /* non usato */ }
  events(): VisioneEvent[] {
    return this.frames.flatMap((f) => (f.kind === 'evt' ? [f.event] : []));
  }
  async command<T>(type: string, payload: unknown): Promise<CommandResponse<T>> {
    const id = ulid();
    this.handler?.({ v: FRAME_VERSION, kind: 'cmd', command: { id, type, ts: Date.now(), correlationId: id, issuedBy: 'ui', payload } });
    for (let i = 0; i < 3_000; i++) {
      const res = this.frames.find((f) => f.kind === 'res' && f.response.id === id);
      if (res && res.kind === 'res') return res.response as CommandResponse<T>;
      await sleep(10);
    }
    throw new Error(`nessuna risposta a ${type}`);
  }
}

const cores: CoreHandle[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const c of cores.splice(0)) if (c.lifecycle === 'running') await c.stop('fine contract', 15_000);
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe.skipIf(!ENABLED)('contract — memoria con il motore reale', () => {
  it('OpenCode/NVIDIA dichiara un fatto (MEMORIA:) → memoria del task → brief di un altro agente OpenCode → risposta che lo usa', async () => {
    const home = tempHome('visione-contract7-');
    cleanups.push(home.cleanup);
    const t = new Transport();
    const core = startCore({ transport: t, paths: resolvePaths(home.dir), env: process.env, pid: process.pid, coreVersion: '0.7.0-contract', exit: () => undefined, logSinks: [], seedDefaultAgents: false, telemetry: { enabled: false }, offline: { enabled: false } });
    cores.push(core);
    const agent = (id: string) => ({
      id, name: id, role: id, competences: ['general'], engine: { adapter: 'opencode', model: MODEL },
      persona: { instructions: 'Rispondi in italiano, in modo brevissimo, senza usare strumenti.', language: 'it' }, permissions: 'read-only',
      workspace: { root: id, isolation: 'shared' }, limits: { maxTurnMinutes: 3, maxTurnsPerTask: 2, maxConcurrentTasks: 1 }
    });
    expect(await t.command('agents.define', { definition: agent('scrittore') })).toMatchObject({ ok: true });
    expect(await t.command('agents.define', { definition: agent('lettore') })).toMatchObject({ ok: true });

    const submit = await t.command<{ rootTaskId: string }>('director.submit', {
      goal: 'Prova di contratto della Fase 7', title: 'Contratto Fase 7',
      plan: { steps: [
        { key: 's', title: 'Scegli il codice', agentId: 'scrittore', maxAttempts: 1, spec: [
          'Inventa un codice di tre lettere maiuscole seguite da tre cifre (diverso da ABC123).',
          'Rispondi con due righe e nient\'altro:',
          'Fatto.',
          'MEMORIA: il codice del progetto Orione è <il codice inventato>'
        ].join('\n') },
        { key: 'l', title: 'Leggi il codice', agentId: 'lettore', dependsOn: ['s'], maxAttempts: 1, spec: 'Qual è il codice del progetto Orione? Rispondi soltanto con il codice.' }
      ] }
    });
    expect(submit.ok).toBe(true);
    const { rootTaskId } = (submit as { data: { rootTaskId: string } }).data;
    let summary: VisioneEvent | undefined;
    for (let waited = 0; waited < 300_000 && !summary; waited += 500) {
      summary = t.events().find((e) => e.type === 'director.summary' && (e.payload as { rootTaskId: string }).rootTaskId === rootTaskId);
      if (!summary) await sleep(500);
    }
    const tree = await t.command<{ task: Task; children: Task[] }>('tasks.get', { taskId: rootTaskId });
    const children = (tree as { data: { children: Task[] } }).data.children;
    console.log('esiti:', JSON.stringify(children.map((c) => ({ title: c.title, status: c.status, result: c.result?.summary ?? null, error: c.error }))));
    expect(summary?.payload).toMatchObject({ outcome: 'succeeded' });

    // Il fatto è nella memoria del task dello scrittore, estratto dal testo reale di OpenCode.
    const found = await t.command<{ items: MemoryItem[] }>('memory.search', { query: 'codice progetto Orione' });
    const fact = (found as { data: { items: MemoryItem[] } }).data.items.find((m) => m.origin === 'turn');
    console.log('fatto:', JSON.stringify(fact));
    expect(fact).toMatchObject({ scope: 'task', scopeId: children[0]?.id, source: 'agent:scrittore' });
    const code = /[A-Z]{3}\d{3}/.exec(fact?.content ?? '')?.[0];
    expect(code, 'codice nel fatto').toBeDefined();
    // Il brief del lettore (allegato al turno reale) contiene il fatto nella memoria pertinente.
    const built = t.events().filter((e) => e.type === 'memory.context.built').map((e) => e.payload as { agentId: string; file: string });
    const brief = readFileSync(built.find((b) => b.agentId === 'lettore')?.file as string, 'utf8');
    expect(brief).toMatch(new RegExp(`## Memoria pertinente[^#]*${code}`));
    expect(children[1]?.result?.summary, 'risposta del lettore').toContain(code as string);

    for (const e of t.events()) expect(containsSecret(JSON.stringify(e.payload)), e.type).toBe(false);
    await core.stop('fine contract', 15_000);
    expect(core.runtime.list({ live: true })).toEqual([]);
  }, 360_000);
});
