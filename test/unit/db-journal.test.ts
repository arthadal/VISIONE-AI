import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventBus } from '../../src/core/bus/index.ts';
import { MIGRATIONS, migrate, openDb, type Db, type Migration } from '../../src/core/db/index.ts';
import { createEventEmitter } from '../../src/core/events/index.ts';
import { createJournal } from '../../src/core/journal/index.ts';
import { createEvent, type VisioneEvent } from '../../src/shared/contracts/index.ts';
import { tempHome } from '../helpers.ts';

const cleanups: Array<() => void> = [];
const open: Db[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
  while (cleanups.length > 0) cleanups.pop()?.();
});
function dbFile(): string {
  const h = tempHome();
  cleanups.push(h.cleanup);
  return join(h.dir, 'visione.db');
}
function openTracked(file: string): Db {
  const db = openDb(file);
  open.push(db);
  return db;
}

describe('migrazioni SQLite', () => {
  it('da database vuoto: migrazioni 1-16 (journal, idempotenza, indici, processi, orchestrazione, memoria, telemetria, identità, riconciliazione istanze, promemoria, addestramento, mappa del codice, timer e liste, gusti sulle battute, chat di gruppo, gruppi degli agenti, chat svuotate), poi idempotente', () => {
    const db = openTracked(dbFile());
    const outcome = migrate(db);
    expect(outcome).toEqual({ from: 0, to: 16, applied: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], backupFile: null });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    expect(tables).toEqual([
      'agent_definitions', 'agent_instances', 'agent_sessions', 'approvals', 'audit_log', 'chat_cleared', 'chat_group_jobs', 'chat_group_messages', 'chat_groups', 'cli_installations', 'code_edges', 'code_files', 'code_roots', 'code_symbols', 'events', 'idempotency', 'list_items',
      'memory_fts', 'memory_fts_config', 'memory_fts_data', 'memory_fts_docsize', 'memory_fts_idx', 'memory_items',
      'messages', 'processes', 'quip_feedback', 'reminders', 'skills', 'task_dependencies', 'task_results', 'tasks', 'telemetry_minutes', 'turns'
    ]);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'events_%' ORDER BY name").all().map((r) => r.name);
    expect(indexes).toEqual(['events_corr', 'events_errors', 'events_target', 'events_type_seq', 'events_type_ts']);
    expect(String(db.prepare('PRAGMA journal_mode').get()?.journal_mode)).toBe('wal');
    expect(migrate(db).applied).toEqual([]); // già applicata
  });

  it('database della Fase 3 (versione 1): backup, poi migrazioni 2-16 con i dati intatti', () => {
    const file = dbFile();
    const db = openTracked(file);
    migrate(db, { migrations: MIGRATIONS.filter((m) => m.version === 1) });
    const kept = createEvent('app.shutdown', { reason: 'fase 3' });
    db.transaction(() => createJournal(db).append([kept]));
    const backup = join(file, '..', 'backup-v1.db');
    const outcome = migrate(db, { backupFile: () => backup });
    expect(outcome).toMatchObject({ from: 1, to: 16, applied: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], backupFile: backup });
    expect(existsSync(backup)).toBe(true);
    const old = openTracked(backup);
    expect(old.userVersion()).toBe(1);
    expect(createJournal(db).get(kept.id)).toEqual({ ...kept, seq: 1 });
  });

  it('la migrazione 12 ricostruisce i promemoria senza perderne uno e accetta timer e ricorrenze', () => {
    const db = openTracked(dbFile());
    migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 11) });
    db.prepare("INSERT INTO reminders (id, text, kind, due_at, notify_at, status, source, created_at, updated_at, fired_at) VALUES ('r1', 'Dentista', 'appointment', 2, 1, 'pending', 'voice', 1, 1, NULL)").run();
    migrate(db);
    expect(db.userVersion()).toBe(16);
    expect(db.prepare('SELECT id, text, kind, status, repeat FROM reminders').all()).toEqual([{ id: 'r1', text: 'Dentista', kind: 'appointment', status: 'pending', repeat: null }]);
    db.prepare("INSERT INTO reminders (id, text, kind, due_at, notify_at, status, source, created_at, updated_at, fired_at, repeat) VALUES ('r2', 'Pasta', 'timer', 3, 3, 'pending', 'ui', 1, 1, NULL, 'daily')").run();
    expect(() => db.prepare("INSERT INTO reminders (id, text, kind, due_at, notify_at, status, source, created_at, updated_at, fired_at, repeat) VALUES ('r3', 'x', 'timer', 3, 3, 'pending', 'ui', 1, 1, NULL, 'mensile')").run()).toThrow();
  });

  it('una migrazione fallita non lascia modifiche parziali', () => {
    const db = openTracked(dbFile());
    migrate(db);
    const broken: Migration = { version: 17, name: 'rotta', up: 'CREATE TABLE a (x INTEGER); CREATE TABLE a (y INTEGER);' };
    expect(() => migrate(db, { migrations: [...MIGRATIONS, broken] })).toThrow();
    expect(db.userVersion()).toBe(16);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'a'").get()?.n).toBe(0);
  });

  it('rifiuta un database di una versione più recente', () => {
    const db = openTracked(dbFile());
    db.exec('PRAGMA user_version = 99');
    expect(() => migrate(db)).toThrow(/più recente/);
  });

  it('la migrazione 7 rinomina il direttore "michael" in "director" su tutte le tabelle di stato', () => {
    const db = openTracked(dbFile());
    migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 6) });
    const now = Date.now();
    db.exec(`INSERT INTO agent_definitions (id, name, adapter, definition, version, archived, created_at, updated_at)
             VALUES ('michael', 'Michael', 'opencode', '{"id":"michael","name":"Michael"}', 1, 0, ${now}, ${now})`);
    db.exec(`INSERT INTO agent_sessions (id, agent_id, adapter, engine_session_id, resumable, started_at)
             VALUES ('s1', 'michael', 'opencode', 'e1', 1, ${now})`);
    db.exec(`INSERT INTO tasks (id, kind, root_id, correlation_id, title, spec, status, priority, actions, budget, spec_hash, created_by, created_at, updated_at)
             VALUES ('t1', 'goal', 't1', 'c1', 'titolo', 'spec', 'created', 0, '[]', '{}', 'h', 'michael', ${now}, ${now})`);
    const outcome = migrate(db);
    expect(outcome.applied).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(db.prepare('SELECT id, name, definition FROM agent_definitions').get()).toEqual({
      id: 'director',
      name: 'Director',
      definition: '{"id":"director","name":"Director"}'
    });
    expect(db.prepare('SELECT agent_id FROM agent_sessions').get()?.agent_id).toBe('director');
    expect(db.prepare('SELECT created_by FROM tasks').get()?.created_by).toBe('director');
  });

  it('la migrazione 8 riconcilia le istanze chiuse con l\'app (crashed → stopped) e lascia intatti i crash reali', () => {
    const db = openTracked(dbFile());
    migrate(db, { migrations: MIGRATIONS.filter((m) => m.version <= 7) });
    const now = Date.now();
    db.exec(`INSERT INTO agent_definitions (id, name, adapter, definition, version, archived, created_at, updated_at)
             VALUES ('a1', 'A1', 'opencode', '{"id":"a1"}', 1, 0, ${now}, ${now})`);
    const insert = db.prepare('INSERT INTO agent_instances (id, agent_id, status, status_reason, created_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('i-stale', 'a1', 'crashed', 'core riavviato: processo non più controllato', now);
    insert.run('i-real', 'a1', 'crashed', 'processo del motore terminato (crashed, codice 1)', now);
    insert.run('i-ok', 'a1', 'idle', 'turno completato', now);
    const outcome = migrate(db);
    expect(outcome.applied).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const rows = db.prepare('SELECT id, status, status_reason FROM agent_instances ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'i-ok', status: 'idle', status_reason: 'turno completato' },
      { id: 'i-real', status: 'crashed', status_reason: 'processo del motore terminato (crashed, codice 1)' },
      { id: 'i-stale', status: 'stopped', status_reason: 'sessione chiusa con l\'app precedente (processo non più controllato)' }
    ]);
  });
});

describe('journal degli eventi', () => {
  function setup(file = dbFile()) {
    const db = openTracked(file);
    migrate(db);
    const journal = createJournal(db);
    return { db, journal, file };
  }

  it('assegna seq crescenti, ignora i duplicati e rilegge gli eventi uguali', () => {
    const { db, journal } = setup();
    const a = createEvent('app.started', { appVersion: '0.3.0', electronVersion: '44.5.1', pid: 10 });
    const b = createEvent('core.crashed', {
      pid: 11, exitCode: 1, reason: 'exit', detail: 'x', stderrTail: '', restartsInWindow: 1, willRestart: true, nextDelayMs: 1000
    }, { target: { kind: 'process', id: '11' } });
    const added = db.transaction(() => journal.append([a, b]));
    expect(added.map((e) => e.seq)).toEqual([1, 2]);
    expect(db.transaction(() => journal.append([a]))).toEqual([]);
    expect(journal.count()).toBe(2);
    expect(journal.lastSeq()).toBe(2);
    expect(journal.read({ limit: 10 })).toEqual(added);
    expect(journal.read({ afterSeq: 1, limit: 10 }).map((e) => e.id)).toEqual([b.id]);
  });

  it('read senza afterSeq restituisce gli ultimi N in ordine crescente', () => {
    const { db, journal } = setup();
    const events = Array.from({ length: 5 }, (_, i) => createEvent('app.shutdown', { reason: `r${i}` }));
    db.transaction(() => journal.append(events));
    expect(journal.read({ limit: 2 }).map((e) => e.seq)).toEqual([4, 5]);
  });

  it('non accetta eventi effimeri', () => {
    const { db, journal } = setup();
    const e = createEvent('command.accepted', { commandId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', type: 'system.ping', issuedBy: 'ui' });
    expect(() => db.transaction(() => journal.append([e]))).toThrow(/effimero/);
  });

  it('un evento scritto sopravvive alla chiusura e riapertura del database', () => {
    const file = dbFile();
    const first = setup(file);
    const e = createEvent('app.shutdown', { reason: 'riavvio' });
    first.db.transaction(() => first.journal.append([e]));
    first.db.close();
    open.splice(open.indexOf(first.db), 1);

    const second = setup(file);
    expect(second.journal.read({ limit: 10 })).toEqual([{ ...e, seq: 1 }]);
  });
});

describe('emissione degli eventi', () => {
  it('i durevoli vanno nel journal prima del bus; gli effimeri solo sul bus; i payload sono redatti', async () => {
    const db = openTracked(dbFile());
    migrate(db);
    const journal = createJournal(db);
    const bus = createEventBus();
    const seen: VisioneEvent[] = [];
    bus.subscribe((e) => {
      seen.push(e);
      if (e.durability === 'durable') expect(journal.read({ limit: 100 }).some((j) => j.id === e.id)).toBe(true);
    });
    const emitter = createEventEmitter({ db, journal, bus });
    emitter.emit('system.error', { code: 'test', message: `chiave nvapi-${'s'.repeat(30)}`, fatal: false });
    emitter.emit('command.accepted', { commandId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', type: 'system.ping', issuedBy: 'ui' });
    await bus.idle();
    expect(seen.map((e) => [e.type, e.seq])).toEqual([['system.error', 1], ['command.accepted', null]]);
    expect(JSON.stringify(journal.read({ limit: 10 }))).not.toContain('nvapi-sss');
  });

  it('ingestFromMain accetta solo eventi del main, ignora i duplicati e li conferma', async () => {
    const db = openTracked(dbFile());
    migrate(db);
    const journal = createJournal(db);
    const bus = createEventBus();
    const emitter = createEventEmitter({ db, journal, bus });
    const fromMain = createEvent('core.started', { pid: 5, attempt: 0 });
    const fromCore = createEvent('system.ready', { startupMs: 1, journalLastSeq: 0 });
    const first = emitter.ingestFromMain([fromMain, fromCore, { rotto: true }]);
    expect(first.accepted).toEqual([fromMain.id]);
    expect(first.rejected).toHaveLength(2);
    const again = emitter.ingestFromMain([fromMain]);
    expect(again.accepted).toEqual([fromMain.id]);
    expect(journal.count()).toBe(1);
  });
});
