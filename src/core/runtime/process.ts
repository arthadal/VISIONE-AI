// Processo gestito dal CLI Runtime: un solo stato alla volta, transizioni controllate, un solo
// esito terminale. Due modalità di I/O (MUNDER_CLI_RUNTIME §7-8): pipe (stdout/stderr separati,
// righe per i parser strutturati) e PTY (flusso unico, CLI interattive).
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  canProcessTransition,
  isTerminalProcessStatus,
  runtimeError,
  type ProcessInfo,
  type ProcessIo,
  type ProcessKind,
  type ProcessOwner,
  type ProcessStatus,
  type RuntimeError,
  type StopIntent
} from '../../shared/contracts/index.ts';
import { LineSplitter, TailBuffer, type Line } from './buffers.ts';
import type { ProcessTools } from './tree.ts';

export type OutputStream = 'stdout' | 'stderr' | 'pty';

/** Cosa avviare. Argomenti sempre come array: nessuna shell, mai `cmd.exe` (P-30). */
export interface ProcessSpec {
  readonly exe: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Ambiente già costruito con `buildEnv`. */
  readonly env: Readonly<Record<string, string>>;
  readonly io: ProcessIo;
  readonly pty?: { readonly cols: number; readonly rows: number };
  readonly kind: ProcessKind;
  readonly owner?: Partial<ProcessOwner>;
  readonly correlationId: string;
  /** Pipe: stdin aperto per scrivere (default chiuso). */
  readonly stdin?: 'pipe' | 'ignore';
  /** Tempo massimo fino al primo segnale di vita (output o uscita). */
  readonly startTimeoutMs?: number;
  /** Durata massima del processo. */
  readonly runTimeoutMs?: number;
  /** Grazia tra la richiesta gentile e il kill dell'albero (default dal runtime). */
  readonly stopGraceMs?: number;
  /** Richiesta gentile: chiudere stdin, Ctrl+C nel PTY, oppure nessuna (kill diretto). */
  readonly gracefulStop?: 'stdin-eof' | 'ctrl-c' | 'none';
  /** Avvii con la stessa chiave sono serializzati (motori con stato condiviso). */
  readonly queueKey?: string;
  /** Annullamento: termina il processo (o lo toglie dalla coda) con esito `cancelled`. */
  readonly signal?: AbortSignal;
  /** Eventi `process.stdout/stderr` sul bus (default true). I parser ricevono comunque tutto. */
  readonly emitOutput?: boolean;
  /** Processo che questo sostituisce (riavvio controllato). */
  readonly restartOf?: string;
}

export interface ProcessResult {
  readonly processId: string;
  readonly status: ProcessStatus;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error: RuntimeError | null;
  readonly durationMs: number | null;
  readonly tail: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export type StopOutcome =
  | { ok: true; result: ProcessResult; alreadyFinished: boolean }
  | { ok: false; error: RuntimeError };

export type OpResult = { ok: true } | { ok: false; error: RuntimeError };

export interface ManagedProcess {
  readonly id: string;
  readonly kind: ProcessKind;
  readonly io: ProcessIo;
  readonly owner: ProcessOwner;
  readonly correlationId: string;
  readonly pid: number | null;
  readonly status: ProcessStatus;
  /** Si risolve con l'esito terminale (mai rigettata). */
  readonly done: Promise<ProcessResult>;
  /** Righe complete (pipe) o blocchi grezzi (PTY), senza perdite: consegna sincrona. */
  onLine(listener: (line: Line, stream: OutputStream) => void): () => void;
  write(data: string): OpResult;
  closeInput(): OpResult;
  resize(cols: number, rows: number): OpResult;
  /** Stop ordinato (gentile → grazia → kill dell'albero). Idempotente. */
  stop(opts?: { mode?: 'graceful' | 'force'; reason?: string; graceMs?: number }): Promise<StopOutcome>;
  cancel(reason?: string): Promise<StopOutcome>;
  tail(): string;
  info(): ProcessInfo;
}

/** Notifiche verso il runtime (registro + eventi). Chiamate in ordine, una per transizione. */
export interface ProcessSink {
  created(p: ManagedProcess, spec: ProcessSpec): void;
  starting(p: ManagedProcess, waitedMs: number): void;
  started(p: ManagedProcess): void;
  output(p: ManagedProcess, stream: OutputStream, text: string): void;
  input(p: ManagedProcess, bytes: number): void;
  stopping(p: ManagedProcess, intent: StopIntent, mode: 'graceful' | 'force', reason: string): void;
  ended(p: ManagedProcess, result: ProcessResult): void;
}

/** Processo figlio astratto: pipe di Node o PTY. */
interface ChildBackend {
  readonly pid: number | undefined;
  write(data: string): boolean;
  endInput(): void;
  resize(cols: number, rows: number): void;
  /** Richiesta gentile (Ctrl+C nel PTY). */
  interrupt(): void;
}

interface BackendEvents {
  spawned(pid: number): void;
  spawnError(err: NodeJS.ErrnoException): void;
  data(stream: OutputStream, text: string): void;
  exited(code: number | null, signal: string | null): void;
}

export interface PtyModule {
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string>; useConpty?: boolean }): {
    readonly pid: number;
    onData(cb: (d: string) => void): { dispose(): void };
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
    write(d: string): void;
    resize(c: number, r: number): void;
  };
}

/** Dopo `exit`, attesa massima della chiusura dei flussi (un nipote può tenerli aperti). */
const CLOSE_WAIT_MS = 2_000;
/** Dopo l'uscita di un PTY, tempo per ricevere gli ultimi dati prima di liberare le risorse. */
const PTY_FLUSH_MS = 300;
/** Attesa massima dell'uscita dopo il kill dell'albero. */
const KILL_WAIT_MS = 5_000;

function pipesBackend(spec: ProcessSpec, ev: BackendEvents): ChildBackend {
  const child = spawnChild(spec.exe, [...spec.args], {
    cwd: spec.cwd,
    env: { ...spec.env },
    stdio: [spec.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  });
  let exited = false;
  let closed = false;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => ev.data('stdout', d));
  child.stderr?.on('data', (d: string) => ev.data('stderr', d));
  child.stdin?.on('error', () => undefined); // EPIPE dopo l'uscita: gestito da write()
  child.once('spawn', () => ev.spawned(child.pid ?? 0));
  child.once('error', (err: NodeJS.ErrnoException) => {
    if (child.pid === undefined) ev.spawnError(err);
  });
  const finish = (code: number | null, signal: string | null): void => {
    if (closed) return;
    closed = true;
    ev.exited(code, signal);
  };
  child.once('close', (code, signal) => finish(code, signal));
  child.once('exit', (code, signal) => {
    exited = true;
    // Un discendente può tenere aperti stdout/stderr: dopo un'attesa si chiudono da qui.
    setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(code, signal);
    }, CLOSE_WAIT_MS).unref();
  });
  return {
    get pid() {
      return child.pid;
    },
    write: (data) => (child.stdin && !child.stdin.writableEnded && !exited ? child.stdin.write(data) || true : false),
    endInput: () => {
      if (child.stdin && !child.stdin.writableEnded) child.stdin.end();
    },
    resize: () => undefined,
    interrupt: () => {
      if (child.stdin && !child.stdin.writableEnded) child.stdin.end();
    }
  };
}

function ptyBackend(pty: PtyModule, spec: ProcessSpec, ev: BackendEvents): ChildBackend {
  const term = pty.spawn(spec.exe, [...spec.args], {
    name: 'xterm-256color',
    cols: spec.pty?.cols ?? 120,
    rows: spec.pty?.rows ?? 30,
    cwd: spec.cwd,
    env: { ...spec.env },
    useConpty: true
  });
  let exited = false;
  const dataSub = term.onData((d) => ev.data('pty', d));
  const exitSub = term.onExit(({ exitCode, signal }) => {
    exited = true;
    setTimeout(() => {
      dataSub.dispose();
      exitSub.dispose();
      releasePty(term);
      ev.exited(exitCode, signal ? String(signal) : null);
    }, PTY_FLUSH_MS).unref();
  });
  setImmediate(() => ev.spawned(term.pid));
  return {
    pid: term.pid,
    write: (data) => {
      if (exited) return false;
      term.write(data);
      return true;
    },
    endInput: () => undefined,
    resize: (cols, rows) => {
      if (!exited) term.resize(cols, rows);
    },
    interrupt: () => {
      if (!exited) term.write('\x03');
    }
    // Nessun `kill()` di node-pty: il kill dell'albero termina il processo e la console ConPTY si
    // chiude con lui (misurato, P-31); `kill()` lancia un agente che fallisce se il processo sta
    // già uscendo (AttachConsole failed).
  };
}

/**
 * node-pty su Windows lascia aperti il worker di conout e il socket di ingresso dopo l'uscita
 * (verificato con la 1.1.0, P-31): si liberano qui, altrimenti il processo del core non esce.
 */
function releasePty(term: unknown): void {
  const agent = (term as { _agent?: { _conoutSocketWorker?: { dispose(): void }; _inSocket?: { destroy(): void }; _outSocket?: { destroy(): void } } })._agent;
  for (const release of [() => agent?._conoutSocketWorker?.dispose(), () => agent?._inSocket?.destroy(), () => agent?._outSocket?.destroy()]) {
    try {
      release();
    } catch {
      // già liberato
    }
  }
}

/** Uscita anomala su Windows: codici NTSTATUS (≥ 0xC0000000) e 134 (abort di Node, misurato). */
export function isCrashExit(code: number | null, signal: string | null): boolean {
  if (signal !== null) return true;
  if (code === null) return false;
  return code === 134 || code >>> 0 >= 0xc0000000;
}

export interface ManagedProcessDeps {
  readonly id: string;
  readonly spec: ProcessSpec;
  readonly sink: ProcessSink;
  readonly tools: ProcessTools;
  readonly loadPty: () => Promise<PtyModule>;
  readonly now: () => number;
  readonly defaultGraceMs: number;
  /** Attesa dell'uscita dopo il kill dell'albero prima di dichiararlo non raggiungibile. */
  readonly killWaitMs?: number;
}

const TERMINAL_BY_INTENT: Record<StopIntent, ProcessStatus> = { stop: 'stopped', timeout: 'timed_out', cancel: 'cancelled' };

/** Crea il processo nello stato `created`; `launch()` lo avvia (anche dopo un'attesa in coda). */
export function createManagedProcess(deps: ManagedProcessDeps): ManagedProcess & { launch(waitedMs: number): Promise<void> } {
  const { spec, sink, tools, now } = deps;
  const createdAt = now();
  const owner: ProcessOwner = {
    agentId: spec.owner?.agentId ?? null,
    sessionId: spec.owner?.sessionId ?? null,
    taskId: spec.owner?.taskId ?? null,
    adapter: spec.owner?.adapter ?? null
  };
  const listeners = new Set<(line: Line, stream: OutputStream) => void>();
  const splitters = { stdout: new LineSplitter(), stderr: new LineSplitter() };
  const tails = { stdout: new TailBuffer(4_096), stderr: new TailBuffer(16_384), pty: new TailBuffer(8_192) };
  let status: ProcessStatus = 'created';
  let pid: number | null = null;
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let exitInfo: { code: number | null; signal: string | null } = { code: null, signal: null };
  let error: RuntimeError | null = null;
  let intent: StopIntent | null = null;
  let backend: ChildBackend | null = null;
  let firstSignal = false;
  let stopping: Promise<StopOutcome> | null = null;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let resolveDone!: (r: ProcessResult) => void;
  const done = new Promise<ProcessResult>((r) => { resolveDone = r; });
  let exitWaiters: Array<() => void> = [];

  const setStatus = (to: ProcessStatus): void => {
    if (!canProcessTransition(status, to)) throw new Error(`transizione di processo non ammessa: ${status} → ${to}`);
    status = to;
  };

  const tailText = (): string => {
    const err = tails.stderr.text.trim();
    return (err !== '' ? err : (tails.pty.text || tails.stdout.text)).slice(-2_000);
  };

  const result = (): ProcessResult => ({
    processId: deps.id,
    status,
    pid,
    exitCode: exitInfo.code,
    signal: exitInfo.signal,
    error,
    durationMs: startedAt === null || endedAt === null ? null : endedAt - startedAt,
    tail: tailText(),
    stdoutBytes: tails.stdout.length + tails.pty.length,
    stderrBytes: tails.stderr.length
  });

  const clearTimers = (): void => {
    for (const t of timers.splice(0)) clearTimeout(t);
  };

  const finish = (target: ProcessStatus, err: RuntimeError | null): void => {
    if (isTerminalProcessStatus(status)) return;
    // Durante uno stop vince il motivo dello stop (es. avvio fallito mentre si chiudeva).
    const to = status === 'stopping' && !canProcessTransition(status, target) ? TERMINAL_BY_INTENT[intent ?? 'stop'] : target;
    clearTimers();
    spec.signal?.removeEventListener('abort', onAbort);
    error = err;
    endedAt = now();
    setStatus(to);
    const r = result();
    sink.ended(self, r);
    for (const w of exitWaiters.splice(0)) w();
    resolveDone(r);
  };

  const deliver = (stream: OutputStream, text: string): void => {
    if (!firstSignal) firstSignal = true;
    tails[stream].append(text);
    if (stream === 'pty') {
      // Il PTY è un flusso di terminale (sequenze ANSI): consegnato a blocchi, non a righe.
      for (const l of listeners) l({ text, partial: true }, 'pty');
    } else {
      for (const line of splitters[stream].push(text)) for (const l of listeners) l(line, stream);
    }
    if (spec.emitOutput !== false) sink.output(self, stream, text);
  };

  const onExit = (code: number | null, signal: string | null): void => {
    if (isTerminalProcessStatus(status)) return;
    for (const stream of ['stdout', 'stderr'] as const) {
      for (const line of splitters[stream].flush()) for (const l of listeners) l(line, stream);
    }
    exitInfo = { code, signal };
    if (intent !== null) {
      finish(TERMINAL_BY_INTENT[intent], intent === 'stop' ? null
        : intent === 'timeout' ? runtimeError('timeout', 'terminato per scadenza')
        : runtimeError('cancelled', 'terminato per annullamento'));
      return;
    }
    if (isCrashExit(code, signal)) {
      finish('crashed', runtimeError('crashed', `terminazione anomala (codice ${String(code)}, segnale ${String(signal)})`));
    } else if (code === 0) {
      finish('exited', null);
    } else {
      finish('failed', runtimeError('exit_nonzero', `uscito con codice ${String(code)}`));
    }
  };

  const spawnErrorOf = (err: NodeJS.ErrnoException): RuntimeError => {
    if (err.code === 'ENOENT') return runtimeError('not_found', `comando inesistente: ${spec.exe}`);
    if (err.code === 'EACCES' || err.code === 'EPERM') return runtimeError('permission_denied', `permessi insufficienti: ${err.message}`);
    return runtimeError('spawn_failed', `${err.code ?? 'errore'}: ${err.message}`);
  };

  const terminate = (why: StopIntent, mode: 'graceful' | 'force', reason: string, graceMs: number): Promise<StopOutcome> => {
    if (isTerminalProcessStatus(status)) return Promise.resolve({ ok: true, result: result(), alreadyFinished: true });
    if (stopping) return stopping;
    if (status === 'created') {
      // Ancora in coda: nessun processo da terminare, l'avvio non avverrà.
      intent = why;
      finish('cancelled', runtimeError('cancelled', `tolto dalla coda prima dell'avvio: ${reason}`));
      return Promise.resolve({ ok: true, result: result(), alreadyFinished: false });
    }
    intent = why;
    setStatus('stopping');
    clearTimers();
    sink.stopping(self, why, mode, reason);
    stopping = (async (): Promise<StopOutcome> => {
      const exitedWithin = (ms: number): Promise<boolean> => new Promise((resolve) => {
        if (isTerminalProcessStatus(status)) return resolve(true);
        const t = setTimeout(() => resolve(isTerminalProcessStatus(status)), ms);
        exitWaiters.push(() => {
          clearTimeout(t);
          resolve(true);
        });
      });
      const gentle = spec.gracefulStop ?? (spec.io === 'pty' ? 'ctrl-c' : 'stdin-eof');
      if (mode === 'graceful' && gentle !== 'none' && backend) {
        if (gentle === 'ctrl-c') backend.interrupt();
        else backend.endInput();
        if (await exitedWithin(graceMs)) return { ok: true, result: result(), alreadyFinished: false };
      }
      // Il processo è ancora vivo e il suo handle è aperto: il pid non può essere stato riusato.
      // Il kill dell'albero termina la radice e i discendenti (pipe e PTY).
      if (pid !== null) await tools.killTree(pid);
      if (await exitedWithin(deps.killWaitMs ?? KILL_WAIT_MS)) return { ok: true, result: result(), alreadyFinished: false };
      return { ok: false, error: runtimeError('unreachable', `il processo ${String(pid)} non è terminato dopo il kill dell'albero`) };
    })();
    return stopping;
  };

  const onAbort = (): void => {
    void terminate('cancel', 'force', typeof spec.signal?.reason === 'string' ? spec.signal.reason : 'annullato', 0);
  };

  const self: ManagedProcess & { launch(waitedMs: number): Promise<void> } = {
    id: deps.id,
    kind: spec.kind,
    io: spec.io,
    owner,
    correlationId: spec.correlationId,
    get pid() {
      return pid;
    },
    get status() {
      return status;
    },
    done,
    onLine(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    write(data) {
      if (status !== 'running' || !backend) return { ok: false, error: runtimeError('not_running', `processo ${status}`) };
      if (spec.io === 'pipes' && spec.stdin !== 'pipe') return { ok: false, error: runtimeError('stdin_closed', 'ingresso non aperto per questo processo') };
      if (!backend.write(data)) return { ok: false, error: runtimeError('stdin_closed', 'ingresso chiuso') };
      sink.input(self, Buffer.byteLength(data));
      return { ok: true };
    },
    closeInput() {
      if (status !== 'running' || !backend) return { ok: false, error: runtimeError('not_running', `processo ${status}`) };
      backend.endInput();
      return { ok: true };
    },
    resize(cols, rows) {
      if (spec.io !== 'pty') return { ok: false, error: runtimeError('invalid_spec', 'resize solo in modalità PTY') };
      if (status !== 'running' || !backend) return { ok: false, error: runtimeError('not_running', `processo ${status}`) };
      backend.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
      return { ok: true };
    },
    stop(opts = {}) {
      return terminate('stop', opts.mode ?? 'graceful', opts.reason ?? 'stop richiesto', opts.graceMs ?? spec.stopGraceMs ?? deps.defaultGraceMs);
    },
    cancel(reason = 'annullato') {
      return terminate('cancel', 'force', reason, 0);
    },
    tail: tailText,
    info: () => ({
      id: deps.id,
      pid,
      status,
      kind: spec.kind,
      io: spec.io,
      owner,
      exe: basename(spec.exe),
      cwd: spec.cwd,
      correlationId: spec.correlationId,
      createdAt,
      startedAt,
      endedAt,
      exitCode: exitInfo.code,
      signal: exitInfo.signal,
      error,
      restartOf: spec.restartOf ?? null
    }),

    async launch(waitedMs) {
      if (status !== 'created') return;
      if (spec.signal?.aborted) {
        finish('cancelled', runtimeError('cancelled', 'annullato prima dell\'avvio'));
        return;
      }
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      setStatus('starting');
      sink.starting(self, waitedMs);
      // Controlli che il sistema operativo riporterebbe in modo ambiguo (ENOENT per tutto).
      if (!existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory()) {
        finish('failed', runtimeError('cwd_missing', `cartella di lavoro inesistente: ${spec.cwd}`));
        return;
      }
      if (!existsSync(spec.exe)) {
        finish('failed', runtimeError('not_found', `comando inesistente: ${spec.exe}`));
        return;
      }
      if (/\.(cmd|bat)$/i.test(spec.exe)) {
        finish('failed', runtimeError('invalid_spec', 'script .cmd/.bat: richiedono cmd.exe, mai usato dal runtime (decodificare lo shim)'));
        return;
      }
      const events: BackendEvents = {
        spawned(p) {
          pid = p;
          startedAt = now();
          if (status === 'stopping') {
            // Stop chiesto mentre l'avvio era in corso: registrato e terminato subito.
            sink.started(self);
            void tools.killTree(p);
            return;
          }
          if (status !== 'starting') return;
          setStatus('running');
          sink.started(self);
          if (spec.startTimeoutMs !== undefined) {
            timers.push(setTimeout(() => {
              if (!firstSignal && status === 'running') void terminate('timeout', 'force', `nessun segnale entro ${spec.startTimeoutMs} ms`, 0);
            }, spec.startTimeoutMs));
          }
          if (spec.runTimeoutMs !== undefined) {
            timers.push(setTimeout(() => {
              if (status === 'running') void terminate('timeout', 'graceful', `durata massima di ${spec.runTimeoutMs} ms superata`, spec.stopGraceMs ?? deps.defaultGraceMs);
            }, spec.runTimeoutMs));
          }
        },
        spawnError(err) {
          finish('failed', spawnErrorOf(err));
        },
        data: deliver,
        exited: onExit
      };
      try {
        if (spec.io === 'pty') {
          let pty: PtyModule;
          try {
            pty = await deps.loadPty();
          } catch (err) {
            finish('failed', runtimeError('pty_unavailable', `PTY non disponibile: ${err instanceof Error ? err.message : String(err)}`));
            return;
          }
          if (isTerminalProcessStatus(status)) return; // annullato durante il caricamento
          backend = ptyBackend(pty, spec, events);
        } else {
          backend = pipesBackend(spec, events);
        }
      } catch (err) {
        finish('failed', spawnErrorOf(err as NodeJS.ErrnoException));
      }
    }
  };

  sink.created(self, spec);
  return self;
}
