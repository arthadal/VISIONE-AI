// Audio del renderer (Fase 9, VISIONE_ARCHITECTURE §28): microfono → processo voce (PCM 16 kHz,
// mono, float32) e riproduzione della sintesi. La porta arriva dal main (che la trasferisce dal
// processo voce); qui non si decide nulla: si cattura, si manda, si riproduce. Il barge-in lo rileva
// il processo voce e si manifesta come uno `stop` di riproduzione.
import type { RendererToVoice, VoiceToRenderer } from '../../shared/contracts/index.ts';
import { resample } from './resample.ts';
import workletUrl from './pcm-worklet.js?url';

/** Canale del main per la porta audio (preload → main world); deve combaciare con `IPC_CHANNELS`. */
const PORT_CHANNEL = 'visione:voice:port';
const MIC_RATE = 16_000;

/** Tetto morbido dell'uscita: −1 dB. */
const CEILING = 10 ** (-1 / 20);
let ceilingCurve: Float32Array<ArrayBuffer> | null = null;

/**
 * Curva del tetto morbido (16/10/2026): lineare fino al 90% del tetto, poi una tangente iperbolica che
 * lo avvicina senza mai superarlo. Copre l'ingresso ±1: oltre, lo shaper tiene il valore dell'estremo,
 * che è già sul tetto (nessun gradino).
 */
export function softCeiling(): Float32Array<ArrayBuffer> {
  if (ceilingCurve) return ceilingCurve;
  const n = 4_097;
  const knee = CEILING * 0.9;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = (2 * i) / (n - 1) - 1;
    const a = Math.abs(v);
    curve[i] = a <= knee ? v : Math.sign(v) * (knee + (CEILING - knee) * Math.tanh((a - knee) / (CEILING - knee)));
  }
  ceilingCurve = curve;
  return curve;
}

interface Playing {
  sources: AudioBufferSourceNode[];
  pending: number;
  nextTime: number;
  ended: boolean;
  endReceived: boolean;
  started: boolean;
  stopped: boolean;
  /** Decodifiche/schedulazioni dei blocchi MP3 in ordine (Edge, P-84): ogni blocco attende il precedente. */
  queue: Promise<void>;
}

class VoiceAudio {
  private port: MessagePort | null = null;
  private captureCtx: AudioContext | null = null;
  private captureStream: MediaStream | null = null;
  private captureNode: AudioWorkletNode | null = null;
  private deviceId: string | null = null;
  private playCtx: AudioContext | null = null;
  private readonly playing = new Map<string, Playing>();
  /** Analizzatore REALE dell'uscita di sintesi (P-90): la scena si muove col volume della voce. */
  private analyser: AnalyserNode | null = null;
  private analyserCtx: AudioContext | null = null;
  private analyserBuf: Float32Array<ArrayBuffer> | null = null;
  /** Volume della voce (11/10/2026): guadagno lineare fra livellatore e limitatore. 2,5 = 250 %. */
  private volume = 2.5;
  private gain: GainNode | null = null;
  /** Ingresso della catena d'uscita (il taglio dei bassi): ci si collegano le frasi. */
  private input: AudioNode | null = null;

  constructor() {
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.data !== PORT_CHANNEL || event.ports.length === 0) return;
      this.port?.close();
      const port = event.ports[0]!;
      port.onmessage = (e: MessageEvent) => this.onVoiceMessage(e.data as VoiceToRenderer);
      port.start();
      this.port = port;
    });
  }

  get capturing(): boolean {
    return this.captureCtx !== null;
  }

  /** Microfono scelto (id di `enumerateDevices`); si applica alla prossima cattura. */
  get device(): string | null {
    return this.deviceId;
  }
  setDeviceId(id: string | null): void {
    this.deviceId = id && id !== '' ? id : null;
    // Rilascia la cattura in corso: la scelta vale dalla prossima apertura del microfono.
    if (this.captureCtx) this.releaseCapture();
  }

  /** Avvia la cattura del microfono (idempotente); rigetta se il permesso è negato. */
  async ensureCapture(): Promise<void> {
    if (this.captureCtx) return;
    const deviceId = this.deviceId;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    const ctx = new AudioContext({ sampleRate: MIC_RATE });
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'visione-pcm');
    const source = ctx.createMediaStreamSource(stream);
    node.port.onmessage = (e: MessageEvent) => {
      const chunk = e.data as Float32Array<ArrayBuffer>;
      this.post({ t: 'audio', samples: resample(chunk, ctx.sampleRate, MIC_RATE) });
    };
    // Un guadagno a zero tiene il nodo nel grafo senza rimandare il microfono alle casse.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(node);
    node.connect(silent);
    silent.connect(ctx.destination);
    this.captureCtx = ctx;
    this.captureStream = stream;
    this.captureNode = node;
  }

  /**
   * Rumore della stanza (P-106): apre il microfono scelto con gli stessi vincoli dell'ascolto per `ms`
   * millisecondi e restituisce il livello RMS di ogni blocco da 100 ms (niente viene inviato altrove).
   */
  async measureNoise(ms = 3_000): Promise<number[]> {
    const deviceId = this.deviceId;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const ctx = new AudioContext({ sampleRate: MIC_RATE });
    try {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2_048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const levels: number[] = [];
      const end = performance.now() + ms;
      while (performance.now() < end) {
        await new Promise((r) => setTimeout(r, 100));
        analyser.getFloatTimeDomainData(buf);
        let s = 0;
        for (const v of buf) s += v * v;
        levels.push(Math.sqrt(s / buf.length));
      }
      return levels;
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    }
  }

  /** Ferma la cattura e libera il microfono. */
  releaseCapture(): void {
    this.captureNode?.port.close();
    this.captureNode?.disconnect();
    this.captureStream?.getTracks().forEach((t) => t.stop());
    void this.captureCtx?.close();
    this.captureCtx = null;
    this.captureStream = null;
    this.captureNode = null;
  }

  private post(msg: RendererToVoice): void {
    this.port?.postMessage(msg);
  }

  private onVoiceMessage(msg: VoiceToRenderer): void {
    if (msg === null || typeof msg !== 'object') return;
    if (msg.t === 'stop') {
      this.stopPlayback(msg.ttsId);
      return;
    }
    if (msg.t === 'end') {
      const entry = this.playing.get(msg.ttsId);
      if (entry) {
        entry.endReceived = true;
        this.maybeFinish(msg.ttsId);
      }
      return;
    }
    if (msg.t === 'pcm') this.onChunk(msg.ttsId, msg.sampleRate, msg.samples);
    else if (msg.t === 'mp3') this.onMp3(msg.ttsId, msg.bytes);
  }

  private playbackContext(rate: number): AudioContext {
    if (!this.playCtx || this.playCtx.sampleRate !== rate) {
      void this.playCtx?.close();
      this.playCtx = new AudioContext({ sampleRate: rate });
    }
    return this.playCtx;
  }

  /**
   * Nodo di uscita della sintesi (l'ingresso della catena), ricreata quando cambia il contesto
   * (16 kHz PCM ↔ 24 kHz MP3). In fondo c'è l'analizzatore: legge il livello REALE in riproduzione.
   */
  private master(ctx: AudioContext): AudioNode {
    if (this.analyserCtx !== ctx || this.analyser === null || this.analyserBuf === null || this.input === null || this.gain === null) {
      // Volume (16-17/10/2026, «si sente basso», poi «non sentivo nulla» con Windows al 100% sulle casse del
      // portatile; misurato nel motore audio di Chromium su frasi vere delle due voci):
      // taglio dei bassi → presenza → livellatore → volume scelto → limitatore → tetto morbido → analizzatore.
      // Prima la voce VISIONE usciva a −15/−17 LUFS (−16/−18 per quel che le casse di un portatile
      // riproducono), diversa di 2,4 dB da una frase all'altra, con picchi 0,7 dB oltre il fondo scala.
      // - Sotto i 180 Hz le casse di un portatile non suonano, ma quei bassi (la voce è un baritono) si
      //   mangiano il margine del limitatore: tolti, tutto il resto può salire. +3 dB a 3 kHz: la zona in cui
      //   l'orecchio capisce le parole.
      // - Il livellatore (lento e dolce) porta ogni frase e ogni voce allo stesso livello.
      // - Il volume viene DOPO il livellatore: prima, il compressore se lo mangerebbe e il cursore non
      //   cambierebbe quasi niente.
      // - Il limitatore (rapido e ripido) tiene i picchi sotto −1 dB; il tetto morbido prende i rari residui
      //   senza mai tagliare di netto.
      // A 250 %: circa −12,5 LUFS, −13 sulle casse del portatile (+4/5 dB rispetto a prima), picchi ≤ −1 dB,
      // tetto toccato da meno dello 0,3% dei campioni (0,7% a 400 %).
      const lowCut = ctx.createBiquadFilter();
      lowCut.type = 'highpass';
      lowCut.frequency.value = 180;
      lowCut.Q.value = 0.707;
      const presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 3_000;
      presence.gain.value = 3;
      presence.Q.value = 1;
      const leveler = ctx.createDynamicsCompressor();
      leveler.threshold.value = -30;
      leveler.knee.value = 10;
      leveler.ratio.value = 3;
      leveler.attack.value = 0.01;
      leveler.release.value = 0.25;
      const gain = ctx.createGain();
      gain.gain.value = this.volume;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.08;
      const ceiling = ctx.createWaveShaper();
      ceiling.curve = softCeiling();
      ceiling.oversample = '4x';
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      lowCut.connect(presence);
      presence.connect(leveler);
      leveler.connect(gain);
      gain.connect(limiter);
      limiter.connect(ceiling);
      ceiling.connect(analyser);
      analyser.connect(ctx.destination);
      this.analyserCtx = ctx;
      this.analyser = analyser;
      this.analyserBuf = new Float32Array(analyser.fftSize);
      this.input = lowCut;
      this.gain = gain;
    }
    return this.input;
  }

  /** Volume della voce in percento (`voice.volume`, 50–400): vale subito, anche a frase in corso. */
  setVolume(percent: number): void {
    if (!Number.isFinite(percent)) return;
    this.volume = Math.min(4, Math.max(0.5, percent / 100));
    if (this.gain && this.analyserCtx) this.gain.gain.setTargetAtTime(this.volume, this.analyserCtx.currentTime, 0.05);
  }

  /** RMS REALE dell'audio di sintesi in uscita (0 quando non suona): muove la scena mentre parla. */
  outputLevel(): number {
    const analyser = this.analyser;
    const buf = this.analyserBuf;
    if (!analyser || !buf) return 0;
    try {
      analyser.getFloatTimeDomainData(buf);
    } catch {
      return 0; // contesto chiuso (cambio di frequenza): nessun livello inventato
    }
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] as number;
      sum += v * v;
    }
    // Taratura dichiarata: una voce piena del TTS (RMS ≈ 0,2–0,35) arriva a fondo scala.
    return Math.min(1, Math.sqrt(sum / buf.length) * 3.5);
  }

  private entry(ttsId: string): Playing {
    const found = this.playing.get(ttsId);
    if (found) return found;
    const entry: Playing = { sources: [], pending: 0, nextTime: 0, ended: false, endReceived: false, started: false, stopped: false, queue: Promise.resolve() };
    this.playing.set(ttsId, entry);
    return entry;
  }

  private onChunk(ttsId: string, sampleRate: number, samples: Float32Array<ArrayBuffer>): void {
    const ctx = this.playbackContext(sampleRate);
    const buffer = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
    buffer.copyToChannel(samples, 0);
    const entry = this.entry(ttsId);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master(ctx));
    const at = Math.max(ctx.currentTime, entry.nextTime);
    source.start(at);
    entry.nextTime = at + buffer.duration;
    entry.sources.push(source);
    entry.pending += 1;
    source.onended = () => {
      entry.pending -= 1;
      if (!entry.stopped) this.maybeFinish(ttsId);
    };
    if (!entry.started) {
      entry.started = true;
      this.post({ t: 'playback', ttsId, phase: 'started' });
    }
  }

  /**
   * Blocco MP3 (Edge, P-84): decodifica con Web Audio e lo accoda in ordine. La decodifica è
   * asincrona: `pending` conta una unità per blocco, che resta la stessa quando il blocco diventa
   * una source in riproduzione (decrementata a `onended`); così `end` non chiude la frase in
   * anticipo e uno `stop` può fermare le source ancora in coda.
   */
  private onMp3(ttsId: string, bytes: Uint8Array): void {
    const entry = this.entry(ttsId);
    entry.pending += 1; // decodifica in corso, poi la source in riproduzione
    entry.queue = entry.queue.then(async () => {
      let scheduled = false;
      try {
        if (entry.stopped) return;
        const ctx = this.playbackContext(24_000);
        const buffer = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
        if (entry.stopped) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.master(ctx));
        const at = Math.max(ctx.currentTime, entry.nextTime);
        source.start(at);
        entry.nextTime = at + buffer.duration;
        entry.sources.push(source);
        source.onended = () => {
          entry.pending -= 1;
          if (!entry.stopped) this.maybeFinish(ttsId);
        };
        scheduled = true;
        if (!entry.started) {
          entry.started = true;
          this.post({ t: 'playback', ttsId, phase: 'started' });
        }
      } catch {
        // Blocco non decodificabile: si scarta (nessun dato inventato); la frase resta tracciata.
      } finally {
        if (!scheduled) {
          entry.pending -= 1;
          this.maybeFinish(ttsId);
        }
      }
    });
  }

  private maybeFinish(ttsId: string): void {
    const entry = this.playing.get(ttsId);
    if (!entry || entry.stopped || entry.ended) return;
    if (!entry.endReceived || entry.pending > 0) return;
    entry.ended = true;
    this.playing.delete(ttsId);
    this.post({ t: 'playback', ttsId, phase: 'ended' });
  }

  private stopPlayback(ttsId: string | null): void {
    const ids = ttsId === null ? [...this.playing.keys()] : [ttsId];
    for (const id of ids) {
      const entry = this.playing.get(id);
      if (!entry || entry.stopped) continue;
      entry.stopped = true;
      for (const source of entry.sources) {
        try {
          source.stop();
        } catch {
          // già terminata
        }
      }
      this.playing.delete(id);
      this.post({ t: 'playback', ttsId: id, phase: 'stopped' });
    }
    if (ttsId === null && this.playing.size > 0) this.playing.clear();
  }
}

export const voiceAudio = new VoiceAudio();
