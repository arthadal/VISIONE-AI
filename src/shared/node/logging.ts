// Logger strutturato JSONL, condiviso da main e core (un file per processo).
// Riga: {ts, level, proc, module, msg, correlationId?, data?}. Messaggi e dati passano dalla
// redazione dei segreti. Il logging non deve MAI far cadere il processo: errori di scrittura
// sincroni e `error` asincroni dei canali (es. EPIPE quando il processo padre — console/npm/e2e —
// non c'è più, P-97) vengono assorbiti; il console sink può ripiegare su un file.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactString, redactValue } from '../lib/redact.ts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(module: string): Logger;
}

export interface LogSink {
  write(line: string): void;
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  proc: string;
  module: string;
  msg: string;
  correlationId?: string;
  data?: unknown;
}

export interface LoggerOptions {
  proc: string;
  level: LogLevel;
  sinks: readonly LogSink[];
  module?: string;
  now?: () => number;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export function createLogger(opts: LoggerOptions): Logger {
  const now = opts.now ?? Date.now;
  const make = (module: string): Logger => {
    const log = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
      if (RANK[level] < RANK[opts.level]) return;
      const record: LogRecord = { ts: new Date(now()).toISOString(), level, proc: opts.proc, module, msg: redactString(msg) };
      if (data !== undefined) {
        const { correlationId, ...rest } = data;
        if (typeof correlationId === 'string') record.correlationId = correlationId;
        if (Object.keys(rest).length > 0) record.data = redactValue(rest);
      }
      let line: string;
      try {
        line = JSON.stringify(record);
      } catch {
        line = JSON.stringify({ ...record, data: '[non serializzabile]' });
      }
      for (const sink of opts.sinks) {
        try {
          sink.write(line);
        } catch {
          // Un sink rotto non deve far cadere il logger (né scrivere su stderr: anche quello può
          // essere un pipe chiuso, P-97). Gli altri sink continuano a ricevere la riga.
        }
      }
    };
    return {
      debug: (msg, data) => log('debug', msg, data),
      info: (msg, data) => log('info', msg, data),
      warn: (msg, data) => log('warn', msg, data),
      error: (msg, data) => log('error', msg, data),
      child: (name) => make(module === '' ? name : `${module}/${name}`)
    };
  };
  return make(opts.module ?? '');
}

export interface FileSinkOptions {
  maxBytes?: number;
  maxFiles?: number;
}

/** `<dir>/<proc>.jsonl` con rotazione per dimensione (default 10 MB × 5 file). */
export function createFileSink(dir: string, proc: string, opts: FileSinkOptions = {}): LogSink {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 5;
  const file = join(dir, `${proc}.jsonl`);
  mkdirSync(dir, { recursive: true });
  let size = existsSync(file) ? statSync(file).size : 0;

  const rotate = (): void => {
    rmSync(join(dir, `${proc}.${maxFiles}.jsonl`), { force: true });
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = join(dir, `${proc}.${i}.jsonl`);
      if (existsSync(from)) renameSync(from, join(dir, `${proc}.${i + 1}.jsonl`));
    }
    if (existsSync(file)) renameSync(file, join(dir, `${proc}.1.jsonl`));
    size = 0;
  };

  return {
    write(line: string): void {
      const bytes = Buffer.byteLength(line) + 1;
      if (size > 0 && size + bytes > maxBytes) rotate();
      appendFileSync(file, `${line}\n`);
      size += bytes;
    }
  };
}

/** Canale di uscita minimo: basta `write`; i canali reali di Node hanno anche `on` e i flag. */
export interface OutputStream {
  write(chunk: string): boolean;
  on?(event: 'error', listener: (err: unknown) => void): unknown;
  readonly destroyed?: boolean;
  readonly writable?: boolean;
  readonly writableEnded?: boolean;
}

export interface ConsoleSinkOptions {
  /** Canale ordinario (default `process.stdout`). */
  stdout?: OutputStream;
  /** Canale di warn/error (default `process.stderr`). */
  stderr?: OutputStream;
  /** Ripiego quando il canale è rotto (es. il file del main): opzionale, scritto senza mai lanciare. */
  fallback?: LogSink;
}

/** Canale marcato rotto (EPIPE/ERR_STREAM_DESTROYED o distrutto): condiviso fra sink e guardie. */
const CANALI_ROTTI = new WeakSet<object>();
/** Canali già protetti con un listener `error`: si registra UNA volta, mai listener duplicati. */
const CANALI_PROTETTI = new WeakSet<object>();

/** L'errore è la rottura di un pipe/canale (il caso reale: processo padre scomparso, P-97). */
export function isBrokenPipeError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END';
}

function streamConsumabile(stream: OutputStream): boolean {
  return !CANALI_ROTTI.has(stream) && stream.destroyed !== true && stream.writable !== false && stream.writableEnded !== true;
}

/**
 * Scudo sui canali standard: assorbe gli `error` asincroni (EPIPE ecc.) che altrimenti diventano
 * un'eccezione non gestita → dialogo di errore Electron. Idempotente. Da chiamare nel main prima
 * di qualunque scrittura; il console sink lo applica da sé.
 */
export function guardOutputStreams(streams: readonly OutputStream[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    if (typeof stream.on !== 'function' || CANALI_PROTETTI.has(stream)) continue;
    CANALI_PROTETTI.add(stream);
    stream.on('error', (err) => {
      // Mai rilanciare: il canale è rotto e va solo marcato (le righe successive useranno il ripiego).
      CANALI_ROTTI.add(stream);
      void err;
    });
  }
}

/**
 * Copia leggibile su stdout/stderr (sviluppo), ROBUSTA per costruzione (P-97):
 * - l'`error` asincrono del canale (EPIPE quando la console/padre non c'è più) viene assorbito;
 * - `write` è in try/catch: un canale rotto viene marcato, mai propagato;
 * - una riga non JSON non impedisce l'uscita;
 * - con `fallback` la riga continua a essere registrata quando il canale è rotto.
 */
export function createConsoleSink(opts: ConsoleSinkOptions = {}): LogSink {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  guardOutputStreams([out, err]);

  const ripiego = (line: string): void => {
    if (!opts.fallback) return;
    try {
      opts.fallback.write(line);
    } catch {
      // anche il ripiego può fallire (disco pieno): mai lanciare dal logging
    }
  };

  return {
    write(line: string): void {
      let level: LogLevel = 'info';
      try {
        level = (JSON.parse(line) as LogRecord).level;
      } catch {
        // riga non JSON: esce comunque, sul canale ordinario
      }
      const target = level === 'error' || level === 'warn' ? err : out;
      if (!streamConsumabile(target)) {
        ripiego(line);
        return;
      }
      try {
        target.write(`${line}\n`);
      } catch {
        // Qualunque errore sincrono del canale (EPIPE compreso): il canale è rotto, riga sul ripiego.
        CANALI_ROTTI.add(target);
        ripiego(line);
      }
    }
  };
}
