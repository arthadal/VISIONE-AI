// Factory del processo core come utilityProcess di Electron (processo Node separato dalla UI).
import { utilityProcess } from 'electron';
import { constants, setPriority } from 'node:os';
import type { MainToCoreFrameBody } from '../shared/contracts/index.ts';
import { FRAME_VERSION } from '../shared/contracts/index.ts';
import type { CoreProcessFactory } from './supervisor.ts';

export interface UtilityCoreOptions {
  entry: string;
  env: Record<string, string>;
}

export function createUtilityCoreFactory(opts: UtilityCoreOptions): CoreProcessFactory {
  return () => {
    const child = utilityProcess.fork(opts.entry, [], {
      serviceName: 'VISIONE Core',
      stdio: 'pipe',
      env: opts.env
    });
    // Un kill chiesto prima che il processo esista non lo ferma (VM da «vergine», 22/10/2026: il core abbandonato è
    // partito dopo ed è rimasto acceso accanto al nuovo): si ripete appena il processo esiste.
    let killed = false;
    child.once('spawn', () => {
      if (killed) child.kill();
    });
    return {
      send: (frame: MainToCoreFrameBody) => child.postMessage({ v: FRAME_VERSION, ...frame }),
      kill: () => {
        killed = true;
        child.kill();
      },
      onSpawn: (listener) => child.once('spawn', () => {
        // Collaudo su un PC vergine (17/10/2026): con la CPU al 100% (sintesi vocale su tutti i core,
        // antivirus, installazioni) il core leggero restava senza CPU e perdeva l'heartbeat. Una priorità
        // sopra il normale gli lascia sempre lo spazio; non serve essere amministratore.
        try {
          if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_ABOVE_NORMAL);
        } catch {
          /* priorità non cambiata: il core funziona lo stesso */
        }
        listener(child.pid ?? 0);
      }),
      onMessage: (listener) => child.on('message', listener),
      onExit: (listener) => child.once('exit', (code) => listener(code)),
      onStderr: (listener) => {
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => listener(chunk));
        // stdout del core: solo diagnostica (il logger del core scrive su file).
        child.stdout?.resume();
      }
    };
  };
}

/** Ambiente del core: quello del main (stringhe soltanto) più le variabili di VISIONE. */
export function coreEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v;
  return { ...env, ...extra };
}
