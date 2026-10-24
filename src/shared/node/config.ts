// Configurazione versionata (VISIONE_ARCHITECTURE §24): default nel codice → <home>\config\visione.json
// → variabili d'ambiente. Il file contiene solo impostazioni: un valore con forma di segreto viene
// rifiutato. Il file è del core (lo crea se manca); il main lo legge soltanto.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { containsSecret } from '../lib/redact.ts';
import { formatIssues } from '../contracts/events.ts';
import { agentCompetenceSchema } from '../contracts/agents.ts';
import { languageSchema } from '../contracts/language.ts';
import { LOG_LEVELS, isLogLevel } from './logging.ts';

export const CONFIG_VERSION = 1;

const ms = z.number().int().positive();

export const visioneConfigSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION),
  logging: z.strictObject({ level: z.enum(LOG_LEVELS).default('info') }).prefault({}),
  supervisor: z
    .strictObject({
      heartbeatIntervalMs: ms.default(2_000),
      // 30 s (17/10/2026, collaudo su un PC vergine): con 10 s un core solo affamato di CPU (PC al 100%)
      // veniva ucciso e riavviato in circolo; un core bloccato davvero si vede lo stesso.
      heartbeatTimeoutMs: ms.default(30_000),
      startTimeoutMs: ms.default(15_000),
      stopTimeoutMs: ms.default(20_000),
      backoffMs: z.array(z.number().int().nonnegative()).min(1).max(10).default([1_000, 2_000, 4_000, 8_000, 30_000]),
      maxRestarts: z.number().int().min(0).max(100).default(5),
      restartWindowMs: ms.default(120_000)
    })
    .prefault({}),
  ipc: z.strictObject({ commandTimeoutMs: ms.max(600_000).default(30_000) }).prefault({}),
  /** CLI Runtime (Fase 5, VISIONE_SECURITY_MODEL §5). */
  runtime: z
    .strictObject({
      stopGraceMs: ms.max(60_000).default(5_000),
      maxProcesses: z.number().int().min(1).max(256).default(32),
      versionTimeoutMs: ms.max(60_000).default(10_000),
      hookResponseMs: ms.max(30_000).default(4_500)
    })
    .prefault({}),
  /** Director e Task Engine (Fase 6, VISIONE_AGENT_ARCHITECTURE §9-10). */
  director: z
    .strictObject({
      /** Task in esecuzione contemporanea (un agente esegue comunque un task alla volta). */
      maxConcurrentTasks: z.number().int().min(1).max(32).default(4),
      /** Tempo di un tentativo di un task, poi `timed_out`. */
      taskTimeoutMs: ms.max(24 * 3_600_000).default(900_000),
      maxAttempts: z.number().int().min(1).max(5).default(2),
      /** Ricerca dei file in `outbox\` di riserva al watcher. */
      outboxScanMs: ms.max(60_000).default(5_000),
      /**
       * Chi comanda (P-105): l'agente che pianifica gli obiettivi quando l'invio non lo indica, scelto
       * nella procedura guidata. `''` = piano a regole del Director. Vale subito, senza riavvio.
       */
      plannerAgentId: z.string().max(64).default('')
    })
    .prefault({}),
  /** Procedura guidata del primo avvio (P-105): versione completata (0 = mai). Vale subito. */
  setup: z
    .strictObject({ completedVersion: z.number().int().min(0).max(1_000).default(0) })
    .prefault({}),
  /**
   * Policy delle azioni (P-102): agenti in «modalità fiducia», scelti SOLO dal proprietario nelle
   * Impostazioni. Le azioni non critiche non chiedono più l'approvazione (tracciate nell'audit);
   * blocchi e percorsi custoditi restano. Vale dal prossimo avvio del core.
   */
  policy: z
    .strictObject({
      trustedAgents: z.array(z.string().min(1).max(64)).max(32).default([])
    })
    .prefault({}),
  /** Agenti predefiniti all'avvio (Fase 12.6, richiesta del proprietario): creati solo se il registro è
   *  vuoto. I ruoli NON nominano un motore: il core assegna a ciascuno un adapter dal registro. */
  agents: z
    .strictObject({
      seedDefaults: z.boolean().default(true),
      defaults: z
        .array(
          z.strictObject({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(80),
            role: z.string().min(1).max(200).default('agente VISIONE'),
            competences: z.array(agentCompetenceSchema).min(1).max(5).default(['general']),
            /** Modello del seed (formato `provider/modello`); assente = usa `defaultModel`. */
            model: z.string().max(120).optional()
          })
        )
        .max(20)
        .default([
          { id: 'director', name: 'Director', role: 'Coordinatore (pianificatore)', competences: ['reasoning', 'general'] },
          { id: 'esecutore', name: 'Esecutore', role: 'Esecutore di codice', competences: ['code'] },
          { id: 'revisore', name: 'Revisore', role: 'Revisione dei risultati', competences: ['review'] },
          { id: 'ricercatore', name: 'Ricercatore', role: 'Ricerca e raccolta', competences: ['research'] }
        ]),
      /**
       * Modello applicato agli agenti dei seed privi di `model` (formato `provider/modello`).
       * `''` = nessun modello: gli agenti restano non eseguibili finché non ne viene configurato
       * uno (nessun provider inventato). Fase 20, P-66.
       */
      defaultModel: z.string().max(120).default(''),
      /**
       * Ripiego quando un motore raggiunge il limite di quota (P-83): se abilitato e `defaultModel`
       * è configurato, all'avvio VISIONE garantisce un agente di ripiego con l'adapter che dichiara
       * di supportare quel modello, e il Director ci reinstrada il task. Nessun motore nominato qui.
       */
      limitFallback: z
        .strictObject({
          enabled: z.boolean().default(true),
          agentId: z.string().min(1).max(64).default('ripiego'),
          name: z.string().min(1).max(80).default('Ripiego')
        })
        .prefault({}),
      /**
       * Agente di coding (P-91). Garantito all'avvio come `limitFallback`: creato solo se manca e
       * solo quando un adapter dichiara il modello (nessun modello inventato). `model` vuoto = usa
       * `agents.defaultModel`. Permessi `workspace-write` (scrive nella propria cartella di lavoro,
       * niente shell): coerenti con le regole di sicurezza di P-39.
       */
      coder: z
        .strictObject({
          enabled: z.boolean().default(true),
          agentId: z.string().min(1).max(64).default('coder'),
          name: z.string().min(1).max(80).default('Coder'),
          model: z.string().max(120).default('')
        })
        .prefault({}),
      /**
       * Agente analista Nemo Ultra (P-93). Garantito all'avvio come `coder`: creato solo se il
       * modello è configurato qui o in `agents.ultra.model` e solo quando un adapter lo dichiara
       * (nessun modello inventato; vuoto = agente non creato). Permessi `read-only`: ragiona e
       * riferisce, non scrive nella cartella.
       */
      ultra: z
        .strictObject({
          enabled: z.boolean().default(true),
          agentId: z.string().min(1).max(64).default('ultra'),
          name: z.string().min(1).max(80).default('Ultra'),
          model: z.string().max(120).default('')
        })
        .prefault({})
    })
    .prefault({}),
  /** Interfaccia (Fase 12.6, Fase 18, P-85, P-86): command center immersivo. `desktop` = sfondo del
   *  desktop (`Progman`/`WorkerW`): VISIONE parte DIETRO icone e barra delle applicazioni e da lì
   *  NON riceve i click (limite di Windows), ma è **richiamabile**: Ctrl+Alt+V o la wake word la
   *  staccano (`SetParent(win, 0)`), la rendono focusable e la portano in primo piano; al blur
   *  torna a riposo dietro le icone (tutto reversibile, P-86). Default **false**: finestra
   *  fullscreen interattiva sopra il desktop; lo sfondo resta un'opzione. */
  ui: z.strictObject({
    fullscreen: z.boolean().default(true),
    desktop: z.boolean().default(false),
    /**
     * P-99: nome mostrato del Director nella scena e nel pannello contestuale. Il coordinatore non
     * è un agente del registro, quindi il suo display name vive qui; l'id interno resta «director».
     * Un file esistente senza la chiave resta «Director».
     */
    directorName: z.string().trim().min(1).max(80).default('Director'),
    /**
     * Variante della scena Neural (P-89): `jarvis` = la scena dei sorgenti JARVIS di Munder (P-88,
     * default e scena storica) oppure `pixel-office` = il globo dell'overlay dell'ufficio pixel di
     * Munder (`munder-patch/rete-neural/rete-neurale.js`, MIT): SFERA 3.200 + 7 strati + 4 anelli +
     * 9.000 particelle. La scelta si applica dal renderer (toggle in Impostazioni, effetto
     * immediato); il default resta `jarvis` — un file esistente senza questa chiave non cambia.
     */
    scene: z.enum(['jarvis', 'pixel-office']).default('jarvis'),
    /**
     * Quanto restano a schermo i nodi di lavoro concluso (task, processi, strumenti, approvazioni),
     * in secondi dall'ultimo evento (P-102; scelta del proprietario dall'11/10/2026). Vale subito.
     */
    nodeLingerSec: z.number().int().min(5).max(600).default(30),
    /** Avvio automatico con Windows (Fase 24, P-71): vale solo nella build installata; reversibile
     *  spegnendolo qui (o da Gestione attività → Avvio). Mai disabilitato Explorer. */
    startWithWindows: z.boolean().default(false),
    /**
     * Lingua dell'interfaccia e della voce (distribuzione mondiale, 10/10/2026). Assente = quella
     * di Windows (italiano se il sistema è in italiano, altrimenti inglese); si sceglie al primo passo
     * della procedura guidata e vale subito.
     */
    language: languageSchema.optional(),
    /**
     * Modalità esperto (11/10/2026, prima dell'uscita): spenta, l'interfaccia mostra solo ciò che serve
     * ogni giorno; accesa, anche i dettagli da sviluppatore (motori, registri, configurazione completa).
     * Vale subito.
     */
    expert: z.boolean().default(false),
    /**
     * Modalità leggera (punto 7, 14/10/2026): per i PC meno potenti la scena resta alla qualità minima
     * a ~30 fotogrammi al secondo, l'Umanoide disegna meno spesso e la sua webcam resta spenta. Vale subito.
     */
    light: z.boolean().default(false),
    /** Guida al primo avvio già vista (11/10/2026): si mostra da sola una volta; poi dallo Start. */
    guideSeen: z.boolean().default(false),
    /**
     * Città del meteo (22/10/2026): la scrive il proprietario nel widget Meteo; la usa anche il saluto all'avvio.
     * Vuota = nessuna richiesta meteo dal saluto (la rete parte solo per una città scelta da lui).
     */
    weatherCity: z.string().trim().max(80).default('')
  }).prefault({}),
  /** Memoria e Context Builder (Fase 7, VISIONE_DATA_MODEL §2). */
  memory: z
    .strictObject({
      /** Tetto del brief di un turno (le sezioni si troncano in ordine di priorità inversa). */
      briefMaxChars: z.number().int().min(2_000).max(60_000).default(12_000),
      /** Elementi pertinenti (FTS5) nel brief. */
      searchLimit: z.number().int().min(0).max(30).default(6),
      /** `memory.md` oltre questa dimensione → riflessione dopo il turno. */
      reflectAtChars: z.number().int().min(2_000).max(200_000).default(24_000),
      /** Sezioni recenti non fissate conservate intatte dalla riflessione. */
      keepRecentSections: z.number().int().min(1).max(50).default(8),
      /** Tetto del riassunto ricorsivo. */
      summaryMaxChars: z.number().int().min(500).max(20_000).default(4_000)
    })
    .prefault({}),
  /** Voce (Fase 9, P-48…P-50): processo locale sherpa-onnx; il microfono lo arma il proprietario dalla UI. */
  voice: z
    .strictObject({
      /** Avvia il processo voce con l'app (senza modelli resta `unavailable`, senza costi). */
      enabled: z.boolean().default(true),
      /** Cartella dei modelli; null = `<home>\models\voice`. */
      modelsDir: z.string().min(3).max(500).nullable().default(null),
      speaker: z.enum(['if_sara', 'im_nicola']).default('if_sara'),
      threads: z.number().int().min(1).max(16).default(4),
      /** Il parlato del proprietario ferma la voce di VISIONE. Spento di serie (16/10/2026): con le casse il microfono sente la voce stessa e VISIONE si zittiva da sola dopo 0,3 s (misurato sulla beta.11). */
      bargeIn: z.boolean().default(false),
      /**
       * Conversazione (17/10/2026, sua richiesta: «per un tot deve stare in ascolto, non devo dire sempre hey
       * visione»): finita una risposta detta, resta in ascolto così a lungo senza parola d'avvio. 0 = spenta.
       */
      followUpMs: z.number().int().min(0).max(30_000).default(8_000),
      /** Scorciatoia globale (accelerator di Electron): avvia l'ascolto, si chiude a fine frase. */
      pttShortcut: z.string().min(1).max(60).default('Control+Alt+Space'),
      /** Alla prima disponibilità della voce in una sessione: pronuncia la frase di avvio (Fase 24). */
      announceStartup: z.boolean().default(true),
      /** Frase di avvio originale di VISIONE (Kokoro locale, P-64/P-71): nessuna voce imitata. */
      startupPhrase: z.string().min(1).max(200).default('VISIONE online. Sistemi operativi.'),
      /**
       * Saluto di stato (11/10/2026): dopo la frase di avvio, come sta il PC, i motori, i lavori da
       * terminare, le approvazioni in attesa e gli impegni di oggi. Solo fatti reali.
       */
      startupBriefing: z.boolean().default(true),
      /**
       * Volume della voce di VISIONE in percento (11/10/2026): un guadagno fra il livellatore e il limitatore
       * del renderer (16/10/2026), cioè 250 ≈ −13 LUFS con qualunque voce, picchi sotto −1 dB.
       */
      volume: z.number().int().min(50).max(400).default(250),
      vadThreshold: z.number().min(0.1).max(0.95).default(0.5),
      minSpeechMs: z.number().int().min(30).max(1_000).default(120),
      minSilenceMs: z.number().int().min(100).max(3_000).default(900), // 600 ms tagliava la frase dopo «hey visione» a una pausa (16/10/2026)
      /**
       * P-106: soglia del rumore (RMS 0–0,2): un parlato più debole non si trascrive. La procedura
       * guidata la misura dal rumore della stanza; 0,004 è il valore storico della wake.
       */
      noiseGate: z.number().min(0).max(0.2).default(0.004),
      /** P-106: pulizia del rumore (GTCRN) prima della trascrizione, se il modello è scaricato. */
      denoise: z.boolean().default(true),
      /**
       * P-106: risponde solo alla voce del proprietario (impronta registrata nella procedura guidata).
       * Soglie tarate su voci reali: somiglianza ≥ 0,40 e margine 0,05 sulle voci di riferimento.
       */
      ownerOnly: z
        .strictObject({
          enabled: z.boolean().default(false),
          minScore: z.number().min(0.1).max(0.95).default(0.4),
          margin: z.number().min(0).max(0.5).default(0.05)
        })
        .prefault({}),
      /** VISIONE legge la sintesi degli obiettivi dati a voce. */
      speakSummaries: z.boolean().default(true),
      /** VISIONE annuncia le richieste di approvazione mentre la voce è pronta. */
      announceApprovals: z.boolean().default(true),
      /**
       * Provider TTS: `windows` (predefinito dal P-103: voci italiane del sistema, locali, nessun
       * modello da scaricare, nessun componente GPL), `kokoro` locale, oppure `edge` (Read Aloud di
       * Microsoft Edge, cloud senza chiave, solo uso personale P-84) con Kokoro come ripiego.
       * `voice` e `rate` valgono per Windows ed Edge (una voce che non esiste in Windows → prima voce
       * italiana installata); `pitch` solo per Edge.
       */
      tts: z
        .strictObject({
          provider: z.enum(['visione', 'windows', 'kokoro', 'edge']).default('visione'),
          voice: z.string().min(1).max(120).default('Microsoft Cosimo'),
          rate: z.string().min(1).max(12).default('+8%'),
          pitch: z.string().min(1).max(12).default('-2Hz')
        })
        .prefault({}),
      /**
       * Wake word «Hey Visione» (P-81): VAD dedicata → STT Whisper locale → matcher puro. Con
       * `enabled:false` il microfono non resta aperto oltre push-to-talk e barge-in.
       */
      wake: z
        .strictObject({
          enabled: z.boolean().default(false),
          /** Frase di attivazione (confrontata con tolleranza dal matcher). */
          phrase: z.string().min(1).max(120).default('hey visione'),
          /** Soglia della VAD dedicata alla wake (0.1–0.95). */
          sensitivity: z.number().min(0.1).max(0.95).default(0.5),
          /** Attesa del comando dopo la sola frase, poi il push-to-talk si disarma. */
          commandTimeoutMs: ms.max(60_000).default(6_000)
        })
        .prefault({})
    })
    .prefault({}),
  /**
   * Modalità offline dell'Assistente (17/10/2026): senza rete le richieste di base vanno a un modello
   * locale scaricato su consenso. `auto` = ci si passa da soli quando cade la rete (sempre col suo avviso).
   */
  offline: z
    .strictObject({
      auto: z.boolean().default(true),
      /** Cartella dei modelli locali; null = `<home>\models\offline`. */
      modelsDir: z.string().min(3).max(500).nullable().default(null)
    })
    .prefault({}),
  /** Telemetria di sistema (Fase 14, P-59): campionatori locali; valori non disponibili = N/D. */
  telemetry: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Periodo del campione (evento effimero); l'aggregato è sempre al minuto. */
      intervalMs: ms.min(500).max(60_000).default(2_000),
      /** Campionatori Windows via PowerShell (GPU, VRAM, rete). Fuori da Windows: inutile. */
      system: z.boolean().default(true),
      /** Provider di sensori esterno per le temperature (LibreHardwareMonitor su loopback). */
      sensors: z
        .strictObject({
          enabled: z.boolean().default(true),
          /** Solo loopback: il provider non può puntare a un host esterno. */
          url: z.string().url().max(200).default('http://127.0.0.1:8085')
        })
        .prefault({})
    })
    .prefault({})
});
export type VisioneConfig = z.infer<typeof visioneConfigSchema>;

export const DEFAULT_CONFIG: VisioneConfig = visioneConfigSchema.parse({ version: CONFIG_VERSION });

export interface LoadedConfig {
  config: VisioneConfig;
  source: 'file' | 'defaults';
  /** Problemi trovati (file non valido, versione futura, segreti, override ignorati). */
  problems: string[];
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Crea il file con i default se manca (solo il proprietario della config: il core). */
  createIfMissing?: boolean;
}

/** Porta un documento di una versione precedente alla versione corrente. */
/**
 * Predefiniti superati che il primo salvataggio ha scritto nel file (si scrive la configurazione intera):
 * si aggiornano; un valore scelto a mano resta. heartbeatTimeoutMs 10 s → 30 s (17/10/2026).
 */
function liftOldDefaults(raw: object): object {
  const sup = (raw as { supervisor?: unknown }).supervisor;
  if (typeof sup === 'object' && sup !== null && (sup as { heartbeatTimeoutMs?: unknown }).heartbeatTimeoutMs === 10_000) {
    return { ...raw, supervisor: { ...sup, heartbeatTimeoutMs: 30_000 } };
  }
  return raw;
}

export function migrateConfig(raw: unknown): { ok: true; value: unknown } | { ok: false; problem: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problem: 'la configurazione non è un oggetto' };
  const version = (raw as { version?: unknown }).version;
  if (version === CONFIG_VERSION) return { ok: true, value: liftOldDefaults(raw) };
  if (typeof version === 'number' && version > CONFIG_VERSION) {
    return { ok: false, problem: `versione ${version} più recente di quella supportata (${CONFIG_VERSION})` };
  }
  return { ok: false, problem: `versione mancante o non supportata: ${String(version)}` };
}

function findSecrets(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'string') {
    if (containsSecret(value)) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findSecrets(v, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) findSecrets(v, path ? `${path}.${k}` : k, out);
  }
}

function applyEnv(config: VisioneConfig, env: NodeJS.ProcessEnv, problems: string[]): VisioneConfig {
  const level = env.VISIONE_LOG_LEVEL;
  if (level === undefined || level === '') return config;
  if (!isLogLevel(level)) {
    problems.push(`VISIONE_LOG_LEVEL ignorata: valore non valido "${level}"`);
    return config;
  }
  return { ...config, logging: { ...config.logging, level } };
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Modifica a runtime (Fase 8, P-46): fusione profonda della patch (gli array si sostituiscono),
 * `version` immutabile, valori con forma di segreto rifiutati, risultato validato dallo schema.
 */
export function applyConfigPatch(current: VisioneConfig, patch: unknown): { ok: true; config: VisioneConfig; changed: string[] } | { ok: false; problem: string } {
  if (!isPlain(patch)) return { ok: false, problem: 'la patch deve essere un oggetto' };
  if ('version' in patch) return { ok: false, problem: 'la versione della configurazione non si modifica' };
  const secrets: string[] = [];
  findSecrets(patch, '', secrets);
  if (secrets.length > 0) return { ok: false, problem: `valori con forma di segreto rifiutati in: ${secrets.join(', ')} (usare una variabile d'ambiente)` };
  const changed: string[] = [];
  const merge = (base: unknown, over: unknown, path: string): unknown => {
    if (isPlain(base) && isPlain(over)) {
      const out: Record<string, unknown> = { ...base };
      for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v, path ? `${path}.${k}` : k);
      return out;
    }
    if (JSON.stringify(base) !== JSON.stringify(over)) changed.push(path);
    return over;
  };
  const parsed = visioneConfigSchema.safeParse(merge(current, patch, ''));
  if (!parsed.success) return { ok: false, problem: `configurazione non valida: ${formatIssues(parsed.error)}` };
  return { ok: true, config: parsed.data, changed };
}

export function writeConfigAtomic(file: string, config: VisioneConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/** Non lancia: in caso di problemi usa i default e lo dice in `problems`. Non sovrascrive mai un file esistente. */
export function loadConfig(file: string, opts: LoadConfigOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const problems: string[] = [];
  const fallback = (): LoadedConfig => ({ config: applyEnv(DEFAULT_CONFIG, env, problems), source: 'defaults', problems });

  if (!existsSync(file)) {
    if (opts.createIfMissing) {
      try {
        writeConfigAtomic(file, DEFAULT_CONFIG);
      } catch (err) {
        problems.push(`impossibile creare ${file}: ${String(err)}`);
      }
    }
    return fallback();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`JSON non valido: ${err instanceof Error ? err.message : String(err)}`);
    return fallback();
  }

  const secrets: string[] = [];
  findSecrets(raw, '', secrets);
  if (secrets.length > 0) {
    problems.push(`valori con forma di segreto rifiutati in: ${secrets.join(', ')} (usare una variabile d'ambiente)`);
    return fallback();
  }

  const migrated = migrateConfig(raw);
  if (!migrated.ok) {
    problems.push(migrated.problem);
    return fallback();
  }
  const parsed = visioneConfigSchema.safeParse(migrated.value);
  if (!parsed.success) {
    problems.push(`configurazione non valida: ${formatIssues(parsed.error)}`);
    return fallback();
  }
  return { config: applyEnv(parsed.data, env, problems), source: 'file', problems };
}
