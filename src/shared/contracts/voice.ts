// Voce (Fase 9, VISIONE_ARCHITECTURE §28, DECISIONI P-48…P-50). Tre canali, tutti validati:
//  - processo voce ↔ core, attraverso il main (frame `voice`, relay senza logica): fatti del
//    processo voce verso il core, ordini del core verso il processo voce;
//  - renderer ↔ processo voce: porta dedicata (MessagePort) per l'audio PCM, nei due sensi;
//  - main ↔ core: ciclo di vita del processo voce (il main lo avvia e lo ferma su ordine del core).
// Il core decide (intenti, approvazioni, cosa dire); il processo voce esegue VAD, STT e TTS.
import { z } from 'zod';
import { languageSchema } from './language.ts';

/** Frequenza del PCM catturato (mono, float32). */
export const VOICE_SAMPLE_RATE = 16_000;

export const VOICE_LIMITS = {
  /** Testo trascritto di un enunciato. */
  utteranceChars: 2_000,
  /** Testo da pronunciare in una richiesta. */
  speakChars: 4_000,
  /** Campioni in un messaggio audio della porta (0,5 s a 16 kHz). */
  frameSamples: 8_192,
  /** Campioni in un blocco PCM verso la riproduzione (10 s a 24 kHz). */
  pcmSamples: 240_000,
  /** Byte MP3 in un blocco dal processo voce (Edge, P-84). */
  mp3Bytes: 512_000,
  /** Enunciato più lungo trascritto (oltre: chiuso d'ufficio). */
  maxUtteranceMs: 30_000,
  /**
   * Turno che si chiude da solo (dopo «hey visione», scorciatoia globale): silenzio in più, oltre a quello del
   * VAD, prima di chiuderlo. Senza, una pausa di 0,9 s dopo «ciao» chiudeva il turno (17/10/2026).
   */
  autoEndGraceMs: 1_100,
  /**
   * …ma dopo una frase intera (almeno `autoEndQuickAfterMs` di parlato) basta `autoEndQuickGraceMs`: col margine
   * pieno VISIONE restava muta 2 s (0,9 di VAD + 1,1) prima di trascrivere (misurato il 18/10/2026). Il margine
   * lungo resta per le frasi brevi («ciao…»), quelle che di solito continuano.
   */
  autoEndQuickAfterMs: 1_200,
  autoEndQuickGraceMs: 300,
  /** Frase di wake configurata (P-81). */
  wakePhraseChars: 120
} as const;

const id = z.string().min(1).max(64);
const ms = z.number().nonnegative().max(3_600_000);

export const voiceProcessStateSchema = z.enum(['off', 'starting', 'ready', 'unavailable', 'failed']);
export type VoiceProcessState = z.infer<typeof voiceProcessStateSchema>;

/** Motori in uso, per nome (nessun percorso). */
export const voiceEnginesSchema = z.strictObject({ vad: z.string().max(80), stt: z.string().max(80), tts: z.string().max(80) });
export type VoiceEngines = z.infer<typeof voiceEnginesSchema>;

/** Voce installata nel sistema (Windows): la procedura guidata mostra quelle della lingua scelta. */
export const installedVoiceSchema = z.strictObject({ name: z.string().min(1).max(120), language: z.string().max(20), gender: z.string().max(20) });
export type InstalledVoice = z.infer<typeof installedVoiceSchema>;

/**
 * Filtri dell'ascolto attivi nel processo voce (P-106): pulizia del rumore, modello dell'impronta,
 * impronta del proprietario registrata, «solo il proprietario» acceso.
 */
export const voiceFiltersSchema = z.strictObject({
  denoise: z.boolean(),
  speaker: z.boolean(),
  owner: z.boolean(),
  ownerOnly: z.boolean(),
  noiseGate: z.number().min(0).max(0.2)
});
export type VoiceFilters = z.infer<typeof voiceFiltersSchema>;
export const NO_VOICE_FILTERS: VoiceFilters = { denoise: false, speaker: false, owner: false, ownerOnly: false, noiseGate: 0 };

/** Esito dei filtri su un parlato: troppo debole, proprietario, estraneo, troppo corto per giudicare. */
export const heardOutcomeSchema = z.enum(['quiet', 'owner', 'stranger', 'unverified']);
export type HeardOutcome = z.infer<typeof heardOutcomeSchema>;

/** Registrazione della voce del proprietario: fasi e motivi d'errore (codici: li traduce la UI). */
export const enrollPhaseSchema = z.enum(['started', 'sample', 'saved', 'cleared', 'cancelled', 'error']);
export const enrollErrorSchema = z.enum(['no-model', 'short', 'few', 'quality', 'failed', 'not-started']);
export type EnrollError = z.infer<typeof enrollErrorSchema>;

/** `conversation` (17/10/2026): ascolto riaperto da solo dopo una risposta, senza «hey visione». */
export const pttSourceSchema = z.enum(['ui', 'shortcut', 'wake', 'conversation']);
export type PttSource = z.infer<typeof pttSourceSchema>;

/** Cosa ha fatto il core di un enunciato (evento `voice.intent`). */
export const voiceIntentSchema = z.enum(['goal', 'approve', 'deny', 'stop', 'empty', 'command', 'assistant']);
export type VoiceIntent = z.infer<typeof voiceIntentSchema>;
export const voiceOutcomeSchema = z.enum([
  'submitted',          // obiettivo al Director
  'decided',            // approvazione decisa a voce
  'no-pending',         // "approva" senza richieste in attesa
  'ambiguous',          // più richieste in attesa: si decide dalla UI
  'stopped',            // riproduzione fermata
  'needs-ui',           // approvazione critica: si concede solo dalla UI
  'ignored',            // niente da fare (testo vuoto)
  'commanded',          // comando di ambiente riconosciuto (lo esegue il renderer)
  'assisted',           // richiesta per l'Assistente (promemoria, note, agenda; beta.5)
  'failed'              // il comando interno non è riuscito
]);
export type VoiceOutcome = z.infer<typeof voiceOutcomeSchema>;

/** Azioni dei comandi di ambiente a voce (Fase 22, P-69); le risolve il renderer col contesto UI. */
export const voiceCommandActionSchema = z.enum([
  'open-agent',
  'open-director',
  'open-terminal',
  'close-terminal',
  'close-window',
  'status',
  /** «Trovami il file del contratto» (14/10/2026): il bersaglio sono le parole da cercare nei nomi. */
  'find-file',
  /** «Apri le impostazioni» (17/10/2026): il core riconosce il nome, il bersaglio è il tipo di finestra (`settings`, `training`…). */
  'open-window'
]);
export type VoiceCommandAction = z.infer<typeof voiceCommandActionSchema>;

/** Motivo di una frase pronunciata. */
export const speechReasonSchema = z.enum(['summary', 'approval', 'reply', 'owner', 'reminder']);
export type SpeechReason = z.infer<typeof speechReasonSchema>;

export const interruptCauseSchema = z.enum(['barge-in', 'ptt', 'owner', 'replaced', 'process']);
export type InterruptCause = z.infer<typeof interruptCauseSchema>;

// --- processo voce → core (attraverso il main) ---------------------------------------------------

export const voiceToCoreSchema = z.discriminatedUnion('type', [
  /** Motori caricati: la voce è pronta. */
  z.strictObject({ type: z.literal('ready'), engines: voiceEnginesSchema, loadMs: ms, voices: z.array(installedVoiceSchema).max(100), filters: voiceFiltersSchema }),
  /** Motori non caricabili (modelli assenti, modulo nativo): il processo resta su, la voce no. */
  z.strictObject({ type: z.literal('unavailable'), reason: z.string().max(500) }),
  z.strictObject({ type: z.literal('vad'), phase: z.enum(['start', 'end']), mode: z.enum(['ptt', 'barge-in']), audioMs: ms }),
  /** Enunciato trascritto: durata dell'audio, tempo di decodifica, latenza dalla fine del parlato. */
  z.strictObject({
    type: z.literal('utterance'), utteranceId: id, text: z.string().max(VOICE_LIMITS.utteranceChars),
    audioMs: ms, sttMs: ms, latencyMs: ms
  }),
  z.strictObject({
    type: z.literal('tts'), ttsId: id, phase: z.enum(['started', 'finished', 'interrupted', 'failed']),
    /** Richiesta → primo campione sintetizzato. */
    synthMs: ms.nullable(),
    /** Richiesta → riproduzione iniziata nel renderer. */
    firstAudioMs: ms.nullable(),
    /** Inizio del parlato del proprietario → riproduzione fermata (conferma del renderer). */
    bargeInMs: ms.nullable(),
    playedMs: ms.nullable(),
    cause: interruptCauseSchema.nullable(),
    error: z.string().max(500).nullable()
  }),
  /** Livello RMS del microfono mentre si ascolta (≈ 5 Hz). */
  z.strictObject({ type: z.literal('level'), rms: z.number().min(0).max(1) }),
  /**
   * Wake word riconosciuta (P-81): `command` è il testo dopo la frase ('' = sola frase). `confidence`
   * non esiste per Whisper: non viene inventata (il campo non c'è).
   */
  z.strictObject({
    type: z.literal('wake'), phrase: z.string().min(1).max(VOICE_LIMITS.wakePhraseChars),
    text: z.string().max(VOICE_LIMITS.utteranceChars), command: z.string().max(VOICE_LIMITS.utteranceChars),
    audioMs: ms, sttMs: ms
  }),
  /** Effetto dell'ordine di wake nel processo (o disponibilità all'avvio). */
  z.strictObject({
    type: z.literal('wake-state'), enabled: z.boolean(), phrase: z.string().max(VOICE_LIMITS.wakePhraseChars),
    available: z.boolean(), reason: z.string().max(200).nullable()
  }),
  z.strictObject({ type: z.literal('error'), code: z.string().max(80), message: z.string().max(500) }),
  /**
   * Prova del PC (16/10/2026): una frase sintetizzata con la voce VISIONE senza riprodurla. `rtf` = tempo di
   * calcolo / durata dell'audio (sotto 1 il PC parla più in fretta di quanto serve); null = non misurabile.
   */
  z.strictObject({
    type: z.literal('benchmark'), rtf: z.number().min(0).max(100).nullable(), audioS: z.number().min(0).max(600),
    spentMs: ms, reason: z.string().max(300).nullable()
  }),
  /** Filtri dell'ascolto su un parlato (P-106): cosa è successo e con che somiglianza al proprietario. */
  z.strictObject({ type: z.literal('heard'), mode: z.enum(['ptt', 'wake']), outcome: heardOutcomeSchema, score: z.number().min(-1).max(1).nullable(), audioMs: ms }),
  /** Registrazione della voce del proprietario (P-106): frasi raccolte, salvataggio, errori. */
  z.strictObject({
    type: z.literal('enroll'), phase: enrollPhaseSchema, count: z.number().int().min(0).max(20),
    audioMs: ms.nullable(), quality: z.number().min(-1).max(1).nullable(), reason: enrollErrorSchema.nullable()
  }),
  /** Dal main: il processo voce è partito o è uscito. */
  z.strictObject({
    type: z.literal('process'), phase: z.enum(['starting', 'exited']), pid: z.number().int().nullable(),
    code: z.number().int().nullable(), reason: z.string().max(200)
  })
]);
export type VoiceToCore = z.infer<typeof voiceToCoreSchema>;

// --- core → processo voce (attraverso il main) ---------------------------------------------------

export const coreToVoiceSchema = z.discriminatedUnion('type', [
  /** `autoEnd`: l'enunciato si chiude da solo a fine frase (scorciatoia globale, senza rilascio). */
  z.strictObject({ type: z.literal('ptt'), down: z.boolean(), autoEnd: z.boolean() }),
  z.strictObject({ type: z.literal('speak'), ttsId: id, text: z.string().min(1).max(VOICE_LIMITS.speakChars) }),
  z.strictObject({ type: z.literal('stop'), ttsId: id.nullable(), cause: interruptCauseSchema }),
  /** Wake word: accende/spegne l'ascolto in attesa della frase (P-81). */
  z.strictObject({ type: z.literal('wake'), enabled: z.boolean(), phrase: z.string().min(1).max(VOICE_LIMITS.wakePhraseChars) }),
  /** Registrazione della voce del proprietario (P-106): le frasi arrivano dal push-to-talk. */
  z.strictObject({ type: z.literal('enroll'), action: z.enum(['start', 'save', 'cancel', 'clear', 'probe']) }),
  /** Prova del PC per il profilo della voce (16/10/2026): risponde con `benchmark`. */
  z.strictObject({ type: z.literal('benchmark') }),
  /** Per il main: avvio, arresto o riavvio del processo voce. */
  z.strictObject({ type: z.literal('control'), action: z.enum(['start', 'stop', 'restart']) })
]);
export type CoreToVoice = z.infer<typeof coreToVoiceSchema>;

// --- profilo della voce (16/10/2026) --------------------------------------------------------------

/**
 * Profilo della voce, scelto dal proprietario il 16/10/2026: `full` = voce VISIONE e «hey visione» sempre in
 * ascolto; `light` = voce di Windows e «hey visione»; `minimal` = voce di Windows e solo il tasto, niente
 * ascolto continuo. VISIONE lo consiglia con una prova del PC (`voice.benchmark`).
 */
export const voiceProfileSchema = z.enum(['full', 'light', 'minimal']);
export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

// --- edizione e motori del parlato ammessi (P-104) -----------------------------------------------

/**
 * Edizione: `tester` è l'app installata dall'installer (versione per tester e commerciale),
 * `sviluppo` è l'app avviata dal sorgente. La decide il main (`app.isPackaged`).
 */
export const editionSchema = z.enum(['tester', 'sviluppo']);
export type Edition = z.infer<typeof editionSchema>;
export type TtsProvider = 'visione' | 'windows' | 'kokoro' | 'edge';

/**
 * Nell'edizione `tester` parlano la voce VISIONE inclusa (P-110: Pocket TTS con onnxruntime-node, licenze
 * MIT e CC-BY-4.0) e Windows: Kokoro porta espeak-ng (GPL) e l'installer ha la DLL sherpa-onnx senza
 * sintesi; Edge è un servizio cloud solo per uso personale (P-84).
 */
export const TTS_PROVIDERS: Readonly<Record<Edition, readonly TtsProvider[]>> = {
  tester: ['visione', 'windows'],
  sviluppo: ['visione', 'windows', 'kokoro', 'edge']
};

/** Il motore che parla davvero: quello configurato se l'edizione lo ammette, altrimenti Windows. */
export function effectiveTtsProvider(provider: TtsProvider, edition: Edition): TtsProvider {
  return TTS_PROVIDERS[edition].includes(provider) ? provider : 'windows';
}

// --- main ↔ processo voce (parentPort del utilityProcess) ---------------------------------------

export const voiceProcessConfigSchema = z.strictObject({
  modelsDir: z.string().min(3).max(500),
  /** Cartella della voce VISIONE inclusa nell'installer (P-110): `resources/voce-visione/it` o `vendor/` in sviluppo. */
  voiceDir: z.string().min(3).max(500),
  /** Lingua di VISIONE: lingua dello STT e voce di ripiego (distribuzione mondiale, 10/10/2026). */
  language: languageSchema,
  threads: z.number().int().min(1).max(16),
  speaker: z.enum(['if_sara', 'im_nicola']),
  bargeIn: z.boolean(),
  /**
   * Provider TTS: `visione` (la voce inclusa, P-110), `windows` (voci del sistema, P-103), `kokoro`
   * locale o `edge` (Read Aloud di Edge, P-84) con Kokoro come ripiego.
   */
  tts: z.strictObject({
    provider: z.enum(['visione', 'windows', 'kokoro', 'edge']),
    voice: z.string().min(1).max(120),
    rate: z.string().min(1).max(12),
    pitch: z.string().min(1).max(12)
  }),
  vad: z.strictObject({ threshold: z.number().min(0.1).max(0.95), minSpeechMs: z.number().int().min(30).max(1_000), minSilenceMs: z.number().int().min(100).max(3_000) }),
  /** Wake word (P-81): la VAD dedicata si costruisce con questa soglia. */
  wake: z.strictObject({ enabled: z.boolean(), phrase: z.string().min(1).max(VOICE_LIMITS.wakePhraseChars), sensitivity: z.number().min(0.1).max(0.95) }),
  /** Filtri dell'ascolto (P-106): soglia del rumore, pulizia, solo il proprietario e dove sta la sua impronta. */
  filter: z.strictObject({
    noiseGate: z.number().min(0).max(0.2),
    denoise: z.boolean(),
    ownerOnly: z.strictObject({ enabled: z.boolean(), minScore: z.number().min(0.1).max(0.95), margin: z.number().min(0).max(0.5) }),
    profilePath: z.string().min(3).max(500)
  })
});
export type VoiceProcessConfig = z.infer<typeof voiceProcessConfigSchema>;

export const mainToVoiceSchema = z.discriminatedUnion('kind', [
  /** Primo messaggio: configurazione e caricamento dei motori. */
  z.strictObject({ kind: z.literal('init'), config: voiceProcessConfigSchema }),
  /** Porta audio verso il renderer (in `ports[0]`); sostituisce la precedente. */
  z.strictObject({ kind: z.literal('port') }),
  /** Ordine del core (mai `control`, che resta al main). */
  z.strictObject({ kind: z.literal('core'), msg: coreToVoiceSchema }),
  z.strictObject({ kind: z.literal('shutdown') })
]);
export type MainToVoice = z.infer<typeof mainToVoiceSchema>;

export const voiceToMainSchema = z.strictObject({ kind: z.literal('core'), msg: voiceToCoreSchema });
export type VoiceToMain = z.infer<typeof voiceToMainSchema>;

// --- renderer ↔ processo voce (porta audio) ------------------------------------------------------

const samples = (max: number) => z.instanceof(Float32Array).refine((a) => a.length > 0 && a.length <= max, `da 1 a ${max} campioni`);
const audioBytes = (max: number) => z.instanceof(Uint8Array).refine((a) => a.length > 0 && a.length <= max, `da 1 a ${max} byte`);

export const rendererToVoiceSchema = z.discriminatedUnion('t', [
  /** PCM del microfono a 16 kHz. */
  z.strictObject({ t: z.literal('audio'), samples: samples(VOICE_LIMITS.frameSamples) }),
  /** Stato della riproduzione di una frase. */
  z.strictObject({ t: z.literal('playback'), ttsId: id, phase: z.enum(['started', 'ended', 'stopped']) })
]);
export type RendererToVoice = z.infer<typeof rendererToVoiceSchema>;

export const voiceToRendererSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('pcm'), ttsId: id, sampleRate: z.number().int().min(8_000).max(48_000), samples: samples(VOICE_LIMITS.pcmSamples), last: z.boolean() }),
  /** Blocco MP3 (Edge, P-84): il renderer lo decodifica con Web Audio. */
  z.strictObject({ t: z.literal('mp3'), ttsId: id, bytes: audioBytes(VOICE_LIMITS.mp3Bytes), last: z.boolean() }),
  /** Fine dei blocchi di una frase senza audio in più. */
  z.strictObject({ t: z.literal('end'), ttsId: id }),
  /** Ferma subito la riproduzione (barge-in, PTT, comando). */
  z.strictObject({ t: z.literal('stop'), ttsId: id.nullable() })
]);
export type VoiceToRenderer = z.infer<typeof voiceToRendererSchema>;

// --- stato (sezione `voice` dello snapshot del core) ---------------------------------------------

/** Wake word (P-81): configurazione applicata al processo e suo stato reale. */
export const voiceWakeStateSchema = z.strictObject({
  enabled: z.boolean(),
  phrase: z.string().max(VOICE_LIMITS.wakePhraseChars),
  /** La VAD dedicata esiste nel processo voce. */
  available: z.boolean(),
  /** Push-to-talk armato dalla wake: in attesa del comando (timeout). */
  armed: z.boolean()
});
export type VoiceWakeState = z.infer<typeof voiceWakeStateSchema>;

export const voiceStateSchema = z.strictObject({
  status: voiceProcessStateSchema,
  since: z.number().int().nonnegative(),
  reason: z.string().max(500).nullable(),
  pid: z.number().int().nullable(),
  engines: voiceEnginesSchema.nullable(),
  /** Push-to-talk premuto: il processo voce trascrive. */
  listening: z.boolean(),
  /** Frase in riproduzione. */
  speaking: id.nullable(),
  lastUtterance: z.strictObject({ text: z.string().max(VOICE_LIMITS.utteranceChars), at: z.number().int() }).nullable(),
  wake: voiceWakeStateSchema,
  /** Voci installate nel sistema (vuoto finché la voce non è pronta o con un motore senza elenco). */
  voices: z.array(installedVoiceSchema).max(100),
  /** Filtri dell'ascolto attivi nel processo voce (P-106). */
  filters: voiceFiltersSchema,
  /** Con chi parla la voce (15/10/2026): l'agente scelto, o null = il Director. */
  talkTo: id.nullable()
});
export type VoiceState = z.infer<typeof voiceStateSchema>;
