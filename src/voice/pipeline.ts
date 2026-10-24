// Pipeline del processo voce (Fase 9, VISIONE_ARCHITECTURE §28): push-to-talk → VAD → STT →
// enunciato al core; frase dal core → TTS a blocchi → riproduzione nel renderer; barge-in.
// Nessuna decisione di dominio: cosa fare del testo e cosa dire lo decide il core.
//
// Audio: il renderer invia il PCM del microfono finché la voce è armata; la pipeline lo usa solo
// (a) mentre il push-to-talk è premuto (enunciato) e (b) mentre VISIONE parla, per il barge-in. Fuori
// da questi due casi l'audio è scartato appena arriva. Il parlato del barge-in ferma la riproduzione e
// basta: non viene trascritto (né la voce di VISIONE captata dal microfono può diventare un comando).
//
// Latenza del barge-in = conferma dello stop dal renderer − istante di inizio del parlato. L'inizio è
// l'indice del primo campione del segmento del VAD, riportato all'ora d'arrivo del suo blocco audio.
import { VOICE_LIMITS, VOICE_SAMPLE_RATE, type InterruptCause, type RendererToVoice, type VoiceToCore, type VoiceToRenderer } from '../shared/contracts/voice.ts';
import type { SpeechSegment, SttEngine, VadEngine, VoiceEngines } from './engines.ts';
import { enrollQuality, judgeOwner, makeProfile, OWNER_LIMITS, speechLevel, type DenoiseEngine, type OwnerProfile, type SpeakerEngine } from './filters.ts';
import { matchWakePhrase, WAKE_LIMITS } from './wake.ts';

const toMs = (samples: number): number => Math.round((samples / VOICE_SAMPLE_RATE) * 1000);

export interface PipelineTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface PipelineDeps {
  engines: VoiceEngines;
  toCore(msg: VoiceToCore): void;
  /** false se nessun renderer è collegato (la frase non può essere riprodotta). */
  toRenderer(msg: VoiceToRenderer): boolean;
  newId(): string;
  bargeIn?: boolean;
  now?: () => number;
  timers?: PipelineTimers;
  /** Attesa massima della conferma di stop dal renderer. */
  ackTimeoutMs?: number;
  /** Intervallo dei livelli del microfono verso il core. */
  levelEveryMs?: number;
  /** Wake word (P-81): stato iniziale; si modifica a runtime con `wake()`. */
  wake?: { enabled: boolean; phrase: string };
  /** Filtri dell'ascolto (P-106): soglia del rumore, pulizia, solo il proprietario, registrazione. */
  filters?: PipelineFilters;
}

export interface PipelineFilters {
  /** RMS minimo del parlato: sotto, non si trascrive (0 = spenta). */
  noiseGate: number;
  denoise?: DenoiseEngine | null;
  speaker?: SpeakerEngine | null;
  /** Modello dell'impronta: un profilo fatto con un altro modello non vale. */
  speakerModel?: string;
  owner?: { enabled: boolean; minScore: number; margin: number; profile: OwnerProfile | null; cohort: Float32Array[] };
  /** Salva (o cancella con null) l'impronta del proprietario. */
  saveProfile?: (profile: OwnerProfile | null) => void;
}

interface Listening {
  readonly startTotal: number;
  readonly autoEnd: boolean;
  lastLevelAt: number;
  /** Da quando il parlato è finito (autoEnd): il turno si chiude dopo `autoEndGraceMs` di silenzio continuo. */
  quietSince: number | null;
}

interface Speech {
  readonly ttsId: string;
  readonly requestedAt: number;
  firstChunkAt: number | null;
  startedAt: number | null;
  cancelled: boolean;
  stopping: { cause: InterruptCause; onsetAt: number | null; timer: unknown } | null;
}

export class VoicePipeline {
  private readonly d: PipelineDeps;
  private readonly now: () => number;
  private readonly timers: PipelineTimers;
  private readonly bargeIn: boolean;
  /** Campioni ricevuti dall'avvio (orologio dell'audio). */
  private total = 0;
  /** Valore di `total` all'ultimo reset del VAD (gli indici del VAD partono da lì). */
  private vadBase = 0;
  private vadFed = 0;
  private pending: Float32Array = new Float32Array(0);
  private vadWasDetected = false;
  /** Arrivo dei blocchi recenti (fine del blocco in campioni, ora d'arrivo). */
  private frames: Array<{ end: number; at: number }> = [];
  private listening: Listening | null = null;
  private segments: Float32Array[] = [];
  private speech: Speech | null = null;
  private transcribing = Promise.resolve();
  private closed = false;
  /** Wake word (P-81): VAD dedicata, stato del segmento e coda di trascrizione (una per volta). */
  private wakeEnabled: boolean;
  private wakePhrase: string;
  private wakeVadWasDetected = false;
  private wakeSpeechStart = 0;
  private wakeBuffer: Float32Array = new Float32Array(0);
  private wakeQueued = 0;
  /** Registrazione della voce del proprietario in corso: impronte delle frasi raccolte (P-106). */
  private enrolling: Float32Array[] | null = null;
  /** Prova della procedura (P-106): la prossima frase si giudica soltanto, senza STT. */
  private probing = false;

  constructor(deps: PipelineDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.bargeIn = deps.bargeIn ?? true;
    // Se la VAD dedicata manca, la wake non può esistere: lo stato lo dice `wake-state`.
    this.wakeEnabled = (deps.wake?.enabled ?? false) && this.wakeVad !== null;
    this.wakePhrase = deps.wake?.phrase ?? 'hey visione';
  }

  get isListening(): boolean {
    return this.listening !== null;
  }

  get speakingId(): string | null {
    return this.speech?.ttsId ?? null;
  }

  /** VAD dedicata alla wake (P-81); assente = wake non disponibile. */
  private get wakeVad(): VadEngine | null {
    return this.d.engines.wakeVad ?? null;
  }

  /**
   * Wake word (P-81): applica lo stato richiesto dal core e risponde con la realtà del processo
   * (`wake-state`): senza VAD dedicata, `available:false` e la wake resta spenta.
   */
  wake(enabled: boolean, phrase: string): void {
    if (this.closed) return;
    const available = this.wakeVad !== null;
    this.wakePhrase = phrase;
    const next = enabled && available;
    if (next !== this.wakeEnabled) this.wakeEnabled = next;
    if (!this.wakeEnabled) {
      this.resetWakeVad();
      this.wakeQueued = 0;
    }
    this.d.toCore({
      type: 'wake-state', enabled: this.wakeEnabled, phrase: this.wakePhrase, available,
      reason: enabled && !available ? 'VAD dedicata assente nel processo voce' : null
    });
  }

  /** Voci di riferimento per il margine (P-106): si aggiungono quando sono pronte (es. la voce di VISIONE). */
  setCohort(cohort: Float32Array[]): void {
    const o = this.d.filters?.owner;
    if (o) o.cohort = cohort;
  }

  /**
   * Registrazione della voce del proprietario (P-106): `start` raccoglie le frasi dette col push-to-talk
   * (niente STT), `save` le unisce nell'impronta e la salva, `cancel` scarta, `clear` cancella l'impronta.
   */
  enroll(action: 'start' | 'save' | 'cancel' | 'clear' | 'probe'): void {
    if (this.closed) return;
    const f = this.d.filters;
    if (action === 'probe') {
      this.probing = true;
      return;
    }
    const report = (phase: 'started' | 'saved' | 'cleared' | 'cancelled' | 'error', reason: 'no-model' | 'few' | 'quality' | 'failed' | 'not-started' | null = null, quality: number | null = null): void =>
      this.d.toCore({ type: 'enroll', phase, count: this.enrolling?.length ?? 0, audioMs: null, quality, reason });
    if (action === 'start') {
      if (!f?.speaker) return report('error', 'no-model');
      this.enrolling = [];
      return report('started');
    }
    if (action === 'cancel') {
      this.enrolling = null;
      return report('cancelled');
    }
    if (action === 'clear') {
      this.enrolling = null;
      if (f?.owner) f.owner.profile = null;
      try {
        f?.saveProfile?.(null);
      } catch {
        return report('error', 'failed');
      }
      return report('cleared');
    }
    // save
    const samples = this.enrolling;
    if (samples === null) return report('error', 'not-started');
    if (samples.length < OWNER_LIMITS.enrollSamples) return report('error', 'few');
    const quality = Math.round(enrollQuality(samples).min * 1000) / 1000;
    if (quality < OWNER_LIMITS.enrollMinQuality) {
      // Frasi poco coerenti tra loro (rumore, voci diverse): si ricomincia, l'impronta vecchia resta.
      this.enrolling = [];
      return report('error', 'quality', quality);
    }
    const profile = makeProfile(f?.speakerModel ?? 'speaker', samples, this.now());
    try {
      f?.saveProfile?.(profile);
    } catch {
      return report('error', 'failed', quality);
    }
    if (f?.owner) f.owner.profile = profile;
    report('saved', null, quality);
    this.enrolling = null;
  }

  /** Attesa delle trascrizioni in corso (spegnimento, test). */
  idle(): Promise<void> {
    return this.transcribing;
  }

  /** Push-to-talk. `autoEnd`: l'enunciato si chiude da solo alla fine del parlato (scorciatoia globale). */
  ptt(down: boolean, autoEnd = false): void {
    if (this.closed) return;
    if (down) {
      if (this.listening) return;
      // Premere il push-to-talk mentre VISIONE parla lo interrompe subito.
      if (this.speech && !this.speech.stopping) this.interrupt(this.speech, 'ptt', this.now());
      this.resetVad();
      this.resetWakeVad();
      this.segments = [];
      this.listening = { startTotal: this.total, autoEnd, lastLevelAt: this.now(), quietSince: null };
    } else if (this.listening) {
      this.endUtterance();
    }
  }

  audio(samples: Float32Array): void {
    if (this.closed) return;
    const at = this.now();
    this.total += samples.length;
    this.frames.push({ end: this.total, at });
    // Bastano gli ultimi secondi per ritrovare l'inizio di un parlato.
    while (this.frames.length > 0 && this.frames[0]!.end < this.total - 5 * VOICE_SAMPLE_RATE) this.frames.shift();
    const watching = this.speech !== null && this.bargeIn && this.speech.stopping === null;
    // Wake (P-81): solo a voce ferma e fuori dal push-to-talk; la coda di trascrizione è limitata.
    const wakeOn = this.wakeEnabled && this.wakeVad !== null && !this.listening && this.speech === null;
    if (!this.listening && !watching && !wakeOn) return;
    if (wakeOn) {
      this.feedWake(samples);
      this.onWakeAudio(at);
      return;
    }
    this.feed(samples);
    if (this.listening) this.onListeningAudio(samples, at);
    else if (watching && this.d.engines.vad.detected()) this.onBargeIn();
  }

  speak(ttsId: string, text: string): void {
    if (this.closed) return;
    if (this.speech && !this.speech.stopping) this.interrupt(this.speech, 'replaced', null);
    const s: Speech = { ttsId, requestedAt: this.now(), firstChunkAt: null, startedAt: null, cancelled: false, stopping: null };
    this.speech = s;
    if (!this.listening) this.resetVad();
    this.resetWakeVad();
    let delivered = true;
    this.d.engines.tts
      .synthesize(text, (chunk) => {
        if (s.cancelled) return false;
        s.firstChunkAt ??= this.now();
        if (chunk.kind === 'mp3') {
          // Edge (P-84): i byte MP3 vanno al renderer, che li decodifica con Web Audio.
          if (chunk.bytes.length === 0) return true;
          delivered = this.d.toRenderer({ t: 'mp3', ttsId, bytes: chunk.bytes.slice(), last: false });
          return delivered;
        }
        for (let i = 0; i < chunk.samples.length; i += VOICE_LIMITS.pcmSamples) {
          delivered = this.d.toRenderer({ t: 'pcm', ttsId, sampleRate: chunk.sampleRate, samples: chunk.samples.slice(i, i + VOICE_LIMITS.pcmSamples), last: false });
          if (!delivered) return false;
        }
        return true;
      })
      .then(
        () => {
          if (s.cancelled) return;
          if (!delivered) this.fail(s, 'nessuna uscita audio: la finestra non è collegata');
          else if (s.firstChunkAt === null) this.fail(s, 'la sintesi non ha prodotto audio');
          else this.d.toRenderer({ t: 'end', ttsId });
        },
        (err: unknown) => {
          if (!s.cancelled) this.fail(s, `sintesi non riuscita: ${err instanceof Error ? err.message : String(err)}`);
        }
      );
  }

  /** Stop dal core (comando del proprietario o nuova frase). `ttsId` null = qualunque frase. */
  stop(ttsId: string | null, cause: InterruptCause): boolean {
    const s = this.speech;
    if (!s || s.stopping || (ttsId !== null && s.ttsId !== ttsId)) return false;
    this.interrupt(s, cause, cause === 'owner' || cause === 'ptt' ? this.now() : null);
    return true;
  }

  /** Messaggio della riproduzione dal renderer. */
  playback(msg: Extract<RendererToVoice, { t: 'playback' }>): void {
    const s = this.speech;
    if (!s || s.ttsId !== msg.ttsId) return;
    const now = this.now();
    if (msg.phase === 'started' && s.startedAt === null && !s.stopping) {
      s.startedAt = now;
      this.d.toCore({
        type: 'tts', ttsId: s.ttsId, phase: 'started', synthMs: s.firstChunkAt === null ? null : s.firstChunkAt - s.requestedAt,
        firstAudioMs: now - s.requestedAt, bargeInMs: null, playedMs: null, cause: null, error: null
      });
    } else if (msg.phase === 'ended' && !s.stopping) {
      this.end(s);
      this.d.toCore({ type: 'tts', ttsId: s.ttsId, phase: 'finished', synthMs: null, firstAudioMs: null, bargeInMs: null, playedMs: s.startedAt === null ? null : now - s.startedAt, cause: null, error: null });
    } else if (msg.phase === 'stopped' && s.stopping) {
      this.reportInterrupted(s, now);
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.speech && !this.speech.stopping) this.interrupt(this.speech, 'process', null);
    this.closed = true;
    this.listening = null;
  }

  // --- interni -------------------------------------------------------------------------------

  private resetVad(): void {
    this.d.engines.vad.reset();
    this.vadBase = this.total;
    this.vadFed = 0;
    this.pending = new Float32Array(0);
    this.vadWasDetected = false;
  }

  private feed(samples: Float32Array): void {
    const vad = this.d.engines.vad;
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    let offset = 0;
    while (joined.length - offset >= vad.windowSize) {
      vad.accept(joined.slice(offset, offset + vad.windowSize));
      offset += vad.windowSize;
    }
    this.vadFed += offset;
    this.pending = joined.slice(offset);
  }

  private resetWakeVad(): void {
    if (this.wakeVad === null) return;
    this.wakeVad.reset();
    this.wakeBuffer = new Float32Array(0);
    this.wakeVadWasDetected = false;
    this.wakeSpeechStart = 0;
  }

  /** Come `feed`, ma per la VAD dedicata alla wake (buffer indipendente). */
  private feedWake(samples: Float32Array): void {
    const vad = this.wakeVad;
    if (vad === null) return;
    const joined = new Float32Array(this.wakeBuffer.length + samples.length);
    joined.set(this.wakeBuffer);
    joined.set(samples, this.wakeBuffer.length);
    let offset = 0;
    while (joined.length - offset >= vad.windowSize) {
      vad.accept(joined.slice(offset, offset + vad.windowSize));
      offset += vad.windowSize;
    }
    this.wakeBuffer = joined.slice(offset);
  }

  /** Segmenti chiusi della wake: si trascrivono qui, il matcher decide se era «Hey Visione». */
  private onWakeAudio(at: number): void {
    const vad = this.wakeVad;
    if (vad === null) return;
    const detected = vad.detected();
    if (detected && !this.wakeVadWasDetected) {
      this.wakeVadWasDetected = true;
      this.wakeSpeechStart = this.total;
    } else if (!detected) {
      this.wakeVadWasDetected = false;
    }
    // Un parlato troppo lungo si chiude d'ufficio (limite di latenza), poi riparte.
    if (detected && toMs(this.total - this.wakeSpeechStart) >= WAKE_LIMITS.maxSegmentMs) {
      vad.flush();
      this.wakeVadWasDetected = false;
    }
    for (let seg = vad.pop(); seg !== null; seg = vad.pop()) this.queueWake(seg, at);
  }

  private queueWake(seg: SpeechSegment, closedAt: number): void {
    if (this.closed || !this.wakeEnabled) return;
    // Coda piena (3 segmenti): si scarta l'audio in eccesso, mai dati inventati.
    if (this.wakeQueued >= 3) return;
    const audioMs = toMs(seg.samples.length);
    if (audioMs < WAKE_LIMITS.minSegmentMs) return;
    let sum = 0;
    for (const v of seg.samples) sum += v * v;
    if (Math.sqrt(sum / seg.samples.length) < WAKE_LIMITS.minRms) return; // energia insufficiente
    if (speechLevel(seg.samples) < (this.d.filters?.noiseGate ?? 0)) return; // P-106: sotto la soglia della stanza
    this.wakeQueued += 1;
    const phrase = this.wakePhrase;
    const samples = seg.samples;
    this.transcribing = this.transcribing.then(async () => {
      try {
        const clean = this.clean(samples);
        // P-106: un estraneo non sveglia VISIONE (la sua frase non arriva nemmeno allo STT).
        if (this.checkOwner(clean, 'wake') === 'stranger') return;
        // 17/10/2026: la parola d'avvio con il modello rapido (gira su ogni rumore); se c'è un comando
        // detto di seguito, lo stesso audio si ritrascrive col modello buono (solo a wake riconosciuta).
        const fast = this.d.engines.wakeStt ?? this.d.engines.stt;
        let text = (await fast.transcribe(this.sttInput(fast, samples, clean))).trim().slice(0, VOICE_LIMITS.utteranceChars);
        if (this.closed || !this.wakeEnabled || this.listening || this.speech !== null) return;
        let match = matchWakePhrase(text, phrase);
        // 24/10/2026 (dal proprietario: «a volte non sente hey visione»): sui segmenti brevi, se il modello rapido non
        // l'ha riconosciuta, un secondo tentativo col modello buono. Misurato sulle frasi di prova: dove uno sbaglia
        // l'altro spesso no; nessun falso allarme su 100 frasi normali con nessuno dei due.
        if (!match && fast !== this.d.engines.stt && audioMs <= WAKE_LIMITS.secondTryMs && text.split(/\s+/).filter(Boolean).length <= WAKE_LIMITS.secondTryWords) {
          const full = (await this.d.engines.stt.transcribe(this.sttInput(this.d.engines.stt, samples, clean))).trim().slice(0, VOICE_LIMITS.utteranceChars);
          if (this.closed || !this.wakeEnabled || this.listening || this.speech !== null) return;
          const second = matchWakePhrase(full, phrase);
          if (second) {
            text = full;
            match = second;
          }
        }
        if (!match) return; // nessuna wake: niente eventi, niente dati inventati
        if (match.command && fast !== this.d.engines.stt) {
          const full = (await this.d.engines.stt.transcribe(this.sttInput(this.d.engines.stt, samples, clean))).trim().slice(0, VOICE_LIMITS.utteranceChars);
          const better = matchWakePhrase(full, phrase);
          if (better?.command) {
            text = full;
            match = better;
          }
        }
        const sttMs = Math.max(0, this.now() - closedAt);
        this.d.toCore({ type: 'wake', phrase: match.phrase, text, command: match.command ?? '', audioMs, sttMs });
      } catch {
        // STT non riuscito in wake: si resta in ascolto, nessun evento.
      } finally {
        this.wakeQueued = Math.max(0, this.wakeQueued - 1);
      }
    });
  }

  private onListeningAudio(samples: Float32Array, at: number): void {
    const l = this.listening!;
    const vad = this.d.engines.vad;
    const detected = vad.detected();
    if (detected !== this.vadWasDetected) {
      this.vadWasDetected = detected;
      this.d.toCore({ type: 'vad', phase: detected ? 'start' : 'end', mode: 'ptt', audioMs: toMs(this.total - l.startTotal) });
    }
    for (let seg = vad.pop(); seg !== null; seg = vad.pop()) this.segments.push(seg.samples);
    const levelEvery = this.d.levelEveryMs ?? 200;
    if (at - l.lastLevelAt >= levelEvery) {
      l.lastLevelAt = at;
      let sum = 0;
      for (const v of samples) sum += v * v;
      this.d.toCore({ type: 'level', rms: Math.min(1, Math.sqrt(sum / samples.length)) });
    }
    const tooLong = toMs(this.total - l.startTotal) >= VOICE_LIMITS.maxUtteranceMs;
    // Turno che si chiude da solo: alla fine del parlato si aspetta ancora un po' di silenzio continuo, così una
    // pausa per pensare non tronca la frase; se si riprende a parlare, si ricomincia ad aspettare.
    const quiet = l.autoEnd && this.segments.length > 0 && !detected;
    if (!quiet) l.quietSince = null;
    else if (l.quietSince === null) l.quietSince = at;
    // Margine adattivo (18/10/2026): pieno dopo una parola o due, breve dopo una frase intera.
    const spokenMs = quiet ? toMs(this.segments.reduce((n, s) => n + s.length, 0)) : 0;
    const grace = spokenMs >= VOICE_LIMITS.autoEndQuickAfterMs ? VOICE_LIMITS.autoEndQuickGraceMs : VOICE_LIMITS.autoEndGraceMs;
    const quietLongEnough = quiet && at - (l.quietSince ?? at) >= grace;
    if (tooLong || quietLongEnough) this.endUtterance();
  }

  private endUtterance(): void {
    const vad = this.d.engines.vad;
    this.listening = null;
    const endAt = this.now();
    vad.flush();
    for (let seg = vad.pop(); seg !== null; seg = vad.pop()) this.segments.push(seg.samples);
    if (this.vadWasDetected) {
      this.vadWasDetected = false;
      this.d.toCore({ type: 'vad', phase: 'end', mode: 'ptt', audioMs: toMs(this.vadFed) });
    }
    const length = this.segments.reduce((n, s) => n + s.length, 0);
    const audio = new Float32Array(length);
    let offset = 0;
    for (const s of this.segments) {
      audio.set(s, offset);
      offset += s.length;
    }
    this.segments = [];
    this.resetVad();
    const utteranceId = this.d.newId();
    // Nessun parlato rilevato: niente STT (Whisper sul silenzio "inventa" frasi).
    if (length === 0) {
      // In registrazione (P-106) il silenzio è una frase troppo corta, non un enunciato vuoto.
      if (this.enrolling !== null) return this.enrollSample(audio, 0);
      this.d.toCore({ type: 'utterance', utteranceId, text: '', audioMs: 0, sttMs: 0, latencyMs: 0 });
      return;
    }
    const audioMs = toMs(length);
    // P-106: in registrazione la frase diventa un'impronta, non un comando.
    if (this.enrolling !== null) {
      this.enrollSample(audio, audioMs);
      return;
    }
    // P-106: prova della procedura — giudizio della voce anche col filtro spento, niente STT.
    if (this.probing) {
      this.probing = false;
      this.transcribing = this.transcribing.then(() => {
        if (this.checkOwner(this.clean(audio), 'ptt', true) === null) this.d.toCore({ type: 'heard', mode: 'ptt', outcome: 'unverified', score: null, audioMs });
      });
      return;
    }
    const gate = this.d.filters?.noiseGate ?? 0;
    if (gate > 0 && speechLevel(audio) < gate) {
      // Parlato troppo debole (rumore di fondo, voci lontane): non si trascrive.
      this.d.toCore({ type: 'heard', mode: 'ptt', outcome: 'quiet', score: null, audioMs });
      this.d.toCore({ type: 'utterance', utteranceId, text: '', audioMs, sttMs: 0, latencyMs: 0 });
      return;
    }
    this.transcribing = this.transcribing.then(async () => {
      const t0 = this.now();
      try {
        const clean = this.clean(audio);
        if (this.checkOwner(clean, 'ptt') === 'stranger') {
          this.d.toCore({ type: 'utterance', utteranceId, text: '', audioMs, sttMs: 0, latencyMs: Math.max(0, this.now() - endAt) });
          return;
        }
        const text = (await this.d.engines.stt.transcribe(this.sttInput(this.d.engines.stt, audio, clean))).trim().slice(0, VOICE_LIMITS.utteranceChars);
        const t1 = this.now();
        this.d.toCore({ type: 'utterance', utteranceId, text, audioMs: toMs(length), sttMs: t1 - t0, latencyMs: t1 - endAt });
      } catch (err) {
        this.d.toCore({ type: 'error', code: 'stt-failed', message: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
      }
    });
  }

  /** L'audio da dare a uno STT: quello pulito, o l'originale se lo STT trascrive meglio senza pulizia (Parakeet). */
  private sttInput(stt: SttEngine, raw: Float32Array, clean: Float32Array): Float32Array {
    return stt.rawInput ? raw : clean;
  }

  /** Pulizia GTCRN se c'è (P-106); se fallisce si usa l'audio originale. */
  private clean(samples: Float32Array): Float32Array {
    const dn = this.d.filters?.denoise;
    if (!dn) return samples;
    try {
      return dn.run(samples);
    } catch {
      return samples;
    }
  }

  /**
   * Solo il proprietario (P-106): null = filtro spento. Un segmento più corto di un secondo non si
   * giudica («unverified»): l'impronta sarebbe poco affidabile (il comando dopo la wake si giudica).
   */
  private checkOwner(samples: Float32Array, mode: 'ptt' | 'wake', force = false): 'owner' | 'stranger' | 'unverified' | null {
    const f = this.d.filters;
    const o = f?.owner;
    if (!o || (!o.enabled && !force) || !o.profile || !f?.speaker) return null;
    const audioMs = toMs(samples.length);
    let outcome: 'owner' | 'stranger' | 'unverified' = 'unverified';
    let score: number | null = null;
    if (audioMs >= OWNER_LIMITS.minVerifyMs) {
      try {
        const d = judgeOwner(f.speaker.embed(samples), o.profile.centroid, o.cohort, o.minScore, o.margin);
        outcome = d.outcome;
        score = Math.round(d.score * 1000) / 1000;
      } catch {
        outcome = 'unverified';
      }
    }
    this.d.toCore({ type: 'heard', mode, outcome, score, audioMs });
    return outcome;
  }

  /** Una frase della registrazione: impronta della frase pulita (niente STT). */
  private enrollSample(audio: Float32Array, audioMs: number): void {
    const speaker = this.d.filters?.speaker;
    const report = (phase: 'sample' | 'error', reason: 'no-model' | 'short' | 'failed' | null): void =>
      this.d.toCore({ type: 'enroll', phase, count: this.enrolling?.length ?? 0, audioMs, quality: null, reason });
    if (!speaker) return report('error', 'no-model');
    if (audioMs < OWNER_LIMITS.enrollMinMs) return report('error', 'short');
    this.transcribing = this.transcribing.then(() => {
      try {
        const v = speaker.embed(this.clean(audio));
        if (this.enrolling === null) return;
        this.enrolling.push(v);
        report('sample', null);
      } catch {
        report('error', 'failed');
      }
    });
  }

  private onBargeIn(): void {
    const s = this.speech!;
    const vad = this.d.engines.vad;
    // Chiudere il segmento dà l'indice del primo campione del parlato (microsecondi), poi lo stop.
    vad.flush();
    const seg = vad.pop();
    const onsetSample = seg ? this.vadBase + seg.start : this.total;
    this.interrupt(s, 'barge-in', this.arrivalOf(onsetSample));
    this.d.toCore({ type: 'vad', phase: 'start', mode: 'barge-in', audioMs: toMs(onsetSample - this.vadBase) });
    this.resetVad();
  }

  /** Ora (stimata) in cui è stato catturato il campione `sample`. */
  private arrivalOf(sample: number): number {
    const frame = this.frames.find((f) => f.end >= sample) ?? this.frames[this.frames.length - 1];
    if (!frame) return this.now();
    return frame.at - toMs(Math.max(0, frame.end - sample));
  }

  private interrupt(s: Speech, cause: InterruptCause, onsetAt: number | null): void {
    s.cancelled = true;
    const timer = this.timers.set(() => this.reportInterrupted(s, null), this.d.ackTimeoutMs ?? 1_000);
    s.stopping = { cause, onsetAt, timer };
    // Il renderer conferma sempre uno stop con `playback: stopped`.
    this.d.toRenderer({ t: 'stop', ttsId: s.ttsId });
  }

  /** Stop confermato dal renderer (`at`) o scaduta l'attesa (null: latenza non misurabile). */
  private reportInterrupted(s: Speech, at: number | null): void {
    if (!s.stopping || this.speech !== s) return;
    this.timers.clear(s.stopping.timer);
    const { cause, onsetAt } = s.stopping;
    this.end(s);
    this.d.toCore({
      type: 'tts', ttsId: s.ttsId, phase: 'interrupted', synthMs: null, firstAudioMs: null,
      bargeInMs: at !== null && onsetAt !== null ? Math.max(0, at - onsetAt) : null,
      playedMs: s.startedAt === null ? null : (at ?? this.now()) - s.startedAt, cause, error: null
    });
  }

  private fail(s: Speech, error: string): void {
    if (this.speech !== s) return;
    s.cancelled = true;
    this.end(s);
    this.d.toCore({ type: 'tts', ttsId: s.ttsId, phase: 'failed', synthMs: null, firstAudioMs: null, bargeInMs: null, playedMs: null, cause: null, error: error.slice(0, 500) });
  }

  private end(s: Speech): void {
    if (this.speech === s) this.speech = null;
    if (!this.listening) this.resetVad();
  }
}
