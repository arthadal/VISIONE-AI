// Collegamento main ↔ core: supervisore + inoltro dei comandi + eventi del main con spool.
// Nessun import di `electron`: lo stesso cablaggio è usato dall'app (utilityProcess) e dai test
// d'integrazione (processo Node).
import type { CoreStateSnapshot, VisioneEvent, SupervisorSnapshot } from '../shared/contracts/index.ts';
import type { CoreToVoice, VoiceToCore } from '../shared/contracts/index.ts';
import type { VisioneConfig } from '../shared/node/config.ts';
import type { Logger } from '../shared/node/logging.ts';
import { createCommandRelay, type CommandRelay } from './command-relay.ts';
import { createMainEventRelay, type MainEventRelay } from './event-relay.ts';
import type { Spool } from './spool.ts';
import { CoreSupervisor, type CoreProcessFactory, type Timers } from './supervisor.ts';

export interface CoreLinkDeps {
  factory: CoreProcessFactory;
  config: VisioneConfig;
  appVersion: string;
  spool: Spool;
  log: Logger;
  /** Verso la UI (nessuna finestra = no-op). */
  toRenderer: {
    event(event: VisioneEvent): void;
    /** Stato del core (dagli eventi `state.changed`, che non vanno sul canale degli eventi). */
    state(snapshot: CoreStateSnapshot): void;
    supervisor(snapshot: SupervisorSnapshot): void;
  };
  /** Ordini del core al processo voce (Fase 9): il main li inoltra senza interpretarli. */
  onVoice?: (msg: CoreToVoice) => void;
  /** Il core è pronto: il main può avviare il processo voce (i frame prima di `ready` andrebbero persi). */
  onReady?: () => void;
  timers?: Timers;
}

export interface CoreLink {
  readonly supervisor: CoreSupervisor;
  readonly commands: CommandRelay;
  readonly events: MainEventRelay;
  /** Fatti del processo voce verso il core (Fase 9). */
  voiceToCore(msg: VoiceToCore): boolean;
}

export function createCoreLink(deps: CoreLinkDeps): CoreLink {
  // `supervisor` è assegnato subito sotto; le funzioni di invio sono chiamate solo dopo l'avvio.
  let supervisor: CoreSupervisor | null = null;
  const sendToCore: Parameters<typeof createCommandRelay>[0]['send'] = (frame) => supervisor?.send(frame) ?? false;

  const events = createMainEventRelay({
    spool: deps.spool,
    sendToCore,
    toRenderer: deps.toRenderer.event,
    toRendererState: deps.toRenderer.state,
    log: deps.log.child('events')
  });
  const commands = createCommandRelay({
    send: sendToCore,
    defaultTimeoutMs: deps.config.ipc.commandTimeoutMs,
    log: deps.log.child('ipc'),
    ...(deps.timers ? { timers: deps.timers } : {})
  });
  supervisor = new CoreSupervisor({
    factory: deps.factory,
    config: deps.config.supervisor,
    appVersion: deps.appVersion,
    log: deps.log.child('supervisor'),
    emit: (type, payload) => {
      events.emit(type, payload);
    },
    onFrame: (frame) => {
      if (frame.kind === 'res') commands.onResponse(frame.response);
      else if (frame.kind === 'evt') events.forwardCoreEvent(frame.event);
      else if (frame.kind === 'voice') deps.onVoice?.(frame.msg);
      else events.onIngested(frame.ids);
    },
    onStateChange: (snapshot) => {
      deps.toRenderer.supervisor(snapshot);
      if (snapshot.state === 'ready') {
        events.flush();
        deps.onReady?.();
      } else commands.failAll('core_unavailable', `core ${snapshot.state}`);
    },
    ...(deps.timers ? { timers: deps.timers } : {})
  });
  return {
    supervisor,
    commands,
    events,
    voiceToCore: (msg) => sendToCore({ kind: 'voice', msg })
  };
}
