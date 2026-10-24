// Memoria di VISIONE (Fase 7, VISIONE_ARCHITECTURE §17, DECISIONI P-42…P-44). Unico proprietario di
// `memory_items`. Verso gli agenti il contratto è a file (`agents\<id>\memory.md`, scritto
// dall'agente e indicizzato qui) più le righe `MEMORIA:` nel risultato di un turno (fatti del task).
// Il Context Builder compone i brief; la riflessione comprime `memory.md` senza perdere i fatti
// fissati (backup → verifica → sostituzione atomica). Nessun motore e nessuna rete: solo file e SQLite.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MEMORY_LIMITS, type AgentDefinition, type Language } from '../../shared/contracts/index.ts';
import type { Logger } from '../../shared/node/logging.ts';
import type { TurnContextProvider } from '../agents/index.ts';
import { CommandFailure, type CommandRouter } from '../commands/index.ts';
import type { EventEmitter } from '../events/index.ts';
import type { Journal } from '../journal/index.ts';
import { createContextBuilder, type ContextConfig, type TaskReader } from './context.ts';
import { extractFacts, parseMemory } from './markdown.ts';
import { planReflection, verifyReflection, type Summarizer } from './reflect.ts';
import { createMemoryStore, type FileEntry, type MemoryStore, type ScopeFilter, type SyncReport } from './store.ts';
import type { Db } from '../db/index.ts';

export { createMemoryStore, type MemoryStore, type ScopeFilter, type SyncReport } from './store.ts';
export { createContextBuilder, type TaskReader } from './context.ts';
export { extractFacts, ftsQuery, parseMemory, withoutFacts, type MemorySection } from './markdown.ts';
export { extractiveSummary, planReflection, verifyReflection, type Summarizer } from './reflect.ts';

export interface MemoryConfig extends ContextConfig {
  readonly reflectAtChars: number;
  readonly keepRecentSections: number;
  readonly summaryMaxChars: number;
}

export interface ReflectOutcome {
  applied: boolean;
  reason: string;
  beforeChars: number;
  afterChars: number;
}

export interface Memory {
  readonly store: MemoryStore;
  /** Context Builder per l'Agent Manager. */
  readonly context: TurnContextProvider;
  /** Reindicizza `memory.md` dell'agente se è cambiato (o sempre con `force`). */
  refresh(agentId: string, force?: boolean): SyncReport | null;
  refreshAll(): void;
  reflect(agentId: string, opts: { force: boolean }): ReflectOutcome;
}

export interface MemoryDeps {
  db: Db;
  events: EventEmitter;
  log: Logger;
  journal: Pick<Journal, 'read'>;
  agentsDir: string;
  config: MemoryConfig;
  tasks: TaskReader;
  /** Agenti attivi e occupati (Agent Manager, legato in ritardo dal kernel). */
  agents: { ids(): string[]; isBusy(agentId: string): boolean };
  summarize?: Summarizer;
  now?: () => number;
  /** Solo test: subito prima della sostituzione del file della riflessione. */
  beforeReplace?: (agentId: string) => void;
  /** Addestramento (P-107k): regole scelte dall'utente, solo quelle che riguardano il compito. */
  skills?: { forTurn(text: string): string[] };
  /** Mappa del codice (P-107l): file e righe della cartella di lavoro che riguardano il compito. */
  codeMap?: { forTurn(def: AgentDefinition, text: string): string[] };
  /** Lingua del proprietario, per la lingua della risposta degli agenti. */
  language?: () => Language;
  /** La squadra nel brief di un passo (24/10/2026), dai gruppi di lavoro. */
  team?: (taskId: string) => string[];
}

const BACKUPS_KEPT = 5;
const SOURCE = { kind: 'visione', id: 'memory' } as const;

export function createMemory(deps: MemoryDeps): Memory {
  const { events, log, tasks, agents, config } = deps;
  const now = deps.now ?? Date.now;
  const store = createMemoryStore({ db: deps.db, events, now });
  const signatures = new Map<string, string>();
  const memoryFile = (agentId: string): string => join(deps.agentsDir, agentId, 'memory.md');

  const emitError = (agentId: string | null, stage: 'index' | 'facts' | 'inbox' | 'context' | 'reflection', err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('memoria: operazione non riuscita', { agentId, stage, message });
    events.emit('memory.error', { agentId, stage, message: message.slice(0, 1_000) }, { source: SOURCE, ...(agentId ? { target: { kind: 'agent', id: agentId } } : {}) });
  };

  const syncText = (agentId: string, text: string, opts: { supersedeWith?: number; reason?: string }): SyncReport => {
    const parsed = parseMemory(text);
    const stats = { ignored: Math.max(0, parsed.sections.length - MEMORY_LIMITS.sectionsPerFile), truncated: 0, scopeDenied: 0 };
    const entries = parsed.sections.slice(0, MEMORY_LIMITS.sectionsPerFile).map((s): FileEntry => {
      let scope: FileEntry['scope'] = 'agent';
      let scopeId = agentId;
      if (s.taskId) {
        // Un agente scrive solo la memoria dei task che gli sono stati assegnati.
        if (tasks.get(s.taskId)?.assigneeAgentId === agentId) {
          scope = 'task';
          scopeId = s.taskId;
        } else {
          stats.scopeDenied++;
        }
      }
      if (s.title.length > MEMORY_LIMITS.titleChars || s.body.length > MEMORY_LIMITS.contentChars) stats.truncated++;
      return { scope, scopeId, kind: s.kind, title: s.title, content: s.body || s.title, pinned: s.pinned, ...(s.reflection ? { source: 'reflection' } : {}) };
    });
    return store.syncFile(agentId, entries, { ...opts, stats });
  };

  const refresh = (agentId: string, force = false): SyncReport | null => {
    const file = memoryFile(agentId);
    let st: { mtimeMs: number; size: number } | null = null;
    try {
      st = statSync(file);
    } catch {
      st = null;
    }
    const sig = st ? `${st.mtimeMs}:${st.size}` : 'missing';
    if (!force && signatures.get(agentId) === sig) return null;
    signatures.set(agentId, sig);
    // File assente: gli elementi che venivano dal file escono dalla ricerca (ritirati, non cancellati).
    if (!st) return store.syncFile(agentId, [], {});
    if (st.size > MEMORY_LIMITS.fileBytes) {
      emitError(agentId, 'index', `memory.md troppo grande (${st.size} byte, massimo ${MEMORY_LIMITS.fileBytes}): non indicizzato`);
      return null;
    }
    return syncText(agentId, readFileSync(file, 'utf8'), {});
  };

  const refreshAll = (): void => {
    for (const agentId of agents.ids()) {
      try {
        refresh(agentId);
      } catch (err) {
        emitError(agentId, 'index', err);
      }
    }
  };

  const reflect = (agentId: string, opts: { force: boolean }): ReflectOutcome => {
    const file = memoryFile(agentId);
    let beforeChars = 0;
    const abort = (reason: string): ReflectOutcome => {
      events.emit('memory.reflection.aborted', { agentId, reason: reason.slice(0, 500) }, { source: SOURCE, target: { kind: 'agent', id: agentId }, severity: 'warning' });
      return { applied: false, reason, beforeChars, afterChars: beforeChars };
    };
    if (!existsSync(file)) return { applied: false, reason: 'memory.md assente', beforeChars: 0, afterChars: 0 };
    if (agents.isBusy(agentId)) return abort('agente al lavoro: la riflessione aspetta la fine del turno');
    try {
      const st1 = statSync(file);
      // La riflessione è anche il rimedio a un file troppo grande da indicizzare: tetto più alto.
      if (st1.size > MEMORY_LIMITS.fileBytes * 8) return abort(`memory.md troppo grande anche per la riflessione (${st1.size} byte)`);
      const before = readFileSync(file, 'utf8');
      beforeChars = before.length;
      if (!opts.force && before.length < config.reflectAtChars) {
        return { applied: false, reason: `sotto soglia (${before.length} < ${config.reflectAtChars} caratteri)`, beforeChars, afterChars: beforeChars };
      }
      // Indice aggiornato prima: le sezioni riassunte devono esistere per essere sostituite.
      if (st1.size <= MEMORY_LIMITS.fileBytes) refresh(agentId);
      const plan = planReflection(before, {
        keepRecent: config.keepRecentSections, summaryMaxChars: config.summaryMaxChars, date: new Date(now()).toISOString().slice(0, 10),
        ...(deps.summarize ? { summarize: deps.summarize } : {})
      });
      if (!plan.ok) return abort(plan.reason);
      const verdict = verifyReflection(before, plan.content);
      if (!verdict.ok) return abort(verdict.reason);

      const backupDir = join(deps.agentsDir, agentId, 'memory.bak');
      mkdirSync(backupDir, { recursive: true });
      const backup = join(backupDir, `memory-${now()}.md`);
      copyFileSync(file, backup);
      for (const old of readdirSync(backupDir).filter((n) => /^memory-\d+\.md$/.test(n)).sort((a, b) => Number(a.slice(7, -3)) - Number(b.slice(7, -3))).slice(0, -BACKUPS_KEPT)) {
        rmSync(join(backupDir, old), { force: true });
      }
      deps.beforeReplace?.(agentId);
      // L'agente può aver scritto nel frattempo: niente sostituzione, si riprova al prossimo turno.
      const st2 = statSync(file);
      if (st2.mtimeMs !== st1.mtimeMs || st2.size !== st1.size) return abort('memory.md modificato durante la riflessione: riprovo al prossimo turno');
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, plan.content, 'utf8');
      renameSync(tmp, file);

      const report = syncText(agentId, plan.content, { supersedeWith: plan.summaryIndex, reason: 'riflessione' });
      const st3 = statSync(file);
      signatures.set(agentId, `${st3.mtimeMs}:${st3.size}`);
      events.emit('memory.reflection.completed', {
        agentId, beforeChars, afterChars: plan.content.length, pinned: plan.pinned, summarized: plan.summarized, kept: plan.kept,
        summaryItemId: report.ids[plan.summaryIndex] ?? null, backup: basename(backup)
      }, { source: SOURCE, target: { kind: 'agent', id: agentId } });
      return { applied: true, reason: 'applicata', beforeChars, afterChars: plan.content.length };
    } catch (err) {
      emitError(agentId, 'reflection', err);
      return { applied: false, reason: `errore: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500), beforeChars, afterChars: beforeChars };
    }
  };

  const context = createContextBuilder({
    store,
    refresh: refreshAll,
    tasks,
    journal: deps.journal,
    events,
    config,
    onError: (agentId, err) => emitError(agentId, 'context', err),
    ...(deps.skills ? { skills: deps.skills } : {}),
    ...(deps.codeMap ? { codeMap: deps.codeMap } : {}),
    ...(deps.language ? { language: deps.language } : {}),
    ...(deps.team ? { team: deps.team } : {}),
    afterTurn({ def, req, turnId, outcome, text, brief }) {
      const corr = { correlationId: req.correlationId };
      if (outcome === 'succeeded' && text) {
        try {
          for (const fact of extractFacts(text)) {
            store.write({ scope: 'task', scopeId: req.taskId, kind: 'fact', title: '', content: fact.content, source: `agent:${def.id}`, origin: 'turn', originRef: turnId, pinned: fact.pinned }, corr);
          }
        } catch (err) {
          emitError(def.id, 'facts', err);
        }
      }
      // Posta letta: archiviata solo se il turno è riuscito (altrimenti torna nel prossimo brief).
      if (outcome === 'succeeded' && brief.consumed.length > 0) {
        try {
          const read = join(deps.agentsDir, def.id, 'inbox', 'read');
          mkdirSync(read, { recursive: true });
          for (const f of brief.consumed) if (existsSync(f)) renameSync(f, join(read, basename(f)));
        } catch (err) {
          emitError(def.id, 'inbox', err);
        }
      }
      try {
        refresh(def.id);
      } catch (err) {
        emitError(def.id, 'index', err);
      }
      try {
        if (existsSync(memoryFile(def.id)) && statSync(memoryFile(def.id)).size >= config.reflectAtChars) reflect(def.id, { force: false });
      } catch (err) {
        emitError(def.id, 'reflection', err);
      }
    }
  });

  return { store, context, refresh, refreshAll, reflect };
}

export function registerMemoryCommands(deps: { router: CommandRouter; memory: Memory; tasks: TaskReader; agentExists(agentId: string): boolean }): void {
  const { router, memory, tasks } = deps;
  router.register('memory.search', (p) => {
    let scopes: ScopeFilter | null = null;
    if (p.agentId !== undefined || p.taskId !== undefined) {
      const task = p.taskId === undefined ? null : tasks.get(p.taskId);
      if (p.taskId !== undefined && !task) throw new CommandFailure('not_found', `task sconosciuto: ${p.taskId}`);
      scopes = { global: true, agentId: p.agentId ?? null, taskIds: task ? tasks.list({ rootId: task.rootId, limit: 200 }).map((t) => t.id) : [] };
    }
    memory.refreshAll();
    return { items: memory.store.search(p.query, { scopes, limit: p.limit, includeInactive: p.includeInactive, agentId: p.agentId ?? null }) };
  });
  router.register('memory.write', (p, ctx) => {
    if (p.scope === 'global' && p.scopeId !== null) throw new CommandFailure('invalid_payload', 'la memoria globale non ha scopeId');
    if (p.scope !== 'global' && p.scopeId === null) throw new CommandFailure('invalid_payload', `scopeId obbligatorio per l'ambito ${p.scope}`);
    if (p.scope === 'agent' && !deps.agentExists(p.scopeId as string)) throw new CommandFailure('not_found', `agente sconosciuto: ${p.scopeId}`);
    if (p.scope === 'task' && !tasks.get(p.scopeId as string)) throw new CommandFailure('not_found', `task sconosciuto: ${p.scopeId}`);
    return memory.store.write({
      scope: p.scope, scopeId: p.scopeId, kind: p.kind, title: p.title, content: p.content, source: `owner:${ctx.command.issuedBy}`, origin: 'command', pinned: p.pinned
    }, { correlationId: ctx.command.correlationId });
  });
  router.register('memory.promote', (p, ctx) => {
    const out = memory.store.promote(p.itemId, `owner:${ctx.command.issuedBy}`, { correlationId: ctx.command.correlationId });
    if (!out) throw new CommandFailure('not_found', `elemento di memoria sconosciuto: ${p.itemId}`);
    return out;
  });
  router.register('memory.reflect', (p) => {
    if (!deps.agentExists(p.agentId)) throw new CommandFailure('not_found', `agente sconosciuto: ${p.agentId}`);
    return memory.reflect(p.agentId, { force: p.force });
  });
}
