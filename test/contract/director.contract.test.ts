// Contract test della Fase 6 con i motori reali (opt-in: `npm run test:contract`, VISIONE_CONTRACT=1).
// Un obiettivo con due passi: OpenCode/NVIDIA produce, Claude Code (account dell'utente, PTY, hook)
// rivede dopo. Tutto passa da comandi → Director → Task Engine → Agent Manager → adapter → CLI
// Runtime. Costo: due turni brevissimi. Claude Code lavora solo nella cartella di test la cui
// fiducia il proprietario ha già confermato (P-36). Credenziali mai lette né stampate da VISIONE.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startCore, type CoreHandle, type CoreTransport } from '../../src/core/kernel/index.ts';
import { FRAME_VERSION, type CommandResponse, type CoreToMainFrameBody, type VisioneEvent, type Task } from '../../src/shared/contracts/index.ts';
import { containsSecret } from '../../src/shared/lib/redact.ts';
import { ulid } from '../../src/shared/lib/ulid.ts';
import { resolvePaths } from '../../src/shared/node/paths.ts';
import { tempHome } from '../helpers.ts';

/** Testo leggibile dello schermo: sequenze di controllo tolte, spazi compressi. */
function screenWords(raw: string): string {
  let out = '';
  for (let k = 0; k < raw.length; k++) {
    const c = raw.charCodeAt(k);
    if (c === 27) {
      // salta la sequenza fino alla lettera finale
      k++;
      while (k < raw.length && !/[A-Za-z~]/.test(raw[k] ?? '')) k++;
      out += ' ';
      continue;
    }
    if (c >= 32) out += raw[k];
  }
  return out.replace(/ +/g, ' ');
}

const ENABLED = process.env.VISIONE_CONTRACT === '1';
const MODEL = process.env.VISIONE_CONTRACT_MODEL ?? 'nvidia/nvidia/nemotron-3-super-120b-a12b';
const CLAUDE_WORKSPACE = join(process.env.LOCALAPPDATA ?? tmpdir(), 'VISIONE-contract', 'claude-workspace');
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

describe.skipIf(!ENABLED)('contract — Director con motori reali', () => {
  it('obiettivo → OpenCode/NVIDIA produce → Claude Code rivede: risultati reali, eventi senza segreti, nessun orfano', async () => {
    const home = tempHome('visione-contract6-');
    cleanups.push(home.cleanup);
    const t = new Transport();
    const core = startCore({ transport: t, paths: resolvePaths(home.dir), env: process.env, pid: process.pid, coreVersion: '0.6.0-contract', exit: () => undefined, logSinks: [], seedDefaultAgents: false, telemetry: { enabled: false }, offline: { enabled: false } });
    cores.push(core);
    const base = { persona: { instructions: 'Rispondi in italiano, in modo brevissimo.', language: 'it' }, permissions: 'read-only', limits: { maxTurnMinutes: 3, maxTurnsPerTask: 2, maxConcurrentTasks: 1 } };
    expect(await t.command('agents.define', { definition: { ...base, id: 'esecutore', name: 'Esecutore', role: 'produce', competences: ['code'], engine: { adapter: 'opencode', model: MODEL }, workspace: { root: 'esecutore', isolation: 'shared' } } })).toMatchObject({ ok: true });
    expect(await t.command('agents.define', { definition: { ...base, id: 'revisore', name: 'Revisore', role: 'rivede', competences: ['review'], engine: { adapter: 'claude-code', model: process.env.VISIONE_CONTRACT_CLAUDE_MODEL ?? 'haiku' }, workspace: { root: CLAUDE_WORKSPACE, isolation: 'shared' } } })).toMatchObject({ ok: true });

    const submit = await t.command<{ rootTaskId: string; correlationId: string }>('director.submit', {
      goal: 'Prova di contratto della Fase 6', title: 'Contratto Fase 6',
      plan: { steps: [
        { key: 'p', title: 'Produci', spec: 'Rispondi soltanto con la parola OK.', agentId: 'esecutore', maxAttempts: 1 },
        { key: 'r', title: 'Rivedi', spec: 'Senza usare strumenti, rispondi soltanto con la parola VISTO.', competence: 'review', dependsOn: ['p'], maxAttempts: 1 }
      ] }
    });
    expect(submit.ok).toBe(true);
    const { rootTaskId } = (submit as { data: { rootTaskId: string } }).data;
    // Diagnosi: schermo del PTY di Claude Code (senza ANSI) raccolto dal runtime.
    let screen = '';
    let attached = false;
    let summary: VisioneEvent | undefined;
    for (let waited = 0; waited < 150_000 && !summary; waited += 500) {
      if (!attached) {
        const p = core.runtime.list({ live: true }).find((x) => x.kind === 'agent-session');
        const proc = p ? core.runtime.get(p.id) : undefined;
        if (proc) {
          attached = true;
          proc.onLine((l) => { screen = (screen + ' ' + screenWords(l.text)).slice(-6_000); });
        }
      }
      summary = t.events().find((e) => e.type === 'director.summary' && (e.payload as { rootTaskId: string }).rootTaskId === rootTaskId);
      if (!summary) await sleep(500);
    }
    const tree = await t.command<{ task: Task; children: Task[] }>('tasks.get', { taskId: rootTaskId });
    const children = (tree as { data: { children: Task[] } }).data.children;
    if (!summary) console.log('SCHERMO:', screen.replace(/\s+/g, ' ').slice(-2_500));
    if (!summary) console.log('EVENTI revisore:', JSON.stringify(t.events().filter((e) => JSON.stringify(e.payload).includes('revisore') || e.source.id === 'revisore').map((e) => e.type)));
    console.log('esiti:', JSON.stringify(children.map((c) => ({ title: c.title, status: c.status, agent: c.assigneeAgentId, result: c.result?.summary ?? null, error: c.error }))));
    expect(summary?.payload).toMatchObject({ outcome: 'succeeded' });
    expect(children[0]?.result?.summary).toMatch(/OK/i);
    // Il testo finale di Claude Code arriva dall'hook Stop (`last_assistant_message`, P-38).
    expect(children[1]?.result?.summary, 'testo finale di Claude Code dall\'hook Stop').toMatch(/VISTO/i);
    const thread = t.events().filter((e) => e.correlationId === (submit as { data: { correlationId: string } }).data.correlationId);
    expect(thread.some((e) => e.type === 'agent.turn.finished' && (e.payload as { agentId: string }).agentId === 'revisore')).toBe(true);
    for (const e of t.events()) expect(containsSecret(JSON.stringify(e.payload)), e.type).toBe(false);
    await core.stop('fine contract', 15_000);
    expect(core.runtime.list({ live: true })).toEqual([]);
  }, 360_000);
});
