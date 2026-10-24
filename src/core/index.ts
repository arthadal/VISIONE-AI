// Punto d'ingresso del processo core (utilityProcess avviato dal main).
// Richiede VISIONE_HOME, impostata dal main. Un errore non gestito non viene "tenuto in vita":
// viene registrato e il processo esce, il supervisore lo riavvia.
import { resolvePaths } from '../shared/node/paths.ts';
import { createProcessTransport, startCore, type CoreHandle } from './kernel/index.ts';

const transport = createProcessTransport();

function bootFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`VISIONE core: avvio fallito: ${message}\n`);
  transport.send({ kind: 'fatal', message: `boot: ${message}`.slice(0, 2000) });
  setTimeout(() => process.exit(2), 50);
}

let core: CoreHandle | undefined;
try {
  const home = process.env.VISIONE_HOME;
  if (!home) throw new Error('VISIONE_HOME non impostata');
  core = startCore({
    transport,
    paths: resolvePaths(home),
    env: process.env,
    pid: process.pid,
    parentPid: Number(process.env.VISIONE_MAIN_PID) || process.ppid,
    coreVersion: process.env.VISIONE_APP_VERSION ?? '0.0.0-dev',
    exit: (code) => process.exit(code)
  });
} catch (err) {
  bootFailure(err);
}

process.on('uncaughtException', (err) => core?.fail(err, 'uncaught-exception'));
process.on('unhandledRejection', (reason) => core?.fail(reason, 'unhandled-rejection'));
