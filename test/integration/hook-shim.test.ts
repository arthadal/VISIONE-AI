// Shim degli hook con il server reale (named pipe / socket) e node vero: payload troppo grandi ridotti senza
// perdere i campi della policy, e PreToolUse fail-closed quando la policy è attiva e VISIONE non risponde.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHookServer, ensureHookShim, hookPipeAddress, type HookHandler, type HookServer } from '../../src/core/runtime/hookpipe.ts';
import { memoryLogger, tempHome } from '../helpers.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Setup { readonly home: string; readonly address: string; readonly shim: string; readonly server: HookServer }

async function setup(opts: { start?: boolean; responseTimeoutMs?: number } = {}): Promise<Setup> {
  const t = tempHome('visione-shim-');
  cleanups.push(t.cleanup);
  mkdirSync(join(t.dir, 'runtime'), { recursive: true }); // il socket Unix fuori da Windows vive lì
  const address = hookPipeAddress(t.dir);
  const server = createHookServer({ address, log: memoryLogger('error').log, ...(opts.responseTimeoutMs !== undefined ? { responseTimeoutMs: opts.responseTimeoutMs } : {}) });
  if (opts.start !== false) {
    await server.start();
    cleanups.push(() => server.close());
  }
  return { home: t.dir, address, shim: ensureHookShim(join(t.dir, 'runtime', 'shims')), server };
}

/** Esegue lo shim come farebbe Claude Code: JSON su stdin, risposta (facoltativa) su stdout. */
function runShim(s: Setup, event: string, payload: unknown, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [s.shim, event], {
      env: { ...process.env, VISIONE_HOOK_PIPE: s.address, VISIONE_HOOK_TIMEOUT_MS: '3000', ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`shim uscito con ${code}`))));
    child.stdin.end(JSON.stringify(payload));
  });
}

const denied = (out: string): boolean => (JSON.parse(out) as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision === 'deny';

describe('shim degli hook', () => {
  it('payload troppo grande: restano nome dello strumento e percorso, il contenuto voluminoso si toglie', async () => {
    const s = await setup();
    const seen: unknown[] = [];
    const handler: HookHandler = (req) => { seen.push(req.payload); return null; };
    const token = s.server.register('a1', handler);
    const out = await runShim(s, 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: 'C:\\Windows\\System32\\x.dll', content: 'x'.repeat(300_000) } }, {
      VISIONE_AGENT_ID: 'a1', VISIONE_AGENT_TOKEN: token, VISIONE_HOOK_FAIL_CLOSED: '1'
    });
    expect(out).toBe('');
    expect(seen).toEqual([{ truncated: true, tool_name: 'Write', tool_input: { file_path: 'C:\\Windows\\System32\\x.dll' } }]);
  }, 20_000);

  it('la decisione di VISIONE arriva al motore così com\'è', async () => {
    const s = await setup();
    const token = s.server.register('a1', () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } }));
    const out = await runShim(s, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.txt' } }, { VISIONE_AGENT_ID: 'a1', VISIONE_AGENT_TOKEN: token });
    expect(denied(out)).toBe(true);
  }, 20_000);

  it('policy attiva: senza VISIONE, con un token sbagliato o un gestore lento PreToolUse è negato', async () => {
    const down = await setup({ start: false });
    const out = await runShim(down, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo ciao' } }, {
      VISIONE_AGENT_ID: 'a1', VISIONE_AGENT_TOKEN: 'qualunque', VISIONE_HOOK_FAIL_CLOSED: '1'
    });
    expect(denied(out)).toBe(true);

    const s = await setup({ responseTimeoutMs: 200 });
    s.server.register('a1', () => null);
    expect(denied(await runShim(s, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo ciao' } }, {
      VISIONE_AGENT_ID: 'a1', VISIONE_AGENT_TOKEN: 'sbagliato', VISIONE_HOOK_FAIL_CLOSED: '1'
    }))).toBe(true);

    const slow = s.server.register('lento', () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)));
    expect(denied(await runShim(s, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo ciao' } }, {
      VISIONE_AGENT_ID: 'lento', VISIONE_AGENT_TOKEN: slow, VISIONE_HOOK_FAIL_CLOSED: '1'
    }))).toBe(true);
  }, 30_000);

  it('senza la policy, e per gli altri eventi, un VISIONE assente non blocca il motore (come prima)', async () => {
    const down = await setup({ start: false });
    const env = { VISIONE_AGENT_ID: 'a1', VISIONE_AGENT_TOKEN: 'qualunque' };
    expect(await runShim(down, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo ciao' } }, env)).toBe('');
    expect(await runShim(down, 'Stop', { stop_hook_active: false }, { ...env, VISIONE_HOOK_FAIL_CLOSED: '1' })).toBe('');
  }, 30_000);
});
