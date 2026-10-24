// Servizio del processo voce: messaggi del main (init, porta audio, ordini del core), porta audio
// del renderer, pipeline. Senza Electron: il punto d'ingresso (`index.ts`) adatta il parentPort e le
// MessagePortMain; i test lo usano in-process con porte finte.
import {
  formatIssues,
  mainToVoiceSchema,
  rendererToVoiceSchema,
  type VoiceProcessConfig,
  type VoiceToCore,
  type VoiceToRenderer
} from '../shared/contracts/index.ts';
import type { VoiceEngines } from './engines.ts';
import { parseProfile, to16k, type OwnerProfile } from './filters.ts';
import { VoicePipeline, type PipelineFilters, type PipelineTimers } from './pipeline.ts';

/** Porta audio verso il renderer (MessagePortMain nel prodotto). */
export interface AudioPort {
  post(msg: VoiceToRenderer): void;
  onMessage(handler: (data: unknown) => void): void;
  close(): void;
}

export interface VoiceServiceDeps {
  toCore(msg: VoiceToCore): void;
  createEngines(config: VoiceProcessConfig): Promise<VoiceEngines>;
  newId(): string;
  /** Diagnostica (stderr del processo, raccolta dal main). */
  log(line: string): void;
  now?: () => number;
  timers?: PipelineTimers;
  /** Spegnimento richiesto dal main. */
  exit(code: number): void;
  /**
   * Impronta del proprietario (P-106): lettura e scrittura del file in locale. Assente = niente impronta
   * (i test usano un archivio in memoria).
   */
  profileStore?: (path: string) => { load(): unknown; save(profile: OwnerProfile | null): void };
  /**
   * Prova del PC per il profilo della voce (16/10/2026): una frase con la voce VISIONE senza riprodurla.
   * Assente = prova non disponibile in questo processo.
   */
  benchmark?: () => Promise<BenchmarkResult>;
}

export interface BenchmarkResult {
  /** Calcolo / durata dell'audio; null = non misurabile (con il motivo). */
  readonly rtf: number | null;
  readonly audioS: number;
  readonly spentMs: number;
  readonly reason: string | null;
}

export interface VoiceService {
  handle(raw: unknown, ports?: readonly AudioPort[]): void;
  readonly pipeline: VoicePipeline | null;
}

export function createVoiceService(deps: VoiceServiceDeps): VoiceService {
  let pipeline: VoicePipeline | null = null;
  let port: AudioPort | null = null;
  let initialized = false;
  let invalidAudio = 0;

  const toRenderer = (msg: VoiceToRenderer): boolean => {
    if (!port) return false;
    port.post(msg);
    return true;
  };

  const adopt = (next: AudioPort): void => {
    port?.close();
    port = next;
    next.onMessage((data) => {
      const parsed = rendererToVoiceSchema.safeParse(data);
      if (!parsed.success) {
        // Il renderer è meno fidato del main: messaggi malformati scartati (segnalati una volta ogni 100).
        if (invalidAudio++ % 100 === 0) deps.log(`messaggio audio non valido scartato: ${formatIssues(parsed.error)}`);
        return;
      }
      const msg = parsed.data;
      if (msg.t === 'audio') pipeline?.audio(msg.samples);
      else pipeline?.playback(msg);
    });
  };

  const init = async (config: VoiceProcessConfig): Promise<void> => {
    const t0 = (deps.now ?? Date.now)();
    let engines: VoiceEngines;
    try {
      engines = await deps.createEngines(config);
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      deps.log(`voce non disponibile: ${reason}`);
      deps.toCore({ type: 'unavailable', reason });
      return;
    }
    // Warmup TTS (Fase 24): la prima sintesi include il caricamento lazy del modello Kokoro
    // (qualche secondo); scaldarla QUI sposta l'attesa nel caricamento dichiarato, non nel primo
    // parlato. Con il provider Edge (P-84) si scalda solo Kokoro (ripiego), senza rete. Best-effort:
    // se fallisce, la voce resta comunque disponibile.
    try {
      if (engines.warmup) await engines.warmup();
      else await engines.tts.synthesize('a', () => true);
    } catch {
      /* warmup non riuscito: nessun blocco */
    }
    // Filtri dell'ascolto (P-106): soglia, pulizia, impronta del proprietario (se registrata).
    const fc = config.filter;
    const store = deps.profileStore?.(fc.profilePath) ?? null;
    let profile: OwnerProfile | null = null;
    if (engines.speaker && engines.speakerModel && store) {
      try {
        profile = parseProfile(store.load(), engines.speakerModel);
      } catch {
        profile = null;
      }
    }
    const filters: PipelineFilters = {
      noiseGate: fc.noiseGate,
      denoise: fc.denoise ? engines.denoise ?? null : null,
      speaker: engines.speaker ?? null,
      ...(engines.speakerModel ? { speakerModel: engines.speakerModel } : {}),
      owner: { enabled: fc.ownerOnly.enabled, minScore: fc.ownerOnly.minScore, margin: fc.ownerOnly.margin, profile, cohort: [] },
      ...(store ? { saveProfile: (p: OwnerProfile | null) => store.save(p) } : {})
    };
    pipeline = new VoicePipeline({
      engines,
      toCore: deps.toCore,
      toRenderer,
      newId: deps.newId,
      bargeIn: config.bargeIn,
      wake: { enabled: config.wake.enabled, phrase: config.wake.phrase },
      filters,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.timers ? { timers: deps.timers } : {})
    });
    // Voci installate (solo il motore di Windows le elenca): best-effort, un elenco vuoto non blocca.
    let voices: Array<{ name: string; language: string; gender: string }> = [];
    try {
      voices = engines.voices ? (await engines.voices()).slice(0, 100) : [];
    } catch {
      voices = [];
    }
    deps.toCore({
      type: 'ready',
      engines: { vad: engines.vad.name, stt: engines.stt.name, tts: engines.tts.name },
      loadMs: (deps.now ?? Date.now)() - t0,
      voices,
      filters: { denoise: filters.denoise !== null, speaker: filters.speaker !== null, owner: profile !== null, ownerOnly: fc.ownerOnly.enabled, noiseGate: fc.noiseGate }
    });
    // Voci di riferimento per il margine (P-106), dopo il «pronto»: le registrazioni umane già sul PC e
    // la voce di VISIONE stessa (così VISIONE non scambia la propria voce per quella del proprietario).
    const speaker = engines.speaker;
    if (speaker) {
      void (async () => {
        const cohort: Float32Array[] = [];
        for (const wave of engines.referenceVoices?.() ?? []) {
          try {
            cohort.push(speaker.embed(wave));
          } catch {
            /* registrazione non utilizzabile: si salta */
          }
        }
        try {
          const parts: Float32Array[] = [];
          let rate = 16_000;
          const sample = config.language === 'en' ? 'This is the voice of VISIONE: all systems are online and the team is ready.' : 'Questa è la voce di VISIONE: tutti i sistemi sono operativi e la squadra è pronta.';
          await engines.tts.synthesize(sample, (chunk) => {
            if (chunk.kind === 'pcm') {
              parts.push(chunk.samples);
              rate = chunk.sampleRate;
            }
            return true;
          });
          const pcm = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
          let o = 0;
          for (const p of parts) {
            pcm.set(p, o);
            o += p.length;
          }
          if (pcm.length > 0) cohort.push(speaker.embed(to16k(pcm, rate)));
        } catch {
          /* voce di VISIONE non disponibile per la coorte: il margine usa le altre */
        }
        pipeline?.setCohort(cohort);
      })();
    }
  };

  let measuring = false;
  const benchmark = async (): Promise<void> => {
    const reply = (r: BenchmarkResult): void => deps.toCore({ type: 'benchmark', rtf: r.rtf === null ? null : Math.min(100, r.rtf), audioS: Math.min(600, r.audioS), spentMs: Math.max(0, Math.round(r.spentMs)), reason: r.reason?.slice(0, 300) ?? null });
    if (!deps.benchmark) return reply({ rtf: null, audioS: 0, spentMs: 0, reason: 'prova non disponibile' });
    // Una prova alla volta: due insieme si rallenterebbero a vicenda e la misura sarebbe falsa.
    if (measuring) return reply({ rtf: null, audioS: 0, spentMs: 0, reason: 'prova già in corso' });
    measuring = true;
    try {
      reply(await deps.benchmark());
    } catch (err) {
      reply({ rtf: null, audioS: 0, spentMs: 0, reason: err instanceof Error ? err.message : String(err) });
    } finally {
      measuring = false;
    }
  };

  return {
    get pipeline() {
      return pipeline;
    },
    handle(raw, ports = []) {
      const parsed = mainToVoiceSchema.safeParse(raw);
      if (!parsed.success) {
        deps.log(`messaggio del main non valido: ${formatIssues(parsed.error)}`);
        return;
      }
      const m = parsed.data;
      switch (m.kind) {
        case 'init':
          if (initialized) return;
          initialized = true;
          void init(m.config);
          return;
        case 'port':
          if (ports[0]) adopt(ports[0]);
          return;
        case 'shutdown':
          pipeline?.close();
          port?.close();
          void (pipeline?.idle() ?? Promise.resolve()).finally(() => deps.exit(0));
          return;
        case 'core': {
          const msg = m.msg;
          // La prova non usa la pipeline: risponde anche con l'ascolto spento o la voce non ancora pronta.
          if (msg.type === 'benchmark') {
            void benchmark();
            return;
          }
          if (!pipeline) {
            // Ordini prima che i motori siano pronti (o con la voce non disponibile).
            if (msg.type === 'speak') {
              deps.toCore({ type: 'tts', ttsId: msg.ttsId, phase: 'failed', synthMs: null, firstAudioMs: null, bargeInMs: null, playedMs: null, cause: null, error: 'voce non pronta' });
            } else if (msg.type === 'wake') {
              deps.toCore({ type: 'wake-state', enabled: false, phrase: msg.phrase, available: false, reason: 'voce non pronta' });
            } else if (msg.type === 'enroll') {
              deps.toCore({ type: 'enroll', phase: 'error', count: 0, audioMs: null, quality: null, reason: 'failed' });
            }
            return;
          }
          if (msg.type === 'ptt') pipeline.ptt(msg.down, msg.autoEnd);
          else if (msg.type === 'speak') pipeline.speak(msg.ttsId, msg.text);
          else if (msg.type === 'stop') pipeline.stop(msg.ttsId, msg.cause);
          else if (msg.type === 'wake') pipeline.wake(msg.enabled, msg.phrase);
          else if (msg.type === 'enroll') pipeline.enroll(msg.action);
          return;
        }
      }
    }
  };
}
