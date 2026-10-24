// Supervisore del core (VISIONE_ARCHITECTURE §4): avvio, handshake `ready`, heartbeat, rilevamento
// dei crash, riavvio con backoff e limite, spegnimento cooperativo. Non importa `electron`: il
// processo arriva da una factory (utilityProcess nel prodotto, child_process nei test).
import {
  coreToMainFrameSchema,
  formatIssues,
  type CoreState,
  type CoreToMainFrame,
  type EventPayload,
  type EventType,
  type MainToCoreFrameBody,
  type SupervisorSnapshot
} from '../shared/contracts/index.ts';
import type { VisioneConfig } from '../shared/node/config.ts';
import type { Logger } from '../shared/node/logging.ts';

export interface CoreProcess {
  send(frame: MainToCoreFrameBody): void;
  kill(): void;
  onSpawn(listener: (pid: number) => void): void;
  onMessage(listener: (raw: unknown) => void): void;
  onExit(listener: (code: number | null) => void): void;
  onStderr(listener: (text: string) => void): void;
}

export type CoreProcessFactory = () => CoreProcess;

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
};

/** Eventi `core.*` prodotti dal supervisore. */
export type SupervisorEventType = Extract<EventType, `core.${string}`>;
export type EmitSupervisorEvent = <T extends SupervisorEventType>(type: T, payload: EventPayload<T>) => void;

export interface SupervisorDeps {
  factory: CoreProcessFactory;
  config: VisioneConfig['supervisor'];
  appVersion: string;
  log: Logger;
  emit: EmitSupervisorEvent;
  /** Frame applicativi dal core: risposte, eventi, conferme di ingest. */
  onFrame: (frame: Extract<CoreToMainFrame, { kind: 'res' | 'evt' | 'ingested' | 'voice' }>) => void;
  onStateChange: (snapshot: SupervisorSnapshot) => void;
  timers?: Timers;
}

type CrashReason = EventPayload<'core.crashed'>['reason'];

const STDERR_TAIL = 2_000;
/**
 * Tempo massimo perché il processo del core esista (evento spawn). Su un PC appena installato Windows controlla
 * l'eseguibile nuovo prima di farlo partire: nella VM da «vergine» (22/10/2026) fino a un minuto e mezzo.
 */
const SPAWN_TIMEOUT_MS = 120_000;

export class CoreSupervisor {
  private readonly deps: SupervisorDeps;
  private readonly t: Timers;
  private state: CoreState = 'stopped';
  private since: number;
  private proc: CoreProcess | null = null;
  private pid: number | null = null;
  private stderrTail = '';
  private lastFatal: string | null = null;
  private crashTimes: number[] = [];
  private totalRestarts = 0;
  private downSince: number | null = null;
  private nextRestartAt: number | null = null;
  private lastExit: SupervisorSnapshot['lastExit'] = null;
  private lastAck = 0;
  private hbCounter = 0;
  private stopReason = 'stop';
  private stopWaiters: Array<() => void> = [];
  private startTimer: unknown = null;
  private hbTimer: unknown = null;
  private restartTimer: unknown = null;
  private killTimer: unknown = null;

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
    this.t = deps.timers ?? realTimers;
    this.since = this.t.now();
  }

  snapshot(): SupervisorSnapshot {
    return {
      state: this.state,
      since: this.since,
      pid: this.pid,
      appVersion: this.deps.appVersion,
      restartsInWindow: this.crashTimes.length,
      totalRestarts: this.totalRestarts,
      nextRestartAt: this.nextRestartAt,
      lastExit: this.lastExit
    };
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  /** Avvia il core. Da `failed` è un riavvio manuale: il contatore dei crash riparte. */
  start(): void {
    if (this.state !== 'stopped' && this.state !== 'failed') return;
    this.crashTimes = [];
    this.spawn('starting');
  }

  /** Invia un frame solo se il core è pronto. */
  send(frame: MainToCoreFrameBody): boolean {
    if (this.state !== 'ready' || !this.proc) return false;
    try {
      this.proc.send(frame);
      return true;
    } catch (err) {
      this.deps.log.warn('invio al core fallito', { err, kind: frame.kind });
      return false;
    }
  }

  stop(reason: string, deadlineMs: number = this.deps.config.stopTimeoutMs): Promise<void> {
    if (this.state === 'stopped') return Promise.resolve();
    const done = new Promise<void>((resolve) => this.stopWaiters.push(resolve));
    if (this.state === 'stopping') return done;

    this.stopReason = reason;
    this.clearTimer('restartTimer');
    this.nextRestartAt = null;
    const proc = this.proc;
    if (!proc) {
      // crashed / recovering in attesa / failed: nessun processo da fermare.
      this.setState('stopped');
      this.deps.emit('core.stopped', { pid: null, exitCode: null, reason });
      this.resolveStop();
      return done;
    }
    const wasReady = this.state === 'ready';
    this.clearProcTimers();
    this.setState('stopping');
    if (wasReady) {
      proc.send({ kind: 'shutdown', reason, deadlineMs: Math.max(1_000, deadlineMs - 2_000) });
    } else {
      proc.kill();
    }
    this.killTimer = this.t.setTimeout(() => {
      this.deps.log.warn('il core non si è fermato entro la scadenza: terminazione forzata', { deadlineMs });
      proc.kill();
    }, deadlineMs);
    return done;
  }

  private spawn(state: 'starting' | 'recovering'): void {
    this.setState(state);
    this.stderrTail = '';
    this.lastFatal = null;
    let proc: CoreProcess;
    try {
      proc = this.deps.factory();
    } catch (err) {
      this.failure(null, 'spawn-error', null, err instanceof Error ? err.message : String(err));
      return;
    }
    this.proc = proc;
    const attempt = this.totalRestarts;
    proc.onSpawn((pid) => {
      // Un core già abbandonato che parte dopo (VM da «vergine», 22/10/2026: Windows lo ha tenuto fermo oltre la
      // scadenza) si chiude subito: due core sullo stesso database si bloccano a vicenda.
      if (this.proc !== proc) {
        this.killStale(proc, pid);
        return;
      }
      this.pid = pid;
      this.deps.log.info('core avviato', { pid, attempt });
      this.deps.emit('core.started', { pid, attempt });
      // Il tempo per il «ready» si conta da quando il processo esiste: prima Windows può tenerlo fermo.
      this.clearTimer('startTimer');
      this.startTimer = this.t.setTimeout(
        () => this.failure(proc, 'start-timeout', null, `nessun segnale ready entro ${this.deps.config.startTimeoutMs} ms`),
        this.deps.config.startTimeoutMs
      );
    });
    proc.onMessage((raw) => this.onMessage(proc, raw));
    proc.onExit((code) => this.onExit(proc, code));
    proc.onStderr((text) => {
      if (this.proc === proc) this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL);
    });
    const spawnLimit = Math.max(SPAWN_TIMEOUT_MS, this.deps.config.startTimeoutMs);
    this.startTimer = this.t.setTimeout(
      () => this.failure(proc, 'start-timeout', null, `processo del core non partito entro ${spawnLimit} ms`),
      spawnLimit
    );
  }

  private killStale(proc: CoreProcess, pid: number | null): void {
    this.deps.log.warn('core di un avvio abbandonato: chiuso', { pid });
    try {
      proc.kill();
    } catch (err) {
      this.deps.log.warn('kill del core abbandonato fallito', { err });
    }
  }

  private onMessage(proc: CoreProcess, raw: unknown): void {
    if (this.proc !== proc) {
      // Un core che non è più quello attuale e parla ancora è vivo per errore: si chiude.
      const frame = coreToMainFrameSchema.safeParse(raw);
      if (frame.success && frame.data.kind === 'ready') this.killStale(proc, frame.data.pid);
      return;
    }
    const parsed = coreToMainFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.log.warn('frame non valido dal core', { issues: formatIssues(parsed.error) });
      return;
    }
    const frame = parsed.data;
    switch (frame.kind) {
      case 'ready': {
        if (this.state !== 'starting' && this.state !== 'recovering') return;
        this.clearTimer('startTimer');
        const recovered = this.state === 'recovering';
        this.pid = frame.pid;
        this.lastAck = this.t.now();
        this.setState('ready');
        this.startHeartbeat(proc);
        this.deps.emit('core.ready', { pid: frame.pid, startupMs: frame.startupMs });
        if (recovered) {
          this.deps.emit('core.restarted', {
            pid: frame.pid,
            attempt: this.totalRestarts,
            downtimeMs: this.downSince === null ? 0 : this.t.now() - this.downSince
          });
        }
        this.downSince = null;
        return;
      }
      case 'hb-ack':
        this.lastAck = this.t.now();
        return;
      case 'fatal':
        this.lastFatal = frame.message;
        this.deps.log.error('il core segnala un errore fatale', { message: frame.message });
        return;
      case 'stopped':
        this.deps.log.info('il core conferma lo spegnimento');
        return;
      case 'res':
      case 'evt':
      case 'ingested':
      case 'voice':
        this.deps.onFrame(frame);
        return;
    }
  }

  private onExit(proc: CoreProcess, code: number | null): void {
    if (this.proc !== proc) return; // processo già sostituito (es. ucciso per timeout)
    this.clearProcTimers();
    this.clearTimer('killTimer');
    this.proc = null;
    const pid = this.pid;
    this.pid = null;
    if (this.state === 'stopping') {
      this.lastExit = { at: this.t.now(), code, reason: this.stopReason };
      this.setState('stopped');
      this.deps.log.info('core fermato', { pid, code });
      this.deps.emit('core.stopped', { pid, exitCode: code, reason: this.stopReason });
      this.resolveStop();
      return;
    }
    this.pid = pid;
    this.failure(null, 'exit', code, this.lastFatal ?? `uscita inattesa con codice ${String(code)}`);
  }

  /** Crash, timeout di avvio o di heartbeat: registra, poi riavvia con backoff o si arrende. */
  private failure(proc: CoreProcess | null, reason: CrashReason, code: number | null, detail: string): void {
    if (proc) {
      if (this.proc !== proc) return;
      this.clearProcTimers();
      this.proc = null;
      try {
        proc.kill();
      } catch (err) {
        this.deps.log.warn('kill del core fallito', { err });
      }
    }
    const now = this.t.now();
    const pid = this.pid;
    this.pid = null;
    this.downSince ??= now;
    this.crashTimes = this.crashTimes.filter((at) => now - at < this.deps.config.restartWindowMs);
    this.crashTimes.push(now);
    const restartsInWindow = this.crashTimes.length;
    const willRestart = restartsInWindow <= this.deps.config.maxRestarts;
    const backoff = this.deps.config.backoffMs;
    const delay = willRestart ? (backoff[Math.min(restartsInWindow - 1, backoff.length - 1)] ?? 0) : null;

    this.lastExit = { at: now, code, reason };
    this.setState('crashed');
    this.deps.log.error('crash del core', { pid, code, reason, detail, restartsInWindow, willRestart, delay });
    this.deps.emit('core.crashed', {
      pid,
      exitCode: code,
      reason,
      detail: detail.slice(0, 2_000),
      stderrTail: this.stderrTail.slice(-STDERR_TAIL),
      restartsInWindow,
      willRestart,
      nextDelayMs: delay
    });

    if (delay === null) {
      this.setState('failed');
      return;
    }
    this.totalRestarts++;
    this.nextRestartAt = now + delay;
    this.setState('recovering');
    this.restartTimer = this.t.setTimeout(() => {
      this.restartTimer = null;
      this.nextRestartAt = null;
      this.spawn('recovering');
    }, delay);
  }

  private startHeartbeat(proc: CoreProcess): void {
    const { heartbeatIntervalMs, heartbeatTimeoutMs } = this.deps.config;
    let lastTick = this.t.now();
    this.hbTimer = this.t.setInterval(() => {
      if (this.proc !== proc || this.state !== 'ready') return;
      const now = this.t.now();
      // Il controllo stesso è arrivato in ritardo (collaudo in VM del 24/10/2026: macchina ferma per un minuto e
      // poi ripartita; lo stesso al risveglio dallo standby): il silenzio misura il fermo di tutto il PC, non un
      // core bloccato. Si riparte a contare da adesso invece di uccidere un core sano.
      if (now - lastTick > heartbeatIntervalMs + heartbeatTimeoutMs / 2) this.lastAck = now;
      lastTick = now;
      const silent = now - this.lastAck;
      if (silent > heartbeatTimeoutMs) {
        this.failure(proc, 'heartbeat-timeout', null, `nessun heartbeat da ${silent} ms`);
        return;
      }
      this.hbCounter++;
      proc.send({ kind: 'hb', n: this.hbCounter });
    }, heartbeatIntervalMs);
  }

  private setState(state: CoreState): void {
    if (state === this.state) return;
    this.state = state;
    this.since = this.t.now();
    this.deps.onStateChange(this.snapshot());
  }

  private resolveStop(): void {
    const waiters = this.stopWaiters;
    this.stopWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private clearProcTimers(): void {
    this.clearTimer('startTimer');
    if (this.hbTimer !== null) {
      this.t.clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  private clearTimer(name: 'startTimer' | 'restartTimer' | 'killTimer'): void {
    if (this[name] !== null) {
      this.t.clearTimeout(this[name]);
      this[name] = null;
    }
  }
}
