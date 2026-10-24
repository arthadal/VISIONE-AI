// Telemetria di sistema (Fase 14, DECISIONI P-59): campionatore locale reale, mai stimato.
//
// - CPU e RAM dai contatori di Node (`os.cpus` a delta, `os.totalmem/freemem`), sempre disponibili.
// - Su Windows GPU, VRAM, rete e temperatura da un processo PowerShell **persistente** che interroga
//   le classi WMI di performance (`Win32_PerfFormattedData_*`): nomi indipendenti dalla lingua, a
//   differenza dei contatori `Get-Counter`. Il processo si chiude da solo se il core termina.
// - Fuori da Windows, o se il campionatore fallisce, quei campi restano `null` → la UI mostra N/D.
//
// Un campione diventa l'evento effimero `telemetry.sample`; ogni minuto si scrive un aggregato in
// `telemetry_minutes` e si emette `telemetry.aggregate`. Nessun valore inventato: se manca, è null.
import { spawn, type ChildProcess } from 'node:child_process';
import { cpus, freemem, platform, totalmem, uptime } from 'node:os';
import type { Logger } from '../../shared/node/logging.ts';
import type { EventEmitter } from '../events/index.ts';
import type { TelemetryAggregateRow, TelemetrySample } from '../../shared/contracts/index.ts';
import type { Db } from '../db/index.ts';

/** Sorgente dichiarata degli eventi di telemetria (Endpoint `system`). */
export const TELEMETRY_SOURCE = { kind: 'system', id: 'telemetry' } as const;

/** Parte di sistema del campione (dipende dalla piattaforma/processo). */
export interface SystemSample {
  gpuPercent: number | null;
  vramUsedBytes: number | null;
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
  netLinkBps: number | null;
}

export interface SystemSampler {
  /** Ultimo campione di sistema noto (campi assenti = non ancora disponibili). */
  read(): Partial<SystemSample>;
  start(): void;
  stop(): void;
}

export interface SystemSamplerOptions {
  /** Piattaforma (default: quella corrente). Fuori da Windows non si avvia alcun processo. */
  platform?: NodeJS.Platform;
  enabled?: boolean;
  intervalMs?: number;
  parentPid?: number;
  /** Spawn iniettabile (test). */
  spawnFn?: typeof spawn;
  log?: Pick<Logger, 'info' | 'warn'>;
}

/** Il processo PowerShell: loop, JSON con prefisso riconoscibile, auto-chiusura col core. */
const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$parent = __PARENT_PID__
while (Get-Process -Id $parent -ErrorAction SilentlyContinue) {
  $gpu = (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object { $_.Name -match 'engtype_3D' } | Measure-Object UtilizationPercentage -Sum).Sum
  $vram = 0
  foreach ($m in (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory)) {
    $v = if ($m.DedicatedUsage -gt 0) { $m.DedicatedUsage } else { $m.SharedUsage }
    if ($v -gt $vram) { $vram = $v }
  }
  $rx = 0; $tx = 0; $link = 0
  foreach ($n in (Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface)) {
    if ($n.Name -match 'Loopback') { continue }
    $rx += $n.BytesReceivedPersec; $tx += $n.BytesSentPersec
    if ($n.CurrentBandwidth -gt $link) { $link = $n.CurrentBandwidth }
  }
  [Console]::Out.WriteLine('VISIONETM ' + (ConvertTo-Json -Compress -InputObject ([ordered]@{ gpu=$gpu; vram=$vram; rx=$rx; tx=$tx; link=$link })))
  Start-Sleep -Milliseconds __INTERVAL__
}
`;

/** Righe con questo prefisso sono campioni; CLIXML/progress di PowerShell vengono ignorati. */
export const SAMPLE_PREFIX = 'VISIONETM ';
const MAX_BUFFER = 64_000;
const RESTART_MS = 15_000;

/** Interpreta una riga del campionatore di sistema; `null` se non è un campione valido. */
export function parseSystemLine(line: string): SystemSample | null {
  const at = line.indexOf(SAMPLE_PREFIX);
  if (at < 0) return null;
  try {
    const raw = JSON.parse(line.slice(at + SAMPLE_PREFIX.length)) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const gpu = num(raw.gpu);
    return {
      gpuPercent: gpu === null ? null : Math.max(0, Math.min(100, gpu)),
      vramUsedBytes: num(raw.vram),
      netRxBytesPerSec: num(raw.rx),
      netTxBytesPerSec: num(raw.tx),
      netLinkBps: num(raw.link)
    };
  } catch {
    return null;
  }
}

/**
 * Campionatore di sistema. CPU/RAM non sono qui (Node `os`, sempre disponibili). Se disabilitato o
 * non su Windows, i campi di sistema restano `null` dichiarati.
 */
export function createSystemSampler(opts: SystemSamplerOptions = {}): SystemSampler {
  const plat = opts.platform ?? platform();
  const intervalMs = Math.max(1_000, opts.intervalMs ?? 2_000);
  const spawnFn = opts.spawnFn ?? spawn;
  let child: ChildProcess | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let buffer = '';
  let stopped = true;
  let current: Partial<SystemSample> = {};

  const launch = (): void => {
    if (stopped || child || plat !== 'win32') return;
    const script = PS_SCRIPT.replace('__PARENT_PID__', String(opts.parentPid ?? process.pid)).replace('__INTERVAL__', String(intervalMs));
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    try {
      const c = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child = c;
      c.stdout?.setEncoding('utf8');
      c.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-4_000);
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          const sample = parseSystemLine(line);
          if (sample) current = sample;
          nl = buffer.indexOf('\n');
        }
      });
      c.on('error', () => {
        child = null;
      });
      c.on('exit', () => {
        child = null;
        if (!stopped && retry === null) {
          current = {};
          retry = setTimeout(() => {
            retry = null;
            launch();
          }, RESTART_MS);
        }
      });
      opts.log?.info?.('campionatore di sistema avviato', { intervalMs });
    } catch (err) {
      child = null;
      opts.log?.warn?.('campionatore di sistema non avviato', { err: String(err) });
    }
  };

  return {
    read: () => current,
    start() {
      stopped = false;
      if (opts.enabled === false) return;
      launch();
    },
    stop() {
      stopped = true;
      if (retry !== null) {
        clearTimeout(retry);
        retry = null;
      }
      if (child) {
        try {
          child.kill();
        } catch {
          // già uscito
        }
        child = null;
      }
      current = {};
    }
  };
}

// --- Provider di sensori esterni (temperature) -----------------------------------------------
// LibreHardwareMonitor (MPL-2.0) espone i sensori via web server locale su loopback (JSON). VISIONE
// legge SOLO 127.0.0.1/localhost (nessun host esterno); se il provider non è attivo le temperature
// restano `null` → N/D. Nessuna dipendenza: solo `fetch` di Node.

export interface SensorTemps {
  cpuTemperatureC: number | null;
  gpuTemperatureC: number | null;
}

export interface SensorProvider {
  read(): Partial<SensorTemps>;
  start(): void;
  stop(): void;
}

export const LHM_DEFAULT_URL = 'http://127.0.0.1:8085';

/** Solo indirizzi di loopback: il provider di sensori non può puntare a un host esterno. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Estrae un numero da un valore di LHM, che è formattato con la cultura locale (es. "74,0 °C"). */
export function numFromValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number.parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

interface LhmNode {
  Text?: unknown;
  Value?: unknown;
  RawValue?: unknown;
  SensorId?: unknown;
  Type?: unknown;
  Children?: unknown;
}

/** Interpreta il `data.json` di LibreHardwareMonitor: temperatura CPU (package) e GPU. */
export function parseLhmData(data: unknown): SensorTemps {
  const temps: Array<{ id: string; text: string; value: number }> = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const n = node as LhmNode;
    if (n.Type === 'Temperature' && typeof n.SensorId === 'string') {
      const value = numFromValue(n.RawValue ?? n.Value);
      if (value !== null) temps.push({ id: n.SensorId, text: typeof n.Text === 'string' ? n.Text : '', value });
    }
    if (Array.isArray(n.Children)) for (const c of n.Children) walk(c);
  };
  walk(data);

  const cpuCandidates = temps.filter((t) => t.id.startsWith('/intelcpu') || t.id.startsWith('/amdcpu') || t.id.startsWith('/cpu'));
  const cpu = cpuCandidates.find((t) => t.text === 'CPU Package') ?? cpuCandidates.find((t) => t.text === 'Core Max') ?? cpuCandidates.find((t) => t.text === 'Core Average') ?? cpuCandidates[0];
  const gpuCandidates = temps.filter((t) => /^\/gpu/.test(t.id) && !/limit/i.test(t.text));
  const gpu = gpuCandidates.find((t) => /gpu core|hot ?spot/i.test(t.text)) ?? gpuCandidates[0];
  return { cpuTemperatureC: cpu?.value ?? null, gpuTemperatureC: gpu?.value ?? null };
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface LhmProviderOptions {
  url?: string;
  enabled?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
  fetchFn?: FetchLike;
  log?: Pick<Logger, 'info' | 'warn' | 'debug'>;
}

/** Provider LibreHardwareMonitor: interroga il web server locale solo su loopback, a bassa frequenza. */
export function createLhmProvider(opts: LhmProviderOptions = {}): SensorProvider {
  const url = opts.url ?? LHM_DEFAULT_URL;
  const intervalMs = Math.max(1_000, opts.intervalMs ?? 2_000);
  const timeoutMs = Math.max(200, opts.timeoutMs ?? 900);
  const fetchFn: FetchLike | undefined = opts.fetchFn ?? (globalThis as { fetch?: FetchLike }).fetch;
  let current: SensorTemps = { cpuTemperatureC: null, gpuTemperatureC: null };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let warned = false;
  const enabled = (opts.enabled ?? true) && isLoopbackUrl(url) && typeof fetchFn === 'function';

  const poll = async (): Promise<void> => {
    if (!fetchFn) return;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${url}/data.json`, { signal: ac.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      current = parseLhmData(await res.json());
      warned = false;
    } catch (err) {
      current = { cpuTemperatureC: null, gpuTemperatureC: null };
      if (!warned) {
        opts.log?.info?.('provider di sensori non disponibile: temperature N/D', { url, err: String(err) });
        warned = true;
      }
    } finally {
      clearTimeout(to);
    }
  };

  const loop = (): void => {
    if (stopped) return;
    void poll().finally(() => {
      if (!stopped) timer = setTimeout(loop, intervalMs);
    });
  };

  return {
    read: () => current,
    start() {
      if (!enabled) return;
      stopped = false;
      loop();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      current = { cpuTemperatureC: null, gpuTemperatureC: null };
    }
  };
}

export interface CpuTimes {
  idle: number;
  total: number;
}

/** Tempi cumulati della CPU su tutti i core (per il calcolo a delta). */
export function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Carico CPU dal delta fra due letture; `null` alla prima lettura (nessun delta). */
export function cpuPercent(prev: CpuTimes | null, next: CpuTimes): number | null {
  if (!prev) return null;
  const dTotal = next.total - prev.total;
  const dIdle = next.idle - prev.idle;
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 1_000) / 10));
}

export interface TelemetryDeps {
  db: Db;
  events: EventEmitter;
  log: Logger;
  now?: () => number;
  intervalMs?: number;
  enabled?: boolean;
  /** Campionatori di sistema (GPU/VRAM/rete). Default: creato internamente (Windows). */
  systemEnabled?: boolean;
  sampler?: SystemSampler;
  /** Provider di sensori esterni per le temperature (LibreHardwareMonitor su loopback). */
  sensorsEnabled?: boolean;
  sensorsUrl?: string;
  sensorProvider?: SensorProvider;
  fetchFn?: FetchLike;
  /** Sorgenti CPU/memoria iniettabili (test); default `os`. */
  readCpu?: () => CpuTimes;
  readMemory?: () => { usedBytes: number; totalBytes: number };
}

const defaultMemory = (): { usedBytes: number; totalBytes: number } => ({ usedBytes: totalmem() - freemem(), totalBytes: totalmem() });

export interface Telemetry {
  start(): void;
  stop(): void;
  /** Campione immediato (usato anche per innescare il primo delta della CPU). */
  sample(): TelemetrySample;
  last(): TelemetrySample | null;
}

const AGGREGATED_METRICS = ['cpuPercent', 'ramUsedBytes', 'gpuPercent', 'vramUsedBytes', 'cpuTemperatureC', 'gpuTemperatureC', 'netRxBytesPerSec', 'netTxBytesPerSec', 'netLinkBps'] as const;

/** Crea il campionatore e il ciclo di aggregazione. Non emette nulla finché non si chiama `start`. */
export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const now = deps.now ?? Date.now;
  const intervalMs = Math.max(500, deps.intervalMs ?? 2_000);
  const enabled = deps.enabled ?? true;
  const sampler = deps.sampler ?? createSystemSampler({ enabled: deps.systemEnabled ?? true, intervalMs, parentPid: process.pid, log: deps.log });
  const sensors = deps.sensorProvider ?? createLhmProvider({ url: deps.sensorsUrl, enabled: deps.sensorsEnabled ?? true, intervalMs, ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}), log: deps.log });
  let prevCpu: CpuTimes | null = null;
  let last: TelemetrySample | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let minute = Math.floor(now() / 60_000);
  const agg = new Map<string, { min: number; max: number; sum: number; n: number; unknown: number }>();

  const take = (): TelemetrySample => {
    const cur = (deps.readCpu ?? cpuTimes)();
    const cpu = cpuPercent(prevCpu, cur);
    prevCpu = cur;
    const mem = (deps.readMemory ?? defaultMemory)();
    const sys = sampler.read();
    const sensor = sensors.read();
    return {
      cpuPercent: cpu,
      ramUsedBytes: mem.usedBytes,
      ramTotalBytes: mem.totalBytes,
      gpuPercent: sys.gpuPercent ?? null,
      vramUsedBytes: sys.vramUsedBytes ?? null,
      cpuTemperatureC: sensor.cpuTemperatureC ?? null,
      gpuTemperatureC: sensor.gpuTemperatureC ?? null,
      netRxBytesPerSec: sys.netRxBytesPerSec ?? null,
      netTxBytesPerSec: sys.netTxBytesPerSec ?? null,
      netLinkBps: sys.netLinkBps ?? null,
      cpuCount: cpus().length,
      uptimeSec: Math.round(uptime())
    };
  };

  const record = (s: TelemetrySample): void => {
    for (const metric of AGGREGATED_METRICS) {
      const value = s[metric];
      const a = agg.get(metric) ?? { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, sum: 0, n: 0, unknown: 0 };
      if (value === null) a.unknown++;
      else {
        a.min = Math.min(a.min, value);
        a.max = Math.max(a.max, value);
        a.sum += value;
        a.n++;
      }
      agg.set(metric, a);
    }
  };

  const flush = (): void => {
    if (agg.size === 0) return;
    const rows: TelemetryAggregateRow[] = [];
    for (const [metric, a] of agg) {
      rows.push({ metric, subject: '', min: a.n > 0 ? a.min : null, max: a.n > 0 ? a.max : null, avg: a.n > 0 ? Math.round((a.sum / a.n) * 1000) / 1000 : null, samples: a.n, unknownSamples: a.unknown });
    }
    agg.clear();
    try {
      const stmt = deps.db.prepare(
        'INSERT INTO telemetry_minutes (minute, metric, subject, min, max, avg, samples, unknown_samples) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(minute, metric, subject) DO UPDATE SET min=excluded.min, max=excluded.max, avg=excluded.avg, samples=excluded.samples, unknown_samples=excluded.unknown_samples'
      );
      const minuteToWrite = Math.floor(now() / 60_000);
      deps.db.transaction(() => {
        for (const r of rows) stmt.run(minuteToWrite, r.metric, r.subject, r.min, r.max, r.avg, r.samples, r.unknownSamples);
      });
      deps.events.emit('telemetry.aggregate', { minute: minuteToWrite, rows }, { source: TELEMETRY_SOURCE });
    } catch (err) {
      deps.log.warn('aggregato di telemetria non scritto', { err: String(err) });
    }
  };

  const tick = (): void => {
    const current = Math.floor(now() / 60_000);
    if (current > minute) {
      minute = current;
      flush();
    }
    const sample = take();
    last = sample;
    deps.events.emit('telemetry.sample', sample, { source: TELEMETRY_SOURCE });
    record(sample);
  };

  return {
    start() {
      if (timer !== null || !enabled) return;
      sampler.start();
      sensors.start();
      prevCpu = (deps.readCpu ?? cpuTimes)(); // prima lettura: nessun valore finché non c'è un delta
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      flush();
      sampler.stop();
      sensors.stop();
      prevCpu = null;
    },
    sample: take,
    last: () => last
  };
}
