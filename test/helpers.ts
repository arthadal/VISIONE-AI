// Utilità comuni dei test: home temporanee, logger in memoria, orologio finto.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inject } from 'vitest';
import { createLogger, type LogRecord, type Logger } from '../src/shared/node/logging.ts';
import type { Timers } from '../src/main/supervisor.ts';

// 17/10/2026: in %TEMP% c'erano 3.349 cartelle visione-* (1,25 GB) lasciate dai test dal 05/10. Ogni home
// di `tempHome` si registra qui e si cancella a fine file anche se il test fallisce o non chiama `cleanup()`
// (test/setup.ts); la corsa intera vive in una cartella sua che si cancella alla fine (test/global-setup.ts).
// Fuori da qui niente mkdtemp nei test: lo blocca tools/check-repo.mjs.
const created = new Set<string>();

// Su Windows SQLite ed Electron tengono i file aperti ancora qualche istante: si riprova.
const remove = (dir: string): void => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

export function tempHome(prefix = 'visione-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(inject('visioneTempRoot') ?? tmpdir(), prefix));
  created.add(dir);
  return { dir, cleanup: () => { remove(dir); created.delete(dir); } };
}

/** Cancella le home di `tempHome` ancora presenti; restituisce quelle che non si riesce a cancellare. */
export function cleanupTempHomes(): string[] {
  const left: string[] = [];
  for (const dir of [...created]) {
    try {
      remove(dir);
      created.delete(dir);
    } catch {
      left.push(dir);
    }
  }
  return left;
}

export function memoryLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): { log: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const log = createLogger({ proc: 'test', level, sinks: [{ write: (line) => records.push(JSON.parse(line) as LogRecord) }] });
  return { log, records };
}

interface Task {
  id: number;
  at: number;
  fn: () => void;
  every: number | null;
}

/** Orologio e timer deterministici: il tempo avanza solo con `advance`. */
export class FakeTimers implements Timers {
  private t = 1_700_000_000_000;
  private seq = 0;
  private tasks = new Map<number, Task>();

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.tasks.set(id, { id, at: this.t + ms, fn, every: null });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.tasks.set(id, { id, at: this.t + ms, fn, every: ms });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.tasks.delete(handle as number);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.tasks.values()].filter((task) => task.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.t = next.at;
      if (next.every === null) this.tasks.delete(next.id);
      else next.at += next.every;
      next.fn();
    }
    this.t = end;
  }
  /** L'orologio salta avanti senza che nessun timer scatti nel mezzo (PC sospeso o macchina virtuale ferma). */
  jump(ms: number): void {
    this.t += ms;
    for (const task of this.tasks.values()) if (task.at < this.t) task.at = this.t;
  }
  get pending(): number {
    return this.tasks.size;
  }
}
