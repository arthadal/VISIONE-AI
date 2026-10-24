// HUD di sistema (Fase 14): proiezione dei dati reali, N/D quando mancano, `stale` quando vecchi.
// Fase G4 (P-76): testi N/D uniformi e attività reale degli agenti dagli eventi.
import { describe, expect, it } from 'vitest';
import type { VisioneEvent } from '../../src/shared/contracts/index.ts';
import {
  agentActivity, agentReasonText, agentStateLabel, agentStatusIsTerminal, AGENT_STATE_IT, buildSections, humanBytes, metricText,
  type BusTelemetry, type Metric
} from '../../src/renderer/app/hud-metrics.ts';

const bus = (over: Partial<BusTelemetry> = {}): BusTelemetry => ({
  rate: null, rateAt: null, lastTurnMs: null, lastTurnAt: null, goalMs: null, goalAt: null,
  tokensIn: null, tokensOut: null, tokensTotal: null, context: null, usageAt: null,
  sttMs: null, ttsMs: null, bargeInMs: null, voiceAt: null, sys: null, sysAt: null, ...over
});
const metrics = (b: BusTelemetry, now = 1_000): Metric[] => buildSections(null, b, null, null, now).flatMap((s) => s.metrics);
const find = (list: Metric[], key: string): Metric => list.find((m) => m.key === key) as Metric;

const SAMPLE = {
  cpuPercent: 12, ramUsedBytes: 8 * 1024 ** 3, ramTotalBytes: 16 * 1024 ** 3, gpuPercent: 30,
  vramUsedBytes: 2 * 1024 ** 3, cpuTemperatureC: 62.5, gpuTemperatureC: null, netRxBytesPerSec: 2048, netTxBytesPerSec: 1024,
  netLinkBps: 866_700_000, cpuCount: 8, uptimeSec: 3600
};

describe('HUD di sistema (Fase 14)', () => {
  it('raggruppa Sistema/Orchestrazione/Voce e proietta i valori reali del campione', () => {
    const sections = buildSections(null, bus({ sys: SAMPLE, sysAt: 1_000, context: { used: 50, size: 100 } }), null, null, 1_000);
    expect(sections.map((s) => s.id)).toEqual(['system', 'orchestration', 'voice']);
    const all = metrics(bus({ sys: SAMPLE, sysAt: 1_000, context: { used: 50, size: 100 } }));
    expect(find(all, 'cpu')).toMatchObject({ status: 'ok', display: '12%' });
    expect(find(all, 'gpu')).toMatchObject({ status: 'ok', display: '30%' });
    expect(find(all, 'ram').display).toBe('8 GB / 16 GB');
    expect(find(all, 'vram').display).toBe('2 GB');
    expect(find(all, 'temp')).toMatchObject({ status: 'ok', display: '62.5 °C' });
    expect(find(all, 'gtemp')).toMatchObject({ status: 'unavailable', display: 'N/D' });
    expect(find(all, 'netlink').display).toBe('866.7 Mbps');
    expect(find(all, 'context').display).toBe('50% · 50/100');
    expect(find(all, 'context').bar).toBe(0.5);
  });

  it('dichiara N/D ciò che non è disponibile e non inventa valori', () => {
    const all = metrics(bus());
    for (const key of ['cpu', 'gpu', 'vram', 'temp', 'gtemp', 'net', 'netlink']) {
      expect(find(all, key), key).toMatchObject({ status: 'unavailable', value: null, display: 'N/D' });
    }
    // TTFT: i motori non lo espongono -> N/D dichiarato (nessuna stima).
    expect(find(all, 'ttft')).toMatchObject({ status: 'unavailable', display: 'N/D' });
    // Token e contesto prima di qualsiasi `agent.usage.updated`: sconosciuti, non zero.
    expect(find(all, 'context')).toMatchObject({ status: 'unknown', value: null });
  });

  it('marca `stale` un campione vecchio invece di spacciarlo per live', () => {
    const all = metrics(bus({ sys: SAMPLE, sysAt: 1_000 }), 1_000 + 10_000);
    expect(find(all, 'cpu')).toMatchObject({ status: 'stale' });
    const fresh = metrics(bus({ sys: SAMPLE, sysAt: 1_000 }), 1_000 + 1_000);
    expect(find(fresh, 'cpu').status).toBe('ok');
  });

  it('formatta le dimensioni in unità leggibili', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(1024)).toBe('1 KB');
    expect(humanBytes(1536)).toBe('1.5 KB');
    expect(humanBytes(1024 ** 3)).toBe('1 GB');
    expect(humanBytes(11.5 * 1024 ** 3)).toBe('11.5 GB');
  });

  it('G4: un valore mancante si scrive sempre N/D, mai un trattino o una cella vuota', () => {
    expect(metricText({ key: 'x', label: 'X', value: null, unit: 'ms', status: 'unknown', source: 'test', sampledAt: null })).toBe('N/D');
    expect(metricText({ key: 'x', label: 'X', value: null, unit: 'ms', status: 'unavailable', source: 'test', sampledAt: null })).toBe('N/D');
    expect(metricText({ key: 'x', label: 'X', value: 42, unit: '%', status: 'ok', source: 'test', sampledAt: null })).toBe('42 %');
  });

  it('G4: l\'attività di un agente è l\'ultimo evento reale che lo riguarda (o N/D)', () => {
    const ev = (ts: number, agentId: string, type: string, extra: Record<string, unknown> = {}): VisioneEvent => ({
      id: `01J${String(ts).padStart(10, '0')}ABCDEFGHJKMNPQRS`, seq: ts, ts, type, category: 'agent',
      source: { kind: 'system', id: 'core' }, target: null, correlationId: 'correlazione', causationId: null,
      severity: 'info', durability: 'durable', schema: 1, payload: { agentId, ...extra }
    });
    const events = [ev(100, 'a1', 'agent.turn.started'), ev(200, 'a1', 'tool.call.started', { tool: 'read' }), ev(300, 'a2', 'agent.turn.started')];
    expect(agentActivity(events, 'a1')).toMatchObject({ type: 'tool.call.started', at: 200, tool: 'read' });
    expect(agentActivity(events, 'a2')).toMatchObject({ type: 'agent.turn.started', tool: null });
    expect(agentActivity(events, 'ignoto')).toBeNull();
  });

  it('G4/P-95: stati agente in chiaro, con i terminali riconosciuti e le etichette dal motivo reale', () => {
    expect(AGENT_STATE_IT.working).toBe('AL LAVORO');
    expect(AGENT_STATE_IT.idle).toBe('A RIPOSO');
    expect(AGENT_STATE_IT.stopped).toBe('TERMINATO');
    expect(AGENT_STATE_IT.crashed).toBe('INTERROTTO');
    expect(agentStatusIsTerminal('stopped')).toBe(true);
    expect(agentStatusIsTerminal('crashed')).toBe(true);
    expect(agentStatusIsTerminal('working')).toBe(false);
    // P-95: l'etichetta mostrata segue il motivo reale dell'istanza.
    expect(agentStateLabel('error', 'turno fallito: limit_reached')).toBe('LIMITE');
    // 10/10/2026: dopo un aggiornamento gli agenti chiusi con l'app sembravano rotti; ripartono da soli.
    expect(agentStateLabel('crashed', 'sessione chiusa con l\'app precedente (processo non più controllato)')).toBe('IN PAUSA');
    expect(agentStateLabel('stopped', 'core: app-quit')).toBe('IN PAUSA');
    expect(agentReasonText('stopped', 'core: app-quit')).toBe('riparte da solo al primo messaggio');
    expect(agentStateLabel('stopped', 'fermato dall\'utente')).toBe('TERMINATO');
    expect(agentReasonText('stopped', 'fermato dall\'utente')).toBe('motivo: fermato dall\'utente');
    expect(agentStateLabel('crashed', 'processo del motore terminato (crashed, codice 1)')).toBe('INTERROTTO');
    expect(agentStateLabel('error', 'connessione assente')).toBe('ERRORE');
    expect(agentStateLabel(null, null)).toBe('MAI AVVIATO');
  });
});
