// Journal degli eventi durevoli: tabella `events`, `seq` = ordine totale di registrazione.
// `append` va chiamato dentro la transazione del chiamante (comando → stato + eventi insieme).
// Le letture non lanciano per una riga illeggibile (payload non JSON, campi incoerenti): la
// saltano e la segnalano, così un dato corrotto non blocca né il recupero né la UI.
import {
  endpointKindSchema,
  eventCategorySchema,
  serializePayload,
  severitySchema,
  type EventCategory,
  type VisioneEvent,
  type Severity
} from '../../shared/contracts/index.ts';
import type { Db, Row, SqlValue } from '../db/index.ts';

export { claimsWork, isReviewTask, recordedProofs, type RecordedProof } from './proofs.ts';

export interface JournalQuery {
  /** Eventi con seq > afterSeq in ordine crescente; assente = gli ultimi `limit`. */
  afterSeq?: number | undefined;
  limit: number;
  types?: readonly string[] | undefined;
  categories?: readonly EventCategory[] | undefined;
  correlationId?: string | undefined;
  minSeverity?: Severity | undefined;
}

export interface Journal {
  /**
   * Inserisce gli eventi durevoli; un id già presente viene ignorato. Ritorna i soli nuovi, con `seq`.
   * `serialized` porta i payload già serializzati (id → JSON) per non ripetere la serializzazione.
   */
  append(events: readonly VisioneEvent[], serialized?: ReadonlyMap<string, string>): VisioneEvent[];
  /** Risultato sempre in ordine crescente di `seq`. */
  read(query: JournalQuery): VisioneEvent[];
  get(id: string): VisioneEvent | null;
  /** Ultimo evento registrato di uno dei tipi indicati (recupero dello stato). */
  latest(types: readonly string[]): VisioneEvent | null;
  /** Ultimo evento con gravità error o critical. */
  lastError(): VisioneEvent | null;
  lastSeq(): number;
  count(): number;
}

export interface JournalOptions {
  /** Riga illeggibile saltata durante una lettura. */
  onCorruptRow?: (seq: number, problem: string) => void;
}

const SEVERITIES_FROM: Record<Severity, readonly Severity[]> = {
  debug: ['debug', 'info', 'warning', 'error', 'critical'],
  info: ['info', 'warning', 'error', 'critical'],
  warning: ['warning', 'error', 'critical'],
  error: ['error', 'critical'],
  critical: ['critical']
};

export function createJournal(db: Db, opts: JournalOptions = {}): Journal {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO events
      (id, ts, type, category, source_kind, source_id, target_kind, target_id,
       correlation_id, causation_id, severity, schema, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const byId = db.prepare('SELECT * FROM events WHERE id = ?');
  const errors = db.prepare("SELECT * FROM events WHERE severity IN ('error', 'critical') ORDER BY seq DESC LIMIT 1");
  const last = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events');
  const total = db.prepare('SELECT COUNT(*) AS n FROM events');

  const decode = (rows: Row[]): VisioneEvent[] => {
    const out: VisioneEvent[] = [];
    for (const row of rows) {
      const decoded = toEvent(row);
      if (decoded.ok) out.push(decoded.event);
      else opts.onCorruptRow?.(Number(row.seq), decoded.problem);
    }
    return out;
  };

  return {
    append(events, serialized) {
      const added: VisioneEvent[] = [];
      for (const e of events) {
        if (e.durability !== 'durable') throw new Error(`evento effimero nel journal: ${e.type}`);
        const precomputed = serialized?.get(e.id);
        let json = precomputed;
        if (json === undefined) {
          const payload = serializePayload(e.payload);
          if (!payload.ok) throw new Error(`${e.type}: ${payload.problem}`);
          json = payload.json;
        }
        const r = insert.run(
          e.id, e.ts, e.type, e.category, e.source.kind, e.source.id, e.target?.kind ?? null,
          e.target?.id ?? null, e.correlationId, e.causationId, e.severity, e.schema, json
        );
        if (r.changes === 1) added.push({ ...e, seq: r.lastInsertRowid });
      }
      return added;
    },
    read(query) {
      const where: string[] = [];
      const params: SqlValue[] = [];
      const inList = (column: string, values: readonly string[]): void => {
        where.push(`${column} IN (${values.map(() => '?').join(', ')})`);
        params.push(...values);
      };
      if (query.afterSeq !== undefined) {
        where.push('seq > ?');
        params.push(query.afterSeq);
      }
      if (query.types?.length) inList('type', query.types);
      if (query.categories?.length) inList('category', query.categories);
      if (query.correlationId !== undefined) {
        where.push('correlation_id = ?');
        params.push(query.correlationId);
      }
      if (query.minSeverity !== undefined && query.minSeverity !== 'debug') inList('severity', SEVERITIES_FROM[query.minSeverity]);
      const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const sql = query.afterSeq === undefined
        ? `SELECT * FROM (SELECT * FROM events ${clause} ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`
        : `SELECT * FROM events ${clause} ORDER BY seq ASC LIMIT ?`;
      return decode(db.prepare(sql).all(...params, query.limit));
    },
    get(id) {
      const row = byId.get(id);
      return row ? decode([row])[0] ?? null : null;
    },
    latest(types) {
      if (types.length === 0) return null;
      const sql = `SELECT * FROM events WHERE type IN (${types.map(() => '?').join(', ')}) ORDER BY seq DESC LIMIT 1`;
      const row = db.prepare(sql).get(...types);
      return row ? decode([row])[0] ?? null : null;
    },
    lastError() {
      const row = errors.get();
      return row ? decode([row])[0] ?? null : null;
    },
    lastSeq: () => Number(last.get()?.seq ?? 0),
    count: () => Number(total.get()?.n ?? 0)
  };
}

type Decoded = { ok: true; event: VisioneEvent } | { ok: false; problem: string };

function toEvent(row: Row): Decoded {
  let payload: unknown;
  try {
    payload = JSON.parse(String(row.payload));
  } catch {
    return { ok: false, problem: 'payload non JSON' };
  }
  const category = eventCategorySchema.safeParse(row.category);
  const severity = severitySchema.safeParse(row.severity);
  const sourceKind = endpointKindSchema.safeParse(row.source_kind);
  const targetKind = row.target_kind === null || row.target_kind === undefined ? null : endpointKindSchema.safeParse(row.target_kind);
  if (!category.success || !severity.success || !sourceKind.success || (targetKind !== null && !targetKind.success)) {
    return { ok: false, problem: 'categoria, gravità o endpoint non validi' };
  }
  return {
    ok: true,
    event: {
      id: String(row.id),
      seq: Number(row.seq),
      ts: Number(row.ts),
      // Un tipo non (più) registrato resta leggibile: chi lo consuma decide se ignorarlo.
      type: String(row.type),
      category: category.data,
      source: { kind: sourceKind.data, id: String(row.source_id) },
      target: targetKind === null ? null : { kind: targetKind.data as typeof sourceKind.data, id: String(row.target_id) },
      correlationId: String(row.correlation_id),
      causationId: row.causation_id === null ? null : String(row.causation_id),
      severity: severity.data,
      durability: 'durable',
      schema: Number(row.schema),
      payload
    }
  };
}
