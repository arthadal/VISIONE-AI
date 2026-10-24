// PATH aggiornato dopo un'installazione (17/10/2026): un installatore (quello di un motore, Node.js…) scrive
// il PATH nel registro, ma un processo già avviato — il core di VISIONE — tiene quello vecchio e non trova
// il programma appena installato finché non si riavvia. Qui si rilegge il PATH di sistema e dell'utente da
// `reg query` e lo si unisce a quello attuale: prima le cartelle del registro (nell'ordine di Windows), poi
// quelle che il processo aveva in più. Fuori da Windows non cambia niente.
import { execFile } from 'node:child_process';
import { join } from 'node:path';

const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_KEY = 'HKCU\\Environment';

export type RegReader = (key: string) => Promise<string | null>;

/** Il valore di `Path` da `reg query` (REG_SZ o REG_EXPAND_SZ), o null. */
export function parseRegPath(output: string): string | null {
  const line = output.split(/\r?\n/).find((l) => /^\s+Path\s+REG_(?:EXPAND_)?SZ\s+/i.test(l));
  if (!line) return null;
  return line.replace(/^\s+Path\s+REG_(?:EXPAND_)?SZ\s+/i, '').trim();
}

/** `%USERPROFILE%\bin` → `C:\Users\x\bin` con le variabili del processo; una variabile sconosciuta resta com'è. */
export function expandEnv(value: string, env: Readonly<Record<string, string | undefined>>): string {
  return value.replace(/%([^%]+)%/g, (all, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key !== undefined && env[key] !== undefined ? env[key]! : all;
  });
}

/** Unione senza doppioni (maiuscole/minuscole e «\» finale non contano), nell'ordine dato. */
export function mergePaths(...lists: ReadonlyArray<string | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of (list ?? '').split(';')) {
      const dir = raw.trim();
      const key = dir.toLowerCase().replace(/[\\/]+$/, '');
      if (dir === '' || seen.has(key)) continue;
      seen.add(key);
      out.push(dir);
    }
  }
  return out.join(';');
}

const systemDir = (): string => join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32');

const readReg: RegReader = (key) => new Promise((resolve) => {
  execFile(join(systemDir(), 'reg.exe'), ['query', key, '/v', 'Path'], { windowsHide: true, timeout: 5_000 }, (err, stdout) => {
    resolve(err ? null : parseRegPath(String(stdout)));
  });
});

/**
 * Rilegge il PATH dal registro e lo scrive in `env` (di norma `process.env`, che i motori ereditano).
 * Restituisce il nuovo PATH; se il registro non si legge, `env` resta com'è.
 */
export async function refreshPath(env: Record<string, string | undefined>, opts: { read?: RegReader; platform?: NodeJS.Platform } = {}): Promise<string | null> {
  if ((opts.platform ?? process.platform) !== 'win32') return null;
  const read = opts.read ?? readReg;
  const [machine, user] = await Promise.all([read(MACHINE_KEY), read(USER_KEY)]);
  if (machine === null && user === null) return null;
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  const merged = mergePaths(machine && expandEnv(machine, env), user && expandEnv(user, env), env[key]);
  env[key] = merged;
  return merged;
}
