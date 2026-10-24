// Telemetria di sistema (Fase 14, P-59): campione reale, N/D quando manca, aggregato al minuto.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/core/db/index.ts';
import type { EventEmitter as VisioneEmitter } from '../../src/core/events/index.ts';
import {
  cpuPercent,
  createLhmProvider,
  createSystemSampler,
  createTelemetry,
  isLoopbackUrl,
  parseLhmData,
  parseSystemLine,
  SAMPLE_PREFIX,
  type CpuTimes,
  type SystemSampler
} from '../../src/core/telemetry/index.ts';

const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child() { return this; } };

function fakeDb(rows: unknown[][]): Db {
  const stmt = { run: (...args: unknown[]) => { rows.push(args); } };
  return { prepare: () => stmt, transaction: (fn: () => void) => fn() } as unknown as Db;
}

function collector(): { events: VisioneEmitter; emitted: Array<{ type: string; payload: Record<string, unknown> }> } {
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const events = { emit: (type: string, payload: Record<string, unknown>) => { emitted.push({ type, payload }); return { type, payload }; } } as unknown as VisioneEmitter;
  return { events, emitted };
}

afterEach(() => vi.useRealTimers());

describe('parser e calcolo CPU', () => {
  it('interpreta la riga del campionatore; ignora rumore e JSON non valido', () => {
    const line = `${SAMPLE_PREFIX}{"gpu":14,"vram":1096462336,"rx":318,"tx":543,"link":758350000}`;
    expect(parseSystemLine(line)).toEqual({ gpuPercent: 14, vramUsedBytes: 1096462336, netRxBytesPerSec: 318, netTxBytesPerSec: 543, netLinkBps: 758350000 });
    expect(parseSystemLine(`${SAMPLE_PREFIX}{"gpu":250}`)?.gpuPercent).toBe(100);
    expect(parseSystemLine('#< CLIXML')).toBeNull();
    expect(parseSystemLine(`${SAMPLE_PREFIX}{bad json`)).toBeNull();
    expect(parseSystemLine(`${SAMPLE_PREFIX}{"gpu":null}`)?.gpuPercent).toBeNull();
  });

  it('calcola il carico CPU dal delta; null alla prima lettura', () => {
    expect(cpuPercent(null, { idle: 0, total: 0 })).toBeNull();
    expect(cpuPercent({ idle: 1000, total: 2000 }, { idle: 1500, total: 3000 })).toBe(50);
    expect(cpuPercent({ idle: 1000, total: 2000 }, { idle: 1000, total: 2000 })).toBeNull();
  });
});

describe('campionatore di sistema', () => {
  function fakeChild(): { stdout: EventEmitter & { setEncoding?: () => void }; kill: () => void } & EventEmitter {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { setEncoding?: () => void }; kill: () => void };
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    child.kill = () => undefined;
    return child;
  }

  it('legge il campione dal processo PowerShell iniettato; non avvia nulla se disabilitato', () => {
    let spawned = 0;
    const child = fakeChild();
    const spawnFn = (() => { spawned++; return child; }) as unknown as typeof import('node:child_process').spawn;
    const sampler = createSystemSampler({ platform: 'win32', enabled: true, spawnFn, intervalMs: 1000, parentPid: 1 });
    sampler.start();
    expect(spawned).toBe(1);
    child.stdout.emit('data', `${SAMPLE_PREFIX}{"gpu":7,"vram":1,"rx":2,"tx":3,"link":4,"temp":null}\n`);
    expect(sampler.read()).toMatchObject({ gpuPercent: 7, vramUsedBytes: 1, netRxBytesPerSec: 2 });
    sampler.stop();
    expect(sampler.read()).toEqual({});

    let offCount = 0;
    const off = createSystemSampler({ platform: 'win32', enabled: false, spawnFn: (() => { offCount++; return child; }) as unknown as typeof import('node:child_process').spawn });
    off.start();
    expect(offCount).toBe(0);
  });
});

describe('provider di sensori esterni (LibreHardwareMonitor, loopback)', () => {
  const sample = {
    Children: [
      { Type: 'Temperature', Text: 'CPU Package', SensorId: '/intelcpu/0/temperature/16', Value: '74,0 °C', RawValue: '74,0 °C', Children: [] },
      { Type: 'Temperature', Text: 'Core Max', SensorId: '/intelcpu/0/temperature/0', Value: '76,0 °C', Children: [] },
      { Type: 'Temperature', Text: 'GPU Core', SensorId: '/gpu-intel/0/temperature/0', Value: '48,5 °C', Children: [] },
      { Type: 'Load', Text: 'CPU Total', SensorId: '/intelcpu/0/load/0', Value: '10,0 %', Children: [] }
    ]
  };

  it('interpreta CPU Package e GPU Core dal JSON, ignorando i sensori non di temperatura', () => {
    expect(parseLhmData(sample)).toEqual({ cpuTemperatureC: 74, gpuTemperatureC: 48.5 });
    // Ripiego: senza "CPU Package" si usa "Core Max".
    const noPkg = { Children: [sample.Children[1]] };
    expect(parseLhmData(noPkg).cpuTemperatureC).toBe(76);
    expect(parseLhmData({ Children: [] })).toEqual({ cpuTemperatureC: null, gpuTemperatureC: null });
  });

  it('accetta solo loopback e legge dal provider quando è attivo', async () => {
    expect(isLoopbackUrl('http://127.0.0.1:8085')).toBe(true);
    expect(isLoopbackUrl('http://localhost:8085')).toBe(true);
    expect(isLoopbackUrl('http://evil.example:8085')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.10:8085')).toBe(false);

    let calls = 0;
    const fetchFn = (async () => { calls++; return { ok: true, status: 200, json: async () => sample }; }) as unknown as NonNullable<Parameters<typeof createLhmProvider>[0]>['fetchFn'];
    const provider = createLhmProvider({ url: 'http://127.0.0.1:8085', fetchFn, intervalMs: 1_000 });
    provider.start();
    await vi.waitFor(() => expect(provider.read()).toEqual({ cpuTemperatureC: 74, gpuTemperatureC: 48.5 }));
    provider.stop();
    expect(calls).toBeGreaterThan(0);

    // Host non loopback: nessuna richiesta, temperature N/D.
    let bad = 0;
    const evil = createLhmProvider({ url: 'http://evil.example:8085', fetchFn: (async () => { bad++; return { ok: true, status: 200, json: async () => sample }; }) as unknown as NonNullable<Parameters<typeof createLhmProvider>[0]>['fetchFn'] });
    evil.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(bad).toBe(0);
    expect(evil.read()).toEqual({ cpuTemperatureC: null, gpuTemperatureC: null });
    evil.stop();
  });
});

describe('createTelemetry: campione, N/D e aggregato', () => {
  it('emette campioni reali, scrive gli aggregati e dichiara N/D ciò che manca', () => {
    vi.useFakeTimers();
    let nowMs = 60_000 * 100; // minuto esatto
    let cpu: CpuTimes = { idle: 1000, total: 2000 };
    const rows: unknown[][] = [];
    const { events, emitted } = collector();
    let sys: Partial<import('../../src/core/telemetry/index.ts').SystemSample> = { gpuPercent: 42, vramUsedBytes: 2048, netRxBytesPerSec: 10, netTxBytesPerSec: 20, netLinkBps: 1_000_000 };
    const sampler: SystemSampler = { read: () => sys, start: () => undefined, stop: () => undefined };
    const telemetry = createTelemetry({
      db: fakeDb(rows), events, log, now: () => nowMs, intervalMs: 1000, sampler, sensorsEnabled: false,
      readCpu: () => cpu, readMemory: () => ({ usedBytes: 8, totalBytes: 16 })
    });
    telemetry.start();
    // Secondo campione: la CPU ha un delta reale (finto) -> 50%.
    cpu = { idle: 1500, total: 3000 };
    vi.advanceTimersByTime(1000);
    const samples = emitted.filter((e) => e.type === 'telemetry.sample');
    expect(samples).toHaveLength(1);
    expect(samples[0]?.payload).toMatchObject({ cpuPercent: 50, gpuPercent: 42, vramUsedBytes: 2048, ramUsedBytes: 8, ramTotalBytes: 16, cpuTemperatureC: null, gpuTemperatureC: null });
    // Passa il minuto: si scrive l'aggregato del minuto precedente.
    nowMs = 60_000 * 101 + 1000;
    cpu = { idle: 2500, total: 5000 };
    vi.advanceTimersByTime(1000);
    const agg = emitted.filter((e) => e.type === 'telemetry.aggregate');
    expect(agg.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const cpuRow = rows.find((r) => r[1] === 'cpuPercent');
    expect(cpuRow?.[1]).toBe('cpuPercent');
    expect(cpuRow?.[3]).toBe(50);
    expect(cpuRow?.[4]).toBe(50);
    expect(cpuRow?.[6]).toBe(1);
    telemetry.stop();

    // N/D: sensore assente e CPU senza delta -> null, mai 0 inventato.
    const rows2: unknown[][] = [];
    const c2 = collector();
    let cpu2: CpuTimes = { idle: 5, total: 10 };
    const telemetry2 = createTelemetry({
      db: fakeDb(rows2), events: c2.events, log, now: () => nowMs, intervalMs: 1000, sensorsEnabled: false,
      sampler: { read: () => ({}), start: () => undefined, stop: () => undefined }, readCpu: () => cpu2, readMemory: () => ({ usedBytes: 2, totalBytes: 4 })
    });
    telemetry2.start();
    vi.advanceTimersByTime(1000); // nessun delta CPU, nessun sensore
    const s2 = c2.emitted.find((e) => e.type === 'telemetry.sample');
    expect(s2?.payload).toMatchObject({ cpuPercent: null, gpuPercent: null, vramUsedBytes: null, cpuTemperatureC: null, gpuTemperatureC: null, netRxBytesPerSec: null });
    telemetry2.stop();
    const nullRow = rows2.find((r) => r[1] === 'gpuPercent');
    expect(nullRow?.[6]).toBe(0); // nessun campione con valore
    expect(Number(nullRow?.[7])).toBeGreaterThan(0); // campioni sconosciuti contati
  });

  it('non emette nulla se disabilitata', () => {
    vi.useFakeTimers();
    const { events, emitted } = collector();
    const telemetry = createTelemetry({ db: fakeDb([]), events, log, now: () => 0, enabled: false, sampler: { read: () => ({}), start: () => undefined, stop: () => undefined } });
    telemetry.start();
    vi.advanceTimersByTime(10_000);
    expect(emitted).toHaveLength(0);
    telemetry.stop();
  });
});
