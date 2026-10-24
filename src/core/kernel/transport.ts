// Canale del core verso il main. Nel prodotto è il `parentPort` del utilityProcess di Electron;
// nei test d'integrazione è il canale IPC di `child_process.fork` di Node. Il core non importa
// `electron`: riconosce il canale dalla forma di `process`.
import { FRAME_VERSION, type CoreToMainFrame, type CoreToMainFrameBody } from '../../shared/contracts/index.ts';

export interface CoreTransport {
  send(frame: CoreToMainFrameBody): void;
  onFrame(handler: (raw: unknown) => void): void;
  /** Il main non è più raggiungibile. */
  onDisconnect(handler: () => void): void;
}

interface ParentPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

function stamp(frame: CoreToMainFrameBody): CoreToMainFrame {
  return { v: FRAME_VERSION, ...frame } as CoreToMainFrame;
}

export function createProcessTransport(proc: NodeJS.Process = process): CoreTransport {
  const parentPort = (proc as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort;
  if (parentPort) {
    return {
      send: (frame) => parentPort.postMessage(stamp(frame)),
      onFrame: (handler) => parentPort.on('message', (e) => handler(e.data)),
      // Electron termina il utilityProcess insieme al main: nessun segnale da gestire qui.
      onDisconnect: () => undefined
    };
  }
  const send = proc.send?.bind(proc);
  if (send) {
    return {
      send: (frame) => {
        if (proc.connected) send(stamp(frame));
      },
      onFrame: (handler) => proc.on('message', handler),
      onDisconnect: (handler) => proc.on('disconnect', handler)
    };
  }
  throw new Error('il core deve essere avviato dal main (utilityProcess) o con un canale IPC');
}
