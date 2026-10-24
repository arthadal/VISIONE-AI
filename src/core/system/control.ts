// System Control (Fase 24b, P-72): metriche REALI della macchina e azioni di controllo supportate.
// Nessun numero inventato: se una metrica non è ottenibile resta null (N/D). Lock/shutdown/restart
// richiedono `confirm: true` nel payload (impossibile attivarli per sbaglio); ogni azione emette un
// evento durevole. Volume/mute con i tasti multimediali di sistema via PowerShell (nessuna libreria).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { cpus, freemem, hostname, loadavg, totalmem, uptime, version } from 'node:os';
import { CommandFailure } from '../commands/index.ts';
import type { EventEmitter } from '../events/index.ts';

export interface SystemInfoSnapshot {
  readonly hostname: string;
  readonly windows: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly loadavg: number[] | null;
  readonly memTotalBytes: number;
  readonly memFreeBytes: number;
  readonly disk: { path: string; totalBytes: number; freeBytes: number } | null;
  readonly uptimeSec: number;
}

export type ControlAction = 'volume-up' | 'volume-down' | 'mute-toggle' | 'task-manager' | 'settings' | 'lock' | 'sleep' | 'shutdown' | 'restart' | 'start-menu';

export interface SystemControl {
  info(): SystemInfoSnapshot;
  exec(action: ControlAction, confirm: boolean | undefined, by: string): Promise<{ action: string; performed: boolean; note: string | null }>;
}

type RunFn = (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;
type StartFn = (file: string, args: readonly string[]) => ChildProcess;

/** Azioni che richiedono la conferma esplicita dell'utente. */
const NEEDS_CONFIRM: ReadonlySet<ControlAction> = new Set(['lock', 'shutdown', 'restart']);
const MEDIA_KEY: Readonly<Record<string, number>> = { 'volume-up': 175, 'volume-down': 174, 'mute-toggle': 173 };

export function createSystemControl(deps: { home: string; events: EventEmitter; run?: RunFn; start?: StartFn }): SystemControl {
  const run: RunFn =
    deps.run ??
    ((file, args, timeout) =>
      new Promise((resolve) => {
        execFile(file, [...args], { windowsHide: true, timeout, encoding: 'utf8' }, (err, stdout) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
          resolve({ code, stdout: String(stdout ?? '') });
        });
      }));
  const start: StartFn =
    deps.start ??
    ((file, args) => spawn(file, [...args], { windowsHide: false, detached: true, stdio: 'ignore' }));

  const launch = (file: string, args: readonly string[]): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        const child = start(file, args);
        child.once('error', () => done(false));
        child.once('spawn', () => {
          child.unref();
          done(true);
        });
      } catch {
        done(false);
      }
    });

  return {
    info() {
      const load = loadavg();
      const loadavgValue = load.every((v) => v === 0) ? null : load; // su Windows loadavg resta [0,0,0] → N/D
      let disk: SystemInfoSnapshot['disk'] = null;
      try {
        const st = statfsSync(deps.home);
        disk = { path: deps.home, totalBytes: Number(st.bsize) * Number(st.blocks), freeBytes: Number(st.bsize) * Number(st.bfree) };
      } catch {
        disk = null;
      }
      return {
        hostname: hostname(),
        windows: version(),
        cpuModel: cpus()[0]?.model ?? 'N/D',
        cpuCount: cpus().length,
        loadavg: loadavgValue,
        memTotalBytes: totalmem(),
        memFreeBytes: freemem(),
        disk,
        uptimeSec: Math.floor(uptime())
      };
    },
    async exec(action, confirm, by) {
      if (NEEDS_CONFIRM.has(action) && confirm !== true) {
        throw new CommandFailure('forbidden', `l'azione ${action} richiede conferma esplicita`);
      }
      let performed = false;
      let note: string | null = null;
      if (action in MEDIA_KEY) {
        const key = MEDIA_KEY[action];
        const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait([char]${key})`;
        const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8_000);
        performed = res.code === 0;
        if (!performed) note = 'tasto multimediale non inviato';
      } else if (action === 'start-menu') {
        // Start di Windows (11/10/2026, dal tasto Start di VISIONE): Ctrl+Esc lo apre anche sopra
        // VISIONE a schermo intero; lo gestisce la shell di Windows, non l'app in primo piano.
        const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^{ESC}')"], 8_000);
        performed = res.code === 0;
      } else if (action === 'task-manager') {
        performed = await launch('taskmgr.exe', []);
      } else if (action === 'settings') {
        performed = await launch('explorer.exe', ['ms-settings:']);
      } else if (action === 'lock') {
        performed = await launch('rundll32.exe', ['user32.dll,LockWorkStation']);
      } else if (action === 'sleep') {
        performed = await launch('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
        note = performed ? 'sospensione richiesta al sistema (dipende dalle impostazioni di risparmio energetico)' : null;
      } else if (action === 'shutdown') {
        performed = await launch('shutdown.exe', ['/s', '/t', '0']);
      } else if (action === 'restart') {
        performed = await launch('shutdown.exe', ['/r', '/t', '0']);
      }
      if (!performed) throw new CommandFailure('operation_failed', `azione non riuscita: ${action}`);
      deps.events.emit('system.control.performed', { action, by });
      return { action, performed: true, note };
    }
  };
}
