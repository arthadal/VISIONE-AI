// Ambiente dei processi (MUNDER_CLI_RUNTIME §4): funzione pura, stratificata e testata.
// ereditato ripulito → PATH → variabili VISIONE_* → valori dell'adapter → PWD = cwd.
// VISIONE non aggiunge segreti: le credenziali restano dove l'utente le ha messe (variabili
// d'ambiente o store della CLI) e arrivano al processo solo perché già nell'ambiente ereditato.

export interface EnvLayers {
  /** Ambiente del core (ereditato dal main). */
  readonly inherited: Readonly<Record<string, string | undefined>>;
  /** Prefissi di variabili ereditate da rimuovere (oltre a quelli sempre rimossi). */
  readonly strip?: readonly string[];
  /** Variabili ereditate da conservare anche se un prefisso le rimuoverebbe. */
  readonly keep?: readonly string[];
  /** Cartelle aggiunte in coda al PATH (es. il node di VISIONE per gli shim). */
  readonly pathAppend?: readonly string[];
  readonly visione?: Readonly<Record<`VISIONE_${string}`, string>>;
  readonly adapter?: Readonly<Record<string, string>>;
  /** Cartella di lavoro: diventa PWD (alcune CLI preferiscono PWD alla cwd reale, P-33). */
  readonly cwd: string;
  readonly platform?: NodeJS.Platform;
}

/** Variabili dell'ambiente del core che non devono mai arrivare ai processi figli. */
export const ALWAYS_STRIPPED: readonly string[] = ['VISIONE_', 'ELECTRON_', 'NODE_OPTIONS', 'VITEST', 'npm_'];

const PATH_KEY = /^path$/i;

/** Su Windows i nomi delle variabili non distinguono le maiuscole: una sola chiave per nome. */
function setVar(env: Record<string, string>, key: string, value: string, win: boolean): void {
  if (win) {
    for (const existing of Object.keys(env)) {
      if (existing !== key && existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    }
  }
  env[key] = value;
}

function matches(key: string, prefix: string, win: boolean): boolean {
  return win ? key.toUpperCase().startsWith(prefix.toUpperCase()) : key.startsWith(prefix);
}

export function buildEnv(layers: EnvLayers): Record<string, string> {
  const win = (layers.platform ?? process.platform) === 'win32';
  const strip = [...ALWAYS_STRIPPED, ...(layers.strip ?? [])];
  const keep = new Set((layers.keep ?? []).map((k) => (win ? k.toUpperCase() : k)));
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(layers.inherited)) {
    if (value === undefined || key === '' || key.startsWith('=')) continue; // `=C:` di cmd.exe
    const kept = keep.has(win ? key.toUpperCase() : key);
    if (!kept && strip.some((p) => matches(key, p, win))) continue;
    setVar(env, key, value, win);
  }

  if (layers.pathAppend && layers.pathAppend.length > 0) {
    const sep = win ? ';' : ':';
    const pathKey = Object.keys(env).find((k) => PATH_KEY.test(k)) ?? (win ? 'Path' : 'PATH');
    const parts = (env[pathKey] ?? '').split(sep).filter(Boolean);
    for (const dir of layers.pathAppend) {
      if (!parts.some((p) => (win ? p.toLowerCase() === dir.toLowerCase() : p === dir))) parts.push(dir);
    }
    setVar(env, pathKey, parts.join(sep), win);
  }

  for (const [key, value] of Object.entries(layers.visione ?? {})) setVar(env, key, value, win);
  for (const [key, value] of Object.entries(layers.adapter ?? {})) setVar(env, key, value, win);
  setVar(env, 'PWD', layers.cwd, win);
  return env;
}

/** Nomi delle variabili (mai i valori) per log e diagnosi. */
export function envNames(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env).sort();
}
