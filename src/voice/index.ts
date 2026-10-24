// Punto d'ingresso del processo voce (utilityProcess avviato dal main, VISIONE_ARCHITECTURE §2, §28).
// Separato perché nativo, pesante e opzionale: se cade, il core continua senza voce. Nessuna rete:
// i modelli sono locali; nessun import di `electron` (il parentPort arriva da `process`).
import { ulid } from '../shared/lib/ulid.ts';
import type { VoiceToMain } from '../shared/contracts/index.ts';
import { createTtsForProvider } from './edge.ts';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { to16k } from './filters.ts';
import { createSherpaEngines, createSherpaFilters, missingModels } from './sherpa.ts';
import type { SttEngine, VadEngine } from './engines.ts';
import { createWindowsTts, type WindowsTts } from './windows-tts.ts';
import { createVoiceService, type AudioPort, type BenchmarkResult } from './service.ts';
import { bestOf } from './benchmark.ts';
import { createPocketTts, POCKET_FILES, type OrtModule } from './pocket/engine.ts';

interface PortMain {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  on(event: 'close', listener: () => void): void;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}
interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown; ports?: PortMain[] }) => void): void;
  postMessage(message: unknown): void;
}

// Voce VISIONE (P-110): onnxruntime-node va caricato PRIMA di sherpa-onnx. Le due librerie portano due
// onnxruntime.dll diverse (1.30 e 1.28): se la prima caricata è quella di sherpa, onnxruntime-node fallisce
// («error: 182», misurato il 15/10/2026); nell'altro ordine funzionano entrambe. Sherpa si carica solo in
// `createEngines`, che aspetta questa promessa.
const ortReady: Promise<OrtModule | null> = import('onnxruntime-node').then(
  (m) => ((m as { default?: unknown }).default ?? m) as unknown as OrtModule,
  (err: unknown) => {
    process.stderr.write(`VISIONE voce: onnxruntime-node non caricato (${err instanceof Error ? err.message : String(err)})
`);
    return null;
  }
);

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  process.stderr.write('VISIONE voce: va avviata dal main (utilityProcess)\n');
  process.exit(2);
}

const wrap = (p: PortMain): AudioPort => {
  p.start();
  return {
    post: (msg) => p.postMessage(msg),
    onMessage: (handler) => p.on('message', (e) => handler(e.data)),
    close: () => p.close()
  };
};

const log = (line: string): void => {
  process.stderr.write(`VISIONE voce: ${line}\n`);
};

/** Ascolto spento: nessun parlato rilevato, nessuna trascrizione; i nomi dicono perché. */
function silentListening(absent: readonly string[], language: 'it' | 'en' = 'it'): { vad: VadEngine; stt: SttEngine } {
  log(`ascolto non disponibile: modelli mancanti (${absent.join('; ')})`);
  // Il nome si mostra nella linguetta Voce: nella lingua di VISIONE (P-108).
  const name = language === 'en' ? 'listening off: models to download' : 'ascolto spento: modelli da scaricare';
  return {
    vad: { name, windowSize: 512, accept: () => undefined, detected: () => false, flush: () => undefined, pop: () => null, reset: () => undefined },
    stt: { name, transcribe: async () => '' }
  };
}

/**
 * Filtri dell'ascolto (P-106) se i modelli sono scaricati; le registrazioni di prova del modello d'ascolto
 * (parlato umano reale, LibriSpeech) fanno da voci di riferimento per il margine.
 */
/**
 * Thread dei motori della voce: al più i core meno uno. Collaudo su un PC vergine (VM a 4 core, 17/10/2026):
 * la sintesi su tutti i core lasciava il core di VISIONE senza CPU e il supervisore lo riavviava in circolo.
 */
function voiceThreads(want: number): number {
  return Math.max(1, Math.min(want, availableParallelism() - 1));
}

async function loadFilters(modelsDir: string, threads: number): Promise<Record<string, unknown>> {
  try {
    const f = await createSherpaFilters(modelsDir, threads);
    const waves = ['0.wav', '1.wav'].map((n) => join(modelsDir, 'sherpa-onnx-whisper-base', 'test_wavs', n)).filter((p) => existsSync(p));
    const referenceVoices = (): Float32Array[] => (f.readWave ? waves.map((p) => { const w = f.readWave!(p); return to16k(Float32Array.from(w.samples), w.sampleRate); }) : []);
    if (f.speaker) log(`filtri: ${f.speaker.name}${f.denoise ? `, ${f.denoise.name}` : ''}`);
    return { speaker: f.speaker, speakerModel: f.speakerModel, denoise: f.denoise, referenceVoices };
  } catch (err) {
    log(`filtri dell'ascolto non caricati: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/** Il ripiego si dichiara: nella linguetta Voce e nel registro, non in silenzio. */
function ttsFallback(message: string): void {
  log(message);
  parentPort!.postMessage({ kind: 'core', msg: { type: 'error', code: 'tts-fallback', message: message.slice(0, 600) } } satisfies VoiceToMain);
}

/**
 * Voce VISIONE (P-110) con Windows come ripiego: file mancanti, onnxruntime-node assente o modelli che
 * non si caricano non lasciano VISIONE muta. Il ripiego vale fino al riavvio della voce.
 */
function visioneVoice(dir: string, ort: OrtModule | null, windows: WindowsTts): WindowsTts | null {
  const absent = POCKET_FILES.filter((f) => !existsSync(join(dir, f)));
  if (!ort || absent.length > 0) {
    ttsFallback(`voce VISIONE non disponibile (${ort ? `file mancanti in ${dir}: ${absent.join(', ')}` : 'onnxruntime-node non caricato'}); parla Windows`);
    return null;
  }
  // 4 thread: misurato il migliore su questo PC (2 più lento, 6 e 8 molto più lenti).
  const pocket = createPocketTts({ dir, ort, threads: voiceThreads(4), log });
  let broken = false;
  const fail = (err: unknown): void => {
    if (broken) return;
    broken = true;
    ttsFallback(`voce VISIONE non caricata (${err instanceof Error ? err.message : String(err)}); parla Windows`);
  };
  return {
    get name() {
      return broken ? windows.name : pocket.name;
    },
    warmup: async () => {
      try {
        await pocket.warmup();
      } catch (err) {
        fail(err);
        await windows.warmup();
      }
    },
    voices: () => windows.voices(),
    close: () => {
      windows.close();
      void pocket.release();
    },
    synthesize: async (text, onChunk) => {
      if (!broken) {
        try {
          return await pocket.synthesize(text, onChunk);
        } catch (err) {
          fail(err);
        }
      }
      return windows.synthesize(text, onChunk);
    }
  };
}

/** Cartella della voce VISIONE, nota dall'avvio dei motori: serve alla prova del PC. */
let benchDir: string | null = null;
/** Frase della prova: ~5 s di parlato, solo parole (nessuna cifra da normalizzare). */
const BENCH_TEXT = 'Sto misurando la velocità di questo computer per scegliere la voce più adatta al lavoro di ogni giorno.';

/** Misure della prova: la migliore di tre, senza cominciarne altre dopo 40 s (il comando ne concede 90). */
const BENCH_RUNS = 3;
const BENCH_BUDGET_MS = 40_000;

/**
 * Prova del PC (16/10/2026): una voce VISIONE a parte, senza effetto né riproduzione, così la misura non
 * dipende dalla voce attiva (può essere Windows) e non la disturba. Una frase per scaldare, poi la migliore
 * di tre misure (`bestOf`: ciò che gira insieme può solo rallentarla).
 */
async function benchmarkVoice(): Promise<BenchmarkResult> {
  const none = (reason: string): BenchmarkResult => ({ rtf: null, audioS: 0, spentMs: 0, reason });
  const ort = await ortReady;
  if (!ort) return none('onnxruntime-node non caricato');
  if (!benchDir) return none('voce non ancora avviata');
  const absent = POCKET_FILES.filter((f) => !existsSync(join(benchDir!, f)));
  if (absent.length > 0) return none(`file della voce mancanti: ${absent.join(', ')}`);
  const probe = createPocketTts({ dir: benchDir, ort, threads: voiceThreads(4), effect: false });
  try {
    await probe.warmup();
    await probe.synthesize('Prova della voce.', () => true);
    const { best, rtfs } = await bestOf(async () => {
      await probe.synthesize(BENCH_TEXT, () => true);
      return probe.stats();
    }, { runs: BENCH_RUNS, budgetMs: BENCH_BUDGET_MS, now: Date.now });
    if (!best) return none('la prova non ha prodotto audio');
    const rtf = best.spentMs / 1000 / best.audioS;
    log(`prova del PC: RTF ${rtf.toFixed(2)} (misure ${rtfs.map((r) => r.toFixed(2)).join(', ')}; ${best.audioS.toFixed(1)} s di audio in ${Math.round(best.spentMs)} ms)`);
    return { rtf, audioS: best.audioS, spentMs: best.spentMs, reason: null };
  } finally {
    await probe.release();
  }
}

const service = createVoiceService({
  toCore: (msg) => parentPort.postMessage({ kind: 'core', msg } satisfies VoiceToMain),
  benchmark: benchmarkVoice,
  createEngines: async (config) => {
    benchDir = config.voiceDir;
    const sherpaOptions = { modelsDir: config.modelsDir, threads: voiceThreads(config.threads), speaker: config.speaker, vad: config.vad, wake: { sensitivity: config.wake.sensitivity }, language: config.language };
    const ort = await ortReady;
    const provider = config.tts.provider;
    if (provider === 'visione' || provider === 'windows') {
      // Voce VISIONE inclusa (P-110) o voce di Windows (P-103): niente Kokoro. Windows è anche il ripiego
      // della voce VISIONE. Se PowerShell non risponde la frase fallisce in modo dichiarato; l'ascolto resta.
      // Senza modelli d'ascolto (installazione nuova: si scaricano su consenso dalla procedura guidata)
      // la voce parla lo stesso; l'ascolto resta spento e lo dice nel nome dei motori (P-105).
      const absent = missingModels(config.modelsDir, ['vad', 'stt']);
      const listening = absent.length === 0 ? await createSherpaEngines({ ...sherpaOptions, kokoro: false }) : silentListening(absent, config.language);
      const filters = absent.length === 0 ? await loadFilters(config.modelsDir, voiceThreads(config.threads)) : {};
      const windows = createWindowsTts({ voice: config.tts.voice, rate: config.tts.rate, language: config.language, log });
      // La voce VISIONE parla italiano: in inglese parla Windows (P-108).
      const own = provider === 'visione' && config.language === 'it' ? visioneVoice(config.voiceDir, ort, windows) : null;
      const tts = own ?? windows;
      return { ...listening, ...filters, tts, warmup: () => tts.warmup(), voices: async () => (await windows.voices()).map((v) => ({ name: v.name.slice(0, 120), language: v.lang.slice(0, 20), gender: v.gender.slice(0, 20) })) };
    }
    // Con `kokoro` ed `edge` Kokoro è caricato: è il TTS locale e il ripiego di Edge (P-84).
    const engines = await createSherpaEngines(sherpaOptions);
    const { tts, warmup } = createTtsForProvider({ ...config.tts, provider }, engines.tts, {
      log,
      onFallback: (reason) =>
        parentPort.postMessage({
          kind: 'core',
          msg: {
            type: 'error',
            code: 'tts-fallback',
            message: `voce Edge non disponibile (${reason.slice(0, 400)}); riproduco con Kokoro`
          }
        } satisfies VoiceToMain)
    });
    return { ...engines, ...(await loadFilters(config.modelsDir, voiceThreads(config.threads))), tts, warmup };
  },
  profileStore: (path) => ({
    load: () => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null),
    // Scrittura atomica; l'impronta resta solo su questo PC e si cancella su richiesta del proprietario.
    save: (profile) => {
      if (profile === null) return rmSync(path, { force: true });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(profile));
      renameSync(`${path}.tmp`, path);
    }
  }),
  newId: () => ulid(),
  log,
  exit: (code) => setTimeout(() => process.exit(code), 20)
});

parentPort.on('message', (e) => service.handle(e.data, (e.ports ?? []).map(wrap)));
process.on('uncaughtException', (err) => {
  process.stderr.write(`VISIONE voce: errore non gestito: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
