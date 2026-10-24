// Eventi prodotti dal main (`app.*`, `core.*`): vanno subito alla UI e nel journal del core.
// Il core può essere assente (crash, chiusura): gli eventi restano in uno spool su disco finché il
// core non conferma la registrazione (`ingested`), anche attraverso un riavvio dell'app (P-23).
import {
  createEvent,
  isEvent,
  type CoreStateSnapshot,
  type EventPayload,
  type EventType,
  type MainToCoreFrameBody,
  type VisioneEvent
} from '../shared/contracts/index.ts';
import type { Logger } from '../shared/node/logging.ts';
import type { Spool } from './spool.ts';

export type MainEventType = Extract<EventType, `app.${string}` | `core.${string}`>;

export interface MainEventRelayDeps {
  spool: Spool;
  sendToCore: (frame: MainToCoreFrameBody) => boolean;
  toRenderer: (event: VisioneEvent) => void;
  toRendererState: (snapshot: CoreStateSnapshot) => void;
  log: Logger;
}

const INGEST_BATCH = 200;

export interface MainEventRelay {
  emit<T extends MainEventType>(type: T, payload: EventPayload<T>): VisioneEvent;
  /** Invia al core gli eventi in attesa (da chiamare quando il core diventa pronto). */
  flush(): void;
  onIngested(ids: readonly string[]): void;
  /** Evento dal bus del core verso la UI; `state.changed` va sul canale dello stato. */
  forwardCoreEvent(event: VisioneEvent): void;
}

export function createMainEventRelay(deps: MainEventRelayDeps): MainEventRelay {
  return {
    emit(type, payload) {
      const event = createEvent(type, payload);
      deps.log.info(`evento ${type}`, { correlationId: event.correlationId, payload: event.payload });
      deps.spool.add(event);
      deps.toRenderer(event);
      deps.sendToCore({ kind: 'ingest', events: [event] });
      return event;
    },
    flush() {
      const events = deps.spool.list();
      for (let i = 0; i < events.length; i += INGEST_BATCH) {
        if (!deps.sendToCore({ kind: 'ingest', events: events.slice(i, i + INGEST_BATCH) })) return;
      }
    },
    onIngested(ids) {
      deps.spool.remove(ids);
    },
    forwardCoreEvent(event) {
      if (isEvent(event, 'state.changed')) deps.toRendererState(event.payload.snapshot);
      else deps.toRenderer(event);
    }
  };
}
