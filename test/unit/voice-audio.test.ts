// Renderer audio (P-84): il percorso MP3 decodifica con Web Audio e accoda le source. Regressione
// del difetto trovato nella prova reale: il blocco in decodifica NON deve essere contato due volte,
// altrimenti la frase risulta «finita» mentre l'audio sta ancora suonando (e lo stop non lo ferma).
// Web Audio e MessagePort sono finti: nessun dispositivo, nessuna rete.
import { describe, expect, it, vi } from 'vitest';

interface FakeBuffer {
  duration: number;
  copyToChannel?: (samples: Float32Array, channel: number) => void;
}

class FakeSource {
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  started: number | null = null;
  readonly stopped = false;
  /** Il nodo a cui è collegata (la catena d'uscita). */
  next: unknown = null;
  connect(node: unknown): void {
    this.next = node;
  }
  start(at: number): void {
    this.started = at;
  }
  stop(): void {
    /* stop immediato */
  }
  end(): void {
    this.onended?.();
  }
}

class FakeAnalyser {
  fftSize = 512;
  next: unknown = null;
  connect(node: unknown): void {
    this.next = node;
  }
  /** Segnale finto: il test decide il valore RMS restituito. */
  livello = 0;
  getFloatTimeDomainData(buf: Float32Array): void {
    buf.fill(this.livello);
  }
}

/** Parametro audio finto (guadagno, soglie del limitatore). */
class FakeParam {
  value = 0;
  setTargetAtTime(v: number): void {
    this.value = v;
  }
}

/** Nodo finto con parametri: volume (GainNode), livellatore e limitatore (DynamicsCompressorNode), tetto (WaveShaperNode). */
class FakeNode {
  readonly kind: 'gain' | 'compressor' | 'shaper' | 'biquad';
  constructor(kind: 'gain' | 'compressor' | 'shaper' | 'biquad') {
    this.kind = kind;
  }
  next: unknown = null;
  curve: Float32Array | null = null;
  oversample = 'none';
  type = '';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  readonly gain = new FakeParam();
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
  connect(node: unknown): void {
    this.next = node;
  }
}

class FakeContext {
  readonly sampleRate: number;
  currentTime = 0;
  readonly destination = {};
  readonly sources: FakeSource[] = [];
  readonly analysers: FakeAnalyser[] = [];
  /** Decodifiche in corso: il test le risolve a mano. */
  readonly pendingDecodes: Array<(buffer: FakeBuffer) => void> = [];
  constructor(opts: { sampleRate: number }) {
    this.sampleRate = opts.sampleRate;
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  readonly gains: FakeNode[] = [];
  createGain(): FakeNode {
    const node = new FakeNode('gain');
    this.gains.push(node);
    return node;
  }
  createDynamicsCompressor(): FakeNode {
    return new FakeNode('compressor');
  }
  createWaveShaper(): FakeNode {
    return new FakeNode('shaper');
  }
  createBiquadFilter(): FakeNode {
    return new FakeNode('biquad');
  }
  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }
  createBuffer(_channels: number, length: number, rate: number): FakeBuffer {
    return { duration: length / rate, copyToChannel: () => undefined };
  }
  decodeAudioData(): Promise<FakeBuffer> {
    return new Promise((resolve) => this.pendingDecodes.push(resolve));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const listeners = new Map<string, Array<(event: { data: unknown; ports?: unknown[] }) => void>>();
const contexts: FakeContext[] = [];

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly posted: unknown[] = [];
  start(): void {
    /* attiva */
  }
  close(): void {
    /* chiude */
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
}

vi.stubGlobal('window', {
  addEventListener: (type: string, fn: (event: { data: unknown; ports?: unknown[] }) => void) => {
    const list = listeners.get(type) ?? [];
    list.push(fn);
    listeners.set(type, list);
  }
});
vi.stubGlobal('AudioContext', class extends FakeContext {
  constructor(opts: { sampleRate: number }) {
    super(opts);
    contexts.push(this);
  }
});

// L'import dell'istanza avviene DOPO gli stub (il costruttore tocca `window`).
const audio = await import('../../src/renderer/voice/audio.ts');

function attach(port: FakePort): void {
  for (const fn of listeners.get('message') ?? []) fn({ data: 'visione:voice:port', ports: [port] });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

const pcm = (ttsId: string, top: number): { t: string; ttsId: string; sampleRate: number; samples: Float32Array; last: boolean } => ({
  t: 'pcm', ttsId, sampleRate: 24_000, samples: new Float32Array(24).fill(top), last: false
});

const PLAY = (phase: 'started' | 'ended' | 'stopped', ttsId = 't1'): { t: string; ttsId: string; phase: string } => ({ t: 'playback', ttsId, phase });

describe('VoiceAudio — percorsi MP3 e stop (P-84)', () => {
  it('due blocchi MP3 + end: «ended» arriva solo quando entrambe le source sono finite', async () => {
    const port = new FakePort();
    attach(port);
    port.onmessage!({ data: { t: 'mp3', ttsId: 't1', bytes: new Uint8Array([1, 2, 3]), last: false } });
    port.onmessage!({ data: { t: 'mp3', ttsId: 't1', bytes: new Uint8Array([4, 5, 6]), last: false } });
    port.onmessage!({ data: { t: 'end', ttsId: 't1' } });
    await flush();

    const ctx = contexts[0]!;
    expect(ctx.pendingDecodes).toHaveLength(1); // la coda serializza le decodifiche
    ctx.pendingDecodes[0]!({ duration: 0.5 });
    await flush();
    expect(ctx.pendingDecodes).toHaveLength(2);
    expect(port.posted).toContainEqual(PLAY('started'));
    ctx.pendingDecodes[1]!({ duration: 0.5 });
    await flush();

    expect(ctx.sources).toHaveLength(2);
    expect(port.posted).not.toContainEqual(PLAY('ended')); // il 2° blocco suona ancora
    ctx.sources[0]!.end();
    expect(port.posted).not.toContainEqual(PLAY('ended')); // il 1° finito, il 2° no
    ctx.sources[1]!.end();
    expect(port.posted).toContainEqual(PLAY('ended'));
  });

  it('stop durante la decodifica: la decodifica in volo viene scartata, «stopped» al core', async () => {
    const port = new FakePort();
    attach(port);
    port.onmessage!({ data: { t: 'mp3', ttsId: 't2', bytes: new Uint8Array([7]), last: false } });
    port.onmessage!({ data: { t: 'end', ttsId: 't2' } });
    await flush();
    const ctx = contexts[0]!;
    const at = ctx.pendingDecodes.length; // le 2 della prova precedente + quella nuova
    expect(at).toBe(3);
    port.onmessage!({ data: { t: 'stop', ttsId: 't2' } }); // stop mentre la decodifica è in volo
    expect(port.posted).toContainEqual(PLAY('stopped', 't2'));
    ctx.pendingDecodes[at - 1]!({ duration: 0.4 }); // arriva dopo lo stop: va scartata
    await flush();
    expect(ctx.sources).toHaveLength(2); // nessuna source nuova
    expect(port.posted).not.toContainEqual(PLAY('ended', 't2'));
  });

  it('PCM: il blocco viene accodato e «ended» arriva a fine source', async () => {
    const port = new FakePort();
    attach(port);
    port.onmessage!({ data: pcm('t3', 0.01) });
    port.onmessage!({ data: { t: 'end', ttsId: 't3' } });
    await flush();
    const ctx = contexts[0]!;
    expect(ctx.sources).toHaveLength(3);
    expect(port.posted).toContainEqual(PLAY('started', 't3'));
    expect(port.posted).not.toContainEqual(PLAY('ended', 't3'));
    ctx.sources[2]!.end();
    expect(port.posted).toContainEqual(PLAY('ended', 't3'));
  });

  it('volume della voce (11/10/2026): 250 % di partenza, cambia subito, limitato a 50–400 %', async () => {
    const port = new FakePort();
    attach(port);
    port.onmessage!({ data: pcm('tv', 0.01) });
    await flush();
    const ctx = contexts[contexts.length - 1]!;
    const gain = ctx.gains[ctx.gains.length - 1]!;
    expect(gain.gain.value).toBe(2.5);
    audio.voiceAudio.setVolume(100);
    expect(gain.gain.value).toBe(1);
    audio.voiceAudio.setVolume(1_000);
    expect(gain.gain.value).toBe(4);
    audio.voiceAudio.setVolume(10);
    expect(gain.gain.value).toBe(0.5);
    audio.voiceAudio.setVolume(250);
  });

  it('volume (16-17/10/2026): frase → taglio dei bassi → presenza → livellatore → volume → limitatore → tetto → analizzatore → casse', async () => {
    const port = new FakePort();
    attach(port);
    port.onmessage!({ data: pcm('tc', 0.01) });
    await flush();
    const ctx = contexts[contexts.length - 1]!;
    // Sotto i 180 Hz le casse di un portatile non suonano: quei bassi si mangerebbero il margine del limitatore.
    const lowCut = ctx.sources.at(-1)!.next as FakeNode;
    expect(lowCut.kind).toBe('biquad');
    expect(lowCut.type).toBe('highpass');
    expect(lowCut.frequency.value).toBe(180);
    const presence = lowCut.next as FakeNode;
    expect(presence.type).toBe('peaking');
    expect(presence.frequency.value).toBe(3_000);
    expect(presence.gain.value).toBe(3);
    const leveler = presence.next as FakeNode;
    expect(leveler.kind).toBe('compressor');
    expect(leveler.threshold.value).toBe(-30);
    expect(leveler.ratio.value).toBe(3);
    // Il volume viene DOPO il livellatore, altrimenti il compressore se lo mangia.
    const gain = leveler.next as FakeNode;
    expect(gain.kind).toBe('gain');
    expect(gain).toBe(ctx.gains.at(-1));
    const limiter = gain.next as FakeNode;
    expect(limiter.kind).toBe('compressor');
    expect(limiter.threshold.value).toBe(-6);
    expect(limiter.ratio.value).toBe(20);
    const ceiling = limiter.next as FakeNode;
    expect(ceiling.kind).toBe('shaper');
    expect(ceiling.curve).toBe(audio.softCeiling());
    expect(ceiling.oversample).toBe('4x');
    const analyser = ceiling.next as FakeAnalyser;
    expect(analyser).toBe(ctx.analysers.at(-1));
    expect(analyser.next).toBe(ctx.destination);
  });

  it('tetto morbido (16/10/2026): lineare sotto il ginocchio, mai oltre −1 dB, senza gradini', () => {
    const curve = audio.softCeiling();
    const top = 10 ** (-1 / 20);
    const at = (x: number): number => curve[Math.round(((x + 1) / 2) * (curve.length - 1))]!;
    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(0.5)).toBeCloseTo(0.5, 3);
    expect(at(-0.75)).toBeCloseTo(-0.75, 3);
    expect(at(1)).toBeGreaterThan(top - 0.01);
    for (let i = 0; i < curve.length; i++) expect(Math.abs(curve[i]!)).toBeLessThanOrEqual(top);
    // Monotona e continua: nessun salto fra due punti vicini (un gradino sarebbe un «clic»).
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
      expect(curve[i]! - curve[i - 1]!).toBeLessThan(0.001);
    }
  });

  it('P-90: il livello di uscita REALE muove la scena (0 a riposo, 0..1 con audio)', async () => {
    const port = new FakePort();
    attach(port);
    // Nessun audio in riproduzione: il livello è zero, non un valore decorativo.
    expect(audio.voiceAudio.outputLevel()).toBe(0);
    port.onmessage!({ data: pcm('t4', 0.02) });
    await flush();
    const ctx = contexts.at(-1)!;
    const analyser = ctx.analysers.at(-1)!;
    expect(analyser).toBeDefined();
    expect(audio.voiceAudio.outputLevel()).toBe(0);
    // Voce piena: RMS 0,5 → fondo scala (taratura dichiarata 3,5×, limitata a 1).
    analyser.livello = 0.5;
    expect(audio.voiceAudio.outputLevel()).toBe(1);
    analyser.livello = 0.1;
    expect(audio.voiceAudio.outputLevel()).toBeCloseTo(0.35, 5);
  });
});
