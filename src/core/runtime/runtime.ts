// CLI Runtime: unica porta di creazione dei processi (VISIONE_AGENT_ARCHITECTURE §4). Policy →
// registro → coda di avvio → processo gestito → eventi `process.*` sull'Event Bus della Fase 4
// (nessun bus proprio) e righe nel registro, nella stessa transazione quando possibile.
import { basename, extname } from 'node:path';
import {
  isTerminalProcessStatus,
  runtimeError,
  type ProcessInfo,
  type ProcessStatus,
  type RuntimeError,
  type TypedEvent
} from '../../shared/contracts/index.ts';
import { ulid } from '../../shared/lib/ulid.ts';
import type { Logger } from '../../shared/node/logging.ts';
import type { Db } from '../db/index.ts';
import type { EventEmitter } from '../events/index.ts';
import { chunks } from './buffers.ts';
import { createCliDiscovery, type CliDiscovery, type DiscoveryResult, type ResolvedCli } from './discovery.ts';
import { buildEnv } from './env.ts';
import type { RuntimePolicy } from './policy.ts';
import {
  createManagedProcess,
  type ManagedProcess,
  type OutputStream,
  type ProcessResult,
  type ProcessSink,
  type ProcessSpec,
  type PtyModule,
  type StopOutcome
} from './process.ts';
import { createProcessRegistry, type ProcessRecord, type ProcessRegistry } from './registry.ts';
import { createProcessTools, type ProcessTools } from './tree.ts';

export type StartResult = { ok: true; process: ManagedProcess } | { ok: false; error: RuntimeError };

export interface RunOutput {
  readonly result: ProcessResult;
  readonly stdout: string;
  readonly stderr: string;
  /** L'uscita superava `maxChars` ed è stata troncata. */
  readonly truncated: boolean;
}

export interface RestartPolicy {
  readonly maxRestarts: number;
  readonly windowMs: number;
  readonly backoffMs: readonly number[];
  /** Esiti che giustificano un riavvio (default: crashed). */
  readonly restartOn?: readonly ProcessStatus[];
}

export interface Supervision {
  readonly current: ManagedProcess | null;
  readonly restarts: number;
  /** Ferma il processo corrente e i riavvii futuri. */
  stop(reason: string): Promise<void>;
  /** Fine della supervisione: ultimo esito, riavvii fatti, errore se il budget è esaurito. */
  readonly done: Promise<{ last: ProcessResult | null; restarts: number; error: RuntimeError | null }>;
}

export interface ReconcileReport {
  readonly checked: number;
  readonly outcomes: ReadonlyArray<{ processId: string; pid: number | null; outcome: 'killed' | 'gone' | 'pid-reused' | 'kill-failed' | 'unverified' }>;
}

export interface CliRuntime {
  readonly policy: RuntimePolicy;
  readonly discovery: CliDiscovery;
  /** Valida e registra il processo; l'avvio vero può attendere la coda. Mai un'eccezione. */
  start(spec: ProcessSpec): StartResult;
  /** Avvia, attende la fine e raccoglie l'uscita (processi brevi: versioni, export). */
  run(spec: ProcessSpec, opts?: { maxChars?: number }): Promise<{ ok: true; output: RunOutput } | { ok: false; error: RuntimeError }>;
  get(id: string): ManagedProcess | undefined;
  /** Processi di questo avvio del core (vivi e terminati). */
  list(filter?: { live?: boolean; agentId?: string; sessionId?: string; taskId?: string }): ProcessInfo[];
  /** Registro persistente (anche avvii precedenti). */
  history(limit: number): ProcessRecord[];
  stop(id: string, opts?: { mode?: 'graceful' | 'force'; reason?: string }): Promise<StopOutcome>;
  stopAll(reason: string, deadlineMs: number): Promise<number>;
  supervise(makeSpec: (attempt: number, restartOf: string | null) => ProcessSpec, policy: RestartPolicy): Supervision;
  reconcile(): Promise<ReconcileReport>;
  /** Comandi di base per costruire l'ambiente dei processi. */
  env(cwd: string, layers?: Omit<Parameters<typeof buildEnv>[0], 'inherited' | 'cwd'>): Record<string, string>;
}

export interface RuntimeDeps {
  readonly db: Db;
  readonly events: EventEmitter;
  readonly log: Logger;
  readonly policy: RuntimePolicy;
  readonly inheritedEnv: Readonly<Record<string, string | undefined>>;
  /** Cartella di lavoro dei processi di sistema (versioni, export): dentro una radice consentita. */
  readonly systemCwd: string;
  readonly tools?: ProcessTools;
  readonly loadPty?: () => Promise<PtyModule>;
  readonly now?: () => number;
  readonly stopGraceMs?: number;
  readonly maxProcesses?: number;
  /** Quanto una coda di avvio attende il primo segnale del processo precedente. */
  readonly queueHoldMs?: number;
  readonly versionTimeoutMs?: number;
  readonly killWaitMs?: number;
  readonly onCliResult?: (result: DiscoveryResult) => void;
}

const SOURCE = { kind: 'visione', id: 'runtime' } as const;
const END_EVENT: Record<string, 'process.exited' | 'process.failed' | 'process.crashed' | 'process.stopped' | 'process.timeout' | 'process.cancelled'> = {
  exited: 'process.exited',
  failed: 'process.failed',
  crashed: 'process.crashed',
  stopped: 'process.stopped',
  timed_out: 'process.timeout',
  cancelled: 'process.cancelled'
};
const OUTPUT_EVENT_CHARS = 16_384;
/** Tolleranza tra l'ora di avvio registrata e quella del sistema operativo (riuso dei pid). */
const START_TOLERANCE_MS = 5_000;

const defaultLoadPty = async (): Promise<PtyModule> => (await import('node-pty')) as unknown as PtyModule;

export function createCliRuntime(deps: RuntimeDeps): CliRuntime {
  const now = deps.now ?? Date.now;
  const tools = deps.tools ?? createProcessTools();
  const registry: ProcessRegistry = createProcessRegistry(deps.db);
  const processes = new Map<string, ManagedProcess>();
  const queues = new Map<string, Promise<void>>();
  const outputSeq = new Map<string, number>();
  const maxProcesses = deps.maxProcesses ?? 32;
  const graceMs = deps.stopGraceMs ?? 5_000;
  const queueHoldMs = deps.queueHoldMs ?? 2_000;
  const { events, log } = deps;

  const opts = (p: ManagedProcess) => ({ correlationId: p.correlationId, source: SOURCE, target: { kind: 'process' as const, id: p.id } });

  /** Registro ed evento insieme; se il database non risponde l'evento parte comunque (P-27). */
  const persist = (write: () => void, emit: () => void): void => {
    try {
      deps.db.transaction(() => {
        write();
        emit();
      });
    } catch (err) {
      log.error('registro dei processi non aggiornato', { err });
      try {
        emit();
      } catch (emitErr) {
        log.error('evento di processo non emesso', { err: emitErr });
      }
    }
  };

  const sink: ProcessSink = {
    created(p, spec) {
      const info = p.info();
      persist(() => registry.insert(info), () => events.emit('process.created', {
        processId: p.id, kind: p.kind, io: p.io, exe: info.exe, cwd: spec.cwd, argCount: spec.args.length,
        owner: p.owner, restartOf: spec.restartOf ?? null
      }, opts(p)));
      log.info('processo registrato', { processId: p.id, exe: info.exe, args: spec.args.length, cwd: spec.cwd, kind: p.kind, correlationId: p.correlationId });
    },
    starting(p, waitedMs) {
      events.emit('process.starting', { processId: p.id, waitedMs }, opts(p));
    },
    started(p) {
      const info = p.info();
      persist(() => registry.update(info), () => events.emit('process.started', { processId: p.id, pid: info.pid ?? 0, owner: p.owner }, opts(p)));
    },
    output(p, stream, text) {
      const type = stream === 'stderr' ? 'process.stderr' : 'process.stdout';
      for (const part of chunks(text, OUTPUT_EVENT_CHARS)) {
        const key = `${p.id}:${stream}`;
        const seq = (outputSeq.get(key) ?? 0) + 1;
        outputSeq.set(key, seq);
        events.emit(type, { processId: p.id, seq, text: part, stream }, opts(p));
      }
    },
    input(p, bytes) {
      events.emit('process.input', { processId: p.id, bytes }, opts(p));
    },
    stopping(p, intent, mode, reason) {
      const info = p.info();
      persist(() => registry.update(info), () => events.emit('process.stopping', { processId: p.id, pid: info.pid, intent, mode, reason: reason.slice(0, 200) }, opts(p)));
    },
    ended(p, r) {
      const info = p.info();
      const type = END_EVENT[r.status];
      outputSeq.delete(`${p.id}:stdout`);
      outputSeq.delete(`${p.id}:stderr`);
      outputSeq.delete(`${p.id}:pty`);
      if (!type) return;
      persist(() => registry.update(info), () => events.emit(type, {
        processId: p.id, pid: r.pid, owner: p.owner, status: r.status, exitCode: r.exitCode, signal: r.signal,
        durationMs: r.durationMs, error: r.error, tail: r.tail, stdoutBytes: r.stdoutBytes, stderrBytes: r.stderrBytes
      }, opts(p)));
      log.info('processo terminato', { processId: p.id, status: r.status, exitCode: r.exitCode, error: r.error?.code ?? null });
    }
  };

  const live = (): ManagedProcess[] => [...processes.values()].filter((p) => !isTerminalProcessStatus(p.status));

  const holdQueue = (p: ManagedProcess): Promise<void> => new Promise((resolve) => {
    const t = setTimeout(done, queueHoldMs);
    const off = p.onLine(() => done());
    void p.done.then(() => done());
    function done(): void {
      clearTimeout(t);
      off();
      resolve();
    }
  });

  const startWithId = (id: string, spec: ProcessSpec): StartResult => {
    const check = deps.policy.check(spec);
    if (!check.ok) {
      log.warn('avvio rifiutato dalla policy del runtime', { exe: basename(spec.exe), cwd: spec.cwd, code: check.error.code });
      return check;
    }
    if (spec.io !== 'pipes' && spec.io !== 'pty') return { ok: false, error: runtimeError('invalid_spec', 'modalità di I/O sconosciuta') };
    if (live().length >= maxProcesses) return { ok: false, error: runtimeError('queue_full', `già ${maxProcesses} processi attivi`) };
    const p = createManagedProcess({
      id, spec, sink, tools, loadPty: deps.loadPty ?? defaultLoadPty, now, defaultGraceMs: graceMs,
      ...(deps.killWaitMs === undefined ? {} : { killWaitMs: deps.killWaitMs })
    });
    processes.set(id, p);
    const queuedAt = now();
    if (spec.queueKey === undefined) {
      void p.launch(0);
    } else {
      // Avvii dello stesso motore uno alla volta: il successivo parte quando il precedente ha dato
      // un segnale di vita, è uscito o è passato `queueHoldMs` (MUNDER_CLI_RUNTIME §6).
      const key = spec.queueKey;
      const previous = queues.get(key) ?? Promise.resolve();
      const turn = previous.then(async () => {
        await p.launch(now() - queuedAt);
        if (!isTerminalProcessStatus(p.status)) await holdQueue(p);
      });
      const tail = turn.catch(() => undefined);
      queues.set(key, tail);
      void tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
      });
    }
    return { ok: true, process: p };
  };

  const runtime: CliRuntime = {
    policy: deps.policy,
    discovery: null as unknown as CliDiscovery,
    start: (spec) => startWithId(ulid(now()), spec),

    async run(spec, runOpts = {}) {
      const maxChars = runOpts.maxChars ?? 1_000_000;
      const started = runtime.start(spec);
      if (!started.ok) return started;
      const out = { stdout: [] as string[], stderr: [] as string[], size: 0, truncated: false };
      started.process.onLine((line, stream) => {
        if (out.size >= maxChars) {
          out.truncated = true;
          return;
        }
        const text = line.text + (line.partial ? '' : '\n');
        out.size += text.length;
        (stream === 'stderr' ? out.stderr : out.stdout).push(text);
      });
      const result = await started.process.done;
      return { ok: true, output: { result, stdout: out.stdout.join(''), stderr: out.stderr.join(''), truncated: out.truncated } };
    },

    get: (id) => processes.get(id),

    list(filter = {}) {
      return [...processes.values()]
        .filter((p) => (filter.live ? !isTerminalProcessStatus(p.status) : true))
        .filter((p) => (filter.agentId === undefined || p.owner.agentId === filter.agentId)
          && (filter.sessionId === undefined || p.owner.sessionId === filter.sessionId)
          && (filter.taskId === undefined || p.owner.taskId === filter.taskId))
        .map((p) => p.info());
    },

    history: (limit) => registry.recent(limit),

    async stop(id, stopOpts = {}) {
      const p = processes.get(id);
      if (!p) {
        const record = registry.get(id);
        return { ok: false, error: record
          ? runtimeError('not_running', `processo di un avvio precedente (${record.status}): non più controllabile`)
          : runtimeError('unknown_process', `processo sconosciuto: ${id}`) };
      }
      return p.stop({ mode: stopOpts.mode ?? 'graceful', reason: stopOpts.reason ?? 'stop richiesto' });
    },

    async stopAll(reason, deadlineMs) {
      const targets = live();
      if (targets.length === 0) return 0;
      const grace = Math.max(0, Math.min(graceMs, Math.floor(deadlineMs / 2)));
      await Promise.race([
        Promise.allSettled(targets.map((p) => p.stop({ mode: 'graceful', reason, graceMs: grace }))),
        new Promise((r) => setTimeout(r, deadlineMs))
      ]);
      return targets.length;
    },

    supervise(makeSpec, policy) {
      const restartOn = policy.restartOn ?? ['crashed'];
      const history: number[] = [];
      let current: ManagedProcess | null = null;
      let restarts = 0;
      let stopped = false;
      let wake: (() => void) | null = null;
      const sleep = (ms: number): Promise<void> => new Promise((r) => {
        const t = setTimeout(() => { wake = null; r(); }, ms);
        wake = () => { clearTimeout(t); wake = null; r(); };
      });
      const done = (async () => {
        let restartOf: string | null = null;
        let attempt = 0;
        let id = ulid(now());
        for (;;) {
          const spec = makeSpec(attempt, restartOf);
          const started = startWithId(id, restartOf === null ? spec : { ...spec, restartOf });
          if (!started.ok) return { last: null, restarts, error: started.error };
          current = started.process;
          const last = await current.done;
          if (stopped || !restartOn.includes(last.status)) return { last, restarts, error: null };
          const t = now();
          while (history.length > 0 && (history[0] ?? 0) < t - policy.windowMs) history.shift();
          if (history.length >= policy.maxRestarts) {
            log.error('limite di riavvii raggiunto', { processId: last.processId, restarts: history.length, windowMs: policy.windowMs });
            return { last, restarts, error: runtimeError('restart_limit', `${history.length} riavvii in ${policy.windowMs} ms: limite raggiunto`) };
          }
          const delayMs = policy.backoffMs[Math.min(history.length, policy.backoffMs.length - 1)] ?? 0;
          history.push(t);
          attempt++;
          restarts++;
          restartOf = last.processId;
          id = ulid(now());
          events.emit('process.restarting', { processId: id, restartOf, attempt, delayMs }, { correlationId: current.correlationId, source: SOURCE, target: { kind: 'process', id } });
          await sleep(delayMs);
          if (stopped) return { last, restarts, error: null };
        }
      })();
      return {
        get current() {
          return current;
        },
        get restarts() {
          return restarts;
        },
        async stop(reason) {
          stopped = true;
          wake?.();
          if (current) await current.stop({ reason });
          await done;
        },
        done
      };
    },

    async reconcile() {
      const mine = new Set(processes.keys());
      const orphans = registry.live().filter((r) => !mine.has(r.id));
      const outcomes: Array<ReconcileReport['outcomes'][number]> = [];
      if (orphans.length === 0) return { checked: 0, outcomes };
      const osInfo = await tools.inspect(orphans.flatMap((r) => (r.pid === null ? [] : [r.pid])));
      for (const r of orphans) {
        let outcome: ReconcileReport['outcomes'][number]['outcome'];
        const os = r.pid === null ? undefined : osInfo.get(r.pid);
        if (r.pid === null || !os) {
          outcome = 'gone';
        } else {
          const expected = basename(r.exe, extname(r.exe)).toLowerCase();
          const reference = r.startedAt ?? r.createdAt;
          const sameName = os.name === '' || os.name === expected;
          const sameStart = os.startedAt === 0 || Math.abs(os.startedAt - reference) <= START_TOLERANCE_MS;
          if (!sameName || !sameStart) outcome = 'pid-reused';
          else outcome = (await tools.killTree(r.pid)) ? 'killed' : 'kill-failed';
        }
        outcomes.push({ processId: r.id, pid: r.pid, outcome });
        persist(
          () => registry.markLost(r.id, now(), 'unreachable', `core caduto mentre il processo era ${r.status}: ${outcome}`),
          () => events.emit('process.reconciled', { processId: r.id, pid: r.pid, outcome }, { source: SOURCE, target: { kind: 'process', id: r.id } })
        );
        log.warn('processo di un avvio precedente riconciliato', { processId: r.id, pid: r.pid, outcome });
      }
      return { checked: orphans.length, outcomes };
    },

    env(cwd, layers = {}) {
      return buildEnv({ ...layers, inherited: deps.inheritedEnv, cwd });
    }
  };

  const readVersion = async (cli: ResolvedCli, args: readonly string[]): Promise<string | null> => {
    deps.policy.allowExecutable(cli.exe);
    const res = await runtime.run({
      exe: cli.exe,
      args: [...cli.prefixArgs, ...args],
      cwd: deps.systemCwd,
      env: runtime.env(deps.systemCwd),
      io: 'pipes',
      kind: 'probe',
      correlationId: ulid(now()),
      runTimeoutMs: deps.versionTimeoutMs ?? 10_000,
      gracefulStop: 'none',
      emitOutput: false
    }, { maxChars: 4_000 });
    if (!res.ok || res.output.result.status !== 'exited') return null;
    const line = (res.output.stdout.trim() || res.output.stderr.trim()).split(/\r?\n/)[0] ?? '';
    return line === '' ? null : line.slice(0, 100);
  };

  (runtime as { discovery: CliDiscovery }).discovery = createCliDiscovery({
    env: deps.inheritedEnv,
    readVersion,
    onResult: (result) => {
      if (result.found) deps.policy.allowExecutable(result.exe);
      try {
        registry.saveCli(result, now());
      } catch (err) {
        log.error('installazione della CLI non registrata', { err });
      }
      deps.onCliResult?.(result);
    }
  });

  return runtime;
}

/** Evento terminale di un processo (per i consumatori del bus). */
export type ProcessEndEvent = TypedEvent<'process.exited' | 'process.failed' | 'process.crashed' | 'process.stopped' | 'process.timeout' | 'process.cancelled'>;
export const PROCESS_END_EVENT_TYPES = Object.values(END_EVENT);

/** Evento di uscita (per i consumatori del bus). */
export type ProcessOutputStream = OutputStream;
