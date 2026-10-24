// Terminazione dell'albero di processi e ispezione dei processi del sistema operativo
// (MUNDER_CLI_RUNTIME §13). Strumenti di sistema avviati senza shell, con percorso assoluto.
import { execFile } from 'node:child_process';
import { join } from 'node:path';

export interface OsProcessInfo {
  readonly pid: number;
  /** Ora di creazione secondo il sistema operativo (epoch ms). */
  readonly startedAt: number;
  /** Nome dell'immagine senza estensione, minuscolo. */
  readonly name: string;
}

export interface ProcessTools {
  /** Termina il processo e i suoi discendenti; true se il sistema conferma. */
  killTree(pid: number): Promise<boolean>;
  /** Processi vivi tra quelli indicati (per la riconciliazione dopo una caduta del core). */
  inspect(pids: readonly number[]): Promise<Map<number, OsProcessInfo>>;
}

function system32(file: string): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', file);
}

function run(file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

export function createProcessTools(platform: NodeJS.Platform = process.platform): ProcessTools {
  if (platform !== 'win32') {
    return {
      async killTree(pid) {
        try {
          process.kill(pid, 'SIGKILL');
          return true;
        } catch {
          return false;
        }
      },
      async inspect(pids) {
        const alive = new Map<number, OsProcessInfo>();
        for (const pid of pids) {
          try {
            process.kill(pid, 0);
            alive.set(pid, { pid, startedAt: 0, name: '' });
          } catch {
            // non esiste
          }
        }
        return alive;
      }
    };
  }
  return {
    async killTree(pid) {
      // /T: tutto l'albero; /F: forzato. Codice 128 = processo già terminato.
      const r = await run(system32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], 10_000);
      if (r.code === 0 || r.code === 128) return true;
      // Ripiego: almeno la radice (TerminateProcess).
      try {
        process.kill(pid);
        return true;
      } catch {
        return false;
      }
    },
    async inspect(pids) {
      const out = new Map<number, OsProcessInfo>();
      const list = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
      if (list.length === 0) return out;
      const script = `Get-Process -Id ${list.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.StartTime.ToUniversalTime().ToString('o'))|$($_.ProcessName)" }`;
      const r = await run(system32('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], 15_000);
      for (const line of r.stdout.split(/\r?\n/)) {
        const [pid, started, name] = line.trim().split('|');
        const t = Date.parse(started ?? '');
        if (pid && Number.isFinite(t)) out.set(Number(pid), { pid: Number(pid), startedAt: t, name: (name ?? '').toLowerCase() });
      }
      return out;
    }
  };
}
