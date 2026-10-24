// Harness degli adapter: runtime reale + CLI finte raggiungibili come shim npm `.cmd` in una
// cartella `bin` messa in testa al PATH (nessun motore reale, nessuna rete).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createAgentEventSink, type AdapterContext, type AgentEvent } from '../src/core/adapters/index.ts';
import type { HookServer } from '../src/core/runtime/index.ts';
import type { AgentDefinition, AgentSession } from '../src/shared/contracts/index.ts';
import { memoryLogger } from './helpers.ts';
import { createRuntimeHarness, type RuntimeHarness } from './runtime-harness.ts';

/** Ambiente con PATH = [bin delle CLI finte, cartella di node] e nient'altro nel PATH. */
export function fakeCliEnv(binDir: string | null, extra: Record<string, string | undefined> = {}, opts: { nodeDir?: boolean } = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^path$/i.test(k)) env[k] = v;
  // La cartella di node può contenere CLI reali installate con npm: esclusa quando serve "CLI assente".
  env.Path = [binDir, opts.nodeDir === false ? null : dirname(process.execPath)].filter(Boolean).join(';');
  return { ...env, ...extra };
}

/** Shim npm come quelli generati da cmd-shim: `"%_prog%" "<script>" %*`. */
export function writeShim(binDir: string, name: string, script: string): string {
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, `${name}.cmd`);
  writeFileSync(file, `@ECHO off\r\nSETLOCAL\r\nSET "_prog=node"\r\n"%_prog%"  "${resolve(script)}" %*\r\n`);
  return file;
}

export function definition(over: Partial<AgentDefinition> & { engine: AgentDefinition['engine'] }): AgentDefinition {
  return {
    id: 'director',
    name: 'Director',
    role: 'esecutore di prova',
    competences: ['code'],
    persona: { instructions: 'Rispondi in italiano.', language: 'it' },
    workspace: { root: 'agente-1', isolation: 'shared' },
    permissions: 'read-only',
    limits: { maxTurnMinutes: 5, maxTurnsPerTask: 10, maxConcurrentTasks: 1 },
    createdBy: 'test',
    createdAt: 0,
    version: 1,
    ...over
  };
}

export interface AdapterTestContext {
  ctx: AdapterContext;
  events: AgentEvent[];
  setSession(session: AgentSession | undefined): void;
  abort: AbortController;
}

export function adapterContext(h: RuntimeHarness, def: AgentDefinition, opts: { hooks?: HookServer; correlationId?: string; trustApproved?: boolean } = {}): AdapterTestContext {
  const events: AgentEvent[] = [];
  const abort = new AbortController();
  let session: AgentSession | undefined;
  const bridge = createAgentEventSink({
    events: h.emitter,
    agentId: def.id,
    sessionId: () => session?.id ?? null,
    adapter: def.engine.adapter,
    correlationId: () => opts.correlationId
  });
  const agentDir = join(h.dir, 'agents', def.id);
  mkdirSync(agentDir, { recursive: true });
  const ctx: AdapterContext = {
    get instance() {
      return { id: `inst-${def.id}`, agentId: def.id, status: 'idle' as const, ...(session ? { session } : {}) };
    },
    definition: def,
    runtime: h.runtime,
    agentDir,
    workspaceDir: h.workspace,
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.trustApproved ? { trustApproved: true } : {}),
    emit(e) {
      events.push(e);
      bridge(e);
    },
    signal: abort.signal,
    log: memoryLogger('error').log
  };
  return { ctx, events, setSession: (s) => { session = s; }, abort };
}

export { createRuntimeHarness };
