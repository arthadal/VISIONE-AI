// Variabili d'ambiente dell'utente Windows (P-105): dove l'utente tiene le sue chiavi (come con
// `setx`), mai in un file di VISIONE. La presenza si controlla senza leggere il valore (`reg query`
// con l'uscita scartata); la scrittura passa il valore a PowerShell da stdin, non sulla riga di
// comando (che altri processi possono vedere). `SetEnvironmentVariable(..., 'User')` avvisa Windows
// del cambio (WM_SETTINGCHANGE): i programmi aperti dopo la vedono.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Dove si trova la variabile: nell'ambiente di questo processo, solo in quello dell'utente, o in nessuno. */
export type EnvPresence = 'processo' | 'utente' | null;

/** Esegue un programma di sistema senza mostrare l'uscita; `stdin` facoltativo. Restituisce il codice d'uscita. */
export type SystemRunner = (exe: string, args: readonly string[], stdin?: string) => Promise<number>;

export interface UserEnvDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: SystemRunner;
  readonly platform?: NodeJS.Platform;
}

const systemDir = (): string => join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32');

/** L'uscita dei programmi non arriva mai qui: né il valore letto da `reg`, né altro. */
export const runSystem: SystemRunner = (exe, args, stdin) =>
  new Promise((resolve) => {
    const child = spawn(exe, [...args], { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? -1));
    if (stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    }
  });

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error(`nome di variabile non valido: ${name}`);
}

export async function userEnvPresence(name: string, deps: UserEnvDeps = {}): Promise<EnvPresence> {
  checkName(name);
  if ((deps.env ?? process.env)[name]?.trim()) return 'processo';
  if ((deps.platform ?? process.platform) !== 'win32') return null;
  const code = await (deps.run ?? runSystem)(join(systemDir(), 'reg.exe'), ['query', 'HKCU\\Environment', '/v', name]);
  return code === 0 ? 'utente' : null;
}

/** Salva la variabile nell'ambiente dell'utente Windows. Il valore non compare in nessun messaggio d'errore. */
export async function setUserEnv(name: string, value: string, deps: UserEnvDeps = {}): Promise<void> {
  checkName(name);
  if ((deps.platform ?? process.platform) !== 'win32') throw new Error('le variabili dell\'utente si salvano così solo su Windows');
  if (value.length < 1 || value.length > 4_096 || /[\r\n\0]/.test(value)) throw new Error(`valore di ${name} non valido (vuoto, troppo lungo o su più righe)`);
  const script = `$v = [Console]::In.ReadLine(); [Environment]::SetEnvironmentVariable('${name}', $v, 'User')`;
  const exe = join(systemDir(), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const code = await (deps.run ?? runSystem)(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], `${value}\n`);
  if (code !== 0) throw new Error(`impossibile salvare ${name} nelle variabili dell'utente (PowerShell codice ${code})`);
}
