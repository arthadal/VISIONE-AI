// Harness dell'orchestrazione (Fase 6): database, journal, bus ed emitter reali, CLI Runtime reale
// (nessun processo per gli adapter finti), audit, approvazioni, policy, Agent Manager, Task Engine,
// Director e canale a file reali. Gli adapter finti stanno in memoria: comportamento deciso da
// parole chiave nel testo del task, nessun motore, nessuna rete.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterError, type AdapterContext, type AgentAdapter, type TurnInput, type TurnOutcome } from '../src/core/adapters/index.ts';
import { createAgentManager, type AgentManager } from '../src/core/agents/index.ts';
import { createApprovalQueue, type ApprovalQueue } from '../src/core/approvals/index.ts';
import { createAuditLog, type AuditLog } from '../src/core/audit/index.ts';
import { createDirector, type Director } from '../src/core/director/index.ts';
import { createMemory, type Memory, type MemoryConfig } from '../src/core/memory/index.ts';
import { createMessageChannel, type MessageChannel } from '../src/core/messages/index.ts';
import { createActionPolicy, type ActionPolicy } from '../src/core/policy/index.ts';
import { createTaskEngine, type TaskEngine } from '../src/core/tasks/index.ts';
import {
  runtimeError,
  type AgentCapability,
  type AgentDefinitionInput,
  type VisioneEvent,
  type RuntimeError
} from '../src/shared/contracts/index.ts';
import { createAdapterRegistry } from '../src/core/adapters/index.ts';
import { memoryLogger } from './helpers.ts';
import { createRuntimeHarness, type RuntimeHarness } from './runtime-harness.ts';

export interface FakeCall {
  readonly agentId: string;
  readonly taskId: string | undefined;
  readonly text: string;
  readonly turnId: string;
  /** P-100: modello reale con cui il turno è partito (dalla definizione al momento del turno). */
  readonly model: string | null;
  /** P-100: potenza reale del turno (`engine.options.effort`), null se il motore non la dichiara. */
  readonly effort: string | null;
  /** Sessione del motore ripresa dal turno ('' = conversazione nuova). */
  readonly engineSessionId: string;
}

export interface FakeAdapter extends AgentAdapter {
  readonly turns: FakeCall[];
  readonly starts: string[];
  readonly cancels: string[];
  readonly stops: string[];
  /** Turni lenti in corso (annullabili). */
  readonly pending: Map<string, () => void>;
}

/**
 * Adapter finto. Parole chiave nel testo del turno:
 * - `FALLISCI` → turno fallito (errore del motore, non ritentabile);
 * - `FALLISCI-UNA-VOLTA` → fallisce al primo turno di quel task, poi riesce;
 * - `LENTO` → resta in corso finché non viene annullato;
 * - `LIMITE` → evento `limit.reached` e turno fallito con `limit_reached` (P-83);
 * - `RISPOSTA:<testo>` → testo finale = <testo> (fino a fine riga);
 * - `FATTO:<testo>` → il testo finale ha anche la riga `MEMORIA: <testo>` (Fase 7);
 * - `SCRIVI-MEMORIA:<intestazione>|<corpo>` → aggiunge la sezione a `memory.md` (`{task}` = id del task).
 */
export function fakeAdapter(
  id: string,
  opts: {
    trust?: boolean;
    startError?: RuntimeError;
    capabilities?: AgentCapability[];
    startDelayMs?: number;
    /** Modelli sondati (P-83): li restituisce `listModels`, con dettaglio comune. */
    models?: readonly string[];
    /** Livelli di potenza dichiarati (P-83); assente = motore senza potenza. */
    effort?: readonly string[];
    /** Riconosce `LIMITE` e fallisce con `limit_reached` (P-83); default true. */
    limit?: boolean;
  } = {}
): FakeAdapter {
  const turns: FakeCall[] = [];
  const starts: string[] = [];
  const cancels: string[] = [];
  const stops: string[] = [];
  const pending = new Map<string, () => void>();
  const failedOnce = new Set<string>();
  /** Limite simulato una volta per istanza: il motore di ripiego non eredita il guasto. */
  const limitedOnce = new Set<string>();
  return {
    id,
    capabilities: new Set<AgentCapability>(opts.capabilities ?? ['turns.headless', 'events.turnEnd', 'control.steer']),
    turns, starts, cancels, stops, pending,
    async listModels() {
      return (opts.models ?? []).map((m) => ({ id: m, detail: 'probe' }));
    },
    tuning(def) {
      if (!opts.effort) return { effort: null };
      const current = typeof def.engine.options?.effort === 'string' ? def.engine.options.effort : null;
      return { effort: { options: [...opts.effort], current } };
    },
    async probe() {
      return { available: true, version: 'finto', problems: [] };
    },
    validate(def) {
      return def.engine.adapter === id ? { ok: true } : { ok: false, problems: ['adapter diverso'] };
    },
    async start(ctx: AdapterContext, resume) {
      starts.push(ctx.instance.agentId);
      if (opts.startDelayMs) await new Promise((r) => setTimeout(r, opts.startDelayMs));
      if (opts.startError) throw new AdapterError(opts.startError);
      if (opts.trust && !ctx.trustApproved) throw new AdapterError(runtimeError('trust_required', `fiducia richiesta per ${ctx.workspaceDir}`));
      return resume ?? { id: `s-${ctx.instance.agentId}-${starts.length}`, engineSessionId: '', adapter: id, startedAt: Date.now(), resumable: false };
    },
    async sendTurn(ctx, input: TurnInput): Promise<TurnOutcome> {
      const effort = typeof ctx.definition.engine.options?.effort === 'string' ? ctx.definition.engine.options.effort : null;
      turns.push({ agentId: ctx.instance.agentId, taskId: input.taskId, text: input.text, turnId: input.turnId, model: ctx.definition.engine.model ?? null, effort, engineSessionId: ctx.instance.session?.engineSessionId ?? '' });
      ctx.emit({ kind: 'turn.started', turnId: input.turnId });
      const engineSessionId = `ses-${ctx.instance.agentId}`;
      if (ctx.instance.session?.engineSessionId !== engineSessionId) ctx.emit({ kind: 'session.started', engineSessionId });
      const finish = (outcome: TurnOutcome['outcome'], error: RuntimeError | null): TurnOutcome => {
        ctx.emit({ kind: 'turn.finished', turnId: input.turnId, outcome, ...(error ? { error } : {}) });
        return { outcome, error, engineSessionId };
      };
      const key = `${input.taskId ?? ''}`;
      // Limite di quota (P-83): evento + turno fallito `limit_reached`, una volta per istanza
      // (il motore di ripiego riceve la stessa specifica ma non eredita il limite simulato).
      if (opts.limit !== false && input.text.includes('LIMITE') && !limitedOnce.has(ctx.instance.agentId)) {
        limitedOnce.add(ctx.instance.agentId);
        ctx.emit({ kind: 'limit.reached', turnId: input.turnId, scope: 'session', message: 'Usage limit reached · limit resets 3:00 PM', resetAt: '3:00pm' });
        return finish('failed', runtimeError('limit_reached', 'Usage limit reached'));
      }
      if (input.text.includes('FALLISCI-UNA-VOLTA') && !failedOnce.has(key)) {
        failedOnce.add(key);
        return finish('failed', runtimeError('engine_error', 'errore simulato (una volta)'));
      }
      if (input.text.includes('FALLISCI') && !input.text.includes('FALLISCI-UNA-VOLTA')) return finish('failed', runtimeError('engine_error', 'errore simulato'));
      if (input.text.includes('LENTO')) {
        await new Promise<void>((resolve) => pending.set(ctx.instance.id, resolve));
        pending.delete(ctx.instance.id);
        return finish('cancelled', runtimeError('cancelled', 'annullato'));
      }
      for (const write of input.text.matchAll(/SCRIVI-MEMORIA:([^|\n]*)\|(.*)/g)) {
        const heading = (write[1] ?? '').replaceAll('{task}', input.taskId ?? '').trim();
        appendFileSync(join(ctx.agentDir, 'memory.md'), `\n## ${heading}\n\n${(write[2] ?? '').trim()}\n`, 'utf8');
      }
      const fact = /FATTO:(.*)/.exec(input.text)?.[1]?.trim();
      const answer = (/RISPOSTA:(.*)/.exec(input.text)?.[1]?.trim() ?? `fatto da ${ctx.instance.agentId}`) + (fact ? `\nMEMORIA: ${fact}` : '');
      ctx.emit({ kind: 'message.text', turnId: input.turnId, text: answer, final: true });
      return finish('completed', null);
    },
    async cancelTurn(ctx) {
      cancels.push(ctx.instance.agentId);
      pending.get(ctx.instance.id)?.();
    },
    async steer() {
      // nessun effetto: il Director lo chiama al livello `steer` del breaker
    },
    async stop(ctx) {
      stops.push(ctx.instance.agentId);
      pending.get(ctx.instance.id)?.();
    }
  };
}

export function agentInput(id: string, adapter: string, over: Partial<AgentDefinitionInput> = {}): AgentDefinitionInput {
  return {
    id,
    name: id.toUpperCase(),
    role: `agente di prova ${id}`,
    competences: ['code'],
    engine: { adapter },
    persona: { instructions: 'Rispondi in italiano.', language: 'it' },
    workspace: { root: id, isolation: 'shared' },
    permissions: 'read-only',
    limits: { maxTurnMinutes: 5, maxTurnsPerTask: 10, maxConcurrentTasks: 1 },
    ...over
  };
}

/** Default della configurazione della memoria (come in config.ts). */
export const MEMORY_TEST_CONFIG: MemoryConfig = { briefMaxChars: 12_000, searchLimit: 6, reflectAtChars: 24_000, keepRecentSections: 8, summaryMaxChars: 4_000 };

export interface Stack {
  h: RuntimeHarness;
  audit: AuditLog;
  approvals: ApprovalQueue;
  policy: ActionPolicy;
  agents: AgentManager;
  engine: TaskEngine;
  director: Director;
  channel: MessageChannel;
  /** Memoria e Context Builder (Fase 7), solo con `memory`. */
  memory: Memory | null;
  adapters: Record<string, FakeAdapter>;
  agentsDir: string;
  workspaceDir: string;
  /** Attende che non ci siano turni in corso né eventi da consegnare. */
  settle(): Promise<void>;
  events(type?: string): VisioneEvent[];
  close(): Promise<void>;
}

export function createStack(opts: {
  adapters?: FakeAdapter[];
  maxConcurrent?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  h?: RuntimeHarness;
  protectedRoots?: string[];
  /** Memoria con il Context Builder (Fase 7); i valori parziali sostituiscono i default. */
  memory?: Partial<MemoryConfig> | true;
  beforeReplace?: (agentId: string) => void;
  /** Agente preferito per il ripiego da limite (P-83). */
  limitFallbackAgentId?: string;
  /** P-105: chi comanda (pianificatore predefinito), letto a ogni invio. */
  defaultPlannerAgentId?: () => string;
} = {}): Stack {
  const h = opts.h ?? createRuntimeHarness();
  const log = memoryLogger('error').log;
  const agentsDir = join(h.dir, 'agents');
  const workspaceDir = join(h.dir, 'workspace');
  const fakes = opts.adapters ?? [fakeAdapter('motore-a'), fakeAdapter('motore-b')];
  const audit = createAuditLog(h.db);
  const approvals = createApprovalQueue({ db: h.db, events: h.emitter, audit });
  const policy = createActionPolicy({ protectedRoots: opts.protectedRoots ?? [] });
  let engineRef: TaskEngine | null = null;
  let agentsRef: AgentManager | null = null;
  const memory = opts.memory
    ? createMemory({
      db: h.db, events: h.emitter, log, journal: h.journal, agentsDir,
      config: { ...MEMORY_TEST_CONFIG, ...(opts.memory === true ? {} : opts.memory) },
      tasks: { get: (id) => engineRef?.get(id) ?? null, children: (id) => engineRef?.children(id) ?? [], list: (f) => engineRef?.list(f) ?? [] },
      agents: { ids: () => agentsRef?.active().map((d) => d.id) ?? [], isBusy: (id) => agentsRef?.isBusy(id) ?? false },
      ...(opts.beforeReplace ? { beforeReplace: opts.beforeReplace } : {})
    })
    : null;
  const agents = createAgentManager({
    db: h.db, events: h.emitter, log, adapters: createAdapterRegistry(fakes), runtime: h.runtime, audit, approvals, policy, agentsDir, workspaceDir, stopDeadlineMs: 1_000,
    ...(memory ? { context: memory.context } : {})
  });
  agentsRef = agents;
  const engine = createTaskEngine({
    db: h.db, events: h.emitter, log, audit, executor: agents, maxConcurrent: opts.maxConcurrent ?? 4,
    defaultBudget: { timeoutMs: opts.timeoutMs ?? 10_000, maxAttempts: opts.maxAttempts ?? 2 }
  });
  engineRef = engine;
  let channel: MessageChannel | null = null;
  const director = createDirector({
    engine, agents, approvals, policy, audit, events: h.emitter, bus: h.bus, log, agentsDir, workspaceDir,
    ...(opts.limitFallbackAgentId ? { limitFallbackAgentId: opts.limitFallbackAgentId } : {}),
    ...(opts.defaultPlannerAgentId ? { defaultPlannerAgentId: opts.defaultPlannerAgentId } : {}),
    reply: (to, act, body) => {
      channel?.send({ conversationId: to.conversationId, inReplyTo: to.id, from: 'director', to: to.from, act, subject: `Re: ${to.subject}`, body, taskId: to.taskId, hops: to.hops + 1, requiresReply: false });
    }
  });
  engine.setHooks(director.hooks);
  director.start();
  channel = createMessageChannel({ db: h.db, events: h.emitter, log, agentsDir, isAgent: (id) => agents.get(id) !== null, onDirectorMessage: (m) => director.onMessage(m) });
  const ch = channel;
  const settle = async (): Promise<void> => {
    // Non attende i turni appesi di proposito (LENTO): solo il lavoro già pronto.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await h.bus.idle();
    }
  };
  return {
    h, audit, approvals, policy, agents, engine, director, channel: ch, memory, agentsDir, workspaceDir, settle,
    adapters: Object.fromEntries(fakes.map((f) => [f.id, f])),
    events: (type) => (type ? h.events.filter((e) => e.type === type) : h.events),
    async close() {
      ch.close();
      director.stop();
      await engine.suspend('fine test', 1_000);
      await agents.stopAll('fine test', 1_000);
      await h.cleanup();
    }
  };
}
