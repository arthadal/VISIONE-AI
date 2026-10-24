// Requisiti di OpenCode per la procedura guidata (P-105): la CLI installata, la chiave NVIDIA
// nell'ambiente dell'utente (solo presenza) e, facoltativo, Ollama acceso con dei modelli. Tutto
// rilevato davvero; la guida è in italiano semplice. Ciò che riguarda i provider (chiave e catalogo
// NVIDIA, Ollama) sta in `../providers/`, condiviso col motore integrato: qui si riesporta, così gli
// import esistenti non cambiano.
import type { EnvPresence } from '../../../shared/node/user-env.ts';
import type { AdapterCatalogEntry, AdapterSetupItem } from '../index.ts';
import { versionNumber } from '../probe-command.ts';
import { NOT_CHAT, NVIDIA_CANDIDATES, NVIDIA_KEY_ENV, type NvidiaProbe } from '../providers/nvidia.ts';
import { OLLAMA_IGPU_ENV, OLLAMA_IGPU_SCRIPT, OLLAMA_INSTALL, type OllamaState } from '../providers/ollama.ts';

export { NVIDIA_CANDIDATES, NVIDIA_KEY_CHECK_URL, NVIDIA_KEY_ENV, NVIDIA_MODELS_URL, checkNvidiaKey, readNvidiaCatalog } from '../providers/nvidia.ts';
export { OLLAMA_INSTALL, OLLAMA_URL, readOllama, type OllamaState } from '../providers/ollama.ts';

export interface OpencodeSetupInput {
  readonly cli: { readonly found: true; readonly version: string | null } | { readonly found: false; readonly problem: string };
  readonly nvidiaKey: EnvPresence;
  readonly ollama: OllamaState;
  /** Scheda integrata scartata o usata da Ollama (dal suo registro) e la variabile che la attiva. */
  readonly ollamaIgpu?: { readonly dropped: string | null; readonly inUse: string | null; readonly env: EnvPresence };
}

/**
 * «Installa» (17/10/2026): Node.js LTS con winget se manca (Windows chiede il permesso), poi il pacchetto
 * ufficiale. Senza winget lo dice invece di fallire a metà. `Step` e `Update-VisionePath` li dà il core.
 */
/**
 * La versione di OpenCode che la procedura installa: una provata, non «l'ultima» (21/10/2026: la 1.19.3 provata nella VM
 * da zero con la configurazione vera di VISIONE). Un OpenCode già installato, di qualunque versione, non si tocca:
 * l'adapter legge dalla sua guida le opzioni che conosce.
 */
export const OPENCODE_NPM_PACKAGE = 'opencode-ai@1.19.3';
// Senza controllo vulnerabilità, richieste di fondi e avviso «npm nuovo» (VM, 22/10/2026): meno attesa e meno rumore.
const NPM_INSTALL = `npm.cmd install -g --no-audit --no-fund --no-update-notifier --allow-scripts=opencode-ai ${OPENCODE_NPM_PACKAGE}`;

export const OPENCODE_INSTALL = [
  "if (-not (Get-Command node -ErrorAction SilentlyContinue)) {",
  "  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'manca winget (Programma di installazione app di Microsoft): installa Node.js LTS dal sito ufficiale, poi premi Ricontrolla' }",
  "  Step 'Installo Node.js LTS (winget). Se Windows chiede il permesso, premi Si.' { winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements }",
  "  Update-VisionePath",
  "}",
  // npm 11.19 (con Node 24.20 LTS) non esegue più gli script di installazione non permessi: quello di
  // opencode-ai veniva saltato (collaudo su un PC vergine, 17/10/2026). Le versioni vecchie ignorano l'opzione.
  // Nella VM (22/10/2026) npm resta muto per minuti: si dice prima, così non sembra bloccato.
  `Step 'Installo OpenCode (npm, pacchetto ${OPENCODE_NPM_PACKAGE}). Ci vuole qualche minuto: npm non scrive niente finché non ha finito.' { ${NPM_INSTALL} }`
].join('\n');

export function opencodeSetupItems(input: OpencodeSetupInput): AdapterSetupItem[] {
  const installed: AdapterSetupItem = input.cli.found
    ? { id: 'installato', label: 'OpenCode installato', ok: true, optional: false, detail: `installato, versione ${versionNumber(input.cli.version)}`, steps: [], commands: [] }
    : {
        id: 'installato',
        label: 'OpenCode installato',
        ok: false,
        optional: false,
        detail: `non trovato (${input.cli.problem})`,
        steps: [
          'OpenCode si installa con Node.js. Se non hai Node.js, installalo per primo con il primo comando (versione LTS, gratuita).',
          'Chiudi e riapri PowerShell, poi installa OpenCode con il secondo comando (con «npm.cmd»: PowerShell non lo blocca).',
          'Torna qui e premi «Ricontrolla».'
        ],
        commands: ['winget install OpenJS.NodeJS.LTS', NPM_INSTALL],
        link: 'https://opencode.ai',
        action: { kind: 'install', source: 'Node.js (winget, se manca) e il pacchetto ufficiale opencode-ai (npm)', admin: true, script: OPENCODE_INSTALL }
      };
  const key: AdapterSetupItem = input.nvidiaKey
    ? {
        id: 'chiave-nvidia',
        label: 'Chiave NVIDIA',
        ok: true,
        optional: true,
        forProfile: 'nvidia',
        detail: input.nvidiaKey === 'processo' ? 'presente (premi «Verifica» per controllarla presso NVIDIA)' : 'salvata nel tuo utente Windows (premi «Verifica» per controllarla presso NVIDIA)',
        steps: [],
        commands: [],
        action: { kind: 'env-key', envName: NVIDIA_KEY_ENV }
      }
    : {
        id: 'chiave-nvidia',
        label: 'Chiave NVIDIA',
        ok: false,
        optional: true,
        forProfile: 'nvidia',
        detail: 'non impostata: serve per gli agenti che usano i modelli NVIDIA',
        steps: [
          'Apri build.nvidia.com e accedi o crea un account NVIDIA (gratuito).',
          'Apri un modello qualsiasi, premi «Get API Key» e poi «Generate Key».',
          'Copia la chiave (inizia con «nvapi-») e incollala nel campo qui sotto, poi premi «Salva e verifica».',
          'VISIONE la controlla presso NVIDIA e la salva nelle variabili del tuo utente Windows, non in un suo file.'
        ],
        commands: [],
        link: 'https://build.nvidia.com',
        action: { kind: 'env-key', envName: NVIDIA_KEY_ENV }
      };
  const ollama: AdapterSetupItem = input.ollama.running && input.ollama.models.length > 0
    ? { id: 'ollama', label: 'Modelli locali (Ollama)', ok: true, optional: true, forProfile: 'ollama', detail: `acceso, ${input.ollama.models.length} modelli: ${input.ollama.models.slice(0, 6).join(', ')}`, steps: [], commands: [] }
    : {
        id: 'ollama',
        label: 'Modelli locali (Ollama)',
        ok: false,
        optional: true,
        forProfile: 'ollama',
        detail: input.ollama.running ? 'acceso ma senza modelli' : 'non raggiungibile: non installato o spento',
        steps: input.ollama.running
          ? ['Scarica un modello con il comando qui sotto (circa 5 GB; con meno di 16 GB di RAM scegli un modello più piccolo, es. qwen2.5-coder:3b).', 'Premi «Ricontrolla».']
          : ['Installa Ollama (gratuito) con il primo comando, oppure scaricalo da ollama.com.', 'Avvialo, poi scarica un modello con il secondo comando (circa 5 GB).', 'Premi «Ricontrolla».'],
        commands: input.ollama.running ? ['ollama pull qwen2.5-coder:7b'] : ['winget install Ollama.Ollama', 'ollama pull qwen2.5-coder:7b'],
        link: 'https://ollama.com/download',
        action: { kind: 'install', source: input.ollama.running ? 'il modello qwen2.5-coder:7b (Ollama, circa 5 GB)' : 'Ollama (winget) e il modello qwen2.5-coder:7b (circa 5 GB)', admin: !input.ollama.running, script: OLLAMA_INSTALL }
      };
  const igpu = ollamaIgpuItem(input);
  return igpu ? [installed, key, ollama, igpu] : [installed, key, ollama];
}

/** Facoltativa e solo dove serve: Ollama acceso che ha scartato la scheda integrata, o che la usa già. */
function ollamaIgpuItem(input: OpencodeSetupInput): AdapterSetupItem | null {
  const g = input.ollamaIgpu;
  if (!input.ollama.running || !g) return null;
  const label = 'Ollama più veloce con la grafica integrata';
  if (g.inUse) return { id: 'ollama-grafica', label, ok: true, optional: true, detail: `usa ${g.inUse}`, steps: [], commands: [] };
  if (!g.dropped) return null;
  return {
    id: 'ollama-grafica',
    label,
    ok: false,
    optional: true,
    detail: g.env
      ? `attivata ma Ollama non è ripartito: usa ancora solo il processore (${g.dropped} scartata)`
      : `Ollama usa solo il processore e scarta ${g.dropped}: con la grafica integrata le risposte arrivano circa 4 volte prima (misurato su un PC Intel Arc)`,
    steps: [
      `Imposta la variabile dell'utente ${OLLAMA_IGPU_ENV}=1 con il comando qui sotto.`,
      'Chiudi Ollama dall\'icona vicino all\'orologio e riaprilo dal menu Start.',
      `Per tornare indietro: [Environment]::SetEnvironmentVariable('${OLLAMA_IGPU_ENV}', $null, 'User') e riavvia Ollama.`
    ],
    commands: [`[Environment]::SetEnvironmentVariable('${OLLAMA_IGPU_ENV}', '1', 'User')`],
    action: { kind: 'install', verb: 'enable', source: `la grafica integrata (${g.dropped}) per Ollama; Ollama si riavvia`, admin: false, script: OLLAMA_IGPU_SCRIPT }
  };
}

const ROLE_TEXT = { code: 'codice, revisione e lavoro generale', research: 'veloce, ricerca' } as const;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;

/**
 * Voci del menu: i candidati NVIDIA in cima, poi il resto del catalogo NVIDIA (chat), poi i modelli Ollama.
 * Con le prove fatte con la chiave (`probes`) si consigliano solo i candidati che hanno risposto, nell'ordine di
 * preferenza: il primo di codice per il codice, il secondo per la revisione (un altro paio d'occhi), il primo di
 * ricerca per la ricerca. Chi non ha risposto scende in fondo al gruppo NVIDIA con il motivo, sempre sceglibile.
 * Senza prove (nessuna chiave: NVIDIA non è comunque utilizzabile) i candidati restano in cima, non provati;
 * quelli che il catalogo pubblico non elenca più non si consigliano.
 */
export function opencodeCatalog(nvidiaIds: readonly string[] | null, ollamaModels: readonly string[], probes: ReadonlyMap<string, NvidiaProbe> | null = null): AdapterCatalogEntry[] {
  const out: AdapterCatalogEntry[] = [];
  const failed: AdapterCatalogEntry[] = [];
  const taken = new Set<'code' | 'review' | 'research'>();
  const listed = nvidiaIds ? new Set(nvidiaIds) : null;
  for (const c of NVIDIA_CANDIDATES) {
    const model = `nvidia/${c.id}`;
    const probe = probes?.get(c.id);
    const problem = probes ? (probe?.ok ? null : probe?.detail ?? 'non provato') : listed && !listed.has(c.id) ? 'non più nel catalogo NVIDIA' : null;
    if (problem) {
      failed.push({ model, label: `${c.name} — ${problem}`, group: 'NVIDIA', endpointProfile: 'nvidia' });
      continue;
    }
    const want = c.role === 'research' ? 'research' : taken.has('code') ? 'review' : 'code';
    const suggestedFor = taken.has(want) ? undefined : want;
    if (suggestedFor) taken.add(suggestedFor);
    const how = probe ? `, risponde in ${seconds(probe.ms)}` : '';
    out.push({ model, label: `${c.name} — ${ROLE_TEXT[c.role]}${how}${suggestedFor ? ' (consigliato)' : ''}`, group: 'NVIDIA', endpointProfile: 'nvidia', recommended: true, ...(suggestedFor ? { suggestedFor } : {}) });
  }
  const seen = new Set(NVIDIA_CANDIDATES.map((c) => c.id));
  for (const id of [...(nvidiaIds ?? [])].sort()) {
    if (seen.has(id) || NOT_CHAT.test(id) || !/^[\w.-]+\/[\w.:-]+$/.test(id)) continue;
    seen.add(id);
    out.push({ model: `nvidia/${id}`, label: id, group: 'NVIDIA', endpointProfile: 'nvidia' });
  }
  out.push(...failed);
  for (const name of ollamaModels) out.push({ model: `ollama/${name}`, label: `${name} (sul tuo PC)`, group: 'Ollama (locale)', endpointProfile: 'ollama' });
  return out;
}
