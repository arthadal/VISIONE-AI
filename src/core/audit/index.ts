// Audit log (VISIONE_SECURITY_MODEL §9, DECISIONI P-40): tabella `audit_log` append-only con catena
// di hash, `hash = sha256(prev_hash + riga)`. Registra approvazioni e dinieghi, decisioni non
// banali della policy, comandi di ciclo di vita degli agenti, obiettivi e cancellazioni, operazioni
// bloccate. Nessuna eliminazione; la catena si verifica all'avvio (rottura → `error.invariant`).
import { createHash } from 'node:crypto';
import type { AuditEntry } from '../../shared/contracts/index.ts';
import { redactString } from '../../shared/lib/redact.ts';
import type { Db } from '../db/index.ts';

export const AUDIT_GENESIS = '0'.repeat(64);

export interface AuditInput {
  actor: string;
  action: string;
  subject?: string | null;
  decision: string;
  detail: string;
  correlationId?: string | null;
}

export interface ChainCheck {
  ok: boolean;
  checked: number;
  /** `seq` della prima riga che non torna (null = catena integra). */
  brokenAt: number | null;
}

export interface AuditLog {
  /** Aggiunge una riga (nella transazione del chiamante, se aperta). */
  record(input: AuditInput): AuditEntry;
  /** Ultime righe, in ordine crescente di `seq`. */
  list(limit: number): AuditEntry[];
  verify(): ChainCheck;
}

export function auditHash(prevHash: string, row: Omit<AuditEntry, 'prevHash' | 'hash'>): string {
  const canonical = JSON.stringify([row.seq, row.ts, row.actor, row.action, row.subject, row.decision, row.detail, row.correlationId]);
  return createHash('sha256').update(`${prevHash}\n${canonical}`).digest('hex');
}

function toEntry(r: Record<string, unknown>): AuditEntry {
  return {
    seq: Number(r.seq),
    ts: Number(r.ts),
    actor: String(r.actor),
    action: String(r.action),
    subject: r.subject === null ? null : String(r.subject),
    decision: String(r.decision),
    detail: String(r.detail),
    correlationId: r.correlation_id === null ? null : String(r.correlation_id),
    prevHash: String(r.prev_hash),
    hash: String(r.hash)
  };
}

export function createAuditLog(db: Db, opts: { now?: () => number } = {}): AuditLog {
  const now = opts.now ?? Date.now;
  const last = db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const insert = db.prepare('INSERT INTO audit_log (seq, ts, actor, action, subject, decision, detail, correlation_id, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const recent = db.prepare('SELECT * FROM (SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC');
  const all = db.prepare('SELECT * FROM audit_log ORDER BY seq ASC');

  return {
    record(input) {
      return db.transaction(() => {
        const prev = last.get();
        const row = {
          seq: prev ? Number(prev.seq) + 1 : 1,
          ts: now(),
          actor: input.actor.slice(0, 80),
          action: input.action.slice(0, 100),
          subject: input.subject ? input.subject.slice(0, 200) : null,
          decision: input.decision.slice(0, 40),
          detail: redactString(input.detail).slice(0, 2_000),
          correlationId: input.correlationId ?? null
        };
        const prevHash = prev ? String(prev.hash) : AUDIT_GENESIS;
        const hash = auditHash(prevHash, row);
        insert.run(row.seq, row.ts, row.actor, row.action, row.subject, row.decision, row.detail, row.correlationId, prevHash, hash);
        return { ...row, prevHash, hash };
      });
    },
    list(limit) {
      return recent.all(limit).map(toEntry);
    },
    verify() {
      let prevHash = AUDIT_GENESIS;
      let checked = 0;
      let expectedSeq = 1;
      for (const raw of all.all()) {
        const e = toEntry(raw);
        checked++;
        if (e.seq !== expectedSeq || e.prevHash !== prevHash || auditHash(prevHash, e) !== e.hash) {
          return { ok: false, checked, brokenAt: e.seq };
        }
        prevHash = e.hash;
        expectedSeq++;
      }
      return { ok: true, checked, brokenAt: null };
    }
  };
}
