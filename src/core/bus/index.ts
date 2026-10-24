// Event Bus in-process del core (VISIONE_EVENT_MODEL §3). Diffonde fatti già avvenuti e già
// registrati: chi pubblica non aspetta i sottoscrittori. Ogni sottoscrittore ha una coda FIFO
// limitata consegnata in modo asincrono (microtask), quindi l'ordine di consegna è l'ordine di
// pubblicazione. Oltre il limite gli eventi vengono scartati e contati (i durevoli si recuperano
// dal journal, la UI rileva il buco di `seq`). Un sottoscrittore che lancia (o rigetta una
// promessa) non disturba gli altri. Per emettere un evento si usa `EventEmitter.emit` (core/events):
// valida, registra e poi pubblica qui.
import {
  severityAtLeast,
  type Durability,
  type EventCategory,
  type EventType,
  type VisioneEvent,
  type Severity,
  type TypedEvent
} from '../../shared/contracts/index.ts';

export type EventListener = (event: VisioneEvent) => unknown;

/** Filtro dichiarativo; i campi presenti sono in AND. `types` accetta anche prefissi `system.*`. */
export interface EventFilter {
  types?: readonly string[];
  categories?: readonly EventCategory[];
  correlationId?: string;
  minSeverity?: Severity;
  durability?: Durability;
  where?: (event: VisioneEvent) => boolean;
}

export interface SubscribeOptions {
  filter?: EventFilter | ((event: VisioneEvent) => boolean);
  maxQueue?: number;
  /** Annulla la sottoscrizione quando il segnale scatta (pulizia legata al proprietario). */
  signal?: AbortSignal;
  /** Nome per i log (errori, overflow). */
  name?: string;
}

export interface Subscription {
  unsubscribe(): void;
  readonly active: boolean;
  readonly dropped: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BusStats {
  subscribers: number;
  published: number;
  delivered: number;
  dropped: number;
  listenerErrors: number;
}

export interface EventBus {
  publish(event: VisioneEvent): void;
  subscribe(listener: EventListener, opts?: SubscribeOptions): Subscription;
  /** Sottoscrizione tipizzata a un solo tipo. */
  on<T extends EventType>(type: T, listener: (event: TypedEvent<T>) => unknown, opts?: Omit<SubscribeOptions, 'filter'>): Subscription;
  /** Come `subscribe`, ma si annulla da sola dopo il primo evento consegnato. */
  once(listener: EventListener, opts?: SubscribeOptions): Subscription;
  /** Il prossimo evento che soddisfa il filtro; rigetta per timeout, annullamento o chiusura del bus. */
  next(filter?: EventFilter | ((event: VisioneEvent) => boolean), opts?: WaitOptions): Promise<VisioneEvent>;
  /** Si risolve quando tutte le code sono state consegnate. */
  idle(): Promise<void>;
  /** Annulla tutte le sottoscrizioni; le pubblicazioni successive sono ignorate. */
  close(): void;
  stats(): BusStats;
}

export interface BusOptions {
  onListenerError?: (err: unknown, event: VisioneEvent, name: string | undefined) => void;
  onOverflow?: (dropped: number, event: VisioneEvent, name: string | undefined) => void;
  /** Avviso (una volta per superamento) quando i sottoscrittori attivi superano la soglia: probabile perdita. */
  onLeakWarning?: (subscribers: number) => void;
  maxSubscribers?: number;
}

const DEFAULT_MAX_QUEUE = 1_000;
const DEFAULT_MAX_SUBSCRIBERS = 200;

export function matchesFilter(event: VisioneEvent, filter: EventFilter): boolean {
  if (filter.types && !filter.types.some((t) => (t.endsWith('.*') ? event.type.startsWith(t.slice(0, -1)) : event.type === t))) return false;
  if (filter.categories && !filter.categories.includes(event.category)) return false;
  if (filter.correlationId !== undefined && event.correlationId !== filter.correlationId) return false;
  if (filter.minSeverity !== undefined && !severityAtLeast(event.severity, filter.minSeverity)) return false;
  if (filter.durability !== undefined && event.durability !== filter.durability) return false;
  if (filter.where && !filter.where(event)) return false;
  return true;
}

function toPredicate(filter: SubscribeOptions['filter']): ((event: VisioneEvent) => boolean) | undefined {
  if (filter === undefined) return undefined;
  if (typeof filter === 'function') return filter;
  return (event) => matchesFilter(event, filter);
}

interface Sub {
  listener: EventListener;
  filter: ((event: VisioneEvent) => boolean) | undefined;
  name: string | undefined;
  maxQueue: number;
  queue: VisioneEvent[];
  scheduled: boolean;
  dropped: number;
  active: boolean;
  once: boolean;
  detach: () => void;
}

export function createEventBus(opts: BusOptions = {}): EventBus {
  const subs = new Set<Sub>();
  const maxSubscribers = opts.maxSubscribers ?? DEFAULT_MAX_SUBSCRIBERS;
  const pendingNext = new Set<(err: Error) => void>();
  let waiters: Array<() => void> = [];
  let closed = false;
  let leakWarned = false;
  let scheduledCount = 0;
  const counters = { published: 0, delivered: 0, dropped: 0, listenerErrors: 0 };

  const busy = (): boolean => scheduledCount > 0;
  const settle = (): void => {
    if (busy()) return;
    const ready = waiters;
    waiters = [];
    for (const resolve of ready) resolve();
  };

  const reportError = (err: unknown, event: VisioneEvent, sub: Sub): void => {
    counters.listenerErrors++;
    try {
      opts.onListenerError?.(err, event, sub.name);
    } catch {
      // il gestore degli errori non deve poter rompere la consegna
    }
  };

  const remove = (sub: Sub): void => {
    if (!sub.active) return;
    sub.active = false;
    sub.queue.length = 0;
    subs.delete(sub);
    sub.detach();
    if (subs.size <= maxSubscribers) leakWarned = false;
    settle();
  };

  const drain = (sub: Sub): void => {
    while (sub.active && sub.queue.length > 0) {
      const event = sub.queue.shift() as VisioneEvent;
      if (sub.once) remove(sub);
      counters.delivered++;
      try {
        const out = sub.listener(event);
        if (out instanceof Promise) out.catch((err: unknown) => reportError(err, event, sub));
      } catch (err) {
        reportError(err, event, sub);
      }
    }
    sub.queue.length = 0;
    sub.scheduled = false;
    scheduledCount = Math.max(0, scheduledCount - 1);
    settle();
  };

  const subscribe = (listener: EventListener, subOpts: SubscribeOptions = {}, once = false): Subscription => {
    const sub: Sub = {
      listener,
      filter: toPredicate(subOpts.filter),
      name: subOpts.name,
      maxQueue: once ? 1 : subOpts.maxQueue ?? DEFAULT_MAX_QUEUE,
      queue: [],
      scheduled: false,
      dropped: 0,
      active: !closed && subOpts.signal?.aborted !== true,
      once,
      detach: () => undefined
    };
    if (sub.active) {
      subs.add(sub);
      if (subOpts.signal) {
        const signal = subOpts.signal;
        const onAbort = (): void => remove(sub);
        signal.addEventListener('abort', onAbort, { once: true });
        sub.detach = () => signal.removeEventListener('abort', onAbort);
      }
      if (subs.size > maxSubscribers && !leakWarned) {
        leakWarned = true;
        opts.onLeakWarning?.(subs.size);
      }
    }
    return {
      unsubscribe: () => remove(sub),
      get active() {
        return sub.active;
      },
      get dropped() {
        return sub.dropped;
      }
    };
  };

  return {
    publish(event) {
      if (closed) return;
      counters.published++;
      for (const sub of subs) {
        if (sub.filter) {
          let match: boolean;
          try {
            match = sub.filter(event);
          } catch (err) {
            reportError(err, event, sub);
            continue;
          }
          if (!match) continue;
        }
        // Una sottoscrizione `once` riceve un solo evento: gli altri non sono "scartati".
        if (sub.once && sub.queue.length > 0) continue;
        if (sub.queue.length >= sub.maxQueue) {
          sub.dropped++;
          counters.dropped++;
          // Un solo avviso per episodio di overflow, poi ogni 1000: evita una tempesta di log
          // quando un sottoscrittore resta saturo. Il totale resta in `stats()`/`sub.dropped`.
          if (sub.dropped === 1 || sub.dropped % 1_000 === 0) opts.onOverflow?.(sub.dropped, event, sub.name);
          continue;
        }
        sub.queue.push(event);
        if (!sub.scheduled) {
          sub.scheduled = true;
          scheduledCount++;
          queueMicrotask(() => drain(sub));
        }
      }
    },
    subscribe: (listener, subOpts) => subscribe(listener, subOpts),
    on(type, listener, subOpts = {}) {
      return subscribe(listener as EventListener, { ...subOpts, filter: (e) => e.type === type });
    },
    once: (listener, subOpts) => subscribe(listener, subOpts, true),
    next(filter, waitOpts = {}) {
      return new Promise<VisioneEvent>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let sub: Subscription | undefined;
        const onAbort = (): void => fail(new Error('attesa annullata'));
        const finish = (): void => {
          clearTimeout(timer);
          pendingNext.delete(fail);
          waitOpts.signal?.removeEventListener('abort', onAbort);
          sub?.unsubscribe();
        };
        function fail(err: Error): void {
          finish();
          reject(err);
        }
        if (closed) return fail(new Error('bus chiuso'));
        if (waitOpts.signal?.aborted) return fail(new Error('attesa annullata'));
        sub = subscribe((event) => {
          finish();
          resolve(event);
        }, { ...(filter ? { filter } : {}), name: 'next' }, true);
        pendingNext.add(fail);
        waitOpts.signal?.addEventListener('abort', onAbort, { once: true });
        if (waitOpts.timeoutMs !== undefined) {
          timer = setTimeout(() => fail(new Error(`nessun evento entro ${waitOpts.timeoutMs} ms`)), waitOpts.timeoutMs);
        }
      });
    },
    idle() {
      if (!busy()) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      if (closed) return;
      closed = true;
      for (const fail of [...pendingNext]) fail(new Error('bus chiuso'));
      for (const sub of [...subs]) remove(sub);
    },
    stats() {
      return { subscribers: subs.size, ...counters };
    }
  };
}
