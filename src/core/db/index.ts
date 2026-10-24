// SQLite locale tramite `node:sqlite` (DECISIONI P-18), dietro l'interfaccia `Db`.
// WAL, foreign_keys, busy_timeout; transazioni esplicite; migrazioni append-only su user_version.
import { existsSync, renameSync } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MIGRATIONS, type Migration } from './migrations.ts';

export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface Statement {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
}

export interface Db {
  readonly file: string;
  exec(sql: string): void;
  prepare(sql: string): Statement;
  /** Esegue `fn` in una transazione IMMEDIATE; annidata = stessa transazione. */
  transaction<T>(fn: () => T): T;
  /** Una transazione di `transaction` è aperta (un errore va propagato, non assorbito). */
  readonly inTransaction: boolean;
  userVersion(): number;
  /** `PRAGMA quick_check`: 'ok' oppure il primo problema trovato. */
  quickCheck(): string;
  close(): void;
}

function wrap(stmt: StatementSync): Statement {
  return {
    run: (...params) => {
      const r = stmt.run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get: (...params) => stmt.get(...params) as Row | undefined,
    all: (...params) => stmt.all(...params) as Row[]
  };
}

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
  } catch (err) {
    // Il file resta libero (rinominabile) anche se non è un database.
    db.close();
    throw err;
  }
  let depth = 0;
  // Cache dei prepared statement (Fase 17): le letture dinamiche (filtri del journal, liste) usano
  // sempre le stesse forme SQL; ricompilarle a ogni chiamata costa. Il limite evita una cache infinita.
  const statements = new Map<string, Statement>();
  const MAX_CACHED = 128;
  const prepare = (sql: string): Statement => {
    const cached = statements.get(sql);
    if (cached) return cached;
    const stmt = wrap(db.prepare(sql));
    if (statements.size >= MAX_CACHED) {
      const oldest = statements.keys().next().value;
      if (oldest !== undefined) statements.delete(oldest);
    }
    statements.set(sql, stmt);
    return stmt;
  };
  return {
    file,
    exec: (sql) => db.exec(sql),
    prepare,
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    get inTransaction() {
      return depth > 0;
    },
    userVersion: () => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
    quickCheck: () => String(Object.values(db.prepare('PRAGMA quick_check(1)').get() ?? { r: 'nessun risultato' })[0]),
    close: () => {
      if (!db.isOpen) return;
      statements.clear();
      try {
        db.exec('PRAGMA optimize');
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
    }
  };
}

export interface MigrationOutcome {
  from: number;
  to: number;
  applied: number[];
  backupFile: string | null;
}

export interface MigrateOptions {
  migrations?: readonly Migration[];
  /** Percorso del backup da creare prima di migrare un database non vuoto; null = nessun backup. */
  backupFile?: (fromVersion: number) => string | null;
}

/**
 * Applica le migrazioni mancanti, ciascuna in una transazione insieme a `user_version`.
 * Rifiuta un database creato da una versione più recente di VISIONE.
 */
export function migrate(db: Db, opts: MigrateOptions = {}): MigrationOutcome {
  const migrations = opts.migrations ?? MIGRATIONS;
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  const from = db.userVersion();
  if (from > latest) {
    throw new Error(`database alla versione ${from}, più recente di quella supportata (${latest})`);
  }
  const pending = migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return { from, to: from, applied: [], backupFile: null };

  let backupFile: string | null = null;
  if (from > 0 && opts.backupFile) {
    backupFile = opts.backupFile(from);
    if (backupFile !== null) db.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`);
  }
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.up);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return { from, to: db.userVersion(), applied: pending.map((m) => m.version), backupFile };
}

export interface OpenOutcome {
  db: Db;
  migration: MigrationOutcome;
  /** Nome del file messo da parte perché illeggibile (null = nessuna quarantena). */
  quarantined: string | null;
  quarantineReason: string | null;
}

/** Errori di SQLite che indicano un file illeggibile, non un problema temporaneo (lock, permessi). */
const CORRUPTION = /SQLITE_(CORRUPT|NOTADB)|file is not a database|malformed|corrupt/i;

export function isCorruption(err: unknown): boolean {
  return CORRUPTION.test(err instanceof Error ? `${(err as { code?: string }).code ?? ''} ${err.message}` : String(err));
}

/**
 * Apre e migra il database. Se il file è corrotto o non è un database lo rinomina in
 * `<file>.corrupt-<ts>` (con -wal e -shm, mai cancellato) e ne crea uno nuovo. Gli altri errori
 * (file bloccato, permessi, versione futura) si propagano: il core non parte e il supervisore
 * riprova con backoff.
 */
export function openDatabase(file: string, opts: MigrateOptions & { now?: () => number } = {}): OpenOutcome {
  const now = opts.now ?? Date.now;
  const attempt = (): { db: Db; migration: MigrationOutcome } => {
    const db = openDb(file);
    try {
      if (db.userVersion() > 0) {
        const check = db.quickCheck();
        if (check !== 'ok') throw Object.assign(new Error(`database corrotto: ${check}`), { code: 'SQLITE_CORRUPT' });
      }
      return { db, migration: migrate(db, opts) };
    } catch (err) {
      try {
        db.close();
      } catch {
        // chiusura best-effort di un file già illeggibile
      }
      throw err;
    }
  };
  try {
    return { ...attempt(), quarantined: null, quarantineReason: null };
  } catch (err) {
    if (!isCorruption(err)) throw err;
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const target = `${file}.corrupt-${now()}`;
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(file + suffix)) renameSync(file + suffix, target + suffix);
    }
    return { ...attempt(), quarantined: basename(target), quarantineReason: reason };
  }
}

export { MIGRATIONS, type Migration } from './migrations.ts';
