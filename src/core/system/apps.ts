// Launcher delle applicazioni installate (Fase 24, P-71). Elenco REALE dal menu Start di Windows
// (`Get-StartApps`, sola lettura) e avvio via `explorer.exe shell:AppsFolder\<id>` — il meccanismo
// supportato dal sistema, senza shell di comando e senza una lista statica nel prodotto. Gli id
// vengono validati e, dopo un elenco, l'avvio accetta solo id presenti in quell'elenco.
import { execFile, spawn, type ChildProcess } from 'node:child_process';

export interface OsApp {
  readonly id: string;
  readonly name: string;
}

export interface AppCatalog {
  list(): Promise<OsApp[]>;
  launch(id: string): Promise<{ launched: boolean; name: string | null }>;
}

/** Id applicazione accettabili per `shell:AppsFolder` (niente metacaratteri, niente percorsi). */
export const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._!+-]{0,199}$/;

type ExecFn = (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;
type StartFn = (file: string, args: readonly string[]) => ChildProcess;

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-StartApps | ConvertTo-Json -Compress'];

export function createAppCatalog(opts: { exec?: ExecFn; start?: StartFn; platform?: NodeJS.Platform; timeoutMs?: number } = {}): AppCatalog {
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const exec: ExecFn =
    opts.exec ??
    ((file, args, timeout) =>
      new Promise((resolve) => {
        execFile(file, [...args], { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
          resolve({ code, stdout: String(stdout ?? '') });
        });
      }));
  const start: StartFn =
    opts.start ??
    ((file, args) =>
      spawn(file, [...args], { windowsHide: false, detached: true, stdio: 'ignore' }));
  /** Ultimo catalogo letto: l'avvio accetta solo id che ne fanno parte (dopo il primo elenco). */
  let known = new Map<string, string>();

  const parse = (stdout: string): OsApp[] => {
    let raw: unknown;
    try {
      raw = JSON.parse(stdout.trim() === '' ? '[]' : stdout);
    } catch {
      return [];
    }
    const rows = Array.isArray(raw) ? raw : [raw];
    const out: OsApp[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const rec = row as Record<string, unknown>;
      const id = typeof rec.AppID === 'string' ? rec.AppID.trim() : '';
      const name = typeof rec.Name === 'string' ? rec.Name.trim() : '';
      if (!APP_ID_PATTERN.test(id) || name === '' || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: name.slice(0, 200) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'it'));
  };

  return {
    async list() {
      if (platform !== 'win32') return [];
      const res = await exec('powershell.exe', PS_ARGS, timeoutMs);
      const apps = parse(res.stdout);
      if (res.code === 0 && apps.length > 0) known = new Map(apps.map((a) => [a.id, a.name]));
      return apps;
    },
    async launch(id) {
      if (platform !== 'win32') return { launched: false, name: null };
      if (!APP_ID_PATTERN.test(id)) return { launched: false, name: null };
      if (known.size > 0 && !known.has(id)) return { launched: false, name: null };
      const explorer = 'explorer.exe';
      return await new Promise((resolve) => {
        let settled = false;
        const done = (launched: boolean): void => {
          if (settled) return;
          settled = true;
          resolve({ launched, name: known.get(id) ?? null });
        };
        try {
          const child = start(explorer, [`shell:AppsFolder\\${id}`]);
          child.once('error', () => done(false));
          child.once('spawn', () => {
            child.unref();
            done(true);
          });
        } catch {
          done(false);
        }
      });
    }
  };
}
