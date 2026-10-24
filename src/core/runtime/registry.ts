// Registro persistente dei processi (tabella `processes`, migrazione 3): serve a sapere, dopo una
// caduta del core, quali processi erano vivi e a chi appartenevano (riconciliazione).
import type { ProcessInfo, ProcessStatus, RuntimeErrorCode } from '../../shared/contracts/index.ts';
import type { Db, Row } from '../db/index.ts';
import type { DiscoveryResult } from './discovery.ts';

export interface ProcessRecord {
  readonly id: string;
  readonly pid: number | null;
  readonly status: ProcessStatus;
  readonly exe: string;
  readonly kind: string;
  readonly agentId: string | null;
  readonly sessionId: string | null;
  readonly taskId: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly errorCode: string | null;
}

export interface ProcessRegistry {
  insert(info: ProcessInfo): void;
  update(info: ProcessInfo): void;
  /** Chiude un processo di un avvio precedente (riconciliazione). */
  markLost(id: string, at: number, code: RuntimeErrorCode, message: string): void;
  get(id: string): ProcessRecord | null;
  /** Processi registrati e non terminati (anche di avvii precedenti). */
  live(): ProcessRecord[];
  recent(limit: number): ProcessRecord[];
  saveCli(result: DiscoveryResult, at: number): void;
}

function toRecord(r: Row): ProcessRecord {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r.id),
    pid: num(r.pid),
    status: String(r.status) as ProcessStatus,
    exe: String(r.exe),
    kind: String(r.kind),
    agentId: str(r.agent_id),
    sessionId: str(r.session_id),
    taskId: str(r.task_id),
    createdAt: Number(r.created_at),
    startedAt: num(r.started_at),
    endedAt: num(r.ended_at),
    errorCode: str(r.error_code)
  };
}

export function createProcessRegistry(db: Db): ProcessRegistry {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO processes
      (id, pid, kind, io, status, exe, cwd, agent_id, session_id, task_id, adapter, correlation_id, restart_of, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`
    UPDATE processes SET pid = ?, status = ?, started_at = ?, ended_at = ?, exit_code = ?, signal = ?,
      error_code = ?, error_message = ? WHERE id = ?`);
  const lost = db.prepare(`
    UPDATE processes SET status = 'lost', ended_at = ?, error_code = ?, error_message = ? WHERE id = ? AND ended_at IS NULL`);
  const byId = db.prepare('SELECT * FROM processes WHERE id = ?');
  const live = db.prepare('SELECT * FROM processes WHERE ended_at IS NULL ORDER BY created_at');
  const recent = db.prepare('SELECT * FROM processes ORDER BY created_at DESC LIMIT ?');
  const cli = db.prepare(`
    INSERT INTO cli_installations (name, path, exe, kind, version, status, problem, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET path = excluded.path, exe = excluded.exe, kind = excluded.kind,
      version = excluded.version, status = excluded.status, problem = excluded.problem, checked_at = excluded.checked_at`);

  return {
    insert(p) {
      insert.run(p.id, p.pid, p.kind, p.io, p.status, p.exe, p.cwd, p.owner.agentId, p.owner.sessionId, p.owner.taskId,
        p.owner.adapter, p.correlationId, p.restartOf, p.createdAt);
    },
    update(p) {
      update.run(p.pid, p.status, p.startedAt, p.endedAt, p.exitCode, p.signal, p.error?.code ?? null, p.error?.message ?? null, p.id);
    },
    markLost(id, at, code, message) {
      lost.run(at, code, message.slice(0, 500), id);
    },
    get(id) {
      const r = byId.get(id);
      return r ? toRecord(r) : null;
    },
    live: () => live.all().map(toRecord),
    recent: (limit) => recent.all(limit).map(toRecord),
    saveCli(result, at) {
      if (result.found) cli.run(result.name, result.path, result.exe, result.kind, result.version, 'found', null, at);
      else cli.run(result.name, null, null, null, null, 'missing', result.problem.slice(0, 500), at);
    }
  };
}
