// Logica pura della HUD di sistema (Fase 14): metriche e gruppi a partire da dati reali.
// Separata dal componente React così è testabile senza JSX e senza DOM.
// Fase G4 (P-76): aggiunti i testi di stato degli agenti e l'attività reale per agente dagli eventi.
// Inglese (11/10/2026): le funzioni che producono testo prendono una lingua facoltativa (default `it`):
// chi le chiama senza ottiene esattamente il testo italiano di prima.
import type { AgentStatus, CoreStateSnapshot, Language, TelemetrySample, VisioneEvent } from '../../shared/contracts/index.ts';
import { translate } from '../lib/i18n/index.ts';

export type MetricStatus = 'ok' | 'unknown' | 'unavailable' | 'stale' | 'bad';
export interface Metric {
  key: string;
  label: string;
  value: number | string | null;
  unit: string;
  status: MetricStatus;
  source: string;
  sampledAt: number | null;
  /** Testo già formattato; se assente la vista usa `value` + `unit`. */
  display?: string;
  /** 0..1 per la barra (solo grandezze percentuali). */
  bar?: number | null;
}
export interface MetricSection {
  id: string;
  title: string;
  metrics: Metric[];
}

/** Sottoinsieme della scena 3D usato dalla HUD (evita di importare un `.tsx` qui). */
export interface SceneStatsLike {
  fps: number | null;
  quality: 0 | 1 | 2;
  context: string;
}

/** Oltre questa età un campione non è più "live": si marca `stale`, senza spacciarlo per attuale. */
export const STALE_MS = 8_000;

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function humanBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i] as string}`;
}

export function humanBitrate(bps: number): string {
  if (bps >= 1e9) return `${Math.round(bps / 1e8) / 10} Gbps`;
  if (bps >= 1e6) return `${Math.round(bps / 1e5) / 10} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e2) / 10} kbps`;
  return `${Math.round(bps)} bps`;
}

export interface BusTelemetry {
  rate: number | null;
  rateAt: number | null;
  lastTurnMs: number | null;
  lastTurnAt: number | null;
  goalMs: number | null;
  goalAt: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensTotal: number | null;
  context: { used: number; size: number } | null;
  usageAt: number | null;
  sttMs: number | null;
  ttsMs: number | null;
  bargeInMs: number | null;
  voiceAt: number | null;
  sys: TelemetrySample | null;
  sysAt: number | null;
}

export const EMPTY_BUS_TELEMETRY: BusTelemetry = {
  rate: null, rateAt: null, lastTurnMs: null, lastTurnAt: null, goalMs: null, goalAt: null,
  tokensIn: null, tokensOut: null, tokensTotal: null, context: null, usageAt: null,
  sttMs: null, ttsMs: null, bargeInMs: null, voiceAt: null, sys: null, sysAt: null
};

/** Stato di una metrica di sistema: N/D se assente, `stale` se il campione è vecchio. */
export function systemStatus(value: number | null, at: number | null, now: number): MetricStatus {
  if (value === null) return 'unavailable';
  if (at === null) return 'unknown';
  return now - at > STALE_MS ? 'stale' : 'ok';
}

/** Il valore «non disponibile» nella lingua (`N/D` / `N/A`). */
export const naText = (lang: Language = 'it'): string => translate(lang, 'settings.common.na');
/** Vero per il «non disponibile» in qualunque lingua: la riga si mostra spenta. */
export const isNa = (v: string): boolean => v === 'N/D' || v === 'N/A';

export function buildSections(core: CoreStateSnapshot | null, bus: BusTelemetry, scene: SceneStatsLike | null, pingMs: number | null, now: number, lang: Language = 'it'): MetricSection[] {
  const na = naText(lang);
  const coreMetric = (key: string, label: string, value: number | undefined, unit = ''): Metric => ({
    key, label, value: value ?? null, unit, status: core ? 'ok' : 'unknown', source: 'core', sampledAt: core?.updatedAt ?? null
  });
  const busMetric = (key: string, label: string, value: number | null, unit: string, source: string, at: number | null, display?: string): Metric => ({
    key, label, value, unit, status: value === null ? 'unknown' : 'ok', source, sampledAt: at, ...(display !== undefined ? { display } : {})
  });
  const sysMetric = (key: string, label: string, value: number | null, unit: string, source: string, display: string, bar: number | null = null): Metric => ({
    key, label, value, unit, status: systemStatus(value, bus.sysAt, now), source, sampledAt: bus.sysAt, display, bar
  });

  const sys = bus.sys;
  const sysSource = 'telemetry.sample (os + WMI Windows)';
  const cpu = sys?.cpuPercent ?? null;
  const ramUsed = sys?.ramUsedBytes ?? null;
  const ramTotal = sys?.ramTotalBytes ?? null;
  const gpu = sys?.gpuPercent ?? null;
  const vram = sys?.vramUsedBytes ?? null;
  const cpuTemp = sys?.cpuTemperatureC ?? null;
  const gpuTemp = sys?.gpuTemperatureC ?? null;
  const rx = sys?.netRxBytesPerSec ?? null;
  const tx = sys?.netTxBytesPerSec ?? null;
  const link = sys?.netLinkBps ?? null;
  const ramPct = ramUsed != null && ramTotal != null && ramTotal > 0 ? ramUsed / ramTotal : null;
  const ctxPct = bus.context ? bus.context.used / Math.max(1, bus.context.size) : null;
  const fpsOk = scene !== null && scene.context !== 'unavailable' && scene.fps != null;
  const tempSource = 'telemetry.sample (LibreHardwareMonitor, loopback)';

  const system: Metric[] = [
    sysMetric('cpu', 'CPU', cpu, '%', sysSource, cpu != null ? `${cpu}%` : na, cpu != null ? clamp01(cpu / 100) : null),
    sysMetric('ram', 'RAM', ramUsed, 'GB', sysSource, ramUsed != null && ramTotal != null ? `${humanBytes(ramUsed)} / ${humanBytes(ramTotal)}` : na, ramPct),
    sysMetric('gpu', 'GPU', gpu, '%', sysSource, gpu != null ? `${gpu}%` : na, gpu != null ? clamp01(gpu / 100) : null),
    sysMetric('vram', 'VRAM', vram, 'GB', sysSource, vram != null ? humanBytes(vram) : na),
    sysMetric('temp', translate(lang, 'settings.metric.tempCpu'), cpuTemp, '°C', tempSource, cpuTemp != null ? `${cpuTemp} °C` : na),
    sysMetric('gtemp', translate(lang, 'settings.metric.tempGpu'), gpuTemp, '°C', tempSource, gpuTemp != null ? `${gpuTemp} °C` : na),
    sysMetric('net', translate(lang, 'settings.metric.network'), rx ?? tx, 'B/s', sysSource, rx != null || tx != null ? `↓${humanBytes(rx ?? 0)}/s ↑${humanBytes(tx ?? 0)}/s` : na),
    sysMetric('netlink', translate(lang, 'settings.metric.link'), link, 'bps', sysSource, link != null ? humanBitrate(link) : na)
  ];

  const orchestration: Metric[] = [
    coreMetric('agents', translate(lang, 'settings.metric.agentsWorking'), core?.agents.working, translate(lang, 'settings.metric.agentsLive', { n: core?.agents.live ?? 0 })),
    coreMetric('tasks', translate(lang, 'settings.metric.tasksActive'), core?.tasks.active),
    coreMetric('approvals', translate(lang, 'settings.metric.approvals'), core?.approvals.pending, translate(lang, 'settings.metric.approvalsPending')),
    coreMetric('processes', translate(lang, 'settings.metric.processes'), core?.processes.active),
    coreMetric('journal', translate(lang, 'settings.metric.journal'), core?.database.pendingWrites, translate(lang, 'settings.metric.journalUnit')),
    busMetric('rate', translate(lang, 'settings.metric.events'), bus.rate, '/s', 'bus (10 s)', bus.rateAt),
    busMetric('turn', translate(lang, 'settings.metric.turn'), bus.lastTurnMs, 'ms', 'agent.turn.*', bus.lastTurnAt),
    busMetric('goal', translate(lang, 'settings.metric.goal'), bus.goalMs, 'ms', 'director.goal.received → summary', bus.goalAt),
    { key: 'ttft', label: 'TTFT', value: null, unit: 'ms', status: 'unavailable', source: translate(lang, 'settings.metric.notExposed'), sampledAt: null, display: na },
    busMetric('tok-in', translate(lang, 'settings.metric.tokensIn'), bus.tokensIn, 'tok', 'agent.usage.updated', bus.usageAt),
    busMetric('tok-out', translate(lang, 'settings.metric.tokensOut'), bus.tokensOut, 'tok', 'agent.usage.updated', bus.usageAt),
    {
      key: 'context', label: translate(lang, 'settings.metric.context'), value: ctxPct, unit: '%', status: bus.context ? 'ok' : 'unknown', source: 'agent.usage.updated', sampledAt: bus.usageAt,
      display: bus.context ? `${Math.round(ctxPct !== null ? ctxPct * 100 : 0)}% · ${bus.context.used}/${bus.context.size}` : undefined,
      bar: ctxPct
    },
    {
      key: 'fps', label: translate(lang, 'settings.metric.scene'), value: fpsOk ? (scene?.fps as number) : null, unit: scene ? `fps · q${scene.quality}` : 'fps',
      status: scene?.context === 'unavailable' ? 'unavailable' : !fpsOk ? 'unknown' : 'ok', source: 'renderer', sampledAt: scene ? now : null,
      display: scene?.context === 'unavailable' ? na : fpsOk ? `${scene?.fps} fps · q${scene?.quality}` : undefined
    }
  ];

  const voice: Metric[] = [
    busMetric('stt', 'STT', bus.sttMs, 'ms', 'voice.stt.final', bus.voiceAt),
    busMetric('tts', 'TTS', bus.ttsMs, 'ms', 'voice.tts.started', bus.voiceAt),
    busMetric('barge', 'Barge-in', bus.bargeInMs, 'ms', 'voice.tts.interrupted', bus.voiceAt),
    { key: 'ping', label: 'Ping IPC', value: pingMs, unit: 'ms', status: pingMs === null ? 'unknown' : 'ok', source: 'system.ping', sampledAt: pingMs === null ? null : now }
  ];

  return [
    { id: 'system', title: translate(lang, 'settings.metric.section.system'), metrics: system },
    { id: 'orchestration', title: translate(lang, 'settings.metric.section.orchestration'), metrics: orchestration },
    { id: 'voice', title: translate(lang, 'settings.metric.section.voice'), metrics: voice }
  ];
}

export function metricText(m: Metric, lang: Language = 'it'): string {
  if (m.display !== undefined) return m.display;
  if (m.status === 'unavailable') return naText(lang);
  // Fase G4: un valore mancante è sempre `N/D` nei pannelli HUD, mai una stringa vuota o un trattino.
  if (m.value === null) return naText(lang);
  return `${m.value} ${m.unit}`.trim();
}

// --- Fase G4: testi e attività degli agenti (dai dati reali, mai ricostruiti) ----------------------

/**
 * Stati di un'istanza agente in italiano, come i riquadri del riferimento.
 * P-95: `crashed` è «INTERROTTO» (un processo terminato non è uno «schianto»), `stopped` è
 * «TERMINATO» (sessione chiusa: dall'utente o con l'app precedente). La riconciliazione all'avvio
 * (`agent.recover`) registra le istanze rimaste aperte come `stopped`, non più come `crashed`.
 */
export const AGENT_STATE_IT: Record<AgentStatus, string> = {
  created: 'IN CODA',
  starting: 'AVVIO',
  idle: 'A RIPOSO',
  working: 'AL LAVORO',
  waiting: 'IN ATTESA',
  error: 'ERRORE',
  stopping: 'CHIUSURA',
  stopped: 'TERMINATO',
  crashed: 'INTERROTTO',
  recovering: 'RECUPERO'
};

/** Gli stessi stati in inglese (stesso significato di `AGENT_STATE_IT`). */
export const AGENT_STATE_EN: Record<AgentStatus, string> = {
  created: 'QUEUED',
  starting: 'STARTING',
  idle: 'IDLE',
  working: 'WORKING',
  waiting: 'WAITING',
  error: 'ERROR',
  stopping: 'STOPPING',
  stopped: 'STOPPED',
  crashed: 'INTERRUPTED',
  recovering: 'RECOVERING'
};

/**
 * Etichetta mostrata per un'istanza, dal suo stato E dal motivo reale (`statusReason`): un turno
 * fermato dalla quota del motore è «LIMITE» (non un errore generico), una sessione chiusa con
 * l'app è «IN PAUSA» (non uno schianto né una fine). Pura e senza invenzioni.
 */
export function agentStateLabel(status: AgentStatus | null, reason?: string | null, lang: Language = 'it'): string {
  if (status === null) return translate(lang, 'settings.agentState.never');
  if ((status === 'error' || status === 'crashed') && typeof reason === 'string' && /limit_reached|quota|rate.?limit/i.test(reason)) {
    return translate(lang, 'settings.agentState.limit');
  }
  if (closedWithApp(status, reason)) return translate(lang, 'settings.agentState.paused');
  return (lang === 'en' ? AGENT_STATE_EN : AGENT_STATE_IT)[status];
}

/**
 * Sessione chiusa insieme all'app (uscita, aggiornamento, core riavviato) e non dall'utente: l'agente
 * non è guasto e riparte da solo al primo messaggio, riprendendo la sessione (verificato il 10/10/2026
 * sull'app installata: Esecutore «core: app-quit» → messaggio → risposta in 2 s). Mostrarlo come
 * «TERMINATO» faceva credere al proprietario che l'aggiornamento avesse rotto gli agenti.
 */
export function closedWithApp(status: AgentStatus | null, reason?: string | null): boolean {
  return (status === 'stopped' || status === 'crashed') && typeof reason === 'string' && /app-quit|core riavviato|sessione chiusa con l'app/i.test(reason);
}

/** Riga del motivo sotto lo stato: per una sessione chiusa con l'app, cosa succede adesso. */
export function agentReasonText(status: AgentStatus | null, reason: string, lang: Language = 'it'): string {
  return closedWithApp(status, reason) ? translate(lang, 'settings.agentState.restartsAlone') : translate(lang, 'settings.agentState.reason', { reason });
}

/** Vero per gli stati terminali: l'istanza non è più viva (come `TERMINAL_AGENT_STATUSES`). */
export function agentStatusIsTerminal(status: AgentStatus): boolean {
  return status === 'stopped' || status === 'crashed';
}

export interface AgentActivity {
  type: string;
  at: number;
  /** Strumento reale dell'evento (`tool.call.*`), quando presente. */
  tool: string | null;
}

/**
 * Ultimo evento reale del bus che riguarda l'agente indicato: è l'attività che la card mostra.
 * Scorre la finestra di eventi della UI (massimo `MAX_EVENTS`): quando l'evento è uscito dalla
 * finestra, l'attività resta `N/D` invece di essere dedotta o inventata.
 */
export function agentActivity(events: readonly VisioneEvent[], agentId: string): AgentActivity | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as VisioneEvent;
    const p = e.payload as Record<string, unknown>;
    if (p.agentId !== agentId) continue;
    const tool = typeof p.tool === 'string' ? p.tool : null;
    return { type: e.type, at: e.ts, tool };
  }
  return null;
}
