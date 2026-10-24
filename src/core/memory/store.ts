// Archivio della memoria: unico proprietario di `memory_items` (l'indice `memory_fts` lo tengono
// allineato i trigger della migrazione 5). Ogni testo è redatto prima di essere scritto; un
// contenuto già attivo nello stesso ambito non si duplica.
import { MEMORY_LIMITS, type MemoryItem, type MemoryKind, type MemoryOrigin, type MemoryScope } from '../../shared/contracts/index.ts';
import { redactString } from '../../shared/lib/redact.ts';
import { ulid } from '../../shared/lib/ulid.ts';
import type { Db, Row } from '../db/index.ts';
import type { EventEmitter } from '../events/index.ts';
import { contentHash, ftsQuery } from './markdown.ts';

/** Ambiti leggibili: `null` = tutti (proprietario). */
export interface ScopeFilter {
  readonly global: boolean;
  readonly agentId: string | null;
  readonly taskIds: readonly string[];
}

export interface WriteInput {
  readonly scope: MemoryScope;
  readonly scopeId: string | null;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly source: string;
  readonly origin: MemoryOrigin;
  readonly originRef?: string | null;
  readonly pinned?: boolean;
}

export interface FileEntry {
  readonly scope: 'agent' | 'task';
  readonly scopeId: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly content: string;
  readonly pinned: boolean;
  /** Default `agent:<id>`; il riassunto della riflessione è `reflection`. */
  readonly source?: string;
}

export interface SyncReport {
  sections: number;
  added: number;
  restored: number;
  retired: number;
  superseded: number;
  unchanged: number;
  redacted: number;
  /** Id dell'elemento per ogni voce (null per un duplicato nel file). */
  ids: (string | null)[];
}

export interface Corr {
  readonly correlationId?: string | undefined;
}

export interface MemoryStore {
  write(input: WriteInput, corr?: Corr): { item: MemoryItem; created: boolean };
  get(id: string): MemoryItem | null;
  /** Ricerca FTS5 (testo vuoto = elementi recenti), solo elementi attivi salvo `includeInactive`. */
  search(query: string, opts: { scopes: ScopeFilter | null; limit: number; includeInactive?: boolean; agentId?: string | null }): MemoryItem[];
  pinned(scopes: ScopeFilter, limit: number): MemoryItem[];
  promote(id: string, by: string, corr?: Corr): { item: MemoryItem; created: boolean } | null;
  /** Allinea gli elementi di `memory.md` di un agente: nuove sezioni, sezioni sparite (ritirate o sostituite). */
  syncFile(agentId: string, entries: readonly FileEntry[], opts: { supersedeWith?: number; reason?: string; stats?: Record<'ignored' | 'truncated' | 'scopeDenied', number> }, corr?: Corr): SyncReport;
}

const SOURCE = { kind: 'visione', id: 'memory' } as const;

export function createMemoryStore(deps: { db: Db; events: EventEmitter; now?: () => number }): MemoryStore {
  const { db, events } = deps;
  const now = deps.now ?? Date.now;
  const q = {
    get: db.prepare('SELECT * FROM memory_items WHERE id = ?'),
    insert: db.prepare(`INSERT OR IGNORE INTO memory_items (id, scope, scope_id, kind, title, content, source, origin, origin_ref, content_hash, pinned, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    active: db.prepare("SELECT * FROM memory_items WHERE scope = ? AND IFNULL(scope_id, '') = ? AND content_hash = ? AND superseded_by IS NULL AND retired_at IS NULL"),
    pin: db.prepare('UPDATE memory_items SET pinned = ?, updated_at = ? WHERE id = ?'),
    fileRows: db.prepare("SELECT * FROM memory_items WHERE origin = 'file' AND origin_ref = ? ORDER BY created_at, id"),
    restore: db.prepare('UPDATE memory_items SET retired_at = NULL, pinned = ?, updated_at = ? WHERE id = ?'),
    retire: db.prepare('UPDATE memory_items SET retired_at = ?, updated_at = ? WHERE id = ?'),
    supersede: db.prepare('UPDATE memory_items SET superseded_by = ?, updated_at = ? WHERE id = ?'),
    promoted: db.prepare("SELECT * FROM memory_items WHERE origin = 'promotion' AND origin_ref = ? AND superseded_by IS NULL AND retired_at IS NULL")
  };

  const toItem = (r: Row): MemoryItem => ({
    id: String(r.id),
    scope: String(r.scope) as MemoryScope,
    scopeId: r.scope_id === null ? null : String(r.scope_id),
    kind: String(r.kind) as MemoryKind,
    title: String(r.title),
    content: String(r.content),
    source: String(r.source),
    origin: String(r.origin) as MemoryOrigin,
    pinned: Number(r.pinned) === 1,
    supersededBy: r.superseded_by === null ? null : String(r.superseded_by),
    retiredAt: r.retired_at === null ? null : Number(r.retired_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  });

  const clean = (title: string, content: string): { title: string; content: string; redacted: boolean } => {
    const t = redactString(title).slice(0, MEMORY_LIMITS.titleChars);
    const c = redactString(content).slice(0, MEMORY_LIMITS.contentChars);
    return { title: t, content: c, redacted: t !== title.slice(0, MEMORY_LIMITS.titleChars) || c !== content.slice(0, MEMORY_LIMITS.contentChars) };
  };

  const emitWritten = (item: MemoryItem, redacted: boolean, corr?: Corr): void => {
    events.emit('memory.item.written', {
      itemId: item.id, scope: item.scope, scopeId: item.scopeId, kind: item.kind, origin: item.origin, source: item.source.slice(0, 80),
      pinned: item.pinned, title: item.title, redacted
    }, { source: SOURCE, target: { kind: 'memory', id: item.id }, ...(corr?.correlationId ? { correlationId: corr.correlationId } : {}) });
  };

  /** Inserisce o restituisce l'elemento attivo con lo stesso contenuto nello stesso ambito. */
  const insert = (input: WriteInput, corr?: Corr): { item: MemoryItem; created: boolean; redacted: boolean } => {
    const { title, content, redacted } = clean(input.title, input.content);
    const hash = contentHash([input.scope, input.scopeId, input.kind, title, content]);
    const t = now();
    const id = ulid(t);
    const r = q.insert.run(id, input.scope, input.scopeId, input.kind, title, content, input.source.slice(0, 80), input.origin, input.originRef ?? null, hash, input.pinned ? 1 : 0, t, t);
    if (r.changes > 0) {
      const item = toItem(q.get.get(id) as Row);
      emitWritten(item, redacted, corr);
      return { item, created: true, redacted };
    }
    const existing = q.active.get(input.scope, input.scopeId ?? '', hash) as Row;
    if (input.pinned && Number(existing.pinned) === 0) q.pin.run(1, t, String(existing.id));
    return { item: toItem(q.get.get(String(existing.id)) as Row), created: false, redacted };
  };

  const scopeSql = (scopes: ScopeFilter | null): { sql: string; params: string[] } => {
    if (!scopes) return { sql: '1', params: [] };
    const parts: string[] = [];
    const params: string[] = [];
    if (scopes.global) parts.push("m.scope = 'global'");
    if (scopes.agentId) {
      parts.push("(m.scope = 'agent' AND m.scope_id = ?)");
      params.push(scopes.agentId);
    }
    const tasks = scopes.taskIds.slice(0, 200);
    if (tasks.length > 0) {
      parts.push(`(m.scope = 'task' AND m.scope_id IN (${tasks.map(() => '?').join(', ')}))`);
      params.push(...tasks);
    }
    return { sql: parts.length > 0 ? `(${parts.join(' OR ')})` : '0', params };
  };

  const store: MemoryStore = {
    write(input, corr) {
      const out = db.transaction(() => insert(input, corr));
      return { item: out.item, created: out.created };
    },

    get(id) {
      const r = q.get.get(id);
      return r ? toItem(r) : null;
    },

    search(query, opts) {
      const started = now();
      const scope = scopeSql(opts.scopes);
      const activeSql = opts.includeInactive ? '1' : 'm.superseded_by IS NULL AND m.retired_at IS NULL';
      const match = ftsQuery(query);
      let rows: Row[];
      if (match === null) {
        rows = db.prepare(`SELECT m.* FROM memory_items m WHERE ${activeSql} AND ${scope.sql} ORDER BY m.updated_at DESC, m.id DESC LIMIT ?`)
          .all(...scope.params, opts.limit);
      } else {
        // Il titolo pesa il doppio del contenuto.
        rows = db.prepare(`SELECT m.* FROM memory_fts JOIN memory_items m ON m.rowid = memory_fts.rowid
          WHERE memory_fts MATCH ? AND ${activeSql} AND ${scope.sql} ORDER BY bm25(memory_fts, 2.0, 1.0), m.id LIMIT ?`)
          .all(match, ...scope.params, opts.limit);
      }
      const items = rows.map(toItem);
      events.emit('memory.search.performed', { query: query.slice(0, 200), agentId: opts.agentId ?? null, hits: items.length, durationMs: now() - started }, { source: SOURCE });
      return items;
    },

    pinned(scopes, limit) {
      const scope = scopeSql(scopes);
      return db.prepare(`SELECT m.* FROM memory_items m WHERE m.pinned = 1 AND m.superseded_by IS NULL AND m.retired_at IS NULL AND ${scope.sql}
        ORDER BY CASE m.scope WHEN 'global' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END, m.created_at, m.id LIMIT ?`).all(...scope.params, limit).map(toItem);
    },

    promote(id, by, corr) {
      const original = store.get(id);
      if (!original) return null;
      if (original.scope === 'global') return { item: original, created: false };
      return db.transaction(() => {
        const already = q.promoted.get(id);
        if (already) return { item: toItem(already), created: false };
        const out = insert({
          scope: 'global', scopeId: null, kind: original.kind, title: original.title, content: original.content,
          source: by, origin: 'promotion', originRef: id, pinned: original.pinned
        }, corr);
        events.emit('memory.item.promoted', { itemId: id, globalItemId: out.item.id, by: by.slice(0, 80) }, {
          source: SOURCE, target: { kind: 'memory', id: out.item.id }, ...(corr?.correlationId ? { correlationId: corr.correlationId } : {})
        });
        return { item: out.item, created: out.created };
      });
    },

    syncFile(agentId, entries, opts, corr) {
      const report: SyncReport = { sections: entries.length, added: 0, restored: 0, retired: 0, superseded: 0, unchanged: 0, redacted: 0, ids: [] };
      db.transaction(() => {
        const t = now();
        const rows = q.fileRows.all(agentId);
        const byHash = new Map<string, Row>();
        for (const r of rows) {
          const prev = byHash.get(String(r.content_hash));
          // Preferito l'elemento attivo, poi quello ritirato (ripristinabile); i sostituiti restano storia.
          const rank = (x: Row): number => (x.superseded_by !== null ? 2 : x.retired_at !== null ? 1 : 0);
          if (!prev || rank(r) < rank(prev)) byHash.set(String(r.content_hash), r);
        }
        const seen = new Set<string>();
        for (const e of entries) {
          const { title, content, redacted } = clean(e.title, e.content);
          if (redacted) report.redacted++;
          const hash = contentHash([e.scope, e.scopeId, e.kind, title, content]);
          if (seen.has(hash)) {
            report.unchanged++;
            report.ids.push(null);
            continue;
          }
          seen.add(hash);
          const row = byHash.get(hash);
          if (row && row.superseded_by === null && row.retired_at === null) {
            if ((Number(row.pinned) === 1) !== e.pinned) q.pin.run(e.pinned ? 1 : 0, t, String(row.id));
            report.unchanged++;
            report.ids.push(String(row.id));
            continue;
          }
          if (row && row.superseded_by === null && q.active.get(e.scope, e.scopeId, hash) === undefined) {
            q.restore.run(e.pinned ? 1 : 0, t, String(row.id));
            report.restored++;
            report.ids.push(String(row.id));
            continue;
          }
          const out = insert({ scope: e.scope, scopeId: e.scopeId, kind: e.kind, title, content, source: e.source ?? `agent:${agentId}`, origin: 'file', originRef: agentId, pinned: e.pinned }, corr);
          if (out.created) report.added++;
          else report.unchanged++;
          report.ids.push(out.item.id);
        }
        const removed = rows.filter((r) => r.superseded_by === null && r.retired_at === null && !seen.has(String(r.content_hash))).map((r) => String(r.id));
        const replacement = opts.supersedeWith === undefined ? null : report.ids[opts.supersedeWith] ?? null;
        if (removed.length > 0 && replacement !== null) {
          for (const id of removed) q.supersede.run(replacement, t, id);
          report.superseded = removed.length;
          events.emit('memory.item.superseded', { itemIds: removed.slice(0, 200), supersededBy: replacement, reason: (opts.reason ?? 'sostituiti').slice(0, 200) }, {
            source: SOURCE, target: { kind: 'memory', id: replacement }, ...(corr?.correlationId ? { correlationId: corr.correlationId } : {})
          });
        } else {
          for (const id of removed) q.retire.run(t, t, id);
          report.retired = removed.length;
        }
        const stats = opts.stats ?? { ignored: 0, truncated: 0, scopeDenied: 0 };
        if (report.added + report.restored + report.retired + report.superseded + stats.ignored + stats.truncated + stats.scopeDenied > 0) {
          events.emit('memory.index.updated', {
            agentId, sections: report.sections, added: report.added, restored: report.restored, retired: report.retired, superseded: report.superseded,
            unchanged: report.unchanged, ...stats, redacted: report.redacted
          }, { source: SOURCE, target: { kind: 'agent', id: agentId }, ...(corr?.correlationId ? { correlationId: corr.correlationId } : {}) });
        }
      });
      return report;
    }
  };
  return store;
}
