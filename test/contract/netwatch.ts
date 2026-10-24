// Osservazione delle connessioni TCP aperte dai discendenti di un processo (VISIONE_SECURITY_MODEL
// §3): PowerShell `Get-NetTCPConnection -OwningProcess`. Solo lettura, nessun filtro: VISIONE non può
// bloccare la rete di un processo figlio, può osservarla e segnalare host inattesi.
// Si avvia PRIMA del turno sulla radice (il processo dei test): i turni brevi durano pochi secondi,
// meno dell'avvio di PowerShell.
import { spawn } from 'node:child_process';
import { lookup, reverse } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface Connection {
  readonly pid: number;
  /** Nome del processo proprietario (senza estensione). */
  readonly name: string;
  readonly address: string;
  readonly port: number;
}

// Discendenti ricalcolati ogni ~0,5 s, solo se nati dopo la radice (un ParentProcessId può
// riferirsi a un padre morto il cui pid è stato riusato); connessioni campionate ogni ~100 ms.
// Le connessioni della radice stessa e di PowerShell non sono riportate.
const SCRIPT = (root: number) => `
$ErrorActionPreference = 'SilentlyContinue'
$rootStart = (Get-Process -Id ${root}).StartTime
$ids = @(${root})
$names = @{}
$tick = 0
while ($true) {
  if ($tick % 5 -eq 0) {
    $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate
    $added = $true
    while ($added) {
      $added = $false
      foreach ($p in $all) {
        if (($ids -contains $p.ParentProcessId) -and -not ($ids -contains $p.ProcessId) -and ($p.CreationDate -ge $rootStart) -and ($p.ProcessId -ne $PID)) {
          $ids += $p.ProcessId; $names[[int]$p.ProcessId] = $p.Name -replace '\\.exe$', ''; $added = $true
        }
      }
    }
    if ($tick -eq 0) { 'READY' }
  }
  $watched = $ids | Where-Object { $_ -ne ${root} }
  if ($watched) {
    Get-NetTCPConnection -OwningProcess $watched | Where-Object { $_.RemoteAddress -ne '0.0.0.0' -and $_.RemoteAddress -ne '::' } | ForEach-Object { "$($_.OwningProcess) $($names[[int]$_.OwningProcess]) $($_.RemoteAddress) $($_.RemotePort)" }
  }
  $tick++
  Start-Sleep -Milliseconds 100
}`;

export interface ConnectionWatch {
  /** Prima scansione dei processi completata: da qui in poi i nuovi discendenti sono osservati. */
  readonly ready: Promise<void>;
  stop(): Promise<Connection[]>;
}

export function watchConnections(rootPid: number): ConnectionWatch {
  const encoded = Buffer.from(SCRIPT(rootPid), 'utf16le').toString('base64');
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const seen = new Map<string, Connection>();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  let buffer = '';
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === 'READY') {
        markReady();
        continue;
      }
      const [pid, name, address, port] = line.trim().split(' ');
      if (!pid || !name || !address || !port) continue;
      seen.set(`${pid}>${address}:${port}`, { pid: Number(pid), name, address, port: Number(port) });
    }
  });
  ps.on('exit', () => markReady());
  return {
    ready,
    async stop() {
      // Un ultimo campione dopo la fine del turno (connessioni in chiusura).
      await new Promise((r) => setTimeout(r, 300));
      ps.kill();
      return [...seen.values()];
    }
  };
}

export interface Classified extends Connection {
  /** `motore` = host documentato della CLI (es. `api.opencode.ai`): non è un endpoint di VISIONE. */
  readonly verdict: 'locale' | 'atteso' | 'motore' | 'inatteso';
  readonly host: string | null;
}

/**
 * Locale (loopback) · atteso (indirizzo di uno degli host attesi) · motore (host proprio della CLI,
 * documentato) · inatteso (segnalato). Gli host del motore sono risolti come gli attesi.
 */
export async function classify(connections: readonly Connection[], expectedHosts: readonly string[], engineHosts: readonly string[] = []): Promise<Classified[]> {
  const expected = new Map<string, string>();
  for (const host of expectedHosts) {
    for (const r of await lookup(host, { all: true }).catch(() => [])) expected.set(r.address, host);
  }
  const engine = new Map<string, string>();
  for (const host of engineHosts) {
    for (const r of await lookup(host, { all: true }).catch(() => [])) engine.set(r.address, host);
  }
  const out: Classified[] = [];
  for (const c of connections) {
    const loopback = c.address === '::1' || c.address.startsWith('127.') || c.address.startsWith('::ffff:127.');
    if (loopback) {
      out.push({ ...c, verdict: 'locale', host: null });
      continue;
    }
    const engineHost = engine.get(c.address);
    if (engineHost) {
      out.push({ ...c, verdict: 'motore', host: engineHost });
      continue;
    }
    const host = expected.get(c.address) ?? null;
    const name = host ?? (isIP(c.address) ? (await reverse(c.address).catch(() => []))[0] ?? null : null);
    out.push({ ...c, verdict: host ? 'atteso' : 'inatteso', host: name });
  }
  return out;
}
