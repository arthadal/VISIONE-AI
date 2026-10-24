// Modalità offline (17/10/2026): c'è rete? Una connessione TCP alla porta 443 di un host noto, con un tetto
// di tempo. Gli host sono quelli che Windows stesso usa per la stessa domanda (nessun dato inviato: si apre e
// si chiude la connessione); il secondo serve se il primo è giù.
import { connect } from 'node:net';

export const PROBE_HOSTS: readonly string[] = ['www.msftconnecttest.com', 'www.microsoft.com'];

export function probeHost(host: string, port = 443, timeoutMs = 4_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Rete presente se almeno un host risponde. */
export async function probeNetwork(hosts: readonly string[] = PROBE_HOSTS, timeoutMs = 4_000): Promise<boolean> {
  for (const host of hosts) {
    if (await probeHost(host, 443, timeoutMs)) return true;
  }
  return false;
}
