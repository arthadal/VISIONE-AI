// Pipeline della voce (Fase 9): PTT → VAD → STT e frase → TTS → riproduzione, con barge-in.
// Motori finti: nessun audio reale, nessun modello. Le latenze si misurano con un orologio finto.
import { describe, expect, it } from 'vitest';
import type { SpeechSegment, SttEngine, TtsChunk, TtsEngine, VadEngine } from '../../src/voice/engines.ts';
import { VoicePipeline, type PipelineTimers } from '../../src/voice/pipeline.ts';
import { VOICE_LIMITS, type VoiceToCore, type VoiceToRenderer } from '../../src/shared/contracts/index.ts';

class FakeVad implements VadEngine {
  readonly name = 'fake-vad';
  readonly windowSize = 8;
  private speaking = false;
  private pos = 0;
  private start = 0;
  private queue: SpeechSegment[] = [];

  accept(window: Float32Array): void {
    this.pos += window.length;
  }

  /** Segmento finto ma energetico e lungo abbastanza (300 ms a 16 kHz): passa i gate della wake. */
  private segment(): Float32Array {
    return new Float32Array(4_800).fill(0.5);
  }

  setSpeaking(value: boolean): void {
    if (value && !this.speaking) this.start = this.pos;
    if (!value && this.speaking) this.queue.push({ start: this.start, samples: this.segment() });
    this.speaking = value;
  }

  detected(): boolean {
    return this.speaking;
  }

  flush(): void {
    if (!this.speaking) return;
    this.queue.push({ start: this.start, samples: this.segment() });
    this.speaking = false;
  }

  pop(): SpeechSegment | null {
    return this.queue.shift() ?? null;
  }

  reset(): void {
    this.speaking = false;
    this.pos = 0;
    this.start = 0;
    this.queue = [];
  }
}

class FakeStt implements SttEngine {
  readonly name = 'fake-stt';
  readonly calls: Float32Array[] = [];
  fail = false;
  private readonly result: string;
  constructor(result = 'accendi le luci') {
    this.result = result;
  }
  transcribe(samples: Float32Array): Promise<string> {
    this.calls.push(samples);
    if (this.fail) return Promise.reject(new Error('modello assente'));
    return Promise.resolve(this.result);
  }
}

class FakeTts implements TtsEngine {
  readonly name = 'fake-tts';
  readonly texts: string[] = [];
  private readonly fail: boolean;
  constructor(fail = false) {
    this.fail = fail;
  }
  synthesize(text: string, onChunk: (chunk: TtsChunk) => boolean): Promise<void> {
    this.texts.push(text);
    if (this.fail) return Promise.reject(new Error('kokoro assente'));
    onChunk({ kind: 'pcm', samples: new Float32Array(8), sampleRate: 24_000 });
    return Promise.resolve();
  }
}

/** TTS che emette MP3 (Edge, P-84): la pipeline deve inoltrarlo come `mp3`, non decodificarlo. */
class FakeMp3Tts implements TtsEngine {
  readonly name = 'edge it-IT-DiegoNeural + kokoro';
  synthesize(_text: string, onChunk: (chunk: TtsChunk) => boolean): Promise<void> {
    onChunk({ kind: 'mp3', bytes: new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2]) });
    onChunk({ kind: 'mp3', bytes: new Uint8Array([0xff, 0xfb, 0x90, 0x00, 3, 4]) });
    return Promise.resolve();
  }
}

const silentTimers: PipelineTimers = { set: () => ({}), clear: () => undefined };

function setup(opts: { result?: string; fail?: boolean; bargeIn?: boolean; wake?: boolean; noWakeVad?: boolean; mp3?: boolean; wakeResult?: string } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const vad = new FakeVad();
  const stt = new FakeStt(opts.result);
  const wakeStt = opts.wakeResult === undefined ? null : new FakeStt(opts.wakeResult);
  const tts: TtsEngine = opts.mp3 ? new FakeMp3Tts() : new FakeTts(opts.fail);
  const core: VoiceToCore[] = [];
  const renderer: VoiceToRenderer[] = [];
  let n = 0;
  const pipeline = new VoicePipeline({
    engines: opts.noWakeVad ? { vad, stt, tts } : { vad, stt, tts, wakeVad: vad, ...(wakeStt ? { wakeStt } : {}) },
    toCore: (m) => core.push(m),
    toRenderer: (m) => {
      renderer.push(m);
      return true;
    },
    newId: () => `u${++n}`,
    bargeIn: opts.bargeIn ?? true,
    ...(opts.wake !== undefined ? { wake: { enabled: opts.wake, phrase: 'hey visione' } } : {}),
    now: () => clock.t,
    timers: silentTimers
  });
  return { clock, vad, stt, wakeStt, tts, core, renderer, pipeline };
}

describe('VoicePipeline', () => {
  it('push-to-talk: VAD → STT produce un enunciato con le latenze', async () => {
    const { vad, stt, core, pipeline } = setup();
    pipeline.ptt(true, false);
    expect(pipeline.isListening).toBe(true);
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(8));
    vad.setSpeaking(false);
    pipeline.audio(new Float32Array(8));
    pipeline.ptt(false, false);
    await pipeline.idle();

    const vadEvents = core.filter((m) => m.type === 'vad');
    expect(vadEvents.map((m) => (m.type === 'vad' ? m.phase : ''))).toEqual(['start', 'end']);
    const utterance = core.find((m) => m.type === 'utterance');
    expect(utterance).toMatchObject({ type: 'utterance', text: 'accendi le luci' });
    expect(stt.calls).toHaveLength(1);
    expect(stt.calls[0]?.length).toBeGreaterThan(0);
  });

  it('autoEnd: la frase si chiude da sola dopo il parlato e un margine di silenzio (scorciatoia globale, wake)', async () => {
    const { vad, core, pipeline, clock } = setup();
    pipeline.ptt(true, true);
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(8));
    vad.setSpeaking(false);
    pipeline.audio(new Float32Array(8));
    expect(pipeline.isListening).toBe(true); // finito il parlato, si aspetta ancora
    clock.t += VOICE_LIMITS.autoEndGraceMs;
    pipeline.audio(new Float32Array(8));
    await pipeline.idle();
    expect(pipeline.isListening).toBe(false);
    expect(core.some((m) => m.type === 'utterance')).toBe(true);
  });

  it('autoEnd (17/10/2026): una pausa per pensare non chiude il turno, si riprende a parlare e la frase resta una', async () => {
    const { vad, stt, pipeline, clock } = setup();
    pipeline.ptt(true, true);
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(8)); // «ciao»
    vad.setSpeaking(false);
    pipeline.audio(new Float32Array(8));
    clock.t += VOICE_LIMITS.autoEndGraceMs - 100; // pausa, ma non abbastanza
    pipeline.audio(new Float32Array(8));
    expect(pipeline.isListening).toBe(true);
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(8)); // «come stai»
    vad.setSpeaking(false);
    pipeline.audio(new Float32Array(8));
    clock.t += VOICE_LIMITS.autoEndGraceMs - 100; // il conto riparte dalla nuova fine del parlato
    pipeline.audio(new Float32Array(8));
    expect(pipeline.isListening).toBe(true);
    clock.t += 200;
    pipeline.audio(new Float32Array(8));
    await pipeline.idle();
    expect(pipeline.isListening).toBe(false);
    expect(stt.calls).toHaveLength(1); // una frase sola, con tutti e due i pezzi
    expect(stt.calls[0]!.length).toBe(2 * 4_800);
  });

  it('autoEnd (18/10/2026): dopo una frase intera il turno si chiude col margine breve, non con quello pieno', async () => {
    const { vad, stt, pipeline, clock } = setup();
    pipeline.ptt(true, true);
    // 4 pezzi da 0,3 s = 1,2 s di parlato: una frase intera.
    for (let i = 0; i < 4; i++) {
      vad.setSpeaking(true);
      pipeline.audio(new Float32Array(8));
      vad.setSpeaking(false);
      pipeline.audio(new Float32Array(8));
    }
    clock.t += VOICE_LIMITS.autoEndQuickGraceMs - 50;
    pipeline.audio(new Float32Array(8));
    expect(pipeline.isListening).toBe(true);
    clock.t += 50;
    pipeline.audio(new Float32Array(8));
    await pipeline.idle();
    expect(pipeline.isListening).toBe(false);
    expect(stt.calls).toHaveLength(1);
    expect(VOICE_LIMITS.autoEndQuickGraceMs).toBeLessThan(VOICE_LIMITS.autoEndGraceMs);
  });

  it('senza parlato non chiama lo STT (il silenzio non inventa frasi)', async () => {
    const { stt, core, pipeline } = setup();
    pipeline.ptt(true, false);
    pipeline.audio(new Float32Array(8));
    pipeline.ptt(false, false);
    await pipeline.idle();
    expect(stt.calls).toHaveLength(0);
    expect(core.find((m) => m.type === 'utterance')).toMatchObject({ text: '', audioMs: 0 });
  });

  it('frase → TTS a blocchi → riproduzione; fine dal renderer', async () => {
    const { tts, renderer, core, pipeline } = setup();
    pipeline.speak('t1', 'Ciao, sono VISIONE.');
    await Promise.resolve();
    expect((tts as FakeTts).texts).toEqual(['Ciao, sono VISIONE.']);
    expect(renderer.some((m) => m.t === 'pcm')).toBe(true);
    expect(renderer.some((m) => m.t === 'end')).toBe(true);
    pipeline.playback({ t: 'playback', ttsId: 't1', phase: 'started' });
    pipeline.playback({ t: 'playback', ttsId: 't1', phase: 'ended' });
    expect(core.find((m) => m.type === 'tts' && m.phase === 'finished')).toBeDefined();
  });

  it('frase MP3 (Edge, P-84): i blocchi viaggiano come mp3 al renderer, il fine resta un end', async () => {
    const { renderer, core, pipeline } = setup({ mp3: true });
    pipeline.speak('t1', 'Buonasera, signore.');
    await Promise.resolve();
    const mp3 = renderer.filter((m) => m.t === 'mp3');
    expect(mp3.length).toBe(2);
    expect(mp3.every((m) => m.t === 'mp3' && m.bytes.length > 0)).toBe(true);
    expect(renderer.some((m) => m.t === 'end')).toBe(true);
    // La sintesi MP3 non produce PCM inventato.
    expect(renderer.some((m) => m.t === 'pcm')).toBe(false);
    pipeline.playback({ t: 'playback', ttsId: 't1', phase: 'started' });
    pipeline.playback({ t: 'playback', ttsId: 't1', phase: 'ended' });
    expect(core.find((m) => m.type === 'tts' && m.phase === 'finished')).toBeDefined();
  });

  it('barge-in su frase MP3: lo stop arriva al renderer e la frase è interrotta', async () => {
    const { vad, renderer, core, pipeline } = setup({ mp3: true });
    pipeline.speak('t1', 'Una frase lunga con la voce di Edge.');
    await Promise.resolve();
    pipeline.playback({ t: 'playback', ttsId: 't1', phase: 'started' });
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(16));
    expect(renderer.some((m) => m.t === 'stop' && m.ttsId === 't1')).toBe(true);
    pipeline.playback({ t: 'playback', ttsId: 't1', phase: 'stopped' });
    expect(core.find((m) => m.type === 'tts' && m.phase === 'interrupted')).toMatchObject({ cause: 'barge-in' });
  });

  it('barge-in: il parlato interrompe la riproduzione, latenza < 300 ms', async () => {
    const { clock, vad, renderer, core, pipeline } = setup({ bargeIn: true });
    pipeline.speak('t1', 'Una frase lunga che VISIONE sta leggendo.');
    await Promise.resolve();
    pipeline.playback({ t: 'playback', ttsId: 't1', phase: 'started' });
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(16));
    expect(renderer.some((m) => m.t === 'stop')).toBe(true);
    clock.t += 80;
    pipeline.playback({ t: 'playback', ttsId: 't1', phase: 'stopped' });
    const interrupted = core.find((m) => m.type === 'tts' && m.phase === 'interrupted');
    expect(interrupted).toBeDefined();
    if (interrupted && interrupted.type === 'tts') {
      expect(interrupted.cause).toBe('barge-in');
      expect(interrupted.bargeInMs).toBeLessThan(300);
      expect(interrupted.bargeInMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('sintesi non riuscita: errore verso il core, nessuna riproduzione', async () => {
    const { core, pipeline } = setup({ fail: true });
    pipeline.speak('t1', 'Ciao');
    await Promise.resolve();
    await Promise.resolve();
    expect(core.some((m) => m.type === 'tts' && m.phase === 'failed')).toBe(true);
  });

  it('STT non disponibile: errore verso il core, nessun enunciato inventato, la pipeline resta usabile', async () => {
    const { vad, stt, core, pipeline } = setup();
    stt.fail = true;
    pipeline.ptt(true, false);
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(8));
    vad.setSpeaking(false);
    pipeline.audio(new Float32Array(8));
    pipeline.ptt(false, false);
    await pipeline.idle();

    expect(core.find((m) => m.type === 'error')).toMatchObject({ type: 'error', code: 'stt-failed' });
    expect(core.some((m) => m.type === 'utterance')).toBe(false); // nessuna frase falsa
    expect(pipeline.isListening).toBe(false);

    // Recovery: il motore torna disponibile, la STESSA pipeline trascrive di nuovo.
    stt.fail = false;
    pipeline.ptt(true, false);
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(8));
    vad.setSpeaking(false);
    pipeline.audio(new Float32Array(8));
    pipeline.ptt(false, false);
    await pipeline.idle();
    expect(core.find((m) => m.type === 'utterance')).toMatchObject({ type: 'utterance', text: 'accendi le luci' });
  });

  it('wake (P-81): la frase con comando produce un fatto wake con lo STT reale', async () => {
    const { vad, stt, core, pipeline } = setup({ result: 'Hey Visione, apri i documenti', wake: true });
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(8));
    vad.setSpeaking(false);
    pipeline.audio(new Float32Array(8));
    await pipeline.idle();

    const wake = core.find((m) => m.type === 'wake');
    expect(wake).toMatchObject({ phrase: 'hey visione', text: 'Hey Visione, apri i documenti', command: 'apri i documenti' });
    if (wake && wake.type === 'wake') {
      expect(wake.audioMs).toBeGreaterThanOrEqual(250);
      expect(wake.sttMs).toBeGreaterThanOrEqual(0);
    }
    expect(stt.calls).toHaveLength(1);
  });

  it('17/10/2026: wake col modello rapido; il comando detto di seguito si ritrascrive col modello buono', async () => {
    const s = setup({ result: 'Hey Visione, apri le impostazioni', wakeResult: 'e visione, avrei le impostazioni', wake: true });
    s.vad.setSpeaking(true);
    s.pipeline.audio(new Float32Array(8));
    s.vad.setSpeaking(false);
    s.pipeline.audio(new Float32Array(8));
    await s.pipeline.idle();
    expect(s.core.find((m) => m.type === 'wake')).toMatchObject({ text: 'Hey Visione, apri le impostazioni', command: 'apri le impostazioni' });
    expect(s.wakeStt!.calls).toHaveLength(1);
    expect(s.stt.calls).toHaveLength(1);
    // Solo la parola d'avvio, o una frase lunga: il modello buono non lavora (niente costo su ogni rumore).
    for (const wakeResult of ['Ehi visione', 'la televisione accesa in salotto stasera']) {
      const q = setup({ result: 'non usato', wakeResult, wake: true });
      q.vad.setSpeaking(true);
      q.pipeline.audio(new Float32Array(8));
      q.vad.setSpeaking(false);
      q.pipeline.audio(new Float32Array(8));
      await q.pipeline.idle();
      expect(q.stt.calls).toHaveLength(0);
    }
    // 24/10/2026: segmento breve che il modello rapido sbaglia («Eh, eh, eh,»): secondo tentativo col modello buono.
    const r = setup({ result: 'Hey Visione.', wakeResult: 'Eh, eh, eh,', wake: true });
    r.vad.setSpeaking(true);
    r.pipeline.audio(new Float32Array(8));
    r.vad.setSpeaking(false);
    r.pipeline.audio(new Float32Array(8));
    await r.pipeline.idle();
    expect(r.stt.calls).toHaveLength(1);
    expect(r.core.find((m) => m.type === 'wake')).toMatchObject({ text: 'Hey Visione.', command: '' });
  });

  it('wake: sola frase → comando vuoto; testo non pertinente → nessun fatto', async () => {
    const only = setup({ result: 'Ehi visione', wake: true });
    only.vad.setSpeaking(true);
    only.pipeline.audio(new Float32Array(8));
    only.vad.setSpeaking(false);
    only.pipeline.audio(new Float32Array(8));
    await only.pipeline.idle();
    expect(only.core.find((m) => m.type === 'wake')).toMatchObject({ command: '' });

    const other = setup({ result: 'accendi le luci', wake: true });
    other.vad.setSpeaking(true);
    other.pipeline.audio(new Float32Array(8));
    other.vad.setSpeaking(false);
    other.pipeline.audio(new Float32Array(8));
    await other.pipeline.idle();
    expect(other.stt.calls).toHaveLength(1); // lo STT è stato chiamato…
    expect(other.core.some((m) => m.type === 'wake')).toBe(false); // …ma nessuna wake inventata
  });

  it('wake spenta: nessuna trascrizione di sottofondo; lo stato risponde con la realtà', () => {
    const { vad, stt, core, pipeline } = setup();
    pipeline.wake(false, 'hey visione');
    expect(core.find((m) => m.type === 'wake-state')).toMatchObject({ enabled: false, available: true, reason: null });
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(8));
    vad.setSpeaking(false);
    pipeline.audio(new Float32Array(8));
    expect(stt.calls).toHaveLength(0);
    expect(core.some((m) => m.type === 'wake')).toBe(false);
  });

  it('wake senza VAD dedicata: non disponibile, nessun ascolto in background', () => {
    const { vad, stt, core, pipeline } = setup({ noWakeVad: true });
    pipeline.wake(true, 'hey visione');
    expect(core.find((m) => m.type === 'wake-state')).toMatchObject({ enabled: false, available: false });
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(8));
    expect(stt.calls).toHaveLength(0);
  });

  it('wake non ascolta mentre VISIONE parla (nessun loop sul proprio TTS)', async () => {
    const { vad, stt, core, renderer, pipeline } = setup({ result: 'Hey Visione', wake: true });
    pipeline.speak('t1', 'Una frase lunga di VISIONE.');
    await Promise.resolve();
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(8));
    expect(stt.calls).toHaveLength(0);
    expect(core.some((m) => m.type === 'wake')).toBe(false);
    // Il barge-in resta attivo: il parlato interrompe la riproduzione.
    expect(renderer.some((m) => m.t === 'stop')).toBe(true);
  });
});

describe('pulizia del rumore e STT (24/10/2026)', () => {
  // Parakeet v3 trascrive meglio l'audio originale (93,0% di parole giuste con rumore, 85,6% dopo GTCRN): la pulizia
  // va solo a Whisper. Il VAD finto dà segmenti a 0,5, la pulizia finta li porta a 0,25: si riconosce quale audio arriva allo STT.
  const run = async (rawInput: boolean): Promise<Float32Array> => {
    const vad = new FakeVad();
    const stt = Object.assign(new FakeStt(), rawInput ? { rawInput: true } : {});
    const pipeline = new VoicePipeline({
      engines: { vad, stt, tts: new FakeTts() },
      toCore: () => undefined,
      toRenderer: () => true,
      newId: () => 'u1',
      bargeIn: true,
      now: () => 1_700_000_000_000,
      timers: silentTimers,
      filters: { noiseGate: 0, denoise: { name: 'pulizia finta', run: (s) => s.map(() => 0.25) } }
    });
    pipeline.ptt(true, false);
    vad.setSpeaking(true);
    pipeline.audio(new Float32Array(8).fill(0.1));
    vad.setSpeaking(false);
    pipeline.audio(new Float32Array(8));
    pipeline.ptt(false, false);
    await pipeline.idle();
    return stt.calls[0]!;
  };

  it('Whisper riceve l\'audio pulito, Parakeet quello originale', async () => {
    const pulito = await run(false);
    expect([...pulito].every((x) => x === 0.25)).toBe(true);
    const grezzo = await run(true);
    expect([...grezzo].every((x) => x === 0.5)).toBe(true);
  });
});
