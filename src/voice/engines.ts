// Motori del processo voce (VISIONE_ARCHITECTURE §25, §28): interfacce interne tipizzate, nessun
// plugin a runtime. L'implementazione inclusa è sherpa-onnx (`sherpa.ts`); i test usano motori finti.
// Tutto l'audio in ingresso è PCM mono float32 a `VOICE_SAMPLE_RATE` (16 kHz).
import type { DenoiseEngine, SpeakerEngine } from './filters.ts';

/** Segmento di parlato chiuso dal VAD: `start` è l'indice del primo campione dall'ultimo `reset()`. */
export interface SpeechSegment {
  readonly start: number;
  readonly samples: Float32Array;
}

export interface VadEngine {
  readonly name: string;
  /** Campioni per chiamata di `accept` (finestra del modello). */
  readonly windowSize: number;
  accept(window: Float32Array): void;
  /** Parlato in corso (dopo la durata minima del parlato). */
  detected(): boolean;
  /** Chiude il segmento in corso, se c'è. */
  flush(): void;
  /** Prossimo segmento chiuso, o null. */
  pop(): SpeechSegment | null;
  /** Svuota lo stato: gli indici ripartono da 0. */
  reset(): void;
}

export interface SttEngine {
  readonly name: string;
  /** Trascrive un enunciato (16 kHz). Non blocca il ciclo degli eventi (decodifica asincrona). */
  transcribe(samples: Float32Array): Promise<string>;
  /**
   * Trascrive meglio l'audio così com'è, senza la pulizia GTCRN (24/10/2026, Parakeet v3 su 100 frasi con rumore a
   * 10 dB: 93,0% di parole giuste senza pulizia, 85,6% con). La pulizia resta per l'impronta del proprietario.
   */
  readonly rawInput?: boolean;
}

/**
 * Blocco di sintesi: PCM locale (Kokoro) o MP3 (Edge). L'MP3 non è decodificato nel processo voce:
 * viaggia al renderer e lì lo decodifica Web Audio (`decodeAudioData`).
 */
export type TtsChunk =
  | { readonly kind: 'pcm'; readonly samples: Float32Array; readonly sampleRate: number }
  | { readonly kind: 'mp3'; readonly bytes: Uint8Array };

export interface TtsEngine {
  readonly name: string;
  /**
   * Sintetizza `text` a blocchi. `onChunk` restituisce false per interrompere la sintesi. Non
   * blocca il ciclo degli eventi.
   */
  synthesize(text: string, onChunk: (chunk: TtsChunk) => boolean): Promise<void>;
}

/**
 * Wake word (P-81): non è un engine separato — la pipeline usa una VAD dedicata (`wakeVad`) con la
 * sua soglia, poi lo STT condiviso e il matcher puro (`wake.ts`). Il vecchio `WakeWordProvider`
 * opzionale (P-12/P-49) non serve più: niente KWS nativo per l'italiano.
 */
export interface VoiceEngines {
  readonly vad: VadEngine;
  readonly stt: SttEngine;
  readonly tts: TtsEngine;
  /** VAD dedicata alla wake (soglia propria): assente = wake non disponibile. */
  readonly wakeVad?: VadEngine;
  /** STT rapido per la parola d'avvio (whisper-base accanto a small, 17/10/2026): assente = `stt`. */
  readonly wakeStt?: SttEngine;
  /**
   * Riscaldamento specifico quando il TTS primario non è Kokoro (provider Edge, P-84): carica il
   * modello locale del ripiego senza fare rete. Assente = il servizio scalda `tts.synthesize('a')`.
   */
  readonly warmup?: () => Promise<void>;
  /** Voci installate nel sistema (motore di Windows); assente = il motore non le elenca. */
  readonly voices?: () => Promise<ReadonlyArray<{ name: string; language: string; gender: string }>>;
  /** Filtri dell'ascolto (P-106), presenti solo se i loro modelli sono scaricati. */
  readonly speaker?: SpeakerEngine | null;
  readonly speakerModel?: string | null;
  readonly denoise?: DenoiseEngine | null;
  /** Voci umane di riferimento già sul PC (16 kHz), per il margine del controllo del proprietario. */
  readonly referenceVoices?: () => Float32Array[];
}
