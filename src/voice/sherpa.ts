// Motori sherpa-onnx (Apache-2.0, P-12, P-48): Silero VAD, Whisper multilingue (STT), Kokoro
// (TTS italiano). Tutto locale: nessuna rete, modelli letti da `<modelsDir>` e mai scaricati qui
// (lo fa `tools/voice-models.mjs`, su richiesta del proprietario). Il modulo nativo è N-API: stessa
// build per Node e per Electron. Caricamento e inferenza pesanti sono asincroni (thread nativi):
// il ciclo degli eventi resta libero per l'audio e il barge-in.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../shared/voice-models.json' with { type: 'json' };
import { VOICE_SAMPLE_RATE } from '../shared/contracts/voice.ts';
import type { SpeechSegment, SttEngine, TtsEngine, VadEngine, VoiceEngines } from './engines.ts';
import type { DenoiseEngine, SpeakerEngine } from './filters.ts';

export interface SherpaOptions {
  readonly modelsDir: string;
  readonly threads: number;
  /** Voce di Kokoro v1.0 (italiano): if_sara (35) o im_nicola (36). */
  readonly speaker: 'if_sara' | 'im_nicola';
  readonly vad: { readonly threshold: number; readonly minSpeechMs: number; readonly minSilenceMs: number };
  /**
   * Wake word (P-81): VAD dedicata con la sua soglia. Sempre costruita se richiesta, anche con la
   * wake spenta: accenderla dalla UI non deve ricaricare il processo.
   */
  readonly wake?: { readonly sensitivity: number };
  /**
   * Carica Kokoro (P-103). `false` con la voce di Windows: il modello TTS non serve, non si carica e
   * la sua assenza non blocca l'ascolto.
   */
  readonly kokoro?: boolean;
  /** Lingua dello STT Whisper (multilingue): `it` o `en` (distribuzione mondiale, 10/10/2026). */
  readonly language?: 'it' | 'en';
}

const SPEAKERS = { if_sara: 35, im_nicola: 36 } as const;

type Role = 'vad' | 'stt' | 'tts' | 'speaker' | 'denoise';
interface ModelEntry { id: string; role: Role; dir: string; files: string[]; license: string; kind?: 'whisper' | 'nemo-transducer' }
const MODELS = manifest.models as ModelEntry[];

/** Modelli mancanti (id e file), dal manifest, per i ruoli indicati (tutti se omessi). Vuoto = tutto presente. */
export function missingModels(modelsDir: string, roles: readonly Role[] = ['vad', 'stt', 'tts']): string[] {
  const missing: string[] = [];
  // Un ruolo con più modelli (STT: whisper-small poi whisper-base, 17/10/2026) basta che ne abbia uno intero.
  for (const role of roles) {
    const candidates = MODELS.filter((x) => x.role === role);
    if (candidates.length === 0 || candidates.some((m) => complete(modelsDir, m))) continue;
    const first = candidates[0]!;
    missing.push(`${first.id} (${first.files.filter((f) => !existsSync(join(modelsDir, first.dir, f))).join(', ')})`);
  }
  return missing;
}

const complete = (modelsDir: string, m: (typeof MODELS)[number]): boolean => m.files.every((f) => existsSync(join(modelsDir, m.dir, f)));

/** Il primo modello intero del ruolo, nell'ordine del manifest (il migliore per primo). */
const model = (modelsDir: string, role: Role): { dir: string; id: string; files: readonly string[]; kind: 'whisper' | 'nemo-transducer' } => {
  const m = MODELS.find((x) => x.role === role && complete(modelsDir, x)) ?? MODELS.find((x) => x.role === role)!;
  return { dir: join(modelsDir, m.dir), id: m.id, files: m.files, kind: m.kind ?? 'whisper' };
};

const fileOf = (files: readonly string[], part: string): string => files.find((f) => f.includes(part))!;

// Superficie minima di sherpa-onnx-node usata qui (il pacchetto non ha dichiarazioni TypeScript).
interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  front(enableExternalBuffer?: boolean): { samples: Float32Array; start: number };
  pop(): void;
  flush(): void;
  reset(): void;
}
interface SherpaStream { acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void }
interface SherpaRecognizer { createStream(): SherpaStream; decodeAsync(s: SherpaStream): Promise<void>; getResult(s: SherpaStream): { text: string } }
interface SherpaTts {
  readonly sampleRate: number;
  generateAsync(o: { text: string; sid: number; speed: number; onProgress: (info: { samples: Float32Array; progress: number }) => number }): Promise<unknown>;
}
interface SherpaSpeakerStream { acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void }
interface SherpaSpeaker { createStream(): SherpaSpeakerStream; isReady(s: SherpaSpeakerStream): boolean; compute(s: SherpaSpeakerStream, enableExternalBuffer?: boolean): Float32Array }
interface SherpaDenoiser { run(o: { samples: Float32Array; sampleRate: number }): { samples: Float32Array; sampleRate: number } }
interface SherpaModule {
  Vad: new (config: unknown, bufferSeconds: number) => SherpaVad;
  SpeakerEmbeddingExtractor?: new (config: unknown) => SherpaSpeaker;
  OfflineSpeechDenoiser?: new (config: unknown) => SherpaDenoiser;
  readWave?: (file: string) => { samples: Float32Array; sampleRate: number };
  OfflineRecognizer: { createAsync(config: unknown): Promise<SherpaRecognizer> };
  OfflineTts: { createAsync(config: unknown): Promise<SherpaTts> };
  version: string;
}

export async function loadSherpa(): Promise<SherpaModule> {
  const mod = (await import('sherpa-onnx-node')) as unknown as SherpaModule & { default?: SherpaModule };
  return mod.default ?? mod;
}

export function createSherpaEngines(opts: SherpaOptions & { readonly kokoro?: true }, load?: () => Promise<SherpaModule>): Promise<VoiceEngines>;
export function createSherpaEngines(opts: SherpaOptions & { readonly kokoro: false }, load?: () => Promise<SherpaModule>): Promise<Omit<VoiceEngines, 'tts'>>;
export async function createSherpaEngines(opts: SherpaOptions, load: () => Promise<SherpaModule> = loadSherpa): Promise<Omit<VoiceEngines, 'tts'> & { tts?: TtsEngine }> {
  const withKokoro = opts.kokoro !== false;
  const missing = missingModels(opts.modelsDir, withKokoro ? ['vad', 'stt', 'tts'] : ['vad', 'stt']);
  if (missing.length > 0) throw new Error(`modelli voce mancanti in ${opts.modelsDir}: ${missing.join('; ')} (npm run voice:models)`);
  const sherpa = await load();

  const vadModel = model(opts.modelsDir, 'vad');
  const windowSize = 512;
  /** Una VAD Silero con la sua soglia (la wake ne ha una propria, P-81). */
  const makeVad = (threshold: number, label: string): VadEngine => {
    const native = new sherpa.Vad({
      sileroVad: {
        model: join(vadModel.dir, 'silero_vad.onnx'),
        threshold,
        minSpeechDuration: opts.vad.minSpeechMs / 1000,
        minSilenceDuration: opts.vad.minSilenceMs / 1000,
        maxSpeechDuration: 30,
        windowSize
      },
      sampleRate: VOICE_SAMPLE_RATE,
      numThreads: 1,
      provider: 'cpu',
      debug: false
    }, 60);
    return {
      name: `${label} (${vadModel.id})`,
      windowSize,
      accept: (w) => native.acceptWaveform(w),
      detected: () => native.isDetected(),
      flush: () => native.flush(),
      pop: (): SpeechSegment | null => {
        if (native.isEmpty()) return null;
        const seg = native.front(false);
        const out = { start: seg.start, samples: Float32Array.from(seg.samples) };
        native.pop();
        return out;
      },
      reset: () => native.reset()
    };
  };
  const vad = makeVad(opts.vad.threshold, 'silero');
  const wakeVad = opts.wake ? makeVad(opts.wake.sensitivity, 'silero wake') : null;

  const whisper = async (m: { dir: string; id: string; files: readonly string[]; kind?: 'whisper' | 'nemo-transducer' }): Promise<SttEngine> => {
    const common = { tokens: join(m.dir, fileOf(m.files, 'tokens')), numThreads: opts.threads, provider: 'cpu', debug: false };
    // Parakeet TDT v3 (NeMo, 24/10/2026): transducer multilingue europeo, la lingua la riconosce da sé. Non annota i
    // rumori («[Musica]») e non inventa i sottotitoli come Whisper sul silenzio.
    const recognizer = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
      modelConfig: m.kind === 'nemo-transducer'
        ? {
          transducer: {
            encoder: join(m.dir, fileOf(m.files, 'encoder')),
            decoder: join(m.dir, fileOf(m.files, 'decoder')),
            joiner: join(m.dir, fileOf(m.files, 'joiner'))
          },
          modelType: 'nemo_transducer',
          ...common
        }
        : {
          whisper: {
            encoder: join(m.dir, fileOf(m.files, 'encoder')),
            decoder: join(m.dir, fileOf(m.files, 'decoder')),
            language: opts.language ?? 'it',
            task: 'transcribe'
          },
          ...common
        }
    });
    return {
      name: `${m.kind === 'nemo-transducer' ? 'parakeet' : 'whisper'} (${m.id})`,
      ...(m.kind === 'nemo-transducer' ? { rawInput: true } : {}),
      transcribe: async (samples) => {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: VOICE_SAMPLE_RATE, samples });
        await recognizer.decodeAsync(stream);
        return recognizer.getResult(stream).text;
      }
    };
  };
  // 17/10/2026, misurato su 40 frasi: whisper-small sbaglia 11,6% delle parole (base 20,5%) ma impiega
  // 1,0 s invece di 0,38. Small per ciò che si dice; base, se c'è, per la parola d'avvio che gira su ogni rumore.
  // 24/10/2026, 100 frasi: Parakeet v3 97,2% di parole giuste (93,0% con rumore a 10 dB) in 0,37 s, contro il 91,5%
  // (80,6%) di whisper-small in 1,8 s: primo nel manifest, quindi scelto quando c'è; la parola d'avvio resta a base.
  const sttModel = model(opts.modelsDir, 'stt');
  const stt = await whisper(sttModel);
  const baseModel = MODELS.find((x) => x.id === 'whisper-base');
  const wakeStt = wakeVad && baseModel && baseModel.id !== sttModel.id && complete(opts.modelsDir, baseModel)
    ? await whisper({ dir: join(opts.modelsDir, baseModel.dir), id: baseModel.id, files: baseModel.files })
    : undefined;
  const listening = { vad, stt, ...(wakeVad ? { wakeVad } : {}), ...(wakeStt ? { wakeStt } : {}) };

  if (!withKokoro) return listening;

  const ttsModel = model(opts.modelsDir, 'tts');
  const engine = await sherpa.OfflineTts.createAsync({
    model: {
      kokoro: {
        model: join(ttsModel.dir, 'model.onnx'),
        voices: join(ttsModel.dir, 'voices.bin'),
        tokens: join(ttsModel.dir, 'tokens.txt'),
        dataDir: join(ttsModel.dir, 'espeak-ng-data'),
        lang: 'it'
      },
      numThreads: opts.threads,
      provider: 'cpu',
      debug: false
    },
    // Una frase per blocco: la riproduzione inizia dopo la prima frase.
    maxNumSentences: 1
  });
  const sid = SPEAKERS[opts.speaker];
  const tts: TtsEngine = {
    name: `kokoro ${opts.speaker} (${ttsModel.id})`,
    synthesize: async (text, onChunk) => {
      await engine.generateAsync({ text, sid, speed: 1, onProgress: (info) => (onChunk({ kind: 'pcm', samples: info.samples, sampleRate: engine.sampleRate }) ? 1 : 0) });
      // Coda di silenzio (Fase 24): senza, il dispositivo taglia l'ultimo fonema («chiusura a
      // freddo»). 220 ms bastano a far finire l'audio in modo naturale.
      const tailMs = 220;
      onChunk({ kind: 'pcm', samples: new Float32Array(Math.round((engine.sampleRate * tailMs) / 1000)), sampleRate: engine.sampleRate });
    }
  };
  return { ...listening, tts };
}

/**
 * Filtri dell'ascolto (P-106): impronta vocale (ERes2Net, Apache-2.0) e pulizia del rumore (GTCRN, MIT),
 * solo se i modelli sono stati scaricati. Ognuno è facoltativo: senza, il filtro resta spento.
 * La DLL sherpa-onnx senza sintesi dell'installer li esporta (verificato il 10/10/2026).
 */
export async function createSherpaFilters(modelsDir: string, threads: number, load: () => Promise<SherpaModule> = loadSherpa): Promise<{
  speaker: SpeakerEngine | null; speakerModel: string | null; denoise: DenoiseEngine | null; readWave: ((file: string) => { samples: Float32Array; sampleRate: number }) | null;
}> {
  const sherpa = await load();
  let speaker: SpeakerEngine | null = null;
  let speakerModel: string | null = null;
  let denoise: DenoiseEngine | null = null;
  if (missingModels(modelsDir, ['speaker']).length === 0 && sherpa.SpeakerEmbeddingExtractor) {
    const m = model(modelsDir, 'speaker');
    const file = MODELS.find((x) => x.role === 'speaker')!.files[0]!;
    const native = new sherpa.SpeakerEmbeddingExtractor({ model: join(m.dir, file), numThreads: Math.max(1, Math.min(threads, 4)), debug: false, provider: 'cpu' });
    speakerModel = m.id;
    speaker = {
      name: `impronta (${m.id})`,
      embed: (samples) => {
        const s = native.createStream();
        s.acceptWaveform({ sampleRate: VOICE_SAMPLE_RATE, samples });
        s.inputFinished();
        if (!native.isReady(s)) throw new Error('segmento troppo corto per l\'impronta');
        return Float32Array.from(native.compute(s, false));
      }
    };
  }
  if (missingModels(modelsDir, ['denoise']).length === 0 && sherpa.OfflineSpeechDenoiser) {
    const m = model(modelsDir, 'denoise');
    const file = MODELS.find((x) => x.role === 'denoise')!.files[0]!;
    const native = new sherpa.OfflineSpeechDenoiser({ model: { gtcrn: { model: join(m.dir, file) }, numThreads: 1, debug: false, provider: 'cpu' } });
    denoise = {
      name: `pulizia (${m.id})`,
      run: (samples) => {
        const out = native.run({ samples, sampleRate: VOICE_SAMPLE_RATE });
        return out.sampleRate === VOICE_SAMPLE_RATE && out.samples.length > 0 ? Float32Array.from(out.samples) : samples;
      }
    };
  }
  return { speaker, speakerModel, denoise, readWave: sherpa.readWave ?? null };
}
