// Niente rallentamenti di Windows per i processi di lavoro senza finestra (issue #1 su GitHub, idea 8, 04/11/2026).
// A un processo senza finestra e senza audio Windows può dare la qualità del servizio «Eco» (EcoQoS: core lenti,
// frequenza bassa) e ignorarne la risoluzione del timer: per la voce sono pause fra le frasi, per il core risposte in
// ritardo. `SetProcessInformation(ProcessPowerThrottling)` con la maschera di controllo accesa e lo stato a zero dice
// a Windows di non farlo mai per quel processo. Nessuna dipendenza: una PowerShell di sistema con P/Invoke per ogni
// avvio di processo, in sottofondo (misurato qui il 04/11/2026: 0,5–0,7 s; rilettura «5 0»).
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { Logger } from './logging.ts';

/** PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION. */
export const QOS_CONTROL = 0x1 | 0x4;
/** PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION. */
const ACCESS = 0x0200 | 0x1000;
/** PROCESS_INFORMATION_CLASS.ProcessPowerThrottling. */
const POWER_THROTTLING = 4;

export interface QosResult {
  readonly pid: number;
  readonly ok: boolean;
  /** Maschere rilette («5 0» = mai rallentato) o codice d'errore di Windows. */
  readonly detail: string;
}

/** Script PowerShell: per ogni pid apre il processo, toglie il rallentamento e rilegge. Una riga per pid. */
export function qosScript(pids: readonly number[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace Visione -Name Qos -MemberDefinition @'",
    '[StructLayout(LayoutKind.Sequential)] public struct Throttle { public uint Version; public uint ControlMask; public uint StateMask; }',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetProcessInformation(IntPtr process, int infoClass, ref Throttle info, int size);',
    '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessInformation(IntPtr process, int infoClass, ref Throttle info, int size);',
    '[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);',
    "'@",
    `foreach ($id in @(${pids.join(', ')})) {`,
    `  $h = [Visione.Qos]::OpenProcess(${ACCESS}, $false, $id)`,
    '  if ($h -eq [IntPtr]::Zero) { "$id err $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; continue }',
    '  $t = New-Object Visione.Qos+Throttle',
    `  $t.Version = 1; $t.ControlMask = ${QOS_CONTROL}; $t.StateMask = 0`,
    '  $size = [Runtime.InteropServices.Marshal]::SizeOf($t)',
    `  $ok = [Visione.Qos]::SetProcessInformation($h, ${POWER_THROTTLING}, [ref]$t, $size)`,
    '  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()',
    '  $r = New-Object Visione.Qos+Throttle',
    '  $r.Version = 1',
    `  [void][Visione.Qos]::GetProcessInformation($h, ${POWER_THROTTLING}, [ref]$r, $size)`,
    '  [void][Visione.Qos]::CloseHandle($h)',
    '  if ($ok) { "$id ok $($r.ControlMask) $($r.StateMask)" } else { "$id err $err" }',
    '}'
  ].join('\n');
}

export function parseQos(stdout: string): QosResult[] {
  const out: QosResult[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\d+) (ok|err) (.*)$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), ok: m[2] === 'ok', detail: (m[3] ?? '').trim() });
  }
  return out;
}

/**
 * Chiede a Windows di non rallentare mai questi processi (dello stesso utente). In sottofondo, mai un'eccezione:
 * senza riuscita il processo lavora come prima. Fuori da Windows non fa niente.
 */
export function keepFullSpeed(pids: readonly number[], done?: (results: QosResult[], error: string | null) => void): void {
  const valid = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (process.platform !== 'win32' || valid.length === 0) return;
  const exe = join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(qosScript(valid), 'utf16le').toString('base64');
  try {
    execFile(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20_000 }, (err, stdout) => {
      done?.(parseQos(String(stdout)), err ? err.message.slice(0, 300) : null);
    });
  } catch (err) {
    done?.([], err instanceof Error ? err.message : String(err));
  }
}

/** Una riga nel registro per processo: così un rallentamento rimasto si vede nel pacchetto «Segnala un problema». */
export function logQos(log: Pick<Logger, 'info' | 'warn'>, name: string): (results: QosResult[], error: string | null) => void {
  return (results, error) => {
    if (error === null && results.length > 0 && results.every((r) => r.ok)) log.info('Windows non rallenterà il processo', { name, results });
    else log.warn('rallentamento di Windows non tolto: il processo lavora come prima', { name, results, error });
  };
}
