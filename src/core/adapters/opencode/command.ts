// Costruzione di argv e configurazione per `opencode run` (MUNDER_CLI_RUNTIME §3, §16; P-7, P-8).
// Solo nel core, funzioni pure testate. Nessun segreto: la chiave del provider resta nella
// variabile d'ambiente dell'utente ed è solo referenziata (`{env:NOME}`, sintassi già usata
// nella config OpenCode dell'utente e verificata).

/** Profilo di endpoint: provider compatibile OpenAI scelto in configurazione, non nel codice. */
export interface EndpointProfile {
  readonly id: string;
  /** Nome del provider in OpenCode (prefisso del modello `provider/modello`). */
  readonly provider: string;
  readonly npm: string;
  readonly baseURL: string;
  /** Variabile d'ambiente con la chiave, mai il valore. Null = nessuna chiave (proxy locale). */
  readonly apiKeyEnv: string | null;
  /** Modello sul PC dell'utente: configurazione leggera (`LOCAL_TOOLS_OFF`) e contesto adatto (`ollamaAgentModel`). */
  readonly local?: boolean;
}

export const DEFAULT_ENDPOINT_PROFILES: readonly EndpointProfile[] = [
  { id: 'nvidia', provider: 'nvidia', npm: '@ai-sdk/openai-compatible', baseURL: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY' },
  // Proxy locale già esistente dell'utente (ai-neurale): stessa chiave, nessun costo aggiuntivo.
  { id: 'nvidia-proxy-locale', provider: 'nvidia', npm: '@ai-sdk/openai-compatible', baseURL: 'http://127.0.0.1:11500/v1', apiKeyEnv: 'NVIDIA_API_KEY' },
  // P-93: DeepSeek ufficiale. L'account è già autenticato in OpenCode (`opencode auth list` →
  // «DeepSeek stored», misurato il 06/10/2026): `apiKeyEnv: null` NON scrive chiavi e lascia che
  // la CLI usi l'autenticazione memorizzata dell'utente. Modelli reali della CLI:
  // `deepseek/deepseek-flash` (identità 3,7 s, config generata dall'adapter 2,3 s) e
  // `deepseek/deepseek-v4-pro`. Nessun costo nuovo: nessuna chiave nel repository.
  { id: 'deepseek', provider: 'deepseek', npm: '@ai-sdk/openai-compatible', baseURL: 'https://api.deepseek.com', apiKeyEnv: null },
  // Fase 20 (P-66): OpenRouter è un endpoint compatibile OpenAI realmente disponibile; la chiave
  // resta solo nell'ambiente dell'utente (`OPENROUTER_API_KEY`), mai nel repository. Il profilo si
  // sceglie nella definizione dell'agente (`engine.endpointProfile`), senza toccare il codice.
  { id: 'openrouter', provider: 'openrouter', npm: '@ai-sdk/openai-compatible', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  // P-105: modelli locali con Ollama (API compatibile OpenAI su loopback, nessuna chiave, nessun
  // costo). Modelli nel formato `ollama/<nome:tag>`, come li elenca `ollama list`.
  { id: 'ollama', provider: 'ollama', npm: '@ai-sdk/openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', apiKeyEnv: null, local: true }
];

/**
 * Strumenti di OpenCode tolti agli agenti locali (22/10/2026). Sul PC del proprietario, senza scheda video, Ollama
 * legge il prompt a ~34 token/s: OpenCode ne manda 8.063 per un turno di una parola, 4.253 senza questi (web,
 * sotto-agenti, liste, patch, terminale quando non è permesso). Restano lettura, ricerca e, se permessi, scrittura.
 * Nomi sconosciuti a una versione di OpenCode vengono ignorati.
 */
export const LOCAL_TOOLS_OFF = ['webfetch', 'websearch', 'codesearch', 'todowrite', 'todoread', 'task', 'patch', 'apply_patch', 'multiedit', 'lsp', 'skill', 'question', 'batch'] as const;

/** Permessi di OpenCode: solo allow/deny. `ask` in `run` viene rifiutato automaticamente e
 * interrompe il turno (verificato), quindi non è mai generato (P-34). */
export type OpenCodePermission = 'allow' | 'deny';

/**
 * `external_directory` (22/10/2026): non dichiarato valeva `ask`, e un modello che guardava fuori dalla sua cartella
 * (Lightning 30B nella verifica della guidata: «permission requested: external_directory (C:/*); auto-rejecting»)
 * chiudeva il turno con codice 1. Con `deny` il modello riceve il rifiuto e continua (provato su 1.19.3 e 2.0.12).
 * Il testo lungo del turno (`--file`, fuori dalla cartella) lo legge OpenCode, non uno strumento: non è toccato.
 */
export const PERMISSION_PROFILES: Readonly<Record<string, Readonly<Record<string, OpenCodePermission>>>> = {
  'read-only': { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' },
  'workspace-write': { edit: 'allow', bash: 'deny', webfetch: 'deny', external_directory: 'deny' },
  'workspace-exec': { edit: 'allow', bash: 'allow', webfetch: 'deny', external_directory: 'deny' },
  // Agente in modalità fiducia (24/10/2026, dal proprietario: «il Director deve essere sempre autorizzato»; con una
  // squadra di soli motori a turni nessuno poteva scrivere un file sul PC). Questo motore non passa dal controllo
  // delle azioni di VISIONE: la fiducia qui è piena, e lo dice l'interruttore nelle Impostazioni.
  trusted: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' }
};

export interface ConfigInput {
  readonly model: string;
  readonly profile: EndpointProfile;
  readonly permissions: string;
}

export function splitModel(model: string): { provider: string; modelId: string } | null {
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) return null;
  return { provider: model.slice(0, i), modelId: model.slice(i + 1) };
}

/** Contenuto di `OPENCODE_CONFIG_CONTENT` per un agente (P-7, MUNDER_CLI_RUNTIME §16). */
export function buildConfigContent(input: ConfigInput): string {
  const split = splitModel(input.model);
  if (!split) throw new Error(`modello non nel formato provider/modello: ${input.model}`);
  const options: Record<string, string> = { baseURL: input.profile.baseURL };
  if (input.profile.apiKeyEnv) options.apiKey = `{env:${input.profile.apiKeyEnv}}`;
  const permission = PERMISSION_PROFILES[input.permissions] ?? PERMISSION_PROFILES['read-only']!;
  // Agente locale: meno strumenti e niente richiesta del titolo. Con un solo posto in Ollama il titolo (537 token)
  // prendeva il posto del prompt già letto e il turno dopo lo rileggeva tutto (misurato il 22/10/2026).
  const local = input.profile.local
    ? {
        tools: Object.fromEntries([...LOCAL_TOOLS_OFF, ...(permission.bash === 'allow' ? [] : ['bash'])].map((t) => [t, false])),
        agent: { title: { disable: true } }
      }
    : {};
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    enabled_providers: [input.profile.provider],
    share: 'disabled',
    autoupdate: false,
    model: input.model,
    provider: {
      [input.profile.provider]: {
        npm: input.profile.npm,
        options,
        models: { [split.modelId]: { tool_call: true } }
      }
    },
    permission,
    ...local
  });
}

export interface TurnArgsInput {
  readonly model: string;
  readonly engineSessionId: string | null;
  readonly agentProfile?: string;
  /** File con il testo del turno (testi lunghi o multi-riga: mai in argv). */
  readonly file?: string;
  readonly message: string;
}

/** Messaggi più lunghi o multi-riga passano da file (`--file`), mai in argv (MUNDER_CLI_RUNTIME §2). */
export const MAX_INLINE_MESSAGE = 1_000;

export function needsFile(text: string): boolean {
  return text.length > MAX_INLINE_MESSAGE || /[\r\n]/.test(text);
}

/**
 * Il messaggio che accompagna il brief in un file. La riga sulla lingua della risposta, l'ultima del brief, si ripete
 * qui (24/10/2026: in fondo all'allegato, dopo il prompt inglese di OpenCode, un modello locale rispondeva in inglese
 * a una richiesta in italiano, come la ricetta della beta.31).
 */
export function fileMessage(text: string): string {
  const base = 'Esegui le istruzioni contenute nel file allegato.';
  const last = text.trimEnd().split('\n').at(-1)?.trim() ?? '';
  return /^Rispondi in \S+/.test(last) && last.length <= 200 ? `${base} ${last}` : base;
}

/**
 * Ciò che la CLI installata sa fare, letto dalla sua guida e non dal numero di versione (21/10/2026: la 1.19.3
 * che npm installa ai tester non conosce `--standalone`, che la 2.x vuole, e ogni turno usciva con codice 1).
 * - `standalone`: `run` accetta `--standalone` (2.x; nella 1.x ogni `run` avvia già un suo server).
 * - `topLevelExport`: l'esportazione è `opencode export <id>` (1.x) invece di `opencode session export <id>` (2.x).
 * - `fileArray`: `--file` prende più valori (1.x, yargs `[array]`) e si mangerebbe il messaggio che lo segue
 *   («File not found: Esegui le istruzioni…», VM 21/10/2026): il messaggio va prima di `--file`.
 */
export interface OpencodeFeatures {
  readonly standalone: boolean;
  readonly topLevelExport: boolean;
  readonly fileArray: boolean;
}

/** Versione principale della CLI ("1.19.3" → 1, "opencode v2.0.12" → 2); null se illeggibile. */
export function opencodeMajor(version: string | null | undefined): number | null {
  const m = /(\d+)\.\d+/.exec(version ?? '');
  return m ? Number(m[1]) : null;
}

/** Ripiego quando la guida non si legge: dalla versione principale; illeggibile = 2.x, quella di P-7. */
export function featuresFromVersion(version: string | null | undefined): OpencodeFeatures {
  const major = opencodeMajor(version);
  const legacy = major !== null && major < 2;
  return { standalone: !legacy, topLevelExport: legacy, fileArray: legacy };
}

/**
 * Dalla guida di `opencode run --help` e di `opencode --help` (stdout e stderr insieme: la 1.x la stampa su stderr).
 * Un'opzione conta solo se apre una riga dell'elenco: la 2.0.12 nomina `--standalone` anche dentro la descrizione
 * di `--print-logs`. Null se la guida di `run` non è riconoscibile (non elenca `--format`): allora decide la versione.
 */
const option = (name: string): RegExp => new RegExp(`^\\s*(?:-\\w,\\s*)?--${name}\\b`, 'm');

export function featuresFromHelp(runHelp: string | null, mainHelp: string | null): OpencodeFeatures | null {
  if (!runHelp || !option('format').test(runHelp)) return null;
  return {
    standalone: option('standalone').test(runHelp),
    topLevelExport: /^\s*(?:opencode\s+)?export\b/m.test(mainHelp ?? ''),
    fileArray: new RegExp(`${option('file').source}.*\\[array\\]`, 'm').test(runHelp)
  };
}

const V2: OpencodeFeatures = { standalone: true, topLevelExport: false, fileArray: false };

export function buildTurnArgs(input: TurnArgsInput, features: OpencodeFeatures = V2): string[] {
  const args = features.standalone ? ['run', '--standalone', '--format', 'json'] : ['run', '--format', 'json'];
  if (input.engineSessionId) args.push('--session', input.engineSessionId);
  args.push('--model', input.model);
  if (input.agentProfile) args.push('--agent', input.agentProfile);
  if (input.file && features.fileArray) args.push(input.message, '--file', input.file);
  else args.push(...(input.file ? ['--file', input.file] : []), input.message);
  return args;
}

export function buildExportArgs(engineSessionId: string, features: OpencodeFeatures = V2): string[] {
  if (features.topLevelExport) return ['export', engineSessionId];
  return features.standalone ? ['session', 'export', '--standalone', engineSessionId] : ['session', 'export', engineSessionId];
}
