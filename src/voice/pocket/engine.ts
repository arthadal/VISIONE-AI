// Voce VISIONE (P-110): il baritono scelto dal proprietario (timbro progettato con VoxCPM2, nessuna persona
// reale) fatto parlare da Pocket TTS (Kyutai, pesi CC-BY-4.0) con onnxruntime-node, più l'effetto «stile
// JARVIS». Tutto incluso nell'installer: nessun download, nessuna rete. È il ciclo del wrapper ONNX di
// Pocket TTS riscritto in TypeScript: per ogni frase il modello di linguaggio produce un fotogramma
// latente alla volta (80 ms), il «flow» lo campiona, il decoder Mimi lo trasforma in audio a 24 kHz.
// Il decoder lavora a blocchi mentre il modello continua a generare, così la prima parola arriva presto.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TtsChunk, TtsEngine } from '../engines.ts';
import { createJarvisEffect } from './effect.ts';
import { normalizeForSpeech } from './normalize.ts';
import { prepareText, splitSentences } from './text.ts';
import { createTokenizer, type TokenizerFile } from './tokenizer.ts';

/** Il minimo di onnxruntime-node che serve qui (iniettato: i test usano un finto). */
export interface OrtTensor {
  readonly data: unknown;
  readonly dims: readonly number[];
}
export interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}
export interface OrtModule {
  InferenceSession: { create(path: string, options?: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => OrtTensor;
}

interface StateEntry {
  readonly input_name: string;
  readonly output_name: string;
  readonly shape: readonly number[];
  readonly dtype: 'float32' | 'int64' | 'bool';
  readonly fill: 'nan' | 'zeros' | 'ones' | 'empty';
}
interface Bundle {
  readonly sample_rate: number;
  readonly frame_rate: number;
  readonly latent_dim: number;
  readonly conditioning_dim: number;
  readonly max_token_per_chunk: number;
  readonly flow_lm_state_manifest: readonly StateEntry[];
  readonly mimi_state_manifest: readonly StateEntry[];
}
type State = Record<string, OrtTensor>;

export interface PocketOptions {
  /** Cartella con modelli, tokenizer e impronta (`vendor/voce-visione/it`, nel pacchetto `resources/`). */
  readonly dir: string;
  readonly ort: OrtModule;
  /** Thread per modello (il wrapper originale ne usa al massimo 4). */
  readonly threads?: number;
  /** Varietà dell'intonazione: 0,5 (misurato: con lo 0,7 del modello Whisper sbaglia il 26% delle parole, con 0,5 il 14%). */
  readonly temperature?: number;
  /** Effetto «stile JARVIS» (P-110) e il suo guadagno fisso. */
  readonly effect?: boolean;
  readonly gain?: number;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** Come è andata l'ultima frase: durata, tempo speso, prima parola, buchi e costi stimati di un fotogramma. */
export interface PocketStats {
  readonly audioS: number;
  readonly spentMs: number;
  readonly firstMs: number;
  readonly gaps: number;
  readonly gapMs: number;
  readonly frameMs: number;
  readonly decoderMs: number;
}

export interface PocketTts extends TtsEngine {
  /** Carica i modelli e prepara la voce: la prima frase non paga l'avvio. */
  warmup(): Promise<void>;
  release(): Promise<void>;
  stats(): PocketStats | null;
}

/** File che devono esserci perché la voce VISIONE parli (il resto del bundle non serve). */
export const POCKET_FILES = ['bundle.json', 'tokenizer.json', 'voce.json', 'voce.f32', 'flow_lm_main_int8.onnx', 'flow_lm_flow_int8.onnx', 'mimi_decoder_int8.onnx', 'text_conditioner.onnx'] as const;

/** Soglia del wrapper: oltre, il modello ha deciso che la frase è finita. */
const EOS_THRESHOLD = -4;
const TOKENS_PER_SECOND = 3;
const PADDING_SECONDS = 2;
/** Parlato reale: ~3,5 token al secondo (misurato sulle frasi di prova). Serve a stimare quanto durerà il testo. */
const SPOKEN_TOKENS_PER_SECOND = 3.5;
/**
 * Riproduzione senza buchi (15/10/2026: con lo `stream` del wrapper, margine 0,2 s e blocchi da 1-3
 * fotogrammi, la voce andava a scatti dentro VISIONE: l'audio passa a un altro processo e ogni chiamata
 * di onnxruntime-node ferma il processo voce). Si parte con l'audio che copre un blocco da `CHUNK`, di più se
 * il PC genera più lento di quanto si parla; poi si decodifica a blocchi da `CHUNK` o subito se il margine
 * scende sotto `LOW_BUFFER_S`. Se l'audio finisce lo stesso (PC rallentato, come all'avvio dell'app) si
 * riaccumula come all'inizio: una pausa sola invece di decine di scatti (16/10/2026, misurato a batteria).
 */
const MARGIN_FRAMES = 3;
const LOW_BUFFER_S = 0.4;
const CHUNK = 12;
/** Riserva sulla stima dei fotogrammi da generare (dai token: sulle prove era corta fino al 7%). */
const RESERVE = 1.15;
/** Tetto della riserva contro i rallentamenti: oltre, la prima parola tarda troppo. */
const MAX_CUSHION_MS = 1_500;

export function createPocketTts(opts: PocketOptions): PocketTts {
  const { ort } = opts;
  const now = opts.now ?? (() => performance.now());
  const random = opts.random ?? Math.random;
  const temperature = opts.temperature ?? 0.5;
  const bundle = JSON.parse(readFileSync(join(opts.dir, 'bundle.json'), 'utf8')) as Bundle;
  const tok = createTokenizer(JSON.parse(readFileSync(join(opts.dir, 'tokenizer.json'), 'utf8')) as TokenizerFile);
  const sr = bundle.sample_rate;
  const frameS = 1 / bundle.frame_rate;
  const dim = bundle.latent_dim;
  const sessionOptions = { intraOpNumThreads: opts.threads ?? 4, interOpNumThreads: 1, graphOptimizationLevel: 'all', executionMode: 'sequential' };

  const tensor = (type: string, data: unknown, dims: readonly number[]): OrtTensor => new ort.Tensor(type, data, dims);
  const initState = (manifest: readonly StateEntry[]): State => {
    const state: State = {};
    for (const e of manifest) {
      const size = e.shape.reduce((a, b) => a * b, 1);
      if (e.dtype === 'int64') state[e.input_name] = tensor('int64', new BigInt64Array(size), e.shape);
      else if (e.dtype === 'bool') state[e.input_name] = tensor('bool', new Uint8Array(size).fill(e.fill === 'ones' ? 1 : 0), e.shape);
      else state[e.input_name] = tensor('float32', new Float32Array(size).fill(e.fill === 'nan' ? NaN : e.fill === 'ones' ? 1 : 0), e.shape);
    }
    return state;
  };
  const advance = (state: State, out: Record<string, OrtTensor>, manifest: readonly StateEntry[]): State => {
    const next: State = { ...state };
    for (const e of manifest) {
      const t = out[e.output_name];
      if (!t) throw new Error(`voce VISIONE: uscita ${e.output_name} assente`);
      next[e.input_name] = t;
    }
    return next;
  };
  /** Rumore gaussiano (Box–Muller) con deviazione √temperatura: è ciò che rende viva l'intonazione. */
  const noise = (temp = temperature): Float32Array => {
    const x = new Float32Array(dim);
    const std = Math.sqrt(temp);
    for (let i = 0; i < dim; i += 2) {
      const r = Math.sqrt(-2 * Math.log(1 - random())) * std;
      const a = 2 * Math.PI * random();
      x[i] = r * Math.cos(a);
      if (i + 1 < dim) x[i + 1] = r * Math.sin(a);
    }
    return x;
  };

  let loading: Promise<{ main: OrtSession; flow: OrtSession; decoder: OrtSession; conditioner: OrtSession; base: State }> | null = null;
  const load = (): NonNullable<typeof loading> =>
    (loading ??= (async () => {
      const t0 = now();
      const open = (file: string): Promise<OrtSession> => ort.InferenceSession.create(join(opts.dir, file), sessionOptions);
      const [main, flow, decoder, conditioner] = await Promise.all([open('flow_lm_main_int8.onnx'), open('flow_lm_flow_int8.onnx'), open('mimi_decoder_int8.onnx'), open('text_conditioner.onnx')]);
      // La voce: l'impronta precalcolata (bos già davanti) fa da «prompt» e lascia lo stato di partenza.
      const meta = JSON.parse(readFileSync(join(opts.dir, 'voce.json'), 'utf8')) as { shape: number[] };
      const raw = readFileSync(join(opts.dir, 'voce.f32'));
      const voice = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      if (voice.length !== meta.shape.reduce((a, b) => a * b, 1)) throw new Error('voce VISIONE: impronta della voce di dimensione inattesa');
      const out = await main.run({ sequence: tensor('float32', new Float32Array(0), [1, 0, dim]), text_embeddings: tensor('float32', voice, meta.shape), ...initState(bundle.flow_lm_state_manifest) });
      const base = advance({}, out, bundle.flow_lm_state_manifest);
      opts.log?.(`voce VISIONE pronta in ${Math.round(now() - t0)} ms`);
      return { main, flow, decoder, conditioner, base };
    })());

  // Costo misurato di un fotogramma (modello + flow) e della sua decodifica, in ms: si parte prudenti e
  // si impara frase dopo frase. Dicono se questo PC genera più in fretta di quanto si parla (80 ms a fotogramma).
  let genMs = 60;
  let decMs = 8;
  /** Costo d'avvio di ogni frase del testo (testo nel modello), durante il quale non si genera audio. */
  let blockMs = 150;
  /**
   * Costo di un fotogramma che modello e decoder non dicono (effetto, invio dell'audio, pulizia della memoria):
   * tempo vero della frase meno la stima, imparato frase dopo frase (16/10/2026 a batteria: 8 ms su 87).
   */
  let extraMs = 0;
  /**
   * Riserva contro i rallentamenti improvvisi che nessuna stima vede (16/10/2026 a batteria: il fotogramma
   * passava da 34 a 80 ms nella stessa prova): cresce con i buchi sentiti, cala con le frasi pulite.
   * Parte da mezzo secondo (la prima frase è il saluto, all avvio, col PC più carico) e su un PC stabile
   * scende verso zero.
   */
  let cushionMs = 500;
  const ema = (old: number, v: number): number => old * 0.8 + v * 0.2;
  let lastStats: PocketStats | null = null;

  const synthesize = async (text: string, onChunk: (chunk: TtsChunk) => boolean): Promise<void> => {
    // Cifre, sigle, simboli e due punti in parole e pause (normalize.ts): il modello legge solo parole.
    const spoken = normalizeForSpeech(text);
    if (!/[\p{L}\d]/u.test(spoken)) return; // solo emoji o simboli: niente da dire, e non è un guasto
    const m = await load();
    const t0 = now();
    // Guadagno 0,7: livello allineato alla voce di Windows (misurato: a 1 picchi −0,3 dB e media −22 dB,
    // Windows −5,5 e −24), perché il volume di VISIONE (250% di serie) e il limitatore sono tarati su quella.
    const fx = opts.effect === false ? null : createJarvisEffect(sr, opts.gain ?? 0.7);
    const blocks = splitSentences(tok, spoken, bundle.max_token_per_chunk).map((c) => {
      const p = prepareText(c);
      return { ids: tok.encode(p.text), framesAfterEos: p.framesAfterEos };
    });
    /** Fotogrammi di parlato stimati dal numero di token. */
    const estimate = (tokens: number): number => (tokens / SPOKEN_TOKENS_PER_SECOND) * bundle.frame_rate;
    /** Fotogrammi stimati dei blocchi non ancora iniziati. */
    let later = blocks.reduce((s, b) => s + estimate(b.ids.length), 0);
    let alive = true;
    let first = -1;
    let samples = 0;
    // Orologio della riproduzione, su tutto il testo: quando finisce l'audio già consegnato e quanto ne è in
    // decodifica. Un blocco consegnato dopo la fine del precedente è un buco che si sente: si conta e si dichiara.
    let audioEnd = -1;
    let decodingS = 0;
    /** Nessun audio che suona: si accumula prima di (ri)partire. */
    let starving = true;
    let gaps = 0;
    let gapMs = 0;
    /** Tempo speso nel decoder: blocca il processo mentre un passo attende, e non va contato nel passo. */
    let decBusyMs = 0;
    const emit = (pcm: Float32Array): void => {
      if (!alive || pcm.length === 0) return;
      const t = now();
      if (audioEnd < 0) {
        first = t - t0;
        audioEnd = t;
      }
      const late = t - audioEnd;
      if (late > 1) {
        gaps++;
        gapMs += late;
      }
      audioEnd = Math.max(audioEnd, t) + (pcm.length / sr) * 1000;
      samples += pcm.length;
      if (!onChunk({ kind: 'pcm', samples: fx ? fx.process(pcm) : pcm, sampleRate: sr })) alive = false;
    };
    const emptyText = tensor('float32', new Float32Array(0), [1, 0, bundle.conditioning_dim]);
    for (const [index, { ids, framesAfterEos }] of blocks.entries()) {
      if (!alive) break;
      later -= estimate(ids.length);
      const blocksAhead = blocks.length - 1 - index;
      const tb = now();
      const cond = await m.conditioner.run({ token_ids: tensor('int64', BigInt64Array.from(ids, (i) => BigInt(i)), [1, ids.length]) });
      let state = advance(m.base, await m.main.run({ sequence: tensor('float32', new Float32Array(0), [1, 0, dim]), text_embeddings: cond.embeddings!, ...m.base }), bundle.flow_lm_state_manifest);
      blockMs = ema(blockMs, now() - tb);
      // Decoder Mimi: stato proprio per frase, blocchi in coda (una promessa dopo l'altra, in ordine).
      let mimi = initState(bundle.mimi_state_manifest);
      let decoding: Promise<void> = Promise.resolve();
      const decode = (frames: Float32Array[]): void => {
        const latent = new Float32Array(frames.length * dim);
        frames.forEach((f, i) => latent.set(f, i * dim));
        decodingS += frames.length * frameS;
        decoding = decoding.then(async () => {
          if (!alive) return;
          const t = now();
          const out = await m.decoder.run({ latent: tensor('float32', latent, [1, frames.length, dim]), ...mimi });
          decBusyMs += now() - t;
          decMs = ema(decMs, (now() - t) / frames.length);
          mimi = advance(mimi, out, bundle.mimi_state_manifest);
          decodingS -= frames.length * frameS;
          emit(out.audio_frame!.data as Float32Array);
        });
      };
      const latents: Float32Array[] = [];
      let queued = 0;
      let curr = tensor('float32', new Float32Array(dim).fill(NaN), [1, 1, dim]);
      let eos = -1;
      const limit = Math.ceil((ids.length / TOKENS_PER_SECOND + PADDING_SECONDS) * bundle.frame_rate);
      const loop = now();
      for (let step = 0; step < limit && alive; step++) {
        const t = now();
        const busy = decBusyMs;
        const out = await m.main.run({ sequence: curr, text_embeddings: emptyText, ...state });
        state = advance(state, out, bundle.flow_lm_state_manifest);
        if (eos < 0 && (out.eos_logit!.data as Float32Array)[0]! > EOS_THRESHOLD) eos = step;
        if (eos >= 0 && step >= eos + framesAfterEos) break;
        const x = noise();
        // Un passo di «flow» da s=0 a t=1, come il wrapper (provati 4 passi il 15/10/2026: nessun guadagno).
        const flow = await m.flow.run({ c: out.conditioning!, s: tensor('float32', new Float32Array([0]), [1, 1]), t: tensor('float32', new Float32Array([1]), [1, 1]), x: tensor('float32', x.slice(), [1, dim]) });
        const dir = flow.flow_dir!.data as Float32Array;
        for (let i = 0; i < dim; i++) x[i]! += dir[i]!;
        latents.push(x);
        curr = tensor('float32', x, [1, 1, dim]);
        // Senza il decoder che ha girato nel frattempo (16/10/2026: contato due volte, un PC che ce la faceva
        // sembrava lento e la voce si fermava a riaccumulare senza motivo).
        genMs = ema(genMs, now() - t - (decBusyMs - busy));
        // Fotogrammi che restano: dopo la fine segnalata dal modello si sanno esatti; prima si stimano dai
        // token, con almeno un secondo di riserva perché la stima può essere corta.
        const left = eos >= 0 ? eos + framesAfterEos - step - 1 : Math.max(estimate(ids.length) - step - 1, bundle.frame_rate);
        const remaining = Math.max(0, left) + later;
        // Fotogrammi di audio pronto che mancano perché la generazione del resto (stimato con la riserva, più
        // l'avvio delle frasi che seguono) non resti indietro rispetto a quanto dura. 0 = questo PC ce la fa.
        const frameMs = frameS * 1000;
        const costMs = genMs + decMs + extraMs;
        const deficit = Math.max(0, Math.ceil((remaining * RESERVE * (costMs - frameMs) + blocksAhead * blockMs) / frameMs));
        const pending = latents.length - queued;
        const buffer = decodingS + (audioEnd < 0 ? 0 : Math.max(0, (audioEnd - now()) / 1000));
        // Audio in coda finito (PC più lento della stima, come all'avvio dell'app): si riaccumula come
        // all'inizio invece di decodificare un fotogramma alla volta, il modo più costoso. Una pausa sola.
        // Lo stesso se il margine si assottiglia su un PC che non ce la fa: a pezzetti il buco arriva
        // comunque, e ne arrivano tanti.
        if (audioEnd >= 0 && (buffer <= 0 || (deficit > 0 && buffer < LOW_BUFFER_S))) starving = true;
        let size = 0;
        if (starving) {
          // Si parte con abbastanza audio da coprire generazione e decodifica del prossimo blocco di CHUNK
          // fotogrammi (si decodifica a blocchi: con 3 fotogrammi, a batteria, la voce si fermava dopo mezzo
          // secondo), più quello che manca se il PC non ce la fa.
          const need = Math.max(MARGIN_FRAMES, Math.ceil((CHUNK * costMs) / frameMs)) + Math.ceil(cushionMs / frameMs) + deficit;
          if (pending >= need) {
            size = Math.min(pending, Math.max(MARGIN_FRAMES, Math.min(need, CHUNK)));
            starving = false;
          }
        } else if (buffer < LOW_BUFFER_S) size = Math.min(pending, CHUNK);
        else if (pending >= CHUNK) size = CHUNK;
        if (size > 0) {
          decode(latents.slice(queued, queued + size));
          queued += size;
        }
      }
      if (alive && queued < latents.length) decode(latents.slice(queued));
      await decoding;
      if (alive && latents.length >= CHUNK) extraMs = Math.max(0, ema(extraMs, (now() - loop) / latents.length - (genMs + decMs)));
    }
    if (alive) cushionMs = gaps > 0 ? Math.min(MAX_CUSHION_MS, cushionMs + gapMs + 100) : cushionMs * 0.8;
    const spent = now() - t0;
    lastStats = { audioS: samples / sr, spentMs: spent, firstMs: first, gaps, gapMs, frameMs: genMs, decoderMs: decMs };
    if (samples > 0) opts.log?.(`voce VISIONE: ${(samples / sr).toFixed(1)} s di audio in ${Math.round(spent)} ms (RTF ${(spent / 1000 / (samples / sr)).toFixed(2)}, prima parola ${Math.round(first)} ms, buchi ${gaps}${gaps ? ` per ${Math.round(gapMs)} ms` : ''}; fotogramma ${Math.round(genMs)} ms + decoder ${Math.round(decMs)} ms + altro ${Math.round(extraMs)} ms)`);
  };

  return {
    name: 'VISIONE (Pocket TTS)',
    synthesize,
    stats: () => lastStats,
    warmup: async () => {
      await load();
    },
    release: async () => {
      if (!loading) return;
      const m = await loading.catch(() => null);
      loading = null;
      if (m) await Promise.all([m.main, m.flow, m.decoder, m.conditioner].map((s) => s.release?.()));
    }
  };
}
