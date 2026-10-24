// Impostazioni comprensibili (P-94): etichette in italiano, spiegazione breve e tooltip per ogni voce,
// raggruppamento per sezioni. Nessun campo finto: ogni voce è una foglia reale della configurazione
// caricata dal core (`config.get`), salvata con `config.update` (la mappatura etichette→config è pura e
// testata). I percorsi con un controllo dedicato (wake, sfondo desktop, scena, riduzione del movimento)
// restano fuori dalla griglia per non duplicarli.
// Inglese (11/10/2026): il testo italiano resta quello di sempre (`SETTING_META`, `SETTING_SECTIONS`, ...);
// accanto ci sono le tabelle inglesi e le funzioni prendono una lingua facoltativa (default `it`), così chi
// le chiama senza ottiene esattamente il testo di prima. Un test verifica che ogni voce abbia l'inglese.
import type { Edition, Language, TtsProvider } from '../../shared/contracts/index.ts';
import { translate } from '../lib/i18n/index.ts';

/**
 * Motori del parlato ammessi per edizione: specchio di `TTS_PROVIDERS` dei contratti (il renderer
 * importa solo tipi). Un test li tiene uguali.
 */
export const TTS_PROVIDERS_UI: Readonly<Record<Edition, readonly TtsProvider[]>> = {
  tester: ['visione', 'windows'],
  sviluppo: ['visione', 'windows', 'kokoro', 'edge']
};

export interface SettingLeaf {
  path: string;
  value: string | number | boolean;
}

/** Le foglie modificabili della configurazione (array e null esclusi: non hanno un editor semplice). */
/** Agenti in modalità fiducia nella configurazione caricata (P-102): solo dati reali, mai stimati. */
export function trustedAgentsOf(config: Record<string, unknown>): string[] {
  const policy = config.policy;
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return [];
  const list = (policy as Record<string, unknown>).trustedAgents;
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
}

/** Chi comanda (P-105): è sempre in fiducia (24/10/2026), il suo interruttore resta acceso e bloccato. */
export function leadAgentOf(config: Record<string, unknown>): string | null {
  const director = config.director;
  if (director === null || typeof director !== 'object' || Array.isArray(director)) return null;
  const id = (director as Record<string, unknown>).plannerAgentId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** Nuovo elenco degli agenti in fiducia dopo un interruttore (senza doppioni, ordine stabile). */
export function withTrust(current: readonly string[], agentId: string, trusted: boolean): string[] {
  return trusted ? [...new Set([...current, agentId])] : current.filter((id) => id !== agentId);
}

export function leaves(obj: unknown, prefix = ''): SettingLeaf[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const out: SettingLeaf[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (k === 'version' && !prefix) continue;
    // La wake ha il suo toggle dedicato (con effetto immediato): non si duplica nella griglia (P-81).
    if (path === 'voice.wake.enabled') continue;
    // Lo sfondo desktop ha il suo toggle dedicato (P-85): richiede il riavvio dell'APP, non del core.
    if (path === 'ui.desktop') continue;
    // La variante di scena ha il suo selettore dedicato (P-89, effetto immediato nel renderer).
    if (path === 'ui.scene') continue;
    // 11/10/2026: la durata dei nodi a schermo ha il suo cursore dedicato (effetto immediato).
    if (path === 'ui.nodeLingerSec') continue;
    // P-99: il nome del Director ha la riga dedicata nella sezione dei nomi.
    if (path === 'ui.directorName') continue;
    // 11/10/2026: la modalità esperto ha il suo interruttore in cima alle Impostazioni.
    if (path === 'ui.expert') continue;
    // La guida si rivede dallo Start: lo stato «già vista» non è un'impostazione.
    if (path === 'ui.guideSeen') continue;
    // P-105: lo stato della procedura guidata si cambia solo dalla procedura (pulsante dedicato).
    if (path === 'setup.completedVersion') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out.push({ path, value: v });
    else out.push(...leaves(v, path));
  }
  return out;
}

/** Durata dei nodi conclusi a schermo (`ui.nodeLingerSec`), in secondi: 30 se assente o non valida. */
export const NODE_LINGER_MIN_SEC = 5;
export const NODE_LINGER_MAX_SEC = 600;
/** Volume della voce in percento (`voice.volume`), 250 se assente o non valido. */
export function voiceVolumeOf(config: Record<string, unknown>): number {
  const voice = config.voice;
  const raw = voice !== null && typeof voice === 'object' && !Array.isArray(voice) ? (voice as Record<string, unknown>).volume : undefined;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(400, Math.max(50, Math.round(raw))) : 250;
}

export function nodeLingerOf(config: Record<string, unknown>): number {
  const ui = config.ui;
  const raw = ui !== null && typeof ui === 'object' && !Array.isArray(ui) ? (ui as Record<string, unknown>).nodeLingerSec : undefined;
  return typeof raw === 'number' && Number.isFinite(raw) ? clampLinger(raw) : 30;
}
/** Riporta un valore scelto nei limiti accettati dalla configurazione (intero, 5…600 s). */
export function clampLinger(sec: number): number {
  if (!Number.isFinite(sec)) return 30;
  return Math.min(NODE_LINGER_MAX_SEC, Math.max(NODE_LINGER_MIN_SEC, Math.round(sec)));
}

export interface SettingSection {
  id: string;
  label: string;
  help: string;
}

/** Sezioni mostrate nell'ordine d'uso; ogni foglia ha una sezione esplicita nella mappatura. */
export const SETTING_SECTIONS: readonly SettingSection[] = [
  { id: 'logging', label: 'Registro', help: 'Il registro degli eventi e quanto è dettagliato.' },
  { id: 'supervisor', label: 'Supervisore', help: 'Il processo che tiene in vita il core e lo riavvia se cade.' },
  { id: 'runtime', label: 'Runtime', help: 'Come VISIONE avvia e chiude i processi (CLI, terminali, aggiornamenti).' },
  { id: 'director', label: 'Director', help: 'L\'orchestrazione: quanti task in parallelo, timeout e tentativi.' },
  { id: 'agents', label: 'Agenti', help: 'Gli agenti creati all\'avvio e i loro modelli.' },
  { id: 'memory', label: 'Memoria', help: 'Quanto contesto ricordato entra nei turni e la riflessione della memoria.' },
  { id: 'voice', label: 'Voce', help: 'Ascolto, parlato, wake word e sintesi vocale.' },
  { id: 'system', label: 'Sistema', help: 'Telemetria locale e i limiti dei comandi tra UI e core.' },
  { id: 'ui', label: 'Interfaccia', help: 'Finestra, schermo intero e avvio con Windows.' },
  { id: 'offline', label: 'Modalità offline', help: 'Senza rete: il modello locale per le cose di base.' },
  { id: 'other', label: 'Altro', help: 'Voci della configurazione senza una descrizione dedicata.' }
];

/** Le sezioni nella lingua indicata (default italiano: la lista di sempre). */
export function settingSections(lang: Language = 'it'): readonly SettingSection[] {
  if (lang === 'it') return SETTING_SECTIONS;
  return SETTING_SECTIONS.map((s) => ({ id: s.id, ...(SECTIONS_EN[s.id] ?? { label: s.label, help: s.help }) }));
}

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingMeta {
  /** Etichetta breve in italiano. */
  label: string;
  /** Cosa fa la voce e cosa cambia nel comportamento reale. */
  help: string;
  section: string;
  /** Per i campi a scelta ESATTA: valori ammessi dal contratto, con nome leggibile (select). */
  options?: readonly SettingOption[];
  /**
   * P-95: per i campi con valori CONSIGLIATI ma aperti (voce Edge, velocità, tono, modelli):
   * si mostrano come combobox (`<input list>` + `<datalist>`), così si sceglie un suggerimento
   * reale OPPURE si scrive un valore personalizzato, che resta la fonte di verità.
   */
  suggestions?: readonly SettingOption[];
}

/**
 * Voci italiane reali: Cosimo ed Elsa di Windows (OneCore, elencate dal sistema il 07/10/2026,
 * P-103) e quelle del servizio Edge (verificate il 06/10/2026): Diego, Elsa, Isabella e Giuseppe
 * (multilingua). Sono SUGGERIMENTI: il campo accetta anche un nome scritto a mano, che resta il valore salvato.
 */
export const IT_VOICES: readonly SettingOption[] = [
  // Voci di Windows (P-103): installate con l'italiano del sistema, usate dal motore «Windows».
  { value: 'Microsoft Cosimo', label: 'Cosimo — Windows (maschile)' },
  { value: 'Microsoft Elsa', label: 'Elsa — Windows (femminile)' },
  { value: 'it-IT-DiegoNeural', label: 'Diego (maschile)' },
  { value: 'it-IT-ElsaNeural', label: 'Elsa (femminile)' },
  { value: 'it-IT-IsabellaNeural', label: 'Isabella (femminile)' },
  { value: 'it-IT-GiuseppeMultilingualNeural', label: 'Giuseppe (maschile, multilingua)' }
];

/** Prosdia Edge: variazioni percentuali sensate (es. `+8%`, `-10%`); si può scrivere altro. */
export const TTS_RATE_PRESETS: readonly SettingOption[] = [
  { value: '+0%', label: '+0% (invariata)' },
  { value: '+5%', label: '+5% (più veloce)' },
  { value: '-5%', label: '-5% (più lenta)' },
  { value: '+10%', label: '+10% (più veloce)' },
  { value: '-10%', label: '-10% (più lenta)' }
];

/** Tono Edge in Hz (es. `-2Hz`); si può scrivere altro. */
export const TTS_PITCH_PRESETS: readonly SettingOption[] = [
  { value: '-2Hz', label: '-2Hz (più grave)' },
  { value: '0', label: '0 (invariato)' },
  { value: '+2Hz', label: '+2Hz (più acuto)' }
];

/** Le voci della config che sono un MODELLO (`provider/modello`): suggerite dagli agenti reali. */
export const MODEL_PATHS: ReadonlySet<string> = new Set(['agents.defaultModel', 'agents.coder.model', 'agents.ultra.model']);

/** Suggerimenti di modello dai modelli REALI configurati negli agenti (dedup, vuoti esclusi). */
export function modelSuggestions(models: readonly string[]): SettingOption[] {
  const seen = new Set<string>();
  const out: SettingOption[] = [];
  for (const raw of models) {
    const value = raw.trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: value });
  }
  return out;
}

/** Mappatura percorso→etichetta/spiegazione. Ogni foglia reale della config ha la sua voce. */
export const SETTING_META: Readonly<Record<string, SettingMeta>> = {
  'logging.level': {
    label: 'Livello dei log', section: 'logging',
    help: 'Quanto è dettagliato il registro: «error» solo errori, «debug» tutto. In uso: info.',
    options: [
      { value: 'debug', label: 'debug — tutto (verboso)' },
      { value: 'info', label: 'info — normale (consigliato)' },
      { value: 'warn', label: 'warn — solo avvisi ed errori' },
      { value: 'error', label: 'error — solo errori' }
    ],
    // P-95: combobox — si sceglie un livello reale del contratto o se ne scrive uno (validato dal core).
    suggestions: [
      { value: 'debug', label: 'debug — tutto (verboso)' },
      { value: 'info', label: 'info — normale (consigliato)' },
      { value: 'warn', label: 'warn — solo avvisi ed errori' },
      { value: 'error', label: 'error — solo errori' }
    ]
  },

  'supervisor.heartbeatIntervalMs': {
    label: 'Battito ogni (ms)', section: 'supervisor',
    help: 'Ogni quanti millisecondi il supervisore verifica che il core sia vivo.'
  },
  'supervisor.heartbeatTimeoutMs': {
    label: 'Attesa massima del battito (ms)', section: 'supervisor',
    help: 'Se il core non risponde entro questo tempo, il supervisore lo considera bloccato e lo riavvia.'
  },
  'supervisor.startTimeoutMs': {
    label: 'Avvio massimo (ms)', section: 'supervisor',
    help: 'Quanto può metterci il core ad avviarsi prima di essere considerato fallito.'
  },
  'supervisor.stopTimeoutMs': {
    label: 'Arresto massimo (ms)', section: 'supervisor',
    help: 'Quanto si aspetta la chiusura ordinata del core prima di forzare.'
  },
  'supervisor.maxRestarts': {
    label: 'Riavvii massimi', section: 'supervisor',
    help: 'Quante volte il supervisore può riavviare il core dentro la finestra qui sotto.'
  },
  'supervisor.restartWindowMs': {
    label: 'Finestra dei riavvii (ms)', section: 'supervisor',
    help: 'Periodo entro cui si contano i riavvii: superato il tetto, il supervisore si ferma.'
  },

  'runtime.stopGraceMs': {
    label: 'Chiusura gentile dei processi (ms)', section: 'runtime',
    help: 'Quanto si aspetta che una CLI esca da sola prima della chiusura forzata.'
  },
  'runtime.maxProcesses': {
    label: 'Processi massimi', section: 'runtime',
    help: 'Tetto dei processi (CLI, terminali, probe) che il runtime può tenere in vita insieme.'
  },
  'runtime.versionTimeoutMs': {
    label: 'Timeout versione CLI (ms)', section: 'runtime',
    help: 'Tempo massimo concesso a una CLI per rispondere alla verifica della versione.'
  },
  'runtime.hookResponseMs': {
    label: 'Timeout risposta hook (ms)', section: 'runtime',
    help: 'Tempo massimo perché un hook di un motore risponda prima di essere considerato in errore.'
  },

  'director.maxConcurrentTasks': {
    label: 'Task in parallelo', section: 'director',
    help: 'Quanti task il Director può eseguire contemporaneamente (ogni agente ne svolge uno alla volta).'
  },
  'director.taskTimeoutMs': {
    label: 'Timeout di un tentativo (ms)', section: 'director',
    help: 'Dopo questo tempo il tentativo di un task viene marcato come scaduto.'
  },
  'director.maxAttempts': {
    label: 'Tentativi per task', section: 'director',
    help: 'Quante volte un task fallito viene ritentato prima di essere dichiarato fallito.'
  },
  'director.outboxScanMs': {
    label: 'Scansione outbox (ms)', section: 'director',
    help: 'Ogni quanto il Director cerca file di risultato lasciati nella cartella outbox di riserva.'
  },
  'director.plannerAgentId': {
    label: 'Chi comanda (agente che pianifica)', section: 'director',
    help: 'Identificativo dell\'agente che scompone gli obiettivi in compiti per gli altri (si sceglie nella procedura guidata). Vuoto = il Director pianifica con regole fisse. Vale subito.'
  },

  'agents.seedDefaults': {
    label: 'Crea gli agenti di base all\'avvio', section: 'agents',
    help: 'Se il registro è vuoto, all\'avvio crea gli agenti predefiniti (Director, Esecutore, ...).'
  },
  'agents.defaultModel': {
    label: 'Modello predefinito', section: 'agents',
    help: 'Modello (provider/modello) per gli agenti senza modello proprio; vuoto = nessun modello e agenti non eseguibili.'
  },
  'agents.limitFallback.enabled': {
    label: 'Ripiego automatico al limite', section: 'agents',
    help: 'Se un motore raggiunge la quota, il Director reinstrada lo stesso task su un agente alternativo.'
  },
  'agents.limitFallback.agentId': {
    label: 'Agente di ripiego', section: 'agents',
    help: 'Id dell\'agente preferito per il ripiego quando un motore raggiunge il limite.'
  },
  'agents.limitFallback.name': {
    label: 'Nome del ripiego', section: 'agents',
    help: 'Nome mostrato per l\'agente di ripiego creato automaticamente.'
  },
  'agents.coder.enabled': {
    label: 'Crea l\'agente «coder» all\'avvio', section: 'agents',
    help: 'Garantisce un agente di coding: creato solo se un adapter dichiara il modello, mai sovrascritto.'
  },
  'agents.coder.agentId': { label: 'Id dell\'agente coder', section: 'agents', help: 'Identificatore dell\'agente di coding garantito all\'avvio.' },
  'agents.coder.name': { label: 'Nome del coder', section: 'agents', help: 'Nome mostrato per l\'agente di coding.' },
  'agents.coder.model': {
    label: 'Modello del coder', section: 'agents',
    help: 'Modello (provider/modello) del coder; vuoto = usa il modello predefinito qui sopra.'
  },
  'agents.ultra.enabled': {
    label: 'Crea l\'agente «ultra» all\'avvio', section: 'agents',
    help: 'Garantisce l\'agente analista: creato solo con un modello dichiarato da un adapter, mai sovrascritto.'
  },
  'agents.ultra.agentId': { label: 'Id dell\'agente ultra', section: 'agents', help: 'Identificatore dell\'agente analista garantito all\'avvio.' },
  'agents.ultra.name': { label: 'Nome di ultra', section: 'agents', help: 'Nome mostrato per l\'agente analista.' },
  'agents.ultra.model': {
    label: 'Modello di ultra', section: 'agents',
    help: 'Modello (provider/modello) dell\'analista; vuoto = agente non creato (nessun modello inventato).'
  },

  'memory.briefMaxChars': {
    label: 'Dimensione massima del brief (caratteri)', section: 'memory',
    help: 'Tetto del contesto inviato all\'agente a ogni turno; le sezioni meno importanti si troncano per prime.'
  },
  'memory.searchLimit': {
    label: 'Ricordi pertinenti nel brief', section: 'memory',
    help: 'Quanti elementi trovati nella memoria entrano nel brief di un turno (0 = nessuno).'
  },
  'memory.reflectAtChars': {
    label: 'Soglia di riflessione di memory.md (caratteri)', section: 'memory',
    help: 'Oltre questa dimensione, la memoria dell\'agente viene riassunta dopo il turno.'
  },
  'memory.keepRecentSections': {
    label: 'Sezioni recenti conservate', section: 'memory',
    help: 'Quante sezioni recenti non fissate restano intatte quando la memoria viene riassunta.'
  },
  'memory.summaryMaxChars': {
    label: 'Tetto del riassunto (caratteri)', section: 'memory',
    help: 'Dimensione massima del riassunto ricorsivo della memoria.'
  },

  'voice.enabled': {
    label: 'Avvia la voce con l\'app', section: 'voice',
    help: 'Avvia il processo locale di voce; senza modelli resta «non disponibile» senza costi.'
  },
  'voice.modelsDir': {
    label: 'Cartella dei modelli vocali', section: 'voice',
    help: 'Dove VISIONE cerca i modelli voce; vuoto = cartella predefinita nella home di VISIONE.'
  },
  'voice.speaker': {
    label: 'Voce Kokoro', section: 'voice',
    help: 'Voce locale usata dal motore Kokoro (e come ripiego quando Edge fallisce).',
    options: [
      { value: 'if_sara', label: 'Sara (femminile)' },
      { value: 'im_nicola', label: 'Nicola (maschile)' }
    ]
  },
  'voice.threads': { label: 'Thread della voce', section: 'voice', help: 'Quanti core della CPU può usare il motore voce locale.' },
  'voice.bargeIn': {
    label: 'Il parlato interrompe VISIONE', section: 'voice',
    help: 'Se parli mentre VISIONE sta parlando, la sua voce si ferma subito.'
  },
  'voice.pttShortcut': {
    label: 'Scorciatoia push-to-talk', section: 'voice',
    help: 'Scorciatoia globale che avvia l\'ascolto e si chiude a fine frase (es. Control+Alt+Space).'
  },
  'voice.announceStartup': {
    label: 'Annuncio all\'avvio', section: 'voice',
    help: 'Alla prima disponibilità della voce, VISIONE pronuncia la frase di avvio.'
  },
  'voice.startupPhrase': { label: 'Frase di benvenuto', section: 'voice', help: 'La prima frase che VISIONE dice quando la voce è pronta (es. «{saluto} signore, bentornato.»: {saluto} diventa buongiorno, buon pomeriggio o buonasera).' },
  'voice.startupBriefing': {
    label: 'Saluto con lo stato del PC', section: 'voice',
    help: 'Dopo la frase di benvenuto VISIONE dice come sta il PC, se i motori rispondono, i lavori da terminare, le approvazioni in attesa e gli impegni di oggi.'
  },
  'voice.volume': {
    label: 'Volume della voce (%)', section: 'voice',
    help: 'Quanto forte parla VISIONE: 100 = basso, 250 = alto, 400 = massimo. Ogni frase e ogni voce vengono portate allo stesso livello e un limitatore evita le distorsioni. Vale subito.'
  },
  'voice.vadThreshold': {
    label: 'Soglia di voce (VAD)', section: 'voice',
    help: 'Quanto deve essere forte il suono per essere considerato parlato (0,1–0,95: più alto = più severo).'
  },
  'voice.minSpeechMs': { label: 'Parlato minimo (ms)', section: 'voice', help: 'Durata minima di un suono per essere considerato inizio di parlato.' },
  'voice.minSilenceMs': { label: 'Silenzio per fine frase (ms)', section: 'voice', help: 'Quanto silenzio chiude una frase durante l\'ascolto.' },
  'voice.followUpMs': { label: 'Resta in ascolto dopo una risposta (ms)', section: 'voice', help: 'Finita una risposta detta, VISIONE ti ascolta ancora così a lungo senza «Hey Visione», per continuare la conversazione. 0 = spento.' },
  'voice.speakSummaries': {
    label: 'Legge la sintesi degli obiettivi', section: 'voice',
    help: 'VISIONE legge ad alta voce il riepilogo degli obiettivi che le dai.'
  },
  'voice.announceApprovals': {
    label: 'Annuncia le approvazioni', section: 'voice',
    help: 'VISIONE avvisa a voce quando una richiesta di approvazione è in attesa.'
  },
  'voice.noiseGate': {
    label: 'Soglia del rumore', section: 'voice',
    help: 'Volume minimo (RMS, 0–0,2) perché un parlato venga trascritto: più alta, più rumore e voci lontane vengono ignorati. La procedura guidata la misura dal rumore della tua stanza.'
  },
  'voice.denoise': {
    label: 'Pulizia del rumore', section: 'voice',
    help: 'Prima di trascrivere, VISIONE ripulisce l\'audio dal rumore di fondo (modello GTCRN locale, da scaricare dalla procedura guidata).'
  },
  'voice.ownerOnly.enabled': {
    label: 'Ascolta solo il proprietario', section: 'voice',
    help: 'VISIONE risponde solo alla tua voce (impronta registrata dalla procedura guidata, salvata solo su questo PC): le altre voci vengono ignorate.'
  },
  'voice.ownerOnly.minScore': {
    label: 'Somiglianza minima alla tua voce', section: 'voice',
    help: 'Quanto un parlato deve somigliare alla tua impronta (0,1–0,95). Tarata a 0,40 su voci reali: più alta = più severa.'
  },
  'voice.ownerOnly.margin': {
    label: 'Margine sulle altre voci', section: 'voice',
    help: 'Di quanto la tua voce deve battere le voci di riferimento (inclusa quella di VISIONE). Tarato a 0,05.'
  },
  'voice.tts.provider': {
    label: 'Motore del parlato', section: 'voice',
    help: 'VISIONE è la voce inclusa nel programma (locale, nessun download, voce maschile con effetto «assistente digitale»); Windows usa le voci italiane già installate nel sistema (locale, nessun download); Kokoro è locale e gratuito ma richiede il modello; Edge usa il servizio Read Aloud di Microsoft (cloud, senza chiave, solo uso personale) con Kokoro come ripiego.',
    options: [
      { value: 'visione', label: 'VISIONE — voce inclusa (consigliata)' },
      { value: 'windows', label: 'Windows — voci del sistema' },
      { value: 'kokoro', label: 'Kokoro — locale' },
      { value: 'edge', label: 'Edge — cloud Microsoft (ripiego locale)' }
    ]
  },
  'voice.tts.voice': {
    label: 'Nome voce (Windows/Edge)', section: 'voice',
    help: 'La voce italiana: Cosimo ed Elsa per il motore Windows, le altre per Edge. Si può scrivere un altro nome; con Windows, un nome che non esiste usa la prima voce italiana installata.',
    suggestions: IT_VOICES
  },
  'voice.tts.rate': {
    label: 'Velocità del parlato (Windows/Edge)', section: 'voice',
    help: 'Variazione di velocità per Windows ed Edge (es. +8% o -10%): scegli un preset o scrivi il tuo.',
    suggestions: TTS_RATE_PRESETS
  },
  'voice.tts.pitch': {
    label: 'Tono del parlato (Edge)', section: 'voice',
    help: 'Variazione di tono per Edge (es. -2Hz): scegli un preset o scrivi il tuo.',
    suggestions: TTS_PITCH_PRESETS
  },
  'voice.wake.phrase': {
    label: 'Frase di attivazione', section: 'voice',
    help: 'La frase che sveglia VISIONE, con tolleranza di pronuncia (es. «hey visione»).'
  },
  'voice.wake.sensitivity': {
    label: 'Sensibilità della wake', section: 'voice',
    help: 'Soglia della VAD dedicata alla frase di attivazione (0,1–0,95).'
  },
  'voice.wake.commandTimeoutMs': {
    label: 'Attesa del comando (ms)', section: 'voice',
    help: 'Dopo la sola frase di attivazione, quanto si aspetta il comando prima di disarmare il microfono.'
  },

  'offline.auto': {
    label: 'Modalità offline automatica', section: 'offline',
    help: 'Quando cade la rete le richieste di base vanno al modello locale, con un avviso; spento = solo col tasto.'
  },
  'offline.modelsDir': {
    label: 'Cartella del modello offline', section: 'offline',
    help: 'Dove VISIONE tiene il modello locale; vuoto = cartella predefinita nella home di VISIONE.'
  },

  'telemetry.enabled': {
    label: 'Telemetria di sistema', section: 'system',
    help: 'Campiona CPU, RAM, disco e rete per HUD e pannello Sistema.'
  },
  'telemetry.intervalMs': { label: 'Intervallo dei campioni (ms)', section: 'system', help: 'Ogni quanto viene letto un campione di sistema (l\'aggregato resta al minuto).' },
  'telemetry.system': {
    label: 'Sensori Windows (GPU, rete)', section: 'system',
    help: 'Usa PowerShell per leggere GPU, VRAM e rete di Windows; disattivalo se non servono.'
  },
  'telemetry.sensors.enabled': {
    label: 'Temperature dai sensori esterni', section: 'system',
    help: 'Legge le temperature da un provider locale opzionale (LibreHardwareMonitor).'
  },
  'telemetry.sensors.url': {
    label: 'Indirizzo del provider (solo loopback)', section: 'system',
    help: 'Indirizzo del provider di sensori; è consentito solo su 127.0.0.1 (nessun host esterno).'
  },

  'ui.fullscreen': {
    label: 'Avvio a schermo intero', section: 'ui',
    help: 'La finestra parte a tutto schermo; F11 (o «Schermo intero») commuta. Vale dal prossimo avvio dell\'app.'
  },
  'ui.startWithWindows': {
    label: 'Avvia VISIONE con Windows', section: 'ui',
    help: 'VISIONE si apre da sola quando accedi a Windows (solo nella build installata). Vale subito; reversibile da qui o da Gestione attività.'
  },
  'ui.light': {
    label: 'Modalità leggera', section: 'ui',
    help: 'Per i PC meno potenti: la scena usa meno dettagli e meno fotogrammi, l\'Umanoide si muove più piano e la webcam resta spenta. Vale subito.'
  },
  'ui.weatherCity': {
    label: 'Città del meteo', section: 'ui',
    help: 'La città del widget Meteo; la usa anche il saluto all\'avvio. Vuota: nessuna richiesta meteo.'
  },

  'ipc.commandTimeoutMs': {
    label: 'Timeout dei comandi UI→core (ms)', section: 'system',
    help: 'Tempo massimo perché un comando della UI riceva risposta dal core prima di scadere.'
  }
};

const OTHER: SettingMeta = {
  label: '', section: 'other',
  help: 'Voce reale della configurazione senza descrizione dedicata: il valore è quello del file.'
};

/**
 * Meta di una voce nella lingua indicata (default italiano, identica a prima): se il percorso non è
 * mappato, l'etichetta resta il percorso (nessuna invenzione). Una voce senza inglese ricade
 * sull'italiano, mai su un testo vuoto.
 */
export function settingMeta(path: string, lang: Language = 'it'): SettingMeta {
  const base = SETTING_META[path];
  if (lang === 'it') return base ?? { ...OTHER, label: path };
  if (!base) return { ...OTHER, label: path, help: translate(lang, 'settings.field.otherHelp') };
  const en = SETTING_META_EN[path];
  if (!en) return base;
  return {
    ...base,
    label: en.label,
    help: en.help,
    ...(base.options ? { options: base.options.map((o) => ({ value: o.value, label: en.choices?.[o.value] ?? o.label })) } : {}),
    ...(en.suggestions ? { suggestions: en.suggestions } : base.suggestions ? { suggestions: base.suggestions.map((o) => ({ value: o.value, label: en.choices?.[o.value] ?? o.label })) } : {})
  };
}

/**
 * Tabella percorso→{etichetta, spiegazione} nella lingua, per la ricerca dello Start. In italiano è
 * `SETTING_META` stessa; l'inglese si costruisce una volta sola.
 */
const searchTables: Partial<Record<Language, Readonly<Record<string, { readonly label: string; readonly help: string }>>>> = {};
export function settingSearchTable(lang: Language = 'it'): Readonly<Record<string, { readonly label: string; readonly help: string }>> {
  if (lang === 'it') return SETTING_META;
  const cached = searchTables[lang];
  if (cached) return cached;
  const built = Object.fromEntries(Object.keys(SETTING_META).map((path) => {
    const m = settingMeta(path, lang);
    return [path, { label: m.label, help: m.help }];
  }));
  searchTables[lang] = built;
  return built;
}

/**
 * Scelte esatte di una voce per l'edizione (P-104): per il motore del parlato solo quelli ammessi
 * (nella `tester` la voce VISIONE e Windows). Un valore già scritto in config ma non ammesso resta visibile e
 * dichiarato, invece di sparire: in quel caso parla Windows.
 */
export function optionsFor(path: string, edition: Edition, current: string, lang: Language = 'it'): readonly SettingOption[] | undefined {
  const all = settingMeta(path, lang).options;
  if (!all || path !== 'voice.tts.provider') return all;
  const allowed = all.filter((o) => (TTS_PROVIDERS_UI[edition] as readonly string[]).includes(o.value));
  const unavailable = all.find((o) => o.value === current && !allowed.includes(o));
  return unavailable ? [...allowed, { value: unavailable.value, label: translate(lang, 'settings.field.unavailable', { label: unavailable.label }) }] : allowed;
}

/** Le foglie reali raggruppate per sezione, nell'ordine dichiarato; le sezioni vuote non appaiono. */
export function settingsBySection(config: Record<string, unknown>, lang: Language = 'it'): Array<{ section: SettingSection; items: SettingLeaf[] }> {
  const list = leaves(config);
  const out: Array<{ section: SettingSection; items: SettingLeaf[] }> = [];
  for (const section of settingSections(lang)) {
    const items = list.filter((leaf) => settingMeta(leaf.path).section === section.id);
    if (items.length > 0) out.push({ section, items });
  }
  return out;
}

// --- Inglese -------------------------------------------------------------------------------------------

/** Sezioni in inglese (stessi id di `SETTING_SECTIONS`). */
const SECTIONS_EN: Readonly<Record<string, { label: string; help: string }>> = {
  logging: { label: 'Log', help: 'The event log and how detailed it is.' },
  supervisor: { label: 'Supervisor', help: 'The process that keeps the core alive and restarts it if it goes down.' },
  runtime: { label: 'Runtime', help: 'How VISIONE starts and stops processes (CLIs, terminals, updates).' },
  director: { label: 'Director', help: 'Orchestration: how many tasks in parallel, timeouts and retries.' },
  agents: { label: 'Agents', help: 'The agents created at start-up and their models.' },
  memory: { label: 'Memory', help: 'How much remembered context goes into turns, and the memory reflection.' },
  voice: { label: 'Voice', help: 'Listening, speech, wake word and speech synthesis.' },
  system: { label: 'System', help: 'Local telemetry and the limits of the commands between the UI and the core.' },
  ui: { label: 'Interface', help: 'Window, full screen and start with Windows.' },
  offline: { label: 'Offline mode', help: 'Without network: the local model for the basics.' },
  other: { label: 'Other', help: 'Configuration entries without a dedicated description.' }
};

/**
 * Voci di Windows in inglese (le stesse tipiche che la procedura guidata mostra finché la voce non
 * elenca quelle installate): suggerimenti, il campo accetta comunque un nome scritto a mano.
 */
export const EN_VOICES: readonly SettingOption[] = [
  { value: 'Microsoft David', label: 'David — Windows (male)' },
  { value: 'Microsoft Zira', label: 'Zira — Windows (female)' },
  { value: 'Microsoft Mark', label: 'Mark — Windows (male)' }
];

interface SettingTextEn {
  label: string;
  help: string;
  /** Nomi inglesi delle scelte (`options` e `suggestions`), per valore. */
  choices?: Readonly<Record<string, string>>;
  /** Suggerimenti diversi da quelli italiani (la voce non si traduce, si sostituisce). */
  suggestions?: readonly SettingOption[];
}

const LOG_LEVEL_CHOICES: Readonly<Record<string, string>> = {
  debug: 'debug — everything (verbose)',
  info: 'info — normal (recommended)',
  warn: 'warn — warnings and errors only',
  error: 'error — errors only'
};

/** Testo inglese di ogni voce di `SETTING_META` (stessi percorsi). */
export const SETTING_META_EN: Readonly<Record<string, SettingTextEn>> = {
  'logging.level': {
    label: 'Log level',
    help: 'How detailed the log is: “error” only errors, “debug” everything. Currently: info.',
    choices: LOG_LEVEL_CHOICES
  },

  'supervisor.heartbeatIntervalMs': {
    label: 'Heartbeat every (ms)',
    help: 'How many milliseconds between the supervisor’s checks that the core is alive.'
  },
  'supervisor.heartbeatTimeoutMs': {
    label: 'Maximum heartbeat wait (ms)',
    help: 'If the core does not answer within this time, the supervisor considers it stuck and restarts it.'
  },
  'supervisor.startTimeoutMs': {
    label: 'Maximum start time (ms)',
    help: 'How long the core may take to start before it is considered failed.'
  },
  'supervisor.stopTimeoutMs': {
    label: 'Maximum stop time (ms)',
    help: 'How long to wait for the core to shut down cleanly before forcing it.'
  },
  'supervisor.maxRestarts': {
    label: 'Maximum restarts',
    help: 'How many times the supervisor may restart the core within the window below.'
  },
  'supervisor.restartWindowMs': {
    label: 'Restart window (ms)',
    help: 'Period over which restarts are counted: once the limit is exceeded, the supervisor stops.'
  },

  'runtime.stopGraceMs': {
    label: 'Graceful process shutdown (ms)',
    help: 'How long to wait for a CLI to exit on its own before it is closed by force.'
  },
  'runtime.maxProcesses': {
    label: 'Maximum processes',
    help: 'Cap on the processes (CLIs, terminals, probes) the runtime can keep alive at once.'
  },
  'runtime.versionTimeoutMs': {
    label: 'CLI version timeout (ms)',
    help: 'Maximum time a CLI is given to answer the version check.'
  },
  'runtime.hookResponseMs': {
    label: 'Hook response timeout (ms)',
    help: 'Maximum time for an engine hook to answer before it is treated as failed.'
  },

  'director.maxConcurrentTasks': {
    label: 'Parallel tasks',
    help: 'How many tasks the Director can run at the same time (each agent handles one at a time).'
  },
  'director.taskTimeoutMs': {
    label: 'Attempt timeout (ms)',
    help: 'After this time, a task attempt is marked as timed out.'
  },
  'director.maxAttempts': {
    label: 'Attempts per task',
    help: 'How many times a failed task is retried before it is declared failed.'
  },
  'director.outboxScanMs': {
    label: 'Outbox scan (ms)',
    help: 'How often the Director looks for result files left in the fallback outbox folder.'
  },
  'director.plannerAgentId': {
    label: 'In charge (planning agent)',
    help: 'Identifier of the agent that breaks goals down into tasks for the others (chosen in the setup wizard). Empty = the Director plans with fixed rules. Takes effect immediately.'
  },

  'agents.seedDefaults': {
    label: 'Create the base agents at start-up',
    help: 'If the registry is empty, creates the default agents (Director, Esecutore, ...) at start-up.'
  },
  'agents.defaultModel': {
    label: 'Default model',
    help: 'Model (provider/model) for agents without one of their own; empty = no model and agents cannot run.'
  },
  'agents.limitFallback.enabled': {
    label: 'Automatic fallback at the limit',
    help: 'If an engine reaches its quota, the Director re-routes the same task to an alternative agent.'
  },
  'agents.limitFallback.agentId': {
    label: 'Fallback agent',
    help: 'Id of the agent preferred as a fallback when an engine reaches its limit.'
  },
  'agents.limitFallback.name': {
    label: 'Fallback name',
    help: 'Name shown for the automatically created fallback agent.'
  },
  'agents.coder.enabled': {
    label: 'Create the “coder” agent at start-up',
    help: 'Guarantees a coding agent: created only if an adapter declares the model, never overwritten.'
  },
  'agents.coder.agentId': { label: 'Coder agent id', help: 'Identifier of the coding agent guaranteed at start-up.' },
  'agents.coder.name': { label: 'Coder name', help: 'Name shown for the coding agent.' },
  'agents.coder.model': {
    label: 'Coder model',
    help: 'Model (provider/model) of the coder; empty = use the default model above.'
  },
  'agents.ultra.enabled': {
    label: 'Create the “ultra” agent at start-up',
    help: 'Guarantees the analyst agent: created only with a model declared by an adapter, never overwritten.'
  },
  'agents.ultra.agentId': { label: 'Ultra agent id', help: 'Identifier of the analyst agent guaranteed at start-up.' },
  'agents.ultra.name': { label: 'Ultra name', help: 'Name shown for the analyst agent.' },
  'agents.ultra.model': {
    label: 'Ultra model',
    help: 'Model (provider/model) of the analyst; empty = agent not created (no invented model).'
  },

  'memory.briefMaxChars': {
    label: 'Maximum brief size (characters)',
    help: 'Cap on the context sent to the agent on every turn; the less important sections are truncated first.'
  },
  'memory.searchLimit': {
    label: 'Relevant memories in the brief',
    help: 'How many items found in memory go into a turn’s brief (0 = none).'
  },
  'memory.reflectAtChars': {
    label: 'memory.md reflection threshold (characters)',
    help: 'Above this size, the agent’s memory is summarised after the turn.'
  },
  'memory.keepRecentSections': {
    label: 'Recent sections kept',
    help: 'How many recent unpinned sections are left untouched when the memory is summarised.'
  },
  'memory.summaryMaxChars': {
    label: 'Summary cap (characters)',
    help: 'Maximum size of the recursive memory summary.'
  },

  'voice.enabled': {
    label: 'Start voice with the app',
    help: 'Starts the local voice process; without models it stays “unavailable” at no cost.'
  },
  'voice.modelsDir': {
    label: 'Voice models folder',
    help: 'Where VISIONE looks for voice models; empty = the default folder in the VISIONE home.'
  },
  'voice.speaker': {
    label: 'Kokoro voice',
    help: 'Local voice used by the Kokoro engine (and as a fallback when Edge fails).',
    choices: { if_sara: 'Sara (female)', im_nicola: 'Nicola (male)' }
  },
  'voice.threads': { label: 'Voice threads', help: 'How many CPU cores the local voice engine may use.' },
  'voice.bargeIn': {
    label: 'Speech interrupts VISIONE',
    help: 'If you speak while VISIONE is talking, its voice stops immediately.'
  },
  'voice.pttShortcut': {
    label: 'Push-to-talk shortcut',
    help: 'Global shortcut that starts listening and ends at the end of the sentence (e.g. Control+Alt+Space).'
  },
  'voice.announceStartup': {
    label: 'Start-up announcement',
    help: 'When the voice first becomes available, VISIONE speaks the start-up phrase.'
  },
  'voice.startupPhrase': { label: 'Welcome phrase', help: 'The first phrase VISIONE says when the voice is ready (e.g. “{saluto}, sir. Welcome back.”: {saluto} becomes good morning, good afternoon or good evening).' },
  'voice.startupBriefing': {
    label: 'Greeting with the PC status',
    help: 'After the welcome phrase VISIONE tells you how the PC is doing, whether the engines respond, the jobs left to finish, the approvals waiting and today’s commitments.'
  },
  'voice.volume': {
    label: 'Voice volume (%)',
    help: 'How loud VISIONE speaks: 100 = low, 250 = loud, 400 = maximum. Every sentence and every voice is brought to the same level, and a limiter prevents distortion. Takes effect immediately.'
  },
  'voice.vadThreshold': {
    label: 'Voice threshold (VAD)',
    help: 'How loud a sound must be to count as speech (0.1–0.95: higher = stricter).'
  },
  'voice.minSpeechMs': { label: 'Minimum speech (ms)', help: 'Minimum duration of a sound to count as the start of speech.' },
  'voice.minSilenceMs': { label: 'Silence to end a sentence (ms)', help: 'How much silence ends a sentence while listening.' },
  'voice.followUpMs': { label: 'Keep listening after an answer (ms)', help: 'After a spoken answer, VISIONE keeps listening this long without “Hey Visione”, to continue the conversation. 0 = off.' },
  'voice.speakSummaries': {
    label: 'Reads out goal summaries',
    help: 'VISIONE reads aloud the summary of the goals you give it.'
  },
  'voice.announceApprovals': {
    label: 'Announce approvals',
    help: 'VISIONE tells you by voice when an approval request is waiting.'
  },
  'voice.noiseGate': {
    label: 'Noise threshold',
    help: 'Minimum volume (RMS, 0–0.2) for speech to be transcribed: the higher it is, the more noise and distant voices are ignored. The setup wizard measures it from your room’s noise.'
  },
  'voice.denoise': {
    label: 'Noise cleanup',
    help: 'Before transcribing, VISIONE cleans the background noise out of the audio (local GTCRN model, to be downloaded from the setup wizard).'
  },
  'voice.ownerOnly.enabled': {
    label: 'Listen to the owner only',
    help: 'VISIONE answers only to your voice (voiceprint recorded by the setup wizard, saved only on this PC): other voices are ignored.'
  },
  'voice.ownerOnly.minScore': {
    label: 'Minimum similarity to your voice',
    help: 'How closely speech must resemble your voiceprint (0.1–0.95). Calibrated at 0.40 on real voices: higher = stricter.'
  },
  'voice.ownerOnly.margin': {
    label: 'Margin over other voices',
    help: 'By how much your voice must beat the reference voices (including VISIONE’s own). Calibrated at 0.05.'
  },
  'voice.tts.provider': {
    label: 'Speech engine',
    help: 'VISIONE is the voice built into the program (local, no download, a male voice with a «digital assistant» effect; it speaks Italian); Windows uses the voices already installed in the system (local, no download); Kokoro is local and free but needs the model; Edge uses Microsoft’s Read Aloud service (cloud, no key, personal use only) with Kokoro as a fallback.',
    choices: {
      visione: 'VISIONE — built-in voice (recommended)',
      windows: 'Windows — system voices',
      kokoro: 'Kokoro — local',
      edge: 'Edge — Microsoft cloud (local fallback)'
    }
  },
  'voice.tts.voice': {
    label: 'Voice name (Windows/Edge)',
    help: 'The voice name: for the Windows engine, a voice installed in the system (e.g. Microsoft David or Zira in English, Cosimo or Elsa in Italian); for Edge, one of its cloud voices. You can type another name; with Windows, a name that does not exist uses the first installed voice for the language.',
    suggestions: EN_VOICES
  },
  'voice.tts.rate': {
    label: 'Speech rate (Windows/Edge)',
    help: 'Speed change for Windows and Edge (e.g. +8% or -10%): pick a preset or type your own.',
    choices: {
      '+0%': '+0% (unchanged)',
      '+5%': '+5% (faster)',
      '-5%': '-5% (slower)',
      '+10%': '+10% (faster)',
      '-10%': '-10% (slower)'
    }
  },
  'voice.tts.pitch': {
    label: 'Speech pitch (Edge)',
    help: 'Pitch change for Edge (e.g. -2Hz): pick a preset or type your own.',
    choices: {
      '-2Hz': '-2Hz (lower)',
      '0': '0 (unchanged)',
      '+2Hz': '+2Hz (higher)'
    }
  },
  'voice.wake.phrase': {
    label: 'Wake phrase',
    help: 'The phrase that wakes VISIONE, with tolerance for pronunciation (e.g. “hey visione”).'
  },
  'voice.wake.sensitivity': {
    label: 'Wake sensitivity',
    help: 'Threshold of the VAD dedicated to the wake phrase (0.1–0.95).'
  },
  'voice.wake.commandTimeoutMs': {
    label: 'Command wait (ms)',
    help: 'After the wake phrase alone, how long to wait for the command before disarming the microphone.'
  },

  'offline.auto': {
    label: 'Automatic offline mode',
    help: 'When the network drops, basic requests go to the local model, with a notice; off = only with the button.'
  },
  'offline.modelsDir': {
    label: 'Offline model folder',
    help: 'Where VISIONE keeps the local model; empty = the default folder in the VISIONE home.'
  },

  'telemetry.enabled': {
    label: 'System telemetry',
    help: 'Samples CPU, RAM, disk and network for the HUD and the System panel.'
  },
  'telemetry.intervalMs': { label: 'Sample interval (ms)', help: 'How often a system sample is read (the aggregate stays per minute).' },
  'telemetry.system': {
    label: 'Windows sensors (GPU, network)',
    help: 'Uses PowerShell to read the GPU, VRAM and network figures from Windows; turn it off if you do not need them.'
  },
  'telemetry.sensors.enabled': {
    label: 'Temperatures from external sensors',
    help: 'Reads temperatures from an optional local provider (LibreHardwareMonitor).'
  },
  'telemetry.sensors.url': {
    label: 'Provider address (loopback only)',
    help: 'Address of the sensor provider; only allowed on 127.0.0.1 (no external hosts).'
  },

  'ui.fullscreen': {
    label: 'Start full screen',
    help: 'The window starts full screen; F11 (or “Full screen”) toggles it. Takes effect at the next app start.'
  },
  'ui.startWithWindows': {
    label: 'Start VISIONE with Windows',
    help: 'VISIONE opens by itself when you sign in to Windows (installed build only). Takes effect immediately; reversible from here or from Task Manager.'
  },
  'ui.light': {
    label: 'Light mode',
    help: 'For less powerful PCs: the scene uses less detail and fewer frames, the Humanoid moves more slowly and the webcam stays off. Takes effect immediately.'
  },
  'ui.weatherCity': {
    label: 'Weather city',
    help: 'The city of the Weather widget; the startup greeting uses it too. Empty: no weather requests.'
  },

  'ipc.commandTimeoutMs': {
    label: 'UI→core command timeout (ms)',
    help: 'Maximum time for a UI command to get an answer from the core before it times out.'
  }
};
