// Coda delle approvazioni (VISIONE_SECURITY_MODEL §2, DECISIONI P-39): richieste di azioni "con
// approvazione" che attendono la decisione del proprietario. Unico proprietario della tabella
// `approvals`. Una richiesta uguale a una già aperta (stesso tipo, bersaglio e task) la riusa; una
// decisione è definitiva e idempotente. Riga, evento e audit nella stessa transazione.
import type { Approval, ApprovalStatus } from '../../shared/contracts/index.ts';
import { ulid } from '../../shared/lib/ulid.ts';
import type { AuditLog } from '../audit/index.ts';
import type { Db, Row } from '../db/index.ts';
import type { EventEmitter } from '../events/index.ts';

export interface ApprovalRequest {
  kind: string;
  target: string;
  reason: string;
  requestedBy: string;
  taskId?: string | null;
  agentId?: string | null;
  correlationId: string;
  causationId?: string | null;
}

export interface ApprovalQueue {
  /** Registra (o riusa) una richiesta in attesa. `created` = nuova riga. */
  request(req: ApprovalRequest): { approval: Approval; created: boolean };
  /** Decisione del proprietario. `null` = richiesta inesistente. */
  decide(id: string, decision: 'grant' | 'deny', by: string, opts?: { note?: string; correlationId?: string; causationId?: string }): { approval: Approval; alreadyDecided: boolean } | null;
  get(id: string): Approval | null;
  list(opts?: { status?: ApprovalStatus; limit?: number }): Approval[];
  /** Esiste un'approvazione concessa per questa azione (tipo e bersaglio). */
  isGranted(kind: string, target: string): boolean;
  pendingCount(): number;
}

function toApproval(r: Row): Approval {
  const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    id: String(r.id),
    kind: String(r.kind),
    target: String(r.target),
    reason: String(r.reason),
    requestedBy: String(r.requested_by),
    taskId: s(r.task_id),
    agentId: s(r.agent_id),
    correlationId: String(r.correlation_id),
    status: String(r.status) as ApprovalStatus,
    decidedBy: s(r.decided_by),
    note: s(r.note),
    requestedAt: Number(r.requested_at),
    decidedAt: r.decided_at === null ? null : Number(r.decided_at)
  };
}

const SOURCE = { kind: 'visione', id: 'approvals' } as const;

export function createApprovalQueue(deps: { db: Db; events: EventEmitter; audit: AuditLog; now?: () => number }): ApprovalQueue {
  const { db, events, audit } = deps;
  const now = deps.now ?? Date.now;
  const byId = db.prepare('SELECT * FROM approvals WHERE id = ?');
  const openOne = db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND kind = ? AND target = ? AND IFNULL(task_id, '') = ?");
  const insert = db.prepare('INSERT INTO approvals (id, kind, target, reason, requested_by, task_id, agent_id, correlation_id, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const setDecision = db.prepare("UPDATE approvals SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'");
  const granted = db.prepare("SELECT 1 FROM approvals WHERE status = 'granted' AND kind = ? AND target = ? LIMIT 1");
  const pending = db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'");

  return {
    request(req) {
      return db.transaction(() => {
        const target = req.target.slice(0, 1000);
        const existing = openOne.get(req.kind, target, req.taskId ?? '');
        if (existing) return { approval: toApproval(existing), created: false };
        const id = ulid(now());
        insert.run(id, req.kind.slice(0, 100), target, req.reason.slice(0, 500), req.requestedBy.slice(0, 80), req.taskId ?? null, req.agentId ?? null, req.correlationId, 'pending', now());
        audit.record({ actor: req.requestedBy, action: `approval.request:${req.kind}`, subject: target, decision: 'pending', detail: req.reason, correlationId: req.correlationId });
        events.emit('approval.requested', {
          approvalId: id, kind: req.kind.slice(0, 100), target, reason: req.reason.slice(0, 500), requestedBy: req.requestedBy.slice(0, 80),
          taskId: req.taskId ?? null, agentId: req.agentId ?? null
        }, { source: SOURCE, target: { kind: 'user', id: 'owner' }, correlationId: req.correlationId, causationId: req.causationId ?? null });
        return { approval: toApproval(byId.get(id) as Row), created: true };
      });
    },

    decide(id, decision, by, opts = {}) {
      return db.transaction(() => {
        const row = byId.get(id);
        if (!row) return null;
        const current = toApproval(row);
        if (current.status !== 'pending') return { approval: current, alreadyDecided: true };
        const status: ApprovalStatus = decision === 'grant' ? 'granted' : 'denied';
        const note = opts.note?.slice(0, 500) ?? null;
        setDecision.run(status, by.slice(0, 80), note, now(), id);
        audit.record({ actor: by, action: `approval.decide:${current.kind}`, subject: current.target, decision: status, detail: note ?? '', correlationId: current.correlationId });
        events.emit(status === 'granted' ? 'approval.granted' : 'approval.denied', {
          approvalId: id, kind: current.kind, target: current.target, decidedBy: by.slice(0, 80), note
        }, { source: { kind: 'user', id: 'owner' }, correlationId: current.correlationId, causationId: opts.causationId ?? null });
        return { approval: toApproval(byId.get(id) as Row), alreadyDecided: false };
      });
    },

    get(id) {
      const row = byId.get(id);
      return row ? toApproval(row) : null;
    },

    list(opts = {}) {
      const limit = opts.limit ?? 50;
      const rows = opts.status
        ? db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY requested_at DESC, id DESC LIMIT ?').all(opts.status, limit)
        : db.prepare('SELECT * FROM approvals ORDER BY requested_at DESC, id DESC LIMIT ?').all(limit);
      return rows.map(toApproval);
    },

    isGranted(kind, target) {
      return granted.get(kind, target.slice(0, 1000)) !== undefined;
    },

    pendingCount() {
      return Number(pending.get()?.n ?? 0);
    }
  };
}
