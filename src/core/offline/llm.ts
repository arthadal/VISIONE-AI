// Modello locale della modalità offline (17/10/2026): Qwen3.5 in ONNX (formato della comunità ONNX:
// `embed_tokens` + `decoder_model_merged`, pesi a 4 bit), eseguito con onnxruntime-node — la stessa libreria
// della voce VISIONE. Strati misti: attenzione piena (cache chiave/valore) e attenzione lineare (stato di
// convoluzione e ricorrente). Le istruzioni e gli esempi si leggono UNA volta al caricamento e il loro stato
// si riusa per ogni richiesta: misurato su questo PC, 13-17 s una volta sola invece che a ogni frase.
// Generazione greedy, una riga sola (al primo a capo ci si ferma), al più 40 token. Nell'app gira nel suo
// filo di lavoro (`worker.ts`, `worker-model.ts`): il caricamento dei pesi è sincrono e fermerebbe il core.
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { Language } from '../../shared/contracts/index.ts';
import { chatPrefix, chatTurn } from './prompt.ts';

export interface LocalModel {
  /** Carica pesi e istruzioni (decine di secondi la prima volta); idempotente. */
  load(): Promise<void>;
  /** Riscrive una frase nella forma che l'Assistente capisce (la prima riga della risposta). */
  rewrite(text: string): Promise<string>;
  /** Libera la memoria (si torna online). */
  release(): Promise<void>;
  loaded(): boolean;
}

interface Tensor { readonly data: Float32Array; readonly dims: readonly number[] }
interface Session {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>>;
  release(): Promise<void>;
}
interface Ort {
  InferenceSession: { create(path: string, opts: Record<string, unknown>): Promise<Session> };
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => unknown;
}
interface Tokenizer {
  encode(text: string, opts: { add_special_tokens: boolean }): { ids: number[] };
  decode(ids: number[], opts: { skip_special_tokens: boolean }): string;
}

interface TextConfig {
  layer_types: string[];
  num_key_value_heads: number;
  head_dim: number;
  linear_num_key_heads: number;
  linear_key_head_dim: number;
  linear_num_value_heads: number;
  linear_value_head_dim: number;
  linear_conv_kernel_dim: number;
  eos_token_id?: number | number[];
}

type Cache = { past: Record<string, unknown>; total: number };

const MAX_NEW_TOKENS = 40;

export const LOCAL_MODEL_FILES = {
  embed: join('onnx', 'embed_tokens_q4.onnx'),
  decoder: join('onnx', 'decoder_model_merged_q4.onnx')
} as const;

export function createLocalModel(opts: { dir: string; language: () => Language; threads?: number }): LocalModel {
  // Misurato su un Core Ultra 5 (18 fili): 4 fili 6,0 s a risposta, 8 fili 4,2 s, 12 fili 4,0 s.
  const threads = opts.threads ?? Math.max(2, Math.min(12, Math.round((availableParallelism() * 2) / 3)));
  let state: {
    ort: Ort; tok: Tokenizer; embed: Session; decoder: Session; cfg: TextConfig; eos: Set<number>;
    prefix: { lang: Language; text: string; cache: Cache } | null;
  } | null = null;
  let loading: Promise<void> | null = null;
  // Una richiesta alla volta: il modello usa già tutti i fili che gli si danno.
  let queue: Promise<unknown> = Promise.resolve();

  const emptyCache = (ort: Ort, c: TextConfig): Cache => {
    const past: Record<string, unknown> = {};
    const convDim = c.linear_num_key_heads * c.linear_key_head_dim * 2 + c.linear_num_value_heads * c.linear_value_head_dim;
    const convLen = c.linear_conv_kernel_dim - 1;
    const rec = [1, c.linear_num_value_heads, c.linear_key_head_dim, c.linear_value_head_dim] as const;
    c.layer_types.forEach((type, l) => {
      if (type === 'full_attention') {
        past[`past_key_values.${l}.key`] = new ort.Tensor('float32', new Float32Array(0), [1, c.num_key_value_heads, 0, c.head_dim]);
        past[`past_key_values.${l}.value`] = new ort.Tensor('float32', new Float32Array(0), [1, c.num_key_value_heads, 0, c.head_dim]);
      } else {
        past[`past_conv.${l}`] = new ort.Tensor('float32', new Float32Array(convDim * convLen), [1, convDim, convLen]);
        past[`past_recurrent.${l}`] = new ort.Tensor('float32', new Float32Array(rec[1] * rec[2] * rec[3]), rec);
      }
    });
    return { past, total: 0 };
  };

  /** Legge `input` sopra la cache: il token più probabile dopo l'ultimo, e la cache nuova. */
  const step = async (cache: Cache, input: readonly number[]): Promise<{ next: number; cache: Cache }> => {
    const s = state!;
    const { ort, cfg } = s;
    const n = input.length;
    const embedded = await s.embed.run({ [s.embed.inputNames[0]!]: new ort.Tensor('int64', BigInt64Array.from(input, (x) => BigInt(x)), [1, n]) });
    const feeds: Record<string, unknown> = { ...cache.past };
    feeds.inputs_embeds = embedded[s.embed.outputNames[0]!];
    feeds.attention_mask = new ort.Tensor('int64', new BigInt64Array(cache.total + n).fill(1n), [1, cache.total + n]);
    // Posizioni a tre righe (testo, altezza, larghezza dell'immagine): per il solo testo sono uguali.
    feeds.position_ids = new ort.Tensor('int64', BigInt64Array.from({ length: 3 * n }, (_, i) => BigInt(cache.total + (i % n))), [3, 1, n]);
    if (s.decoder.inputNames.includes('num_logits_to_keep')) feeds.num_logits_to_keep = new ort.Tensor('int64', BigInt64Array.from([1n]), []);
    const res = await s.decoder.run(feeds);
    const logits = res.logits!;
    const vocab = logits.dims[2]!;
    const off = (logits.dims[1]! - 1) * vocab;
    let next = 0;
    let best = -Infinity;
    for (let v = 0; v < vocab; v++) {
      const x = logits.data[off + v]!;
      if (x > best) { best = x; next = v; }
    }
    const past: Record<string, unknown> = {};
    cfg.layer_types.forEach((type, l) => {
      if (type === 'full_attention') {
        past[`past_key_values.${l}.key`] = res[`present.${l}.key`];
        past[`past_key_values.${l}.value`] = res[`present.${l}.value`];
      } else {
        past[`past_conv.${l}`] = res[`present_conv.${l}`];
        past[`past_recurrent.${l}`] = res[`present_recurrent.${l}`];
      }
    });
    return { next, cache: { past, total: cache.total + n } };
  };

  const prefixFor = async (lang: Language): Promise<{ text: string; cache: Cache }> => {
    const s = state!;
    if (s.prefix?.lang === lang) return s.prefix;
    const text = chatPrefix(lang);
    const ids = s.tok.encode(text, { add_special_tokens: false }).ids;
    const { cache } = await step(emptyCache(s.ort, s.cfg), ids);
    s.prefix = { lang, text, cache };
    return s.prefix;
  };

  const load = (): Promise<void> => {
    if (state) return Promise.resolve();
    loading ??= (async () => {
      // Caricati solo quando servono: chi non usa mai la modalità offline non paga niente.
      const ort = (await import('onnxruntime-node')) as unknown as Ort;
      const { Tokenizer: Tok } = (await import('@huggingface/tokenizers')) as unknown as { Tokenizer: new (json: unknown, cfg: unknown) => Tokenizer };
      const read = (f: string): unknown => JSON.parse(readFileSync(join(opts.dir, f), 'utf8'));
      const config = read('config.json') as { text_config?: TextConfig; eos_token_id?: number | number[] } & TextConfig;
      const cfg = config.text_config ?? config;
      const tok = new Tok(read('tokenizer.json'), read('tokenizer_config.json'));
      const sessionOpts = { intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all', executionMode: 'sequential' };
      const embed = await ort.InferenceSession.create(join(opts.dir, LOCAL_MODEL_FILES.embed), sessionOpts);
      const decoder = await ort.InferenceSession.create(join(opts.dir, LOCAL_MODEL_FILES.decoder), sessionOpts);
      const eos = new Set<number>([config.eos_token_id ?? cfg.eos_token_id ?? []].flat());
      state = { ort, tok, embed, decoder, cfg, eos, prefix: null };
      try {
        await prefixFor(opts.language());
      } catch (err) {
        await release();
        throw err;
      }
    })().finally(() => { loading = null; });
    return loading;
  };

  const release = async (): Promise<void> => {
    const s = state;
    state = null;
    if (!s) return;
    await Promise.allSettled([s.embed.release(), s.decoder.release()]);
  };

  return {
    load,
    loaded: () => state !== null,
    release: () => {
      const out = queue.then(release, release);
      queue = out.catch(() => undefined);
      return out;
    },
    rewrite(text) {
      const run = async (): Promise<string> => {
        await load();
        const s = state;
        if (!s) throw new Error('modello locale non caricato');
        const prefix = await prefixFor(opts.language());
        const full = prefix.text + chatTurn(text);
        const ids = s.tok.encode(full.slice(prefix.text.length), { add_special_tokens: false }).ids;
        let r = await step(prefix.cache, ids);
        const out: number[] = [];
        for (let i = 0; i < MAX_NEW_TOKENS; i++) {
          if (s.eos.has(r.next)) break;
          out.push(r.next);
          if (s.tok.decode(out, { skip_special_tokens: true }).trimStart().includes('\n')) break;
          r = await step(r.cache, [r.next]);
        }
        return s.tok.decode(out, { skip_special_tokens: true }).trim().split('\n')[0] ?? '';
      };
      const out = queue.then(run, run);
      queue = out.catch(() => undefined);
      return out;
    }
  };
}
