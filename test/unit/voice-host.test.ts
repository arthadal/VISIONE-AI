// Processo voce nel main (Fase 9, Fase 15): il crash chiude il processo e informa il core; il riavvio
// avviene solo su ordine del core (`control('restart')`). Electron è finto: nessun processo reale.
import type { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { VisioneConfig } from '../../src/shared/node/config.ts';
import { mainToVoiceSchema, type VoiceToCore } from '../../src/shared/contracts/index.ts';
import { memoryLogger } from '../helpers.ts';

interface FakeChild extends EventEmitter {
  pid: number;
  postMessage: (msg: unknown) => void;
  sent: unknown[];
  stderr: { setEncoding: () => void; on: () => void };
  kill: () => void;
}
// Prefisso `mock`: la factory di vi.mock può riferirsi a questa variabile (convenzione vitest).
const mockState = { instances: [] as FakeChild[] };

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeChild extends Emitter {
    readonly pid: number;
    readonly sent: unknown[] = [];
    postMessage = (msg: unknown): void => {
      this.sent.push(msg);
    };
    stderr = { setEncoding: (): void => undefined, on: (): void => undefined };
    kill = (): void => {
      queueMicrotask(() => this.emit('exit', 0));
    };
    constructor() {
      super();
      this.pid = 5000 + mockState.instances.length;
      mockState.instances.push(this as unknown as FakeChild);
    }
  }
  return {
    utilityProcess: { fork: () => new FakeChild() },
    MessageChannelMain: class {
      port1 = {};
      port2 = {};
    }
  };
});

import { createVoiceHost } from '../../src/main/voice-host.ts';

const config: VisioneConfig['voice'] = {
  enabled: true,
  modelsDir: null,
  speaker: 'if_sara',
  threads: 4,
  bargeIn: true,
  followUpMs: 8_000,
  pttShortcut: 'Control+Alt+Space',
  vadThreshold: 0.5,
  minSpeechMs: 120,
  minSilenceMs: 600,
  noiseGate: 0.004,
  denoise: true,
  ownerOnly: { enabled: false, minScore: 0.4, margin: 0.05 },
  speakSummaries: true,
  announceApprovals: true,
  announceStartup: false,
  startupPhrase: 'VISIONE online. Sistemi operativi.',
  startupBriefing: false,
  volume: 250,
  tts: { provider: 'kokoro', voice: 'it-IT-DiegoNeural', rate: '+8%', pitch: '-2Hz' },
  wake: { enabled: false, phrase: 'hey visione', sensitivity: 0.5, commandTimeoutMs: 6_000 }
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createVoiceHost (main) — Fase 15', () => {
  it('avvio, crash → fatto al core senza riavvio automatico, riavvio su control, stop senza riavvio', async () => {
    mockState.instances.length = 0;
    const facts: VoiceToCore[] = [];
    const host = createVoiceHost({ entry: 'voice.js', env: {}, language: 'it', config, edition: 'sviluppo', modelsDir: 'm', log: memoryLogger().log, toCore: (m) => facts.push(m) });

    host.start();
    expect(mockState.instances).toHaveLength(1);

    // Crash del processo: il fatto è dichiarato al core e NON si riavvia da solo.
    mockState.instances[0]?.emit('exit', 1);
    expect(facts.at(-1)).toMatchObject({ type: 'process', phase: 'exited', code: 1 });
    expect(mockState.instances).toHaveLength(1);

    // Il core chiede il riavvio: un nuovo processo.
    host.control('restart');
    expect(mockState.instances).toHaveLength(2);

    // Stop: il processo esce e non viene riavviato.
    host.control('stop');
    await tick();
    expect(facts.at(-1)).toMatchObject({ type: 'process', phase: 'exited' });
    expect(mockState.instances).toHaveLength(2);
    host.stop();
  });

  it('disabilitato: non avvia alcun processo', () => {
    mockState.instances.length = 0;
    const host = createVoiceHost({ entry: 'voice.js', env: {}, language: 'it', config: { ...config, enabled: false }, edition: 'sviluppo', modelsDir: 'm', log: memoryLogger().log, toCore: () => undefined });
    host.start();
    expect(mockState.instances).toHaveLength(0);
    host.stop();
  });

  it('edizione (P-104): nella tester parla Windows anche se la config dice kokoro o edge; in sviluppo resta la scelta', () => {
    const providerSent = (edition: 'tester' | 'sviluppo', provider: 'visione' | 'windows' | 'kokoro' | 'edge'): unknown => {
      mockState.instances.length = 0;
      const host = createVoiceHost({ entry: 'voice.js', env: {}, language: 'it', config: { ...config, tts: { ...config.tts, provider } }, edition, modelsDir: 'm', log: memoryLogger().log, toCore: () => undefined });
      host.start();
      mockState.instances[0]?.emit('spawn');
      const init = mockState.instances[0]?.sent.find((m) => (m as { kind?: string }).kind === 'init') as { config: { tts: { provider: string; voice: string } } } | undefined;
      host.stop();
      return init?.config.tts;
    };
    expect(providerSent('tester', 'kokoro')).toEqual({ provider: 'windows', voice: 'it-IT-DiegoNeural', rate: '+8%', pitch: '-2Hz' });
    expect(providerSent('tester', 'edge')).toMatchObject({ provider: 'windows' });
    expect(providerSent('tester', 'windows')).toMatchObject({ provider: 'windows' });
    expect(providerSent('sviluppo', 'kokoro')).toMatchObject({ provider: 'kokoro' });
    expect(providerSent('sviluppo', 'edge')).toMatchObject({ provider: 'edge' });
    expect(providerSent('tester', 'visione')).toMatchObject({ provider: 'visione' });
  });

  it('voce VISIONE (P-110): la cartella della voce inclusa arriva al processo voce e il messaggio è valido per il contratto', () => {
    const initOf = (voiceDir?: string): { config: Record<string, unknown> } | undefined => {
      mockState.instances.length = 0;
      const host = createVoiceHost({ entry: 'voice.js', env: {}, language: 'it', config, edition: 'tester', modelsDir: 'C:/modelli', ...(voiceDir ? { voiceDir } : {}), log: memoryLogger().log, toCore: () => undefined });
      host.start();
      mockState.instances[0]?.emit('spawn');
      const init = mockState.instances[0]?.sent.find((m) => (m as { kind?: string }).kind === 'init') as { config: Record<string, unknown> } | undefined;
      host.stop();
      return init;
    };
    const init = initOf('C:/VISIONE/resources/voce-visione/it');
    expect(init?.config.voiceDir).toBe('C:/VISIONE/resources/voce-visione/it');
    expect(mainToVoiceSchema.safeParse(init).error?.issues ?? []).toEqual([]);
    // Senza cartella: una che non esiste, e il processo voce ripiega su Windows dichiarandolo.
    expect(initOf()?.config.voiceDir).toBe(join('C:/modelli', 'voce-visione'));
  });

  it('riavvio: riparte con la configurazione e la lingua ATTUALI, non con quelle dell\'avvio (10/10/2026)', () => {
    mockState.instances.length = 0;
    let current = { voice: config, language: 'it' as 'it' | 'en' };
    const host = createVoiceHost({ entry: 'voice.js', env: {}, language: 'it', config, current: () => current, edition: 'sviluppo', modelsDir: 'm', log: memoryLogger().log, toCore: () => undefined });
    const initOf = (i: number): { language: string; tts: { voice: string }; wake: { phrase: string } } | undefined =>
      (mockState.instances[i]?.sent.find((m) => (m as { kind?: string }).kind === 'init') as { config: { language: string; tts: { voice: string }; wake: { phrase: string } } } | undefined)?.config;
    host.start();
    mockState.instances[0]?.emit('spawn');
    expect(initOf(0)).toMatchObject({ language: 'it', tts: { voice: 'it-IT-DiegoNeural' } });
    // La procedura guidata cambia voce, lingua e parola d'avvio, poi chiede il riavvio della voce.
    current = { voice: { ...config, tts: { ...config.tts, voice: 'Microsoft Zira' }, wake: { ...config.wake, phrase: 'hey vision' } }, language: 'en' };
    mockState.instances[0]?.emit('exit', 0);
    host.control('restart');
    mockState.instances[1]?.emit('spawn');
    expect(initOf(1)).toMatchObject({ language: 'en', tts: { voice: 'Microsoft Zira' }, wake: { phrase: 'hey vision' } });
    // Configurazione illeggibile: si riparte con quella dell'avvio invece di non ripartire.
    const broken = createVoiceHost({ entry: 'voice.js', env: {}, language: 'it', config, current: () => { throw new Error('file rotto'); }, edition: 'sviluppo', modelsDir: 'm', log: memoryLogger().log, toCore: () => undefined });
    broken.start();
    mockState.instances[2]?.emit('spawn');
    expect(initOf(2)).toMatchObject({ language: 'it', tts: { voice: 'it-IT-DiegoNeural' } });
    host.stop();
    broken.stop();
  });
});
