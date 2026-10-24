// Emissione degli eventi nel core: validazione → redazione → (se durevole) journal in transazione
// → stato → bus. Il bus diffonde solo dopo il commit (VISIONE_EVENT_MODEL §3, atomicità).
//
// Guasti del journal (P-27): se la scrittura fallisce fuori da una transazione del chiamante, gli
// eventi durevoli non si perdono subito né bloccano il sistema: vengono diffusi lo stesso (con
// `seq` null), tenuti in memoria in ordine (al massimo `maxPending`) e riscritti appena il journal
// torna disponibile. Dentro una transazione del chiamante l'errore si propaga (rollback).
import {
  createEvent,
  parseEvent,
  serializePayload,
  type CreateEventOptions,
  type EventPayload,
  type EventType,
  type VisioneEvent,
  type TypedEvent
} from '../../shared/contracts/index.ts';
import { redactValue } from '../../shared/lib/redact.ts';
import type { EventBus } from '../bus/index.ts';
import type { Db } from '../db/index.ts';
import type { Journal } from '../journal/index.ts';

export interface IngestOutcome {
  /** Id registrati o già presenti: il mittente può scartarli. */
  accepted: string[];
  rejected: Array<{ id: string | null; type: string | null; problem: string }>;
}

export type JournalHealth =
  | { status: 'ok'; pending: 0; lastError: null; since: null }
  | { status: 'degraded'; pending: number; lastError: string; since: number };

/** Cambio di salute del journal; `flushed`/`lost` valorizzati al ritorno a `ok`. */
export interface JournalChange {
  health: JournalHealth;
  flushed: number;
  lost: number;
  downMs: number;
  /** `seq` dell'ultimo evento riscritto (gli eventi riscritti erano già stati diffusi). */
  lastSeq: number | null;
}

export interface EventEmitter {
  /** Lancia solo per un errore del chiamante (payload non conforme al registro). */
  emit<T extends EventType>(type: T, payload: EventPayload<T>, opts?: CreateEventOptions): TypedEvent<T>;
  /** Registra eventi prodotti dal main (solo tipi con origine `main`); i non validi sono rifiutati. */
  ingestFromMain(raw: readonly unknown[]): IngestOutcome;
  /** Riprova a scrivere gli eventi in attesa; true se non ne resta nessuno. */
  flushPending(): boolean;
  health(): JournalHealth;
  /** Ferma i tentativi; ritorna il numero di eventi durevoli rimasti non scritti. */
  close(): number;
}

export interface EmitterDeps {
  db: Db;
  journal: Journal;
  bus: EventBus;
  now?: () => number;
  maxPending?: number;
  retryMs?: number;
  /** Eventi registrati, nell'ordine di diffusione, prima della diffusione (lo stato li osserva qui). */
  onCommitted?: (events: readonly VisioneEvent[]) => void;
  /** Cambio di salute del journal (notificato fuori dal commit, in un microtask). */
  onJournalChange?: (change: JournalChange) => void;
  /** Evento scartato perché non serializzabile o troppo grande. */
  onRejected?: (event: VisioneEvent, problem: string) => void;
}

const OK: JournalHealth = { status: 'ok', pending: 0, lastError: null, since: null };

export function createEventEmitter(deps: EmitterDeps): EventEmitter {
  const now = deps.now ?? Date.now;
  const maxPending = deps.maxPending ?? 1_000;
  const retryMs = deps.retryMs ?? 2_000;
  let pending: VisioneEvent[] = [];
  let health: JournalHealth = OK;
  let lost = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const notify = (change: JournalChange): void => {
    if (deps.onJournalChange) queueMicrotask(() => deps.onJournalChange?.(change));
  };

  const scheduleRetry = (): void => {
    if (retryTimer !== null || closed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!flushPending()) scheduleRetry();
    }, retryMs);
    retryTimer.unref?.();
  };

  const degrade = (err: unknown, events: readonly VisioneEvent[]): void => {
    pending.push(...events);
    if (pending.length > maxPending) {
      lost += pending.length - maxPending;
      pending = pending.slice(-maxPending);
    }
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const wasOk = health.status === 'ok';
    health = { status: 'degraded', pending: pending.length, lastError: message, since: health.since ?? now() };
    if (wasOk) notify({ health, flushed: 0, lost: 0, downMs: 0, lastSeq: null });
    scheduleRetry();
  };

  function flushPending(): boolean {
    if (pending.length === 0) return true;
    const batch = pending;
    try {
      const stored = deps.db.transaction(() => deps.journal.append(batch));
      pending = [];
      const downMs = health.since === null ? 0 : now() - health.since;
      const change: JournalChange = { health: OK, flushed: stored.length, lost, downMs, lastSeq: stored.at(-1)?.seq ?? null };
      health = OK;
      lost = 0;
      notify(change);
      return true;
    } catch (err) {
      if (health.status === 'degraded') health = { ...health, lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
      return false;
    }
  }

  const commit = (events: VisioneEvent[]): VisioneEvent[] => {
    const accepted: VisioneEvent[] = [];
    const jsonById = new Map<string, string>();
    for (const e of events) {
      const serialized = serializePayload(e.payload);
      if (serialized.ok) {
        accepted.push(e);
        jsonById.set(e.id, serialized.json);
      } else deps.onRejected?.(e, serialized.problem);
    }
    const durable = accepted.filter((e) => e.durability === 'durable');
    let storedById = new Map<string, VisioneEvent>();
    if (durable.length > 0) {
      // Gli eventi in attesa vanno scritti prima dei nuovi, per non invertire l'ordine.
      if (pending.length > 0 && !deps.db.inTransaction) flushPending();
      if (pending.length > 0) {
        degrade(new Error(health.status === 'degraded' ? health.lastError : 'journal non disponibile'), durable);
      } else {
        try {
          storedById = new Map(deps.db.transaction(() => deps.journal.append(durable, jsonById)).map((e) => [e.id, e]));
        } catch (err) {
          if (deps.db.inTransaction) throw err;
          degrade(err, durable);
        }
      }
    }
    const pendingIds = new Set(pending.map((e) => e.id));
    const published: VisioneEvent[] = [];
    for (const e of accepted) {
      if (e.durability === 'ephemeral' || pendingIds.has(e.id)) published.push(e);
      else {
        // Un durevole già presente (id duplicato) non viene ridiffuso.
        const withSeq = storedById.get(e.id);
        if (withSeq) published.push(withSeq);
      }
    }
    if (published.length > 0) deps.onCommitted?.(published);
    for (const e of published) deps.bus.publish(e);
    return published;
  };

  return {
    emit(type, payload, opts) {
      const event = createEvent(type, redactValue(payload) as typeof payload, opts);
      const [published] = commit([event]);
      return (published ?? event) as typeof event;
    },
    ingestFromMain(raw) {
      const outcome: IngestOutcome = { accepted: [], rejected: [] };
      const valid: VisioneEvent[] = [];
      for (const item of raw) {
        const parsed = parseEvent(item, 'main');
        if (!parsed.ok) {
          const obj = typeof item === 'object' && item !== null ? (item as { id?: unknown; type?: unknown }) : {};
          outcome.rejected.push({
            id: typeof obj.id === 'string' ? obj.id.slice(0, 64) : null,
            type: typeof obj.type === 'string' ? obj.type.slice(0, 100) : null,
            problem: parsed.problem.slice(0, 500)
          });
          continue;
        }
        valid.push({ ...parsed.event, seq: null, payload: redactValue(parsed.event.payload) });
      }
      commit(valid);
      // Conferma al main solo ciò che è nel journal: gli eventi in attesa restano nel suo spool.
      const waiting = new Set(pending.map((e) => e.id));
      outcome.accepted = valid.map((e) => e.id).filter((id) => !waiting.has(id));
      return outcome;
    },
    flushPending,
    health: () => health,
    close() {
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      return pending.length;
    }
  };
}
